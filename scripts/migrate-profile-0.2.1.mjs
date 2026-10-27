#!/usr/bin/env node
/** Audit or migrate an offline profile to DSH 0.2.1 without touching task data. */
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const retiredBundle = "@deepseek-ai/dsh-experimental-schedule-bundle";
const balanceName = "dsh-balance-deepseek";
const balanceHostBefore = "bafa79db5c88e42e223fe3a494a89c85bc96b136e6514af38893f3cc5ae22f7c";
const balanceHostAfter = "90767603f2cc6322cf74bf92ae9d89af4250e1feb2f42b28eec21c7b44ba5cf1";
const balanceClient = "6abd208879283ddcc023ef1fce9c4f58a310cf9c38bcda2aab66c3a5007c5187";
const oldSettingsRead = 'settings?.describe?.().namespaces.find(entry => String(entry.ns) === "llm-deepseek")?.value';
const newSettingsRead = 'settings?.describe?.().find(entry => String(entry.ns) === "llm-deepseek")?.value';
const digest = value => createHash("sha256").update(value).digest("hex");
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");

/** Only the retired dependency and bundle entry are removed; all other fields survive. */
function profileManifest(current) {
  const next = structuredClone(current);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (next[section] !== undefined) delete next[section][retiredBundle];
  }
  const bundles = next.dsh?.profile?.bundles;
  if (bundles !== undefined) {
    if (!Array.isArray(bundles) || bundles.some(value => typeof value !== "string")) throw new Error("Invalid profile bundle list");
    next.dsh.profile.bundles = bundles.filter(value => value !== retiredBundle);
  }
  return next;
}

function balanceManifest(current) {
  if (current.name !== balanceName || !["0.1.1", "0.1.2"].includes(current.version)) throw new Error("Unknown local balance package revision");
  const peers = current.peerDependencies;
  if (!["~4.0.4", "~4.0.5"].includes(peers?.["@deepseek-ai/cordis"])
    || !["0.2.0-rc.2", "0.2.1-rc.2"].includes(peers?.["@deepseek-ai/dsh-credentials"])) throw new Error("Unknown local balance peer requirements");
  const injected = current.dsh?.client?.inject;
  if (!Array.isArray(injected)
    || injected.filter(name => ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-renderer"].includes(name)).length !== 1) {
    throw new Error("Unknown local balance client dependencies");
  }
  const next = structuredClone(current);
  next.version = "0.1.2";
  next.peerDependencies["@deepseek-ai/cordis"] = "~4.0.5";
  next.peerDependencies["@deepseek-ai/dsh-credentials"] = "0.2.1-rc.2";
  next.dsh.client.inject = injected.map(name => name === "@deepseek-ai/dsh-client-runtime" ? "@deepseek-ai/dsh-client-ui-renderer" : name);
  return next;
}

async function readState(root, path) {
  const absolute = join(root, path);
  const stat = await lstat(absolute);
  const actual = await realpath(absolute);
  if (!stat.isFile() || !actual.startsWith(root + sep)) throw new Error(`Migration requires an in-profile regular file: ${path}`);
  return { path, absolute, before: await readFile(absolute), mode: stat.mode & 0o777 };
}

async function atomicWrite(path, bytes, mode) {
  const temporary = `${path}.migration-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/** Validate every known input before applying exact edits; backups are private and immutable. */
export async function migrateProfile(profileDirectory, { apply = false } = {}) {
  const root = await realpath(resolve(profileDirectory));
  const plans = [];
  const manifestState = await readState(root, "package.json");
  const manifest = JSON.parse(manifestState.before);
  const nextManifest = profileManifest(manifest);
  if (JSON.stringify(nextManifest) !== JSON.stringify(manifest)) plans.push({ ...manifestState, after: jsonBytes(nextManifest) });

  let balance = "absent";
  if (["dependencies", "devDependencies", "optionalDependencies"].some(section => Object.hasOwn(manifest[section] ?? {}, balanceName))) {
    if (manifest.dependencies?.[balanceName] !== "workspace:*") throw new Error("Only the known workspace balance package can be migrated");
    const prefix = `packages/${balanceName}`;
    const metadataState = await readState(root, `${prefix}/package.json`);
    const metadata = JSON.parse(metadataState.before);
    const nextMetadata = balanceManifest(metadata);
    const host = await readState(root, `${prefix}/lib/index.js`);
    const client = await readState(root, `${prefix}/lib/client.js`);
    if (digest(client.before) !== balanceClient) throw new Error("Unknown balance client revision; original files preserved");
    const hostHash = digest(host.before);
    if (![balanceHostBefore, balanceHostAfter].includes(hostHash)) throw new Error("Unknown balance host revision; original files preserved");
    if (hostHash === balanceHostBefore) {
      const source = host.before.toString("utf8");
      if (source.split(oldSettingsRead).length !== 2) throw new Error("Unexpected balance settings read preimage");
      const after = Buffer.from(source.replace(oldSettingsRead, newSettingsRead));
      if (digest(after) !== balanceHostAfter) throw new Error("Unexpected balance settings patch result");
      plans.push({ ...host, after });
    }
    if (JSON.stringify(nextMetadata) !== JSON.stringify(metadata)) plans.push({ ...metadataState, after: jsonBytes(nextMetadata) });
    balance = plans.some(plan => plan.path.startsWith(prefix + "/")) ? "upgrade-required" : "current";
  }

  const report = { targetDSH: "0.2.1-rc.2", mode: apply ? "apply" : "audit", status: plans.length ? "changes-required" : "current",
    changedFiles: plans.map(plan => plan.path), balance, dependencyInstallRequired: plans.some(plan => plan.path.endsWith("package.json")) };
  if (!apply || !plans.length) return report;
  for (const plan of plans) {
    if (!(await readFile(plan.absolute)).equals(plan.before)) throw new Error(`Profile changed during audit: ${plan.path}`);
  }
  const backupRoot = join(root, ".migration-backups", `dsh-0.2.1-rc.2-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(dirname(backupRoot), 0o700);
  for (const plan of plans) {
    const backup = join(backupRoot, plan.path);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await writeFile(backup, plan.before, { mode: 0o600, flag: "wx" });
  }
  for (const plan of plans) await atomicWrite(plan.absolute, plan.after, plan.mode);
  return { ...report, status: "applied", balance: balance === "absent" ? balance : "current", backupDirectory: backupRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const paths = args.filter(argument => argument !== "--apply");
    if (paths.length !== 1 || paths[0].startsWith("--") || args.filter(argument => argument === "--apply").length > 1) {
      throw new Error("usage: migrate-profile-0.2.1.mjs <profile-directory> [--apply]; stop DSH before applying, then reinstall profile dependencies");
    }
    console.log(JSON.stringify(await migrateProfile(paths[0], { apply })));
  } catch (error) {
    console.error(`Profile migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
