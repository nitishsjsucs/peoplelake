"""Reference data shared by the generator and the warehouse seeds (warehouse/seeds/reference)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Department:
    department_id: str
    department_name: str


@dataclass(frozen=True)
class Job:
    job_code: str
    job_title: str
    job_family: str
    job_level: int


@dataclass(frozen=True)
class Location:
    location_id: str
    location_name: str
    country_code: str


DEPARTMENTS: tuple[Department, ...] = tuple(
    Department(f"D{i:02d}", name)
    for i, name in enumerate(
        [
            "Engineering",
            "Product",
            "Design",
            "Sales",
            "Marketing",
            "Customer Success",
            "Finance",
            "People",
            "Legal",
            "Operations",
            "Data",
            "Security",
        ],
        start=1,
    )
)

_FAMILIES = ("Engineer", "Analyst", "Specialist", "Manager", "Consultant")
_LEVEL_TITLES = ("Associate", "", "Senior", "Staff", "Principal", "Distinguished")

# 30 jobs: levels 1..6, five families per level. J01..J05 are level 1, J26..J30 level 6.
JOBS: tuple[Job, ...] = tuple(
    Job(
        job_code=f"J{(level - 1) * 5 + f + 1:02d}",
        job_title=(f"{_LEVEL_TITLES[level - 1]} {family}").strip(),
        job_family=family,
        job_level=level,
    )
    for level in range(1, 7)
    for f, family in enumerate(_FAMILIES)
)

LOCATIONS: tuple[Location, ...] = (
    Location("L1", "San Jose", "US"),
    Location("L2", "New York", "US"),
    Location("L3", "Austin", "US"),
    Location("L4", "Toronto", "CA"),
    Location("L5", "London", "GB"),
    Location("L6", "Remote", "US"),
)

DEPARTMENT_IDS: tuple[str, ...] = tuple(d.department_id for d in DEPARTMENTS)
JOB_BY_CODE: dict[str, Job] = {j.job_code: j for j in JOBS}
JOBS_BY_LEVEL: dict[int, tuple[str, ...]] = {
    level: tuple(j.job_code for j in JOBS if j.job_level == level) for level in range(1, 7)
}
LOCATION_IDS: tuple[str, ...] = tuple(loc.location_id for loc in LOCATIONS)
FTE_VALUES_BP: tuple[int, ...] = (10000, 8000, 6000, 5000)

# Base salary band (USD, whole hundreds) per job level.
SALARY_BANDS: dict[int, tuple[int, int]] = {
    1: (52000, 70000),
    2: (68000, 95000),
    3: (92000, 130000),
    4: (125000, 170000),
    5: (160000, 215000),
    6: (205000, 280000),
}
BONUS_TARGET_BP_BY_LEVEL: dict[int, int] = {1: 0, 2: 500, 3: 1000, 4: 1500, 5: 2000, 6: 2500}


def reference_csvs() -> dict[str, str]:
    """CSV text for the three committed reference seeds."""
    deps = "department_id,department_name\n" + "".join(f"{d.department_id},{d.department_name}\n" for d in DEPARTMENTS)
    jobs = "job_code,job_title,job_family,job_level\n" + "".join(
        f"{j.job_code},{j.job_title},{j.job_family},{j.job_level}\n" for j in JOBS
    )
    locs = "location_id,location_name,country_code\n" + "".join(
        f"{loc.location_id},{loc.location_name},{loc.country_code}\n" for loc in LOCATIONS
    )
    return {"ref_departments.csv": deps, "ref_jobs.csv": jobs, "ref_locations.csv": locs}
