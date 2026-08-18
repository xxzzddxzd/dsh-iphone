#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command xcrun
require_command make

"$SCRIPT_DIR/fetch-node.sh" >/dev/null
SOURCE_DIR="$ROOT/build/node-v$NODE_VERSION"
IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
MAC_SDK=$(xcrun --sdk macosx --show-sdk-path)

case "$(uname -m)" in
  arm64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=x64 ;;
  *) die "unsupported macOS host architecture: $(uname -m)" ;;
esac

export SDKROOT="$IOS_SDK"
export GYP_DEFINES="target_arch=arm64 host_arch=$HOST_ARCH host_os=mac target_os=ios"
export CC_host="$(xcrun --sdk macosx -f clang) -isysroot $MAC_SDK -mmacosx-version-min=11.0"
export CXX_host="$(xcrun --sdk macosx -f clang++) -isysroot $MAC_SDK -mmacosx-version-min=11.0"
export AR_host="$(xcrun --sdk macosx -f ar)"
export LINK_host="$CXX_host"
export CC_target="$(xcrun --sdk iphoneos -f clang) -arch arm64 -isysroot $IOS_SDK -miphoneos-version-min=$NODE_IOS_MIN_VERSION"
export CXX_target="$(xcrun --sdk iphoneos -f clang++) -arch arm64 -isysroot $IOS_SDK -miphoneos-version-min=$NODE_IOS_MIN_VERSION"
export AR_target="$(xcrun --sdk iphoneos -f ar)"
export LINK_target="$CXX_target"

if [ -z "${JOBS:-}" ]; then
  JOBS=$(sysctl -n hw.logicalcpu 2>/dev/null || printf '4')
fi

cd "$SOURCE_DIR"
./configure \
  --dest-os=ios \
  --dest-cpu=arm64 \
  --with-intl=small-icu \
  --cross-compiling \
  --openssl-no-asm \
  --v8-options=--jitless \
  --without-node-code-cache \
  --without-node-snapshot

make -C out -j"$JOBS" BUILDTYPE=Release V=0 node
printf 'Built %s\n' "$SOURCE_DIR/out/Release/node"
