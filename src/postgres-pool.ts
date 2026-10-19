import net from 'node:net';
import type { LookupAddress } from 'node:dns';
import pg from 'pg';
import { environmentCredentialBindings } from './credential-bindings.js';
import { assertEgressEndpointAllowed, pinnedEgressLookup, validateEgressCidrs, type EgressPolicy } from './egress.js';

function postgresDestination(connectionString: string, env: NodeJS.ProcessEnv): { endpoint: URL; connectionString: string } {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error('Database URL must be a PostgreSQL URL when strict egress is enabled'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) throw new Error('Database URL must be a PostgreSQL URL when strict egress is enabled');
  // node-postgres accepts host/port query overrides. Bind and validate the destination
  // the driver will actually use, not just the authority portion of the URL.
  const rawHost = url.searchParams.getAll('host').at(-1) || url.hostname || env.PGHOST;
  const host = rawHost?.replace(/^\[|\]$/g, '');
  const portText = url.searchParams.getAll('port').at(-1) || url.port || env.PGPORT || '5432';
  const port = Number(portText);
  const database = decodeURIComponent(url.pathname.slice(1)) || env.PGDATABASE || env.PGUSER || env.USER || 'postgres';
  if (!host || host.includes(',') || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !database || host.startsWith('/')) {
    throw new Error('Database URL has an unsupported destination');
  }
  const authorityHost = net.isIP(host) === 6 ? `[${host}]` : host;
  const endpoint = new URL(`postgresql://${authorityHost}:${port}/${encodeURIComponent(database)}`);
  // Normalize host/port overrides into the authority so node-postgres cannot
  // silently apply a different PGHOST/PGPORT after this destination is checked.
  const normalized = new URL(url.href);
  normalized.searchParams.delete('host');
  normalized.searchParams.delete('port');
  normalized.host = `${authorityHost}:${port}`;
  if (!normalized.pathname || normalized.pathname === '/') normalized.pathname = `/${encodeURIComponent(database)}`;
  const sslMode = normalized.searchParams.getAll('sslmode').at(-1) || env.PGSSLMODE;
  const sslValue = normalized.searchParams.getAll('ssl').at(-1);
  const weakTlsMode = Boolean(sslMode && sslMode !== 'verify-full') || Boolean(sslValue && !['1', 'true'].includes(sslValue));
  if (weakTlsMode) throw new Error('Strict database egress requires sslmode=verify-full');
  normalized.searchParams.set('sslmode', 'verify-full');
  return { endpoint, connectionString: normalized.href };
}

function pinnedSocketFactory(lookup: ReturnType<typeof pinnedEgressLookup>): () => net.Socket {
  return () => {
    const socket = new net.Socket();
    const connect = socket.connect.bind(socket) as (...args: unknown[]) => net.Socket;
    // node-postgres creates a fresh stream per pooled connection, then calls
    // stream.connect(port, host). Translate that supported stream hook to Node's
    // documented connect options so DNS validation occurs for every new socket.
    socket.connect = ((port: number | string | net.SocketConnectOpts, host?: string | (() => void), callback?: () => void) => {
      if (typeof port === 'number' && typeof host === 'string') {
        return connect({ port, host, lookup, autoSelectFamily: true }, callback);
      }
      return connect(port, host, callback);
    }) as typeof socket.connect;
    return socket;
  };
}

export function createPostgresPool(env: NodeJS.ProcessEnv, resolveAddresses?: (hostname: string) => Promise<LookupAddress[]>): pg.Pool | undefined {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return undefined;
  if (env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS !== undefined && !['true', 'false'].includes(env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS)) throw new Error('Invalid credential binding enforcement mode');
  if (env.GATEWAY_REQUIRE_EGRESS_VALIDATION !== undefined && !['true', 'false'].includes(env.GATEWAY_REQUIRE_EGRESS_VALIDATION)) throw new Error('Invalid egress validation mode');
  const requireBindings = env.GATEWAY_REQUIRE_CREDENTIAL_BINDINGS === 'true';
  const requireEgress = requireBindings || env.GATEWAY_REQUIRE_EGRESS_VALIDATION === 'true';
  if (env.GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS !== undefined && !requireEgress) throw new Error('Private egress CIDRs require egress validation to be enabled');

  const destination = requireEgress ? postgresDestination(connectionString, env) : undefined;
  if (requireBindings) {
    const bindings = environmentCredentialBindings(env);
    if (!bindings) throw new Error('Database URL requires deployment credential bindings');
    bindings.assertAllowed('DATABASE_URL', destination!.endpoint.href, 'database');
  }

  const policy: EgressPolicy | undefined = requireEgress ? {
    allowedPrivateCidrs: validateEgressCidrs(env.GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS?.split(',').map(cidr => cidr.trim()) ?? []),
    ...(resolveAddresses ? { resolveAddresses } : {})
  } : undefined;
  if (destination && policy) assertEgressEndpointAllowed(destination.endpoint, policy);
  const lookup = policy ? pinnedEgressLookup(policy) : undefined;
  return new pg.Pool({
    connectionString: destination?.connectionString ?? connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    ...(lookup ? { stream: pinnedSocketFactory(lookup) } : {})
  });
}
