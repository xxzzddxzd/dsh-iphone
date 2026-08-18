#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command file
require_command go
require_command rg
require_command vtool
require_command xcrun

"$SCRIPT_DIR/fetch-xray.sh" >/dev/null
SOURCE_DIR="$ROOT/build/xray-core-$XRAY_VERSION"
OUTPUT_DIR="$ROOT/build/xray-ios-$XRAY_VERSION"
OUTPUT="$OUTPUT_DIR/xray"
IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
IOS_CLANG=$(xcrun --sdk iphoneos --find clang)

mkdir -p "$OUTPUT_DIR"

cd "$SOURCE_DIR"
actual_go=$(GOTOOLCHAIN=auto go env GOVERSION)
[ "$actual_go" = "go$XRAY_GO_VERSION" ] || \
  die "Xray build selected $actual_go, expected go$XRAY_GO_VERSION"

GOTOOLCHAIN=auto \
GOOS=ios \
GOARCH=arm64 \
CGO_ENABLED=1 \
CC="$IOS_CLANG" \
SDKROOT="$IOS_SDK" \
CGO_CFLAGS="-isysroot $IOS_SDK -miphoneos-version-min=$XRAY_IOS_MIN_VERSION" \
CGO_LDFLAGS="-isysroot $IOS_SDK -miphoneos-version-min=$XRAY_IOS_MIN_VERSION" \
go build \
  -mod=readonly \
  -o "$OUTPUT" \
  -trimpath \
  -buildvcs=false \
  -gcflags='all=-l=4' \
  -ldflags="-X github.com/xtls/xray-core/core.build=${XRAY_COMMIT:0:7} -s -w -buildid=" \
  ./main

file "$OUTPUT" | rg 'Mach-O 64-bit executable arm64' >/dev/null
vtool -show-build "$OUTPUT" | rg 'platform IOS' >/dev/null
vtool -show-build "$OUTPUT" | rg "minos $XRAY_IOS_MIN_VERSION" >/dev/null

printf 'Built %s\n' "$OUTPUT"
