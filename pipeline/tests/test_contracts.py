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
def test_raw_record_schema_matches_the_iceberg_schema_field_by_field():
    """contracts/raw-record.schema.json is the schema of record; lake/schema.py creates the Iceberg table
    (`peoplelake lake init`) and must agree on every column, its order, requiredness and type."""
    import pyarrow as pa

    from peoplelake.lake.schema import RAW_ARROW_SCHEMA, RAW_FIELDS

    schema = _schema("raw-record")
    props = schema["properties"]
    assert list(props) == [name for name, _ in RAW_FIELDS] == list(c.RAW_RECORD_COLUMNS)
    assert set(schema["required"]) == set(props)
    assert schema.get("additionalProperties") is False
    assert all(not f.nullable for f in RAW_ARROW_SCHEMA)
    timestamp_pattern = props["received_at"]["pattern"]
    for name, arrow_type in RAW_FIELDS:
        prop = props[name]
        if pa.types.is_timestamp(arrow_type):
            assert (prop["type"], prop["pattern"]) == ("string", timestamp_pattern), name
            assert arrow_type == pa.timestamp("us", tz="UTC"), name
        elif arrow_type == pa.int32():
            assert prop["type"] == "integer" and prop["maximum"] <= 2**31 - 1, name
        elif arrow_type == pa.int64():
            assert prop["type"] == "integer" and prop["maximum"] > 2**31 - 1, name
        else:
            assert arrow_type == pa.string() and prop["type"] == "string", name


def test_raw_records_golden_is_current():
    from peoplelake.devtools.goldens import render_raw_records_golden

    path = CONTRACTS / "golden" / "raw-records.json"
    assert path.read_text() == render_raw_records_golden()
    for case in json.loads(path.read_text())["cases"]:
        c.RawRecord.model_validate_json(json.dumps(case["raw_record"]))
