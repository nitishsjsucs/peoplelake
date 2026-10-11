"""ADR 0008: one process owns the local warehouse file while the stack is up."""

import subprocess
import sys

from peoplelake.warehouse.duckdb_wh import open_duckdb


def _open_in_other_process(path) -> subprocess.CompletedProcess:
    code = f"import duckdb; duckdb.connect({str(path)!r}, read_only=True).execute('SELECT 1')"
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)


def test_second_process_cannot_open_while_owner_holds_it(tmp_path):
    path = tmp_path / "owned.duckdb"
    owner = open_duckdb(path)
    try:
        owner.execute("CREATE TABLE t AS SELECT 1 AS x")
        proc = _open_in_other_process(path)
        assert proc.returncode != 0
        assert "lock" in proc.stderr.lower()
    finally:
        owner.close()
    assert _open_in_other_process(path).returncode == 0


def test_two_default_connections_in_one_process_coexist(tmp_path):
    path = tmp_path / "shared.duckdb"
    a = open_duckdb(path)
    b = open_duckdb(path)
    try:
        a.execute("CREATE TABLE t AS SELECT 42 AS x")
        assert b.execute("SELECT x FROM t").fetchone()[0] == 42
    finally:
        a.close()
        b.close()
