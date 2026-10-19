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
search?.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase();
  let shown = 0;
  configRows.forEach((row) => {
    const visible = row.innerText.toLocaleLowerCase().includes(query);
    row.hidden = !visible;
    if (visible) shown += 1;
  });
  if (searchCount) searchCount.textContent = `${shown} of ${configRows.length} settings`;
});

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
