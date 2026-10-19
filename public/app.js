const $ = selector => document.querySelector(selector);
let key = '', revision = 0, draft, tab = 'overview', busy = false;
const labels = { safeguards: ['Action safeguards', 'Constrain tool arguments and review catalog exposure.'], explorer: ['Tool explorer', 'Discover tools using a service identity, review definitions, and test calls.'], history: ['Configuration history', 'Review earlier settings and publish a controlled rollback.'], traffic: ['Traffic controls', 'Limit bursts and protect failing upstreams.'], overview: ['Overview', 'One place for every connection.'], upstreams: ['Upstream servers', 'Bring your MCP servers into one governed entry point.'], clients: ['Access policies', 'Define exactly which tools each service can use.'], routes: ['Routing', 'Give tools a stable name. Choose where calls go.'], audit: ['Activity', 'Request metadata, without tool payloads or credentials.'], security: ['Identity security', 'Respond to a compromised JWT without waiting for it to expire.'], configuration: ['Configuration', 'Review the complete draft. Secrets stay in your environment.'] };
function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function message(text, error = false) { const e = $('#message'); e.textContent = text; e.className = error ? 'error' : ''; e.style.display = 'block'; }
function mirroredHeaders(schema, args) {
  const headers = {}, pending = [{ schema, value: args }];
  while (pending.length) {
    const { schema, value } = pending.pop();
    if (!schema || typeof schema !== 'object') continue;
    if (schema['x-mcp-header'] && value !== undefined && value !== null) {
      const text = String(value), bytes = new TextEncoder().encode(text);
      const encoded = !text || text !== text.trim() || /[^\x09\x20-\x7e]/u.test(text) || text.startsWith('=?base64?') && text.endsWith('?=') ? `=?base64?${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}?=` : text;
      headers[`Mcp-Param-${schema['x-mcp-header']}`] = encoded;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) pending.push({ schema: child, value: value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined });
  }
  return headers;
}
async function api(path, options = {}) {
  const response = await fetch(`/admin/api/${path}`, { ...options, headers: { Authorization: `Bearer ${key}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}
function dirty() { $('#revision').textContent = `Revision ${revision} · unpublished draft`; $('#revision').classList.add('draft'); }
async function reload() { const data = await api('config'); revision = data.revision; draft = data.document; $('#revision').textContent = `Revision ${revision} · connected`; $('#revision').classList.remove('draft'); await render(); }
$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault(); key = $('#admin-key').value;
  try { await reload(); $('#connection').hidden = true; $('#workspace').hidden = false; $('#admin-key').value = ''; message('Connected. Configuration loaded.'); }
  catch (error) { key = ''; message(error.message, true); }
});
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { if (!draft) return message('Connect to your gateway first.'); tab = button.dataset.tab; void render(); }));
$('#reload').addEventListener('click', () => { void reload().then(() => message('Latest configuration loaded.')).catch(e => message(e.message, true)); });
$('#save').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('#save').disabled = true;
  try {
    const saved = await api('config', { method: 'PUT', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify(draft) });
    revision = saved.revision; draft = saved.document; $('#revision').textContent = `Revision ${revision} · connected`; $('#revision').classList.remove('draft');
    await render(); message('Configuration published. New requests use the updated revision.');
  } catch (error) { message(error.message, true); }
  finally { busy = false; $('#save').disabled = false; }
});
function table(headers, rows) {
  const wrap = node('div', undefined, 'table-wrap'), table = node('table'), head = node('thead'), tr = node('tr');
  headers.forEach(label => tr.append(node('th', label))); head.append(tr); table.append(head);
  const body = node('tbody');
  rows.forEach(cells => { const tr = node('tr'); cells.forEach(value => { const td = node('td'); if (value instanceof Node) td.append(value); else td.textContent = value; tr.append(td); }); body.append(tr); });
  table.append(body); wrap.append(table); return wrap;
}
function panel(title, description, action) { const panel = node('div', undefined, 'panel'), head = node('div', undefined, 'panel-head'), heading = node('div'); heading.append(node('h2', title), node('p', description)); head.append(heading); if (action) head.append(action); panel.append(head); return panel; }
function button(text, action, className) { const b = node('button', text, className); b.type = 'button'; b.addEventListener('click', action); return b; }
function rowActions(kind, index) { const div = node('div'); div.append(button('Edit', () => edit(kind, index)), button('Remove', () => { draft[kind].splice(index, 1); dirty(); void render(); }, 'danger')); return div; }
async function render() {
  if (!draft) return;
  const [title, description] = labels[tab]; $('#page-title').textContent = title; $('#breadcrumb').textContent = title; $('#page-description').textContent = description;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('selected', b.dataset.tab === tab));
  const content = $('#content'); content.replaceChildren();
  if (tab === 'overview') {
    const cards = node('div', undefined, 'cards');
    [['Server definitions', draft.upstreams.length, 'Administrator-approved upstreams'], ['Service identities', draft.clients.length, 'Explicit permission boundaries'], ['Custom routes', (draft.routes ?? []).length, 'Aliases, weighted and sticky routing']].forEach(([label, value, detail]) => { const card = node('div', undefined, 'card'); card.append(node('div', label, 'card-label'), node('div', value, 'card-value'), node('small', detail)); cards.append(card); });
    content.append(cards);
    const p = panel('Connection directory', 'Registered upstreams · configuration inventory');
    p.append(table(['Server', 'Endpoint', 'Transport'], draft.upstreams.map(u => [u.id, u.url, node('span', u.transport ?? 'streamable-http', 'tag')]))); content.append(p);
    content.append(node('div', 'Policy is evaluated on discovery and every tool call. Publishing takes effect on new requests across replicas sharing PostgreSQL. Server counts indicate configured endpoints, not live health checks.', 'notice'));
  } else if (['upstreams', 'clients', 'routes'].includes(tab)) {
    const guidance = {
      upstreams: ['Connection flow', 'An upstream is a server the gateway connects to. Add its endpoint and transport first; then bind credentials and limits. Agents never connect to these URLs directly.', 'Example: server ID `inventory`, endpoint `https://inventory.internal/mcp`, secret reference `INVENTORY_TOKEN`.'],
      clients: ['Identity flow', 'A client is an agent or service identity. Authentication identifies the caller; the grants here decide which public tools it may discover and call. Empty tool grants deny all.', 'Example: identity `support-agent`, allow `inventory__lookup`, role `support-read`. Put token values in deployment secrets; this screen stores only the environment variable name.'],
      routes: ['Request flow', 'A route maps a stable public tool name to one or more upstream tools. The gateway checks identity and policy before choosing a target; it never retries a tool call automatically.', 'Example: public tool `catalog_search` → `inventory / search`. Weighted routes split eligible calls by weight; sticky routes keep a caller on one eligible target.']
    }[tab];
    const guide = node('div', undefined, 'guide-banner'); guide.append(node('span', 'HOW THIS PART FITS', 'eyebrow'), node('h2', guidance[0]), node('p', guidance[1]), node('code', guidance[2])); content.append(guide);
    const p = panel(title, 'Edit the draft, then publish when ready.', button(`+ Add ${tab === 'upstreams' ? 'server' : tab === 'clients' ? 'identity' : 'route'}`, () => edit(tab), 'primary'));
    let rows, headers;
    if (tab === 'upstreams') { headers = ['Server', 'Endpoint', 'Transport', '']; rows = draft.upstreams.map((u, i) => [u.id, u.url, u.transport ?? 'streamable-http', rowActions(tab, i)]); }
    if (tab === 'clients') { headers = ['Identity', 'Allowed tools', 'Credential reference', '']; rows = draft.clients.map((c, i) => [c.id, c.allow.join(', ') || 'Deny all', c.tokenEnv ?? (c.certificateSha256 ? 'Pinned mTLS certificate' : 'Verified OAuth identity'), rowActions(tab, i)]); }
    if (tab === 'routes') { headers = ['Public tool', 'Strategy', 'Targets', '']; rows = (draft.routes ?? []).map((r, i) => [r.name, r.strategy, r.targets.map(t => `${t.upstreamId} / ${t.tool}`).join(', '), rowActions(tab, i)]); }
    p.append(rows.length ? table(headers, rows) : node('div', 'No entries yet. Add your first definition.', 'empty')); content.append(p);
    if (tab === 'clients') content.append(node('div', 'Permissions use exact tool names or upstream__*. Role and relationship checks, when enabled, further restrict these grants. Credential references name environment variables; never enter secret values here.', 'notice'));
    if (tab === 'routes') content.append(node('div', 'Sticky routes select a target per identity and tool. Weighted routes distribute calls by configured weights. Rendezvous routes keep identity assignments stable when targets are added or removed. Automatic retries are disabled. All targets for an alias must implement the same tool contract.', 'notice'));
    if (tab === 'routes') {
      const simulator = panel('Test a published route', 'Evaluate current permissions and routing without invoking a tool. Unpublished drafts are excluded.');
      const form = node('form', undefined, 'simulator');
      const identity = node('select'); identity.setAttribute('aria-label', 'Simulation identity');
      draft.clients.forEach(client => { const option = node('option', client.id); option.value = client.id; identity.append(option); });
      const tool = node('input'); tool.placeholder = 'Public tool name'; tool.setAttribute('aria-label', 'Simulation tool'); tool.required = true;
      const run = node('button', 'Evaluate route'); run.type = 'submit';
      const result = node('p'); result.setAttribute('role', 'status');
      form.append(identity, tool, run);
      form.onsubmit = async event => { event.preventDefault(); run.disabled = true; try { const decision = await api('resolve', { method: 'POST', body: JSON.stringify({ clientId: identity.value, tool: tool.value }) }); result.textContent = `Revision ${decision.revision}: ${decision.reason}${decision.routable ? ` → ${decision.upstreamId} / ${decision.upstreamTool}` : ''}`; } catch (e) { result.textContent = e.message; } finally { run.disabled = false; } };
      simulator.append(form, result); content.append(simulator);
    }
  } else if (tab === 'explorer') {
    const p = panel('Connect as a service identity', 'The service key determines tool permissions. It stays in this page memory and is discarded when leaving this view.');
    const form = node('form'), key = node('input'), connect = node('button', 'Discover tools');
    key.type = 'password'; key.required = true; key.autocomplete = 'off'; key.id = 'explorer-key'; const label = node('label', 'Service access key'); label.htmlFor = key.id;
    const query = node('input'); query.id = 'explorer-query'; query.maxLength = 128; const queryLabel = node('label', 'Search tools (optional)'); queryLabel.htmlFor = query.id;
    connect.type = 'submit'; form.append(label, key, queryLabel, query, connect); p.append(form);
    p.append(node('p', `Browser MCP access requires this exact origin in allowedOrigins: ${location.origin}`));
    const results = node('div'); content.append(p, results);
    form.onsubmit = async event => {
      event.preventDefault(); const serviceKey = key.value; connect.disabled = true;
      const request = async (method, params, tool) => {
        const version = '2026-07-28';
        const response = await fetch('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}), ...(tool ? mirroredHeaders(tool.inputSchema, params.arguments) : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
        const value = await response.json();
        if (!response.ok || value.error) throw new Error(value.error?.message ?? value.error ?? `Request failed (${response.status})`);
        return value.result;
      };
      try {
        const catalog = { tools: [] }; let cursor; const seen = new Set();
        do {
          let page;
          if (query.value.trim()) {
            const response = await fetch('/catalog/search', { method: 'POST', headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query.value.trim(), limit: 100, detail: 'full', ...(cursor ? { cursor } : {}) }) });
            page = await response.json(); if (!response.ok) throw new Error(page.error ?? 'Catalog search failed');
          } else page = await request('tools/list', cursor ? { cursor } : {});
          catalog.tools.push(...page.tools); cursor = page.nextCursor;
          if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('Catalog pagination exceeded its budget');
          if (cursor) seen.add(cursor);
        } while (cursor);
        key.value = ''; results.replaceChildren();
        results.append(node('h2', `${catalog.tools.length} permitted tools`));
        for (const tool of catalog.tools) {
          const card = panel(tool.name, tool.description ?? 'No description');
          const definition = node('textarea', undefined, 'code-editor'); definition.readOnly = true; definition.value = JSON.stringify(tool, null, 2); definition.setAttribute('aria-label', `Definition of ${tool.name}`);
          card.append(definition);
          const fingerprint = tool._meta?.['com.example.relay/contractFingerprint'];
          if (/^[a-f0-9]{64}$/.test(fingerprint ?? '')) card.append(button('Pin reviewed definition to draft', () => { draft.toolContracts = { ...draft.toolContracts, [tool.name]: fingerprint }; dirty(); message(`${tool.name} definition pinned in draft. Publish to enforce.`); }));
          const invocation = node('form'), args = node('textarea'), call = node('button', 'Call selected tool'), result = node('pre');
          args.value = '{}'; args.setAttribute('aria-label', `Arguments for ${tool.name}`); call.type = 'submit'; result.setAttribute('aria-label', `Result of ${tool.name}`);
          invocation.append(node('label', 'Tool arguments (JSON)'), args, call); card.append(invocation, result);
          invocation.onsubmit = async e => {
            e.preventDefault(); call.disabled = true;
            try {
              const argumentsValue = JSON.parse(args.value); if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== 'object') throw new Error('Arguments must be a JSON object');
              const value = await request('tools/call', { name: tool.name, arguments: argumentsValue }, tool); result.textContent = JSON.stringify(value, null, 2);
              message(value.isError ? 'The tool returned an error. Review the result before retrying.' : 'Tool response received.', Boolean(value.isError));
            } catch (e) { result.textContent = e.message; } finally { call.disabled = false; }
          };
          results.append(card);
        }
      } catch (e) { results.replaceChildren(node('p', e.message)); }
      finally { connect.disabled = false; }
    };
  } else if (tab === 'history') {
    const p = panel('Published revisions', 'Latest 50 revisions. Restoring creates a new revision and retains the previous history.');
    content.append(p);
    try {
      const revisions = await api('history'); if (tab !== 'history') return;
      const preview = node('div');
      p.append(table(['Revision', 'Published', ''], revisions.map(item => [String(item.revision), new Date(item.at).toLocaleString(), button(`Review revision ${item.revision}`, async () => {
        try {
          const saved = await api(`history/${item.revision}`);
          preview.replaceChildren();
          preview.append(node('h2', `Review revision ${item.revision}`), node('p', 'Review the complete configuration below. Publishing restores its permissions and routing using current deployment validation.'));
          const text = node('textarea', undefined, 'code-editor'); text.readOnly = true; text.value = JSON.stringify(saved.document, null, 2); text.setAttribute('aria-label', 'Historical configuration');
          const restore = button('Publish this revision as a new configuration', async () => {
            restore.disabled = true;
            try {
              const result = await api('rollback', { method: 'POST', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify({ revision: item.revision }) });
              revision = result.revision; draft = result.document; $('#revision').textContent = `Revision ${revision} · connected`; $('#revision').classList.remove('draft');
              await render(); message(`Revision ${item.revision} restored as revision ${revision}.`);
            } catch (e) { message(e.message, true); restore.disabled = false; }
          }, 'primary');
          preview.append(text, restore);
        } catch (e) { message(e.message, true); }
      })])));
      p.append(preview);
    } catch (e) { message(e.message, true); }
  } else if (tab === 'safeguards') {
    const p = panel('Action safeguards', 'Restrict tool arguments, pin definitions, and require independent one-use approval for selected tools. Apply to the draft, then publish.');
    const form = node('form');
    const checks = {};
    for (const [name, label] of [['requirePinned', 'Expose only pinned tool definitions'], ['rejectControlCharacters', 'Reject display controls in tool metadata']]) {
      const input = node('input'); input.type = 'checkbox'; input.id = `safeguard-${name}`; input.checked = Boolean(draft.catalogPolicy?.[name]);
      const l = node('label', label); l.htmlFor = input.id; form.append(l, input); checks[name] = input;
    }
    const label = node('label', 'Tool argument policies (JSON)'); label.htmlFor = 'argument-policies';
    const input = node('textarea', undefined, 'code-editor'); input.id = 'argument-policies'; input.value = JSON.stringify(draft.invocationPolicies ?? {}, null, 2);
    const approvalLabel = node('label', 'Tools requiring independent approval (comma-separated exact names or namespace wildcards)'); approvalLabel.htmlFor = 'approval-required-tools';
    const approvals = node('input'); approvals.id = 'approval-required-tools'; approvals.value = (draft.approvalRequiredTools ?? []).join(', '); approvals.placeholder = 'payments__transfer, finance__*';
    const discovery = {};
    for (const [name, label, value, min, max] of [['concurrency', 'Discovery parallel upstreams', draft.discovery?.concurrency ?? 4, 1, 16], ['pageSize', 'Tools per discovery page', draft.discovery?.pageSize ?? 100, 1, 200], ['maxTools', 'Maximum catalog candidates', draft.discovery?.maxTools ?? 1000, 1, 10000], ['maxBytes', 'Maximum catalog bytes', draft.discovery?.maxBytes ?? 1048576, 1024, 4194304]]) {
      const input = node('input'); input.type = 'number'; input.id = `discovery-${name}`; input.value = value; input.min = min; input.max = max; input.required = true;
      const l = node('label', label); l.htmlFor = input.id; form.append(l, input); discovery[name] = input;
    }
    const search = node('input'); search.type = 'checkbox'; search.id = 'catalog-search'; search.checked = Boolean(draft.features?.catalogSearch);
    const searchLabel = node('label', 'Enable authorized catalog search'); searchLabel.htmlFor = search.id; form.append(searchLabel, search);
    const tasks = node('input'); tasks.type = 'checkbox'; tasks.id = 'mcp-tasks'; tasks.checked = Boolean(draft.features?.tasks);
    const tasksLabel = node('label', 'Enable MCP Tasks V2 for asynchronous tool calls'); tasksLabel.htmlFor = tasks.id; form.append(tasksLabel, tasks);
    const example = { alpha__echo: { allow: [{ constraints: [{ field: ['text'], op: 'equals', value: 'reviewed message' }] }] } };
    const sample = button('Load example into editor', () => { input.value = JSON.stringify(example, null, 2); });
    const apply = node('button', 'Apply safeguards to draft'); apply.type = 'submit'; form.append(approvalLabel, approvals, label, input, sample, apply);
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        const approvalRequiredTools = approvals.value.split(',').map(name => name.trim()).filter(Boolean);
        const candidate = { ...draft, invocationPolicies: JSON.parse(input.value), ...(approvalRequiredTools.length ? { approvalRequiredTools } : {}), catalogPolicy: Object.fromEntries(Object.entries(checks).map(([name, input]) => [name, input.checked])), discovery: { ...draft.discovery, ...Object.fromEntries(Object.entries(discovery).map(([name, input]) => [name, Number(input.value)])) }, features: { ...draft.features, catalogSearch: search.checked, tasks: tasks.checked } };
        if (!approvalRequiredTools.length) delete candidate.approvalRequiredTools;
        await api('validate', { method: 'POST', body: JSON.stringify(candidate) }); draft = candidate; dirty(); message('Safeguards applied to draft. Publish to activate.');
      } catch (e) { message(e.message, true); }
    };
    p.append(form); content.append(p);
    content.append(node('div', 'MCP Tasks V2 requires a shared GATEWAY_STATE_KEY of at least 32 bytes. Use PostgreSQL for task state when running multiple replicas; SQLite is intended for one local instance. The gateway stores only opaque task IDs and encrypted upstream route state, checks the caller and current tool contract on every operation, and requires matching Mcp-Name routing headers. Pin reviewed tools before requiring pins. Approval-required calls need a configured external approval service. Policies narrow existing permissions: every applicable alias and physical-tool policy must allow the call.', 'notice'));
  } else if (tab === 'traffic') {
    const p = panel('Request budgets and recovery', 'Edit the draft, then publish. PostgreSQL shares quotas across replicas; circuit breakers protect each replica.');
    const form = node('form');
    const rates = draft.traffic?.rateLimit, circuit = draft.traffic?.circuitBreaker;
    const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(rates); enabled.id = 'rate-enabled';
    const enabledLabel = node('label', 'Enable per-identity request rate limit'); enabledLabel.htmlFor = enabled.id;
    form.append(enabledLabel, enabled);
    const inputs = {};
    for (const [key, label, value, min, step] of [['capacity', 'Burst capacity', rates?.capacity ?? 20, 1, 1], ['refillPerSecond', 'Requests restored per second', rates?.refillPerSecond ?? 5, 0.001, 0.001], ['failureThreshold', 'Failures before circuit opens', circuit?.failureThreshold ?? 5, 1, 1], ['resetAfterMs', 'Recovery delay in milliseconds', circuit?.resetAfterMs ?? 10000, 100, 1]]) {
      const input = node('input'); input.type = 'number'; input.id = `traffic-${key}`; input.min = min; input.step = step; input.value = value; input.required = true;
      const l = node('label', label); l.htmlFor = input.id; form.append(l, input); inputs[key] = input;
    }
    const breaker = node('input'); breaker.type = 'checkbox'; breaker.checked = Boolean(circuit); breaker.id = 'circuit-enabled';
    const breakerLabel = node('label', 'Enable upstream circuit breakers'); breakerLabel.htmlFor = breaker.id;
    const apply = node('button', 'Apply traffic controls to draft'); apply.type = 'submit'; form.append(breakerLabel, breaker, apply);
    form.onsubmit = async event => {
      event.preventDefault();
      const traffic = { ...draft.traffic };
      if (enabled.checked) traffic.rateLimit = { capacity: Number(inputs.capacity.value), refillPerSecond: Number(inputs.refillPerSecond.value) }; else delete traffic.rateLimit;
      if (breaker.checked) traffic.circuitBreaker = { failureThreshold: Number(inputs.failureThreshold.value), resetAfterMs: Number(inputs.resetAfterMs.value) }; else delete traffic.circuitBreaker;
      const candidate = { ...draft, traffic };
      try { await api('validate', { method: 'POST', body: JSON.stringify(candidate) }); draft = candidate; dirty(); message('Traffic controls applied to draft. Publish to activate.'); } catch (e) { message(e.message, true); }
    };
    p.append(form); content.append(p);
    content.append(node('div', 'All authenticated requests consume the identity budget. Optional exact public-tool budgets and identity plan overrides are available in Configuration. Aliases have separate public-tool budgets. Failed or denied work can consume reserved budget; calls are never automatically retried.', 'notice'));
  } else if (tab === 'security') {
    try {
      const security = await api('security');
      const p = panel('Emergency JWT revocation', security.jwtRevocationEnabled ? 'Stop an entire trusted issuer or revoke one signed token across gateway replicas.' : 'JWT revocation is disabled. Set JWT_REVOCATION_ENABLED=true and use a shared PostgreSQL or local SQLite store, then restart the gateway.');
      if (security.jwtRevocationEnabled && security.authorizationServers.length) {
        const issuerPanel = panel('Issuer emergency stop', 'Blocking an issuer denies every token it signs, even when tokens have no jti or the issuer publishes a replacement key. Re-enable only after the identity provider is trusted again.');
        issuerPanel.append(table(['Trusted issuer', 'State', ''], security.authorizationServers.map(entry => {
          const toggle = button(entry.disabled ? 'Re-enable issuer' : 'Block issuer', async () => {
            toggle.disabled = true;
            try { await api('jwt-issuers', { method: 'POST', body: JSON.stringify({ issuer: entry.issuer, disabled: !entry.disabled }) }); message(entry.disabled ? 'Issuer re-enabled. Newly authenticated requests can use its valid tokens.' : 'Issuer disabled across replicas. All its JWTs are now denied.'); await render(); }
            catch (e) { message(e.message, true); }
            finally { toggle.disabled = false; }
          }, entry.disabled ? 'primary' : 'danger');
          return [entry.issuer, node('span', entry.disabled ? 'Blocked' : 'Active', entry.disabled ? 'tag danger' : 'tag'), toggle];
        })));
        content.append(issuerPanel);
      }
      if (security.jwtRevocationEnabled && security.authorizationServers.length) {
        const form = node('form'), issuerLabel = node('label', 'Trusted issuer'), issuer = node('select'); issuer.id = 'revocation-issuer'; issuerLabel.htmlFor = issuer.id; issuer.required = true;
        security.authorizationServers.forEach(entry => { const option = node('option', entry.issuer); option.value = entry.issuer; issuer.append(option); });
        const jtiLabel = node('label', 'JWT ID (jti)'), jti = node('input'); jti.id = 'revocation-token-id'; jtiLabel.htmlFor = jti.id; jti.required = true; jti.maxLength = 256; jti.autocomplete = 'off';
        const expiryLabel = node('label', 'Keep revoked until'), expiry = node('input'); expiry.id = 'revocation-expiry'; expiryLabel.htmlFor = expiry.id; expiry.type = 'datetime-local'; expiry.required = true; expiry.value = new Date(Date.now() + 60 * 60 * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        const submit = node('button', 'Revoke JWT', 'danger'); submit.type = 'submit'; form.append(issuerLabel, issuer, jtiLabel, jti, expiryLabel, expiry, submit);
        form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; try { await api('token-revocations', { method: 'POST', body: JSON.stringify({ issuer: issuer.value, tokenId: jti.value, expiresAt: Math.floor(new Date(expiry.value).getTime() / 1000) }) }); jti.value = ''; message('JWT revoked. All replicas will deny it until the selected expiry.'); } catch (e) { message(e.message, true); } finally { submit.disabled = false; } };
        p.append(form);
      } else if (security.jwtRevocationEnabled) p.append(node('div', 'No trusted JWT issuers are configured.', 'empty'));
      p.append(node('div', 'Only the issuer and jti are used; the bearer token is never entered or stored. Revocation records are hashed and automatically expire. This control applies to locally verified JWTs; opaque-token introspection already checks status on every request.', 'notice'));
      content.append(p);
    } catch (e) { message(e.message, true); }
  } else if (tab === 'configuration') {
    const flow = node('section', undefined, 'request-flow');
    flow.append(node('span', 'START TO FINISH', 'eyebrow'), node('h2', 'What happens when an agent calls a tool'));
    const steps = [
      ['1', 'Authenticate', 'A service key, verified OAuth token, or mTLS certificate identifies the caller.'],
      ['2', 'Authorize', 'Identity grants, roles, tenant rules, ReBAC/OPA, and argument policies narrow access.'],
      ['3', 'Discover', 'The gateway exposes only permitted tools, optionally filtered by reviewed contracts.'],
      ['4', 'Route', 'A public tool maps to eligible upstream targets using your routing strategy.'],
      ['5', 'Forward safely', 'Destination rules, deadlines, concurrency limits, and credential bindings protect the upstream.'],
      ['6', 'Record outcome', 'Auditing and optional tracing capture request metadata without tool arguments or secrets.']
    ];
    const stepGrid = node('div', undefined, 'flow-grid');
    steps.forEach(([number, name, explanation]) => { const item = node('article', undefined, 'flow-step'); item.append(node('span', number, 'step-number'), node('h3', name), node('p', explanation)); stepGrid.append(item); });
    flow.append(stepGrid); content.append(flow);
    const fieldPanel = panel('Settings, grouped by purpose', 'Choose a group to see what it controls, when it is used, and a safe example. Values below are deployment configuration; secret values belong in a secret manager or environment, never in this editor.');
    const groups = [
      ['Identity and authentication', 'Who is calling the gateway? Configure clients in Access policies, and choose the gateway-wide verification mode in deployment environment settings.', 'Example: a verified JWT issuer profile maps the trusted subject to a client identity; the identity’s `allow` list then limits tools.'],
      ['Permissions and safeguards', 'Decide which tools, arguments, tenants, roles, and sensitive actions are allowed. These checks run during discovery and again before execution.', 'Example: `allow: ["inventory__lookup"]` grants one public tool; an argument rule can cap a requested quantity.'],
      ['Upstream connections and credentials', 'Define MCP servers, transports, approved destinations, and secret references. Credential binding is enforced at the destination boundary.', 'Example: `tokenEnv: "INVENTORY_TOKEN"` names a deployment secret. The token itself is never entered into gateway configuration.'],
      ['Routing and traffic', 'Select targets for public tools and control rate, timeout, concurrency, and failure recovery behavior.', 'Example: a `weighted` route with weights 9 and 1 sends roughly 90% of eligible calls to the primary target and 10% to the canary.'],
      ['Protocol and optional MCP capabilities', 'Opt into prompts, resources, callbacks, notifications, or tasks only when clients and upstreams support them.', 'Example: enable `features.resources` to forward resources, then add separate resource grants for the relevant identities.'],
      ['Storage and deployment', 'Choose local single-instance SQLite or shared PostgreSQL for replicas. Configure keys, TLS, trust roots, and state encryption through deployment settings.', 'Example: all replicas share PostgreSQL and the same randomly generated `GATEWAY_STATE_KEY` for encrypted continuation/task state.']
    ];
    const groupsWrap = node('div', undefined, 'field-groups');
    groups.forEach(([name, purpose, example]) => { const details = node('details', undefined, 'field-group'); const summary = node('summary', name); details.append(summary, node('p', purpose), node('div', example, 'example-box')); groupsWrap.append(details); });
    fieldPanel.append(groupsWrap); content.append(fieldPanel);
    const p = panel('Advanced: complete configuration document', 'Use this editor when you need a setting that does not yet have a guided control. Validation runs before the draft changes; publishing applies it as a new revision.');
    const details = node('details', undefined, 'raw-config'); details.append(node('summary', 'Open the complete JSON configuration'));
    const textarea = node('textarea', undefined, 'code-editor'); textarea.id = 'config-json'; textarea.setAttribute('aria-label', 'Gateway configuration JSON'); textarea.value = JSON.stringify(draft, null, 2);
    const apply = button('Apply JSON to draft', async () => { try { const value = JSON.parse(textarea.value); await api('validate', { method: 'POST', body: JSON.stringify(value) }); draft = value; dirty(); message('Validated JSON applied to draft; publish to persist.'); } catch (e) { message(e.message, true); } });
    details.append(textarea, apply); p.append(details); content.append(p);
  } else {
    try {
      const audit = await api('audit'); if (tab !== 'audit') return;
      const p = panel('Recent requests', 'Latest 100 persisted events.');
      p.append(audit.length ? table(['Time', 'Identity', 'Operation', 'Outcome', 'Duration'], audit.map(e => [new Date(e.at).toLocaleString(), e.clientId, e.tool ?? e.method ?? e.upstream ?? '—', e.outcome, e.durationMs === undefined ? '—' : `${e.durationMs} ms`])) : node('div', 'Activity will appear after the first request.', 'empty')); content.append(p);
    } catch (e) { message(e.message, true); }
  }
}
function edit(kind, index) {
  const existing = index === undefined ? {} : draft[kind][index];
  const fields = $('#editor-fields'); fields.replaceChildren();
  $('#editor-title').textContent = `${index === undefined ? 'Add' : 'Edit'} ${kind === 'upstreams' ? 'server' : kind === 'clients' ? 'identity' : 'route'}`;
  const specs = kind === 'upstreams' ? [['id', 'Server ID', existing.id ?? '', true], ['url', 'MCP endpoint URL', existing.url ?? 'https://', true], ['transport', 'Connection type', existing.transport ?? 'streamable-http', true], ['tokenEnv', 'Upstream credential environment variable (optional)', existing.tokenEnv ?? '', false]] : kind === 'clients' ? [['id', 'Identity / verified subject', existing.id ?? '', true], ['tokenEnv', 'Gateway credential environment variable (optional)', existing.tokenEnv ?? '', false], ['allow', 'Allowed tools (comma separated)', (existing.allow ?? []).join(', '), false], ['roles', 'Roles (comma separated)', (existing.roles ?? []).join(', '), false]] : [['name', 'Public tool name', existing.name ?? '', true], ['strategy', 'Routing strategy', existing.strategy ?? 'sticky', true], ['targets', 'Targets JSON: upstreamId, tool, weight', JSON.stringify(existing.targets ?? [{ upstreamId: draft.upstreams[0]?.id ?? '', tool: 'echo', weight: 1 }], null, 2), true], ['clients', 'Restrict to identity IDs (optional, comma separated)', (existing.clients ?? []).join(', '), false]];
  if (kind === 'upstreams' || kind === 'clients') specs.push(['tenantId', 'Tenant (optional)', existing.tenantId ?? '', false]);
  if (kind === 'clients') specs.push(['subject', 'Verified token subject (OAuth identity)', existing.subject ?? '', false], ['oauthIssuer', 'Trusted OAuth issuer (required for multi-issuer JWT mode)', existing.oauthIssuer ?? '', false], ['oauthClientId', 'Verified OAuth client ID (optional)', existing.oauthClientId ?? '', false], ['certificateSha256', 'Pinned client certificate SHA-256 thumbprint (mTLS)', existing.certificateSha256 ?? '', false]);
  if (kind === 'upstreams') specs.push(['timeoutMs', 'Total upstream time budget, milliseconds (optional)', existing.timeoutMs ?? '', false], ['connectTimeoutMs', 'Connection time limit, milliseconds (optional)', existing.connectTimeoutMs ?? '', false], ['discoveryCacheTtlMs', 'Protocol discovery cache TTL in ms (optional; enable only for homogeneous MCP versions)', existing.discoveryCacheTtlMs ?? '', false], ['requestPaths', 'Allowed request paths (JSON array; optional, defaults to the configured endpoint path)', JSON.stringify(existing.requestPaths ?? []), false], ['command', 'Approved executable path (stdio only)', existing.command ?? '', false], ['args', 'Executable arguments (JSON array)', JSON.stringify(existing.args ?? []), false]);
  if (kind === 'routes') specs.push(['tenants', 'Allowed tenants (optional, comma separated)', (existing.tenants ?? []).join(', '), false], ['requiredRoles', 'Required roles, all must match (optional, comma separated)', (existing.requiredRoles ?? []).join(', '), false]);
  const targets = structuredClone(existing.targets ?? [{ upstreamId: draft.upstreams[0]?.id ?? '', tool: 'echo', weight: 1 }]);
  const helpText = {
    id: ['Stable name used by routes and policies.', kind === 'upstreams' ? 'Example: `inventory`' : kind === 'clients' ? 'Example: `support-agent`' : 'Example: `catalog_search`'],
    url: ['Where the gateway connects to this MCP server. The destination must also pass deployment egress policy.', 'Example: `https://inventory.internal/mcp`'],
    transport: ['Protocol used for this upstream. Streamable HTTP is the recommended modern default; SSE supports older servers; stdio starts a configured local process.', 'Example: `streamable-http`'],
    tokenEnv: ['Name of an environment variable containing a secret. The gateway sends that value only to its explicitly bound destination.', 'Example: `INVENTORY_TOKEN` (never paste the token itself)'],
    allow: ['Public tools this identity may discover and call. Exact names are narrowest; `upstream__*` allows all tools from one upstream. Empty means deny all.', 'Example: `inventory__lookup, catalog_search`'],
    roles: ['Additional role names required by policy. A role never overrides the identity’s own tool grants.', 'Example: `support-read`'],
    timeoutMs: ['Maximum total time for this upstream operation before the gateway aborts it.', 'Example: `15000` milliseconds'],
    connectTimeoutMs: ['Maximum time to establish the upstream connection; should be shorter than the total timeout.', 'Example: `2000` milliseconds'],
    discoveryCacheTtlMs: ['How long protocol discovery may be reused for a homogeneous upstream. Leave blank when definitions can change dynamically.', 'Example: `15000` milliseconds'],
    requestPaths: ['Allowed HTTP paths for legacy SSE servers that post messages to a separate endpoint. Restricts paths on this same configured host.', 'Example: `["/mcp", "/messages"]`'],
    command: ['Absolute executable path for a stdio upstream. It must be approved by the deployment allowlist; stdio runs trusted code.', 'Example: `/usr/local/bin/inventory-mcp`'],
    args: ['Arguments passed to the approved stdio executable. Use a JSON string array; do not put secrets here.', 'Example: `["--config", "/etc/inventory.json"]`'],
    name: ['Stable tool name agents see. A route can preserve backend details while giving clients one consistent name.', 'Example: `catalog_search`'],
    strategy: ['How an eligible target is selected. Sticky pins an identity to a target; weighted splits traffic; rendezvous minimizes reassignment; priority prefers the highest-priority enabled target.', 'Example: `weighted` for a canary rollout'],
    targets: ['Backend tool implementations for this public name. All targets must satisfy the same tool contract. Calls are not automatically retried.', 'Example: upstream `primary`, tool `search`, weight `9`'],
    clients: ['Optional identity allowlist for this route. Use it to expose a route only to selected agents.', 'Example: `support-agent, analyst`'],
    tenantId: ['Tenant boundary assigned to this identity or upstream. Tenant constraints are applied in addition to tool permissions.', 'Example: `acme-prod`'],
    subject: ['Exact verified OAuth subject bound to this identity. This value is read from a validated token, never from an untrusted request header.', 'Example: `svc-catalog-agent`'],
    oauthIssuer: ['Exact trusted issuer URL for the OAuth identity, especially when multiple JWT issuers are configured.', 'Example: `https://login.example.com/tenant/v2.0`'],
    oauthClientId: ['Optional verified OAuth client identifier to bind this identity to a registered application.', 'Example: `catalog-agent-prod`'],
    certificateSha256: ['Base64url SHA-256 thumbprint of the verified client certificate when gateway-side mTLS is enabled.', 'Example: 43 base64url characters; configure TLS trust separately.'],
    tenants: ['Tenant IDs allowed to use this route. Omit to let other policy determine tenant access.', 'Example: `acme-prod`'],
    requiredRoles: ['Every listed role must be present for the route to match.', 'Example: `support-read, pii-approved`']
  };
  const sectionFor = name => ({ id: 'Identity and naming', url: 'Connection', transport: 'Connection', command: 'Connection', args: 'Connection', requestPaths: 'Connection', tokenEnv: 'Credentials and limits', timeoutMs: 'Credentials and limits', connectTimeoutMs: 'Credentials and limits', discoveryCacheTtlMs: 'Credentials and limits', allow: 'Permissions', roles: 'Permissions', subject: 'Permissions', oauthIssuer: 'Permissions', oauthClientId: 'Permissions', certificateSha256: 'Permissions', tenantId: 'Permissions', name: 'Route definition', strategy: 'Route definition', targets: 'Route targets', clients: 'Route access', tenants: 'Route access', requiredRoles: 'Route access' }[name] ?? 'Additional settings');
  const renderedGroups = new Map();
  specs.filter(([name]) => name !== 'targets').forEach(([name, label, value, required]) => {
    const section = sectionFor(name); let sectionGroup = renderedGroups.get(section);
    if (!sectionGroup) { sectionGroup = node('fieldset', undefined, 'editor-group'); sectionGroup.append(node('legend', section)); renderedGroups.set(section, sectionGroup); fields.append(sectionGroup); }
    const fieldGroup = node('div'), input = node(name === 'args' || name === 'requestPaths' ? 'textarea' : ['strategy', 'transport'].includes(name) ? 'select' : 'input');
    if (name === 'strategy' || name === 'transport') {
      const choices = name === 'strategy' ? [['sticky', 'Sticky · stable per identity'], ['weighted', 'Weighted · gradual traffic split'], ['rendezvous', 'Rendezvous · minimal reassignment'], ['priority', 'Priority · highest enabled first']] : [['streamable-http', 'Streamable HTTP · recommended'], ['sse', 'SSE · legacy HTTP + events'], ['stdio', 'stdio · approved local process']];
      for (const [choice, display] of choices) { const option = node('option', display); option.value = choice; input.append(option); }
    }
    input.id = `field-${name}`; input.name = name; input.value = value; input.required = required; const l = node('label', label); l.htmlFor = input.id; fieldGroup.append(l, input);
    const help = helpText[name]; if (help) { const hint = node('p', `${help[0]} ${help[1]}`, 'field-help'); fieldGroup.append(hint); }
    sectionGroup.append(fieldGroup);
  });
  if (kind === 'routes') {
    const group = node('div'), rows = node('div'); group.append(node('label', 'Route targets'), rows);
    const renderTargets = () => {
      rows.replaceChildren();
      targets.forEach((target, i) => {
        const row = node('div', undefined, 'target-row'), upstream = node('select'), tool = node('input'), weight = node('input'), priority = node('input');
        upstream.setAttribute('aria-label', `Target ${i + 1} upstream`); draft.upstreams.forEach(u => { const option = node('option', u.id); option.value = u.id; upstream.append(option); }); upstream.value = target.upstreamId;
        tool.value = target.tool; tool.placeholder = 'Tool name'; tool.required = true; tool.setAttribute('aria-label', `Target ${i + 1} tool`);
        weight.type = 'number'; weight.min = '1'; weight.max = '10000'; weight.value = target.weight ?? 1; weight.required = true; weight.setAttribute('aria-label', `Target ${i + 1} weight`);
        priority.type = 'number'; priority.min = '0'; priority.max = '1000'; priority.value = target.priority ?? 0; priority.setAttribute('aria-label', `Target ${i + 1} priority`);
        priority.oninput = () => { target.priority = Number(priority.value); };
        upstream.onchange = () => { target.upstreamId = upstream.value; }; tool.oninput = () => { target.tool = tool.value; }; weight.oninput = () => { target.weight = Number(weight.value); };
        const remove = button('×', () => { targets.splice(i, 1); renderTargets(); }); remove.setAttribute('aria-label', `Remove target ${i + 1}`);
        const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = target.enabled !== false; enabled.setAttribute('aria-label', `Target ${i + 1} enabled`); enabled.onchange = () => { target.enabled = enabled.checked; };
        row.append(upstream, tool, weight, priority, enabled, remove); rows.append(row);
      });
    };
    group.append(node('p', 'Targets are the physical upstream tool implementations. Weight affects weighted routing; priority affects priority routing. Keep tool schemas compatible across all targets.', 'field-help'));
    renderTargets(); group.append(button('+ Add target', () => { targets.push({ upstreamId: draft.upstreams[0]?.id ?? '', tool: '', weight: 1 }); renderTargets(); })); fields.append(group);
  }
  $('#edit-form').onsubmit = event => {
    event.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const entry = { ...existing, ...values };
      for (const name of ['allow', 'roles', 'clients', 'tenants', 'requiredRoles']) if (name in values) entry[name] = values[name].split(',').map(x => x.trim()).filter(Boolean);
      for (const name of ['tenants', 'requiredRoles']) if (kind === 'routes' && !entry[name].length) delete entry[name];
      for (const name of ['timeoutMs', 'connectTimeoutMs']) if (kind === 'upstreams') { if (values[name] === '') delete entry[name]; else { entry[name] = Number(values[name]); if (!Number.isInteger(entry[name]) || entry[name] < 1 || entry[name] > 120000) throw new Error('Time budgets must be integers from 1 to 120000 milliseconds'); } }
      if (kind === 'upstreams') { if (!values.discoveryCacheTtlMs) delete entry.discoveryCacheTtlMs; else { entry.discoveryCacheTtlMs = Number(values.discoveryCacheTtlMs); if (!Number.isInteger(entry.discoveryCacheTtlMs) || entry.discoveryCacheTtlMs < 1 || entry.discoveryCacheTtlMs > 60000) throw new Error('Discovery cache TTL must be an integer from 1 to 60000 milliseconds'); } }
      if ('tenantId' in entry && !entry.tenantId) delete entry.tenantId;
      for (const name of ['subject','oauthIssuer','oauthClientId','certificateSha256']) if (kind === 'clients' && !entry[name]) delete entry[name];
      if (kind === 'upstreams') {
        entry.args = JSON.parse(values.args || '[]'); if (!Array.isArray(entry.args) || entry.args.some(x => typeof x !== 'string')) throw new Error('Arguments must be a JSON array of strings'); if (!entry.command) delete entry.command;
        entry.requestPaths = JSON.parse(values.requestPaths || '[]'); if (!Array.isArray(entry.requestPaths) || entry.requestPaths.some(x => typeof x !== 'string')) throw new Error('Request paths must be a JSON array of strings'); if (!entry.requestPaths.length) delete entry.requestPaths;
      }
      if (kind === 'routes') { if (!targets.length) throw new Error('Add at least one route target'); entry.targets = targets; }
      if (kind === 'routes' && !entry.clients.length) delete entry.clients;
      if ((kind === 'upstreams' || kind === 'clients') && !entry.tokenEnv) delete entry.tokenEnv;
      if (kind === 'clients' && !entry.tokenEnv && !entry.subject && !entry.certificateSha256) throw new Error('Provide a credential reference, verified OAuth subject, or pinned client certificate');
      if (kind === 'clients' && entry.certificateSha256 && !/^[A-Za-z0-9_-]{43}$/.test(entry.certificateSha256)) throw new Error('Certificate thumbprint must be a 43-character base64url SHA-256 value');
      if (kind === 'clients' && entry.oauthIssuer) { try { const issuer = new URL(entry.oauthIssuer); if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error(); } catch { throw new Error('OAuth issuer must be a public HTTPS URL without credentials, query, or fragment'); } }
      draft[kind] ??= [];
      if (index === undefined) draft[kind].push(entry); else draft[kind][index] = entry;
      dirty(); $('#editor').close(); void render();
    } catch (e) { message(e.message, true); }
  };
  $('#editor').showModal();
}
$('#close-editor').addEventListener('click', () => $('#editor').close());
