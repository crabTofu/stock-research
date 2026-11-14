"""Read models built from the local DB: price panels, snapshots, statements,
and point-in-time fundamentals for research. Heavy frames are memoised on the
DB data_version (see cache.py)."""
from __future__ import annotations

import json
import math
from datetime import date

import numpy as np
import pandas as pd

from . import db
from .cache import versioned

# Reporting lag: a quarter's numbers are assumed public this many days after
# period end (10-Q deadline ~40-45d; 10-K ~60-90d). Prevents look-ahead bias.
LAG_DAYS = {"Q": 45, "A": 75}
# Beyond this age a point-in-time value is considered stale and dropped.
MAX_AGE_DAYS = {"Q": 200, "A": 460}


def _clean(v):
    if v is None:
        return None
    if isinstance(v, (float, np.floating)):
        return None if math.isnan(v) or math.isinf(v) else float(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


# ------------------------------------------------------------------ prices

@versioned(maxsize=4)
def close_panel() -> pd.DataFrame:
    """date x ticker matrix of adjusted closes for everything stored."""
    df = pd.read_sql_query("SELECT ticker, date, close FROM prices", db.conn())
    if df.empty:
        return pd.DataFrame()
    df["date"] = pd.to_datetime(df["date"])
    return df.pivot(index="date", columns="ticker", values="close").sort_index()


def prices(ticker: str, start: str | None = None) -> pd.DataFrame:
    q = "SELECT date, open, high, low, close, volume FROM prices WHERE ticker=?"
    args: list = [ticker]
    if start:
        q += " AND date>=?"
        args.append(start)
    return pd.read_sql_query(q + " ORDER BY date", db.conn(), params=args)


@versioned(maxsize=8)
def profiles() -> dict[str, dict]:
    rows = db.conn().execute("SELECT ticker, name, profile FROM companies").fetchall()
    return {r["ticker"]: {"name": r["name"], **json.loads(r["profile"] or "{}")} for r in rows}


def _ret(s: pd.Series, days: int) -> float | None:
    s = s.dropna()
    if len(s) < 2:
        return None
    last_date = s.index[-1]
    past = s[s.index <= last_date - pd.Timedelta(days=days)]
    if past.empty:
        return None
    return float(s.iloc[-1] / past.iloc[-1] - 1)


@versioned(maxsize=16)
def snapshot(tickers: tuple[str, ...]) -> dict[str, dict]:
    panel = close_panel()
    profs = profiles()
    out: dict[str, dict] = {}
    for t in tickers:
        p = profs.get(t, {})
        rec: dict = {
            "ticker": t,
            "name": p.get("name") or p.get("shortName") or t,
            "industry": p.get("industry"),
            "market_cap": p.get("marketCap"),
            "pe": p.get("trailingPE"),
            "fwd_pe": p.get("forwardPE"),
            "ps": p.get("priceToSalesTrailing12Months"),
            "ev_ebitda": p.get("enterpriseToEbitda"),
            "gross_margin": p.get("grossMargins"),
            "operating_margin": p.get("operatingMargins"),
            "revenue_growth": p.get("revenueGrowth"),
            "fcf": p.get("freeCashflow"),
            "ocf": p.get("operatingCashflow"),
            "revenue": p.get("totalRevenue"),
        }
        if not panel.empty and t in panel:
            s = panel[t].dropna()
            if len(s):
                last = s.index[-1]
                ytd_base = s[s.index < pd.Timestamp(last.year, 1, 1)]
                year = s[s.index > last - pd.Timedelta(days=365)]
                spark = s.iloc[-90:]
                step = max(1, len(spark) // 45)
                rec.update(
                    price=float(s.iloc[-1]),
                    as_of=last.strftime("%Y-%m-%d"),
                    chg_1d=float(s.iloc[-1] / s.iloc[-2] - 1) if len(s) > 1 else None,
                    chg_1w=_ret(s, 7),
                    chg_1m=_ret(s, 30),
                    chg_3m=_ret(s, 91),
                    chg_ytd=float(s.iloc[-1] / ytd_base.iloc[-1] - 1) if len(ytd_base) else None,
                    chg_1y=_ret(s, 365),
                    chg_3y=_ret(s, 365 * 3),
                    high_52w=float(year.max()),
                    low_52w=float(year.min()),
                    spark=[round(float(v), 4) for v in spark.iloc[::step]],
                )
        out[t] = {k: _clean(v) for k, v in rec.items()}
    return out


# ------------------------------------------------------------------ statements

KEY_ITEMS = {
    "income": [
        "Total Revenue", "Cost Of Revenue", "Gross Profit", "Research And Development",
        "Selling General And Administration", "Operating Expense", "Operating Income", "EBITDA",
        "Interest Expense", "Pretax Income", "Tax Provision", "Net Income", "Diluted EPS",
        "Diluted Average Shares",
    ],
    "balance": [
        "Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments", "Receivables",
        "Inventory", "Current Assets", "Net PPE", "Goodwill And Other Intangible Assets", "Total Assets",
        "Current Liabilities", "Total Debt", "Net Debt", "Total Liabilities Net Minority Interest",
        "Stockholders Equity", "Ordinary Shares Number",
    ],
    "cashflow": [
        "Operating Cash Flow", "Capital Expenditure", "Free Cash Flow", "Depreciation And Amortization",
        "Stock Based Compensation", "Change In Working Capital", "Investing Cash Flow",
        "Financing Cash Flow", "Repurchase Of Capital Stock", "Cash Dividends Paid", "Issuance Of Debt",
        "Repayment Of Debt",
    ],
}


@versioned(maxsize=64)
def statements(ticker: str, freq: str) -> dict:
    rows = db.conn().execute(
        "SELECT period_end, statement, item, value FROM financials WHERE ticker=? AND freq=?",
        (ticker, freq),
    ).fetchall()
    if not rows:
        return {"periods": [], "statements": {}, "key": {}}
    df = pd.DataFrame(rows, columns=["period_end", "statement", "item", "value"])
    periods = sorted(df["period_end"].unique(), reverse=True)
    out: dict = {"periods": periods, "statements": {}}
    for st, g in df.groupby("statement"):
        wide = g.pivot(index="item", columns="period_end", values="value").reindex(columns=periods)
        key = [i for i in KEY_ITEMS.get(st, []) if i in wide.index]
        rest = sorted(i for i in wide.index if i not in key)
        out["statements"][st] = [
            {"item": i, "key": i in key, "values": [_clean(v) for v in wide.loc[i].tolist()]}
            for i in key + rest
        ]
    out["key"] = _key_series(df, periods)
    return out


def _key_series(df: pd.DataFrame, periods: list[str]) -> dict:
    """Headline metrics per period for charts (oldest -> newest)."""
    w = df.pivot_table(index="period_end", columns="item", values="value", aggfunc="first")
    w = w.reindex(sorted(periods))
    # yfinance sometimes returns a stub period with almost no line items: hide it from charts
    headline = [c for c in ("Total Revenue", "Operating Cash Flow", "Net Income") if c in w]
    if headline:
        w = w[w[headline].notna().any(axis=1)]
    g = lambda c: w[c] if c in w else pd.Series(np.nan, index=w.index)  # noqa: E731
    rev = g("Total Revenue")
    series = {
        "periods": list(w.index),
        "revenue": rev,
        "gross_margin": g("Gross Profit") / rev,
        "operating_margin": g("Operating Income") / rev,
        "net_income": g("Net Income"),
        "net_margin": g("Net Income") / rev,
        "ocf": g("Operating Cash Flow"),
        "fcf": g("Free Cash Flow"),
        "capex": -g("Capital Expenditure"),
        "eps": g("Diluted EPS"),
    }
    return {k: (v if isinstance(v, list) else [_clean(x) for x in v.tolist()]) for k, v in series.items()}


# ------------------------------------------------------------------ point-in-time fundamentals

def _period_metrics(fin: pd.DataFrame) -> pd.DataFrame:
    """One row per (ticker, freq, period_end) with derived ratios and TTM flows."""
    w = fin.pivot_table(index=["ticker", "freq", "period_end"], columns="item", values="value", aggfunc="first")
    g = lambda c: w[c] if c in w else pd.Series(np.nan, index=w.index)  # noqa: E731
    rev = g("Total Revenue").where(lambda s: s > 0)
    ni = g("Net Income")
    # flow items get TTM-summed for quarterly rows; stock items (balance sheet) don't
    flows = {
        "rev": g("Total Revenue"), "gp": g("Gross Profit"), "oi": g("Operating Income"), "ni": ni,
        "ocf": g("Operating Cash Flow"), "fcf": g("Free Cash Flow"),
        "rnd": g("Research And Development"), "capex": -g("Capital Expenditure"),
    }
    m = pd.DataFrame({f"_{k}": v for k, v in flows.items()}, index=w.index)
    equity = g("Stockholders Equity").where(lambda s: s > 0)
    m["debt_to_equity"] = g("Total Debt").fillna(0) / equity
    m["current_ratio"] = g("Current Assets") / g("Current Liabilities")
    m["_equity"] = equity
    m = m.reset_index()
    m["period_end"] = pd.to_datetime(m["period_end"])
    m = m.sort_values(["ticker", "freq", "period_end"]).reset_index(drop=True)

    # TTM: annual rows are already 12 months; quarterly rows sum the last 4 contiguous quarters
    ttm = {k: np.full(len(m), np.nan) for k in flows}
    growth = np.full(len(m), np.nan)
    for (_t, freq), grp in m.groupby(["ticker", "freq"], sort=False):
        idx = grp.index.to_numpy()
        days = (grp["period_end"] - grp["period_end"].min()).dt.days.to_numpy()
        rv = grp["_rev"].to_numpy()
        for i in range(len(grp)):
            lo, hi = (300, 430) if freq == "A" else (340, 390)
            prev = [j for j in range(i) if lo <= days[i] - days[j] <= hi]
            if prev and rv[prev[-1]] and rv[prev[-1]] > 0:
                growth[idx[i]] = rv[i] / rv[prev[-1]] - 1
            if freq == "A":
                for k in flows:
                    ttm[k][idx[i]] = grp[f"_{k}"].iloc[i]
            else:
                window = [j for j in range(i + 1) if days[i] - days[j] < 350]
                if len(window) == 4:
                    for k in flows:
                        ttm[k][idx[i]] = grp[f"_{k}"].iloc[window].sum(min_count=4)
    for k in flows:
        m[f"ttm_{k}"] = ttm[k]
    # single-quarter values as fallback when there aren't 4 quarters yet
    pick = lambda k: m[f"ttm_{k}"].where(m["ttm_rev"].notna(), m[f"_{k}"])  # noqa: E731
    rev = pick("rev").where(lambda s: s > 0)
    m["gross_margin"] = pick("gp") / rev
    m["operating_margin"] = pick("oi") / rev
    m["net_margin"] = pick("ni") / rev
    m["ocf_margin"] = pick("ocf") / rev
    m["fcf_margin"] = pick("fcf") / rev
    m["rnd_intensity"] = pick("rnd") / rev
    m["capex_intensity"] = pick("capex") / rev
    m["cash_conversion"] = (pick("ocf") / pick("ni")).where(pick("ni") > 0)
    m["roe"] = (m["ttm_ni"] / m["_equity"])
    m["revenue_growth"] = growth
    m = m.rename(columns={"ttm_rev": "ttm_revenue"})
    m["available"] = m["period_end"] + m["freq"].map(lambda f: pd.Timedelta(days=LAG_DAYS[f]))
    return m.drop(columns=[c for c in m.columns if c.startswith("_")])


@versioned(maxsize=4)
def period_metrics() -> pd.DataFrame:
    fin = pd.read_sql_query(
        "SELECT ticker, freq, period_end, item, value FROM financials WHERE item IN ("
        + ",".join("?" * 12) + ")",
        db.conn(),
        params=[
            "Total Revenue", "Gross Profit", "Operating Income", "Net Income", "Operating Cash Flow",
            "Free Cash Flow", "Research And Development", "Capital Expenditure", "Stockholders Equity",
            "Total Debt", "Current Assets", "Current Liabilities",
        ],
    )
    if fin.empty:
        return pd.DataFrame()
    return _period_metrics(fin)


def point_in_time(metric: str, dates: pd.DatetimeIndex, tickers: list[str]) -> pd.DataFrame:
    """dates x tickers frame: the latest value of `metric` that was public at each date.
    Quarterly data is preferred; annual fills the gaps (yfinance only keeps ~5 quarters)."""
    pm = period_metrics()
    out = pd.DataFrame(index=dates, columns=tickers, dtype=float)
    if pm.empty or metric not in pm:
        return out
    pm = pm[pm["ticker"].isin(tickers)].dropna(subset=[metric])
    for t, grp in pm.groupby("ticker"):
        best = None
        for freq in ("Q", "A"):
            g = grp[grp["freq"] == freq].sort_values("available")
            if g.empty:
                continue
            vals = pd.Series(g[metric].to_numpy(), index=g["available"]).groupby(level=0).last()
            avail = pd.Series(g["available"].to_numpy(), index=g["available"]).groupby(level=0).last()
            v = vals.reindex(dates, method="ffill")
            age = (dates.to_series() - avail.reindex(dates, method="ffill")).dt.days
            v = v.where(age <= MAX_AGE_DAYS[freq])
            best = v if best is None else best.combine_first(v)
        if best is not None:
            out[t] = best.to_numpy()
    return out


def today() -> str:
    return date.today().isoformat()
