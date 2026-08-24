#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [shim, nativeSource, buildScript, packageScript, postInstall] = await Promise.all([
  readFile(new URL("../shims/ios-sharp-shim.mjs", import.meta.url), "utf8"),
  readFile(new URL("../ios/image/DSHImageTool.m", import.meta.url), "utf8"),
  readFile(new URL("../scripts/build-ios-image-tool.sh", import.meta.url), "utf8"),
  readFile(new URL("../scripts/package-dsh.sh", import.meta.url), "utf8"),
  readFile(new URL("../packaging/dsh/postinst", import.meta.url), "utf8"),
]);

assert.match(shim, /\/var\/jb\/usr\/local\/bin\/dsh-image-tool/);
assert.match(shim, /rotate\(\)/);
assert.match(shim, /toColourspace\(colourspace\)/);
assert.match(shim, /resize\(options\)/);
assert.match(shim, /toBuffer\(options = \{\}\)/);
assert.match(shim, /WebP output is unavailable/);
assert.match(nativeSource, /CGImageSourceCreateImageAtIndex/);
assert.match(nativeSource, /CGImageSourceCreateThumbnailAtIndex/);
assert.match(nativeSource, /CGColorSpaceCreateWithName\(kCGColorSpaceSRGB\)/);
assert.match(nativeSource, /CGImageDestinationFinalize/);
assert.match(buildScript, /-framework CoreGraphics/);
assert.match(buildScript, /-framework ImageIO/);
assert.match(packageScript, /build-ios-image-tool\.sh/);
assert.match(packageScript, /dsh-image-tool/);
assert.match(postInstall, /ldid -S \/var\/jb\/usr\/local\/bin\/dsh-image-tool/);

const patchedAttachment = await readFile(new URL(
  "../build/dsh-runtime/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js",
  import.meta.url,
), "utf8").catch(() => "");
if (patchedAttachment !== "") {
  assert.match(patchedAttachment, /request-image-v4-ios-imageio-1/);
  assert.match(patchedAttachment, /"low-colour:png-jpeg"/);
  assert.match(patchedAttachment, /"alpha:png"/);
  assert.doesNotMatch(patchedAttachment, /webpQualities: REQUEST_IMAGE_QUALITIES/);
}

console.log("iOS ImageIO image backend checks passed");
