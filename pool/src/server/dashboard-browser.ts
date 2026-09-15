export const BROWSER_SOURCE = String.raw`
function setText(node, value) {
  const text = String(value == null ? '—' : value);
  if (node.textContent !== text) node.textContent = text;
}
function element(html) {
  const template = document.createElement('template'); template.innerHTML = html;
  return template.content.firstElementChild;
}
function patchInput(input, value) {
  const text = String(value == null ? '' : value);
  if (input.value !== text) input.value = text;
}
function patchMeter(node, value, presentation) {
  const known = value.percent != null;
  node.querySelector('.quota-track').hidden = !known;
  node.querySelector('.quota-fill').style.width = known ? value.percent + '%' : '0%';
  node.querySelector('[data-assumed]').hidden = value.provenance !== 'assumed-reset';
  const label = known ? Math.round(value.percent) + '%' : 'Not reported';
  setText(node.querySelector('.quota-value'), label);
  node.querySelector('.quota-value').classList.toggle('unknown', !known);
  const detail = (value.model ? value.model + ' · ' : '') + value.key + ': ' + label
    + (value.provenance === 'assumed-reset' ? ' · Reset assumed — awaiting usage check' : '')
    + (value.resetAt != null ? ' · resets ' + presentation.relative(value.resetAt, Date.now(), true) : '')
    + (value.lastCheckAt != null ? ' · checked ' + presentation.relative(value.lastCheckAt) : ' · usage check not reported')
    + (value.checkError ? ' · Usage check: ' + value.checkError : '');
  node.dataset.tooltip = detail; node.setAttribute('aria-label', detail);
}
function meterElement() {
  return element('<div class="quota" tabindex="0"><span class="quota-track"><span class="quota-fill"></span></span><span class="quota-value"></span><small data-assumed hidden>Reset assumed</small></div>');
}
function patchStatus(node, key, label) {
  node.dataset.status = key;
  setText(node.querySelector('.status-icon'), key === 'ready' ? '●' : key === 'cooldown' ? '◷' : '○');
  setText(node.querySelector('[data-status-text]'), label);
}
function captureViewport(root) {
  if (root.hidden) return null;
  const region = root.querySelector('.table-region');
  const focused = document.activeElement;
  const activeRow = root.contains(focused) ? focused.closest('tr') : null;
  const row = activeRow || Array.from(root.querySelectorAll('tbody tr')).find(r => r.getBoundingClientRect().top >= 80);
  return { region, left: region ? region.scrollLeft : 0, focused, row, top: row ? row.getBoundingClientRect().top : 0, scroll: window.scrollY };
}
function restoreViewport(root, anchor) {
  if (!anchor || root.hidden) return;
  if (anchor.focused && root.contains(anchor.focused) && document.activeElement !== anchor.focused) anchor.focused.focus({ preventScroll: true });
  if (anchor.region) anchor.region.scrollLeft = anchor.left;
  if (anchor.row && anchor.row.isConnected) {
    const delta = anchor.row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) window.scrollTo(0, anchor.scroll + delta);
  }
}
function orderedRows(tbody, rows) {
  rows.forEach((row, index) => { if (tbody.children[index] !== row) tbody.insertBefore(row, tbody.children[index] || null); });
}
function bindAccountRow(row, button, controller, name) {
  button.addEventListener('click', () => controller.requestTransition({ kind: 'account', account: name }));
  row.addEventListener('click', event => {
    if (event.target.closest('button,input,select,a,[tabindex]') || String(window.getSelection()).length) return;
    button.focus({ preventScroll: true }); controller.requestTransition({ kind: 'account', account: name });
  });
}
function trapDialogFocus(dialog) {
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]'))
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); dialog.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
function initializeDashboard(shared, presentation, forms, createController) {
  let controller, drawer, views = {}, previousView = 'overview';
  const positions = new Map();
  const guard = document.getElementById('discard-dialog');
  trapDialogFocus(guard); trapDialogFocus(document.getElementById('account-drawer'));
  const port = {
    now: () => Date.now(), fetch: (url, init) => fetch(url, init),
    setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
    render(state) {
      if (!state.pendingTransition && guard.open) guard.close();
      const changedView = previousView !== state.view;
      if (changedView) positions.set(previousView, window.scrollY);
      ['overview', 'routing', 'settings'].forEach(view => {
        document.getElementById(view + '-view').hidden = state.view !== view;
        const button = document.querySelector('[data-view="' + view + '"]');
        if (state.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      });
      if (views[state.view]) views[state.view].update(state);
      if (drawer) drawer.update(state);
      if (changedView) { window.scrollTo(0, positions.get(state.view) || 0); previousView = state.view; }
      const feedback = document.getElementById('connection-feedback');
      setText(feedback, state.connectionError ? 'Offline · data stale' : state.lastSuccessAt == null ? 'Connecting…' : 'Connected · ' + presentation.relative(state.lastSuccessAt));
      const error = document.getElementById('transport-error'); error.hidden = !state.connectionError;
      setText(error, state.connectionError ? state.connectionError + (state.lastSuccessAt ? ' · Last successful update ' + presentation.relative(state.lastSuccessAt) : ' · No status received yet') : '');
      if (state.pendingTransition) {
        const saving = Array.from(state.forms.values()).some(d => d.phase === 'saving');
        guard.querySelectorAll('button').forEach(b => { b.disabled = saving; });
        const errors = Array.from(state.forms.values()).filter(d => d.phase === 'error').map(d => d.message).join(' ');
        const note = guard.querySelector('[data-transition-error]'); note.hidden = !errors; setText(note, errors);
        if (!guard.open) guard.showModal();
      }
    },
  };
  controller = createController(port, forms, shared);
  views = {
    overview: createOverviewView(document.getElementById('overview-view'), controller, presentation),
    routing: createRoutingView(document.getElementById('routing-view'), controller, presentation, shared),
    settings: createSettingsView(document.getElementById('settings-view'), controller, forms, shared),
  };
  drawer = createDrawerView(document.getElementById('account-drawer'), controller, presentation, shared);
  document.querySelectorAll('nav [data-view]').forEach(button => button.addEventListener('click', () => controller.requestTransition({ kind: 'view', view: button.dataset.view })));
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); controller.requestTransition({ kind: 'view', view: 'overview' }); });
  document.querySelector('[data-retry]').addEventListener('click', () => controller.refresh('retry'));
  guard.querySelectorAll('[data-decision]').forEach(button => button.addEventListener('click', () => controller.resolveTransition(button.dataset.decision)));
  guard.addEventListener('cancel', event => { event.preventDefault(); controller.resolveTransition('stay'); });
  const themeButton = document.getElementById('theme-toggle');
  try { const saved = localStorage.getItem('cmp-theme'); if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved; } catch (_) {}
  themeButton.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next;
    try { localStorage.setItem('cmp-theme', next); } catch (_) {}
  });
  document.querySelectorAll('[data-origin-path]').forEach(node => setText(node, location.origin + node.dataset.originPath));
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.parentElement.querySelector('code').textContent); setText(document.querySelector('[data-copy-feedback]'), 'Command copied'); }
    catch (_) { setText(document.querySelector('[data-copy-feedback]'), 'Clipboard unavailable. Select and copy the command.'); }
  }));
  const tooltip = element('<div class="quota-tooltip" role="tooltip" hidden></div>'); document.body.append(tooltip);
  function showTooltip(event) {
    const target = event.target.closest('[data-tooltip]'); if (!target) return;
    setText(tooltip, target.dataset.tooltip); tooltip.hidden = false;
    const box = target.getBoundingClientRect();
    tooltip.style.left = Math.max(8, Math.min(innerWidth - tooltip.offsetWidth - 8, box.left)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(innerHeight - tooltip.offsetHeight - 8, box.bottom + 6)) + 'px';
  }
  document.addEventListener('mouseover', showTooltip); document.addEventListener('focusin', showTooltip);
  document.addEventListener('mouseout', () => { tooltip.hidden = true; }); document.addEventListener('focusout', () => { tooltip.hidden = true; });
  window.addEventListener('beforeunload', event => {
    if (Array.from(controller.getState().forms.values()).some(d => d.phase === 'saving' || d.phase === 'error' || !forms.equal(d.value, d.latest))) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', event => { if (!event.persisted) controller.stop(); });
  controller.start();
}
`;
