#!/usr/bin/env node
// Safari 16.1 cannot parse RegExp lookbehind. Preserve source offsets and
// context reads by checking boundaries against the original input instead.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const defaultSource = resolve(repository, 'dsh-runtime/node_modules');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('iOS token rule preimage must occur exactly once');
  return source.replace(before, after);
}

export const tokenRuleInputs = Object.freeze([
  { name: 'skill', relative: '@deepseek-ai/dsh-client-ui-skill/lib/client.js',
    sha256: 'a0acc17b955b1262208613a84b2192868417b6d8b3b8f222e4e9dc480c7ad2f8' },
  { name: 'reference', relative: '@deepseek-ai/dsh-client-ui-reference/lib/client.js',
    sha256: '3d179111c51381733c7d0ec13c60ee4d9444c1dfb474ef28a0127654b8ba28a3' },
  { name: 'goal', relative: '@deepseek-ai/dsh-client-ui-goal/lib/client.js',
    sha256: 'bd8e08a20c040729678c66fdeb5f823e6fbdb8a4b17feadd8e26a63a87294d0c' },
]);

function compatibleRule(name, source) {
  if (name === 'skill') {
    source = once(source, String.raw`const tokens = /(?<!\S)\/([\w-]+)(?!\S)/gu;`,
      String.raw`const tokens = /\/([\w-]+)(?!\S)/gu;`);
    return once(source,
      'for (let token = tokens.exec(text); token !== null; token = tokens.exec(text)) {',
      String.raw`for (let token = tokens.exec(text); token !== null; token = tokens.exec(text)) {
                    if (token.index !== 0 && !/\s/u.test(text.slice(token.index - 1, token.index))) continue;`);
  }
  if (name === 'reference') {
    source = once(source, String.raw`const tokens = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu;`,
      String.raw`const tokens = /(@"[^"\n]+"|@[^\s]+)/gu;`);
    return once(source,
      'for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {',
      String.raw`for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {
                if (match.index !== 0 && !/\s/u.test(text.slice(match.index - 1, match.index))) {
                    // A rejected quoted candidate may contain a later valid @ token.
                    tokens.lastIndex = match.index + 1;
                    continue;
                }`);
  }
  if (name === 'goal') {
    source = once(source, String.raw`const slash = /(?<!\S)\//gu;`, String.raw`const slash = /\//gu;`);
    return once(source, 'if (!slash.test(text)) return void 0;', String.raw`let boundarySlash = false;
                for (let match = slash.exec(text); match !== null; match = slash.exec(text)) {
                    if (match.index === 0 || /\s/u.test(text.slice(match.index - 1, match.index))) {
                        boundarySlash = true;
                        break;
                    }
                }
                if (!boundarySlash) return void 0;`);
  }
  throw new Error('Unknown iOS token rule');
}

/** Validate all immutable inputs and all targets before writing any module. */
export async function patchIosTokenRules(runtimeRoot, { source = defaultSource, check = false } = {}) {
  const entries = await Promise.all(tokenRuleInputs.map(async input => {
    const original = await readFile(resolve(source, input.relative));
    if (hash(original) !== input.sha256) throw new Error(`Unsupported iOS token rule upstream preimage: ${input.relative}`);
    const desired = Buffer.from(compatibleRule(input.name, original.toString('utf8')));
    const target = resolve(runtimeRoot, 'node_modules', input.relative);
    const current = await readFile(target);
    if (!current.equals(original) && !current.equals(desired)) throw new Error(`Unexpected iOS token rule target bytes: ${input.relative}`);
    if (check && !current.equals(desired)) throw new Error(`iOS token rule patch is missing: ${input.relative}`);
    return { ...input, target, current, desired };
  }));
  if (!check) for (const entry of entries) if (!entry.current.equals(entry.desired)) await writeFile(entry.target, entry.desired);
  return { files: entries.map(entry => ({ name: entry.name, path: `node_modules/${entry.relative}`, sha256: hash(entry.desired) })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  if (rootIndex < 0 || !args[rootIndex + 1] || args.some((arg, index) => index !== rootIndex && index !== rootIndex + 1 && arg !== '--check')) {
    throw new Error('usage: patch-ios-token-rules.mjs --root <runtime-root> [--check]');
  }
  console.log(JSON.stringify(await patchIosTokenRules(resolve(args[rootIndex + 1]), { check: args.includes('--check') })));
}
