#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command node
require_command shasum
require_command tar

CACHE_DIR="$ROOT/.cache"
SOURCE_DIR="$ROOT/build/pnpm-$PNPM_VERSION"
ARCHIVE_PATH=${PNPM_ARCHIVE_PATH:-"$CACHE_DIR/$PNPM_ARCHIVE"}

mkdir -p "$CACHE_DIR" "$ROOT/build"

if [ ! -f "$ARCHIVE_PATH" ]; then
  require_command curl
  printf 'Downloading %s\n' "$PNPM_URL"
  curl -fL --retry 3 --output "$ARCHIVE_PATH" "$PNPM_URL"
fi

actual_sha=$(sha256_file "$ARCHIVE_PATH")
[ "$actual_sha" = "$PNPM_SHA256" ] || \
  die "pnpm archive checksum mismatch: expected $PNPM_SHA256, got $actual_sha"

if [ ! -d "$SOURCE_DIR" ]; then
  temp_extract="$ROOT/build/.pnpm-$PNPM_VERSION.extract"
  reset_build_dir "$temp_extract"
  tar -xzf "$ARCHIVE_PATH" -C "$temp_extract"
  [ -d "$temp_extract/package" ] || die "pnpm archive has no package directory"
  mv "$temp_extract/package" "$SOURCE_DIR"
  rmdir "$temp_extract"
fi

[ -f "$SOURCE_DIR/bin/pnpm.cjs" ] || die "pnpm entry point is missing from $SOURCE_DIR"
[ -f "$SOURCE_DIR/bin/pnpx.cjs" ] || die "pnpx entry point is missing from $SOURCE_DIR"
package_name=$(node -p "require('$SOURCE_DIR/package.json').name")
package_version=$(node -p "require('$SOURCE_DIR/package.json').version")
[ "$package_name" = pnpm ] || die "unexpected pnpm package name: $package_name"
[ "$package_version" = "$PNPM_VERSION" ] || \
  die "unexpected pnpm package version: $package_version"

printf '%s\n' "$SOURCE_DIR"
