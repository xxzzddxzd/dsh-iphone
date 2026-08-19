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
OUTPUT_DIR="$ROOT/build/ios-notifier"
OUTPUT="$OUTPUT_DIR/DSHNotifierBridge.dylib"
APP_OUTPUT="$OUTPUT_DIR/DSH.app"
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

mkdir -p "$APP_OUTPUT"
"$CC" \
  -arch arm64 \
  -arch arm64e \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -fobjc-arc \
  -O2 \
  -framework Foundation \
  "$ROOT/ios/notifications/DSHIconHost.m" \
  -o "$APP_OUTPUT/DSHIconHost"
install -m 0644 "$ROOT/ios/notifications/DSHIconHost-Info.plist" "$APP_OUTPUT/Info.plist"

ICON_SOURCE="$ROOT/upstream/deepseek-harness/apps/web/public/favicon.svg"
sips -s format png --resampleHeightWidthMax 96 --padToHeightWidth 120 120 \
  --padColor FFFFFF "$ICON_SOURCE" --out "$APP_OUTPUT/Icon-60@2x.png" >/dev/null 2>&1
sips -s format png --resampleHeightWidthMax 144 --padToHeightWidth 180 180 \
  --padColor FFFFFF "$ICON_SOURCE" --out "$APP_OUTPUT/Icon-60@3x.png" >/dev/null 2>&1

printf '%s\n' "$OUTPUT"
