#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { verifyNativeSettings } from '../scripts/check-native-settings.mjs';

const pins = { DSH_CODEX_VERSION: '0.2.11' };
const privateValue = 'synthetic-private-key-and-session-content-never-report';
const providers = ['provider-codex', 'provider-xai', 'provider-google'];
const clone = value => JSON.parse(JSON.stringify(value));
const refusal = code => Object.assign(new Error(code), { nativeCheckCode: code });
const mutations = calls => calls.filter(call => ['images.set', 'responses.set', 'mutate', 'credentials.set', 'credentials.unset'].includes(call.action));

async function fixture(options = {}) {
  const images = { modifyReadImage: true, shareImagegenWithOtherModels: false };
  const responses = { useWebSocketContextReuse: false, useNativeCompaction: true };
  const imageModel = { model: 'grok-imagine-image-2.0', models: [{ id: 'grok-imagine-image-2.0', name: privateValue }] };
  const models = Object.fromEntries(providers.map(provider => [provider, { models: [{ id: provider + '-fixture', name: privateValue }] }]));
  const egress = Object.fromEntries(providers.map(provider => [provider, { configured: true, running: true, reachable: true, egress: 'direct', node: privateValue }]));
  const namespace = { ns: 'agent-loop', revision: 7, value: { maxParallelToolCalls: 4, unchanged: privateValue },
    base: { maxParallelToolCalls: 4, unchanged: privateValue },
    ...options.noUser ? {} : { user: { maxParallelToolCalls: 4, unrelated: privateValue } } };
  const originalUser = structuredClone(namespace.user);
  const state = { calls: [], hostRPC: [], webRequests: [], mutates: 0, namespace };
  const routes = new Map([
    ['/plugins/dsh-openai-codex/image-tools', () => options.webMismatch ? { ...images, unexpected: privateValue } : images],
    ['/plugins/dsh-openai-codex/response-api', () => responses],
    ['/plugins/dsh-openai-codex/providers/xai/image-model', () => imageModel],
  ]);
  for (const provider of providers) {
    routes.set(`/plugins/dsh-openai-codex/providers/${provider}/models`, () => models[provider]);
    routes.set(`/plugins/dsh-openai-codex/providers/${provider}/egress`, () => egress[provider]);
  }
  const server = createServer((request, response) => {
    state.webRequests.push({ method: request.method, path: request.url });
    assert.equal(request.headers.cookie, 'fixture-cookie=value');
    assert.equal(request.headers.origin, base.origin);
    const route = routes.get(request.url);
    response.writeHead(route ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(route ? route() : {}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = new URL(`http://127.0.0.1:${server.address().port}/`);
  const host = { base, cookie: 'fixture-cookie=value', async rpc(endpoint) {
    state.hostRPC.push(endpoint);
    assert.equal(endpoint, 'session/list');
    return { items: [{ sessionId: 'fixture-session', running: options.busy === true }] };
  } };
  const control = { async request(type, kind, fields) {
    assert.equal(type, 'native-settings'); assert.equal(kind, 'native-settings');
    const { requestId, scope, action, payload } = fields;
    state.calls.push(clone({ scope, action, payload }));
    let value;
    if (scope === 'provider') {
      if (action === 'overview') value = { settingsReady: true, components: { bundle: { version: pins.DSH_CODEX_VERSION } }, providers: providers.map(id => ({ id })) };
      else if (action === 'models.get') value = models[payload.provider];
      else if (action === 'egress.get') value = egress[payload.provider];
      else if (action === 'images.get') value = images;
      else if (action === 'responses.get') value = responses;
      else if (action === 'xai-image.get') value = imageModel;
      else if (action === 'images.set') { assert.deepEqual(payload, images); value = images; }
      else if (action === 'responses.set') { assert.deepEqual(payload, responses); value = responses; }
      else throw new Error('Unexpected Provider action in acceptance fixture');
    } else if (scope === 'cline-pass') {
      if (action === 'state') value = { accounts: [{ key: privateValue, apiKeyEnv: 'FIXTURE_CLINE_KEY' }], models: [{ id: privateValue }] };
      else if (action === 'history') { assert.deepEqual(payload, { limit: 1 }); value = { entries: [{ content: privateValue }] }; }
      else throw new Error('Unexpected Cline mutation in acceptance fixture');
    } else if (scope === 'plugin') {
      if (action === 'describe') value = { writable: true, namespaces: [namespace] };
      else if (action === 'credentials.describe') {
        assert.deepEqual(payload.refs, ['FIXTURE_CLINE_KEY']);
        value = { FIXTURE_CLINE_KEY: { configured: true, source: 'file', writable: true,
          ...options.credentialLeak ? { value: privateValue } : {} } };
      } else if (action === 'mutate') {
        state.mutates++;
        assert.equal(payload.ns, 'agent-loop');
        if (options.initialConflict && state.mutates === 1) namespace.revision++;
        if (options.firstMutationFails && state.mutates === 1) throw refusal('fixture-mutation-rejected');
        if (payload.expectedRevision !== namespace.revision) throw refusal('fixture-revision-conflict');
        for (const op of payload.ops) {
          assert.deepEqual(op.path, ['maxParallelToolCalls']);
          namespace.user ??= {};
          if (op.op === 'set') { assert.equal(op.value, 4); namespace.user.maxParallelToolCalls = op.value; }
          else { assert.equal(op.op, 'unset'); delete namespace.user.maxParallelToolCalls; }
        }
        namespace.revision++;
        value = clone(namespace);
        if (state.mutates === 1 && options.changedResponseMismatch) value.value.maxParallelToolCalls = 99;
        if (state.mutates === 1 && options.concurrentAfterSet) {
          namespace.revision++;
          namespace.user.concurrent = true;
        }
      } else throw new Error('Unexpected credential/plugin action in acceptance fixture');
    } else throw new Error('Unexpected native scope');
    return clone({ kind: 'native-settings', requestId, scope, action, value });
  } };
  return { host, control, state, originalUser, async close() { await new Promise(resolve => server.close(resolve)); } };
}

function assertPrivateValuesAbsent(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(privateValue), 'an acceptance report/error exposed credential or settings values');
}

for (const options of [{}, { writeSameValues: true }, { writeSameValues: true, noUser: true }]) {
  const test = await fixture(options);
  try {
    const report = await verifyNativeSettings(test.host, test.control, { pins, writeSameValues: options.writeSameValues });
    assert.equal(report.status, 'passed');
    assert.equal(report.credentialMetadataOnly, true);
    assert.equal(report.credentialsWritten, 0);
    assert.equal(report.loginsStarted, 0);
    assert.equal(report.modelProbesSubmitted, 0);
    assertPrivateValuesAbsent(report);
    assert.ok(test.state.webRequests.every(request => request.method === 'GET'));
    if (options.writeSameValues) {
      assert.deepEqual(report.savedAndReadBack, ['image-tools', 'response-api', 'plugin-path-edit-restored']);
      assert.deepEqual(mutations(test.state.calls).map(call => call.action), ['images.set', 'responses.set', 'mutate', 'mutate']);
      assert.deepEqual(test.state.namespace.user ?? {}, test.originalUser ?? {}, 'same-value acceptance did not restore the original user layer');
      const edits = test.state.calls.filter(call => call.action === 'mutate');
      assert.equal(edits[0].payload.expectedRevision, 7);
      assert.equal(edits[1].payload.expectedRevision, 8);
      assert.equal(edits[1].payload.ops[0].op, options.noUser ? 'unset' : 'set');
      assert.deepEqual(test.state.hostRPC, ['session/list']);
    } else {
      assert.deepEqual(mutations(test.state.calls), [], 'read-only acceptance mutated settings');
      assert.deepEqual(test.state.hostRPC, []);
      assert.deepEqual(report.savedAndReadBack, []);
    }
  } finally { await test.close(); }
}
for (const [options, code, expectedMutates] of [
  [{ busy: true }, 'settings-save-requires-idle-host', 0],
  [{ initialConflict: true }, 'fixture-revision-conflict', 1],
  [{ firstMutationFails: true }, 'fixture-mutation-rejected', 1],
  [{ noUser: true, changedResponseMismatch: true }, 'native-web-settings-disagree', 2],
  [{ noUser: true, concurrentAfterSet: true }, 'fixture-revision-conflict', 2],
  [{ credentialLeak: true }, 'credential-read-projection-invalid', 0],
  [{ webMismatch: true }, 'native-web-settings-disagree', 0],
]) {
  const test = await fixture(options);
  try {
    let error;
    try { await verifyNativeSettings(test.host, test.control, { pins, writeSameValues: true }); }
    catch (value) { error = value; }
    assert.ok(error, 'invalid acceptance state was reported as passed');
    assert.equal(error.nativeCheckCode, code);
    assertPrivateValuesAbsent({ message: error.message, code: error.nativeCheckCode });
    assert.equal(test.state.mutates, expectedMutates, 'a failed mutation/restore was retried without a valid revision');
    if (options.concurrentAfterSet) {
      assert.equal(test.state.namespace.user.concurrent, true, 'restore overwrote a concurrent user-layer edit');
      const last = test.state.calls.filter(call => call.action === 'mutate').at(-1);
      assert.equal(last.payload.expectedRevision, 8, 'restore did not use the acknowledged revision');
      assert.equal(test.state.namespace.revision, 9);
    } else {
      assert.deepEqual(test.state.namespace.user ?? {}, test.originalUser ?? {}, 'exception did not restore or preserve the original user layer');
    }
    if (options.busy || options.credentialLeak || options.webMismatch) assert.deepEqual(mutations(test.state.calls), [], 'a failed read/idle gate allowed writes');
    assert.ok(!test.state.calls.some(call => ['auth.login', 'credentials.set', 'credentials.unset', 'model.probe', 'model.test', 'model.validate', 'models.set'].includes(call.action)));
  } finally { await test.close(); }
}
console.log('Native settings acceptance: read-only/no mutations, optional same-value saves with user-layer restoration, safe failure/revision refusal and secret-free credential/report gates passed');
