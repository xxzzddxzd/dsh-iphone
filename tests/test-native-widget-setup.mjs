#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Compile the actual production helper, but call only its pure version gate.
// No private framework, registration, phone, cache or Activity is accessed.
const source = fileURLToPath(new URL("../ios/native/DSHWidgetSetup.m", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "dsh-widget-version-"));
try {
  const path = join(temporary, "VersionTests.m");
  const binary = join(temporary, "VersionTests");
  await writeFile(path, `#define main DSHUnusedSetupMain
#include ${JSON.stringify(source)}
#undef main
@interface DSHFixtureProxy : NSObject
@property(nonatomic) NSURL *url;
@property(nonatomic) NSDictionary *registeredInfo;
@end
@implementation DSHFixtureProxy
- (NSURL *)bundleURL { return self.url; }
- (NSString *)bundleVersion { return @"1.7.11"; }
- (NSDictionary *)infoPlist { return self.registeredInfo; }
@end
int main(int argc, char **argv) { @autoreleasepool {
  NSArray *cases = @[
    @[@"37-37-(2026-10-27T13:40:58+08:00)", @"37", @"37", @YES],
    @[@"5-9-(2026-10-12T18:58:26+08:00)", @"5", @"9", @YES],
    @[@"38-37-(2026-10-27T05:40:58.123Z)", @"38", @"37", @YES],
    @[@"36-36-(2026-10-27T13:40:58+08:00)", @"37", @"37", @NO],
    @[@"36-37-(2026-10-27T13:40:58+08:00)", @"37", @"37", @NO],
    @[@"37-36-(2026-10-27T13:40:58+08:00)", @"37", @"37", @NO],
    @[@"codec-37-(2026-10-27T13:40:58+08:00)", @"37", @"37", @NO],
    @[@"37-37", @"37", @"37", @NO],
    @[@"37-37-(unknown)", @"37", @"37", @NO],
    @[@"037-37-(2026-10-27T13:40:58+08:00)", @"37", @"37", @NO],
    @[@"37-37-(2026-10-27T13:40:58+08:00)extra", @"37", @"37", @NO],
    @[@"37-37-(2026-10-27T13:40:58+08:00)\\n", @"37", @"37", @NO]
  ];
  for (NSArray *item in cases) {
    if (metadataMatchesBuilds(item[0], @[item[1], item[2]]) != [item[3] boolValue]) {
      fprintf(stderr, "Unexpected version-gate result: %s\\n", [item[0] UTF8String]);
      return 1;
    }
  }
  if (!metadataHasOlderBuilds(@"36-36-(2026-10-27T13:40:58+08:00)", @[@"37", @"37"]) ||
      !metadataHasOlderBuilds(@"37-36-(2026-10-27T13:40:58+08:00)", @[@"37", @"37"]) ||
      metadataHasOlderBuilds(@"37-37-(2026-10-27T13:40:58+08:00)", @[@"37", @"37"]) ||
      metadataHasOlderBuilds(@"36-38-(2026-10-27T13:40:58+08:00)", @[@"37", @"37"]) ||
      metadataHasOlderBuilds(@"38-37-(2026-10-27T13:40:58+08:00)", @[@"37", @"37"]) ||
      metadataHasOlderBuilds(@"unknown", @[@"37", @"37"])) return 9;
  for (id value in @[@"0", @"037", @"37\\n", @"3.7", @"-37", @"1000000000", @37]) {
    if (isBuildNumber(value)) return 2;
  }
  if (!isBuildNumber(@"1") || !isBuildNumber(@"999999999") || metadataMatchesBuilds(@"37-37-(2026-10-27T13:40:58Z)", @[])) return 3;
  DSHFixtureProxy *proxy = [DSHFixtureProxy new];
  proxy.url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]] isDirectory:YES];
  NSURL *infoURL = [proxy.url URLByAppendingPathComponent:@"Info.plist"];
  NSDictionary *info = @{@"CFBundleIdentifier": DSHWidgetBundle, @"CFBundleVersion": @"37", @"CFBundleExecutable": @"AgentLiveActivityWidget"};
  proxy.registeredInfo = info;
  // Real LSPlugInKitProxy uses this marketing getter even while build is37.
  if (![proxy.bundleVersion isEqual:@"1.7.11"] || ![registeredWidgetBuild(proxy) isEqual:@"37"]) return 10;
  [info writeToURL:infoURL atomically:YES];
  if (!diskMatchesRegistration(proxy, DSHWidgetBundle, @"37", @"AgentLiveActivityWidget")) return 4;
  // LS+cache may both be36 while the actual installed file is37.
  if (diskMatchesRegistration(proxy, DSHWidgetBundle, @"36", @"AgentLiveActivityWidget")) return 5;
  if (diskMatchesRegistration(proxy, @"another.app", @"37", @"AgentLiveActivityWidget")) return 6;
  if (diskMatchesRegistration(proxy, DSHWidgetBundle, @"37", @"anotherExecutable")) return 7;
  proxy.url = [NSURL URLWithString:@"https://example.invalid/Widget.appex"];
  if (diskMatchesRegistration(proxy, DSHWidgetBundle, @"37", @"AgentLiveActivityWidget")) return 8;
  puts("native Widget freshness gate: cache/build cases and registered/disk identity checks passed");
  return 0;
} }
`);
  execFileSync("xcrun", ["--sdk", "macosx", "clang", "-fobjc-arc", "-fblocks", "-framework", "Foundation", "-lsqlite3", path, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, [temporary], { stdio: "inherit" });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
