import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('website build contains a product story, sourced comparison and complete documentation guide', async () => {
  const html = await readFile(resolve(root, 'website/dist/index.html'), 'utf8');
  const docs = await readFile(resolve(root, 'website/dist/docs.html'), 'utf8');
  const css = await readFile(resolve(root, 'website/dist/styles.css'), 'utf8');
  const siteJs = await readFile(resolve(root, 'website/dist/site.js'), 'utf8');
  const docsJs = await readFile(resolve(root, 'website/dist/docs.js'), 'utf8');
  const lab = await readFile(resolve(root, 'website/dist/lab.html'), 'utf8');
  const labJs = await readFile(resolve(root, 'website/dist/lab.js'), 'utf8');
  const labCss = await readFile(resolve(root, 'website/dist/lab.css'), 'utf8');
  const visuals = await readFile(resolve(root, 'website/dist/visuals.css'), 'utf8');
  assert.match(html, /class="hero-visual reveal"/);
  assert.match(html, /id="security"/);
  assert.match(html, /id="deploy"/);
  assert.match(html, /id="compare"/);
  assert.match(html, /MICROSOFT/);
  assert.match(html, /GRAVITEE/);
  assert.match(html, /KRAKEND/);
  assert.match(html, /id="hosted-mcp-link"/);
  assert.match(html, /href="lab.html"/);
  for (const demo of ['jira', 'aws', 'gmail', 'slack', 'drive', 'logs', 'github', 'calendar', 'database', 'observability']) assert.match(`${lab}\n${labJs}`, new RegExp(demo, 'i'));
  for (const scenario of ['incident', 'read', 'deny', 'bad-auth', 'route', 'mtls', 'mtls-deny', 'oauth', 'oauth-deny', 'approval']) assert.match(labJs, new RegExp(`id: '${scenario}'`));
  assert.match(lab, /Agent-to-gateway and gateway-to-server mutual TLS/);
  assert.match(lab, /private key never crosses the gateway/i);
  assert.match(lab, /Public demo keys are intentionally public/);
  assert.match(labJs, /http_headers =/);
  assert.match(labJs, /Stopped before upstream/);
  assert.match(labJs, /npm run test:mtls/);
  assert.match(labCss, /prefers-reduced-motion/);
  assert.match(html, /data-cap="authorization"/);
  assert.match(html, /Relay’s strongest case/);
  for (const visual of ['value-journey', 'cap-map', 'secret-branch', 'compare-flow', 'deployment-map', 'quick-steps', 'proof-path', 'community-orbit']) {
    assert.match(html, new RegExp(visual), `homepage includes its ${visual} explainer`);
  }
  assert.match(docs, /id="configuration"/);
  assert.match(docs, /docs-request-map/);
  assert.match(docs, /id="authentication"/);
  assert.match(docs, /id="authorization"/);
  assert.match(docs, /id="routing"/);
  assert.match(docs, /id="secrets"/);
  assert.match(docs, /id="containers"/);
  assert.match(docs, /id="kubernetes"/);
  assert.match(docs, /id="aws"/);
  assert.match(docs, /id="cloud"/);
  assert.match(docs, /id="readiness"/);
  assert.match(docs, /config-search/);
  assert.match(docs, /config-lab/);
  assert.match(docs, /data-config-scenario="blocked"/);
  assert.match(docs, /data-config-step="destination"/);
  assert.match(docs, /This is an explanatory prototype/);
  assert.match(docs, /21 settings/);
  assert.match(docs, /data-setting-search="GATEWAY_CREDENTIAL_BINDINGS"/);
  for (const group of ['identity', 'permissions', 'upstreams', 'routing', 'runtime']) {
    assert.match(docs, new RegExp(`data-group="${group}"`));
  }
  const configTable = docs.match(/<table class="doc-table" id="config-table">[\s\S]*?<\/table>/)?.[0];
  const groupedRows = [...(configTable ?? '').matchAll(/<tr data-setting-group="([^"]+)"/g)];
  assert.equal(groupedRows.length, 21, 'every configuration row belongs to one explorable group');
  assert.deepEqual([...new Set(groupedRows.map((row) => row[1]))].sort(), ['identity', 'permissions', 'routing', 'runtime', 'upstreams']);
  assert.match(docs, /Microsoft/);
  assert.match(docs, /Gravitee/);
  assert.match(docs, /KrakenD/);
  assert.match(siteJs, /ArrowRight/);
  assert.match(siteJs, /prefers-reduced-motion/);
  for (const mode of ['protocol', 'identity', 'authorization', 'routing', 'security', 'operations']) {
    assert.match(siteJs, new RegExp(`${mode}: \\{[\\s\\S]*?flow:`), `${mode} updates the capability flow map`);
  }
  assert.match(docsJs, /config-search/);
  assert.match(docsJs, /data-copy-code/);
  assert.match(docsJs, /showConfigScenario/);
  assert.match(docsJs, /selectConfigGroup/);
  assert.match(docsJs, /dataset\.settingGroup/);
  assert.match(docsJs, /withholds the credential/);
  assert.match(docsJs, /setDocsStage/);
  assert.match(css, /@media\(max-width:(?:560|600)px\)/);
  assert.match(css, /focus-visible/);
  assert.match(css, /config-flow-node\[data-state=denied\]/);
  assert.match(css, /@keyframes route-flow/);
  assert.match(css, /@keyframes map-pulse/);
  assert.match(visuals, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(visuals, /@keyframes docs-map-flow/);
  await access(resolve(root, 'website/dist/README.md'));
  await access(resolve(root, 'website/dist/docs/coverage.md'));
  await access(resolve(root, 'website/dist/docs/demo-lab.md'));
});

