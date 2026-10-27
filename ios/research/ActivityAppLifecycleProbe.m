#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <notify.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <sys/sysctl.h>
#import <unistd.h>

// These are read-only SPI calls also used by WebKit's EndowmentStateTracker.
@interface RBSProcessIdentifier : NSObject
+ (instancetype)identifierWithPid:(pid_t)pid;
@end
@interface RBSProcessHandle : NSObject
+ (instancetype)handleForIdentifier:(RBSProcessIdentifier *)identifier error:(NSError **)error;
@property(nonatomic, readonly) id identity;
@property(nonatomic, readonly) id currentState;
@end

static id DSHObject(id object, const char *selector) {
  SEL method = sel_registerName(selector);
  return [object respondsToSelector:method] ? ((id (*)(id, SEL))objc_msgSend)(object, method) : nil;
}

static NSArray<NSNumber *> *DSHProcessIDs(void) {
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
  size_t size = 0;
  if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0 || size == 0) return nil;
  // Leave room for processes starting between the size and contents queries.
  size += sizeof(struct kinfo_proc) * 64;
  struct kinfo_proc *processes = calloc(1, size);
  if (processes == NULL) return nil;
  if (sysctl(mib, 4, processes, &size, NULL, 0) != 0) { free(processes); return nil; }
  NSMutableArray *pids = [NSMutableArray array];
  for (size_t index = 0; index < size / sizeof(struct kinfo_proc); index++) {
    pid_t pid = processes[index].kp_proc.p_pid;
    if (pid > 0 && pid != getpid()) [pids addObject:@(pid)];
  }
  free(processes);
  return pids;
}

// Never launches applications, creates assertions, or loads ActivityKit.
int main(void) {
  @autoreleasepool {
    void *library = dlopen("/System/Library/PrivateFrameworks/RunningBoardServices.framework/RunningBoardServices", RTLD_NOW | RTLD_LOCAL);
    Class identifierClass = objc_getClass("RBSProcessIdentifier");
    Class handleClass = objc_getClass("RBSProcessHandle");
    BOOL apiAvailable = library != NULL &&
        [identifierClass respondsToSelector:@selector(identifierWithPid:)] &&
        [handleClass respondsToSelector:@selector(handleForIdentifier:error:)];
    NSMutableArray *rows = [NSMutableArray array];
    BOOL stateAvailable = NO;
    if (apiAvailable) for (NSNumber *pid in DSHProcessIDs()) {
      @autoreleasepool {
        RBSProcessIdentifier *identifier = [identifierClass identifierWithPid:pid.intValue];
        RBSProcessHandle *handle = [handleClass handleForIdentifier:identifier error:NULL];
        NSString *bundleID = DSHObject(DSHObject(handle, "identity"), "embeddedApplicationIdentifier");
        if (![bundleID isKindOfClass:NSString.class] || bundleID.length == 0) continue;
        id state = DSHObject(handle, "currentState");
        NSSet *namespaces = DSHObject(state, "endowmentNamespaces");
        BOOL available = [namespaces isKindOfClass:NSSet.class];
        stateAvailable |= available;
        [rows addObject:@{ @"bundleID": bundleID, @"pid": pid,
          @"stateAvailable": @(available),
          @"visible": available ? @([namespaces containsObject:@"com.apple.frontboard.visibility"]) : NSNull.null }];
      }
    }
    int token = NOTIFY_TOKEN_INVALID;
    uint64_t lockState = UINT64_MAX;
    BOOL lockAvailable = notify_register_check("com.apple.springboard.lockstate", &token) == NOTIFY_STATUS_OK &&
        notify_get_state(token, &lockState) == NOTIFY_STATUS_OK && lockState != UINT64_MAX;
    if (token != NOTIFY_TOKEN_INVALID) notify_cancel(token);
    NSDictionary *result = @{ @"rbsStateAvailable": @(stateAvailable), @"processes": rows,
      @"lockStateAvailable": @(lockAvailable), @"locked": lockAvailable ? @(lockState != 0) : NSNull.null };
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    return stateAvailable && lockAvailable ? 0 : 1;
  }
}
