#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command xcrun

IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
CC=$(xcrun --sdk iphoneos -f clang)
OUTPUT_DIR="$ROOT/build/ios-image-tool"
OUTPUT="$OUTPUT_DIR/dsh-image-tool"
reset_build_dir "$OUTPUT_DIR"

"$CC" \
  -arch arm64 \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -fobjc-arc \
  -O2 \
  -framework Foundation \
  -framework CoreGraphics \
  -framework ImageIO \
  "$ROOT/ios/image/DSHImageTool.m" \
  -o "$OUTPUT"

printf '%s\n' "$OUTPUT"
