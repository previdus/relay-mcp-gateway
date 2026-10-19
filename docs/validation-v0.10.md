# Validation record — v0.10.0 enterprise destination-security checkpoint

Executed 17 October 2026 on Windows with Node.js 22.14 and Docker Desktop 29.8.2. The release focuses on preventing configurable credentials from reaching unintended destinations. Test counts are executable test cases, not proof of universal correctness or production readiness.

| Check | Result |
|---|---|
| TypeScript no-emit check and production build | Passed |
| Full core, protocol, auth, security, routing, telemetry and deployment-manifest suite | 100 passed; 0 failed, cancelled, skipped or todo |
| Chromium administration workflows | 8 passed; 0 failed or skipped |
| Real PostgreSQL/OpenFGA integration | 4 passed; 0 failed or skipped |
| Docker build and dependency audit | Passed; npm reported 0 vulnerabilities in both build/runtime installs |
| Hardened container acceptance | Passed: readiness, console, auth, stdio MCP discovery/call, policy update/revocation, audit, non-root and read-only filesystem |
| Kubernetes two-replica acceptance | Not run: this environment had no configured Kubernetes context and no `kind` executable. The test refuses to target an unspecified cluster. |
| Local demo | Updated to v0.10.0 after validation; stored revision and demo keys preserved; MCP discovery and call verified |

The 100-case core suite includes deployment-bound destination tests for pre-read denial, admin repoint rejection, strict parsing and exact URL matching, OAuth issuer/recipient separation, SSE message path allowlists, stdio executable binding, OpenFGA and introspection operations, OTLP endpoint/credentials/client identity, redirect refusal, blocked host/hop-by-hop headers, and plugin context redaction. A manifest test checks the current Kubernetes image version, two-replica baseline, non-root/read-only settings, probes, and autoscaler. Browser tests cover editing and publishing SSE `requestPaths`.

Across core, browser, and live service integration, 112 tests passed (100 + 8 + 4). The container smoke is an additional deployment acceptance script, not included in that test-case sum.

Final v0.10 image manifest digest: `sha256:2206a9151f9d7064e0f46a7c982eb05d0c235504ac903fe608b961039aa262cd`.

The following remain release gaps: a real Kubernetes rollout/rollback on a dedicated cluster; production load and soak limits; DNS/IP and metadata-range enforcement at the network layer; native AWS/Azure/GCP/OCI vault adapters; sandboxing untrusted extensions; multi-cloud certification; independent penetration testing; and the unfinished 200-article/40-cycle research programme. Strict destination binding is opt-in for compatibility and must be enabled by the operator with `GATEWAY_REQUIRE_CREDENTIAL_BINDINGS=true` and a deployment-owned policy. An exact URL does not constrain DNS resolution or a compromised trusted plugin.
