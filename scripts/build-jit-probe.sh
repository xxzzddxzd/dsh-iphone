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
OUTPUT="$ROOT/build/ios-jit-probe.ios-arm64"
mkdir -p "$ROOT/build"

"$CC" \
  -arch arm64 \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -O2 "$ROOT/tools/ios-jit-probe.c" \
  -o "$OUTPUT"

printf '%s\n' "$OUTPUT"
