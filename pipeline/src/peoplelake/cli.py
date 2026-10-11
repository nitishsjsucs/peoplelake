"""`peoplelake` command line entry point."""

from __future__ import annotations

import argparse
import json
import os
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


def _cmd_metricflow_parity(args: argparse.Namespace) -> int:
    from datetime import UTC, datetime

    from .paths import data_dir, repo_root
    from .semantic.parity import parity_report, write

    workdir = Path(args.workdir) if args.workdir else data_dir() / "metricflow" / args.profile
    command = ("peoplelake dev metricflow-parity " + " ".join(sys.argv[3:])).strip()
    report = parity_report(args.profile, workdir, command)
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    out = (
        Path(args.out)
        if args.out
        else repo_root() / "evals" / "results" / f"metricflow-parity-{args.profile}-{date}.json"
    )
    write(report, out)
    print(
        json.dumps(
            {"rows_compared": report["rows_compared"], "mismatched_rows": report["mismatched_rows"], "out": str(out)}
        )
    )
    return 0 if report["passed"] else 1


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
    from .config import lake_catalog, load_settings, open_lake
    from .lake.reader import current_snapshot_id, read_appends

    settings = load_settings(args.target)
    if args.lake_command == "catalog-info":
        from .lake.catalog import catalog_info

        info = catalog_info(lake_catalog(settings))
        if settings.is_local:
            info["stand_in"] = "pyiceberg SqlCatalog (local)"
        print(json.dumps(info, indent=2))
        return 0
    if args.lake_command == "init":
        # Creates namespace peoplelake and table raw_events with the canonical schema if absent (idempotent);
        # in production this is setup step 5 against Basin Catalog.
        from .lake.catalog import ensure_table
        from .lake.committer import landing_cursor

        table = ensure_table(lake_catalog(settings))
        print(
            json.dumps(
                {
                    "table": "peoplelake.raw_events",
                    "catalog": "local SqlCatalog (stand-in)" if settings.is_local else "Basin Catalog",
                    "current_snapshot": current_snapshot_id(table),
                    "landing_cursor": landing_cursor(table),
                }
            )
        )
        return 0
    table = open_lake(settings)
    if args.lake_command == "commit":
        from .lake.committer import DirectoryLandingSource, commit_pending

        if not settings.is_local:
            print(
                "lake commit reads roll files from a local directory and writes only the local table", file=sys.stderr
            )
            return 2
        _, report = commit_pending(
            DirectoryLandingSource(Path(args.dir)), table, prefix=args.prefix, recommit=args.recommit
        )
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


def _cmd_runner(args: argparse.Namespace) -> int:
    import logging

    from .runner.main import build_runner, install_sigterm_handler

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    install_sigterm_handler()
    runner = build_runner(args.target, args.worker_url)
    if args.runner_command == "poll":
        while True:  # the process restarts its loop after MAX_JOBS_PER_PROCESS jobs (in-process dbt memory)
            runner.poll(interval=args.interval)
            if args.once:
                return 0
            os.execv(sys.executable, [sys.executable, "-m", "peoplelake.cli", *sys.argv[1:]])
    processed = runner.poll(until_idle=args.until_idle, interval=2.0)
    print(json.dumps({"processed": processed, "outcomes": runner.counts}))
    return 0


def _cmd_stack(args: argparse.Namespace) -> int:
    from .stack import PORTS, LocalStack, StackError, ports_busy, stop_recorded, ticker, wait_ports_free

    if args.stack_command == "ticker":
        ticker(args.worker_url, args.interval)
        return 0
    if args.stack_command == "down":
        stop_recorded()
        busy = wait_ports_free(PORTS)
        print(json.dumps({"ports_busy": busy}))
        return 1 if busy else 0
    if args.stack_command == "status":
        print(json.dumps({"ports_busy": ports_busy()}))
        return 0
    stack = LocalStack(mode=args.mode, profile=args.profile)
    if args.reset:
        stack.reset_state()
    try:
        stack.up()
    except StackError as exc:
        print(f"stack up: {exc}", file=sys.stderr)
        stack.down()
        return 1
    # Leave the processes running; `peoplelake stack down` stops them.
    stack._cleanup_registered = False
    import atexit

    atexit.unregister(stack.down)
    print(json.dumps({"worker_url": "http://127.0.0.1:8791", "processes": [p.name for p in stack.processes]}))
    return 0


def _cmd_clean_clone(args: argparse.Namespace) -> int:
    from .devtools.clean_clone import clean_clone_check

    return clean_clone_check()


def _cmd_eval_scenarios(args: argparse.Namespace) -> int:
    import logging
    from datetime import UTC, datetime

    from .devtools.reference import reference_digests
    from .evals.scenarios import EvalError, results_name, run_scenario, scenarios_report, write_report
    from .paths import data_dir, repo_root
    from .sim.plan import SCENARIOS

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    chunks = args.chunks or (20 if args.profile == "full" else 10)
    wanted = [s.strip() for s in args.scenarios.split(",")] if args.scenarios else list(SCENARIOS)
    workdir = data_dir() / "eval" / f"scenarios-{args.profile}"
    if args.reference:
        reference = json.loads(Path(args.reference).read_text())["digests"]
    else:
        reference = reference_digests(args.profile, workdir / "reference")["digests"]
    results = []
    for scenario in wanted:
        print(f"scenario {scenario}: running", flush=True)
        try:
            result = run_scenario(scenario, args.profile, chunks, reference, workdir=workdir, target=args.target)
        except EvalError as exc:
            print(f"scenario {scenario}: {exc}", file=sys.stderr)
            return 2
        print(f"scenario {scenario}: passed={result['passed']} in {result['duration_s']} s", flush=True)
        results.append(result)
    command = "peoplelake eval scenarios " + " ".join(sys.argv[3:])
    report = scenarios_report(results, profile=args.profile, reference=reference, command=command.strip())
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    out = (
        Path(args.out)
        if args.out
        else repo_root() / "evals" / "results" / results_name(args.profile, report["engine"], date, wanted)
    )
    write_report(report, out)
    print(json.dumps({"passed": report["passed"], "out": str(out)}))
    return 0 if report["passed"] else 1


def _cmd_eval_freshness(args: argparse.Namespace) -> int:
    import logging
    from datetime import UTC, datetime

    from .evals.freshness import run_freshness, write
    from .evals.scenarios import EvalError
    from .paths import data_dir, repo_root

    if args.target == "prod":
        from .evals.freshness import prod_freshness, write
        from .sim.deliver import latest_delivery_id, load_delivery

        delivery_id = args.from_delivery or latest_delivery_id("prod")
        if not delivery_id:
            print("eval freshness --target prod needs --from-delivery (the prod:e2e delivery id)", file=sys.stderr)
            return 2
        report = prod_freshness(load_delivery(delivery_id))
        date = datetime.now(UTC).strftime("%Y-%m-%d")
        out = Path(args.out) if args.out else repo_root() / "evals" / "results" / f"freshness-prod-full-{date}.json"
        write(report, out, "peoplelake eval freshness " + " ".join(sys.argv[3:]))
        print(json.dumps({"p95_s": report["overall"]["p95_s"], "out": str(out)}))
        return 0
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    unit = args.duration[-1]
    minutes = float(args.duration[:-1]) * (60 if unit == "h" else 1) if unit in "mh" else float(args.duration)
    rate = None if args.rate == "auto" else float(args.rate)
    try:
        report = run_freshness(
            args.profile, minutes, workdir=data_dir() / "eval", rate=rate, tick_seconds=args.tick_seconds
        )
    except EvalError as exc:
        print(f"eval freshness: {exc}", file=sys.stderr)
        return 1
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    out = (
        Path(args.out)
        if args.out
        else repo_root() / "evals" / "results" / f"freshness-local-{args.profile}-{date}.json"
    )
    write(report, out, "peoplelake eval freshness " + " ".join(sys.argv[3:]))
    print(json.dumps({"p95_s": report["overall"]["p95_s"], "events": report["overall"]["events"], "out": str(out)}))
    return 0


def _cmd_eval_oracle(args: argparse.Namespace) -> int:
    """SPEC 16.3: the metrics mart against the oracle seed, on a warehouse file (open it only after `stack down`)."""
    from .evals.scenarios import oracle_mismatches

    path = _duckdb_path(args.duckdb)
    mismatched = oracle_mismatches(path, args.profile)
    print(json.dumps({"duckdb": str(path), "profile": args.profile, "oracle_rows_mismatched": mismatched}))
    return 0 if mismatched == 0 else 1


def _cmd_eval_parity(args: argparse.Namespace) -> int:
    """SPEC 16.3: incremental build on an empty warehouse equals a --full-refresh build (digests of 10 models)."""
    from .devtools.reference import ReferenceError_, reference_digests
    from .paths import data_dir

    workdir = Path(args.workdir) if args.workdir else data_dir() / "parity" / args.profile
    try:
        result = reference_digests(args.profile, workdir)
    except ReferenceError_ as exc:
        print(json.dumps({"profile": args.profile, "incremental_equals_full_refresh": False, "error": str(exc)}))
        return 1
    print(
        json.dumps({"profile": args.profile, "incremental_equals_full_refresh": True, "models": len(result["digests"])})
    )
    return 0


def _cmd_eval_ask(args: argparse.Namespace) -> int:
    from datetime import UTC, datetime

    from .evals.ask import AskEvalError, load_questions, report, run_local, run_prod, write
    from .paths import repo_root

    questions = load_questions(Path(args.questions) if args.questions else None)
    if args.limit:
        questions = questions[: args.limit]
    try:
        if args.provider == "workers-ai":
            outcome = run_prod(questions)
        else:
            outcome = run_local(args.provider, questions, gguf=Path(args.gguf) if args.gguf else None)
    except AskEvalError as exc:
        print(f"eval ask: {exc}", file=sys.stderr)
        return 1
    rep = report(args.provider, outcome, ("peoplelake eval ask " + " ".join(sys.argv[3:])).strip())
    date = datetime.now(UTC).strftime("%Y-%m-%d")
    out = Path(args.out) if args.out else repo_root() / "evals" / "results" / f"ask-{args.provider}-{date}.json"
    write(rep, out)
    s = rep["summary"]
    print(
        json.dumps(
            {"exact_match": f"{s['exact_match']}/{s['questions']}", "fields": s["field_accuracy"], "out": str(out)}
        )
    )
    return 0


def _cmd_prod(args: argparse.Namespace) -> int:
    from .paths import repo_root

    prod_dir = repo_root() / ".prod"
    if args.prod_command == "bootstrap-gcp":
        from .prod.bootstrap_gcp import main as bootstrap

        return bootstrap(plan=args.plan, prod_dir=prod_dir)
    if args.prod_command == "doctor-gcp":
        from .prod.doctor_gcp import doctor

        checks = doctor(prod_dir)
        for c in checks:
            print(c.line())
        return 0 if all(c.status in ("PASS", "WARN") for c in checks) else 1
    from .prod.bootstrap_gcp import GcpConfig

    config = GcpConfig.load(prod_dir)
    if args.prod_command == "e2e":
        from .prod.e2e import e2e

        unit = args.duration[-1]
        minutes = float(args.duration[:-1]) * (60 if unit == "h" else 1) if unit in "mh" else float(args.duration)
        print(json.dumps(e2e(minutes, tick_seconds=args.tick_seconds), indent=2))
        return 0
    if args.prod_command == "deploy-runner":
        from .prod.bootstrap_gcp import Bootstrap, Gcloud, git_head, real_clients

        boot = Bootstrap(
            config,
            Gcloud(plan=False, project=config.project),
            real_clients(config),
            prod_dir=prod_dir,
            git_sha=git_head(),
        )
        boot.taxonomy_and_policies()
        image = boot.artifact_registry_and_build()
        boot.run_job(image)
        print(json.dumps({"image": image}))
        return 0
    if args.prod_command == "verify":
        from .config import load_settings, open_lake
        from .evals.freshness import prod_operator
        from .prod.verify import landing_committed, verify

        landing = landing_committed(open_lake(load_settings("prod")), prod_operator().status().get("landed_through"))
        result = verify(config, Path(args.reference) if args.reference else None, landing=landing)
    elif args.prod_command == "demo-masking":
        from .prod.demo_masking import demo

        result = demo(config)
    elif args.prod_command == "drill-restore":
        from google.cloud import bigquery

        from .prod.drills import drill_restore

        expected = json.loads(Path(args.expected).read_text())["digests"]
        client = bigquery.Client(project=config.project, location=config.bq_location)
        result = drill_restore(client, config.project, int(args.as_of_ms), expected)
    else:
        from .prod.reset import reset

        result = reset(config, args.confirm or "")
    print(json.dumps(result, indent=2, default=str))
    return 0 if result.get("passed", True) else 1


def _cmd_sim_deliver(args: argparse.Namespace) -> int:
    import logging

    from .sim.deliver import deliver

    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.scenario != "baseline":
        print("sim deliver sends the baseline; scenarios run through `peoplelake eval scenarios`", file=sys.stderr)
        return 2
    unit = args.duration[-1]
    minutes = float(args.duration[:-1]) * (60 if unit == "h" else 1) if unit in "mh" else float(args.duration)
    record = deliver(
        target=args.target,
        profile=args.profile,
        mode=args.mode,
        duration_minutes=minutes,
        tick_seconds=args.tick_seconds,
    )
    print(json.dumps(record))
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
        (
            "init",
            "create namespace peoplelake and table raw_events if absent (local, or Basin Catalog with --target prod)",
        ),
        ("commit", "commit landing roll files from a local directory into the local table (offline tooling)"),
        ("scan", "read appended data between snapshots and print counts"),
        ("catalog-info", "print the catalog URI and warehouse"),
    ):
        lp = lake_sub.add_parser(name, help=help_text)
        lp.add_argument("--target", choices=["local", "prod"], default=None)
        if name == "commit":
            lp.add_argument("--dir", required=True, help="directory whose relative paths are the landing keys")
            lp.add_argument("--prefix", default="landing/raw_events/")
            lp.add_argument("--recommit", type=int, default=0)
        if name == "scan":
            lp.add_argument("--from-snapshot")
            lp.add_argument("--to-snapshot")
        lp.set_defaults(func=_cmd_lake)

    sim = sub.add_parser("sim", help="simulated sources")
    sim_sub = sim.add_subparsers(dest="sim_command", required=True)
    dl = sim_sub.add_parser("deliver", help="post a profile to the Worker as hris, ats and talent")
    dl.add_argument("--target", choices=["local", "prod"], default="local")
    dl.add_argument("--profile", choices=["small", "full"], default="small")
    dl.add_argument("--scenario", default="baseline")
    dl.add_argument("--mode", choices=["chunk", "live"], default="chunk")
    dl.add_argument("--duration", default="60m")
    dl.add_argument(
        "--tick-seconds",
        type=float,
        default=None,
        help="live mode: post every N seconds (default 10 in production, 1 locally)",
    )
    dl.set_defaults(func=_cmd_sim_deliver)

    runner = sub.add_parser("runner", help="claim and run warehouse jobs")
    runner_sub = runner.add_subparsers(dest="runner_command", required=True)
    poll = runner_sub.add_parser("poll", help="local loop against wrangler dev")
    poll.add_argument("--worker-url")
    poll.add_argument("--target", choices=["local", "prod-drill"], default="local")
    poll.add_argument("--interval", type=float, default=1.0)
    poll.add_argument("--once", action="store_true", help="exit after MAX_JOBS_PER_PROCESS jobs instead of restarting")
    poll.set_defaults(func=_cmd_runner)
    run = runner_sub.add_parser("run", help="process jobs until idle (the Cloud Run Job entry point)")
    run.add_argument("--worker-url")
    run.add_argument("--target", choices=["local", "prod", "prod-drill"], default="prod")
    run.add_argument("--until-idle", type=float, default=15.0)
    run.set_defaults(func=_cmd_runner)

    stack = sub.add_parser("stack", help="local stack: wrangler dev, runner and ticker")
    stack_sub = stack.add_subparsers(dest="stack_command", required=True)
    up = stack_sub.add_parser("up")
    up.add_argument("--mode", choices=["eval", "live"], default="live")
    up.add_argument("--profile", choices=["small", "full"], default="small")
    up.add_argument("--reset", action="store_true", help="empty Worker state, lake and warehouse first")
    up.set_defaults(func=_cmd_stack)
    for name in ("down", "status"):
        stack_sub.add_parser(name).set_defaults(func=_cmd_stack)
    tick = stack_sub.add_parser("ticker", help="call the local scheduled handler every interval (stand-in for cron)")
    tick.add_argument("--worker-url", default="http://127.0.0.1:8791")
    tick.add_argument("--interval", type=float, default=60.0)
    tick.set_defaults(func=_cmd_stack)

    ev = sub.add_parser("eval", help="evals whose numbers may appear in the README")
    ev_sub = ev.add_subparsers(dest="eval_command", required=True)
    sc = ev_sub.add_parser("scenarios", help="scenario equivalence: B, S1..S5 must equal the reference digests")
    sc.add_argument("--profile", choices=["small", "full"], default="small")
    sc.add_argument("--chunks", type=int)
    sc.add_argument("--scenarios", help="comma separated, for example B,S1 (default: all six)")
    sc.add_argument("--target", choices=["local", "prod-drill"], default="local")
    sc.add_argument("--reference", help="reference digests JSON (default: computed now)")
    sc.add_argument("--out")
    sc.set_defaults(func=_cmd_eval_scenarios)

    fr = ev_sub.add_parser("freshness", help="deliver at a constant rate in live mode and measure p50/p95 freshness")
    fr.add_argument("--target", choices=["local", "prod"], default="local")
    fr.add_argument("--profile", choices=["small", "full"], default="full")
    fr.add_argument("--duration", default="60m", help="for example 60m or 1h")
    fr.add_argument("--rate", default="auto", help="events per second, or auto = events / duration")
    fr.add_argument(
        "--tick-seconds", type=float, default=1.0, help="local live delivery: post every N seconds (default 1)"
    )
    fr.add_argument("--from-delivery", help="production: the prod:e2e delivery id (default: the latest)")
    fr.add_argument("--out")
    fr.set_defaults(func=_cmd_eval_freshness)

    orc = ev_sub.add_parser("oracle", help="metrics mart against the oracle seed (open the file only after stack down)")
    orc.add_argument("--profile", choices=["small", "full"], default="small")
    orc.add_argument("--duckdb", help="warehouse file (default: PL_DUCKDB_PATH or .data/warehouse/peoplelake.duckdb)")
    orc.set_defaults(func=_cmd_eval_oracle)
    par = ev_sub.add_parser("parity", help="incremental build on an empty warehouse equals a full refresh")
    par.add_argument("--profile", choices=["small", "full"], default="small")
    par.add_argument("--workdir")
    par.set_defaults(func=_cmd_eval_parity)

    ask = ev_sub.add_parser("ask", help="score each AiProvider on the 60 questions in evals/ask/questions.jsonl")
    ask.add_argument(
        "--provider",
        choices=["stub", "llama", "workers-ai"],
        required=True,
        help="stub and llama run on the local stack; workers-ai calls the production Worker",
    )
    ask.add_argument(
        "--gguf", help="llama only: the GGUF llama-server loads (default: PL_LLAMA_GGUF or the Qwen3-1.7B path)"
    )
    ask.add_argument("--questions", help="questions file (default: evals/ask/questions.jsonl)")
    ask.add_argument("--limit", type=int, help="only the first N questions (smoke runs; never for README numbers)")
    ask.add_argument("--out")
    ask.set_defaults(func=_cmd_eval_ask)

    prod = sub.add_parser("prod", help="production: Google Cloud bootstrap, doctor, verify, drills (needs credentials)")
    prod_sub = prod.add_subparsers(dest="prod_command", required=True)
    bs = prod_sub.add_parser("bootstrap-gcp", help="create every GCP resource, idempotent")
    bs.add_argument("--plan", action="store_true", help="print every mutation without making it")
    bs.set_defaults(func=_cmd_prod)
    prod_sub.add_parser("doctor-gcp", help="check every GCP prerequisite").set_defaults(func=_cmd_prod)
    prod_sub.add_parser(
        "deploy-runner", help="build the runner image with Cloud Build and update the job"
    ).set_defaults(func=_cmd_prod)
    ver = prod_sub.add_parser(
        "verify", help="100,000 unique events in BigQuery, R7 at error level, digests equal the reference"
    )
    ver.add_argument("--reference")
    ver.set_defaults(func=_cmd_prod)
    e2e_p = prod_sub.add_parser("e2e", help="one live delivery of the full profile, verify, production freshness")
    e2e_p.add_argument("--duration", default="60m")
    e2e_p.add_argument("--tick-seconds", type=float, default=10.0, help="sources post every N seconds (default 10)")
    e2e_p.set_defaults(func=_cmd_prod)
    prod_sub.add_parser("demo-masking", help="query restricted columns as pl-analyst").set_defaults(func=_cmd_prod)
    dr = prod_sub.add_parser("drill-restore", help="time-travel restore into _drill datasets and compare digests")
    dr.add_argument("--as-of-ms", required=True)
    dr.add_argument(
        "--expected", required=True, help="JSON with the digests the ledger recorded for the run committed then"
    )
    dr.set_defaults(func=_cmd_prod)
    rs = prod_sub.add_parser("reset", help="guarded full production reset")
    rs.add_argument("--confirm")
    rs.set_defaults(func=_cmd_prod)

    dev = sub.add_parser("dev", help="developer and CI tools")
    dev_sub = dev.add_subparsers(dest="dev_command", required=True)
    ref = dev_sub.add_parser(
        "reference-digests", help="straight load + incremental and full-refresh builds (SPEC 15.4)"
    )
    ref.add_argument("--profile", choices=["full", "small"], default="small")
    ref.add_argument("--workdir")
    ref.add_argument("--out")
    ref.set_defaults(func=_cmd_reference_digests)

    cc = dev_sub.add_parser(
        "clean-clone-check", help="clone HEAD to a temp dir: uv sync --locked, dbt parse, smoke tests"
    )
    cc.set_defaults(func=_cmd_clean_clone)
    mfp = dev_sub.add_parser(
        "metricflow-parity", help="MetricFlow answers for the five metrics must equal metrics_workforce_monthly"
    )
    mfp.add_argument("--profile", choices=["full", "small"], default="small")
    mfp.add_argument("--workdir")
    mfp.add_argument("--out")
    mfp.set_defaults(func=_cmd_metricflow_parity)
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
