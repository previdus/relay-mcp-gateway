# Component research and hardening plan — 17 October 2026

This is a new work programme following v0.7. Previous research counts do not count as completion of this request. The requested target is four areas, ten papers and fifty articles per area, ten review iterations per area, and a fresh comparison of ten commercial gateway offerings. Standards and reference documentation will be identified separately from research papers and editorial articles. Search results and downloads alone are not reviewed sources. Selection is relevance based, not a verified ranking of worldwide research or products.

## Areas and acceptance

| Area | Questions | Acceptance boundaries |
|---|---|---|
| Agent authentication | Service keys, OAuth resource-server JWTs, opaque token introspection, workload identity, delegated users; issuer/audience/type/lifetime/tenant binding; key rotation and revocation | Explicit mechanisms; no credential fallback/downgrade; verified identity maps to administrator-managed grants; strict endpoint trust and bounded responses; no token logging; negative and live HTTP tests |
| Authorization | Allow lists, RBAC, ReBAC, argument predicates, aliases, prompts/resources, callbacks, tenant isolation | Deny-by-default intersection; authority cannot be granted by routing or model assertions; relationship checks use trusted identity and pinned models; fail closed on service faults; discovery does not disclose forbidden definitions |
| Routing | Direct names, aliases, weighted selection, affinity, membership stability, tenant/agent selectors, canary/priority, plugin trust | Authorize public and physical constraints; deterministic selection tests; eligible targets only; routes cannot expand identity/tenant authority; no unsafe effect replay |
| Protocol/reliability | Modern/legacy MCP HTTP, SSE upstreams, stdio, cancellation, deadlines, response size, fan-out, retry semantics, circuit breakers | Standard MCP behavior and explicit unsupported protocols; separate time budgets; cancellation and resource cleanup; retries only where semantics prove safety; database outage/revocation behavior |

## Ten review iterations per area

1. Inventory current behavior and threat model.
2. Verify normative protocol/identity contracts.
3. Review deployment and tenant trust boundaries.
4. Review policy/configuration ergonomics and validation.
5. Review malformed input and bounded resource use.
6. Review cancellation, dependency failures and recovery.
7. Review cross-replica consistency and revocation.
8. Review extension points and interaction with other areas.
9. Review operational visibility without secrets/payload leakage.
10. Re-run acceptance and document residual gaps.

Each actual iteration must record the question, evidence reviewed, decision, source/code changes, tests, and next unresolved question. These are planned iterations, not a claim that forty reviews have happened. Research may reject a feature: SAML login belongs at an identity provider, agent planning belongs outside the data plane, and side-effect retries require backend idempotency rather than a tool annotation alone.

## ReBAC decision

The gateway already has an OpenFGA adapter composed with local allow lists/RBAC and verified identities. ReBAC makes sense for organization/project/group-to-tool relationships shared across applications. Backend record ownership is usually better enforced by the backend unless a deliberate trusted argument-to-resource policy is designed. Do not duplicate OpenFGA or infer relationships from caller claims. Assess endpoint trust, bounded decision responses, tenant namespacing, model pinning, consistency, outages and real group revocation tests before expanding scope.

## Delivery gates

Publish source-by-source status, distinguishing candidates, retrieved, substantively reviewed, and rejected. Publish implementation and validation evidence separately from research counts. Preserve v0.7 archives and live configuration. Run core, browser and service integration checks for affected behavior, then container/Kubernetes acceptance when deployment changes warrant it. Do not claim all authentication mechanisms, protocols, literature or commercial capabilities are implemented merely because adapters are extensible.
