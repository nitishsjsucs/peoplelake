"""The runner asks the Worker before its idle exit and keeps polling when a job was queued meanwhile."""

from types import SimpleNamespace

import pytest

from peoplelake.runner.main import Runner


class FakeClient:
    def __init__(self, claims, idle_answers):
        self.claims = list(claims)
        self.idle_answers = list(idle_answers)
        self.idle_calls = 0

    def claim(self, worker_id):
        return self.claims.pop(0) if self.claims else None

    def idle(self, worker_id):
        self.idle_calls += 1
        answer = self.idle_answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.setattr("peoplelake.runner.main.time.sleep", lambda s: None)
    r = Runner(SimpleNamespace(target="local"), FakeClient([], [True]), worker_id="w")
    r.process = lambda job: "succeeded"
    return r


def test_exits_when_the_worker_says_nothing_is_queued(runner):
    assert runner.poll(until_idle=0) == 0
    assert runner.client.idle_calls == 1


def test_stays_for_a_job_enqueued_after_the_last_poll(runner):
    # First idle check: a job was queued after the last empty poll (the Coordinator did not dispatch,
    # because this runner was seen); the runner keeps polling, claims it, and asks again before exiting.
    runner.client = FakeClient([None, {"job_id": "j1"}], [False, True])
    assert runner.poll(until_idle=0) == 1
    assert runner.client.idle_calls == 2


def test_exits_when_the_worker_cannot_be_asked(runner):
    runner.client = FakeClient([], [RuntimeError("unreachable")])
    assert runner.poll(until_idle=0) == 0
