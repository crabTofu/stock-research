"""Incremental sync from the provider into the local DB.

    python -m backend.app.ingest                 # everything in every sector, only what's stale
    python -m backend.app.ingest --sector ai --force
    python -m backend.app.ingest --tickers NVDA AMD --datasets prices

Prices are fetched incrementally (from the last stored date with a small overlap).
If the overlap no longer matches what we stored, a split or dividend has changed the
adjusted history, so that ticker's full history is re-downloaded.
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

from . import db
from .config import settings
from .providers import get_provider
from .sectors import all_tickers, get_sector

log = logging.getLogger("ingest")

DATASETS = ("prices", "fundamentals", "profile", "news")
TTL = {
    "prices": lambda: settings.ttl_prices,
    "fundamentals": lambda: settings.ttl_fundamentals,
    "profile": lambda: settings.ttl_profile,
    "news": lambda: settings.ttl_news,
}

# serialise writers; SQLite allows one at a time anyway, this avoids busy-wait
_write_lock = threading.Lock()
# one in-flight fetch per (ticker, dataset), so concurrent API requests don't double-fetch
_inflight: dict[tuple[str, str], threading.Lock] = {}
_inflight_guard = threading.Lock()

_status_lock = threading.Lock()
status: dict = {"running": False, "done": 0, "total": 0, "errors": [], "started_at": None, "finished_at": None}


def _key_lock(ticker: str, dataset: str) -> threading.Lock:
    with _inflight_guard:
        return _inflight.setdefault((ticker, dataset), threading.Lock())


def _sync_prices(ticker: str) -> int:
    p = get_provider()
    c = db.conn()
    last = c.execute("SELECT MAX(date) FROM prices WHERE ticker=?", (ticker,)).fetchone()[0]
    full_start = date.today() - timedelta(days=365 * settings.price_history_years)
    if last is None:
        rows = p.prices(ticker, full_start)
        with _write_lock, db.tx() as w:
            n = db.replace_prices(w, ticker, rows)
            db.log_fetch(w, ticker, "prices", True)
            db.bump_version(w)
        return n

    overlap_start = date.fromisoformat(last) - timedelta(days=10)
    rows = p.prices(ticker, overlap_start)
    stored = dict(c.execute(
        "SELECT date, close FROM prices WHERE ticker=? AND date>=?", (ticker, overlap_start.isoformat())
    ).fetchall())
    drift = any(
        d in stored and stored[d] and abs(close / stored[d] - 1) > 0.005
        for d, _o, _h, _l, close, _v in rows
    )
    if drift:
        log.info("%s: adjusted history changed (split/dividend); refetching full history", ticker)
        rows = p.prices(ticker, full_start)
        with _write_lock, db.tx() as w:
            n = db.replace_prices(w, ticker, rows)
            db.log_fetch(w, ticker, "prices", True)
            db.bump_version(w)
        return n

    with _write_lock, db.tx() as w:
        n = db.upsert_prices(w, ticker, rows)
        db.log_fetch(w, ticker, "prices", True)
        db.bump_version(w)
    return n


def _sync_fundamentals(ticker: str) -> int:
    rows = get_provider().financials(ticker)
    with _write_lock, db.tx() as w:
        n = db.upsert_financials(w, ticker, rows)
        db.log_fetch(w, ticker, "fundamentals", True)
        db.bump_version(w)
    return n


def _sync_profile(ticker: str) -> int:
    prof = get_provider().profile(ticker)
    with _write_lock, db.tx() as w:
        db.upsert_profile(w, ticker, prof.get("longName") or prof.get("shortName"), prof)
        db.log_fetch(w, ticker, "profile", True)
        db.bump_version(w)
    return 1


def _sync_news(ticker: str) -> int:
    items = get_provider().news(ticker)
    with _write_lock, db.tx() as w:
        n = db.upsert_news(w, ticker, items)
        db.log_fetch(w, ticker, "news", True)
    return n


_SYNC = {
    "prices": _sync_prices,
    "fundamentals": _sync_fundamentals,
    "profile": _sync_profile,
    "news": _sync_news,
}


def sync_one(ticker: str, dataset: str, force: bool = False) -> bool:
    """Bring one (ticker, dataset) up to date. Returns True if a fetch happened."""
    if not force and db.is_fresh(ticker, dataset, TTL[dataset]()):
        return False
    lock = _key_lock(ticker, dataset)
    with lock:
        # another thread may have fetched while we waited
        if not force and db.is_fresh(ticker, dataset, TTL[dataset]()):
            return False
        try:
            _SYNC[dataset](ticker)
            return True
        except Exception as e:  # provider hiccups shouldn't kill a batch
            log.warning("%s %s failed: %s", ticker, dataset, e)
            with _write_lock, db.tx() as w:
                db.log_fetch(w, ticker, dataset, False, str(e)[:500])
            raise


def ensure(ticker: str, datasets: tuple[str, ...]) -> None:
    """Fetch on demand if the data is missing or stale; swallow errors (serve what we have)."""
    for ds in datasets:
        try:
            sync_one(ticker, ds)
        except Exception:
            pass


def sync_many(tickers: list[str], datasets: tuple[str, ...] = ("prices", "fundamentals", "profile"),
              force: bool = False) -> dict:
    jobs = [(t, ds) for t in tickers for ds in datasets]
    with _status_lock:
        if status["running"]:
            return status
        status.update(running=True, done=0, total=len(jobs), errors=[], started_at=time.time(), finished_at=None)
    try:
        with ThreadPoolExecutor(max_workers=settings.fetch_workers) as pool:
            futs = {pool.submit(sync_one, t, ds, force): (t, ds) for t, ds in jobs}
            for f in as_completed(futs):
                t, ds = futs[f]
                try:
                    f.result()
                except Exception as e:
                    status["errors"].append({"ticker": t, "dataset": ds, "error": str(e)[:200]})
                status["done"] += 1
    finally:
        status.update(running=False, finished_at=time.time())
    return status


def sync_in_background(tickers: list[str] | None = None, force: bool = False) -> bool:
    if status["running"]:
        return False
    tickers = tickers or all_tickers()
    threading.Thread(target=sync_many, args=(tickers,), kwargs={"force": force}, daemon=True).start()
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sector", help="only tickers in this sector (plus its benchmarks)")
    ap.add_argument("--tickers", nargs="*", help="explicit tickers")
    ap.add_argument("--datasets", nargs="*", default=["prices", "fundamentals", "profile"], choices=DATASETS)
    ap.add_argument("--force", action="store_true", help="ignore freshness windows")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.tickers:
        tickers = [t.upper() for t in args.tickers]
    elif args.sector:
        s = get_sector(args.sector)
        if not s:
            raise SystemExit(f"unknown sector {args.sector}")
        tickers = s.tickers + s.benchmarks
    else:
        tickers = all_tickers()

    t0 = time.time()
    res = sync_many(tickers, tuple(args.datasets), force=args.force)
    log.info("synced %d jobs in %.1fs, %d errors", res["done"], time.time() - t0, len(res["errors"]))
    for e in res["errors"]:
        log.warning("  %s %s: %s", e["ticker"], e["dataset"], e["error"])


if __name__ == "__main__":
    main()
