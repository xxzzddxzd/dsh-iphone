#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Exercise the validator shipped in each browser bundle, including its
// recursive snapshot rules, under both V8 and JavaScriptCore native formatting.
function validator(source, webkit) {
  const begin = source.indexOf("function hasIntrinsicConstructor(prototype, name)");
  const end = source.indexOf("function deepFreeze(value)", begin);
  assert.ok(begin >= 0 && end > begin, "locked JSON validator exists");
  const context = vm.createContext({});
  if (webkit) vm.runInContext(`
    const intrinsicToString = Function.prototype.toString;
    Function.prototype.toString = function toString() {
      const text = intrinsicToString.call(this);
      return text.replace('{ [native code] }', '{\\n    [native code]\\n}');
    };
  `, context);
  vm.runInContext(source.slice(begin, end), context);
  return context;
}

for (const name of ["dsh-api-session-controller"]) {
  const path = `node_modules/@deepseek-ai/${name}/lib/client.js`;
  const official = await readFile(new URL(`../dsh-runtime/${path}`, import.meta.url), "utf8");
  const patched = await readFile(new URL(`../build/dsh-runtime/${path}`, import.meta.url), "utf8");
  const jsonSource = source => source.slice(source.indexOf("function hasIntrinsicConstructor(prototype, name)"), source.indexOf("function deepFreeze(value)", source.indexOf("function hasIntrinsicConstructor(prototype, name)")));
  assert.equal(jsonSource(patched), jsonSource(official), "upstream WebKit JSON fix must remain unchanged");
  for (const webkit of [false, true]) {
    const context = validator(patched, webkit);
    const accepted = vm.runInContext(`
      const value = { type: 'metadata', values: [1, '鲸🐋', true, null, { nested: 'ok' }] };
      const snapshot = snapshotJsonValue(value);
      JSON.stringify({ equal: JSON.stringify(snapshot) === JSON.stringify(value), detached: snapshot !== value && snapshot.values !== value.values });
    `, context);
    assert.deepEqual(JSON.parse(accepted), { equal: true, detached: true });
    context.foreignValue = { data: [1, { safe: true }] };
    assert.equal(vm.runInContext("JSON.stringify(snapshotJsonValue(foreignValue))", context), JSON.stringify(context.foreignValue));
    assert.equal(vm.runInContext("JSON.stringify(snapshotJsonValue(Object.assign(Object.create(null), { value: 1 })))", context), '{"value":1}');
    for (const expression of [
      "({ bad: undefined })", "({ bad: () => 1 })", "({ bad: Symbol('x') })", "({ bad: 1n })",
      "({ bad: NaN })", "({ bad: Infinity })", "({ bad: -0 })", "[1,,3]",
      "new (class ArrayChild extends Array {})(1,2)", "new Date(0)", "new (class Record {})()",
      "(() => { const value = {}; value.self = value; return value; })()",
      "Object.defineProperty({}, 'hidden', { value: 1 })", "({ [Symbol('hidden')]: 1 })",
      "Object.assign([1], { extra: 2 })",
      "(() => { function Object() {} return new Object(); })()",
    ]) {
      assert.equal(vm.runInContext(`snapshotJsonValue(${expression})`, context), undefined,
        `${name} must still reject non-JSON values: ${expression}`);
    }
  }
}
console.log("iOS JSON validation: Safari native formatting, cross-realm records and strict lossless rejection passed");
