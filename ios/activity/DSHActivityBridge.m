#import <Foundation/Foundation.h>
#import <errno.h>
#import <limits.h>
#import <math.h>
#import <poll.h>
#import <signal.h>
#import <spawn.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <sys/wait.h>
#import <time.h>
#import <unistd.h>
#import <string.h>

extern char **environ;

static NSString *const DSHActivitySocketPath =
    @"/var/mobile/Library/DSHNotifier/activity.sock";
static NSString *const DSHActivityIdentifierPath =
    @"/var/mobile/Library/DSHNotifier/activity.id";
static NSString *const DSHActivityWorkerPath =
    @"/var/jb/usr/local/lib/dsh/ios/DSHActivityOp";
static const NSUInteger DSHActivityMaximumRequestBytes = 64 * 1024;
static const NSUInteger DSHActivityMaximumWorkerOutputBytes = 4 * 1024;
static const int64_t DSHActivityWorkerTimeoutMilliseconds = 7 * 1000;

static NSString *DSHActivityIdentifier;

static BOOL DSHActivityValidString(id value, NSUInteger maximumBytes, BOOL mayBeEmpty) {
  if (![value isKindOfClass:[NSString class]]) return NO;
  NSUInteger length = [(NSString *)value lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  return (mayBeEmpty || length > 0) && length <= maximumBytes;
}

static BOOL DSHActivityInteger(id value, int64_t minimum, int64_t *result) {
  if (![value isKindOfClass:[NSNumber class]]) return NO;
  double number = [(NSNumber *)value doubleValue];
  int64_t integer = [(NSNumber *)value longLongValue];
  if (!isfinite(number) || number != (double)integer || integer < minimum) return NO;
  if (result != NULL) *result = integer;
  return YES;
}

static NSString *DSHActivitySafeError(NSString *message) {
  if (message.length == 0) return @"unknown ActivityKit error";
  NSString *singleLine = [[message stringByReplacingOccurrencesOfString:@"\r" withString:@" "]
      stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
  return singleLine.length <= 512 ? singleLine : [singleLine substringToIndex:512];
}

static void DSHActivityReply(int client, NSString *status, NSString *detail) {
  int enabled = 1;
  setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
  NSString *line = detail.length == 0
      ? [NSString stringWithFormat:@"%@\n", status]
      : [NSString stringWithFormat:@"%@ %@\n", status, DSHActivitySafeError(detail)];
  NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
  const uint8_t *bytes = data.bytes;
  NSUInteger remaining = data.length;
  while (remaining > 0) {
    ssize_t count = send(client, bytes, remaining, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return;
    bytes += count;
    remaining -= (NSUInteger)count;
  }
}

static NSDictionary *DSHActivityReadCommand(int client, NSString **errorMessage) {
  struct timeval timeout = { .tv_sec = 5, .tv_usec = 0 };
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  NSMutableData *data = [NSMutableData data];
  uint8_t buffer[4096];
  BOOL foundNewline = NO;
  while (data.length < DSHActivityMaximumRequestBytes) {
    ssize_t count = recv(client, buffer, sizeof(buffer), 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    uint8_t *newline = memchr(buffer, '\n', (size_t)count);
    NSUInteger accepted = newline == NULL
        ? (NSUInteger)count
        : (NSUInteger)(newline - buffer);
    [data appendBytes:buffer length:accepted];
    if (newline != NULL) {
      foundNewline = YES;
      break;
    }
  }
  if (!foundNewline || data.length >= DSHActivityMaximumRequestBytes) {
    if (errorMessage != NULL) *errorMessage = @"invalid request framing";
    return nil;
  }
  NSError *error = nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![object isKindOfClass:[NSDictionary class]]) {
    if (errorMessage != NULL) *errorMessage = @"invalid JSON";
    return nil;
  }
  return object;
}

static NSDictionary *DSHActivityValidatedState(id value, NSString **errorMessage) {
  if (![value isKindOfClass:[NSDictionary class]]) {
    if (errorMessage != NULL) *errorMessage = @"update requires task";
    return nil;
  }
  NSDictionary *task = value;
  NSString *sessionID = task[@"sessionID"];
  NSString *title = task[@"title"];
  NSString *phase = task[@"phase"];
  NSString *detail = task[@"detail"];
  // Keep accepting the pre-split payload during a rolling deployment. The
  // broker always emits the complete new state so WidgetKit never has to
  // decode an ActivityKit payload with missing non-optional fields.
  NSString *assistantDetail = task[@"assistantDetail"] ?: phase;
  NSString *toolDetail = task[@"toolDetail"] ?: detail;
  if (!DSHActivityValidString(sessionID, 512, NO)) {
    if (errorMessage != NULL) *errorMessage = @"invalid sessionID";
    return nil;
  }
  if (!DSHActivityValidString(title, 512, NO)) {
    if (errorMessage != NULL) *errorMessage = @"invalid title";
    return nil;
  }
  if (!DSHActivityValidString(phase, 256, NO)) {
    if (errorMessage != NULL) *errorMessage = @"invalid phase";
    return nil;
  }
  if (!DSHActivityValidString(detail, 2048, YES)) {
    if (errorMessage != NULL) *errorMessage = @"detail is too long";
    return nil;
  }
  if (!DSHActivityValidString(assistantDetail, 2048, YES)) {
    if (errorMessage != NULL) *errorMessage = @"assistantDetail is too long";
    return nil;
  }
  if (!DSHActivityValidString(toolDetail, 2048, YES)) {
    if (errorMessage != NULL) *errorMessage = @"toolDetail is too long";
    return nil;
  }

  int64_t startedAt = 0;
  int64_t step = 0;
  int64_t agentCount = 1;
  int64_t completedItems = 0;
  int64_t totalItems = 0;
  if (!DSHActivityInteger(task[@"startedAtMilliseconds"], 1, &startedAt) ||
      !DSHActivityInteger(task[@"step"], 0, &step) ||
      (task[@"agentCount"] != nil &&
       !DSHActivityInteger(task[@"agentCount"], 1, &agentCount)) ||
      !DSHActivityInteger(task[@"completedItems"], 0, &completedItems) ||
      !DSHActivityInteger(task[@"totalItems"], 0, &totalItems) ||
      (totalItems != 0 && completedItems > totalItems)) {
    if (errorMessage != NULL) *errorMessage = @"invalid progress values";
    return nil;
  }
  id waitingValue = task[@"waitingForUser"];
  if (![waitingValue isKindOfClass:[NSNumber class]] ||
      CFGetTypeID((__bridge CFTypeRef)waitingValue) != CFBooleanGetTypeID()) {
    if (errorMessage != NULL) *errorMessage = @"invalid waitingForUser";
    return nil;
  }

  return @{
    @"sessionID": sessionID,
    @"title": title,
    @"phase": phase,
    @"detail": detail,
    @"assistantDetail": assistantDetail,
    @"toolDetail": toolDetail,
    @"startedAtMilliseconds": @(startedAt),
    @"step": @(step),
    @"agentCount": @(agentCount),
    @"completedItems": @(completedItems),
    @"totalItems": @(totalItems),
    @"waitingForUser": @([(NSNumber *)waitingValue boolValue]),
  };
}

static int64_t DSHActivityMonotonicMilliseconds(void) {
  struct timespec value = {0};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static BOOL DSHActivityRunWorker(NSArray<NSString *> *arguments,
                                 NSString **response,
                                 NSString **errorMessage) {
  if (arguments.count > 4) {
    if (errorMessage != NULL) *errorMessage = @"internal worker argument overflow";
    return NO;
  }
  const char *workerPath = DSHActivityWorkerPath.fileSystemRepresentation;
  if (access(workerPath, X_OK) != 0) {
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"Activity worker is unavailable: %s",
                                                 strerror(errno)];
    }
    return NO;
  }

  int outputPipe[2] = {-1, -1};
  if (pipe(outputPipe) != 0) {
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"could not create worker pipe: %s",
                                                 strerror(errno)];
    }
    return NO;
  }

  posix_spawn_file_actions_t actions;
  int actionError = posix_spawn_file_actions_init(&actions);
  BOOL actionsInitialized = actionError == 0;
  if (actionError == 0) {
    actionError = posix_spawn_file_actions_addclose(&actions, outputPipe[0]);
  }
  if (actionError == 0) {
    actionError = posix_spawn_file_actions_adddup2(&actions, outputPipe[1], STDOUT_FILENO);
  }
  if (actionError == 0) {
    actionError = posix_spawn_file_actions_adddup2(&actions, outputPipe[1], STDERR_FILENO);
  }
  if (actionError == 0 && outputPipe[1] != STDOUT_FILENO && outputPipe[1] != STDERR_FILENO) {
    actionError = posix_spawn_file_actions_addclose(&actions, outputPipe[1]);
  }
  if (actionError != 0) {
    if (actionsInitialized) posix_spawn_file_actions_destroy(&actions);
    close(outputPipe[0]);
    close(outputPipe[1]);
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"could not configure worker: %s",
                                                 strerror(actionError)];
    }
    return NO;
  }

  posix_spawnattr_t attributes;
  int attributeError = posix_spawnattr_init(&attributes);
  BOOL attributesInitialized = attributeError == 0;
  if (attributeError == 0) {
    attributeError = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  }
  if (attributeError != 0) {
    if (attributesInitialized) posix_spawnattr_destroy(&attributes);
    posix_spawn_file_actions_destroy(&actions);
    close(outputPipe[0]);
    close(outputPipe[1]);
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"could not configure worker process: %s",
                                                 strerror(attributeError)];
    }
    return NO;
  }

  char *argv[6] = {0};
  argv[0] = (char *)workerPath;
  for (NSUInteger index = 0; index < arguments.count; index += 1) {
    argv[index + 1] = (char *)arguments[index].UTF8String;
  }

  pid_t processIdentifier = 0;
  int spawnError = posix_spawn(
      &processIdentifier, workerPath, &actions, &attributes, argv, environ);
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
  close(outputPipe[1]);
  if (spawnError != 0) {
    close(outputPipe[0]);
    if (errorMessage != NULL) {
      *errorMessage = [NSString stringWithFormat:@"could not start Activity worker: %s",
                                                 strerror(spawnError)];
    }
    return NO;
  }

  NSMutableData *output = [NSMutableData data];
  int64_t deadline = DSHActivityMonotonicMilliseconds() +
      DSHActivityWorkerTimeoutMilliseconds;
  BOOL timedOut = NO;
  BOOL oversized = NO;
  while (YES) {
    int64_t remaining = deadline - DSHActivityMonotonicMilliseconds();
    if (remaining <= 0) {
      timedOut = YES;
      break;
    }
    struct pollfd pollDescriptor = {
      .fd = outputPipe[0],
      .events = POLLIN | POLLHUP,
      .revents = 0,
    };
    int pollResult = poll(&pollDescriptor, 1, (int)MIN(remaining, INT_MAX));
    if (pollResult < 0 && errno == EINTR) continue;
    if (pollResult < 0) break;
    if (pollResult == 0) {
      timedOut = YES;
      break;
    }
    if ((pollDescriptor.revents & (POLLIN | POLLHUP)) != 0) {
      uint8_t buffer[1024];
      ssize_t count = read(outputPipe[0], buffer, sizeof(buffer));
      if (count < 0 && errno == EINTR) continue;
      if (count < 0) break;
      if (count == 0) break;
      [output appendBytes:buffer length:(NSUInteger)count];
      if (output.length > DSHActivityMaximumWorkerOutputBytes) {
        oversized = YES;
        break;
      }
      continue;
    }
    break;
  }
  close(outputPipe[0]);

  int waitStatus = 0;
  if (timedOut || oversized) kill(processIdentifier, SIGKILL);
  while (!timedOut && !oversized) {
    pid_t waitResult = waitpid(processIdentifier, &waitStatus, WNOHANG);
    if (waitResult == processIdentifier) break;
    if (waitResult < 0 && errno != EINTR) break;
    if (DSHActivityMonotonicMilliseconds() >= deadline) {
      timedOut = YES;
      kill(processIdentifier, SIGKILL);
      break;
    }
    usleep(10 * 1000);
  }
  if (timedOut || oversized) {
    while (waitpid(processIdentifier, &waitStatus, 0) < 0 && errno == EINTR) {}
  }
  if (timedOut) {
    if (errorMessage != NULL) *errorMessage = @"Activity worker timed out";
    return NO;
  }
  if (oversized) {
    if (errorMessage != NULL) *errorMessage = @"Activity worker returned too much data";
    return NO;
  }

  NSString *line = [[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding];
  line = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!WIFEXITED(waitStatus) || WEXITSTATUS(waitStatus) != 0 ||
      ![line hasPrefix:@"OK "]) {
    if ([line hasPrefix:@"ERR "]) line = [line substringFromIndex:4];
    if (errorMessage != NULL) {
      *errorMessage = line.length > 0
          ? line
          : [NSString stringWithFormat:@"Activity worker exited abnormally (status %d)",
                                             waitStatus];
    }
    return NO;
  }
  if (response != NULL) *response = line;
  return YES;
}

static NSString *DSHActivityStateJSON(NSDictionary *state, NSString **errorMessage) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:&error];
  NSString *json = data == nil
      ? nil
      : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (json == nil && errorMessage != NULL) {
    *errorMessage = [NSString stringWithFormat:@"JSON serialization failed: %@", error];
  }
  return json;
}

static void DSHActivityStoreIdentifier(NSString *identifier) {
  DSHActivityIdentifier = [identifier copy];
  if (identifier == nil) {
    unlink(DSHActivityIdentifierPath.fileSystemRepresentation);
    return;
  }
  NSError *error = nil;
  if (![identifier writeToFile:DSHActivityIdentifierPath
                    atomically:YES
                      encoding:NSUTF8StringEncoding
                         error:&error]) {
    NSLog(@"[DSHActivity] could not persist identifier: %@", error);
    return;
  }
  chmod(DSHActivityIdentifierPath.fileSystemRepresentation, 0600);
}

static void DSHActivityLoadIdentifier(void) {
  NSError *error = nil;
  NSString *identifier = [NSString stringWithContentsOfFile:DSHActivityIdentifierPath
                                                    encoding:NSUTF8StringEncoding
                                                       error:&error];
  identifier = [identifier stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (identifier.length > 0 && [[NSUUID alloc] initWithUUIDString:identifier] != nil) {
    DSHActivityIdentifier = identifier;
    NSLog(@"[DSHActivity] recovered activity %@", identifier);
  } else if (identifier != nil || error.code != NSFileReadNoSuchFileError) {
    unlink(DSHActivityIdentifierPath.fileSystemRepresentation);
  }
}

static BOOL DSHActivityCreate(NSDictionary *state, NSString **errorMessage) {
  NSString *stateJSON = DSHActivityStateJSON(state, errorMessage);
  if (stateJSON == nil) return NO;
  NSString *response = nil;
  if (!DSHActivityRunWorker(@[@"create", stateJSON], &response, errorMessage)) return NO;
  static NSString *const prefix = @"OK created ";
  NSString *identifier = [response hasPrefix:prefix]
      ? [response substringFromIndex:prefix.length]
      : nil;
  if ([[NSUUID alloc] initWithUUIDString:identifier] == nil) {
    if (errorMessage != NULL) *errorMessage = @"Activity worker returned an invalid identifier";
    return NO;
  }
  DSHActivityStoreIdentifier(identifier);
  NSLog(@"[DSHActivity] worker created %@ for ai.deepseek.dsh", identifier);
  return YES;
}

static BOOL DSHActivityUpdate(NSDictionary *state, NSString **errorMessage) {
  if (DSHActivityIdentifier == nil) return DSHActivityCreate(state, errorMessage);
  NSString *stateJSON = DSHActivityStateJSON(state, errorMessage);
  if (stateJSON == nil) return NO;
  return DSHActivityRunWorker(
      @[@"update", DSHActivityIdentifier, stateJSON], NULL, errorMessage);
}

static BOOL DSHActivityEnd(NSString **errorMessage) {
  NSString *identifier = DSHActivityIdentifier;
  if (identifier == nil) return YES;
  if (!DSHActivityRunWorker(@[@"end", identifier], NULL, errorMessage)) return NO;
  DSHActivityStoreIdentifier(nil);
  NSLog(@"[DSHActivity] worker ended %@", identifier);
  return YES;
}

static void DSHActivityHandleClient(int client) {
  @autoreleasepool {
    NSString *errorMessage = nil;
    NSDictionary *command = DSHActivityReadCommand(client, &errorMessage);
    if (command == nil) {
      DSHActivityReply(client, @"ERR", errorMessage);
      return;
    }
    if (![command[@"version"] isEqual:@1]) {
      DSHActivityReply(client, @"ERR", @"unsupported protocol version");
      return;
    }
    NSString *operation = command[@"operation"];
    if ([operation isEqualToString:@"status"]) {
      DSHActivityReply(client, @"OK", DSHActivityIdentifier == nil ? @"idle" : @"active");
      return;
    }
    if ([operation isEqualToString:@"update"]) {
      NSDictionary *state = DSHActivityValidatedState(command[@"task"], &errorMessage);
      if (state != nil && DSHActivityUpdate(state, &errorMessage)) {
        DSHActivityReply(client, @"OK", @"updated");
      } else {
        DSHActivityReply(client, @"ERR", errorMessage);
      }
      return;
    }
    if ([operation isEqualToString:@"end"] || [operation isEqualToString:@"shutdown"]) {
      if (DSHActivityEnd(&errorMessage)) {
        DSHActivityReply(client, @"OK",
            [operation isEqualToString:@"shutdown"] ? @"shutdown" : @"ended");
      } else {
        DSHActivityReply(client, @"ERR", errorMessage);
      }
      return;
    }
    DSHActivityReply(client, @"ERR", @"unknown operation");
  }
}

static int DSHActivityCreateServer(void) {
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0) return -1;
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  const char *path = DSHActivitySocketPath.fileSystemRepresentation;
  if (strlen(path) >= sizeof(address.sun_path)) {
    close(server);
    return -1;
  }
  strlcpy(address.sun_path, path, sizeof(address.sun_path));

  if (bind(server, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    int probe = socket(AF_UNIX, SOCK_STREAM, 0);
    BOOL active = probe >= 0 && connect(
        probe, (const struct sockaddr *)&address, sizeof(address)) == 0;
    if (probe >= 0) close(probe);
    if (active) {
      close(server);
      return -1;
    }
    unlink(path);
    if (bind(server, (const struct sockaddr *)&address, sizeof(address)) != 0) {
      close(server);
      return -1;
    }
  }
  chmod(path, 0600);
  if (listen(server, 8) != 0) {
    close(server);
    unlink(path);
    return -1;
  }
  return server;
}

static void DSHActivityRunServer(void) {
  @autoreleasepool {
    DSHActivityLoadIdentifier();
    int server = DSHActivityCreateServer();
    if (server < 0) {
      NSLog(@"[DSHActivity] could not create %@", DSHActivitySocketPath);
      return;
    }
    NSLog(@"[DSHActivity] launchd worker broker listening at %@",
          DSHActivitySocketPath);
    while (YES) {
      int client = accept(server, NULL, NULL);
      if (client < 0) {
        if (errno == EINTR) continue;
        break;
      }
      DSHActivityHandleClient(client);
      close(client);
    }
    close(server);
    unlink(DSHActivitySocketPath.fileSystemRepresentation);
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    (void)argc;
    (void)argv;
    DSHActivityRunServer();
  }
  return 1;
}
