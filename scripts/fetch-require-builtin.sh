#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
load_versions
require_command shasum
require_command tar
require_command node

fetch_archive() {
  local archive url expected actual
  archive="$ROOT/.cache/$1"
  url=$2
  expected=$3
  if [ ! -f "$archive" ]; then
    require_command curl
    curl -fL --retry 3 --output "$archive" "$url"
  fi
  actual=$(sha256_file "$archive")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $1: expected $expected, got $actual"
}

mkdir -p "$ROOT/.cache" "$ROOT/build"
fetch_archive "$REQUIRE_BUILTIN_ARCHIVE" "$REQUIRE_BUILTIN_URL" "$REQUIRE_BUILTIN_SHA256"
fetch_archive "$REQUIRE_BUILTIN_ADDON_API_ARCHIVE" "$REQUIRE_BUILTIN_ADDON_API_URL" "$REQUIRE_BUILTIN_ADDON_API_SHA256"

# Re-extract verified archives so edited build copies cannot affect the binary.
SOURCE_DIR="$ROOT/build/require-builtin-$REQUIRE_BUILTIN_VERSION"
API_DIR="$ROOT/build/require-builtin-addon-api-$REQUIRE_BUILTIN_ADDON_API_VERSION"
reset_build_dir "$SOURCE_DIR"
reset_build_dir "$API_DIR"
tar -xzf "$ROOT/.cache/$REQUIRE_BUILTIN_ARCHIVE" -C "$SOURCE_DIR" --strip-components=1
tar -xzf "$ROOT/.cache/$REQUIRE_BUILTIN_ADDON_API_ARCHIVE" -C "$API_DIR" --strip-components=1

source_version=$(node -p "require('$SOURCE_DIR/packages/require-builtin/entry/package.json').version")
loader_version=$(node -p "require('$SOURCE_DIR/packages/loader/package.json').version")
api_version=$(node -p "require('$API_DIR/package.json').version")
[ "$source_version" = "$REQUIRE_BUILTIN_VERSION" ] || die "unexpected require-builtin source version: $source_version"
[ "$loader_version" = "$REQUIRE_BUILTIN_VERSION" ] || die "unexpected native custom loader source version: $loader_version"
[ "$api_version" = "$REQUIRE_BUILTIN_ADDON_API_VERSION" ] || die "unexpected require-builtin headers: $api_version"
printf '%s\n' "$SOURCE_DIR"
