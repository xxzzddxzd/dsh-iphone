#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Execute the real remote-install heredoc entirely inside a temporary fixture.
// Python JSON/build gates and clear_activity_support are production code.
// App installation, signing, Widget cache setup and daemon commands are doubles.
const root = await mkdtemp(join(tmpdir(), "dsh-widget-install-"));
const installer = await readFile(fileURLToPath(new URL("../scripts/install-native-app.sh", import.meta.url)), "utf8");
const nativeModule = fileURLToPath(new URL("../ios/native/native_client.py", import.meta.url));
const match = installer.match(/<<'NATIVE_INSTALL'\n([\s\S]*?)\nNATIVE_INSTALL(?:\n|$)/);
assert.ok(match, "the production NATIVE_INSTALL program is missing");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hash = value => createHash("sha256").update(value).digest("hex");
const ownMarker = { schema: 1, managedBy: "dsh-iphone/native-client", bundleId: "com.clark.dshmobile.dev" };
const widgetBundleId = "com.clark.dshmobile.dev.AgentLiveActivityWidget";
const nativeDouble = String.raw`import importlib.util,json,os,sys
from pathlib import Path
root=Path(os.environ['WIDGET_INSTALL_FIXTURE'])
def record(kind,**fields):
    with (root/'events.jsonl').open('a') as out: out.write(json.dumps({'kind':kind,**fields})+'\n')
spec=importlib.util.spec_from_file_location('native_fixture_module',os.environ['WIDGET_INSTALL_MODULE'])
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
command=sys.argv[1];record(command)
if command=='verify-ipa':
    print(json.dumps({'status':'verified'}))
elif command=='installed':
    status='current' if (root/'installed.flag').exists() else os.environ.get('WIDGET_INSTALL_INITIAL','current')
    print(json.dumps({'status':status,'build':'37'}))
elif command=='verify-widget-setup':
    manifest=json.loads(Path('ios/native/app-release.json').read_text())
    print(json.dumps(native.verify_widget_setup(sys.argv[2],sys.argv[3],manifest)))
elif command=='clear-activity-support':
    print(json.dumps(native.clear_activity_support(root/'private/activity-widget.json',root/'public/activity-widget.json')))
elif command=='publish-activity-support':
    (root/'published.flag').write_text('published')
    print(json.dumps({'status':'published'}))
else:
    raise SystemExit('Unexpected native fixture command')
`;
const toolDouble = String.raw`#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ['WIDGET_INSTALL_FIXTURE'])
tool=Path(sys.argv[0]).name
with (root/'events.jsonl').open('a') as out: out.write(json.dumps({'kind':tool,'args':sys.argv[1:]})+'\n')
if tool=='ldid': raise SystemExit(int(os.environ.get('WIDGET_INSTALL_LDID_STATUS','0')))
if tool=='trollstorehelper':
    (root/'installed.flag').write_text('installed')
    raise SystemExit(0)
if tool in ['reload-chronod','launchctl','killall','kill','pkill']:
    raise SystemExit(int(os.environ.get('WIDGET_INSTALL_RELOAD_STATUS','0')))
if tool=='sleep': raise SystemExit(0)
raise SystemExit('Unexpected fixture tool')
`;
const setupDouble = String.raw`#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ['WIDGET_INSTALL_FIXTURE'])
counter=root/'setup-count'
index=int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(index+1))
with (root/'events.jsonl').open('a') as out: out.write(json.dumps({'kind':'setup','attempt':index+1})+'\n')
statuses=json.loads(os.environ.get('WIDGET_INSTALL_SETUP_STATUSES','[0]'))
status=statuses[min(index,len(statuses)-1)]
if status: raise SystemExit(status)
result={'status':'ready','widgetBundleId':'com.clark.dshmobile.dev.AgentLiveActivityWidget','appBuild':'37','widgetBuild':'37','attributes':['AgentActivityAttributes','DSHActivityAttributes']}
mode=os.environ.get('WIDGET_INSTALL_RESULT','ready')
if mode=='old-build': result.update(appBuild='36',widgetBuild='36')
elif mode=='wrong-target': result['widgetBundleId']='another.app.Widget'
elif mode=='malformed':
    print('invalid-json');raise SystemExit(0)
print(json.dumps(result))
`;

async function fixture(name, options = {}) {
  const directory = join(root, name);
  const stage = join(directory, "stage");
  const bin = join(directory, "bin");
  await Promise.all([bin, join(stage, "ios/native"), join(stage, "artifacts"), join(directory, "private"), join(directory, "public"), join(directory, "app-data")].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(directory, "events.jsonl"), "");
  await writeFile(join(stage, "ios/native/native_client.py"), nativeDouble);
  const setup = join(stage, "artifacts/DSHWidgetSetup");
  const entitlements = join(stage, "artifacts/DSHWidgetSetup.entitlements");
  await writeFile(setup, setupDouble);
  await chmod(setup, 0o755);
  await copyFile(fileURLToPath(new URL("../ios/native/DSHWidgetSetup.entitlements", import.meta.url)), entitlements);
  const manifest = { build: "37", widgetBundleId, capabilities: ["root-live-activity-widget-v1"],
    helperSHA256: hash(await readFile(setup)), helperEntitlementsSHA256: hash(await readFile(entitlements)) };
  await writeFile(join(stage, "ios/native/app-release.json"), JSON.stringify(manifest));
  if (options.verifyFail) await writeFile(setup, setupDouble + "\n# altered after manifest pinning\n");
  await writeFile(join(stage, "artifacts/app.ipa"), "fixture IPA; verification covered separately");
  for (const side of ["private", "public"]) await writeFile(join(directory, side, "activity-widget.json"), JSON.stringify(ownMarker));
  if (options.foreignPrivate) await writeFile(join(directory, "private/activity-widget.json"), "foreign-private-record");
  const sentinels = [join(directory, "private/gateway-map.json"), join(directory, "app-data/pairing.json"), join(directory, "app-data/preferences.plist")];
  for (const path of sentinels) await writeFile(path, "retained fixture state");
  for (const name of ["ldid", "reload-chronod", "launchctl", "killall", "kill", "pkill", "sleep", "trollstorehelper"]) {
    await writeFile(join(bin, name), toolDouble);
    await chmod(join(bin, name), 0o755);
  }
  let program = match[1]
    .replaceAll("/var/root/dsh-native-client", quote(stage))
    .replaceAll("/var/jb/Applications/TrollStoreLite.app/trollstorehelper", quote(join(bin, "trollstorehelper")));
  // Keep the real shell retry/exit-code flow; replace only its kernel/process
  // operation with a double. Never execute the embedded root reload program.
  const reloadProgram = /python3 - <<'NATIVE_RELOAD_CHRONOD'\n([\s\S]*?)\nNATIVE_RELOAD_CHRONOD/g;
  const reloadBlocks = [...program.matchAll(reloadProgram)];
  assert.equal(reloadBlocks.length, 1, "the production bounded chronod reload operation is missing");
  assert.match(reloadBlocks[0][1], /target = '\/System\/Library\/PrivateFrameworks\/ChronoCore\.framework\/Support\/chronod'/,
    "reload must retain the precise reviewed chronod target");
  program = program.replace(reloadProgram, quote(join(bin, "reload-chronod")));
  // Do not let absolute daemon-tool paths escape the fixture PATH.
  program = program.replace(/\/(?:var\/jb\/bin|usr\/bin|bin)\/(launchctl|killall|kill|pkill|sleep)\b/g,
    (_path, tool) => quote(join(bin, tool)));
  // kill is also a shell builtin, so an executable PATH double is insufficient.
  program = `kill() { ${quote(join(bin, "kill"))} "$@"; }\n` + program;
  const executableLines = program.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");
  assert.ok(!/\b(?:ssh|scp|sudo|sbreload|reboot|respring)\b/.test(executableLines), "unexpected device/system operation in install fixture");
  const script = join(directory, "install.sh");
  await writeFile(script, program);
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH,
    PYTHONDONTWRITEBYTECODE: "1",
    WIDGET_INSTALL_FIXTURE: directory, WIDGET_INSTALL_MODULE: nativeModule,
    WIDGET_INSTALL_INITIAL: options.initial ?? "current",
    WIDGET_INSTALL_LDID_STATUS: String(options.ldidStatus ?? 0), WIDGET_INSTALL_SETUP_STATUSES: JSON.stringify(options.setupStatuses ?? [0]),
    WIDGET_INSTALL_RELOAD_STATUS: String(options.reloadStatus ?? 0), WIDGET_INSTALL_RESULT: options.result ?? "ready" };
  const result = spawnSync("/bin/sh", [script], { env, cwd: directory, encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  const events = (await readFile(join(directory, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  for (const path of sentinels) assert.equal(await readFile(path, "utf8"), "retained fixture state", "App data or pairing was modified");
  return { directory, result, events };
}

try {
  const failureCases = [
    ["verify-failed", { verifyFail: true }, 0, 0],
    ["signing-failed", { ldidStatus: 1 }, 0, 0],
    ["setup-failed", { setupStatuses: [1] }, 1, 0],
    ["setup-alarm", { setupStatuses: [142] }, 1, 0],
    ["stale-twice", { setupStatuses: [2, 2] }, 2, 1],
    ["stale-then-alarm", { setupStatuses: [2, 142] }, 2, 1],
    ["reload-failed", { setupStatuses: [2, 0], reloadStatus: 1 }, 1, 1],
    ["old-output-build", { result: "old-build" }, 1, 0],
    ["wrong-output-target", { result: "wrong-target" }, 1, 0],
    ["malformed-output", { result: "malformed" }, 1, 0],
    ["foreign-private", { verifyFail: true, foreignPrivate: true }, 0, 0],
  ];
  const daemonEvents = events => events.filter(event => ["reload-chronod", "launchctl", "killall", "kill", "pkill"].includes(event.kind));
  const assertGateOrder = events => {
    const verification = events.findIndex(event => event.kind === "verify-widget-setup");
    assert.ok(verification >= 0, "device-side helper hash gate was skipped");
    assert.equal(events.filter(event => event.kind === "verify-widget-setup").length, 1);
    for (const [index, event] of events.entries()) {
      if (["ldid", "setup", "reload-chronod"].includes(event.kind)) assert.ok(verification < index, "privileged operation preceded helper verification");
      if (event.kind === "setup") assert.ok(events.slice(0, index).some(prior => prior.kind === "ldid"), "helper ran before signing");
      if (event.kind === "publish-activity-support") assert.ok(events.slice(0, index).some(prior => prior.kind === "setup"), "support published before Widget setup");
    }
  };
  for (const [name, options, attempts, reloads] of failureCases) {
    const test = await fixture(name, options);
    assertGateOrder(test.events);
    assert.notEqual(test.result.status, 0, `${name} unexpectedly passed`);
    assert.equal(test.events.filter(event => event.kind === "setup").length, attempts, `${name}: wrong setup attempts`);
    assert.equal(daemonEvents(test.events).length, reloads, `${name}: wrong daemon reload count`);
    assert.equal(test.events.filter(event => event.kind === "clear-activity-support").length, 1, `${name}: owned support was not revoked`);
    assert.ok(!test.events.some(event => event.kind === "publish-activity-support"), `${name}: failure published support`);
    const remaining = await readFile(join(test.directory, "public/activity-widget.json"), "utf8").catch(error => {
      assert.equal(error.code, "ENOENT"); return undefined;
    });
    assert.equal(remaining, undefined, `${name}: public support survived failure`);
    assert.ok(!test.events.some(event => event.kind === "trollstorehelper"), `${name}: already-current App was reinstalled`);
    if (options.verifyFail) assert.ok(!test.events.some(event => event.kind === "ldid"), `${name}: signing ran after failed hash verification`);
    if (options.foreignPrivate) assert.equal(await readFile(join(test.directory, "private/activity-widget.json"), "utf8"), "foreign-private-record");
    for (const event of daemonEvents(test.events)) {
      assert.equal(event.kind, "reload-chronod", "unexpected daemon/process operation outside the reviewed reload function");
      assert.deepEqual(event.args, [], "reload function unexpectedly accepted configurable process targets");
    }
  }
  for (const [name, options, attempts, reloads] of [
    ["already-current", {}, 1, 0], ["upgrade", { initial: "upgrade-required" }, 1, 0],
    ["stale-then-ready", { setupStatuses: [2, 0] }, 2, 1],
  ]) {
    const test = await fixture(name, options);
    assertGateOrder(test.events);
    assert.equal(test.result.status, 0, `${name}: ${test.result.stderr}`);
    assert.equal(test.events.filter(event => event.kind === "setup").length, attempts);
    assert.equal(daemonEvents(test.events).length, reloads);
    assert.equal(test.events.filter(event => event.kind === "publish-activity-support").length, 1);
    assert.ok(!test.events.some(event => event.kind === "clear-activity-support"));
    assert.equal(test.events.filter(event => event.kind === "trollstorehelper").length, options.initial === "upgrade-required" ? 1 : 0);
  }
  console.log("Native Widget install heredoc passes signing/setup/alarm failures, single stale-cache reload, build/target gates, cleanup, upgrade and retained App data");
} finally { await rm(root, { recursive: true, force: true }); }
