# Agent-driven delivery contract

The initial gateway is implemented. A persistent autonomous delivery controller is not implemented in this cut. These contracts define how to extend the project with agents without implying that CI itself is an agent orchestrator.

1. Requirements agent updates requirement IDs, acceptance criteria, assumptions, and open decisions.
2. Design agent produces interface changes, threat analysis, migration and rollback plans, and bounded implementation tasks.
3. Coding agent implements one task per branch with requirement references and reproducible validation steps.
4. Review agent independently checks correctness, credential boundaries, failure modes, and scope. It must not silently waive failed requirements.
5. Test agent adds independent acceptance and failure tests and records execution evidence.
6. Release agent builds an immutable artifact, deploys to staging, verifies real integrations, and proposes a production promotion with rollback evidence.

The controller should persist task status, artifact references, execution attempts, cost, and test outcomes. Give it task and spending limits. CI owns immutable verification gates; agents must not be able to approve their own permission changes or override release policy.

Current automation: dependency lockfile, test command, CI validation and container build definition. Future automation: workflow persistence, agent invocation, isolated workspaces, review separation, staging provisioning, canary promotion, rollback, and operational monitoring.

Production deployment needs the chosen hosting account, identity provider, secret manager, real upstreams, and an explicit release authorization policy. No infrastructure resources have been created.
