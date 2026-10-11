"""Deterministic synthetic workforce data: three sources, exact counts, oracle (SPEC section 5)."""

from .dataset import SOURCES, Dataset, generate
from .profiles import FULL, PROFILES, SMALL, Profile, get_profile

__all__ = ["FULL", "PROFILES", "SMALL", "SOURCES", "Dataset", "Profile", "generate", "get_profile"]
