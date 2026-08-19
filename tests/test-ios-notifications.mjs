#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMainModule,
  notificationPayload,
  parseArgs,
  sendNotification,
  validateLaunchUrl,
} from "../ios/notifications/dsh-notify.mjs";

assert.equal(validateLaunchUrl("http://127.0.0.1:3080/?session=s1"), "http://127.0.0.1:3080/?session=s1");
assert.throws(() => validateLaunchUrl("dsh://session/s1"), /HTTP\(S\)/);
assert.throws(() => validateLaunchUrl("http://root:secret@127.0.0.1:3080/"), /without credentials/);
const helperUrl = new URL("../ios/notifications/dsh-notify.mjs", import.meta.url);
assert.equal(isMainModule(fileURLToPath(helperUrl), helperUrl.href), true);
assert.equal(isMainModule(undefined, helperUrl.href), false);

const options = parseArgs([
  "--bundle-id", "ai.deepseek.dsh",
  "--url", "http://127.0.0.1:3080/?session=session-1",
  "--sound-id", "1007",
  "--timeout", "9000",
  "完成", "目标已完成",
]);
assert.equal(options.help, false);
assert.equal(options.soundId, 1007);
assert.equal(options.timeoutMs, 9000);
assert.deepEqual(notificationPayload(options), {
  version: 1,
  title: "完成",
  body: "目标已完成",
  bundleId: "ai.deepseek.dsh",
  url: "http://127.0.0.1:3080/?session=session-1",
  soundId: 1007,
});

const helperSource = await readFile(
  helperUrl,
  "utf8",
);
assert.match(helperSource, /^#!\/var\/jb\/usr\/local\/lib\/nodejs22\/node\n/);

const packageScript = await readFile(
  new URL("../scripts/package-dsh.sh", import.meta.url),
  "utf8",
);
assert.match(packageScript, /lib\/dsh\/ios\/dsh-notify\.mjs/);
assert.match(
  packageScript,
  /ln -s \.\.\/lib\/dsh\/ios\/dsh-notify\.mjs "\$STAGE\/var\/jb\/usr\/local\/bin\/dsh-notify"/,
);
assert.match(packageScript, /build\/ios-notifier\/DSH\.app/);

const postInstall = await readFile(new URL("../packaging/dsh/postinst", import.meta.url), "utf8");
assert.match(postInstall, /uicache -p "\$notifier_app"/);
const preRemove = await readFile(new URL("../packaging/dsh/prerm", import.meta.url), "utf8");
assert.match(
  preRemove,
  /remove \| deconfigure\)[\s\S]*rm -f \/var\/mobile\/Library\/DSHNotifier\/notify\.sock/,
);
const controlTemplate = await readFile(new URL("../packaging/dsh/control.in", import.meta.url), "utf8");
assert.match(controlTemplate, /\buikittools\b/);

const socketDirectory = await mkdtemp(join(tmpdir(), "dsh-notifier-test-"));
const socketPath = join(socketDirectory, "notify.sock");
let receivedPayload;
const server = createServer((socket) => {
  let request = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    request += chunk;
    const newline = request.indexOf("\n");
    if (newline < 0) return;
    receivedPayload = JSON.parse(request.slice(0, newline));
    socket.end("OK queued\n");
  });
});
try {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, resolvePromise);
  });
  await sendNotification(options, { socketPath });
  assert.deepEqual(receivedPayload, notificationPayload(options));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(socketDirectory, { recursive: true, force: true });
}

const bridgeSource = await readFile(
  new URL("../ios/notifications/DSHNotifierBridge.m", import.meta.url),
  "utf8",
);
assert.match(bridgeSource, /dispatch_async\(queue/);
assert.match(bridgeSource, /actionWithLaunchURL:callblock:/);
assert.match(bridgeSource, /observer:addBulletin:forFeed:/);
assert.match(bridgeSource, /setPublisherBulletinID:/);
assert.match(bridgeSource, /dsh-notifier-/);
assert.match(bridgeSource, /responseForAction:/);
assert.match(bridgeSource, /posix_spawn/);
assert.match(bridgeSource, /\/var\/jb\/usr\/bin\/uiopen/);
assert.match(bridgeSource, /method_setImplementation/);
assert.match(bridgeSource, /if \(handled\) return nil/);

const bridgeBuildScript = await readFile(
  new URL("../scripts/build-ios-notifier.sh", import.meta.url),
  "utf8",
);
assert.match(bridgeBuildScript, /-arch arm64e/);
assert.match(bridgeBuildScript, /DSHIconHost/);
assert.match(bridgeBuildScript, /favicon\.svg/);

const iconHostInfo = await readFile(
  new URL("../ios/notifications/DSHIconHost-Info.plist", import.meta.url),
  "utf8",
);
assert.match(iconHostInfo, /<string>ai\.deepseek\.dsh<\/string>/);
assert.match(iconHostInfo, /<string>hidden<\/string>/);

const pluginPath = new URL(
  "../build/dsh-runtime/node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs",
  import.meta.url,
);
let pluginAvailable = true;
try {
  await access(pluginPath);
} catch {
  pluginAvailable = false;
}

if (pluginAvailable) {
  const {
    navigationUrl,
    renderGoalNotification,
    renderSessionNotification,
    resolveConfig,
    runNotifier,
  } = await import(`${pluginPath.href}?test=${Date.now()}`);
  const config = resolveConfig();
  assert.equal(config.browserBaseUrl, "http://127.0.0.1:3080/");
  assert.throws(() => resolveConfig({ browserBaseUrl: "file:///tmp/dsh" }), /HTTP\(S\)/);

  assert.deepEqual(renderGoalNotification({
    operation: "complete",
    ref: { id: "g1" },
    goal: { objective: "完成通知链路" },
  }, config), { title: "DSH 目标已完成", body: "完成通知链路" });
  assert.deepEqual(renderSessionNotification({
    type: "approval/asked",
    data: { toolName: "bash", reason: "需要允许部署" },
  }, config), { title: "DSH 等待确认", body: "需要允许部署" });
  assert.deepEqual(renderSessionNotification({
    type: "tool/call",
    data: {
      name: "ask_user_question",
      arguments: JSON.stringify({ questions: [{ question: "使用哪个出口？" }] }),
    },
  }, config), { title: "DSH 等待确认", body: "使用哪个出口？" });

  const rootSession = { id: "session-root", header: {}, events: [] };
  assert.equal(navigationUrl(rootSession, config), "http://127.0.0.1:3080/?session=session-root");
  const childSession = {
    id: "child-1",
    header: { origin: "subagent", parentSession: "parent-1", seedLength: 2 },
    events: [
      { type: "subagent/descriptor", seq: 1, data: { mode: "one-shot" } },
      { type: "subagent/descriptor", seq: 2, data: { mode: "continuable" } },
    ],
  };
  assert.equal(
    navigationUrl(childSession, config),
    "http://127.0.0.1:3080/?session=child-1&parent=parent-1&mode=continuable",
  );

  let request;
  const stream = (text) => ({ readFrom: () => ({ text }) });
  const ctx = {
    subprocess: {
      spawn(value) {
        request = value;
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: stream("notification sent"), stderr: stream("") },
        };
      },
    },
  };
  await runNotifier(ctx, config, { title: "完成", body: "目标" }, rootSession);
  const urlIndex = request.argv.indexOf("--url");
  assert.ok(urlIndex > 0);
  assert.equal(request.argv[urlIndex + 1], "http://127.0.0.1:3080/?session=session-root");
} else {
  const source = await readFile(new URL("../ios/notifications/dsh-ios-notifier.mjs", import.meta.url), "utf8");
  assert.match(source, /action|navigationUrl/);
  process.stdout.write("Built notification plugin checks skipped: prepare DSH first\n");
}

console.log("iOS notification checks passed");
