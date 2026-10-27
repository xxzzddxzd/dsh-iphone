#!/usr/bin/env node
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createNativeSettingsBridge } from '../ios/native/native-settings-bridge.mjs'
import { patchMobileGateway } from '../scripts/patch-mobile-gateway.mjs'

const require = createRequire(new URL('../dsh-runtime/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve(name)))
const { Context } = await load('@deepseek-ai/cordis')
const { Peer } = await load('@deepseek-ai/dsh-client-connection')
const { CredentialsController } = await load('@deepseek-ai/dsh-api-settings-controller')
const { TYPERT } = await load('@deepseek-ai/dsh-api-settings-controller/typert')
const { default: TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry')
const { default: RemoteAccessService } = await load('@deepseek-ai/dsh-api-remote-access')
const { default: TypertGatewayService } = await load('@deepseek-ai/dsh-api-gateway')
const { LocalCredentialProvider } = await load('@deepseek-ai/dsh-credentials-local')
const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await load('@deepseek-ai/dsh-launch-environment')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-native-credentials-'))
let ctx, owner, guest
let sequence = 0
const device = { deviceId: 'paired-credentials-fixture' }
const message = (action, payload) => ({ type: 'native-settings', requestId: `credential-${++sequence}`, scope: 'plugin', action, payload })
const expectError = async (bridge, msg, code = 'bad-request', admission = device) => {
  const result = await bridge.handle(msg, admission)
  assert.equal(result.kind, 'error')
  assert.equal(result.code, `native-settings/${code}`)
  return result
}
try {
  const packageRoot = join(temporary, 'gateway')
  await cp(fileURLToPath(new URL('../mobile-gateway/node_modules/dsh-plugin-mobile-gateway', import.meta.url)), packageRoot, { recursive: true, dereference: true })
  await patchMobileGateway(packageRoot)
  const { createDshHostAdapter } = await import(pathToFileURL(join(packageRoot, 'lib/dsh-host-adapter.mjs')))
  const fakePeer = { principal: { kind: 'owner' }, signal: new AbortController().signal }
  const secret = 'synthetic-fixture-api-key-never-return-this-value'
  const calls = []
  let valueReads = 0
  const bridge = createNativeSettingsBridge({ peer: fakePeer, api: { credentials: {
    async describe(payload) {
      calls.push(['describe', payload])
      const result = Object.fromEntries(payload.refs.map(ref => [ref, Object.defineProperty({ configured: true, source: 'file', writable: true }, 'value', {
        enumerable: true, get() { valueReads++; return secret },
      })]))
      result.NOT_REQUESTED = { configured: true, writable: true, value: secret }
      return result
    },
    async set(payload) { calls.push(['set', payload]); return { value: secret } },
    async unset(payload) { calls.push(['unset', payload]); return { value: secret } },
  } } })
  await expectError(bridge, message('credentials.set', { ref: 'FIXTURE_KEY', value: secret }), 'authentication-required', {})
  for (const invalid of [
    message('credentials.resolve', { ref: 'FIXTURE_KEY' }),
    message('credentials.describe', { refs: ['BAD-REF'] }),
    message('credentials.describe', { refs: ['1BAD'] }),
    message('credentials.describe', { refs: ['A'.repeat(129)] }),
    message('credentials.describe', { refs: Array.from({ length: 65 }, (_, index) => `FIXTURE_${index}`) }),
    message('credentials.describe', { refs: ['FIXTURE_KEY'], endpoint: 'credentials/resolve' }),
    message('credentials.set', { ref: 'FIXTURE_KEY', value: '' }),
    message('credentials.set', { ref: 'FIXTURE_KEY', value: 'x'.repeat(8193) }),
    message('credentials.unset', { ref: 'BAD REF' }),
    message('credentials.unset', { ref: 'FIXTURE_KEY', value: secret }),
  ]) await expectError(bridge, invalid)
  await expectError(bridge, message('credentials.set', { ref: 'FIXTURE_KEY', value: '中'.repeat(6000) }), 'too-large')
  assert.equal(calls.length, 0, 'invalid/unpaired credential actions reached the Host')
  const refs = ['FIXTURE_KEY', '_FIXTURE_2', '__proto__', 'constructor', 'prototype']
  const info = await bridge.handle(message('credentials.describe', { refs }), device)
  assert.deepEqual(Object.keys(info.value), refs)
  assert.ok(Object.values(info.value).every(value => JSON.stringify(value) === JSON.stringify({ configured: true, source: 'file', writable: true })))
  assert.equal(valueReads, 0, 'credential projection inspected a backend value accessor')
  assert.ok(!JSON.stringify(info).includes(secret), 'credential describe returned a backend value')
  assert.deepEqual((await bridge.handle(message('credentials.set', { ref: 'FIXTURE_KEY', value: secret }), device)).value, { stored: true })
  assert.deepEqual((await bridge.handle(message('credentials.unset', { ref: 'FIXTURE_KEY' }), device)).value, { removed: true })
  assert.equal({}.configured, undefined, 'POSIX reference keys polluted the object prototype')
  const throwing = createNativeSettingsBridge({ peer: fakePeer, api: { credentials: { set() { throw new Error(secret) } } } })
  assert.ok(!JSON.stringify(await expectError(throwing, message('credentials.set', { ref: 'FIXTURE_KEY', value: secret }), 'failed')).includes(secret))
  await expectError(createNativeSettingsBridge({ peer: fakePeer, api: {} }), message('credentials.describe', { refs: [] }), 'unavailable')

  // The adapter alone knows Remote names and positional argument descriptors.
  const remoteCalls = []
  const adapter = createDshHostAdapter({ async invoke(request) {
    remoteCalls.push(request)
    if (request.method === 'describe') return { FIXTURE_KEY: { configured: false, writable: true } }
    return undefined // The official set/unset contract is void.
  }, stream() { throw new Error('Unexpected credential stream') } }, fakePeer)
  const adapted = createNativeSettingsBridge({ api: adapter, peer: fakePeer })
  await adapted.handle(message('credentials.describe', { refs: ['FIXTURE_KEY'] }), device)
  assert.deepEqual((await adapted.handle(message('credentials.set', { ref: 'FIXTURE_KEY', value: secret }), device)).value, { stored: true })
  assert.deepEqual((await adapted.handle(message('credentials.unset', { ref: 'FIXTURE_KEY' }), device)).value, { removed: true })
  assert.deepEqual(remoteCalls.map(({ namespace, method, args, peer, signal }) => {
    assert.equal(peer, fakePeer); assert.ok(signal instanceof AbortSignal)
    return { namespace, method, args }
  }), [
    { namespace: 'credentials', method: 'describe', args: { refs: ['FIXTURE_KEY'] } },
    { namespace: 'credentials', method: 'set', args: { ref: 'FIXTURE_KEY', value: secret } },
    { namespace: 'credentials', method: 'unset', args: { ref: 'FIXTURE_KEY' } },
  ])

  // Real Core CredentialsController + generated Remote metadata + access
  // control + file-backed provider. Only this temporary store/snapshot exists.
  const store = join(temporary, '.credentials.yaml')
  ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { NATIVE_FIXTURE_AMBIENT: 'synthetic-ambient-fallback' } },
  ]))
  await ctx.plugin(LocalCredentialProvider, { path: store, watch: false })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  ctx.typert.register(TYPERT)
  await ctx.plugin(CredentialsController)
  owner = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
  guest = new Peer(ctx, { principal: { kind: 'native-credential-guest' }, interactions: 'none' })
  const ownerBridge = createNativeSettingsBridge({ api: createDshHostAdapter(ctx.typertGateway, owner), peer: owner })
  const guestBridge = createNativeSettingsBridge({ api: createDshHostAdapter(ctx.typertGateway, guest), peer: guest })
  const ref = 'NATIVE_FIXTURE_API_KEY'
  assert.deepEqual((await ownerBridge.handle(message('credentials.describe', { refs: [ref] }), device)).value,
    { [ref]: { configured: false, writable: true } })
  assert.deepEqual((await ownerBridge.handle(message('credentials.set', { ref, value: secret }), device)).value, { stored: true })
  const stored = await readFile(store, 'utf8')
  assert.ok(stored.includes(secret), 'real CredentialProvider did not persist the fixture input')
  const configured = await ownerBridge.handle(message('credentials.describe', { refs: [ref] }), device)
  assert.deepEqual(configured.value, { [ref]: { configured: true, source: 'file', writable: true } })
  assert.ok(!JSON.stringify(configured).includes(secret))
  await expectError(guestBridge, message('credentials.set', { ref, value: 'guest-must-not-store-this' }), 'failed')
  await expectError(guestBridge, message('credentials.describe', { refs: [ref] }), 'failed')
  await expectError(guestBridge, message('credentials.unset', { ref }), 'failed')
  await expectError(ownerBridge, message('credentials.unset', { ref }), 'authentication-required', {})
  assert.equal(await readFile(store, 'utf8'), stored, 'guest/unpaired action changed the real temporary credential store')
  assert.deepEqual((await ownerBridge.handle(message('credentials.unset', { ref }), device)).value, { removed: true })
  assert.deepEqual((await ownerBridge.handle(message('credentials.describe', { refs: [ref] }), device)).value,
    { [ref]: { configured: false, writable: true } })
  const ambient = 'NATIVE_FIXTURE_AMBIENT'
  await ownerBridge.handle(message('credentials.set', { ref: ambient, value: secret }), device)
  await ownerBridge.handle(message('credentials.unset', { ref: ambient }), device)
  assert.deepEqual((await ownerBridge.handle(message('credentials.describe', { refs: [ambient] }), device)).value,
    { [ambient]: { configured: true, source: 'env', writable: true } }, 'unset should reveal an ambient fallback without reading it back')
  console.log('Native credentials: fixed adapter endpoints, strict POSIX/batch/value limits, one-way projected replies, real Core/temp-store write/describe/unset and owner/guest/unpaired fences passed')
} finally {
  await guest?.dispose()
  await owner?.dispose()
  await ctx?.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
