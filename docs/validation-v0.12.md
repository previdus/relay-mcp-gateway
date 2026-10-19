# Validation record — v0.12.0 strict upstream egress

Executed 17 October 2026 on Windows with Node.js 22.14.0 and Docker Desktop. The application and container acceptance passed in this local environment.

| Check | Result |
|---|---|
| Clean dependency install from lockfile | Passed; 154 packages installed, 0 npm audit findings |
| TypeScript no-emit check and production build | Passed |
| Core, MCP protocol, authentication, routing, egress, policy and security suite | 109 passed; 0 failed, cancelled, skipped or todo |
| Chromium administration workflows | 8 passed; 0 failed or skipped |
| Real PostgreSQL/OpenFGA/OPA integration | 5 passed; 0 failed or skipped |
| Production dependency audit | Passed; 0 vulnerabilities |
| Hardened gateway container acceptance | Passed: readiness, console, authentication, stdio call, policy publish/revocation, audit, non-root and read-only filesystem |
| Kubernetes two-replica acceptance | Passed on kind v0.33.0 / Kubernetes v1.34.11: MCP discovery/calls, shared quotas and revocation, reviewed catalog and policies, cursor routing, budgets/search, pod replacement, database outage/recovery, v0.11 rollback and v0.12 promotion |
| Local MCP performance smoke | Passed at 1, 8, and 16 client sessions with zero call failures; measured scaling is weak and the production performance/soak gate remains open (details in [performance validation](performance-validation.md)) |
| Deployment and CI YAML checks | Passed |

The strict-egress tests make an actual loopback HTTP connection through a deterministic resolver, verify the vetted address is supplied to the connection, and assert denial before connecting for loopback/private, metadata, special-use, and mixed public/private answer sets. They also cover canonical RFC1918/ULA/loopback allowlists and a stalled DNS lookup. Strict credential binding enables this guard; deployments can explicitly enable egress validation without credential binding. Compatibility mode remains permissive unless operators opt in.

The Kubernetes run used the pinned node image `kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d`. Rollback used the actual v0.11.0 image and a compatible test configuration. The disposable namespace and dedicated cluster were removed after the run.

Final v0.12 image manifest digest: `sha256:a7e813a25c40512f6e914318590149c4b527fd2fbce2f507ccc4a009c488586b`.

These results do not establish cloud-provider certification, multi-node failure behavior, maximum throughput, HPA scaling under load, plugin sandboxing, complete outbound control for identity/policy/telemetry/plugins, independent penetration-test results, or absence of bugs. Remaining product gates include representative production perf/soak benchmarks (the smoke sweep showed weak scaling), native cloud secret adapters, deployment-specific network egress policies, admin SSO/role review, plugin isolation, and the incomplete literature programme (25/200 articles and 5/40 research cycles).
