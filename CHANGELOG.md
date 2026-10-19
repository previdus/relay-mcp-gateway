# Unreleased

Added the AWS launch package: a public echo-only demo container, CloudFormation infrastructure for App Runner and a private S3/CloudFront site, a GitHub OIDC deployment role and workflow, and a monthly budget warning. Added a deployment guide that explains the cost alert's limits and the single-instance demo's state boundary. Expanded the project website with a cited feature comparison for Microsoft MCP Gateway, Gravitee APIM, and KrakenD MCP Server.

The admin console now introduces upstreams, identities, routes, and advanced settings with a plain-language purpose, request-flow context, grouped fields, and safe examples. The complete JSON editor remains available under an Advanced disclosure, while configuration is also explained as a six-step agent request flow. Added a responsive Relay project website, a self-contained static build and local preview command, website link checks, open-source contribution and security guidance, and an MIT license. Package metadata is now publishable rather than marked private.

Upstream OAuth token requests now authenticate with form-encoded HTTP Basic by default, keeping client secrets out of the grant body. Providers that require body credentials can opt into `client_secret_post`.

Added authenticated cursor pagination for audit-history retrieval, with bounded page sizes and ascending keyset traversal. The latest-100 endpoint remains compatible. Retention, tamper-evident storage and SIEM forwarding remain deployment responsibilities.

Runtime now composes trusted injected audit sinks with its local durable store. A failing sink blocks pre-operation audit admission; post-effect delivery still requires an external durable exporter or outbox.

Added an issuer-wide JWT emergency stop to the Identity security screen. Operators can disable any deployment-pinned issuer across replicas and explicitly re-enable it after response; all validly signed tokens from a disabled issuer fail authentication regardless of key rotation. The state and metadata-only audit event are committed atomically in SQLite/PostgreSQL. The single registry query also checks issuer status alongside individual jti revocation. Added local persistence, issuer isolation, API authorization/audit and rollback tests plus a cross-pool PostgreSQL integration case. Targeted key-thumbprint revocation and JWKS cache invalidation remain open.

Added opt-in emergency JWT revocation for locally verified JWTs. Every authentication checks the signed issuer and `jti` against hashed expiry records in SQLite or shared PostgreSQL; missing IDs and store failures deny access. The Identity security screen and authenticated admin API accept only configured issuers and bounded expiry windows, and audit revocation events without storing the token ID or bearer token. Added issuer-isolation, fail-closed, expiry, API authorization and redaction tests, plus a two-pool PostgreSQL integration test. Browser and PostgreSQL service execution remain dependent on their local runtimes.

Added multi-issuer JWT authentication for enterprises that federate agents from separate identity providers. Operators can pin 2–16 issuer/audience/JWKS profiles with independent token type, scope and age requirements. The unverified issuer claim selects only from the static map; signature, exact issuer and audience are validated by the selected profile, and every gateway identity must bind its exact `oauthIssuer`. Unknown claims never control key discovery. Protected-resource metadata advertises every trusted authorization server. Added same-subject cross-issuer, wrong-audience, cross-key, unknown-issuer, profile-validation and metadata tests, plus the console field for issuer identity binding.

Added optional OAuth DPoP enforcement for JWT and opaque introspection modes. The resource server validates the RFC 9449 proof signature and public JWK thumbprint against the token's `cnf.jkt`, plus method, client-visible HTTPS target, access-token hash, age and one-use `jti`; Bearer downgrade and duplicate proof headers are denied. Replay state uses a bounded in-memory store for a single local process or an atomic PostgreSQL store for replicas, and authentication fails closed when replay storage is unavailable. Deployment settings require an explicit HTTPS public origin. Optional nonce challenges return a signed `DPoP-Nonce` and require clients to retry with a matching proof; replicas share the nonce HMAC key through deployment secret management. In nonce mode freshness follows the server-issued timestamp rather than client clock. Added signed-proof, negative, replay, HTTP challenge, introspection, nonce-retry and mode-configuration tests, plus a cross-pool PostgreSQL integration test. This does not implement RFC 8705 certificate-bound OAuth tokens or issue OAuth credentials.

Added an optional external human-approval gate for selected tool calls. It sends a review request bound to the authenticated client/tenant, exact arguments, resolved route, configuration revision, and pinned tool contract; the initial response can only create a pending approval, while an exact one-use consume decision is required before upstream execution. The core enforces that two-phase contract even for custom approval plugins, returns pending permit handles in JSON-RPC `error.data`, and records metadata-only requested/consumed lifecycle events without permit IDs or arguments. With required audit enabled, failures to record either approval lifecycle event stop the handoff before upstream execution; a consumed permit may need replacement if that audit write fails. The adapter fails closed and uses a separately bound service credential. The external service owns reviewer authentication, durable workflow state, expiry, and atomic permit consumption; it receives full tool arguments, and the gateway does not promise exactly-once execution. Added real MCP/HTTP integration tests proving no pre-approval side effect, exact permit use, replay/change rejection, required-audit failure behavior, and strict adapter response behavior.

Added certificate-only mTLS agent authentication for deployments that terminate TLS in the gateway. Peer certificates must chain to the configured client CA and match an administrator-pinned SHA-256 thumbprint; bearer authorization and forwarded-certificate headers cannot substitute for the TLS peer. The admin console can configure the thumbprint mapping, while TLS key material remains deployment-mounted. RFC 8705 OAuth certificate-bound tokens and ingress TLS offload are not implemented. Real HTTPS tests exercise both denial and acceptance paths.

PostgreSQL-backed runtimes now share upstream circuit-breaker state across replicas. A database-time half-open lease admits one recovery probe, generation guards prevent stale in-flight completions from closing a newly opened circuit, and the runtime selects the shared implementation by default when using PostgreSQL. SQLite retains its in-process breaker. Real service integration tests use independent PostgreSQL pools and two gateway runtimes to verify cross-replica opening, recovery-probe exclusion, success recovery, stale-completion handling, and default wiring. No automatic tool-effect retries or cross-target failover were added.

Added core authorization binding for custom routes: physical public names must resolve to that same upstream/tool, while aliases must use an enabled, selector-eligible target from the administrator-configured pool. This closes a same-tenant cross-upstream substitution path in trusted routing plugins while preserving dynamic selection within approved alias pools. Added an optional out-of-process route decision adapter that receives a minimized identity and approved candidate pool; the gateway independently validates the chosen target and fails closed. Sealed callback continuations reuse their prior authorized target without depending on another remote decision. Strict credential bindings can pin the route service token to its endpoint. Added an optional out-of-process tool inspector for pre-call and post-call allow/deny decisions, with a required deployment-owned tool allowlist. It sends full tool arguments/results only for selected calls, applies request/response and deadline bounds, pins its service credential to the destination, and fails closed. Its identity payload now defaults to client and tenant identifiers; subject, roles and auth scheme require explicit deployment opt-in. It does not redact or reverse completed actions. Added integration coverage for route and inspector isolation, target filtering, DNS-pinned egress, continuation behavior, denial paths, payload transfer, identity minimization, tool scoping, and deployment bindings. Added an opt-in, bounded protocol-discovery verdict cache for homogeneous upstream deployments, scoped by principal, callback capabilities, configuration revision, endpoint, and a digest of outbound credentials. Custom transports and SSE bypass the cache. The cache is configurable in the admin console and defaults off. Local comparison improved throughput by about 3×, but the 60-second run still shows elevated p95 latency and RSS growth; production performance qualification remains open. See [performance validation](docs/performance-validation.md), [plugin contract](docs/plugin-api.md), and [workspace validation](docs/validation-unreleased.md).

# 0.12.0 — 17 October 2026 — DNS-pinned strict upstream egress

Added connection-time validation and pinning for every A/AAAA upstream DNS answer in strict egress mode. Link-local metadata and special-use addresses are denied; internal RFC1918, ULA, and loopback ranges require narrow canonical deployment allowlists. DNS resolution is bounded and fails closed. Strict credential destination binding enables this guard; deployments can also enable it independently. Added deterministic DNS pinning, mixed-answer, metadata, CIDR, and timeout tests.

Migrated the production demo upstream to the split official SDK v2 packages. Kept SDK v1 as a development-only dependency for compatibility tests covering 2025 MCP clients and legacy SSE.

# 0.11.0 — 17 October 2026 — external policy decision adapter

Added a bounded Open Policy Agent Data API authorizer. OPA decisions compose with local grants, roles and OpenFGA using all-of semantics. Requests contain only allowlisted identity attributes, action and resource name; literal `result: true` is the only granting response. Errors, redirects, invalid responses, oversized bodies and timeouts deny. Strict destination mode pins both the OPA decision URL and bearer token reference.

The adapter has local HTTP fixture coverage, not a real OPA cluster test or production latency benchmark. OPA management, bundle distribution, cloud vault integration, and Kubernetes promotion remain separate operator/release gates.

# 0.10.0 — 17 October 2026 — enterprise destination-security checkpoint

Added deployment-owned exact credential-to-destination bindings, strict enforcement for HTTP upstreams and telemetry endpoints, explicit SSE request-path pins, and stdio secret bindings tied to the approved executable. OAuth secrets are separately pinned to issuer and recipient. Service credentials are removed before routing, authorization, and inspection plugins. Redirects and unsafe request headers remain blocked by the egress layer.

Added enterprise threat/deployment guidance and a 21-point review ledger. These reviews are scoped evidence, not proof of a complete product: native cloud vault adapters, network-layer DNS/IP enforcement, untrusted plugin sandboxing, production load/soak tests, and independent security certification remain open. Full literature-program counts remain 25/200 articles and 5/40 component cycles.

# 0.9.0 — 17 October 2026 — continued hardening checkpoint

Bounded remote JWKS downloads to 64 KiB and 64 keys while retaining jose cache and unknown-key cooldown behavior. Added explicit OAuth-only subjects without dummy API keys, including console support. API-key authentication cannot match these identities.

Fixed concurrent expired OAuth token cache entries triggering duplicate exchanges. Token responses now require bounded UTF-8 JSON, safe bearer syntax, configured scope coverage when scope is returned, and an access-token issued_token_type for RFC 8693 exchanges. This deliberately rejects previously accepted nonconforming exchange responses.

Added enabled:false per built-in route target, UI controls and continuation selector rechecks. Direct tool grants are independent; this is alias selection control, not backend shutdown or automated failover.

Reviewed 23 more primary articles/chapters and completed five evidence/decision/test cycles. Cumulative article count is 25/200; cycle count 5/40. Remaining programme is not declared complete. See docs/continued-hardening.md for limits and migration.

# 0.8.0 — 17 October 2026 — component-hardening checkpoint

Added an exclusive opaque-token introspection mode with strict resource/identity/lifetime checks, fresh revocation decisions and bounded security-service responses. JWT mode gains optional type/age and OAuth client binding; bearer paths reject proof-bound tokens and duplicate/oversized/malformed headers. Partial/mixed authentication configuration fails instead of falling back to keys. OpenFGA adds explicit tuple-v2 namespaces with migration guidance and response bounds; role lookup ignores inherited properties.

Added explicit argument deny rules overriding allows, trusted tenant/role route selectors, deterministic priority routing, and per-upstream connection/total deadlines that include credential acquisition. UI edits verified subject/client bindings, selectors, priorities and budgets. Automatic effect retries remain disabled.

Targeted body-section inspection covers ten papers per component and selected primary documentation for ten commercial offerings. The 200-article / forty-full-cycle research programme remains incomplete, explicitly recorded in the source ledger. No exhaustive protocol, identity-provider or competitor parity claim. New fields require v0.8 replicas; restore compatible configuration/deployment settings before an older-image rollback.

# 0.7.0 — 17 October 2026

Re-audited the original literature, reviewed 50 additional distinct papers in five rounds, and compared ten gateway projects/products using primary sources. Findings, limitations, decisions and a pre-implementation plan accompany the release.

Fixed physical contract pins being bypassable through independently unpinned aliases. Added bounded aggregate catalog collection and page-level upstream reads, stateless caller/catalog/revision-bound pagination, an optional authenticated literal search API and console controls, a versioned typed plugin facade and fail-closed pre-call/result inspectors, weighted rendezvous routing, and tenant-eligible target filtering for all routing strategies. Added strict schema-derived parameter-header validation, encoding, forwarding and HTTP 400/-32020 mismatch handling without automatic effect retry.

Tests caught SDK auto-pagination bypassing collection-time checks and low-level header errors returning HTTP 200; both paths were corrected. These additions do not supply untrusted plugin isolation, semantic ranking, delegated human approval, interactive consent, workload lifecycle or universal MCP conformance. New configuration fields and routing strategy require v0.7 serving replicas; rollback requires an explicitly reviewed compatible document.

# 0.6.0 — 17 October 2026

Added deterministic invocation policies with exact scalar/membership/range/authenticated-identity constraints; all-of enforcement for public aliases and resolved physical tools before upstream connection; modern continuation and legacy ingress coverage; optional mandatory metadata pins and unsafe display-control rejection at discovery/call; a validated Action safeguards console; real-state adversarial fixtures and PostgreSQL cross-replica policy tests.

Reviewed 20 engineering articles and 10 research papers, with source-specific findings, limitations and a plan recorded before implementation. Research benchmark scores are not gateway test results. No executable policies, automatic side-effect retries or unisolated code runtime were introduced. New fields require v0.6 serving replicas; see the plan for staged deployment and rollback compatibility.

# 0.5.0 — 17 October 2026

Added transactionally stored configuration history with reviewed, conditional and audited rollback; definition fingerprints that block pinned tool metadata/schema drift at discovery and invocation; a service-identity browser tool explorer and draft pinning; OpenTelemetry request/upstream spans and OTLP/HTTP export with payload exclusions; a repeatable isolated Kubernetes acceptance suite; serialized database initialization; and idle database-connection error handling. Existing configurations remain compatible and optional controls remain opt-in.

The browser suite caught a missing MCP name header in the new explorer; it was fixed before release. Deployment testing caught a seed-order race in the test harness; the complete fixture configuration now mounts before any gateway pod starts. A supported Kubernetes 1.34 node image was required on this host after the default 1.37 control plane failed to bootstrap.

# 0.4.0 — 17 October 2026



Added shared PostgreSQL token-bucket admission, per-client plan overrides, exact public-tool rate budgets, conservative Retry-After, fail-closed quota-store handling, replaceable rate/circuit interfaces, per-replica upstream circuit breakers with one recovery probe and stale-completion protection, and a tested Traffic controls console page. Database-backed runtimes now select shared concurrency by default even when constructed outside the executable entry point. No automatic retries or side-effect failover were added.



Reviewed Gravitee, KrakenD and Microsoft MCP Gateway using official documentation. The sourced 40-area matrix separates documented features, edition ambiguity, unverified compatibility, our implementation and the prioritized backlog. No blanket superiority claim is made.



# 0.3.0 — 16 October 2026



Added tenant-scoped discovery/execution; modern callback continuation relay across replicas; resource templates/completion and embedded-link rewriting; notification feeds with revision-based closure; stdio upstreams with explicit environment and deployment executable approval; OAuth client credentials and delegated token exchange; bounded schema validation workers; durable audit admission and transactional configuration/audit commits; protected per-process metrics; console tenant/stdio controls; local deployment verification instructions.



Validation: 37 regression tests, one Chromium acceptance test, and three real PostgreSQL/OpenFGA integration tests passed, with no failures or skips. Strict TypeScript and deployment YAML checks passed. Real-service tests include independent database pools, transaction failure injection, group-relation revocation, two HTTP gateway replicas and concurrent calls.



Not production complete. See docs/coverage.md for remaining features, docs/validation.md for evidence, and docs/local-deployment.md for container/Kubernetes steps. Docker engine was unavailable and kubectl had no selected context; no live container or cluster deployment is claimed. Autonomous delivery controller, task extensions, legacy callback bridging, tenant administration, production SSO/retention/tracing, extended load/chaos testing and exhaustive conformance remain open. No zero-bug or novelty guarantee is made.

