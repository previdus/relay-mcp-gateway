# Research implementation plan — 17 October 2026

Status at publication: research reviewed; application implementation has not started. This plan precedes source changes. See [the annotated review](research-review.md) for 20 articles and 10 papers, including limitations. This is a bounded release plan, not a claim that every possible gateway feature is enumerated or that research results transfer automatically.

## Objectives and acceptance

1. Restrict **which arguments** an authenticated caller may send, in addition to existing tool grants, roles, tenant boundaries and OpenFGA checks. A grant must never override another protection.
2. Let administrators require reviewed, pinned definitions before exposing tools. Detect display-control characters without pretending to detect all natural-language prompt injection.
3. Demonstrate permitted utility and blocked side effects against actual MCP fixtures. No model-generated transcript is accepted as execution evidence.
4. Preserve standard MCP wire messages, existing transports, configuration revision control, secret references, audit privacy and horizontal deployment.

## Planned release work, in dependency order

| ID | Work | Sources | Acceptance evidence |
|---|---|---|---|
| R1 | Add a bounded declarative argument policy module, separate from routing and identity authorization | P02, P08, P09 | Strict configuration rejects malformed rules, excessive size, unknown operators and empty permissions |
| R2 | Policies keyed by exact public or physical tool name. Within a policy, allow if any rule matches; each rule requires every constraint. No matching rule means deny. Policies for alias and resolved physical tool both apply | P02, P08 | Test direct calls, aliases, wrong clients, missing fields, nested fields, number/string confusion and conflicting restrictions |
| R3 | Support scalar equality, scalar membership, finite numeric ranges, and equality with authenticated client ID/tenant ID/subject. Fields use bounded arrays of literal object keys; own properties only. No scripts, regexes, coercion, inferred intent or caller-supplied identity | P08, P09 | Boundary, prototype-property, absent-identity and nested-object cases; no mutation of arguments |
| R4 | Enforce immediately after authenticated route/tenant checks and before opening an upstream connection; apply again on every continuation request through the same handler | P02, P07, P08 | Denied calls produce zero upstream invocations; continuation tests remain passing |
| R5 | Add optional catalog controls requiring an existing definition pin and rejecting ANSI/control/bidirectional display characters in metadata, checked during discovery and direct execution | A12, A14, A15 | Unpinned, changed and hidden-control definitions are unavailable; normal multilingual text stays usable |
| R6 | Add an administration panel for these settings, with validation before adding to draft and the existing conditional publish flow | P02, A15 | Browser test edits safeguards, validates, publishes and reloads persisted settings |
| R7 | Add deterministic adversarial integration scenarios with paired legitimate actions and assertions on upstream state; keep security outcomes separate from utility outcomes | A01, A06, P04, P05, P06 | Allowed recipient/amount succeeds; recipient substitution, excess amount, wrong principal and alias bypass fail without side effects |
| R8 | Document policy semantics, examples, operator responsibilities, trust boundaries, deployment compatibility and research-to-feature mapping | all | Reviewer can reproduce tests and identify deferred work without reading this chat |

## Architecture and configuration details

`invocationPolicies` is a map from exact tool names to `{allow: [...]}`. A rule contains optional exact client IDs and a nonempty list of constraints. Empty `allow` deliberately disables invocation of that tool. Rules grant no access by themselves: normal authentication and tool authorization must already pass. Tools without a policy retain current behavior. Define restrictive policies for all sensitive tools; strict catalog enrollment does not imply an argument policy exists.

Policies constrain JSON values the gateway observes. They cannot prove a recipient owns a mailbox, resolve filesystem symlinks, constrain SQL embedded in strings, or stop a malicious upstream from ignoring arguments. Use narrow upstream APIs and destination-specific enforcement. No automatic changes to a caller's request or upstream schema. Restricting a discovered tool's possible calls is compatible with MCP; these are gateway configuration fields, not new MCP methods.

The module has no network access, mutable session state or executable rules. Bound policy count, rule count, constraints, key depth, names and literal sizes. Validate both raw configuration ingestion and programmatic gateway construction. Use deterministic comparisons and fail closed for missing values or identity claims. Audit only ordinary request metadata and denial outcome; do not add arguments or policy values to logs/traces.

## Persistence, rollout and rollback

Existing SQLite/PostgreSQL configuration documents already store JSON; no SQL schema migration is necessary. New fields use the same revision-controlled publication, history and rollback validation. Test persistence through the real PostgreSQL runtime, not only module calls. Multi-replica behavior follows the existing request-time configuration revision refresh.

Defaults are backward compatible and opt-in. First review and pin definitions with strict catalog mode disabled; publish pins; then enable strict enrollment. Disabling a safeguard is a security-relevant administrative change. Prior binaries have strict configuration schemas and cannot read these new fields: before rolling back to v0.5, explicitly publish a compatible configuration and assess the removed restrictions. Do not present a mixed-version rollout carrying v0.6 policy fields as safe. Deploy a parallel v0.6 pool and switch traffic only after validation, or use a maintenance window. Never silently drop policies for old replicas.

## Verification sequence

1. Compile/type-check after implementation. Run focused policy and catalog tests, then the complete core suite.
2. Run Chromium administration tests, including new policy editing.
3. Run real PostgreSQL/OpenFGA integration tests, including persisted policy enforcement and policy changes across runtime instances. Disposable service data only.
4. Build and run the hardened container smoke test and deployment manifest checks. Record Kubernetes evidence separately; do not relabel prior-release evidence as current-release validation.
5. Inspect failures, fix causes and repeat affected checks. Record exact counts, commands, environment and limitations in release evidence. Passing finite tests does not establish absence of bugs or universal prompt-injection resistance.

## Deliberately staged work

| Follow-on | Why not part of this release | Required design/test gate |
|---|---|---|
| Durable human approval | A UI confirmation alone is not secure authorization | Independent approver identity; one-use transactional consumption; tenant/caller/tool/arguments/route/revision/expiry binding; concurrent replicas; cancellation; timeout ambiguity; no promise of upstream exactly-once effects |
| Workflow information-flow enforcement | CaMeL and toxic-flow analysis need reliable provenance and an agent execution model the gateway does not possess | Trusted plan/data separation, provenance propagation, cross-tool/session tests, privacy review, explicit threat model |
| Code-mode execution and tool search | Context efficiency is useful, but arbitrary code adds a new execution boundary | Separate sandbox, egress/CPU/memory/time limits, per-call gateway mediation, authorized discovery, measured latency/token benefit; preserve ordinary tools/list |
| Automatic retry/idempotency | A gateway cannot infer whether a timed-out side effect happened | Explicit upstream idempotency contract; caller token + parameter binding; durable results; late-arrival and crash tests |
| Broad DLP/classifier filtering | Encodings and legitimate secrets create false negatives/positives | Pluggable engine, data handling agreement, adversarial corpus, utility measurement; no security guarantee from regex scanning |
| Signed catalog/image admission | Metadata pinning is not executable provenance | Registry/verifier integration, trust roots/revocation and admission policy tests |
| Interactive user OAuth and administrator SSO | Existing service JWT and token exchange do not implement the entire delegated consent lifecycle | OAuth conformance, PKCE/state/resource binding, tenant credential vault, consent/revocation and role-separated administration |
| Full autonomous delivery controller | Agent-driven development is a separate control plane | Isolated workers, protected requirements/tests, bounded budgets, independently checked artifacts, deployment identities and approval gates |

Existing controls retained: all-of authorization/OpenFGA, tenant routing, bounded schema validation, egress restrictions, credential references, request admission audit, rate/concurrency controls, circuit breakers, configuration history, tracing, modern/legacy HTTP, SSE and approved stdio. These still require operational configuration; their presence does not imply every deployment is secure.


## Execution outcome

R1–R8 were completed after this plan was published. The implementation, examples and limits are in [action-safeguards.md](action-safeguards.md). Final verification passed 54 core, five Chromium and four real-service tests, plus separate hardened-container and two-replica Kubernetes acceptance. See [validation.md](validation.md). Staged work above remains staged; the release makes no all-features, zero-bug or universal security claim.
