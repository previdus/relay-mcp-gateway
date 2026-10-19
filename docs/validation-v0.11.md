# Validation record — v0.11.0 external policy checkpoint

Executed 17 October 2026 on Windows with Node.js 22.14 and Docker Desktop 29.8.2. This release adds an optional, fail-closed OPA Data API authorizer. The evidence distinguishes local HTTP fixtures from a real OPA server and from production fleet validation.

| Check | Result |
|---|---|
| TypeScript no-emit check and production build | Passed |
| Full core, protocol, auth, routing, security, telemetry and manifest suite | 105 passed; 0 failed, cancelled, skipped or todo |
| Chromium administration workflows | 8 passed; 0 failed or skipped |
| Real PostgreSQL/OpenFGA/OPA integration | 5 passed; 0 failed or skipped |
| OPA integration server | Official `openpolicyagent/opa:1.19.1`; Rego decisions gated actual MCP discovery and calls |
| Deployment and CI YAML checks | Passed |
| Docker build and dependency audit | Passed; npm reported 0 vulnerabilities in both build/runtime installs |
| Hardened gateway container acceptance | Passed: readiness, console, authentication, stdio call, policy publish/revocation, audit, non-root and read-only filesystem |
| Kubernetes two-replica rollout/rollback | Passed in a dedicated kind v0.33.0 cluster on Kubernetes v1.34.11; two replicas, shared state, replacement, DB outage/recovery, v0.10 rollback and v0.11 promotion |
| Local demo | v0.11.0; previous SQLite revision/configuration and demo keys preserved; MCP discovery and call verified |

The OPA unit/integration fixtures check exact-boolean grants, identity minimization, no token or argument disclosure, absent/malformed/oversized/unsuccessful response denial, redirects, timeout, endpoint policy pinning, and OPA composition with local grants. The service test uses actual Rego in the pinned OPA image and verifies tool discovery, a successful tool call, direct-call denial, and resource decisions. The gateway still uses all-of semantics: OPA cannot grant past the configured local allowlist.

Across core, browser, and service suites, 118 automated test cases passed (105 + 8 + 5). The separate hardened-container and Kubernetes acceptance suites also passed. Kubernetes used the pinned node image `kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d`; the test used the actual v0.10 image for rollback and then promoted v0.11. The isolated test namespace was removed after the run.

Final v0.11 image manifest digest: `sha256:5003e15a3d7ad8ff35481a2c5407a24eb32a100b213ec5e26dd9708f80e326e9`.

The live demo preserves its existing compatible sample settings; deployment strict credential binding is not enabled in that sample environment. Follow `docs/enterprise-security.md` when configuring a production deployment.

Remaining gates include production OPA latency/soak tests, network-level DNS/IP and metadata-range controls, cloud vault adapters, admin SSO/role review, plugin isolation, independent penetration testing, and the unfinished literature programme (25/200 articles and 5/40 research cycles). OPA policy distribution and management remain operator responsibilities. The Kubernetes result covers this isolated single-node local cluster and does not establish multi-node or cloud-provider behavior, universal feature completeness, or absence of bugs.
