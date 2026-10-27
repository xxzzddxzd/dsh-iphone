#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command ssh
require_command scp
require_command node
require_command tar

# App releases are independent from Host upgrades. A Host deployment must not
# replace a reviewed local build with the stock release in the default manifest.
INSTALL_NATIVE_APP=0
if [ -n "${NATIVE_APP_IPA:-}" ] && [ -n "${NATIVE_APP_MANIFEST:-}" ]; then
  [ -f "$NATIVE_APP_IPA" ] || die "NATIVE_APP_IPA does not exist"
  [ -f "$NATIVE_APP_MANIFEST" ] || die "NATIVE_APP_MANIFEST does not exist"
  require_command python3
  python3 "$ROOT/ios/native/native_client.py" --manifest "$NATIVE_APP_MANIFEST" verify-ipa "$NATIVE_APP_IPA"
  INSTALL_NATIVE_APP=1
elif [ -n "${NATIVE_APP_IPA:-}" ] || [ -n "${NATIVE_APP_MANIFEST:-}" ]; then
  die "set both NATIVE_APP_IPA and NATIVE_APP_MANIFEST to update the native App"
fi

"$SCRIPT_DIR/package-dsh-codex.sh" >/dev/null
"$SCRIPT_DIR/package-dsh-cline-pass.sh" >/dev/null
"$SCRIPT_DIR/package-mobile-gateway.sh" >/dev/null

DEVICE_HOST=${DEVICE_HOST:-10.99.1.41}
DEVICE_PORT=${DEVICE_PORT:-22}
DEVICE_USER=${DEVICE_USER:-root}
REMOTE="$DEVICE_USER@$DEVICE_HOST"

NODE_DEB="$ROOT/dist/nodejs22_${NODE_VERSION}-${NODE_PACKAGE_REVISION}_iphoneos-arm64.deb"
PNPM_DEB="$ROOT/dist/pnpm10_${PNPM_VERSION}-${PNPM_PACKAGE_REVISION}_iphoneos-arm64.deb"
DSH_DEB="$ROOT/dist/dsh_${DSH_DEBIAN_VERSION}_iphoneos-arm64.deb"
DSH_CODEX_TGZ="$ROOT/dist/dsh-codex-$DSH_CODEX_VERSION.tgz"
DSH_CLINE_PASS_TGZ="$ROOT/dist/dsh-cline-pass-$DSH_CLINE_PASS_VERSION.tgz"
DSH_MOBILE_GATEWAY_TGZ="$ROOT/dist/dsh-plugin-mobile-gateway-$DSH_MOBILE_GATEWAY_VERSION.tgz"

[ -f "$NODE_DEB" ] || die "missing $NODE_DEB; run ./scripts/package-node.sh"
[ -f "$PNPM_DEB" ] || die "missing $PNPM_DEB; run ./scripts/package-pnpm.sh"
[ -f "$DSH_DEB" ] || die "missing $DSH_DEB; run ./scripts/package-dsh.sh"
[ -f "$DSH_CODEX_TGZ" ] || die "missing $DSH_CODEX_TGZ"
[ -f "$DSH_CLINE_PASS_TGZ" ] || die "missing $DSH_CLINE_PASS_TGZ"
[ -f "$DSH_MOBILE_GATEWAY_TGZ" ] || die "missing $DSH_MOBILE_GATEWAY_TGZ"
[ -f "$SCRIPT_DIR/migrate-profile-0.2.1.mjs" ] || die "missing profile migration script"
[ -f "$SCRIPT_DIR/install-native-profile.mjs" ] || die "missing Native profile installer"
[ -f "$ROOT/packaging/mobile-gateway/cordis.patch.yml" ] || die "missing loopback Native profile template"
tar -xOf "$DSH_MOBILE_GATEWAY_TGZ" package/package.json | node -e '
const fs = require("node:fs");
const assert = require("node:assert/strict");
const metadata = JSON.parse(fs.readFileSync(0, "utf8"));
assert.equal(metadata.name, "dsh-plugin-mobile-gateway", "wrong Mobile Gateway artifact");
assert.equal(metadata.version, process.argv[1], "Mobile Gateway version differs from versions.env");
assert.equal(metadata.dsh?.bundle?.patch, "./cordis.patch.yml", "Mobile Gateway bundle metadata is missing");
' "$DSH_MOBILE_GATEWAY_VERSION"

REMOTE_NODE_DEB=/var/root/dsh-iphone-node22.deb
REMOTE_PNPM_DEB=/var/root/dsh-iphone-pnpm10.deb
REMOTE_DSH_DEB=/var/root/dsh-iphone-dsh.deb
REMOTE_DSH_CODEX_TGZ=/var/root/dsh-codex-shared.tgz
REMOTE_DSH_CLINE_PASS_TGZ=/var/root/dsh-cline-pass-shared.tgz
REMOTE_DSH_MOBILE_GATEWAY_TGZ=/var/root/dsh-mobile-gateway-shared.tgz
REMOTE_NATIVE_ROOT=/var/root/dsh-native-host
REMOTE_NODE="/var/jb/usr/local/lib/nodejs22/node --no-jitless --disable-wasm-trap-handler"
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -p "$DEVICE_PORT")
SCP_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -P "$DEVICE_PORT")

scp "${SCP_OPTIONS[@]}" "$NODE_DEB" "$REMOTE:$REMOTE_NODE_DEB"
scp "${SCP_OPTIONS[@]}" "$PNPM_DEB" "$REMOTE:$REMOTE_PNPM_DEB"
scp "${SCP_OPTIONS[@]}" "$DSH_DEB" "$REMOTE:$REMOTE_DSH_DEB"
scp "${SCP_OPTIONS[@]}" "$DSH_CODEX_TGZ" "$REMOTE:$REMOTE_DSH_CODEX_TGZ"
scp "${SCP_OPTIONS[@]}" "$DSH_CLINE_PASS_TGZ" "$REMOTE:$REMOTE_DSH_CLINE_PASS_TGZ"
scp "${SCP_OPTIONS[@]}" "$DSH_MOBILE_GATEWAY_TGZ" "$REMOTE:$REMOTE_DSH_MOBILE_GATEWAY_TGZ"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "umask 077; mkdir -p '$REMOTE_NATIVE_ROOT/scripts' '$REMOTE_NATIVE_ROOT/packaging/mobile-gateway'"
scp "${SCP_OPTIONS[@]}" "$SCRIPT_DIR/migrate-profile-0.2.1.mjs" "$REMOTE:$REMOTE_NATIVE_ROOT/scripts/"
scp "${SCP_OPTIONS[@]}" "$SCRIPT_DIR/install-native-profile.mjs" "$REMOTE:$REMOTE_NATIVE_ROOT/scripts/"
scp "${SCP_OPTIONS[@]}" "$ROOT/packaging/mobile-gateway/cordis.patch.yml" "$REMOTE:$REMOTE_NATIVE_ROOT/packaging/mobile-gateway/"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "DSH_DEPLOY_DEFER_START=1 dpkg -i '$REMOTE_NODE_DEB' '$REMOTE_PNPM_DEB' '$REMOTE_DSH_DEB'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "$REMOTE_NODE '$REMOTE_NATIVE_ROOT/scripts/migrate-profile-0.2.1.mjs' '/var/root/.dsh/profiles/web' --apply"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "test \"\$(/var/jb/usr/local/bin/pnpm --version)\" = '$PNPM_VERSION'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root --offline '$REMOTE_DSH_CODEX_TGZ'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-codex"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root --offline '$REMOTE_DSH_CLINE_PASS_TGZ'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-cline-pass"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root --offline '$REMOTE_DSH_MOBILE_GATEWAY_TGZ'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-plugin-mobile-gateway"
# Merge only Host configuration. The template disables LAN and points to the
# existing private device/state files; neither identity nor App pairing is uploaded.
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "$REMOTE_NODE '$REMOTE_NATIVE_ROOT/scripts/install-native-profile.mjs' '/var/root/.dsh/profiles/web' --runtime '/var/jb/usr/local/lib/dsh' --apply"
DEVICE_HOST="$DEVICE_HOST" DEVICE_PORT="$DEVICE_PORT" DEVICE_USER="$DEVICE_USER" \
  bash "$SCRIPT_DIR/migrate-device-history.sh" --apply
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  'launchctl bootstrap system /var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist'

service_ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  # DSH returns 401 until the browser completes its authenticated handshake.
  if ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
    "/var/jb/usr/local/lib/nodejs22/node -e \"const http = require('node:http'); const request = http.get('http://127.0.0.1:3080/', response => { response.resume(); response.on('end', () => process.exit(response.statusCode >= 200 && response.statusCode < 500 ? 0 : 1)); }); request.on('error', () => process.exit(1)); request.setTimeout(2000, () => { request.destroy(); process.exit(1); });\""; then
    service_ready=1
    break
  fi
  sleep 1
done

[ "$service_ready" -eq 1 ] || \
  die "DSH did not answer on device port 3080; inspect /var/root/dsh.log"

if [ "$INSTALL_NATIVE_APP" -eq 1 ]; then
  DEVICE_HOST="$DEVICE_HOST" DEVICE_PORT="$DEVICE_PORT" DEVICE_USER="$DEVICE_USER" \
    NATIVE_APP_IPA="$NATIVE_APP_IPA" NATIVE_APP_MANIFEST="$NATIVE_APP_MANIFEST" \
    "$SCRIPT_DIR/install-native-app.sh"
else
  printf 'Existing native App retained; select both NATIVE_APP_IPA and NATIVE_APP_MANIFEST to update it.\n'
fi

DEVICE_HOST="$DEVICE_HOST" DEVICE_PORT="$DEVICE_PORT" DEVICE_USER="$DEVICE_USER" \
  "$SCRIPT_DIR/open-device.sh"

printf 'DSH is running on %s. Start ./scripts/start-tunnel.sh and open:\n' "$REMOTE"
printf 'node ./scripts/open-browser.mjs iphone\n'
