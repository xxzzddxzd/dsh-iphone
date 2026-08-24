#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

static void DSHFail(NSString *message) {
  fprintf(stderr, "dsh-image-tool: %s\n", message.UTF8String ?: "unknown error");
  exit(1);
}

static NSString *DSHArgument(NSArray<NSString *> *arguments, NSString *name) {
  NSUInteger index = [arguments indexOfObject:name];
  if (index == NSNotFound || index + 1 >= arguments.count) return nil;
  return arguments[index + 1];
}

static BOOL DSHFlag(NSArray<NSString *> *arguments, NSString *name) {
  NSString *value = DSHArgument(arguments, name);
  return [value isEqualToString:@"1"] || [value isEqualToString:@"true"];
}

static NSInteger DSHInteger(NSArray<NSString *> *arguments, NSString *name, NSInteger fallback) {
  NSString *value = DSHArgument(arguments, name);
  if (value == nil) return fallback;
  NSScanner *scanner = [NSScanner scannerWithString:value];
  NSInteger parsed = 0;
  if (![scanner scanInteger:&parsed] || !scanner.isAtEnd || parsed <= 0) {
    DSHFail([NSString stringWithFormat:@"%@ must be a positive integer", name]);
  }
  return parsed;
}

static CGImageSourceRef DSHCreateSource(NSString *path) {
  NSURL *url = [NSURL fileURLWithPath:path];
  CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
  if (source == NULL || CGImageSourceGetCount(source) == 0) {
    if (source != NULL) CFRelease(source);
    DSHFail(@"input is not a supported image");
  }
  return source;
}

static NSString *DSHFormat(CGImageSourceRef source) {
  NSString *type = (__bridge NSString *)CGImageSourceGetType(source);
  if ([type isEqualToString:@"public.png"]) return @"png";
  if ([type isEqualToString:@"public.jpeg"] || [type isEqualToString:@"public.jpeg-2000"]) return @"jpeg";
  if ([type isEqualToString:@"com.compuserve.gif"]) return @"gif";
  if ([type isEqualToString:@"org.webmproject.webp"] || [type containsString:@"webp"]) return @"webp";
  DSHFail([NSString stringWithFormat:@"unsupported image type %@", type ?: @"(null)"]);
  return @"";
}

static BOOL DSHImageHasAlpha(CGImageRef image) {
  CGImageAlphaInfo alpha = CGImageGetAlphaInfo(image) & kCGBitmapAlphaInfoMask;
  return alpha != kCGImageAlphaNone && alpha != kCGImageAlphaNoneSkipFirst
    && alpha != kCGImageAlphaNoneSkipLast;
}

static NSString *DSHColourSpace(CGImageRef image) {
  CGColorSpaceRef colourSpace = CGImageGetColorSpace(image);
  if (colourSpace == NULL) return @"other";
  CFStringRef name = CGColorSpaceGetName(colourSpace);
  if (name != NULL && (CFEqual(name, kCGColorSpaceSRGB)
      || CFEqual(name, kCGColorSpaceExtendedSRGB)
      || CFEqual(name, kCGColorSpaceLinearSRGB)
      || CFEqual(name, kCGColorSpaceExtendedLinearSRGB))) {
    return @"srgb";
  }
  if (CGColorSpaceGetModel(colourSpace) == kCGColorSpaceModelMonochrome) return @"b-w";
  return @"other";
}

static NSDictionary *DSHMetadata(CGImageSourceRef source) {
  NSDictionary *properties = CFBridgingRelease(
    CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
  if (![properties isKindOfClass:NSDictionary.class]) DSHFail(@"could not read image metadata");
  NSDictionary *decodeOptions = @{(__bridge NSString *)kCGImageSourceShouldCacheImmediately: @YES};
  CGImageRef image = CGImageSourceCreateImageAtIndex(
    source, 0, (__bridge CFDictionaryRef)decodeOptions);
  if (image == NULL) DSHFail(@"image could not be decoded");

  NSMutableDictionary *metadata = [@{
    @"format": DSHFormat(source),
    @"width": @(CGImageGetWidth(image)),
    @"height": @(CGImageGetHeight(image)),
    @"pages": @(CGImageSourceGetCount(source)),
    @"depth": CGImageGetBitsPerComponent(image) <= 8 ? @"uchar" : @"ushort",
    @"space": DSHColourSpace(image),
    @"hasAlpha": @(DSHImageHasAlpha(image)),
  } mutableCopy];

  NSNumber *orientation = properties[(__bridge NSString *)kCGImagePropertyOrientation];
  if ([orientation isKindOfClass:NSNumber.class]) metadata[@"orientation"] = orientation;
  if (properties[(__bridge NSString *)kCGImagePropertyExifDictionary] != nil) metadata[@"exif"] = @YES;
  if (properties[(__bridge NSString *)kCGImagePropertyIPTCDictionary] != nil) metadata[@"iptc"] = @YES;
  if (properties[(__bridge NSString *)kCGImagePropertyGPSDictionary] != nil) metadata[@"xmp"] = @YES;
  NSString *space = metadata[@"space"];
  if (![space isEqualToString:@"srgb"] && ![space isEqualToString:@"b-w"]) metadata[@"hasProfile"] = @YES;

  CGImageRelease(image);
  return metadata;
}

static CGImageRef DSHCreateOrientedImage(CGImageSourceRef source, BOOL rotate) {
  if (!rotate) {
    NSDictionary *options = @{(__bridge NSString *)kCGImageSourceShouldCacheImmediately: @YES};
    CGImageRef image = CGImageSourceCreateImageAtIndex(
      source, 0, (__bridge CFDictionaryRef)options);
    if (image == NULL) DSHFail(@"image could not be decoded");
    return image;
  }

  NSDictionary *properties = CFBridgingRelease(
    CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
  NSInteger width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] integerValue];
  NSInteger height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] integerValue];
  NSInteger edge = MAX(width, height);
  if (edge <= 0) DSHFail(@"image has invalid dimensions");
  NSDictionary *options = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @(edge),
    (__bridge NSString *)kCGImageSourceShouldCacheImmediately: @YES,
  };
  CGImageRef image = CGImageSourceCreateThumbnailAtIndex(
    source, 0, (__bridge CFDictionaryRef)options);
  if (image == NULL) DSHFail(@"oriented image could not be decoded");
  return image;
}

typedef struct {
  CGImageRef image;
  CGContextRef context;
  size_t width;
  size_t height;
  BOOL hasAlpha;
} DSHRaster;

static DSHRaster DSHCreateRaster(CGImageRef source, NSArray<NSString *> *arguments) {
  size_t sourceWidth = CGImageGetWidth(source);
  size_t sourceHeight = CGImageGetHeight(source);
  NSInteger requestedWidth = DSHInteger(arguments, @"--width", (NSInteger)sourceWidth);
  NSInteger requestedHeight = DSHInteger(arguments, @"--height", (NSInteger)sourceHeight);
  double scale = MIN((double)requestedWidth / (double)sourceWidth,
                     (double)requestedHeight / (double)sourceHeight);
  if (DSHFlag(arguments, @"--without-enlargement")) scale = MIN(1.0, scale);
  size_t width = MAX((size_t)1, (size_t)llround((double)sourceWidth * scale));
  size_t height = MAX((size_t)1, (size_t)llround((double)sourceHeight * scale));
  BOOL hasAlpha = DSHImageHasAlpha(source);
  CGColorSpaceRef colourSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (colourSpace == NULL) DSHFail(@"could not create sRGB colour space");
  CGBitmapInfo bitmapInfo = kCGBitmapByteOrder32Big
    | (hasAlpha ? kCGImageAlphaPremultipliedLast : kCGImageAlphaNoneSkipLast);
  CGContextRef context = CGBitmapContextCreate(
    NULL, width, height, 8, width * 4, colourSpace, bitmapInfo);
  CGColorSpaceRelease(colourSpace);
  if (context == NULL) DSHFail(@"could not allocate output raster");
  NSString *kernel = DSHArgument(arguments, @"--kernel");
  CGContextSetInterpolationQuality(context,
    [kernel isEqualToString:@"nearest"] ? kCGInterpolationNone : kCGInterpolationHigh);
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), source);
  CGImageRef image = CGBitmapContextCreateImage(context);
  if (image == NULL) {
    CGContextRelease(context);
    DSHFail(@"could not create transformed image");
  }
  return (DSHRaster){image, context, width, height, hasAlpha};
}

static void DSHReleaseRaster(DSHRaster raster) {
  CGImageRelease(raster.image);
  CGContextRelease(raster.context);
}

static void DSHWriteJSON(NSDictionary *value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (data == nil) DSHFail(error.localizedDescription ?: @"could not encode result JSON");
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

static void DSHWriteRaw(DSHRaster raster, NSString *output) {
  size_t length = CGBitmapContextGetBytesPerRow(raster.context) * raster.height;
  NSData *data = [NSData dataWithBytes:CGBitmapContextGetData(raster.context) length:length];
  NSError *error = nil;
  if (![data writeToFile:output options:NSDataWritingAtomic error:&error]) {
    DSHFail(error.localizedDescription ?: @"could not write raw image");
  }
  DSHWriteJSON(@{
    @"width": @(raster.width), @"height": @(raster.height), @"channels": @4,
    @"depth": @"uchar", @"space": @"srgb", @"hasAlpha": @(raster.hasAlpha),
  });
}

static void DSHEncode(DSHRaster raster, NSString *format, NSInteger quality, NSString *output) {
  NSString *type = nil;
  if ([format isEqualToString:@"png"]) type = @"public.png";
  else if ([format isEqualToString:@"jpeg"]) type = @"public.jpeg";
  else DSHFail([NSString stringWithFormat:@"unsupported output format %@", format]);

  NSURL *url = [NSURL fileURLWithPath:output];
  CGImageDestinationRef destination = CGImageDestinationCreateWithURL(
    (__bridge CFURLRef)url, (__bridge CFStringRef)type, 1, NULL);
  if (destination == NULL) DSHFail(@"could not create image encoder");
  NSDictionary *properties = [format isEqualToString:@"jpeg"]
    ? @{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality:
          @(MIN(100, MAX(1, quality)) / 100.0)}
    : @{};
  CGImageDestinationAddImage(destination, raster.image, (__bridge CFDictionaryRef)properties);
  BOOL finalized = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  if (!finalized) DSHFail(@"image encoder failed");
  DSHWriteJSON(@{
    @"width": @(raster.width), @"height": @(raster.height),
    @"format": format, @"hasAlpha": @(raster.hasAlpha),
  });
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) DSHFail(@"usage: dsh-image-tool metadata|raw|encode --input PATH");
    NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithCapacity:(NSUInteger)argc];
    for (int index = 0; index < argc; index += 1) {
      [arguments addObject:[NSString stringWithUTF8String:argv[index]]];
    }
    NSString *operation = arguments[1];
    NSString *input = DSHArgument(arguments, @"--input");
    if (input == nil) DSHFail(@"--input is required");
    CGImageSourceRef source = DSHCreateSource(input);
    if ([operation isEqualToString:@"metadata"]) {
      DSHWriteJSON(DSHMetadata(source));
      CFRelease(source);
      return 0;
    }

    NSString *output = DSHArgument(arguments, @"--output");
    if (output == nil) DSHFail(@"--output is required");
    CGImageRef oriented = DSHCreateOrientedImage(source, DSHFlag(arguments, @"--rotate"));
    DSHRaster raster = DSHCreateRaster(oriented, arguments);
    CGImageRelease(oriented);
    CFRelease(source);

    if ([operation isEqualToString:@"raw"]) {
      DSHWriteRaw(raster, output);
    } else if ([operation isEqualToString:@"encode"]) {
      NSString *format = DSHArgument(arguments, @"--format");
      if (format == nil) DSHFail(@"--format is required");
      DSHEncode(raster, format, DSHInteger(arguments, @"--quality", 85), output);
    } else {
      DSHReleaseRaster(raster);
      DSHFail([NSString stringWithFormat:@"unknown operation %@", operation]);
    }
    DSHReleaseRaster(raster);
  }
  return 0;
}
