import json
import stat

import jwt
import pytest

from peoplelake.auth.dev_tokens import DEV_AUDIENCE, DEV_ISSUER, KID, AccessHeaders, generate_dev_keys, mint


@pytest.fixture
def keys(tmp_path):
    jwks = generate_dev_keys(tmp_path / "keys", tmp_path / ".dev.vars")
    return tmp_path, jwks


def verify(token, jwks, **kw):
    key = jwt.PyJWK(jwks["keys"][0]).key
    return jwt.decode(token, key, algorithms=["RS256"], audience=kw.get("aud", DEV_AUDIENCE), issuer=DEV_ISSUER)


def test_dev_keys_files_and_dev_vars(keys):
    root, jwks = keys
    for name in ("keys/private.pem", "keys/jwks.json", ".dev.vars"):
        assert stat.S_IMODE((root / name).stat().st_mode) == 0o600
    line = next(ln for ln in (root / ".dev.vars").read_text().splitlines() if ln.startswith("DEV_ACCESS_JWKS="))
    assert json.loads(line.split("=", 1)[1]) == jwks
    assert jwks["keys"][0]["kid"] == KID and jwks["keys"][0]["alg"] == "RS256"
    assert "d" not in jwks["keys"][0]  # public only


def test_dev_vars_keeps_other_lines(tmp_path):
    (tmp_path / ".dev.vars").write_text("OTHER=1\nDEV_ACCESS_JWKS=old\n")
    generate_dev_keys(tmp_path / "keys", tmp_path / ".dev.vars")
    text = (tmp_path / ".dev.vars").read_text()
    assert "OTHER=1" in text and "DEV_ACCESS_JWKS=old" not in text


def test_service_token_claims(keys):
    root, jwks = keys
    token = mint("runner", keys_dir=root / "keys", now=1_800_000_000, ttl_seconds=300)
    assert jwt.get_unverified_header(token) == {"alg": "RS256", "kid": KID, "typ": "JWT"}
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims == {
        "common_name": "runner.access",
        "sub": "",
        "iss": DEV_ISSUER,
        "aud": DEV_AUDIENCE,
        "iat": 1_799_999_995,
        "exp": 1_800_000_300,
    }


def test_user_token_verifies_and_expires(keys):
    root, jwks = keys
    claims = verify(mint("operator", keys_dir=root / "keys"), jwks)
    assert claims["email"] == "dev@peoplelake.local"
    with pytest.raises(jwt.ExpiredSignatureError):
        verify(mint("operator", keys_dir=root / "keys", ttl_seconds=-120), jwks)
    with pytest.raises(jwt.InvalidAudienceError):
        verify(mint("operator", keys_dir=root / "keys"), jwks, aud="someone-else")


def test_access_headers(keys):
    root, _ = keys
    assert list(AccessHeaders(local=True, keys_dir=root / "keys")()) == ["Cf-Access-Jwt-Assertion"]
    prod = AccessHeaders(local=False, client_id="id.access", client_secret="s3cret")()
    assert prod == {"CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s3cret"}
    with pytest.raises(ValueError):
        AccessHeaders(local=False)
