#import <Foundation/Foundation.h>

static BOOL DSHIsNativeSessionURL(NSURL *url) {
  if (url == nil || ![url.scheme.lowercaseString isEqualToString:@"dshmobile"] ||
      ![url.host.lowercaseString isEqualToString:@"session"] || url.user != nil ||
      url.password != nil || url.port != nil || url.fragment != nil ||
      (url.path.length != 0 && ![url.path isEqualToString:@"/"])) return NO;
  NSArray<NSURLQueryItem *> *items = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO].queryItems;
  if (items.count != 2) return NO;
  NSMutableDictionary<NSString *, NSString *> *fields = [NSMutableDictionary dictionary];
  for (NSURLQueryItem *item in items) {
    if (item.value == nil || fields[item.name] != nil) return NO;
    fields[item.name] = item.value;
  }
  if (fields.count != 2 || fields[@"gateway"] == nil || fields[@"id"] == nil ||
      [[NSUUID alloc] initWithUUIDString:fields[@"gateway"]] == nil) return NO;
  NSString *session = fields[@"id"];
  if (session.length == 0 || session.length > 512) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:
      @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"] invertedSet];
  return [session rangeOfCharacterFromSet:invalid].location == NSNotFound;
}
