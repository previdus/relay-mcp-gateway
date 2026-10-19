import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const siteRoot = await realpath(resolve(projectRoot, 'website', 'dist'));
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8']
]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname);
    const relativePath = decoded === '/' ? 'index.html' : decoded.slice(1);
    const filePath = resolve(siteRoot, relativePath);
    if (filePath !== siteRoot && !filePath.startsWith(siteRoot + sep)) {
      response.writeHead(400).end('Invalid path');
      return;
    }
    const content = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': mimeTypes.get(extname(filePath)) ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});
const port = Number(process.env.WEBSITE_PORT ?? 4173);
server.listen(port, '127.0.0.1', () => console.log('Relay website preview: http://127.0.0.1:' + port));

