#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installFrontendSyntax } from "./frontend-syntax.mjs";

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
if (dshPackage.name !== "@deepseek-ai/dsh" || dshPackage.version !== "0.2.1-rc.2") {
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

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js",
  '\tif (platform === "darwin") return new MacProcessInspector(internals);',
  '\t// iOS provides the same BSD ps fields and POSIX signal semantics.\n\tif (platform === "darwin" || platform === "ios") return new MacProcessInspector(internals);',
  "iOS BSD terminal process inspection",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js",
  'const DEFAULT_BASH_SHELL = "/bin/bash";',
  'const DEFAULT_BASH_SHELL = process.platform === "ios" ? "/var/jb/bin/bash" : "/bin/bash";',
  "iOS rootless default Bash path",
);

await installNewFile(
  "node_modules/ios-sharp-shim.mjs",
  resolve(repositoryRoot, "shims/ios-sharp-shim.mjs"),
  "sharp iOS shim",
);
await installNewFile(
  "node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs",
  resolve(repositoryRoot, "ios/notifications/dsh-ios-notifier.mjs"),
  "iOS notification plugin",
);
await installNewFile(
  "node_modules/@deepseek-ai/dsh-ios-notifier/native-navigation.mjs",
  resolve(repositoryRoot, "ios/notifications/native-navigation.mjs"),
  "iOS native session navigation",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js",
  `\t\t\tconst initiallyAvailable = browser?.navigator?.onLine;`,
  `\t\t\t// iOS: lack of Internet access does not disconnect the on-device Host.
\t\t\tconst localHost = typeof location !== "undefined" && isLoopbackHostname(location.hostname);
\t\t\tconst initiallyAvailable = localHost ? true : browser?.navigator?.onLine;`,
  "local Host network availability",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js",
  `\t\t\tconst offline = () => {
\t\t\t\tcontroller.setNetworkAvailable(false);
\t\t\t};`,
  `\t\t\tconst offline = () => {
\t\t\t\tcontroller.setNetworkAvailable(localHost);
\t\t\t};`,
  "local Host offline events",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js",
  `\t\t\t\tif (connection.rpc.open === void 0) this.streams.start();
\t\t\t\tlet disposed = false;`,
  `\t\t\t\tif (connection.rpc.open === void 0) this.streams.start();
\t\t\t\tif (connection.rpc.open === void 0 && window.__DSH_IOS_CONNECTION_RECOVERY__ !== void 0) ctx.effect(() => window.__DSH_IOS_CONNECTION_RECOVERY__.install({
\t\t\t\t\tconnection,
\t\t\t\t\topenProbe: (signal) => this.streams.open("session/control", { args: {} }, signal)
\t\t\t\t}), "iOS connection recovery");
\t\t\t\tlet disposed = false;`,
  "iOS event stream recovery",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  'const requireSharp = createLazyRequire("sharp", import.meta.url);',
  '// iOS patch: ImageIO/CoreGraphics facade replaces native libvips\nimport sharp from "../../../ios-sharp-shim.mjs";\nconst requireSharp = () => sharp;',
  "attachment image backend",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `\tconst { data, info } = await (mediaType === "image/webp" ? pipeline.webp({
\t\tquality,
\t\teffort: 0
\t}) : pipeline.jpeg({ quality })).toBuffer({ resolveWithObject: true });`,
  `\tconst encoder = mediaType === "image/webp" ? pipeline.webp({
\t\tquality,
\t\teffort: 0
\t}) : mediaType === "image/png" ? pipeline.png() : pipeline.jpeg({ quality });
\tconst { data, info } = await encoder.toBuffer({ resolveWithObject: true });`,
  "attachment ImageIO encoding dispatch",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `\tconst mediaType = hasAlpha ? "image/webp" : "image/jpeg";
\treturn IMAGE_ENCODING_QUALITIES.map((quality) => (() => encode(prepared.clone(), mediaType, quality)));`,
  `\tif (hasAlpha) return [() => encode(prepared.clone(), "image/png", void 0)];
\treturn IMAGE_ENCODING_QUALITIES.map((quality) => (() => encode(prepared.clone(), "image/jpeg", quality)));`,
  "attachment ImageIO encoding ladder",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `const REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-v6";`,
  `const REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-v6-ios-imageio-1";`,
  "attachment request-image transform identity",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  `\t\t\twebpQualities: IMAGE_ENCODING_QUALITIES,
\t\t\twebpEffort: 0,
\t\t\tjpegQualities: IMAGE_ENCODING_QUALITIES,
\t\t\torder: ["alpha:webp", "opaque:jpeg"],`,
  `\t\t\tpngForAlpha: true,
\t\t\tjpegQualities: IMAGE_ENCODING_QUALITIES,
\t\t\torder: ["alpha:png", "opaque:jpeg"],`,
  "attachment request-image descriptor",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/node-addon-system/lib/flock.js",
  `    if (platform !== 'linux' && platform !== 'darwin') {
        throw Object.assign(new Error(\`flock is not supported on \${platform}-\${arch}\`), {
            code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
            syscall: 'flock',
        });
    }`,
  `    if (platform === 'ios') {
        // iOS patch: official darwin-arm64 system.node is macOS Mach-O.
        const iosRequire = createRequire(import.meta.url);
        binding = iosRequire('../prebuilds/ios-arm64/system.node');
        return binding;
    }
    if (platform !== 'linux' && platform !== 'darwin') {
        throw Object.assign(new Error(\`flock is not supported on \${platform}-\${arch}\`), {
            code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
            syscall: 'flock',
        });
    }`,
  "iOS flock prebuild",
);

await replaceExactlyOnce(
  "lib/bin.js",
  "if (import.meta.main) await runCli();",
  'if (import.meta.main) await runCli({ packageManager: { command: process.execPath, args: ["/var/jb/usr/local/lib/pnpm10/bin/pnpm.cjs"] } });',
  "iOS installation-owned pnpm launcher",
);

await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml",
  `    - id: workspace-controller
      name: '@deepseek-ai/dsh-api-workspace-controller'
`,
  `    - id: workspace-controller
      name: '@deepseek-ai/dsh-api-workspace-controller'

    # Rootless iOS system notifications for goal completion/blocking and
    # pending confirmation. Its URL action opens the originating Web session.
    - id: ios-notifier
      name: 'file:///var/jb/usr/local/lib/dsh/node_modules/@deepseek-ai/dsh-ios-notifier/index.mjs'
`,
  "iOS notification composition",
);

const mimeTail =
  '\t".webmanifest": "application/manifest+json",\n\t".gz": "application/gzip"\n};';
const mimeTailWithPng =
  '\t".webmanifest": "application/manifest+json",\n\t".gz": "application/gzip",\n\t".png": "image/png"\n};';
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
  '/(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu';
const compatibleEmailRegExp =
  '/([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)/gu';
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-DcuzkuQH.js",
  unsupportedEmailRegExp,
  compatibleEmailRegExp,
  "Safari 16 GFM email regexp",
);
await replaceExactlyOnce(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js",
  'from"./vendor-DcuzkuQH.js"',
  'from"./vendor-DcuzkuQH.js?ioscompat=18"',
  "frontend vendor cache key",
);
await installNewFile(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/apple-touch-icon.png",
  resolve(repositoryRoot, "web/apple-touch-icon.png"),
  "iOS Home Screen icon",
);
for (const extension of ["js", "css"]) {
  await installNewFile(
    `node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-ios-mobile-shell.${extension}`,
    resolve(repositoryRoot, `web/mobile-shell.${extension}`),
    `iPhone floating sidebar ${extension}`,
  );
}
await installNewFile(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/dsh-ios-connection-recovery.js",
  resolve(repositoryRoot, "web/connection-recovery.js"),
  "iOS connection recovery helper",
);
await installExactFile(
  "node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
  resolve(repositoryRoot, "web/index.ios.html"),
  "3a402b94efa1253d80666438e60ed89d0b5cf1fd07d24a2f59731623e9bd8a49",
  "Safari 16 entry document",
);

await installFrontendSyntax(repositoryRoot, runtimeRoot, checkOnly);
process.stdout.write(`DSH ${dshPackage.version} iOS compatibility ${checkOnly ? "verified" : "applied"}\n`);
