# Validation record — version 0.7.0

Executed locally on 17 October 2026 with Node.js 22.14.0 on Windows and Docker Desktop. Historical records remain in [validation-v0.6.md](validation-v0.6.md) and [validation-v0.5.md](validation-v0.5.md). The [research review](expansion-review.md), [pre-implementation plan](expansion-plan.md) and [ten-gateway comparison](gateway-landscape.md) describe evidence boundaries.

| Check | Result |
|---|---|
| Strict TypeScript build and declaration output | Passed |
| Core/protocol/security/extension tests | **70 passed**, 0 failed, 0 skipped |
| Chromium administration workflows | **6 passed**, 0 failed, 0 skipped |
| Real PostgreSQL/OpenFGA integration tests | **4 passed**, 0 failed, 0 skipped |
| Deployment/CI YAML and JavaScript syntax | Passed |
| Release container build | Passed; install audit reported 0 vulnerabilities at execution time |
| Hardened container acceptance | Passed, including authorized search, actual stdio calls, argument denial, publication/revocation and audit |
| Two-replica local Kubernetes acceptance | Passed: two replicas, shared state, recovery and actual prior-image rollback/promotion |
| External model benchmarks / exhaustive MCP conformance / cloud deployment | Not executed |

**80 automated tests**, excluding the separate container/Kubernetes acceptance scripts. Individual scenarios inside a test are not counted as extra tests. No competing runtime was benchmarked. These results do not establish zero bugs, exhaustive protocol compliance or universal prompt-injection resistance.

## New boundaries tested

* A pinned physical definition cannot be bypassed through an independently unpinned alias during discovery or execution.
* Inspectors see frozen credential-free snapshots. Denial, timeout, malformed verdicts, exceptions and mutation attempts fail closed. Earlier declarative authorization still blocks before an inspector can allow anything. Concurrent calls remain isolated and later inspectors do not run after a veto.
* Output withholding leaves exactly the recorded upstream effect and issues an explicit no-blind-retry warning. Pending modern callback results also pass through result inspection.
* Discovery follows raw upstream pages with aggregate candidate/scan/byte limits and bounded concurrency. Overflow errors never masquerade as a complete truncated catalog. Search applies the same fresh visibility/pin checks, literal matching, result limits and durable admission.
* Opaque cursors work between independent replicas and fail for another caller, changed metadata, changed query or configuration revision. The actual PostgreSQL test transfers a page between runtimes and verifies invalidation after publication.
* Schema-derived headers cover nested strings, zero integers and false booleans; unsafe Unicode/control values encode safely. Invalid/duplicate/composition annotations, non-safe integers, malformed Base64 and invalid UTF-8 fail. A real call verifies outgoing headers; a mismatched modern ingress returns HTTP 400 and MCP -32020 with no additional tool execution.
* Rendezvous selection is stable under target reordering and additions/removals, and biases assignments by weight. All built-in strategies exclude foreign-tenant candidates. Unknown strategies, duplicate targets and unsupported plugin API versions are rejected.
* Chromium publishes/reloads discovery limits and search enablement, follows multi-page discovery, and searches with a real service identity. Existing traffic, route, history, audit and tool-pin workflows still pass.

## Corrections found during iteration

An initial ToolNet identifier resolved to an unrelated astronomy paper; the primary-title check rejected it and the correct full text replaced it. The unrelated paper is not counted among the 50. SecAlign/Reflexion original-version titles are distinguished from later names.

The pagination test first showed that the SDK convenience list method auto-aggregated pages. The collector now uses raw request pages so it can enforce budgets before continuing. This required preserving parameter-header validation explicitly rather than relying on the convenience method's filtering. The pinned SDK has a documented number-annotation discrepancy; Relay follows the primary spec's supported primitive types. Another test found low-level dispatch returning HTTP 200 for a header error; the response status is now corrected to 400. See catalog-and-routing.md for scope and unsupported nullable union annotation types.

## Reproduce

```sh
npm ci
npm run build
node --test test/*.test.js
node --test --test-timeout=30000 integration/browser.test.js
docker compose -f deploy/compose.test.yaml up -d --wait postgres openfga
# Set TEST_DATABASE_URL and TEST_FGA_URL to the disposable services in local-deployment.md.
node --test integration/services.test.js
node scripts/check-deploy.js
docker build -t relay-gateway:0.7.0 .
node scripts/container-smoke.js
# An explicit dedicated kind-relay-validation kubeconfig and actual 0.6/0.7 images are required:
node scripts/kubernetes-smoke.js
```

Service tests truncate gateway tables. Use only disposable integration data. The Kubernetes script creates/deletes a random namespace; remove the dedicated cluster separately. Source archives exclude node_modules, credentials, databases, logs, paper bodies and intermediate research files.

## Practical limits

Inspectors are trusted in-process extensions with cooperative cancellation, not a CPU/process sandbox. They cover tools, including pending results, not every prompt/resource phase. A withheld result cannot reverse effects. Literal HTTP search is not semantic retrieval and does not inject a new MCP method. Cursors are selection hints, not authority. Single primitive parameter-header types are supported; nullable union annotations remain outside this tested scanner.

Interactive OAuth consent, independent human approval, signed workload admission, model memory/provenance, API conversion and full workload orchestration remain staged designs. This smoke-scale validation is not a throughput benchmark, production collector soak, HPA/multi-node availability test or cloud certification. Read the comparison before making any claim of uniqueness or across-vendor superiority.

## Final release acceptance

All 80 tests passed again after the duplicate-parameter-header correction (70 core, 6 Chromium, 4 PostgreSQL/OpenFGA; no failures or skips). Duplicate wire header lines now fail with HTTP 400 / MCP -32020 without executing the tool. Deployment syntax and the hardened final-image container check also passed.

The final v0.7 image manifest-list digest was `sha256:3fce9322044ff2217e4a05fe08d9031da145c3f46dda12a84c70f8b4bf898338`. Dedicated kind 0.33.0 / Kubernetes 1.34.11 acceptance passed: two ready replicas, actual MCP calls, shared quota, revocation and audited restoration; reviewed pins, argument denial, cross-pod cursors, rendezvous and authorized search; surviving-pod service during replacement; database outage denial and recovery with revision 6; actual v0.6 image rollback and v0.7 promotion after restoring a compatible configuration. This is a single-node smoke environment, not a multi-node availability or capacity certification.

The existing local demo was upgraded to v0.7 and readiness retained revision 5. Its existing database, keys and configuration were preserved; optional search was not automatically enabled.
