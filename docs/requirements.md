# Initial requirements and acceptance criteria

| ID | Requirement | Evidence |
|---|---|---|
| GW-01 | Discover namespaced tools from two upstream servers | Integration test: colliding names |
| GW-02 | Route each namespaced call to its originating upstream | Integration test: colliding names |
| GW-03 | Enforce configured client permissions in discovery and invocation | Integration test: direct unauthorized call |
| GW-04 | Reject missing credentials and disallowed origins | Integration test: authentication and origins |
| GW-05 | Audit call identity, tool, outcome, duration without payloads or keys | Integration test: audit redaction |
| GW-06 | Bound upstream work and avoid automatic retries | Integration tests: unavailable and stalled upstreams |
| GW-07 | Limit in-flight requests per service client | Integration test: concurrent requests |
| GW-08 | Provide reproducible packaging and CI | Dockerfile, lockfile, GitHub Actions; container execution pending |

Assumptions: one organization, administrator-managed upstreams, service API keys, tools only, no cloud selected. Design: stateless ingress; separate outbound credentials; SDK transport handling; per-request upstream clients; configuration files as the initial control plane.

Next milestones: real integration compatibility matrix; OIDC and delegated upstream identity; persistent registry and policy administration; centralized telemetry; staging deployment and rollback verification. Production promotion remains unconfigured until a cloud, identity provider, and release policy are selected.

## Version 0.2 implementation

The gateway now uses official SDK v2 with an explicit modern 2026 protocol path and legacy compatibility. Persistent configuration, policy administration UI, JWT verification, OAuth resource metadata, OpenFGA checks, role composition, alias routing, prompts/resources, shared PostgreSQL concurrency leases, and deployment templates are implemented. The table above retains the original initial-cut requirements; [coverage.md](coverage.md) is the current feature inventory and release gate. Delegated upstream OAuth, telemetry and deployment/rollback verification are still pending.
