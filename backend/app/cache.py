"""A tiny memo cache keyed on the DB data_version.

Any ingest bumps the version, so cached panels/snapshots invalidate automatically
without TTL guesswork. Reading the version is one indexed SELECT (~µs).
"""
from __future__ import annotations

import functools
import threading
from collections import OrderedDict

from . import db


def versioned(maxsize: int = 64):
    def deco(fn):
        cache: OrderedDict = OrderedDict()
        lock = threading.Lock()

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            key = (db.data_version(), args, tuple(sorted(kwargs.items())))
            with lock:
                if key in cache:
                    cache.move_to_end(key)
                    return cache[key]
            value = fn(*args, **kwargs)
            with lock:
                cache[key] = value
                while len(cache) > maxsize:
                    cache.popitem(last=False)
            return value

        wrapper.cache_clear = cache.clear  # type: ignore[attr-defined]
        return wrapper

    return deco
