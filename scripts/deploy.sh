#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command ssh
require_command scp

"$SCRIPT_DIR/package-dsh-codex.sh" >/dev/null
"$SCRIPT_DIR/package-dsh-cline-pass.sh" >/dev/null

DEVICE_HOST=${DEVICE_HOST:-10.99.1.41}
DEVICE_PORT=${DEVICE_PORT:-22}
DEVICE_USER=${DEVICE_USER:-root}
REMOTE="$DEVICE_USER@$DEVICE_HOST"

NODE_DEB="$ROOT/dist/nodejs22_${NODE_VERSION}-${NODE_PACKAGE_REVISION}_iphoneos-arm64.deb"
PNPM_DEB="$ROOT/dist/pnpm10_${PNPM_VERSION}-${PNPM_PACKAGE_REVISION}_iphoneos-arm64.deb"
DSH_DEB="$ROOT/dist/dsh_${DSH_DEBIAN_VERSION}_iphoneos-arm64.deb"
DSH_CODEX_TGZ="$ROOT/dist/dsh-codex-$DSH_CODEX_VERSION.tgz"
DSH_CLINE_PASS_TGZ="$ROOT/dist/dsh-cline-pass-$DSH_CLINE_PASS_VERSION.tgz"

[ -f "$NODE_DEB" ] || die "missing $NODE_DEB; run ./scripts/package-node.sh"
[ -f "$PNPM_DEB" ] || die "missing $PNPM_DEB; run ./scripts/package-pnpm.sh"
[ -f "$DSH_DEB" ] || die "missing $DSH_DEB; run ./scripts/package-dsh.sh"
[ -f "$DSH_CODEX_TGZ" ] || die "missing $DSH_CODEX_TGZ"
[ -f "$DSH_CLINE_PASS_TGZ" ] || die "missing $DSH_CLINE_PASS_TGZ"

REMOTE_NODE_DEB=/var/root/dsh-iphone-node22.deb
REMOTE_PNPM_DEB=/var/root/dsh-iphone-pnpm10.deb
REMOTE_DSH_DEB=/var/root/dsh-iphone-dsh.deb
REMOTE_DSH_CODEX_TGZ=/var/root/dsh-codex-shared.tgz
REMOTE_DSH_CLINE_PASS_TGZ=/var/root/dsh-cline-pass-shared.tgz
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -p "$DEVICE_PORT")
SCP_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -P "$DEVICE_PORT")

scp "${SCP_OPTIONS[@]}" "$NODE_DEB" "$REMOTE:$REMOTE_NODE_DEB"
scp "${SCP_OPTIONS[@]}" "$PNPM_DEB" "$REMOTE:$REMOTE_PNPM_DEB"
scp "${SCP_OPTIONS[@]}" "$DSH_DEB" "$REMOTE:$REMOTE_DSH_DEB"
scp "${SCP_OPTIONS[@]}" "$DSH_CODEX_TGZ" "$REMOTE:$REMOTE_DSH_CODEX_TGZ"
scp "${SCP_OPTIONS[@]}" "$DSH_CLINE_PASS_TGZ" "$REMOTE:$REMOTE_DSH_CLINE_PASS_TGZ"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "dpkg -i '$REMOTE_NODE_DEB' '$REMOTE_PNPM_DEB' '$REMOTE_DSH_DEB'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "test \"\$(/var/jb/usr/local/bin/pnpm --version)\" = '$PNPM_VERSION'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root '$REMOTE_DSH_CODEX_TGZ'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-codex"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web add --workspace-root '$REMOTE_DSH_CLINE_PASS_TGZ'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "/var/jb/usr/local/bin/dsh22 plugin --profile web why dsh-cline-pass"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  'launchctl bootout user/foreground/ai.deepseek.dsh >/dev/null 2>&1 || true; for attempt in 1 2 3 4 5 6 7 8 9 10; do launchctl print user/foreground/ai.deepseek.dsh >/dev/null 2>&1 || break; sleep 1; done; ! launchctl print user/foreground/ai.deepseek.dsh >/dev/null 2>&1; launchctl bootstrap system /var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist; launchctl kickstart -k user/foreground/ai.deepseek.dsh'

service_ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  # DSH 0.1.5 returns 401 until the browser completes its authenticated handshake.
  if ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
    "/var/jb/usr/local/lib/nodejs22/node -e \"const http = require('node:http'); const request = http.get('http://127.0.0.1:3080/', response => { response.resume(); response.on('end', () => process.exit(response.statusCode >= 200 && response.statusCode < 500 ? 0 : 1)); }); request.on('error', () => process.exit(1)); request.setTimeout(2000, () => { request.destroy(); process.exit(1); });\""; then
    service_ready=1
    break
  fi
  sleep 1
done

[ "$service_ready" -eq 1 ] || \
  die "DSH did not answer on device port 3080; inspect /var/root/dsh.log"

bash "$SCRIPT_DIR/migrate-device-history.sh" --apply
"$SCRIPT_DIR/open-device.sh"

printf 'DSH is running on %s. Start ./scripts/start-tunnel.sh and open:\n' "$REMOTE"
printf 'node ./scripts/open-browser.mjs iphone\n'
