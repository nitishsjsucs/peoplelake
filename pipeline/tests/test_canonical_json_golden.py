import hashlib
import json

import pytest

from peoplelake.canonical import CanonicalJsonError, canonical_json
from peoplelake.paths import repo_root

GOLDEN = json.loads((repo_root() / "contracts" / "golden" / "canonical-json.json").read_text())


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=[c["name"] for c in GOLDEN["cases"]])
@pytest.mark.smoke
def test_golden_case(case):
    text = canonical_json(case["value"])
    assert text == case["canonical"]
    assert hashlib.sha256(text.encode("ascii")).hexdigest() == case["sha256"]


@pytest.mark.parametrize("case", GOLDEN["rejected"], ids=[c["name"] for c in GOLDEN["rejected"]])
def test_golden_rejected(case):
    with pytest.raises(CanonicalJsonError):
        canonical_json(json.loads(case["json"]))
