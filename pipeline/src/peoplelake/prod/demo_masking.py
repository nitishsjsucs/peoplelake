"""`peoplelake prod demo-masking`: query restricted columns as peoplelake-analyst (impersonated) and show that
compensation is masked to the default value and performance ratings are null, while peoplelake-runner reads them."""

from __future__ import annotations

from .bootstrap_gcp import GcpConfig


def demo(config: GcpConfig) -> dict:
    from ..warehouse.bigquery_wh import bigquery_client

    client = bigquery_client(config.project, config.bq_location, impersonate=config.analyst_sa)
    comp = [
        dict(r)
        for r in client.query(
            f"SELECT employee_id, base_salary, bonus_target_pct FROM `{config.project}.peoplelake_restricted.fct_compensation_history` "
            "ORDER BY employee_id ASC NULLS LAST, valid_from ASC NULLS LAST LIMIT 5"
        ).result()
    ]
    reviews = [
        dict(r)
        for r in client.query(
            f"SELECT review_id, rating FROM `{config.project}.peoplelake_restricted.fct_performance_reviews` ORDER BY review_id ASC NULLS LAST LIMIT 5"
        ).result()
    ]
    return {
        "as": config.analyst_sa,
        "compensation_rows": comp,
        "review_rows": reviews,
        "compensation_masked": all(r["base_salary"] in (0, None) for r in comp),
        "ratings_null": all(r["rating"] is None for r in reviews),
    }
