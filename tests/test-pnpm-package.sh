#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../scripts/lib.sh
. "$SCRIPT_DIR/../scripts/lib.sh"

ROOT=$(repo_root)
load_versions
require_command node
require_command rg

SOURCE_DIR=${PNPM_SOURCE_PATH:-"$ROOT/build/pnpm-$PNPM_VERSION"}
[ -f "$SOURCE_DIR/bin/pnpm.cjs" ] || die "missing pnpm source at $SOURCE_DIR"

actual_name=$(node -p "require('$SOURCE_DIR/package.json').name")
actual_version=$(node -p "require('$SOURCE_DIR/package.json').version")
[ "$actual_name" = pnpm ] || die "unexpected pnpm package name: $actual_name"
[ "$actual_version" = "$PNPM_VERSION" ] || \
  die "pnpm source is $actual_version, expected $PNPM_VERSION"
[ "$(node "$SOURCE_DIR/bin/pnpm.cjs" --version)" = "$PNPM_VERSION" ] || \
  die "pnpm entry point did not report $PNPM_VERSION"

rg -F '/var/jb/usr/local/lib/nodejs22/node' "$ROOT/packaging/pnpm/pnpm" >/dev/null
rg -F '/var/jb/usr/local/lib/nodejs22:' "$ROOT/packaging/pnpm/pnpm" >/dev/null
rg -F '/var/jb/usr/local/lib/nodejs22/node' "$ROOT/packaging/pnpm/pnpx" >/dev/null

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dsh-pnpm-test.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/dist"
cp "$SOURCE_DIR/package.json" "$TEMP_ROOT/package.json"
cp "$SOURCE_DIR/dist/pnpm.cjs" "$TEMP_ROOT/dist/pnpm.cjs"
node "$ROOT/scripts/patch-pnpm.mjs" --root "$TEMP_ROOT" >/dev/null
node "$ROOT/scripts/patch-pnpm.mjs" --root "$TEMP_ROOT" --check >/dev/null
rg -F 'process.platform === "ios"' "$TEMP_ROOT/dist/pnpm.cjs" >/dev/null

printf 'pnpm package source, wrappers, and iOS exec patch passed\n'
