from __future__ import annotations

import os

import pytest

os.environ.setdefault("TZ", "UTC")

from peoplelake.generator import Dataset, generate, get_profile  # noqa: E402

_CACHE: dict[str, Dataset] = {}


def dataset(profile: str) -> Dataset:
    if profile not in _CACHE:
        _CACHE[profile] = generate(get_profile(profile))
    return _CACHE[profile]


@pytest.fixture(scope="session", params=["small", "full"])
def ds(request: pytest.FixtureRequest) -> Dataset:
    return dataset(request.param)


@pytest.fixture(scope="session")
def small() -> Dataset:
    return dataset("small")


@pytest.fixture(scope="session")
def full() -> Dataset:
    return dataset("full")
