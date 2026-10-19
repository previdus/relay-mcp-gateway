# Coverage and release readiness

The v0.10 [enterprise destination-security checkpoint](enterprise-security.md) adds deployment-owned exact credential/destination bindings, strict endpoint enforcement, explicit SSE path pins, and executable-bound stdio secret references. Its [21-point evidence ledger](enterprise-iteration-plan.md) records what was reviewed and what remains open. The v0.9 [continued hardening checkpoint](continued-hardening.md) adds bounded JWKS retrieval, keyless OAuth identities, safe concurrent token-cache refresh, strict exchange response checks, and per-target alias availability. Current literature progress remains [25 articles/chapters and five cycles](continued-component-research.md); the requested 200-article / 40-cycle programme is unfinished.

The v0.11 [OPA adapter](opa-policy.md) adds a bounded and fail-closed external policy decision point, composed with local grants, roles, and OpenFGA. It sends identity attributes and resource names only, not credentials or tool arguments. This is a protocol-fixture-tested adapter, not a real OPA cluster or performance certification.

The v0.12 strict egress path validates all DNS answers and pins the validated result into outbound connections, with explicit private CIDR allowances and a bounded DNS timeout. Strict credential-binding mode enables it automatically. It guards upstream MCP, PostgreSQL, OAuth token exchange/introspection, JWKS refresh, OPA/OpenFGA, configured remote extensions, and the built-in OTLP HTTP trace exporter. Strict PostgreSQL mode also requires verified TLS (`sslmode=verify-full`) and exact credential-binding mode pins `DATABASE_URL` to a deployment-owned database endpoint. Direct library use and compatibility deployments remain unchanged unless strict egress or strict credential bindings are enabled. Arbitrary plugin-owned connections still need network-level egress policy. See [enterprise security](enterprise-security.md) for boundaries. Release evidence is in [validation-v0.12.md](validation-v0.12.md).

The current workspace adds an opt-in, per-upstream, short-lived MCP v2 discovery verdict cache to skip repeated protocol probes, PostgreSQL-shared circuit-breaker state, and an optional external human-approval gate for selected tools. The cache is off by default, isolated by principal/callback capabilities/outbound-credential digest, and bypassed for custom transports and SSE. Local measurements improved by roughly 3×, but the short soak still shows elevated latency and RSS growth; see [performance validation](performance-validation.md) and the [unreleased validation record](validation-unreleased.md). The approval adapter requires a deployment-owned service; its durable reviewer workflow is not implemented by the gateway. This is not production performance qualification and the current workspace has not been rebuilt into a release image.

The v0.8 [component hardening checkpoint](component-hardening.md) adds opaque OAuth introspection, optional verified OAuth client binding, JWT type/age profiles, bounded OpenFGA decisions and tuple-v2 namespaces, explicit argument denies, priority/role/tenant routing and cumulative upstream/connection budgets. The current workspace adds opt-in DPoP-bound OAuth verification with PostgreSQL-shared replay protection; RFC 8705 OAuth certificate binding remains open. The [research ledger](component-research.md) explicitly separates targeted paper inspection from the still-pending 200-article / forty-cycle programme.



This is a feature inventory, not an official conformance certification. MCP includes optional role-specific capabilities and extensions; "100% of every feature" is not a single interoperable product target. Required behavior must be tested for each advertised role, version, and transport.



| Area | Implementation | Verification / remaining work |

|---|---|---|

| Pluggable tool inspections | Versioned type facade; veto-only before-call and result pipeline, immutable credential-free snapshots, cumulative timeout; optional out-of-process inspector defaults to metadata-only, with explicit full-payload opt-in | Real effect, failure, timeout, concurrency, continuation and remote transfer tests; in-process inspectors remain trusted and full mode can expose secrets in tool data |

| Human approval | Optional fail-closed external two-phase gate for selected public/physical tools; exact caller/tenant, args digest, route, configuration revision and tool-contract binding; core-enforced one-use consume phase immediately before execution; metadata-only lifecycle audit | Six core tests and browser configuration test; gateway forwards no permit upstream and rejects custom-plugin initial allow. Human reviewer UI/authentication, durable approval records, expiry/revocation and atomic consumption are responsibilities of the external service and were not integration-tested against a production implementation |

| Bounded discovery/search | Aggregate candidate/scan/byte/deadline/concurrency controls; standard stateless pagination; optional literal HTTP search | Identity/revision/metadata cursor rejection, authorized search, browser and PostgreSQL replica tests; not semantic retrieval |

| MCP cacheable result hints | SDK emits `resultType: complete`, `ttlMs: 0`, and `cacheScope: private` for modern cacheable results by default; legacy wire responses omit modern fields | Raw HTTP test verifies modern `tools/list` hints and legacy omission; gateway-facing positive TTL remains unset because permission and configuration changes require fresh lists. Upstream positive hints can bound the gateway's internal secondary-contract cache |

| Stable pool routing | Weighted rendezvous plus tenant-eligible selection in all strategies | Ordering, membership changes and weight-distribution tests; not persistent backend sessions or effect failover |

| MCP parameter headers | Strict supported annotations, bounded UTF-8 sentinel encoding, body comparison and forwarding | Actual SDK calls and HTTP 400/-32020 mismatch test; single primitive types only, no nullable union annotation support |

| Argument permissions | Bounded scalar, membership, number and authenticated-identity checks; alias + physical policy intersection | Modern, legacy, continuation, upstream-state and PostgreSQL replica tests; workflow data provenance is not implemented |

| Catalog enrollment/display safety | Optional mandatory pinning and control-character rejection; discovery and direct calls | Unpinned/drift/hidden-control rejection and multilingual utility tests; no natural-language injection or executable provenance guarantee |

| Modern MCP 2026-07-28 | Official SDK v2 handler, explicit modern negotiation upstream | Real SDK client/server tests, header mismatch and unsupported-version errors |

| Protocol discovery cache | Explicit per-upstream TTL; bounded, in-process, auth-context scoped; automatic fresh negotiation after cached-era mismatch | Cache isolation/expiry/size and custom transport bypass tests; opt in only for homogeneous upstream protocol deployments; mixed-version rolling updates and multi-replica soak remain unverified |

| Legacy Streamable HTTP | Stateless SDK fallback | v1 clients/upstreams integration tests |

| HTTP+SSE upstream | Transport adapter | Modern-to-legacy-SSE integration and separate-credential assertion |

| Custom transports | Trusted transport factory interface | Stdio process-per-operation adapter; executable allowlist and explicit environment test |

| Tool discovery/calls | Namespace aggregation, permissions, input schema validation, no side-effect retries | End-to-end modern/legacy, invalid inputs, denial, timeout, failure tests; aliases additionally compare target contracts during discovery and before execution |

| Prompt list/get | Opt-in aggregation with distinct permissions | Modern SDK end-to-end test |

| Resource list/read | Opt-in aggregation, URI namespace, distinct permissions | Modern SDK end-to-end test |

| Resource templates/completion | Namespaced templates, expansion, completion | Real modern SDK template/read/completion test |

| MRTR, elicitation, sampling, roots | Modern relay, encrypted caller/route-bound state bound to client, tenant and authenticated subject attributes, per-method permissions | Cross-replica elicitation, cross-subject denial, and state-tamper tests; sampling/roots payload variants and legacy push bridging need more coverage |

| Notifications/subscriptions | Modern streams, upstream event adapters, revision-based closure | Tools-change relay/revocation test; resource-update and legacy event variants need broader integration coverage |

| Extension tasks | Opt-in Tasks V2 for `tools/call`, opaque IDs, authenticated encrypted ownership/route state, `tasks/get`, `tasks/update`, `tasks/cancel`, `Mcp-Name` mapping, shared PostgreSQL storage and atomic task-state compare-and-set | Real MCP integration tests cover cross-replica lookup, ID rewriting, encrypted state, all task operations, caller isolation, conflicting headers, duplicate/concurrent input responses, conflicting in-flight response bodies, ignored unknown keys and recovery after an ambiguous upstream failure. SQLite persistence and stale-write denial pass; PostgreSQL tests cover cross-pool lookup, CAS/expiry, and a two-gateway ambiguous-acknowledgement recovery: replica A submits the response and loses the acknowledgement, the shared encrypted lease expires, replica B retries the identical response, and replica A observes completion. The published `@modelcontextprotocol/ext-tasks` V2 requester adapter now completes a real tool task through the gateway and verifies opaque `Mcp-Name` rewriting and V2 completion result decoding. Input responses use a 3-minute durable claim lease; compliant peers must ignore already-satisfied keys. Notification streams, task listing, load/retention soak and interoperability with an independently implemented V2 server remain open. V2 uses an isolated raw-dispatch adapter because the pinned base SDK rejects `resultType: "task"`; compatible peers must use the official extension V2 path. See the [official Tasks specification](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html) and [extension adapter guide](https://modelcontextprotocol.github.io/ext-tasks/typescript/adapters-and-schemas.html) |

| Service keys | Constant-time digest comparison; separate administration key | Missing credentials, key boundary tests |

| OAuth resource / JWT / DPoP | Protected-resource metadata advertises all configured issuers; 2–16 pinned JWT issuer/audience/JWKS profiles with issuer-bound subject mappings; optional RFC 9449 proof binding and nonce challenges; opt-in issuer+jti revocation and issuer-wide emergency stop stored in SQLite or shared PostgreSQL | Signed cross-issuer/audience/subject isolation, local token and issuer revocation, authenticated admin actions, hashing and atomic audit tests; PostgreSQL multi-pool revocation, issuer-stop and DPoP replay checks pass. Real provider login/consent, targeted key-thumbprint/JWKS cache invalidation and RFC 8705 OAuth certificate binding remain unverified/unsupported |

| Native mTLS | Gateway-terminated TLS, CA-verified peer certificate and exact DER SHA-256 identity pinning for MCP/catalog; no bearer or proxy-header fallback | Real HTTPS tests cover acceptance, missing peer, spoofed header, mixed credentials, thumbprint validation and configuration; OAuth certificate-bound tokens and ingress TLS offload are not supported |

| Role authorization | Optional additional role restriction | Policy composition test |

| Runtime security-plugin composition | Injected authorizers compose with deployment grants; strict environment egress and state keys remain authoritative; conflicting application authenticators or approval gates fail readiness instead of replacing deployment controls | Real MCP regressions prove OPA/client-grant denial, zero contact with an endpoint denied by deployment egress, and fail-closed readiness for authenticator/approval conflicts; direct `createGateway` remains a lower-level explicit policy-selection API |

| Relationship authorization | OpenFGA pinned store/model, higher consistency, fail closed | HTTP adapter test and dedicated real-service suite |

| Routing | Namespace, public alias, weighted, per-identity sticky, client segmentation, optional out-of-process selector constrained to administrator-approved targets, non-executing policy simulator | MCP regressions cover same-tenant substitution denial, configured-pool selection, disabled-target denial and selector enforcement; alias discovery and invocation compare complete contracts; secondary checks use only positive upstream TTL hints, are caller/revision scoped, capped at 5 seconds by default, and can be disabled with `discovery.routeContractCacheMaxTtlMs: 0`; a paired local two-target smoke improved from 61.64 to 88.19 calls/s with p95 80 to 61 ms, but representative pool-size load and isolation of non-routing plugin types remain open |

| Rate controls | Token buckets per identity/plan and public tool; PostgreSQL shared reservations; local buckets reclaim only after full refill so repeated policy revisions do not accumulate stale state | Burst/refill tests, actual MCP 429, backend failure, independent pools and cross-replica calls; monthly/spend quotas pending |

| Circuit breakers | SQLite-local or PostgreSQL-shared consecutive-failure state with a single recovery probe and stale-response guards | State-machine tests and real two-pool PostgreSQL replica integration; distributed health-aware failover remains pending |

| Persistence | SQLite local; PostgreSQL shared state | SQLite restart/CAS tests; dedicated PostgreSQL suite |

| Horizontal configuration | Per-request shared revision, conditional writes | Two app instances sharing a store test; dedicated PostgreSQL atomicity test |

| Concurrency | Local slots or PostgreSQL leased slots | Local integration test; dedicated multi-pool PostgreSQL race test |

| Administration console | Server/client/route draft editing, traffic controls, selected-tool approval policy, service-identity explorer, reviewed history/rollback, JSON editor, revision publish, audit view | Real Chromium workflows include approval-policy publish/reload; approval endpoint/token stay deployment-owned; mobile overflow test |

| Host/origin and request limits | Host allowlist, exact origins, body limits, request deadline | Origin/malformed-body tests; broader penetration testing pending |

| Destinations / SSRF | HTTPS by default, explicit local exception, same-origin request paths, no redirects, response byte cap, deployment-owned exact credential bindings, optional DNS answer validation and connection pinning for MCP upstreams, security services, PostgreSQL and OTLP traces; strict PostgreSQL also requires verified TLS | Integration tests verify all-answer rejection, connect-time IP pinning, TLS-before-auth behavior, CA and hostname verification, timeouts, and no credential-bearing connection after a forbidden DNS result. Arbitrary plugin egress needs network policy; production egress proxy and firewall behavior remain deployment-specific |

| Audit | Shared metadata-only database events, latest-100 query | Redaction and persistence tests; fail-closed admission and atomic config/audit commits tested; retention and immutability remain open |

| Containers / Kubernetes | Non-root image, Compose, two-replica/HPA/PDB template; zero-unavailable rollout, startup probe, `RuntimeDefault` seccomp, disabled service-account token, best-effort node/zone spreading, read-only filesystem | Current-source image smoke passed. The two-replica manifest passed isolated kind acceptance, including shared state, pod replacement, database outage fail-closed/recovery and prior-image rollback/promotion. Docker Desktop's local two-node kind cluster is also running with both nodes Ready. Cloud/multi-node failure-domain behavior remains unverified |

| Operations | Liveness/readiness, two-minute HTTP drain followed by bounded force-close, fail-closed store reads | Real long-lived HTTP connection drain test; protected per-process metrics implemented; OTLP/HTTP traces implemented; extended load/chaos and multi-environment verification pending; Kubernetes grace must exceed the configured drain plus cleanup margin |

| Autonomous delivery controller | Workflow design only | Persistent agent orchestration not implemented |

| Multi-tenancy | Tenant-scoped discovery, execution, JWT mapping and relationship identifiers | Custom-router isolation test; tenant-scoped administration and federation remain open |



The release gate remains **not production complete** while the unresolved compatibility, security, operational, and deployment items above remain. Test results are recorded separately in `validation.md`; tests not executed are not counted as passing.



Additional boundaries: upstream catalog schemas remain trusted administrator-selected inputs. Schema validation runs in deadline-limited worker threads with bounded concurrency, memory and queue. Prompt/tool embedded resource links and embedded resource contents are namespaced; arbitrary structured payloads are intentionally not rewritten. Alias discovery compares canonical full definitions across every eligible target and hides an alias if any target is missing, unavailable or incompatible. Alias invocation rechecks live target definitions in groups of four and denies the call on drift or a missing target; this adds one metadata lookup per other eligible backend, so large-pool latency and throughput need measurement. Reviewed per-public-tool definition pins continue to block pinned drift at discovery and invocation.



Version 0.4 priorities and vendor evidence are maintained in [competitive-review.md](competitive-review.md).


Version 0.5 adds transactionally stored history and rollback in both built-in databases, definition drift pins at discovery/call time, a browser tool explorer and OpenTelemetry request/upstream spans. Broader administrator SSO, durable approval/reviewer workflows, second-admin approval for configuration publication, large-pool route latency measurements and collector soak tests remain open.
