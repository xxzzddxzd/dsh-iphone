#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../scripts/lib.sh
. "$SCRIPT_DIR/../scripts/lib.sh"

ROOT=$(repo_root)
load_versions
require_command file
require_command node
require_command plutil
require_command rg
require_command vtool

node "$ROOT/scripts/validate-vless-config.mjs" \
  --allow-placeholders \
  --port "$XRAY_PROXY_PORT" \
  "$ROOT/config/xray/vless-ws-tls.json.example" >/dev/null
node -e "const fs = require('node:fs'); const config = JSON.parse(fs.readFileSync('$ROOT/config/xray/fail-closed.json')); if (config.inbounds[0].listen !== '127.0.0.1' || config.inbounds[0].port !== $XRAY_PROXY_PORT || config.outbounds.some(outbound => outbound.protocol === 'freedom')) process.exit(1)"
plutil -lint \
  "$ROOT/launchd/ai.deepseek.dsh-vless.plist" \
  "$ROOT/packaging/xray/entitlements.xml" >/dev/null

BINARY=${XRAY_BINARY_PATH:-"$ROOT/build/xray-ios-$XRAY_VERSION/xray"}
if [ -f "$BINARY" ]; then
  file "$BINARY" | rg 'Mach-O 64-bit executable arm64' >/dev/null
  vtool -show-build "$BINARY" | rg 'platform IOS' >/dev/null
  vtool -show-build "$BINARY" | rg "minos $XRAY_IOS_MIN_VERSION" >/dev/null
fi

printf 'Xray package tests passed\n'
