#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lock = JSON.parse(
  await readFile(new URL("../dsh-runtime/package-lock.json", import.meta.url), "utf8"),
);
const versions = Object.fromEntries(
  (await readFile(new URL("../versions.env", import.meta.url), "utf8"))
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const packages = lock.packages;
const dsh = packages["node_modules/@deepseek-ai/dsh"];

assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.packages[""].dependencies["@deepseek-ai/dsh"], versions.DSH_VERSION);
assert.equal(dsh.version, versions.DSH_VERSION);
assert.equal(dsh.integrity, versions.DSH_NPM_INTEGRITY);
assert.equal(packages["node_modules/node-pty"].version, versions.NODE_PTY_VERSION);
assert.equal(packages["node_modules/node-addon-api"].version, versions.NODE_ADDON_API_VERSION);

for (const [path, metadata] of Object.entries(packages)) {
  if (/^node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(path)) {
    assert.equal(metadata.version, versions.DSH_VERSION, `${path} drifted from ${versions.DSH_VERSION}`);
  }
}

console.log("npm lockfile versions and integrity passed");
