# Validation record — v0.9.0 checkpoint

Executed 17 October 2026 on Windows, Node 22.14 and Docker Desktop. The earlier record remains in validation-v0.8.md. These are implementation checks, not completion of the 200-article/40-cycle programme.

| Check | Result |
|---|---|
| TypeScript and deployment/CI YAML syntax | Passed |
| Core/protocol/security tests | 86 passed; 0 failed, cancelled or skipped |
| Chromium workflows | 7 passed; 0 failed or skipped |
| Real PostgreSQL and OpenFGA integration | 4 passed; 0 failed or skipped |
| Clean container build | Passed; installation audit reported 0 vulnerabilities at execution time |
| Non-root/read-only container acceptance | Passed |
| Kubernetes acceptance | Passed: two replicas, shared quota/revocation, pod replacement, database outage/recovery, actual v0.8 rollback and v0.9 promotion |
| Live demo | v0.9.0; readiness revision 5; admin HTTP 200; real MCP discovery and echo call passed |

97 automated tests in total, plus deployment acceptance scripts. Multiple cases inside one test are not counted separately. Core was rerun after adding actual MCP target-availability coverage. Browser and service suites exercised the same application source; the later source change only updated release metadata.

New tests cover streamed JWKS bounds, redirects, invalid document/type/count, algorithm confusion and unsigned tokens, concurrent JWKS fetch reuse, unknown-key cooldown, OAuth-only subjects without API-key fallback, simultaneous expired-token refresh, narrowed token scope, invalid/absent RFC 8693 issued_token_type, unsafe bearer values, and recovery after exchange rejection.

Routing tests cover all four built-in strategies with disabled targets, alias disappearance when all targets are disabled, actual MCP selection of the remaining backend, and denial of direct physical access without a grant. Browser tests persist both OAuth-only identities and disabled route targets. A local policy truth table checks the intersection of role, allowlist and relationship decisions, plus tenant arguments and inherited-property rejection. Real OpenFGA/PG tests continue covering group inheritance, revocation, cross-replica policy and shared limits.

Final image manifest-list digest: sha256:e6fd9c74a23d28fc7036ca143c688f9377fd39ed7540f0192e4aaedc28d058f1.

No multi-cloud or multi-node chaos test, sustained load/soak run, formal verification, exhaustive MCP certification or competitor benchmark was performed. The JWKS fixture uses real local HTTP with a test-only socket destination substitution; production validation continues to require the pinned HTTPS endpoint. That fixture is not a public TLS/PKI interoperability test.

The Kubernetes acceptance used the dedicated kind-relay-validation cluster (kind 0.33; Kubernetes 1.34.11). The executed image loop selected v0.8.0 and v0.9.0. Its final human-readable log still named the previous versions; that stale label was corrected after the successful run. The tested compatible document was restored before rollback. New v0.9-only configuration is not claimed to run on v0.8.
