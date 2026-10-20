# Relay — modular MCP gateway

The [Relay GitHub repository](https://github.com/previdus/relay-mcp-gateway) is the home for source, issues, and releases. The [project website source](website/index.html) gives a guided overview of the request flow, security model, deployment options, and contribution links. Build a self-contained static site with `npm run website:build` (then open `website/dist/index.html`); verify its local links with `npm run website:check`. The project is released under the [MIT License](LICENSE). See [contribution guidance](CONTRIBUTING.md) and [security reporting](SECURITY.md) before opening a change or issue.

## Performance baseline

Run `npm run perf:smoke` for a local end-to-end baseline through the real MCP gateway and demo upstream. Set `RELAY_PERF_CONCURRENCY`, `RELAY_PERF_DURATION_SECONDS`, and `RELAY_PERF_WARMUP_SECONDS` to adjust the run; optional `RELAY_PERF_MAX_P95_MS` and `RELAY_PERF_MIN_RPS` enforce local thresholds. The report includes latency, throughput, event-loop delay, and memory deltas. See [performance validation](docs/performance-validation.md) for interpretation and limitations.



TypeScript gateway with an administration console, versioned database configuration, replaceable routing and authorization, and MCP SDK v2 protocol handling. This is a growing product foundation; see the [coverage matrix](docs/coverage.md) for implemented features and release gaps.

## Strict upstream egress (v0.12)

Strict credential destination mode now also validates and pins upstream DNS answers at connection time. Private services require a narrow RFC1918/ULA CIDR allowlist; metadata and other special-use ranges remain denied. See [enterprise security](docs/enterprise-security.md) for deployment settings and limits.

## Enterprise destination security (v0.10)

Deployment-owned exact credential destination bindings protect upstream, OAuth, telemetry, and stdio credentials. Strict mode pins every HTTP upstream, validates/pins DNS answers for the actual connection, and requires explicit request paths for deployment-bound SSE. See [enterprise security](docs/enterprise-security.md) and the [review ledger](docs/enterprise-iteration-plan.md). Cloud vault adapters, network-level egress policy, and plugin sandboxing remain deployment or follow-up work.

## External policy decisions (v0.11)

An optional [Open Policy Agent adapter](docs/opa-policy.md) composes as a required policy alongside the built-in allowlist, roles, and OpenFGA. It sends identity attributes and resource names only, accepts only literal boolean approval, and fails closed on timeouts and invalid responses. OPA policy lifecycle remains operator-managed.

## External human approval for sensitive tools

The Action safeguards screen can mark exact tools or namespace wildcards as approval-required. Configure a separate deployment-owned `APPROVAL_DECISION_URL` and `APPROVAL_BEARER_TOKEN`; the console edits only the selected tool policy. The first call can only create a pending review. The caller must resubmit the same action with the returned one-use permit, and the gateway verifies an external consume decision before any upstream effect. The binding covers caller/tenant, full arguments, selected route, configuration revision, and pinned tool contract. See [approval adapter behavior and its trust boundary](docs/plugin-api.md#external-human-approval-for-selected-tools). The external service must supply the reviewer UI, independent reviewer authentication, durable expiry, and atomic one-time consumption; the gateway does not guarantee exactly-once business execution.



## Proof-bound OAuth tokens

JWT and opaque introspection deployments can optionally require [OAuth DPoP](https://www.rfc-editor.org/rfc/rfc9449.html), binding each token use to a client key and the exact method, public HTTPS URL and token hash. PostgreSQL shares one-use proof replay protection across replicas; the in-memory store is intended for a single local process. Set `JWT_DPOP_REQUIRED=true` or `OAUTH_DPOP_REQUIRED=true`, configure `GATEWAY_DPOP_PUBLIC_ORIGIN`, and use PostgreSQL for multi-replica deployment. Optional nonce challenges can further reduce proof pre-generation risk when all replicas share `GATEWAY_DPOP_NONCE_SECRET`. OAuth issuance/key registration remains the identity provider's responsibility; RFC 8705 certificate-bound OAuth tokens are not implemented. See [authentication details](docs/component-hardening.md#authentication-configuration) and the [unreleased test record](docs/validation-unreleased.md).

For locally verified JWTs, `JWT_REVOCATION_ENABLED=true` enables immediate issuer-bound `jti` revocation and an issuer-wide emergency stop through the Identity security screen. Use PostgreSQL across replicas; SQLite state is local to one process. The shared check runs on every authentication, store failures deny access, per-token records are hashed and expire, and normal JWT acceptance requires a bounded `jti`. Re-enabling a stopped issuer is explicit and audited. This does not revoke tokens at the identity provider or other resource servers.

## Continued hardening (v0.9 checkpoint)

Added bounded JWKS retrieval, OAuth-only identities without API keys, coalesced expired-token refresh, stricter RFC 8693 response validation, and per-target alias availability controls. See [configuration and migration](docs/continued-hardening.md), [article findings](docs/continued-component-research.md), and [seven completed review cycles](docs/component-cycles.md). The 200-article / 40-cycle programme remains incomplete: 25 articles/chapters and 7 cycles are recorded so far.

## Component hardening (v0.8 checkpoint)

Added [opaque OAuth introspection, verified subject/client bindings, JWT type/age checks, bounded ReBAC decisions, collision-free OpenFGA namespaces, explicit argument forbids, priority/tenant/role routing and upstream deadlines](docs/component-hardening.md), with console controls and regression tests. The [component plan](docs/component-hardening-plan.md), [40-paper findings and progress ledger](docs/component-research.md), and [ten-commercial-offering review](docs/commercial-component-review.md) record scope. The requested 200-article and forty-cycle programme is **still pending beyond this first pass**; retrieved papers or checklist items are not counted as completed deep iterations.

## Five-round expansion (v0.7)

The [second audit and 50-paper review](docs/expansion-review.md) covers five additional groups of ten papers, with source-specific findings, limits and decisions. The [ten-gateway comparison](docs/gateway-landscape.md) distinguishes documented strengths, editions and unresolved gaps. The [expansion plan](docs/expansion-plan.md) preceded source changes.

Added: cumulative physical/alias pins; a [typed, veto-only inspection API](docs/plugin-api.md); bounded catalog collection, standard pagination and [authorized literal search](docs/catalog-and-routing.md); weighted rendezvous routing with tenant-eligible selection; and modern parameter-header validation/mirroring. Search is an optional companion HTTP API, not semantic search or a new MCP method. Inspectors are trusted deployment code, not a sandbox. See the [validation record](docs/validation.md) for measured evidence and remaining gates.

## Research-backed safeguards (v0.6)

The [30-source review](docs/research-review.md) records findings from 20 engineering articles and 10 research papers. The [implementation plan](docs/research-implementation-plan.md) was published before source changes. This release adds bounded argument-level permissions, reviewed-only tool catalogs, metadata display-control rejection, and an Action safeguards console panel. See [configuration examples and limitations](docs/action-safeguards.md). These controls complement existing authorization; they do not establish universal prompt-injection resistance.

## Try it locally

For the AWS-hosted public demonstration, see the [AWS demo guide](docs/aws-demo.md). It uses a one-instance App Runner gateway with synthetic enterprise fixtures and a CloudFront-hosted static site. No AWS budget alert is configured; monitor spending in Billing and Cost Management.



Requires Node.js 22.14 or later. SQLite uses Node's built-in API (experimental on Node 22).



```sh

npm ci

npm run demo

```



Open `http://127.0.0.1:3000/admin/` and enter the generated **admin key** printed in the terminal. Use the separate **service key** to connect an MCP client to `http://127.0.0.1:3000/mcp` with `Authorization: Bearer <service key>`.



The demo starts a legacy MCP upstream, a modern upstream, and safe local simulations for Jira, AWS, Gmail, Slack, Google Drive, and application logs. Product-like tools are exposed with names such as `jira__search`, `aws__cloudwatch_logs`, and `gmail__create_draft`; the `enterprise_search` alias demonstrates priority routing across multiple servers. Simulated writes return previews and never touch real accounts. All demo data is synthetic. The in-memory database is discarded and demo keys rotate on restart.

See [MCP server interoperability and integration limits](docs/integration-compatibility.md) for supported transports/capabilities, vendor authentication patterns, and the remaining OAuth account-linking boundary.



## Configure a persistent gateway



1. Copy `.env.example` to `.env` and set independent random admin and service keys. Generate each with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

2. Update `gateway.config.json` with approved upstreams, secret environment variable references, and permissions.

3. Set referenced secrets in `.env`. The UI stores references, never secret values.

4. Run `npm run build`, then `npm start`.



On first start, the file seeds the database. After that, the database is authoritative: use the console or management API to change configuration. Changing the seed file does not overwrite an existing database. All replicas must have the same referenced secrets. Secret changes require a process restart.

The administrator API exposes the most recent 100 audit events at `/admin/api/audit` and bounded ascending pages at `/admin/api/audit/pages?limit=100&cursor=...` (maximum 500 events per page). Keyset pages avoid offset shifts, but are not a transactionally consistent snapshot. This endpoint reads the gateway's database audit log; retention, archival, tamper-evident storage, and SIEM forwarding must be provided by the deployment.



Without `DATABASE_URL`, configuration and audit events persist in `data/gateway.sqlite`. SQLite mode is intended for a single local deployment. With `DATABASE_URL`, PostgreSQL holds shared configuration, audit events, and expiring concurrency leases. Every request reads the current revision; store failures reject requests rather than falling back to stale permissions.



## Security and access



- Default authentication: gateway service keys. Keys are compared via constant-time digest comparisons.

- JWT mode: set `JWT_ISSUER`, `JWT_JWKS_URL`, `JWT_AUDIENCE`, and `GATEWAY_RESOURCE_URL`, or use `JWT_ISSUER_PROFILES` for 2–16 separately pinned issuers. Multiple-issuer mode requires each identity to set its exact `oauthIssuer` in the administration console/configuration. This replaces service-key authentication; there is no downgrade fallback. Each profile checks its own signing keys, issuer, audience, expiration, and optional scope/type/token-age rules. See [authentication details](docs/component-hardening.md#authentication-configuration).

- OAuth protected-resource metadata is served at the well-known path for the configured resource. Unauthorized requests advertise it. Your external OAuth/OIDC provider owns login, consent, client registration, and token issuance; validate its compatibility separately.

- mTLS agent authentication is available when the gateway itself terminates TLS. Set `GATEWAY_TLS_CERT_FILE`, `GATEWAY_TLS_KEY_FILE`, and `GATEWAY_MTLS_CLIENT_CA_FILE`; map each identity using `certificateSha256` (base64url SHA-256 of the client certificate's DER bytes). MCP and catalog requests require the verified peer certificate and reject bearer credentials and forwarded certificate headers in this mode. The admin API still uses its separate administrator key, and health endpoints remain available for orchestration probes. Mount TLS files as secrets. This mode does not implement RFC 8705 certificate-bound OAuth tokens and cannot be used behind a TLS-terminating ingress unless the gateway also terminates and verifies client TLS.

- Tool `allow` grants accept an exact public tool name or `upstream__*`. Empty lists deny all tools.

- `roleGrants`, when present, adds a required role check. Roles do not override an identity's own grants.

- OpenFGA mode adds a required relationship check. Set `FGA_URL`, `FGA_STORE_ID`, and immutable `FGA_MODEL_ID`; optionally set `FGA_API_TOKEN`. Errors and outages deny access. `FGA_ALLOW_HTTP=true` is for a trusted local service network only.

- The admin key is separate and controls configuration, including permissions. Keep the control plane on a restricted network. UI keys stay in browser memory; no local storage is used.



Always configure `GATEWAY_ALLOWED_HOSTS` for the externally served hostname and set matching `allowedHosts` in gateway configuration. Origins are denied unless explicitly allowed. For service-key and OAuth modes, TLS should terminate at a trusted ingress; mTLS mode terminates TLS in the gateway. Set `UPSTREAM_ALLOWED_HOSTS` for an immutable deployment-level destination allowlist; additionally enforce outbound network policy. URL validation and redirect refusal alone are not complete SSRF protection.



## Routing and protocol features



Namespaced routing is the default. `routes` adds public aliases with weighted distribution or a stable target per identity/tool. Optional client restrictions can segment routes. Aliases must have compatible tool contracts across targets; automatic cross-target contract validation is not yet implemented. Reviewed public-tool fingerprints can now reject changed definitions at discovery and invocation. Calls never automatically retry side effects.



Before forwarding a tool call, the gateway finds the selected upstream tool and validates arguments against its advertised JSON Schema using the SDK's dialect-aware validator. Schemas and inputs have structure limits, and external schema references are disabled. Upstream responses are capped (4 MiB by default, configurable with `maxUpstreamResponseBytes`), including chunked responses. Schema compilation, regex evaluation, and structured-output validation run in bounded worker threads with deadlines, memory limits, and a bounded queue.



```json

{

  "name": "search",

  "strategy": "sticky",

  "clients": ["research-agent"],

  "targets": [

    { "upstreamId": "primary", "tool": "search", "weight": 9 },

    { "upstreamId": "canary", "tool": "search", "weight": 1 }

  ]

}

```



Streamable HTTP ingress serves the July 2026 protocol and stateless legacy requests through the official SDK. Outbound connections negotiate modern/legacy automatically; `transport: "sse"` selects the older HTTP+SSE upstream transport. A dedicated fixture verifies modern-to-SSE calls and credential separation. SDK v1 is retained for compatibility fixtures.



Tools are enabled by default. Opt into `features.prompts` and `features.resources`, then configure the separate identity `permissions.prompts` and `permissions.resources` grants. Prompts use `upstream__name`; resource grants use `upstream__original-uri`. The public resource URI is `mcp-gateway://upstream/percent-encoded-original-uri`. Resource reads rewrite content URIs back into that namespace. Prompt and resource wildcards are `upstream__*`. No feature grants are inferred from tool grants.



Modern callbacks, notifications, templates, completion and MCP Tasks V2 are opt-in capabilities described below. Legacy push callbacks are not bridged. The routing console includes a published-policy simulator that evaluates access and selects a route without invoking the upstream tool.



## Extension contracts



`createGateway(config, plugins)` accepts independent `authenticator`, `authorizer`, `router`, `approvalGate`, `transportFactory`, `credentials`, `limiter`, and `audit` implementations. `createRuntime` additionally accepts a `ConfigStore` and per-configuration plugin factory. Plugins are trusted application code, not arbitrary scripts uploaded through the console. See [architecture](docs/architecture.md).



## Verification



```sh

npm run check

npm test

npx playwright install chromium

npm run test:browser

```



For disposable PostgreSQL/OpenFGA tests:



```sh

docker compose -f deploy/compose.test.yaml up -d --wait postgres

docker compose -f deploy/compose.test.yaml up -d openfga opa

node scripts/wait-services.js

```



Set `TEST_DATABASE_URL=postgresql://gateway_test:disposable-integration-only@127.0.0.1:55432/gateway_test`, `TEST_FGA_URL=http://127.0.0.1:58080`, and `TEST_OPA_URL=http://127.0.0.1:58181/v1/data/mcp/authz/allow`, then run `npm run test:services`. These tests reset gateway tables: **use the dedicated test database only**. Stop the stack with `docker compose -f deploy/compose.test.yaml down`.



CI runs the core, browser, and service suites and builds the container when this directory is the repository root. It does not deploy to a cloud.



## Local containers and cloud deployments



Set a URL-safe random `POSTGRES_PASSWORD` in `.env`, then run `docker compose up --build`. The supplied Compose stack runs the gateway and persistent PostgreSQL, with only the gateway published to loopback. Configuration is shared when you scale gateway containers behind a load balancer; replace the fixed host port mapping for that topology.



`deploy/kubernetes.yaml` provides two replicas, resource limits, readiness/liveness probes, a service, HPA, and disruption budget. Replace the image and public hostname; create `relay-gateway-secrets` containing `DATABASE_URL`, `GATEWAY_ADMIN_KEY`, and referenced service/upstream credentials. Use a managed PostgreSQL service and managed secret injection for cloud environments. Add TLS ingress, network policy, backups, log retention, migrations, and your release/rollback process before production. The templates are portable deployment inputs, not verified cloud deployments.



## Current operational limits



Concurrency and token-bucket quotas are shared in PostgreSQL mode and local in SQLite mode. PostgreSQL circuit-breaker state is shared across replicas with a leased half-open probe; SQLite circuit state is local. Concurrency leases expire after crashed replicas; requests are capped below lease duration. Pooled upstream connections, administrator SSO, long-term/spend quotas and production audit retention remain open. The runtime persists metadata-only admission events before forwarding work; admission-store failures reject work. Completion events are best effort, so a started event without a completion requires investigation. Configuration changes and their audit events commit in one transaction. Database append-only/tamper-resistant enforcement remains deployment work. Authenticated per-process Prometheus metrics are available at `/admin/api/metrics`. Active requests retain the configuration snapshot under which they began.



The console contains server definitions, not live upstream health or availability measurements. Passing the supplied tests is evidence for their scenarios, not proof of zero bugs or universal MCP conformance.





## Features added in 0.3



- Tenant-scoped upstream discovery and execution, including custom-router destination checks. JWT subjects map within the verified `tenant_id` claim; administrators remain globally privileged.

- Modern multi-round-trip callbacks for elicitation, sampling and roots. Enable `features.callbacks`, configure each identity's `callbackMethods`, and set the same random `GATEWAY_STATE_KEY` (at least 32 characters) on every replica. Clients must declare matching capabilities. Encrypted continuation state expires after ten minutes, binds the caller, tenant, route and arguments, and is reauthorized each round. It is not an exactly-once replay ledger. Legacy push callbacks are not bridged.

- MCP Tasks V2 is opt-in with `features.tasks`. It follows the [official Tasks extension](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html): clients declare the extension on a per-request basis, and the gateway may return a task handle for `tools/call`. The gateway replaces upstream IDs with random opaque IDs, stores a hash of each public ID and encrypts the upstream task ID, route, caller-bound data and original arguments. It reauthenticates and rechecks role, tenant, route, argument policy and tool contract on every `tasks/get`, `tasks/update` and `tasks/cancel`; it also enforces the required `Mcp-Name` header mapping. Set the same `GATEWAY_STATE_KEY` on every replica. Use PostgreSQL for horizontally shared task state; SQLite supports local single-instance deployment. Task state expires after at most 24 hours. The pinned base SDK does not yet decode V2 `resultType: "task"`, so compatible clients and upstream servers need the official Tasks extension's raw-dispatch path. Status notifications and task listing are not implemented.

- Resource templates, completion and embedded resource-link namespacing when prompts/resources are enabled.

- Opt-in modern notification streams (`features.notifications`), including legacy upstream event adapters. Streams close on configuration changes and have a bounded lifetime; clients must reconnect. They are not durable event logs.

- Upstream OAuth client credentials or RFC 8693 exchange. Configure `oauth.mode`, `tokenEndpoint`, `clientIdEnv`, `clientSecretEnv`, and optional `scope`/`audience`. Client authentication defaults to `client_secret_basic`; set `clientAuthMethod: "client_secret_post"` only for a token service that requires body credentials. Exchange requires a verified JWT principal; inbound credentials are never forwarded directly. Interactive upstream authorization/refresh flows are not implemented.

- Stdio upstreams with explicit `command`, `args` and secret `envRefs`. The deployment must approve the absolute executable in semicolon-separated `STDIO_ALLOWED_COMMANDS`. Set `url` to `stdio://server-id`; workers run per operation. Stdio executes trusted administrator-selected programs and is not a sandbox. The UI supports transport, executable, arguments and tenant fields; OAuth and advanced policy settings use the configuration editor.



See [local deployment verification](docs/local-deployment.md) for container and Kubernetes steps and [validation](docs/validation.md) for checks actually executed.





## Traffic controls added in 0.4



The **Traffic controls** screen configures default burst capacity, refill rate and circuit recovery. Publish the draft to apply changes. Individual identities can override `rateLimit` to represent service plans. Exact public-tool budgets are configured under `traffic.toolRateLimits`:



```json

{

  "traffic": {

    "rateLimit": { "capacity": 20, "refillPerSecond": 5 },

    "toolRateLimits": { "alpha__echo": { "capacity": 3, "refillPerSecond": 1 } },

    "circuitBreaker": { "failureThreshold": 5, "resetAfterMs": 10000 }

  }

}

```



All authenticated MCP HTTP requests consume the identity bucket, including discovery, continuations and legacy handshakes. Matching tool calls also reserve their exact public-tool bucket. Reservations are not refunded after validation, permission, concurrency or upstream failure; a rejected tool budget can therefore still consume the identity budget. Separate bucket reservations are atomic individually, not jointly. Aliases have distinct tool buckets, so use identity budgets to prevent alias-based aggregate overload.



PostgreSQL mode automatically uses shared concurrency leases and atomic token buckets. An unrelated revision change does not reset budgets; changing the rate policy creates a new bucket. Local buckets and circuit registries fail closed at bounded capacity. Historical PostgreSQL buckets need operator-managed retention; do not delete recently active/exhausted buckets, as doing so replenishes quota.



Exhaustion returns HTTP 429 with conservative Retry-After; rate-store/audit errors return 503. Circuit state is shared in PostgreSQL mode and process-local with SQLite. Ordinary thrown failures count; caller cancellation, argument errors and ProtocolError do not. Successful MCP `isError` responses are application errors and do not trip outage circuits. Subscriptions bypass breakers. Open circuits fail the selected route fast, without automatically retrying or moving side effects to another target. A PostgreSQL transaction admits only one half-open probe across replicas; generation checks ignore stale completions. The local SQLite circuit resets on process restart.



See the [sourced competitive review](docs/competitive-review.md) for comparison with Gravitee, KrakenD and Microsoft MCP Gateway, acceptance criteria and the prioritized remaining work. This release does not establish feature parity or comparative performance superiority.



## Governance and tracing added in 0.5

**Configuration history:** built-in stores retain full configuration documents for each published revision. Existing installations start from their current revision; earlier history cannot be reconstructed. The History screen reviews a saved document before publishing it as a new revision. `GET /admin/api/history`, `GET /admin/api/history/:revision`, and `POST /admin/api/rollback` use the same administrator boundary as configuration editing. Rollback requires `If-Match` and revalidates historical settings against current deployment credentials and restrictions. Configuration, history and audit commit together. The rollback event identifies source and resulting revisions. History stores secret references, not resolved credentials. History retention and a separate second-admin approval workflow for configuration publication are still pending; the tool approval gate described above governs selected runtime actions.

**Tool definition review:** the Tool explorer uses a separate service key to call the actual MCP endpoint. It shows only that identity's permitted tools, can invoke a selected tool with explicit arguments, and can add a reviewed fingerprint to the administrator's draft. Add the console's exact origin to `allowedOrigins` to use browser MCP calls. Service keys are cleared from the field after discovery, held in page memory and discarded when leaving the view. Refresh loses both login contexts; browser storage is not used.

Configure `toolContracts` as a map of public tool name to lowercase SHA-256 fingerprint. Discovery exposes each computed value in `_meta["com.example.relay/contractFingerprint"]`. The canonical fingerprint includes the published definition except its routed name, including descriptions, schemas, annotations and metadata. Pinned mismatches are omitted and audited as `gateway/contract_drift`; direct calls recheck the current advertised definition and are rejected before invocation. A pinned alias can use only targets with that same reviewed definition. Fingerprints are intentionally conservative: semantically equivalent schemas with different encodings can differ. Pinning does not prove backend behavior or eliminate the upstream's ability to change implementation between definition retrieval and execution. Unpinned tools remain mutable.

**Distributed traces:** set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to an HTTPS OTLP/HTTP endpoint. Optional `OTEL_SERVICE_NAME` and `OTEL_TRACES_SAMPLE_RATIO` (0–1, default 0.1) control service naming and root sampling. `OTEL_ALLOW_LOCAL_HTTP=true` allows a loopback-only collector for local tests. Traces link authenticated MCP request and upstream operations, propagate traceparent, record final MCP outcomes including tool errors, and exclude arguments, results, credentials, user identities and incoming baggage. Unknown methods have a bounded `other` label. Export queues/timeouts are bounded; telemetry failure does not replace durable audit admission. Authentication, origin, quota and concurrency rejections before request dispatch do not currently create request spans. There is no built-in trace viewer, multi-signal OTel metrics export, or collector-vendor certification. The executable flushes tracing on graceful shutdown.
