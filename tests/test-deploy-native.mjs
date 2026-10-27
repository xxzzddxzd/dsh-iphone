#!/usr/bin/env node
/** Run deploy with an isolated fake repository and mock every SSH/SCP operation. */
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "dsh-deploy-native-"));
const write = async (path, text, executable = false) => { await writeFile(path, text); if (executable) await chmod(path, 0o755); };
try {
  const scripts = join(root, "scripts");
  const bin = join(root, "mock-bin");
  const dist = join(root, "dist");
  const log = join(root, "events.jsonl");
  await Promise.all([scripts, bin, dist, join(root, "packaging/mobile-gateway"), join(root, "ios/native"), join(root, "gateway-fixture/package")].map(path => mkdir(path, { recursive: true })));
  for (const file of ["deploy.sh", "lib.sh"]) await copyFile(join(sourceRoot, "scripts", file), join(scripts, file));
  await write(join(root, "versions.env"), [
    "NODE_VERSION=22.23.2", "NODE_PACKAGE_REVISION=1", "PNPM_VERSION=10.34.5", "PNPM_PACKAGE_REVISION=1",
    "DSH_DEBIAN_VERSION=0.2.1~rc.2-1", "DSH_CODEX_VERSION=0.2.10", "DSH_CLINE_PASS_VERSION=0.2.13",
    "DSH_MOBILE_GATEWAY_VERSION=0.11.1+iphone.1", "",
  ].join("\n"));
  for (const file of ["nodejs22_22.23.2-1_iphoneos-arm64.deb", "pnpm10_10.34.5-1_iphoneos-arm64.deb", "dsh_0.2.1~rc.2-1_iphoneos-arm64.deb", "dsh-codex-0.2.10.tgz", "dsh-cline-pass-0.2.13.tgz"]) await write(join(dist, file), "fixture");
  await write(join(root, "packaging/mobile-gateway/cordis.patch.yml"), "fixture-template\n");
  for (const file of ["migrate-profile-0.2.1.mjs", "install-native-profile.mjs"]) await write(join(scripts, file), "// uploaded fixture only\n");
  const record = `#!/usr/bin/env python3
import json,os,sys
with open(os.environ['FIXTURE_LOG'],'a') as f:
 f.write(json.dumps({'kind':os.path.basename(sys.argv[0]),'args':sys.argv[1:]})+'\\n')
`;
  for (const command of ["ssh", "scp"]) await write(join(bin, command), record, true);
  for (const command of ["package-dsh-codex.sh", "package-dsh-cline-pass.sh", "migrate-device-history.sh", "open-device.sh"]) {
    await write(join(scripts, command), `#!/usr/bin/env bash
python3 - <<'PY'
import json,os
with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps({'kind':'${command}','target':os.environ.get('DEVICE_HOST')})+'\\n')
PY
`, true);
  }
  await write(join(scripts, "package-mobile-gateway.sh"), `#!/usr/bin/env bash
set -e
python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['FIXTURE_ROOT'])
with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps({'kind':'package-mobile-gateway.sh'})+'\\n')
(root/'gateway-fixture/package/package.json').write_text(json.dumps({'name':'dsh-plugin-mobile-gateway','version':os.environ.get('FIXTURE_GATEWAY_VERSION','0.11.1+iphone.1'),'dsh':{'bundle':{'patch':'./cordis.patch.yml'}}}))
PY
tar -czf "$FIXTURE_ROOT/dist/dsh-plugin-mobile-gateway-0.11.1+iphone.1.tgz" -C "$FIXTURE_ROOT/gateway-fixture" package
`, true);
  await write(join(root, "ios/native/native_client.py"), `import json,os
with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps({'kind':'verify-app'})+'\\n')
`);
  await write(join(scripts, "install-native-app.sh"), `#!/usr/bin/env bash
python3 - <<'PY'
import json,os
with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps({'kind':'install-app','target':os.environ.get('DEVICE_HOST'),'ipa':os.path.basename(os.environ['NATIVE_APP_IPA']),'manifest':os.path.basename(os.environ['NATIVE_APP_MANIFEST'])})+'\\n')
PY
`, true);
  const ipa = join(root, "reviewed native.ipa");
  const manifest = join(root, "reviewed manifest.json");
  await write(ipa, "fixture archive"); await write(manifest, "{}");
  const run = async (extra = {}) => {
    await write(log, "");
    const env = { ...process.env, PATH: bin + ":" + process.env.PATH, FIXTURE_ROOT: root, FIXTURE_LOG: log,
      DEVICE_HOST: "192.0.2.19", DEVICE_PORT: "2229", DEVICE_USER: "root" };
    delete env.NATIVE_APP_IPA; delete env.NATIVE_APP_MANIFEST; delete env.FIXTURE_GATEWAY_VERSION;
    Object.assign(env, extra);
    const result = spawnSync("bash", [join(scripts, "deploy.sh")], { cwd: root, env, encoding: "utf8" });
    const events = (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { result, events };
  };
  const remote = event => event.kind === "ssh" ? event.args.at(-1) : "";
  const index = (events, predicate) => { const value = events.findIndex(predicate); assert.ok(value >= 0, "required deployment stage is absent"); return value; };
  const assertOrder = events => {
    const packaged = index(events, event => event.kind === "package-mobile-gateway.sh");
    const uploaded = index(events, event => event.kind === "scp" && event.args.at(-1).endsWith(":/var/root/dsh-mobile-gateway-shared.tgz"));
    const template = index(events, event => event.kind === "scp" && event.args.some(arg => arg.endsWith("packaging/mobile-gateway/cordis.patch.yml")));
    const dpkg = index(events, event => remote(event).includes("DSH_DEPLOY_DEFER_START=1 dpkg -i"));
    const migration = index(events, event => remote(event).includes("scripts/migrate-profile-0.2.1.mjs'"));
    const provider = index(events, event => remote(event).includes("--offline '/var/root/dsh-codex-shared.tgz'"));
    const cline = index(events, event => remote(event).includes("--offline '/var/root/dsh-cline-pass-shared.tgz'"));
    const gateway = index(events, event => remote(event).includes("--offline '/var/root/dsh-mobile-gateway-shared.tgz'"));
    const nativeProfile = index(events, event => remote(event).includes("scripts/install-native-profile.mjs'"));
    const history = index(events, event => event.kind === "migrate-device-history.sh");
    const bootstrap = index(events, event => remote(event).includes("launchctl bootstrap"));
    assert.ok(packaged < uploaded && uploaded < dpkg && template < nativeProfile);
    assert.ok(dpkg < migration && migration < provider && provider < cline && cline < gateway && gateway < nativeProfile && nativeProfile < history && history < bootstrap);
    assert.match(remote(events[nativeProfile]), /--runtime '\/var\/jb\/usr\/local\/lib\/dsh' --apply/);
    assert.equal(events.filter(event => remote(event).includes("launchctl bootstrap")).length, 1);
    assert.ok(!events.some(event => /kickstart|respring|sbreload/.test(remote(event))));
    assert.ok(!events.some(event => event.kind === "scp" && /mobile-gateway-(devices|state)\.json/.test(event.args.at(-1))));
    assert.ok(events.filter(event => ["migrate-device-history.sh", "open-device.sh"].includes(event.kind)).every(event => event.target === "192.0.2.19"));
  };

  const normal = await run();
  assert.equal(normal.result.status, 0, normal.result.stderr);
  assertOrder(normal.events);
  assert.ok(!normal.events.some(event => event.kind === "install-app" || event.kind === "verify-app"), "default deployment must retain the existing native build");
  for (const extra of [{ NATIVE_APP_IPA: ipa }, { NATIVE_APP_MANIFEST: manifest }]) {
    const partial = await run(extra);
    assert.notEqual(partial.result.status, 0);
    assert.match(partial.result.stderr, /set both NATIVE_APP_IPA and NATIVE_APP_MANIFEST/);
    assert.deepEqual(partial.events, [], "partial App inputs must fail before any packaging or device operation");
  }
  const explicit = await run({ NATIVE_APP_IPA: ipa, NATIVE_APP_MANIFEST: manifest });
  assert.equal(explicit.result.status, 0, explicit.result.stderr);
  assertOrder(explicit.events);
  assert.equal(explicit.events[0].kind, "verify-app", "reviewed IPA must be checked before deployment");
  const app = explicit.events.find(event => event.kind === "install-app");
  assert.deepEqual(app, { kind: "install-app", target: "192.0.2.19", ipa: basename(ipa), manifest: basename(manifest) });
  assert.ok(index(explicit.events, event => event.kind === "install-app") > index(explicit.events, event => remote(event).includes("launchctl bootstrap")));
  const stale = await run({ FIXTURE_GATEWAY_VERSION: "0.10.0" });
  assert.notEqual(stale.result.status, 0);
  assert.ok(!stale.events.some(event => ["ssh", "scp"].includes(event.kind)), "wrong Gateway metadata must be rejected before device changes");
  console.log("Native deployment verifies artifacts, migrates before offline installs, configures loopback before one bootstrap, retains App by default and rejects partial App inputs without device access");
} finally { await rm(root, { recursive: true, force: true }); }
