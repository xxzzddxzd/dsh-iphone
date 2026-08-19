#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <errno.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <unistd.h>

static id DSHSendObject(id receiver, SEL selector) {
  return ((id (*)(id, SEL))objc_msgSend)(receiver, selector);
}

static NSInteger DSHSendInteger(id receiver, SEL selector) {
  return ((NSInteger (*)(id, SEL))objc_msgSend)(receiver, selector);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IONBF, 0);
    NSString *bundleIdentifier = argc > 1
      ? [NSString stringWithUTF8String:argv[1]]
      : @"ai.deepseek.dsh";

    void *handle = dlopen(
      "/System/Library/PrivateFrameworks/SessionAssertion.framework/SessionAssertion",
      RTLD_NOW | RTLD_LOCAL);
    if (handle == NULL) {
      fprintf(stderr, "dlopen failed: %s\n", dlerror());
      return 1;
    }

    Class targetClass = objc_getClass("SNAAssertionTarget");
    Class assertionClass = objc_getClass("SNAAssertion");
    if (targetClass == Nil || assertionClass == Nil) {
      fprintf(stderr, "missing classes target=%p assertion=%p\n", targetClass, assertionClass);
      return 2;
    }

    id target = ((id (*)(id, SEL, id))objc_msgSend)(
      [targetClass alloc], sel_registerName("initWithBundleIdentifier:"), bundleIdentifier);
    if (target == nil) {
      fprintf(stderr, "could not create assertion target\n");
      return 3;
    }

    __block BOOL invalidated = NO;
    void (^invalidationHandler)(void) = ^{
      invalidated = YES;
      printf("INVALIDATED\n");
    };
    id assertion = ((id (*)(id, SEL, id, id, BOOL, id))objc_msgSend)(
      [assertionClass alloc],
      sel_registerName("initWithExplanation:target:invalidateOnSessionRequest:invalidationHandler:"),
      @"DSH ActivityKit headless request probe", target, NO, invalidationHandler);
    if (assertion == nil) {
      fprintf(stderr, "could not create assertion\n");
      return 4;
    }

    NSDate *settleUntil = [NSDate dateWithTimeIntervalSinceNow:0.75];
    while ([settleUntil timeIntervalSinceNow] > 0 && !invalidated) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }

    id sessionIdentifiers = nil;
    if ([assertion respondsToSelector:sel_registerName("sessionIdentifiers")]) {
      sessionIdentifiers = DSHSendObject(assertion, sel_registerName("sessionIdentifiers"));
    }
    NSInteger state = -1;
    if ([assertion respondsToSelector:sel_registerName("state")]) {
      state = DSHSendInteger(assertion, sel_registerName("state"));
    }
    NSInteger reason = -1;
    if ([assertion respondsToSelector:sel_registerName("invalidationReason")]) {
      reason = DSHSendInteger(assertion, sel_registerName("invalidationReason"));
    }

    printf("pid=%d bundle=%s state=%ld invalidationReason=%ld sessions=%s\n",
           getpid(), bundleIdentifier.UTF8String, (long)state, (long)reason,
           sessionIdentifiers == nil ? "(nil)" : [[sessionIdentifiers description] UTF8String]);
    printf("READY (press return to invalidate)\n");

    char byte = 0;
    while (read(STDIN_FILENO, &byte, 1) < 0 && errno == EINTR) {}
    if ([assertion respondsToSelector:sel_registerName("invalidate")]) {
      ((void (*)(id, SEL))objc_msgSend)(assertion, sel_registerName("invalidate"));
    }

    NSDate *finishBy = [NSDate dateWithTimeIntervalSinceNow:0.5];
    while ([finishBy timeIntervalSinceNow] > 0 && !invalidated) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    printf("DONE invalidated=%s\n", invalidated ? "yes" : "no");
    (void)assertion;
    (void)target;
    (void)handle;
  }
  return 0;
}
