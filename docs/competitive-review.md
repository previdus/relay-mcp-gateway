# Comparative review and implementation plan

Reviewed 17 October 2026. Scope: the official product sites, linked feature inventories and public implementation documentation, compared with this project's source and executed tests. This is a broad capability review, not a licensed-product hands-on evaluation or an exhaustive inventory of every plugin. No competitors were deployed or benchmarked. Vendor statements below are documented capabilities, not independently measured guarantees. “Not established” means the reviewed sources do not settle the question; it does not mean absent.

## Different products, different strengths

**Gravitee** spans API/event management and AI governance. Its AI Gateway describes shared policy and telemetry across MCP, LLM and A2A traffic, while MCP Studio composes curated tool bundles. Its authorization platform describes a Cedar-backed decision engine with catalog-aware policy authoring. This breadth makes it a platform comparison, rather than just an MCP reverse-proxy comparison. [AI Gateway](https://www.gravitee.io/platform/ai-gateway), [platform](https://www.gravitee.io/platform/), [authorization](https://www.gravitee.io/platform/authorization-management)

**KrakenD** is a configurable general API gateway with extensive connectivity and traffic controls. Its MCP proxy documentation describes transparent HTTP/SSE forwarding through no-op routes and excludes stdio from that function. Its separate MCP Server feature exposes existing backend use cases as tools. These are different capabilities; a raw proxy's generic HTTP controls do not by themselves demonstrate tool-aware federation. [MCP proxy](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-gateway/), [MCP Server](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-server/)

**Microsoft MCP Gateway** emphasizes Kubernetes lifecycle management: deploy/update/delete servers and tools, inspect status/logs, and route requests to available instances. Its current documentation describes a React management portal, Entra creator/role authorization, Redis/Cosmos metadata, and stateless per-request routing. Its optional Foundry agent/session execution is explicitly preview and single-replica, with isolation limitations. This is not equivalent to production-ready autonomous software delivery. [Project documentation](https://microsoft.github.io/mcp-gateway/)

**Relay, our gateway**, currently emphasizes protocol-aware aggregation, replaceable policy/routing interfaces, tenant-scoped data-plane access, OpenFGA composition, independently scoped upstream credentials and verified local containers. It lacks the breadth, operational maturity and managed server lifecycle of the comparison platforms. Source-level modularity is useful, but is not evidence of superior performance or production reliability.

## Edition and evidence cautions

KrakenD's current feature matrix lists MCP Gateway in CE and EE, but its dedicated MCP Gateway page labels the feature Enterprise AI module. Confirm the exact release and entitlement before procurement or migration. The matrix places native MCP Server and several advanced policies in Enterprise. [Matrix](https://www.krakend.io/features/), [proxy page](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-gateway/)

Gravitee's policy reference marks MCP ACL and several security/AI policies as Enterprise. Platform marketing does not prove that every capability is available in every open-source distribution or older APIM version. [Policy catalogue](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference)

The Microsoft GitHub repository description mentions session-aware routing while the current project site describes stateless routing without MCP transport-session storage. Use a pinned release/commit and test its actual behavior; do not infer protocol-version support from the repository tagline. [Repository](https://github.com/microsoft/mcp-gateway), [current documentation](https://microsoft.github.io/mcp-gateway/)

## Capability matrix

G = Gravitee; K = KrakenD; M = Microsoft's project. “Relay” distinguishes implementation from backlog. Linked cells identify supporting vendor documentation. This table groups related features rather than treating plugin counts as a quality score.

| Capability | G | K | M | Relay 0.5 |
|---|---|---|---|---|
| MCP proxy | [Protocol-aware](https://www.gravitee.io/platform/ai-gateway) | [HTTP no-op](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-gateway/) | [Request routing](https://microsoft.github.io/mcp-gateway/) | SDK-based modern/legacy HTTP aggregation |
| Native API-to-tool generation | [API mediation](https://www.gravitee.io/platform/protocol-mediation) | [MCP Server](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-server/) | Not established | Backlog: constrained OpenAPI adapter |
| Curated tool bundles | [Composite servers](https://www.gravitee.io/platform/) | [Multi-tool servers](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-server/) | [Tool registration](https://microsoft.github.io/mcp-gateway/) | Per-identity grants and aliases; named/versioned bundles pending |
| Prompts/resources/templates | [Composite assets](https://www.gravitee.io/platform/) | Exact coverage not established | Exact coverage not established | Opt-in aggregation, URI namespaces, templates, completion |
| Stdio upstream bridge | Exact coverage not established | [Excluded from proxy](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-gateway/) | [Local/remote servers](https://microsoft.github.io/mcp-gateway/) | Approved executable, explicit environment; process per operation |
| Callback continuation compatibility | Version-specific review needed | Version-specific review needed | Version-specific review needed | Modern encrypted continuation relay; legacy push gap |
| Notification durability | Not established | Not established | Not established | Bounded streams; no durable event ledger |
| Tool/method permissions | [MCP ACL](https://documentation.gravitee.io/apim/4.10/create-and-configure-apis/apply-policies/policy-reference/ai-mcp-acl) | [Per-client filtering](https://www.krakend.io/docs/enterprise/ai-gateway/mcp-server/) | [Creator/roles](https://microsoft.github.io/mcp-gateway/) | Discovery plus invocation enforcement; separate resource grants |
| Role and contextual policy | [Cedar/context](https://www.gravitee.io/platform/authorization-management) | [Policy engine](https://www.krakend.io/features/) | [App roles](https://microsoft.github.io/mcp-gateway/) | All-of grants/roles/OpenFGA; general ABAC pending |
| Relationship authorization | Model parity not established | Model parity not established | Model parity not established | Real OpenFGA membership/revocation tests |
| Federated caller identity | [Agent/IAM](https://www.gravitee.io/platform/ai-gateway) | [OIDC/JWT](https://www.krakend.io/features/) | [Entra](https://microsoft.github.io/mcp-gateway/) | 2–16 statically pinned issuer/JWKS profiles with per-issuer subject identity bindings; provider login/consent remains delegated |
| Upstream user credentials | [Exchange/consent](https://www.gravitee.io/blog/mcp-server-mediation-securing-third-party-mcp-connections) | [Client credentials](https://www.krakend.io/features/) | Not established | Client credentials/exchange; interactive consent and refresh storage pending |
| mTLS/workload identity | [mTLS policy](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference) | [mTLS/cloud auth](https://www.krakend.io/features/) | Entra integration | TLS ingress delegated; native certificate/SPIFFE policies pending |
| Token revocation | Product configuration dependent | [Revocation components](https://www.krakend.io/features/) | Provider dependent | Config revokes identity/grants; token jti denylist pending |
| Human tool-call approval | Not established | Not established | Not established | Backlog: separate approval ledger and bound permits |
| Tenant administration | Product configuration dependent | Product configuration dependent | [Resource ownership](https://microsoft.github.io/mcp-gateway/) | Data-plane tenancy; global administrator only |
| Rate/long-term quotas | [Rate/quota/spike](https://documentation.gravitee.io/apim/4.2/reference/policy-reference/rate-limit) | [Traffic controls](https://www.krakend.io/features/) | Not established | New token buckets; monthly quotas/spend budgets pending |
| Shared replica counters | Deployment dependent | [Redis limiter](https://www.krakend.io/docs/enterprise/throttling/global-rate-limit/) | Not established | New atomic PostgreSQL buckets; real replica race test |
| Identity plan overrides | Policy driven | [Tiered limits](https://www.krakend.io/features/) | Not established | New per-client rate overrides |
| Tool-specific throttling | [Tool throttling](https://www.gravitee.io/blog/mcp-gateway) | Requires mode-specific configuration | Not established | New exact public-tool budgets; alias buckets distinct |
| Circuit breaking | [Policy](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference) | [State machine](https://www.krakend.io/docs/backends/circuit-breaker/) | Not established | Local breaker for SQLite; shared PostgreSQL state and one cross-replica recovery probe for PostgreSQL deployments |
| Dynamic/load-balanced routing | [Routing policy](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference) | [Conditional/weighted](https://www.krakend.io/features/) | [Ready instance routing](https://microsoft.github.io/mcp-gateway/) | Weighted/sticky aliases, client segmentation, trusted router plugin |
| Service discovery | Deployment dependent | [DNS SRV](https://www.krakend.io/features/) | [Kubernetes](https://microsoft.github.io/mcp-gateway/) | Static approved registry; resolver plugin planned |
| Failover/retries/hedging | [Retry policy](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference) | [Fallback/concurrency](https://www.krakend.io/features/) | Instance routing | Deliberately no automatic side-effect retries; read-only failover pending |
| Response transformation | [Policy family](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference) | [Transformation](https://www.krakend.io/features/) | Not established | Resource link rewriting; generic adapters pending |
| Safe cache | [Cache policy](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference) | [Backend cache](https://www.krakend.io/features/) | Not established | No cross-user result cache; identity-aware opt-in caching pending |
| Input/output contracts | [Validation policies](https://documentation.gravitee.io/apim/create-and-configure-apis/apply-policies/policy-reference) | [Schemas](https://www.krakend.io/features/) | [Definition metadata](https://microsoft.github.io/mcp-gateway/) | Worker-isolated schemas; pinned definition drift blocks calls; automatic alias compatibility gate pending |
| Distributed telemetry | [OTel lineage](https://www.gravitee.io/platform/ai-gateway) | [OTel exporters](https://www.krakend.io/docs/telemetry/opentelemetry/) | [Telemetry integration](https://microsoft.github.io/mcp-gateway/) | Request IDs/audit/metrics; OTLP/HTTP request/upstream spans tested; viewer/metrics export pending |
| PII/security filtering | [AI guardrails](https://www.gravitee.io/platform/ai-gateway) | [AI controls](https://www.krakend.io/features/) | Not established | Payloads excluded from audit; DLP policy adapter pending |
| LLM routing/cache/spend | [Model governance](https://www.gravitee.io/platform/ai-gateway) | [AI module](https://www.krakend.io/features/) | Foundry agent integration | Outside current MCP-only runtime; separate module proposed |
| A2A governance | [A2A proxy](https://www.gravitee.io/platform/ai-gateway) | Not established | Not established | Separate future adapter |
| Event/broker connectivity | [Event mediation](https://www.gravitee.io/platform/protocol-mediation) | [Broker adapters](https://www.krakend.io/features/) | Not established | Not implemented |
| Management experience | [Policy/catalog UI](https://www.gravitee.io/platform/authorization-management) | [Designer](https://www.krakend.io/features/) | [Portal/logs/test](https://microsoft.github.io/mcp-gateway/) | Console, policy simulator, new traffic form; service-identity explorer and reviewed definition pinning implemented |
| GitOps/config validation | [Policy validation](https://www.gravitee.io/platform/authorization-management) | [Validation/templates](https://www.krakend.io/features/) | Deployment samples | Strict config, CAS publish and CI; transactional history and reviewed rollback; signed promotion pending |
| Server deployment lifecycle | Scope-specific | Not established | [Deploy/update/delete](https://microsoft.github.io/mcp-gateway/) | Registry only; workload controller pending |
| Horizontal state | Deployment-specific | [Shared limit store](https://www.krakend.io/docs/enterprise/throttling/global-rate-limit/) | [Redis/Cosmos](https://microsoft.github.io/mcp-gateway/) | PostgreSQL config/audit/leases/rates; SQLite local |
| Kubernetes portability | Deployment-specific | Deployment-specific | [Kubernetes native](https://microsoft.github.io/mcp-gateway/) | Templates and verified containers; cluster rollout unverified |
| Autonomous development agents | Not established | Not established | [Preview agent sessions](https://microsoft.github.io/mcp-gateway/) | Delivery contract only; persistent controller pending |
| Commercial support/compliance | Vendor terms required | [Edition/support](https://www.krakend.io/features/) | Project terms required | No support SLA or certification |
| Comparative performance | Not independently measured | Not independently measured | Not independently measured | No comparative benchmark or superiority claim |

## What “better” will mean for this project

These are proposed acceptance criteria, not achieved results:

1. **Protocol reliability:** version-pinned conformance and adversarial fixtures for every advertised capability, including callbacks, notifications and cancellation. Never advertise unimplemented extensions.
2. **Authorization precision:** tenant, human/workload identity, public tool, method, argument conditions and relationship grants compose without bypasses. Zero unauthorized successes in the defined adversarial corpus is the acceptance gate, not a universal zero-bug claim.
3. **Side-effect safety:** approval permits bind identity, tenant, argument digest, route and expiry; atomic consumption prevents duplicate approval reuse. Retry/failover requires an administrator-pinned safety contract, not untrusted tool annotations.
4. **Portable operations:** identical acceptance scenarios on local Compose and at least two Kubernetes environments. Shared budgets and policy revision changes must work across replicas and restarts; failure injection must show fail-closed authorization and bounded recovery.
5. **Transparent governance:** compare candidate policy changes before publish, require review for privilege escalation, store audit intent atomically with control-plane changes, and export a verifiable release evidence bundle.
6. **Measured efficiency:** benchmark all candidates with pinned versions, same hardware, equivalent security policies, upstream latency and tenant/tool cardinality. Report p50/p95/p99, throughput, errors, CPU/memory and recovery time. No target numbers invented before a baseline.
7. **Extensibility:** public contracts and compatibility tests for identity, policy, relationship checks, routing, credentials, rate storage, transport, telemetry and deployment adapters. Dynamic third-party code remains outside the untrusted configuration surface.

## Changes implemented from this review

**TRAFFIC-01:** Token-bucket admission per identity with optional plan override and exact public-tool buckets. PostgreSQL performs atomic reservations across replicas; SQLite/local mode uses a bounded in-process map. Quota-store failures return 503; exhausted budgets return 429 with Retry-After. Publishing unrelated configuration does not refill the bucket. Changing a policy creates a new bucket. This is request-rate control, not monetary budgeting or a rolling monthly quota.

**RESILIENCE-01:** Optional circuit breakers around ordinary upstream operations. SQLite deployments keep local state; PostgreSQL deployments share breaker state across replicas and use a database-backed half-open probe lease. Consecutive counted failures open the circuit; after the delay only one recovery probe proceeds. Generation checks ignore stale completions from before a state transition. Tool `isError` results, caller cancellation, caller argument errors and ProtocolError are excluded from outage counting. Long-lived subscriptions bypass breakers. The circuit can fail a selected route fast; it does not choose another route or retry a tool call.

**CONSOLE-01:** Traffic controls screen for rate and recovery settings, with validation, draft/publish and reload coverage. Advanced tool budgets and plan overrides use the complete configuration editor.

## Prioritized implementation backlog

| ID | Priority | Work | Release evidence needed |
|---|---|---|---|
| SEC-01 | P0 | Tenant-scoped administrator SSO and ownership | Cross-tenant CRUD, grant escalation and session-revocation negatives |
| SEC-02 | P0 | Durable human approval workflow with one-use bound permits | Multi-replica consume race, expiry, changed arguments, denied reviewer |
| CONTRACT-01 | P0 | Alias contract fingerprints and schema drift quarantine | Different schemas, poisoned descriptions, changed upstream between discovery/call |
| OBS-01 | P0 | OTel tracing and redaction controls | In-memory exporter plus collector integration; no tokens/payloads in spans |
| DEPLOY-01 | P0 | Verified local Kubernetes rollout and rollback | Two replicas, PG interruption, pod death, secret rotation, previous-image recovery |
| MCP-01 | P0 | Legacy callbacks and optional task extension lifecycle | Real clients, cancellation, continuation and capability negotiation matrix |
| GOV-01 | P1 | Config history, diff, reviewed promotion and rollback | Atomic revision history, conflict, reviewer separation, audit failure injection |
| ADAPTER-01 | P1 | Constrained OpenAPI-to-MCP module | JSON Schema mapping, parameter placement, SSRF and auth boundaries |
| ROUTE-01 | P1 | Health/capability routing, read-only failover and discovery | No side-effect replay; health race, tenant and destination pinning tests |
| AUTH-01 | P1 | Interactive upstream OAuth, per-user consent, refresh encryption | Real provider fixtures, audience/scope/PKCE/refresh rotation negatives |
| CATALOG-01 | P1 | Live tool explorer, curated/versioned bundles, ownership | Permission-filtered discovery and execution, schema drift view |
| OPS-01 | P1 | Retention, immutable audit export, rate-store maintenance | Export verification, legal-hold configuration, expired bucket safety |
| BENCH-01 | P1 | Reproducible comparative load/chaos suite | Pinned vendor deployments; equivalent-policy runs and raw result artifacts |
| DELIVERY-01 | P1 | Persistent bounded agent delivery controller | Task state, isolated workspaces, review gates, budgets and resumability |
| ECOSYSTEM-01 | P2 | LLM/A2A/event modules and developer portal | Separate protocol contracts, threat models and interoperability tests |

No blanket parity or superiority claim is justified by the current implementation. This backlog intentionally shows where the other platforms remain ahead and where our target needs stronger evidence.



## Second review: 0.5 implementation and evaluation

The October 17 follow-up concentrated on gaps with immediate operational consequences. Gravitee's catalog-aware policy editor illustrates the value of reviewing the actual governed asset; its documented breadth still exceeds Relay's policy language. KrakenD documents trace export and monitoring integrations; Relay now implements an OTLP/HTTP path but does not reproduce that ecosystem. Microsoft's documented portal includes server lifecycle, status/logs and interactive testing; Relay now has a service-identity tool explorer but still cannot deploy or operate arbitrary MCP server workloads. [Gravitee](https://www.gravitee.io/platform/authorization-management), [KrakenD](https://www.krakend.io/docs/telemetry/opentelemetry/), [Microsoft](https://microsoft.github.io/mcp-gateway/)

Completed additions: transactionally stored configuration history and conditional rollback; canonical administrator-reviewed tool-definition fingerprints with discovery and direct-call drift checks; OpenTelemetry request/upstream spans and real OTLP/HTTP serialization/export; browser tool discovery/invocation/pinning; and reviewed history restoration. Fault preparation also identified missing idle database-error handling, and database schema initialization is now serialized across replicas with an advisory transaction lock.

Evaluation gates are deliberately falsifiable:

| Gate | Current assessment | Evidence still required |
|---|---|---|
| Protocol correctness for advertised behavior | Tested scenarios pass | Exhaustive conformance, legacy callbacks and optional tasks |
| Cross-replica state and authorization | Shared config/rates/leases and revocation tested | Tenant administrator isolation, approval races and longer chaos runs |
| Governed definitions and changes | Pinning/history/rollback implemented | Mandatory enrollment policies, automatic alias compatibility, independent reviewers |
| Operational visibility | Request/upstream traces and redaction tested | Production collector soak, early rejection spans, trace UI and immutable audit export |
| Local deployment recovery | Container and isolated kind fault/rollback acceptance passed | Multiple Kubernetes environments and cloud validation |
| Extensibility | Replaceable routing/auth/transport/rate/circuit interfaces | Public plugin SDK compatibility and deployment adapter contracts |
| Comparative efficiency | Unproven | Equivalent-policy benchmarks of pinned competitor releases |
| Full-platform breadth | Competitors remain ahead | Workload lifecycle, API/event mediation, LLM/A2A governance and support operations |

This evaluation supports a stronger local MCP product foundation. It does not support declaring Relay better than all three platforms overall. SEC-01/02, remaining MCP compatibility, lifecycle management and BENCH-01 are still release priorities. GOV-01 is partially complete (history/rollback, without independent review). CONTRACT-01 is partially complete (pinned drift enforcement, without automatic contract enrollment). OBS-01 has an initial tested OTLP path; production collector interoperability remains to be established.

Local deployment evidence now includes two actual Kubernetes gateway replicas, PVC-backed database outage/recovery, pod replacement and compatible image rollback. DEPLOY-01 is partially complete: multi-node, multi-environment, TLS/ingress and cloud gates remain. The final release runs passed 55 core/browser/service tests plus separate container and Kubernetes acceptance commands. These are our measured scenarios, not comparative vendor benchmark results.


## v0.6 research follow-up — 17 October 2026

The separate [30-source review](research-review.md) and [pre-implementation plan](research-implementation-plan.md) informed new argument-level constraints and optional mandatory contract enrollment/display-control rejection. Mandatory enrollment is now implemented; automatic alias contract inference and independent approval remain staged. A pinned alias must match the definition of each selected target, but there is no automatic schema-compatibility migration or cross-target enrollment. The present validation counts and deployment evidence are maintained in [validation.md](validation.md), superseding earlier counts above. No new comparative performance claim is made.

The subsequent expanded review of ten products and additional implementation decisions is in [gateway-landscape.md](gateway-landscape.md).
