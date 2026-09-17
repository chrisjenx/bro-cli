export const DRAWER_SOURCE = String.raw`
function createDrawerView(root, controller, presentation, shared) {
  let returnFocus = null, accountName = null;
  const windows = new Map(), form = root.querySelector('[data-account-form]');
  const priority = form.querySelector('[name="priority"]'), weight = form.querySelector('[name="weight"]');
  priority.min = '0'; weight.min = shared.minWeight; weight.max = shared.maxWeight;
  function edit() {
    if (accountName) controller.editForm('account:' + accountName, { account: accountName, priority: priority.value, weight: weight.value });
  }
  priority.addEventListener('input', edit); weight.addEventListener('input', edit);
  form.addEventListener('submit', event => { event.preventDefault(); if (accountName) controller.saveForm('account:' + accountName); });
  root.querySelector('[data-cancel-account]').addEventListener('click', () => controller.cancelForm('account:' + accountName));
  root.querySelector('[aria-label="Close account details"]').addEventListener('click', () => controller.requestTransition({ kind: 'close-drawer' }));
  root.querySelector('[data-view-routing]').addEventListener('click', () => controller.requestTransition({ kind: 'view', view: 'routing' }));
  const recheck = root.querySelector('[data-recheck]'), recheckStatus = root.querySelector('[data-recheck-status]');
  recheck.addEventListener('click', async () => {
    if (!accountName) return;
    const name = accountName;
    recheck.disabled = true; setText(recheckStatus, 'Rechecking...');
    const ok = await controller.recheckAccount(name);
    // Re-enable unconditionally: the drawer may have closed or switched account
    // mid-flight, and a button left disabled never comes back on its own.
    recheck.disabled = false;
    if (accountName !== name) return;
    setText(recheckStatus, ok ? '' : 'Recheck failed; see pool logs.');
  });
  root.addEventListener('cancel', event => { event.preventDefault(); controller.requestTransition({ kind: 'close-drawer' }); });
  root.addEventListener('click', event => {
    if (event.target !== root) return;
    const b = root.getBoundingClientRect();
    if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) controller.requestTransition({ kind: 'close-drawer' });
  });
  function definitions(dl, items) {
    items.forEach(([key, label, value]) => {
      let dd = dl.querySelector('[data-value="' + key + '"]');
      if (!dd) { const dt = document.createElement('dt'); setText(dt, label); dd = document.createElement('dd'); dd.dataset.value = key; dl.append(dt, dd); }
      if (key === 'inflight') dd.setAttribute('data-detail-inflight', '');
      setText(dd, value);
    });
  }
  function update(state) {
    if (!state.drawer || !state.snapshot) {
      if (root.open) { root.close(); if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); else document.getElementById(state.view + '-title').focus({ preventScroll: true }); }
      accountName = null; return;
    }
    const detail = presentation.accountDetailModel(state.snapshot, state.drawer.lastKnownAccount, Date.now());
    const a = detail.account, u = a.usage;
    // The click handler always re-enables the button, so only the status text
    // needs clearing here — a switch between two blocked accounts leaves the
    // row visible, so the hidden-transition below would not fire.
    if (accountName !== a.name) { accountName = a.name; root.scrollTop = 0; setText(recheckStatus, ''); }
    setText(root.querySelector('#account-title'), a.name);
    setText(root.querySelector('[data-account-meta]'), (a.provider === 'openai' ? 'OpenAI' : 'Anthropic') + ' · ' + (a.subscriptionType || 'Unknown plan') + ' · ' + detail.status.label);
    root.querySelector('[data-account-removed]').hidden = !detail.removed;
    const reason = root.querySelector('[data-account-reason]'); reason.hidden = !a.unavailableReason; setText(reason, a.unavailableReason || '');
    // Only a live billing block is clearable by hand; every other sideline has
    // its own reset. Gated on the same condition as the Billing status, so the
    // row disappears once the block's cooldown has lapsed.
    const recheckRow = root.querySelector('[data-recheck-row]'), blocked = detail.status.key === 'billing';
    if (recheckRow.hidden !== !blocked) { recheckRow.hidden = !blocked; setText(recheckStatus, ''); }
    const parent = root.querySelector('[data-detail-windows]');
    const keys = new Set(detail.windows.map(w => w.key + '/' + (w.model || '')));
    for (const [key, node] of windows) if (!keys.has(key)) { node.remove(); windows.delete(key); }
    let empty = parent.querySelector('[data-no-windows]');
    if (!empty) { empty = element('<p class="muted small" data-no-windows>No provider-reported usage windows.</p>'); parent.append(empty); }
    empty.hidden = detail.windows.length > 0;
    detail.windows.forEach(w => {
      const key = w.key + '/' + (w.model || ''); let node = windows.get(key);
      if (!node) { node = element('<div class="detail-window"><div class="window-heading"><span data-window-name></span><strong data-window-used></strong></div><div data-window-meter></div><small data-window-reset></small><small data-window-provenance></small></div>'); node.querySelector('[data-window-meter]').append(meterElement()); windows.set(key, node); parent.append(node); }
      setText(node.querySelector('[data-window-name]'), (w.model ? w.model + ' · ' : 'Account · ') + w.key);
      setText(node.querySelector('[data-window-used]'), w.percent == null ? 'Not reported' : Math.round(w.percent) + '% used');
      patchMeter(node.querySelector('.quota'), w, presentation);
      setText(node.querySelector('[data-window-reset]'), w.resetAt == null ? (w.reportedResetAt ? 'Reported reset passed; next reset not reported' : 'Reset not reported') : 'Resets ' + presentation.relative(w.resetAt, Date.now(), true));
      setText(node.querySelector('[data-window-provenance]'), w.provenance === 'assumed-reset' ? 'Reset assumed — awaiting usage check' : '');
    });
    setText(root.querySelector('[data-usage-freshness]'), 'Usage checked ' + presentation.relative(u.lastUsageCheckAt) + (u.rateLimitStatus ? ' · snapshot ' + presentation.relative(u.rateLimitStatus.updatedAt) : ''));
    const usageError = root.querySelector('[data-usage-error]'); usageError.hidden = !u.lastUsageCheckError; setText(usageError, 'Usage check: ' + (u.lastUsageCheckError || ''));
    definitions(root.querySelector('[data-auth-values]'), [
      ['auth','Authentication', a.authenticated ? 'Authenticated' : 'Login required'],
      ['token','Token', a.tokenExpired ? 'Expired · refresh on use' : a.tokenExpiresAt ? 'Expires ' + presentation.relative(a.tokenExpiresAt, Date.now(), true) : 'Expiry not reported'],
      ['tier','Rate tier',a.rateLimitTier || '—'], ['requests','Total requests',presentation.number(u.totalRequests)],
      ['last','Last used',presentation.relative(u.lastUsedAt)], ['sessions','Active sessions',presentation.number(a.activeSessions)],
      ['inflight','In-flight',presentation.number(a.inFlight)], ['cost','Recorded window cost', '$' + Number(u.windowCostUsd || 0).toFixed(4)],
      ['window-requests','Window requests',presentation.number(u.windowRequests)], ['input','Window input tokens',presentation.number(u.windowInputTokens)],
      ['output','Window output tokens',presentation.number(u.windowOutputTokens)], ['status','Usage status',u.rateLimitStatus && u.rateLimitStatus.unifiedStatus || '—'],
      ['cooldown','Cooldown until',u.rateLimitedUntil && u.rateLimitedUntil > Date.now() ? presentation.relative(u.rateLimitedUntil, Date.now(), true) : '—'],
      ['error','Last serving error',u.lastError || '—']
    ]);
    root.querySelector('[data-auth-help]').hidden = a.authenticated && !a.unavailableReason;
    const shellName = "'" + a.name.replace(/'/g, "'\\''") + "'";
    setText(root.querySelector('[data-login-command]'), 'bun run src/index.ts accounts login ' + shellName + (a.provider === 'openai' ? ' --provider openai' : ''));
    const route = detail.routing, row = route.candidates.concat(route.others).find(r => r.account.name === a.name);
    setText(root.querySelector('[data-detail-context]'), state.routingPending ? 'Updating routing context…' : route.contextLabel + (route.pickLabel === 'Hypothetical pick' ? ' · hypothetical' : ''));
    const candidate = row && row.candidate;
    const factor = key => candidate && candidate[key] != null ? (key === 'viable' ? candidate[key] ? 'Viable' : 'Below gate' : Number(candidate[key]).toFixed(2)) : '—';
    definitions(root.querySelector('[data-detail-factors]'), [
      ['priority','Priority',a.priority], ['weight','Manual weight',a.weight], ['expiry','Expiry share',factor('expiryShare')],
      ['headroom','5h headroom',candidate ? Math.round(candidate.headroom * 100) + '%' : '—'],
      ['taper','5h factor',factor('fiveHourFactor')], ['viable','Viability',factor('viable')], ['score','Weighted score',factor('score')]
    ]);
    setText(root.querySelector('[data-detail-route-reason]'), row ? row.reason : 'Not included in this candidate snapshot');
    const draft = state.forms.get('account:' + a.name);
    if (draft) {
      patchInput(priority, draft.value.priority); patchInput(weight, draft.value.weight);
      const disabled = draft.phase === 'saving' || detail.removed;
      form.querySelector('fieldset').disabled = disabled;
      form.querySelector('[type="submit"]').disabled = disabled;
      form.querySelector('[data-cancel-account]').disabled = draft.phase === 'saving';
      setText(root.querySelector('[data-account-feedback]'), draft.message || (draft.phase === 'dirty' ? 'Unsaved changes' : draft.phase === 'saving' ? 'Saving…' : ''));
      root.querySelector('[data-account-conflict]').hidden = !draft.externalChange;
    }
    if (!root.open) { returnFocus = document.activeElement; root.showModal(); root.querySelector('[aria-label="Close account details"]').focus(); }
  }
  return { update, destroy() { windows.clear(); } };
}
`;
