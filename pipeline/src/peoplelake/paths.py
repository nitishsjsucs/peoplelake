"""Repository paths. `PL_REPO_ROOT` overrides discovery (the runner image sets it)."""

from __future__ import annotations

import os
from pathlib import Path


def repo_root() -> Path:
    env = os.environ.get("PL_REPO_ROOT")
    if env:
        return Path(env).resolve()
    for start in (Path.cwd(), Path(__file__).resolve()):
        for candidate in (start, *start.parents):
            if (candidate / "warehouse").is_dir() and (candidate / "pipeline" / "pyproject.toml").is_file():
                return candidate
    raise RuntimeError("cannot locate the repository root; set PL_REPO_ROOT")


def warehouse_dir() -> Path:
    return repo_root() / "warehouse"


def data_dir() -> Path:
    return Path(os.environ.get("PL_DATA_DIR", str(repo_root() / ".data"))).resolve()
