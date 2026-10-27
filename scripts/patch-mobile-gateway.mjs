#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_VERSION = '0.11.1';
export const IPHONE_VERSION = '0.11.1+iphone.1';
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
  ['lib/index.mjs', '01a2d488fbe00a3b0faaeddf6912928319f93a6013b73c8a957d95cf1e40eadf', text =>
    once(text, "supported: process.platform === 'darwin' || process.platform === 'win32',",
      'supported: false, // iPhone-local artifact: no desktop Tunnel executable')],
];

export async function patchMobileGateway(root, { source = defaultSource, check = false } = {}) {
  const inputs = await Promise.all(patches.map(async ([name, expected, transform]) => {
    const pristine = await readFile(resolve(source, name));
    if (sha256(pristine) !== expected) throw new Error(`Unsupported mobile gateway upstream preimage: ${name}`);
    const after = Buffer.from(await transform(pristine.toString('utf8')));
    const target = resolve(root, name);
    const current = await readFile(target);
    if (!current.equals(pristine) && !current.equals(after)) throw new Error(`Unexpected mobile gateway target bytes: ${name}`);
    if (check && !current.equals(after)) throw new Error(`Mobile gateway iPhone patch is missing: ${name}`);
    return { name, target, current, after };
  }));
  // Validate every preimage before the first write to avoid partial adaptation.
  if (!check) for (const entry of inputs) if (!entry.current.equals(entry.after)) await writeFile(entry.target, entry.after);
  return { upstreamVersion: UPSTREAM_VERSION, version: IPHONE_VERSION, files: inputs.map(entry => ({ path: entry.name, sha256: sha256(entry.after) })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  if (at < 0 || !args[at + 1] || args.some((arg, i) => i !== at && i !== at + 1 && arg !== '--check')) throw new Error('usage: patch-mobile-gateway.mjs --root path [--check]');
  console.log(JSON.stringify(await patchMobileGateway(resolve(args[at + 1]), { check: args.includes('--check') })));
}
