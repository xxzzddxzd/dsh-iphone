#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lock = JSON.parse(
  await readFile(new URL("../dsh-runtime/package-lock.json", import.meta.url), "utf8"),
);
const packages = lock.packages;
const dsh = packages["node_modules/@deepseek-ai/dsh"];

assert.equal(lock.lockfileVersion, 3);
assert.equal(dsh.version, "0.1.0-rc.6");
assert.equal(
  dsh.integrity,
  "sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==",
);
assert.equal(packages["node_modules/node-pty"].version, "1.1.0");
assert.equal(packages["node_modules/node-addon-api"].version, "7.1.1");

for (const [path, metadata] of Object.entries(packages)) {
  if (/^node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(path)) {
    assert.equal(metadata.version, "0.1.0-rc.6", `${path} drifted from rc.6`);
  }
}

console.log("npm lockfile versions and integrity passed");
