#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../web/connection-recovery.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup(initialState = "connected", hostname = "example.test") {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const browser = new EventTarget();
  const document = new EventTarget();
  const consoleCalls = [];
  const browserConsole = { error: (...args) => consoleCalls.push(args) };
  const originalConsoleError = browserConsole.error;
  document.visibilityState = "visible";
  // A reconnect must not replace the document or mutate a user's draft.
  document.draft = "尚未发送的草稿";
  browser.location = { reload() { throw new Error("page reload loses local state"); } };
  const context = vm.createContext({
    window: browser, document, location: { hostname }, AbortController, console: browserConsole,
    Date: { now: () => now },
    setTimeout(fn, delay = 0) { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  let state = initialState;
  let generation = { id: 1 };
  let mode = "healthy";
  let opens = 0;
  let closes = 0;
  let reconnects = 0;
  const listeners = new Set();
  const setState = value => { state = value; for (const fn of [...listeners]) fn(); };
  const connection = {
    state: { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    generation: { getSnapshot: () => generation },
    reconnect() {
      reconnects++;
      setState("connecting");
      generation = { id: generation.id + 1 };
      setState("connected");
    },
  };
  const options = {
    connection,
    openProbe(signal) {
      opens++;
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (mode === "healthy") return Promise.resolve({ done: false, value: { type: "baseline" } });
          if (mode === "invalid") return Promise.resolve({ done: false, value: { type: "unrelated" } });
          // Model a browser whose socket stays OPEN and never dispatches close.
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        return() { closes++; return Promise.resolve({ done: true }); },
      };
    },
  };
  const dispose = browser.__DSH_IOS_CONNECTION_RECOVERY__.install(options);
  async function advance(ms, suspended = false) {
    const end = now + ms;
    while (true) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      now = suspended ? end : first[1].at;
      timers.delete(first[0]); first[1].fn(); await flush();
    }
    now = end; await flush();
  }
  const visibility = value => {
    document.visibilityState = value;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const show = persisted => {
    const event = new Event("pageshow"); Object.defineProperty(event, "persisted", { value: persisted });
    browser.dispatchEvent(event);
  };
  return {
    browser, document, connection, options, dispose, advance, visibility, show, setState,
    browserConsole, originalConsoleError, consoleCalls,
    mode: value => { mode = value; },
    counters: () => ({ opens, closes, reconnects, timers: timers.size, listeners: listeners.size }),
    status: () => browser.__DSH_IOS_CONNECTION_RECOVERY__.status,
  };
}

{
  const t = setup();
  await t.advance(45_000);
  assert.equal(t.counters().opens, 3);
  assert.equal(t.counters().closes, 3);
  assert.equal(t.counters().reconnects, 0);
  assert.equal(t.status().checks, 3);
  t.dispose();
}
{
  const t = setup(); t.mode("stalled");
  await t.advance(20_000);
  assert.equal(t.counters().reconnects, 1);
  assert.equal(t.status().lastReason, "event-stream-unresponsive");
  assert.equal(t.document.draft, "尚未发送的草稿");
  t.mode("healthy"); await t.advance(15_000);
  assert.equal(t.status().checks, 1);
  assert.equal(t.counters().reconnects, 1);
  t.dispose();
}
{
  const t = setup(); t.mode("stalled"); await t.advance(15_000);
  t.visibility("hidden"); await t.advance(60_000);
  assert.equal(t.counters().opens, 1);
  assert.equal(t.counters().reconnects, 0);
  t.visibility("visible"); t.show(true); await flush();
  assert.equal(t.counters().reconnects, 1, "coalesce visibility and BFCache resume events");
  t.dispose();
}
{
  // An app switch that never suspended the web process must not replace the
  // mux: prove it with one control probe instead of reconnecting.
  const t = setup();
  t.visibility("hidden"); await t.advance(500);
  t.visibility("visible"); await t.advance(1_000);
  assert.equal(t.counters().opens, 1, "a brief hide is proven by a probe");
  assert.equal(t.counters().reconnects, 0, "a brief hide keeps the existing mux");
  t.dispose();
}
{
  const t = setup(); t.mode("stalled");
  t.visibility("hidden"); await t.advance(500);
  t.visibility("visible"); await t.advance(6_000);
  assert.equal(t.counters().reconnects, 1, "a brief hide still recovers an unresponsive mux");
  assert.equal(t.status().lastReason, "page-visible");
  t.dispose();
}
{
  const t = setup("connected", "127.0.0.1");
  t.browser.dispatchEvent(new Event("online"));
  assert.equal(t.counters().reconnects, 0, "a radio change cannot affect the on-device Host");
  t.dispose();
}
{
  const t = setup();
  t.browser.dispatchEvent(new Event("online"));
  assert.equal(t.counters().reconnects, 1, "a remote Host still recovers when the network returns");
  t.dispose();
}
{
  const t = setup(); t.show(false); assert.equal(t.counters().reconnects, 0);
  t.show(true); assert.equal(t.counters().reconnects, 1);
  t.dispose();
}
{
  const t = setup(); await t.advance(60_000, true);
  assert.equal(t.counters().reconnects, 1, "recover after suspended JS timers without visibility notification");
  t.dispose();
}
{
  const t = setup("connecting"); await t.advance(60_000);
  assert.equal(t.counters().opens, 0, "do not compete with initial readiness/backoff");
  t.setState("connected"); t.mode("stalled"); await t.advance(15_000);
  t.setState("disconnected"); await t.advance(10_000);
  assert.equal(t.counters().reconnects, 0, "do not treat a replaced generation as an unresponsive one");
  t.dispose();
}
{
  const t = setup(); t.mode("invalid"); await t.advance(15_000);
  assert.equal(t.counters().reconnects, 1, "require a control baseline to prove event delivery");
  t.dispose();
}
{
  const t = setup();
  const newer = t.browser.__DSH_IOS_CONNECTION_RECOVERY__.install(t.options);
  t.dispose(); await t.advance(15_000);
  assert.equal(t.counters().opens, 1, "only one watchdog after plugin replacement");
  newer(); t.browser.dispatchEvent(new Event("online")); t.show(true); await t.advance(30_000);
  assert.equal(t.counters().opens, 1);
  assert.equal(t.counters().reconnects, 0);
  assert.equal(t.counters().listeners, 0);
  assert.equal(t.counters().timers, 0);
}

{
  const t = setup();
  const error = Object.assign(new Error("private conversation content"), { code: "session/protocol-error" });
  for (let i = 0; i < 12; i++) t.browserConsole.error("[session-controller] stream failed:", error);
  assert.equal(t.status().errors.length, 10);
  assert.equal(t.status().errors[0].code, "session/protocol-error");
  assert.equal(t.consoleCalls.length, 12);
  assert.equal(JSON.stringify(t.status()).includes("private conversation content"), false);
  t.dispose();
  assert.equal(t.browserConsole.error, t.originalConsoleError);
}

const client = await readFile(new URL(
  "../build/dsh-runtime/node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js", import.meta.url,
), "utf8");
const watcher = client.match(/function watchBrowserNetwork\(controller\) \{[\s\S]*?^\t\t\}/m)?.[0];
assert.ok(watcher, "locked browser network watcher exists");
for (const [hostname, expected] of [["127.0.0.1", true], ["example.test", false]]) {
  const window = new EventTarget(); window.navigator = { onLine: false };
  const values = [];
  const context = vm.createContext({ window, location: { hostname }, isLoopbackHostname: value => value === "127.0.0.1" });
  const watch = vm.runInContext(`(${watcher})`, context);
  const dispose = watch({ setNetworkAvailable(value) { values.push(value); } });
  window.dispatchEvent(new Event("offline"));
  assert.deepEqual(values, [expected, expected]);
  window.dispatchEvent(new Event("online")); assert.equal(values.at(-1), true);
  dispose(); window.dispatchEvent(new Event("offline")); assert.equal(values.length, 3);
}
console.log("iOS connection recovery: stalled mux, brief app switch, background/BFCache, offline loopback, cancellation and draft preservation passed");
