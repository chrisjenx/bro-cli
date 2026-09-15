export const ROUTING_SOURCE = String.raw`
function createRoutingView(root, controller, presentation, shared) {
  const select = root.querySelector('[data-routing-context]');
  const option = document.createElement('option'); option.value = ''; option.textContent = 'Account-wide comparison'; select.append(option);
  shared.families.forEach(family => { const item = document.createElement('option'); item.value = family; item.textContent = family; select.append(item); });
  select.addEventListener('change', () => controller.setContext(select.value || null));
  const candidates = new Map(), others = new Map();
  const hero = root.querySelector('[data-routing-pick]');
  hero.append(element('<p class="eyebrow" data-pick-label></p>'), element('<h2 data-winner-name></h2>'), element('<div class="winner-meta"><span data-winner-provider></span><span data-winner-priority></span></div>'), element('<p class="subtitle small" data-pick-summary></p>'), element('<p class="muted small" data-pick-busy></p>'), element('<details class="routing-reasons"><summary>Why this account?</summary><ul data-reasons></ul></details>'));
  let reasonSignature = '';
  function sync(tbody, modelRows, cache, active, winnerName) {
    const names = new Set(modelRows.map(r => r.account.name)), ordered = [];
    for (const [name, node] of cache) if (!names.has(name)) { node.remove(); cache.delete(name); }
    modelRows.forEach(data => {
      const a = data.account; let node = cache.get(a.name);
      if (!node) {
        node = element(active ? '<tr><td><button type="button" class="account-name" data-open-account></button><span class="next-tag" hidden>Next pick</span><span class="account-meta"></span></td><td data-factor="priority"></td><td data-factor="weight"></td><td data-factor="expiryShare"></td><td data-factor="headroom"></td><td data-factor="activeSessions"></td><td data-factor="inFlight"></td><td data-factor="viable"></td><td data-factor="score"></td></tr>' : '<tr><td><button type="button" class="account-name" data-open-account></button><span class="account-meta"></span></td><td><span class="status-label"><span class="status-icon" aria-hidden="true"></span><span data-status-text></span></span></td><td data-other-reason></td></tr>');
        bindAccountRow(node, node.querySelector('[data-open-account]'), controller, a.name); cache.set(a.name, node);
      }
      setText(node.querySelector('[data-open-account]'), a.name);
      setText(node.querySelector('.account-meta'), (a.provider === 'openai' ? 'OpenAI' : 'Anthropic') + ' · ' + (a.subscriptionType || 'Unknown plan'));
      if (active) {
        const c = data.candidate;
        node.querySelector('.next-tag').hidden = a.name !== winnerName;
        node.querySelectorAll('[data-factor]').forEach(cell => {
          const key = cell.dataset.factor;
          let value = key === 'priority' ? a.priority : c && c[key];
          if (key === 'inFlight' && data.busy) value = data.busy.inFlight + ' / ' + data.busy.limit + ' · waiting';
          else if (value != null && key === 'headroom') value = Math.round(value * 100) + '%';
          else if (value != null && key === 'viable') value = value ? 'Viable' : 'Below gate';
          else if (value != null && ['weight', 'expiryShare', 'score'].includes(key)) value = Number(value).toFixed(2);
          setText(cell, value == null ? '—' : value);
        });
      } else {
        const status = presentation.statusOf(a, Date.now()); patchStatus(node.querySelector('.status-label'), status.key, status.label);
        setText(node.querySelector('[data-other-reason]'), data.reason + (data.busy ? ' · ' + data.busy.inFlight + ' / ' + data.busy.limit : ''));
      }
      ordered.push(node);
    });
    orderedRows(tbody, ordered);
  }
  function update(state) {
    patchInput(select, state.routingModel || '');
    root.querySelector('[data-routing-pending]').hidden = !state.routingPending;
    if (!state.snapshot) return;
    const model = presentation.routingModel(state.snapshot), snapshot = model.snapshot;
    // Never label the previous snapshot as the newly selected context while a request is pending.
    const mismatched = (state.snapshot.routingContext && state.snapshot.routingContext.model || null) !== state.routingModel;
    hero.hidden = mismatched;
    root.querySelector('[data-routing-candidates]').closest('.table-region').hidden = mismatched;
    root.querySelector('[data-routing-others]').closest('.table-region').hidden = mismatched;
    const note = root.querySelector('[data-routing-context-note]');
    setText(note, mismatched ? 'No snapshot for this context yet. Refresh to retry if the connection failed.' : model.pickLabel === 'Hypothetical pick'
      ? 'Hypothetical account-wide comparison across ' + model.providers.join(' + ') + '. This includes configured preview providers even when model mappings are disabled; actual model eligibility differs.'
      : 'Eligible providers: ' + (model.providers.join(' + ') || 'none — this model is unsupported on the current backend') + '. Preview for a new session; existing pins and slot availability still apply.');
    if (mismatched) return;
    setText(hero.querySelector('[data-pick-label]'), model.pickLabel);
    setText(hero.querySelector('[data-winner-name]'), model.winnerName || 'No account selected');
    setText(hero.querySelector('[data-winner-provider]'), model.winnerProvider || '');
    setText(hero.querySelector('[data-winner-priority]'), model.winnerPriority == null ? 'Priority not reported' : 'Priority ' + model.winnerPriority);
    setText(hero.querySelector('[data-pick-summary]'), snapshot.nextPick ? snapshot.nextPick.reason && snapshot.nextPick.reason.summary || 'No explanation reported.' : model.providers.length ? 'No candidate is currently selected. Inspect the accounts below.' : 'This model cannot run on the configured backend.');
    const busy = (snapshot.busy || []).find(b => b.account === model.winnerName);
    setText(hero.querySelector('[data-pick-busy]'), busy ? busy.inFlight + ' / ' + busy.limit + ' soft limit · requests may wait for a slot' : '');
    const factors = snapshot.nextPick && snapshot.nextPick.reason && snapshot.nextPick.reason.factors || [];
    hero.querySelector('details').hidden = !factors.length;
    const signature = JSON.stringify(factors);
    if (signature !== reasonSignature) {
      const list = hero.querySelector('[data-reasons]'); list.replaceChildren();
      factors.forEach(factor => {
        const li = document.createElement('li'), label = document.createElement('b'), detail = document.createElement('span');
        setText(label, factor.label); setText(detail, factor.detail); li.append(label, detail);
        if (factor.decisive) { const badge = element('<span class="decisive">Decisive</span>'); label.append(badge); }
        list.append(li);
      }); reasonSignature = signature;
    }
    const anchor = captureViewport(root);
    sync(root.querySelector('[data-routing-candidates]'), model.candidates, candidates, true, model.winnerName);
    sync(root.querySelector('[data-routing-others]'), model.others, others, false, model.winnerName);
    root.querySelector('[data-no-candidates]').hidden = model.candidates.length > 0;
    restoreViewport(root, anchor);
  }
  return { update, destroy() { candidates.clear(); others.clear(); } };
}
`;
