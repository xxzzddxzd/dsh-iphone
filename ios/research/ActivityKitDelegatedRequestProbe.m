#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <unistd.h>

static NSData *DSHBinaryPlist(id object, NSError **error) {
  return [NSPropertyListSerialization dataWithPropertyList:object
                                                    format:NSPropertyListBinaryFormat_v1_0
                                                   options:0
                                                     error:error];
}

static NSData *DSHJSONData(id object, NSError **error) {
  return [NSJSONSerialization dataWithJSONObject:object options:0 error:error];
}

static void DSHPrintObject(NSString *label, id object) {
  printf("%s class=%s value=%s\n",
         label.UTF8String,
         object == nil ? "(nil)" : class_getName(object_getClass(object)),
         object == nil ? "(nil)" : [[object description] UTF8String]);
}

static NSDictionary *DSHRequestPropertyList(NSString *targetBundleIdentifier, NSError **error) {
  NSData *attributes = DSHJSONData(@{
    @"source": @"springboard-delegated-probe",
  }, error);
  if (attributes == nil) return nil;

  int64_t startedAt = (int64_t)(NSDate.date.timeIntervalSince1970 * 1000.0);
  NSData *contentState = DSHJSONData(@{
    @"sessionID": @"springboard-delegated-probe",
    @"title": @"DSH delegated ActivityKit probe",
    @"phase": @"running",
    @"detail": @"Explicit private platter target",
    @"startedAtMilliseconds": @(startedAt),
    @"step": @1,
    @"agentCount": @1,
    @"completedItems": @0,
    @"totalItems": @1,
    @"waitingForUser": @NO,
  }, error);
  if (contentState == nil) return nil;

  return @{
    @"attributesData": attributes,
    @"attributesType": @{ @"attributesType": @"DSHActivityAttributes" },
    @"contentSourceRequests": @[
      @{
        @"process": @{
          @"target": @{
            @"processIdentifier": @{ @"_0": targetBundleIdentifier },
          },
        },
      },
    ],
    @"initialContentStateData": contentState,
    @"isEphemeral": @NO,
    @"isUnbounded": @NO,
    @"platterTarget": @{
      @"widget": @{
        @"containingProcess": @{
          @"processIdentifier": @{ @"_0": targetBundleIdentifier },
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
  };
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IONBF, 0);
    NSString *targetBundleIdentifier = argc > 1
      ? [NSString stringWithUTF8String:argv[1]]
      : @"ai.deepseek.dsh";

    void *handle = dlopen(
      "/System/Library/Frameworks/ActivityKit.framework/ActivityKit",
      RTLD_NOW | RTLD_LOCAL);
    if (handle == NULL) {
      fprintf(stderr, "dlopen failed: %s\n", dlerror());
      return 1;
    }

    Class clientClass = objc_getClass("_TtC11ActivityKit19ActivityInputClient");
    if (clientClass == Nil) {
      fprintf(stderr, "ActivityInputClient is unavailable\n");
      return 2;
    }
    id client = ((id (*)(id, SEL))objc_msgSend)(
      [clientClass alloc], sel_registerName("init"));
    DSHPrintObject(@"client", client);
    if (client == nil) return 3;

    Ivar connectionIvar = class_getInstanceVariable(clientClass, "connection");
    if (connectionIvar == NULL) {
      fprintf(stderr, "ActivityInputClient.connection is unavailable\n");
      return 4;
    }
    id connection = object_getIvar(client, connectionIvar);
    DSHPrintObject(@"connection", connection);
    SEL remoteTargetSelector = sel_registerName("remoteTarget");
    if (connection == nil || ![connection respondsToSelector:remoteTargetSelector]) {
      fprintf(stderr, "ActivityInputClient connection has no remote target\n");
      return 5;
    }
    id remoteTarget = ((id (*)(id, SEL))objc_msgSend)(connection, remoteTargetSelector);
    DSHPrintObject(@"remoteTarget", remoteTarget);

    NSError *serializationError = nil;
    NSDictionary *requestPropertyList = DSHRequestPropertyList(
      targetBundleIdentifier, &serializationError);
    NSData *request = requestPropertyList == nil
      ? nil
      : DSHBinaryPlist(requestPropertyList, &serializationError);
    if (request == nil) {
      fprintf(stderr, "request serialization failed: %s\n",
              serializationError.description.UTF8String);
      return 6;
    }
    printf("requestBytes=%lu target=%s\n",
           (unsigned long)request.length, targetBundleIdentifier.UTF8String);

    NSError *requestError = nil;
    SEL requestSelector = sel_registerName("requestActivityWithRequest:error:");
    id response = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
      remoteTarget, requestSelector, request, &requestError);
    DSHPrintObject(@"response", response);
    if (requestError != nil) DSHPrintObject(@"requestError", requestError);
    if (response == nil) return 7;

    NSError *decodeError = nil;
    id descriptor = [response isKindOfClass:NSData.class]
      ? [NSPropertyListSerialization propertyListWithData:response
                                                   options:NSPropertyListImmutable
                                                    format:NULL
                                                     error:&decodeError]
      : response;
    DSHPrintObject(@"descriptor", descriptor);
    if (decodeError != nil) DSHPrintObject(@"decodeError", decodeError);

    NSString *identifier = [descriptor isKindOfClass:NSDictionary.class]
      ? descriptor[@"id"]
      : nil;
    if (identifier.length == 0) {
      fprintf(stderr, "response has no activity identifier\n");
      return 8;
    }
    printf("CREATED id=%s\n", identifier.UTF8String);

    sleep(2);
    NSError *optionsError = nil;
    NSData *endOptions = DSHBinaryPlist(@{
      @"uiDismissalPolicy": @{ @"date": NSDate.distantPast },
    }, &optionsError);
    if (endOptions == nil) {
      DSHPrintObject(@"endOptionsError", optionsError);
      return 9;
    }
    SEL endSelector = sel_registerName("endActivityWithIdentifier:payload:options:");
    ((void (*)(id, SEL, id, id, id))objc_msgSend)(
      remoteTarget, endSelector, identifier, nil, endOptions);
    printf("END_SENT id=%s optionsBytes=%lu\n",
           identifier.UTF8String, (unsigned long)endOptions.length);
    (void)client;
    (void)handle;
  }
  return 0;
}
