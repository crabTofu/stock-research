"""Sector definitions loaded from config/sectors/*.yaml.

A sector is an ordered list of tiers (supply-chain stages), each holding tickers,
plus supplier -> customer edges. Files are re-read when they change on disk, so
editing the YAML is enough to add companies (no restart needed).
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .config import settings


@dataclass
class Tier:
    id: str
    name: str
    description: str
    tickers: list[str]


@dataclass
class Sector:
    id: str
    name: str
    description: str
    tiers: list[Tier]
    edges: list[tuple[str, str]]
    benchmarks: list[str]
    default_benchmark: str
    tier_of: dict[str, str] = field(default_factory=dict)

    @property
    def tickers(self) -> list[str]:
        return [t for tier in self.tiers for t in tier.tickers]

    def suppliers(self, ticker: str) -> list[str]:
        return [a for a, b in self.edges if b == ticker]

    def customers(self, ticker: str) -> list[str]:
        return [b for a, b in self.edges if a == ticker]


_lock = threading.Lock()
_cache: dict[str, Sector] = {}
_mtimes: dict[Path, float] = {}


def _parse(path: Path) -> Sector:
    raw = yaml.safe_load(path.read_text())
    tiers = [
        Tier(
            id=t["id"],
            name=t["name"],
            description=t.get("description", ""),
            tickers=[s.upper() for s in t["tickers"]],
        )
        for t in raw["tiers"]
    ]
    known = {s for t in tiers for s in t.tickers}
    edges = [(a.upper(), b.upper()) for a, b in raw.get("edges", [])]
    unknown = {s for e in edges for s in e} - known
    if unknown:
        raise ValueError(f"{path.name}: edges reference tickers not in any tier: {sorted(unknown)}")
    benchmarks = [b.upper() for b in raw.get("benchmarks", ["SPY"])]
    sector = Sector(
        id=raw["id"],
        name=raw["name"],
        description=(raw.get("description") or "").strip(),
        tiers=tiers,
        edges=edges,
        benchmarks=benchmarks,
        default_benchmark=raw.get("default_benchmark", benchmarks[0]).upper(),
    )
    sector.tier_of = {s: t.id for t in tiers for s in t.tickers}
    return sector


def load_sectors() -> dict[str, Sector]:
    with _lock:
        files = sorted(settings.sectors_dir.glob("*.y*ml"))
        current = {p: p.stat().st_mtime for p in files}
        if current != _mtimes:
            _cache.clear()
            for p in files:
                s = _parse(p)
                _cache[s.id] = s
            _mtimes.clear()
            _mtimes.update(current)
        return dict(_cache)


def get_sector(sector_id: str) -> Sector | None:
    return load_sectors().get(sector_id)


def all_tickers(include_benchmarks: bool = True) -> list[str]:
    out: dict[str, None] = {}
    for s in load_sectors().values():
        for t in s.tickers:
            out[t] = None
        if include_benchmarks:
            for b in s.benchmarks:
                out[b] = None
    return list(out)


def all_benchmarks() -> list[str]:
    out: dict[str, None] = {}
    for s in load_sectors().values():
        for b in s.benchmarks:
            out[b] = None
    return list(out) or ["SPY"]


def sectors_for(ticker: str) -> list[Sector]:
    return [s for s in load_sectors().values() if ticker in s.tier_of]
