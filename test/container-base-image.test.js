import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

test('both Docker build stages use one digest-pinned multi-architecture Node base with update monitoring', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const baseReferences = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+\S+)?$/gim)]
    .map((match) => match[1]);
  assert.equal(baseReferences.length, 2);
  assert.equal(baseReferences[0], baseReferences[1]);
  assert.match(baseReferences[0], /^node:22-alpine@sha256:[a-f0-9]{64}$/);

  const dependabotSource = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  const dependabot = YAML.parse(dependabotSource);
  assert.equal(dependabot.version, 2);
  for (const ecosystem of ['docker', 'github-actions', 'npm']) {
    assert.ok(dependabot.updates.some((update) => update['package-ecosystem'] === ecosystem
      && update.directory === '/'
      && update.schedule.interval === 'weekly'), `${ecosystem} updates must be monitored weekly`);
  }
});
