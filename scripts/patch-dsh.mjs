#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  throw new Error("usage: node scripts/patch-dsh.mjs --root <dsh-package-root> [--check]");
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

async function replaceExactlyOnce(relativePath, original, replacement, label) {
  const target = resolve(runtimeRoot, relativePath);
  const source = await readFile(target, "utf8");
  const originalCount = occurrences(source, original);
  const replacementCount = occurrences(source, replacement);

  if (
    replacementCount === 1 &&
    (originalCount === 0 || (replacement.includes(original) && originalCount === 1))
  ) {
    process.stdout.write(`${label}: verified\n`);
    return;
  }
  if (checkOnly) {
    throw new Error(`${label}: patched preimage not found in ${relativePath}`);
  }
  if (originalCount !== 1 || replacementCount !== 0) {
    throw new Error(
      `${label}: expected one original and no replacement in ${relativePath}; ` +
        `found original=${originalCount}, replacement=${replacementCount}`,
    );
  }

  await writeFile(target, source.replace(original, replacement));
  process.stdout.write(`${label}: patched\n`);
}

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function installExactFile(relativePath, sourcePath, originalHash, label) {
  const target = resolve(runtimeRoot, relativePath);
  const desired = await readFile(sourcePath);
  const current = await readFile(target);
  const currentHash = digest(current);
  const desiredHash = digest(desired);

  if (currentHash === desiredHash) {
    process.stdout.write(`${label}: verified\n`);
    return;
  }
  if (checkOnly) {
    throw new Error(`${label}: target does not match the compatibility asset`);
  }
  if (currentHash !== originalHash) {
    throw new Error(
      `${label}: unknown preimage hash ${currentHash}; expected ${originalHash}`,
    );
  }
  await copyFile(sourcePath, target);
  process.stdout.write(`${label}: installed\n`);
}

async function installNewFile(relativePath, sourcePath, label) {
  const target = resolve(runtimeRoot, relativePath);
  const desired = await readFile(sourcePath);
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (current !== undefined && digest(current) === digest(desired)) {
    process.stdout.write(`${label}: verified\n`);
    return;
  }
  if (checkOnly) throw new Error(`${label}: missing or different target ${relativePath}`);
  if (current !== undefined) {
    throw new Error(`${label}: refusing to overwrite an unknown existing ${relativePath}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
  process.stdout.write(`${label}: installed\n`);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(runtimeRoot, relativePath), "utf8"));
}

const dshPackage = await readJson("package.json");
if (dshPackage.name !== "@deepseek-ai/dsh" || dshPackage.version !== "0.1.0-rc.7") {
  throw new Error(
    `unsupported DSH package: ${dshPackage.name ?? "unknown"}@${dshPackage.version ?? "unknown"}`,
  );
}

const nodePtyPackage = await readJson("node_modules/node-pty/package.json");
if (nodePtyPackage.version !== "1.2.0-beta.15") {
  throw new Error(`unsupported node-pty version: ${nodePtyPackage.version}`);
}
const nodeAddonApiPackage = await readJson("node_modules/node-addon-api/package.json");
if (nodeAddonApiPackage.version !== "7.1.1") {
  throw new Error(`unsupported node-addon-api version: ${nodeAddonApiPackage.version}`);
}

await installNewFile(
  "node_modules/ios-sharp-shim.mjs",
  resolve(repositoryRoot, "shims/ios-sharp-shim.mjs"),
  "sharp iOS shim",
);
await installNewFile(
  "node_modules/ios-koffi-stub.mjs",
  resolve(repositoryRoot, "shims/ios-koffi-stub.mjs"),
  "koffi iOS stub",
);
await installNewFile(
  "node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs",
  resolve(repositoryRoot, "ios/notifications/dsh-ios-notifier.mjs"),
  "iOS notification plugin",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  'import sharp from "sharp";',
  '// iOS patch: pure-JS image validator replaces native libvips\nimport sharp from "../../../ios-sharp-shim.mjs";',
  "attachment image backend",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/types-CNjZgO4h.js",
  'import koffi from "koffi";',
  '// iOS patch: Win32-only FFI stays inert on iOS\nimport koffi from "../../../ios-koffi-stub.mjs";',
  "Win32 koffi import",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/types-CNjZgO4h.js",
  "if (STARTUPINFOW.size !== 104)",
  "if (STARTUPINFOW.size !== void 0 && STARTUPINFOW.size !== 104)",
  "STARTUPINFOW inert-size guard",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/types-CNjZgO4h.js",
  "if (PROCESS_INFORMATION.size !== 24)",
  "if (PROCESS_INFORMATION.size !== void 0 && PROCESS_INFORMATION.size !== 24)",
  "PROCESS_INFORMATION inert-size guard",
);

await replaceExactlyOnce(
  "lib/profile-boot-DG5t9aNs.js",
  'if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {',
  'if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0 && ctx.loader.internal) try {',
  "profile HMR loader guard",
);

await replaceExactlyOnce(
  "lib/plugin-9h8shc4d.js",
  `\tconst result = spawnSync("pnpm", args.map((argument) => anchorPathSpec(argument, process.cwd())), {
\t\tcwd: dir,
\t\tstdio: "inherit",
\t\tshell: process.platform === "win32"
\t});`,
  `\tconst pnpmArgs = args.map((argument) => anchorPathSpec(argument, process.cwd()));
\tconst result = spawnSync(process.execPath, ["/var/jb/usr/local/lib/pnpm10/bin/pnpm.cjs", ...pnpmArgs], {
\t\tcwd: dir,
\t\tstdio: "inherit",
\t\tshell: false
\t});`,
  "iOS pnpm launcher",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml",
  `    - id: api-gateway
      name: '@deepseek-ai/dsh-host-apiproxy'
`,
  `    - id: api-gateway
      name: '@deepseek-ai/dsh-host-apiproxy'

    # Rootless iOS system notifications for goal completion/blocking and
    # pending confirmation. Its URL action opens the originating Web session.
    - id: ios-notifier
      name: 'file:///var/jb/usr/local/lib/dsh/node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs'
`,
  "iOS notification composition",
);

const mimeTail = '\t".webmanifest": "application/manifest+json"\n};';
const indexHeaders = `${mimeTail}\nconst INDEX_HEADERS = {\n\t"content-type": MIME[".html"],\n\t"cache-control": "no-store, no-cache, must-revalidate, max-age=0",\n\tpragma: "no-cache",\n\texpires: "0"\n};`;
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js",
  mimeTail,
  indexHeaders,
  "frontend HTML cache headers",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js",
  'res.writeHead(200, { "content-type": MIME[".html"] });',
  "res.writeHead(200, INDEX_HEADERS);",
  "frontend index response headers",
);

const unsupportedEmailRegExp =
  'new RegExp("(?<=^|\\\\s|\\\\p{P}|\\\\p{S})([-.\\\\w+]+)@([-\\\\w]+(?:\\\\.[-\\\\w]+)+)","gu")';
const compatibleEmailRegExp =
  'new RegExp("([-.\\\\w+]+)@([-\\\\w]+(?:\\\\.[-\\\\w]+)+)","gu")';
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-Cjbwl5VI.js",
  unsupportedEmailRegExp,
  compatibleEmailRegExp,
  "Safari 16 GFM email regexp",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-C-1AiF3k.js",
  'from"./vendor-Cjbwl5VI.js"',
  'from"./vendor-Cjbwl5VI.js?ioscompat=7"',
  "frontend vendor cache key",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js",
  resolve(repositoryRoot, "web/plugins/ui-layout-client.js"),
  "744b27c101f129e2a3cd4dcbad8e0932c1950459cea733a8d0d32d238af473b0",
  "iOS floating layout plugin",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js",
  resolve(repositoryRoot, "web/plugins/ui-sidebar-client.js"),
  "b9bd53c300a07199cadcfee7c2a35c6ca4633849ce14574738c26649b09657ba",
  "iOS single-launcher sidebar plugin",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
  resolve(repositoryRoot, "web/plugins/ui-conversation-client.js"),
  "0980922f58332dea0ff18079d2da728f7a81136079babf0278776d6897a45d80",
  "iOS mobile conversation header plugin",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
  resolve(repositoryRoot, "web/index.ios.html"),
  "dd159dc02803ac2b16892ec5843567722e0b18e93a9a7a888c77410ea108a13e",
  "Safari 16 entry document",
);

process.stdout.write(`DSH ${dshPackage.version} iOS compatibility ${checkOnly ? "verified" : "applied"}\n`);
