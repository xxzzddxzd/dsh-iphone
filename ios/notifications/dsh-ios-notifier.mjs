import z from "@deepseek-ai/schemastery";

const name = "ios-notifier";
const inject = ["goals", "subprocess"];

const HELPER_PATH = "/var/jb/usr/local/bin/dsh-notify";
const LAUNCHER_PATH = "/var/jb/usr/bin/bash";
const HELPER_CWD = "/var/root";
const DEFAULT_HELPER_TIMEOUT_MS = 15_000;

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

function notificationBody(session, lines, config) {
  const content = [];
  if (session !== undefined) content.push(`会话：${sessionTitle(session) ?? "未命名会话"}`);
  content.push(...lines.filter((line) => typeof line === "string" && line.trim() !== ""));
  return truncate(content.join("\n"), config.maxBodyChars);
}

function assistantSummary(session, turn) {
  if (session === undefined) return undefined;
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event.type !== "assistant/message" || event.data?.turn !== turn) continue;
    const blocks = event.data.message?.content ?? event.data.content;
    if (!Array.isArray(blocks)) continue;
    const text = compactText(blocks
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .filter((value) => typeof value === "string")
      .join("\n"));
    if (text !== "") return text;
  }
  return undefined;
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
    const detail = typeof event.data.reason === "string" && event.data.reason.trim() !== ""
      ? event.data.reason.trim()
      : "该操作需要你授权后才能继续";
    return {
      title: config.confirmTitle,
      body: notificationBody(session, [
        "状态：等待工具授权",
        `工具：${event.data.toolName}`,
        `原因：${detail}`,
      ], config),
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

async function runNotifier(ctx, config, notification, session) {
  const helperArgs = [
    "--bundle-id",
    config.bundleId,
    "--url",
    navigationUrl(session, config),
    "--timeout",
    String(DEFAULT_HELPER_TIMEOUT_MS),
  ];
  if (config.soundId !== undefined) helperArgs.push("--sound-id", String(config.soundId));
  helperArgs.push(notification.title, notification.body);
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

function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  let stopped = false;
  let queue = Promise.resolve();
  const pendingGoalTurns = new Map();

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

  const stopGoals = ctx.on("goal/changed", ({ agent, change }) => {
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

  ctx.effect(() => () => {
    stopped = true;
    stopGoals();
    stopSessionEvents();
    return queue;
  }, "ios-notifier lifecycle");
}

export {
  Config,
  DEFAULTS,
  apply,
  activeTurn,
  inject,
  name,
  navigationUrl,
  renderGoalNotification,
  renderSessionNotification,
  resolveConfig,
  runNotifier,
  assistantSummary,
  notificationBody,
  sessionEventNotificationKind,
  sessionTitle,
  subagentMode,
  truncate,
};
