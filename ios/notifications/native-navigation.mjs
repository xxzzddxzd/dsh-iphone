import { readFileSync } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9._:-]{1,512}$/;

export function isNativeSessionUrl(value) {
  try {
    const url = new URL(value);
    const fields = [...url.searchParams];
    return url.protocol === "dshmobile:" && url.hostname === "session" && !url.port
      && !url.username && !url.password && !url.hash && (url.pathname === "" || url.pathname === "/")
      && fields.length === 2 && new Set(fields.map(([key]) => key)).size === 2
      && UUID.test(url.searchParams.get("gateway") ?? "") && SESSION.test(url.searchParams.get("id") ?? "");
  } catch { return false; }
}

/** Only a paired profile for this exact local gateway can replace a Web link. */
export function nativeSessionUrl(sessionId, options = {}) {
  if (!SESSION.test(sessionId ?? "")) return undefined;
  try {
    const read = path => {
      const text = readFileSync(path, "utf8");
      if (text.length > 65536) throw new Error("oversized native navigation metadata");
      return JSON.parse(text);
    };
    const mapping = read(options.mappingPath ?? "/var/root/.dsh/native-client/gateway-map.json");
    const gateway = read(options.gatewayStatePath ?? "/var/root/.dsh/mobile-gateway-state.json");
    if (mapping.schema !== 1 || mapping.bundleId !== "com.clark.dshmobile.dev" || !UUID.test(gateway.gatewayId ?? "")) return undefined;
    const entries = mapping.gateways?.filter(entry => entry.gatewayId?.toLowerCase() === gateway.gatewayId.toLowerCase()
      && entry.localId === mapping.activeLocalId && UUID.test(entry.localId)
      && entry.endpoints?.includes("ws://127.0.0.1:3080/ws/mobile"));
    if (entries?.length !== 1) return undefined;
    const url = new URL("dshmobile://session");
    url.searchParams.set("gateway", entries[0].localId);
    url.searchParams.set("id", sessionId);
    return url.href;
  } catch { return undefined; }
}
