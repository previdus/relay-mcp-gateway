import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'website', 'dist');
const requiredFiles = ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'];

await mkdir(output, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await writeFile(resolve(output, file), await readFile(resolve(root, 'website', file)));
}
for (const file of requiredFiles) {
  await writeFile(resolve(output, file), await readFile(resolve(root, file)));
}
await cp(resolve(root, 'docs'), resolve(output, 'docs'), { recursive: true, force: true });

let html = await readFile(resolve(output, 'index.html'), 'utf8');
const configuredEndpoint = process.env.RELAY_MCP_ENDPOINT ?? '';
if (configuredEndpoint) {
  const endpoint = new URL(configuredEndpoint);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.awsapprunner.com') || endpoint.pathname !== '/mcp') {
    throw new Error('RELAY_MCP_ENDPOINT must be an HTTPS App Runner /mcp URL');
  }
  html = html.replace('__RELAY_MCP_ENDPOINT__', endpoint.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;'));
} else html = html.replace('__RELAY_MCP_ENDPOINT__', '');
await writeFile(resolve(output, 'index.html'), html);
for (const href of html.matchAll(/href="([^"]+)"/g)) {
  const target = href[1];
  if (/^(?:https?:|#|mailto:)/.test(target)) continue;
  const local = resolve(output, target.split('#')[0]);
  try { await readFile(local); }
  catch { throw new Error(`Website link does not resolve in build output: ${target}`); }
}
console.log(`Website built and local links checked: ${output}`);
