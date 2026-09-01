import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayNativeProvider } from './models.js';

const bundled = { providers: [{ id: 'anthropic', mode: 'native', models: [{ id: 'opus', name: 'Opus (latest)' }] }] };

test('the bundled native provider replaces the remote one, keeping the others', () => {
  const remote = { providers: [
    { id: 'openrouter', mode: 'anthropic', models: [] },
    { id: 'anthropic', mode: 'native', models: [{ id: 'claude-opus-4-8' }] }
  ] };
  const out = overlayNativeProvider(remote, bundled);
  assert.deepEqual(out.providers.map((p) => p.id), ['anthropic', 'openrouter']);
  assert.deepEqual(out.providers[0].models, bundled.providers[0].models);
});

test('a remote catalog that renamed or dropped the native provider still gets it', () => {
  const remote = { providers: [{ id: 'claude', mode: 'native', models: [{ id: 'claude-fable-5' }] }] };
  assert.deepEqual(overlayNativeProvider(remote, bundled).providers, bundled.providers);
  assert.deepEqual(overlayNativeProvider({ providers: [] }, bundled).providers, bundled.providers);
});

test('no bundled native provider leaves the catalog alone', () => {
  const remote = { providers: [{ id: 'x', mode: 'openai', models: [] }] };
  assert.deepEqual(overlayNativeProvider(remote, { providers: [] }), remote);
});
