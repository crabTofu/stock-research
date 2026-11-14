"""SQLite storage.

Design notes
- WAL mode: readers never block on the ingest writer.
- WITHOUT ROWID tables clustered on (ticker, date): range scans for one ticker are
  contiguous on disk.
- Financials are stored in long format (ticker, freq, period_end, statement, item, value)
  so a new line item or a new provider never needs a schema change.
- `meta.data_version` is bumped after every ingest. In-process caches key on it,
  so they invalidate themselves when new data lands (even from the CLI process).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
    ticker      TEXT PRIMARY KEY,
    name        TEXT,
    profile     TEXT,            -- JSON blob from the provider
    updated_at  REAL
);

CREATE TABLE IF NOT EXISTS prices (
    ticker  TEXT NOT NULL,
    date    TEXT NOT NULL,       -- YYYY-MM-DD
    open    REAL, high REAL, low REAL, close REAL,   -- split/dividend adjusted
    volume  REAL,
    PRIMARY KEY (ticker, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS financials (
    ticker      TEXT NOT NULL,
    freq        TEXT NOT NULL,   -- 'Q' quarterly | 'A' annual
    period_end  TEXT NOT NULL,
    statement   TEXT NOT NULL,   -- income | balance | cashflow
    item        TEXT NOT NULL,
    value       REAL,
    PRIMARY KEY (ticker, freq, period_end, statement, item)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS news (
    ticker      TEXT NOT NULL,
    id          TEXT NOT NULL,
    published   TEXT,
    title       TEXT,
    publisher   TEXT,
    link        TEXT,
    summary     TEXT,
    thumbnail   TEXT,
    PRIMARY KEY (ticker, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS news_by_time ON news (ticker, published DESC);

CREATE TABLE IF NOT EXISTS fetch_log (
    ticker      TEXT NOT NULL,
    dataset     TEXT NOT NULL,   -- prices | fundamentals | profile | news
    fetched_at  REAL NOT NULL,
    ok          INTEGER NOT NULL,
    error       TEXT,
    PRIMARY KEY (ticker, dataset)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('data_version', '0');
"""

_local = threading.local()
_init_lock = threading.Lock()
_initialised = False


def _connect() -> sqlite3.Connection:
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-65536")   # 64 MB page cache
    conn.execute("PRAGMA mmap_size=268435456") # 256 MB memory-mapped reads
    return conn


def init_db() -> None:
    global _initialised
    with _init_lock:
        if _initialised:
            return
        conn = _connect()
        conn.executescript(SCHEMA)
        conn.commit()
        conn.close()
        _initialised = True


def conn() -> sqlite3.Connection:
    """One connection per thread (sqlite3 connections are not thread-safe)."""
    c = getattr(_local, "conn", None)
    if c is None:
        init_db()
        c = _connect()
        _local.conn = c
    return c


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        yield c
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise


def data_version() -> int:
    row = conn().execute("SELECT value FROM meta WHERE key='data_version'").fetchone()
    return int(row[0]) if row else 0


def bump_version(c: sqlite3.Connection) -> None:
    c.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='data_version'")


# ---------------------------------------------------------------- fetch log

def last_fetch(ticker: str, dataset: str) -> sqlite3.Row | None:
    return conn().execute(
        "SELECT fetched_at, ok, error FROM fetch_log WHERE ticker=? AND dataset=?",
        (ticker, dataset),
    ).fetchone()


def is_fresh(ticker: str, dataset: str, ttl: int) -> bool:
    row = last_fetch(ticker, dataset)
    return bool(row and row["ok"] and time.time() - row["fetched_at"] < ttl)


def log_fetch(c: sqlite3.Connection, ticker: str, dataset: str, ok: bool, error: str | None = None) -> None:
    c.execute(
        "INSERT OR REPLACE INTO fetch_log (ticker, dataset, fetched_at, ok, error) VALUES (?,?,?,?,?)",
        (ticker, dataset, time.time(), int(ok), error),
    )


# ---------------------------------------------------------------- writers

def upsert_prices(c: sqlite3.Connection, ticker: str, rows: Iterable[tuple]) -> int:
    rows = list(rows)
    c.executemany(
        "INSERT OR REPLACE INTO prices (ticker, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
        [(ticker, *r) for r in rows],
    )
    return len(rows)


def replace_prices(c: sqlite3.Connection, ticker: str, rows: Iterable[tuple]) -> int:
    c.execute("DELETE FROM prices WHERE ticker=?", (ticker,))
    return upsert_prices(c, ticker, rows)


def upsert_financials(c: sqlite3.Connection, ticker: str, rows: Iterable[tuple]) -> int:
    rows = list(rows)
    c.executemany(
        "INSERT OR REPLACE INTO financials (ticker, freq, period_end, statement, item, value) VALUES (?,?,?,?,?,?)",
        [(ticker, *r) for r in rows],
    )
    return len(rows)


def upsert_profile(c: sqlite3.Connection, ticker: str, name: str | None, profile: dict[str, Any]) -> None:
    c.execute(
        "INSERT OR REPLACE INTO companies (ticker, name, profile, updated_at) VALUES (?,?,?,?)",
        (ticker, name, json.dumps(profile, default=str), time.time()),
    )


def upsert_news(c: sqlite3.Connection, ticker: str, items: Iterable[dict[str, Any]]) -> int:
    rows = [
        (ticker, i["id"], i.get("published"), i.get("title"), i.get("publisher"),
         i.get("link"), i.get("summary"), i.get("thumbnail"))
        for i in items
    ]
    c.executemany(
        "INSERT OR REPLACE INTO news (ticker, id, published, title, publisher, link, summary, thumbnail) "
        "VALUES (?,?,?,?,?,?,?,?)",
        rows,
    )
    # keep the table bounded
    c.execute(
        "DELETE FROM news WHERE ticker=? AND id NOT IN "
        "(SELECT id FROM news WHERE ticker=? ORDER BY published DESC LIMIT 100)",
        (ticker, ticker),
    )
    return len(rows)
