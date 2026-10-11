"""Application default credentials, seen the way every Google client in this repo sees them.

`google.auth.default()` locates and parses the credentials (honouring `GOOGLE_APPLICATION_CREDENTIALS` and
`CLOUDSDK_CONFIG`); this repo's code never opens the credential file itself and requests no token here.
The doctor and bootstrap only need to know whether ADC loads and which quota project it carries: ADC calls
to Data Catalog and the BigQuery Data Policy API fail without one (SPEC 20.2 step 12)."""

from __future__ import annotations


def adc_quota_project() -> tuple[bool, str | None]:
    """(credentials load, their quota project or None)."""
    import google.auth
    from google.auth.exceptions import DefaultCredentialsError

    try:
        credentials, _ = google.auth.default()
    except DefaultCredentialsError:
        return False, None
    return True, getattr(credentials, "quota_project_id", None) or None
