export const SETTINGS_SOURCE = String.raw`
function createSettingsView(root, controller, forms, shared) {
  const mappingForm = root.querySelector('[data-mapping-form]'), tuningForm = root.querySelector('[data-tuning-form]');
  const enabled = root.querySelector('[data-mapping-enabled]'), rows = new Map(), tuningInputs = new Map();
  let clearedMessage = '';
  const copy = value => JSON.parse(JSON.stringify(value));
  function mappingDraft() { const d = controller.getState().forms.get('mapping'); return d ? copy(d.value) : null; }
  enabled.addEventListener('change', () => { const value = mappingDraft(); if (value) { value.enabled = enabled.checked; controller.editForm('mapping', value); } });
  function options(select, choices, selected) {
    const items = choices.slice();
    if (selected && !items.some(c => c.value === selected)) items.push({ value: selected, label: 'Unavailable: ' + selected, disabled: true });
    const signature = JSON.stringify(items);
    if (select.dataset.options !== signature) {
      select.replaceChildren(); items.forEach(item => { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; option.disabled = !!item.disabled; select.append(option); });
      select.dataset.options = signature;
    }
    // Target/effort changes are explicit user actions; keep the same select node.
    if (select.value !== selected) select.value = selected;
  }
  shared.families.forEach(family => {
    const row = element('<div class="mapping-row"><div class="mapping-target"><strong></strong><select></select></div><div class="effort-grid"></div></div>');
    setText(row.querySelector('strong'), family);
    const target = row.querySelector('.mapping-target select'); target.setAttribute('aria-label', 'Target for ' + family);
    target.addEventListener('change', () => {
      const state = controller.getState(), value = mappingDraft(); if (!value || !state.snapshot) return;
      const changed = forms.changeMappingTarget(value, family, target.value, state.snapshot.mapping.targets);
      clearedMessage = changed.clearedTiers.length ? family + ': unsupported ' + changed.clearedTiers.join(', ') + ' effort overrides cleared.' : '';
      controller.editForm('mapping', changed.value);
    });
    const efforts = new Map();
    shared.effortTiers.forEach(tier => {
      const label = document.createElement('label'), text = document.createElement('span'), select = document.createElement('select');
      setText(text, tier); select.setAttribute('aria-label', family + ' ' + tier + ' effort'); label.append(text, select); row.querySelector('.effort-grid').append(label);
      select.addEventListener('change', () => {
        const value = mappingDraft(); if (!value) return;
        const mapping = value.mappings.find(m => m.from === family); if (!mapping) return;
        mapping.effort = mapping.effort || {};
        if (select.value) mapping.effort[tier] = select.value; else delete mapping.effort[tier];
        if (!Object.keys(mapping.effort).length) delete mapping.effort;
        clearedMessage = ''; controller.editForm('mapping', value);
      });
      efforts.set(tier, select);
    });
    root.querySelector('[data-mapping-rows]').append(row); rows.set(family, { row, target, efforts });
  });
  const descriptions = {
    fiveHourExp: 'How strongly low five-hour headroom reduces a share.',
    headroomTaperStart: 'Remaining fraction below which the taper applies (0–1, above zero).',
    minHeadroom: 'Minimum remaining five-hour fraction for normal selection (0–1).',
  };
  shared.tuningFields.forEach(field => {
    const label = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input'), hint = document.createElement('small');
    setText(text, field.label); setText(hint, descriptions[field.key]); input.type = 'number'; input.step = 'any'; input.min = String(field.min); input.max = String(field.max); input.setAttribute('aria-label', field.label);
    input.addEventListener('input', () => {
      const draft = controller.getState().forms.get('tuning'); if (!draft) return;
      controller.editForm('tuning', { ...draft.value, [field.key]: input.value });
    });
    label.append(text, input, hint); root.querySelector('[data-tuning-fields]').append(label); tuningInputs.set(field.key, input);
  });
  mappingForm.addEventListener('submit', event => { event.preventDefault(); clearedMessage = ''; controller.saveForm('mapping'); });
  tuningForm.addEventListener('submit', event => { event.preventDefault(); controller.saveForm('tuning'); });
  root.querySelector('[data-cancel-mapping]').addEventListener('click', () => { clearedMessage = ''; controller.cancelForm('mapping'); });
  root.querySelector('[data-cancel-tuning]').addEventListener('click', () => controller.cancelForm('tuning'));
  function feedback(form, draft, key) {
    const saving = !draft || draft.phase === 'saving';
    form.querySelector('fieldset').disabled = saving; form.querySelector('[type="submit"]').disabled = saving;
    form.querySelector('[data-cancel-' + key + ']').disabled = saving;
    const text = !draft ? 'Waiting for status…' : (draft.message || (draft.phase === 'dirty' ? 'Unsaved changes' : draft.phase === 'saving' ? 'Saving…' : ''))
      + (draft.externalChange ? ' · Server settings changed. Cancel loads latest; Save applies your draft.' : '');
    setText(form.querySelector('[data-' + key + '-feedback]'), text);
  }
  function update(state) {
    const mapping = state.forms.get('mapping'), tuning = state.forms.get('tuning');
    feedback(mappingForm, mapping, 'mapping'); feedback(tuningForm, tuning, 'tuning');
    if (!state.snapshot) return;
    if (mapping) {
      enabled.checked = mapping.value.enabled;
      const targets = state.snapshot.mapping.targets;
      rows.forEach(({ row, target, efforts }, family) => {
        const data = mapping.value.mappings.find(m => m.from === family) || { from: family, to: family };
        const classification = forms.classifyMappingTarget(data.to, state.snapshot.mapping);
        const choices = targets.map(t => ({ value: t.id, label: t.id }));
        if (!targets.some(t => t.id === family)) choices.unshift({ value: family, label: 'Claude only' });
        if (classification.pass && data.to !== family) choices.push({ value: data.to, label: 'Claude only (' + data.to + ')' });
        options(target, choices, data.to);
        const pass = classification.pass, supported = classification.target ? classification.target.supportedEfforts : [];
        row.querySelector('.effort-grid').hidden = pass;
        efforts.forEach((select, tier) => {
          const choices = [{ value: '', label: 'pass-through' }].concat(shared.codexEfforts.filter(e => supported.includes(e)).map(e => ({ value: e, label: e === 'low' ? 'Low (Light)' : e === 'xhigh' ? 'Extra High' : e.charAt(0).toUpperCase() + e.slice(1) })));
          options(select, choices, data.effort && data.effort[tier] || ''); select.disabled = pass || mapping.phase === 'saving';
        });
      });
      const validation = forms.prepareSave('mapping', mapping.value, mapping.latest, state.snapshot);
      const warning = root.querySelector('[data-mapping-warning]');
      const text = [clearedMessage, !validation.ok ? Object.values(validation.errors).join(' ') : ''].filter(Boolean).join(' ');
      warning.hidden = !text; setText(warning, text);
    }
    if (tuning) tuningInputs.forEach((input, key) => patchInput(input, tuning.value[key]));
  }
  return { update, destroy() { rows.clear(); tuningInputs.clear(); } };
}
`;
