#!/var/jb/usr/local/lib/nodejs22/node

import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SOCKET_PATH = "/var/mobile/Library/DSHNotifier/notify.sock";
const DEFAULT_BUNDLE_ID = "ai.deepseek.dsh";
const DEFAULT_TIMEOUT_MS = 15_000;

class UsageError extends Error {}

function usage() {
  return [
    "Usage: dsh-notify [options] <title> <body>",
    "       dsh-notify --dismiss-id <id> [--timeout <ms>]",
    "",
    "Options:",
    `  --bundle-id <id>   Existing app bundle id used for the notification icon (default: ${DEFAULT_BUNDLE_ID})`,
    "  --id <id>          Stable notification id used for replacement and withdrawal",
    "  --url <url>        HTTP(S) address opened by the notification's default action",
    "  --actions-json <j> Supplementary action array for an actionable notification",
    "  --dismiss-id <id>  Withdraw a previously published stable notification",
    "  --sound-id <id>    Optional integer iOS system sound id",
    "  --timeout <ms>     Notification bridge timeout in milliseconds (default: 15000)",
    "  --verbose          Reserved for compatibility",
    "  -h, --help         Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  let bundleId = DEFAULT_BUNDLE_ID;
  let notificationId;
  let launchUrl;
  let actions;
  let dismissId;
  let soundId;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let verbose = false;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--bundle-id" || arg === "--id" || arg === "--url"
      || arg === "--actions-json" || arg === "--dismiss-id"
      || arg === "--sound-id" || arg === "--timeout") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      index += 1;
      if (arg === "--bundle-id") bundleId = value;
      else if (arg === "--id") notificationId = validateNotificationId(value, "--id");
      else if (arg === "--url") launchUrl = validateLaunchUrl(value);
      else if (arg === "--actions-json") actions = validateActionsJson(value);
      else if (arg === "--dismiss-id") dismissId = validateNotificationId(value, "--dismiss-id");
      else if (arg === "--sound-id") {
        if (!/^-?\d+$/.test(value)) throw new UsageError("--sound-id must be an integer");
        soundId = Number(value);
        if (!Number.isSafeInteger(soundId)) {
          throw new UsageError("--sound-id is outside the safe integer range");
        }
      } else {
        if (!/^\d+$/.test(value)) throw new UsageError("--timeout must be a positive integer");
        timeoutMs = Number(value);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw new UsageError("--timeout must be a positive integer");
        }
      }
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
    positional.push(arg);
  }

  if (dismissId !== undefined) {
    if (positional.length !== 0 || notificationId !== undefined || launchUrl !== undefined
      || actions !== undefined || soundId !== undefined) {
      throw new UsageError("--dismiss-id cannot be combined with publish options or positional arguments");
    }
    return { help: false, operation: "dismiss", dismissId, timeoutMs, verbose };
  }
  if (positional.length !== 2) throw new UsageError("expected exactly <title> and <body>");
  const [title, body] = positional;
  if (title.length === 0) throw new UsageError("title must not be empty");
  if (body.length === 0) throw new UsageError("body must not be empty");
  if (bundleId.length === 0) throw new UsageError("bundle id must not be empty");

  return {
    help: false,
    operation: "publish",
    title,
    body,
    bundleId,
    notificationId,
    launchUrl,
    actions,
    soundId,
    timeoutMs,
    verbose,
  };
}

function validateNotificationId(value, option = "notification id") {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new UsageError(`${option} must use 1-256 safe identifier characters`);
  }
  return value;
}

function validateActionsJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError("--actions-json must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 4) {
    throw new UsageError("--actions-json must contain 1-4 actions");
  }
  return parsed.map((action, index) => {
    if (action === null || typeof action !== "object" || Array.isArray(action)) {
      throw new UsageError(`action ${index + 1} must be an object`);
    }
    const title = action.title;
    const token = action.token;
    if (typeof title !== "string" || title.length < 1 || title.length > 128) {
      throw new UsageError(`action ${index + 1} has an invalid title`);
    }
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
      throw new UsageError(`action ${index + 1} has an invalid token`);
    }
    if (action.authenticationRequired !== undefined
      && typeof action.authenticationRequired !== "boolean") {
      throw new UsageError(`action ${index + 1} has an invalid authenticationRequired value`);
    }
    return {
      title,
      token,
      authenticationRequired: action.authenticationRequired === true,
    };
  });
}

function validateLaunchUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError("--url must be an absolute HTTP(S) URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") {
    throw new UsageError("--url must be an absolute HTTP(S) URL without credentials");
  }
  return parsed.href;
}

function notificationPayload(options) {
  if (options.operation === "dismiss") {
    return { version: 2, operation: "dismiss", id: options.dismissId };
  }
  return {
    version: 2,
    operation: "publish",
    title: options.title,
    body: options.body,
    bundleId: options.bundleId,
    ...(options.notificationId === undefined ? {} : { id: options.notificationId }),
    ...(options.launchUrl === undefined ? {} : { url: options.launchUrl }),
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    ...(options.soundId === undefined ? {} : { soundId: options.soundId }),
  };
}

function sendNotification(options, transport = {}) {
  const connect = transport.connect ?? createConnection;
  const socketPath = transport.socketPath ?? SOCKET_PATH;
  return new Promise((resolvePromise, rejectPromise) => {
    let response = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const socket = connect({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs);
    socket.once("connect", () => {
      socket.end(`${JSON.stringify(notificationPayload(options))}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => {
      const reply = response.trim();
      if (reply.startsWith("OK ") || reply === "OK") finish();
      else finish(new Error(`notification bridge rejected the request${reply === "" ? "" : `: ${reply}`}`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      finish(new Error(`notification bridge timed out after ${options.timeoutMs} ms`));
    });
    socket.once("error", (error) => {
      finish(new Error(`could not contact notification bridge: ${error.message}`));
    });
  });
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-notify: ${message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    await sendNotification(options);
    process.stdout.write("notification sent\n");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-notify: ${message}\n`);
    return 1;
  }
}

function isMainModule(argvPath, moduleUrl) {
  if (argvPath === undefined) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return resolve(argvPath) === resolve(modulePath);
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

export {
  DEFAULT_BUNDLE_ID,
  DEFAULT_TIMEOUT_MS,
  SOCKET_PATH,
  UsageError,
  isMainModule,
  main,
  notificationPayload,
  parseArgs,
  sendNotification,
  usage,
  validateActionsJson,
  validateLaunchUrl,
  validateNotificationId,
};
