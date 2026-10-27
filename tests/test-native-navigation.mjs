import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isNativeSessionUrl, nativeSessionUrl } from "../ios/notifications/native-navigation.mjs";
import { validateLaunchUrl } from "../ios/notifications/dsh-notify.mjs";

const localId = "ABCDEF01-1234-1234-1234-123456789ABC";
const gatewayId = "abcdef02-1234-1234-1234-123456789abc";
const good = `dshmobile://session?gateway=${localId}&id=session-test`;
const cases = [
  { url: good, allowed: true },
  { url: `dshmobile://session/?id=s1&gateway=${localId}`, allowed: true },
  ...["dshmobile://pair?payload=secret", `dshmobile://evil?gateway=${localId}&id=s1`,
    `${good}&id=duplicate`, `${good}&payload=secret`, `${good}#fragment`,
    `dshmobile://user:secret@session?gateway=${localId}&id=s1`,
    `dshmobile://session/path?gateway=${localId}&id=s1`,
    `dshmobile://session?gateway=not-a-uuid&id=s1`,
    `dshmobile://session?gateway=${localId}&id=..%2Fbad`,
    `dshmobile://session?gateway=${localId}&id=${"a".repeat(513)}`,
  ].map(url => ({ url, allowed: false })),
];
for (const entry of cases) assert.equal(isNativeSessionUrl(entry.url), entry.allowed, entry.url);
assert.equal(validateLaunchUrl(good), good);
assert.throws(() => validateLaunchUrl("dshmobile://pair?payload=secret"), /HTTP\(S\)/);

const root = await mkdtemp(join(tmpdir(), "dsh-native-navigation-"));
try {
  const options = { mappingPath: join(root, "map.json"), gatewayStatePath: join(root, "state.json") };
  const entry = { gatewayId, localId, endpoints: ["ws://127.0.0.1:3080/ws/mobile"] };
  const mapping = { schema: 1, bundleId: "com.clark.dshmobile.dev", activeLocalId: localId, gateways: [entry] };
  await writeFile(options.gatewayStatePath, JSON.stringify({ version: 1, gatewayId }));
  await writeFile(options.mappingPath, JSON.stringify(mapping));
  assert.equal(nativeSessionUrl("session-test", options), good, "preserve case-sensitive native profile ID");
  for (const changed of [
    { ...mapping, activeLocalId: gatewayId },
    { ...mapping, gateways: [{ ...entry, gatewayId: localId }] },
    { ...mapping, gateways: [entry, entry] },
    { ...mapping, gateways: [{ ...entry, endpoints: ["ws://192.168.1.10:3080/ws/mobile"] }] },
  ]) {
    await writeFile(options.mappingPath, JSON.stringify(changed));
    assert.equal(nativeSessionUrl("session-test", options), undefined, "untrusted mappings preserve the Web fallback");
  }
  assert.equal(nativeSessionUrl("../bad", options), undefined);
  await writeFile(options.mappingPath, "invalid");
  assert.equal(nativeSessionUrl("session-test", options), undefined);

  // The actual Swift predicate used by the iOS Host and Widget must agree.
  const fixtures = join(root, "urls.json");
  await writeFile(fixtures, JSON.stringify(cases));
  await writeFile(join(root, "main.swift"), `import Foundation
struct Case: Decodable { let url: String; let allowed: Bool }
let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
for item in cases {
  guard let url = URL(string: item.url), DSHNavigation.isNativeSessionURL(url) == item.allowed else { fatalError("native URL contract mismatch") }
}
`);
  execFileSync("xcrun", ["swiftc", fileURLToPath(new URL("../ios/navigation/DSHNavigation.swift", import.meta.url)), join(root, "main.swift"), "-o", join(root, "check")]);
  execFileSync(join(root, "check"), [fixtures]);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Paired local native links, Web fallback and Swift URL rejection checks passed");
