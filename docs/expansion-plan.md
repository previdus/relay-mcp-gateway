# Five-round expansion plan — 17 October 2026

Published before this expansion's application changes. Baseline: v0.6, 63 tests plus separate container/Kubernetes acceptance. This request includes a second audit of the original 30 sources, **50 additional distinct papers in five groups of 10**, followed by a 10-gateway review. Paper selection favors primary full-text work from established research groups, relevance, methodological detail and complementary failure modes; it is not a numerical ranking of researchers. Downloading a paper is not counted as reviewing its methods and limitations.

## Sequence and decision gates

| Stage | Review | Candidate improvements and acceptance |
|---|---|---|
| Original-source audit | Revisit discovery, metadata integrity, complete mediation, bounds, evaluation and deployment findings against implementation | Physical definition pins must also constrain aliases. Test changed definition through both names with zero execution. Identify aggregate discovery resource limits and missing extension points. |
| Round 1 | 10 papers on security boundaries and adversarial agents | Separate pluggable invocation/result inspection from routing. Fail closed on thrown/invalid/timed-out decisions. No LLM verdict treated as authorization proof. Test allowed utility and denied effects/results. |
| Round 2 | 10 stateful evaluation papers | Exercise cross-step/state behavior, failure injection and independent result checks. Keep benchmark-inspired regressions distinct from running a published model benchmark. Cover inspection failures and continuation paths. |
| Round 3 | 10 tool orchestration papers | Keep planner/code execution outside the gateway; consolidate a small typed plugin contract with explicit phase order, immutable snapshots, cancellation and bounded budgets. No automatic side-effect retry. |
| Round 4 | 10 memory/context papers | Bound discovery concurrency, tool count and bytes. Add standard tools/list pagination with identity/catalog binding and stale-cursor rejection. Do not add shared model memory or retain tool payloads as a shortcut. |
| Round 5 | 10 discovery/tool-reliability papers | Add optional authorized catalog search through a distinct management endpoint, not altered tools/list semantics. Reuse the same authorized catalog and pin/tenant checks. Verify search does not reveal inaccessible tools or bypass catalog bounds. |
| Comparative review | 10 gateway products/projects, primary docs/source only; distinguish paid editions and unknowns | Build a feature/evidence matrix. Implement concrete remaining gaps with tests, prioritizing admission limits, extension interfaces, routing flexibility and usable configuration. No claim of uniqueness from undocumented absence. |
| Final verification | Compile; full core/browser/service suites; container and local Kubernetes checks appropriate to changes | Publish exact evidence and an archive, preserve demo data, clean disposable services. Passing finite tests is not zero-bug certification or an across-vendor benchmark. |

## Architectural constraints

Keep authentication, name authorization, tenant filtering, argument policy and metadata pins mandatory. Additional inspectors may only narrow permission or withhold an output. They cannot grant access, mutate arguments, reroute, retry effects or silently rewrite upstream results. Installed in-process plugins are trusted code; a timeout cancels cooperative work but cannot sandbox CPU loops or undo effects. Never persist inspector payloads in audit/traces. Configuration contains bounded options, not executable predicates or arbitrary module paths.

Discovery is a separate component with bounded collection and presentation. MCP pagination remains standard; cursors cannot convey permission. Recompute authorization before returning a page/search result and bind cursors to the authorized catalog, caller and current configuration. Reject overflow with a clear error rather than silently publishing an incomplete catalog as complete. Support replicas without process-local cursor sessions.

New optional fields must be validated through both raw ingestion and programmatic construction. Preserve revision/audit behavior and document older-binary schema incompatibility. Record each round's selected papers, body areas reviewed, findings, limitations, implement/already-covered/defer decision, code and tests. A round may correctly reject a proposed feature if it belongs in the agent runtime or lacks evidence.

## Explicit exclusions from claims

No automatic reproduction of model-training defenses, prompt-injection immunity, untrusted code sandbox, inferred provenance, autonomous privilege grants or inferred backend idempotency. Human approval, interactive user OAuth, signed workload admission and cloud certification still require their separate designs unless this work actually implements and verifies those contracts. Comparative feature coverage alone cannot establish that no one offers a feature or that this gateway outperforms every competitor.


## Research and implementation decisions recorded

The [50-paper review](expansion-review.md) records all five groups, the corrected ToolNet identifier, pinned original titles and source-specific limitations. The [ten-gateway matrix](gateway-landscape.md) followed those rounds. Completed code includes cumulative physical/alias pins, typed veto-only inspectors, bounded collection/pagination, authorized literal search, weighted rendezvous routing and modern parameter-header mediation. The routing addition follows the comparative review; the header correction follows both SDK inspection and primary MCP requirements. Published findings do not assert universal uniqueness or competitor inferiority.

Targeted verification caught and corrected automatic SDK catalog aggregation and dispatch-time header-mismatch HTTP status. Final suite/deployment evidence is recorded in validation.md. Deferred features remain explicit designs; none are silently treated as implemented.
