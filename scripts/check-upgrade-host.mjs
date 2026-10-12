#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { UpgradeHost, compareBaseline } from "./upgrade-host.mjs";

const [target, ...args] = process.argv.slice(2);
let save, compare;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--save") save = args[++index];
  else if (args[index] === "--compare") compare = args[++index];
  else throw new Error("usage: check-upgrade-host.mjs mac|iphone [--save path] [--compare path]");
}
if (!["mac", "iphone"].includes(target) || args.at(-1)?.startsWith("--")) throw new Error("usage: check-upgrade-host.mjs mac|iphone [--save path] [--compare path]");
let host;
try {
  host = await UpgradeHost.connect(target);
  const health = await host.health();
  if (health.running) throw new Error(`${health.running} session(s) are running; wait before deployment`);
  if (health.catalogFailures !== 0) throw new Error("Model catalog is incomplete; inspect Provider state");
  if (compare) {
    const baseline = JSON.parse(await readFile(resolve(compare), "utf8"));
    if (baseline.target !== target) throw new Error("Baseline belongs to another host");
    compareBaseline(baseline, health);
  }
  if (save) {
    const path = resolve(save);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schema: 1, target, capturedAt: new Date().toISOString(), ...health }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  console.log(JSON.stringify({ target, status: "passed", sessionCount: health.sessionIds.length, running: health.running,
    oldSessionVersion: health.oldSessionVersion, providerCount: health.providerCount, baselineCompared: Boolean(compare) }));
} catch (error) {
  console.error(`${target}: ${error.message}`);
  process.exitCode = 1;
} finally { host?.close(); }
