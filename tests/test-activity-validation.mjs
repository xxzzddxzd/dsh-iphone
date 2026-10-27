import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "dsh-activity-validation-"));
try {
  const worker = fileURLToPath(new URL("../ios/activity/DSHActivityWorker.m", import.meta.url));
  const bridge = fileURLToPath(new URL("../ios/activity/DSHActivityBridge.m", import.meta.url));
  const programs = {
    worker: `#define main DSHActivityWorkerMain
#import "${worker}"
#undef main
int main(void) { @autoreleasepool {
  NSUInteger budget = DSHActivityMaximumDataBytes - DSHActivityAttributesData().length;
  NSString *empty = @"{\\"p\\":\\"\\"}";
  NSString *padding = [@"" stringByPaddingToLength:budget - [empty lengthOfBytesUsingEncoding:NSUTF8StringEncoding]
                                      withString:@"x" startingAtIndex:0];
  NSString *boundary = [NSString stringWithFormat:@"{\\"p\\":\\"%@\\"}", padding];
  NSCAssert(DSHActivityStateData(boundary.UTF8String, NULL) != nil, @"exact combined 4 KB boundary must pass");
  NSString *over = [NSString stringWithFormat:@"{\\"p\\":\\"%@x\\"}", padding];
  NSString *error = nil;
  NSCAssert(DSHActivityStateData(over.UTF8String, &error) == nil, @"one byte above combined limit must fail");
  NSCAssert([error containsString:@"4 KB"], @"oversized updates need a useful error");
  const char *update[] = { "DSHActivityOp", "update", "12345678-1234-1234-1234-123456789ABC", over.UTF8String };
  NSCAssert(DSHActivityWorkerMain(4, update) == 1, @"oversized updates must fail before loading ActivityKit");
  NSDictionary *mismatch = @{ @"sessionID": @"session-a",
    @"launchURL": @"dshmobile://session?gateway=ABCDEF01-1234-1234-1234-123456789ABC&id=session-b" };
  NSData *state = [NSJSONSerialization dataWithJSONObject:mismatch options:0 error:NULL];
  NSCAssert(DSHActivityCreate(nil, state, DSHActivityNativeTarget) == 1,
      @"native creation must reject the wrong session before calling XPC");
} return 0; }
`,
    bridge: `#define main DSHActivityBridgeMain
#import "${bridge}"
#undef main
static NSString *commandReply(NSDictionary *command) {
  int pair[2];
  NSCAssert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0, @"socketpair");
  NSMutableData *request = [[NSJSONSerialization dataWithJSONObject:command options:0 error:NULL] mutableCopy];
  [request appendBytes:"\\n" length:1];
  NSCAssert(write(pair[0], request.bytes, request.length) == (ssize_t)request.length, @"request write");
  DSHActivityHandleClient(pair[1]);
  close(pair[1]);
  NSMutableData *response = [NSMutableData data];
  char buffer[2048]; ssize_t count;
  while ((count = read(pair[0], buffer, sizeof(buffer))) > 0) [response appendBytes:buffer length:(NSUInteger)count];
  close(pair[0]);
  return [[NSString alloc] initWithData:response encoding:NSUTF8StringEncoding];
}
int main(void) { @autoreleasepool {
  for (id operation in @[@1, @[], @{}, NSNull.null]) {
    NSString *reply = commandReply(@{ @"version": @1, @"operation": operation });
    NSCAssert([reply hasPrefix:@"ERR "], @"non-string operations must return errors without crashing");
  }
  NSCAssert([commandReply(@{ @"version": @1 }) hasPrefix:@"ERR "], @"missing operation must fail");
  NSString *sessionID = [@"" stringByPaddingToLength:512 withString:@"s" startingAtIndex:0];
  DSHActivityIdentifier = @"12345678-1234-1234-1234-123456789ABC";
  DSHActivityTargetBundle = DSHActivityNativeTarget;
  DSHActivityTask = @{ @"sessionID": sessionID, @"startedAtMilliseconds": @1793070000000LL };
  NSString *reply = commandReply(@{ @"version": @1, @"operation": @"inspect" });
  NSCAssert(reply.length > 512 && [reply hasPrefix:@"OK "], @"inspect must preserve long JSON");
  NSData *json = [[reply substringFromIndex:3] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *view = [NSJSONSerialization JSONObjectWithData:json options:0 error:NULL];
  NSCAssert([view[@"task"][@"sessionID"] isEqual:sessionID], @"inspect must return complete valid JSON");
  NSMutableDictionary *task = [@{ @"sessionID": @"session-a", @"title": @"Task", @"phase": @"Running", @"detail": @"",
    @"startedAtMilliseconds": @1, @"step": @0, @"completedItems": @0, @"totalItems": @0, @"waitingForUser": @NO,
    @"launchURL": @"dshmobile://session?gateway=ABCDEF01-1234-1234-1234-123456789ABC&id=session-b" } mutableCopy];
  NSString *error = nil;
  NSCAssert(DSHActivityValidatedState(task, &error) == nil, @"mismatched native URL must be rejected");
  NSCAssert([error containsString:@"sessionID"], @"native mismatch should identify the contract error");
  task[@"launchURL"] = @"dshmobile://session?gateway=ABCDEF01-1234-1234-1234-123456789ABC&id=session-a";
  NSCAssert(DSHActivityValidatedState(task, NULL) != nil, @"matching native session URL must remain valid");
} return 0; }
`,
  };
  for (const [name, source] of Object.entries(programs)) {
    const path = join(root, `${name}.m`);
    const binary = join(root, name);
    await writeFile(path, source);
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-framework", "Foundation", path, "-o", binary]);
    const output = execFileSync(binary, [], { encoding: "utf8" });
    if (name === "worker") assert.match(output, /ERR native activity requires a matching native session URL/);
  }
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Activity validation checks combined 4 KB, matching links, operation types and complete inspect JSON");
