#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

let runtimeRoot;
let checkOnly = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--root") {
    runtimeRoot = resolve(process.argv[++index] ?? "");
  } else if (argument === "--check") {
    checkOnly = true;
  } else {
    throw new Error(`unknown argument: ${argument}`);
  }
}

if (runtimeRoot === undefined) {
  throw new Error("usage: node scripts/patch-pnpm.mjs --root <pnpm-package-root> [--check]");
}

const packageJson = JSON.parse(await readFile(resolve(runtimeRoot, "package.json"), "utf8"));
if (packageJson.name !== "pnpm" || packageJson.version !== "10.34.5") {
  throw new Error(
    `unsupported pnpm package: ${packageJson.name ?? "unknown"}@${packageJson.version ?? "unknown"}`,
  );
}

const target = resolve(runtimeRoot, "dist/pnpm.cjs");
const source = await readFile(target, "utf8");
const original = `    function parseNonShell(parsed) {
      if (!isWin) {
        return parsed;
      }
      const commandFile = detectShebang(parsed);`;
const replacement = `    function parseNonShell(parsed) {
      if (process.platform === "ios") {
        detectShebang(parsed);
        return parsed;
      }
      if (!isWin) {
        return parsed;
      }
      const commandFile = detectShebang(parsed);`;
const originalCount = source.split(original).length - 1;
const replacementCount = source.split(replacement).length - 1;

if (replacementCount === 1 && originalCount === 0) {
  process.stdout.write(`pnpm iOS shebang launcher: ${checkOnly ? "verified" : "already patched"}\n`);
} else if (checkOnly) {
  throw new Error("pnpm iOS shebang launcher patch is missing or ambiguous");
} else if (originalCount === 1 && replacementCount === 0) {
  await writeFile(target, source.replace(original, replacement));
  process.stdout.write("pnpm iOS shebang launcher: patched\n");
} else {
  throw new Error(
    `pnpm iOS shebang launcher: expected one original and no replacement; ` +
      `found original=${originalCount}, replacement=${replacementCount}`,
  );
}
