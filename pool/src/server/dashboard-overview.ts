export const OVERVIEW_SOURCE = String.raw`
function createOverviewView(root, controller, presentation) {
  const tbody = root.querySelector('[data-overview-rows]'), rowNodes = new Map();
  const search = root.querySelector('[aria-label="Search accounts"]');
  const provider = root.querySelector('[aria-label="Provider"]');
  const status = root.querySelector('[aria-label="Account status"]');
  function filters() { controller.setFilters({ search: search.value, provider: provider.value, status: status.value }); }
  search.addEventListener('input', filters); provider.addEventListener('change', filters); status.addEventListener('change', filters);
  root.querySelector('[data-clear-filters]').addEventListener('click', () => controller.setFilters({ search: '', provider: 'all', status: 'all' }));
  root.querySelector('[data-filter-unavailable]').addEventListener('click', () => controller.setFilters({ ...controller.getState().filters, status: 'unavailable' }));
  root.querySelector('[data-filter-warning]').addEventListener('click', () => controller.setFilters({ ...controller.getState().filters, status: 'usage-warning' }));
  root.querySelectorAll('[data-sort]').forEach(button => button.dataset.label = button.textContent.replace(/[↑↓]/g, '').trim());
  root.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    const current = controller.getState().sort;
    controller.setSort({ key: button.dataset.sort, direction: current.key === button.dataset.sort && current.direction === 'asc' ? 'desc' : 'asc' });
  }));
  function createRow(name) {
    const row = element('<tr><td><button type="button" class="account-name" data-open-account></button><span class="account-meta"></span><span class="quota-note" data-row-warning></span></td><td><span class="status-label"><span class="status-icon" aria-hidden="true"></span><span data-status-text></span></span></td><td data-five></td><td data-seven></td><td class="overview-reset"></td><td class="overview-sessions"></td><td class="overview-inflight"></td></tr>');
    row.dataset.account = name;
    row.querySelector('[data-five]').append(meterElement()); row.querySelector('[data-seven]').append(meterElement());
    bindAccountRow(row, row.querySelector('[data-open-account]'), controller, name); return row;
  }
  function update(state) {
    patchInput(search, state.filters.search); patchInput(provider, state.filters.provider); patchInput(status, state.filters.status);
    root.querySelector('[data-loading]').hidden = !!state.snapshot;
    if (!state.snapshot) return;
    const model = presentation.overviewModel(state.snapshot, state.filters, state.sort, Date.now());
    const m = model.metrics;
    setText(root.querySelector('[data-metric="available"]'), m.available + ' / ' + m.total);
    setText(root.querySelector('[data-metric="sessions"]'), presentation.number(m.activeSessions));
    setText(root.querySelector('[data-metric="inflight"]'), presentation.number(m.inFlight));
    setText(root.querySelector('[data-metric="unavailable"]'), m.unavailable);
    const warnings = state.snapshot.accounts.filter(a => a.usage.lastUsageCheckError).length;
    const attention = root.querySelector('[data-attention]'); attention.hidden = m.unavailable === 0 && warnings === 0;
    setText(root.querySelector('[data-attention-text]'), m.unavailable + ' unavailable account' + (m.unavailable === 1 ? '' : 's') + (warnings ? ' · ' + warnings + ' usage check warning' + (warnings === 1 ? '' : 's') : '') + '. Select an account for its reason and next steps.');
    root.querySelector('[data-filter-unavailable]').hidden = !m.unavailable;
    root.querySelector('[data-filter-warning]').hidden = !warnings;
    root.querySelector('#onboard').hidden = m.total !== 0;
    root.querySelector('[data-account-list]').hidden = m.total === 0;
    root.querySelector('[data-filter-empty]').hidden = model.rows.length !== 0 || m.total === 0;
    setText(root.querySelector('[data-account-count]'), model.rows.length === m.total ? m.total : model.rows.length + ' / ' + m.total);
    root.querySelectorAll('[data-sort]').forEach(button => {
      const selected = button.dataset.sort === state.sort.key;
      button.parentElement.setAttribute('aria-sort', selected ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      setText(button, button.dataset.label + (selected ? (state.sort.direction === 'asc' ? ' ↑' : ' ↓') : ''));
    });
    const anchor = captureViewport(root), names = new Set(model.rows.map(r => r.account.name)), ordered = [];
    for (const [name, row] of rowNodes) if (!names.has(name)) { row.remove(); rowNodes.delete(name); }
    for (const data of model.rows) {
      const a = data.account;
      let row = rowNodes.get(a.name); if (!row) { row = createRow(a.name); rowNodes.set(a.name, row); }
      setText(row.querySelector('[data-open-account]'), a.name);
      setText(row.querySelector('.account-meta'), (a.provider === 'openai' ? 'OpenAI' : 'Anthropic') + ' · ' + (a.subscriptionType || 'Unknown plan'));
      setText(row.querySelector('[data-row-warning]'), data.usageWarning ? 'Usage check failed' : '');
      patchStatus(row.querySelector('.status-label'), data.statusKey, data.statusLabel);
      patchMeter(row.querySelector('[data-five] .quota'), data.fiveHour, presentation);
      patchMeter(row.querySelector('[data-seven] .quota'), data.sevenDay, presentation);
      setText(row.querySelector('.overview-reset'), data.nextReset ? data.nextReset.key + ' · ' + presentation.relative(data.nextReset.at, Date.now(), true) : '—');
      setText(row.querySelector('.overview-sessions'), presentation.number(a.activeSessions));
      setText(row.querySelector('.overview-inflight'), presentation.number(a.inFlight));
      ordered.push(row);
    }
    orderedRows(tbody, ordered); restoreViewport(root, anchor);
  }
  return { update, destroy() { rowNodes.clear(); } };
}
`;
