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
  completeTitle: "DSH 目标已完成",
  blockedTitle: "DSH 目标被阻塞",
  confirmTitle: "DSH 等待确认",
  notifyComplete: true,
  notifyBlocked: true,
  notifyConfirm: true,
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
  notifyComplete: z.boolean().default(DEFAULTS.notifyComplete),
  notifyBlocked: z.boolean().default(DEFAULTS.notifyBlocked),
  notifyConfirm: z.boolean().default(DEFAULTS.notifyConfirm),
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
    notifyComplete: booleanValue(config.notifyComplete, DEFAULTS.notifyComplete, "notifyComplete"),
    notifyBlocked: booleanValue(config.notifyBlocked, DEFAULTS.notifyBlocked, "notifyBlocked"),
    notifyConfirm: booleanValue(config.notifyConfirm, DEFAULTS.notifyConfirm, "notifyConfirm"),
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

function renderGoalNotification(change, config) {
  if (!config.enabled) return undefined;
  if (change.operation === "complete") {
    if (!config.notifyComplete) return undefined;
    const objective = change.goal?.objective ?? `Goal ${change.ref.id}`;
    return { title: config.completeTitle, body: truncate(objective, config.maxBodyChars) };
  }
  if (change.operation === "block") {
    if (!config.notifyBlocked) return undefined;
    const objective = change.goal?.objective ?? `Goal ${change.ref.id}`;
    const reason = change.goal?.blockedReason?.message;
    const body = reason === undefined ? objective : `${objective}\n\n阻塞原因：${reason}`;
    return { title: config.blockedTitle, body: truncate(body, config.maxBodyChars) };
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

function renderSessionNotification(event, config) {
  if (!config.enabled || !config.notifyConfirm) return undefined;
  if (event.type === "approval/asked") {
    const detail = typeof event.data.reason === "string" && event.data.reason.trim() !== ""
      ? event.data.reason.trim()
      : `工具 ${event.data.toolName} 正在等待确认`;
    return { title: config.confirmTitle, body: truncate(detail, config.maxBodyChars) };
  }
  if (event.type === "tool/call" && event.data.name === "ask_user_question") {
    const detail = firstQuestion(event.data.arguments) ?? "会话正在等待你的回答";
    return { title: config.confirmTitle, body: truncate(detail, config.maxBodyChars) };
  }
  if (event.type === "tool/call" && event.data.name === "exit_plan_mode") {
    return { title: config.confirmTitle, body: "计划已准备好，等待你确认" };
  }
  return undefined;
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
    enqueue(change.operation, agent.session, renderGoalNotification(change, resolved), `goal "${change.ref.id}"`);
  }, { global: true });
  const stopSessionEvents = ctx.on("session/event", (session, event) => {
    enqueue("confirm", session, renderSessionNotification(event, resolved), `event "${event.type}"`);
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
  inject,
  name,
  navigationUrl,
  renderGoalNotification,
  renderSessionNotification,
  resolveConfig,
  runNotifier,
  subagentMode,
  truncate,
};
