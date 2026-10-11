# ADR 0006: Verify the Access JWT on every request

Status: accepted (2026-10-10)

## Decision
The Worker never trusts that Cloudflare Access ran. It verifies `Cf-Access-Jwt-Assertion` on every request except `GET /v1/health` with jose: RS256, `iss` equal to the team domain, `aud` equal to the application AUD, and `exp`. Production uses the team JWKS (remote key set, so key rotation is handled); local and CI use the same code against locally generated keys. The `CF_Authorization` cookie is ignored. Service-token JWTs map by `common_name` (the Client ID) and people by `email` through `ACCESS_ROLE_MAP`; a source token may post only to its own source.

## Consequences
A request that bypasses Access (for example a misconfigured route) is still rejected. Organizations with strict service token authentication are supported because machines always send both service-token headers.
