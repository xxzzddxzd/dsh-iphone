#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command ssh
require_command scp

DEVICE_HOST=${DEVICE_HOST:-10.99.6.77}
DEVICE_PORT=${DEVICE_PORT:-22}
DEVICE_USER=${DEVICE_USER:-root}
REMOTE="$DEVICE_USER@$DEVICE_HOST"

NODE_DEB="$ROOT/dist/nodejs22_${NODE_VERSION}-${NODE_PACKAGE_REVISION}_iphoneos-arm64.deb"
DSH_DEB="$ROOT/dist/dsh_${DSH_DEBIAN_VERSION}_iphoneos-arm64.deb"

[ -f "$NODE_DEB" ] || die "missing $NODE_DEB; run ./scripts/package-node.sh"
[ -f "$DSH_DEB" ] || die "missing $DSH_DEB; run ./scripts/package-dsh.sh"

REMOTE_NODE_DEB=/var/root/dsh-iphone-node22.deb
REMOTE_DSH_DEB=/var/root/dsh-iphone-dsh.deb
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -p "$DEVICE_PORT")
SCP_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -P "$DEVICE_PORT")

scp "${SCP_OPTIONS[@]}" "$NODE_DEB" "$REMOTE:$REMOTE_NODE_DEB"
scp "${SCP_OPTIONS[@]}" "$DSH_DEB" "$REMOTE:$REMOTE_DSH_DEB"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "dpkg -i '$REMOTE_NODE_DEB' '$REMOTE_DSH_DEB'"
ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
  "launchctl bootout system/ai.deepseek.dsh >/dev/null 2>&1 || true; launchctl bootstrap system /var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist; launchctl kickstart -k system/ai.deepseek.dsh"

service_ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if ssh "${SSH_OPTIONS[@]}" "$REMOTE" \
    "curl -fsS http://127.0.0.1:3080/ >/dev/null"; then
    service_ready=1
    break
  fi
  sleep 1
done

[ "$service_ready" -eq 1 ] || \
  die "DSH did not answer on device port 3080; inspect /var/root/dsh.log"

printf 'DSH is running on %s. Start ./scripts/start-tunnel.sh and open:\n' "$REMOTE"
printf 'http://127.0.0.1:3082/?ioscompat=%s\n' "$IOS_COMPAT_VERSION"
