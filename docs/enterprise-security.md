# Enterprise credential and destination controls

The gateway configuration UI stores references such as `BACKEND_ALPHA_TOKEN`; it never stores their values. A deployment-owned `GATEWAY_CREDENTIAL_BINDINGS` policy pins each reference to an exact destination and purpose. The policy is loaded from the process environment, not the editable database, and is checked before secret values are read. URL matches include scheme, host, port, path, and query. PostgreSQL bindings use a credential-free `postgresql://host:port/database` endpoint. Wildcards, host suffix matching, URL credentials, and fragments are rejected.

For production, set `GATEWAY_REQUIRE_CREDENTIAL_BINDINGS=true`. This requires a deployment policy for every HTTP/SSE upstream destination even if it has no credential, and the policy must name every permitted request path. It also enables strict egress validation: every DNS A/AAAA answer is checked at connection time and the checked address is used for that socket, so a later DNS answer cannot redirect a credential-bearing request. This guard covers MCP upstream calls, PostgreSQL connections, OAuth token exchange and introspection, JWT JWKS refresh, OPA/OpenFGA decisions, optional remote routing, inspection and approval services, and the OTLP HTTP trace exporter. Database credentials are pinned with `{"reference":"DATABASE_URL","endpoint":"postgresql://db.example:5432/gateway","purpose":"database"}`. Telemetry headers and client identity still require exact destination bindings. Link-local, metadata, reserved, and other special-use addresses are denied. Private RFC1918/ULA endpoints must be listed narrowly in `GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS`. Enable the same egress behavior without credential binding using `GATEWAY_REQUIRE_EGRESS_VALIDATION=true`. Leaving both enforcement settings unset preserves existing deployments; it does not provide destination or DNS pin guarantees.

For example, an enterprise with an upstream network in `10.24.16.0/20` and `fd12:3456:789a::/48` can set:

```dotenv
GATEWAY_REQUIRE_CREDENTIAL_BINDINGS=true
GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS=10.24.16.0/20,fd12:3456:789a::/48
```

The CIDR list accepts only canonical RFC1918, IPv6 ULA, and loopback subnets. It cannot allow link-local addresses such as `169.254.169.254`, even if they appear in the list. Strict egress rejects the entire DNS answer set if any returned address is unsafe rather than selecting only a public answer. This application-layer guard complements network egress policies and proxies; it does not replace them.

This design follows [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) to bind a request to the vetted address rather than checking DNS and resolving it again later. The implementation passes a bounded Undici dispatcher to Node's [documented Fetch custom-dispatcher hook](https://nodejs.org/download/release/v22.14.0/docs/api/globals.html#custom-dispatcher) and its connection-specific [Agent lookup option](https://undici.nodejs.org/api/Agent). The deterministic integration tests verify the address reaching the actual socket.

Example policy for a credentialed HTTP upstream:

```json
[
  {"reference":"MCP_UPSTREAM_ALPHA","endpoint":"https://tools.example/mcp","purpose":"upstream-endpoint"},
  {"reference":"BACKEND_ALPHA_TOKEN","endpoint":"https://tools.example/mcp","purpose":"upstream"}
]
```

The first entry pins the configurable endpoint independently of the token reference. This prevents an administrator who can edit database configuration from redirecting the credential. Keep the policy in deployment-controlled environment or a mounted environment file. Do not put it in the gateway configuration document.

OAuth client credentials have two separate destination checks: `oauth-token` pins the secret to the identity provider token endpoint, and `oauth-recipient` pins it to the upstream receiving the exchanged token. The inbound agent token is passed only to the configured token-exchange provider. The gateway service credential is removed from the principal before authorization, routing, and inspection plugins are invoked. An outbound credential provider and transport factory execute as trusted in-process code and can access their documented inputs; isolate untrusted extensions in a separate service.

For SSE, deployment policy requires explicit `requestPaths`. Add an `upstream-endpoint` entry for every configured message path and an `upstream` or `oauth-recipient` entry for every path receiving that credential. Streamable HTTP uses the configured endpoint path unless an explicit list is provided. Redirects are rejected, cross-origin requests are rejected, and unsafe hop-by-hop/host override headers are removed before transport. The admin console exposes `requestPaths` as a JSON array.

Stdio environment references are pinned to the executable as well as the upstream identity. The destination is `stdio://<upstream-id>/<percent-encoded-absolute-command>`, for example `stdio://worker/%2Fusr%2Flocal%2Fbin%2Fnode`. The deployment must also list that executable in `STDIO_ALLOWED_COMMANDS`. Args remain gateway configuration and should be treated as trusted administrator-controlled input.

OpenFGA API tokens bind to the exact `/stores/<store-id>/check` operation. Introspection credentials bind to the exact configured introspection endpoint. OTLP can pin the trace endpoint using purpose `telemetry-endpoint`; authorization headers use `telemetry-export`, and exporter client keys use `telemetry-client-identity`. Use the exact endpoint the exporter will call, including the signal path.

For the optional remote route selector, bind both `ROUTER_DECISION_URL` and `ROUTER_BEARER_TOKEN` to the exact decision endpoint with purpose `routing-service`. Its HTTP contract and payload limits are documented in [the plugin API guide](plugin-api.md).

The optional remote inspector uses purpose `inspection-service` and requires `INSPECTOR_TOOLS` to scope which public or physical tools may be evaluated. It receives client and tenant identifiers by default; `INSPECTOR_IDENTITY_FIELDS` explicitly opts into sending subject, roles or auth scheme. `INSPECTOR_DATA_MODE` defaults to `metadata`, which excludes tool arguments and results; set it to `full` to explicitly send complete arguments before execution and results afterward. Full payloads may contain secrets even when gateway credentials are excluded. Approve the endpoint's data region, access, logging and retention before enabling full mode, and cap payloads using `INSPECTOR_MAX_BYTES`. A post-call denial does not reverse the operation.

## Deployment and cloud boundary

The gateway accepts secrets through environment references so operators can inject values using Kubernetes Secrets, a CSI Secrets Store provider, or their cloud secret manager and workload identity. This release does not ship native AWS Secrets Manager, Azure Key Vault, Google Secret Manager, or OCI Vault clients. A deployment adapter or a reviewed credential-provider plugin can provide those integrations without placing provider SDK logic in the gateway core. Rotate values through the secret manager and restart or roll the gateway pods; all replicas must receive the same configuration and compatible secret versions.

For upstream OAuth client-credentials and token-exchange grants, client authentication defaults to `client_secret_basic`: the secret is form-encoded with the client identifier and sent in HTTP Basic, separate from the grant body. `oauth.clientAuthMethod: "client_secret_post"` is an explicit compatibility option for providers that require request-body authentication. Both paths remain bound to the configured token endpoint; Basic is the preferred interoperable choice under [RFC 6749 §2.3.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1), and RFC 8693's exchange example uses it as well.

## Per-user delegation and mTLS

Do not copy the gateway's inbound bearer token to an arbitrary upstream. The MCP authorization specification requires audience validation and says MCP servers must not accept or transit tokens issued for other resources. Configure an OAuth token exchange to obtain a token for the actual downstream MCP resource instead:

```json
{
  "id": "jira",
  "url": "https://jira.example/mcp",
  "oauth": {
    "mode": "token_exchange",
    "tokenEndpoint": "https://identity.example/token",
    "clientIdEnv": "GATEWAY_CLIENT_ID",
    "clientSecretEnv": "GATEWAY_CLIENT_SECRET",
    "actorTokenEnv": "GATEWAY_ACTOR_TOKEN",
    "resource": "https://jira.example/mcp",
    "scope": "issues:read"
  },
  "tls": {
    "clientCertEnv": "JIRA_CLIENT_CERT_PEM",
    "clientKeyEnv": "JIRA_CLIENT_KEY_PEM",
    "caEnv": "JIRA_SERVER_CA_PEM"
  }
}
```

`resource` is sent as RFC 8707's token-request parameter. `actorTokenEnv` is optional RFC 8693 actor evidence; it is sent only to the configured token endpoint and is accepted only with token exchange. The authorization server decides whether it will issue the downstream token and which delegated scope it carries. The resulting bearer token is sent only to this upstream. Configure exact deployment credential bindings with purpose `oauth-token` for the actor token, `oauth-token-tls` for the certificate/key/CA at the token endpoint, and `upstream-tls` for those TLS references at each upstream endpoint and allowed request path.

For RFC 8705 OAuth client-certificate authentication at the token endpoint, set `oauth.clientAuthMethod` to `tls_client_auth` (PKI-issued client cert) or `self_signed_tls_client_auth` (registered self-signed cert), provide the matching `tls` certificate/key references, and omit `clientSecretEnv`. The gateway sends `client_id` in the form body and authenticates the token request with that TLS certificate. It reuses the same certificate for the configured MCP upstream. When the authorization server also issues a certificate-bound token, the resource server can verify that token against the certificate presented on this upstream connection.

The `tls` configuration presents a gateway-owned client identity on the upstream HTTPS connection and, when configured, the OAuth token endpoint connection. This works with RFC 8705 certificate-bound access tokens when the authorization server binds the issued token to this same certificate and the MCP resource checks the binding. It does not forward the agent's inbound certificate or private key. When credentials are user-specific, implement the optional `CredentialProvider.tls(upstream, principal)` and use a managed vault or short-lived certificate issuer; the default configured PEM references are shared across callers of that upstream.

An inbound mTLS certificate authenticates the agent to Relay only. The gateway maps its verified certificate fingerprint to the configured identity, applies the same per-tool authorization, and then connects using the independently configured upstream identity. If an upstream needs an identity assertion for that user rather than a shared gateway certificate, use a trusted identity-aware credential provider or token exchange supported by your identity system. A fingerprint alone is not cryptographic proof for the next TLS hop.

Destination pins do not prevent IP routing changes, compromised destination services, or a trusted plugin from making its own network request. Enforce egress at the network layer too: allow only approved service identities/private endpoints, block cloud metadata ranges, validate DNS in the egress proxy, and apply Kubernetes NetworkPolicy, cloud security groups/firewalls, or equivalent on-prem controls. The application guard covers the built-in PostgreSQL pool and OTLP HTTP trace exporter, but not arbitrary plugin-owned outbound connections. Strict PostgreSQL mode requires TCP and `sslmode=verify-full`; weaker modes are rejected and Unix-domain socket URLs are unsupported. For a private database CA, configure `sslrootcert` in `DATABASE_URL` and mount the CA through the deployment's secret or trust configuration. PostgreSQL verifies the CA chain and the original database hostname, even though the socket connects to the pinned IP. Strict telemetry mode uses a non-keepalive agent because the pinned exporter transport does not expose agent cleanup.

## Extension and performance contract

Routing, authorization, credential, inspector, store, limiter, and transport interfaces are replaceable. The v0.11 OPA adapter provides an out-of-process policy decision option for centrally managed Rego; see [OPA policy setup](opa-policy.md). The current workspace also supports an out-of-process route-selection service with an allowlisted identity projection and admin-constrained candidate targets. This isolates routing code from the gateway process, but does not sandbox uploaded plugins generally. Other extensions loaded in-process remain privileged application code. Use separate services with their own identities for third-party extensions; keep deployment artifacts versioned, signed, reviewed, and included in controlled images.

The current workspace also enforces a route-target boundary after custom routing: direct physical names cannot be rebound, and aliases are limited to enabled, selector-eligible targets in the administrator's route table. This closes a same-tenant substitution path while keeping custom target selection flexible. OWASP recommends checking access for the specific function/object on every request ([Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)); real MCP regressions are in `test/advanced.test.js`. This fix is unreleased and does not sandbox trusted plugin code.

Bindings are parsed and validated when configuration is loaded. Destination membership is an in-memory exact-set lookup and does not add a remote policy request to each tool call. A PostgreSQL-backed deployment shares config revisions, audit records, rate buckets, concurrency leases, and circuit-breaker state across replicas; SQLite uses local limiter and circuit state for single-instance development. The PostgreSQL breaker admits one recovery probe across replicas and ignores stale completions using a generation counter. This change has not established a production throughput limit. Measure with the deployment's upstream latency, tool mix, database, tracing exporter, and replica counts before setting capacity commitments.

## Verification in this release

The enterprise security tests cover admin destination repointing, no secret read before policy approval, malformed policy, URL canonicalization, OAuth issuer and recipient separation, SSE path pins, stdio command pins, OpenFGA and introspection destinations, OTLP credentials, redirects, cross-origin requests, unsafe headers, token-free plugin contexts, and OPA decision parsing and failure handling. Browser coverage checks editing explicit request paths. v0.10 and v0.11 verification records document separate release evidence.
