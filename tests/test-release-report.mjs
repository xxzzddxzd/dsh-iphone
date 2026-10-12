import assert from "node:assert/strict";
import { releaseReport } from "../scripts/check-dsh-update.mjs";

const commit = "a".repeat(40);
const pins = { DSH_VERSION: "1.0.0", DSH_UPSTREAM_COMMIT: commit, DSH_NPM_INTEGRITY: "sha512-fixture" };
const lock = { packages: { "node_modules/@deepseek-ai/dsh": { dependencies: { retained: "1", removed: "1" }, engines: { node: ">=22" } } } };
const registry = { "dist-tags": { latest: "1.0.0", next: "1.1.0-rc.1" }, time: { "1.0.0": "2026-10-12T00:00:00.000Z" },
  versions: { "1.0.0": { name: "@deepseek-ai/dsh", version: "1.0.0", dist: { integrity: "sha512-fixture" }, dependencies: { retained: "1", removed: "1" }, engines: { node: ">=24" } } } };
const refs = `${"b".repeat(40)}\trefs/tags/dsh-v1.0.0\n${commit}\trefs/tags/dsh-v1.0.0^{}\n`;
const report = releaseReport(pins, lock, registry, refs);
assert.equal(report.status, "current", "a higher next tag must not trigger an upgrade");
assert.equal(report.commit, commit, "annotated tags must resolve to the peeled commit");
assert.deepEqual(report.dependencyChanges, []);
assert.equal(report.nodeEngine, ">=24");
assert.equal(releaseReport({ ...pins, DSH_VERSION: "0.9.0" }, lock, registry, refs).status, "update-available");
const changed = structuredClone(registry);
changed.versions["1.0.0"].dependencies = { retained: "2", added: "1" };
assert.deepEqual(releaseReport({ ...pins, DSH_VERSION: "0.9.0" }, lock, changed, refs).dependencyChanges.map(row => row.name), ["added", "removed", "retained"]);
assert.throws(() => releaseReport(pins, lock, changed, refs), /differs from the pinned lock/);
assert.throws(() => releaseReport(pins, lock, registry, ""), /tag is not available/);
assert.throws(() => releaseReport({ ...pins, DSH_NPM_INTEGRITY: "other" }, lock, registry, refs), /no longer matches/);
assert.throws(() => releaseReport(pins, lock, { ...registry, "dist-tags": { latest: "latest" } }, refs), /Invalid official/);
console.log("Release checking distinguishes latest/next, resolves tags and refuses incomplete or changed releases");
