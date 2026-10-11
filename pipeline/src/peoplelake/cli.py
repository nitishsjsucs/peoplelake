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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="peoplelake", description="PeopleLake pipelines")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="generate the synthetic dataset or rewrite the oracle seeds")
    gen.add_argument("--profile", choices=["full", "small"])
    gen.add_argument("--out", help="output directory for hris.jsonl, ats.jsonl, talent.jsonl, manifest.json")
    gen.add_argument("--check", action="store_true", help="fail unless the dataset sha256 equals the pin")
    gen.add_argument("--write-seeds", action="store_true", help="rewrite warehouse/seeds for both profiles")
    gen.set_defaults(func=_cmd_generate)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
