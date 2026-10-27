#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { checkNativeGateway } from "../scripts/check-native-gateway.mjs";

const require = createRequire(new URL("../dsh-runtime/package.json", import.meta.url));
const { WebSocket, WebSocketServer } = require("ws");
const pins = { DSH_VERSION: "0.2.1-rc.2", DSH_MOBILE_GATEWAY_VERSION: "0.11.1+iphone.1", DSH_CODEX_REQUIRED_MODELS: "gpt-6.1-sol" };
const capabilities = ["split-channels", "assistant-stream-v1", "history-format-version", "projection-baseline"];

async function fixture(options = {}) {
  const privateText = "private fixture history must never reach a report";
  const pairingCode = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const gatewayId = randomUUID();
  const newId = randomUUID();
  const appId = "existing-app-device";
  const devices = new Map([[appId, { id: appId, name: privateText }]]);
  const state = { pairingCount: 0, revoked: [], messages: [], authenticatedReconnects: 0, historySessionIds: [], subscriptionSessionIds: [] };
  const catalog = { default: { provider: "provider-codex", model: "gpt-6.1-sol" },
    groups: [{ id: "provider-codex", models: [{ id: "gpt-6.1-sol", name: privateText }] }] };
  const items = [{ sessionId: "old-session", running: false, blank: false, formatStatus: "current", title: privateText }];
  if (options.smallHistory) items.push({ sessionId: "session-native-small-fixture", running: false, blank: false, formatStatus: "current", title: privateText });
  const event = { seq: 3, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: privateText }] } } };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, "fixture-admin=value");
    assert.equal(req.headers.origin, base.origin);
    res.setHeader("content-type", "application/json");
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    if (req.url === "/mgw/status") return send(200, { version: pins.DSH_MOBILE_GATEWAY_VERSION, gatewayId,
      gatewayEnabled: true, requireAuth: options.requireAuth ?? true, wsPath: "/ws/mobile" });
    if (req.url === "/mgw/devices") return send(200, { devices: [...devices.values()] });
    if (req.url === "/mgw/pair") {
      let text = ""; for await (const chunk of req) text += chunk;
      assert.equal(JSON.parse(text).publicUrl, base.href.replace(/^http/, "ws") + "ws/mobile");
      state.pairingCount++;
      return send(201, { pairing: { id: newId }, payload: { pairingCode }, qrPayload: "not-for-reports", svg: privateText });
    }
    if (req.url?.endsWith("/revoke")) {
      const id = decodeURIComponent(req.url.slice("/mgw/devices/".length, -"/revoke".length));
      state.revoked.push(id);
      const revoked = devices.delete(id);
      return send(revoked ? 200 : 404, { revoked });
    }
    send(404, {});
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has("dsh-mobile-v1") ? "dsh-mobile-v1" : false });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers.cookie, undefined, "native auth must not borrow the browser cookie");
    assert.match(req.headers["x-dsh-device-id"], /^native-check-/);
    assert.equal(req.url, "/ws/mobile");
    const protocols = req.headers["sec-websocket-protocol"].split(",").map(value => value.trim());
    const paired = protocols.includes(`dsh-pair.${pairingCode}`);
    if (paired) {
      assert.equal(req.headers["x-dsh-channel"], "control");
      devices.set(newId, { id: newId, name: "acceptance fixture" });
    } else {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.headers["x-dsh-channel"], "conversation");
      state.authenticatedReconnects++;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
      if (paired) ws.send(JSON.stringify({ kind: "paired", device: { id: newId }, token }));
      ws.send(JSON.stringify({ kind: "hello", gatewayId, protocol: options.protocol ?? 3,
        historyFormatVersion: options.historyFormatVersion ?? 4, dshVersion: pins.DSH_VERSION,
        capabilities: options.capabilities ?? capabilities, authenticated: true,
        device: { id: options.wrongDevice ? appId : newId } }));
      ws.send(JSON.stringify({ kind: "event", event: { text: privateText } }));
      ws.on("message", bytes => {
        const request = JSON.parse(bytes.toString());
        state.messages.push(request.type);
        let response;
        switch (request.type) {
          case "workspaces": response = { kind: "workspaces", items: [{ title: privateText, sessionIds: ["old-session"] }] }; break;
          case "sessions": response = { kind: "sessions", items }; break;
          case "host": response = { kind: "host", dshVersion: pins.DSH_VERSION, historyFormatVersion: 4, cwd: privateText }; break;
          case "models": response = { kind: "models", ...catalog }; break;
          case "history":
            state.historySessionIds.push(request.sessionId);
            response = options.historyFailure
              ? { kind: "error", requestType: "history", message: privateText }
              : { kind: "history", sessionId: request.sessionId, historyFormatVersion: 4, events: [event] };
            break;
          case "subscribe":
            state.subscriptionSessionIds.push(request.sessionId);
            assert.equal(request.assistantStream, true);
            // Exercise a fast opening snapshot before the subscription acknowledgement.
            ws.send(JSON.stringify({ kind: "session-snapshot", sessionId: request.sessionId,
              historyFormatVersion: 4, replace: true, events: [event], assistantStream: { revision: 0 } }));
            response = { kind: "subscribed", sessionId: request.sessionId };
            break;
          case "native-settings":
            assert.equal(request.scope, "provider");
            assert.equal(request.action, "images.get");
            assert.deepEqual(request.payload, {});
            response = { kind: "native-settings", requestId: request.requestId, scope: request.scope, action: request.action,
              value: { modifyReadImage: true, shareImagegenWithOtherModels: false } };
            break;
          default: throw new Error("fixture received an unapproved mutation");
        }
        ws.send(JSON.stringify(response));
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = new URL(`http://127.0.0.1:${server.address().port}/`);
  const host = { base, cookie: "fixture-admin=value", async rpc(endpoint) {
    if (endpoint === "session/modelCatalog") return structuredClone(catalog);
    if (endpoint === "session/list") return { items: structuredClone(items) };
    throw new Error("fixture received an unapproved Host mutation");
  } };
  return { host, state, devices, appId, newId, token, pairingCode, privateText,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise(done => wss.close(done));
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    } };
}

for (const options of [{}, { protocol: 99 }, { historyFormatVersion: 5 }, { capabilities: [] }, { historyFailure: true }, { wrongDevice: true }, { requireAuth: false }]) {
  const test = await fixture(options);
  try {
    const report = await checkNativeGateway(test.host, { WebSocket, pins, timeoutMs: 1500 });
    const serialized = JSON.stringify(report);
    for (const secret of [test.token, test.pairingCode, test.privateText]) assert.ok(!serialized.includes(secret), "private protocol fields leaked into report");
    assert.ok(test.devices.has(test.appId), "existing App pairing must be retained");
    assert.ok(!test.devices.has(test.newId), "the acceptance device must be revoked on success and failure");
    assert.ok(test.state.revoked.every(id => id === test.newId), "cleanup must never revoke another device");
    assert.ok(!test.state.messages.some(type => ["message", "select-model", "save-default-model", "permission"].includes(type)));
    if (Object.keys(options).length === 0) {
      assert.equal(report.status, "passed");
      assert.equal(report.authenticatedPairing, true);
      assert.equal(report.authenticatedTokenReconnect, true);
      assert.equal(test.state.authenticatedReconnects, 1);
      assert.equal(report.nativeSessionSnapshot, true);
      assert.equal(report.oldHistoryEventCount, 1);
      assert.equal(report.testDeviceRevoked, true);
      assert.equal(report.existingAppDevicesRetained, true);
      assert.equal(report.promptsSubmitted, 0);
    } else {
      assert.equal(report.status, "failed");
      if (options.requireAuth === false) assert.equal(test.state.pairingCount, 0, "disabled device auth must fail before creating a pairing");
      else assert.equal(report.testDeviceRevoked, true);
    }
  } finally { await test.close(); }
}
for (const fails of [false, true]) {
  const test = await fixture({ smallHistory: true, capabilities: [...capabilities, "iphone-native-settings-v1"] });
  try {
    let called = 0;
    const report = await checkNativeGateway(test.host, { WebSocket, pins, timeoutMs: 1500,
      historySessionId: "session-native-small-fixture", settingsAcceptance: async control => {
        called++;
        const reply = await control.request("native-settings", "native-settings", {
          requestId: "settings-fixture", scope: "provider", action: "images.get", payload: {},
        });
        assert.equal(reply.requestId, "settings-fixture");
        if (fails) throw new Error(test.privateText);
        return { status: "passed", requests: 1 };
      } });
    assert.equal(called, 1, "settings callback did not run through the paired control channel");
    assert.equal(report.status, fails ? "failed" : "passed");
    assert.equal(report.testDeviceRevoked, true);
    assert.equal(report.existingAppDevicesRetained, true);
    assert.ok(test.devices.has(test.appId));
    assert.ok(!test.devices.has(test.newId));
    assert.deepEqual(test.state.revoked, [test.newId], "callback cleanup revoked a foreign App device");
    if (fails) {
      assert.deepEqual(report.failure, { phase: "native-settings", code: "native-gateway-check-failed" });
    } else {
      assert.deepEqual(report.nativeSettings, { status: "passed", requests: 1 });
      assert.deepEqual(test.state.historySessionIds, ["session-native-small-fixture"]);
      assert.deepEqual(test.state.subscriptionSessionIds, ["session-native-small-fixture"]);
    }
    for (const secret of [test.privateText, test.token, test.pairingCode]) assert.ok(!JSON.stringify(report).includes(secret));
  } finally { await test.close(); }
}
console.log("Native Gateway pairing, token reconnect, read APIs and snapshot pass; failures retain App devices, revoke only the test device and redact all private values");
