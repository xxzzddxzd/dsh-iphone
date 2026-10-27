#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
load_versions
require_command npm
require_command node
require_command tar
require_command rsync

# npm ci verifies every archive against the committed production lock. No
# lifecycle scripts run, no host DSH peer is resolved or included.
npm ci --prefix "$ROOT/mobile-gateway" --omit=dev --ignore-scripts --no-audit --no-fund >&2
SOURCE="$ROOT/mobile-gateway/node_modules/dsh-plugin-mobile-gateway"
STAGE="$ROOT/build/mobile-gateway"
reset_build_dir "$STAGE"
mkdir -p "$STAGE/package/node_modules" "$ROOT/dist"
rsync -a --exclude=node_modules --exclude=bin --exclude=helper "$SOURCE/" "$STAGE/package/"
rsync -a --exclude=dsh-plugin-mobile-gateway --exclude=.bin --exclude=.package-lock.json \
  "$ROOT/mobile-gateway/node_modules/" "$STAGE/package/node_modules/"
node "$SCRIPT_DIR/patch-mobile-gateway.mjs" --root "$STAGE/package" >&2
node "$ROOT/tests/test-mobile-gateway.mjs" --root "$STAGE/package" >&2
OUTPUT="$ROOT/dist/dsh-plugin-mobile-gateway-$DSH_MOBILE_GATEWAY_VERSION.tgz"
COPYFILE_DISABLE=1 tar -czf "$OUTPUT" -C "$STAGE" package
printf '%s\n' "$OUTPUT"
