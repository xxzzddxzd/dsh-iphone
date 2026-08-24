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
if (dshPackage.name !== "@deepseek-ai/dsh" || dshPackage.version !== "0.1.1-rc.2") {
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
  '// iOS patch: ImageIO/CoreGraphics facade replaces native libvips\nimport sharp from "../../../ios-sharp-shim.mjs";',
  "attachment image backend",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `\tconst webp = NORMALIZATION_QUALITIES.map((quality) => (() => encode(prepared.clone(), "image/webp", quality)));
\tif (lowColour) return [() => encode(prepared.clone(), "image/png", void 0, !hasAlpha), ...webp];
\tif (hasAlpha) return webp;
\treturn NORMALIZATION_QUALITIES.map((quality) => (() => encode(prepared.clone(), "image/jpeg", quality)));`,
  `\tconst jpeg = NORMALIZATION_QUALITIES.map((quality) => (() => encode(prepared.clone(), "image/jpeg", quality)));
\tconst png = () => encode(prepared.clone(), "image/png", void 0, !hasAlpha);
\tif (hasAlpha) return [png];
\tif (lowColour) return [png, ...jpeg];
\treturn jpeg;`,
  "attachment normalization encoders",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `\tconst webp = REQUEST_IMAGE_QUALITIES.map((quality) => (() => encoded(prepared.clone(), "image/webp", quality)));
\tif (lowColour) return [() => encoded(prepared.clone(), "image/png", void 0, !hasAlpha), ...webp];
\tif (hasAlpha) return webp;
\treturn REQUEST_IMAGE_QUALITIES.map((quality) => (() => encoded(prepared.clone(), "image/jpeg", quality)));`,
  `\tconst jpeg = REQUEST_IMAGE_QUALITIES.map((quality) => (() => encoded(prepared.clone(), "image/jpeg", quality)));
\tconst png = () => encoded(prepared.clone(), "image/png", void 0, !hasAlpha);
\tif (hasAlpha) return [png];
\tif (lowColour) return [png, ...jpeg];
\treturn jpeg;`,
  "attachment request-image encoders",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `const REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-v4";`,
  `const REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-v4-ios-imageio-1";`,
  "attachment request-image transform identity",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `\t\t\twebpQualities: REQUEST_IMAGE_QUALITIES,
\t\t\tjpegQualities: REQUEST_IMAGE_QUALITIES,
\t\t\torder: [
\t\t\t\t"low-colour:png-webp",
\t\t\t\t"alpha:webp",
\t\t\t\t"opaque:jpeg"
\t\t\t],`,
  `\t\t\tjpegQualities: REQUEST_IMAGE_QUALITIES,
\t\t\torder: [
\t\t\t\t"low-colour:png-jpeg",
\t\t\t\t"alpha:png",
\t\t\t\t"opaque:jpeg"
\t\t\t],`,
  "attachment request-image descriptor",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js",
  'import koffi from "koffi";',
  '// iOS patch: Win32 process inspection stays inert on iOS\nimport koffi from "../../../ios-koffi-stub.mjs";',
  "subprocess Win32 koffi import",
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
const mimeTailWithPng =
  '\t".webmanifest": "application/manifest+json",\n\t".png": "image/png"\n};';
const indexHeaders = `${mimeTailWithPng}\nconst INDEX_HEADERS = {\n\t"content-type": MIME[".html"],\n\t"cache-control": "no-store, no-cache, must-revalidate, max-age=0",\n\tpragma: "no-cache",\n\texpires: "0"\n};`;
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js",
  mimeTail,
  indexHeaders,
  "frontend HTML cache headers and PNG MIME",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js",
  'res.writeHead(200, { "content-type": type });',
  'res.writeHead(200, type === HTML_MIME ? INDEX_HEADERS : { "content-type": type });',
  "frontend index response headers",
);

const unsupportedEmailRegExp =
  'new RegExp("(?<=^|\\\\s|\\\\p{P}|\\\\p{S})([-.\\\\w+]+)@([-\\\\w]+(?:\\\\.[-\\\\w]+)+)","gu")';
const compatibleEmailRegExp =
  'new RegExp("([-.\\\\w+]+)@([-\\\\w]+(?:\\\\.[-\\\\w]+)+)","gu")';
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-D22_Mp1f.js",
  unsupportedEmailRegExp,
  compatibleEmailRegExp,
  "Safari 16 GFM email regexp",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-ClqxG24t.js",
  'from"./vendor-D22_Mp1f.js"',
  'from"./vendor-D22_Mp1f.js?ioscompat=9"',
  "frontend vendor cache key",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js",
  resolve(repositoryRoot, "web/plugins/ui-layout-client.js"),
  "16f001f89a9bc19c54cfa90e37cf52e191113af0abe5efd593e57d7ab30060ad",
  "iOS floating layout plugin",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js",
  resolve(repositoryRoot, "web/plugins/ui-sidebar-client.js"),
  "719693c401e7175e73f50e8021d918b2829a602fbd09761a6ef39d055c53460a",
  "iOS single-launcher sidebar plugin",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
  resolve(repositoryRoot, "web/plugins/ui-conversation-client.js"),
  "fe448ef7e0b1f3e7713dadfc7eff56b9f80d103a2111dfe69c1735ffd0196d61",
  "iOS mobile conversation header plugin",
);

const settingsShellCssTail =
  ".VOzbGW_hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}";
const narrowSettingsCss =
  "@media (max-width:680px){.VOzbGW_overlay{box-sizing:border-box;align-items:stretch;padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}.VOzbGW_panel{width:100%;max-width:none;height:100%;border-radius:18px;flex-direction:column}.VOzbGW_nav{width:100%;gap:10px;padding:12px 12px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}.VOzbGW_navTitle{padding:0 48px 0 4px;font-size:18px;line-height:28px}.VOzbGW_navList{flex-direction:row;gap:4px;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}.VOzbGW_navList::-webkit-scrollbar{display:none}.VOzbGW_navCell{flex:none;height:44px;padding:10px 12px;border-radius:10px}.VOzbGW_content{min-height:0}.VOzbGW_header{height:44px;align-items:center;padding:8px 12px 4px}.VOzbGW_actions{justify-content:flex-start;width:100%;margin-left:0}.VOzbGW_close{position:absolute;top:4px;right:6px;width:44px;height:44px}.VOzbGW_options{padding:4px 12px 16px;overscroll-behavior:contain}}@media (max-width:390px){.VOzbGW_options [data-slot='settings.general.item']>[class$='_row']{align-items:stretch;flex-direction:column;gap:10px}.VOzbGW_options [data-slot='settings.general.item']>[class$='_row']>[class$='_rowText']{padding-right:0}.VOzbGW_options [data-slot='settings.general.item']>[class$='_row']>:last-child{align-self:flex-start}}";
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js",
  settingsShellCssTail,
  `${settingsShellCssTail}${narrowSettingsCss}`,
  "iOS narrow Settings layout",
);
await installNewFile(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/apple-touch-icon.png",
  resolve(repositoryRoot, "web/apple-touch-icon.png"),
  "iOS Home Screen icon",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
  resolve(repositoryRoot, "web/index.ios.html"),
  "f64ff1fca53360a2ae76819ed23c64ddb5b92ae8bf43b2323c8139416efcf065",
  "Safari 16 entry document",
);

process.stdout.write(`DSH ${dshPackage.version} iOS compatibility ${checkOnly ? "verified" : "applied"}\n`);
