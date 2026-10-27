#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <grp.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <sqlite3.h>
#import <unistd.h>

// This short-lived installer helper targets only this reviewed native client.
// Its permissions are never embedded in the App or its Widget.
static NSString *const DSHWidgetBundle = @"com.clark.dshmobile.dev.AgentLiveActivityWidget";
static NSString *const DSHContainerBundle = @"com.clark.dshmobile.dev";
static const char *const DSHChronoDatabase = "/var/mobile/Library/chronod/chrono.sql";
static NSString *DSHDescriptorFailure;
static NSArray<NSString *> *DSHVerifiedBuilds;
static BOOL DSHStaleDescriptorCache;

static BOOL isBuildNumber(id value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[1-9][0-9]{0,8}$" options:0 error:NULL];
  NSTextCheckingResult *match = [pattern firstMatchInString:value options:0 range:NSMakeRange(0, [value length])];
  return match && match.range.length == [value length];
}

static BOOL diskMatchesRegistration(id proxy, NSString *identifier, NSString *build, NSString *executable) {
  SEL bundleURL = sel_registerName("bundleURL");
  if (![proxy respondsToSelector:bundleURL]) return NO;
  id url = ((id(*)(id,SEL))objc_msgSend)(proxy, bundleURL);
  if (![url isKindOfClass:NSURL.class] || ![url isFileURL]) return NO;
  NSData *data = [NSData dataWithContentsOfURL:[url URLByAppendingPathComponent:@"Info.plist"] options:0 error:NULL];
  if (!data || data.length > 128 * 1024) return NO;
  id info = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:NULL error:NULL];
  return [info isKindOfClass:NSDictionary.class] && [identifier isEqual:info[@"CFBundleIdentifier"]] &&
         [build isEqual:info[@"CFBundleVersion"]] && [executable isEqual:info[@"CFBundleExecutable"]];
}

static NSString *registeredWidgetBuild(id widget) {
  SEL infoPlist = sel_registerName("infoPlist");
  if (![widget respondsToSelector:infoPlist]) return nil;
  id info = ((id(*)(id,SEL))objc_msgSend)(widget, infoPlist);
  id build = [info isKindOfClass:NSDictionary.class] ? info[@"CFBundleVersion"] : nil;
  // LSPlugInKitProxy.bundleVersion is the marketing version on iOS 16.1;
  // its registered Info.plist carries the extension's actual build number.
  return isBuildNumber(build) ? build : nil;
}

static NSArray<NSString *> *registeredBuilds(void) {
  Class proxyClass = NSClassFromString(@"LSPlugInKitProxy");
  SEL lookup = sel_registerName("pluginKitProxyForIdentifier:");
  if (![proxyClass respondsToSelector:lookup]) return nil;
  id widget = ((id(*)(id,SEL,id))objc_msgSend)(proxyClass, lookup, DSHWidgetBundle);
  if (![widget respondsToSelector:sel_registerName("containingBundle")]) return nil;
  id app = ((id(*)(id,SEL))objc_msgSend)(widget, sel_registerName("containingBundle"));
  SEL identifier = sel_registerName("bundleIdentifier");
  SEL version = sel_registerName("bundleVersion");
  if (![app respondsToSelector:identifier] || ![app respondsToSelector:version] || ![widget respondsToSelector:identifier]) return nil;
  if (![DSHContainerBundle isEqual:((id(*)(id,SEL))objc_msgSend)(app, identifier)] ||
      ![DSHWidgetBundle isEqual:((id(*)(id,SEL))objc_msgSend)(widget, identifier)]) return nil;
  id appBuild = ((id(*)(id,SEL))objc_msgSend)(app, version);
  id widgetBuild = registeredWidgetBuild(widget);
  if (!isBuildNumber(appBuild) || !isBuildNumber(widgetBuild)) return nil;
  if (!diskMatchesRegistration(app, DSHContainerBundle, appBuild, @"DshMobile") ||
      !diskMatchesRegistration(widget, DSHWidgetBundle, widgetBuild, @"AgentLiveActivityWidget")) return nil;
  return @[appBuild, widgetBuild];
}

static NSArray<NSString *> *metadataBuilds(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  // Observed iOS 16.1 form: <containing-app-build>-<widget-build>-(ISO date).
  // Reject unknown forms; both versions must match current LaunchServices data.
  NSString *expression = @"^([1-9][0-9]{0,8})-([1-9][0-9]{0,8})-\\([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})\\)$";
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:expression options:0 error:NULL];
  NSTextCheckingResult *match = [pattern firstMatchInString:value options:0 range:NSMakeRange(0, value.length)];
  if (!match || match.range.length != value.length) return nil;
  return @[[value substringWithRange:[match rangeAtIndex:1]], [value substringWithRange:[match rangeAtIndex:2]]];
}

static BOOL metadataMatchesBuilds(NSString *value, NSArray<NSString *> *builds) {
  return builds.count == 2 && [metadataBuilds(value) isEqual:builds];
}

static BOOL metadataHasOlderBuilds(NSString *value, NSArray<NSString *> *builds) {
  NSArray<NSString *> *cached = metadataBuilds(value);
  if (cached.count != 2 || builds.count != 2) return NO;
  long long app = cached[0].longLongValue, widget = cached[1].longLongValue;
  long long currentApp = builds[0].longLongValue, currentWidget = builds[1].longLongValue;
  return app <= currentApp && widget <= currentWidget && (app < currentApp || widget < currentWidget);
}

static int fail(const char *message) {
  fprintf(stderr, "DSHWidgetSetup: %s\n", message);
  return 1;
}

static BOOL checkDescriptors(void) {
  DSHStaleDescriptorCache = NO;
  NSArray<NSString *> *builds = registeredBuilds();
  if (!builds) { DSHDescriptorFailure = @"the registered native App and Widget builds could not be verified"; return NO; }
  sqlite3 *database = NULL;
  sqlite3_stmt *statement = NULL;
  NSString *cachedVersion = nil;
  BOOL valid = NO;
  DSHDescriptorFailure = @"cannot read the mobile chronod database";
  if (sqlite3_open_v2(DSHChronoDatabase, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, NULL) != SQLITE_OK) goto done;
  sqlite3_busy_timeout(database, 500);
  DSHDescriptorFailure = @"unsupported chronod descriptor schema";
  if (sqlite3_prepare_v2(database, "SELECT d.data,m.version FROM Descriptors d JOIN ExtensionMetadata m ON m.bundleIdentifier=d.bundleIdentifier WHERE d.bundleIdentifier = ? AND d.descriptorType = 1", -1, &statement, NULL) != SQLITE_OK) goto done;
  sqlite3_bind_text(statement, 1, DSHWidgetBundle.UTF8String, -1, SQLITE_STATIC);
  DSHDescriptorFailure = @"the native Live Activity descriptors have not been registered";
  if (sqlite3_step(statement) != SQLITE_ROW) goto done;
  DSHDescriptorFailure = @"the cached Widget descriptor version has an unsupported format";
  const char *version = (const char *)sqlite3_column_text(statement, 1);
  cachedVersion = version ? [NSString stringWithUTF8String:version] : nil;
  if (!metadataBuilds(cachedVersion)) goto done;
  int size = sqlite3_column_bytes(statement, 0);
  if (size <= 0 || size > 1024 * 1024) goto done;
  @try {
    // The protected, system-authored archive contains Live Activity descriptors.
    // CHSConnection.descriptors: only exposes ordinary Widgets on iOS 16.1.
    NSData *data = [NSData dataWithBytes:sqlite3_column_blob(statement, 0) length:(NSUInteger)size];
    NSError *error = nil;
    Class descriptorClass = NSClassFromString(@"CHSSessionPlatterDescriptor");
    if (!descriptorClass) goto done;
    NSSet *classes = [NSSet setWithObjects:NSArray.class, descriptorClass, nil];
    id descriptors = [NSKeyedUnarchiver unarchivedObjectOfClasses:classes fromData:data error:&error];
    if (error) { DSHDescriptorFailure = [NSString stringWithFormat:@"descriptor decode failed: %@/%ld", error.domain, (long)error.code]; goto done; }
    DSHDescriptorFailure = @"unexpected descriptor archive type";
    if (![descriptors isKindOfClass:NSArray.class]) goto done;
    NSMutableSet<NSString *> *types = [NSMutableSet new];
    for (id descriptor in descriptors) {
      DSHDescriptorFailure = @"unexpected Live Activity descriptor class";
      if (![descriptor isKindOfClass:descriptorClass]) goto done;
      id extension = ((id(*)(id,SEL))objc_msgSend)(descriptor, sel_registerName("extensionBundleIdentifier"));
      id container = ((id(*)(id,SEL))objc_msgSend)(descriptor, sel_registerName("containerBundleIdentifier"));
      DSHDescriptorFailure = @"Live Activity descriptor ownership does not match the native App";
      if (![extension isEqual:DSHWidgetBundle] || ![container isEqual:DSHContainerBundle]) goto done;
      id attributes = ((id(*)(id,SEL))objc_msgSend)(descriptor, sel_registerName("activityAttributesType"));
      if ([attributes isKindOfClass:NSData.class] && [attributes length] <= 1024) {
        attributes = [NSPropertyListSerialization propertyListWithData:attributes options:NSPropertyListImmutable format:NULL error:NULL];
      }
      id name = [attributes isKindOfClass:NSDictionary.class] ? attributes[@"attributesType"] : nil;
      if (!name && [attributes respondsToSelector:sel_registerName("attributesType")]) {
        name = ((id(*)(id,SEL))objc_msgSend)(attributes, sel_registerName("attributesType"));
      }
      DSHDescriptorFailure = [NSString stringWithFormat:@"unsupported ActivityAttributes type wrapper: %@", NSStringFromClass([attributes class])];
      if (![name isKindOfClass:NSString.class]) goto done;
      [types addObject:name];
    }
    valid = [types containsObject:@"DSHActivityAttributes"] && [types containsObject:@"AgentActivityAttributes"];
    DSHDescriptorFailure = @"both native Live Activity attribute types are required";
    if (sqlite3_step(statement) != SQLITE_DONE) valid = NO;
    if (valid && !metadataMatchesBuilds(cachedVersion, builds)) {
      // Code2 is reserved for an otherwise valid older cache. Unexpected newer
      // versions, malformed archives and identity failures never request reload.
      DSHStaleDescriptorCache = metadataHasOlderBuilds(cachedVersion, builds);
      DSHDescriptorFailure = @"cached Widget descriptors do not match the registered native App/Widget builds";
      valid = NO;
    }
    if (valid) DSHVerifiedBuilds = builds;
  } @catch (__unused NSException *exception) {
    DSHDescriptorFailure = @"the system descriptor archive could not be decoded";
    valid = NO;
  }
done:
  if (statement) sqlite3_finalize(statement);
  if (database) sqlite3_close(database);
  return valid;
}

int main(int argc, char **argv) { @autoreleasepool {
  if (argc != 1) return fail("no arguments are accepted");
  // Bound synchronous service calls as well as the asynchronous cache request.
  alarm(30);
  if (geteuid() == 0) {
    if (setgroups(0, NULL) || setgid(501) || setuid(501)) return fail("cannot adopt the mobile user");
  }
  if (getuid() != 501 || geteuid() != 501 || getgid() != 501) return fail("the mobile user is required");
  if (!dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", RTLD_NOW)) return fail("LaunchServices is unavailable");
  if (!dlopen("/System/Library/PrivateFrameworks/ChronoServices.framework/ChronoServices", RTLD_NOW)) return fail("ChronoServices is unavailable");
  Class connectionClass = NSClassFromString(@"CHSChronoServicesConnection");
  Class toolClass = NSClassFromString(@"CHSToolServiceConnection");
  SEL shared = sel_registerName("sharedInstance");
  SEL query = sel_registerName("descriptors:");
  SEL cache = sel_registerName("cacheDescriptorsForBundleIdentifier:completion:");
  if (![connectionClass respondsToSelector:shared] || ![toolClass respondsToSelector:shared]) return fail("unsupported ChronoServices classes");
  id connection = ((id(*)(id,SEL))objc_msgSend)(connectionClass, shared);
  id tool = ((id(*)(id,SEL))objc_msgSend)(toolClass, shared);
  if (![connection respondsToSelector:query] || ![tool respondsToSelector:cache]) return fail("unsupported ChronoServices methods");
  NSError *error = nil;
  id ordinaryWidgets = ((id(*)(id,SEL,NSError**))objc_msgSend)(connection, query, &error);
  if (!ordinaryWidgets || error) return fail("ChronoServices connection was rejected");
  dispatch_semaphore_t completion = dispatch_semaphore_create(0);
  // The private completion's arguments are intentionally neither assumed nor read.
  ((void(*)(id,SEL,id,id))objc_msgSend)(tool, cache, DSHWidgetBundle, ^{ dispatch_semaphore_signal(completion); });
  if (dispatch_semaphore_wait(completion, dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_SEC))) return fail("Widget descriptor refresh timed out");
  for (unsigned attempt = 0; attempt < 10; attempt++) {
    if (checkDescriptors()) {
      alarm(0);
      printf("{\"status\":\"ready\",\"widgetBundleId\":\"com.clark.dshmobile.dev.AgentLiveActivityWidget\",\"appBuild\":\"%s\",\"widgetBuild\":\"%s\",\"attributes\":[\"AgentActivityAttributes\",\"DSHActivityAttributes\"]}\n", DSHVerifiedBuilds[0].UTF8String, DSHVerifiedBuilds[1].UTF8String);
      return 0;
    }
    usleep(200000);
  }
  fail(DSHDescriptorFailure.UTF8String ?: "the native Live Activity descriptors could not be verified");
  return DSHStaleDescriptorCache ? 2 : 1;
} }
