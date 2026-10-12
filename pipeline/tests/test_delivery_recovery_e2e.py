"""SPEC 29.4.1 item 11 end to end: the small profile's baseline delivery through the fault proxy and the
local stack (wrangler dev, runner, DuckDB) recovers from every kind of injected failure, with every event
in the warehouse exactly once and the published digests equal to the reference."""

import pytest

pytestmark = pytest.mark.e2e


def test_the_baseline_delivery_recovers_from_every_kind_of_injected_failure(tmp_path):
    from peoplelake.devtools.reference import reference_digests
    from peoplelake.evals.delivery_recovery import DEFAULT_FAULTS, run_delivery_recovery
    from peoplelake.stack import ports_busy

    if ports_busy():
        pytest.skip("ports 8791, 9241 or 8150 are in use")
    reference = reference_digests("small", tmp_path / "reference")["digests"]
    report = run_delivery_recovery("small", 3, reference, workdir=tmp_path / "eval")
    assert report["checks"] == dict.fromkeys(report["checks"], True)
    assert sum(report["faults_by_kind"].values()) == sum(len(burst) for _, burst in DEFAULT_FAULTS)
    assert report["warehouse"]["duplicate_deliveries_in_raw"] == report["landed_then_failed_records"] > 0
    assert report["delivery"]["deliveries_sent"] == report["warehouse"]["stg_events_rows"] == 10_000
    assert ports_busy() == []
