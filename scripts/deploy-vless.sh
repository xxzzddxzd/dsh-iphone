#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command node
require_command scp
require_command ssh

CONFIG=${VLESS_CONFIG_PATH:-}
[ -n "$CONFIG" ] || die "set VLESS_CONFIG_PATH to a complete Xray JSON configuration"
[ -f "$CONFIG" ] || die "VLESS configuration not found: $CONFIG"
node "$ROOT/scripts/validate-vless-config.mjs" --port "$XRAY_PROXY_PORT" "$CONFIG"

PACKAGE_VERSION="$XRAY_VERSION-$XRAY_PACKAGE_REVISION"
XRAY_DEB="$ROOT/dist/dsh-vless_${PACKAGE_VERSION}_iphoneos-arm64.deb"
[ -f "$XRAY_DEB" ] || die "missing $XRAY_DEB; run ./scripts/package-xray.sh"

DEVICE_HOST=${DEVICE_HOST:-10.99.6.77}
DEVICE_PORT=${DEVICE_PORT:-22}
DEVICE_USER=${DEVICE_USER:-root}
REMOTE="$DEVICE_USER@$DEVICE_HOST"
REMOTE_DEB=/var/root/dsh-vless.deb
REMOTE_CANDIDATE=/var/root/.dsh-vless-config.candidate.json
REMOTE_CONFIG=/var/root/.config/dsh-vless/config.json
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -p "$DEVICE_PORT")
SCP_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -P "$DEVICE_PORT")

scp "${SCP_OPTIONS[@]}" "$XRAY_DEB" "$REMOTE:$REMOTE_DEB"
scp "${SCP_OPTIONS[@]}" "$CONFIG" "$REMOTE:$REMOTE_CANDIDATE"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "chmod 0600 '$REMOTE_CANDIDATE'; dpkg -i '$REMOTE_DEB'; /var/jb/usr/local/lib/dsh-vless/xray run -test -config '$REMOTE_CANDIDATE'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "install -d -m 0700 '/var/root/.config/dsh-vless'; if [ -f '$REMOTE_CONFIG' ]; then cp -p '$REMOTE_CONFIG' '$REMOTE_CONFIG.previous'; chmod 0600 '$REMOTE_CONFIG.previous'; fi; install -m 0600 '$REMOTE_CANDIDATE' '$REMOTE_CONFIG.next'; mv '$REMOTE_CONFIG.next' '$REMOTE_CONFIG'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  'launchctl bootout user/foreground/ai.deepseek.dsh-vless >/dev/null 2>&1 || true; for attempt in 1 2 3 4 5 6 7 8 9 10; do launchctl print user/foreground/ai.deepseek.dsh-vless >/dev/null 2>&1 || break; sleep 1; done; ! launchctl print user/foreground/ai.deepseek.dsh-vless >/dev/null 2>&1; launchctl bootstrap system /var/jb/Library/LaunchDaemons/ai.deepseek.dsh-vless.plist; launchctl kickstart -k user/foreground/ai.deepseek.dsh-vless'

service_ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
    "launchctl print user/foreground/ai.deepseek.dsh-vless >/dev/null 2>&1 && /var/jb/usr/local/lib/nodejs22/node -e \"const net = require('node:net'); const socket = net.connect($XRAY_PROXY_PORT, '127.0.0.1', () => { socket.end(); process.exit(0); }); socket.setTimeout(2000, () => { socket.destroy(); process.exit(1); }); socket.on('error', () => process.exit(1));\""; then
    service_ready=1
    break
  fi
  sleep 1
done

[ "$service_ready" -eq 1 ] || \
  die "DSH VLESS proxy did not listen on 127.0.0.1:$XRAY_PROXY_PORT; inspect /var/root/dsh-vless-error.log"

printf 'DSH VLESS proxy is running on %s at 127.0.0.1:%s\n' "$REMOTE" "$XRAY_PROXY_PORT"
printf 'Access log: /var/root/dsh-vless-access.log\n'
