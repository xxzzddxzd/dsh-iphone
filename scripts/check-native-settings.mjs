#!/usr/bin/env node
// Exercise the paired native settings wire without logging credentials or history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkNativeGateway } from './check-native-gateway.mjs';
import { UpgradeHost } from './upgrade-host.mjs';
import { readVersionPins } from './provider-components.mjs';

const require = createRequire(new URL('../dsh-runtime/package.json', import.meta.url));
const failed = code => Object.assign(new Error(code), { nativeCheckCode: code });
const need = (condition, code) => { if (!condition) throw failed(code); };
const providers = ['provider-codex', 'provider-xai', 'provider-google'];

export async function verifyNativeSettings(host, control, { writeSameValues = false, pins } = {}) {
  let requests = 0;
  const call = async (scope, action, payload = {}) => {
    const requestId = randomUUID();
    const frame = await control.request('native-settings', 'native-settings', { requestId, scope, action, payload });
    need(frame.requestId === requestId && frame.scope === scope && frame.action === action, 'settings-reply-correlation');
    need(Object.hasOwn(frame, 'value'), 'settings-value-missing');
    requests++;
    return frame.value;
  };
  const web = async path => {
    const response = await fetch(new URL(path, host.base), {
      headers: { cookie: host.cookie, origin: host.base.origin }, signal: AbortSignal.timeout(20000),
    });
    need(response.ok, 'settings-web-read-failed');
    return response.json();
  };
  const compare = (actual, expected) => {
    // Never print assert's potentially sensitive value diff.
    try { assert.deepStrictEqual(actual, expected); } catch { throw failed('native-web-settings-disagree'); }
  };
  const overview = await call('provider', 'overview');
  need(overview.settingsReady === true && overview.components?.bundle?.version === pins.DSH_CODEX_VERSION, 'provider-settings-not-ready');
  need(providers.every(id => overview.providers?.some(row => row.id === id)), 'managed-provider-missing');
  const modelCounts = {};
  for (const provider of providers) {
    const models = await call('provider', 'models.get', { provider });
    compare(models, await web(`plugins/dsh-openai-codex/providers/${provider}/models`));
    need(Array.isArray(models.models), 'settings-model-list-invalid');
    modelCounts[provider] = models.models.length;
    const egress = await call('provider', 'egress.get', { provider });
    compare(egress, await web(`plugins/dsh-openai-codex/providers/${provider}/egress`));
  }
  const images = await call('provider', 'images.get');
  compare(images, await web('plugins/dsh-openai-codex/image-tools'));
  const responses = await call('provider', 'responses.get');
  compare(responses, await web('plugins/dsh-openai-codex/response-api'));
  const imageModel = await call('provider', 'xai-image.get');
  compare(imageModel, await web('plugins/dsh-openai-codex/providers/xai/image-model'));
  const namespaces = await call('plugin', 'describe');
  need(Array.isArray(namespaces.namespaces), 'plugin-settings-list-invalid');
  const cline = await call('cline-pass', 'state');
  need(Array.isArray(cline.accounts) && Array.isArray(cline.models), 'cline-settings-state-invalid');
  const history = await call('cline-pass', 'history', { limit: 1 });
  need(Array.isArray(history.entries), 'cline-settings-history-invalid');
  const refs = [...new Set(cline.accounts.map(row => row.apiKeyEnv).filter(ref => typeof ref === 'string'))];
  const credentials = refs.length ? await call('plugin', 'credentials.describe', { refs }) : {};
  for (const [ref, info] of Object.entries(credentials)) {
    need(refs.includes(ref) && typeof info.configured === 'boolean' && typeof info.writable === 'boolean'
      && Object.keys(info).every(key => ['configured', 'source', 'writable'].includes(key)), 'credential-read-projection-invalid');
  }
  const saved = [];
  if (writeSameValues) {
    const sessions = await host.rpc('session/list', { _request: {} });
    need(!sessions.items.some(row => row.running), 'settings-save-requires-idle-host');
    compare(await call('provider', 'images.set', images), images);
    compare(await web('plugins/dsh-openai-codex/image-tools'), images);
    saved.push('image-tools');
    compare(await call('provider', 'responses.set', responses), responses);
    compare(await web('plugins/dsh-openai-codex/response-api'), responses);
    saved.push('response-api');
    const current = namespaces.namespaces.find(row => row.ns === 'agent-loop');
    if (namespaces.writable === true && Number.isSafeInteger(current?.value?.maxParallelToolCalls)) {
      const key = 'maxParallelToolCalls';
      let changed;
      try {
        changed = await call('plugin', 'mutate', { ns: current.ns, expectedRevision: current.revision,
          ops: [{ op: 'set', path: [key], value: current.value[key] }] });
        compare(changed.value, current.value);
      } finally {
        if (changed) {
          const op = Object.hasOwn(current.user ?? {}, key)
            ? { op: 'set', path: [key], value: current.user[key] } : { op: 'unset', path: [key] };
          const restored = await call('plugin', 'mutate', { ns: current.ns, expectedRevision: changed.revision, ops: [op] });
          compare(restored.value, current.value);
          // An absent user section and an empty section both mean no overrides.
          compare(restored.user ?? {}, current.user ?? {});
        }
      }
      saved.push('plugin-path-edit-restored');
    }
  }
  return { status: 'passed', requests, modelCounts, pluginNamespaces: namespaces.namespaces.length,
    clineAccounts: cline.accounts.length, clineModels: cline.models.length, credentialMetadataOnly: true,
    nativeAndWebAgree: true, savedAndReadBack: saved, credentialsWritten: 0, loginsStarted: 0, modelProbesSubmitted: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let host;
  try {
    let save, historySessionId, writeSameValues = false;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--save' && args[index + 1]) save = args[++index];
      else if (args[index] === '--session' && args[index + 1]) historySessionId = args[++index];
      else if (args[index] === '--write-same-values') writeSameValues = true;
      else throw failed('invalid-native-settings-check-arguments');
    }
    process.env.LOCAL_PORT ??= '13081';
    host = await UpgradeHost.connect('iphone');
    const pins = await readVersionPins();
    const report = await checkNativeGateway(host, { WebSocket: require('ws'), pins, timeoutMs: 30000, historySessionId,
      settingsAcceptance: control => verifyNativeSettings(host, control, { pins, writeSameValues }) });
    report.mode = writeSameValues ? 'paired-settings-save-and-restore' : 'paired-settings-read-only';
    if (save) { await mkdir(dirname(resolve(save)), { recursive: true }); await writeFile(resolve(save), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
    console.log(JSON.stringify(report));
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.nativeCheckCode ?? 'native-settings-check-failed' }));
    process.exitCode = 1;
  } finally { host?.close(); }
}
