import type { Server } from 'node:http';

/** Stop accepting new requests, let active work drain, then close remaining HTTP streams. */
export function closeHttpServer(server: Server, drainTimeoutMs = 120_000): Promise<void> {
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 120_000) throw new Error('Invalid HTTP drain timeout');
  return new Promise((resolve, reject) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), drainTimeoutMs);
    forceClose.unref();
    server.close(error => {
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
  });
}
