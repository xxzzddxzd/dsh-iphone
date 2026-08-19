#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc != 2) {
      fprintf(stderr, "usage: ActivityKitEndProbe <activity-uuid>\n");
      return 2;
    }
    NSString *identifier = [NSString stringWithUTF8String:argv[1]];
    if ([[NSUUID alloc] initWithUUIDString:identifier] == nil) {
      fprintf(stderr, "invalid activity UUID\n");
      return 2;
    }
    if (dlopen("/System/Library/Frameworks/ActivityKit.framework/ActivityKit",
               RTLD_NOW | RTLD_LOCAL) == NULL) {
      fprintf(stderr, "ActivityKit load failed: %s\n", dlerror());
      return 1;
    }
    Class clientClass = objc_getClass("_TtC11ActivityKit19ActivityInputClient");
    Ivar connectionIvar = class_getInstanceVariable(clientClass, "connection");
    id client = ((id (*)(id, SEL))objc_msgSend)(
      [clientClass alloc], sel_registerName("init"));
    id connection = client == nil ? nil : object_getIvar(client, connectionIvar);
    id remoteTarget = connection == nil ? nil : ((id (*)(id, SEL))objc_msgSend)(
      connection, sel_registerName("remoteTarget"));
    if (remoteTarget == nil) {
      fprintf(stderr, "ActivityKit input service is unavailable\n");
      return 1;
    }
    NSError *error = nil;
    NSData *options = [NSPropertyListSerialization dataWithPropertyList:@{
      @"uiDismissalPolicy": @{ @"date": NSDate.distantPast },
    } format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
    if (options == nil) {
      fprintf(stderr, "options failed: %s\n", error.description.UTF8String);
      return 1;
    }
    @try {
      ((void (*)(id, SEL, id, id, id))objc_msgSend)(
        remoteTarget,
        sel_registerName("endActivityWithIdentifier:payload:options:"),
        identifier,
        nil,
        options);
    } @catch (NSException *exception) {
      fprintf(stderr, "end failed: %s\n", exception.description.UTF8String);
      return 1;
    }
    printf("END_SENT id=%s\n", identifier.UTF8String);
    (void)client;
  }
  return 0;
}
