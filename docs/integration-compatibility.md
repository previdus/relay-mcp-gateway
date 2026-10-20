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

## Authentication and credential forwarding

The incoming agent and each upstream are separate trust boundaries. Incoming agent authentication supports configured service keys, JWT, opaque-token introspection, DPoP-bound OAuth, or mTLS. Outbound upstream credentials support a bearer secret reference, static custom HTTP headers, OAuth client credentials, or RFC 8693 token exchange from a verified JWT. Exchange requests can name the exact downstream `resource` (RFC 8707) and include a configured `actor_token` (RFC 8693) so the issuer can represent both user and gateway identities. For stdio, the process can receive operator-approved secret environment references.

Relay deliberately does not transparently copy the inbound `Authorization` token to arbitrary MCP servers. MCP requires each server to validate a token issued for that server's audience, and forbids accepting/transiting tokens for another resource. A caller token issued for Relay is therefore not automatically valid for Jira, Gmail, Slack, or another upstream. Use token exchange to obtain a downstream-audience token, or a trusted `CredentialProvider` plugin to fetch a per-user/per-tenant token from an approved vault. The default gateway authorizer still checks the agent's configured tool grants before each call.

mTLS has two different hops. Relay can authenticate an agent's client certificate when it terminates inbound TLS; that handshake proves identity only to Relay. The gateway cannot forward the agent's private key through MCP, nor can a certificate fingerprint recreate proof of possession. For upstream mTLS, configure a separate `tls` identity under that upstream, or have a trusted credential plugin return a per-principal certificate/key. The same gateway-to-upstream TLS identity is used at that upstream's token endpoint when token exchange is configured, which supports certificate-bound downstream tokens when the issuer and resource server bind them according to RFC 8705. Keep certificate/key material in a secret manager and bind it separately to the exact upstream and token endpoint in strict deployments.

Some important integrations (including many Jira, Gmail, Drive, and Slack deployments) require user-consented OAuth authorization-code flows, refresh-token lifecycle, per-user account linking, or vendor-specific headers. Relay does not currently provide a built-in interactive upstream account-linking screen or a general OAuth authorization-code token vault. A deployment can implement a `CredentialProvider` plugin for user/tenant-scoped tokens and a transport plugin for specialized handshakes; otherwise use an upstream-supported service credential where its vendor policy permits. Do not assume that one organization-wide token preserves each user's native product permissions.

AWS integrations may be stdio processes using the AWS SDK credential chain, or remote MCP endpoints with their own authentication model. The operator must configure narrowly scoped AWS roles/credentials at the process or identity-provider boundary. Relay does not turn a generic bearer token into AWS SigV4 credentials.

For bearer credentials, use distinct secret references per upstream and enable strict destination bindings. The gateway resolves and attaches an outbound secret only for its approved endpoint. Static credentials are shared by callers of that upstream; use token exchange or a per-principal credential plugin when user-level vendor permissions are required. Management keys must remain separate from both sets of credentials.

## Safe local examples

`npm run demo` launches synthetic Jira, AWS/CloudWatch, Gmail, Slack, Drive, logs, GitHub, Calendar, read-only database and observability MCPs in addition to legacy/modern protocol fixtures. A linked incident dataset connects OPS-204 to service resources, mail, chat, runbooks, logs, a pull request, a calendar event, a read-only record and a trace. Preview-write tools never contact vendor services or mutate fixture data. `enterprise_search` demonstrates a priority route to one configured eligible target, not fan-out. Use the [interactive scenario lab](../website/lab.html) or `npm run demo:call` to connect with a real MCP client. OAuth token exchange, mTLS and external approvals require deployment credentials or services and are clearly labeled as local/configuration walkthroughs.

The integration test starts these upstreams and a real MCP gateway, discovers their tools, calls product-shaped operations, verifies alias routing, and checks prompt/resource aggregation. It proves protocol interoperability for these fixtures, not authentication compatibility with each vendor's production deployment.

## References

- [MCP 2026-07-28 specification announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/) describes Streamable HTTP headers, multi-round-trip requests, list caching, and the Tasks extension.
- [Official MCP TypeScript SDK documentation](https://ts.sdk.modelcontextprotocol.io/) lists Streamable HTTP, legacy SSE, stdio, tools, resources, prompts, sampling, elicitation, and tasks.
- [Atlassian MCP server documentation](https://atlassian.github.io/atlassian-mcp-server/) documents its remote MCP server and OAuth/API-token options.
- [AWS Labs MCP server catalog](https://github.com/awslabs/mcp) illustrates the range of AWS domain servers, local processes, and cloud-managed MCP endpoints.
- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) requires audience-bound resource tokens and explicitly prohibits MCP servers accepting or transiting tokens issued for other resources.
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) explains token-passthrough and confused-deputy risks.
- [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html) defines subject/actor token exchange; [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) defines resource indicators; [RFC 8705](https://www.rfc-editor.org/rfc/rfc8705.html) defines client-certificate authentication and certificate-bound tokens; [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) recommends sender-constrained tokens.
- [Identity Dilution in Multi-Hop MCP Architectures](https://arxiv.org/abs/2608.10760) highlights the user/service identity distinction and token-exchange patterns; it is an emerging research preprint, not a normative standard.
