#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/runtime.h>

static void PrintMethodDescriptions(Protocol *protocol, BOOL required, BOOL instance) {
  unsigned int count = 0;
  struct objc_method_description *methods =
      protocol_copyMethodDescriptionList(protocol, required, instance, &count);
  for (unsigned int index = 0; index < count; index++) {
    const char *name = methods[index].name == NULL ? "(null)" : sel_getName(methods[index].name);
    const char *types = methods[index].types == NULL ? "(null)" : methods[index].types;
    printf("  method required=%d instance=%d %s types=%s\n",
           required, instance, name, types);
  }
  free(methods);
}

static void PrintProtocol(Protocol *protocol) {
  printf("protocol %s\n", protocol_getName(protocol));
  unsigned int adoptedCount = 0;
  Protocol *__unsafe_unretained *adopted = protocol_copyProtocolList(protocol, &adoptedCount);
  for (unsigned int index = 0; index < adoptedCount; index++) {
    printf("  adopts %s\n", protocol_getName(adopted[index]));
  }
  free(adopted);
  PrintMethodDescriptions(protocol, YES, YES);
  PrintMethodDescriptions(protocol, YES, NO);
  PrintMethodDescriptions(protocol, NO, YES);
  PrintMethodDescriptions(protocol, NO, NO);
}

static void PrintClass(Class cls) {
  printf("class %s superclass=%s size=%zu\n",
         class_getName(cls),
         class_getSuperclass(cls) == Nil ? "(nil)" : class_getName(class_getSuperclass(cls)),
         class_getInstanceSize(cls));

  unsigned int methodCount = 0;
  Method *methods = class_copyMethodList(cls, &methodCount);
  for (unsigned int index = 0; index < methodCount; index++) {
    printf("  instance %s types=%s\n",
           sel_getName(method_getName(methods[index])),
           method_getTypeEncoding(methods[index]));
  }
  free(methods);

  methods = class_copyMethodList(object_getClass(cls), &methodCount);
  for (unsigned int index = 0; index < methodCount; index++) {
    printf("  class %s types=%s\n",
           sel_getName(method_getName(methods[index])),
           method_getTypeEncoding(methods[index]));
  }
  free(methods);

  unsigned int propertyCount = 0;
  objc_property_t *properties = class_copyPropertyList(cls, &propertyCount);
  for (unsigned int index = 0; index < propertyCount; index++) {
    printf("  property %s attributes=%s\n",
           property_getName(properties[index]),
           property_getAttributes(properties[index]));
  }
  free(properties);

  unsigned int ivarCount = 0;
  Ivar *ivars = class_copyIvarList(cls, &ivarCount);
  for (unsigned int index = 0; index < ivarCount; index++) {
    printf("  ivar %s type=%s offset=%td\n",
           ivar_getName(ivars[index]),
           ivar_getTypeEncoding(ivars[index]),
           ivar_getOffset(ivars[index]));
  }
  free(ivars);
}

int main(void) {
  @autoreleasepool {
    void *handle = dlopen("/System/Library/Frameworks/ActivityKit.framework/ActivityKit", RTLD_NOW);
    if (handle == NULL) {
      fprintf(stderr, "dlopen ActivityKit failed: %s\n", dlerror());
      return 1;
    }
    void *assertionHandle = dlopen(
        "/System/Library/PrivateFrameworks/SessionAssertion.framework/SessionAssertion",
        RTLD_NOW);
    if (assertionHandle == NULL) {
      fprintf(stderr, "dlopen SessionAssertion failed: %s\n", dlerror());
      return 1;
    }

    const char *protocolNames[] = {
      "ACActivityInputXPCClient",
      "ACActivityInputXPCServer",
      "ACActivityOutputXPCClient",
      "ACActivityOutputXPCServer",
      "ACActivityAuthorizationXPCClient",
      "ACActivityAuthorizationXPCServer",
      "SNAAssertionXPCClient",
      "SNAAssertionXPCServer",
    };
    for (NSUInteger index = 0; index < sizeof(protocolNames) / sizeof(protocolNames[0]); index++) {
      Protocol *protocol = objc_getProtocol(protocolNames[index]);
      if (protocol == nil) {
        printf("protocol %s unavailable\n", protocolNames[index]);
      } else {
        PrintProtocol(protocol);
      }
    }

    const char *classNames[] = {
      "ACActivityAuthorization",
      "ACActivityCenter",
      "ACActivityContent",
      "ACActivityDescriptor",
      "ACActivityPresentationOptions",
      "_TtC11ActivityKit19ActivityInputClient",
      "_TtC11ActivityKit20ActivityOutputClient",
      "_TtC11ActivityKit24ActivityCenterObjcBridge",
      "_NSXPCDistantObject",
      "NSXPCConnection",
      "NSXPCInterface",
      "BSServiceConnection",
      "BSServiceConnectionEndpoint",
      "BSServiceConnectionListener",
      "BSXPCServiceConnection",
      "BSXPCServiceConnectionProxy",
      "BSXPCServiceConnectionMessage",
      "BSXPCServiceConnectionMessageReply",
      "BSXPCServiceConnectionContext",
      "BSXPCServiceConnectionRootClientEndpointContext",
      "BSXPCServiceConnectionPeer",
      "SNAAssertion",
      "SNAAssertionTarget",
      "_TtC16SessionAssertion15AssertionClient",
      "_TtC16SessionAssertion16AssertionOptions",
      "_TtC16SessionAssertion23SessionRequestAssertion",
    };
    for (NSUInteger index = 0; index < sizeof(classNames) / sizeof(classNames[0]); index++) {
      Class cls = objc_getClass(classNames[index]);
      if (cls == Nil) {
        printf("class %s unavailable\n", classNames[index]);
      } else {
        PrintClass(cls);
      }
    }

    NSArray<NSString *> *proxySelectors = @[
      @"invokeMethod:onTarget:withArguments:count:returnValue:",
      @"invokeMethod:onTarget:withMessage:forConnection:",
      @"createImplementationOfProtocol:forClass:withName:",
      @"concreteArgumentsForArguments:",
      @"proxyForConnection:handshake:withProtocol:activeXPCConnection:xpcConnectionTargetQueue:replyQueue:target:attributes:assertionProvider:",
    ];
    for (NSString *selectorName in proxySelectors) {
      Method proxyMethod = class_getClassMethod(
          NSClassFromString(@"BSXPCServiceConnectionProxy"),
          NSSelectorFromString(selectorName));
      printf("BSXPC proxy method %s types=%s imp=%p\n",
             selectorName.UTF8String,
             proxyMethod == NULL ? "(null)" : method_getTypeEncoding(proxyMethod),
             proxyMethod == NULL ? NULL : method_getImplementation(proxyMethod));
    }

    unsigned int loadedClassCount = 0;
    Class *loadedClasses = objc_copyClassList(&loadedClassCount);
    for (unsigned int index = 0; index < loadedClassCount; index++) {
      NSString *name = @(class_getName(loadedClasses[index]));
      if ([name localizedCaseInsensitiveContainsString:@"xpc"] ||
          [name localizedCaseInsensitiveContainsString:@"proxy"] ||
          [name localizedCaseInsensitiveContainsString:@"distant"]) {
        if (class_getInstanceMethod(loadedClasses[index], @selector(forwardInvocation:)) != NULL ||
            class_getInstanceMethod(loadedClasses[index], @selector(remoteObjectProxy)) != NULL ||
            class_getInstanceMethod(loadedClasses[index], @selector(remoteObjectProxyWithErrorHandler:)) != NULL) {
          PrintClass(loadedClasses[index]);
        }
      }
    }
    free(loadedClasses);

    dlclose(assertionHandle);
    dlclose(handle);
  }
  return 0;
}
