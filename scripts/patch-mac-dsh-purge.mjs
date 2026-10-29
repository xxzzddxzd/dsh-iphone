#!/usr/bin/env node
// Source anchors: YuJunZhiXue/dsh-purge at 0c933dc7d3252698f3f0f9756932dcc88355f532.
// Original source and Apache-2.0 notices: tests/fixtures/dsh-purge-1.1.82/.
import { createHash } from 'node:crypto';
import { readFile, open, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const managedRestartInputs = Object.freeze([
  {
    "relative": "lib/web.js",
    "originalSHA256": "e715a801eb98b176e5e455bada74cb540cee99959ee015dd5ae4155a2070b02c",
    "patchedSHA256": "f19cbcdec01045ffff0d729c22bf83a681c2b4463ef6bfe03d648f4e9ab1541b",
    "anchors": [
      {
        "before": "export function scheduleRestart(request, _ctx, options = {}) {\n",
        "after": "export function scheduleRestart(request, _ctx, options = {}) {\n  if (process.env.DSH_MANAGED_RESTART === \"launchd\") {\n    // [dsh-iphone] launchd owns the next process; never start a detached DSH.\n    setTimeout(() => process.exit(0), 250);\n    return;\n  }\n"
      },
      {
        "before": "export function scheduleCleanupRestart({ request, restartArgv: argv, cleanup = [] } = {}) {\n",
        "after": "export function scheduleCleanupRestart({ request, restartArgv: argv, cleanup = [] } = {}) {\n  if (process.env.DSH_MANAGED_RESTART === \"launchd\") {\n    const error = new Error(\"DSH is managed by launchd. Stop the managed service before uninstalling dsh-purge, then restart the service through launchd.\");\n    error.code = \"DSH_MANAGED_UNINSTALL\";\n    throw error;\n  }\n"
      }
    ]
  },
  {
    "relative": "lib/uninstall.js",
    "originalSHA256": "711877aa432b176c5f382dd7bf08c337fbe3df2e5b9790048ebcb0c7a5084cfb",
    "patchedSHA256": "f37623fcff185dc41ffd62d6200e2bbcc530834dce54520062a760cadacce7b6",
    "anchors": [
      {
        "before": "export async function uninstallPurge(options = {}) {\n",
        "after": "export async function uninstallPurge(options = {}) {\n  if (process.env.DSH_MANAGED_RESTART === \"launchd\") {\n    const error = new Error(\"DSH is managed by launchd. Stop the managed service before uninstalling dsh-purge, then restart the service through launchd.\");\n    error.code = \"DSH_MANAGED_UNINSTALL\";\n    throw error;\n  }\n"
      }
    ]
  }
]);

/** Validate every complete preimage before writing either file. Never loads Purge code. */
export async function patchPurgeManagedRestart(root, { check = false } = {}) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'dsh-purge') throw new Error('Expected a dsh-purge package root');
  const entries = await Promise.all(managedRestartInputs.map(async entry => {
    const path = resolve(root, entry.relative);
    const current = await readFile(path);
    const hash = digest(current);
    if (hash !== entry.originalSHA256 && hash !== entry.patchedSHA256) throw new Error(`Unsupported Purge managed-restart preimage: ${entry.relative}`);
    if (check && hash !== entry.patchedSHA256) throw new Error(`Purge managed-restart patch is missing: ${entry.relative}`);
    let desired = current;
    if (hash === entry.originalSHA256) {
      let text = current.toString('utf8');
      for (const anchor of entry.anchors) {
        if (text.split(anchor.before).length !== 2) throw new Error(`Purge restart anchor must occur exactly once: ${entry.relative}`);
        text = text.replace(anchor.before, anchor.after);
      }
      desired = Buffer.from(text);
      if (digest(desired) !== entry.patchedSHA256) throw new Error('Unexpected Purge managed-restart patch output');
    }
    return { ...entry, path, current, desired };
  }));
  if (!check) for (const entry of entries) {
    if (entry.current.equals(entry.desired)) continue;
    const temporary = `${entry.path}.managed-restart-${process.pid}.tmp`;
    let file, created = false;
    try {
      const mode = (await stat(entry.path)).mode & 0o777;
      file = await open(temporary, 'wx', mode); created = true;
      await file.chmod(mode);
      await file.writeFile(entry.desired);
      await file.sync();
      await file.close(); file = undefined;
      await rename(temporary, entry.path);
    } finally {
      await file?.close().catch(() => {});
      if (created) await rm(temporary, { force: true });
    }
  }
  return { status: check ? 'verified' : 'patched', version: pkg.version, files: entries.map(entry => ({ path: entry.relative, sha256: entry.patchedSHA256 })) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--root');
  if (at < 0 || !args[at + 1] || args.some((x, i) => i !== at && i !== at + 1 && x !== '--check')) throw new Error('usage: patch-mac-dsh-purge.mjs --root <Purge package root> [--check]');
  try {
    console.log(JSON.stringify(await patchPurgeManagedRestart(resolve(args[at + 1]), { check: args.includes('--check') })));
  } catch (error) {
    console.error(`Mac DSH Purge preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
