import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "dsh-activity-target-"));
try {
  execFileSync("python3", ["-c", `
from pathlib import Path
import plistlib,sys
root=Path(sys.argv[1]);app=root/'DshMobile.app';widget=app/'PlugIns/AgentLiveActivityWidget.appex'
widget.mkdir(parents=True)
for path,identifier in [(app,'com.clark.dshmobile.dev'),(widget,'com.clark.dshmobile.dev.AgentLiveActivityWidget')]:
 value={'CFBundleIdentifier':identifier,'CFBundleVersion':'35','CFBundleShortVersionString':'1.7.11'}
 if path==widget:value['NSExtension']={'NSExtensionPointIdentifier':'com.apple.widgetkit-extension'}
 (path/'Info.plist').write_bytes(plistlib.dumps(value))
`, root]);
  const header = fileURLToPath(new URL("../ios/activity/DSHActivityTarget.h", import.meta.url));
  await writeFile(join(root, "main.m"), `#import "${header}"
#import <unistd.h>
int main(int argc, const char **argv) { @autoreleasepool {
 if (argc != 2) return 2;
 NSString *target = DSHActivitySelectTarget([NSString stringWithUTF8String:argv[1]], getuid());
 printf("%s", target.UTF8String); return 0;
} }
`);
  execFileSync("xcrun", ["clang", "-fobjc-arc", "-framework", "Foundation", join(root, "main.m"), "-o", join(root, "check")]);
  const marker = { schema: 1, managedBy: "dsh-iphone/native-client", bundleId: "com.clark.dshmobile.dev", version: "1.7.11", build: "35",
    attributesType: "DSHActivityAttributes", widgetKind: "DSHRootActivityWidget", bundlePath: join(root, "DshMobile.app") };
  const path = join(root, "activity-widget.json");
  const select = file => execFileSync(join(root, "check"), [file], { encoding: "utf8" });
  assert.equal(select(path), "ai.deepseek.dsh", "missing capability preserves legacy support");
  await writeFile(path, JSON.stringify(marker), { mode: 0o600 });
  assert.equal(select(path), marker.bundleId);
  for (const patch of [{ bundleId: "other.app" }, { build: "34" }, { build: "36" }, { attributesType: "AgentActivityAttributes" },
    { widgetKind: null }, { bundleId: [] }, { schema: 2 }, { managedBy: "other-tool" }, { bundlePath: join(root, "missing.app") }]) {
    await writeFile(path, JSON.stringify({ ...marker, ...patch }));
    assert.equal(select(path), "ai.deepseek.dsh", "unsupported or stale metadata must not target the App");
  }
  await writeFile(path, JSON.stringify(marker));
  await chmod(path, 0o644);
  assert.equal(select(path), marker.bundleId, "the mobile broker can read root-owned public capability metadata");
  await chmod(path, 0o666);
  assert.equal(select(path), "ai.deepseek.dsh", "mobile-writable metadata cannot grant a private target");
  await chmod(path, 0o600);
  await symlink(path, join(root, "alias"));
  assert.equal(select(join(root, "alias")), "ai.deepseek.dsh", "symlink capability files are refused");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Activity target capabilities bind the installed build and Widget; unsafe/stale markers preserve legacy");
