#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <stdio.h>
#import <objc/message.h>
#import <objc/runtime.h>

static NSString *const DSHActivityTargetBundleIdentifier = @"ai.deepseek.dsh";
static const NSUInteger DSHActivityMaximumDataBytes = 4 * 1024;

static NSString *DSHActivitySafeError(NSString *message) {
  if (message.length == 0) return @"unknown ActivityKit error";
  NSString *singleLine = [[message stringByReplacingOccurrencesOfString:@"\r" withString:@" "]
      stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
  return singleLine.length <= 512 ? singleLine : [singleLine substringToIndex:512];
}

static int DSHActivityFail(NSString *message) {
  fprintf(stdout, "ERR %s\n", DSHActivitySafeError(message).UTF8String);
  return 1;
}

static NSData *DSHActivityPropertyListData(id object, NSString **errorMessage) {
  NSError *error = nil;
  NSData *data = [NSPropertyListSerialization dataWithPropertyList:object
                                                            format:NSPropertyListBinaryFormat_v1_0
                                                           options:0
                                                             error:&error];
  if (data == nil && errorMessage != NULL) {
    *errorMessage = [NSString stringWithFormat:@"property-list serialization failed: %@", error];
  }
  return data;
}

static NSDictionary *DSHActivityDecodePropertyList(id value, NSString **errorMessage) {
  if (![value isKindOfClass:[NSData class]]) {
    if (errorMessage != NULL) *errorMessage = @"ActivityKit returned an invalid response";
    return nil;
  }
  NSError *error = nil;
  id object = [NSPropertyListSerialization propertyListWithData:value
                                                        options:NSPropertyListImmutable
                                                         format:NULL
                                                          error:&error];
  if (![object isKindOfClass:[NSDictionary class]]) {
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"ActivityKit response decoding failed: %@", error];
    }
    return nil;
  }
  return object;
}

static NSData *DSHActivityStateData(const char *argument, NSString **errorMessage) {
  if (argument == NULL) {
    if (errorMessage != NULL) *errorMessage = @"missing task state";
    return nil;
  }
  NSData *data = [[NSString stringWithUTF8String:argument]
      dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  id object = data == nil
      ? nil
      : [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![object isKindOfClass:[NSDictionary class]]) {
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"invalid task state: %@", error];
    }
    return nil;
  }
  if (data.length > DSHActivityMaximumDataBytes) {
    if (errorMessage != NULL) *errorMessage = @"task state exceeds ActivityKit's 4 KB limit";
    return nil;
  }
  return data;
}

static id DSHActivityRemoteTarget(id __strong *retainedClient, NSString **errorMessage) {
  if (dlopen("/System/Library/Frameworks/ActivityKit.framework/ActivityKit",
             RTLD_NOW | RTLD_LOCAL) == NULL) {
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"ActivityKit load failed: %s", dlerror()];
    }
    return nil;
  }
  Class clientClass = objc_getClass("_TtC11ActivityKit19ActivityInputClient");
  Ivar connectionIvar = clientClass == Nil
      ? NULL
      : class_getInstanceVariable(clientClass, "connection");
  if (clientClass == Nil || connectionIvar == NULL) {
    if (errorMessage != NULL) *errorMessage = @"private ActivityKit input API is unavailable";
    return nil;
  }
  id client = ((id (*)(id, SEL))objc_msgSend)(
      [clientClass alloc], sel_registerName("init"));
  id connection = client == nil ? nil : object_getIvar(client, connectionIvar);
  id target = connection == nil
      ? nil
      : ((id (*)(id, SEL))objc_msgSend)(connection, sel_registerName("remoteTarget"));
  if (target == nil) {
    if (errorMessage != NULL) *errorMessage = @"ActivityKit input service is unavailable";
    return nil;
  }
  if (retainedClient != NULL) *retainedClient = client;
  return target;
}

static int DSHActivityCreate(id target, NSData *contentState) {
  NSString *errorMessage = nil;
  NSData *attributes = [NSJSONSerialization dataWithJSONObject:@{ @"source": @"dsh" }
                                                        options:0
                                                          error:NULL];
  if (attributes.length + contentState.length > DSHActivityMaximumDataBytes) {
    return DSHActivityFail(@"attributes and task state exceed ActivityKit's 4 KB limit");
  }
  NSData *request = DSHActivityPropertyListData(@{
    @"attributesData": attributes,
    @"attributesType": @{ @"attributesType": @"DSHActivityAttributes" },
    @"contentSourceRequests": @[],
    @"initialContentStateData": contentState,
    @"isEphemeral": @NO,
    @"isUnbounded": @NO,
    @"platterTarget": @{
      @"widget": @{
        @"containingProcess": @{
          @"processIdentifier": @{ @"_0": DSHActivityTargetBundleIdentifier },
        },
      },
    },
    @"presentationOptions": @{
      @"destinations": @[
        @{ @"lockscreen": @{} },
        @{ @"systemAperture": @{} },
        @{ @"banner": @{} },
      ],
      @"isUserDismissalAllowedOnLockScreen": @YES,
      @"showsAuthorizationOptions": @NO,
    },
  }, &errorMessage);
  if (request == nil) return DSHActivityFail(errorMessage);

  NSError *requestError = nil;
  id response = nil;
  @try {
    response = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
        target,
        sel_registerName("requestActivityWithRequest:error:"),
        request,
        &requestError);
  } @catch (NSException *exception) {
    return DSHActivityFail(exception.reason ?: exception.description);
  }
  if (response == nil) {
    NSError *underlying = requestError.userInfo[NSUnderlyingErrorKey];
    return DSHActivityFail(underlying == nil
        ? requestError.description
        : [NSString stringWithFormat:@"%@; underlying: %@", requestError, underlying]);
  }

  NSDictionary *descriptor = DSHActivityDecodePropertyList(response, &errorMessage);
  NSString *identifier = descriptor[@"id"];
  NSString *targetBundle = descriptor[@"platterTarget"][@"widget"]
      [@"containingProcess"][@"bundleIdentifier"];
  if ([[NSUUID alloc] initWithUUIDString:identifier] == nil ||
      ![targetBundle isEqualToString:DSHActivityTargetBundleIdentifier]) {
    return DSHActivityFail(errorMessage ?: @"ActivityKit returned the wrong activity target");
  }
  fprintf(stdout, "OK created %s\n", identifier.UTF8String);
  return 0;
}

static int DSHActivityUpdate(id target, NSString *identifier, NSData *contentState) {
  NSString *errorMessage = nil;
  NSData *payload = DSHActivityPropertyListData(@{
    @"contentState": contentState,
    @"timestamp": NSDate.date,
  }, &errorMessage);
  if (payload == nil) return DSHActivityFail(errorMessage);
  @try {
    ((void (*)(id, SEL, id, id))objc_msgSend)(
        target,
        sel_registerName("updateActivityWithIdentifier:payload:"),
        identifier,
        payload);
  } @catch (NSException *exception) {
    return DSHActivityFail(exception.reason ?: exception.description);
  }
  fprintf(stdout, "OK updated\n");
  return 0;
}

static int DSHActivityEnd(id target, NSString *identifier) {
  NSString *errorMessage = nil;
  NSData *options = DSHActivityPropertyListData(@{
    @"uiDismissalPolicy": @{ @"date": NSDate.distantPast },
  }, &errorMessage);
  if (options == nil) return DSHActivityFail(errorMessage);
  @try {
    ((void (*)(id, SEL, id, id, id))objc_msgSend)(
        target,
        sel_registerName("endActivityWithIdentifier:payload:options:"),
        identifier,
        nil,
        options);
  } @catch (NSException *exception) {
    return DSHActivityFail(exception.reason ?: exception.description);
  }
  fprintf(stdout, "OK ended\n");
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc < 2) return DSHActivityFail(@"missing operation");
    NSString *operation = [NSString stringWithUTF8String:argv[1]];
    NSString *identifier = argc > 2
        ? [NSString stringWithUTF8String:argv[2]]
        : nil;
    BOOL isCreate = [operation isEqualToString:@"create"];
    BOOL isUpdate = [operation isEqualToString:@"update"];
    BOOL isEnd = [operation isEqualToString:@"end"];
    if ((!isCreate && !isUpdate && !isEnd) ||
        (isCreate && argc != 3) ||
        (isUpdate && argc != 4) ||
        (isEnd && argc != 3)) {
      return DSHActivityFail(@"invalid operation arguments");
    }
    if (!isCreate && [[NSUUID alloc] initWithUUIDString:identifier] == nil) {
      return DSHActivityFail(@"invalid activity identifier");
    }

    NSString *errorMessage = nil;
    NSData *contentState = isCreate
        ? DSHActivityStateData(argv[2], &errorMessage)
        : (isUpdate ? DSHActivityStateData(argv[3], &errorMessage) : nil);
    if ((isCreate || isUpdate) && contentState == nil) {
      return DSHActivityFail(errorMessage);
    }

    __attribute__((objc_precise_lifetime)) id client = nil;
    id target = DSHActivityRemoteTarget(&client, &errorMessage);
    if (target == nil) return DSHActivityFail(errorMessage);
    if (isCreate) return DSHActivityCreate(target, contentState);
    if (isUpdate) return DSHActivityUpdate(target, identifier, contentState);
    return DSHActivityEnd(target, identifier);
  }
}
