# Component hardening — current authentication and authorization behavior

The research programme is still in progress. See [the plan](component-hardening-plan.md), [source-specific paper findings and exact progress](component-research.md), and [commercial comparison](commercial-component-review.md). This document describes implemented behavior, independently of research targets.

## Audit retrieval and retention

The administrator API keeps `/admin/api/audit` as the latest-100 compatibility endpoint and adds `/admin/api/audit/pages?limit=100&cursor=...` for bounded forward pagination. Page size is limited to 500; immutable database row IDs provide keyset order so later pages are not offset-shifted by new records. A traversal is not a transactionally consistent database snapshot: for archival exports, repeat the tail after writes settle or use a deployment-owned export process. The cursor is opaque but is not an authorization token; every page still requires administrator authentication. This improves complete retrieval but does not provide tamper-evident/WORM storage, retention deletion, archival, or SIEM delivery. Plan database capacity and export records to an independently controlled audit system where required.

## Authentication configuration

Choose **one** inbound deployment mode. JWT verification, introspection, or mTLS replaces service-key authentication; rejected credentials do not fall back to keys. Administrator access remains a separate key. Deployment identity-provider credentials and TLS files stay in environment/secret management and require restart; the UI configures identity bindings, not arbitrary trusted issuer URLs. Switching all authentication settings off returns to the explicitly documented key mode, so deployment configuration must be controlled.

| Mode | Deployment settings | Behavior |
|---|---|---|
| Service key | Default; each configured identity references its own `tokenEnv` | Constant-time comparison; key rotation through environment/config publication. Short-lived tokens and proof binding are not provided by a static key. |
| JWT resource server | Single issuer: `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_JWKS_URL`; or 2–16 pinned `JWT_ISSUER_PROFILES` JSON entries. Profiles may set their own `requiredScopes`, `requiredTyp`, and `maxTokenAgeSeconds`. `GATEWAY_RESOURCE_URL` remains required; optional `JWT_DPOP_REQUIRED=true` | Each profile pins issuer, audience and JWKS URL. The unverified `iss` only selects a pinned verifier; no URL or key source is derived from token claims. Multiple-issuer mode requires every gateway identity to set exact `oauthIssuer`; same subjects can safely map to distinct identities across issuers. MCP protected-resource metadata advertises all trusted authorization servers. Optional DPoP verifies proof binding and nonce challenges. This alone is not full RFC 9068 certification. |
| Opaque OAuth introspection | `OAUTH_INTROSPECTION_URL`, `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, `OAUTH_INTROSPECTION_CLIENT_ID`, `OAUTH_INTROSPECTION_CLIENT_SECRET`, `GATEWAY_RESOURCE_URL`; optional `OAUTH_REQUIRED_SCOPES`, `OAUTH_MAX_TOKEN_AGE_SECONDS`, `OAUTH_DPOP_REQUIRED=true` | RFC 7662 POST with separately authenticated `client_secret_basic`; strict response profile requires active boolean, issuer, audience, subject, exp and iat. DPoP mode requires `token_type=DPoP`, a matching `cnf.jkt`, and a valid RFC 9449 proof. Optional nonce challenge configuration is shared with JWT mode. No positive cache: revocation is checked per request. 2-second timeout, 16 KiB JSON body budget, no redirects. Some RFC 7662 fields are optional in the RFC but mandatory in this profile. |
| mTLS certificate identity | `GATEWAY_TLS_CERT_FILE`, `GATEWAY_TLS_KEY_FILE`, `GATEWAY_MTLS_CLIENT_CA_FILE`; each client identity has a unique `certificateSha256` | The gateway terminates TLS, requests a peer certificate, maps only a CA-authorized certificate's DER SHA-256 base64url thumbprint, ignores forwarded certificate headers, and rejects Authorization headers on MCP/catalog requests. The admin API still uses its separate key; health endpoints remain open for orchestration. This is certificate-only identity authentication; it does not implement RFC 8705 certificate-bound OAuth access tokens or TLS termination at an ingress proxy. |

API-key, OAuth-subject and mTLS-thumbprint identities may omit `tokenEnv`; the listener's selected mode determines which identity attribute is used. No service-key fallback is enabled in the OAuth or mTLS modes.

Inbound token values and DPoP proofs are bounded to 8192 characters and must occur in exactly one Authorization/DPoP header. The scheme is case insensitive. Query tokens, duplicate proof headers and malformed values are not accepted. A `cnf.jkt` token is accepted only in the explicitly configured DPoP mode; bearer downgrade is rejected. Proof replay claims are atomic in PostgreSQL across replicas. The in-memory replay store is for one local process only; DPoP mode refuses to start without an HTTPS public origin and replay store. The origin must match the client-visible URL behind an ingress. Optional nonce challenges issue a signed, short-lived nonce in `DPoP-Nonce` and require a matching proof claim; replicas need the same deployment secret. When enabled, nonce issuance time supplies the proof freshness check, avoiding reliance on client clock synchronization. Nonces may be reused during their lifetime as permitted by RFC 9449, while the shared `jti` store rejects proof replay. Native certificate-only mTLS identity is supported; RFC 8705 OAuth certificate-bound access tokens remain unsupported.

For local JWT verification, `JWT_REVOCATION_ENABLED=true` adds synchronous `issuer + jti` lookup on every token authentication and enables an issuer-wide emergency stop. The administrator can revoke one JWT using issuer and signed JWT ID from trusted identity-provider records, or block every otherwise-valid JWT from an issuer, including tokens signed after a key rotation. Raw tokens are never accepted or stored. Normal JWT acceptance in this mode requires a bounded `jti`; tokens without one are denied independently. Revocation entries use SHA-256 keys and expire automatically; issuer-stop state is also hashed and shared across replicas by PostgreSQL. SQLite supports local single-instance use. Store failures deny authentication. Choose an expiry at or after the token's actual `exp`; the control accepts at most 30 days to bound storage. State changes and metadata-only audit events commit atomically. This is gateway-local enforcement: it does not revoke tokens at their issuer or affect other resource servers. PostgreSQL behavior still requires the disposable-service integration run.

Identity entries can set `subject`, `tenantId`, `oauthClientId`, and `certificateSha256`. The OAuth client ID requires the verified token/introspection `client_id` to match; the mTLS fingerprint is pinned to the verified TLS peer. This supports two agents acting for the same mapped subject with different permissions. An unbound and client-bound mapping for the same subject/tenant would overlap and is rejected. Roles/grants remain administrator owned; arbitrary JWT roles do not become permissions. `azp`, nested `act` and vendor-specific claim mappings are not inferred. Introspected tokens are not silently treated as JWTs for the existing JWT-only delegated exchange adapter.

## Authorization and ReBAC

Tool allow lists, configured RBAC, OpenFGA, physical/alias pins and argument policies remain cumulative restrictions. Relationship authorization is useful for team/project membership and shared tool entitlements; it does not replace backend record-level ownership or independent approval. OpenFGA decisions retain the pinned store/model and `HIGHER_CONSISTENCY`; that option is not a claim of Zanzibar's full causal consistency contract.

OpenFGA responses now have a 16 KiB streaming bound, JSON content-type/object checks, a strict boolean decision, a timeout and redirect rejection. Explicit HTTP is limited to loopback; HTTPS endpoints for internal services remain deployment-owned. HTTPS configuration alone does not install a network egress allowlist.

`FGA_NAMESPACE_FORMAT=tuple-v2` encodes user/object IDs as `encodeURIComponent(JSON.stringify([tenantId ?? 'default', id]))`. Provision corresponding tuples in a reviewed model/store before enabling it consistently across replicas. No legacy lookup fallback occurs in v2. The default remains legacy for compatibility; ambiguous slash-containing default-tenant user IDs fail closed. Legacy resource ID composition is not a general injective namespace; new multi-tenant deployments should use v2. Switching formats without migration denies previously stored grants. Existing grants are never rewritten automatically.

Argument policy objects retain required `allow` and add optional `deny`. Each contains bounded rules with optional client selectors and scalar/path constraints. Matching **any deny** blocks, even if an allow matches. No allow match also blocks. Both alias and physical policies must permit the operation. Example:

```json
{
  "invocationPolicies": {
    "finance__transfer": {
      "allow": [{"constraints": [{"field": ["amount"], "op": "numberRange", "min": 0, "max": 100}]}],
      "deny": [{"constraints": [{"field": ["environment"], "op": "equals", "value": "production"}]}]
    }
  }
}
```

This is a bounded declarative policy facility, not a Cedar interpreter or formally verified policy generator.

## Routing

Routes may add `tenants` and `requiredRoles` (all roles must match), alongside the existing `clients` selector. These use the authenticated, configured principal; raw caller headers cannot select an identity or expand access. Discovery aliases and invocation apply the same eligibility checks. Physical names still require their own ordinary grants and tenant checks.

The new `priority` strategy picks the lowest configured target `priority` (default 0), then breaks ties by stable upstream/tool key order. It is deterministic configured preference, **not health-based failover**. A failure does not dispatch the same call elsewhere. Weight is used by weighted/sticky/rendezvous strategies, not priority. Route targets must still implement compatible tool contracts. More dynamic needs belong behind the typed Router adapter, with mandatory gateway authorization/tenant checks retained.

## Protocol budgets and retries

Each upstream may configure `timeoutMs` and `connectTimeoutMs` (1–120000 ms). Total timeout defaults to the gateway timeout; connection timeout defaults to and is capped by that total. The cumulative deadline starts before credential acquisition, covers connection/validation/operation, and observes caller cancellation. Waiting for a slow credential provider ends at the deadline and cannot trigger a later connection. A trusted provider can still finish internal cooperative work; this is not process termination or rollback. Long-lived subscription handling retains its separate 120-second stream bound.

Modern Streamable HTTP, legacy HTTP/SSE upstreams and approved stdio retain their tested mediation. WebSocket/gRPC/REST conversion is not claimed as native MCP transport support. Tool-effect retries and hedges remain disabled because a lost response does not establish that an action failed. A safe retry feature needs backend idempotency, durable attempt identity, bounded retry budgets and outcome reconciliation. Neither annotations nor an in-memory cache proves exactly-once execution.

The administration forms expose subject/client binding, route roles/tenants/priorities, and per-server time budgets. Full configuration JSON still provides the bounded deny rules. Rollback to v0.7 requires first restoring a configuration without v0.8 fields and reverting deployment-only authentication settings if used; prior binaries cannot parse the new fields.
