#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command xcrun
require_command node
require_command rg

RUNTIME_ROOT=${DSH_RUNTIME_ROOT:-"$ROOT/build/dsh-runtime"}
SYSTEM_ROOT="$RUNTIME_ROOT/node_modules/@deepseek-ai/node-addon-system"
SOURCE="$SYSTEM_ROOT/src/flock.c"
OUTPUT_ROOT="$SYSTEM_ROOT/prebuilds/ios-arm64"
OUTPUT="$OUTPUT_ROOT/system.node"

[ -f "$RUNTIME_ROOT/package.json" ] || "$SCRIPT_DIR/prepare-dsh.sh" >/dev/null
[ -f "$SOURCE" ] || die "missing flock source at $SOURCE"
rg -Fq 'NAPI_MODULE_INIT()' "$SOURCE" || die "flock.c is missing the Node-API module entry"

NODE_HEADERS=""
for candidate in \
  /opt/homebrew/include/node \
  /usr/local/include/node \
  "$(node -p "require('node:path').resolve(require('node:path').dirname(process.execPath), '..', 'include', 'node')")"
do
  if [ -f "$candidate/node_api.h" ]; then
    NODE_HEADERS=$candidate
    break
  fi
done
[ -n "$NODE_HEADERS" ] || die "Node-API headers not found; install Node development headers"

IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
CC=$(xcrun --sdk iphoneos -f clang)
mkdir -p "$OUTPUT_ROOT"

"$CC" \
  -std=c11 \
  -arch arm64 \
  -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -O2 -Wall -Wextra -Werror -fPIC -fvisibility=hidden \
  -DNAPI_VERSION=8 \
  -I "$NODE_HEADERS" \
  -bundle \
  -Wl,-undefined,dynamic_lookup \
  -o "$OUTPUT" \
  "$SOURCE"

printf 'Built %s\n' "$OUTPUT"
