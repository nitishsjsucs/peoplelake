"""Locally generated RS256 keys for Access JWT verification (SPEC 12).

`generate_dev_keys` writes `.dev/keys/private.pem` and `.dev/keys/jwks.json` (mode 600) and puts the
public JWKS into `.dev.vars` as DEV_ACCESS_JWKS, which `wrangler dev` reads. Tokens use the dev issuer
and audience configured in wrangler.jsonc. The Worker verifies them with the same code that verifies
production Access JWTs against the team JWKS. Production machine clients send Access service-token
headers instead and Access injects the JWT.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

DEV_ISSUER = "https://peoplelake-dev.local"
DEV_AUDIENCE = "peoplelake-dev"
KID = "peoplelake-dev-1"

IDENTITIES: dict[str, dict[str, str]] = {
    "runner": {"common_name": "runner.access"},
    "hris": {"common_name": "src-hris.access"},
    "ats": {"common_name": "src-ats.access"},
    "talent": {"common_name": "src-talent.access"},
    "operator": {"email": "dev@peoplelake.local"},
}


def _write_private(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data.encode() if isinstance(data, str) else data)
    os.chmod(path, 0o600)


def update_dev_vars(dev_vars: Path, name: str, value: str) -> None:
    lines = dev_vars.read_text().splitlines() if dev_vars.exists() else []
    lines = [ln for ln in lines if not ln.startswith(f"{name}=")]
    lines.append(f"{name}={value}")
    _write_private(dev_vars, "\n".join(lines) + "\n")


def generate_dev_keys(keys_dir: Path, dev_vars: Path) -> dict:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    public_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public_jwk.update({"kid": KID, "alg": "RS256", "use": "sig"})
    jwks = {"keys": [public_jwk]}
    _write_private(keys_dir / "private.pem", pem)
    _write_private(keys_dir / "jwks.json", json.dumps(jwks, indent=2) + "\n")
    update_dev_vars(dev_vars, "DEV_ACCESS_JWKS", json.dumps(jwks, separators=(",", ":")))
    return jwks


def load_private_key(keys_dir: Path):
    path = keys_dir / "private.pem"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found; run `peoplelake auth dev-keys`")
    return serialization.load_pem_private_key(path.read_bytes(), password=None)


def mint(identity: str, *, keys_dir: Path, ttl_seconds: int = 300, now: int | None = None, key=None) -> str:
    """A dev Access JWT for one of IDENTITIES (or an email address)."""
    claims: dict[str, object] = dict(IDENTITIES.get(identity) or {"email": identity})
    if "common_name" in claims:
        claims["sub"] = ""
    issued = int(time.time()) if now is None else now
    claims.update({"iss": DEV_ISSUER, "aud": DEV_AUDIENCE, "iat": issued - 5, "exp": issued + ttl_seconds})
    return jwt.encode(claims, key or load_private_key(keys_dir), algorithm="RS256", headers={"kid": KID})


class AccessHeaders:
    """Headers for machine requests to the Worker: dev JWTs locally, service-token headers in production."""

    def __init__(
        self,
        *,
        local: bool,
        identity: str = "runner",
        keys_dir: Path | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
    ) -> None:
        self.local = local
        self.identity = identity
        self.keys_dir = keys_dir
        self.client_id = client_id
        self.client_secret = client_secret
        self._key = None
        if not local and not (client_id and client_secret):
            raise ValueError("production requests need PL_CF_ACCESS_CLIENT_ID and PL_CF_ACCESS_CLIENT_SECRET")

    def __call__(self) -> dict[str, str]:
        if self.local:
            if self._key is None:
                assert self.keys_dir is not None
                self._key = load_private_key(self.keys_dir)
            return {"Cf-Access-Jwt-Assertion": mint(self.identity, keys_dir=self.keys_dir or Path("."), key=self._key)}
        return {"CF-Access-Client-Id": self.client_id or "", "CF-Access-Client-Secret": self.client_secret or ""}
