#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command npm
require_command node

LOCK_FILE="$ROOT/dsh-runtime/package-lock.json"
INSTALL_ROOT="$ROOT/dsh-runtime/node_modules"
PACKAGE_ROOT="$INSTALL_ROOT/@deepseek-ai/dsh"
RUNTIME_ROOT="$ROOT/build/dsh-runtime"

[ -f "$LOCK_FILE" ] || die "missing dsh-runtime/package-lock.json"

npm ci \
  --prefix "$ROOT/dsh-runtime" \
  --ignore-scripts \
  --no-audit \
  --no-fund

[ -f "$PACKAGE_ROOT/package.json" ] || die "npm did not install @deepseek-ai/dsh"
reset_build_dir "$RUNTIME_ROOT"
cp -R "$PACKAGE_ROOT/." "$RUNTIME_ROOT/"
mkdir -p "$RUNTIME_ROOT/node_modules"
cp -R "$INSTALL_ROOT/." "$RUNTIME_ROOT/node_modules/"
rm -rf "$RUNTIME_ROOT/node_modules/@deepseek-ai/dsh"

node "$SCRIPT_DIR/patch-dsh.mjs" --root "$RUNTIME_ROOT"
printf '%s\n' "$RUNTIME_ROOT"
