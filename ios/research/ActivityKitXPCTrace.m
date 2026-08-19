#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <errno.h>
#import <fcntl.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <stdint.h>
#import <string.h>
#import <unistd.h>
#import <xpc/xpc.h>

extern void DSHTraceSwiftObject(const void *object);

typedef void (*SendInvocationImplementation)(
    id,
    SEL,
    NSInvocation *,
    __unsafe_unretained id *,
    NSUInteger,
    NSMethodSignature *,
    SEL,
    id);

static SendInvocationImplementation OriginalSendInvocation;
static id (*OriginalSendSynchronouslyWithError)(id, SEL, NSError **);
static BOOL (*OriginalSendSynchronously)(id, SEL);
static BOOL (*OriginalSend)(id, SEL);

static const char *ActivityKitTracePath =
    "/var/mobile/Library/DSHNotifier/activitykit-xpc-raw.log";
static const char *ActivityKitRequestPath =
    "/var/mobile/Library/DSHNotifier/activitykit-request.bplist";
static const char *ActivityKitReplyPath =
    "/var/mobile/Library/DSHNotifier/activitykit-reply.bplist";
static const char *ActivityKitUpdatePath =
    "/var/mobile/Library/DSHNotifier/activitykit-update.bplist";
static const char *ActivityKitEndOptionsPath =
    "/var/mobile/Library/DSHNotifier/activitykit-end-options.bplist";

static void AppendXPCTrace(const char *operation, xpc_object_t object) {
  char *description = object == NULL ? NULL : xpc_copy_description(object);
  int descriptor = open(ActivityKitTracePath, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (descriptor >= 0) {
    dprintf(descriptor, "--- %s pid=%d ---\n%s\n",
            operation,
            getpid(),
            description == NULL ? "(null)" : description);
    close(descriptor);
  }
  free(description);
}

static void WriteXPCDataValue(xpc_object_t dictionary, const char *key, const char *path) {
  if (dictionary == NULL || xpc_get_type(dictionary) != XPC_TYPE_DICTIONARY) return;
  xpc_object_t value = xpc_dictionary_get_value(dictionary, key);
  if (value == NULL || xpc_get_type(value) != XPC_TYPE_DATA) return;
  const void *bytes = xpc_data_get_bytes_ptr(value);
  size_t length = xpc_data_get_length(value);
  int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (descriptor < 0) return;
  const uint8_t *cursor = bytes;
  size_t remaining = length;
  while (remaining > 0) {
    ssize_t count = write(descriptor, cursor, remaining);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    cursor += count;
    remaining -= (size_t)count;
  }
  close(descriptor);
}

static xpc_object_t TraceSendMessageWithReplySync(
    xpc_connection_t connection,
    xpc_object_t message) {
  AppendXPCTrace("xpc_connection_send_message_with_reply_sync request", message);
  xpc_object_t reply = xpc_connection_send_message_with_reply_sync(connection, message);
  AppendXPCTrace("xpc_connection_send_message_with_reply_sync reply", reply);
  return reply;
}

static void TraceSendMessageWithReply(
    xpc_connection_t connection,
    xpc_object_t message,
    dispatch_queue_t queue,
    xpc_handler_t handler) {
  AppendXPCTrace("xpc_connection_send_message_with_reply request", message);
  xpc_connection_send_message_with_reply(connection, message, queue, handler);
}

static void TraceSendMessage(xpc_connection_t connection, xpc_object_t message) {
  AppendXPCTrace("xpc_connection_send_message", message);
  xpc_connection_send_message(connection, message);
}

#define DSH_INTERPOSE(replacement, replacee)                                      \
  __attribute__((used)) static struct {                                           \
    const void *replacement;                                                      \
    const void *replacee;                                                         \
  } dsh_interpose_##replacee __attribute__((section("__DATA,__interpose"))) = {  \
    (const void *)(uintptr_t)&replacement,                                        \
    (const void *)(uintptr_t)&replacee,                                           \
  }

DSH_INTERPOSE(TraceSendMessageWithReplySync, xpc_connection_send_message_with_reply_sync);
DSH_INTERPOSE(TraceSendMessageWithReply, xpc_connection_send_message_with_reply);
DSH_INTERPOSE(TraceSendMessage, xpc_connection_send_message);

static xpc_object_t MessagePayload(id message) {
  SEL selector = sel_registerName("message");
  if (message == nil || ![message respondsToSelector:selector]) return NULL;
  return ((xpc_object_t (*)(id, SEL))objc_msgSend)(message, selector);
}

static id TraceSendSynchronouslyWithError(id message, SEL selector, NSError **error) {
  xpc_object_t payload = MessagePayload(message);
  AppendXPCTrace("BSXPCServiceConnectionMessage sendSynchronouslyWithError request", payload);
  const char *remoteSelector = payload == NULL
      ? NULL
      : xpc_dictionary_get_string(payload, "bsxpc_SEL");
  BOOL isActivityRequest = remoteSelector != NULL &&
      strcmp(remoteSelector, "requestActivityWithRequest:error:") == 0;
  if (isActivityRequest) WriteXPCDataValue(payload, "1", ActivityKitRequestPath);
  if (remoteSelector != NULL &&
      strcmp(remoteSelector, "updateActivityWithIdentifier:payload:") == 0) {
    WriteXPCDataValue(payload, "2", ActivityKitUpdatePath);
  }
  if (remoteSelector != NULL &&
      strcmp(remoteSelector, "endActivityWithIdentifier:payload:options:") == 0) {
    WriteXPCDataValue(payload, "3", ActivityKitEndOptionsPath);
  }
  id reply = OriginalSendSynchronouslyWithError(message, selector, error);
  xpc_object_t replyPayload = MessagePayload(reply);
  AppendXPCTrace("BSXPCServiceConnectionMessage sendSynchronouslyWithError reply", replyPayload);
  if (isActivityRequest) {
    WriteXPCDataValue(replyPayload, "BSXPCReturnValue", ActivityKitReplyPath);
  }
  return reply;
}

static BOOL TraceSendSynchronously(id message, SEL selector) {
  AppendXPCTrace("BSXPCServiceConnectionMessage sendSynchronously request",
                 MessagePayload(message));
  return OriginalSendSynchronously(message, selector);
}

static BOOL TraceSend(id message, SEL selector) {
  AppendXPCTrace("BSXPCServiceConnectionMessage send request", MessagePayload(message));
  return OriginalSend(message, selector);
}

static void ReplaceInstanceMethod(
    Class cls,
    SEL selector,
    IMP replacement,
    IMP *original) {
  Method method = class_getInstanceMethod(cls, selector);
  if (method == NULL) return;
  *original = method_getImplementation(method);
  method_setImplementation(method, replacement);
}

static void TraceSendInvocation(
    id connection,
    SEL command,
    NSInvocation *invocation,
    __unsafe_unretained id *arguments,
    NSUInteger count,
    NSMethodSignature *signature,
    SEL selector,
    id proxy) {
  if (sel_isEqual(selector, sel_registerName("requestActivityWithRequest:error:"))) {
    id request = nil;
    if (invocation != nil && invocation.methodSignature.numberOfArguments > 2) {
      [invocation getArgument:&request atIndex:2];
    } else if (arguments != NULL && count > 0) {
      request = arguments[0];
    }
    if (request != nil) {
      DSHTraceSwiftObject((__bridge const void *)request);
    }
  }
  OriginalSendInvocation(
      connection, command, invocation, arguments, count, signature, selector, proxy);
}

__attribute__((constructor))
static void InstallActivityKitXPCTrace(void) {
  Class connectionClass = NSClassFromString(@"NSXPCConnection");
  SEL selector = NSSelectorFromString(
      @"_sendInvocation:orArguments:count:methodSignature:selector:withProxy:");
  Method method = class_getInstanceMethod(connectionClass, selector);
  if (method == NULL) return;
  OriginalSendInvocation = (SendInvocationImplementation)method_getImplementation(method);
  method_setImplementation(method, (IMP)TraceSendInvocation);

  Class messageClass = NSClassFromString(@"BSXPCServiceConnectionMessage");
  ReplaceInstanceMethod(
      messageClass,
      sel_registerName("sendSynchronouslyWithError:"),
      (IMP)TraceSendSynchronouslyWithError,
      (IMP *)&OriginalSendSynchronouslyWithError);
  ReplaceInstanceMethod(
      messageClass,
      sel_registerName("sendSynchronously"),
      (IMP)TraceSendSynchronously,
      (IMP *)&OriginalSendSynchronously);
  ReplaceInstanceMethod(
      messageClass,
      sel_registerName("send"),
      (IMP)TraceSend,
      (IMP *)&OriginalSend);
}
