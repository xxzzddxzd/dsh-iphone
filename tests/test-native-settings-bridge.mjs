#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createNativeSettingsBridge, NATIVE_SETTINGS_TIMEOUT_MS, NATIVE_SETTINGS_CAPABILITY } from '../ios/native/native-settings-bridge.mjs'

const require = createRequire(new URL('../dsh-runtime/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { HostConnectionService } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-connection')))
const { registerPanel } = await import(new URL('../cline-pass/node_modules/dsh-cline-pass/lib/panel.js', import.meta.url))
const { createDshHostAdapter } = await import(new URL('../mobile-gateway/node_modules/dsh-plugin-mobile-gateway/lib/dsh-host-adapter.mjs', import.meta.url))
const device = { deviceId: 'paired-fixture-device' }
let sequence = 0
const message = (scope = 'provider', action = 'overview', payload = {}) => ({ type: 'native-settings', requestId: `request-${++sequence}`, scope, action, payload })
const peerAbort = new AbortController()
const peer = { principal: { kind: 'owner' }, signal: peerAbort.signal }
const failures = async (bridge, msg, code = 'bad-request', context = device) => {
  const result = await bridge.handle(msg, context)
  assert.equal(result.kind, 'error')
  assert.equal(result.requestType, 'native-settings')
  assert.equal(result.code, `native-settings/${code}`)
  return result
}
const tick = () => new Promise(resolve => setImmediate(resolve))

assert.equal(NATIVE_SETTINGS_CAPABILITY, 'iphone-native-settings-v1')
assert.equal(NATIVE_SETTINGS_TIMEOUT_MS, 60_000)
assert.throws(() => createNativeSettingsBridge({ timeoutMs: 60_001 }), /deadline/)
let calls = []
let response = () => Response.json({ ok: true, value: { ready: true } })
const connection = { createSharedFetchHandler(channel) {
  assert.equal(channel, '/api')
  return { async fetch(request, fixedPeer) {
    calls.push({ request, peer: fixedPeer, body: await request.json() })
    return response(request)
  } }
} }
const mutations = []
const api = { settings: {
  async describe(_payload, signal) {
    assert.ok(signal instanceof AbortSignal)
    return { writable: true, hasDocument: true, namespaces: [{ ns: 'entry-a', revision: 2, value: { enabled: true }, optional: undefined }, { ns: 'entry-b', revision: 0 }] }
  },
  async mutate(payload, signal) { assert.ok(signal instanceof AbortSignal); mutations.push(payload); return { ns: payload.ns, revision: 3 } },
} }
const bridge = createNativeSettingsBridge({ api, connection, peer })
await failures(bridge, message(), 'authentication-required', {})
assert.equal(calls.length, 0, 'an unpaired request reached the owner')
for (const invalid of [
  { ...message(), url: '/api/arbitrary' }, { ...message(), peer }, { ...message(), headers: {} },
  { ...message(), scope: 'credentials' }, { ...message(), action: 'constructor' }, { ...message(), requestId: 'bad id' },
  { ...message(), payload: null }, { ...message(), payload: [] }, { ...message(), payload: { unknown: true } },
  message('provider', 'models.get', { provider: 'xai' }),
  message('provider', 'models.set', { provider: 'provider-codex', models: [{ id: 'gpt-6.1-sol', value: 'unknown' }] }),
  message('provider', 'egress.set', { provider: 'provider-codex', egress: 'http://other.invalid' }),
  message('cline-pass', 'arbitrary.route'), message('cline-pass', 'key.set', { ref: 'FIXTURE_KEY', value: 'fixture-secret', url: 'https://other.invalid' }),
  message('plugin', 'mutate', { ns: 'entry-a', expectedRevision: -1, ops: [] }),
  message('plugin', 'mutate', { ns: 'entry-a', expectedRevision: 2, ops: [{ op: 'set', path: ['__proto__', 'polluted'], value: true }] }),
  message('plugin', 'mutate', { ns: 'entry-a', expectedRevision: 2, ops: [{ op: 'unset', path: ['enabled'], value: true }] }),
]) await failures(bridge, invalid)
for (const key of ['__proto__', 'constructor', 'prototype']) {
  await failures(bridge, message('plugin', 'mutate', { ns: 'entry-a', expectedRevision: 2, ops: [{ op: 'set', path: ['value'], value: JSON.parse(`{"${key}":{}}`) }] }))
}
const exotic = message(); Object.setPrototypeOf(exotic.payload, { inherited: true })
await failures(bridge, exotic)
let getterCalls = 0
const accessor = message(); Object.defineProperty(accessor, 'requestId', { enumerable: true, get() { getterCalls++; throw new Error('must not run') } })
await failures(bridge, accessor)
await failures(bridge, accessor, 'authentication-required', {})
assert.equal(getterCalls, 0, 'request validation or error correlation invoked an accessor')
const cyclic = message(); cyclic.payload.self = cyclic.payload
await failures(bridge, cyclic)
await failures(bridge, message('cline-pass', 'key.set', { ref: 'FIXTURE', value: 'x'.repeat(20_000) }), 'too-large')
assert.equal(calls.length, 0, 'invalid messages reached an owner route')

const providerPayloads = {
  overview: {}, 'auth.status': { provider: 'provider-codex' }, 'auth.login': { provider: 'provider-google' }, 'auth.logout': { provider: 'provider-xai' },
  'models.get': { provider: 'provider-codex' }, 'models.set': { provider: 'provider-codex', models: [{ id: 'gpt-6.1-sol', visible: false, maxTokens: 8192 }] },
  'images.get': {}, 'images.set': { modifyReadImage: false }, 'responses.get': {}, 'responses.set': { useNativeCompaction: true },
  'xai-image.get': {}, 'xai-image.set': { model: 'grok-imagine-image-2.0' }, 'egress.get': { provider: 'provider-google' },
  'egress.set': { provider: 'provider-xai', egress: 'vless' }, 'vless.get': {}, 'vless.configure': { vlessUrl: 'vless://fixture@example.invalid:443' }, 'vless.speed-test': {},
}
for (const [action, payload] of Object.entries(providerPayloads)) {
  const msg = message('provider', action, payload)
  assert.deepEqual(await bridge.handle(msg, device), { kind: 'native-settings', requestId: msg.requestId, scope: 'provider', action, value: { ready: true } })
  const call = calls.at(-1)
  assert.equal(call.request.url, 'http://dsh.internal/api/dsh-provider-settings')
  assert.equal(call.request.method, 'POST')
  assert.equal(call.peer, peer)
  assert.deepEqual(call.body, { action, payload })
  assert.deepEqual([...call.request.headers.keys()], ['content-type'])
}
const clinePayloads = {
  state: {}, usage: {}, 'key.set': { ref: 'FIXTURE_KEY', value: 'fixture-secret' }, 'key.test': { ref: 'FIXTURE_KEY' },
  'account.add': { name: 'fixture', displayName: 'Fixture', key: 'fixture-secret', enabled: true }, 'account.remove': { name: 'fixture' },
  'account.mode': { mode: 'roundrobin' }, 'account.enable': { name: 'fixture', enabled: false },
  'model.pin': { model: 'cline-pass/fixture', upstreams: ['fixture'], pinMode: 'preferred' }, 'model.visibility': { model: 'cline-pass/fixture', visible: true },
  'models.visibility': { mode: 'invert' }, 'model.probe': { model: 'cline-pass/fixture' }, 'model.validate': { model: 'cline-pass/fixture' },
  'model.test': { model: 'cline-pass/fixture', exclude: [] }, 'model.reset': { model: 'cline-pass/fixture' }, 'models.refresh': {},
  'tools.expose': { value: false }, 'budget.set': { value: 8192 }, history: { limit: 2 },
}
for (const [action, payload] of Object.entries(clinePayloads)) {
  assert.equal((await bridge.handle(message('cline-pass', action, payload), device)).kind, 'native-settings')
  assert.equal(calls.at(-1).request.url, 'http://dsh.internal/api/cline-pass')
  assert.deepEqual(calls.at(-1).body, { endpoint: action, payload }, 'Cline endpoint body changed')
}
const described = await bridge.handle(message('plugin', 'describe', { ns: 'entry-a' }), device)
assert.deepEqual(described.value.namespaces, [{ ns: 'entry-a', revision: 2, value: { enabled: true } }])
const edits = { ns: 'entry-a', expectedRevision: 2, ops: [{ op: 'set', path: ['enabled'], value: false }] }
assert.deepEqual((await bridge.handle(message('plugin', 'mutate', edits), device)).value, { ns: 'entry-a', revision: 3 })
assert.deepEqual(mutations, [edits])

const secret = 'fixture-private-key-vless://must-not-be-echoed'
for (const incoming of [
  () => { throw Object.assign(new Error(secret), { code: secret }) },
  () => Response.json({ ok: false, error: { code: secret, message: secret, details: { value: secret } } }),
  () => new Response(secret, { status: 500 }), () => new Response(secret),
]) {
  response = incoming
  const frame = await failures(bridge, message(), 'failed')
  assert.ok(!JSON.stringify(frame).includes(secret), 'upstream failure disclosed settings/credentials')
}
response = () => new Response('route missing', { status: 404 })
await failures(bridge, message(), 'unavailable')
await failures(createNativeSettingsBridge({ api, peer }), message(), 'unavailable')
await failures(createNativeSettingsBridge({ connection, peer }), message('plugin', 'describe'), 'unavailable')
let cancelled = false
response = () => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(new Uint8Array(600_000)); controller.enqueue(new Uint8Array(600_000))
}, cancel() { cancelled = true } }))
await failures(bridge, message(), 'too-large')
assert.equal(cancelled, true, 'oversized settings response was not cancelled')
response = () => Response.json({ ok: true, value: 'x'.repeat(1024 * 1024 - 30) })
await failures(bridge, message(), 'too-large') // The complete wire frame, not just the route body, is bounded.
response = () => Response.json({ ok: true, value: JSON.parse('{"__proto__":{}}') })
await failures(bridge, message(), 'failed')
for (const [code, detail, expected] of [['settings/conflict', secret, 'conflict'], ['gateway/internal', 'settings service is absent: ' + secret, 'unavailable']]) {
  const unavailable = createNativeSettingsBridge({ peer, api: { settings: { describe() { throw Object.assign(new Error(detail), { code }) } } } })
  assert.ok(!JSON.stringify(await failures(unavailable, message('plugin', 'describe'), expected)).includes(secret))
}

// Timeouts must bound the reply without releasing capacity for ignored aborts.
const held = []
const timeoutBridge = createNativeSettingsBridge({ peer, timeoutMs: 15, connection: {
  createSharedFetchHandler: () => ({ fetch(request) { return new Promise(resolve => held.push({ resolve, signal: request.signal })) } }),
} })
const inflight = Array.from({ length: 8 }, () => message())
const replies = inflight.map(msg => timeoutBridge.handle(msg, device))
await tick()
await failures(timeoutBridge, inflight[0], 'duplicate')
await failures(timeoutBridge, message(), 'busy')
assert.ok((await Promise.all(replies)).every(frame => frame.code === 'native-settings/timeout'))
assert.ok(held.every(item => item.signal.aborted))
await failures(timeoutBridge, message(), 'busy')
const other = timeoutBridge.handle(message(), { deviceId: 'other-device' })
await tick()
assert.equal(held.length, 9, 'device concurrency was global rather than per-device')
for (const item of held) item.resolve(Response.json({ ok: true, value: {} }))
assert.equal((await other).kind, 'native-settings')
await tick()
const next = timeoutBridge.handle(message(), device)
await tick(); held.at(-1).resolve(Response.json({ ok: true, value: {} }))
assert.equal((await next).kind, 'native-settings', 'settled operations did not release capacity')
const disposed = new AbortController()
let finishDisposed, disposedRequest, disposedCalls = 0
const disposingBridge = createNativeSettingsBridge({ peer: { signal: disposed.signal }, connection: {
  createSharedFetchHandler: () => ({ fetch(request) { disposedCalls++; disposedRequest = request; return new Promise(resolve => { finishDisposed = resolve }) } }),
} })
const disposedReply = disposingBridge.handle(message(), device)
await tick(); disposed.abort()
assert.equal((await disposedReply).code, 'native-settings/unavailable')
assert.equal(disposedRequest.signal.aborted, true, 'Peer disposal did not abort its fixed owner request')
finishDisposed(Response.json({ ok: true, value: {} }))
await tick()
await failures(disposingBridge, message(), 'unavailable')
assert.equal(disposedCalls, 1, 'a disposed Peer started new settings work')

// Real official Connection dispatch, owner fence, and the untouched Cline route.
const ctx = new Context()
ctx.provide('webServer', { register() { return () => {} } })
const official = new HostConnectionService(ctx, [], {})
const owner = official.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
let ownerCalls = 0
official.fetch.register({ path: '/api/dsh-provider-settings', methods: ['POST'], requestBody: 'streaming', async fetch(request) {
  ownerCalls++; const body = await request.json()
  return Response.json({ ok: true, value: { action: body.action, provider: body.payload.provider ?? null } })
} })
const realBridge = createNativeSettingsBridge({ api, connection: official, peer: owner })
assert.equal((await realBridge.handle(message(), device)).value.action, 'overview')
const guestBridge = createNativeSettingsBridge({ connection: official, peer: { principal: { kind: 'non-owner-fixture' } } })
await failures(guestBridge, message(), 'failed')
await failures(realBridge, message(), 'authentication-required', {})
assert.equal(ownerCalls, 1, 'a guest/unpaired caller reached the real owner route')
const hostCalls = []
const adapter = createDshHostAdapter({ async invoke(request) {
  hostCalls.push(request)
  assert.equal(request.peer, owner)
  assert.equal(request.namespace, 'settings')
  return request.method === 'describe' ? { writable: true, namespaces: [] } : { ns: request.args.ns, revision: 3 }
}, stream() { throw new Error('Unexpected native settings stream') } }, owner, official)
const adapterBridge = createNativeSettingsBridge({ api: adapter, connection: official, peer: owner })
assert.equal((await adapterBridge.handle(message('plugin', 'describe'), device)).kind, 'native-settings')
assert.deepEqual((await adapterBridge.handle(message('plugin', 'mutate', edits), device)).value, { ns: 'entry-a', revision: 3 })
assert.deepEqual(hostCalls.map(call => ({ method: call.method, args: call.args })), [
  { method: 'describe', args: {} }, { method: 'mutate', args: edits },
], 'plugin settings changed the official adapter argument contract')
let config = { accounts: {}, knownModels: [], defaultMaxTokens: 4096 }
registerPanel(ctx, { control: {
  readConfig: () => config, accountsWithKeys: async () => [], effectiveAccount: async () => '', settingsAvailable: () => true,
  async updateConfig(patch) { config = { ...config, ...patch } },
}, engine: {}, store: { usage: () => null, catalog: () => null, historySize: () => 0, historyRevision: () => 0 } })
await tick()
const changed = await realBridge.handle(message('cline-pass', 'budget.set', { value: 8192 }), device)
assert.equal(changed.kind, 'native-settings')
assert.equal(changed.value.defaultMaxTokens, 8192)
assert.equal(config.defaultMaxTokens, 8192, 'native Cline mutation did not reach the existing panel owner')
assert.equal((await realBridge.handle(message('cline-pass', 'state'), device)).value.defaultMaxTokens, 8192)
await owner.dispose()
await ctx.fiber.dispose()
console.log('Native settings: strict paired owner dispatch, Provider/Cline actions, plugin revision edits, redacted failures, bounded responses/concurrency/deadlines and real Connection+Cline route passed')
