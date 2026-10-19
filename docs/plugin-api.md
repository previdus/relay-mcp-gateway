# Plugin API v1

Import `createGateway`, `PLUGIN_API_VERSION` and the public extension types from `dist/gateway.js`. The entry point exports routing, authentication, authorization, credential, concurrency, traffic and inspection interfaces. Existing plugins without an explicit version still work; an explicit unsupported `pluginApiVersion` is rejected at construction. This is a source-level integration API, not an untrusted plugin marketplace or binary compatibility guarantee.

Use `createRuntime(store, {plugins: config => ({...})})` to install compiled deployment-owned extensions with database configuration. No JSON configuration field loads arbitrary JavaScript or module paths. The executable's environment-based plugins remain available; deployment-specific code controls registrations. Runtime-injected authorizers are composed with environment-configured client grants, role grants, OPA and OpenFGA using `AllOfAuthorizer`, so an application plugin can add a restriction but cannot silently remove deployment policy. Strict deployment egress policy and state keys remain authoritative when supplied by the environment. Conflicting application authenticators or approval gates do not replace their environment-configured counterparts; the runtime reports unready until the conflict is removed. At the lower-level `createGateway` API, the supplied authorizer is the selected policy component; explicitly pass an `AllOfAuthorizer` when you need to combine policies. An in-process plugin is trusted with its own process permissions. Use an independently isolated service for untrusted execution.

## Inspection extension

```ts
import { createGateway, PLUGIN_API_VERSION, type ToolInspector } from './dist/gateway.js';

const destinationPolicy: ToolInspector = {
  id: 'payment-destination',
  async beforeCall(context) {
    if (context.upstreamId !== 'bank' || context.upstreamTool !== 'transfer') return 'allow';
    return context.arguments.recipient === 'billing@example.test' ? 'allow' : 'deny';
  },
  async afterCall(context) {
    // An optional deployment-owned DLP adapter can inspect this transient snapshot.
    // Forward context.signal to any remote operation; never log payloads by default.
    return 'allow';
  }
};
const gateway = createGateway(config, {
  pluginApiVersion: PLUGIN_API_VERSION,
  inspectors: [destinationPolicy]
});
```

Prefer the built-in declarative argument policies for simple values/ranges/identity comparisons. Use inspectors for domain checks or integration with an externally operated policy/DLP engine. Inspectors return only `allow` or `deny`; all applicable inspectors must allow. They cannot return replacement arguments/results, route overrides, grants or retry instructions. Invalid responses, exceptions, attempts to mutate a frozen snapshot, timeouts and request cancellation fail closed.

Execution order is: authenticate → tool authorization → resolve and validate tenant/upstream → declarative argument policy for both public and physical name → pre-call inspectors → bounded upstream connection/catalog/schema/pin checks → one upstream call → output schema/continuation/link processing → result inspectors → delivery. Inspectors cover normal and pending callback results. Existing prompt/resource handlers use their separate authorization path and currently do not run these tool inspectors.

Snapshots include request ID, authenticated ID/tenant/subject/roles/authentication scheme, public name, selected upstream/tool and arguments; result inspectors additionally receive the result. They exclude the API/bearer token and upstream credentials. JSON values are deeply frozen and have a 50,000-node snapshot budget; the request/response byte limits still apply. Tool data can contain secrets of its own, so the adapter's operator must govern any remote transfer and retention. The gateway adds no inspector payloads to audit/tracing. Errors returned to clients omit private adapter diagnostics.

`inspectionTimeoutMs` configures one cumulative budget per phase (default 1,000 ms, range 1–5,000). At most 16 inspectors with distinct bounded IDs are registered. Request cancellation and deadline expiry abort the signal. A late promise cannot change the already denied response. This is cooperative cancellation: JavaScript cannot kill a CPU loop or undo a remote adapter's effects. Avoid non-cooperative code and isolate heavy classifiers in another service.

## Out-of-process inspection and DLP

Set `INSPECTOR_DECISION_URL`, `INSPECTOR_BEARER_TOKEN`, and a required `INSPECTOR_TOOLS` allowlist to opt into a deployment-owned HTTP inspection service. The comma-separated allowlist accepts exact public/physical tool names or namespace wildcards such as `payments__*`; the service is not called for other tools. For selected calls it runs before the upstream operation and again after it. Application-local inspectors run first; if one vetoes, the remote service is not sent that call's data. By default the request contains client and tenant identifiers, requested/public and resolved tool names, but omits tool arguments and results. Set deployment-owned `INSPECTOR_DATA_MODE=full` to send the complete argument object before execution and the full result afterward; these payloads may contain customer secrets. Additional identity fields (`subject`, `roles`, `authScheme`) require explicit selection in `INSPECTOR_IDENTITY_FIELDS`, which must include `id`. Choose a service in an approved region, protect its logs and retention, and approve the full-data transfer path before enabling it. The gateway does not redact, tokenize, or transform payloads in full mode.

The service must return exactly `{"decision":"allow"}` or `{"decision":"deny"}`. Only the exact `allow` value grants passage; malformed responses, redirects, failures, oversized payloads and timeouts deny. The request is capped at 256 KiB by default (`INSPECTOR_MAX_BYTES`, configurable from 1 KiB to 1 MiB); the response is capped at 2 KiB. The inspection timeout defaults to `inspectionTimeoutMs` or 1 second and can be set from 1 to 5 seconds, but the gateway's cumulative phase timeout still applies. Service credentials use the `inspection-service` destination-binding purpose; strict egress mode pins the service address. Configure these values only through deployment environment or a secret manager, never the admin document.

Pre-call denial prevents the upstream call. Post-call denial withholds the result but cannot undo an action that already occurred; the caller receives the existing no-automatic-retry warning. The service can only allow or deny; response rewriting/redaction is not supported.

**Withholding a result does not undo the upstream action.** The caller gets an explicit warning that it may already have completed and must not retry automatically. No automatic tool retries occur. Inspectors should be side-effect free; business actions belong in tools.

## Routing and other extensions

`Router.names` controls advertised names; `Router.resolve` chooses a target using authenticated routing context. The gateway enforces that a physical public name resolves only to that same physical upstream/tool. An alias must exist in the administrator's route table, satisfy its client/tenant/role selectors, and resolve to one of its enabled target pairs. Custom plugins may implement flexible selection among those approved targets, but cannot create a new grant or redirect an authorized tool to another registered server. The same target-boundary check filters catalog names and runs again immediately before invocation. Routing APIs do not receive bearer credentials. There is no default retry/failover of uncertain side effects.

For `createRuntime`, an injected authorizer is an additional policy and is combined with the deployment policy by `AllOfAuthorizer`; it cannot grant a tool rejected by an environment-configured control. For direct `createGateway` construction, the injected authorizer is the selected policy component, so explicitly compose it with other grants using `AllOfAuthorizer`. Inspection vetoes cannot replace authorization. Database-backed concurrency/rate adapters provide shared admission; custom adapters must document consistency and fail-closed behavior.

`createRuntime` also composes an injected `audit` sink with the local database audit sink, instead of silently replacing either one. Both receive the same metadata-only `AuditEvent`; they do not receive arguments, results, or credentials. Failure from either sink rejects durable admission events before an operation starts. A sink failure after an upstream effect cannot undo that effect, and the gateway does not provide an outbox or guaranteed delivery; use a durable, retrying exporter if external retention is required. In-process sink code is trusted deployment code.

## Out-of-process route decisions

For deployments that must keep custom routing code out of the gateway process, set a deployment-owned `ROUTER_DECISION_URL` and `ROUTER_BEARER_TOKEN`. The remote service receives `POST` JSON with `requestId`, an allowlisted principal projection, the public alias, and only the targets that are enabled, tenant-compatible, and selector-eligible. It returns exactly `{"target":{"upstreamId":"...","tool":"..."}}`. It never receives the inbound agent token, upstream credentials, arguments, or upstream destination URLs. Direct physical names continue to resolve locally.

Example request:

```json
{
  "requestId": "gateway-generated-id",
  "principal": { "id": "agent-17", "tenantId": "payments", "roles": ["writer"] },
  "route": { "name": "transfer" },
  "candidates": [
    { "upstreamId": "payments-east", "tool": "transfer", "weight": 3 },
    { "upstreamId": "payments-west", "tool": "transfer", "weight": 1 }
  ]
}
```

Example response: `{"target":{"upstreamId":"payments-east","tool":"transfer"}}`.

```dotenv
ROUTER_DECISION_URL=https://router.internal.example/decide
ROUTER_BEARER_TOKEN=inject-through-your-secret-provider
ROUTER_TIMEOUT_MS=500
```

The service must return one exact member of the supplied pool. The gateway independently checks the selected target again before invoking it. Invalid responses, redirects, service errors, cancellation, and deadline expiry fail closed; no fallback route or effect retry occurs. The endpoint and token are deployment-owned, and `GATEWAY_REQUIRE_CREDENTIAL_BINDINGS=true` requires both references to be bound to this exact endpoint with purpose `routing-service`. Strict egress mode also pins the service's DNS result for its request. Keep the route service private and authenticated because it receives identity metadata. This provides a remote extension boundary for routing only: custom authenticators, inspectors, transports, and other in-process extensions remain trusted code. A remote decision service also adds a latency and availability dependency.

Regression coverage: `test/advanced.test.js` proves a custom router cannot map an authorized physical tool to a different same-tenant upstream, can choose among enabled targets in an approved alias pool, cannot choose a disabled target, and cannot expose or invoke an alias outside configured selectors. `test/remote-router.test.js` exercises the deployed environment wiring, MCP call and management preview, identity/payload minimization, target filtering, strict DNS-pinned egress, sealed continuation reuse, malformed/redirect/timeout denial, and exact deployment credential binding. `test/remote-inspector.test.js` exercises real before/after MCP inspection, metadata-only default, explicit full argument/result transfer, tool allowlisting, credential minimization, post-effect denial warnings, response strictness, payload limits, deadline cancellation, strict egress and endpoint binding. `test/research-safeguards.test.js` verifies immutable credential-free inspector contexts, sequential vetoes, concurrent-call isolation, failure/timeout handling, prevention of grants outside core policy and the state left by withheld outputs. These are gateway extension tests, not a reproduction of model-training defenses or published agent benchmarks.

## External human approval for selected tools

Set `approvalRequiredTools` in the gateway document to exact public/physical tool names or namespace wildcards such as `payments__*`, and configure `APPROVAL_DECISION_URL` plus a separate `APPROVAL_BEARER_TOKEN`. The gateway refuses to start or validate that configuration unless an approval adapter is available. The endpoint and token are deployment-owned; strict credential binding uses purpose `approval-service`, and strict egress mode pins the endpoint address.

For a selected call, the gateway first sends a `request` phase containing the authenticated client/tenant/subject projection, public and resolved tool names, configuration revision, pinned tool-contract fingerprint, full arguments, and a canonical SHA-256 argument digest. The approval service may return only `{"decision":"pending","approvalId":"..."}`. It cannot grant the first call. The MCP response is JSON-RPC error `-32022` with `data: {"approvalId":"..."}`, so clients can retrieve the opaque permit without parsing the human-readable message. After a human review, the agent retries with that ID in MCP request metadata as `_meta["com.agentrelay/approvalId"]`. The gateway sends a `consume` phase with the same binding data. Only the exact `{"decision":"allow"}` response proceeds to the upstream call; the opaque permit metadata is not forwarded upstream. Denials, malformed replies, redirects, oversized messages, cancellation, endpoint failure, and timeouts fail closed. Tool names, request/response sizes and service timeouts are bounded.

The core enforces this two-phase contract for every `ToolApprovalGate` implementation: the no-permit phase must return a syntactically valid pending ID, and an `allow` is accepted only when a syntactically valid permit was supplied. A plugin cannot grant a first call by returning `allow`; malformed permit metadata is rejected before invoking the plugin. Custom adapters remain trusted code and must still implement durable atomic consumption correctly.

Metadata-only audit events use outcomes `approval_pending` and `approval_consumed` with methods `gateway/approval.requested` and `gateway/approval.consumed`. They identify the caller, public tool, upstream, request and configuration revision, but omit permit IDs and arguments. The original tool-call event is still recorded separately. Without `requireAudit`, these lifecycle events are best effort. With `requireAudit`, failure to record either event fails closed before the call is forwarded; if the consumed event cannot be recorded, the external one-use permit may already have been consumed, so a new approval may be needed. Deployments needing an independently durable approval ledger must keep that ledger in the approval service.

The external approval service is a security-critical extension and owns all durable workflow state. It must authenticate and record the human reviewer independently of the agent, bind the permit to the authenticated caller and tenant, exact public and physical tool, exact canonical arguments, selected route, configuration revision, tool-contract fingerprint, expiry and any business context, and atomically consume the permit once across concurrent replicas. It should reject changed bindings, expired approvals, cross-tenant use, concurrent replay and revoked approvals. A pending `approvalId` must be unguessable and disclose no reviewer or business data. The gateway does not store approval records, establish that a human actually reviewed the action, or implement a reviewer UI.

The approval service receives full tool arguments, which may contain secrets or regulated data. Approve its endpoint, region, operators, logging and retention accordingly. The gateway consumes the permit before forwarding the action and does not guarantee exactly-once business execution: if the upstream fails or the response is lost after consumption, require a fresh approval unless the business system supplies its own idempotency protocol. Never blindly retry a side effect. A local fixture test proves the gateway boundary, not the correctness, availability, reviewer controls or transactional semantics of a production approval service.
