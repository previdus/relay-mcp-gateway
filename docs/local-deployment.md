# Local container and Kubernetes verification



The v0.12.0 image build, hardened container smoke test, disposable PostgreSQL/OpenFGA/OPA integration suite, and two-replica Kubernetes acceptance all passed locally. Kubernetes acceptance ran in a dedicated kind v0.33.0 cluster using Kubernetes v1.34.11 and tested shared state, pod replacement, database outage recovery, rollback to the actual v0.11 image, and v0.12 promotion. See [validation-v0.12.md](validation-v0.12.md) for evidence and limits. This is one local environment, not universal cloud certification.



## In-process demo

Run `npm run demo` to start the gateway and two sample upstreams on loopback ports 3000, 4101, and 4102. The demo prints a fresh administrator key and service key at startup; both rotate whenever the process restarts. Its SQLite store is in memory, so published configuration and audit history reset on exit. The `echo` alias routes between one legacy and one modern upstream, which must publish the same tool description and input schema for the gateway to expose that alias safely.


## Containers



1. Copy `.env.example` to `.env`; generate separate random service/admin/upstream keys and a URL-safe `POSTGRES_PASSWORD`.

2. Set approved upstream URLs in `gateway.config.json`. For a control-plane-only smoke check, use an empty `upstreams` array and empty client `allow` list. Local HTTP exceptions accept loopback only; an ordinary Compose service hostname requires HTTPS.

3. Run `docker compose config --quiet`, then `docker compose up --build -d --wait`.

4. Check `http://127.0.0.1:3000/readyz`, log into `/admin/`, publish a policy change, and make a real MCP discovery/call using the service key.

5. Run the disposable integration stack described in README. Keep its database separate from gateway data.

6. Use `docker compose down` to stop. Persistent volumes remain for restart verification; do not remove them unless intentionally resetting data.



## Local Kubernetes



Use Docker Desktop Kubernetes or another local cluster. For kind/minikube, load the built image into that cluster's image store before applying the deployment.



1. Build `docker build -t relay-gateway:0.12.0 .`.

2. Choose a dedicated namespace: `kubectl create namespace relay-local`.

3. Provision PostgreSQL in that namespace with a persistent volume and a secret password. Use `deploy/compose.test.yaml` only for disposable tests, not as the gateway database. Alternatively, supply a reachable PostgreSQL instance outside the cluster.

4. Create `relay-gateway-secrets` in `relay-local` containing `DATABASE_URL`, `GATEWAY_ADMIN_KEY`, `GATEWAY_API_KEY`, `UPSTREAM_API_KEY`, and any optional identity/OpenFGA settings. Include `GATEWAY_STATE_KEY` if callbacks are enabled. Supply secrets through your secret manager or local protected file, not a committed manifest. DATABASE_URL must be reachable from pods; pod localhost is not the host machine.

5. Update the seed configuration and hostname, rebuild/load the image, and apply `kubectl -n relay-local apply -f deploy/kubernetes.yaml`.

6. Wait with `kubectl -n relay-local rollout status deployment/relay-gateway --timeout=120s`; inspect failed pods and events if it times out.

7. Forward locally with `kubectl -n relay-local port-forward service/relay-gateway 3000:80`; verify `/readyz`, console publish and MCP calls. Check both replicas observe a permission revocation. HPA requires metrics-server.

8. Restart one pod during parallel calls and verify recovery, then test a PostgreSQL interruption and confirm fail-closed responses. Apply a known prior image to test rollback. Record outcomes before production promotion.



The base manifest supplies two replicas, zero-unavailable rolling updates, HPA, disruption budget, best-effort node/zone spreading, non-root execution, the runtime-default seccomp profile, no mounted Kubernetes service-account token, a read-only root filesystem and writable scratch storage. Startup probes allow up to five minutes before liveness/readiness checks take over. On SIGINT/SIGTERM the gateway stops accepting connections, lets active HTTP/MCP work drain for up to two minutes, then closes remaining HTTP connections; the pod grace period is 135 seconds to allow shutdown and store/tracing cleanup to finish. Memory requests/limits are starter values informed by the local smoke runs; size them using representative production load and retained-heap measurements. PostgreSQL is mandatory for shared configuration and leases. Stdio processes and notification feeds remain local to the handling replica; continuation state uses the shared key and can resume elsewhere. No sticky load balancer is required for the tested modern continuation flow. NetworkPolicies, ingress TLS, cloud secret-store integration, database backups and multi-node failure-domain checks remain deployment-specific work.



The isolated cluster acceptance described below exercised the two-replica and fault scenarios. It does not replace deployment-specific checks for TLS ingress, network egress policy, database backups, secret rotation, immutable audit export, production SSO, multi-node failure domains, or managed cloud services.

On Windows with Docker Desktop backed by WSL2, kubelet can fail to start if the WSL kernel exposes cgroup v1. The local fix used for this validation was to update WSL, set `kernelCommandLine = cgroup_no_v1=all systemd.unified_cgroup_hierarchy=1` under `[wsl2]` in `%USERPROFILE%\.wslconfig`, run `wsl --shutdown`, and restart Docker Desktop. This file changes kernel settings for every WSL2 distribution on the machine; review the [Microsoft WSL configuration reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) before applying it elsewhere. Verify `docker desktop kubernetes status` and `kubectl --context docker-desktop get nodes` before running tests.



## Repeat the isolated Kubernetes acceptance suite

Build `relay-gateway:0.12.0` from this release and retain or build `relay-gateway:0.11.0` from the actual v0.11 release. Do not tag current source as the older release. The acceptance script verifies rollback to the prior image as well as promotion. Create a dedicated kind cluster named `relay-validation` using a separate kubeconfig file. The prior release acceptance on this host used this node image:

`kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d`

Load both images with `kind load docker-image relay-gateway:0.11.0 relay-gateway:0.12.0 --name relay-validation`. Set `KUBECONFIG` explicitly to that cluster's private kubeconfig and make its context `kind-relay-validation`, then run `npm run test:kubernetes`. The script refuses another context. It creates a random namespace, secret credentials, a PVC-backed test PostgreSQL and two hardened gateway replicas, then removes its namespace. `deploy/kubernetes.test.yaml` is a disposable test dependency, not a production PostgreSQL installation.

If kind cannot import a multi-platform image due to missing platform content, export the existing images with `docker image save --platform linux/amd64 --output release-images.tar relay-gateway:0.11.0 relay-gateway:0.12.0 postgres:17-alpine` and use `kind load image-archive release-images.tar --name relay-validation` on an amd64 host. Select the actual machine platform elsewhere.

This acceptance passed on 17 October 2026 with kind v0.33.0 and the pinned Kubernetes v1.34.11 node image above. It checks reviewed-only catalog and argument restrictions on both replicas as well as actual MCP discovery/calls, one shared quota across pods, permission revocation, audited configuration restoration, serving through a surviving pod during replacement, fail-closed behavior during database shutdown, persistence/recovery, prior-image rollback and promotion. It does not measure maximum throughput, HPA behavior under load, multi-node failure domains, ingress/TLS, managed storage or multi-cloud behavior. Before rollback the test deliberately restores a configuration without v0.8 fields. See [the rollout plan](research-implementation-plan.md) for production safeguards; old binaries reject v0.8 selector/deadline fields. Image rollback uses a compatible test configuration; arbitrary future schema/config downgrades require a migration plan.

Delete only this dedicated cluster with `kind delete cluster --name relay-validation --kubeconfig <private-kubeconfig>` when finished. The running local browser demo is independent of this cluster.
