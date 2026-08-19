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
    apply,
    activeTurn,
    navigationUrl,
    renderGoalNotification,
    renderSessionNotification,
    resolveConfig,
    runNotifier,
  } = await import(`${pluginPath.href}?test=${Date.now()}`);
  const config = resolveConfig();
  assert.equal(config.browserBaseUrl, "http://127.0.0.1:3080/");
  assert.equal(config.notifyFailure, true);
  assert.throws(() => resolveConfig({ browserBaseUrl: "file:///tmp/dsh" }), /HTTP\(S\)/);

  const detailedSession = {
    id: "session-detailed",
    header: {},
    events: [
      { type: "session/title", data: { title: "通知链路测试" } },
      {
        type: "assistant/message",
        data: {
          turn: 1,
          message: {
            content: [
              { type: "reasoning", text: "不应出现在通知中" },
              { type: "text", text: "通知链路已经完成。\n可以点击查看。" },
            ],
          },
        },
      },
    ],
  };

  assert.deepEqual(renderGoalNotification({
    operation: "complete",
    ref: { id: "g1" },
    goal: { objective: "完成通知链路" },
  }, config, detailedSession), {
    title: "DSH 回复已完成",
    body: "会话：通知链路测试\n状态：目标已完成\n目标：完成通知链路",
  });
  assert.deepEqual(renderSessionNotification({
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  }, config, detailedSession), {
    title: "DSH 回复已完成",
    body: "会话：通知链路测试\n状态：回复已完成\n回复摘要：通知链路已经完成。 可以点击查看。",
  });
  assert.deepEqual(renderSessionNotification({
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  }, resolveConfig({ notifyConfirm: false }), detailedSession), {
    title: "DSH 回复已完成",
    body: "会话：通知链路测试\n状态：回复已完成\n回复摘要：通知链路已经完成。 可以点击查看。",
  });
  assert.deepEqual(renderSessionNotification({
    type: "turn/end",
    data: { turn: 2, reason: { kind: "blocked" } },
  }, config, detailedSession), {
    title: "DSH 会话被阻塞",
    body: "会话：通知链路测试\n状态：本轮处理被阻塞\n说明：点击查看阻塞原因",
  });
  assert.deepEqual(renderSessionNotification({
    type: "turn/end",
    data: { turn: 2, reason: { kind: "error", error: { code: "TIMEOUT", message: "请求超时" } } },
  }, config, detailedSession), {
    title: "DSH 运行失败",
    body: "会话：通知链路测试\n状态：运行失败\n错误：[TIMEOUT] 请求超时",
  });
  assert.deepEqual(renderSessionNotification({
    type: "turn/end",
    data: { turn: 1, reason: { kind: "max-tokens" } },
  }, config, detailedSession), {
    title: "DSH 输出已截断",
    body: "会话：通知链路测试\n状态：输出达到 token 上限，回复可能不完整\n最后内容：通知链路已经完成。 可以点击查看。",
  });
  assert.deepEqual(renderSessionNotification({
    type: "turn/end",
    data: { turn: 2, reason: { kind: "interrupted" } },
  }, config, detailedSession), {
    title: "DSH 会话异常中断",
    body: "会话：通知链路测试\n状态：上一轮未正常结束\n说明：DSH 恢复会话时发现异常中断，请点击查看",
  });
  assert.deepEqual(renderSessionNotification({
    type: "turn/end",
    data: { turn: 2, reason: { kind: "aborted", reason: { kind: "hook", reason: "依赖服务不可用" } } },
  }, config, detailedSession), {
    title: "DSH 会话已停止",
    body: "会话：通知链路测试\n状态：会话被系统停止\n原因：依赖服务不可用",
  });
  assert.equal(renderSessionNotification({
    type: "turn/end",
    data: { turn: 2, reason: { kind: "error", error: { code: "FAIL", message: "failed" } } },
  }, resolveConfig({ notifyFailure: false }), detailedSession), undefined);
  assert.equal(renderSessionNotification({
    type: "turn/end",
    data: { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } },
  }, config, detailedSession), undefined);
  assert.deepEqual(renderSessionNotification({
    type: "approval/asked",
    data: { toolName: "bash", reason: "需要允许部署" },
  }, config, detailedSession), {
    title: "DSH 等待确认",
    body: "会话：通知链路测试\n状态：等待工具授权\n工具：bash\n原因：需要允许部署",
  });
  assert.deepEqual(renderSessionNotification({
    type: "tool/call",
    data: {
      name: "ask_user_question",
      arguments: JSON.stringify({ questions: [{ question: "使用哪个出口？" }] }),
    },
  }, config, detailedSession), {
    title: "DSH 等待确认",
    body: "会话：通知链路测试\n状态：等待你回答\n问题：使用哪个出口？",
  });
  assert.deepEqual(renderSessionNotification({
    type: "tool/call",
    data: {
      name: "exit_plan_mode",
      arguments: JSON.stringify({ plan: "# 部署方案\n\n- 构建\n- 安装" }),
    },
  }, config, detailedSession), {
    title: "DSH 等待确认",
    body: "会话：通知链路测试\n状态：计划已准备好，等待你确认\n计划摘要：部署方案 - 构建 - 安装",
  });

  const rootSession = { id: "session-root", header: {}, events: [] };
  assert.equal(activeTurn(rootSession), undefined);
  assert.equal(activeTurn({
    ...rootSession,
    events: [
      { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } },
      { type: "turn/start", data: { turn: 4 } },
      { type: "assistant/message", data: {} },
    ],
  }), 4);
  assert.equal(activeTurn({
    ...rootSession,
    events: [
      { type: "turn/start", data: { turn: 4 } },
      { type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } },
    ],
  }), undefined);
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

  const handlers = new Map();
  const notifierRequests = [];
  let disposeNotifier;
  const notifierCtx = {
    on(eventName, callback) {
      handlers.set(eventName, callback);
      return () => handlers.delete(eventName);
    },
    effect(register) {
      disposeNotifier = register();
    },
    logger: { info() {}, warn() {} },
    subprocess: {
      spawn(value) {
        notifierRequests.push(value);
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: stream("notification sent"), stderr: stream("") },
        };
      },
    },
  };
  apply(notifierCtx, { logSuccess: false });

  handlers.get("session/event")(rootSession, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  });
  handlers.get("session/event")(childSession, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  });

  const goalSession = {
    id: "session-goal",
    header: {},
    events: [
      { type: "session/title", data: { title: "去重测试" } },
      { type: "turn/start", data: { turn: 5 } },
    ],
  };
  handlers.get("goal/changed")({
    agent: { session: goalSession },
    change: {
      operation: "complete",
      ref: { id: "g5" },
      goal: { objective: "只应通知一次" },
    },
  });
  handlers.get("session/event")(goalSession, {
    type: "turn/end",
    data: { turn: 5, reason: { kind: "completed" } },
  });

  const blockedGoalSession = {
    id: "session-blocked-goal",
    header: {},
    events: [{ type: "turn/start", data: { turn: 6 } }],
  };
  handlers.get("goal/changed")({
    agent: { session: blockedGoalSession },
    change: {
      operation: "block",
      ref: { id: "g6" },
      goal: {
        objective: "部署到手机",
        blockedReason: { message: "SSH 连接不可用" },
      },
    },
  });
  // Goal blocking is the outcome even if the agent loop itself ended cleanly.
  handlers.get("session/event")(blockedGoalSession, {
    type: "turn/end",
    data: { turn: 6, reason: { kind: "completed" } },
  });

  handlers.get("session/event")(rootSession, {
    type: "turn/end",
    data: { turn: 7, reason: { kind: "error", error: { code: "TIMEOUT", message: "请求超时" } } },
  });

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(notifierRequests.length, 4);
  assert.equal(notifierRequests[0].argv.at(-2), "DSH 回复已完成");
  assert.equal(
    notifierRequests[0].argv.at(-1),
    "会话：未命名会话\n状态：回复已完成\n说明：点击查看完整回复",
  );
  assert.equal(
    notifierRequests[1].argv.at(-1),
    "会话：去重测试\n状态：目标已完成\n目标：只应通知一次",
  );
  assert.equal(notifierRequests[2].argv.at(-2), "DSH 会话被阻塞");
  assert.equal(
    notifierRequests[2].argv.at(-1),
    "会话：未命名会话\n状态：目标被阻塞\n目标：部署到手机\n原因：SSH 连接不可用",
  );
  assert.equal(notifierRequests[3].argv.at(-2), "DSH 运行失败");
  await disposeNotifier();
} else {
  const source = await readFile(new URL("../ios/notifications/dsh-ios-notifier.mjs", import.meta.url), "utf8");
  assert.match(source, /action|navigationUrl/);
  process.stdout.write("Built notification plugin checks skipped: prepare DSH first\n");
}

console.log("iOS notification checks passed");
