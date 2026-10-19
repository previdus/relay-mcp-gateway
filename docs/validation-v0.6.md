# Validation record — version 0.6.0

Executed on 17 October 2026 on Windows with Node.js 22.14.0 and Docker Desktop. Historical v0.5 evidence is retained in [validation-v0.5.md](validation-v0.5.md).

| Check | Final result |
|---|---|
| Compiled strict TypeScript build | Passed |
| Core/protocol/security regression suite | **54 passed**, 0 failed, 0 skipped |
| Chromium administration workflows | **5 passed**, 0 failed, 0 skipped |
| Real PostgreSQL/OpenFGA integration suite | **4 passed**, 0 failed, 0 skipped |
| Deployment and CI YAML syntax | Passed |
| v0.6 image build | Passed; dependency installation reported 0 vulnerabilities at execution time |
| Hardened container acceptance | Passed, including argument-policy rejection and approved stdio call |
| Two-replica local Kubernetes acceptance | Passed, including new policies, pod/database recovery and compatible v0.5 rollback/v0.6 promotion |
| Exhaustive official MCP conformance / model benchmark / cloud deployment | Not executed |

Total automated test cases: **63**, excluding the separate container and Kubernetes acceptance scripts. Nested adversarial scenarios are not inflated into additional test counts. These tests use actual SDK client/server calls and disposable services; passing them does not establish absence of bugs, universal prompt-injection protection or competitor superiority.

## Reproduction

```sh
npm ci
npm run build
node --test test/*.test.js
node --test --test-timeout=30000 integration/browser.test.js
docker compose -f deploy/compose.test.yaml up -d --wait postgres openfga
# Set TEST_DATABASE_URL and TEST_FGA_URL to the disposable services, as documented in local-deployment.md.
node --test integration/services.test.js
node scripts/check-deploy.js
docker build -t relay-gateway:0.6.0 .
node scripts/container-smoke.js
# Explicit isolated kind-relay-validation kubeconfig and loaded 0.5/0.6 images required:
node scripts/kubernetes-smoke.js
```

Integration tests truncate gateway tables; use only the documented disposable test database. Tests must never be pointed at production. The local Kubernetes script creates/deletes its own randomized namespace. The cluster is separately disposable and should be removed after acceptance.

## New evidence

Argument-policy regressions exercise exact values, membership, inclusive ranges, string/number confusion, missing identity/fields, nested paths and inherited-property rejection. Actual payment fixtures assert that two legitimate actions occur and six forbidden variants make zero further upstream requests. Policies cannot grant access denied by the tool ACL. Public-alias and physical-target restrictions intersect. Legacy clients use the same enforcement, and an already issued modern continuation is denied when its next gateway applies a restrictive policy.

Catalog tests reject unpinned definitions during listing and direct invocation, block hidden ANSI/C1/bidirectional controls even for a matching hash, permit ordinary multilingual text, and retain existing drift detection. Chromium validates malformed drafts and publishes/reloads valid policies. PostgreSQL tests publish an argument restriction through one store and verify it on both independent runtime instances, with approved calls still succeeding. Existing OpenFGA grants/group revocation, shared quotas, leases, transactional audit/history, transports, schema budgets, tracing and authentication remain covered.

The hardened container runs as UID 1000, with a read-only root filesystem, dropped capabilities, no privilege escalation and a writable temporary data mount. It performs real stdio discovery/execution, blocks an unapproved argument, publishes revocation and reads audit metadata. The final v0.6 image is `sha256:41e591a5c959088e724ef0fdf73631ba429c88154fba861ee4b0679015f9e1d1` (local image manifest list; registries can assign a different digest on push).

## Limits

This is a smoke-scale functional/security suite, not a throughput, statistical model safety, multi-node availability or exhaustive protocol certification. No external research benchmark was reproduced. Interactive OAuth, independent human approvals, signed upstream images, code sandboxing and workflow provenance remain staged as documented in the research plan. The live demo was upgraded without changing its revision-5 configuration; new controls are opt-in.

## Kubernetes acceptance — final

Passed on an isolated kind 0.33.0 cluster with Kubernetes 1.34.11 and PVC-backed PostgreSQL 17. Two non-root gateway pods performed actual stdio MCP calls. Twelve concurrent calls consumed one shared three-call quota; cross-pod revocation and audited configuration rollback passed. Both pods then enforced the new reviewed catalog and argument restrictions while approved calls succeeded. The fixture was restored to a configuration without v0.6-only fields before testing older images. Pod replacement preserved service through the other replica, PostgreSQL shutdown caused fail-closed responses, and persistent revision 6 recovered. Compatible v0.5 rollback and v0.6 promotion succeeded. Namespace and cluster cleanup followed.

An initial kind multi-platform image import failed on a missing content digest. Exporting the existing local images for linux/amd64 and loading that archive corrected the fixture preparation. This was an image-loading issue, not an application pass. As in the prior validation, this host uses cgroup v1 and required the compatible 1.34 node image. The test is one local node and does not prove multi-node, ingress/TLS, HPA or cloud availability.
