#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { migrateProviderRows, SEARCH_EVENT } from "../scripts/migrate-provider-history.mjs";

const runtime = fileURLToPath(new URL("../dsh-runtime/", import.meta.url));
const require = createRequire(join(runtime, "package.json"));
const { sessionFormatCatalog: catalog } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-format-catalog")));
const request = {
  endpoint: "https://chatgpt.com/backend-api/codex/alpha/search",
  body: { id: "fixture", model: "fixture", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "preserve this search" }] }],
    commands: { search_query: [{ q: "preserve this search" }] },
    settings: { search_context_size: "medium", allowed_callers: ["direct"], external_web_access: true }, max_output_tokens: 100 },
};
function fixture(version, seeded = false) {
  return [
    { type: "session", version, id: "history-fixture", createdAt: 1, delegationDepth: 0,
      ...(version < 2 ? (seeded ? { seedLength: 3, parentSession: "parent" } : {}) : { isSeeded: seeded }) },
    { type: "turn/start", seq: 0, time: 2, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 3, data: { turn: 1, step: 1 } },
    { type: SEARCH_EVENT, seq: 2, time: 4, data: structuredClone(request) },
    ...(version === 2 && seeded ? [{ type: "session/end-seed", seq: 3, time: 4, data: { inherited: true } }] : []),
  ];
}
for (const version of [0, 1, 2]) {
  for (const seeded of [false, true]) {
    const rows = fixture(version, seeded);
    const before = JSON.stringify(rows);
    const result = migrateProviderRows(rows, catalog);
    assert.equal(JSON.stringify(rows), before, "source must remain unchanged");
    assert.equal(result.rows[0].version, 3);
    const event = result.rows.find(row => row.type === SEARCH_EVENT);
    assert.deepEqual(event.data, request);
    assert.equal(event.time, 4);
    assert.equal(event.seq, 3, "official system-head insertion must remap provider sequence");
    assert.equal(event.ignorable, true);
    assert.equal(result.rows.filter(row => row.type === "system/message").length, 1);
    if (seeded) assert.equal(result.rows.at(-1).type, "session/end-seed");
    assert.ok(!JSON.stringify(result.rows).includes("migration-only"));
  }
}
const unknown = fixture(0);
const descriptor = fixture(0);
descriptor[3] = { type: "subagent/descriptor", seq: 2, time: 4, data: {
  version: 2, mode: "continuable", provider: "delegate", label: "fixture", agentProvider: "mock", agentModel: "mock", persona: "retained", toolFilter: { deny: ["shell"] },
} };
const descriptorResult = migrateProviderRows(descriptor, catalog);
assert.equal(descriptorResult.descriptors, 1);
assert.deepEqual(descriptorResult.rows.find(row => row.type === "subagent/descriptor").data, { ...descriptor[3].data, version: 3 });
assert.equal(descriptor[3].data.version, 2);
descriptor[3].data.unreviewedSequenceReference = 1;
assert.throws(() => migrateProviderRows(descriptor, catalog), /unknown v2 descriptor field/);
unknown[3].type = "another-plugin/unknown";
unknown[3].ignorable = true;
assert.throws(() => migrateProviderRows(unknown, catalog), /unknown historical event/);
const malformed = fixture(0);
malformed[3].data.body.unreviewedSequenceReference = 2;
assert.throws(() => migrateProviderRows(malformed, catalog), /unsupported Codex search body/);

const directory = await mkdtemp(join(tmpdir(), "dsh-history-test-"));
try {
  const original = fixture(0).map(row => JSON.stringify(row)).join("\n") + "\n";
  const source = join(directory, "session.jsonl");
  await writeFile(source, original);
  const wrapper = fileURLToPath(new URL("../scripts/migrate-provider-history.py", import.meta.url));
  const run = () => execFileSync("python3", [wrapper, runtime, directory, "--node", process.execPath, "--apply"], { encoding: "utf8" });
  assert.match(run(), /1 candidate\(s\), 0 failure/);
  assert.equal(await readFile(source, "utf8"), original);
  const current = await readFile(join(directory, "session.v3.jsonl"), "utf8");
  assert.match(run(), /0 candidate\(s\), 0 failure/);
  assert.equal(await readFile(join(directory, "session.v3.jsonl"), "utf8"), current);
  assert.ok((await readdir(directory)).every(name => !name.endsWith(".tmp")));
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("provider history: official sequence migration, payload preservation, refusal and atomic publication passed");
