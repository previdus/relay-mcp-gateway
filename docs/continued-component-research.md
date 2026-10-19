# Continued component research — 17 October 2026

This checkpoint adds 23 selected-body article/chapter reviews to the two previously reviewed reliability essays. Total: 25/200 articles or chapters, 40/40 paper selected-body inspections, 7/40 completed review cycles (the latest two are standards reviews, not articles or papers). Full-paper proof audits and vendor performance reproduction are not claimed. Ten commercial offerings were previously reviewed from primary sources; no new deployment comparison was performed here.

The programme is still incomplete: 40 authentication, 45 authorization, 45 routing and 45 reliability articles/chapters remain, plus 33 cycles. Downloaded candidates are not included in these counts.

## Standards checkpoint: MCP Tasks extension (2026-07-28)

[Primary specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) — draft extension reviewed for capability negotiation, task creation, polling, update, cancellation, status, HTTP routing headers and security considerations.

The extension is not a core MCP requirement and is not implemented or advertised by this gateway. A compatible implementation must only return task handles when the request declares `io.modelcontextprotocol/tasks`, and must durably commit the task before returning its ID. `tasks/get`, `tasks/update`, and `tasks/cancel` require request authentication and authorization; task IDs must be unguessable, and the extension intentionally has no `tasks/list`. Cancellation is cooperative. Persisting a job does not justify replaying a possibly side-effecting upstream call after a crash.

Decision: Keep the extension capability unadvertised until a shared task store, per-operation owner/policy checks, cancellation, expiry/retention, cross-replica retrieval and ambiguous-outcome recovery have executable integration tests. See iteration 27 in [the enterprise iteration plan](enterprise-iteration-plan.md) and the explicit gap in [protocol coverage](coverage.md).

## component-article-authentication-01: Critical vulnerabilities in JSON Web Token libraries

[Primary source](https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/) — technical-article; selected body sections reviewed.

Historical JWT library exploits show algorithm confusion and unsigned-token acceptance.

Decision: Retain the RS256/ES256 allowlist; add none/HMAC/signature-negative regression cases. The article is historical, not evidence of a current jose vulnerability.

## component-article-authentication-02: JSON Web Token (JWT) Signing Algorithms Overview

[Primary source](https://auth0.com/blog/json-web-token-signing-algorithms-overview/) — technical-article; selected body sections reviewed.

Signing authenticates content but does not encrypt it; shared-key and public-key verification have different trust requirements.

Decision: Keep public-key verification at ingress and secrets out of token claims and logs. Do not implement cryptography locally.

## component-article-authentication-03: Brute Forcing HS256 is Possible: The Importance of Using Strong Keys in Signing JWTs

[Primary source](https://auth0.com/blog/brute-forcing-hs256-is-possible-the-importance-of-using-strong-keys-to-sign-jwts/) — technical-article; selected body sections reviewed.

Weak HMAC secrets permit offline guessing; the demonstrated timing depends on hardware and secret strength.

Decision: Do not add arbitrary HS256 configuration to this resource server. The test checks algorithm rejection, not brute-force resistance.

## component-article-authentication-04: ID Token and Access Token: What Is the Difference? | Auth0

[Primary source](https://auth0.com/blog/id-token-access-token-what-is-the-difference/) — technical-article; selected body sections reviewed.

ID tokens and access tokens have different recipients and purposes.

Decision: Keep issuer/audience checks and optional access-token typ profile. Allow explicit OAuth subjects without unused API keys; never accept them as API-key credentials.

## component-article-authentication-05: Protect Your Access Tokens with DPoP

[Primary source](https://auth0.com/blog/protect-your-access-tokens-with-dpop/) — technical-article; selected body sections reviewed.

DPoP binds tokens to client keys and adds per-request proof semantics.

Decision: Keep rejecting cnf-bearing tokens until method/URL binding, nonce and cross-replica replay protection are implemented. DPoP does not solve malicious action by an already-authorized agent.

## component-article-authentication-06: On-Behalf-Of Is a Pattern. Token Exchange Is the Standard.

[Primary source](https://auth0.com/blog/on-behalf-of-is-a-pattern-token-exchange-is-the-standard/) — technical-article; selected body sections reviewed.

On-behalf-of is a delegation pattern; vendor grant formats and RFC 8693 are not interchangeable.

Decision: Require the returned issued_token_type for RFC 8693 exchange; reject ID-token output. Token exchange alone is not proof of user consent to an agent action.

## component-article-authentication-07: Refresh Token Security: Detecting Hijacking and Misuse with Auth0

[Primary source](https://auth0.com/blog/refresh-token-security-detecting-hijacking-and-misuse-with-auth0/) — technical-article; selected body sections reviewed.

Refresh reuse can signal theft or a legitimate race; network and user-agent heuristics need false-positive handling.

Decision: Fix concurrent expired-cache exchanges. Keep interactive refresh-token storage/rotation at the identity service; do not infer compromise solely from IP changes.

## component-article-authentication-08: Demystifying OAuth Security: State vs. Nonce vs. PKCE

[Primary source](https://auth0.com/blog/demystifying-oauth-security-state-vs-nonce-vs-pkce/) — technical-article; selected body sections reviewed.

State, nonce and PKCE protect different steps in interactive OAuth/OIDC flows.

Decision: Defer a hosted login flow until redirect/session/PKCE lifecycle is designed. These parameters are not substitutes for resource-server token validation.

## component-article-authentication-09: Common Risks of Giving Your API Keys to AI Agents

[Primary source](https://auth0.com/blog/api-key-security-for-ai-agents/) — technical-article; selected body sections reviewed.

Shared broad API keys obscure attribution and enlarge the impact of disclosure.

Decision: Support keyless OAuth-only identities, retain per-agent grants and separate upstream credentials. A vault does not itself prevent prompt injection or unauthorized decisions.

## component-article-authentication-10: OAuth 2.0 Access Tokens and The Principle of Least Privilege

[Primary source](https://auth0.com/blog/oauth2-access-tokens-and-principle-of-least-privilege/) — technical-article; selected body sections reviewed.

Least privilege requires resource binding, appropriate scopes and limited token lifetime.

Decision: Reject an explicitly narrowed token response missing requested scopes. Omitted scope does not automatically mean unlimited access; local grants still constrain every call.

## component-article-authorization-01: Understanding ReBAC and ABAC Through OpenFGA and Cedar

[Primary source](https://auth0.com/blog/rebac-abac-openfga-cedar/) — technical-article; selected body sections reviewed.

OpenFGA relationships and Cedar attributes organize authorization data differently; either requires trustworthy and fresh inputs.

Decision: Retain the replaceable Authorizer interface and OpenFGA adapter. Do not add Cedar merely to duplicate existing argument constraints.

## component-article-authorization-02: How To Evaluate Resource-Specific Permissions Efficiently with ReBAC instead of RBAC

[Primary source](https://auth0.com/blog/evaluate-resource-specific-permissions-with-rebac-instead-of-rbac/) — technical-article; selected body sections reviewed.

Resource-specific rights can grow awkwardly when encoded as many global roles or token claims.

Decision: Keep group-to-tool relationships in OpenFGA and backend record ownership at the backend unless a trusted resource-binding design is introduced.

## component-article-authorization-03: What Is Relationship-based access control (ReBAC)

[Primary source](https://auth0.com/blog/relationship-based-access-control-rebac/) — technical-article; selected body sections reviewed.

Relationships are facts; permissions derive from a model and may require multiple graph traversals.

Decision: Pin the model, use higher consistency and fail closed on dependency faults. Do not equate a relationship tuple with an unconditional permission.

## component-article-authorization-04: Policy Testing With Oso Cloud - Part 1: Local Testing

[Primary source](https://www.osohq.com/post/policy-testing-with-oso-cloud-part-1-local-testing/) — technical-article; selected body sections reviewed.

Fast local policy checks complement service integration tests; syntax validation alone does not prove intended decisions.

Decision: Add a local permission-intersection matrix and retain real OpenFGA grant/inheritance/revocation tests. No dependency on a paid Oso service is introduced.

## component-article-authorization-05: Building the GitHub Authorization Model Using oso - oso

[Primary source](https://www.osohq.com/post/building-the-github-authorization-model-using-oso/) — technical-article; selected body sections reviewed.

Repository and organization roles differ, and permission inheritance can be expressed through recursive model rules.

Decision: Keep inheritance in the external relationship model rather than copying a fixed GitHub hierarchy into the gateway. Test local/role/relationship intersection.

## component-article-routing-01: Test driving “power of two random choices” load balancing

[Primary source](https://www.haproxy.com/blog/power-of-two-load-balancing/) — technical-article; selected body sections reviewed.

Power-of-two selection depends on a load signal; multiple independent balancers and slow-start complicate comparisons.

Decision: Defer least-load routing until reliable metrics and lifecycle hooks exist. Do not market a process-local counter as global capacity.

## component-article-routing-02: Client IP Persistence or Source IP Hash Load Balancing

[Primary source](https://www.haproxy.com/blog/client-ip-persistence-or-source-ip-hash-load-balancing/) — technical-article; selected body sections reviewed.

Naive source hashing can remap broadly on membership changes; persistence tables and consistent hashing have different costs.

Decision: Retain principal-based rendezvous for stable assignment. Avoid IP-based identity, particularly behind NAT and proxies.

## component-article-routing-03: Two ways to enable sticky sessions in HAProxy (guide)

[Primary source](https://www.haproxy.com/blog/enable-sticky-sessions-in-haproxy/) — technical-article; selected body sections reviewed.

Cookies and source IP offer different session-affinity tradeoffs; NAT and changing addresses skew IP affinity.

Decision: Keep agent identity as the affinity key and document that affinity is not resumability or guaranteed session migration.

## component-article-routing-04: Load Balancing with Weighted Pools | Cloudflare Blog

[Primary source](https://blog.cloudflare.com/load-balancing-with-weighted-pools/) — technical-article; selected body sections reviewed.

Relative weights support canaries and capacity splits; removing a pool from selection is useful during maintenance.

Decision: Add explicit enabled:false per route target across all built-in strategies. It pauses alias selection; separately granted direct tools remain available.

## component-article-routing-05: Rich, complex rules for advanced load balancing | Cloudflare Blog

[Primary source](https://blog.cloudflare.com/rich-complex-rules-for-advanced-load-balancing/) — technical-article; selected body sections reviewed.

Rule-based steering supports business and location needs, but a broad expression language adds semantics and trust requirements.

Decision: Retain trusted tenant/role/client selectors and the Router plugin. Extend continuation eligibility to check those selectors and disabled targets; defer arbitrary caller-header trust.

## component-article-reliability-01: The complete guide to Go net/http timeouts | Cloudflare Blog

[Primary source](https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/) — technical-article; selected body sections reviewed.

Different HTTP phases and streaming traffic need distinct budgets; fixed deadlines and idle timeouts are not interchangeable.

Decision: Retain total upstream budgets including credential acquisition and separate connection limits. Add bounded JWKS reads using the existing deadline. Go-specific APIs are not copied into Node.

## component-article-reliability-02: Bringing insights into TCP resets and timeouts to Cloudflare Radar | Cloudflare Blog

[Primary source](https://blog.cloudflare.com/tcp-resets-timeouts/) — technical-article; selected body sections reviewed.

Early TCP resets/timeouts can have multiple causes, including client behavior, middleboxes and attacks.

Decision: Do not infer that a tool action failed or retry it solely from a reset. Distinguish transport observations from execution outcomes.

## component-article-reliability-03: Google SRE - Cascading Failures: Reducing System Outage

[Primary source](https://sre.google/sre-book/addressing-cascading-failures/) — engineering-book-chapter; selected body sections reviewed.

Retry and failover feedback can turn partial overload into a cascading failure.

Decision: Keep effect retries disabled and preserve quotas, circuits, bounded fan-out and cancellation tests. Capacity/soak validation remains separate work.
