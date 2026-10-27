#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateProfile } from "../scripts/migrate-profile-0.2.1.mjs";

const retired = "@deepseek-ai/dsh-experimental-schedule-bundle";
const root = await mkdtemp(join(tmpdir(), "dsh-profile-migration-"));
const exists = path => access(path).then(() => true, () => false);
try {
  const profile = join(root, "profiles", "web");
  await mkdir(profile, { recursive: true });
  const original = {
    name: "fixture-profile", dependencies: { [retired]: "0.2.0-rc.2", "dsh-codex": "link:../provider", keep: "1.2.3" },
    devDependencies: { [retired]: "0.2.0-rc.2", retainDev: "2.3.4" },
    optionalDependencies: { [retired]: "0.2.0-rc.2" }, peerDependencies: { [retired]: "0.2.0-rc.2", retainedPeer: "*" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", retired, "dsh-codex"], patchReload: "live" } },
    privateFixture: "do-not-print-this-value",
  };
  const bytes = Buffer.from(JSON.stringify(original, null, 2) + "\n");
  await writeFile(join(profile, "package.json"), bytes);
  const taskFile = join(root, "schedule-library.json");
  const tasks = Buffer.from('{"tasks":[{"id":"existing-task","enabled":true}]}\n');
  await writeFile(taskFile, tasks);

  const audit = await migrateProfile(profile);
  assert.equal(audit.mode, "audit");
  assert.deepEqual(audit.changedFiles, ["package.json"]);
  assert.deepEqual(await readFile(join(profile, "package.json")), bytes);
  assert.deepEqual(await readdir(profile), ["package.json"], "audit must not write backups or metadata");
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/migrate-profile-0.2.1.mjs", import.meta.url)), profile], { encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.ok(!cli.stdout.includes(original.privateFixture), "reports must not expose profile values");

  const applied = await migrateProfile(profile, { apply: true });
  assert.equal(applied.status, "applied");
  assert.equal(applied.dependencyInstallRequired, true);
  const after = JSON.parse(await readFile(join(profile, "package.json")));
  const expected = structuredClone(original);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) delete expected[section][retired];
  expected.dsh.profile.bundles = expected.dsh.profile.bundles.filter(name => name !== retired);
  assert.deepEqual(after, expected, "only the retired bundle and dependency may change");
  assert.deepEqual(await readFile(taskFile), tasks, "stored tasks must remain byte-identical");
  const backup = join(applied.backupDirectory, "package.json");
  assert.deepEqual(await readFile(backup), bytes);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.equal((await stat(applied.backupDirectory)).mode & 0o777, 0o700);
  const backups = await readdir(join(profile, ".migration-backups"));
  const again = await migrateProfile(profile, { apply: true });
  assert.equal(again.status, "current");
  assert.deepEqual(again.changedFiles, []);
  assert.deepEqual(await readdir(join(profile, ".migration-backups")), backups, "a repeated migration must not create backup churn");

  const unsupported = join(root, "unsupported");
  const balance = join(unsupported, "packages", "dsh-balance-deepseek");
  await mkdir(join(balance, "lib"), { recursive: true });
  const profileBytes = Buffer.from(JSON.stringify({ dependencies: { [retired]: "0.2.0-rc.2", "dsh-balance-deepseek": "workspace:*" } }));
  await writeFile(join(unsupported, "package.json"), profileBytes);
  await writeFile(join(balance, "package.json"), JSON.stringify({ name: "dsh-balance-deepseek", version: "0.1.1",
    peerDependencies: { "@deepseek-ai/cordis": "~4.0.4", "@deepseek-ai/dsh-credentials": "0.2.0-rc.2" },
    dsh: { client: { inject: ["@deepseek-ai/dsh-client-runtime"] } } }));
  await writeFile(join(balance, "lib/index.js"), "// locally modified host\n");
  await writeFile(join(balance, "lib/client.js"), "// locally modified client\n");
  await assert.rejects(migrateProfile(unsupported, { apply: true }), /Unknown balance .* revision/);
  assert.deepEqual(await readFile(join(unsupported, "package.json")), profileBytes, "all edits must wait for balance preflight");
  assert.equal(await exists(join(unsupported, ".migration-backups")), false);

  const phone = join(root, "phone");
  await mkdir(phone);
  const phoneBytes = Buffer.from(JSON.stringify({ dependencies: { "dsh-codex": "file:/var/root/provider.tgz" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-codex"] } } }));
  await writeFile(join(phone, "package.json"), phoneBytes);
  assert.equal((await migrateProfile(phone, { apply: true })).status, "current");
  assert.deepEqual(await readFile(join(phone, "package.json")), phoneBytes);
  assert.deepEqual(await readdir(phone), ["package.json"]);

  const linked = join(root, "linked");
  await mkdir(linked);
  await symlink(join(phone, "package.json"), join(linked, "package.json"));
  await assert.rejects(migrateProfile(linked, { apply: true }), /in-profile regular file/);
  assert.deepEqual(await readFile(join(phone, "package.json")), phoneBytes);
  console.log("Profile migration preserves tasks and unrelated fields, audits without writes, backs up privately, is idempotent and refuses unknown balance code");
} finally { await rm(root, { recursive: true, force: true }); }
