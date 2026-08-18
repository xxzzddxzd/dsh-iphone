#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command shasum
require_command tar

CACHE_DIR="$ROOT/.cache"
SOURCE_DIR="$ROOT/build/xray-core-$XRAY_VERSION"
ARCHIVE_PATH=${XRAY_ARCHIVE_PATH:-"$CACHE_DIR/$XRAY_ARCHIVE"}

mkdir -p "$CACHE_DIR" "$ROOT/build"

if [ ! -f "$ARCHIVE_PATH" ]; then
  require_command curl
  printf 'Downloading %s\n' "$XRAY_URL"
  curl -fL --retry 3 --output "$ARCHIVE_PATH" "$XRAY_URL"
fi

actual_sha=$(sha256_file "$ARCHIVE_PATH")
[ "$actual_sha" = "$XRAY_SHA256" ] || \
  die "Xray archive checksum mismatch: expected $XRAY_SHA256, got $actual_sha"

if [ ! -d "$SOURCE_DIR" ]; then
  temp_extract="$ROOT/build/.xray-core-$XRAY_VERSION.extract"
  reset_build_dir "$temp_extract"
  tar -xzf "$ARCHIVE_PATH" -C "$temp_extract"
  mv "$temp_extract/Xray-core-$XRAY_VERSION" "$SOURCE_DIR"
  rmdir "$temp_extract"
fi

rg -q '^module github\.com/xtls/xray-core$' "$SOURCE_DIR/go.mod" || \
  die "unexpected Xray module in $SOURCE_DIR/go.mod"
rg -q "^go ${XRAY_GO_VERSION%.*}$" "$SOURCE_DIR/go.mod" || \
  die "Xray v$XRAY_VERSION no longer declares Go ${XRAY_GO_VERSION%.*}"

printf '%s\n' "$SOURCE_DIR"
