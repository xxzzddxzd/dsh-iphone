import { readFile } from "node:fs/promises";

export async function readVersionPins() {
  return Object.fromEntries((await readFile(new URL("../versions.env", import.meta.url), "utf8"))
    .split("\n").filter(line => line && !line.startsWith("#")).map(line => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }));
}

export function validateProviderComponents(info, pins, visibleModels) {
  if (info?.schema !== 1 || info.bundle?.name !== "dsh-codex") throw new Error("Provider component metadata is unavailable or unsupported");
  if (info.bundle.version !== pins.DSH_CODEX_VERSION) throw new Error(`Provider bundle is ${info.bundle.version}; expected ${pins.DSH_CODEX_VERSION}`);
  if (!pins.DSH_CODEX_PI_AI_VERSION || info.piAi?.version !== pins.DSH_CODEX_PI_AI_VERSION || info.piAi.declaredVersion !== pins.DSH_CODEX_PI_AI_VERSION) {
    throw new Error("The loaded pi-ai component does not match the pinned Provider dependency");
  }
  const catalog = info.catalogs?.["provider-codex"];
  if (!Array.isArray(catalog) || catalog.some(id => typeof id !== "string") || new Set(catalog).size !== catalog.length) throw new Error("Invalid Codex model catalog");
  const required = (pins.DSH_CODEX_REQUIRED_MODELS ?? "").split(",").filter(Boolean);
  if (!required.length) throw new Error("Required Codex models are not configured");
  for (const id of required) {
    if (!catalog.includes(id)) throw new Error(`Required model ${id} is missing from the Provider catalog`);
    if (visibleModels && !visibleModels.includes(id)) throw new Error(`Required model ${id} is not visible in the running Host catalog`);
  }
  if (visibleModels !== undefined && info.settings?.ready !== true) throw new Error("Provider durable settings are not initialized");
  return { bundleVersion: info.bundle.version, piAiVersion: info.piAi.version,
    codexModels: catalog, requiredModels: required, xaiImageModels: info.xaiImageModels,
    ...info.settings === undefined ? {} : { settingsReady: info.settings.ready === true } };
}

export function validateProviderDependencyPins(metadata, lock, pins) {
  const name = "@earendil-works/pi-ai";
  const version = pins.DSH_CODEX_PI_AI_VERSION;
  const direct = lock.importers?.["."]?.dependencies?.[name];
  if (metadata.version !== pins.DSH_CODEX_VERSION || metadata.dependencies?.[name] !== version || direct?.specifier !== version || typeof direct.version !== "string" || direct.version.split("(")[0] !== version) {
    throw new Error("Provider manifest and dependency lock do not match the version pins");
  }
  if (!pins.DSH_CODEX_PI_AI_INTEGRITY || lock.packages?.[`${name}@${version}`]?.resolution?.integrity !== pins.DSH_CODEX_PI_AI_INTEGRITY) {
    throw new Error("Provider pi-ai archive integrity differs from the recorded release");
  }
}

export async function componentUpdateReport(pins, fetcher = fetch) {
  const specs = [
    { name: "@earendil-works/pi-ai", pinned: pins.DSH_CODEX_PI_AI_VERSION, integrity: pins.DSH_CODEX_PI_AI_INTEGRITY },
    { name: "dsh-cline-pass", pinned: pins.DSH_CLINE_PASS_VERSION },
  ];
  return Promise.all(specs.map(async spec => {
    if (!spec.pinned) throw new Error(`Missing version pin for ${spec.name}`);
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(spec.name)}/latest`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Component registry check failed for ${spec.name}: HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata.name !== spec.name || typeof metadata.version !== "string" || !metadata.dist?.integrity) throw new Error(`Incomplete component release: ${spec.name}`);
    if (spec.integrity && spec.pinned === metadata.version && spec.integrity !== metadata.dist.integrity) throw new Error(`Pinned component integrity changed: ${spec.name}`);
    return { name: spec.name, pinned: spec.pinned, latest: metadata.version, integrity: metadata.dist.integrity,
      nodeEngine: metadata.engines?.node ?? null, updateAvailable: spec.pinned !== metadata.version };
  }));
}

export function combineUpdateReports(dsh, components) {
  const needsUpdate = dsh.status !== "current" || components.some(component => component.updateAvailable);
  return { ...dsh, dshStatus: dsh.status, status: needsUpdate ? "update-available" : "current", components };
}
