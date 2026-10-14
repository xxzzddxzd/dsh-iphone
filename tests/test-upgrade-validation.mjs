import assert from "node:assert/strict";
import { compareBaseline, validateSmokeFrames } from "../scripts/upgrade-host.mjs";

const marker = "DSH_TEST_MARKER";
const event = (type, data) => ({ type: "event", event: { type, data } });
function fixture(text = `${marker}\n[Command finished with exit code 0]`, isError = false) {
  return [
    event("tool/call", { name: "bash", callId: "call-test" }),
    event("tool/result", { message: { toolCallId: "call-test", isError, content: [{ type: "text", text }] } }),
    { type: "assistant-stream" }, event("turn/end", { reason: { kind: "completed" } }),
  ];
}
assert.equal(validateSmokeFrames(fixture(), marker).bashExitCode, 0);
assert.equal(validateSmokeFrames(fixture(`${marker}\n[shell exited: code 0]`), marker).bashExitCode, 0);
assert.throws(() => validateSmokeFrames(fixture(`${marker}\n[Command finished with exit code 0]`, true), marker), /Bash did not/);
assert.throws(() => validateSmokeFrames(fixture("Error: PTY shell exited during startup", true), marker), /Bash did not/);
assert.throws(() => validateSmokeFrames(fixture(`${marker}\n[Command finished with exit code 1]`), marker), /Bash did not/);
assert.throws(() => validateSmokeFrames(fixture("another output\n[Command finished with exit code 0]"), marker), /Bash did not/);
assert.throws(() => validateSmokeFrames(fixture().filter(frame => frame.type !== "assistant-stream"), marker), /No assistant streaming/);
assert.throws(() => validateSmokeFrames(fixture().slice(0, -1), marker), /did not complete/);
assert.throws(() => validateSmokeFrames([event("tool/call", { name: "read_file", callId: "other" }), ...fixture()], marker), /exactly one/);
const mismatched = fixture();
mismatched[1].event.data.message.toolCallId = "another-call";
assert.throws(() => validateSmokeFrames(mismatched, marker), /Bash did not/);
const modelFrames = [event("request/header", { header: { config: { provider: "provider-codex", model: "gpt-6.1-sol" } } }), ...fixture()];
assert.equal(validateSmokeFrames(modelFrames, marker, { provider: "provider-codex", model: "gpt-6.1-sol" }).bashExitCode, 0);
assert.throws(() => validateSmokeFrames(modelFrames, marker, { provider: "provider-codex", model: "gpt-6-sol" }), /required model/);
assert.throws(() => validateSmokeFrames(fixture(), marker, { provider: "provider-codex", model: "gpt-6.1-sol" }), /required model/);

const before = { sessionIds: ["original"], defaultModel: { provider: "provider-a", model: "model-a" } };
assert.doesNotThrow(() => compareBaseline(before, { ...before, sessionIds: ["original", "smoke"] }));
assert.throws(() => compareBaseline(before, { ...before, sessionIds: [] }), /original session/);
assert.throws(() => compareBaseline(before, { ...before, defaultModel: { provider: "provider-b", model: "model-b" } }), /Default model changed/);
console.log("Upgrade validation rejects false-success, missing sessions and changed defaults");
