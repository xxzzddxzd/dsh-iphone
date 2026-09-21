#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packages = [
  "dsh-client-ui-layout",
  "dsh-client-ui-sidebar",
  "dsh-client-ui-conversation",
  "dsh-client-ui-settings-general",
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

console.log("official Web UI packages remain unchanged on iPhone");
