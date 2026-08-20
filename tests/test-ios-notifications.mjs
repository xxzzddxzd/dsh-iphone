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
import {
  parseArgs as parseActivityArgs,
  sendActivityCommand as sendActivityHelperCommand,
} from "../ios/activity/dsh-activity.mjs";

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
assert.equal(options.operation, "publish");
assert.equal(options.soundId, 1007);
assert.equal(options.timeoutMs, 9000);
assert.deepEqual(notificationPayload(options), {
  version: 2,
  operation: "publish",
  title: "完成",
  body: "目标已完成",
  bundleId: "ai.deepseek.dsh",
  url: "http://127.0.0.1:3080/?session=session-1",
  soundId: 1007,
});

const allowToken = "allow_token_12345678901234567890";
const rejectToken = "reject_token_1234567890123456789";
const actionableOptions = parseArgs([
  "--id", "approval-a1",
  "--url", "http://127.0.0.1:3080/?session=session-1",
  "--actions-json", JSON.stringify([
    { title: "拒绝", token: rejectToken, authenticationRequired: false },
    { title: "允许一次", token: allowToken, authenticationRequired: true },
  ]),
  "需要授权", "展开通知后作答",
]);
assert.deepEqual(notificationPayload(actionableOptions), {
  version: 2,
  operation: "publish",
  id: "approval-a1",
  title: "需要授权",
  body: "展开通知后作答",
  bundleId: "ai.deepseek.dsh",
  url: "http://127.0.0.1:3080/?session=session-1",
  actions: [
    { title: "拒绝", token: rejectToken, authenticationRequired: false },
    { title: "允许一次", token: allowToken, authenticationRequired: true },
  ],
});
assert.deepEqual(notificationPayload(parseArgs(["--dismiss-id", "approval-a1"])), {
  version: 2,
  operation: "dismiss",
  id: "approval-a1",
});
assert.throws(() => parseArgs(["--dismiss-id", "../bad"]), /safe identifier/);
assert.throws(() => parseArgs([
  "--actions-json", '[{"title":"允许","token":"short"}]', "标题", "正文",
]), /invalid token/);

assert.deepEqual(parseActivityArgs(["status"]).command, { version: 1, operation: "status" });
assert.deepEqual(parseActivityArgs(["shutdown"]).command, { version: 1, operation: "shutdown" });
const activityTask = {
  sessionID: "s1",
  title: "测试会话",
  phase: "思考中",
  detail: "正在生成下一步",
  goalDetail: "完成 iPhone 通知链路",
  assistantDetail: "我正在检查当前状态",
  toolDetail: "Bash · 正在运行",
  startedAtMilliseconds: 1_700_000_000_000,
  finishedAtMilliseconds: 0,
  step: 2,
  agentCount: 1,
  completedItems: 1,
  totalItems: 3,
  waitingForUser: false,
};
assert.deepEqual(parseActivityArgs(["update", JSON.stringify(activityTask)]).command, {
  version: 1,
  operation: "update",
  task: activityTask,
});

const helperSource = await readFile(
  helperUrl,
  "utf8",
);
assert.match(helperSource, /^#!\/var\/jb\/usr\/local\/lib\/nodejs22\/node\n/);

const pluginSource = await readFile(
  new URL("../ios/notifications/dsh-ios-notifier.mjs", import.meta.url),
  "utf8",
);
assert.match(pluginSource, /import WebSocket from "ws"/);
assert.match(pluginSource, /new URL\("\/api\/events\.mux"/);
assert.match(pluginSource, /new URL\("\/api\/respond"/);
assert.match(pluginSource, /ctx\.on\("agent\/status"/);
assert.doesNotMatch(pluginSource, /\bfetch\s*\(/);
assert.doesNotMatch(pluginSource, /consumeMuxEvents/);
assert.doesNotMatch(pluginSource, /launchActivityHost/);

const upstreamPackage = JSON.parse(await readFile(
  new URL("../upstream/deepseek-harness/package.json", import.meta.url),
  "utf8",
));
assert.equal(upstreamPackage.version, "0.1.0-rc.7");
const officialConnectionContract = await readFile(
  new URL(
    "../upstream/deepseek-harness/packages/client/connection/README.md",
    import.meta.url,
  ),
  "utf8",
);
assert.match(officialConnectionContract, /\/api\/events\.mux/);
assert.match(officialConnectionContract, /WebSocket upgrade/);
assert.match(officialConnectionContract, /return 426 with no SSE fallback/);
const officialApprovalSchema = await readFile(
  new URL(
    "../upstream/deepseek-harness/packages/host/apiproxy/src/api/approvals.schema.ts",
    import.meta.url,
  ),
  "utf8",
);
assert.match(officialApprovalSchema, /allowed-once/);
assert.match(officialApprovalSchema, /rejected/);

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
assert.match(packageScript, /dsh-activity\.mjs/);
assert.match(packageScript, /DSHActivity\.entitlements/);
assert.match(packageScript, /DSHActivityExtension\.entitlements/);
assert.match(packageScript, /build\/ios-notifier\/DSHActivityOp/);
assert.match(packageScript, /build\/ios-notifier\/DSHActivityD/);
assert.match(packageScript, /DSHActivityWorker\.entitlements/);
assert.match(packageScript, /ai\.deepseek\.dsh-activity\.plist/);

const postInstall = await readFile(new URL("../packaging/dsh/postinst", import.meta.url), "utf8");
assert.match(postInstall, /uicache -p "\$notifier_app"/);
assert.match(postInstall, /ldid -Iai\.deepseek\.dsh\.activity-worker/);
assert.match(postInstall, /ldid -Iai\.deepseek\.dsh\.activity-broker/);
assert.match(postInstall, /ldid -Cadhoc -Iai\.deepseek\.dsh\.live-activity/);
assert.match(postInstall, /ldid -Cadhoc -Iai\.deepseek\.dsh -S/);
assert.match(postInstall, /killall DSHLiveActivity/);
assert.match(postInstall, /launchctl bootstrap system "\$activity_plist"/);
assert.match(postInstall, /launchctl bootstrap system "\$dsh_plist"/);
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

const activitySocketDirectory = await mkdtemp(join(tmpdir(), "dsh-activity-test-"));
const activitySocketPath = join(activitySocketDirectory, "activity.sock");
let receivedActivityCommand;
const activityServer = createServer((socket) => {
  let request = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    request += chunk;
    const newline = request.indexOf("\n");
    if (newline < 0) return;
    receivedActivityCommand = JSON.parse(request.slice(0, newline));
    socket.end("OK updated\n");
  });
});
try {
  await new Promise((resolvePromise, rejectPromise) => {
    activityServer.once("error", rejectPromise);
    activityServer.listen(activitySocketPath, resolvePromise);
  });
  const command = { version: 1, operation: "update", task: activityTask };
  assert.equal(await sendActivityHelperCommand(command, { socketPath: activitySocketPath }), "OK updated");
  assert.deepEqual(receivedActivityCommand, command);
} finally {
  await new Promise((resolvePromise) => activityServer.close(resolvePromise));
  await rm(activitySocketDirectory, { recursive: true, force: true });
}

const bridgeSource = await readFile(
  new URL("../ios/notifications/DSHNotifierBridge.m", import.meta.url),
  "utf8",
);
assert.match(bridgeSource, /dispatch_async\(queue/);
assert.match(bridgeSource, /actionWithLaunchURL:callblock:/);
assert.match(bridgeSource, /observer:addBulletin:forFeed:/);
assert.match(bridgeSource, /observer:removeBulletin:/);
assert.match(bridgeSource, /setPublisherBulletinID:/);
assert.match(bridgeSource, /setClearable:/);
assert.match(bridgeSource, /dsh-notifier-/);
assert.match(bridgeSource, /responseForAction:/);
assert.match(bridgeSource, /posix_spawn/);
assert.match(bridgeSource, /\/var\/jb\/usr\/bin\/uiopen/);
assert.match(bridgeSource, /method_setImplementation/);
assert.match(bridgeSource, /if \(handled\) return nil/);
assert.match(bridgeSource, /DSHRemoveBulletin\(bulletin\)/);
assert.match(bridgeSource, /setSupplementaryActionsByLayout:/);
assert.match(bridgeSource, /setAuthenticationRequired:/);
assert.match(bridgeSource, /DSHActionSocketPath/);
assert.match(bridgeSource, /DSHDismissPayload/);

const notifierPluginSource = await readFile(
  new URL("../ios/notifications/dsh-ios-notifier.mjs", import.meta.url),
  "utf8",
);
assert.match(notifierPluginSource, /createServer\(\{ allowHalfOpen: true \}/);

const activityBridgeSource = await readFile(
  new URL("../ios/activity/DSHActivityBridge.m", import.meta.url),
  "utf8",
);
assert.match(activityBridgeSource, /posix_spawn/);
assert.match(activityBridgeSource, /DSHActivityOp/);
assert.match(activityBridgeSource, /launchd worker broker listening/);
assert.match(activityBridgeSource, /activity\.id/);
assert.match(activityBridgeSource, /agentCount/);
assert.match(activityBridgeSource, /goalDetail/);
assert.match(activityBridgeSource, /assistantDetail/);
assert.match(activityBridgeSource, /toolDetail/);
assert.match(activityBridgeSource, /finishedAtMilliseconds/);
assert.match(activityBridgeSource, /activity\.task/);
assert.match(activityBridgeSource, /replacing activity .* for new task/);
assert.match(activityBridgeSource, /int main\(int argc/);
assert.doesNotMatch(activityBridgeSource, /__attribute__\(\(constructor\)\)/);
assert.doesNotMatch(activityBridgeSource, /ActivityKit\.framework/);
assert.doesNotMatch(activityBridgeSource, /_TtC11ActivityKit19ActivityInputClient/);

const activityWorkerSource = await readFile(
  new URL("../ios/activity/DSHActivityWorker.m", import.meta.url),
  "utf8",
);
assert.match(activityWorkerSource, /_TtC11ActivityKit19ActivityInputClient/);
assert.match(activityWorkerSource, /requestActivityWithRequest:error:/);
assert.match(activityWorkerSource, /updateActivityWithIdentifier:payload:/);
assert.match(activityWorkerSource, /endActivityWithIdentifier:payload:options:/);
assert.match(activityWorkerSource, /processIdentifier/);
assert.match(activityWorkerSource, /DSHActivityTargetBundleIdentifier = @"ai\.deepseek\.dsh"/);
assert.match(activityWorkerSource, /NSDate\.distantPast/);
assert.match(activityWorkerSource, /ActivityKit's 4 KB limit/);

const bridgeBuildScript = await readFile(
  new URL("../scripts/build-ios-notifier.sh", import.meta.url),
  "utf8",
);
assert.match(bridgeBuildScript, /-arch arm64e/);
assert.match(bridgeBuildScript, /DSHActivityHost/);
assert.match(bridgeBuildScript, /DSHActivityBridge\.m/);
assert.match(bridgeBuildScript, /DSHActivityWorker\.m/);
assert.match(bridgeBuildScript, /DSHActivityOp/);
assert.match(bridgeBuildScript, /DSHActivityD/);
assert.match(bridgeBuildScript, /DSHLiveActivity/);
assert.match(bridgeBuildScript, /_NSExtensionMain/);
assert.match(bridgeBuildScript, /actool/);
assert.match(bridgeBuildScript, /favicon\.svg/);

const activityLaunchdPlist = await readFile(
  new URL("../launchd/ai.deepseek.dsh-activity.plist", import.meta.url),
  "utf8",
);
assert.match(activityLaunchdPlist, /<string>ai\.deepseek\.dsh-activity<\/string>/);
assert.match(activityLaunchdPlist, /<string>mobile<\/string>/);
assert.match(activityLaunchdPlist, /<string>\/var\/jb\/usr\/local\/lib\/dsh\/ios\/DSHActivityD<\/string>/);
assert.match(activityLaunchdPlist, /<key>KeepAlive<\/key>\s*<true\/>/);

const iconHostInfo = await readFile(
  new URL("../ios/activity/DSHActivityHost-Info.plist", import.meta.url),
  "utf8",
);
assert.match(iconHostInfo, /<string>ai\.deepseek\.dsh<\/string>/);
assert.match(iconHostInfo, /<string>hidden<\/string>/);
assert.match(iconHostInfo, /NSSupportsLiveActivities/);

const activityHostSource = await readFile(
  new URL("../ios/activity/DSHActivityHost.swift", import.meta.url),
  "utf8",
);
assert.match(activityHostSource, /Darwin\.exit\(0\)/);
assert.match(activityHostSource, /application\.open\(url/);
assert.match(activityHostSource, /launchOptions\?\[\.url\]/);
assert.match(activityHostSource, /open url: URL/);
assert.match(activityHostSource, /userActivity\.webpageURL/);
assert.match(activityHostSource, /host == "127\.0\.0\.1" \|\| host == "localhost"/);
assert.doesNotMatch(activityHostSource, /activity\.sock|Activity<|import ActivityKit/);

const liveActivitySource = await readFile(
  new URL("../ios/activity/DSHLiveActivityWidget.swift", import.meta.url),
  "utf8",
);
assert.match(liveActivitySource, /ActivityConfiguration/);
assert.match(liveActivitySource, /style: \.timer/);
assert.match(liveActivitySource, /DSHAgentDotsRing/);
assert.match(liveActivitySource, /state\.agentCount/);
assert.match(liveActivitySource, /ForEach\(0\.\.<visibleAgentCount/);
assert.match(liveActivitySource, /Text\(startedAt, style: \.timer\)/);
assert.match(liveActivitySource, /multilineTextAlignment\(\.center\)/);
assert.match(liveActivitySource, /frame\(width: 40, height: 40, alignment: \.center\)/);
assert.doesNotMatch(liveActivitySource, /Text\("\\\(state\.step\)"\)/);
assert.match(liveActivitySource, /Text\("GOAL"\)/);
assert.match(liveActivitySource, /Text\("ASSISTANT"\)/);
assert.match(liveActivitySource, /Text\("TOOL"\)/);
assert.match(liveActivitySource, /context\.state\.goalDetail/);
assert.match(liveActivitySource, /context\.state\.assistantDetail/);
assert.match(liveActivitySource, /context\.state\.toolDetail/);
assert.match(liveActivitySource, /finishedAtMilliseconds/);
assert.doesNotMatch(liveActivitySource, /fixedSize\(|firstTextBaseline/);
assert.doesNotMatch(liveActivitySource, /agentCount, 1\)\)A/);
assert.doesNotMatch(liveActivitySource, /ProgressView/);

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
    activeGoalDetail,
    activeTurn,
    activityCommand,
    navigationUrl,
    newestRunningTask,
    renderApprovalNotification,
    renderGoalNotification,
    renderSessionNotification,
    removeUnfinishedLiveTasks,
    resolveConfig,
    runNotifier,
    toolActionDetail,
    updateLiveGoal,
    updateLiveTasks,
  } = await import(`${pluginPath.href}?test=${Date.now()}`);
  const config = resolveConfig();
  assert.equal(config.browserBaseUrl, "http://127.0.0.1:3080/");
  assert.equal(config.notifyFailure, true);
  assert.equal(config.actionableApprovals, true);
  assert.equal(config.liveActivity, true);
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
  assert.deepEqual(renderApprovalNotification({
    sessionId: "session-detailed",
    approvalId: "approval-1",
    toolName: "Bash",
    reason: "需要部署到手机",
  }, config, detailedSession, { allow: allowToken, reject: rejectToken }), {
    id: "approval-approval-1",
    title: "DSH 等待确认",
    body: "会话：通知链路测试\n状态：任务暂停，等待操作授权\n权限：允许“Bash”执行当前请求一次\n原因：需要部署到手机\n操作：展开通知后选择“允许一次”或“拒绝”",
    actions: [
      { title: "拒绝", token: rejectToken, authenticationRequired: false },
      { title: "允许一次", token: allowToken, authenticationRequired: true },
    ],
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
  assert.equal(
    toolActionDetail("bash", JSON.stringify({
      command: "sleep 45",
      description: "等待四十五秒完成通知测试",
    })),
    "等待四十五秒完成通知测试",
  );
  assert.equal(
    toolActionDetail("read", JSON.stringify({ file_path: "/private/var/root/config.json" })),
    "文件读取：/private/var/root/config.json",
  );
  assert.equal(
    toolActionDetail("bash", JSON.stringify({ command: "token=private-value curl example.test" })),
    "工具“Bash”正在运行",
  );

  const activeGoalEvent = {
    type: "goal/change",
    data: {
      kind: "goal/change",
      version: 1,
      operation: "create",
      goal: { objective: "交付完整的 Live Activity", phase: "active" },
    },
  };
  assert.equal(activeGoalDetail({ events: [activeGoalEvent] }), "交付完整的 Live Activity");
  assert.equal(activeGoalDetail({ events: [activeGoalEvent, {
    type: "goal/change",
    data: {
      kind: "goal/change",
      version: 1,
      operation: "pause",
      goal: { objective: "交付完整的 Live Activity", phase: "paused" },
    },
  }] }), "");
  assert.equal(activeGoalDetail({ events: [activeGoalEvent, {
    type: "goal/change",
    data: { kind: "goal/change", version: 1, operation: "clear" },
  }] }), "");

  const runningTasks = new Map();
  const firstRunningSession = {
    id: "running-a",
    header: {},
    events: [
      { type: "session/title", data: { title: "较早任务" } },
      activeGoalEvent,
    ],
  };
  updateLiveTasks(runningTasks, firstRunningSession, {
    type: "turn/start", time: 1_700_000_000_000, data: { turn: 1 },
  });
  updateLiveTasks(runningTasks, firstRunningSession, {
    type: "step/start", data: { turn: 1, step: 2 },
  });
  updateLiveTasks(runningTasks, firstRunningSession, {
    type: "todo/write",
    data: {
      todos: [
        { content: "完成通知按钮", status: "completed" },
        { content: "验证 Live Activity", status: "in_progress" },
      ],
    },
  });
  assert.deepEqual(activityCommand(runningTasks), {
    version: 1,
    operation: "update",
    task: {
      sessionID: "running-a",
      title: "较早任务",
      phase: "正在执行计划",
      detail: "验证 Live Activity",
      goalDetail: "交付完整的 Live Activity",
      assistantDetail: "等待 Assistant 回复",
      toolDetail: "任务计划 · 验证 Live Activity",
      startedAtMilliseconds: 1_700_000_000_000,
      finishedAtMilliseconds: 0,
      step: 2,
      agentCount: 1,
      completedItems: 1,
      totalItems: 2,
      waitingForUser: false,
    },
  });

  const secondRunningSession = {
    id: "running-b",
    header: {},
    events: [{ type: "session/title", data: { title: "最后启动任务" } }],
  };
  updateLiveTasks(runningTasks, secondRunningSession, {
    type: "turn/start", time: 1_700_000_001_000, data: { turn: 4 },
  });
  assert.equal(newestRunningTask(runningTasks).sessionID, "running-b");
  assert.equal(updateLiveGoal(runningTasks, secondRunningSession, {
    operation: "create",
    goal: { objective: "验证目标实时变化", phase: "active" },
  }), true);
  assert.equal(activityCommand(runningTasks).task.goalDetail, "验证目标实时变化");
  assert.equal(updateLiveGoal(runningTasks, secondRunningSession, {
    operation: "pause",
    goal: { objective: "验证目标实时变化", phase: "paused" },
  }), true);
  assert.equal(activityCommand(runningTasks).task.goalDetail, "");
  const bashCall = {
    type: "tool/call",
    data: {
      turn: 4,
      callId: "call-live-action",
      name: "bash",
      arguments: JSON.stringify({
        command: "sleep 45",
        description: "等待四十五秒完成通知测试",
      }),
    },
  };
  secondRunningSession.events.push(bashCall);
  updateLiveTasks(runningTasks, secondRunningSession, bashCall);
  assert.equal(activityCommand(runningTasks).task.phase, "正在执行 Bash");
  assert.equal(activityCommand(runningTasks).task.detail, "等待四十五秒完成通知测试");
  assert.equal(
    activityCommand(runningTasks).task.toolDetail,
    "Bash · 等待四十五秒完成通知测试",
  );
  updateLiveTasks(runningTasks, secondRunningSession, {
    type: "assistant/chunk",
    data: { turn: 4, text: "正在流式输出" },
  });
  assert.equal(activityCommand(runningTasks).task.phase, "正在执行 Bash");
  assert.equal(activityCommand(runningTasks).task.detail, "等待四十五秒完成通知测试");
  updateLiveTasks(runningTasks, secondRunningSession, {
    type: "approval/asked",
    data: {
      toolName: "Bash",
      callId: "call-live-action",
      reason: "需要安装权限",
    },
  });
  assert.equal(activityCommand(runningTasks).task.phase, "等待操作授权");
  assert.equal(activityCommand(runningTasks).task.detail, "等待四十五秒完成通知测试");
  assert.equal(activityCommand(runningTasks).task.waitingForUser, true);
  updateLiveTasks(runningTasks, secondRunningSession, {
    type: "approval/decided", data: { outcome: "allowed-once" },
  });
  updateLiveTasks(runningTasks, secondRunningSession, {
    type: "assistant/message",
    data: {
      turn: 4,
      message: { content: [{ type: "text", text: "权限已确认，继续等待测试完成。" }] },
    },
  });
  assert.equal(activityCommand(runningTasks).task.phase, "继续执行");
  assert.equal(activityCommand(runningTasks).task.detail, "等待四十五秒完成通知测试");
  assert.equal(
    activityCommand(runningTasks).task.assistantDetail,
    "权限已确认，继续等待测试完成。",
  );
  const childRunningSession = {
    id: "running-b-child",
    header: { origin: "subagent", parentSession: "running-b" },
    events: [],
  };
  updateLiveTasks(runningTasks, childRunningSession, {
    type: "turn/start", data: { turn: 1 },
  });
  assert.equal(activityCommand(runningTasks).task.agentCount, 2);
  const nestedRunningSession = {
    id: "running-b-grandchild",
    header: { origin: "subagent", parentSession: "running-b-child" },
    events: [],
  };
  updateLiveTasks(runningTasks, nestedRunningSession, {
    type: "turn/start", data: { turn: 1 },
  });
  assert.equal(activityCommand(runningTasks).task.agentCount, 3);
  updateLiveTasks(runningTasks, childRunningSession, {
    type: "step/start", data: { turn: 1, step: 2 },
  });
  assert.equal(activityCommand(runningTasks).task.agentCount, 3);
  updateLiveTasks(runningTasks, secondRunningSession, {
    type: "turn/end", time: 1_700_000_006_000,
    data: { turn: 4, reason: { kind: "completed" } },
  });
  assert.equal(newestRunningTask(runningTasks).sessionID, "running-a");
  updateLiveTasks(runningTasks, firstRunningSession, {
    type: "turn/end", time: 1_700_000_010_000,
    data: { turn: 1, reason: { kind: "completed" } },
  });
  const finishedActivity = activityCommand(runningTasks);
  assert.equal(finishedActivity.operation, "update");
  assert.equal(finishedActivity.task.phase, "已完成");
  assert.equal(finishedActivity.task.finishedAtMilliseconds, 1_700_000_010_000);
  assert.equal(finishedActivity.task.goalDetail, "交付完整的 Live Activity");
  assert.equal(finishedActivity.task.assistantDetail, "回复已完成，点击查看完整结果");

  const nextSession = {
    id: "running-c",
    header: {},
    events: [{ type: "session/title", data: { title: "后续任务" } }],
  };
  updateLiveTasks(runningTasks, nextSession, {
    type: "turn/start", time: 1_700_000_020_000, data: { turn: 1 },
  });
  assert.equal(activityCommand(runningTasks).task.sessionID, "running-c");
  assert.equal(activityCommand(runningTasks).task.finishedAtMilliseconds, 0);

  const interruptedTasks = new Map();
  const interruptedSession = {
    id: "interrupted-live",
    header: {},
    events: [{ type: "session/title", data: { title: "异常中断任务" } }],
  };
  updateLiveTasks(interruptedTasks, interruptedSession, {
    type: "turn/start", time: 1_700_000_030_000, data: { turn: 1 },
  });
  assert.equal(removeUnfinishedLiveTasks(interruptedTasks, "other-session"), 0);
  assert.equal(removeUnfinishedLiveTasks(interruptedTasks, interruptedSession.id), 1);
  assert.deepEqual(activityCommand(interruptedTasks), { version: 1, operation: "end" });

  updateLiveTasks(interruptedTasks, interruptedSession, {
    type: "turn/start", time: 1_700_000_040_000, data: { turn: 2 },
  });
  updateLiveTasks(interruptedTasks, interruptedSession, {
    type: "turn/end", time: 1_700_000_045_000,
    data: { turn: 2, reason: { kind: "completed" } },
  });
  assert.equal(removeUnfinishedLiveTasks(interruptedTasks, interruptedSession.id), 0);
  assert.equal(activityCommand(interruptedTasks).task.finishedAtMilliseconds, 1_700_000_045_000);

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
  await runNotifier(ctx, config, {
    id: "approval-a1",
    title: "授权",
    body: "请选择",
    actions: [{ title: "允许一次", token: allowToken, authenticationRequired: true }],
  }, rootSession);
  assert.equal(request.argv[request.argv.indexOf("--id") + 1], "approval-a1");
  assert.deepEqual(
    JSON.parse(request.argv[request.argv.indexOf("--actions-json") + 1]),
    [{ title: "允许一次", token: allowToken, authenticationRequired: true }],
  );

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
