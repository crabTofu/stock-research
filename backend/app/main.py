"""HTTP API + static frontend.

    uvicorn backend.app.main:app --reload --port 8000
"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from dataclasses import fields

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, ingest, metrics, research
from .config import settings
from .sectors import all_benchmarks, all_tickers, get_sector, load_sectors, sectors_for

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    if settings.sync_on_startup:
        ingest.sync_in_background()
    yield


app = FastAPI(title="Stock Research", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ------------------------------------------------------------------ sectors

@app.get("/api/sectors")
def list_sectors():
    return [
        {"id": s.id, "name": s.name, "description": s.description, "n_companies": len(s.tickers)}
        for s in load_sectors().values()
    ]


@app.get("/api/sectors/{sector_id}")
def sector_detail(sector_id: str):
    s = get_sector(sector_id)
    if not s:
        raise HTTPException(404, "unknown sector")
    snap = metrics.snapshot(tuple(s.tickers + s.benchmarks))
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "benchmarks": s.benchmarks,
        "default_benchmark": s.default_benchmark,
        "tiers": [{"id": t.id, "name": t.name, "description": t.description, "tickers": t.tickers} for t in s.tiers],
        "edges": s.edges,
        "companies": {t: snap[t] for t in s.tickers},
        "benchmark_snapshot": {b: snap[b] for b in s.benchmarks},
    }


# ------------------------------------------------------------------ companies

def _check(ticker: str) -> str:
    t = ticker.upper()
    if t not in set(all_tickers()):
        raise HTTPException(404, f"{t} is not tracked; add it to a sector YAML first")
    return t


@app.get("/api/companies/{ticker}")
def company(ticker: str):
    t = _check(ticker)
    ingest.ensure(t, ("profile", "prices"))
    prof = metrics.profiles().get(t, {})
    snap = metrics.snapshot((t,))[t]
    rel = []
    for s in sectors_for(t):
        tier = next(x for x in s.tiers if x.id == s.tier_of[t])
        rel.append({
            "sector": s.id, "sector_name": s.name, "tier": tier.id, "tier_name": tier.name,
            "suppliers": s.suppliers(t), "customers": s.customers(t),
            "peers": [p for p in tier.tickers if p != t],
            "default_benchmark": s.default_benchmark,
        })
    return {"ticker": t, "profile": prof, "snapshot": snap, "supply_chain": rel}


RANGES = {"1m": 31, "3m": 92, "6m": 183, "ytd": None, "1y": 366, "3y": 366 * 3, "5y": 366 * 5, "max": 366 * 50}


@app.get("/api/companies/{ticker}/prices")
def company_prices(ticker: str, range: str = Query("1y"), benchmark: str | None = None):
    t = _check(ticker)
    ingest.ensure(t, ("prices",))
    import datetime as dt

    today = dt.date.today()
    days = RANGES.get(range, 366)
    start = dt.date(today.year, 1, 1) if range == "ytd" else today - dt.timedelta(days=days)
    df = metrics.prices(t, start.isoformat())
    out = {
        "ticker": t,
        # columnar arrays are ~3x smaller than a list of objects
        "date": df["date"].tolist(),
        "open": df["open"].round(4).tolist(),
        "high": df["high"].round(4).tolist(),
        "low": df["low"].round(4).tolist(),
        "close": df["close"].round(4).tolist(),
        "volume": df["volume"].tolist(),
    }
    if benchmark:
        b = benchmark.upper()
        bdf = metrics.prices(b, start.isoformat())
        out["benchmark"] = {"ticker": b, "date": bdf["date"].tolist(), "close": bdf["close"].round(4).tolist()}
    return out


@app.get("/api/companies/{ticker}/financials")
def company_financials(ticker: str, freq: str = Query("Q", pattern="^[QA]$")):
    t = _check(ticker)
    ingest.ensure(t, ("fundamentals",))
    return {"ticker": t, "freq": freq, **metrics.statements(t, freq)}


@app.get("/api/companies/{ticker}/news")
def company_news(ticker: str, limit: int = 20):
    t = _check(ticker)
    ingest.ensure(t, ("news",))
    rows = db.conn().execute(
        "SELECT id, published, title, publisher, link, summary, thumbnail FROM news "
        "WHERE ticker=? ORDER BY published DESC LIMIT ?",
        (t, limit),
    ).fetchall()
    return [dict(r) for r in rows]


# ------------------------------------------------------------------ research

class ResearchBody(BaseModel):
    x: str
    y: str = "fwd_excess"
    sector: str | None = "ai"
    tiers: list[str] = []
    tickers: list[str] = []
    benchmark: str = "QQQ"
    horizon_months: int = 3
    lookback_years: float = 3
    cohort: str = "quantile"
    quantile: float = 0.5
    threshold: float | None = None
    op: str = ">"
    higher_is_better: bool = True
    winsorize: bool = True


@app.get("/api/research/factors")
def research_factors():
    return {**research.factor_catalog(), "benchmarks": all_benchmarks()}


@app.post("/api/research/run")
def research_run(body: ResearchBody):
    names = {f.name for f in fields(research.ResearchRequest)}
    req = research.ResearchRequest(**{k: v for k, v in body.model_dump().items() if k in names})
    t0 = time.perf_counter()
    try:
        out = research.run(req)
    except ValueError as e:
        raise HTTPException(400, str(e))
    out["elapsed_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return out


# ------------------------------------------------------------------ data management

@app.get("/api/status")
def data_status():
    c = db.conn()
    counts = c.execute(
        "SELECT (SELECT COUNT(*) FROM prices), (SELECT COUNT(DISTINCT ticker) FROM prices), "
        "(SELECT MAX(date) FROM prices), (SELECT COUNT(*) FROM financials)"
    ).fetchone()
    errors = [dict(r) for r in c.execute(
        "SELECT ticker, dataset, fetched_at, error FROM fetch_log WHERE ok=0 ORDER BY fetched_at DESC LIMIT 20"
    ).fetchall()]
    oldest = c.execute("SELECT MIN(fetched_at) FROM fetch_log WHERE dataset='prices' AND ok=1").fetchone()[0]
    return {
        "price_rows": counts[0], "tickers": counts[1], "latest_price_date": counts[2],
        "financial_rows": counts[3], "oldest_price_sync": oldest, "data_version": db.data_version(),
        "sync": ingest.status, "recent_errors": errors, "db_path": str(settings.db_path),
    }


class RefreshBody(BaseModel):
    tickers: list[str] = []
    force: bool = False


@app.post("/api/refresh")
def refresh(body: RefreshBody):
    started = ingest.sync_in_background([t.upper() for t in body.tickers] or None, force=body.force)
    return {"started": started, "sync": ingest.status}


# ------------------------------------------------------------------ frontend (production build)

dist = settings.frontend_dist
if dist.exists():
    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = dist / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(dist / "index.html")
