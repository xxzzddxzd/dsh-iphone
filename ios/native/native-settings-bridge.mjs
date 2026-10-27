// Paired native settings use the Host's existing owner Connection and APIs.
// No network fetch, client-selected URL/headers/Peer, credential store or logging.
export const NATIVE_SETTINGS_CAPABILITY = 'iphone-native-settings-v1'
export const NATIVE_SETTINGS_TIMEOUT_MS = 60_000
export const NATIVE_SETTINGS_REQUEST_BYTES = 16 * 1024
export const NATIVE_SETTINGS_RESPONSE_BYTES = 1024 * 1024
const MAX_PENDING_PER_DEVICE = 8
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
const PROVIDERS = new Set(['provider-codex', 'provider-xai', 'provider-google'])
const UNAVAILABLE = new Set(['gateway/invocation-unavailable', 'gateway/definition-unavailable', 'gateway/service-unavailable', 'settings/unavailable'])
const PROVIDER_FIELDS = Object.freeze({
  overview: [], 'auth.status': ['provider'], 'auth.login': ['provider'], 'auth.logout': ['provider'],
  'models.get': ['provider'], 'models.set': ['provider', 'models'],
  'images.get': [], 'images.set': ['modifyReadImage', 'shareImagegenWithOtherModels'],
  'responses.get': [], 'responses.set': ['useWebSocketContextReuse', 'useNativeCompaction'],
  'xai-image.get': [], 'xai-image.set': ['model'], 'egress.get': ['provider'], 'egress.set': ['provider', 'egress'],
  'vless.get': [], 'vless.configure': ['vlessUrl'], 'vless.speed-test': [],
})
const CLINE_FIELDS = Object.freeze({
  state: [], usage: [], 'key.set': ['ref', 'value'], 'key.test': ['ref', 'value'],
  'account.add': ['name', 'displayName', 'apiKeyEnv', 'enabled', 'baseURL', 'key'],
  'account.remove': ['name'], 'account.mode': ['mode', 'active'], 'account.enable': ['name', 'enabled'],
  'model.pin': ['model', 'upstreams', 'exclude', 'pinMode', 'sort', 'has'],
  'model.visibility': ['model', 'visible'], 'models.visibility': ['mode'],
  'model.probe': ['model'], 'model.validate': ['model'], 'model.test': ['model', 'upstreams', 'exclude'],
  'model.reset': ['model'], 'models.refresh': [], 'tools.expose': ['value'], 'budget.set': ['value'], history: ['limit', 'model'],
})

function failure(code) { return Object.assign(new Error('Native settings request failed'), { nativeSettingsCode: code }) }
function check(condition, code = 'bad-request') { if (!condition) throw failure(code) }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function text(value, maximum = 512) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
}
function requestID(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function credentialRef(value) { return typeof value === 'string' && value.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) }
function fields(value, allowed, required = []) {
  check(plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)))
}

// Reject getters, exotic prototypes, cycles, sparse arrays and pollution keys
// before JSON.stringify can invoke user code or coerce non-JSON values.
function safeJSON(value, maximumBytes, omitUndefined = false, credentialInfoRefs = false) {
  const ancestors = new Set()
  let nodes = 0
  function visit(item, depth) {
    check(++nodes <= maximumBytes && depth <= 64)
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string') { check(Buffer.byteLength(item) <= maximumBytes, 'too-large'); return }
    if (typeof item === 'number') { check(Number.isFinite(item)); return }
    check(typeof item === 'object' && !ancestors.has(item) && Object.getOwnPropertySymbols(item).length === 0)
    const array = Array.isArray(item)
    check(array ? Object.getPrototypeOf(item) === Array.prototype : plain(item))
    if (array) check(item.length <= maximumBytes)
    const names = Object.getOwnPropertyNames(item).filter(key => !(array && key === 'length'))
    if (array) check(names.length === item.length && names.every((key, index) => key === String(index)))
    ancestors.add(item)
    for (const key of names) {
      // A projected CredentialInfo map may have any POSIX ref, including
      // "constructor". Only its validated map keys get this exception.
      check(!FORBIDDEN.has(key) || credentialInfoRefs && depth === 1)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'))
      if (!array && omitUndefined && descriptor.value === undefined) continue
      visit(descriptor.value, depth + 1)
    }
    ancestors.delete(item)
  }
  visit(value, 0)
  const json = JSON.stringify(value)
  check(Buffer.byteLength(json) <= maximumBytes, 'too-large')
  return json
}

function validateProvider(action, payload) {
  check(Object.hasOwn(PROVIDER_FIELDS, action))
  fields(payload, PROVIDER_FIELDS[action])
  if (PROVIDER_FIELDS[action].includes('provider')) check(PROVIDERS.has(payload.provider))
  if (action === 'models.set') {
    check(Array.isArray(payload.models) && payload.models.length <= 1000)
    const seen = new Set()
    for (const model of payload.models) {
      fields(model, ['id', 'visible', 'contextWindow', 'maxTokens'], ['id'])
      check(text(model.id) && !seen.has(model.id)); seen.add(model.id)
      for (const field of ['contextWindow', 'maxTokens']) if (Object.hasOwn(model, field)) check(Number.isSafeInteger(model[field]) && model[field] > 0)
      if (Object.hasOwn(model, 'visible')) check(typeof model.visible === 'boolean')
    }
  }
  if (action === 'images.set' || action === 'responses.set') {
    check(Object.keys(payload).length > 0 && Object.values(payload).every(value => typeof value === 'boolean'))
  }
  if (action === 'xai-image.set') check(text(payload.model))
  if (action === 'egress.set') check(['direct', 'vless'].includes(payload.egress))
  if (action === 'vless.configure') check(text(payload.vlessUrl, 8192) && payload.vlessUrl.startsWith('vless://'))
}

function validateCline(action, payload) {
  check(Object.hasOwn(CLINE_FIELDS, action))
  fields(payload, CLINE_FIELDS[action])
  for (const field of ['name', 'displayName', 'apiKeyEnv', 'baseURL', 'key', 'ref', 'model', 'active', 'sort', 'value']) {
    if (!Object.hasOwn(payload, field) || ['budget.set', 'tools.expose'].includes(action) && field === 'value') continue
    check(typeof payload[field] === 'string' && payload[field].length <= (['key', 'value'].includes(field) ? 8192 : 2048))
  }
  if (action.startsWith('model.')) check(text(payload.model))
  if (action === 'key.set') check(text(payload.ref) && text(payload.value, 8192))
  if (action === 'key.test') check(text(payload.ref) || text(payload.value, 8192))
  if (['account.add', 'account.remove', 'account.enable'].includes(action)) check(text(payload.name) && /^[A-Za-z0-9._-]+$/.test(payload.name) && !FORBIDDEN.has(payload.name))
  for (const field of ['enabled', 'visible']) if (Object.hasOwn(payload, field)) check(typeof payload[field] === 'boolean')
  if (action === 'account.mode') check((Object.hasOwn(payload, 'mode') || Object.hasOwn(payload, 'active')) && (payload.mode === undefined || ['single', 'roundrobin'].includes(payload.mode)))
  if (action === 'models.visibility') check(['all', 'none', 'invert'].includes(payload.mode))
  if (Object.hasOwn(payload, 'pinMode')) check(['preferred', 'strict'].includes(payload.pinMode))
  for (const field of ['upstreams', 'exclude', 'has']) if (Object.hasOwn(payload, field)) check(Array.isArray(payload[field]) && payload[field].length <= 100 && payload[field].every(value => text(value)))
  if (action === 'tools.expose') check(typeof payload.value === 'boolean')
  if (action === 'budget.set') check(Number.isSafeInteger(payload.value) && payload.value >= 1024 && payload.value <= 2_000_000)
  if (action === 'history' && payload.limit !== undefined) check(Number.isSafeInteger(payload.limit) && payload.limit >= 1 && payload.limit <= 100)
}

function validatePlugin(action, payload) {
  if (['credentials.describe', 'credentials.set', 'credentials.unset'].includes(action)) {
    const keys = action === 'credentials.describe' ? ['refs'] : action === 'credentials.set' ? ['ref', 'value'] : ['ref']
    fields(payload, keys, keys)
    if (action === 'credentials.describe') check(Array.isArray(payload.refs) && payload.refs.length <= 64 && payload.refs.every(credentialRef))
    else check(credentialRef(payload.ref))
    if (action === 'credentials.set') check(typeof payload.value === 'string' && payload.value.length > 0 && payload.value.length <= 8192)
    return
  }
  check(['describe', 'mutate'].includes(action))
  fields(payload, action === 'describe' ? ['ns'] : ['ns', 'ops', 'expectedRevision'], action === 'mutate' ? ['ns', 'ops', 'expectedRevision'] : [])
  if (Object.hasOwn(payload, 'ns')) check(text(payload.ns) && !FORBIDDEN.has(payload.ns))
  if (action === 'describe') return
  check(Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision >= 0)
  check(Array.isArray(payload.ops) && payload.ops.length >= 1 && payload.ops.length <= 100)
  for (const op of payload.ops) {
    check(plain(op) && ['set', 'unset'].includes(op.op))
    fields(op, op.op === 'set' ? ['op', 'path', 'value'] : ['op', 'path'], op.op === 'set' ? ['op', 'path', 'value'] : ['op', 'path'])
    check(Array.isArray(op.path) && op.path.length >= 1 && op.path.length <= 32 && op.path.every(part => text(part, 256) && !FORBIDDEN.has(part)))
  }
}

const MESSAGES = Object.freeze({
  'bad-request': 'Invalid native settings request', 'too-large': 'Native settings data exceeds its size limit',
  unavailable: 'This settings service is unavailable; enable or update its plugin',
  'authentication-required': 'Native settings require a paired device',
  busy: 'Too many settings requests are still running on this device',
  duplicate: 'A settings request already uses this requestId',
  timeout: 'The settings request timed out; refresh its current state before retrying',
  conflict: 'These settings changed; reload before saving', failed: 'The settings operation failed',
})
function errorFrame(msg, code) {
  const descriptor = msg !== null && typeof msg === 'object' ? Object.getOwnPropertyDescriptor(msg, 'requestId') : undefined
  const id = descriptor && Object.hasOwn(descriptor, 'value') && requestID(descriptor.value) ? descriptor.value : undefined
  return { kind: 'error', requestType: 'native-settings',
    ...(id === undefined ? {} : { requestId: id }),
    code: `native-settings/${code}`, message: MESSAGES[code] ?? MESSAGES.failed }
}
function errorCode(error) {
  if (Object.hasOwn(MESSAGES, error?.nativeSettingsCode)) return error.nativeSettingsCode
  if (UNAVAILABLE.has(error?.code)) return 'unavailable'
  if (error?.code === 'gateway/internal' && typeof error.message === 'string' &&
      (error.message.startsWith('settings service is absent:') || error.message.startsWith('credentials service is absent:'))) return 'unavailable'
  if (['SETTINGS_CONFLICT', 'settings/conflict'].includes(error?.code)) return 'conflict'
  return 'failed'
}

async function responseJSON(response) {
  check(response instanceof Response, 'failed')
  if ([404, 503].includes(response.status)) { void response.body?.cancel().catch(() => {}); throw failure('unavailable') }
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw failure('failed') }
  const reader = response.body?.getReader()
  check(reader, 'failed')
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      check(bytes <= NATIVE_SETTINGS_RESPONSE_BYTES, 'too-large')
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

function projectCredentialInfos(value, refs) {
  check(plain(value), 'failed')
  const ownData = (object, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    check(descriptor === undefined || Object.hasOwn(descriptor, 'value'), 'failed')
    return descriptor?.value
  }
  return Object.fromEntries(refs.map(ref => {
    const info = ownData(value, ref)
    check(plain(info), 'failed')
    const configured = ownData(info, 'configured'), writable = ownData(info, 'writable'), source = ownData(info, 'source')
    check(typeof configured === 'boolean' && typeof writable === 'boolean' &&
      (source === undefined || typeof source === 'string' && source.length <= 128 && !/[\x00-\x1f\x7f]/.test(source)), 'failed')
    return [ref, { configured, ...(source === undefined ? {} : { source }), writable }]
  }))
}

export function createNativeSettingsBridge({ api, connection, peer, timeoutMs = NATIVE_SETTINGS_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NATIVE_SETTINGS_TIMEOUT_MS) throw new Error('Invalid native settings deadline')
  const pending = new Map()
  let carrier
  try { carrier = connection?.createSharedFetchHandler?.('/api') } catch { /* capability unavailable */ }

  async function dispatch(msg, signal) {
    if (msg.scope === 'plugin') {
      const credentialMethod = { 'credentials.describe': 'describe', 'credentials.set': 'set', 'credentials.unset': 'unset' }[msg.action]
      if (credentialMethod) {
        check(typeof api?.credentials?.[credentialMethod] === 'function', 'unavailable')
        const value = await api.credentials[credentialMethod](msg.payload, signal)
        if (credentialMethod === 'describe') return projectCredentialInfos(value, msg.payload.refs)
        // Core writes return void. Never forward an unexpected provider value.
        return credentialMethod === 'set' ? { stored: true } : { removed: true }
      }
      check(typeof api?.settings?.[msg.action] === 'function', 'unavailable')
      const value = await api.settings[msg.action](msg.payload, signal)
      if (msg.action === 'describe') {
        check(plain(value) && Array.isArray(value.namespaces), 'failed')
        if (msg.payload.ns !== undefined) return { ...value, namespaces: value.namespaces.filter(item => item?.ns === msg.payload.ns) }
      }
      return value
    }
    check(typeof carrier?.fetch === 'function' && peer, 'unavailable')
    const path = msg.scope === 'provider' ? '/api/dsh-provider-settings' : '/api/cline-pass'
    const body = msg.scope === 'provider' ? { action: msg.action, payload: msg.payload } : { endpoint: msg.action, payload: msg.payload }
    const request = new Request('http://dsh.internal' + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    })
    const response = await carrier.fetch(request, peer)
    if (request.signal.aborted) { void response.body?.cancel().catch(() => {}); throw failure('timeout') }
    const result = await responseJSON(response)
    check(plain(result) && typeof result.ok === 'boolean', 'failed')
    check(result.ok && Object.hasOwn(result, 'value'), 'failed')
    return result.value
  }

  return { async handle(msg, { deviceId } = {}) {
    // Authentication precedes validation, capability checks and every owner call.
    if (!text(deviceId, 256)) return errorFrame(msg, 'authentication-required')
    try {
      safeJSON(msg, NATIVE_SETTINGS_REQUEST_BYTES)
      fields(msg, ['type', 'requestId', 'scope', 'action', 'payload'], ['type', 'requestId', 'scope', 'action', 'payload'])
      check(msg.type === 'native-settings' && requestID(msg.requestId) && typeof msg.action === 'string' && ['provider', 'cline-pass', 'plugin'].includes(msg.scope))
      const validate = { provider: validateProvider, 'cline-pass': validateCline, plugin: validatePlugin }[msg.scope]
      validate(msg.action, msg.payload)
    } catch (error) { return errorFrame(msg, errorCode(error)) }
    if (peer?.signal?.aborted) return errorFrame(msg, 'unavailable')
    const requests = pending.get(deviceId) ?? new Set()
    if (requests.has(msg.requestId)) return errorFrame(msg, 'duplicate')
    if (requests.size >= MAX_PENDING_PER_DEVICE) return errorFrame(msg, 'busy')
    requests.add(msg.requestId); pending.set(deviceId, requests)
    const abort = new AbortController()
    let timer, abortListener
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve(errorFrame(msg, 'timeout')) }, timeoutMs)
      abortListener = () => { abort.abort(); resolve(errorFrame(msg, 'unavailable')) }
      peer?.signal?.addEventListener('abort', abortListener, { once: true })
    })
    const operation = Promise.resolve().then(() => dispatch(msg, abort.signal)).then(value => {
      const frame = { kind: 'native-settings', requestId: msg.requestId, scope: msg.scope, action: msg.action, value }
      check(value !== undefined, 'failed')
      try { return JSON.parse(safeJSON(frame, NATIVE_SETTINGS_RESPONSE_BYTES, true,
        msg.scope === 'plugin' && msg.action === 'credentials.describe')) }
      catch (error) { throw failure(error?.nativeSettingsCode === 'too-large' ? 'too-large' : 'failed') }
    }, error => errorFrame(msg, errorCode(error))).catch(error => errorFrame(msg, errorCode(error)))
    // A timed-out route may ignore AbortSignal. Keep its capacity reserved until
    // it really settles, so retries cannot accumulate unbounded Host operations.
    void operation.finally(() => {
      clearTimeout(timer)
      peer?.signal?.removeEventListener('abort', abortListener)
      requests.delete(msg.requestId)
      if (requests.size === 0) pending.delete(deviceId)
    })
    return Promise.race([operation, deadline])
  } }
}
