/** Fixed deployment-owned endpoints only; never derive these URLs from a caller token. */
export function securityEndpoint(value: string, allowLocalHttp = false): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Security endpoint requires HTTPS or explicit loopback HTTP, without credentials, query or fragment');
  return url;
}

/** Enforce the byte limit while reading, including chunked bodies without Content-Length. */
export async function boundedJson(response: Response, maxBytes = 16384): Promise<Record<string, unknown>> {
  if (!response.ok || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid security service response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty security service response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('Security service response too large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid security service document');
  return value as Record<string, unknown>;
}
