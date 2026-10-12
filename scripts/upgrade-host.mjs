import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { launchUrl, exchange } from "./web-auth.mjs";

const require = createRequire(new URL("../dsh-runtime/package.json", import.meta.url));

export class UpgradeHost {
  constructor(url, cookie, WebSocket) {
    this.base = new URL("/", url);
    this.cookie = cookie;
    this.pending = new Map();
    this.socket = new WebSocket(new URL("api/remote.mux", this.base).href.replace(/^http/, "ws"), {
      headers: { cookie, origin: this.base.origin },
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("WebSocket connection timed out")); this.close(); }, 15000);
      this.socket.once("open", () => { clearTimeout(timer); resolve(); });
      this.socket.once("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); });
      this.socket.once("close", () => { clearTimeout(timer); reject(new Error("WebSocket closed before ready")); });
    });
    this.ready.catch(() => {});
    this.socket.on("message", data => {
      let frame;
      try { frame = JSON.parse(data.toString()); }
      catch { this.failAll(new Error("Invalid WebSocket frame")); return; }
      const pending = this.pending.get(frame.streamId);
      if (!pending) return;
      if (frame.type === "error") pending.finish(new Error(`Stream ${pending.endpoint} failed (${frame.error?.code ?? "unknown"})`));
      else if (frame.type === "complete") pending.finish(new Error(`Stream ${pending.endpoint} ended before its expected result`));
      else if (frame.type === "item") {
        try {
          const value = pending.accept(frame.value);
          if (value !== undefined) pending.finish(null, value);
        } catch (error) { pending.finish(error); }
      }
    });
    this.socket.on("error", () => this.failAll(new Error("WebSocket transport failed")));
    this.socket.on("close", () => this.failAll(new Error("WebSocket closed")));
  }

  static async connect(target) {
    const url = await launchUrl(target);
    const { cookie } = await exchange(url);
    const host = new UpgradeHost(url, cookie, require("ws"));
    try { await host.ready; }
    catch (error) { host.close(); throw error; }
    return host;
  }

  async rpc(endpoint, args) {
    const response = await fetch(new URL(`api/${endpoint}`, this.base), {
      method: "POST",
      headers: { cookie: this.cookie, origin: this.base.origin, "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`RPC ${endpoint} returned HTTP ${response.status}`);
    const envelope = await response.json();
    if (!envelope.result?.ok) throw new Error(`RPC ${endpoint} failed (${envelope.result?.error?.code ?? "invalid-response"})`);
    return envelope.result.value;
  }

  stream(endpoint, args, accept, timeoutMs = 20000) {
    const id = randomUUID();
    let finish;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Stream ${endpoint} timed out`)), timeoutMs);
      finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (this.socket.readyState === 1) this.socket.send(JSON.stringify({ type: "cancel", streamId: id }));
        if (error) reject(error); else resolve(value);
      };
      this.pending.set(id, { endpoint, accept, finish });
      this.socket.send(JSON.stringify({ type: "open", streamId: id, endpoint, payload: { args } }));
    });
    result.catch(() => {});
    return { result, cancel: () => finish(new Error(`Stream ${endpoint} cancelled`)) };
  }

  failAll(error) { for (const pending of [...this.pending.values()]) pending.finish(error); }
  close() {
    this.failAll(new Error("Validation client closed"));
    if (this.socket.readyState === 1) this.socket.close(); else this.socket.terminate();
  }

  async snapshot(sessionId) {
    return this.stream("session/follow", { request: {
      address: { kind: "session", sessionId }, maxMessages: 1,
    } }, frame => frame.type === "snapshot" ? frame : undefined).result;
  }

  async health() {
    const control = await this.stream("session/control", {}, frame => frame.type === "baseline" ? frame.value : undefined).result;
    if (!control || typeof control.projections !== "object") throw new Error("Unsupported session/control baseline; audit the new API");
    const sessions = await this.rpc("session/list", { _request: {} });
    const catalog = await this.rpc("session/modelCatalog", {});
    if (!Array.isArray(sessions.items) || !Array.isArray(catalog.groups) || !catalog.default) throw new Error("Unsupported session/model catalog response");
    for (const row of sessions.items) {
      if (typeof row.sessionId !== "string" || typeof row.running !== "boolean") throw new Error("Unsupported session-list row");
    }
    const old = sessions.items.find(row => !row.blank && !row.sessionId.startsWith("session-upgrade-"));
    const snapshot = old ? await this.snapshot(old.sessionId) : undefined;
    return {
      sessionIds: sessions.items.map(row => row.sessionId).sort(),
      running: sessions.items.filter(row => row.running).length,
      oldSessionVersion: snapshot?.header.version ?? null,
      defaultModel: catalog.default,
      providerCount: catalog.groups.length,
      catalogFailures: catalog.failures?.length ?? null,
    };
  }
}

export function compareBaseline(before, after) {
  if (!Array.isArray(before.sessionIds)) throw new Error("Unsupported saved baseline");
  const current = new Set(after.sessionIds);
  const missing = before.sessionIds.filter(id => !current.has(id));
  if (missing.length) throw new Error(`${missing.length} original session(s) are missing`);
  if (!isDeepStrictEqual(before.defaultModel, after.defaultModel)) throw new Error("Default model changed; verify the migration before accepting the upgrade");
}

export function validateSmokeFrames(frames, marker) {
  const events = frames.filter(frame => frame.type === "event").map(frame => frame.event);
  const calls = events.filter(event => event.type === "tool/call");
  if (calls.length !== 1 || calls[0].data.name !== "bash") throw new Error("Smoke test must execute exactly one Bash call");
  const result = events.find(event => event.type === "tool/result" && event.data.message.toolCallId === calls[0].data.callId)?.data.message;
  const text = (result?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
  if (result?.isError !== false || !text.includes(marker) || !/\[(?:Command finished with exit code 0|shell exited: code 0)\]/.test(text)) {
    throw new Error("Bash did not return the marker with exit code 0");
  }
  if (events.filter(event => event.type === "turn/end").at(-1)?.data.reason.kind !== "completed") throw new Error("Smoke turn did not complete");
  const streamFrames = frames.filter(frame => frame.type === "assistant-stream").length;
  if (!streamFrames) throw new Error("No assistant streaming frames observed");
  return { bashExitCode: 0, streamFrames, turn: "completed" };
}
