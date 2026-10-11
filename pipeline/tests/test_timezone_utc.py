import os
import subprocess
import sys

from peoplelake.warehouse.duckdb_wh import open_duckdb


def test_open_duckdb_session_is_utc(tmp_path):
    con = open_duckdb(tmp_path / "tz.duckdb")
    try:
        assert con.execute("SELECT current_setting('TimeZone')").fetchone()[0] == "UTC"
        day = con.execute("SELECT CAST(TIMESTAMPTZ '2026-01-01 03:00:00+00' AS DATE)").fetchone()[0]
        assert day.isoformat() == "2026-01-01"
    finally:
        con.close()


def test_utc_even_when_the_process_zone_is_not(tmp_path):
    code = (
        "from peoplelake.warehouse.duckdb_wh import open_duckdb;"
        f"c=open_duckdb({str(tmp_path / 'tz2.duckdb')!r});"
        "print(c.execute(\"SELECT current_setting('TimeZone'), "
        "CAST(TIMESTAMPTZ '2026-01-01 03:00:00+00' AS DATE)\").fetchone())"
    )
    env = dict(os.environ, TZ="America/Los_Angeles")
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True).stdout
    assert "'UTC'" in out and "datetime.date(2026, 1, 1)" in out


def test_dbt_profile_session_is_utc(tmp_path, monkeypatch):
    from dbt.cli.main import dbtRunner

    from peoplelake.paths import warehouse_dir

    monkeypatch.setenv("PL_DUCKDB_PATH", str(tmp_path / "dbt-tz.duckdb"))
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    project = warehouse_dir()
    result = dbtRunner().invoke(
        [
            "show",
            "--inline",
            "select current_setting('TimeZone') as tz, cast(timestamptz '2026-01-01 03:00:00+00' as date) as d",
            "--project-dir",
            str(project),
            "--profiles-dir",
            str(project),
            "--target-path",
            str(tmp_path / "target"),
            "--quiet",
        ]
    )
    assert result.success
    row = result.result.results[0].agate_table.rows[0]
    assert row[0] == "UTC"
    assert str(row[1]) == "2026-01-01"
