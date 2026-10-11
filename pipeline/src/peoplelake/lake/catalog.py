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


def ensure_local_table(catalog: Catalog) -> Table:
    """Create the raw table locally. In production the Basin sink creates it; setup never pre-creates it."""
    catalog.create_namespace_if_not_exists(NAMESPACE)
    return catalog.create_table_if_not_exists(TABLE_ID, schema=RAW_ARROW_SCHEMA)


def load_table(catalog: Catalog) -> Table | None:
    try:
        return catalog.load_table(TABLE_ID)
    except NoSuchTableError:
        return None


def catalog_info(catalog: Catalog) -> dict[str, Any]:
    """URI, warehouse and the REST prefix the Worker's catalog poll needs (from GET /v1/config)."""
    props = dict(catalog.properties)
    return {
        "uri": props.get("uri"),
        "warehouse": props.get("warehouse"),
        "prefix": props.get("prefix"),
        "table": TABLE_ID,
    }
