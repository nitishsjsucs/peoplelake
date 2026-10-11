"""Per-model bucket cursors (ADR 0004, SPEC 11.5) driven through dbt in process on the small profile."""

import pytest

from dbt_helpers import make_env
from peoplelake.prng import SplitMix64
from peoplelake.warehouse.direct import part

pytestmark = pytest.mark.dbt


def full_refresh_digests(env):
    outcome = env.dbt.build(full_refresh=True)
    assert outcome.success, outcome.failed_nodes
    return env.wh.digests()


def test_failed_model_catches_up_from_its_own_cursor(tmp_path, monkeypatch, small):
    env = make_env(tmp_path, monkeypatch, small)
    env.load(part(env.items, 1, 2))
    assert env.dbt.build().success

    env.load(part(env.items, 2, 2))
    failed = env.dbt.build(fail_model="fct_workforce_monthly")
    assert not failed.success
    assert any(n.endswith(".fct_workforce_monthly") for n in failed.failed_nodes)
    assert failed.models_ok > 0  # upstream models, dim_employee_history included, advanced their cursors

    recovered = env.dbt.build()
    assert recovered.success, recovered.failed_nodes
    incremental = env.wh.digests()
    assert incremental == full_refresh_digests(env)


def test_shuffled_delivery_incremental_equals_full_refresh(tmp_path, monkeypatch, small):
    """Corrections, rescinds and terminations often arrive before their targets or hires."""
    env = make_env(tmp_path, monkeypatch, small)
    items = list(env.items)
    SplitMix64(7).shuffle(items)
    for i in range(1, 7):
        env.load(part(items, i, 6))
        outcome = env.dbt.build()
        assert outcome.success, outcome.failed_nodes  # error-level checks hold while data is in flight
    assert outcome.tests_warn == 0, outcome.checks_warn  # warn-level checks are 0 at quiescence
    assert env.wh.digests() == full_refresh_digests(env)


def test_bucket_that_becomes_empty_is_cleared(tmp_path, monkeypatch, small):
    """An employee terminated before the first month end of the window has no snapshot rows at all."""
    env = make_env(tmp_path, monkeypatch, small)
    early = [
        i
        for i, (s, e) in enumerate(env.items)
        if s == "hris" and e["eventType"] == "worker.terminated" and e["effectiveDate"] < "2023-01-31"
    ]
    assert early, "the small profile has an early termination"
    target = env.items[early[0]]
    worker = target[1]["workerId"]
    env.load(env.items[: early[0]] + env.items[early[0] + 1 :])
    assert env.dbt.build().success
    rows = env.wh.query_arrow(f"SELECT count(*) AS n FROM pl_core.fct_workforce_monthly WHERE employee_id = '{worker}'")
    assert rows.column("n")[0].as_py() > 0

    env.load([target])
    assert env.dbt.build().success
    rows = env.wh.query_arrow(f"SELECT count(*) AS n FROM pl_core.fct_workforce_monthly WHERE employee_id = '{worker}'")
    assert rows.column("n")[0].as_py() == 0
