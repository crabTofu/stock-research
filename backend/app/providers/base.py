"""Provider interface. Implement this to plug in another data source
(SEC EDGAR, Financial Modeling Prep, Polygon, a paid feed...)."""
from __future__ import annotations

from datetime import date
from typing import Any, Protocol

# (date 'YYYY-MM-DD', open, high, low, close, volume) — prices adjusted for splits & dividends
PriceRow = tuple[str, float, float, float, float, float]
# (freq 'Q'|'A', period_end 'YYYY-MM-DD', statement, item, value)
FinancialRow = tuple[str, str, str, str, float]


class Provider(Protocol):
    name: str

    def prices(self, ticker: str, start: date | None) -> list[PriceRow]:
        """Daily bars from `start` (inclusive) to today. `start=None` means full history."""

    def financials(self, ticker: str) -> list[FinancialRow]:
        """Income statement, balance sheet and cash flow, quarterly and annual."""

    def profile(self, ticker: str) -> dict[str, Any]:
        """Descriptive data: name, industry, summary, market cap, shares, website..."""

    def news(self, ticker: str) -> list[dict[str, Any]]:
        """Recent headlines: id, published (ISO), title, publisher, link, summary, thumbnail."""
