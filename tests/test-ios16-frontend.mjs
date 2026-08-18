#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const htmlPath = new URL("../web/index.ios.html", import.meta.url);
const html = await readFile(htmlPath, "utf8");
const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];

assert.ok(inlineScript, "compatibility bootstrap script is missing");
assert.match(html, /name="dsh-ios-compat" content="4"/);
assert.match(html, /index-Dqw48FrP\.js\?ioscompat=4/);
assert.match(html, /vendor-Cjbwl5VI\.js\?ioscompat=4/);

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
  Uint8Array,
  WeakMap,
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

const vendorPath = process.argv[2];
const indexPath = process.argv[3];
if (vendorPath !== undefined || indexPath !== undefined) {
  assert.ok(vendorPath && indexPath, "pass both vendor and index bundle paths");
  const vendor = await readFile(vendorPath, "utf8");
  const index = await readFile(indexPath, "utf8");
  const unsupported =
    'new RegExp("(?<=^|\\\\s|\\\\p{P}|\\\\p{S})([-.\\\\w+]+)@([-\\\\w]+(?:\\\\.[-\\\\w]+)+)","gu")';
  const compatible =
    'new RegExp("([-.\\\\w+]+)@([-\\\\w]+(?:\\\\.[-\\\\w]+)+)","gu")';
  assert.equal(vendor.includes(unsupported), false, "Safari lookbehind remains");
  assert.equal(vendor.split(compatible).length - 1, 1, "compatible regexp count");
  assert.ok(index.includes('from"./vendor-Cjbwl5VI.js?ioscompat=4"'));
}

console.log("iOS 16 frontend compatibility checks passed");
