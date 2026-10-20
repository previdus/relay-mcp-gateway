# Interactive demo lab

The lab uses one deterministic, synthetic incident dataset behind ten small MCP servers. All records are local fixtures. Search, reads, trace inspection and cloud-log queries never contact vendor services. Write-shaped actions such as creating a Jira issue, drafting mail, posting Slack text, creating a calendar event, or commenting on a pull request return `preview: true` and do not mutate the dataset.

The records share incident tags so a user can follow one story across products:

| Demo service | Try this tool | Synthetic sample |
|---|---|---|
| Jira | `jira__search` with `checkout` | OPS-204: Checkout API elevated error rate |
| AWS / CloudWatch | `aws__search` with `us-west-2`; `aws__cloudwatch_logs` with `contains: retry` | demo-worker in us-west-2; bounded retry budget warning |
| Gmail | `gmail__search` with `credentials` | Mail 118: Credential rotation window |
| Slack | `slack__search` with `checkout` | Incident bot links OPS-204 to the checkout deploy |
| Drive | `drive__read_file` with `runbook-checkout` or `runbook-mtls` | Synthetic checkout or certificate runbook |
| Application logs | `logs__query` with `service: checkout-api`, `severity: error` | Log 204a: upstream timeout |
| GitHub | `github__list_pull_requests` with `acme/checkout` | PR-204: bounded upstream retry budget |
| Calendar | `calendar__list_events` | Incident review and certificate-rotation events |
| Read-only database | `database__get_record` with `order-demo-17` | Synthetic order state; there is no arbitrary SQL tool |
| Observability | `observability__get_trace` with `trace-204` | Error trace with bounded synthetic span summary |

## Use the hosted gateway from Codex

Open [the interactive lab](../website/lab.html), set the URL shown for the deployed demo, choose **Read-only explorer**, and copy the Codex entry into `~/.codex/config.toml`. The example contains a public demonstration key for synthetic data only. Never replace it with a real product credential or reuse these keys in another deployment.

After restarting/reloading the MCP server in Codex, ask it to search Jira for `checkout`, read `runbook-checkout`, or inspect `trace-204`. The public gateway uses Streamable HTTP and exposes a real MCP endpoint; the website animation explains the call path but does not fake or proxy the result. The gateway's response comes from the synthetic backend.

The **Read-only explorer** can list and call search/read tools. The **Preview-write operator** can call write-shaped demo tools, which only return previews. The negative tests switch the configured key to a deliberately invalid value or attempt a preview-write tool with the read-only key. MCP clients filter unavailable tools during discovery, so a read-only caller may not see the denied tool in Codex; use an MCP client/Inspector capable of sending a direct `tools/call` to observe the gateway's execution-time denial.

Codex supports remote MCP servers in `config.toml` with a URL and HTTP headers. Example:

```toml
[mcp_servers.relay_demo]
url = "https://YOUR-APP-RUNNER-URL/mcp"
http_headers = { Authorization = "Bearer relay-public-reader-demo-token" }
```

For a local demo, start `npm run demo`, use the service key printed by the local process, and change the URL to `http://127.0.0.1:3000/mcp`. Local service keys are randomly generated on each start. Loopback HTTP is for local development only.

## Call it directly from a terminal

The repository includes an MCP SDK client so users can list tools or call a specific operation without an agent UI:

```powershell
$env:MCP_DEMO_URL = "https://YOUR-APP-RUNNER-URL/mcp"
$env:MCP_DEMO_TOKEN = "relay-public-reader-demo-token"
npm run demo:call -- --list
npm run demo:call -- --tool jira__search --args '{"query":"checkout"}'
```

To check the negative auth path, set the token to an intentionally invalid value and run `npm run demo:call -- --list`; the MCP client reports the gateway's authentication rejection. To check permissions, use the reader key and directly call `github__preview_review_comment`; the gateway denies the invocation before any upstream effect. Change to the operator key to observe that this operation is only a preview.

## Security scenarios and boundaries

The lab separates end-to-end runnable demo paths from architecture walkthroughs:

| Scenario | Status | What it demonstrates |
|---|---|---|
| Authorized search/read | Runnable against hosted or local gateway | MCP discovery, grants, routing and synthetic results |
| Read-only denial | Runnable using direct MCP call | Catalog filtering and per-call authorization before upstream dispatch |
| Invalid credential | Runnable using direct MCP client | Authentication rejection at the gateway |
| Priority route | Runnable using `enterprise_search` | One configured eligible backend is selected; it is not fan-out aggregation |
| OAuth resource/actor-token exchange | Configure with a test issuer | Delegation and audience restriction; issuer and OAuth credentials are deployment-owned |
| Wrong OAuth audience | Local/test issuer; use a JWT addressed to a different resource | Authentication and exchange fail before an upstream credential is issued |
| Agent mTLS and upstream mTLS | Local certificate-backed tests and deployment guide | Two separate TLS connections; client private key is not forwarded |
| Missing or untrusted mTLS certificate | Local listener test with no peer certificate or wrong CA | TLS handshake is rejected before MCP request parsing or upstream dispatch |
| Human approval | External approval adapter required | Exact caller/tool/route/argument binding and one-use permit; the project does not ship the reviewer portal |
| Metadata drift / tool poisoning | Pin/review paths and test fixtures | Tool definitions can change; a metadata hash is change detection, not proof of benign intent |

Run `npm run test:mtls` for the focused mTLS exercise. It builds Relay, starts a local HTTPS gateway with test-only certificates, and checks trusted, missing, untrusted, and mixed bearer/certificate cases. The hosted demo does not accept visitor certificates. These certificates are test fixtures; use certificates issued by your own test CA for deployments.

MCP's authorization specification requires the token audience to match the resource and the MCP Security Best Practices warn against token passthrough and confused-deputy behavior. [MCPTox (AAAI 2026)](https://ojs.aaai.org/index.php/AAAI/article/view/40895) evaluates tool poisoning against real MCP servers and tools. [Breaking the Protocol (arXiv preprint)](https://arxiv.org/abs/2601.17549) studies capability claims and trust propagation risks; it is emerging research, not an MCP normative requirement. The lab treats these as adversarial test motivations, not claims that metadata scanners can detect every malicious instruction.

See the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices), and [enterprise credential boundary guide](enterprise-security.md) for protocol requirements and production setup.
