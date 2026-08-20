#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const defaultLayout = new URL("../web/plugins/ui-layout-client.js", import.meta.url);
const defaultSidebar = new URL("../web/plugins/ui-sidebar-client.js", import.meta.url);
const defaultConversation = new URL("../web/plugins/ui-conversation-client.js", import.meta.url);
const layoutPath = process.argv[2] ?? defaultLayout;
const sidebarPath = process.argv[3] ?? defaultSidebar;
const conversationPath = process.argv[4] ?? defaultConversation;
const settingsPath = process.argv[5];

if (
  process.argv[2] !== undefined
  || process.argv[3] !== undefined
  || process.argv[4] !== undefined
  || process.argv[5] !== undefined
) {
  assert.ok(
    process.argv[2] && process.argv[3] && process.argv[4] && process.argv[5],
    "pass layout, sidebar, conversation, and settings bundle paths",
  );
}

const [layout, sidebar, conversation, settingsPatch, settings] = await Promise.all([
  readFile(layoutPath, "utf8"),
  readFile(sidebarPath, "utf8"),
  readFile(conversationPath, "utf8"),
  readFile(new URL("../patches/dsh-rc7-ios-floating-sidebar.patch", import.meta.url), "utf8"),
  settingsPath === undefined ? undefined : readFile(settingsPath, "utf8"),
]);

assert.ok(layout.includes('"data-floating-sidebar"'), "floating layout marker is missing");
assert.ok(layout.includes("sidebarBackdrop"), "sidebar backdrop is missing");
assert.ok(layout.includes('event.key === "Escape"'), "Escape-to-close behavior is missing");
assert.ok(layout.includes("narrow ? 0 : cols.sidebar"), "narrow layout still reserves sidebar width");
assert.ok(layout.includes("@media (max-width:1023px)"), "narrow layout media query is missing");
assert.ok(layout.includes("position:absolute"), "floating sidebar positioning is missing");
for (const column of [1, 2, 3]) {
  assert.ok(
    layout.includes(`grid-column:${column}`),
    `explicit grid placement for column ${column} is missing`,
  );
}

assert.ok(sidebar.includes("primaryArea"), "upper function group is missing");
assert.ok(sidebar.includes("settingsArea"), "independent Settings group is missing");
assert.ok(
  sidebar.includes("--dsh-mobile-sidebar-launcher-size:48px"),
  "single mobile whale launcher is missing",
);
assert.equal(sidebar.includes("margin-top:auto"), false, "legacy bottom Settings floater remains");
assert.ok(sidebar.includes("pointer-events:none"), "collapsed floating rail behavior is missing");
assert.ok(
  sidebar.includes("@media (max-width:1023px)"),
  "mobile launcher media query is missing",
);

assert.ok(
  conversation.includes("@media (max-width:1023px)"),
  "mobile header media query is missing",
);
assert.ok(
  conversation.includes("padding-left:max(68px, calc(env(safe-area-inset-left) + 64px))"),
  "mobile header does not clear the whale launcher",
);

assert.ok(
  settingsPatch.includes("@media (max-width: 680px)"),
  "narrow Settings source media query is missing",
);
assert.ok(
  settingsPatch.includes("overflow-x: auto"),
  "narrow Settings navigation is not horizontally scrollable",
);
assert.ok(
  settingsPatch.includes("padding: max(8px, env(safe-area-inset-top))"),
  "narrow Settings panel does not respect the iOS safe area",
);

if (settings !== undefined) {
  assert.ok(settings.includes("@media (max-width:680px)"), "narrow Settings bundle media query is missing");
  assert.ok(settings.includes("flex-direction:column"), "narrow Settings bundle still uses two columns");
  assert.ok(settings.includes("overflow-x:auto"), "narrow Settings bundle tabs cannot scroll");
  assert.ok(settings.includes("safe-area-inset-top"), "narrow Settings bundle ignores safe areas");
  assert.ok(settings.includes("width:44px;height:44px"), "narrow Settings close target is too small");
  assert.ok(settings.includes("@media (max-width:390px)"), "very narrow Settings rows do not stack");
  assert.ok(settings.includes("[class$='_rowText']{padding-right:0}"), "stacked Settings labels remain squeezed");
}

for (const [name, bundle] of [
  ["layout", layout],
  ["sidebar", sidebar],
  ["conversation", conversation],
  ...(settings === undefined ? [] : [["settings", settings]]),
]) {
  assert.equal(
    bundle.includes("@media (width<=1023px)"),
    false,
    `${name} bundle still uses Safari 16.4-only media range syntax`,
  );
}

console.log("iOS floating sidebar checks passed");
