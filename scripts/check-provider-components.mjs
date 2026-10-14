#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UpgradeHost } from "./upgrade-host.mjs";
import { readVersionPins, validateProviderComponents, validateProviderDependencyPins } from "./provider-components.mjs";

const [target = "local", ...args] = process.argv.slice(2);
let source, save;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--source") source = args[++index];
  else if (args[index] === "--save") save = args[++index];
  else throw new Error("usage: check-provider-components.mjs local|mac|iphone [--source path] [--save path]");
}
if (!["local", "mac", "iphone"].includes(target) || args.at(-1)?.startsWith("--")) throw new Error("Invalid component-check arguments");
let host;
try {
  const pins = await readVersionPins();
  let info, visible;
  if (target === "local") {
    const root = resolve(source ?? process.env.DSH_CODEX_SOURCE ?? fileURLToPath(new URL("../../dsh-codex", import.meta.url)));
    const sourceRequire = createRequire(pathToFileURL(resolve(root, "package.json")));
    const yaml = sourceRequire("js-yaml");
    validateProviderDependencyPins(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")),
      yaml.load(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8")), pins);
    const plugin = await import(pathToFileURL(resolve(root, "lib/index.js")));
    if (typeof plugin.describeProviderComponents !== "function") throw new Error("Build the Provider with component metadata before validation");
    info = plugin.describeProviderComponents();
  } else {
    host = await UpgradeHost.connect(target);
    const response = await fetch(new URL("plugins/dsh-openai-codex/components", host.base), {
      headers: { cookie: host.cookie, origin: host.base.origin }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Loaded Provider metadata returned HTTP ${response.status}; check deployment and restart state`);
    info = await response.json();
    const catalog = await host.rpc("session/modelCatalog", {});
    visible = catalog.groups.find(group => group.id === "provider-codex")?.models.map(model => model.id) ?? [];
  }
  const report = { target, status: "passed", ...validateProviderComponents(info, pins, visible) };
  if (save) {
    await mkdir(dirname(resolve(save)), { recursive: true });
    await writeFile(resolve(save), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  }
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(`${target}: ${error.message}`);
  process.exitCode = 1;
} finally { host?.close(); }
