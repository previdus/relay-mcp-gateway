import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('website build contains the main project guide and all linked documentation', async () => {
  const html = await readFile(resolve(root, 'website/dist/index.html'), 'utf8');
  const css = await readFile(resolve(root, 'website/dist/styles.css'), 'utf8');
  assert.match(html, /id="flow"/);
  assert.match(html, /id="security"/);
  assert.match(html, /id="deploy"/);
  assert.match(html, /id="compare"/);
  assert.match(html, /Microsoft MCP Gateway/);
  assert.match(html, /Gravitee APIM/);
  assert.match(html, /KrakenD MCP Server/);
  assert.match(html, /id="hosted-mcp-link"/);
  assert.match(css, /@media\(max-width:600px\)/);
  for (const href of html.matchAll(/href="((?:docs|README|LICENSE|CONTRIBUTING|SECURITY|CHANGELOG)[^\"]*)"/g)) {
    await access(resolve(root, 'website/dist', href[1]));
  }
});

