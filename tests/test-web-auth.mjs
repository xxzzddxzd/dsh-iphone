#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { exchange } from "../scripts/web-auth.mjs";

let redirect = "/";
let includeCookie = true;
const server = createServer((_request, response) => {
  response.writeHead(303, {
    location: redirect,
    ...(includeCookie ? { "set-cookie": "dsh-session=fixture; HttpOnly; Path=/" } : {}),
  });
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const url = new URL(`http://127.0.0.1:${server.address().port}/?token=fixture`);
  for (redirect of ["/", "./"]) {
    assert.equal((await exchange(url)).cookie, "dsh-session=fixture");
  }
  for (redirect of ["/other", "https://example.invalid/", "/?token=retained"]) {
    await assert.rejects(exchange(url), /launch exchange failed/);
  }
  redirect = "./";
  includeCookie = false;
  await assert.rejects(exchange(url), /launch exchange failed/);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log("Web authentication: same-origin root redirects and cookie exchange passed");
