# MCP server interoperability

Relay is a protocol gateway, not a vendor-specific Jira, AWS, Gmail, Slack, or Drive connector. If a product exposes a compliant MCP server, Relay can aggregate and govern its MCP surface without knowing the vendor API. Vendor-specific data access, OAuth consent, account scopes, and product licensing still belong to that server and its identity provider.

## What connects today

| Server shape | Gateway support | Notes |
|---|---|---|
| Remote Streamable HTTP | Yes; default | Supports normal MCP initialization and protocol-version negotiation. The current implementation advertises MCP `2026-07-28`, including required method/name routing headers and the current multi-round-trip request flow. |
| Legacy HTTP + SSE | Yes; select `transport: "sse"` | Compatibility path for older servers. It requires careful endpoint/path allowlisting when strict deployment credential bindings are enabled. |
| Local stdio process | Yes; select `transport: "stdio"` | The operator controls executable, arguments, and environment references. This fits many AWS and local developer servers that use SDK or CLI credentials. Treat the process as trusted code. |
| Static vendor-specific HTTP headers | Yes; use `upstreams[].headerEnvRefs` | Supports keys such as `X-API-Key` or workspace identifiers from environment/secret-manager references. Protocol-controlled and forwarding headers are rejected, and strict deployments bind each secret to the exact upstream endpoint. |
| Tools and routed aliases | Yes | Tools are discovered with pagination, namespaced, authorized, schema-checked, and invoked through configured targets. Aliases can use sticky, weighted, rendezvous, or priority selection among contract-compatible targets. |
| Prompts, resources, templates, completions | Optional | Enable the corresponding gateway features and grant the caller access. Names and resource URIs are namespaced to avoid collisions. |
| Notifications and resource subscriptions | Optional | Relay bridges the supported list/resource notifications through its subscriptions feature. |
| Multi-round requests / callbacks | Supported with caller permission and capability checks | Continuation state is encrypted and bound to caller, request, and upstream. Tool/task callback forwarding remains capability-gated. |
| MCP Tasks extension | Optional | Tasks V2 requires a shared durable store for multiple replicas. A backend without the extension continues to use ordinary calls. |

This list is not a promise that every MCP extension or vendor-specific behavior is transparently proxied. Relay intentionally exposes a governed subset and rejects unsupported or unconfigured operations. In particular, servers relying on arbitrary out-of-band HTTP endpoints, WebSockets, custom protocol framing, or dynamic request headers that cannot be represented as static secret references need an adapter or a compatible MCP endpoint.

## Authentication differences

The incoming agent and each upstream are separate trust boundaries. Incoming agent authentication supports configured service keys, JWT, opaque-token introspection, DPoP-bound OAuth, or mTLS. Outbound upstream credentials support a bearer secret reference, static custom HTTP headers, OAuth client credentials, or RFC 8693 token exchange from a verified JWT. For stdio, the process can receive operator-approved secret environment references.

Some important integrations (including many Jira, Gmail, Drive, and Slack deployments) require user-consented OAuth authorization-code flows, refresh-token lifecycle, per-user account linking, or vendor-specific headers. Relay does not currently provide a built-in interactive upstream account-linking screen or a general OAuth authorization-code token vault. A deployment can implement a `CredentialProvider` plugin for user/tenant-scoped tokens and a transport plugin for specialized handshakes; otherwise use an upstream-supported service credential where its vendor policy permits. Do not assume that one organization-wide token preserves each user's native product permissions.

AWS integrations may be stdio processes using the AWS SDK credential chain, or remote MCP endpoints with their own authentication model. The operator must configure narrowly scoped AWS roles/credentials at the process or identity-provider boundary. Relay does not turn a generic bearer token into AWS SigV4 credentials.

For bearer credentials, use distinct secret references per upstream and enable strict destination bindings. The gateway resolves and attaches an outbound secret only for its approved endpoint. Static credentials are shared by callers of that upstream; use a per-principal credential plugin when user-level vendor permissions are required. Management keys must remain separate from both sets of credentials.

## Safe local examples

`npm run demo` launches synthetic Jira, AWS/CloudWatch, Gmail, Slack, Drive, and log-server MCPs in addition to the legacy/modern protocol fixtures. They have realistic tool names and representative inputs/results, plus prompts and resources. Create/draft/post examples are previews only; they never contact vendor services or mutate real data. `enterprise_search` demonstrates a governed priority route across servers with a shared tool contract.

The integration test starts these upstreams and a real MCP gateway, discovers their tools, calls product-shaped operations, verifies alias routing, and checks prompt/resource aggregation. It proves protocol interoperability for these fixtures, not authentication compatibility with each vendor's production deployment.

## References

- [MCP 2026-07-28 specification announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/) describes Streamable HTTP headers, multi-round-trip requests, list caching, and the Tasks extension.
- [Official MCP TypeScript SDK documentation](https://ts.sdk.modelcontextprotocol.io/) lists Streamable HTTP, legacy SSE, stdio, tools, resources, prompts, sampling, elicitation, and tasks.
- [Atlassian MCP server documentation](https://atlassian.github.io/atlassian-mcp-server/) documents its remote MCP server and OAuth/API-token options.
- [AWS Labs MCP server catalog](https://github.com/awslabs/mcp) illustrates the range of AWS domain servers, local processes, and cloud-managed MCP endpoints.
