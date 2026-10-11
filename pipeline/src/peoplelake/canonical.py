"""Canonical JSON shared with the Worker (src/worker/ingest/canonical-json.ts).

Sorted keys (by Unicode code point), no whitespace, ASCII only (non-ASCII escaped as lowercase
\\uXXXX, astral characters as surrogate pairs), integers only. `contracts/golden/canonical-json.json`
pins the bytes and sha256 for both implementations.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

MAX_SAFE_INTEGER = 2**53 - 1


class CanonicalJsonError(ValueError):
    pass


def _check(value: Any, path: str) -> None:
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError(f"{path}: integer outside the safe range")
        return
    if isinstance(value, float):
        raise CanonicalJsonError(f"{path}: non-integer number {value!r}")
    if isinstance(value, list):
        for i, item in enumerate(value):
            _check(item, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise CanonicalJsonError(f"{path}: non-string key {k!r}")
            _check(v, f"{path}.{k}")
        return
    raise CanonicalJsonError(f"{path}: unsupported type {type(value).__name__}")


def canonical_json(value: Any) -> str:
    _check(value, "$")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("ascii")).hexdigest()
