import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import z from "@deepseek-ai/schemastery";

const name = "ios-notifier";
const inject = ["goals", "subprocess"];

const HELPER_PATH = "/var/jb/usr/local/bin/dsh-notify";
const LAUNCHER_PATH = "/var/jb/usr/bin/bash";
const UIOPEN_PATH = "/var/jb/usr/bin/uiopen";
const ACTIVITY_SOCKET_PATH = "/var/mobile/Library/DSHNotifier/activity.sock";
const HELPER_CWD = "/var/root";
const DEFAULT_HELPER_TIMEOUT_MS = 15_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;
const ACTIVITY_SOCKET_TIMEOUT_MS = 5_000;

const DEFAULTS = Object.freeze({
  enabled: true,
  browserBaseUrl: "http://127.0.0.1:3080/",
  bundleId: "ai.deepseek.dsh",
  completeTitle: "DSH 回复已完成",
  blockedTitle: "DSH 会话被阻塞",
  confirmTitle: "DSH 等待确认",
  errorTitle: "DSH 运行失败",
  maxTokensTitle: "DSH 输出已截断",
  interruptedTitle: "DSH 会话异常中断",
  stoppedTitle: "DSH 会话已停止",
  notifyComplete: true,
  notifyBlocked: true,
  notifyConfirm: true,
  notifyFailure: true,
  liveActivity: true,
  soundId: undefined,
  maxBodyChars: 800,
  logSuccess: true,
});

const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  browserBaseUrl: z.string().default(DEFAULTS.browserBaseUrl),
  bundleId: z.string().default(DEFAULTS.bundleId),
  completeTitle: z.string().default(DEFAULTS.completeTitle),
  blockedTitle: z.string().default(DEFAULTS.blockedTitle),
  confirmTitle: z.string().default(DEFAULTS.confirmTitle),
  errorTitle: z.string().default(DEFAULTS.errorTitle),
  maxTokensTitle: z.string().default(DEFAULTS.maxTokensTitle),
  interruptedTitle: z.string().default(DEFAULTS.interruptedTitle),
  stoppedTitle: z.string().default(DEFAULTS.stoppedTitle),
  notifyComplete: z.boolean().default(DEFAULTS.notifyComplete),
  notifyBlocked: z.boolean().default(DEFAULTS.notifyBlocked),
  notifyConfirm: z.boolean().default(DEFAULTS.notifyConfirm),
  notifyFailure: z.boolean().default(DEFAULTS.notifyFailure),
  liveActivity: z.boolean().default(DEFAULTS.liveActivity),
  soundId: z.number(),
  maxBodyChars: z.number().default(DEFAULTS.maxBodyChars),
  logSuccess: z.boolean().default(DEFAULTS.logSuccess),
});

function nonEmptyString(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`ios-notifier: ${field} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`ios-notifier: ${field} must be a boolean`);
  return value;
}

function positiveInteger(value, fallback, field) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`ios-notifier: ${field} must be a positive safe integer`);
  }
  return value;
}

function browserBaseUrl(value) {
  const input = nonEmptyString(value, DEFAULTS.browserBaseUrl, "browserBaseUrl");
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError("ios-notifier: browserBaseUrl must be an absolute HTTP(S) URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("ios-notifier: browserBaseUrl must be an absolute HTTP(S) URL without credentials");
  }
  return parsed.href;
}

function resolveConfig(config = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("ios-notifier: config must be an object");
  }
  const soundId = config.soundId;
  if (soundId !== undefined && !Number.isSafeInteger(soundId)) {
    throw new TypeError("ios-notifier: soundId must be a safe integer");
  }
  return Object.freeze({
    enabled: booleanValue(config.enabled, DEFAULTS.enabled, "enabled"),
    browserBaseUrl: browserBaseUrl(config.browserBaseUrl),
    bundleId: nonEmptyString(config.bundleId, DEFAULTS.bundleId, "bundleId"),
    completeTitle: nonEmptyString(config.completeTitle, DEFAULTS.completeTitle, "completeTitle"),
    blockedTitle: nonEmptyString(config.blockedTitle, DEFAULTS.blockedTitle, "blockedTitle"),
    confirmTitle: nonEmptyString(config.confirmTitle, DEFAULTS.confirmTitle, "confirmTitle"),
    errorTitle: nonEmptyString(config.errorTitle, DEFAULTS.errorTitle, "errorTitle"),
    maxTokensTitle: nonEmptyString(config.maxTokensTitle, DEFAULTS.maxTokensTitle, "maxTokensTitle"),
    interruptedTitle: nonEmptyString(
      config.interruptedTitle,
      DEFAULTS.interruptedTitle,
      "interruptedTitle",
    ),
    stoppedTitle: nonEmptyString(config.stoppedTitle, DEFAULTS.stoppedTitle, "stoppedTitle"),
    notifyComplete: booleanValue(config.notifyComplete, DEFAULTS.notifyComplete, "notifyComplete"),
    notifyBlocked: booleanValue(config.notifyBlocked, DEFAULTS.notifyBlocked, "notifyBlocked"),
    notifyConfirm: booleanValue(config.notifyConfirm, DEFAULTS.notifyConfirm, "notifyConfirm"),
    notifyFailure: booleanValue(config.notifyFailure, DEFAULTS.notifyFailure, "notifyFailure"),
    liveActivity: booleanValue(config.liveActivity, DEFAULTS.liveActivity, "liveActivity"),
    soundId,
    maxBodyChars: positiveInteger(config.maxBodyChars, DEFAULTS.maxBodyChars, "maxBodyChars"),
    logSuccess: booleanValue(config.logSuccess, DEFAULTS.logSuccess, "logSuccess"),
  });
}

function truncate(value, maxChars) {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function sessionTitle(session) {
  if (session === undefined) return undefined;
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type !== "session/title") continue;
    const title = event.data?.title;
    if (typeof title === "string" && title.trim() !== "") return title.trim();
  }
  return undefined;
}

function compactText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function normalizeLiveMarkdown(value) {
  if (typeof value !== "string") return "";
  const withoutLinkTargets = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\r\n?/gu, "\n");
  const lines = [];
  let insideFence = false;
  for (const rawLine of withoutLinkTargets.split("\n")) {
    if (/^\s*```/u.test(rawLine)) {
      insideFence = !insideFence;
      continue;
    }
    let line = rawLine
      .replace(/^\s{0,3}#{1,6}\s+/u, "")
      .replace(/^\s*>\s?/u, "")
      .replace(/^\s*[-+*]\s+/u, "• ")
      .replace(/^\s*(\d+)[.)]\s+/u, "$1. ")
      .replace(/\s+$/u, "");
    if (!insideFence) line = line.replace(/[\t ]{2,}/gu, " ");
    lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function notificationBody(session, lines, config) {
  const content = [];
  if (session !== undefined) content.push(`会话：${sessionTitle(session) ?? "未命名会话"}`);
  content.push(...lines.filter((line) => typeof line === "string" && line.trim() !== ""));
  return truncate(content.join("\n"), config.maxBodyChars);
}

function assistantMessageDetail(event) {
  if (event?.type !== "assistant/message") return undefined;
  const blocks = event.data?.message?.content ?? event.data?.content;
  if (!Array.isArray(blocks)) return undefined;
  const text = compactText(blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .filter((value) => typeof value === "string")
    .join("\n"));
  return text === "" ? undefined : text;
}

function reasoningProgressText(value, requireMarkdownHeading = false) {
  const rawText = compactText(value);
  const headings = [...rawText.matchAll(/\*\*([^*]+)\*\*/gu)];
  if (requireMarkdownHeading && headings.length === 0) return undefined;
  const text = compactText(headings.at(-1)?.[1] ?? rawText.replace(/\*\*/gu, ""));
  return text === "" ? undefined : text;
}

function assistantProgressDetail(event) {
  if (event?.type !== "assistant/message") return undefined;
  const blocks = event.data?.message?.content ?? event.data?.content;
  if (!Array.isArray(blocks)) return undefined;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "text" && block?.type !== "reasoning") continue;
    const text = block.type === "reasoning"
      ? reasoningProgressText(block.text)
      : normalizeLiveMarkdown(block.text);
    if (text === undefined) continue;
    if (text === "") continue;
    return block.type === "reasoning"
      ? { phase: "正在思考", detail: `思考 · ${text}` }
      : { phase: "正在说明进展", detail: text };
  }
  return undefined;
}

function assistantChunkProgressDetail(event) {
  if (event?.type !== "assistant/chunk") return undefined;
  const chunk = event.data?.chunk;
  if (chunk?.type !== "reasoning-delta") return undefined;
  // Codex emits complete **reasoning headings** as individual chunks. Updating
  // only those headings makes Think visible without sending one native Live
  // Activity request for every token from providers that stream plain prose.
  const text = reasoningProgressText(chunk.text, true);
  return text === undefined ? undefined : { phase: "正在思考", detail: `思考 · ${text}` };
}

function assistantSummary(session, turn) {
  if (session === undefined) return undefined;
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type !== "assistant/message" || event.data?.turn !== turn) continue;
    const detail = assistantMessageDetail(event);
    if (detail !== undefined) return detail;
  }
  return undefined;
}

function activeGoalDetail(session) {
  if (session === undefined || !Array.isArray(session.events)) return "";
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type !== "goal/change") continue;
    if (event.data?.operation === "clear") return "";
    return event.data?.goal?.phase === "active"
      ? compactText(event.data.goal.objective)
      : "";
  }
  return "";
}

function renderGoalNotification(change, config, session) {
  if (!config.enabled) return undefined;
  if (change.operation === "complete") {
    if (!config.notifyComplete) return undefined;
    const objective = change.goal?.objective ?? `Goal ${change.ref.id}`;
    return {
      title: config.completeTitle,
      body: notificationBody(session, ["状态：目标已完成", `目标：${objective}`], config),
    };
  }
  if (change.operation === "block") {
    if (!config.notifyBlocked) return undefined;
    const objective = change.goal?.objective ?? `Goal ${change.ref.id}`;
    const reason = change.goal?.blockedReason?.message;
    return {
      title: config.blockedTitle,
      body: notificationBody(session, [
        "状态：目标被阻塞",
        `目标：${objective}`,
        reason === undefined ? "原因：未提供，点击查看会话" : `原因：${reason}`,
      ], config),
    };
  }
  return undefined;
}

function firstQuestion(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson);
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.questions)) return undefined;
    const question = parsed.questions[0];
    if (question === null || typeof question !== "object") return undefined;
    if (typeof question.question === "string" && question.question.trim() !== "") return question.question.trim();
    if (typeof question.header === "string" && question.header.trim() !== "") return question.header.trim();
  } catch {
    // A malformed tool-call payload is handled by the tool executor; the
    // notification keeps a generic body instead of becoming a second error.
  }
  return undefined;
}

function firstPlanLine(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson);
    const plan = compactText(parsed?.plan);
    if (plan === "") return undefined;
    return plan.replace(/^#+\s*/u, "");
  } catch {
    return undefined;
  }
}

function renderSessionNotification(event, config, session) {
  if (!config.enabled) return undefined;
  if (event.type === "turn/end") {
    const { reason, turn } = event.data;
    const summary = assistantSummary(session, turn);
    if (reason.kind === "completed") {
      if (!config.notifyComplete) return undefined;
      return {
        title: config.completeTitle,
        body: notificationBody(session, [
          "状态：回复已完成",
          summary === undefined ? "说明：点击查看完整回复" : `回复摘要：${summary}`,
        ], config),
      };
    }
    if (reason.kind === "blocked") {
      if (!config.notifyBlocked) return undefined;
      return {
        title: config.blockedTitle,
        body: notificationBody(session, [
          "状态：本轮处理被阻塞",
          summary === undefined ? "说明：点击查看阻塞原因" : `最后说明：${summary}`,
        ], config),
      };
    }
    if (reason.kind === "error") {
      if (!config.notifyFailure) return undefined;
      const code = compactText(reason.error?.code);
      const message = compactText(reason.error?.message) || "未知错误";
      return {
        title: config.errorTitle,
        body: notificationBody(session, [
          "状态：运行失败",
          `错误：${code === "" ? "" : `[${code}] `}${message}`,
        ], config),
      };
    }
    if (reason.kind === "max-tokens") {
      if (!config.notifyFailure) return undefined;
      return {
        title: config.maxTokensTitle,
        body: notificationBody(session, [
          "状态：输出达到 token 上限，回复可能不完整",
          summary === undefined ? "说明：点击查看并继续会话" : `最后内容：${summary}`,
        ], config),
      };
    }
    if (reason.kind === "interrupted") {
      if (!config.notifyFailure) return undefined;
      return {
        title: config.interruptedTitle,
        body: notificationBody(session, [
          "状态：上一轮未正常结束",
          "说明：DSH 恢复会话时发现异常中断，请点击查看",
        ], config),
      };
    }
    if (reason.kind === "aborted" && reason.reason?.kind === "hook") {
      if (!config.notifyFailure) return undefined;
      return {
        title: config.stoppedTitle,
        body: notificationBody(session, [
          "状态：会话被系统停止",
          `原因：${compactText(reason.reason.reason) || "未提供"}`,
        ], config),
      };
    }
    return undefined;
  }
  if (!config.notifyConfirm) return undefined;
  if (event.type === "approval/asked") {
    return {
      title: approvalNotificationTitle(session),
      body: approvalNotificationBody(event.data, session, config),
    };
  }
  if (event.type === "tool/call" && event.data.name === "ask_user_question") {
    const detail = firstQuestion(event.data.arguments) ?? "会话正在等待你的回答";
    return {
      title: config.confirmTitle,
      body: notificationBody(session, ["状态：等待你回答", `问题：${detail}`], config),
    };
  }
  if (event.type === "tool/call" && event.data.name === "exit_plan_mode") {
    const summary = firstPlanLine(event.data.arguments);
    return {
      title: config.confirmTitle,
      body: notificationBody(session, [
        "状态：计划已准备好，等待你确认",
        summary === undefined ? undefined : `计划摘要：${summary}`,
      ], config),
    };
  }
  return undefined;
}

function sessionEventNotificationKind(event) {
  if (event.type === "turn/end") {
    if (event.data.reason.kind === "completed") return "complete";
    if (event.data.reason.kind === "blocked") return "block";
    if (event.data.reason.kind === "max-tokens") return "max-tokens";
    if (event.data.reason.kind === "interrupted") return "interrupted";
    if (event.data.reason.kind === "aborted") return "stopped";
    if (event.data.reason.kind === "error") return "error";
  }
  return "confirm";
}

function activeTurn(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type === "turn/end") return undefined;
    if (event.type === "turn/start") return event.data.turn;
  }
  return undefined;
}

function turnNotificationKey(session, turn) {
  return `${session.id}:${turn}`;
}

function subagentMode(session) {
  const seedLength = Number.isSafeInteger(session.header?.seedLength) ? session.header.seedLength : 0;
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type !== "subagent/descriptor" || event.seq < seedLength) continue;
    const mode = event.data?.mode;
    if (mode === "one-shot" || mode === "continuable") return mode;
  }
  return undefined;
}

function navigationUrl(session, config) {
  const url = new URL(config.browserBaseUrl);
  url.searchParams.set("session", session.id);
  const parentSessionId = session.header?.origin === "subagent"
    ? session.header.parentSession
    : undefined;
  const mode = parentSessionId === undefined ? undefined : subagentMode(session);
  if (parentSessionId !== undefined && mode !== undefined) {
    url.searchParams.set("parent", parentSessionId);
    url.searchParams.set("mode", mode);
  }
  return url.href;
}

function renderExecutionError(message, stdout, stderr) {
  const detail = [stdout, stderr]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .join("\n")
    .trim();
  return detail === "" ? message : `${message}: ${detail}`;
}

async function runNotifierHelper(ctx, helperArgs) {
  // iOS denies direct posix_spawn of the script from Node (EPERM). DSH can
  // launch the signed rootless Bash binary, which then execs the exact argv.
  // The command string is constant; all variable values remain positional args.
  const argv = [LAUNCHER_PATH, "-c", "exec \"$@\"", "dsh-notify", HELPER_PATH, ...helperArgs];

  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new Error(`notification helper timed out after ${DEFAULT_HELPER_TIMEOUT_MS + 2_000} ms`));
  }, DEFAULT_HELPER_TIMEOUT_MS + 2_000);
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: HELPER_CWD,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 1_000,
      signal: timeout.signal,
      env: { TERM: "dumb", NO_COLOR: "1" },
    });
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
    if (timeout.signal.aborted) throw timeout.signal.reason;
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      throw new Error(renderExecutionError(
        `notification helper exited with code ${String(outcome.exitCode)} signal ${String(outcome.signal)}`,
        stdout,
        stderr,
      ));
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function runNotifier(ctx, config, notification, session) {
  const helperArgs = [
    "--bundle-id",
    config.bundleId,
    "--url",
    navigationUrl(session, config),
    "--timeout",
    String(DEFAULT_HELPER_TIMEOUT_MS),
  ];
  if (notification.id !== undefined) helperArgs.push("--id", notification.id);
  if (notification.actions !== undefined) {
    helperArgs.push("--actions-json", JSON.stringify(notification.actions));
  }
  if (config.soundId !== undefined) helperArgs.push("--sound-id", String(config.soundId));
  helperArgs.push(notification.title, notification.body);
  return runNotifierHelper(ctx, helperArgs);
}

function approvalNotificationTitle(session) {
  return `${sessionTitle(session) ?? "未命名会话"} · 请求确认`;
}

function approvalCommand(session, callId) {
  if (!Array.isArray(session?.events)) return undefined;
  const call = findToolCall(session, callId);
  if (call === undefined) return undefined;
  const args = parseToolArguments(call.data?.arguments);
  const command = args.command ?? args.cmd;
  if (typeof command !== "string") return undefined;
  const normalized = command.replace(/\r\n?/gu, "\n").trim();
  return normalized === "" ? undefined : normalized;
}

function approvalNotificationBody(approval, session, config) {
  const command = approvalCommand(session, approval.callId);
  const detail = command === undefined
    ? `工具：${toolDisplayName(approval.toolName)}`
    : `指令：${command}`;
  return truncate(detail, config.maxBodyChars);
}

let nextTaskStartOrder = 0;
const agentRegistries = new WeakMap();

function agentRegistry(tasks) {
  let registry = agentRegistries.get(tasks);
  if (registry === undefined) {
    registry = {
      parentSessionIDs: new Map(),
      runningSessionIDs: new Set(),
    };
    agentRegistries.set(tasks, registry);
  }
  return registry;
}

function rootSessionForAgent(registry, sessionId) {
  let current = sessionId;
  const visited = new Set();
  while (registry.parentSessionIDs.has(current)) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    current = registry.parentSessionIDs.get(current);
  }
  return current;
}

function agentSessionsForRoot(tasks, rootSessionId) {
  const registry = agentRegistry(tasks);
  const known = new Set();
  const active = new Set();
  for (const sessionId of registry.parentSessionIDs.keys()) {
    if (rootSessionForAgent(registry, sessionId) === rootSessionId) known.add(sessionId);
  }
  for (const sessionId of registry.runningSessionIDs) {
    if (rootSessionForAgent(registry, sessionId) === rootSessionId) active.add(sessionId);
  }
  return { known, active };
}

function taskKey(sessionId, turn) {
  return `${sessionId}:${turn}`;
}

function newestRunningTask(tasks) {
  let selected;
  for (const task of tasks.values()) {
    if (task.finishedAtMilliseconds > 0) continue;
    if (selected === undefined || task.startOrder > selected.startOrder) selected = task;
  }
  return selected;
}

function newestFinishedTask(tasks) {
  let selected;
  for (const task of tasks.values()) {
    if (!(task.finishedAtMilliseconds > 0)) continue;
    if (selected === undefined || task.finishedAtMilliseconds > selected.finishedAtMilliseconds) {
      selected = task;
    }
  }
  return selected;
}

function removeUnfinishedLiveTasks(tasks, sessionId) {
  let removed = 0;
  for (const [key, task] of tasks) {
    if (task.sessionID !== sessionId || task.finishedAtMilliseconds > 0) continue;
    tasks.delete(key);
    removed += 1;
  }
  return removed;
}

function latestSessionTask(tasks, sessionId, turn) {
  if (Number.isSafeInteger(turn)) {
    const task = tasks.get(taskKey(sessionId, turn));
    return task?.finishedAtMilliseconds > 0 ? undefined : task;
  }
  let selected;
  for (const task of tasks.values()) {
    if (task.sessionID !== sessionId || task.finishedAtMilliseconds > 0) continue;
    if (selected === undefined || task.startOrder > selected.startOrder) selected = task;
  }
  return selected;
}

function taskForAgentSession(tasks, sessionId) {
  const direct = latestSessionTask(tasks, sessionId);
  if (direct !== undefined) return direct;
  const rootSessionId = rootSessionForAgent(agentRegistry(tasks), sessionId);
  if (rootSessionId !== undefined && rootSessionId !== sessionId) {
    const rootTask = latestSessionTask(tasks, rootSessionId);
    if (rootTask !== undefined) return rootTask;
  }
  for (const task of tasks.values()) {
    if (task.knownAgentSessionIDs?.has(sessionId)) return task;
  }
  return undefined;
}

function updateLiveGoal(tasks, session, change) {
  // A Live Activity represents the root session. A child agent can own a
  // different goal, so letting it overwrite the root goal would be misleading.
  if (session.header?.origin === "subagent") return false;
  const task = latestSessionTask(tasks, session.id);
  if (task === undefined) return false;
  const goalDetail = change?.goal?.phase === "active"
    ? compactText(change.goal.objective)
    : "";
  if (task.goalDetail === goalDetail) return false;
  task.goalDetail = goalDetail;
  return true;
}

function registerSubagentSession(tasks, session) {
  const parentSessionId = session.header?.parentSession;
  if (typeof parentSessionId !== "string") return undefined;
  agentRegistry(tasks).parentSessionIDs.set(session.id, parentSessionId);
  const task = taskForAgentSession(tasks, parentSessionId);
  if (task === undefined) return undefined;
  const sessions = agentSessionsForRoot(tasks, task.sessionID);
  for (const sessionId of sessions.known) task.knownAgentSessionIDs.add(sessionId);
  for (const sessionId of sessions.active) task.activeAgentSessionIDs.add(sessionId);
  return task;
}

function setSubagentSessionRunning(tasks, session, running) {
  if (session.header?.origin !== "subagent") return false;
  const registry = agentRegistry(tasks);
  if (running) {
    registry.runningSessionIDs.add(session.id);
    const previousTask = taskForAgentSession(tasks, session.header?.parentSession);
    const previousSize = previousTask?.activeAgentSessionIDs.size;
    const task = registerSubagentSession(tasks, session);
    if (task === undefined) return false;
    return task !== previousTask || task.activeAgentSessionIDs.size !== previousSize;
  }
  registry.runningSessionIDs.delete(session.id);
  let changed = false;
  for (const task of tasks.values()) {
    if (task.activeAgentSessionIDs?.delete(session.id)) changed = true;
  }
  return changed;
}

function toolDisplayName(name) {
  const labels = {
    exec_command: "命令行",
    Bash: "Bash",
    bash: "Bash",
    apply_patch: "文件修改",
    edit: "文件修改",
    read: "文件读取",
    write: "文件写入",
    web: "网络查询",
    web_search: "网络搜索",
    web_fetch: "网页读取",
    glob: "文件搜索",
    grep: "内容搜索",
    todo_write: "进度更新",
    request_user_input: "用户问答",
  };
  return labels[name] ?? name;
}

function parseToolArguments(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compactArgument(value) {
  return typeof value === "string" ? compactText(value) : "";
}

function toolActionDetail(name, rawArguments) {
  const args = parseToolArguments(rawArguments);
  const description = compactArgument(args.description);
  if (description !== "") return truncate(description, 160);

  const label = toolDisplayName(name);
  const filePath = compactArgument(args.file_path ?? args.path);
  if (filePath !== "") return truncate(`${label}：${filePath}`, 160);

  const query = compactArgument(args.query ?? args.q);
  if (query !== "") return truncate(`${label}：${query}`, 160);

  const url = compactArgument(args.url);
  if (url !== "") return truncate(`${label}：${url}`, 160);

  const pattern = compactArgument(args.pattern);
  if (pattern !== "") return truncate(`${label}：${pattern}`, 160);

  // Shell commands can contain credentials or other private values. DSH's
  // Bash tool normally supplies a user-facing description; without one, keep
  // the lock-screen text useful without copying the raw command verbatim.
  return `工具“${label}”正在运行`;
}

function toolProgressDetail(name, rawArguments) {
  const label = toolDisplayName(name);
  const action = toolActionDetail(name, rawArguments);
  if (action === `工具“${label}”正在运行`) return `${label} · 正在运行`;
  if (action.startsWith(`${label}：`)) return `${label} · ${action.slice(label.length + 1)}`;
  return action;
}

function toolStatusDetail(name, status) {
  return `${toolDisplayName(name)} · ${status}`;
}

function findToolCall(session, callId) {
  if (typeof callId !== "string" || !Array.isArray(session?.events)) return undefined;
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type === "tool/call" && event.data?.callId === callId) return event;
  }
  return undefined;
}

function terminalActivityPresentation(reason) {
  switch (reason?.kind) {
    case "completed":
      return { phase: "已完成", fallback: "回复已完成，点击查看完整结果" };
    case "blocked":
      return { phase: "已阻塞", fallback: "任务被阻塞，点击查看原因并继续处理" };
    case "error": {
      const code = compactText(reason.error?.code);
      const message = compactText(reason.error?.message) || "未知错误";
      return {
        phase: "运行失败",
        fallback: `运行失败：${code === "" ? "" : `[${code}] `}${message}`,
      };
    }
    case "max-tokens":
      return { phase: "已截断", fallback: "输出达到 token 上限，点击查看并继续会话" };
    case "interrupted":
      return { phase: "已中断", fallback: "任务未正常结束，点击查看会话状态" };
    case "aborted":
      if (reason.reason?.kind !== "hook") return undefined;
      return {
        phase: "已停止",
        fallback: `会话被系统停止：${compactText(reason.reason.reason) || "未提供原因"}`,
      };
    default:
      return undefined;
  }
}

function updateLiveTasks(tasks, session, event) {
  if (session.header?.origin === "subagent") {
    // Session events preserve cumulative lineage for nested delegation, but
    // only the authoritative agent/status event may change the active set.
    // This prevents an idle child from being revived by a later title or
    // maintenance event.
    registerSubagentSession(tasks, session);
    return newestRunningTask(tasks);
  }
  if (event.type === "turn/start") {
    const key = taskKey(session.id, event.data.turn);
    if (!tasks.has(key)) {
      const agentSessions = agentSessionsForRoot(tasks, session.id);
      // A new root turn supersedes the retained terminal card. The native
      // broker observes finishedAtMilliseconds returning to zero and replaces
      // the old Activity ID before rendering this task. Carry the agent
      // lineage and active set from the task-independent registry because a
      // continuable child can remain running across root turns without
      // emitting another status transition, even if another root replaced the
      // previous terminal card in between.
      for (const [finishedKey, task] of tasks) {
        if (task.finishedAtMilliseconds > 0) tasks.delete(finishedKey);
      }
      const eventTime = Number(event.time);
      tasks.set(key, {
        sessionID: session.id,
        turn: event.data.turn,
        startOrder: ++nextTaskStartOrder,
        startedAtMilliseconds: Number.isFinite(eventTime) && eventTime > 0 ? Math.trunc(eventTime) : Date.now(),
        title: sessionTitle(session) ?? "未命名会话",
        phase: "正在开始",
        detail: "正在理解请求并规划下一步",
        goalDetail: activeGoalDetail(session),
        assistantDetail: "",
        toolDetail: "尚未调用 Tool",
        step: 0,
        finishedAtMilliseconds: 0,
        completedItems: 0,
        totalItems: 0,
        waitingForUser: false,
        hasMeaningfulAction: false,
        terminalReasonKind: undefined,
        knownAgentSessionIDs: agentSessions.known,
        activeAgentSessionIDs: agentSessions.active,
      });
    }
    return newestRunningTask(tasks);
  }
  if (event.type === "turn/end") {
    const key = taskKey(session.id, event.data.turn);
    const task = tasks.get(key);
    const presentation = terminalActivityPresentation(event.data.reason);
    if (task === undefined || presentation === undefined) {
      tasks.delete(key);
      return newestRunningTask(tasks) ?? newestFinishedTask(tasks);
    }
    for (const [finishedKey, candidate] of tasks) {
      if (finishedKey !== key && candidate.finishedAtMilliseconds > 0) tasks.delete(finishedKey);
    }
    const eventTime = Number(event.time);
    const now = Number.isFinite(eventTime) && eventTime > 0 ? Math.trunc(eventTime) : Date.now();
    const summary = assistantSummary(session, event.data.turn);
    task.phase = presentation.phase;
    task.terminalReasonKind = event.data.reason.kind;
    task.finishedAtMilliseconds = Math.max(task.startedAtMilliseconds, now);
    task.waitingForUser = false;
    if (summary !== undefined) {
      task.assistantDetail = summary;
    } else if (event.data.reason.kind !== "completed"
      || task.assistantDetail === "") {
      task.assistantDetail = presentation.fallback;
    }
    task.detail = event.data.reason.kind === "completed"
      ? task.assistantDetail
      : presentation.fallback;
    return newestRunningTask(tasks) ?? newestFinishedTask(tasks);
  }
  if (event.type === "session/title") {
    const title = compactText(event.data?.title);
    if (title !== "") {
      for (const task of tasks.values()) {
        if (task.sessionID === session.id) task.title = title;
      }
    }
    return newestRunningTask(tasks);
  }

  const task = latestSessionTask(tasks, session.id, event.data?.turn);
  if (task === undefined) return newestRunningTask(tasks);
  switch (event.type) {
    case "step/start": {
      const resumedAfterUserInput = task.waitingForUser;
      task.step = Math.max(0, event.data.step);
      task.waitingForUser = false;
      if (!task.hasMeaningfulAction) {
        task.phase = "思考中";
        task.detail = "正在理解请求并规划下一步";
      } else if (resumedAfterUserInput) {
        task.phase = "继续执行";
      }
      break;
    }
    case "assistant/chunk": {
      const progress = assistantChunkProgressDetail(event);
      if (progress !== undefined && !task.waitingForUser) {
        task.phase = progress.phase;
        task.detail = progress.detail;
        task.hasMeaningfulAction = true;
      } else if (!task.waitingForUser && !task.hasMeaningfulAction) {
        task.phase = "思考中";
        task.detail = "正在理解请求并规划下一步";
      }
      break;
    }
    case "assistant/message": {
      const assistantDetail = assistantMessageDetail(event);
      if (assistantDetail !== undefined) task.assistantDetail = assistantDetail;
      const progress = assistantProgressDetail(event);
      if (progress !== undefined && !task.waitingForUser) {
        task.phase = progress.phase;
        task.detail = progress.detail;
        task.hasMeaningfulAction = true;
      }
      break;
    }
    case "tool/call":
      if (event.data.name === "ask_user_question") {
        task.phase = "等待你的回答";
        task.detail = firstQuestion(event.data.arguments) ?? "会话提出了一个问题";
        task.toolDetail = "用户问答 · 等待回答";
        task.waitingForUser = true;
      } else if (event.data.name === "exit_plan_mode") {
        task.phase = "等待计划确认";
        task.detail = firstPlanLine(event.data.arguments) ?? "计划已经准备完成";
        task.toolDetail = "计划确认 · 等待确认";
        task.waitingForUser = true;
      } else {
        const toolName = toolDisplayName(event.data.name);
        task.phase = `正在执行 ${toolName}`;
        task.detail = toolProgressDetail(event.data.name, event.data.arguments);
        task.toolDetail = toolStatusDetail(event.data.name, "运行中");
        task.waitingForUser = false;
      }
      task.hasMeaningfulAction = true;
      break;
    case "approval/asked": {
      const toolName = toolDisplayName(event.data.toolName);
      const call = findToolCall(session, event.data.callId);
      task.phase = "等待操作授权";
      task.detail = call === undefined
        ? compactText(event.data.reason) || `“${toolName}”需要一次性权限`
        : toolProgressDetail(call.data.name, call.data.arguments);
      task.toolDetail = call === undefined
        ? `${toolName} · 等待授权`
        : toolStatusDetail(call.data.name, "等待授权");
      task.waitingForUser = true;
      task.hasMeaningfulAction = true;
      break;
    }
    case "approval/decided":
      task.phase = event.data.outcome === "allowed-once" ? "继续执行" : "授权未通过";
      task.waitingForUser = false;
      break;
    case "tool/result": {
      const call = findToolCall(session, event.data.message?.source?.callId ?? event.data.callId);
      const toolName = toolDisplayName(call?.data?.name ?? "工具");
      task.phase = event.data.error === undefined ? "正在处理结果" : "工具执行失败";
      const liveAction = call === undefined
        ? toolName
        : toolDisplayName(call.data.name);
      task.toolDetail = event.data.error === undefined
        ? `${liveAction} · 已完成`
        : `${liveAction} · 执行失败`;
      task.waitingForUser = false;
      task.hasMeaningfulAction = true;
      break;
    }
    case "todo/write": {
      const todos = Array.isArray(event.data.todos) ? event.data.todos : [];
      task.totalItems = todos.length;
      task.completedItems = todos.filter((item) => item?.status === "completed").length;
      const current = todos.find((item) => item?.status === "in_progress");
      if (current !== undefined) {
        task.phase = "正在执行计划";
        task.detail = compactText(current.content) || task.detail;
        task.hasMeaningfulAction = true;
      }
      break;
    }
    case "step/end":
      task.waitingForUser = false;
      if (!task.hasMeaningfulAction) {
        task.phase = "思考中";
        task.detail = "正在理解请求并规划下一步";
      }
      break;
    default:
      break;
  }
  return newestRunningTask(tasks);
}

function liveProgressDetail(task) {
  if (task.waitingForUser) return task.detail;
  if (task.finishedAtMilliseconds > 0
      && task.terminalReasonKind !== "completed"
      && task.terminalReasonKind !== "max-tokens") {
    return task.detail;
  }
  return task.assistantDetail || task.detail;
}

function activityCommand(tasks) {
  const task = newestRunningTask(tasks) ?? newestFinishedTask(tasks);
  if (task === undefined) return { version: 1, operation: "end" };
  return {
    version: 1,
    operation: "update",
    task: {
      sessionID: task.sessionID,
      title: truncate(task.title, 100),
      phase: truncate(task.phase, 40),
      detail: truncate(normalizeLiveMarkdown(liveProgressDetail(task)), 160),
      goalDetail: truncate(task.goalDetail, 160),
      assistantDetail: truncate(task.assistantDetail, 320),
      toolDetail: truncate(task.toolDetail, 160),
      startedAtMilliseconds: task.startedAtMilliseconds,
      finishedAtMilliseconds: task.finishedAtMilliseconds,
      step: task.step,
      agentCount: task.finishedAtMilliseconds > 0
        ? 0
        : 1 + (task.activeAgentSessionIDs?.size ?? 0),
      completedItems: task.completedItems,
      totalItems: task.totalItems,
      waitingForUser: task.waitingForUser,
    },
  };
}

function socketError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sendSocketJson(socketPath, payload, timeoutMs = DEFAULT_SOCKET_TIMEOUT_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    let response = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolvePromise(response.trim());
      else rejectPromise(error);
    };
    const socket = createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 4_096) {
        socket.destroy();
        finish(socketError("Unix socket returned an oversized response", "OVERSIZED_RESPONSE"));
      }
    });
    socket.once("end", () => {
      const reply = response.trim();
      if (reply === "OK" || reply.startsWith("OK ")) finish();
      else finish(socketError(`Unix socket request rejected${reply === "" ? "" : `: ${reply}`}`, "HOST_REJECTED"));
    });
    socket.once("timeout", () => {
      socket.destroy();
      finish(socketError(`Unix socket timed out after ${timeoutMs} ms`, "ETIMEDOUT"));
    });
    socket.once("error", (error) => finish(socketError(error.message, error.code)));
  });
}

async function sendActivityCommand(_ctx, _bundleId, command) {
  return sendSocketJson(ACTIVITY_SOCKET_PATH, command, ACTIVITY_SOCKET_TIMEOUT_MS);
}

function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  let stopped = false;
  let queue = Promise.resolve();
  let activityQueue = Promise.resolve();
  let lastActivitySignature;
  const pendingGoalTurns = new Map();
  const liveTasks = new Map();
  const nativeFeaturesAvailable = existsSync(HELPER_PATH) && existsSync(UIOPEN_PATH);

  const enqueue = (kind, session, notification, detail) => {
    if (notification === undefined || stopped) return;
    queue = queue.then(async () => {
      if (stopped) return;
      try {
        await runNotifier(ctx, resolved, notification, session);
        if (resolved.logSuccess) {
          ctx.logger.info(`ios-notifier: sent ${kind} notification for ${detail} on session "${session.id}"`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`ios-notifier: failed ${kind} notification for ${detail}: ${message}`);
      }
    });
  };

  const syncLiveActivity = () => {
    if (!resolved.liveActivity || !nativeFeaturesAvailable || stopped) return;
    const command = activityCommand(liveTasks);
    const signature = JSON.stringify(command);
    if (signature === lastActivitySignature) return;
    lastActivitySignature = signature;
    activityQueue = activityQueue.then(async () => {
      if (stopped) return;
      try {
        await sendActivityCommand(ctx, resolved.bundleId, command);
      } catch (error) {
        ctx.logger.warn(`ios-notifier: Live Activity update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };

  syncLiveActivity();

  const stopGoals = ctx.on("goal/changed", ({ agent, change }) => {
    if (updateLiveGoal(liveTasks, agent.session, change)) syncLiveActivity();
    const notification = renderGoalNotification(change, resolved, agent.session);
    if (notification !== undefined) {
      const turn = activeTurn(agent.session);
      if (turn !== undefined && (change.operation === "complete" || change.operation === "block")) {
        const key = turnNotificationKey(agent.session, turn);
        const previous = pendingGoalTurns.get(key);
        // A blocked goal is more actionable than a completed sibling goal.
        if (previous === undefined || change.operation === "block") {
          pendingGoalTurns.set(key, {
            kind: change.operation,
            notification,
            detail: `goal "${change.ref.id}"`,
          });
        }
        return;
      }
    }
    enqueue(change.operation, agent.session, notification, `goal "${change.ref.id}"`);
  }, { global: true });
  const stopSessionEvents = ctx.on("session/event", (session, event) => {
    updateLiveTasks(liveTasks, session, event);
    syncLiveActivity();
    if (event.type === "turn/end") {
      const key = turnNotificationKey(session, event.data.turn);
      const pendingGoal = pendingGoalTurns.get(key);
      pendingGoalTurns.delete(key);
      const reasonKind = event.data.reason.kind;
      const pendingMatchesOutcome = pendingGoal !== undefined && (
        (pendingGoal.kind === "complete" && reasonKind === "completed")
        || (pendingGoal.kind === "block" && (reasonKind === "completed" || reasonKind === "blocked"))
      );
      if (pendingMatchesOutcome) {
        enqueue(pendingGoal.kind, session, pendingGoal.notification, pendingGoal.detail);
        return;
      }
      // A root turn corresponds to a user-visible reply. Subagent turns can be
      // numerous; their explicit goal and confirmation notifications remain.
      if (session.header?.origin === "subagent") return;
    }
    enqueue(
      sessionEventNotificationKind(event),
      session,
      renderSessionNotification(event, resolved, session),
      `event "${event.type}"`,
    );
  }, { global: true });
  const stopAgentStatus = ctx.on("agent/status", ({ agent, status }) => {
    if (agent.session.header?.origin === "subagent") {
      if (setSubagentSessionRunning(liveTasks, agent.session, status === "running")) {
        syncLiveActivity();
      }
      return;
    }
    if (status !== "idle") return;
    const removed = removeUnfinishedLiveTasks(liveTasks, agent.id);
    if (removed === 0) return;
    if (resolved.logSuccess) {
      ctx.logger.info(
        `ios-notifier: removed ${removed} unfinished Live Activity task(s) for idle session "${agent.id}"`,
      );
    }
    syncLiveActivity();
  }, { global: true });

  ctx.effect(() => async () => {
    stopped = true;
    stopGoals();
    stopSessionEvents();
    stopAgentStatus();
    await Promise.allSettled([
      queue,
      activityQueue,
      resolved.liveActivity && nativeFeaturesAvailable
        ? sendActivityCommand(ctx, resolved.bundleId, { version: 1, operation: "end" })
        : Promise.resolve(),
    ]);
  }, "ios-notifier lifecycle");
}

export {
  Config,
  DEFAULTS,
  ACTIVITY_SOCKET_PATH,
  apply,
  activeGoalDetail,
  activeTurn,
  activityCommand,
  inject,
  name,
  navigationUrl,
  liveProgressDetail,
  newestRunningTask,
  normalizeLiveMarkdown,
  removeUnfinishedLiveTasks,
  renderGoalNotification,
  renderSessionNotification,
  resolveConfig,
  runNotifier,
  sendActivityCommand,
  sendSocketJson,
  assistantSummary,
  notificationBody,
  sessionEventNotificationKind,
  sessionTitle,
  subagentMode,
  setSubagentSessionRunning,
  toolActionDetail,
  truncate,
  updateLiveGoal,
  updateLiveTasks,
};
