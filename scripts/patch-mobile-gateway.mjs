#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_VERSION = '0.11.1';
export const IPHONE_VERSION = '0.11.1+iphone.2';
export const UPSTREAM_INTEGRITY = 'sha512-je77m6JXDNFz371PvhwtHpWNVnJk5OnSyH5+ke8bZM5zukE1wE4ve1LW8f9oxZQX7kToy1LNwfcQQO3x+HpEhg==';
const repository = fileURLToPath(new URL('../', import.meta.url));
const defaultSource = resolve(repository, 'mobile-gateway/node_modules/dsh-plugin-mobile-gateway');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function once(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Mobile gateway patch preimage must occur exactly once');
  return text.replace(before, after);
}

// Full-file preimages are from the integrity-locked npm 0.11.1 archive. The
// installed pristine copy supplies expected patched bytes, so --check is also
// strict and never trusts a mutable marker inside the generated package.
const patches = [
  ['package.json', '9e4e681fbf383ce904e274c611d959e85b8b95b8a660c6ef752b564aa169cb32', text => {
    const metadata = JSON.parse(text);
    if (metadata.name !== 'dsh-plugin-mobile-gateway' || metadata.version !== UPSTREAM_VERSION) throw new Error('Unsupported mobile gateway manifest');
    metadata.version = IPHONE_VERSION;
    metadata.bundledDependencies = Object.keys(metadata.dependencies);
    // The upstream executable installs Linux/systemd/nginx helpers. This
    // device-local package exposes no setup/init CLI.
    delete metadata.bin;
    metadata.files = metadata.files.filter(name => name !== 'bin' && name !== 'helper');
    return JSON.stringify(metadata, null, 2) + '\n';
  }],
  ['cordis.patch.yml', '2eb26cdd78ce68d7f52c31041399b0814fa3ce5c0f1e5a89ad22a67431d53fa3', async () =>
    readFile(resolve(repository, 'packaging/mobile-gateway/cordis.patch.yml'), 'utf8')],
  ['lib/gateway-tools.mjs', '782adadf14bd6e6f1822d81bdec45ea36ff47bc1627de2cbe4c3e04f0b38215e', () =>
    `// iPhone variant: launchd exclusively owns the DSH service lifecycle.\nexport function webRestartAvailable() { return false }\nexport async function prepareWebRestart() {\n  throw new Error('The iPhone DSH service is managed by launchd')\n}\n`],
  ['lib/dsh-host-adapter.mjs', '6b0a64954e2f4609a744b0f72173fa51e69e251747f7a77640568d9b4ef91140', text =>
    once(text, '    settings: {\n', `    credentials: {
      describe: (payload, signal) => invoke('credentials', 'describe', { refs: payload.refs }, signal),
      set: (payload, signal) => invoke('credentials', 'set', { ref: payload.ref, value: payload.value }, signal),
      unset: (payload, signal) => invoke('credentials', 'unset', { ref: payload.ref }, signal),
    },
    settings: {
`)],
  ['lib/index.mjs', '01a2d488fbe00a3b0faaeddf6912928319f93a6013b73c8a957d95cf1e40eadf', text => {
    text = once(text, "supported: process.platform === 'darwin' || process.platform === 'win32',",
      'supported: false, // iPhone-local artifact: no desktop Tunnel executable');
    text = once(text, "import { stringifyWireFrame } from './wire-json.mjs'\n",
      "import { stringifyWireFrame } from './wire-json.mjs'\nimport { createNativeSettingsBridge, NATIVE_SETTINGS_CAPABILITY } from './iphone-native-settings.mjs'\n");
    text = once(text, '    const api = createDshHostAdapter(ctx.typertGateway, peer, ctx.connection)\n',
      '    const api = createDshHostAdapter(ctx.typertGateway, peer, ctx.connection)\n    const nativeSettings = createNativeSettingsBridge({ api, connection: ctx.connection, peer })\n');
    text = once(text, "            } else if (FILE_UPLOAD_REQUEST_TYPES.has(msg.type)) {",
      `            } else if (msg.type === 'native-settings') {
              if (!ws.deviceId) {
                sendFrame({ kind: 'error', code: 'native-settings/authentication-required', requestType: 'native-settings',
                  ...(typeof msg.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(msg.requestId) ? { requestId: msg.requestId } : {}),
                  message: 'Native settings require a paired device' })
                return
              }
              void nativeSettings.handle(msg, { deviceId: ws.deviceId }).then(sendFrame)
            } else if (FILE_UPLOAD_REQUEST_TYPES.has(msg.type)) {`);
    return once(text, "              'plugin-management-v1',\n",
      "              'plugin-management-v1',\n              ...(device ? [NATIVE_SETTINGS_CAPABILITY] : []),\n");
  }],
];
const additions = [['lib/iphone-native-settings.mjs', 'ios/native/native-settings-bridge.mjs']];

export async function patchMobileGateway(root, { source = defaultSource, check = false } = {}) {
  const inputs = await Promise.all([...patches.map(async ([name, expected, transform]) => {
    const pristine = await readFile(resolve(source, name));
    if (sha256(pristine) !== expected) throw new Error(`Unsupported mobile gateway upstream preimage: ${name}`);
    const after = Buffer.from(await transform(pristine.toString('utf8')));
    const target = resolve(root, name);
    const current = await readFile(target);
    if (!current.equals(pristine) && !current.equals(after)) throw new Error(`Unexpected mobile gateway target bytes: ${name}`);
    if (check && !current.equals(after)) throw new Error(`Mobile gateway iPhone patch is missing: ${name}`);
    return { name, target, current, after };
  }), ...additions.map(async ([name, sourcePath]) => {
    const after = await readFile(resolve(repository, sourcePath));
    const target = resolve(root, name);
    const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (current !== undefined && !current.equals(after)) throw new Error(`Unexpected mobile gateway target bytes: ${name}`);
    if (check && current === undefined) throw new Error(`Mobile gateway iPhone patch is missing: ${name}`);
    return { name, target, current, after, generated: true };
  })]);
  // Validate every preimage before the first write to avoid partial adaptation.
  if (!check) for (const entry of inputs) if (!entry.current?.equals(entry.after)) await writeFile(entry.target, entry.after);
  return { upstreamVersion: UPSTREAM_VERSION, version: IPHONE_VERSION, files: inputs.map(entry => ({ path: entry.name, sha256: sha256(entry.after), ...(entry.generated ? { generated: true } : {}) })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  if (at < 0 || !args[at + 1] || args.some((arg, i) => i !== at && i !== at + 1 && arg !== '--check')) throw new Error('usage: patch-mobile-gateway.mjs --root path [--check]');
  console.log(JSON.stringify(await patchMobileGateway(resolve(args[at + 1]), { check: args.includes('--check') })));
}
