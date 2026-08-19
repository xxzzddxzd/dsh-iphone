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
    "",
    "Options:",
    `  --bundle-id <id>   Existing app bundle id used for the notification icon (default: ${DEFAULT_BUNDLE_ID})`,
    "  --url <url>        HTTP(S) address opened by the notification's default action",
    "  --sound-id <id>    Optional integer iOS system sound id",
    "  --timeout <ms>     Notification bridge timeout in milliseconds (default: 15000)",
    "  --verbose          Reserved for compatibility",
    "  -h, --help         Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  let bundleId = DEFAULT_BUNDLE_ID;
  let launchUrl;
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
    if (arg === "--bundle-id" || arg === "--url" || arg === "--sound-id" || arg === "--timeout") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      index += 1;
      if (arg === "--bundle-id") bundleId = value;
      else if (arg === "--url") launchUrl = validateLaunchUrl(value);
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

  if (positional.length !== 2) throw new UsageError("expected exactly <title> and <body>");
  const [title, body] = positional;
  if (title.length === 0) throw new UsageError("title must not be empty");
  if (body.length === 0) throw new UsageError("body must not be empty");
  if (bundleId.length === 0) throw new UsageError("bundle id must not be empty");

  return { help: false, title, body, bundleId, launchUrl, soundId, timeoutMs, verbose };
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
  return {
    version: 1,
    title: options.title,
    body: options.body,
    bundleId: options.bundleId,
    ...(options.launchUrl === undefined ? {} : { url: options.launchUrl }),
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
  validateLaunchUrl,
};
