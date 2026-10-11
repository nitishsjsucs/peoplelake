"""`peoplelake` command line entry point."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _cmd_generate(args: argparse.Namespace) -> int:
    from .generator import generate, get_profile
    from .generator.pins import DATASET_SHA256
    from .generator.seeds import write_seeds
    from .paths import warehouse_dir

    if args.write_seeds:
        for path in write_seeds(warehouse_dir() / "seeds"):
            print(f"wrote {path}")
        return 0
    if not args.profile:
        print("generate: --profile is required unless --write-seeds is given", file=sys.stderr)
        return 2
    ds = generate(get_profile(args.profile))
    manifest = ds.write(Path(args.out)) if args.out else ds.manifest()
    print(
        json.dumps(
            {
                "profile": manifest["profile"],
                "total_events": manifest["total_events"],
                "dataset_sha256": manifest["dataset_sha256"],
            }
        )
    )
    if args.check:
        pinned = DATASET_SHA256.get(args.profile)
        if pinned != manifest["dataset_sha256"]:
            print(f"generate --check: dataset sha256 {manifest['dataset_sha256']} != pinned {pinned}", file=sys.stderr)
            return 1
        print("generate --check: dataset sha256 matches the pin")
    return 0


def _duckdb_path(arg: str | None) -> Path:
    import os

    from .paths import data_dir

    return Path(arg or os.environ.get("PL_DUCKDB_PATH") or data_dir() / "warehouse" / "peoplelake.duckdb")


def _cmd_load_direct(args: argparse.Namespace) -> int:
    from .generator import generate, get_profile
    from .warehouse.direct import canonical_order, envelopes_from_dataset, envelopes_from_dir, load_direct, part
    from .warehouse.duckdb_wh import DuckDBWarehouse

    envelopes = (
        envelopes_from_dir(Path(args.data))
        if args.data
        else envelopes_from_dataset(generate(get_profile(args.profile)))
    )
    items = canonical_order(envelopes)
    if args.parts > 1:
        items = part(items, args.part, args.parts)
    stats = load_direct(DuckDBWarehouse(_duckdb_path(args.duckdb)), items)
    print(
        json.dumps(
            {
                "rows_read": stats.rows_read,
                "rows_inserted": stats.rows_inserted,
                "unique_new_events": stats.unique_new_events,
                "raw_max_load_seq": stats.raw_max_load_seq,
            }
        )
    )
    return 0


def _cmd_warehouse_init(args: argparse.Namespace) -> int:
    from .warehouse.duckdb_wh import DuckDBWarehouse

    path = _duckdb_path(args.duckdb)
    DuckDBWarehouse(path).ensure_raw()
    print(f"raw table ready in {path}")
    return 0


def _cmd_digest(args: argparse.Namespace) -> int:
    from .warehouse.digest import DIGEST_VERSION
    from .warehouse.duckdb_wh import DuckDBWarehouse

    digests = DuckDBWarehouse(_duckdb_path(args.duckdb)).digests(args.suffix)
    payload = {"digest_version": DIGEST_VERSION, "engine": "duckdb", "digests": digests}
    text = json.dumps(payload, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text + "\n")
    print(text)
    return 0


def _cmd_dbt(args: argparse.Namespace) -> int:
    """dbt in process with this repo's project and profiles directories (`peoplelake dbt build ...`)."""
    from dbt.cli.main import dbtRunner

    from .paths import warehouse_dir

    project = warehouse_dir()
    argv = list(args.dbt_args)
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("usage: peoplelake dbt <dbt command> [args]", file=sys.stderr)
        return 2
    extra = []
    if "--project-dir" not in argv:
        extra += ["--project-dir", str(project)]
    if "--profiles-dir" not in argv:
        extra += ["--profiles-dir", str(project)]
    result = dbtRunner().invoke(argv + extra)
    return 0 if result.success else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="peoplelake", description="PeopleLake pipelines")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="generate the synthetic dataset or rewrite the oracle seeds")
    gen.add_argument("--profile", choices=["full", "small"])
    gen.add_argument("--out", help="output directory for hris.jsonl, ats.jsonl, talent.jsonl, manifest.json")
    gen.add_argument("--check", action="store_true", help="fail unless the dataset sha256 equals the pin")
    gen.add_argument("--write-seeds", action="store_true", help="rewrite warehouse/seeds for both profiles")
    gen.set_defaults(func=_cmd_generate)

    wh = sub.add_parser("warehouse", help="local warehouse utilities")
    wh_sub = wh.add_subparsers(dest="warehouse_command", required=True)
    init = wh_sub.add_parser("init", help="create pl_raw.raw_event_deliveries and pl_ops.load_log in DuckDB")
    init.add_argument("--duckdb")
    init.set_defaults(func=_cmd_warehouse_init)
    direct = wh_sub.add_parser("load-direct", help="load generated events straight into DuckDB (no Worker, no lake)")
    direct.add_argument("--profile", choices=["full", "small"], default="small")
    direct.add_argument("--data", help="generated dataset directory (default: generate in memory)")
    direct.add_argument("--duckdb", help="DuckDB file (default: $PL_DUCKDB_PATH or .data/warehouse/peoplelake.duckdb)")
    direct.add_argument("--part", type=int, default=1)
    direct.add_argument("--parts", type=int, default=1)
    direct.set_defaults(func=_cmd_load_direct)

    dbt = sub.add_parser("dbt", help="run dbt in process with the repo's project and profiles directories")
    dbt.add_argument("dbt_args", nargs=argparse.REMAINDER)
    dbt.set_defaults(func=_cmd_dbt)

    dig = sub.add_parser("digest", help="output digests of the 10 published models (open only after `stack down`)")
    dig.add_argument("--duckdb")
    dig.add_argument("--suffix", help="dataset suffix, for example pit")
    dig.add_argument("--out", help="also write the JSON here")
    dig.set_defaults(func=_cmd_digest)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
