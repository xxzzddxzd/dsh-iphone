#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../scripts/lib.sh
. "$SCRIPT_DIR/../scripts/lib.sh"

ROOT=$(repo_root)
load_versions
require_command patch
require_command rg
require_command shasum
require_command tar

ARCHIVE_PATH=${NODE_ARCHIVE_PATH:-"$ROOT/.cache/$NODE_ARCHIVE"}
[ -f "$ARCHIVE_PATH" ] || die "Node archive unavailable; run ./scripts/fetch-node.sh first"
[ "$(sha256_file "$ARCHIVE_PATH")" = "$NODE_SHA256" ] || die "Node archive checksum mismatch"

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dsh-iphone-patches.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT INT TERM
tar -xJf "$ARCHIVE_PATH" -C "$TEMP_ROOT"
NODE_SOURCE="$TEMP_ROOT/node-v$NODE_VERSION"

patch -d "$NODE_SOURCE" -p1 --forward --force --dry-run \
  < "$ROOT/patches/node-v$NODE_VERSION-ios.patch" >/dev/null
patch -d "$NODE_SOURCE" -p1 --forward --force \
  < "$ROOT/patches/node-v$NODE_VERSION-ios.patch" >/dev/null
rg -q "elif options\.dest_os == 'ios':" "$NODE_SOURCE/configure.py"
rg -q 'IosJitWriteState' "$NODE_SOURCE/deps/v8/src/common/code-memory-access.cc"

if [ -d "$ROOT/dsh-runtime/node_modules/node-pty" ]; then
  patch -d "$ROOT/dsh-runtime/node_modules/node-pty" -p1 --forward --force --dry-run \
    < "$ROOT/patches/node-pty-$NODE_PTY_VERSION-ios.patch" >/dev/null
fi

printf 'Node and node-pty source patch checks passed\n'
