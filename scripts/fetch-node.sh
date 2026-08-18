#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command patch
require_command rg
require_command shasum
require_command tar

CACHE_DIR="$ROOT/.cache"
SOURCE_DIR="$ROOT/build/node-v$NODE_VERSION"
PATCH_FILE="$ROOT/patches/node-v$NODE_VERSION-ios.patch"
ARCHIVE_PATH=${NODE_ARCHIVE_PATH:-"$CACHE_DIR/$NODE_ARCHIVE"}

mkdir -p "$CACHE_DIR" "$ROOT/build"

if [ ! -f "$ARCHIVE_PATH" ]; then
  require_command curl
  printf 'Downloading %s\n' "$NODE_URL"
  curl -fL --retry 3 --output "$ARCHIVE_PATH" "$NODE_URL"
fi

actual_sha=$(sha256_file "$ARCHIVE_PATH")
[ "$actual_sha" = "$NODE_SHA256" ] || \
  die "Node archive checksum mismatch: expected $NODE_SHA256, got $actual_sha"

if [ ! -d "$SOURCE_DIR" ]; then
  temp_extract="$ROOT/build/.node-v$NODE_VERSION.extract"
  reset_build_dir "$temp_extract"
  tar -xJf "$ARCHIVE_PATH" -C "$temp_extract"
  mv "$temp_extract/node-v$NODE_VERSION" "$SOURCE_DIR"
  rmdir "$temp_extract"
fi

if rg -q "elif options\.dest_os == 'ios':" "$SOURCE_DIR/configure.py" && \
  rg -q 'IosJitWriteState' "$SOURCE_DIR/deps/v8/src/common/code-memory-access.cc"; then
  printf 'Node iOS patch already applied: %s\n' "$SOURCE_DIR"
elif patch -d "$SOURCE_DIR" -p1 --forward --force --dry-run < "$PATCH_FILE" >/dev/null; then
  patch -d "$SOURCE_DIR" -p1 --forward --force < "$PATCH_FILE"
else
  die "Node patch preimage does not match $SOURCE_DIR; reset build/node-v$NODE_VERSION"
fi

printf '%s\n' "$SOURCE_DIR"
