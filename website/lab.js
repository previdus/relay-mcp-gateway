const scenarios = [
  { id: 'incident', label: 'Incident investigation', tag: 'LIVE · READ PATH', title: 'Investigate the checkout incident', result: 'allow', agent: 'reader · synthetic records', decision: 'Allowed', policy: 'reader may search', server: 'Jira · OPS-204', tool: 'jira__search', args: { query: 'checkout' }, preview: 'Returns OPS-204 plus related synthetic records from other services as you query each server.', steps: ['Codex authenticates with the public read-only demo identity.', 'The gateway filters the catalog to tools granted to this identity.', 'A Jira search for “checkout” matches the linked incident fixture OPS-204.', 'Call slack__search, logs__query, drive__read_file, aws__cloudwatch_logs and observability__get_trace to follow the same incident across services.'], explanation: 'All fixture records use the OPS-204 incident tag and demo-only identities. This demonstrates catalog federation through distinct MCP servers; it never contacts real Jira or cloud accounts.' },
  { id: 'read', label: 'Read a runbook', tag: 'LIVE · AUTHORIZED READ', title: 'Read the certificate rotation runbook', result: 'allow', agent: 'reader · synthetic records', decision: 'Allowed', policy: 'read tool is granted', server: 'Drive · runbooks', tool: 'drive__read_file', args: { fileId: 'runbook-mtls' }, preview: 'Returns a synthetic runbook with certificate and mTLS rotation steps.', steps: ['Use the read-only Codex profile from the setup below.', 'Call drive__read_file with runbook-mtls.', 'Relay rechecks the tool grant at execution time.', 'The Drive fixture returns the content associated with that stable ID.'], explanation: 'The file ID is constrained to the fixed in-memory demo dataset. No Google Drive integration or organization data is involved.' },
  { id: 'deny', label: 'Read-only denies write', tag: 'LIVE · EXPECTED DENIAL', title: 'A reader tries to post a review comment', result: 'deny', agent: 'reader · read-only', decision: 'Denied', policy: 'preview write not granted', server: 'No upstream call', tool: 'github__preview_review_comment', args: { pullRequest: 'PR-204', body: 'Please merge this change.' }, preview: 'Expected: authorization error. The read-only identity will not discover this tool, and a direct call is denied before GitHub demo dispatch.', steps: ['Connect as “Read-only explorer” using the config below.', 'Attempt github__preview_review_comment with the sample arguments.', 'Discovery omits the preview tool for this identity.', 'Even if a client sends the name directly, Relay denies the call before contacting the server.'], explanation: 'This is a real identity-level tool grant in the hosted demo. The preview operator can call this tool; the reader cannot. The backend never posts a real review.' },
  { id: 'bad-auth', label: 'Invalid key rejected', tag: 'LIVE · AUTHENTICATION DENIAL', title: 'An unknown caller is stopped at the gateway', result: 'deny', agent: 'unknown · invalid token', decision: '401 · denied', policy: 'identity not established', server: 'No upstream call', tool: 'tools/list', args: {}, preview: 'Expected: HTTP 401. No tool catalog or upstream result is returned.', steps: ['Choose “Invalid key (negative test)” in the connection controls.', 'Restart or refresh the MCP client so it sends the shown test credential.', 'The gateway fails authentication before discovery or execution.', 'Switch back to a demo identity to continue.'], explanation: 'The deliberately invalid value is not a working credential. Authentication and authorization failures happen before an upstream credential is resolved.' },
  { id: 'route', label: 'Compare routing targets', tag: 'LIVE · ROUTING', title: 'Route the same search to different backends', result: 'allow', agent: 'reader · synthetic records', decision: 'Allowed', policy: 'grant + target eligibility', server: 'Priority alias → Jira', tool: 'enterprise_search', args: { query: 'credential rotation' }, preview: 'This alias uses priority routing. It selects one configured eligible target; it does not fan out to every service.', steps: ['Call enterprise_search with “credential rotation”.', 'The gateway resolves the configured alias target pool.', 'Priority routing chooses the first healthy eligible MCP target.', 'Call jira__search, slack__search and github__search directly to compare independent data.'], explanation: 'The sample deliberately distinguishes priority selection from fan-out aggregation. The alias is not described as a multi-backend search.' },
  { id: 'mtls', label: 'mTLS · two TLS sessions', tag: 'ARCHITECTURE · LOCAL TEST', title: 'Authenticate both sides of the gateway', result: 'allow', agent: 'agent certificate A', decision: 'Verify then route', policy: 'gateway identity mapping', server: 'Upstream certificate B', tool: 'gateway → upstream TLS', args: null, preview: 'Run npm run test:mtls for the local gateway handshake exercise. Use deployment-owned certificates; the public hosted demo does not request client certificates.', steps: ['The client starts TLS session 1 and proves possession of its certificate to the gateway.', 'Relay maps the verified certificate to a principal and applies tool permissions.', 'Relay starts a separate TLS session 2 to the selected upstream using a gateway certificate.', 'The upstream validates certificate B. The client private key never leaves the client.'], explanation: 'A TLS client certificate is proof-of-possession on one connection. It cannot be forwarded as a reusable identity token. Per-user upstream certificates need a trusted credential provider.' },
  { id: 'mtls-deny', label: 'mTLS · reject untrusted peer', tag: 'NEGATIVE · LOCAL TLS TEST', title: 'Reject an untrusted agent certificate', result: 'deny', agent: 'missing / untrusted cert', decision: 'TLS handshake denied', policy: 'peer CA verification', server: 'No HTTP request reaches Relay', tool: 'inbound TLS handshake', args: null, preview: 'Run npm run test:mtls. The test proves TLS rejection before MCP initialization; no bearer fallback or upstream call is attempted.', steps: ['Connect without a client certificate or present a certificate signed by an untrusted CA.', 'The TLS listener rejects the handshake before an HTTP request exists.', 'Forwarded identity headers or bearer tokens cannot substitute for the missing certificate proof.', 'The gateway does not create an upstream TLS session.'], explanation: 'Use the local mTLS listener test with trusted and untrusted peers. The hosted public endpoint does not require certificates and cannot demonstrate this handshake.' },
  { id: 'oauth', label: 'OAuth · delegated access', tag: 'ARCHITECTURE · CONFIGURABLE', title: 'Exchange a caller token for an upstream audience', result: 'allow', agent: 'verified JWT subject', decision: 'Exchange at issuer', policy: 'scope + destination binding', server: 'Resource-specific token', tool: 'MCP tools/call', args: null, preview: 'Set the upstream OAuth token-exchange profile, exact resource audience, and credential bindings. Use an IdP test tenant to run the exchange.', steps: ['The agent presents a token issued for this gateway; Relay validates issuer, audience and claims.', 'Relay checks the caller’s tool entitlement and selected upstream policy.', 'The credential provider requests a resource-specific downstream token from the configured issuer.', 'Only that upstream receives its own audience-bound token; no cross-resource bearer pass-through occurs.'], explanation: 'MCP authorization requires audience validation and warns against token passthrough. Some SaaS providers need interactive user consent and refresh-token storage that must be supplied by a compatible IdP or credential plugin.' },
  { id: 'oauth-deny', label: 'OAuth · reject wrong audience', tag: 'NEGATIVE · TOKEN BOUNDARY', title: 'Stop a token issued for another resource', result: 'deny', agent: 'JWT audience ≠ gateway', decision: 'Rejected before exchange', policy: 'issuer + audience check', server: 'No upstream token issued', tool: 'OAuth validation', args: null, preview: 'Expected: authentication/exchange failure. A Jira or Gmail token is never copied to another resource.', steps: ['Present an otherwise valid JWT whose audience names a different MCP resource.', 'The configured JWT validator rejects the mismatch at gateway authentication.', 'No tool permission or route can override the audience check.', 'The upstream receives no request and no inbound bearer token.'], explanation: 'The gateway authentication mode must be configured with the resource audience it serves. A JWT accepted for another API does not automatically authenticate this gateway.' },
  { id: 'approval', label: 'Approval · exact intent', tag: 'ARCHITECTURE · ADAPTER REQUIRED', title: 'Review a write before dispatch', result: 'deny', agent: 'authorized operator', decision: 'Awaiting reviewer', policy: 'exact args + route bound', server: 'No dispatch before approval', tool: 'jira__create_issue', args: { project: 'OPS', summary: 'Review OPS-204 recovery' }, preview: 'The gateway has a fail-closed approval adapter. Configure an external reviewer service to execute this full path; a static mock approval would not prove reviewer identity.', steps: ['The operator requests a preview-safe write for a synthetic Jira issue.', 'The policy adapter stores the caller, tool, route, configuration revision and argument digest.', 'An authenticated reviewer approves or rejects that exact intent outside the agent.', 'On resume, Relay rechecks policy and intent; only an exact one-use approval can reach the upstream.'], explanation: 'The current gateway integrates an external approval gate and verifies a one-use permit, but does not bundle a reviewer portal. Approval is not enabled in the public cloud demo.' }
];

const $ = selector => document.querySelector(selector);
const list = $('#scenario-list');
const flow = $('#lab-flow');
let activeId = scenarios[0].id;
let playTimer;
const escapeToml = value => JSON.stringify(value);
const endpointInput = $('#gateway-endpoint');
const endpointMeta = document.querySelector('meta[name="relay-mcp-endpoint"]')?.content ?? '';
endpointInput.value = endpointMeta || 'https://YOUR-APP-RUNNER-URL/mcp';

for (const scenario of scenarios) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'lab-scenario'; button.role = 'option'; button.dataset.scenario = scenario.id;
  const badge = scenario.tag.startsWith('LIVE') ? 'LIVE' : 'GUIDE';
  button.innerHTML = `<span class="lab-scenario-status ${badge === 'LIVE' ? 'is-live' : ''}">${badge}</span><b></b><small></small>`;
  button.querySelector('b').textContent = scenario.label;
  button.querySelector('small').textContent = scenario.tag.replace(/^(LIVE|ARCHITECTURE) · /, '');
  button.setAttribute('aria-selected', String(scenario.id === activeId));
  button.addEventListener('click', () => selectScenario(scenario.id));
  list.append(button);
}

function selectScenario(id) {
  activeId = id;
  const scenario = scenarios.find(item => item.id === id);
  clearTimeout(playTimer);
  document.querySelectorAll('.lab-scenario').forEach(button => button.setAttribute('aria-selected', String(button.dataset.scenario === id)));
  $('#scenario-kicker').textContent = scenario.tag;
  $('#scenario-title').textContent = scenario.title;
  $('#scenario-description').textContent = scenario.explanation;
  $('#flow-agent').textContent = scenario.agent;
  $('#flow-decision').textContent = scenario.decision;
  $('#flow-policy').textContent = scenario.policy;
  $('#flow-server').textContent = scenario.server;
  flow.dataset.result = scenario.result;
  flow.querySelectorAll('[data-state]').forEach(node => node.removeAttribute('data-state'));
  flow.querySelectorAll('.lab-flow-edge').forEach(edge => edge.removeAttribute('data-state'));
  const outcome = $('#lab-outcome'); outcome.dataset.result = scenario.result;
  $('.lab-outcome-icon').textContent = scenario.result === 'allow' ? '✓' : '⊘';
  $('#outcome-title').textContent = scenario.result === 'allow' ? (scenario.tag.startsWith('LIVE') ? 'Allowed path' : 'Expected safe path') : (scenario.tag.includes('DENIAL') || scenario.id === 'deny' ? 'Expected denial' : 'Execution is held');
  $('#outcome-copy').textContent = scenario.preview;
  $('#request-tool').textContent = scenario.tool;
  $('#request-json').textContent = scenario.args ? JSON.stringify({ name: scenario.tool, arguments: scenario.args }, null, 2) : scenario.preview;
  $('#request-result').textContent = scenario.tag.startsWith('LIVE') ? `Demo response shape: ${scenario.preview}` : 'Not executed in the hosted demo. Follow the local or IdP-specific steps above.';
  const steps = $('#scenario-steps'); steps.replaceChildren();
  for (const [index, text] of scenario.steps.entries()) { const li = document.createElement('li'); li.dataset.step = String(index); li.textContent = text; steps.append(li); }
}

function renderCodexConfig() {
  const persona = $('#demo-persona').value;
  const token = persona === 'reader' ? 'relay-public-reader-demo-token' : persona === 'operator' ? 'relay-public-echo-demo-token' : 'deliberately-invalid-demo-token';
  const endpoint = endpointInput.value.trim() || 'https://YOUR-APP-RUNNER-URL/mcp';
  const config = `[mcp_servers.relay_demo]\nurl = ${escapeToml(endpoint)}\nhttp_headers = { Authorization = ${escapeToml(`Bearer ${token}`)} }`;
  $('#codex-config').textContent = config;
  return config;
}
$('#demo-persona').addEventListener('change', renderCodexConfig);
endpointInput.addEventListener('input', renderCodexConfig);
renderCodexConfig();

$('#play-scenario').addEventListener('click', event => {
  const playButton = event.currentTarget;
  clearTimeout(playTimer);
  const scenario = scenarios.find(item => item.id === activeId);
  const nodes = [...flow.querySelectorAll('[data-flow-node]')];
  const edges = [...flow.querySelectorAll('.lab-flow-edge')];
  const steps = [...$('#scenario-steps').children];
  nodes.forEach(node => node.removeAttribute('data-state'));
  edges.forEach(edge => edge.removeAttribute('data-state'));
  steps.forEach(step => step.removeAttribute('data-active'));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const delay = reduced ? 0 : 700;
  let index = 0;
  const tick = () => {
    if (index > 0) {
      nodes[index - 1]?.setAttribute('data-state', index === 2 && scenario.result === 'deny' ? 'denied' : 'passed');
      edges[index - 1]?.setAttribute('data-state', 'passed');
      steps[index - 1]?.removeAttribute('data-active');
    }
    if (index < nodes.length) {
      if (scenario.result === 'deny' && index === 3) {
        nodes[2]?.setAttribute('data-state', 'denied');
        edges[1]?.setAttribute('data-state', 'denied');
        $('#outcome-title').textContent = 'Stopped before upstream';
        $('#outcome-copy').textContent = scenario.preview;
        playButton.querySelector('span').textContent = 'Replay the flow';
        return;
      }
      nodes[index].setAttribute('data-state', 'active');
      steps[Math.min(index, steps.length - 1)]?.setAttribute('data-active', 'true');
      index++;
      playTimer = setTimeout(tick, delay);
    } else {
      nodes.at(-1)?.setAttribute('data-state', 'passed');
      steps.at(-1)?.removeAttribute('data-active');
      $('#outcome-title').textContent = scenario.tag.startsWith('LIVE') ? 'Gateway path illustrated · now try the call' : 'Architecture path illustrated';
      playButton.querySelector('span').textContent = 'Play again';
    }
  };
  playButton.querySelector('span').textContent = 'Playing…';
  tick();
});

async function copyText(button, text) {
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
  catch { button.textContent = 'Select text to copy'; const range = document.createRange(); range.selectNodeContents($('#codex-config')); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
  setTimeout(() => button.textContent = button.id === 'copy-codex-config' ? 'Copy Codex config' : 'Copy JSON', 1600);
}
$('#copy-codex-config').addEventListener('click', event => copyText(event.currentTarget, renderCodexConfig()));
document.querySelectorAll('[data-copy="request-json"]').forEach(button => button.addEventListener('click', () => copyText(button, $('#request-json').textContent)));
selectScenario(activeId);
