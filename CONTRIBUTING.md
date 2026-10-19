# Contributing to Relay

Thanks for helping improve Relay. Contributions should include a clear user need, a focused change, and evidence that the behavior works.

## Before you change code

- Read [the architecture](docs/architecture.md), [security boundaries](docs/security.md), and [feature coverage](docs/coverage.md).
- For protocol behavior, follow the current MCP specification and cite the relevant specification or test case in the change description.
- For new extension points, document the trust boundary and preserve the core gateway checks around plugins.

## Local checks

Requirements: Node.js 22.14 or later.

```sh
npm ci
npm run check
npm test
npm run test:browser
npm run website:check
```

The browser suite uses Playwright Chromium. If its bundled browser is unavailable but Chromium or Edge is installed, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to that browser's executable before running `npm run test:browser`.

Optional service, container, Kubernetes, and performance checks are documented in [local deployment](docs/local-deployment.md) and [performance validation](docs/performance-validation.md). Do not point acceptance scripts at a cluster or database that contains user data; the tests create and remove disposable resources.

## Pull requests

- Keep a change focused and explain the before and after behavior.
- Add regression coverage for security, protocol, routing, persistence, or UI behavior.
- Never commit secret values, local environment files, generated credentials, or customer data.
- Update user and operator documentation when configuration or deployment behavior changes.
- Report checks run and call out checks you could not run.

## Security issues

Please do not file exploitable vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) for private reporting guidance.

