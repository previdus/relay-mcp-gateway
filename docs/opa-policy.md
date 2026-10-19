# Open Policy Agent authorization adapter

OPA can be added as a remote policy decision point through its documented Data API. The gateway posts to one deployment-configured decision URL and accepts only a JSON response with the literal boolean `{"result":true}`. `false`, an undefined result, malformed or oversized JSON, non-2xx status, redirect, connection failure, and timeout all deny. Decisions have a 1,000 ms default deadline, configurable from 1 to 10,000 ms; the gateway does not cache results, so relationship changes are observed on the next decision.

Configure the decision endpoint and, when required, its bearer token in deployment environment:

```dotenv
OPA_DECISION_URL=https://opa.internal.example/v1/data/mcp/authz/allow
OPA_BEARER_TOKEN=inject-through-your-secret-provider
OPA_TIMEOUT_MS=1000
```

With `GATEWAY_REQUIRE_CREDENTIAL_BINDINGS=true`, bind the fixed decision endpoint and token reference under the `authorization-service` purpose:

```json
[
  {"reference":"OPA_DECISION_URL","endpoint":"https://opa.internal.example/v1/data/mcp/authz/allow","purpose":"authorization-service"},
  {"reference":"OPA_BEARER_TOKEN","endpoint":"https://opa.internal.example/v1/data/mcp/authz/allow","purpose":"authorization-service"}
]
```

OPA is an additional required decision: it composes with the gateway allowlist, configured roles, and OpenFGA using all-of semantics. A local denial prevents the remote call. OPA does not grant a tool absent a local allowlist grant, and an OPA outage cannot grant access. The same endpoint decides tool calls, prompt reads, and resource reads using the `action` field.

The request document is intentionally small and credential-free:

```json
{
  "input": {
    "principal": {"id":"agent-1","tenantId":"tenant-a","subject":"user-7","roles":["reader"]},
    "action":"tools/call",
    "resource":{"name":"alpha__search"}
  }
}
```

The gateway constructs an allowlisted identity projection; it never serializes the principal object, bearer token, tool arguments, or upstream credentials. The decision URL is fixed by the deployment and may not come from the agent request or database gateway document.

Example Rego policy for the configured `/v1/data/mcp/authz/allow` decision:

```rego
package mcp.authz

default allow := false

allow if {
  input.action == "tools/call"
  input.principal.roles[_] == "reader"
  startswith(input.resource.name, "alpha__")
}

allow if {
  input.action == "resources/read"
  input.principal.id == "report-agent"
  input.resource.name == "resource://monthly-report"
}
```

Keep the OPA API private to the gateway, authenticate it when it crosses a trust boundary, and use TLS. The gateway client follows OPA's REST decision response format but does not manage policy bundles, Rego modules, or OPA administration. Configure a decision-only API path and deny management endpoints to the gateway identity. See [OPA REST API](https://www.openpolicyagent.org/docs/rest-api) and [OPA security guidance](https://www.openpolicyagent.org/docs/security).

The fast suite uses local HTTP fixtures for identity minimization, strict response parsing, failures, redirects, limits, timeouts and destination binding. The disposable service suite also runs the official `openpolicyagent/opa:1.19.1` image with the committed Rego policy and gates real MCP discovery and calls. This is one local OPA version and policy; it is not a production latency benchmark or managed OPA deployment certification.
