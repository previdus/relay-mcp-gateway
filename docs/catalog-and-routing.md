# Bounded discovery, search and routing

## Discovery settings

```json
{
  "discovery": {
    "concurrency": 4,
    "pageSize": 100,
    "maxTools": 1000,
    "maxScannedTools": 10000,
    "maxBytes": 1048576
  },
  "features": { "catalogSearch": true }
}
```

These are the defaults, except search is **disabled** unless enabled. `concurrency` is 1–16 upstreams per collection, `pageSize` 1–200, `maxTools` 1–10,000 published candidates, `maxScannedTools` 1–100,000 upstream definitions, and `maxBytes` 1,024–4,194,304 bytes. The byte budget independently caps scanned metadata and retained published candidates. Candidates include alias copies before deduplication, so multiple aliases consume budget. Unauthorized definitions still consume the scan/byte budget to prevent an upstream from evading resource limits through hidden tools.

The collector reads raw SDK request pages rather than an auto-aggregating convenience method. It bounds upstream cursor traversal and rejects repeated cursors. Per-response network caps remain. The whole collection has the configured `timeoutMs` deadline, including concurrent batches, and cancels on overflow. Exceeding an aggregate limit produces an explicit error, **not** an apparently complete truncated list. Narrow the registered inventory/aliases or intentionally adjust the bounded settings. Failed individual backends can still yield a partial catalog and discovery-failure audit records when the overall deadline/budgets are satisfied.

Ordinary MCP `tools/list` uses standard `nextCursor` pagination. Each page freshly collects authorized definitions; it does not trust a prior discovery decision. Cursors bind to caller ID/tenant/subject, catalog content, page settings and the database configuration revision. They work across replicas sharing the same state. Changed metadata, visibility or revision invalidates a cursor, and the caller must restart. No cursor sessions or tool payloads are persisted.

Cursors are opaque offset/catalog-selection hints, **not signed authorization credentials**. A forged offset cannot expose tools outside the freshly authorized catalog. They contain no bearer token, argument policy values or raw principal data. A custom `createGateway` integration should supply its own monotonic `configurationRevision` to invalidate otherwise identical catalogs on configuration changes; `createRuntime` supplies the actual shared database revision. A changing upstream inventory can make a long traversal stale by design.

SDK clients may auto-collect pages; raw callers must follow `nextCursor` until absent. The console does this automatically, with its own repeated-cursor/page bound. Some SDKs impose a default auto-pagination cap, so an unusually small page size for a very large inventory may require adjusting the client's cap. The gateway defaults produce at most ten visible pages before its default candidate limit.

## Authorized catalog search

This is an optional **HTTP companion API**, not a new MCP protocol method or semantic-search engine:

```http
POST /catalog/search
Authorization: Bearer <service credential>
Content-Type: application/json

{"query":"invoice lookup","limit":20,"detail":"summary"}
```

The service key/JWT, exact browser-origin policy, tenant boundary, rate/concurrency admission, durable audit admission (when enabled), grants, definition pins and collection budgets all apply. Administrator keys do not impersonate services here. Search does not query arbitrary upstream URLs, create tools, change grants or execute effects. Its query is literal case-insensitive matching of all whitespace-separated terms against authorized names/descriptions, with deterministic name-weighted ordering. It is not regex, embedding or graph search. No global/inaccessible-tool count is returned.

`query` is 1–128 trimmed characters; `limit` 1–200, default 20. `detail` is `summary` (name/description/fingerprint) or `full` (complete definition); default `summary`. Pass the returned `nextCursor` with the same query/limit/detail for subsequent pages. Query and detail are included in cursor binding. A stale/invalid cursor returns 400; unavailability/budget failures return 503; disabled search returns 404 after authentication. Search queries, arguments and results are not added to audit records. The current search path uses audit metrics and upstream tracing; it does not yet create a dedicated request-level search span.

Enable the API and edit discovery limits under **Action safeguards**. Tool explorer's optional search field uses it; an empty query uses ordinary paginated MCP discovery. Agent frameworks can wrap the HTTP API as an explicitly configured discovery tool. Relay does not inject a hidden built-in search tool or change a client's granted tools after a search.

## Routing strategies

`weighted` distributes independent requests according to target weights. `sticky` keeps the existing identity/tool bucket selection. `rendezvous` uses weighted highest-random-weight style selection: a deterministic hash per authenticated tenant/identity/public tool/physical target yields an exponential race score divided by weight. The smallest score wins, with a stable target-name tie break.

```json
{"routes":[{"name":"lookup","strategy":"rendezvous","targets":[
  {"upstreamId":"east","tool":"lookup","weight":3},
  {"upstreamId":"west","tool":"lookup","weight":1}
]}]}
```

Target order does not affect rendezvous assignments. Adding a target only moves identities that select the new target; removing one only moves identities that selected it. Weights influence assignments across identities; a single identity remains assigned deterministically. Changing weights can reassign clients. This is application affinity, not a guarantee that process-local state survives a restart, and no HTTP session ID is used as authorization.

Every built-in strategy removes foreign-tenant targets **before** choosing. No eligible target means no route. Duplicate upstream/tool target entries and unknown strategies are rejected; express distribution using weights. A resumed callback retains its sealed eligible route, then rechecks current permissions/policies. Route selection never retries a failed effect or silently fails over an ambiguous result.

Routing remains replaceable through the [typed plugin API](plugin-api.md). Metadata pins on both public and physical names apply cumulatively: an alias does not bypass a reviewed physical definition. New configuration fields/strategy require v0.7 serving replicas; prior strict-schema binaries reject them. Publish a reviewed compatible document before an older-image rollback, accounting for removed protections.

## Parameter-header compatibility correction

Relay now validates `x-mcp-header` declarations on its exposed HTTP catalog and direct calls, derives modern upstream `Mcp-Param-*` headers from body arguments, and checks modern ingress against those values. It supports nested static property chains, case-insensitive header-name uniqueness, safe integers, booleans and strings with UTF-8 Base64-sentinel encoding. Optional absent/null argument values omit headers. Mirrored headers have an 8 KiB total budget. Malformed definitions are withheld, not silently changed; unknown inbound headers grant no authority and are not forwarded blindly.

The [pinned MCP specification](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx) permits annotated string/integer/boolean properties and excludes `number`; Relay follows that rule. The pinned TypeScript SDK's scanner accepts `number` due to a known conformance-scenario discrepancy. Relay's bounded scanner corrects this difference, supports explicit single primitive `type` declarations, and rejects annotation paths through compositions/arrays/referenced definitions. Nullable union-type declarations are not supported by this scanner. Unannotated ordinary schemas still use the bounded schema worker.

[Transport requirements](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx) require decoding before comparison and HTTP 400/-32020 for mismatches. Relay tests both the status and code, numerical integer equivalence, malformed/invalid-UTF-8 encodings, zero/false values and zero additional upstream execution. The low-level SDK dispatcher returned 200 for a handler-thrown mismatch; Relay corrects the outgoing status. These targeted checks are not exhaustive MCP conformance certification.
