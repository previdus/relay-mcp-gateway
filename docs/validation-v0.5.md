# Validation record — version 0.5.0



Executed locally on 17 October 2026 with Node.js 22.14.0 on Windows.



| Check | Result |

|---|---|

| Strict TypeScript checking and compiled build | Passed |

| Pinned dependency clean install using npm ci | Passed from cached packages |

| Core / HTTP / security / transport regression tests | 47 passed, 0 failed, 0 skipped |

| Browser end-to-end tests | 4 passed, 0 failed, 0 skipped |

| Real service integration tests | 4 passed, 0 failed, 0 skipped |

| Deployment / CI YAML syntax | Passed |

| Test Compose configuration validation | Passed |

| Dependency installation audit | Reported 0 vulnerabilities at installation time |

| Container image build / run | Passed after Docker Desktop reinstall; non-root/read-only MCP and admin smoke test |

| Local Kubernetes deployment/fault/rollback acceptance | Passed on kind 0.33.0 / Kubernetes 1.34.11; cloud not executed |

| Official exhaustive protocol conformance suite | Not executed |



## What the integration evidence covers



Real PostgreSQL 18.4 and OpenFGA 1.22.0 ran as isolated local processes. The official OpenFGA binary's SHA-256 matched its release checksums. The processes were stopped after each run. CI uses the dedicated disposable container stack and PostgreSQL 17; that container environment has not been run here.



The PostgreSQL suite also injects an audit-table failure and verifies that configuration revisions roll back with the failed audit, then confirms a successful atomic commit. The PostgreSQL suite races revision updates from independent pools, verifies shared audit reads, and races distributed lease acquisitions to confirm the configured capacity is not exceeded. A separate scenario starts two actual gateway HTTP servers sharing PostgreSQL and sends 20 concurrent calls through both. It then revokes permissions through one replica's management API and verifies the other replica denies access on subsequent requests. This is a concurrency smoke test, not a capacity benchmark or extended soak test.



The OpenFGA suite creates a real store, immutable authorization model, group membership, and tool grant. It verifies access, a denied tool, and denial after membership revocation. An additional HTTP adapter test confirms pinned model IDs and fail-closed responses.



The browser suite launches Chromium and verifies admin login, route creation using form controls, publish, policy simulation without invocation, invalid JSON configuration rejection, reload, persisted activity, and a mobile viewport without horizontal page overflow. It asserts no browser page errors and no local-storage credentials. `console-preview.png` is the verified desktop view.



Protocol tests use real SDK clients against the gateway and modern, legacy HTTP, and legacy SSE upstreams. They cover namespace collisions, aliases, custom routing plugins, separate upstream credentials, prompts, resources, denied direct calls, unsupported versions, header mismatches, malformed requests, timeouts, and schema input checks.



Security tests cover invalid JWT signatures/issuer/audience/expiry, missing scopes, management/service key separation, exact-origin restrictions, wildcard/alias isolation, policy-backend failures, redirect refusal, cross-origin transport destinations, and declared/chunked response byte limits. These are targeted tests, not a penetration-test certification.



## Additional 0.3 scenarios



Seven new protocol/security scenarios exercise worker termination and recovery, tenant isolation with a malicious custom router, encrypted multi-round-trip state across replicas with tamper/argument/identity rejection, resource template expansion and completion, stdio credential boundaries, delegated token exchange and modern notification delivery with configuration revocation. Three operational tests verify SQLite audit/configuration rollback, fail-closed audit admission, protected metrics with bounded labels, and rejection of callback configuration without a shared state key.



## Release assessment



The implemented scenarios pass. The full product remains incomplete, with unresolved items listed in [coverage.md](coverage.md). No zero-bug, universal-cloud, full-protocol, security-certification, or unique-feature claim is made.





## Container verification after Docker reinstall



Docker Desktop 4.35.1 was uninstalled using keep-data mode and 4.95.0 was installed. The existing Docker data disk was backed up and SHA-256 verified before uninstall. Engine 29.8.2 responded successfully; previous unrelated containers and named volumes remained visible.



The image `relay-gateway:0.3.0` built successfully from the supplied Dockerfile, including clean dependency installation and TypeScript compilation. `node scripts/container-smoke.js` passed readiness, console availability, authentication, real stdio tool discovery/call, configuration publication, immediate permission revocation, audit presence and UID 1000 checks. It ran with a read-only root filesystem, dropped capabilities and no-new-privileges. The disposable container was removed afterward.



All three integration tests passed again with PostgreSQL 17 and OpenFGA 1.22.0 running in the supplied Docker Compose test stack. The stack was stopped after verification. This confirms local container execution; Kubernetes rollout, full production Compose deployment with real upstreams, and cloud verification remain unexecuted.





## 0.4 competitive-review release validation



The complete core regression run passed 41 tests, Chromium passed two acceptance scenarios, and PostgreSQL 17/OpenFGA 1.22.0 in the disposable Docker stack passed four integration tests: **47 tests, zero failures, zero skips**. The image `relay-gateway:0.4.0` built successfully and the separate hardened container smoke scenario passed. TypeScript checking and deployment/CI YAML syntax passed.



New evidence includes deterministic token refill and key isolation; single half-open circuit probes; stale success exclusion; real MCP 429 and quota-store failure; failed connection suppression and recovery; preservation of a healthy circuit after invalid caller input; traffic form validation/publish/reload; an independent-pool reservation race; and 12 concurrent real tool calls across two gateways, of which exactly three were admitted by one shared budget. Publishing an unrelated revision did not refill it.



This smoke-scale load is not a throughput benchmark. No competing vendor runtime was installed or measured, so no relative latency, reliability or completeness ranking is supported. The public documentation review and remaining acceptance gates are in competitive-review.md. Live demo upgrade is separate from release verification and may require access to its temporary administrator credential.



## 0.5 final validation — 17 October 2026

The final test runs passed **55 tests**: 47 core/protocol/security/governance/tracing cases, four Chromium workflows, and four real PostgreSQL/OpenFGA integration scenarios. There were zero failures or skips in those final runs. The separate hardened-container acceptance and isolated Kubernetes acceptance commands also completed successfully. TypeScript and all deployment/CI YAML syntax checks passed. Dependency installation reported zero vulnerabilities at execution time.

New governance coverage verifies revision listing, administrator boundary, stale rollback conflicts, missing/invalid source revisions, historical credential-reference revalidation, canonical fingerprints, description/annotation drift, removal from discovery and zero upstream invocations while a pinned definition is changed. SQLite and PostgreSQL failure injection verifies configuration, audit and history roll back together. The browser uses a real service identity to discover/invoke and pin a definition; its MCP name header was corrected after the test caught a protocol rejection.

Tracing coverage uses the official SDK with an in-memory exporter and real OTLP/HTTP export to a receiving fixture. It verifies parent/child IDs, traceparent propagation, MCP denial status and absence of credentials, identity, arguments, results and incoming baggage in recorded spans. This is not a production collector soak or trace UI certification.

### Kubernetes evidence

An isolated kind 0.33.0 cluster used official `kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d`. Two gateway pods ran the supplied deployment with PostgreSQL 17 backed by a PVC and a dedicated fixture configuration. The acceptance command passed:

- Discovery and actual tool calls through both pods.
- One shared three-call budget across 12 requests through the two pods.
- Cross-pod permission revocation and a reviewed, audited configuration rollback.
- Pod replacement while the other replica continued serving.
- Database shutdown producing fail-closed readiness/call failures, followed by database recovery with configuration revision preserved.
- Image rollback to 0.4 and promotion to 0.5 with a compatible configuration, with MCP discovery checked after each rollout.

The default Kubernetes 1.37 image failed to bootstrap its control plane on this host's cgroup v1 setup, before application deployment. Retrying the officially supported 1.34 image succeeded. The deployment harness also needed its full configuration mounted before initial database seeding; this fixture-order issue was corrected and the complete suite rerun. The rate-limit assertion was adjusted to accept the SDK's error wording while still requiring exactly three successes and nine rate rejections.

The acceptance namespace, PVC-backed test database, cluster and Compose integration stack were removed after success. The browser demo remains running independently with its existing login, configuration and service key. This one-node cluster test does not prove multi-node availability, HPA scaling under load, TLS ingress, cloud storage, secret rotation, arbitrary schema downgrades or universal cloud portability.
