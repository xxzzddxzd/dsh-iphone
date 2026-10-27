#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchMobileGateway, IPHONE_VERSION, UPSTREAM_INTEGRITY } from '../scripts/patch-mobile-gateway.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const inputs = join(repository, 'mobile-gateway');
const source = join(inputs, 'node_modules/dsh-plugin-mobile-gateway');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--root'), 'usage: test-mobile-gateway.mjs [--root path]');
const temporary = await mkdtemp(join(tmpdir(), 'dsh-iphone-mobile-gateway-'));
let dispose;
try {
  const lock = JSON.parse(await readFile(join(inputs, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/dsh-plugin-mobile-gateway'].integrity, UPSTREAM_INTEGRITY);
  assert.equal(lock.packages[''].dependencies['dsh-plugin-mobile-gateway'], '0.11.1');
  assert.ok(Object.entries(lock.packages).every(([name, entry]) => !entry.hasInstallScript && !name.includes('@deepseek-ai/dsh-')));
  let root = args.length ? resolve(args[1]) : join(temporary, 'package');
  if (!args.length) {
    await cp(source, root, { recursive: true });
    await symlink(join(inputs, 'node_modules'), join(root, 'node_modules'), 'dir');
    await patchMobileGateway(root);
  }
  const report = await patchMobileGateway(root, { check: true });
  await patchMobileGateway(root); // Applying an already-adapted package is exact and idempotent.
  await patchMobileGateway(root, { check: true });
  assert.equal(report.version, IPHONE_VERSION);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.version, IPHONE_VERSION);
  assert.equal(metadata.bin, undefined);
  assert.deepEqual(metadata.bundledDependencies, Object.keys(metadata.dependencies));
  const template = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(template, /lanEnabled: false/);
  assert.match(template, /requireAuth: true/);
  assert.match(template, /ws:\/\/127\.0\.0\.1:3080\/ws\/mobile/);
  assert.doesNotMatch(template, /0\.0\.0\.0|lanEnabled: true/);
  const unexpected = join(temporary, 'unknown');
  for (const entry of report.files) {
    const target = join(unexpected, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, entry.path), target);
  }
  await writeFile(join(unexpected, 'lib/index.mjs'), '// unsupported upstream change\n');
  const pristineManifest = await readFile(join(unexpected, 'package.json'));
  await assert.rejects(patchMobileGateway(unexpected), /Unexpected mobile gateway target bytes/);
  assert.deepEqual(await readFile(join(unexpected, 'package.json')), pristineManifest, 'no files may change before every preimage is validated');

  const tools = await import(pathToFileURL(join(root, 'lib/gateway-tools.mjs')));
  assert.equal(tools.webRestartAvailable({ name: 'web' }, process), false);
  await assert.rejects(tools.prepareWebRestart(), /managed by launchd/);
  const plugin = (await import(pathToFileURL(join(root, 'lib/index.mjs')))).default;
  let management, upgrade;
  const peerAbort = new AbortController();
  let peerDisposed = false;
  const peer = { signal: peerAbort.signal, dispose: async () => { peerDisposed = true; peerAbort.abort(); } };
  const waitForAbort = signal => new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  });
  const ctx = {
    webServer: {
      port: 3080,
      register(route) { management = route; return () => { management = undefined; }; },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined; }; },
    },
    connection: { createPeer: () => peer },
    typertGateway: {
      async invoke() { throw new Error('Unexpected business RPC in local capability test'); },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace') yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } };
          else if (request.namespace === 'session') yield { type: 'baseline', value: { projections: {} } };
          else throw new Error('Unexpected stream');
          await waitForAbort(request.signal);
        })();
      },
    },
    agentDefaultModel: {},
    get(name) { return name === 'profileContext' ? { name: 'web' } : undefined; },
    on() { return () => {}; },
    effect(factory) { dispose = factory(); },
  };
  plugin.apply(ctx, { gatewayMode: 'persistent', requireAuth: true, adminLoopbackOnly: true,
    lanEnabled: false, publicUrl: 'ws://127.0.0.1:3080/ws/mobile', publicUrlFile: '',
    deviceFile: join(temporary, 'devices.json'), gatewayStateFile: join(temporary, 'state.json') });
  assert.equal(upgrade.path, '/ws/mobile');
  const request = async (method, url, body, remoteAddress = '127.0.0.1') => {
    let status, result;
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, socket: { remoteAddress } });
    const res = { writeHead(value) { status = value; }, end(value) { result = JSON.parse(value); } };
    await management.handler(req, res);
    return { status, result };
  };
  const status = await request('GET', '/mgw/status');
  assert.equal(status.status, 200);
  assert.equal(status.result.version, IPHONE_VERSION);
  assert.equal(status.result.gatewayMode, 'persistent');
  assert.equal(status.result.lan.enabled, false);
  assert.equal(status.result.cloudflare.supported, false, 'the local artifact must never select a desktop Tunnel binary, even when tested on a Mac');
  assert.deepEqual(status.result.tools, { restartWeb: false, stopWeb: false });
  for (const path of ['/mgw/tools/restart-web', '/mgw/tools/stop-web']) {
    assert.equal((await request('POST', path, {})).status, 409, 'direct calls must enforce launchd ownership');
  }
  assert.equal((await request('POST', '/mgw/cloudflare', { enabled: true, mode: 'quick' })).status, 400);
  assert.equal((await request('GET', '/mgw/status', undefined, '10.99.1.139')).status, 403);
  const paired = await request('POST', '/mgw/pair', { publicUrl: 'ws://127.0.0.1:3080/ws/mobile' });
  assert.equal(paired.status, 201);
  assert.equal(paired.result.payload.publicUrl, 'ws://127.0.0.1:3080/ws/mobile');
  assert.ok(typeof paired.result.qrPayload === 'string' && paired.result.qrPayload.length > 0);
  // Do not log the one-time pairing payload or generated credential data.
  dispose(); dispose = undefined;
  assert.equal(management, undefined);
  assert.equal(upgrade, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peerDisposed, true);

  async function inspect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await inspect(path);
      else assert.ok(!/\.(node|dylib|so|exe)$/.test(item.name), `unverified native dependency: ${path}`);
    }
  }
  await inspect(join(root, 'node_modules'));
  console.log('Mobile gateway: frozen inputs, strict patches, loopback configuration, pairing, launchd ownership, Tunnel denial and disposal passed');
} finally {
  dispose?.();
  await rm(temporary, { recursive: true, force: true });
}
