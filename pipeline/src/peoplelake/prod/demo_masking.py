"""`peoplelake prod demo-masking`: as peoplelake-analyst (impersonated), read the restricted columns through
the analyst views in `peoplelake_restricted_access` and show that compensation (base salary and bonus
target) is masked to the default value and performance ratings are null, and that the dataset dbt builds
in, `peoplelake_restricted`, refuses the analyst outright."""

from __future__ import annotations

from .bootstrap_gcp import GcpConfig


def demo(config: GcpConfig) -> dict:
    from google.api_core.exceptions import Forbidden, NotFound

    from ..warehouse.bigquery_wh import bigquery_client

    client = bigquery_client(config.project, config.bq_location, impersonate=config.analyst_sa)
    views = f"{config.project}.peoplelake_restricted_access"
    comp = [
        dict(r)
        for r in client.query(
            f"SELECT employee_id, base_salary, bonus_target_pct FROM `{views}.compensation_history` "
            "ORDER BY employee_id ASC NULLS LAST, valid_from ASC NULLS LAST LIMIT 5"
        ).result()
    ]
    reviews = [
        dict(r)
        for r in client.query(
            f"SELECT review_id, rating FROM `{views}.performance_reviews` ORDER BY review_id ASC NULLS LAST LIMIT 5"
        ).result()
    ]
    try:
        list(
            client.query(
                f"SELECT base_salary FROM `{config.project}.peoplelake_restricted.fct_compensation_history` LIMIT 1"
            ).result()
        )
        direct_refused = False
    except (Forbidden, NotFound):
        direct_refused = True
    return {
        "as": config.analyst_sa,
        "compensation_rows": comp,
        "review_rows": reviews,
        "compensation_masked": bool(comp)
        and all(r["base_salary"] in (0, None) and r["bonus_target_pct"] in (0, None) for r in comp),
        "ratings_null": bool(reviews) and all(r["rating"] is None for r in reviews),
        "restricted_dataset_refused": direct_refused,
    }
