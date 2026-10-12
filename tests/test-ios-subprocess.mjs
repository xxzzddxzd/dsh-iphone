#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? new URL("../build/dsh-runtime", import.meta.url).pathname);
const { D: createProcessInspector } = await import(pathToFileURL(resolve(root,
  "node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js")));
let started = "Mon Oct 12 11:00:00 2026";
const signals = [];
const boundary = {
  exec(file, args) {
    assert.equal(file, "/bin/ps");
    if (args[0] === "-axo") {
      assert.deepEqual(args, ["-axo", "pid=,ppid=,lstart="]);
      return `10 1 Mon Oct 12 10:00:00 2026\n20 10 ${started}\n`;
    }
    assert.deepEqual(args, ["-o", "tpgid=", "-p", "10"]);
    return "20\n";
  },
  kill(pid, signal) { signals.push([pid, signal]); },
};
const inspector = createProcessInspector("ios", "arm64", boundary);
const snapshot = inspector.snapshot();
assert.equal(snapshot.complete, true);
assert.deepEqual(snapshot.tree(10).map(row => row.pid), [20, 10]);
assert.equal(inspector.foregroundPgid(10), 20);
const child = snapshot.tree(10)[0];
inspector.signalProcess(child, "SIGTERM");
assert.deepEqual(signals, [[20, "SIGTERM"]]);
started = "Mon Oct 12 12:00:00 2026";
assert.equal(inspector.isAlive(child), false, "PID reuse must invalidate the old process identity");
inspector.signalProcess(child, "SIGKILL");
assert.equal(signals.length, 1, "a reused PID must not receive the previous owner's signal");
assert.throws(() => createProcessInspector("aix"), /unsupported/);
const terminalBash = await import(pathToFileURL(resolve(root,
  "node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js")));
let backend;
const registry = { terminals: { registerBackend(value) { backend = value; } } };
terminalBash.apply(registry, terminalBash.Config({}));
assert.equal(backend.config.shellPath, process.platform === "ios" ? "/var/jb/bin/bash" : "/bin/bash");
assert.deepEqual(backend.config.shellArgs, ["--noprofile", "--norc", "-i"]);
terminalBash.apply(registry, terminalBash.Config({ shellPath: "/explicit/bash" }));
assert.equal(backend.config.shellPath, "/explicit/bash", "explicit shell selection must take precedence");
console.log("iOS BSD process inspection, PID identity fencing and Bash path passed");
