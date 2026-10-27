#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packages = [
  "dsh-client-ui-layout",
  "dsh-client-ui-sidebar",
  "dsh-client-ui-conversation",
  "dsh-client-ui-settings-general",
  "dsh-client-ui-theme",
];

for (const packageName of packages) {
  const locked = await readFile(new URL(
    `../dsh-runtime/node_modules/@deepseek-ai/${packageName}/lib/client.js`,
    import.meta.url,
  ));
  const packaged = await readFile(new URL(
    `../build/dsh-runtime/node_modules/@deepseek-ai/${packageName}/lib/client.js`,
    import.meta.url,
  ));
  assert.deepEqual(
    packaged,
    locked,
    `${packageName} must stay byte-identical to the official locked npm package`,
  );
}

const layout = await readFile(new URL(
  "../build/dsh-runtime/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js",
  import.meta.url,
), "utf8");
assert.match(layout, /SIDEBAR_AUTO_COLLAPSE/);
assert.match(layout, /narrowExpanded/);

// The mobile shell uses these versioned selectors around the official UI.
// An upstream class change must be reviewed instead of silently losing the drawer.
for (const [packageName, selectors] of [
  ["dsh-client-ui-layout", ["pI_x6G_frame", "pI_x6G_sidebarCol", "pI_x6G_centerCol", "pI_x6G_rightbarCol"]],
  ["dsh-client-ui-sidebar", ["hHd-Xa_toggle", "hHd-Xa_root", "hHd-Xa_logoRow", "hHd-Xa_railMark"]],
  ["dsh-client-ui-conversation", ["wSkVaW_header"]],
  ["dsh-client-ui-settings-general", ["VOzbGW_overlay", "VOzbGW_panel", "VOzbGW_navList"]],
]) {
  const source = await readFile(new URL(`../dsh-runtime/node_modules/@deepseek-ai/${packageName}/lib/client.js`, import.meta.url), "utf8");
  for (const selector of selectors) assert.ok(source.includes(`"${selector}"`), `mobile shell selector changed: ${selector}`);
}

// The mobile shell also keys off data attributes: the portaled menu surface that
// owns a search field, and the transcript's scrollport and follow-tail state.
for (const [entry, needles] of [
  // Pure primitives are inlined into the published frontend entry in 0.2.1.
  ["dsh-web-frontend/dist/assets/index-CN7NIWNw.js", ['"data-menu-material"']],
  ["dsh-client-ui-chat/lib/client.js", ['"data-chat-following-tail"', "[data-conversation-scroll]"]],
]) {
  const source = await readFile(new URL(`../dsh-runtime/node_modules/@deepseek-ai/${entry}`, import.meta.url), "utf8");
  for (const needle of needles) assert.ok(source.includes(needle), `mobile shell hook changed: ${needle}`);
}

console.log("official Web UI packages remain unchanged on iPhone");
