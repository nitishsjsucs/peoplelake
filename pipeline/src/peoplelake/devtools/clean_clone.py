"""Clean clone check (SPEC 17): clone the checked-out commit into a temporary directory and run
`uv sync --locked`, `dbt parse` and the smoke tests there, so nothing gitignored is ever relied on."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from ..paths import repo_root


def run(cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def clean_clone_check() -> int:
    root = repo_root()
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
    ).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="peoplelake-clean-") as tmp:
        clone = Path(tmp) / "peoplelake"
        run(["git", "clone", "--quiet", "--no-local", str(root), str(clone)], Path(tmp), dict(os.environ))
        run(["git", "checkout", "--quiet", head], clone, dict(os.environ))
        env = {k: v for k, v in os.environ.items() if not k.startswith(("PL_", "VIRTUAL_ENV", "UV_PROJECT"))}
        env.update({"TZ": "UTC", "PL_REPO_ROOT": str(clone), "PL_DATA_DIR": str(Path(tmp) / "data")})
        run(["uv", "sync", "--locked", "--project", "pipeline"], clone, env)
        run(["uv", "run", "--project", "pipeline", "peoplelake", "dbt", "parse", "--target", "local"], clone, env)
        run(["uv", "run", "--project", "pipeline", "pytest", "-q", "-m", "smoke", "pipeline/tests"], clone, env)
    print(f"clean clone check passed for {head}")
    return 0


if __name__ == "__main__":
    sys.exit(clean_clone_check())
