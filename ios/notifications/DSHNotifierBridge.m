#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <errno.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <spawn.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <sys/wait.h>
#import <string.h>
#import <unistd.h>

extern char **environ;

static NSString *const DSHSocketPath = @"/var/mobile/Library/DSHNotifier/notify.sock";
static NSString *const DSHActionSocketPath = @"/var/mobile/Library/DSHNotifier/action.sock";
static NSString *const DSHDefaultActionIdentifier = @"com.apple.UNNotificationDefaultActionIdentifier";
static NSString *const DSHActionIdentifierPrefix = @"dsh-action:";
static NSString *const DSHPublisherPrefix = @"dsh-notifier-";
static const NSUInteger DSHDefaultFeed = 27;
static const NSUInteger DSHMaximumRequestBytes = 64 * 1024;
static id (*DSHOriginalResponseForAction)(id, SEL, id) = NULL;
static NSMutableDictionary<NSString *, id> *DSHBulletinsByIdentifier;

static id DSHSendId(id target, SEL selector) {
  return ((id (*)(id, SEL))objc_msgSend)(target, selector);
}

static id DSHSendId1(id target, SEL selector, id value) {
  return ((id (*)(id, SEL, id))objc_msgSend)(target, selector, value);
}

static id DSHSendId2(id target, SEL selector, id first, id second) {
  return ((id (*)(id, SEL, id, id))objc_msgSend)(target, selector, first, second);
}

static id DSHSendId3(id target, SEL selector, id first, id second, id third) {
  return ((id (*)(id, SEL, id, id, id))objc_msgSend)(target, selector, first, second, third);
}

static void DSHSendVoid1(id target, SEL selector, id value) {
  ((void (*)(id, SEL, id))objc_msgSend)(target, selector, value);
}

static void DSHSendVoidBool(id target, SEL selector, BOOL value) {
  ((void (*)(id, SEL, BOOL))objc_msgSend)(target, selector, value);
}

static void DSHSendVoidInteger(id target, SEL selector, NSInteger value) {
  ((void (*)(id, SEL, NSInteger))objc_msgSend)(target, selector, value);
}

static id DSHCreateSound(id soundClass, unsigned int soundID) {
  id sound = DSHSendId(soundClass, sel_registerName("alloc"));
  return ((id (*)(id, SEL, unsigned int, NSInteger, id))objc_msgSend)(
      sound,
      sel_registerName("initWithSystemSoundID:behavior:vibrationPattern:"),
      soundID,
      0,
      nil);
}

static void DSHPublishOnController(id controller, id observer, id bulletin, NSUInteger feed) {
  ((void (*)(id, SEL, id, id, NSUInteger))objc_msgSend)(
      controller,
      sel_registerName("observer:addBulletin:forFeed:"),
      observer,
      bulletin,
      feed);
}

static void DSHRemoveOnController(id controller, id observer, id bulletin) {
  ((void (*)(id, SEL, id, id))objc_msgSend)(
      controller,
      sel_registerName("observer:removeBulletin:"),
      observer,
      bulletin);
}

static BOOL DSHValidString(id value, NSUInteger maximumLength) {
  return [value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0 &&
         [(NSString *)value length] <= maximumLength;
}

static BOOL DSHValidIdentifier(id value) {
  if (!DSHValidString(value, 256)) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:
      @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"] invertedSet];
  return [(NSString *)value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static BOOL DSHValidActionToken(id value) {
  if (!DSHValidString(value, 128) || [(NSString *)value length] < 20) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:
      @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"] invertedSet];
  return [(NSString *)value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static NSURL *DSHLaunchURL(id value) {
  NSURL *url = nil;
  if ([value isKindOfClass:[NSURL class]]) {
    url = (NSURL *)value;
  } else if (DSHValidString(value, 8192)) {
    url = [NSURL URLWithString:(NSString *)value];
  }
  NSString *scheme = url.scheme.lowercaseString;
  if (url == nil || (! [scheme isEqualToString:@"http"] && ! [scheme isEqualToString:@"https"])) {
    return nil;
  }
  return url;
}

static NSURL *DSHActionLaunchURL(id bulletin, id action) {
  if (action != nil && [action respondsToSelector:sel_registerName("launchURL")]) {
    NSURL *url = DSHLaunchURL(DSHSendId(action, sel_registerName("launchURL")));
    if (url != nil) return url;
  }
  id candidate = DSHSendId(bulletin, sel_registerName("defaultAction"));
  if (candidate == nil || ![candidate respondsToSelector:sel_registerName("launchURL")]) return nil;
  return DSHLaunchURL(DSHSendId(candidate, sel_registerName("launchURL")));
}

static NSString *DSHActionToken(id action) {
  if (action == nil || ![action respondsToSelector:sel_registerName("identifier")]) return nil;
  id identifier = DSHSendId(action, sel_registerName("identifier"));
  if (![identifier isKindOfClass:[NSString class]] ||
      ![(NSString *)identifier hasPrefix:DSHActionIdentifierPrefix]) return nil;
  NSString *token = [(NSString *)identifier substringFromIndex:DSHActionIdentifierPrefix.length];
  return DSHValidActionToken(token) ? token : nil;
}

static void DSHSendActionCallback(NSString *token) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSDictionary *payload = @{ @"version": @1, @"token": token };
    NSError *jsonError = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&jsonError];
    if (json == nil) {
      NSLog(@"[DSHNotifier] action callback JSON failed: %@", jsonError);
      return;
    }
    NSMutableData *line = [json mutableCopy];
    const uint8_t newline = '\n';
    [line appendBytes:&newline length:1];

    int client = socket(AF_UNIX, SOCK_STREAM, 0);
    if (client < 0) {
      NSLog(@"[DSHNotifier] action callback socket failed: %d", errno);
      return;
    }
    struct timeval timeout = { .tv_sec = 6, .tv_usec = 0 };
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    int noSigPipe = 1;
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, sizeof(noSigPipe));

    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    const char *path = DSHActionSocketPath.fileSystemRepresentation;
    strlcpy(address.sun_path, path, sizeof(address.sun_path));
    if (connect(client, (const struct sockaddr *)&address, sizeof(address)) != 0) {
      NSLog(@"[DSHNotifier] action callback connect failed: %d", errno);
      close(client);
      return;
    }

    const uint8_t *bytes = line.bytes;
    NSUInteger remaining = line.length;
    while (remaining > 0) {
      ssize_t count = send(client, bytes, remaining, 0);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) break;
      bytes += count;
      remaining -= (NSUInteger)count;
    }
    shutdown(client, SHUT_WR);
    char response[256] = {0};
    ssize_t received = recv(client, response, sizeof(response) - 1, 0);
    close(client);
    if (remaining == 0 && received > 0 && strncmp(response, "OK", 2) == 0) {
      NSLog(@"[DSHNotifier] action callback accepted");
    } else {
      NSLog(@"[DSHNotifier] action callback rejected: %s", received > 0 ? response : "no response");
    }
  });
}

static void DSHRememberBulletin(NSString *identifier, id bulletin) {
  if (identifier == nil || bulletin == nil) return;
  @synchronized (DSHBulletinsByIdentifier) {
    DSHBulletinsByIdentifier[identifier] = bulletin;
  }
}

static id DSHTakeBulletin(NSString *identifier) {
  if (identifier == nil) return nil;
  @synchronized (DSHBulletinsByIdentifier) {
    id bulletin = DSHBulletinsByIdentifier[identifier];
    [DSHBulletinsByIdentifier removeObjectForKey:identifier];
    return bulletin;
  }
}

static void DSHForgetBulletin(id bulletin) {
  if (bulletin == nil) return;
  @synchronized (DSHBulletinsByIdentifier) {
    NSArray<NSString *> *keys = [DSHBulletinsByIdentifier allKeysForObject:bulletin];
    [DSHBulletinsByIdentifier removeObjectsForKeys:keys];
  }
}

static void DSHOpenURLInDefaultBrowser(NSURL *url) {
  NSString *absoluteString = url.absoluteString;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    const char *executable = "/var/jb/usr/bin/uiopen";
    char *const arguments[] = {
      (char *)executable,
      (char *)absoluteString.UTF8String,
      NULL,
    };
    pid_t child = 0;
    int spawnResult = posix_spawn(&child, executable, NULL, NULL, arguments, environ);
    if (spawnResult != 0) {
      NSLog(@"[DSHNotifier] uiopen spawn failed (%d) for %@", spawnResult, url);
      return;
    }

    int childResult = 0;
    while (waitpid(child, &childResult, 0) < 0 && errno == EINTR) {}
    BOOL opened = WIFEXITED(childResult) && WEXITSTATUS(childResult) == 0;
    NSLog(@"[DSHNotifier] default browser open %@: %@", opened ? @"accepted" : @"rejected", url);
  });
}

static void DSHRemoveBulletin(id bulletin) {
  Class managerClass = objc_getClass("JBBulletinManager");
  if (managerClass == Nil) {
    NSLog(@"[DSHNotifier] cannot remove bulletin: Libbulletin is unavailable");
    return;
  }

  id manager = DSHSendId(managerClass, sel_registerName("sharedInstance"));
  id controller = DSHSendId(manager, sel_registerName("notificationController"));
  id observer = DSHSendId1(controller, sel_registerName("valueForKey:"), @"observer");
  id queueObject = DSHSendId1(controller, sel_registerName("valueForKey:"), @"_queue");
  dispatch_queue_t queue = (dispatch_queue_t)queueObject;
  if (controller == nil || observer == nil || queue == nil) {
    NSLog(@"[DSHNotifier] cannot remove bulletin: notification controller is not ready");
    return;
  }

  dispatch_async(queue, ^{
    @try {
      DSHRemoveOnController(controller, observer, bulletin);
      NSLog(@"[DSHNotifier] removed opened bulletin %@",
            DSHSendId(bulletin, sel_registerName("publisherBulletinID")));
    } @catch (NSException *exception) {
      NSLog(@"[DSHNotifier] bulletin removal failed: %@", exception);
    }
  });
}

static id DSHResponseForAction(id bulletin, SEL selector, id action) {
  BOOL handled = NO;
  @try {
    id publisherID = DSHSendId(bulletin, sel_registerName("publisherBulletinID"));
    if ([publisherID isKindOfClass:[NSString class]] &&
        [(NSString *)publisherID hasPrefix:DSHPublisherPrefix]) {
      handled = YES;
      NSString *token = DSHActionToken(action);
      NSURL *url = token == nil ? DSHActionLaunchURL(bulletin, action) : nil;
      NSLog(@"[DSHNotifier] received notification action for %@: %@",
            publisherID, token == nil ? url : @"approval callback");
      DSHForgetBulletin(bulletin);
      DSHRemoveBulletin(bulletin);
      if (token != nil) DSHSendActionCallback(token);
      else if (url != nil) DSHOpenURLInDefaultBrowser(url);
    }
  } @catch (NSException *exception) {
    NSLog(@"[DSHNotifier] notification action failed: %@", exception);
  }
  // BulletinBoard's original response path waits roughly ten seconds before
  // resolving launchURL for these synthetic bulletins. DSH has already handed
  // its validated URL to the default handler, so do not enter that path.
  if (handled) return nil;
  return DSHOriginalResponseForAction == NULL
      ? nil
      : DSHOriginalResponseForAction(bulletin, selector, action);
}

static void DSHInstallActionHook(void) {
  Class bulletinClass = objc_getClass("BBBulletin");
  SEL selector = sel_registerName("responseForAction:");
  Method method = class_getInstanceMethod(bulletinClass, selector);
  if (method == NULL) {
    NSLog(@"[DSHNotifier] BBBulletin response action hook is unavailable");
    return;
  }
  IMP current = method_getImplementation(method);
  if (current == (IMP)DSHResponseForAction) return;
  DSHOriginalResponseForAction = (id (*)(id, SEL, id))current;
  method_setImplementation(method, (IMP)DSHResponseForAction);
  NSLog(@"[DSHNotifier] installed notification action hook");
}

static void DSHPublishPayload(NSDictionary *payload) {
  NSString *title = payload[@"title"];
  NSString *body = payload[@"body"];
  NSString *bundleID = payload[@"bundleId"];
  NSURL *launchURL = DSHLaunchURL(payload[@"url"]);
  NSString *notificationID = DSHValidIdentifier(payload[@"id"]) ? payload[@"id"] : nil;
  NSArray *actionPayloads = [payload[@"actions"] isKindOfClass:[NSArray class]]
      ? payload[@"actions"]
      : nil;
  if (!DSHValidString(title, 2048) || !DSHValidString(body, 8192) ||
      !DSHValidString(bundleID, 512)) {
    NSLog(@"[DSHNotifier] rejected invalid notification payload");
    return;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    @try {
      Class managerClass = objc_getClass("JBBulletinManager");
      Class actionClass = objc_getClass("BBAction");
      if (managerClass == Nil || actionClass == Nil) {
        NSLog(@"[DSHNotifier] Libbulletin or BulletinBoard is unavailable");
        return;
      }

      id manager = DSHSendId(managerClass, sel_registerName("sharedInstance"));
      id bulletin = DSHSendId3(
          manager,
          sel_registerName("bulletinWithTitle:message:bundleID:"),
          title,
          body,
          bundleID);
      if (bulletin == nil) {
        NSLog(@"[DSHNotifier] could not create bulletin");
        return;
      }

      // Libbulletin special-cases publisher IDs that begin with
      // "-bulletin-manager" and launches the bulletin section for default
      // actions, ignoring BBAction.launchURL. Use a distinct publisher ID so
      // BulletinBoard's native response path handles the URL action.
      NSString *publisherSuffix = notificationID ?: NSUUID.UUID.UUIDString;
      NSString *publisherID = [DSHPublisherPrefix stringByAppendingString:publisherSuffix];
      DSHSendVoid1(bulletin, sel_registerName("setPublisherBulletinID:"), publisherID);
      DSHSendVoidBool(bulletin, sel_registerName("setClearable:"), YES);

      if (launchURL != nil) {
        id action = DSHSendId2(
            actionClass,
            sel_registerName("actionWithLaunchURL:callblock:"),
            launchURL,
            nil);
        DSHSendVoid1(action, sel_registerName("setIdentifier:"), DSHDefaultActionIdentifier);
        DSHSendVoidInteger(action, sel_registerName("setActionType:"), 1);
        DSHSendVoidBool(action, sel_registerName("setShouldDismissBulletin:"), YES);
        DSHSendVoid1(bulletin, sel_registerName("setDefaultAction:"), action);
      }

      if (actionPayloads.count > 0 && actionPayloads.count <= 4) {
        NSMutableArray *actions = [NSMutableArray arrayWithCapacity:actionPayloads.count];
        for (id value in actionPayloads) {
          if (![value isKindOfClass:[NSDictionary class]]) continue;
          NSDictionary *spec = (NSDictionary *)value;
          NSString *actionTitle = spec[@"title"];
          NSString *token = spec[@"token"];
          if (!DSHValidString(actionTitle, 128) || !DSHValidActionToken(token)) continue;
          NSString *actionIdentifier = [DSHActionIdentifierPrefix stringByAppendingString:token];
          id action = DSHSendId2(
              actionClass,
              sel_registerName("actionWithIdentifier:title:"),
              actionIdentifier,
              actionTitle);
          if (action == nil) continue;
          BOOL authenticationRequired = [spec[@"authenticationRequired"] isEqual:@YES];
          DSHSendVoidInteger(action, sel_registerName("setActionType:"), 1);
          DSHSendVoidBool(action, sel_registerName("setAuthenticationRequired:"), authenticationRequired);
          DSHSendVoidBool(action, sel_registerName("setCanBypassPinLock:"), !authenticationRequired);
          DSHSendVoidBool(action, sel_registerName("setLaunchCanBypassPinLock:"), !authenticationRequired);
          DSHSendVoidBool(action, sel_registerName("setShouldDismissBulletin:"), YES);
          [actions addObject:action];
        }
        if (actions.count > 0) {
          NSDictionary *layouts = @{ @0: actions, @1: actions, @2: actions, @3: actions };
          DSHSendVoid1(bulletin, sel_registerName("setSupplementaryActionsByLayout:"), layouts);
          DSHSendVoidBool(bulletin, sel_registerName("setDisplaysActionsInline:"), YES);
        }
      }

      NSNumber *soundID = payload[@"soundId"];
      Class soundClass = objc_getClass("BBSound");
      if ([soundID isKindOfClass:[NSNumber class]] && soundClass != Nil &&
          soundID.unsignedLongLongValue <= UINT_MAX) {
        id sound = DSHCreateSound(soundClass, soundID.unsignedIntValue);
        DSHSendVoid1(bulletin, sel_registerName("setSound:"), sound);
      }

      id controller = DSHSendId(manager, sel_registerName("notificationController"));
      id observer = DSHSendId1(controller, sel_registerName("valueForKey:"), @"observer");
      id queueObject = DSHSendId1(controller, sel_registerName("valueForKey:"), @"_queue");
      dispatch_queue_t queue = (dispatch_queue_t)queueObject;
      if (controller == nil || observer == nil || queue == nil) {
        NSLog(@"[DSHNotifier] notification controller is not ready");
        return;
      }

      if (notificationID != nil) {
        id previous = DSHTakeBulletin(notificationID);
        if (previous != nil) DSHRemoveBulletin(previous);
        DSHRememberBulletin(notificationID, bulletin);
      }

      dispatch_async(queue, ^{
        @try {
          DSHPublishOnController(controller, observer, bulletin, DSHDefaultFeed);
        } @catch (NSException *exception) {
          NSLog(@"[DSHNotifier] publish failed: %@", exception);
        }
      });
    } @catch (NSException *exception) {
      NSLog(@"[DSHNotifier] request failed: %@", exception);
    }
  });
}

static void DSHDismissPayload(NSDictionary *payload) {
  NSString *notificationID = payload[@"id"];
  if (!DSHValidIdentifier(notificationID)) {
    NSLog(@"[DSHNotifier] rejected invalid dismiss payload");
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    id bulletin = DSHTakeBulletin(notificationID);
    if (bulletin != nil) DSHRemoveBulletin(bulletin);
  });
}

static void DSHReply(int client, const char *message) {
  int enabled = 1;
  setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
  send(client, message, strlen(message), 0);
}

static void DSHHandleClient(int client) {
  @autoreleasepool {
    NSMutableData *data = [NSMutableData data];
    uint8_t buffer[4096];
    BOOL foundNewline = NO;
    while (data.length < DSHMaximumRequestBytes) {
      ssize_t count = recv(client, buffer, sizeof(buffer), 0);
      if (count <= 0) break;
      [data appendBytes:buffer length:(NSUInteger)count];
      if (memchr(buffer, '\n', (size_t)count) != NULL) {
        foundNewline = YES;
        break;
      }
    }

    if (!foundNewline || data.length > DSHMaximumRequestBytes) {
      DSHReply(client, "ERR invalid request framing\n");
      return;
    }

    const uint8_t *bytes = data.bytes;
    NSUInteger length = 0;
    while (length < data.length && bytes[length] != '\n') length += 1;
    NSData *jsonData = [data subdataWithRange:NSMakeRange(0, length)];
    NSError *error = nil;
    id object = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&error];
    if (error != nil || ![object isKindOfClass:[NSDictionary class]]) {
      DSHReply(client, "ERR invalid JSON\n");
      return;
    }

    NSDictionary *payload = (NSDictionary *)object;
    NSNumber *version = payload[@"version"];
    if ([version isEqual:@1]) {
      DSHPublishPayload(payload);
      DSHReply(client, "OK queued\n");
      return;
    }
    if (![version isEqual:@2]) {
      DSHReply(client, "ERR unsupported protocol\n");
      return;
    }
    NSString *operation = payload[@"operation"];
    if ([operation isEqualToString:@"publish"]) {
      DSHPublishPayload(payload);
      DSHReply(client, "OK queued\n");
    } else if ([operation isEqualToString:@"dismiss"]) {
      DSHDismissPayload(payload);
      DSHReply(client, "OK dismissed\n");
    } else {
      DSHReply(client, "ERR invalid operation\n");
    }
  }
}

static int DSHCreateServer(void) {
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0) return -1;

  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  const char *path = DSHSocketPath.fileSystemRepresentation;
  if (strlen(path) >= sizeof(address.sun_path)) {
    close(server);
    return -1;
  }
  strlcpy(address.sun_path, path, sizeof(address.sun_path));

  if (bind(server, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    int probe = socket(AF_UNIX, SOCK_STREAM, 0);
    BOOL activeServer = probe >= 0 &&
        connect(probe, (const struct sockaddr *)&address, sizeof(address)) == 0;
    if (probe >= 0) close(probe);
    if (activeServer) {
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

static void DSHRunServer(void) {
  @autoreleasepool {
    int server = DSHCreateServer();
    if (server < 0) {
      NSLog(@"[DSHNotifier] could not create %@", DSHSocketPath);
      return;
    }
    NSLog(@"[DSHNotifier] listening at %@", DSHSocketPath);
    while (YES) {
      int client = accept(server, NULL, NULL);
      if (client < 0) continue;
      DSHHandleClient(client);
      close(client);
    }
  }
}

__attribute__((constructor)) static void DSHNotifierStart(void) {
  DSHBulletinsByIdentifier = [NSMutableDictionary dictionary];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    DSHRunServer();
  });
  dispatch_async(dispatch_get_main_queue(), ^{
    DSHInstallActionHook();
  });
}
