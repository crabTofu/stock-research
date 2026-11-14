"""Factor research engine.

Question it answers: "Across the companies on my radar, does variable X tell me
anything about Y?" where Y is usually forward return vs a benchmark.

Method (kept deliberately simple and transparent):
1. Rebalance dates step back from the latest price date every `horizon` months, so
   holding periods never overlap and the most recent one ends today.
2. At each date, each company's X is the value that was *public* then
   (fundamentals lagged by reporting delay; prices as of that day).
3. Y is the forward return over the next `horizon` months, minus the benchmark's.
4. We report pooled correlations, the per-period rank IC (Spearman), and a cohort
   test: an equal-weight basket of companies passing the screen vs the rest and vs
   the benchmark, period by period.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import metrics
from .sectors import get_sector, load_sectors

# ------------------------------------------------------------------ factor registry

FACTORS: dict[str, dict] = {
    # profitability & cash
    "ocf_margin": {"label": "Operating cash flow margin (TTM)", "group": "Cash flow", "unit": "pct", "kind": "fund"},
    "fcf_margin": {"label": "Free cash flow margin (TTM)", "group": "Cash flow", "unit": "pct", "kind": "fund"},
    "cash_conversion": {"label": "Cash conversion (OCF / net income)", "group": "Cash flow", "unit": "x", "kind": "fund"},
    "capex_intensity": {"label": "Capex / revenue", "group": "Cash flow", "unit": "pct", "kind": "fund"},
    "gross_margin": {"label": "Gross margin", "group": "Profitability", "unit": "pct", "kind": "fund"},
    "operating_margin": {"label": "Operating margin", "group": "Profitability", "unit": "pct", "kind": "fund"},
    "net_margin": {"label": "Net margin", "group": "Profitability", "unit": "pct", "kind": "fund"},
    "roe": {"label": "Return on equity", "group": "Profitability", "unit": "pct", "kind": "fund"},
    "rnd_intensity": {"label": "R&D / revenue", "group": "Profitability", "unit": "pct", "kind": "fund"},
    # growth & balance sheet
    "revenue_growth": {"label": "Revenue growth (YoY)", "group": "Growth", "unit": "pct", "kind": "fund"},
    "debt_to_equity": {"label": "Debt / equity", "group": "Balance sheet", "unit": "x", "kind": "fund"},
    "current_ratio": {"label": "Current ratio", "group": "Balance sheet", "unit": "x", "kind": "fund"},
    # valuation (price x fundamentals)
    "ps_ratio": {"label": "Price / sales (TTM)", "group": "Valuation", "unit": "x", "kind": "val"},
    "pe_ratio": {"label": "Price / earnings (TTM)", "group": "Valuation", "unit": "x", "kind": "val"},
    "fcf_yield": {"label": "FCF yield (TTM)", "group": "Valuation", "unit": "pct", "kind": "val"},
    "ocf_yield": {"label": "OCF yield (TTM)", "group": "Valuation", "unit": "pct", "kind": "val"},
    # price-based
    "mom_1m": {"label": "Momentum 1M", "group": "Price", "unit": "pct", "kind": "price"},
    "mom_3m": {"label": "Momentum 3M", "group": "Price", "unit": "pct", "kind": "price"},
    "mom_6m": {"label": "Momentum 6M", "group": "Price", "unit": "pct", "kind": "price"},
    "mom_12_1": {"label": "Momentum 12M ex last month", "group": "Price", "unit": "pct", "kind": "price"},
    "vol_3m": {"label": "Volatility 3M (annualised)", "group": "Price", "unit": "pct", "kind": "price"},
    "beta_1y": {"label": "Beta 1Y vs benchmark", "group": "Price", "unit": "x", "kind": "price"},
    "dist_52w_high": {"label": "Distance from 52W high", "group": "Price", "unit": "pct", "kind": "price"},
}

TARGETS = {
    "fwd_excess": {"label": "Forward return vs benchmark", "group": "Outcome", "unit": "pct"},
    "fwd_return": {"label": "Forward return (absolute)", "group": "Outcome", "unit": "pct"},
}


def factor_catalog() -> dict:
    return {
        "factors": [{"id": k, **v} for k, v in FACTORS.items()],
        "targets": [{"id": k, **v} for k, v in TARGETS.items()],
    }


# ------------------------------------------------------------------ helpers

def _asof(frame: pd.DataFrame, dates: pd.DatetimeIndex) -> pd.DataFrame:
    """Value of each column as of each date (last observation on or before)."""
    idx = frame.index.union(dates)
    return frame.reindex(idx).ffill(limit=10).reindex(dates)


def _price_factor(name: str, panel: pd.DataFrame, bench: str, dates: pd.DatetimeIndex) -> pd.DataFrame:
    px = _asof(panel, dates)
    lag = lambda days: _asof(panel, dates - pd.Timedelta(days=days)).set_axis(dates)  # noqa: E731
    if name == "mom_1m":
        return px / lag(30) - 1
    if name == "mom_3m":
        return px / lag(91) - 1
    if name == "mom_6m":
        return px / lag(182) - 1
    if name == "mom_12_1":
        return lag(30) / lag(365) - 1
    rets = panel.pct_change(fill_method=None)
    if name == "vol_3m":
        return _asof(rets.rolling(63, min_periods=40).std() * math.sqrt(252), dates)
    if name == "beta_1y":
        b = rets[bench]
        cov = rets.rolling(252, min_periods=120).cov(b)
        var = b.rolling(252, min_periods=120).var()
        return _asof(cov.div(var, axis=0), dates)
    if name == "dist_52w_high":
        hi = panel.rolling(252, min_periods=120).max()
        return _asof(panel / hi - 1, dates)
    raise KeyError(name)


def _market_cap(panel: pd.DataFrame, tickers: list[str], dates: pd.DatetimeIndex) -> pd.DataFrame:
    """Historical market cap ≈ today's market cap scaled by adjusted price ratio.
    Split-safe (both sides are split-adjusted); ignores buyback-driven share count drift."""
    profs = metrics.profiles()
    px = _asof(panel[tickers], dates)
    last = panel[tickers].ffill().iloc[-1]
    mcap_now = pd.Series({t: (profs.get(t) or {}).get("marketCap") for t in tickers}, dtype=float)
    return px.div(last).mul(mcap_now)


def factor_frame(name: str, tickers: list[str], dates: pd.DatetimeIndex, bench: str) -> pd.DataFrame:
    panel = metrics.close_panel()
    spec = FACTORS[name]
    if spec["kind"] == "price":
        cols = [t for t in tickers if t in panel] + ([bench] if bench not in tickers else [])
        return _price_factor(name, panel[cols], bench, dates).reindex(columns=tickers)
    if spec["kind"] == "fund":
        return metrics.point_in_time(name, dates, tickers)
    # valuation
    have = [t for t in tickers if t in panel]
    mcap = _market_cap(panel, have, dates).reindex(columns=tickers)
    if name == "ps_ratio":
        return mcap / metrics.point_in_time("ttm_revenue", dates, tickers).where(lambda d: d > 0)
    if name == "pe_ratio":
        return mcap / metrics.point_in_time("ttm_ni", dates, tickers).where(lambda d: d > 0)
    if name == "fcf_yield":
        return metrics.point_in_time("ttm_fcf", dates, tickers) / mcap
    if name == "ocf_yield":
        return metrics.point_in_time("ttm_ocf", dates, tickers) / mcap
    raise KeyError(name)


def _rank_corr(x: pd.Series, y: pd.Series) -> float | None:
    if len(x) < 4:
        return None
    r = x.rank().corr(y.rank())
    return None if pd.isna(r) else float(r)


def _stats(x: pd.Series, y: pd.Series) -> dict:
    n = int(len(x))
    if n < 4:
        return {"n": n, "pearson": None, "spearman": None, "t": None, "p": None, "slope": None, "intercept": None}
    r = float(x.corr(y))
    rho = float(x.rank().corr(y.rank()))
    t = rho * math.sqrt((n - 2) / max(1e-12, 1 - rho * rho))
    p = math.erfc(abs(t) / math.sqrt(2))  # normal approximation, fine for n > ~30
    slope, intercept = np.polyfit(x.to_numpy(), y.to_numpy(), 1)
    return {"n": n, "pearson": r, "spearman": rho, "t": t, "p": p,
            "slope": float(slope), "intercept": float(intercept)}


def _winsorize(s: pd.Series, q: float = 0.02) -> pd.Series:
    if len(s) < 20:
        return s
    lo, hi = s.quantile(q), s.quantile(1 - q)
    return s.clip(lo, hi)


def _f(v):
    if v is None:
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or math.isinf(v) else v


# ------------------------------------------------------------------ request / run

@dataclass
class ResearchRequest:
    x: str
    y: str = "fwd_excess"
    sector: str | None = "ai"
    tiers: list[str] = field(default_factory=list)
    tickers: list[str] = field(default_factory=list)
    benchmark: str = "QQQ"
    horizon_months: int = 3
    lookback_years: float = 3
    # cohort definition: "quantile" (top fraction by X) or "threshold" (X op value)
    cohort: str = "quantile"
    quantile: float = 0.5
    threshold: float | None = None
    op: str = ">"
    higher_is_better: bool = True
    winsorize: bool = True


def universe(req: ResearchRequest) -> list[str]:
    if req.tickers:
        return [t.upper() for t in req.tickers]
    sectors = [get_sector(req.sector)] if req.sector else list(load_sectors().values())
    out: dict[str, None] = {}
    for s in sectors:
        if not s:
            continue
        for tier in s.tiers:
            if not req.tiers or tier.id in req.tiers:
                for t in tier.tickers:
                    out[t] = None
    return list(out)


def run(req: ResearchRequest) -> dict:
    if req.x not in FACTORS:
        raise ValueError(f"unknown factor {req.x}")
    if req.y not in FACTORS and req.y not in TARGETS:
        raise ValueError(f"unknown target {req.y}")

    panel = metrics.close_panel()
    if panel.empty:
        raise ValueError("no price data yet — run the ingest first")
    bench = req.benchmark.upper()
    if bench not in panel:
        raise ValueError(f"no price data for benchmark {bench}")
    tickers = [t for t in universe(req) if t in panel]
    if len(tickers) < 3:
        raise ValueError("need at least 3 companies with price data in the universe")

    last = panel.index[-1]
    h = req.horizon_months
    n_periods = max(1, int(req.lookback_years * 12 // h))
    starts = pd.DatetimeIndex(sorted(last - pd.DateOffset(months=h * k) for k in range(1, n_periods + 1)))
    ends = starts + pd.DateOffset(months=h)
    all_dates = starts.append(pd.DatetimeIndex([last]))

    X = factor_frame(req.x, tickers, all_dates, bench)
    current = X.iloc[-1]
    X = X.iloc[:-1]

    px = panel[tickers + ([bench] if bench not in tickers else [])]
    p0 = _asof(px, starts)
    p1 = _asof(px, ends).set_axis(starts)
    fwd = (p1 / p0 - 1)
    bench_fwd = fwd[bench]
    fwd = fwd[tickers]
    excess = fwd.sub(bench_fwd, axis=0)

    forward_target = req.y in TARGETS
    if forward_target:
        Y = excess if req.y == "fwd_excess" else fwd
        Y_dates = starts
    else:
        Y_all = factor_frame(req.y, tickers, all_dates, bench)
        Y = Y_all.iloc[:-1]
        Y_dates = starts

    # ---- observations (long form)
    obs = (
        pd.DataFrame({"x": X.stack(future_stack=True), "y": Y.stack(future_stack=True)})
        .dropna()
        .reset_index()
        .rename(columns={"level_0": "date", "level_1": "ticker"})
    )
    obs.columns = ["date", "ticker", "x", "y"]
    xs = _winsorize(obs["x"]) if req.winsorize else obs["x"]
    ys = _winsorize(obs["y"]) if req.winsorize else obs["y"]
    pooled = _stats(xs, ys)

    # ---- per-period rank IC
    ic = []
    for d in Y_dates:
        if d not in X.index:
            continue
        pair = pd.DataFrame({"x": X.loc[d], "y": Y.loc[d]}).dropna()
        ic.append({"date": d.strftime("%Y-%m-%d"), "ic": _f(_rank_corr(pair["x"], pair["y"])), "n": len(pair)})
    ic_vals = [p["ic"] for p in ic if p["ic"] is not None]

    result: dict = {
        "request": req.__dict__,
        "universe": tickers,
        "x": {"id": req.x, **FACTORS[req.x]},
        "y": {"id": req.y, **(TARGETS.get(req.y) or FACTORS[req.y])},
        "periods": [{"start": s.strftime("%Y-%m-%d"), "end": e.strftime("%Y-%m-%d")} for s, e in zip(starts, ends)],
        "coverage": {t: int(X[t].notna().sum()) for t in tickers},
        "observations": [
            {"date": r.date.strftime("%Y-%m-%d"), "ticker": r.ticker, "x": _f(r.x), "y": _f(r.y)}
            for r in obs.itertuples(index=False)
        ],
        "stats": {k: _f(v) if k != "n" else v for k, v in pooled.items()},
        "ic": ic,
        "ic_summary": {
            "mean": _f(np.mean(ic_vals)) if ic_vals else None,
            "positive_share": _f(np.mean([v > 0 for v in ic_vals])) if ic_vals else None,
            "periods": len(ic_vals),
        },
        "current": sorted(
            [{"ticker": t, "x": _f(current.get(t))} for t in tickers],
            key=lambda r: (r["x"] is None, -(r["x"] or 0) if req.higher_is_better else (r["x"] or 0)),
        ),
    }

    if forward_target:
        result["cohort"] = _cohort_test(req, X, fwd, bench_fwd, starts, ends)
    else:
        # cross-sectional snapshot today, X vs Y
        yc = Y_all.iloc[-1]
        snap = pd.DataFrame({"x": current, "y": yc}).dropna()
        result["latest"] = {
            "date": last.strftime("%Y-%m-%d"),
            "points": [{"ticker": t, "x": _f(r.x), "y": _f(r.y)} for t, r in snap.iterrows()],
            "stats": {k: _f(v) if k != "n" else v for k, v in _stats(snap["x"], snap["y"]).items()},
        }
    return result


def _in_cohort(req: ResearchRequest, xrow: pd.Series) -> pd.Series:
    x = xrow.dropna()
    if req.cohort == "threshold" and req.threshold is not None:
        ops = {">": x > req.threshold, ">=": x >= req.threshold, "<": x < req.threshold, "<=": x <= req.threshold}
        return ops.get(req.op, x > req.threshold)
    q = min(max(req.quantile, 0.05), 0.95)
    if req.higher_is_better:
        return x >= x.quantile(1 - q)
    return x <= x.quantile(q)


def _cohort_test(req, X, fwd, bench_fwd, starts, ends) -> dict:
    rows = []
    cum = {"in": 1.0, "out": 1.0, "universe": 1.0, "bench": 1.0}
    curve = [{"date": starts[0].strftime("%Y-%m-%d"), **cum}] if len(starts) else []
    for s, e in zip(starts, ends):
        mask = _in_cohort(req, X.loc[s])
        valid = fwd.loc[s].dropna()
        ins = [t for t in mask[mask].index if t in valid.index]
        outs = [t for t in valid.index if t not in ins and t in mask.index]
        r_in = float(valid[ins].mean()) if ins else None
        r_out = float(valid[outs].mean()) if outs else None
        r_uni = float(valid.mean()) if len(valid) else None
        r_b = _f(bench_fwd.loc[s])
        for k, v in (("in", r_in), ("out", r_out), ("universe", r_uni), ("bench", r_b)):
            if v is not None:
                cum[k] *= 1 + v
        rows.append({
            "start": s.strftime("%Y-%m-%d"), "end": e.strftime("%Y-%m-%d"),
            "in": _f(r_in), "out": _f(r_out), "universe": _f(r_uni), "bench": r_b,
            "members": ins, "n_in": len(ins), "n_out": len(outs),
        })
        curve.append({"date": e.strftime("%Y-%m-%d"), **cum})

    def hit(a, b):
        pairs = [(r[a], r[b]) for r in rows if r[a] is not None and r[b] is not None]
        return _f(np.mean([x > y for x, y in pairs])) if pairs else None

    def avg(key, minus=None):
        vals = [r[key] - (r[minus] if minus else 0) for r in rows
                if r[key] is not None and (minus is None or r[minus] is not None)]
        return _f(np.mean(vals)) if vals else None

    years = max(1e-9, len(rows) * req.horizon_months / 12)
    cagr = {k: _f(cum[k] ** (1 / years) - 1) for k in cum}
    return {
        "rows": rows,
        "curve": curve,
        "summary": {
            "periods": len(rows),
            "hit_vs_bench": hit("in", "bench"),
            "hit_vs_out": hit("in", "out"),
            "out_hit_vs_bench": hit("out", "bench"),
            "avg_excess_in": avg("in", "bench"),
            "avg_excess_out": avg("out", "bench"),
            "avg_spread": avg("in", "out"),
            "total": {k: _f(v - 1) for k, v in cum.items()},
            "cagr": cagr,
        },
    }
