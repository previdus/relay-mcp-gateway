import { randomUUID } from 'node:crypto';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/client';

type RawRequest = { jsonrpc: '2.0'; id: string; method: string; params?: Record<string, unknown> };
type RawResponse = { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** Multiplexes extension responses before the base SDK's method-specific decoder rejects them. */
export class RawTaskTransport implements Transport {
  private listener?: Transport['onmessage'];
  private readonly pending = new Map<string, { resolve: (response: RawResponse) => void; reject: (error: Error) => void }>();
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  constructor(private readonly inner: Transport) {
    inner.onmessage = (message, extra) => {
      const messages = Array.isArray(message) ? message : [message];
      const forwarded: typeof messages = [];
      for (const item of messages) {
        if (item && typeof item === 'object' && 'id' in item) {
          const key = String(item.id), waiter = this.pending.get(key);
          if (waiter) { this.pending.delete(key); waiter.resolve(item as RawResponse); continue; }
        }
        forwarded.push(item);
      }
      if (forwarded.length) this.listener?.((Array.isArray(message) ? forwarded : forwarded[0]) as never, extra as never);
    };
    inner.onerror = error => { for (const waiter of this.pending.values()) waiter.reject(error instanceof Error ? error : new Error('MCP transport failed')); this.pending.clear(); this.onerror?.(error); };
    inner.onclose = () => { for (const waiter of this.pending.values()) waiter.reject(new Error('MCP transport closed')); this.pending.clear(); this.onclose?.(); };
  }
  set onmessage(value: Transport['onmessage']) { this.listener = value; }
  get onmessage() { return this.listener; }
  start() { return this.inner.start(); }
  close() { for (const waiter of this.pending.values()) waiter.reject(new Error('MCP transport closed')); this.pending.clear(); return this.inner.close(); }
  send(message: Parameters<Transport['send']>[0], options?: TransportSendOptions) { return this.inner.send(message, options); }
  async dispatch(request: Omit<RawRequest, 'jsonrpc' | 'id'>, options: { signal: AbortSignal; timeout: number; headers?: Readonly<Record<string, string>> }): Promise<RawResponse> {
    const id = `gateway-task-${randomUUID()}`;
    const requestMessage: RawRequest = { jsonrpc: '2.0', id, ...request };
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout)]);
    signal.throwIfAborted();
    const response = new Promise<RawResponse>((resolve, reject) => {
      const abort = () => { this.pending.delete(id); reject(signal.reason instanceof Error ? signal.reason : new Error('MCP request aborted')); };
      this.pending.set(id, { resolve: value => { signal.removeEventListener('abort', abort); resolve(value); }, reject: error => { signal.removeEventListener('abort', abort); reject(error); } });
      signal.addEventListener('abort', abort, { once: true });
    });
    void response.catch(() => {});
    try {
      await this.inner.send(requestMessage as never, { requestSignal: signal, headers: options.headers });
      return await response;
    } catch (error) {
      const waiter = this.pending.get(id);
      if (waiter) { this.pending.delete(id); waiter.reject(error instanceof Error ? error : new Error('MCP request failed')); }
      throw error;
    }
  }
}
