#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { UpgradeHost, compareBaseline } from "./upgrade-host.mjs";

const [target, ...args] = process.argv.slice(2);
if (!["mac", "iphone"].includes(target) || (args.length && (args.length !== 2 || args[0] !== "--save"))) {
  throw new Error("usage: check-provider-settings.mjs mac|iphone [--save path]");
}
let host;
try {
  host = await UpgradeHost.connect(target);
  const before = await host.health();
  if (before.running) throw new Error("Host has active sessions; wait before settings validation");
  const request = async (path, body) => {
    const response = await fetch(new URL(`plugins/dsh-openai-codex/${path}`, host.base), {
      headers: { cookie: host.cookie, origin: host.base.origin, "content-type": "application/json" },
      ...body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`Provider settings ${path} returned HTTP ${response.status}`);
    return value;
  };
  if ((await request("components")).settings?.ready !== true) throw new Error("Provider durable settings are not initialized");
  const modelPreferences = rows => rows.map(row => ({ id: row.id, visible: row.visible !== false,
    ...row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow },
    ...row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens },
  }));
  const checked = [];
  for (const provider of ["provider-codex", "provider-xai"]) {
    const path = `providers/${provider}/models`;
    const expected = modelPreferences((await request(path)).models);
    await request(path, { models: expected });
    if (!isDeepStrictEqual(modelPreferences((await request(path)).models), expected)) throw new Error(`Provider preferences changed while saving ${provider}`);
    checked.push(path);
  }
  for (const path of ["image-tools", "response-api"]) {
    const expected = await request(path);
    await request(path, expected);
    if (!isDeepStrictEqual(await request(path), expected)) throw new Error(`Provider preferences changed while saving ${path}`);
    checked.push(path);
  }
  compareBaseline(before, await host.health());
  const report = { target, status: "passed", savedAndReadBack: checked, effectivePreferencesUnchanged: true, defaultModelUnchanged: true };
  if (args.length) {
    await mkdir(dirname(resolve(args[1])), { recursive: true });
    await writeFile(resolve(args[1]), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(`${target}: ${error.message}`);
  process.exitCode = 1;
} finally { host?.close(); }
