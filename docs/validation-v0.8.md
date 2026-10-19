# Validation record — v0.8.0 component checkpoint

Executed 17 October 2026 on Windows / Node 22.14 and Docker Desktop. Prior evidence remains in [validation-v0.7.md](validation-v0.7.md). These results validate the implemented checkpoint, not completion of the requested research programme or exhaustive protocol certification.

| Check | Result |
|---|---|
| Strict TypeScript build and deployment/CI syntax | Passed |
| Core/protocol/security tests | **80 passed**, 0 failed/skipped |
| Chromium administration workflows | **7 passed**, 0 failed/skipped |
| Actual PostgreSQL/OpenFGA integration | **4 passed**, 0 failed/skipped |
| Final Docker image | Built; fresh install audit reported 0 vulnerabilities at execution time |
| Hardened container acceptance | Passed against final image |
| Two-replica Kubernetes acceptance | Passed, including outage recovery and actual v0.7 rollback/v0.8 promotion |
| External model/paper benchmark reproductions | Not run |
| Multi-cloud, multi-node failure, throughput/soak or exhaustive MCP conformance | Not run |

**91 automated tests**, plus separate deployment acceptance scripts. A complete core run followed the final already-cancelled promise guard. Scenarios within one test are not counted as extra tests.

## New assertions

Bearer extraction rejects duplicate, oversized and malformed credentials. Signed JWT fixtures cover proof binding, invalid tenants, token type/age, ambiguous mappings and separate client_id bindings for agents sharing a subject. Existing signature/issuer/audience/expiry/scope checks pass.

A real local introspection service checks separate Basic credentials, token hints, fresh revocation, wrong audience, scope denial and proof-bound rejection. Security-service parsing rejects oversized streaming bodies and invalid content/document types. OpenFGA fixtures reject oversized, redirected or non-boolean decisions. A real OpenFGA store verifies tuple-v2 grants, distinct ambiguous identities and revocation.

Priority routing checks reorder stability and configured client/tenant/role intersections. Existing weighted/sticky/rendezvous checks pass. Argument forbids override permits, including physical guardrails through aliases. A real MCP request reaches its deadline during credential lookup without creating a later upstream transport. Cancellation fixtures consume late/already-rejected work safely.

Chromium publishes subject/client bindings, selectors/priorities and time budgets; catalog, pin, history, traffic, route and tool-explorer workflows pass. PostgreSQL replica/cursor/revision/policy/shared-budget checks pass.

## Corrections during iteration

The first priority fixture omitted matching upstream tenants and correctly failed the existing tenant boundary; the fixture was fixed. The deadline test initially expected an exception; MCP returns an isError result for this failure, so the assertion now checks the wire result and absence of connection. A broad release-number edit changed a dependency reference; clean container installation caught it. The pinned v0.7 dependency graph was restored, changing only root release metadata. A fresh build/install then passed.

Final image manifest-list digest: `sha256:be359830aee74beb534a90a5fdf8ce0c40d2937969ab4f36b8a12291fe0ce844`.

## Boundaries

See [component-hardening.md](component-hardening.md) for behavior/migration and [component-research.md](component-research.md) for research scope. Forty papers received targeted body-section inspection; **198 additional articles and all forty complete research/implementation/review cycles remain pending**. A source download, selected excerpt or checklist is not counted as a full cycle. No competitor runtime was benchmarked.

DPoP/mTLS verification, interactive consent, workload attestation, cloud identity providers, backend resource ownership, adaptive health routing and effect-safe replay remain separate contracts. Plugins are trusted cooperative code. A timeout cannot undo an effect. Service tokenEnv remains required even when OAuth mode disables key authentication. No zero-bug, universal prompt-injection defense or product-parity claim.

The local demo was upgraded to v0.8 and remained ready at revision 5, preserving its database, keys and configuration.


## Kubernetes final outcome

Dedicated kind 0.33.0 / Kubernetes 1.34.11 acceptance passed: two ready replicas; actual MCP discovery/calls; shared quotas, revocation and audited restoration; deny-overrides argument rules, priority role/tenant selectors, connection/total budgets, pins, cross-pod cursors and search; serving through pod replacement; fail-closed database outage and persistent revision-6 recovery; actual v0.7 image rollback and v0.8 promotion after restoring a compatible fixture. This is a single-node smoke environment, not a throughput, multi-node availability or cloud certification.

