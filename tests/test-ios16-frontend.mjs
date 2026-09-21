#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
import { compatibleSource, syntaxFiles } from "../scripts/frontend-syntax.mjs";
import { fileURLToPath } from "node:url";

const htmlPath = new URL("../web/index.ios.html", import.meta.url);
const html = await readFile(htmlPath, "utf8");
const touchIcon = await readFile(new URL("../web/apple-touch-icon.png", import.meta.url));
const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];

assert.ok(inlineScript, "compatibility bootstrap script is missing");
assert.match(html, /name="dsh-ios-compat" content="13"/);
assert.match(html, /name="apple-mobile-web-app-title" content="DSH"/);
assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png\?ioscompat=13"/);
assert.match(html, /index-BKQ_L1z6\.js\?ioscompat=13/);
assert.match(html, /vendor-CCJJTK99\.js\?ioscompat=13/);
assert.equal(touchIcon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(touchIcon.readUInt32BE(16), 180, "Home Screen icon width");
assert.equal(touchIcon.readUInt32BE(20), 180, "Home Screen icon height");

const storage = new Map();
let replacedUrl;
const context = vm.createContext({
  AbortController,
  AbortSignal,
  ArrayBuffer,
  clearTimeout,
  crypto: globalThis.crypto,
  DOMException,
  Map,
  Promise,
  RegExp,
  Set,
  setTimeout,
  URL,
  URLSearchParams,
  Uint8Array,
  WeakMap,
  history: {
    state: null,
    replaceState(_state, _title, url) {
      replacedUrl = url;
    },
  },
  localStorage: {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  },
  location: {
    href: "http://127.0.0.1:3080/?ioscompat=13&session=child-1&parent=parent-1&mode=continuable",
  },
});
context.window = context;
vm.runInContext(
  `
    delete Promise.withResolvers;
    delete Array.prototype.toSpliced;
    delete Array.prototype.toReversed;
    delete Array.prototype.toSorted;
    delete Array.prototype.with;
    delete Array.prototype.findLast;
    delete Array.prototype.findLastIndex;
    delete AbortSignal.timeout;
    delete AbortSignal.any;
    delete globalThis.structuredClone;
  `,
  context,
);
vm.runInContext(inlineScript, context);

assert.equal(vm.runInContext("typeof Promise.withResolvers", context), "function");
assert.equal(vm.runInContext("typeof AbortSignal.timeout", context), "function");
assert.equal(vm.runInContext("typeof AbortSignal.any", context), "function");
assert.equal(vm.runInContext("typeof structuredClone", context), "function");
assert.equal(vm.runInContext("[1, 2, 3].toReversed().join(',')", context), "3,2,1");
assert.equal(vm.runInContext("[1, 2, 3].toSpliced(1, 1, 9).join(',')", context), "1,9,3");
assert.equal(vm.runInContext("[3, 1, 2].toSorted().join(',')", context), "1,2,3");
assert.equal(vm.runInContext("[1, 2, 3].with(-1, 9).join(',')", context), "1,2,9");
assert.equal(vm.runInContext("[1, 2, 3].findLast((value) => value < 3)", context), 2);
assert.deepEqual(JSON.parse(storage.get("dsh.sessions.current")), {
  sessionId: "child-1",
  subagentAddress: {
    parentSessionId: "parent-1",
    childSessionId: "child-1",
    mode: "continuable",
  },
});
assert.equal(replacedUrl, "/?ioscompat=13");
assert.equal(vm.runInContext("__DSH_IOS_SESSION_LINK__.sessionId", context), "child-1");
assert.equal(vm.runInContext("__DSH_IOS_COMPAT__", context), 13);

const vendorPath = process.argv[2];
const indexPath = process.argv[3];
if (vendorPath !== undefined || indexPath !== undefined) {
  assert.ok(vendorPath && indexPath, "pass both vendor and index bundle paths");
  const vendor = await readFile(vendorPath, "utf8");
  const index = await readFile(indexPath, "utf8");
  const unsupported =
    '/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu';
  const compatible =
    '/([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu';
  assert.equal(vendor.includes(unsupported), false, "Safari lookbehind remains");
  assert.equal(vendor.split(compatible).length - 1, 1, "compatible regexp count");
  assert.ok(index.includes('from"./vendor-CCJJTK99.js?ioscompat=13"'));
  assert.doesNotMatch(index, /\bstatic\s*\{/, "Safari 16.1 cannot parse class static blocks");
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const path of syntaxFiles) {
    const actual = await readFile(new URL(`../build/dsh-runtime/node_modules/${path}`, import.meta.url), "utf8");
    assert.equal(actual, (await compatibleSource(root, path)).code, "syntax output must reproduce from official packages");
  }
  const polyfills = await readFile(new URL("../build/dsh-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-ios-polyfills.js", import.meta.url), "utf8");
  const legacy = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext("delete globalThis.Iterator; delete Uint8Array.fromBase64; delete Array.prototype.toReversed", legacy);
  vm.runInContext(polyfills, legacy);
  assert.equal(vm.runInContext("Iterator.from([1,2,3]).map(x => x*2).toArray().join(',')", legacy), "2,4,6");
  assert.equal(vm.runInContext("Uint8Array.fromBase64('SGk=').length", legacy), 2);
  assert.equal(vm.runInContext("[1,2,3].toReversed().join(',')", legacy), "3,2,1");
}

const require = createRequire(new URL("../tools/frontend/package.json", import.meta.url));
const { transform } = require("esbuild");
const fixture = `
  const order = [];
  class Logger {
    static count = 2;
    static { order.push(this.count); this.prototype.log = () => 'ready'; }
    static after = order.push(3);
  }
  globalThis.result = [order, new Logger().log(), Logger.count];
`;
const lowered = (await transform(fixture, { target: "safari16.1" })).code;
assert.doesNotMatch(lowered, /\bstatic\s*\{/);
const originalContext = vm.createContext({});
const loweredContext = vm.createContext({});
vm.runInContext(fixture, originalContext);
vm.runInContext(lowered, loweredContext);
assert.equal(JSON.stringify(loweredContext.result), JSON.stringify(originalContext.result));

console.log("iOS 16 frontend compatibility checks passed");
