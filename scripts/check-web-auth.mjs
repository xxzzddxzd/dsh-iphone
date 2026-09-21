#!/usr/bin/env node
import assert from "node:assert/strict";
import { request } from "node:http";
import { exchange, launchUrl } from "./web-auth.mjs";

function websocketStatus(origin, cookie, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL("/api/remote.mux", origin), {
      headers: {
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        origin, ...(cookie ? { cookie } : {}), ...extra,
      },
    });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("WebSocket timed out")));
    req.end();
  });
}

async function check(target) {
  const url = await launchUrl(target);
  const { cookie, header } = await exchange(url);
  for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age="]) assert.ok(header.includes(flag), `missing ${flag}`);
  const origin = url.origin;
  async function status(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, origin), options, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.setTimeout(10000, () => req.destroy(new Error("HTTP timed out")));
      req.end(options.body);
    });
  }
  const body = JSON.stringify({ type: "client-request", rpcId: "auth-check", method: "settings/describe", payload: { args: {} } });
  const rpc = (headers = {}) => status("/api/settings/describe", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  assert.equal(await status("/"), 401, "unauthenticated root");
  assert.equal(await status("/?token=invalid"), 401, "invalid token");
  assert.equal(await status("/", { headers: { cookie } }), 200, "authenticated root");
  assert.equal(await status("/index.html", { headers: { cookie } }), 200, "authenticated index");
  assert.equal(await rpc(), 401, "unauthenticated RPC");
  assert.equal(await rpc({ cookie, origin }), 200, "authenticated same-origin RPC");
  assert.equal(await rpc({ cookie, origin: "http://untrusted.invalid" }), 403, "foreign Origin");
  assert.equal(await rpc({ cookie, "sec-fetch-site": "cross-site" }), 403, "cross-site fetch");
  assert.equal(await rpc({ cookie, host: "untrusted.invalid" }), 403, "untrusted Host");
  assert.equal(await rpc({ cookie, host: `localhost:${url.port}` }), 401, "wrong cookie authority");
  assert.equal(await rpc({ cookie: cookie.slice(0, -1) + "!" }), 401, "tampered cookie");
  assert.equal(await rpc({ authorization: `Bearer ${url.searchParams.get("token")}` }), 401, "Authorization is not a browser session");
  assert.equal(await status(`/api/settings/describe?${url.searchParams}`, { method: "POST", body, headers: { "content-type": "application/json" } }), 401, "query token cannot authorize RPC");
  assert.equal(await websocketStatus(origin), 401, "unauthenticated WebSocket");
  assert.equal(await websocketStatus(origin, cookie), 101, "authenticated WebSocket");
  assert.equal(await websocketStatus(origin, cookie, { origin: "http://untrusted.invalid" }), 403, "foreign WebSocket Origin");
  console.log(`${target} ${origin}: launch exchange, cookie, root/index, RPC and WebSocket checks passed (including rejection cases).`);
}

for (const target of process.argv.slice(2).length ? process.argv.slice(2) : ["mac", "iphone"]) {
  try { await check(target); }
  catch (error) {
    // Assertion messages contain only check labels/status codes; never print requests or headers.
    console.error(`${target}: ${error.code === "ERR_ASSERTION" ? error.message : "authentication check failed; inspect service/tunnel"}`);
    process.exitCode = 1;
  }
}
