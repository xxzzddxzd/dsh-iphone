import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../tools/frontend/package.json", import.meta.url));
const { transform, build } = require("esbuild");
export const syntaxFiles = [
  "@deepseek-ai/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js",
  "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js",
];

export async function compatibleSource(repositoryRoot, relativePath) {
  let source = await readFile(resolve(repositoryRoot, "dsh-runtime/node_modules", relativePath), "utf8");
  source = source.replace('from"./vendor-CCJJTK99.js"', 'from"./vendor-CCJJTK99.js?ioscompat=13"');
  const result = await transform(source, {
    target: "safari16.1", format: "esm", minifyWhitespace: true,
    legalComments: "inline", sourcefile: relativePath,
  });
  return { source, code: result.code };
}

export async function installFrontendSyntax(repositoryRoot, runtimeRoot, checkOnly) {
  for (const relativePath of syntaxFiles) {
    const target = resolve(runtimeRoot, "node_modules", relativePath);
    const current = await readFile(target, "utf8");
    const { source, code } = await compatibleSource(repositoryRoot, relativePath);
    if (current === code) continue;
    if (checkOnly || current !== source) throw new Error(`Safari syntax: unexpected preimage in ${relativePath}`);
    await writeFile(target, code);
  }
  const polyfills = await build({
    entryPoints: [require.resolve("core-js/stable")],
    bundle: true, write: false, format: "iife", platform: "browser",
    target: "safari16.1", minify: true, legalComments: "inline",
  });
  const target = resolve(runtimeRoot, "node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-ios-polyfills.js");
  const expected = polyfills.outputFiles[0].text;
  if (checkOnly) {
    if (await readFile(target, "utf8") !== expected) throw new Error("Safari API polyfills differ from locked build");
  } else {
    await writeFile(target, expected);
  }
  console.log("Safari 16.1 frontend syntax verified");
}
