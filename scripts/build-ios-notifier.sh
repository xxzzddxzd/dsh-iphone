#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command xcrun
require_command sips

IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
CC=$(xcrun --sdk iphoneos -f clang)
SWIFTC=$(xcrun --sdk iphoneos -f swiftc)
LIPO=$(xcrun -f lipo)
ACTOOL=$(xcrun -f actool)
OUTPUT_DIR="$ROOT/build/ios-notifier"
OUTPUT="$OUTPUT_DIR/DSHNotifierBridge.dylib"
APP_OUTPUT="$OUTPUT_DIR/DSH.app"
ACTIVITY_OUTPUT="$APP_OUTPUT/DSHActivityHost"
ACTIVITY_BROKER_OUTPUT="$OUTPUT_DIR/DSHActivityD"
ACTIVITY_WORKER_OUTPUT="$OUTPUT_DIR/DSHActivityOp"
ACTIVITY_EXTENSION="$APP_OUTPUT/PlugIns/DSHLiveActivity.appex"
ACTIVITY_MIN_VERSION=16.1
reset_build_dir "$OUTPUT_DIR"

"$CC" \
  -arch arm64 \
  -arch arm64e \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -fobjc-arc \
  -fblocks \
  -O2 \
  -dynamiclib \
  -framework Foundation \
  -install_name /var/jb/Library/MobileSubstrate/DynamicLibraries/DSHNotifierBridge.dylib \
  "$ROOT/ios/notifications/DSHNotifierBridge.m" \
  -o "$OUTPUT"

"$CC" \
  -arch arm64 \
  -arch arm64e \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$ACTIVITY_MIN_VERSION" \
  -fobjc-arc \
  -fblocks \
  -O2 \
  -framework Foundation \
  "$ROOT/ios/activity/DSHActivityBridge.m" \
  -o "$ACTIVITY_BROKER_OUTPUT"

"$CC" \
  -arch arm64 \
  -arch arm64e \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$ACTIVITY_MIN_VERSION" \
  -fobjc-arc \
  -O2 \
  -framework Foundation \
  "$ROOT/ios/activity/DSHActivityWorker.m" \
  -o "$ACTIVITY_WORKER_OUTPUT"

mkdir -p "$ACTIVITY_EXTENSION" "$OUTPUT_DIR/swift" \
  "$OUTPUT_DIR/assets/DSHActivity.xcassets/DSHWhale.imageset"

for arch in arm64 arm64e; do
  "$SWIFTC" \
    -sdk "$IOS_SDK" \
    -target "$arch-apple-ios$ACTIVITY_MIN_VERSION" \
    -parse-as-library \
    -O \
    -module-name DSHActivityHost \
    "$ROOT/ios/activity/DSHActivityHost.swift" \
    -o "$OUTPUT_DIR/swift/DSHActivityHost-$arch"

  "$SWIFTC" \
    -sdk "$IOS_SDK" \
    -target "$arch-apple-ios$ACTIVITY_MIN_VERSION" \
    -parse-as-library \
    -application-extension \
    -O \
    -module-name DSHLiveActivity \
    -Xlinker -e \
    -Xlinker _NSExtensionMain \
    "$ROOT/ios/activity/DSHActivityAttributes.swift" \
    "$ROOT/ios/activity/DSHLiveActivityWidget.swift" \
    -o "$OUTPUT_DIR/swift/DSHLiveActivity-$arch"
done

"$LIPO" -create \
  "$OUTPUT_DIR/swift/DSHActivityHost-arm64" \
  "$OUTPUT_DIR/swift/DSHActivityHost-arm64e" \
  -output "$ACTIVITY_OUTPUT"
"$LIPO" -create \
  "$OUTPUT_DIR/swift/DSHLiveActivity-arm64" \
  "$OUTPUT_DIR/swift/DSHLiveActivity-arm64e" \
  -output "$ACTIVITY_EXTENSION/DSHLiveActivity"

install -m 0644 "$ROOT/ios/activity/DSHActivityHost-Info.plist" "$APP_OUTPUT/Info.plist"
install -m 0644 "$ROOT/ios/activity/DSHLiveActivity-Info.plist" "$ACTIVITY_EXTENSION/Info.plist"

cp "$ROOT/ios/activity/DSHActivity.xcassets/Contents.json" \
  "$OUTPUT_DIR/assets/DSHActivity.xcassets/Contents.json"
cp "$ROOT/ios/activity/DSHActivity.xcassets/DSHWhale.imageset/Contents.json" \
  "$OUTPUT_DIR/assets/DSHActivity.xcassets/DSHWhale.imageset/Contents.json"
cp "$ROOT/upstream/deepseek-harness/apps/web/public/favicon.svg" \
  "$OUTPUT_DIR/assets/DSHActivity.xcassets/DSHWhale.imageset/whale.svg"
"$ACTOOL" "$OUTPUT_DIR/assets/DSHActivity.xcassets" \
  --compile "$ACTIVITY_EXTENSION" \
  --platform iphoneos \
  --minimum-deployment-target "$ACTIVITY_MIN_VERSION" \
  --target-device iphone \
  --output-partial-info-plist "$OUTPUT_DIR/assets-info.plist" >/dev/null

ICON_SOURCE="$ROOT/upstream/deepseek-harness/apps/web/public/favicon.svg"
sips -s format png --resampleHeightWidthMax 96 --padToHeightWidth 120 120 \
  --padColor FFFFFF "$ICON_SOURCE" --out "$APP_OUTPUT/Icon-60@2x.png" >/dev/null 2>&1
sips -s format png --resampleHeightWidthMax 144 --padToHeightWidth 180 180 \
  --padColor FFFFFF "$ICON_SOURCE" --out "$APP_OUTPUT/Icon-60@3x.png" >/dev/null 2>&1

printf '%s\n' "$OUTPUT"
