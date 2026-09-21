#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readFile, link, unlink, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SEARCH_EVENT = "web/openai-codex-search-llm-request";
const CARRIER = "web/deepseek-search-llm-request";
const hash = value => createHash("sha256").update(value).digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function validateSearch(row) {
  assert.ok(Object.keys(row).every(key => ["type", "seq", "time", "data", "ignorable"].includes(key)), "unknown search event envelope field");
  const data = row.data;
  assert.ok(isObject(data) && Object.keys(data).sort().join() === "body,endpoint", "invalid Codex search record");
  assert.equal(data.endpoint, "https://chatgpt.com/backend-api/codex/alpha/search", "unexpected Codex search endpoint");
  const body = data.body;
  assert.ok(isObject(body) && Object.keys(body).sort().join() === "commands,id,input,max_output_tokens,model,settings", "unsupported Codex search body");
  assert.ok(typeof body.id === "string" && typeof body.model === "string", "invalid search identifiers");
  assert.ok(Array.isArray(body.input) && body.input.every(message =>
    isObject(message) && Object.keys(message).sort().join() === "content,role,type" &&
    message.type === "message" && message.role === "user" &&
    Array.isArray(message.content) && message.content.every(part =>
      isObject(part) && Object.keys(part).sort().join() === "text,type" &&
      part.type === "input_text" && typeof part.text === "string")), "unsupported search input");
  assert.ok(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0, "invalid search output budget");
  assert.ok(isObject(body.commands) && Object.keys(body.commands).join() === "search_query", "unsupported search commands");
  assert.ok(Array.isArray(body.commands.search_query) && body.commands.search_query.length === 1 && typeof body.commands.search_query[0].q === "string", "invalid search query");
  assert.ok(isObject(body.settings), "invalid search settings");
  assert.ok(Object.keys(body.settings).every(key => ["search_context_size", "allowed_callers", "external_web_access"].includes(key)), "unsupported search settings");
  // This plugin-owned record contains no Session sequence coordinates. Its JSON
  // payload is preserved exactly while official migrations remap the envelope.
}

export function migrateProviderRows(rows, catalog) {
  const [header, ...events] = rows;
  assert.equal(catalog.currentVersion, 3, "review recovery tool before changing target format");
  assert.ok([0, 1, 2].includes(header.version), "expected predecessor format");
  const records = new Map();
  let descriptors = 0;
  const marker = `urn:dsh-codex-history:${randomUUID()}:`;
  const restore = catalog.createRestore(header, { recovery: "strict", validation: "current" });
  for (const row of events) {
    if (row.type === "subagent/descriptor" && row.data?.version === 2) {
      // Released descriptor v3 only adds optional agentReasoningEffort (official
      // commit f76a225a7d). All v2 fields have the same meaning and no sequence
      // references. Reject extra fields before the official v3 schema validator.
      assert.ok(Object.keys(row.data).every(key => ["version", "mode", "provider", "label", "agentProvider", "agentModel", "persona", "toolFilter"].includes(key)), "unknown v2 descriptor field");
      restore.decodeRow({ ...row, data: { ...row.data, version: 3 } });
      descriptors += 1;
      continue;
    }
    if (row.type !== SEARCH_EVENT) { restore.decodeRow(row); continue; }
    validateSearch(row);
    const key = marker + records.size;
    records.set(key, row);
    // The frozen official chain has no extension hook. A private in-memory,
    // non-surface carrier keeps this row in sequence remapping. It is replaced
    // with the original provider event before any output is encoded or written.
    restore.decodeRow({ ...row, type: CARRIER, data: {
      endpoint: key, apiVersion: "dsh-codex-history-identity",
      body: { model: "migration-only", max_tokens: 1,
        messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      },
    } });
  }
  assert.ok(records.size + descriptors > 0, "no supported historical extensions to migrate");
  const migrated = restore.finish();
  let restored = 0;
  const currentEvents = migrated.events.map(event => {
    const original = event.type === CARRIER ? records.get(event.data?.endpoint) : undefined;
    if (!original) return event;
    restored += 1;
    // The search request is diagnostic metadata. Marking it ignorable permits
    // offline/current readers without the provider to retain its exact payload.
    return { type: SEARCH_EVENT, seq: event.seq, time: original.time, data: original.data, ignorable: true };
  });
  assert.equal(restored, records.size, "official migration lost a provider record");
  const encoded = [catalog.encodeCurrentHeader(migrated.header, migrated.inheritedEventCount), ...currentEvents.map(event => catalog.encodeCurrentEvent(event))];
  const verify = catalog.createRestore(encoded[0], { recovery: "strict", validation: "current" });
  for (const row of encoded.slice(1)) verify.decodeRow(row);
  const verified = verify.finish();
  assert.deepEqual(verified.events, currentEvents, "current-generation round trip changed events");
  assert.ok(!JSON.stringify(encoded).includes(marker), "temporary carrier escaped into output");
  return { rows: encoded, records: restored, descriptors, events: currentEvents.length };
}

async function main() {
  const [runtime, source, mode, lockFd] = process.argv.slice(2);
  assert.ok(runtime && source, "usage: migrate-provider-history.mjs <dsh-runtime> <session.jsonl> [--apply <locked-fd>]");
  const require = createRequire(resolve(runtime, "package.json"));
  const { sessionFormatCatalog } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-format-catalog")).href);
  const original = await readFile(source);
  const rows = original.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const result = migrateProviderRows(rows, sessionFormatCatalog);
  const directory = dirname(source);
  const target = resolve(directory, "session.v3.jsonl");
  if (mode === "--apply") {
    assert.ok(/^\d+$/.test(lockFd ?? ""), "apply requires the Python wrapper's held session.lock descriptor");
    const { fstatSync } = await import("node:fs");
    const held = fstatSync(Number(lockFd));
    const named = await stat(resolve(directory, "session.lock"));
    assert.ok(held.ino === named.ino && held.dev === named.dev, "lock inode changed");
    assert.equal(hash(await readFile(source)), hash(original), "source changed during migration");
    const temporary = resolve(directory, `.dsh-codex-migration-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(result.rows.map(row => JSON.stringify(row)).join("\n") + "\n");
      await file.sync();
    } finally { await file.close(); }
    try {
      await link(temporary, target); // EEXIST never overwrites a committed generation.
      const folder = await open(directory, "r");
      try { await folder.sync(); } finally { await folder.close(); }
    } finally { await unlink(temporary); }
    assert.equal(hash(await readFile(source)), hash(original), "original generation changed");
  } else {
    assert.ok(mode === undefined, "unknown mode");
  }
  console.log(JSON.stringify({ session: rows[0].id, mode: mode ?? "dry-run", records: result.records, descriptors: result.descriptors, events: result.events, sourceSha256: hash(original), targetVersion: 3 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => {
    // Validators can carry user payloads in assertion diagnostics. Print only
    // the first message line; no request body, credential, or conversation text.
    console.error(String(error.message).split("\n", 1)[0]);
    process.exitCode = 1;
  });
}
