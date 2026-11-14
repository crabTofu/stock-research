"""Yahoo Finance via the `yfinance` package.

Free and broad (prices, ~5 quarters + 4 years of statements, news, profile) but
unofficial and rate-limited, which is why everything is cached locally.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
import yfinance as yf

from .base import FinancialRow, PriceRow

PROFILE_KEYS = [
    "longName", "shortName", "sector", "industry", "country", "website", "longBusinessSummary",
    "fullTimeEmployees", "marketCap", "enterpriseValue", "sharesOutstanding", "currency",
    "trailingPE", "forwardPE", "priceToSalesTrailing12Months", "enterpriseToRevenue",
    "enterpriseToEbitda", "pegRatio", "priceToBook", "beta", "dividendYield",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "averageVolume", "grossMargins", "operatingMargins",
    "profitMargins", "revenueGrowth", "earningsGrowth", "returnOnEquity", "returnOnAssets",
    "totalCash", "totalDebt", "freeCashflow", "operatingCashflow", "totalRevenue", "ebitda",
    "recommendationKey", "targetMeanPrice", "numberOfAnalystOpinions", "quoteType", "exchange",
]


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


class YahooProvider:
    name = "yahoo"

    def prices(self, ticker: str, start: date | None) -> list[PriceRow]:
        t = yf.Ticker(ticker)
        if start is None:
            df = t.history(period="max", auto_adjust=True, actions=False)
        else:
            df = t.history(start=start.isoformat(), end=(date.today() + timedelta(days=1)).isoformat(),
                           auto_adjust=True, actions=False)
        if df is None or df.empty:
            return []
        df = df.dropna(subset=["Close"])
        idx = pd.DatetimeIndex(df.index).tz_localize(None).strftime("%Y-%m-%d")
        return list(zip(
            idx,
            df["Open"].astype(float), df["High"].astype(float), df["Low"].astype(float),
            df["Close"].astype(float), df["Volume"].astype(float),
        ))

    def financials(self, ticker: str) -> list[FinancialRow]:
        t = yf.Ticker(ticker)
        frames = {
            ("Q", "income"): t.quarterly_income_stmt,
            ("Q", "balance"): t.quarterly_balance_sheet,
            ("Q", "cashflow"): t.quarterly_cashflow,
            ("A", "income"): t.income_stmt,
            ("A", "balance"): t.balance_sheet,
            ("A", "cashflow"): t.cashflow,
        }
        out: list[FinancialRow] = []
        for (freq, statement), df in frames.items():
            if df is None or df.empty:
                continue
            for col in df.columns:
                period = pd.Timestamp(col).strftime("%Y-%m-%d")
                for item, value in df[col].items():
                    v = _num(value)
                    if v is not None:
                        out.append((freq, period, statement, str(item), v))
        return out

    def profile(self, ticker: str) -> dict[str, Any]:
        info = yf.Ticker(ticker).info or {}
        return {k: info.get(k) for k in PROFILE_KEYS if info.get(k) is not None}

    def news(self, ticker: str) -> list[dict[str, Any]]:
        items = yf.Ticker(ticker).news or []
        out = []
        for raw in items:
            c = raw.get("content", raw)
            nid = raw.get("id") or c.get("id")
            if not nid:
                continue
            link = (c.get("clickThroughUrl") or {}).get("url") or (c.get("canonicalUrl") or {}).get("url")
            thumb = None
            res = ((c.get("thumbnail") or {}).get("resolutions")) or []
            small = [r for r in res if r.get("tag") != "original"]
            if small or res:
                thumb = (small or res)[0].get("url")
            published = c.get("pubDate") or c.get("displayTime")
            if isinstance(published, (int, float)):
                published = datetime.utcfromtimestamp(published).isoformat() + "Z"
            out.append({
                "id": nid,
                "published": published,
                "title": c.get("title"),
                "publisher": (c.get("provider") or {}).get("displayName") or c.get("publisher"),
                "link": link,
                "summary": c.get("summary") or c.get("description"),
                "thumbnail": thumb,
            })
        return out
