#!/var/jb/usr/local/lib/nodejs22/node

import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOCKET_PATH = "/var/mobile/Library/DSHNotifier/activity.sock";
const DEFAULT_TIMEOUT_MS = 5_000;
const OPERATIONS = new Set(["status", "end", "shutdown"]);

class UsageError extends Error {}

function usage() {
  return [
    "Usage:",
    "  dsh-activity [--timeout <ms>] status|end|shutdown",
    "  dsh-activity [--timeout <ms>] update <task-json>",
  ].join("\n");
}

function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") return { help: true };
    if (argument === "--timeout") {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new UsageError("--timeout requires a positive integer");
      }
      index += 1;
      timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new UsageError("--timeout requires a positive integer");
      }
      continue;
    }
    if (argument.startsWith("-")) throw new UsageError(`unknown option: ${argument}`);
    positional.push(argument);
  }

  const operation = positional[0];
  if (OPERATIONS.has(operation) && positional.length === 1) {
    return { help: false, timeoutMs, command: { version: 1, operation } };
  }
  if (operation === "update" && positional.length === 2) {
    let task;
    try {
      task = JSON.parse(positional[1]);
    } catch {
      throw new UsageError("update task must be valid JSON");
    }
    if (task === null || typeof task !== "object" || Array.isArray(task)) {
      throw new UsageError("update task must be a JSON object");
    }
    return { help: false, timeoutMs, command: { version: 1, operation, task } };
  }
  throw new UsageError("expected status, end, shutdown, or update <task-json>");
}

function sendActivityCommand(command, options = {}) {
  const connect = options.connect ?? createConnection;
  const socketPath = options.socketPath ?? SOCKET_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, rejectPromise) => {
    let response = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolvePromise(response.trim());
      else rejectPromise(error);
    };
    const socket = connect({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.end(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 4_096) {
        socket.destroy();
        finish(new Error("activity host returned an oversized response"));
      }
    });
    socket.once("end", () => {
      const reply = response.trim();
      if (reply === "OK" || reply.startsWith("OK ")) finish();
      else finish(new Error(`activity host rejected the request${reply === "" ? "" : `: ${reply}`}`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      finish(new Error(`activity host timed out after ${timeoutMs} ms`));
    });
    socket.once("error", (error) => finish(new Error(`could not contact activity host: ${error.message}`)));
  });
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-activity: ${message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const response = await sendActivityCommand(options.command, { timeoutMs: options.timeoutMs });
    process.stdout.write(`${response}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-activity: ${message}\n`);
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
  DEFAULT_TIMEOUT_MS,
  SOCKET_PATH,
  UsageError,
  isMainModule,
  main,
  parseArgs,
  sendActivityCommand,
  usage,
};
