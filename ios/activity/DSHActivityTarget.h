#import <Foundation/Foundation.h>
#import <sys/stat.h>

static NSString *const DSHActivityLegacyTarget = @"ai.deepseek.dsh";
static NSString *const DSHActivityNativeTarget = @"com.clark.dshmobile.dev";

static BOOL DSHActivityAllowedTarget(NSString *value) {
  return [value isEqualToString:DSHActivityLegacyTarget] ||
      [value isEqualToString:DSHActivityNativeTarget];
}

/** A root-published, installed-build-bound capability; no credentials involved. */
static NSString *DSHActivitySelectTarget(NSString *path, uid_t expectedOwner) {
  struct stat info;
  if (lstat(path.fileSystemRepresentation, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_uid != expectedOwner || (info.st_mode & 0022) != 0 || info.st_size > 16384) {
    return DSHActivityLegacyTarget;
  }
  NSData *data = [NSData dataWithContentsOfFile:path];
  id value = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  if (![value isKindOfClass:NSDictionary.class]) return DSHActivityLegacyTarget;
  NSDictionary *marker = value;
  for (NSString *key in @[@"bundleId", @"attributesType", @"widgetKind", @"build", @"version", @"bundlePath"]) {
    if (![marker[key] isKindOfClass:NSString.class]) return DSHActivityLegacyTarget;
  }
  if (![marker[@"schema"] isEqual:@1] ||
      ![@"dsh-iphone/native-client" isEqual:marker[@"managedBy"]] ||
      ![marker[@"bundleId"] isEqualToString:DSHActivityNativeTarget] ||
      ![marker[@"attributesType"] isEqualToString:@"DSHActivityAttributes"] ||
      ![marker[@"widgetKind"] isEqualToString:@"DSHRootActivityWidget"] ||
      ![marker[@"build"] isKindOfClass:NSString.class] ||
      ![marker[@"version"] isKindOfClass:NSString.class] ||
      ![marker[@"bundlePath"] isKindOfClass:NSString.class]) return DSHActivityLegacyTarget;
  NSString *build = marker[@"build"];
  NSCharacterSet *nonDigits = NSCharacterSet.decimalDigitCharacterSet.invertedSet;
  if (build.length == 0 || [build rangeOfCharacterFromSet:nonDigits].location != NSNotFound ||
      build.integerValue < 35) return DSHActivityLegacyTarget;
  NSString *app = marker[@"bundlePath"];
  NSDictionary *appInfo = [NSDictionary dictionaryWithContentsOfFile:[app stringByAppendingPathComponent:@"Info.plist"]];
  NSString *widgetPath = [app stringByAppendingPathComponent:@"PlugIns/AgentLiveActivityWidget.appex/Info.plist"];
  NSDictionary *widget = [NSDictionary dictionaryWithContentsOfFile:widgetPath];
  NSDictionary *extension = widget[@"NSExtension"];
  if (![extension isKindOfClass:NSDictionary.class] ||
      ![DSHActivityNativeTarget isEqual:appInfo[@"CFBundleIdentifier"]] ||
      ![@"com.clark.dshmobile.dev.AgentLiveActivityWidget" isEqual:widget[@"CFBundleIdentifier"]] ||
      ![@"com.apple.widgetkit-extension" isEqual:extension[@"NSExtensionPointIdentifier"]] ||
      ![appInfo[@"CFBundleVersion"] isEqual:build] || ![widget[@"CFBundleVersion"] isEqual:build] ||
      ![appInfo[@"CFBundleShortVersionString"] isEqual:marker[@"version"]] ||
      ![widget[@"CFBundleShortVersionString"] isEqual:marker[@"version"]]) return DSHActivityLegacyTarget;
  return DSHActivityNativeTarget;
}
