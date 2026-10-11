"""SPEC 15.6, "five workforce metrics": the catalog has exactly five members everywhere it is named (the
Worker's METRIC_IDS, the metrics mart's documented metric columns, the oracle seed and the semantic layer),
so a sixth metric or a dropped one fails CI."""

import re

import yaml

from peoplelake.generator.oracle import ORACLE_COLUMNS
from peoplelake.paths import repo_root

FIVE = ["headcount", "fte", "hires", "departures", "offer_acceptance_rate"]
COMPONENTS = ["rehires", "transfers_in", "transfers_out", "offers_extended", "offers_accepted", "offers_declined"]


def test_metric_catalog_has_exactly_five():
    ts = (repo_root() / "src" / "shared" / "metrics.ts").read_text()
    ids = re.search(r"export const METRIC_IDS = \[([^\]]*)\]", ts)
    assert ids is not None
    assert re.findall(r'"([a-z_]+)"', ids.group(1)) == FIVE

    core = yaml.safe_load((repo_root() / "warehouse" / "models" / "core" / "_core.yml").read_text())
    mart = next(m for m in core["models"] if m["name"] == "metrics_workforce_monthly")
    assert [c["name"] for c in mart["columns"]] == FIVE

    assert list(ORACLE_COLUMNS) == ["profile", "month", "department_id", *FIVE[:3], "rehires", "departures"] + [
        "transfers_in",
        "transfers_out",
        "offers_extended",
        "offers_accepted",
        "offers_declined",
        "offer_acceptance_rate",
    ]
    assert set(ORACLE_COLUMNS) - {"profile", "month", "department_id"} == set(FIVE) | set(COMPONENTS)

    semantic = yaml.safe_load((repo_root() / "warehouse" / "models" / "semantic" / "_semantic.yml").read_text())
    # The five plus the two components the acceptance-rate ratio is built from.
    assert {m["name"] for m in semantic["metrics"]} == set(FIVE) | {"offers_accepted", "offers_decided"}
