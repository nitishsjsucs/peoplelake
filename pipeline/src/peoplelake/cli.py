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


def _cmd_reference_digests(args: argparse.Namespace) -> int:
    from .devtools.reference import ReferenceError_, reference_digests
    from .paths import data_dir

    try:
        result = reference_digests(args.profile, Path(args.workdir) if args.workdir else data_dir() / "reference")
    except ReferenceError_ as exc:
        print(f"reference-digests: {exc}", file=sys.stderr)
        return 1
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text + "\n")
    print(text)
    return 0


def _cmd_bq_compile(args: argparse.Namespace) -> int:
    from .devtools.bq_offline import BRANCHES, compile_branch
    from .paths import data_dir

    root = Path(args.workdir) if args.workdir else data_dir() / "bq-compile"
    failed = False
    for branch in BRANCHES:
        report = compile_branch(branch, root / branch)
        status = "ok" if report.ok else "FAILED"
        print(
            f"{branch}: {report.compiled_models} models and {report.compiled_tests} tests compiled for BigQuery offline;"
            f" sqlglot parse and ORDER BY lint {status}"
        )
        for err in report.parse_errors:
            print(f"  parse: {err}")
        for v in report.order_violations:
            print(f"  lint: {v.file}:{v.line} ORDER BY item without NULLS FIRST/LAST: {v.item}")
        failed = failed or not report.ok
    return 1 if failed else 0


def _cmd_lint_sql(args: argparse.Namespace) -> int:
    from .devtools.lint_sql import lint_compiled

    violations = lint_compiled(Path(args.compiled_dir))
    for v in violations:
        print(f"{v.file}:{v.line} ORDER BY item without NULLS FIRST/LAST: {v.item}")
    print(f"lint-sql: {len(violations)} violation(s)")
    return 1 if violations else 0


def _cmd_lake(args: argparse.Namespace) -> int:
    from .config import load_settings, open_lake
    from .lake.reader import current_snapshot_id, read_appends

    settings = load_settings(args.target)
    if args.lake_command == "catalog-info":
        from .lake.catalog import basin_catalog, catalog_info, local_catalog

        if settings.is_local:
            info = catalog_info(local_catalog(settings.lake_dir))
            info["stand_in"] = "pyiceberg SqlCatalog (local)"
        else:
            info = catalog_info(
                basin_catalog(
                    settings.r2_catalog_uri or "", settings.r2_warehouse or "", settings.r2_catalog_token or ""
                )
            )
        print(json.dumps(info, indent=2))
        return 0
    table = open_lake(settings)
    if args.lake_command == "init":
        print(json.dumps({"table": "peoplelake.raw_events", "current_snapshot": current_snapshot_id(table)}))
        return 0
    if args.lake_command == "commit":
        from .lake.committer import DirectorySinkSource, commit_pending

        if not settings.is_local:
            print("lake commit is the local stand-in for the Basin sink and never runs in production", file=sys.stderr)
            return 2
        report = commit_pending(DirectorySinkSource(Path(args.sink_dir)), table, recommit=args.recommit)
        print(json.dumps(report.__dict__))
        return 0
    batch = read_appends(
        table,
        int(args.from_snapshot) if args.from_snapshot else None,
        int(args.to_snapshot) if args.to_snapshot else None,
    )
    print(json.dumps(batch.info.__dict__))
    return 0


def _cmd_auth(args: argparse.Namespace) -> int:
    from .auth.dev_tokens import generate_dev_keys, mint
    from .config import load_settings
    from .paths import repo_root

    settings = load_settings()
    if args.auth_command == "dev-keys":
        jwks = generate_dev_keys(settings.dev_keys_dir, repo_root() / ".dev.vars")
        print(
            f"wrote {settings.dev_keys_dir}/private.pem, jwks.json and DEV_ACCESS_JWKS in .dev.vars (kid {jwks['keys'][0]['kid']})"
        )
        return 0
    print(mint(args.identity, keys_dir=settings.dev_keys_dir, ttl_seconds=args.ttl))
    return 0


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

    auth = sub.add_parser("auth", help="local dev keys and tokens")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True)
    keys = auth_sub.add_parser(
        "dev-keys", help="generate RS256 dev keys into .dev/keys and DEV_ACCESS_JWKS into .dev.vars"
    )
    keys.set_defaults(func=_cmd_auth)
    tok = auth_sub.add_parser("dev-token", help="print a dev Access JWT")
    tok.add_argument("identity", help="runner, hris, ats, talent, operator or an email address")
    tok.add_argument("--ttl", type=int, default=300)
    tok.set_defaults(func=_cmd_auth)

    lake = sub.add_parser("lake", help="Iceberg lake: local stand-in or Basin Catalog")
    lake_sub = lake.add_subparsers(dest="lake_command", required=True)
    for name, help_text in (
        ("init", "create the local raw_events table (local only)"),
        ("commit", "commit sink roll files from a directory (local stand-in)"),
        ("scan", "read appended data between snapshots and print counts"),
        ("catalog-info", "print catalog URI, warehouse and REST prefix"),
    ):
        lp = lake_sub.add_parser(name, help=help_text)
        lp.add_argument("--target", choices=["local", "prod"], default=None)
        if name == "commit":
            lp.add_argument("--sink-dir", required=True)
            lp.add_argument("--recommit", type=int, default=0)
        if name == "scan":
            lp.add_argument("--from-snapshot")
            lp.add_argument("--to-snapshot")
        lp.set_defaults(func=_cmd_lake)

    dev = sub.add_parser("dev", help="developer and CI tools")
    dev_sub = dev.add_subparsers(dest="dev_command", required=True)
    ref = dev_sub.add_parser(
        "reference-digests", help="straight load + incremental and full-refresh builds (SPEC 15.4)"
    )
    ref.add_argument("--profile", choices=["full", "small"], default="small")
    ref.add_argument("--workdir")
    ref.add_argument("--out")
    ref.set_defaults(func=_cmd_reference_digests)

    bqc = dev_sub.add_parser("bq-compile", help="offline BigQuery compile (both branches), sqlglot parse and SQL lint")
    bqc.add_argument("--workdir")
    bqc.set_defaults(func=_cmd_bq_compile)
    lint = dev_sub.add_parser("lint-sql", help="require NULLS FIRST/LAST on every ORDER BY item of compiled SQL")
    lint.add_argument("compiled_dir")
    lint.set_defaults(func=_cmd_lint_sql)

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
