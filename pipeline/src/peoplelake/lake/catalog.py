"""Iceberg catalogs: a local SqlCatalog (stand-in) or Basin Catalog through Iceberg REST (production)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pyiceberg.catalog import Catalog
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.table import Table

from .schema import RAW_ARROW_SCHEMA

NAMESPACE = "peoplelake"
TABLE = "raw_events"
TABLE_ID = f"{NAMESPACE}.{TABLE}"
NO_LIBRARY_RETRIES = "commit.retry.num-retries"
TABLE_PROPERTIES = {NO_LIBRARY_RETRIES: "0"}


def local_catalog(root: Path) -> Catalog:
    """Stand-in for Basin Catalog: pyiceberg SqlCatalog (SQLite) with a file warehouse."""
    from pyiceberg.catalog.sql import SqlCatalog

    root.mkdir(parents=True, exist_ok=True)
    (root / "warehouse").mkdir(exist_ok=True)
    return SqlCatalog("local", uri=f"sqlite:///{root}/catalog.db", warehouse=f"file://{root}/warehouse")


def basin_catalog(uri: str, warehouse: str, token: str) -> Catalog:
    """Basin Catalog (formerly R2 Data Catalog) over Iceberg REST; it vends storage credentials."""
    from pyiceberg.catalog.rest import RestCatalog

    return RestCatalog(name="basin", uri=uri, warehouse=warehouse, token=token)


def ensure_table(catalog: Catalog) -> Table:
    """Create namespace `peoplelake` and table `raw_events` with the canonical schema if absent. Locally on
    the SqlCatalog stand-in; in production `peoplelake lake init --target prod` (setup step 5) runs this
    against Basin Catalog, so the physical types are this repo's (SPEC 29.4.1)."""
    catalog.create_namespace_if_not_exists(NAMESPACE)
    table = catalog.create_table_if_not_exists(TABLE_ID, schema=RAW_ARROW_SCHEMA, properties=TABLE_PROPERTIES)
    return disable_library_commit_retries(table)


def disable_library_commit_retries(table: Table) -> Table:
    """pyiceberg retries a conflicting append by itself (4 times by default) on top of the new metadata,
    which would append a roll again and move the landing cursor backwards. With `commit.retry.num-retries`
    0 a conflict surfaces as CommitFailedException and the committer re-reads its cursor instead."""
    if table.properties.get(NO_LIBRARY_RETRIES) != "0":
        with table.transaction() as tx:
            tx.set_properties({NO_LIBRARY_RETRIES: "0"})
    return table


def ensure_local_table(catalog: Catalog) -> Table:
    return ensure_table(catalog)


def load_table(catalog: Catalog) -> Table | None:
    try:
        return catalog.load_table(TABLE_ID)
    except NoSuchTableError:
        return None


def catalog_info(catalog: Catalog) -> dict[str, Any]:
    """Catalog URI and warehouse (the runner job's PL_R2_CATALOG_URI and PL_R2_WAREHOUSE)."""
    props = dict(catalog.properties)
    return {"uri": props.get("uri"), "warehouse": props.get("warehouse"), "table": TABLE_ID}
