# Completed component review cycles

Seven cycles completed. Each links inspected evidence to a code decision, tests, and the next research question. A decision can retain existing behavior or defer an unsafe addition; it is not a claim that a whole component is complete.

## authentication-01

Can key retrieval or token confusion defeat the ingress profile?

Evidence: component-article-authentication-01, component-article-authentication-02, component-article-authentication-03, component-article-authentication-04, component-article-authentication-05; saved paper context authentication-paper-01.

Implemented 64 KiB/64-key remote JWKS limits while retaining jose refresh coalescing and cooldown. Added unsigned, wrong algorithm, invalid signature, redirect and oversized document tests. Retained rejection of unsupported proof-bound tokens.

Validation: test/jwks-boundary.test.js; test/component-hardening.test.js.

Next: Can a whole-issuer emergency stop contain a compromised provider when per-token revocation is insufficient?

## authentication-03

Can an operator stop a compromised but unexpired locally verified JWT across every gateway replica?

Evidence: [RFC 7519 §4.1.7](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.7) defines the optional JWT ID claim; its presence alone does not provide a revocation mechanism. This standards review is not counted as a paper or article.

Added opt-in synchronous revocation checks keyed by the validated issuer and signed `jti`. Administrators can revoke through the authenticated console/API using only issuer and `jti`; local SQLite supports one instance and PostgreSQL is shared across replicas. Records are hashed, expire, deny on storage errors, and the revocation plus required audit record commit atomically. The mode rejects JWTs without bounded IDs. Issuer-level key rollover and distributed PostgreSQL verification remain open.

Validation: `test/jwt-revocation.test.js`; PostgreSQL cross-pool integration is pending a Docker-enabled run.

Next: How should emergency key removal and JWKS cache refresh coordinate across replicas without accepting stale keys or causing a key-fetch stampede?

## authentication-04

Can an emergency signing-key incident be contained without relying on an optional or mutable `kid` value?

Evidence: [RFC 7517 §4.5](https://www.rfc-editor.org/rfc/rfc7517.html#section-4.5) makes `kid` an optional selector for a key; [RFC 8725 §3.8](https://www.rfc-editor.org/rfc/rfc8725.html#section-3.8) requires issuer/key binding. This normative standards review is not counted as an article or research paper.

Added an issuer-wide emergency stop to the shared JWT revocation registry. It denies every validly signed token from that configured issuer regardless of key rotation or token ID. Administrators can re-enable only through an explicit audited action. Using the per-token registry check ensures one storage read per authentication. PostgreSQL cross-pool validation is pending; key-specific JWKS cache purging remains separate work.

Validation: `test/jwt-revocation.test.js`; `integration/services.test.js` contains the two-pool PostgreSQL check but Docker was unavailable.

Next: How should a targeted key-thumbprint revocation and JWKS refresh avoid ambiguity, stale acceptance, and refresh stampedes without an issuer-wide outage?

## authentication-02

Do delegated credentials preserve recipient/scope constraints under concurrent expiry?

Evidence: component-article-authentication-06, component-article-authentication-07, component-article-authentication-08, component-article-authentication-09, component-article-authentication-10; saved paper context authentication-paper-02.

Fixed duplicate refresh exchanges; tightened JSON, bearer syntax, length, returned scope and issued token type checks. Added explicit keyless OAuth subjects and UI support; retained separate interactive identity-provider responsibilities.

Validation: test/credential-boundary.test.js; test/config.test.js; test/advanced.test.js; integration/browser.test.js.

Next: Which upstream client authentication methods and consent contracts need additional provider adapters?

## authorization-01

Should relationship facts, roles and caller-supplied arguments expand one another’s authority?

Evidence: component-article-authorization-01, component-article-authorization-02, component-article-authorization-03, component-article-authorization-04, component-article-authorization-05; saved paper context authorization-paper-01.

Retained strict policy intersection and external model ownership. Added an allow/role/relationship truth-table test and argument/prototype rejection checks. Deferred backend-record authorization until trusted resource binding exists.

Validation: test/policy-composition.test.js; integration/services.test.js.

Next: How can conditional relationship attributes be sourced authoritatively and remain fresh across replicas?

## routing-01

How can an operator remove a target from alias selection without introducing unsafe failover?

Evidence: component-article-routing-01, component-article-routing-02, component-article-routing-03, component-article-routing-04, component-article-routing-05; saved paper context routing-paper-04.

Implemented per-target availability in configuration, built-in routing and UI; continued requests recheck selectors and availability. No automatic replay or least-load claims.

Validation: test/route-availability.test.js; test/advanced.test.js; integration/browser.test.js.

Next: How should health signals, slow-start and explicit direct-access shutdown interact with trusted Router plugins?

## reliability-01

Can response loss or overload justify retrying a potentially completed action?

Evidence: component-article-reliability-01, component-article-reliability-02, component-article-reliability-03, reliability-article-01, reliability-article-02; saved paper context reliability-paper-03.

Retained no automatic tool-effect retries, bounded fan-out, cancellation, rate limits and circuit behavior. Hardened security-service reads and exchange coalescing; deferred retry and outcome reconciliation until backend idempotency is explicit.

Validation: test/component-hardening.test.js; test/catalog.test.js; test/traffic.test.js; test/credential-boundary.test.js.

Next: Which discovery requests can be retried under a shared budget, and which ingress/streaming soak tests expose remaining failure modes?

## authentication-05

Does the gateway send upstream OAuth client secrets using the recommended client authentication method while preserving explicit provider compatibility?

Evidence: [RFC 6749 §2.3.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1), [RFC 8693 §2.3](https://www.rfc-editor.org/rfc/rfc8693.html#section-2.3). Normative standards review; not counted as an article or research-paper cycle.

Changed upstream token requests to use form-encoded HTTP Basic client authentication by default. `client_secret_post` is available only through explicit configuration for legacy providers. The real local token endpoint verifies credential placement and special-character encoding.

Validation: test/credential-boundary.test.js; test/advanced.test.js; test/enterprise-security.test.js.

Next: Can asymmetric client authentication and workload identity plug in without static client secrets or destination-pin bypasses?
