import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

const allowedPrivateNetworks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fc00::/7', '::1/128'];
const forbiddenPrivateRanges = new Set(['loopback', 'private', 'uniqueLocal']);

/** Only private RFC1918/ULA ranges and loopback can be allowlisted; link-local metadata and special ranges stay denied. */
export function validateEgressCidrs(cidrs: readonly string[] = []): string[] {
  if (!Array.isArray(cidrs) || cidrs.length > 64) throw new Error('Invalid egress CIDR allowlist');
  const normalized = new Set<string>();
  for (const cidr of cidrs) {
    if (typeof cidr !== 'string' || cidr.length > 64) throw new Error('Invalid egress CIDR allowlist');
    let parsed: [ipaddr.IPv4 | ipaddr.IPv6, number];
    try { parsed = ipaddr.parseCIDR(cidr); } catch { throw new Error('Invalid egress CIDR allowlist'); }
    const [network, prefix] = parsed;
    const source = ipaddr.parse(cidr.slice(0, cidr.lastIndexOf('/')));
    const canonicalNetwork = network.kind() === 'ipv4' ? ipaddr.IPv4.networkAddressFromCIDR(cidr) : ipaddr.IPv6.networkAddressFromCIDR(cidr);
    if (source.toString() !== canonicalNetwork.toString()) throw new Error('Egress CIDRs must use canonical network addresses');
    const allowed = allowedPrivateNetworks.some(parent => {
      const [parentNetwork, parentPrefix] = ipaddr.parseCIDR(parent);
      return network.kind() === parentNetwork.kind() && prefix >= parentPrefix && network.match(parentNetwork, parentPrefix);
    });
    if (!allowed) throw new Error('Egress CIDRs may only include RFC1918, ULA, or loopback networks');
    normalized.add(`${canonicalNetwork.toString()}/${prefix}`);
  }
  return [...normalized];
}

function safeAddress(address: string, allowedCidrs: readonly string[]): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try { parsed = ipaddr.parse(address); } catch { return false; }
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) return false;
  const range = parsed.range();
  if (range === 'unicast') return true;
  if (!forbiddenPrivateRanges.has(range)) return false;
  return allowedCidrs.some(cidr => {
    const [network, prefix] = ipaddr.parseCIDR(cidr);
    return parsed.kind() === network.kind() && parsed.match(network, prefix);
  });
}

export interface EgressPolicy {
  /** Narrow private ranges explicitly approved for this deployment. Special-use and link-local ranges remain denied. */
  allowedPrivateCidrs?: readonly string[];
  resolutionTimeoutMs?: number;
  /** Test seam for deterministic resolution. Production callers should omit it. */
  resolveAddresses?: (hostname: string) => Promise<LookupAddress[]>;
}

function deniedAddress(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Upstream address denied for ${hostname}`), { code: 'EACCES' });
}

export function pinnedLookup(allowedCidrs: readonly string[], resolve: NonNullable<EgressPolicy['resolveAddresses']>, timeoutMs: number): LookupFunction {
  return (hostname, options, callback) => {
    let completed = false;
    const timer = setTimeout(() => {
      completed = true;
      callback(Object.assign(new Error('Upstream DNS lookup timed out'), { code: 'ETIMEDOUT' }), options.all ? [] : '', 0);
    }, timeoutMs);
    void resolve(hostname).then(addresses => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (!addresses.length || addresses.length > 64 || addresses.some(({ address, family }) => !safeAddress(address, allowedCidrs) || (family !== 4 && family !== 6) || (ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6) !== family)) {
        callback(deniedAddress(hostname), options.all ? [] : '', 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const selected = addresses.find(item => !options.family || options.family === item.family);
      if (!selected) callback(Object.assign(new Error('No upstream address matches the requested family'), { code: 'EAI_ADDRFAMILY' }), '', 0);
      else callback(null, selected.address, selected.family);
    }).catch(() => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      callback(deniedAddress(hostname), options.all ? [] : '', 0);
    });
  };
}

export function pinnedEgressLookup(egress: EgressPolicy): LookupFunction {
  const allowedCidrs = validateEgressCidrs(egress.allowedPrivateCidrs);
  const timeoutMs = egress.resolutionTimeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000) throw new Error('Invalid egress resolution timeout');
  const resolve = egress.resolveAddresses ?? (hostname => new Promise<LookupAddress[]>((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
  }));
  return pinnedLookup(allowedCidrs, resolve, timeoutMs);
}

/** Literal IPs can bypass Node's lookup callback, so validate them before creating an exporter request. */
export function assertEgressEndpointAllowed(endpoint: string | URL, egress: EgressPolicy): void {
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(hostname) && !safeAddress(hostname, validateEgressCidrs(egress.allowedPrivateCidrs))) throw deniedAddress(hostname);
}

/** Restrict every transport HTTP request, including SSE endpoint events, to its configured origin and vetted connect-time DNS answers. */
export function upstreamFetch(endpoint: string, maximumBytes = 4 * 1024 * 1024, requestPaths?: readonly string[], egress?: EgressPolicy): typeof fetch {
  const origin = new URL(endpoint).origin;
  const allowedCidrs = validateEgressCidrs(egress?.allowedPrivateCidrs);
  const agent = egress ? new Agent({ maxOrigins: 1, connect: { lookup: pinnedEgressLookup(egress) } }) : undefined;
  const guardedFetch: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== origin || target.username || target.password) throw new Error('Cross-origin upstream request denied');
    if (requestPaths && !requestPaths.includes(target.pathname)) throw new Error('Upstream request path denied');
    const literalHost = target.hostname.replace(/^\[|\]$/g, '');
    if (egress && ipaddr.isValid(literalHost) && !safeAddress(literalHost, allowedCidrs)) throw deniedAddress(literalHost);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of ['host', 'proxy-authorization', 'proxy-connection', 'connection', 'upgrade', 'transfer-encoding']) if (headers.has(name)) throw new Error('Unsafe upstream transport header');
    const requestInit = { ...init, redirect: 'error' as const, ...(agent ? { dispatcher: agent } : {}) } as RequestInit;
    const response = await fetch(input, requestInit);
    if (Number(response.headers.get('content-length')) > maximumBytes) {
      void response.body?.cancel();
      throw new Error('Upstream response exceeds byte limit');
    }
    if (!response.body) return response;
    let received = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maximumBytes) controller.error(new Error('Upstream response exceeds byte limit'));
        else controller.enqueue(chunk);
      }
    }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  // The transport owns this dispatcher and closes it with its own lifecycle.
  Object.defineProperty(guardedFetch, 'closeEgress', { value: () => agent?.close() });
  return guardedFetch;
}

export async function closeEgressFetch(fetcher: typeof fetch): Promise<void> {
  const close = (fetcher as typeof fetch & { closeEgress?: () => Promise<void> }).closeEgress;
  if (close) await close();
}

/** Run one fixed security-service request with the same connect-time DNS pinning as MCP upstreams. */
export async function withEgressFetch<T>(endpoint: string | URL, maximumBytes: number, egress: EgressPolicy | undefined, operation: (fetcher: typeof fetch) => Promise<T>): Promise<T> {
  if (!egress) return operation(fetch);
  const url = new URL(endpoint);
  const fetcher = upstreamFetch(url.href, maximumBytes, [url.pathname], egress);
  try { return await operation(fetcher); }
  finally { await closeEgressFetch(fetcher); }
}
