#!/usr/bin/env node
/** Verify native pairing and read APIs; never submit prompts or persist credentials. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { UpgradeHost } from "./upgrade-host.mjs";
import { readVersionPins } from "./provider-components.mjs";

const requiredCapabilities = ["split-channels", "assistant-stream-v1", "history-format-version", "projection-baseline"];
const failure = code => Object.assign(new Error(code), { nativeCheckCode: code });
const requireValue = (condition, code) => { if (!condition) throw failure(code); };
const validEvents = events => Array.isArray(events) && events.every((event, index) => event
  && typeof event.type === "string" && Number.isSafeInteger(event.seq) && event.seq >= 0
  && (index === 0 || event.seq > events[index - 1].seq));

function validateHello(value, pins, gatewayId, deviceId) {
  requireValue(value.protocol === 3, "unsupported-native-protocol");
  requireValue(value.historyFormatVersion === 4, "unsupported-history-format");
  requireValue(value.dshVersion === pins.DSH_VERSION, "native-host-version-mismatch");
  requireValue(value.gatewayId === gatewayId && value.device?.id === deviceId, "native-identity-mismatch");
  requireValue(value.authenticated === true, "native-authentication-required");
  requireValue(Array.isArray(value.capabilities)
    && requiredCapabilities.every(capability => value.capabilities.includes(capability)), "native-capabilities-incomplete");
}

class NativeWire {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.waiters = new Set();
    this.openings = [];
    this.ready = new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(failure("native-socket-open-timeout")), timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        if (socket.protocol !== "dsh-mobile-v1") reject(failure("native-subprotocol-mismatch")); else accept();
      });
      socket.once("error", () => { clearTimeout(timer); reject(failure("native-socket-open-failed")); });
      socket.once("close", () => { clearTimeout(timer); reject(failure("native-socket-closed")); });
    });
    this.ready.catch(() => {});
    socket.on("message", bytes => {
      let frame;
      try { frame = JSON.parse(bytes.toString()); }
      catch { this.rejectAll(failure("invalid-native-json")); return; }
      if (frame?.kind === "error") { this.rejectAll(failure("native-request-rejected")); return; }
      for (const waiter of this.waiters) {
        if (waiter.match(frame)) { waiter.finish(null, frame); return; }
      }
      // Keep only handshake frames. Unrequested session events can contain private text.
      if (["paired", "hello"].includes(frame?.kind) && this.openings.length < 4) this.openings.push(frame);
    });
    socket.on("error", () => this.rejectAll(failure("native-socket-failed")));
    socket.on("close", () => this.rejectAll(failure("native-socket-closed")));
  }

  wait(kind, predicate = () => true) {
    const match = frame => frame?.kind === kind && predicate(frame);
    const index = this.openings.findIndex(match);
    if (index >= 0) return Promise.resolve(this.openings.splice(index, 1)[0]);
    const promise = new Promise((accept, reject) => {
      const waiter = { match, finish: (error, frame) => {
        if (!this.waiters.delete(waiter)) return;
        clearTimeout(timer);
        if (error) reject(error); else accept(frame);
      } };
      const timer = setTimeout(() => waiter.finish(failure("native-response-timeout")), this.timeoutMs);
      this.waiters.add(waiter);
    });
    promise.catch(() => {});
    return promise;
  }

  async request(type, kind = type, fields = {}) {
    const result = this.wait(kind);
    try { this.socket.send(JSON.stringify({ type, ...fields })); }
    catch { this.rejectAll(failure("native-send-failed")); }
    return result;
  }

  rejectAll(error) { for (const waiter of [...this.waiters]) waiter.finish(error); }

  async close() {
    this.rejectAll(failure("native-check-finished"));
    this.openings.length = 0;
    if (this.socket.readyState === 3) return;
    await new Promise(done => {
      const timer = setTimeout(() => { this.socket.terminate(); done(); }, 500);
      this.socket.once("close", () => { clearTimeout(timer); done(); });
      if (this.socket.readyState === 1) this.socket.close(1000, "acceptance finished"); else this.socket.terminate();
    });
  }
}

/** The caller owns the authenticated Host connection; this check owns only its new device. */
export async function checkNativeGateway(host, { WebSocket, pins, timeoutMs = 15000, historySessionId, settingsAcceptance } = {}) {
  const report = { status: "failed", target: "iphone", mode: "pairing-and-read-only" };
  let phase = "management-status", ownedDeviceId, initialDevices, token, control, conversation;
  const manage = async (path, body, accepted = [200]) => {
    let response;
    try {
      response = await fetch(new URL(`mgw/${path}`, host.base), {
        headers: { cookie: host.cookie, origin: host.base.origin, "content-type": "application/json" },
        ...body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
        redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw failure("gateway-management-transport-failed"); }
    requireValue(accepted.includes(response.status), `gateway-management-http-${response.status}`);
    try { return await response.json(); }
    catch { throw failure("gateway-management-invalid-json"); }
  };
  try {
    requireValue(["127.0.0.1", "localhost", "[::1]"].includes(host.base.hostname), "loopback-forward-required");
    const status = await manage("status");
    requireValue(status.gatewayEnabled === true && status.requireAuth === true, "authenticated-gateway-must-already-be-enabled");
    requireValue(status.version === pins.DSH_MOBILE_GATEWAY_VERSION, "gateway-version-mismatch");
    requireValue(typeof status.gatewayId === "string" && status.gatewayId.length > 0, "gateway-identity-missing");
    requireValue(typeof status.wsPath === "string" && status.wsPath.startsWith("/"), "gateway-path-invalid");
    const wsURL = new URL(status.wsPath, host.base);
    requireValue(wsURL.origin === host.base.origin && !wsURL.search && !wsURL.hash, "gateway-path-invalid");
    wsURL.protocol = wsURL.protocol === "https:" ? "wss:" : "ws:";
    const beforeCatalog = await host.rpc("session/modelCatalog", {});
    const beforeSessions = await host.rpc("session/list", { _request: {} });
    const existing = await manage("devices");
    requireValue(Array.isArray(existing.devices) && existing.devices.every(device => typeof device.id === "string"), "invalid-device-list");
    initialDevices = new Set(existing.devices.map(device => device.id));
    phase = "pairing";
    const pairing = await manage("pair", { publicUrl: wsURL.href }, [201]);
    const id = pairing.pairing?.id;
    requireValue(typeof id === "string" && id.length > 0 && !initialDevices.has(id), "pairing-device-is-not-new");
    ownedDeviceId = id;
    const code = pairing.payload?.pairingCode;
    requireValue(typeof code === "string" && /^[A-Za-z0-9_-]{43}$/.test(code), "invalid-pairing-response");
    const clientId = `native-check-${randomUUID()}`;
    const headers = { "X-DSH-Device-ID": clientId, "X-DSH-Device-Name": "DSH native acceptance" };
    control = new NativeWire(new WebSocket(wsURL, ["dsh-mobile-v1", `dsh-pair.${code}`], {
      headers: { ...headers, "X-DSH-Channel": "control" }, maxPayload: 64 * 1024 * 1024,
    }), timeoutMs);
    await control.ready;
    const paired = await control.wait("paired");
    requireValue(paired.device?.id === ownedDeviceId && typeof paired.token === "string"
      && /^[A-Za-z0-9_-]{43}$/.test(paired.token), "paired-device-mismatch");
    token = paired.token;
    phase = "native-hello";
    const hello = await control.wait("hello");
    validateHello(hello, pins, status.gatewayId, ownedDeviceId);
    report.gatewayVersion = status.version;
    report.dshVersion = hello.dshVersion;
    report.protocol = hello.protocol;
    report.historyFormatVersion = hello.historyFormatVersion;
    report.requiredCapabilities = requiredCapabilities;
    phase = "workspaces";
    const workspaces = await control.request("workspaces");
    requireValue(Array.isArray(workspaces.items), "invalid-native-workspaces");
    phase = "sessions";
    const sessions = await control.request("sessions");
    requireValue(Array.isArray(sessions.items) && sessions.items.every(session => typeof session.sessionId === "string"), "invalid-native-sessions");
    const nativeIds = new Set(sessions.items.map(session => session.sessionId));
    requireValue(beforeSessions.items.every(session => nativeIds.has(session.sessionId)), "native-session-list-incomplete");
    phase = "host";
    const facts = await control.request("host");
    requireValue(facts.dshVersion === pins.DSH_VERSION && facts.historyFormatVersion === 4, "native-host-facts-mismatch");
    phase = "models";
    const models = await control.request("models");
    requireValue(Array.isArray(models.groups) && models.groups.every(group => Array.isArray(group.models)), "invalid-native-models");
    const modelIds = new Set(models.groups.flatMap(group => group.models.map(model => model.id)));
    const requiredModels = (pins.DSH_CODEX_REQUIRED_MODELS ?? "").split(",").filter(Boolean);
    requireValue(requiredModels.every(model => modelIds.has(model)), "native-required-model-missing");
    const old = beforeSessions.items.find(session => !session.running && !session.blank
      && session.formatStatus !== "migration-required" && nativeIds.has(session.sessionId)
      && (historySessionId === undefined ? !/^session-(upgrade|native)-/.test(session.sessionId) : session.sessionId === historySessionId));
    requireValue(old, "old-session-unavailable-for-history-check");
    if (settingsAcceptance !== undefined) {
      phase = "native-settings";
      requireValue(typeof settingsAcceptance === "function" && hello.capabilities.includes("iphone-native-settings-v1"), "native-settings-capability-missing");
      report.nativeSettings = await settingsAcceptance(control);
    }
    phase = "authenticated-conversation-reconnect";
    conversation = new NativeWire(new WebSocket(wsURL, ["dsh-mobile-v1"], {
      headers: { ...headers, "X-DSH-Channel": "conversation", authorization: `Bearer ${token}` }, maxPayload: 64 * 1024 * 1024,
    }), timeoutMs);
    await conversation.ready;
    validateHello(await conversation.wait("hello"), pins, status.gatewayId, ownedDeviceId);
    phase = "old-session-history";
    const history = await conversation.request("history", "history", {
      sessionId: old.sessionId, requestId: randomUUID(), view: "conversation", maxMessages: 3, maxBytes: 256 * 1024,
    });
    requireValue(history.sessionId === old.sessionId && history.historyFormatVersion === 4
      && validEvents(history.events) && history.events.length > 0, "invalid-native-history");
    phase = "old-session-native-snapshot";
    const opening = conversation.wait("session-snapshot", frame => frame.sessionId === old.sessionId);
    await conversation.request("subscribe", "subscribed", { sessionId: old.sessionId, assistantStream: true });
    const snapshot = await opening;
    requireValue(snapshot.historyFormatVersion === 4 && snapshot.replace === true
      && validEvents(snapshot.events) && Number.isSafeInteger(snapshot.assistantStream?.revision), "invalid-native-session-snapshot");
    const afterCatalog = await host.rpc("session/modelCatalog", {});
    requireValue(isDeepStrictEqual(beforeCatalog.default, afterCatalog.default), "default-model-changed-during-native-check");
    Object.assign(report, { status: "passed", authenticatedPairing: true, authenticatedTokenReconnect: true,
      workspaceCount: workspaces.items.length, sessionCount: sessions.items.length, modelGroupCount: models.groups.length,
      requiredModels, oldHistoryEventCount: history.events.length, nativeSessionSnapshot: true,
      defaultModelUnchanged: true, promptsSubmitted: 0 });
  } catch (error) {
    report.failure = { phase, code: error.nativeCheckCode ?? "native-gateway-check-failed" };
  } finally {
    await Promise.allSettled([control?.close(), conversation?.close()]);
    token = undefined;
    if (ownedDeviceId && !initialDevices.has(ownedDeviceId)) {
      try {
        await manage(`devices/${encodeURIComponent(ownedDeviceId)}/revoke`, {}, [200, 404]);
        const after = await manage("devices");
        requireValue(Array.isArray(after.devices), "invalid-device-list-after-cleanup");
        const remaining = new Set(after.devices.map(device => device.id));
        requireValue(!remaining.has(ownedDeviceId), "test-device-cleanup-failed");
        requireValue([...initialDevices].every(id => remaining.has(id)), "existing-app-device-list-changed");
        report.testDeviceRevoked = true;
        report.existingAppDevicesRetained = true;
      } catch (error) {
        report.status = "failed";
        report.cleanupFailure = { phase: "cleanup", code: error.nativeCheckCode ?? "test-device-cleanup-failed" };
      }
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let host;
  try {
    const [target = "iphone", ...args] = process.argv.slice(2);
    if (target !== "iphone" || (args.length && (args.length !== 2 || args[0] !== "--save"))) throw failure("invalid-native-check-arguments");
    process.env.LOCAL_PORT ??= "13081";
    host = await UpgradeHost.connect(target);
    const require = createRequire(new URL("../dsh-runtime/package.json", import.meta.url));
    const report = await checkNativeGateway(host, { WebSocket: require("ws"), pins: await readVersionPins() });
    if (args.length) {
      await mkdir(dirname(resolve(args[1])), { recursive: true });
      await writeFile(resolve(args[1]), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    }
    console.log(JSON.stringify(report));
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ target: "iphone", status: "failed", code: error.nativeCheckCode ?? "native-host-connection-failed" }));
    process.exitCode = 1;
  } finally { host?.close(); }
}
