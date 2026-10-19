const capabilityDetails = {
  protocol: {
    tag: '01 / PROTOCOL & CATALOG', title: 'Expose a deliberate catalog of MCP capabilities.',
    summary: 'Relay aggregates tool definitions from approved upstreams, namespaces physical names and can expose stable aliases. Discovery is permission-filtered; each execution is authorized again.',
    modes: ['Streamable HTTP and stateless legacy requests', 'Legacy HTTP+SSE upstream adapter and trusted stdio transport', 'Optional prompts, resources, templates, completion, callbacks, notifications and Tasks V2', 'Bounded discovery, opaque pagination and optional literal catalog search'],
    example: 'tools/list → echo, docs__search\n\n# Stable aliases are administrator-defined\necho → samples.echo',
    boundary: 'Relay implements the capabilities shown in its coverage guide. Optional protocol extensions must be enabled and tested with your client.',
    flow: ['Agent', 'MCP client', 'Relay catalog', 'Allowed tools', 'MCP server'], focus: 2, caption: 'Protocol negotiation carries a permission-filtered catalog to the client.',
    link: 'docs.html#protocol'
  },
  identity: {
    tag: '02 / AUTHENTICATION', title: 'Map a verified caller to a stable gateway identity.',
    summary: 'Select one configured authentication mode for agents. Identity is resolved before catalog discovery, authorization or audit attribution.',
    modes: ['Per-client service keys', 'JWT/OAuth issuer, audience and JWKS validation', 'Opaque token introspection with bounded timeouts', 'Gateway-terminated mTLS certificate mapping, DPoP checks and optional token exchange'],
    example: 'mode: jwt\nissuer: https://id.example/tenant\naudience: relay-tools\nrequiredScopes: [mcp.invoke]',
    boundary: 'Relay validates tokens; your identity provider remains responsible for login, MFA, user lifecycle, issuance and signing key protection.',
    flow: ['Agent token', 'Verifier', 'Client identity', 'Policy context', 'Catalog'], focus: 1, caption: 'The verifier resolves one caller identity before discovery or authorization.',
    link: 'docs.html#authentication'
  },
  authorization: {
    tag: '03 / AUTHORIZATION', title: 'Apply policy at discovery and again at execution.',
    summary: 'Use simple grants for small deployments and add external policy or relationship checks where teams need central governance or contextual decisions.',
    modes: ['Exact tool grants and constrained namespace wildcards', 'Roles, tenant and resource context', 'OpenFGA relationship checks and OPA policy adapter', 'Argument constraints, target pins, quotas and optional human approval'],
    example: 'client: analyst\nallow: [search, docs__*]\ntenant: team-a\nmaxCallsPerMinute: 60',
    boundary: 'External policy services are deployment dependencies. Configure timeouts and fail-closed behavior; test the policies with your own identity model.',
    flow: ['Caller', 'Tool grant', 'Role + tenant', 'OPA / OpenFGA', 'Decision'], focus: 3, caption: 'Independent checks narrow access; a later policy cannot widen the caller grant.',
    link: 'docs.html#authorization'
  },
  routing: {
    tag: '04 / ROUTING & RESILIENCE', title: 'Keep public tool names stable while placement evolves.',
    summary: 'Route only among administrator-configured upstream and tool pairs. Selection policies cannot introduce a host or target from caller-provided arguments.',
    modes: ['Direct namespace and stable aliases', 'Sticky, weighted, priority and weighted rendezvous selection', 'Tenant selectors and constrained remote selector plugin', 'Per-upstream deadlines, bounded concurrency, circuit state and explicit retries only when safe'],
    example: 'route: search\nstrategy: weighted\ntargets: [primary: 90, canary: 10]\ntimeoutMs: 8000\nretry: disabled by default',
    boundary: 'Tool calls can have side effects. Relay does not blindly replay failed calls; retry safety belongs to the tool contract and operator policy.',
    flow: ['Tool alias', 'Eligible pool', 'Route strategy', 'Selected target', 'MCP server'], focus: 2, caption: 'Routing selects from administrator-defined candidates after tenant and policy filters.',
    link: 'docs.html#routing'
  },
  security: {
    tag: '05 / SECRETS & EGRESS', title: 'Bind credentials to the exact destination that may receive them.',
    summary: 'Keep secret values in the deployment secret source. Relay configuration holds references, and strict binding checks the destination before resolving a credential.',
    modes: ['Separate inbound agent and upstream service identities', 'Exact URL, path and purpose bindings for each credential reference', 'DNS answer validation and strict egress checks', 'Private CIDR allowlists, origin checks and metadata-only audit events'],
    example: 'reference: DOCS_TOKEN\nallowedUrl: https://docs.example/api\npurpose: bearer-auth\nstrictBindings: true',
    boundary: 'Network controls and secret delivery are deployment responsibilities. Protect credentials in logs, crash dumps, CI, backups and operator workflows too.',
    flow: ['Secret ref', 'Destination bind', 'Egress check', 'Secret resolver', 'Approved host'], focus: 1, caption: 'Relay checks the exact destination before resolving a credential reference.',
    link: 'docs.html#secrets'
  },
  operations: {
    tag: '06 / ADMIN & OPERATIONS', title: 'Manage policy as versioned, observable gateway state.',
    summary: 'Use the admin API/UI for configuration and inspect health, audit metadata and metrics as part of your service operations.',
    modes: ['Admin API and browser configuration UI', 'In-memory demo state or PostgreSQL shared state', 'OpenTelemetry traces, health/readiness and protected metrics', 'Typed component contracts for auth, policy, router, transport, storage and quotas'],
    example: 'local: npm run demo\nshared state: DATABASE_URL=postgres://…\nhealth: /health /ready',
    boundary: 'Plugin contracts support composition but are not a sandbox. Run trusted plugins in a separately isolated process and apply platform resource and network limits.',
    flow: ['Admin draft', 'Schema check', 'Publish revision', 'Gateway replicas', 'Audit + metrics'], focus: 2, caption: 'A published revision is the boundary between reviewed configuration and request handling.',
    link: 'docs.html#admin'
  }
};

document.documentElement.classList.add('js');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const nav = document.querySelector('#site-nav');
const menuButton = document.querySelector('.menu-toggle');
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  nav?.classList.toggle('open', open);
});
nav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  nav.classList.remove('open');
  menuButton?.setAttribute('aria-expanded', 'false');
  menuButton?.setAttribute('aria-label', 'Open navigation');
}));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && nav?.classList.contains('open')) {
    nav.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
    menuButton?.focus();
  }
});

const tabs = [...document.querySelectorAll('.cap-tab')];
const panel = document.querySelector('#cap-panel');
function selectCapability(key, focus = false) {
  const detail = capabilityDetails[key];
  if (!detail || !panel) return;
  tabs.forEach((tab) => {
    const active = tab.dataset.cap === key;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  const list = (items) => items.map((item) => `<li>${item}</li>`).join('');
  panel.innerHTML = `<div class="cap-panel-top"><span class="cap-tag">${detail.tag}</span><span class="cap-status"><i></i> IMPLEMENTED · SEE COVERAGE</span></div><h3>${detail.title}</h3><p class="cap-summary">${detail.summary}</p><div class="cap-detail-grid"><div><h4>Modes</h4><ul>${list(detail.modes)}</ul></div><div><h4>Example</h4><pre class="mini-code"><code>${detail.example}</code></pre></div></div><div class="cap-boundary"><b>Plan for</b><span>${detail.boundary}</span></div><a class="cap-doc-link" href="${detail.link}">Open detailed configuration guide <span>↗</span></a>`;
  const mapWrap = document.createElement('div');
  mapWrap.className = 'cap-map-wrap';
  const mapKicker = document.createElement('span');
  mapKicker.className = 'cap-map-kicker';
  mapKicker.textContent = 'WHERE THIS CONTROL SITS';
  const map = document.createElement('div');
  map.id = 'cap-map';
  map.className = 'cap-map';
  map.setAttribute('role', 'img');
  const mapCaption = document.createElement('p');
  mapCaption.className = 'cap-map-caption';
  mapCaption.id = 'cap-map-caption';
  mapCaption.setAttribute('aria-live', 'polite');
  mapWrap.append(mapKicker, map, mapCaption);
  panel.querySelector('.cap-detail-grid')?.before(mapWrap);
  if (map) {
    map.replaceChildren();
    map.setAttribute('aria-label', detail.flow.join(' then '));
    const line = document.createElement('i'); line.className = 'cap-map-line'; map.append(line);
    const traveler = document.createElement('i'); traveler.className = 'cap-map-traveler'; map.append(traveler);
    detail.flow.forEach((step, index) => {
      const node = document.createElement('span');
      node.className = `cap-map-node${index === detail.focus ? ' is-focus' : ''}`;
      node.textContent = step;
      map.append(node);
    });
    map.classList.remove('is-changing');
    if (!reduceMotion) { void map.offsetWidth; map.classList.add('is-changing'); }
    mapCaption.textContent = detail.caption;
  }
  panel.setAttribute('aria-labelledby', tabs.find((tab) => tab.dataset.cap === key)?.id ?? '');
  if (focus) panel.focus();
}
tabs.forEach((tab, index) => {
  tab.id ||= `cap-tab-${tab.dataset.cap}`;
  tab.addEventListener('click', () => selectCapability(tab.dataset.cap));
  tab.addEventListener('keydown', (event) => {
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next].focus();
    selectCapability(tabs[next].dataset.cap);
  });
});
if (tabs.length) {
  const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0];
  tabs.forEach((tab) => { tab.id ||= `cap-tab-${tab.dataset.cap}`; });
  panel?.setAttribute('aria-labelledby', active.id);
}

document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
  const code = document.getElementById(button.dataset.copy)?.innerText;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = 'COPIED';
    window.setTimeout(() => { button.textContent = 'COPY'; }, 1500);
  } catch {
    button.textContent = 'SELECT & COPY';
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(button.dataset.copy));
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}));

const endpoint = document.querySelector('meta[name="relay-mcp-endpoint"]')?.content;
const hostedLink = document.querySelector('#hosted-mcp-link');
if (endpoint && hostedLink) {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.awsapprunner.com') && parsed.pathname === '/mcp') hostedLink.href = parsed.href;
  } catch { /* Keep the safe documentation link if endpoint configuration is invalid. */ }
}

if (!reduceMotion && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries, current) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      current.unobserve(entry.target);
    }
  }), { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));
} else document.querySelectorAll('.reveal').forEach((element) => element.classList.add('is-visible'));
