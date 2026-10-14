#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { componentUpdateReport, combineUpdateReports } from "./provider-components.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function releaseReport(pins, lock, registry, refs) {
  const version = registry["dist-tags"]?.latest;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid official latest version");
  const metadata = registry.versions?.[version];
  if (metadata?.name !== "@deepseek-ai/dsh" || metadata.version !== version || !metadata.dist?.integrity) throw new Error("Incomplete official npm release");
  const tag = `refs/tags/dsh-v${version}`;
  const parsed = new Map(refs.trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/).reverse()));
  const commit = parsed.get(`${tag}^{}`) ?? parsed.get(tag);
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Official release tag is not available yet");
  const unchanged = version === pins.DSH_VERSION;
  if (unchanged && (commit !== pins.DSH_UPSTREAM_COMMIT || metadata.dist.integrity !== pins.DSH_NPM_INTEGRITY)) throw new Error("The current official release no longer matches its pinned commit/integrity");
  const current = lock.packages["node_modules/@deepseek-ai/dsh"];
  const oldDependencies = current.dependencies ?? {};
  const newDependencies = metadata.dependencies ?? {};
  const dependencyChanges = [...new Set([...Object.keys(oldDependencies), ...Object.keys(newDependencies)])]
    .sort().filter(name => oldDependencies[name] !== newDependencies[name])
    .map(name => ({ name, before: oldDependencies[name] ?? null, after: newDependencies[name] ?? null }));
  if (unchanged && dependencyChanges.length) throw new Error("Current npm dependency metadata differs from the pinned lock; audit the discrepancy");
  return { checkedAt: new Date().toISOString(), status: unchanged ? "current" : "update-available",
    installed: pins.DSH_VERSION, latest: version, next: registry["dist-tags"].next ?? null,
    commit, integrity: metadata.dist.integrity, publishedAt: registry.time?.[version] ?? null,
    nodeEngine: metadata.engines?.node ?? null, previousNodeEngine: current.engines?.node ?? null,
    dependencyChanges,
    cutoff: "Confirm publication times for the complete dependency closure; CLI publication time alone is insufficient.",
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--save")) throw new Error("usage: check-dsh-update.mjs [--save path]");
  const pins = Object.fromEntries((await readFile(resolve(repository, "versions.env"), "utf8"))
    .split("\n").filter(line => line && !line.startsWith("#")).map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const lock = JSON.parse(await readFile(resolve(repository, "dsh-runtime/package-lock.json"), "utf8"));
  const response = await fetch("https://registry.npmjs.org/@deepseek-ai%2fdsh", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Official npm registry returned HTTP ${response.status}`);
  const registry = await response.json();
  const latest = registry["dist-tags"]?.latest;
  if (typeof latest !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) throw new Error("Invalid official latest version");
  const tag = `refs/tags/dsh-v${latest}`;
  const { stdout } = await promisify(execFile)("git", ["ls-remote", "--tags",
    "https://github.com/deepseek-ai/deepseek-harness.git", tag, `${tag}^{}`],
    { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const report = combineUpdateReports(releaseReport(pins, lock, registry, stdout), await componentUpdateReport(pins));
  if (args.length) {
    const output = resolve(args[1]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Release check failed: ${error.message}`); process.exitCode = 1; });
}
