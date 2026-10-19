# Action safeguards

These optional controls narrow existing authentication, tool grants, roles, tenant boundaries and relationship checks. They do not replace them. Configure through **Action safeguards** in the administration console or the configuration document. Validation precedes draft application; publishing still requires the current revision.

## Argument policies

```json
{
  "invocationPolicies": {
    "bank__transfer": {
      "allow": [{
        "clients": ["payments-worker"],
        "constraints": [
          {"field": ["recipient"], "op": "oneOf", "values": ["billing@example.test"]},
          {"field": ["amount"], "op": "numberRange", "min": 1, "max": 100},
          {"field": ["account", "tenant"], "op": "matchesIdentity", "claim": "tenantId"}
        ]
      }]
    },
    "pay": {
      "allow": [{"constraints": [{"field": ["amount"], "op": "numberRange", "max": 50}]}]
    }
  }
}
```

This example assumes `pay` routes to `bank__transfer`, that the upstream accepts those arguments, and the caller already has permission for the requested name. A call through `pay` must satisfy **both** policies. A direct `bank__transfer` call satisfies its physical policy. To require the 50 limit everywhere, put it in the physical policy. Policies for other, unselected targets do not apply.

Within one policy, at least one rule must match. Every constraint in that rule must pass, and an optional client list must contain the authenticated client ID. An empty `allow` array denies every invocation. A tool with no applicable policy retains its existing authorization behavior. Configuring one policy does not impose default denial on other tools.

| Operator | Meaning |
|---|---|
| `equals` | Exact scalar equality with `value` (string, finite number, boolean or null) |
| `oneOf` | Exact equality with one scalar in `values` |
| `numberRange` | Finite number, inclusive `min` and/or `max`; numeric strings fail |
| `matchesIdentity` | Exact string equality with authenticated `id`, `tenantId` or `subject`; absent claims fail |

Fields are literal own-property paths, for example `["account","tenant"]`. Dots, slashes and tildes have no special meaning. Array indexes can be addressed with literal string keys such as `"0"`. There is no coercion, pattern matching, filesystem normalization, executable predicate or inferred identity. Missing fields fail even if another rule compares against null. Keep recipients, account IDs and numeric units consistent with the upstream's exact schema. Use integer minor currency units when the tool supports them; the gateway does not reinterpret currencies or financial precision.

Limits: 1,000 tool policies, 32 rules per policy, 32 constraints per rule, 16 path components, 128 characters per path component/client ID/tool policy name, 100 client IDs or membership values per rule/constraint, 2,048 characters per literal string. The management/request body limits still apply. Errors identify a denied policy without disclosing approved argument values. Audit/traces do not contain the arguments.

Checks run before upstream connection and on every request, including resumed modern requests. A policy change does not undo an admitted operation or cancel effects already running at an upstream. Normal schema validation and contract checking remain mandatory before execution. These policies currently govern `tools/call`; prompt/resource permissions retain their existing distinct controls. Callback response contents are not new tool arguments and are not inspected by this policy vocabulary.

## Catalog review

```json
{"catalogPolicy":{"requirePinned":true,"rejectControlCharacters":true}}
```

First discover tools with strict enrollment disabled, inspect their complete definitions, and use **Pin reviewed definition to draft** in Tool explorer. Publish pins, then enable reviewed-only exposure. Strict mode hides unpinned tools and rejects direct invocation; reviewing a public alias requires its own pin. A single pinned alias hash also requires each selected target's definition to match it. Upstreams may change between review and use, so calls recheck definitions; a malicious server can still lie or change behavior without changing metadata.

Control rejection checks string values and property names throughout tool metadata, including descriptions, schemas and annotations. It rejects C0 controls except tab/newline/carriage return, DEL/C1, Unicode bidirectional embeddings/overrides and isolates. Ordinary multilingual text remains valid. Definitions are rejected, not silently rewritten. This deliberately narrow rule may block legitimate use of those formatting characters. It does not detect every invisible character, deceptive language, homoglyph or prompt injection. Metadata pins prove stability only; they do not verify executable signatures or upstream behavior.

Definitions rejected at discovery produce metadata-only `gateway/catalog_rejected` audit events (changed pins retain `gateway/contract_drift`). Direct catalog and argument denials record denied request outcomes. Discovery can return a partial catalog; check activity when expected tools are missing.

## Deployment and trust

Configuration uses the existing SQLite/PostgreSQL revision store and needs no schema migration. New replicas read the same published document. Use v0.6 on all serving replicas before publishing these fields. Older binaries reject unknown configuration fields, so follow the compatibility and rollback procedure in the [research plan](research-implementation-plan.md). Do not remove a policy merely to make a rollback green without evaluating the resulting access.

The gateway, administrators and installed plugins are trusted. Make upstream systems require the mediated path using network and credential restrictions. A compromised tool can ignore safe-looking arguments. Broad shell, SQL or arbitrary-URL tools need restrictions at their execution boundary; a string equality policy is not a shell parser, URL resolver or data-provenance system. Workflow-level information flow, durable human approval, interactive consent and code sandboxing remain staged work with explicit gates in the plan.


## v0.7 additions

Physical and public-name pins now both constrain an alias; an independently unpinned alias cannot bypass physical drift enforcement. Discovery budgets/search settings are available in the same panel. See [catalog-and-routing.md](catalog-and-routing.md) and [plugin-api.md](plugin-api.md) for bounded collection, pagination, the HTTP search API, rendezvous routing and veto-only inspections. New options require v0.7; older schema compatibility and rollback caveats still apply.
