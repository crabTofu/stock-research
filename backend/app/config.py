"""Runtime settings. Override any value with an environment variable of the same name."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _env(name: str, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return type(default)(raw)


@dataclass(frozen=True)
class Settings:
    db_path: Path = Path(_env("DB_PATH", str(ROOT / "data" / "market.db")))
    sectors_dir: Path = Path(_env("SECTORS_DIR", str(ROOT / "config" / "sectors")))
    frontend_dist: Path = ROOT / "frontend" / "dist"

    # How far back to pull price history on first sync.
    price_history_years: int = _env("PRICE_HISTORY_YEARS", 10)

    # Freshness windows (seconds). Data younger than this is served from the local DB.
    ttl_prices: int = _env("TTL_PRICES", 6 * 3600)
    ttl_fundamentals: int = _env("TTL_FUNDAMENTALS", 7 * 24 * 3600)
    ttl_profile: int = _env("TTL_PROFILE", 24 * 3600)
    ttl_news: int = _env("TTL_NEWS", 30 * 60)

    # Parallel requests to the data provider. Keep low to stay under rate limits.
    fetch_workers: int = _env("FETCH_WORKERS", 4)

    # Refresh stale data in a background thread when the server starts.
    sync_on_startup: bool = _env("SYNC_ON_STARTUP", "1") not in ("0", "false", "False")


settings = Settings()
