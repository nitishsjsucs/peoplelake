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


def test_load_dbt_build_and_digest_in_one_process(tmp_path, monkeypatch, small):
    """The runner's sequence: load, in-process dbt build, digests, all in one process (ADR 0008)."""
    from dbt_helpers import make_env
    from peoplelake.warehouse.direct import part

    env = make_env(tmp_path, monkeypatch, small)
    env.load(part(env.items, 1, 3))
    assert env.dbt.build().success
    digests = env.wh.digests()
    assert len(digests) == 10
    proc = _open_in_other_process(env.wh.path)
    assert proc.returncode != 0  # in-process dbt keeps the file open for the life of the process
    env.load(part(env.items, 2, 3))
    assert env.dbt.build().success
    assert env.wh.digests() != digests
