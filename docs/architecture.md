# Architecture and extension boundaries

## Runtime

An Express host wraps two logical planes: the administration API/UI and MCP execution. They share a deployable process for this version; put management routes behind a restricted ingress. A request reads a `ConfigStore` snapshot and resolves environment references. The runtime caches a gateway application by revision, never cached permission decisions. New revisions affect subsequent requests without a replica restart.

The SDK owns JSON-RPC validation, protocol negotiation, modern header/body consistency, and transport response encoding. A per-request server factory avoids sticky ingress sessions. Upstream connections are short-lived and isolated. A router selects a configured upstream and original tool name; the gateway then looks up the configured destination again to prevent a router result from replacing its URL.

PostgreSQL is the shared state boundary: optimistic revision updates use one conditional UPDATE; lease acquisition uses an advisory transaction lock per principal before counting and inserting leases. Leases have a deadline and requests have a shorter wall-clock cap. Database errors deny new work. SQLite provides durable local operation, not a distributed lease backend.

## Plugin interfaces

| Interface | Responsibility | Built-in implementations |
|---|---|---|
| Authenticator | Verify a credential, return a configured principal | Service key, JWT/JWKS |
| Authorizer | Decide each tool call and optional prompt/resource access | Allow list, role policy, OpenFGA, all-of composition |
| Router | Map catalog names and resolve calls | Namespace, alias, weighted, identity-sticky |
| transportFactory | Construct a client-side MCP transport | Built-in remote HTTP/SSE; trusted application override |
| ConcurrencyLimiter | Acquire and release bounded work slots | In-memory, PostgreSQL leases |
| ConfigStore | Read revision, compare-and-swap update, audit storage | SQLite, PostgreSQL |
| AuditSink | Receive metadata-only events | ConfigStore adapter, application-supplied sink |

Custom code imports interfaces from `src/plugins.ts`, `src/limiter.ts`, and `src/store.ts`. A custom `Authorizer` lacking `canAccess` denies prompt/resource requests. All-of composition means every configured policy must grant; exceptions deny. Plugins must obey timeouts, avoid logging secrets, and preserve the intended identity boundary. Do not load untrusted modules dynamically from admin configuration.

## OpenFGA model

Use a pinned model version. The test model in `integration/services.test.js` demonstrates users, group membership, and a tool's `can_call` relation accepting users or group members. The gateway requests higher-consistency checks and does not cache permission decisions. User and object identifiers are percent encoded consistently when constructing tuple keys.

Optional feature relations are `prompt:NAME#can_get` and `resource:NAME#can_read`; add these types and relations to your deployed model when enabling these features. A resource NAME is `upstream__original-uri`, percent encoded as a whole for the OpenFGA object ID. The gateway only checks relationships; relationship provisioning/administration stays in OpenFGA and is not exposed through this UI.

## Security decisions

Gateway tokens and upstream credentials are separate. JWT claims cannot directly grant arbitrary permissions: subjects are matched to administrator-configured identities. Discovery is filtered using the same policies as execution. Host and exact-origin checks guard HTTP entry points; the console uses a restrictive content policy and constructs dynamic text with DOM text APIs. Management changes need a separate key and an If-Match revision.

Operator-managed destination allowlists are applied before a new configuration is used. A network egress policy is still necessary against DNS rebinding, private address resolution, and metadata access. Identity provider and OpenFGA endpoints are deployment settings, not values editable by ordinary tool clients.

## Design inputs

- [MCP July 2026 base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic): distinguish required protocol behavior from optional capabilities; advertise only implemented features.
- [Official SDK gateway guidance](https://ts.sdk.modelcontextprotocol.io/v2/advanced/gateway.html): modern/legacy negotiation and authorization-scoped discovery. Cross-request discovery caching is deliberately deferred.
- [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices): credential audience separation, SSRF and proxy trust boundaries.
- [IBM ContextForge](https://github.com/IBM/mcp-context-forge): federation, administration, and plugin boundaries are useful reference concerns; this project does not claim its feature parity.
- [Microsoft MCP Gateway](https://github.com/microsoft/mcp-gateway): scalable hosting and lifecycle routing as distinct responsibilities.
- [Google's Zanzibar paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/): relationship checks as a separate authorization service; consistency matters for revocation.
- [OpenFGA Check documentation](https://openfga.dev/docs/getting-started/perform-check): explicit principal/relation/object checks against an authorization model.
- [Enterprise MCP gateway paper](https://arxiv.org/abs/2504.19997): abstract reviewed for self-hosting and threat-model concerns. Secure tunneling and intrusion detection described by that work are not implemented here.
- [Relationship authorization in Data Spaces](https://arxiv.org/abs/2505.24742): abstract reviewed for separation of authentication and relationship-policy enforcement. ODRL policy translation is outside this gateway's current scope.

These references informed the design. No claim is made that the resulting features are novel or unavailable in existing gateways.
