#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [profile, ...args] = process.argv.slice(2);
let apply = false, runtime = resolve(root, "build/dsh-runtime");
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--apply") apply = true;
  else if (args[index] === "--runtime") runtime = resolve(args[++index]);
  else throw new Error("usage: install-native-profile.mjs <profile-dir> [--apply] [--runtime path]");
}
if (!profile) throw new Error("The target profile directory is required");
const yaml = createRequire(resolve(runtime, "package.json"))("js-yaml");
const file = resolve(profile, "cordis.patch.yml");
const before = await readFile(file, "utf8");
const rows = yaml.load(before) ?? [];
if (!Array.isArray(rows)) throw new Error("Profile patch must be an array");
const template = yaml.load(await readFile(resolve(root, "packaging/mobile-gateway/cordis.patch.yml"), "utf8"));
const desired = [template[0].insert[0], template[1]].map(row => ({ id: row.id, config: row.config }));
const changed = [];
for (const row of desired) {
  const matches = rows.filter(entry => entry?.id === row.id);
  if (matches.length > 1) throw new Error(`Duplicate local override for ${row.id}`);
  if (!matches.length) { rows.push(row); changed.push(row.id); }
  else {
    const next = { ...matches[0].config, ...row.config };
    if (!isDeepStrictEqual(matches[0].config, next)) {
      matches[0].config = next;
      changed.push(row.id);
    }
  }
}
if (apply && changed.length) {
  const backup = resolve(profile, ".native-client-backup");
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await writeFile(resolve(backup, "cordis.patch.yml"), before, { mode: 0o600, flag: "wx" });
  const after = yaml.dump(rows, { noRefs: true, lineWidth: -1 });
  if (!isDeepStrictEqual(yaml.load(after), rows)) throw new Error("Profile YAML did not round-trip");
  const temporary = file + ".native-tmp";
  await writeFile(temporary, after, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
console.log(JSON.stringify({ status: changed.length ? apply ? "applied" : "planned" : "current", rows: changed,
  gateway: "ws://127.0.0.1:3080/ws/mobile", authenticated: true, lanEnabled: false }));
