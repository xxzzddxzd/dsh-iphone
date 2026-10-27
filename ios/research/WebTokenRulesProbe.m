#import <Foundation/Foundation.h>
#import <JavaScriptCore/JavaScriptCore.h>
#import <math.h>
#import <stdlib.h>
#import <sys/stat.h>
#import <unistd.h>

// Parser/registration gate only. Never invoke a plugin factory or expose Host APIs.
static NSString *const StagePrefix = @"/var/root/dsh-web-token-probes/";

static int fail(const char *message) {
  fprintf(stderr, "WebTokenRulesProbe: %s\n", message);
  return 1;
}

static BOOL validStage(NSString *path) {
  if (![path hasPrefix:StagePrefix]) return NO;
  NSString *name = [path substringFromIndex:StagePrefix.length];
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[a-f0-9]{32}$" options:0 error:NULL];
  NSTextCheckingResult *match = [pattern firstMatchInString:name options:0 range:NSMakeRange(0, name.length)];
  struct stat info;
  return match && match.range.length == name.length &&
      lstat(path.fileSystemRepresentation, &info) == 0 && S_ISDIR(info.st_mode) &&
      info.st_uid == 0 && (info.st_mode & 0077) == 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2 || getuid() != 0) return fail("one private research stage and the device root user are required");
    NSString *stage = [NSString stringWithUTF8String:argv[1]];
    if (!validStage(stage)) return fail("invalid private research stage");
    // Bound malformed or non-terminating input without changing any service.
    alarm(20);
    setenv("JSC_useJIT", "false", 1);
    NSMutableArray *reports = [NSMutableArray new];
    BOOL passed = YES;
    for (NSString *name in @[@"skill", @"reference", @"goal"]) {
      NSString *path = [stage stringByAppendingPathComponent:[name stringByAppendingString:@".js"]];
      struct stat info;
      if (lstat(path.fileSystemRepresentation, &info) != 0 || !S_ISREG(info.st_mode) ||
          info.st_uid != 0 || (info.st_mode & 0077) != 0 || info.st_size <= 0 || info.st_size > 2 * 1024 * 1024) {
        return fail("a fixed client source is missing or invalid");
      }
      NSString *source = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
      if (!source) return fail("a fixed client source is not UTF-8");
      NSString *expected = [@"@deepseek-ai/dsh-client-ui-" stringByAppendingString:name];
      JSContext *context = [JSContext new];
      __block NSString *errorType = nil;
      __block NSNumber *errorLine = nil;
      context.exceptionHandler = ^(JSContext *ctx, JSValue *exception) {
        (void)ctx;
        NSString *type = [exception[@"name"] toString];
        // Do not print an exception message: it may quote arbitrary input text.
        errorType = [@[@"SyntaxError", @"ReferenceError", @"TypeError", @"RangeError", @"Error"] containsObject:type]
            ? type : @"JavaScriptError";
        JSValue *line = exception[@"line"];
        if (line.isNumber && isfinite(line.toDouble) && line.toDouble >= 0 && line.toDouble <= 10000000) {
          errorLine = line.toNumber;
        }
      };
      [context evaluateScript:@"var window=this; var __dshProbeRecords=[]; window.__ModuleLoader__={load:function(v){__dshProbeRecords.push({id:v&&v.id,factory:!!v&&typeof v.factory==='function'});}};"];
      if (errorType) return fail("the registration recorder could not initialize");
      [context evaluateScript:source withSourceURL:[NSURL URLWithString:[NSString stringWithFormat:@"https://probe.invalid/%@.js", name]]];
      NSArray *records = [context[@"__dshProbeRecords"] toArray];
      BOOL registration = records.count == 1 && [records[0] isKindOfClass:NSDictionary.class] &&
          [records[0][@"id"] isEqual:expected] && [records[0][@"factory"] isEqual:@YES];
      BOOL good = errorType == nil && registration;
      passed &= good;
      NSMutableDictionary *report = [@{ @"module": name, @"expectedId": expected,
          @"registeredCount": @(records.count), @"registrationValid": @(registration), @"passed": @(good) } mutableCopy];
      if (errorType) report[@"errorType"] = errorType;
      if (errorLine) report[@"errorLine"] = errorLine;
      [reports addObject:report];
    }
    alarm(0);
    NSDictionary *result = @{ @"status": passed ? @"passed" : @"failed", @"probe": @"ios-jsc-token-registration", @"modules": reports };
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    if (!json) return fail("cannot encode the probe result");
    puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    return passed ? 0 : 1;
  }
}
