#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const defaultLayout = new URL("../web/plugins/ui-layout-client.js", import.meta.url);
const defaultSidebar = new URL("../web/plugins/ui-sidebar-client.js", import.meta.url);
const layoutPath = process.argv[2] ?? defaultLayout;
const sidebarPath = process.argv[3] ?? defaultSidebar;

if (process.argv[2] !== undefined || process.argv[3] !== undefined) {
  assert.ok(process.argv[2] && process.argv[3], "pass both layout and sidebar bundle paths");
}

const [layout, sidebar] = await Promise.all([
  readFile(layoutPath, "utf8"),
  readFile(sidebarPath, "utf8"),
]);

assert.ok(layout.includes('"data-floating-sidebar"'), "floating layout marker is missing");
assert.ok(layout.includes("sidebarBackdrop"), "sidebar backdrop is missing");
assert.ok(layout.includes('event.key === "Escape"'), "Escape-to-close behavior is missing");
assert.ok(layout.includes("narrow ? 0 : cols.sidebar"), "narrow layout still reserves sidebar width");
assert.ok(layout.includes("@media (width<=1023px)"), "narrow layout media query is missing");
assert.ok(layout.includes("position:absolute"), "floating sidebar positioning is missing");
for (const column of [1, 2, 3]) {
  assert.ok(
    layout.includes(`grid-column:${column}`),
    `explicit grid placement for column ${column} is missing`,
  );
}

assert.ok(sidebar.includes("primaryArea"), "upper function group is missing");
assert.ok(sidebar.includes("settingsArea"), "independent Settings group is missing");
assert.ok(sidebar.includes("margin-top:auto"), "Settings is not pinned to the bottom");
assert.ok(sidebar.includes("pointer-events:none"), "collapsed floating rail behavior is missing");

console.log("iOS floating sidebar checks passed");
