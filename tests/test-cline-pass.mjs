#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === '--root'), 'usage: test-cline-pass.mjs [--root path]');
const source = join(repository, 'cline-pass/node_modules/dsh-cline-pass');
const patcher = join(repository, 'scripts/patch-dsh-cline-pass.mjs');
const temporary = await mkdtemp(join(tmpdir(), 'dsh-iphone-cline-pass-'));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const apply = file => execFileSync(process.execPath, [patcher, file], { stdio: 'pipe' });
try {
  const lock = JSON.parse(await readFile(join(repository, 'cline-pass/package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies['dsh-cline-pass'], '0.2.13');
  assert.equal(lock.packages['node_modules/dsh-cline-pass'].integrity,
    'sha512-KJAE+jASp0tYCukIr+fAJzcAE8S1ZVuvHzNKBu3mJPwl4Cd3Uh3ojYh89uweuPgv2fui3a8pSW/jw3wNvI6xUQ==');
  assert.equal(Object.keys(lock.packages).length, 2, 'the frozen input must not auto-install DSH peers');
  const root = args.length ? resolve(args[1]) : join(temporary, 'package');
  if (!args.length) {
    await cp(source, root, { recursive: true });
    apply(join(root, 'lib/client.js'));
  }
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.version, '0.2.13');
  assert.deepEqual(Object.keys(metadata.dependencies ?? {}), []);
  assert.equal(sha256(await readFile(join(root, 'lib/index.js'))), '2e7011c5b499b035baf9ef9cf9131784e1584f11be2a4721a451f7a738fef88d');
  async function filesAt(directory, prefix = '') {
    const files = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isDirectory()) files.push(...await filesAt(join(directory, item.name), name + '/'));
      else files.push(name);
    }
    return files.sort();
  }
  const upstreamFiles = await filesAt(source);
  assert.deepEqual(await filesAt(root), upstreamFiles, 'the local bundle may not add an unaudited runtime file');
  for (const name of upstreamFiles) if (name !== 'lib/client.js') {
    assert.deepEqual(await readFile(join(root, name)), await readFile(join(source, name)), `upstream file changed outside the audited client patch: ${name}`);
  }
  const file = join(root, 'lib/client.js');
  const patched = await readFile(file, 'utf8');
  apply(file);
  assert.equal(await readFile(file, 'utf8'), patched, 'patching must be idempotent');
  const bad = join(temporary, 'unknown');
  await cp(root, bad, { recursive: true });
  await writeFile(join(bad, 'lib/client.js'), patched + '\n// changed source\n');
  assert.throws(() => apply(join(bad, 'lib/client.js')), /unknown Cline Pass client preimage/);
  await writeFile(join(bad, 'lib/client.js'), patched);
  await writeFile(join(bad, 'package.json'), JSON.stringify({ ...metadata, version: '0.2.14' }));
  assert.throws(() => apply(join(bad, 'lib/client.js')), /unsupported Cline Pass package/);

  const start = patched.indexOf('      panelUrl() {');
  const end = patched.indexOf('      async call(endpoint, payload) {', start);
  assert.ok(start >= 0 && end > start);
  const methods = patched.slice(start, end);
  const origin = 'http://127.0.0.1:3080';
  let xhrCount = 0;
  class XHR {
    open(method, url, asynchronous) { assert.equal(method, 'POST'); assert.equal(url, origin + '/api/cline-pass'); assert.equal(asynchronous, true); }
    setRequestHeader(name, value) { assert.equal(name, 'content-type'); assert.equal(value, 'application/json'); }
    send(body) {
      xhrCount++;
      assert.equal(this.withCredentials, true);
      assert.equal(body, '{"endpoint":"snapshot"}');
      this.status = 200;
      this.responseText = '{"ok":true,"value":{"saved":true}}';
      queueMicrotask(() => this.onload());
    }
  }
  const sandbox = { location: { origin }, PANEL_PATH: '/api/cline-pass', XMLHttpRequest: XHR, queueMicrotask,
    fetch: async (url, request) => {
      assert.equal(url, origin + '/api/cline-pass');
      assert.equal(request.credentials, 'include');
      assert.equal(request.cache, 'no-store');
      throw new TypeError('Load failed');
    },
  };
  const transport = vm.runInNewContext(`new (class Transport { ${methods} })()`, sandbox);
  const response = await transport.postPanel('{"endpoint":"snapshot"}');
  assert.equal(response.ok, true);
  assert.equal((await response.json()).value.saved, true);
  assert.equal(xhrCount, 1);
  sandbox.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
  const refused = await transport.postPanel('{"endpoint":"snapshot"}');
  assert.equal(refused.status, 403);
  assert.equal(xhrCount, 1, 'HTTP refusals must not retry the mutation through XHR');
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) });
  await transport.postPanel('{"endpoint":"snapshot"}');
  assert.equal(xhrCount, 1, 'successful fetch must not create a second request');

  async function inspect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.notEqual(item.name, 'node_modules', 'Cline Pass must use the installed Host peers');
      assert.ok(!/\.(node|dylib|so|exe)$/.test(item.name));
      if (item.isDirectory()) await inspect(join(directory, item.name));
    }
  }
  await inspect(root);
  console.log('Cline Pass 0.2.13: exact upstream input, strict/idempotent iOS patch, credentialed XHR fallback and HTTP refusal behavior passed');
} finally { await rm(temporary, { recursive: true, force: true }); }
