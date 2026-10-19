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
  assert.match(html, /class="hero-visual reveal"/);
  assert.match(html, /id="security"/);
  assert.match(html, /id="deploy"/);
  assert.match(html, /id="compare"/);
  assert.match(html, /MICROSOFT/);
  assert.match(html, /GRAVITEE/);
  assert.match(html, /KRAKEND/);
  assert.match(html, /id="hosted-mcp-link"/);
  assert.match(html, /data-cap="authorization"/);
  assert.match(html, /Relay’s strongest case/);
  assert.match(docs, /id="configuration"/);
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
  assert.match(docs, /Microsoft/);
  assert.match(docs, /Gravitee/);
  assert.match(docs, /KrakenD/);
  assert.match(siteJs, /ArrowRight/);
  assert.match(siteJs, /prefers-reduced-motion/);
  assert.match(docsJs, /config-search/);
  assert.match(docsJs, /data-copy-code/);
  assert.match(css, /@media\(max-width:(?:560|600)px\)/);
  assert.match(css, /focus-visible/);
  await access(resolve(root, 'website/dist/README.md'));
  await access(resolve(root, 'website/dist/docs/coverage.md'));
});

