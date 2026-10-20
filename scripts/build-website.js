import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'website', 'dist');
const requiredFiles = ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'];

await mkdir(output, { recursive: true });
for (const file of ['index.html', 'docs.html', 'lab.html', 'styles.css', 'visuals.css', 'site.js', 'docs.js', 'lab.js', 'lab.css']) {
  await writeFile(resolve(output, file), await readFile(resolve(root, 'website', file)));
}
for (const file of requiredFiles) {
  await writeFile(resolve(output, file), await readFile(resolve(root, file)));
}
await cp(resolve(root, 'docs'), resolve(output, 'docs'), { recursive: true, force: true });

const configuredEndpoint = process.env.RELAY_MCP_ENDPOINT ?? '';
let endpointValue = '';
if (configuredEndpoint) {
  const endpoint = new URL(configuredEndpoint);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.awsapprunner.com') || endpoint.pathname !== '/mcp') {
    throw new Error('RELAY_MCP_ENDPOINT must be an HTTPS App Runner /mcp URL');
  }
  endpointValue = endpoint.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
for (const page of ['index.html', 'docs.html', 'lab.html']) {
  let html = await readFile(resolve(output, page), 'utf8');
  html = html.replaceAll('__RELAY_MCP_ENDPOINT__', endpointValue);
  await writeFile(resolve(output, page), html);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const href of html.matchAll(/href="([^"]+)"/g)) {
    const target = href[1];
    if (/^(?:https?:|mailto:|javascript:|tel:)/.test(target)) continue;
    const [path, fragment] = target.split('#');
    if (fragment && path === '' && !ids.has(decodeURIComponent(fragment))) {
      throw new Error(`${page} anchor does not resolve: ${target}`);
    }
    if (!path) continue;
    const local = resolve(output, decodeURIComponent(path));
    try {
      const targetHtml = await readFile(local, 'utf8');
      if (fragment && local.endsWith('.html')) {
        const targetIds = new Set([...targetHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
        if (!targetIds.has(decodeURIComponent(fragment))) throw new Error('missing fragment');
      }
    }
    catch { throw new Error(`${page} link does not resolve in build output: ${target}`); }
  }
}
console.log(`Website built and local links checked: ${output}`);
