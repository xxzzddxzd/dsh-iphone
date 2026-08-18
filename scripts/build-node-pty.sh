#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command xcrun
require_command node
require_command patch
require_command rg

SOURCE_ROOT="$ROOT/build/node-v$NODE_VERSION"
RUNTIME_ROOT=${DSH_RUNTIME_ROOT:-"$ROOT/build/dsh-runtime"}
PTY_ROOT="$RUNTIME_ROOT/node_modules/node-pty"
NODE_ADDON_API="$RUNTIME_ROOT/node_modules/node-addon-api"
PATCH_FILE="$ROOT/patches/node-pty-$NODE_PTY_VERSION-ios.patch"
OUTPUT_ROOT="$PTY_ROOT/prebuilds/ios-arm64"

[ -d "$SOURCE_ROOT" ] || "$SCRIPT_DIR/fetch-node.sh" >/dev/null
[ -f "$RUNTIME_ROOT/package.json" ] || "$SCRIPT_DIR/prepare-dsh.sh" >/dev/null

actual_pty_version=$(node -p "require('$PTY_ROOT/package.json').version")
[ "$actual_pty_version" = "$NODE_PTY_VERSION" ] || \
  die "expected node-pty $NODE_PTY_VERSION, got $actual_pty_version"
actual_napi_version=$(node -p "require('$NODE_ADDON_API/package.json').version")
[ "$actual_napi_version" = "$NODE_ADDON_API_VERSION" ] || \
  die "expected node-addon-api $NODE_ADDON_API_VERSION, got $actual_napi_version"

if rg -q '^#if defined\(NODE_PTY_IOS\)$' "$PTY_ROOT/src/unix/pty.cc" && \
  rg -q '^#if defined\(__APPLE__\) && !defined\(NODE_PTY_IOS\)$' "$PTY_ROOT/src/unix/pty.cc"; then
  printf 'node-pty iOS patch already applied\n'
elif patch -d "$PTY_ROOT" -p1 --forward --force --dry-run < "$PATCH_FILE" >/dev/null; then
  patch -d "$PTY_ROOT" -p1 --forward --force < "$PATCH_FILE"
else
  die "node-pty patch preimage mismatch in $PTY_ROOT"
fi

IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
CXX=$(xcrun --sdk iphoneos -f clang++)
mkdir -p "$OUTPUT_ROOT"

"$CXX" \
  -std=gnu++20 \
  -arch arm64 \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -O2 -fPIC -bundle \
  -Wl,-undefined,dynamic_lookup \
  -DNODE_GYP_MODULE_NAME=pty \
  -DBUILDING_NODE_EXTENSION \
  -DNODE_PTY_IOS=1 \
  -include "$ROOT/shims/native/pty-decls.h" \
  -I "$ROOT/shims/native" \
  -I "$SOURCE_ROOT/src" \
  -I "$SOURCE_ROOT/deps/v8/include" \
  -I "$SOURCE_ROOT/deps/uv/include" \
  -I "$NODE_ADDON_API" \
  -x c++ "$PTY_ROOT/src/unix/pty.cc" \
  -lutil \
  -o "$OUTPUT_ROOT/pty.node"

"$CXX" \
  -std=gnu++20 \
  -arch arm64 \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -O2 "$PTY_ROOT/src/unix/spawn-helper.cc" \
  -o "$OUTPUT_ROOT/spawn-helper"

chmod 0755 "$OUTPUT_ROOT/spawn-helper"
printf 'Built %s and %s\n' "$OUTPUT_ROOT/pty.node" "$OUTPUT_ROOT/spawn-helper"
