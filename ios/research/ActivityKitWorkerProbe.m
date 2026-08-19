#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static id DSHRemoteTarget(id *retainedClient) {
  if (dlopen("/System/Library/Frameworks/ActivityKit.framework/ActivityKit",
             RTLD_NOW | RTLD_LOCAL) == NULL) return nil;
  Class cls = objc_getClass("_TtC11ActivityKit19ActivityInputClient");
  Ivar ivar = class_getInstanceVariable(cls, "connection");
  id client = ((id (*)(id, SEL))objc_msgSend)([cls alloc], sel_registerName("init"));
  id connection = client == nil ? nil : object_getIvar(client, ivar);
  id target = connection == nil ? nil : ((id (*)(id, SEL))objc_msgSend)(
    connection, sel_registerName("remoteTarget"));
  if (retainedClient != NULL) *retainedClient = client;
  return target;
}

static NSData *DSHPlist(id object) {
  return [NSPropertyListSerialization dataWithPropertyList:object
                                                    format:NSPropertyListBinaryFormat_v1_0
                                                   options:0
                                                     error:NULL];
}

static NSData *DSHJSON(id object) {
  return [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];
}

static NSDictionary *DSHState(NSString *phase) {
  return @{
    @"sessionID": @"headless-worker-probe",
    @"title": @"DSH headless worker",
    @"phase": phase,
    @"detail": @"Cross-process ActivityKit identity probe",
    @"startedAtMilliseconds": @1787129800000,
    @"step": [phase isEqualToString:@"created"] ? @1 : @2,
    @"completedItems": [phase isEqualToString:@"created"] ? @0 : @1,
    @"totalItems": @2,
    @"waitingForUser": @NO,
  };
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc < 2) {
      fprintf(stderr, "usage: ActivityKitWorkerProbe create|status|update <uuid>|end <uuid>\n");
      return 2;
    }
    NSString *operation = [NSString stringWithUTF8String:argv[1]];
    NSString *identifier = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : nil;
    if (![operation isEqualToString:@"create"] &&
        ![operation isEqualToString:@"status"] &&
        [[NSUUID alloc] initWithUUIDString:identifier] == nil) {
      fprintf(stderr, "operation requires an activity UUID\n");
      return 2;
    }
    id client = nil;
    id target = DSHRemoteTarget(&client);
    if (target == nil) {
      fprintf(stderr, "ActivityKit input service is unavailable\n");
      return 1;
    }

    if ([operation isEqualToString:@"create"]) {
      NSData *request = DSHPlist(@{
        @"attributesData": DSHJSON(@{ @"source": @"headless-worker" }),
        @"attributesType": @{ @"attributesType": @"DSHActivityAttributes" },
        @"contentSourceRequests": @[],
        @"initialContentStateData": DSHJSON(DSHState(@"created")),
        @"isEphemeral": @NO,
        @"isUnbounded": @NO,
        @"platterTarget": @{
          @"widget": @{
            @"containingProcess": @{
              @"processIdentifier": @{ @"_0": @"ai.deepseek.dsh" },
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
      });
      NSError *error = nil;
      id response = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
        target, sel_registerName("requestActivityWithRequest:error:"), request, &error);
      if (response == nil) {
        fprintf(stderr, "create failed: %s\n", error.description.UTF8String);
        return 1;
      }
      NSDictionary *descriptor = [NSPropertyListSerialization propertyListWithData:response
                                                                             options:0
                                                                              format:NULL
                                                                               error:NULL];
      printf("DESCRIPTOR %s\n", descriptor.description.UTF8String);
      printf("CREATED %s\n", [descriptor[@"id"] UTF8String]);
      return 0;
    }

    if ([operation isEqualToString:@"status"]) {
      Class centerClass = objc_getClass("ACActivityCenter");
      id center = ((id (*)(id, SEL))objc_msgSend)([centerClass alloc],
                                                  sel_registerName("init"));
      if (center == nil) {
        fprintf(stderr, "ActivityKit output service is unavailable\n");
        return 1;
      }
      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      __block NSUInteger descriptorCount = 0;
      id observer = ((id (*)(id, SEL, id))objc_msgSend)(
        center,
        sel_registerName("observeDescriptorsWithHandler:"),
        ^(NSArray *descriptors) {
          descriptorCount = descriptors.count;
          printf("DESCRIPTORS %lu\n", (unsigned long)descriptorCount);
          for (id descriptor in descriptors) {
            NSString *activityIdentifier = ((id (*)(id, SEL))objc_msgSend)(
              descriptor, sel_registerName("activityIdentifier"));
            NSString *bundleIdentifier = ((id (*)(id, SEL))objc_msgSend)(
              descriptor, sel_registerName("platterTargetBundleIdentifier"));
            printf("ACTIVITY %s target=%s\n",
                   activityIdentifier.UTF8String ?: "(null)",
                   bundleIdentifier.UTF8String ?: "(null)");
          }
          dispatch_semaphore_signal(semaphore);
        });
      if (observer == nil ||
          dispatch_semaphore_wait(semaphore,
                                  dispatch_time(DISPATCH_TIME_NOW,
                                                5 * NSEC_PER_SEC)) != 0) {
        fprintf(stderr, "status timed out\n");
        return 1;
      }
      (void)observer;
      return 0;
    }

    if ([operation isEqualToString:@"update"]) {
      NSData *payload = DSHPlist(@{
        @"contentState": DSHJSON(DSHState(@"updated across processes")),
        @"timestamp": NSDate.date,
      });
      ((void (*)(id, SEL, id, id))objc_msgSend)(
        target, sel_registerName("updateActivityWithIdentifier:payload:"), identifier, payload);
      printf("UPDATED %s\n", identifier.UTF8String);
      return 0;
    }

    if ([operation isEqualToString:@"end"]) {
      NSData *options = DSHPlist(@{
        @"uiDismissalPolicy": @{ @"date": NSDate.distantPast },
      });
      ((void (*)(id, SEL, id, id, id))objc_msgSend)(
        target,
        sel_registerName("endActivityWithIdentifier:payload:options:"),
        identifier,
        nil,
        options);
      printf("ENDED %s\n", identifier.UTF8String);
      return 0;
    }
    fprintf(stderr, "unknown operation\n");
    (void)client;
    return 2;
  }
}
