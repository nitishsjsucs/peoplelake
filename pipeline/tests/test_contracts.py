import json

import pytest
from pydantic import TypeAdapter, ValidationError

from peoplelake import contracts as c
from peoplelake.paths import repo_root

CONTRACTS = repo_root() / "contracts"
MODELS = {
    "raw-record": c.RawRecord,
    "source-hris": c.HrisBatch,
    "source-ats": c.AtsBatch,
    "source-talent": c.TalentBatch,
    "job": c.JobSpec,
    "load-result": TypeAdapter(c.LoadResult | c.FailedResult),
    "transform-result": TypeAdapter(c.TransformResult | c.FailedResult),
}


def _validate(model, text: str):
    if isinstance(model, TypeAdapter):
        return model.validate_json(text)
    return model.model_validate_json(text)


@pytest.mark.parametrize("name", sorted(MODELS))
@pytest.mark.smoke
def test_valid_fixture(name):
    _validate(MODELS[name], (CONTRACTS / "fixtures" / f"{name}.valid.json").read_text())


@pytest.mark.parametrize("name", sorted(MODELS))
def test_invalid_fixture(name):
    with pytest.raises(ValidationError):
        _validate(MODELS[name], (CONTRACTS / "fixtures" / f"{name}.invalid.json").read_text())


def test_integers_stay_integers():
    raw = json.loads((CONTRACTS / "fixtures" / "source-hris.valid.json").read_text())
    raw["events"][0]["data"]["fte_bp"] = 1.0
    with pytest.raises(ValidationError):
        c.HrisBatch.model_validate_json(json.dumps(raw))


def test_optional_fields_reject_explicit_null():
    job = json.loads((CONTRACTS / "fixtures" / "job.valid.json").read_text())
    job["input"]["to_snapshot"] = None  # nullable and optional in zod
    c.JobSpec.model_validate_json(json.dumps(job))
    job["faults"] = None  # optional only
    with pytest.raises(ValidationError):
        c.JobSpec.model_validate_json(json.dumps(job))


@pytest.mark.parametrize("profile", ["small", "full"])
def test_every_generated_envelope_validates(profile):
    from conftest import dataset

    ds = dataset(profile)
    batches = {"hris": (c.HrisBatch, "events"), "ats": (c.AtsBatch, "records"), "talent": (c.TalentBatch, "items")}
    for source, (model, key) in batches.items():
        lines = ds.lines[source]
        for i in range(0, len(lines), 500):
            model.model_validate_json(f'{{"{key}":[{",".join(lines[i : i + 500])}]}}')


def _schema(name: str) -> dict:
    return json.loads((CONTRACTS / f"{name}.schema.json").read_text())


def _fields(model) -> tuple[set[str], set[str]]:
    return set(model.model_fields), {k for k, f in model.model_fields.items() if f.is_required()}


@pytest.mark.parametrize(
    ("name", "model", "pick"),
    [
        ("raw-record", c.RawRecord, lambda s: s),
        ("job", c.JobSpec, lambda s: s),
        ("job", c.JobInput, lambda s: s["properties"]["input"]),
        ("job", c.FaultSpec, lambda s: s["properties"]["faults"]["items"]),
        ("load-result", c.LoadResult, lambda s: s["anyOf"][0]),
        ("load-result", c.FailedResult, lambda s: s["anyOf"][1]),
        ("transform-result", c.TransformResult, lambda s: s["anyOf"][0]),
        ("transform-result", c.DbtStats, lambda s: s["anyOf"][0]["properties"]["dbt"]),
    ],
)
def test_pydantic_fields_match_json_schema(name, model, pick):
    schema = pick(_schema(name))
    props, required = _fields(model)
    assert props == set(schema["properties"])
    assert required == set(schema.get("required", []))
    assert tuple(_schema("raw-record")["properties"]) == c.RAW_RECORD_COLUMNS


@pytest.mark.smoke
def test_stream_schema_matches_lake_schema_field_by_field():
    import pyarrow as pa

    from peoplelake.lake.schema import RAW_FIELDS

    stream = json.loads((repo_root() / "infra" / "cloudflare" / "stream-schema.json").read_text())
    types = {"string": pa.string(), "int64": pa.int64(), "int32": pa.int32()}
    assert [f["name"] for f in stream["fields"]] == [name for name, _ in RAW_FIELDS] == list(c.RAW_RECORD_COLUMNS)
    for field, (name, arrow_type) in zip(stream["fields"], RAW_FIELDS, strict=True):
        assert field["required"] is True
        if field["type"] == "timestamp":
            assert pa.types.is_timestamp(arrow_type), name
        else:
            assert types[field["type"]] == arrow_type, name


def test_pipeline_sql_lists_every_column_explicitly():
    sql = (repo_root() / "infra" / "cloudflare" / "pipeline.sql").read_text()
    assert "SELECT *" not in sql.upper()
    for col in c.RAW_RECORD_COLUMNS:
        assert col in sql


def test_raw_records_golden_is_current():
    from peoplelake.devtools.goldens import render_raw_records_golden

    path = CONTRACTS / "golden" / "raw-records.json"
    assert path.read_text() == render_raw_records_golden()
    for case in json.loads(path.read_text())["cases"]:
        c.RawRecord.model_validate_json(json.dumps(case["raw_record"]))
