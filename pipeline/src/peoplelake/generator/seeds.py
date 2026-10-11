"""Committed dbt seeds derived from the generator: oracle metrics, expected counts, reference data."""

from __future__ import annotations

from pathlib import Path

from .dataset import generate
from .manifest import expected_event_counts_rows
from .oracle import oracle_csv, oracle_rows
from .profiles import PROFILES
from .reference import reference_csvs


def seed_files() -> dict[str, str]:
    """Relative path under warehouse/seeds -> exact file content."""
    rows = []
    counts = ["profile,source,event_type,expected_count"]
    for name in sorted(PROFILES):
        ds = generate(PROFILES[name])
        rows += oracle_rows(ds.world)
        counts += [f"{p},{s},{t},{n}" for p, s, t, n in expected_event_counts_rows(ds)]
    rows.sort(key=lambda r: (r["profile"], r["month"], r["department_id"]))
    files = {
        "oracle/oracle_workforce_monthly.csv": oracle_csv(rows),
        "oracle/expected_event_counts.csv": "\n".join(counts) + "\n",
    }
    for name, text in reference_csvs().items():
        files[f"reference/{name}"] = text
    return files


def write_seeds(seeds_dir: Path) -> list[Path]:
    written = []
    for rel, text in seed_files().items():
        path = seeds_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        written.append(path)
    return written
