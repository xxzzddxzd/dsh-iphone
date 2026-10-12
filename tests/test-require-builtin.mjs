#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? new URL("../build/dsh-runtime", import.meta.url).pathname);
const require = createRequire(resolve(root, "package.json"));
assert.ok(!process.execArgv.includes("--expose-internals"));
assert.throws(() => require("internal/modules/esm/loader"), /Cannot find module|No such built-in module/);
const addon = require("node-addon-require-builtin");
const info = addon.getBindingInfo();
assert.equal(info.product, "require-builtin");
assert.equal(typeof addon.requireBuiltin("internal/modules/esm/loader").getOrInitializeCascadedLoader, "function");
assert.equal(typeof addon.requireBuiltin("internal/modules/cjs/loader").Module, "function");
assert.throws(() => addon.requireBuiltin(), /moduleId must be a string/);
assert.throws(() => addon.requireBuiltin("not-a-node-builtin"));
if (process.platform === "ios") {
  assert.equal(info.backend, "napi");
  assert.equal(info.abi, "napi-v9");
  assert.equal(info.bindingSource, "local-build");
  assert.match(info.bindingPath, /\/build\/napi\/napi-v9-ios-arm64\/require_builtin\.node$/);
  assert.equal(process.env.NARB_DISABLE_NATIVE_CACHE, "1");
}
console.log(JSON.stringify({ nativeBuiltinLoader: "passed", platform: process.platform, backend: info.backend, abi: info.abi }));
