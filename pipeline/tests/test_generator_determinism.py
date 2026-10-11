import json

from peoplelake.canonical import canonical_json
from peoplelake.generator import generate, get_profile
from peoplelake.generator.pins import DATASET_SHA256


def test_dataset_sha256_is_pinned(ds):
    assert ds.dataset_sha256() == DATASET_SHA256[ds.profile.name]


def test_regeneration_is_byte_identical(small):
    again = generate(get_profile("small"))
    for source in ("hris", "ats", "talent"):
        assert again.file_bytes(source) == small.file_bytes(source)


def test_lines_are_canonical_json_sorted_by_sequence(ds):
    for source, lines in ds.lines.items():
        seq_key = {"hris": "sequence", "ats": "seq", "talent": "revision"}[source]
        prev = 0
        for line in lines[:2000]:
            obj = json.loads(line)
            assert canonical_json(obj) == line
            assert obj[seq_key] == prev + 1
            prev = obj[seq_key]


def test_payload_numbers_are_integers(ds):
    def walk(v):
        assert not isinstance(v, float)
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    for source in ("hris", "ats", "talent"):
        for env in ds.envelopes(source):
            walk(env)
