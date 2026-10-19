document.documentElement.classList.add('js');
const deployTabs = [...document.querySelectorAll('[data-deploy]')];
deployTabs.forEach((tab, index) => {
  tab.id ||= `deploy-tab-${tab.dataset.deploy}`;
  const panel = document.querySelector(`#${tab.dataset.deploy}`);
  if (panel) {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.setAttribute('aria-controls', panel.id);
  }
  tab.addEventListener('click', () => {
    deployTabs.forEach((item) => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.querySelector(`#${item.dataset.deploy}`)?.classList.toggle('active', active);
    });
  });
  tab.addEventListener('keydown', (event) => {
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % deployTabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + deployTabs.length - 1) % deployTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = deployTabs.length - 1;
    else return;
    event.preventDefault();
    deployTabs[next].focus();
    deployTabs[next].click();
  });
});

const search = document.querySelector('#config-search');
const searchCount = document.querySelector('#config-search-count');
const configRows = [...document.querySelectorAll('#config-table tbody tr')];
let selectedGroup = 'all';
function filterConfigRows() {
  const query = search.value.trim().toLocaleLowerCase();
  let shown = 0;
  configRows.forEach((row) => {
    const inGroup = selectedGroup === 'all' || row.dataset.settingGroup === selectedGroup;
    const visible = inGroup && row.innerText.toLocaleLowerCase().includes(query);
    row.hidden = !visible;
    if (visible) shown += 1;
  });
  if (searchCount) searchCount.textContent = `${shown} of ${configRows.length} settings`;
  const groupCount = document.querySelector('#config-group-count');
  if (groupCount) groupCount.textContent = selectedGroup === 'all' ? `ALL · ${shown} FIELDS` : `${shown} · ${selectedGroup.toUpperCase()} FIELDS`;
}

const configurationGroups = {
  all: { label: 'THE FULL REQUEST', title: 'How the settings work together', description: 'A request gets a known caller, a permitted tool, an approved destination and bounded execution.', benefit: 'Keep access decisions close to the gateway and visible to operators.', steps: ['Agent', 'Identity', 'Tool policy', 'Approved route', 'Bound secret', 'MCP server'], fields: [] },
  identity: { label: '01 · CALLER IDENTITY', title: 'Give each agent a distinct identity', description: 'Map a service credential or verified token to one named client before Relay builds its tool catalog.', benefit: 'Separate agents cleanly and attribute every decision to the caller that made it.', steps: ['Agent key', 'Verify token', 'Map client'], fields: ['clients[].id', 'clients[].tokenEnv', 'clients[].oauthIssuer', 'clients[].certificateSha256'] },
  permissions: { label: '02 · TOOL ACCESS', title: 'Limit the tools each identity can see and call', description: 'Combine each client’s tool allowlist with role and tenant requirements. Relay checks the grant at discovery and again at execution.', benefit: 'Give an agent only its permitted tools, even when the shared upstream catalog grows.', steps: ['Verified client', 'Grants + roles', 'Visible tools'], fields: ['clients[].allow', 'clients[].roles', 'clients[].tenantId'] },
  upstreams: { label: '03 · UPSTREAMS & SECRETS', title: 'Connect approved servers without leaking credentials', description: 'Declare the MCP endpoint and transport, keep secret values in deployment-owned storage, and bind each reference to its exact destination.', benefit: 'A tool can use its required credential while an unapproved host receives none.', steps: ['Public alias', 'Approved MCP URL', 'Bound credential'], fields: ['upstreams[].id', 'upstreams[].url', 'upstreams[].transport', 'upstreams[].tokenEnv', 'GATEWAY_CREDENTIAL_BINDINGS', 'upstreams[].oauth'] },
  routing: { label: '04 · TOOL ROUTING', title: 'Keep the agent’s tool name stable', description: 'A public alias maps to an administrator-defined target pool. The caller can request a tool, but cannot supply an upstream URL or choose an unapproved target.', benefit: 'Change pools or shift traffic without rewriting agent configuration.', steps: ['search alias', 'Eligible target pool', 'Selected server'], fields: ['routes[].name / targets', 'routes[].strategy'] },
  runtime: { label: '05 · RUNTIME CONTROLS', title: 'Put a clear ceiling on each request', description: 'Bound request time, concurrency and call rates. Restrict accepted hosts and origins, and enable only the MCP capabilities you operate.', benefit: 'Control resource use and reduce the exposed surface as load or integrations grow.', steps: ['Incoming request', 'Deadline + limits', 'Enabled capability'], fields: ['timeoutMs', 'maxConcurrentPerClient', 'traffic.rateLimit', 'allowedHosts / allowedOrigins', 'features.*'] }
};
const groupTabs = [...document.querySelectorAll('[data-group]')];
const groupPanel = document.querySelector('#config-group-panel');
const groupLabel = document.querySelector('#config-group-label');
const groupTitle = document.querySelector('#config-group-title');
const groupDescription = document.querySelector('#config-group-description');
const groupBenefit = document.querySelector('#config-group-benefit');
const groupFields = document.querySelector('#config-group-fields');
const groupMap = document.querySelector('#config-group-map');
function selectConfigGroup(group) {
  const config = configurationGroups[group];
  if (!config) return;
  selectedGroup = group;
  groupTabs.forEach((tab) => {
    const active = tab.dataset.group === group;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  const activeTab = groupTabs.find((tab) => tab.dataset.group === group);
  if (activeTab) groupPanel?.setAttribute('aria-labelledby', activeTab.id);
  if (groupLabel) groupLabel.textContent = config.label;
  if (groupTitle) groupTitle.textContent = config.title;
  if (groupDescription) groupDescription.textContent = config.description;
  if (groupBenefit) groupBenefit.textContent = config.benefit;
  if (groupFields) {
    groupFields.replaceChildren();
    config.fields.forEach((field) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.settingSearch = field;
      chip.textContent = field;
      groupFields.append(chip);
    });
    if (!config.fields.length) {
      const note = document.createElement('span');
      note.textContent = 'Choose a group to focus its fields.';
      groupFields.append(note);
    }
  }
  if (groupMap) {
    groupMap.replaceChildren();
    groupMap.setAttribute('aria-label', `${config.title}: ${config.steps.join(' then ')}`);
    config.steps.forEach((step, index) => {
      const node = document.createElement('div');
      node.className = 'config-map-node';
      node.style.setProperty('--step', String(index));
      node.innerHTML = `<span>${String(index + 1).padStart(2, '0')}</span><b>${step}</b>`;
      groupMap.append(node);
      if (index < config.steps.length - 1) {
        const edge = document.createElement('i');
        edge.className = 'config-map-edge';
        edge.style.setProperty('--step', String(index));
        groupMap.append(edge);
      }
    });
  }
  filterConfigRows();
}
groupTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    if (search) search.value = '';
    selectConfigGroup(tab.dataset.group);
  });
  tab.addEventListener('keydown', (event) => {
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % groupTabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + groupTabs.length - 1) % groupTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = groupTabs.length - 1;
    else return;
    event.preventDefault();
    groupTabs[next].focus();
    groupTabs[next].click();
  });
});
groupFields?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-setting-search]');
  if (button) openSettingSearch(button.dataset.settingSearch);
});
search?.addEventListener('input', () => {
  if (search.value.trim() && selectedGroup !== 'all') selectConfigGroup('all');
  else filterConfigRows();
});
selectConfigGroup('all');

const configFlow = document.querySelector('#config-flow');
const configOutcome = document.querySelector('#config-lab-outcome');
const scenarios = [...document.querySelectorAll('[data-config-scenario]')];
function showConfigScenario(scenario) {
  const blocked = scenario === 'blocked';
  scenarios.forEach((button) => {
    const active = button.dataset.configScenario === scenario;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  configFlow?.classList.toggle('blocked', blocked);
  configFlow?.setAttribute('data-result', scenario);
  configFlow?.querySelectorAll('[data-config-step]').forEach((step, index) => {
    const state = blocked && index === 3 ? 'denied' : blocked && index === 4 ? 'pending' : 'passed';
    step.dataset.state = state;
    const icon = step.querySelector('.config-node-icon');
    if (icon) icon.textContent = state === 'denied' ? '×' : state === 'pending' ? '·' : ['◉', '✓', '⇄', '⛨', '▦'][index];
  });
  if (configOutcome) {
    configOutcome.classList.toggle('denied', blocked);
    configOutcome.querySelector('.outcome-icon').textContent = blocked ? '×' : '✓';
    configOutcome.querySelector('b').textContent = blocked
      ? 'Blocked: Relay withholds the credential before forwarding.'
      : 'Allowed: the request reaches its approved target.';
    configOutcome.querySelector('p span').textContent = blocked
      ? 'The route points to an unapproved host. Strict destination binding rejects the mismatch before Relay resolves or sends the upstream secret.'
      : 'Relay identifies the caller, confirms the tool grant, selects an administrator-defined route and sends the credential only to its bound host.';
  }
}
scenarios.forEach((button) => button.addEventListener('click', () => showConfigScenario(button.dataset.configScenario)));
showConfigScenario('allowed');

function openSettingSearch(setting) {
  if (!search) return;
  if (selectedGroup !== 'all') selectConfigGroup('all');
  search.value = setting;
  filterConfigRows();
  search.focus();
  search.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}
document.querySelectorAll('[data-setting-search]').forEach((button) => button.addEventListener('click', () => openSettingSearch(button.dataset.settingSearch)));

document.querySelectorAll('[data-copy-code]').forEach((button) => button.addEventListener('click', async () => {
  const code = button.parentElement?.querySelector('code')?.innerText;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = 'COPIED';
    window.setTimeout(() => { button.textContent = 'COPY'; }, 1500);
  } catch {
    button.textContent = 'COPY MANUALLY';
    const range = document.createRange();
    range.selectNodeContents(button.parentElement.querySelector('code'));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}));

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

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries, current) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      current.unobserve(entry.target);
    }
  }), { threshold: 0.08 });
  document.querySelectorAll('.doc-section').forEach((element) => {
    element.classList.add('reveal');
    observer.observe(element);
  });
}
