import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createPostgresPool } from '../dist/postgres-pool.js';

async function receiver(t) {
  let hits = 0;
  const server = net.createServer(socket => { hits++; socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return { port: server.address().port, hits: () => hits };
}

test('strict database egress denies the whole unsafe DNS answer before PostgreSQL credentials reach a socket', async t => {
  const target = await receiver(t); let resolutions = 0;
  const pool = createPostgresPool({
    DATABASE_URL: `postgresql://gateway-user:database-secret@database-egress.test:${target.port}/gateway`,
    GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true'
  }, async hostname => {
    resolutions++;
    assert.equal(hostname, 'database-egress.test');
    return [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }];
  });
  assert.ok(pool);
  await assert.rejects(pool.connect(), /denied/i);
  await pool.end();
  assert.equal(resolutions, 1);
  assert.equal(target.hits(), 0);
});

test('strict database egress pins approved private DNS answers on every new PostgreSQL socket', async t => {
  const target = await receiver(t); let resolutions = 0;
  const pool = createPostgresPool({
    DATABASE_URL: `postgresql://gateway-user:database-secret@database-allowed.test:${target.port}/gateway`,
    GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true',
    GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8'
  }, async hostname => {
    resolutions++;
    assert.equal(hostname, 'database-allowed.test');
    return [{ address: '127.0.0.1', family: 4 }];
  });
  assert.ok(pool);
  await assert.rejects(pool.connect());
  await pool.end();
  assert.equal(resolutions, 1);
  assert.equal(target.hits(), 1, 'the allowed DNS answer must be the address used by the actual socket');
});

test('strict credential-binding mode pins DATABASE_URL to an exact credential-free PostgreSQL destination', async () => {
  const endpoint = 'postgresql://database.example:5432/gateway';
  const bindings = [{ reference: 'DATABASE_URL', endpoint, purpose: 'database' }];
  const pool = createPostgresPool({
    DATABASE_URL: 'postgresql://gateway-user:database-secret@database.example/gateway',
    GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true',
    GATEWAY_CREDENTIAL_BINDINGS: JSON.stringify(bindings)
  }, async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.ok(pool);
  await pool.end();

  assert.throws(() => createPostgresPool({
    DATABASE_URL: 'postgresql://gateway-user:database-secret@other.example/gateway',
    GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true',
    GATEWAY_CREDENTIAL_BINDINGS: JSON.stringify(bindings)
  }), /not approved/);
});

test('strict database destination uses node-postgres host and port query overrides', () => {
  assert.throws(() => createPostgresPool({
    DATABASE_URL: 'postgresql://database.example/gateway?host=127.0.0.1',
    GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true'
  }), /denied/);
});

test('strict database binding accounts for node-postgres PGPORT fallback values', async () => {
  const pool = createPostgresPool({
    DATABASE_URL: 'postgresql:///gateway',
    PGHOST: 'database.example',
    PGPORT: '55432',
    GATEWAY_REQUIRE_CREDENTIAL_BINDINGS: 'true',
    GATEWAY_CREDENTIAL_BINDINGS: JSON.stringify([{ reference: 'DATABASE_URL', endpoint: 'postgresql://database.example:55432/gateway', purpose: 'database' }])
  });
  assert.ok(pool);
  await pool.end();
});

test('strict PostgreSQL egress negotiates verified TLS by default before sending startup credentials', async t => {
  let firstPacket;
  const server = net.createServer(socket => {
    socket.once('data', packet => { firstPacket = Buffer.from(packet); socket.end('N'); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  const pool = createPostgresPool({
    DATABASE_URL: `postgresql://gateway-user:database-secret@database-tls.test:${server.address().port}/gateway`,
    GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true',
    GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8'
  }, async hostname => {
    assert.equal(hostname, 'database-tls.test');
    return [{ address: '127.0.0.1', family: 4 }];
  });
  assert.ok(pool);
  await assert.rejects(pool.connect(), /SSL|server does not support/i);
  await pool.end();
  assert.ok(firstPacket?.length >= 8);
  assert.equal(firstPacket.readInt32BE(0), 8, 'client starts with the PostgreSQL SSLRequest');
  assert.equal(firstPacket.readInt32BE(4), 80877103, 'password and startup parameters are withheld until TLS is accepted');
});

test('strict PostgreSQL egress rejects insecure TLS modes for every destination', async () => {
  for (const mode of ['disable', 'no-verify', 'prefer', 'require', 'verify-ca']) {
    assert.throws(() => createPostgresPool({
      DATABASE_URL: `postgresql://database.example/gateway?sslmode=${mode}`,
      GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true'
    }), /requires sslmode=verify-full/);
  }
  assert.throws(() => createPostgresPool({
    DATABASE_URL: 'postgresql://127.0.0.1:5432/gateway?sslmode=disable',
    GATEWAY_REQUIRE_EGRESS_VALIDATION: 'true',
    GATEWAY_EGRESS_ALLOWED_PRIVATE_CIDRS: '127.0.0.0/8'
  }), /requires sslmode=verify-full/);
});
