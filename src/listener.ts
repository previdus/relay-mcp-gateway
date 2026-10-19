import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Express } from 'express';

export type GatewayListener = HttpServer | HttpsServer;

/** Builds the production listener. In mTLS mode, TLS terminates here so identity uses the verified socket peer. */
export async function createGatewayListener(app: Express, environment: NodeJS.ProcessEnv = process.env): Promise<GatewayListener> {
  const paths = [environment.GATEWAY_TLS_CERT_FILE, environment.GATEWAY_TLS_KEY_FILE, environment.GATEWAY_MTLS_CLIENT_CA_FILE];
  if (!paths.some(Boolean)) return createHttpServer(app);
  if (paths.some(value => !value)) throw new Error('mTLS requires gateway TLS certificate, key, and client CA files');
  const [cert, key, ca] = await Promise.all(paths.map(path => readFile(path!)));
  return createHttpsServer({ cert, key, ca, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2' }, app);
}
