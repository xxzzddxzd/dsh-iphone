#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { patchIosTokenRules, tokenRuleInputs } from '../scripts/patch-ios-token-rules.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const upstream = join(repository, 'dsh-runtime/node_modules');
const temporary = await mkdtemp(join(tmpdir(), 'dsh-ios-token-rules-'));
const pristine = new Map(await Promise.all(tokenRuleInputs.map(async input =>
  [input.relative, await readFile(join(upstream, input.relative))])));
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(name, { source = false } = {}) {
  const root = join(temporary, name);
  for (const [relative, bytes] of pristine) {
    const path = join(root, source ? '' : 'node_modules', relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return root;
}
async function contents(root) {
  return Promise.all(tokenRuleInputs.map(input => readFile(join(root, 'node_modules', input.relative), 'utf8')));
}
function extractRule(source, name) {
  const marker = name === 'reference' ? 'function nextPath(' :
    `const ${name === 'goal' ? 'goalCommandReferenceRule' : 'skillReferenceRule'} =`;
  const start = source.indexOf(marker);
  const end = source.indexOf('//#endregion', start);
  assert.ok(start > 0 && end > start, 'Production rule boundaries moved; audit the new release');
  const expression = name === 'reference' ? '[fileReferenceRule,folderReferenceRule]' :
    `[${name === 'goal' ? 'goalCommandReferenceRule' : 'skillReferenceRule'}]`;
  return vm.runInNewContext(`(()=>{${source.slice(start, end)};return ${expression}})()`);
}
function materialize(source, input) {
  const registrations = [];
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registrations.push(value); } } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, `@deepseek-ai/dsh-client-ui-${input.name}`);
  const loaded = [];
  const inertComponent = () => null;
  const react = new Proxy({ memo: value => value, forwardRef: value => value,
    createContext: () => ({ Provider: inertComponent }), lazy: () => inertComponent },
  { get(object, name) { return object[name] ?? inertComponent; } });
  const primitives = new Proxy({}, { get() { return inertComponent; } });
  const exports = registrations[0].factory(name => {
    loaded.push(name);
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: inertComponent, jsxs: inertComponent, Fragment: inertComponent };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`Unexpected browser module dependency: ${name}`);
  });
  assert.equal(typeof exports.apply, 'function');
  assert.ok(loaded.length > 0);
}

try {
  for (const input of tokenRuleInputs) {
    assert.equal(hash(pristine.get(input.relative)), input.sha256, 'Locked full-file preimage changed');
    assert.ok(pristine.get(input.relative).toString().includes('(?<!\\S)'), 'The old source must retain the actual failing syntax');
  }
  const root = await fixture('runtime');
  const before = await contents(root);
  await assert.rejects(patchIosTokenRules(root, { check: true }), /patch is missing/);
  assert.deepEqual(await contents(root), before, 'Check mode must never write');
  const report = await patchIosTokenRules(root);
  const patched = await contents(root);
  assert.equal(report.files.length, 3);
  await patchIosTokenRules(root, { check: true });
  await patchIosTokenRules(root);
  assert.deepEqual(await contents(root), patched, 'Applying twice must be byte-identical');
  for (let index = 0; index < tokenRuleInputs.length; index++) {
    assert.equal(patched[index].includes('(?<!'), false);
    assert.equal(patched[index].includes('(?<='), false);
    assert.equal(hash(patched[index]), report.files[index].sha256);
    // Node VM validates registration and materialization, not Safari parsing.
    // The separate iPhone JSContext probe is required for the target engine.
    materialize(patched[index], tokenRuleInputs[index]);
  }

  const unknown = await fixture('unknown-target');
  const last = tokenRuleInputs.at(-1).relative;
  await writeFile(join(unknown, 'node_modules', last), pristine.get(last).toString() + '\n// unexpected downstream change\n');
  const unknownBefore = await contents(unknown);
  await assert.rejects(patchIosTokenRules(unknown), /Unexpected .* target bytes/);
  assert.deepEqual(await contents(unknown), unknownBefore, 'No earlier module may be patched after a later preimage refuses');
  const alteredSource = await fixture('unknown-upstream', { source: true });
  await writeFile(join(alteredSource, last), pristine.get(last).toString() + '\n// unsupported upstream\n');
  const pristineTarget = await fixture('unchanged-target');
  await assert.rejects(patchIosTokenRules(pristineTarget, { source: alteredSource }), /Unsupported .* upstream preimage/);
  assert.deepEqual(await contents(pristineTarget), before);
  const mixed = await fixture('mixed');
  await writeFile(join(mixed, 'node_modules', tokenRuleInputs[0].relative), patched[0]);
  await patchIosTokenRules(mixed);
  assert.deepEqual(await contents(mixed), patched);

  const rulePairs = tokenRuleInputs.map((input, index) => ({ name: input.name,
    original: extractRule(before[index], input.name), patched: extractRule(patched[index], input.name) }));
  const strings = ['', '/foo', '/foo /bar', 'x/foo /foo\t/bar', '/foo/bar',
    'x@"foo @bar"', '@"white space.txt" @dir/', 'x@"@nested @"z w"',
    '😀/foo 😀 /foo', '\n/goal start\t/x', '@"a b/" text @a,', '/foo\u00a0/bar', '@"foo @bar" /goal'];
  let seed = 0x15af41;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const alphabet = ['a', 'b', ' ', '\t', '\n', '@', '"', '/', '-', '.', ',', '😀', 'foo', 'bar', 'goal'];
  for (let index = 0; index < 2500; index++) {
    let value = '';
    const length = random() % 35;
    for (let part = 0; part < length; part++) value += alphabet[random() % alphabet.length];
    strings.push(value);
  }
  const names = ['foo', 'bar', 'goal', 'goal-start', 'x'];
  let comparisons = 0;
  for (const text of strings) for (let from = 0; from <= text.length + 1; from++) {
    const commands = [];
    for (const name of [...names, 'goal start']) {
      let start = -1;
      while ((start = text.indexOf('/' + name, start + 1)) >= 0) commands.unshift({ start, end: start + name.length + 1, name });
    }
    for (const pair of rulePairs) for (let index = 0; index < pair.original.length; index++) {
      const originalReads = [], patchedReads = [];
      const context = reads => ({ read(key) { reads.push(key); return key === 'commands' ? commands : names; } });
      const expected = pair.original[index].match(text, from, context(originalReads));
      const actual = pair.patched[index].match(text, from, context(patchedReads));
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), JSON.stringify({ rule: pair.name, text, from }));
      assert.deepEqual(patchedReads, originalReads, 'Do not add eager context reads on non-token text');
      comparisons++;
    }
  }
  // A rejected quoted prefix must not hide a later, whitespace-delimited token.
  const reference = rulePairs.find(pair => pair.name === 'reference').patched[0];
  assert.equal(reference.match('x@"foo @bar"', 0).start, 7);
  console.log(`iOS token rules: ${comparisons} production-rule comparisons, module registration, exact preimages and no-partial-write checks passed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
