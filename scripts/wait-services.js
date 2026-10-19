const url = process.env.TEST_FGA_URL ?? 'http://127.0.0.1:58080';
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try { if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw new Error('OpenFGA did not become ready');

const opaUrl = process.env.TEST_OPA_URL ?? 'http://127.0.0.1:58181/v1/data/mcp/authz/allow';
ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(new URL('/health', opaUrl), { signal: AbortSignal.timeout(1000) });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw new Error('OPA did not become ready');
