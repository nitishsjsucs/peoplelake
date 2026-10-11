"""Google Cloud budget constants (SPEC 29.4.6), mirrored from src/shared/free-budget.ts (a test compares them).

The project `master-magnet-444903-u4` is shared by four repos, so this repo plans to use at most 25% of each
free tier: every query is capped at 1 GB billed and labeled `app=peoplelake`, and the BigQuery work of a
calendar month is guarded at 275 GB (the Coordinator for production runs, the drill driver for drills).
"""

from __future__ import annotations

BQ_MAX_BYTES_BILLED = 1_000_000_000
BQ_LABELS = {"app": "peoplelake"}
BQ_MONTHLY_BYTES_CAP = 275_000_000_000
BQ_TRANSFORM_RESERVE_BYTES = 3_000_000_000
