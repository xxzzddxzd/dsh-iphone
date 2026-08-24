#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
require_command curl
require_command idevice_id
require_command iproxy
require_command launchctl
require_command plutil

LABEL=ai.deepseek.dsh-iphone-usb-proxy
LOCAL_PORT=${LOCAL_PORT:-3081}
REMOTE_PORT=${REMOTE_PORT:-3080}
DEVICE_UDID=${DEVICE_UDID:-}

[[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] && ((LOCAL_PORT >= 1 && LOCAL_PORT <= 65535)) || \
  die "LOCAL_PORT must be between 1 and 65535"
[[ "$REMOTE_PORT" =~ ^[0-9]+$ ]] && ((REMOTE_PORT >= 1 && REMOTE_PORT <= 65535)) || \
  die "REMOTE_PORT must be between 1 and 65535"

if [ -z "$DEVICE_UDID" ]; then
  connected_devices=$(idevice_id -l)
  device_count=$(printf '%s\n' "$connected_devices" | awk 'NF { count += 1 } END { print count + 0 }')
  [ "$device_count" -eq 1 ] || \
    die "expected one USB iPhone, found $device_count; set DEVICE_UDID explicitly"
  DEVICE_UDID=$(printf '%s\n' "$connected_devices" | awk 'NF { print; exit }')
fi
[[ "$DEVICE_UDID" =~ ^[A-Za-z0-9-]+$ ]] || die "invalid DEVICE_UDID"

iproxy_path=$(command -v iproxy)
launch_agents="$HOME/Library/LaunchAgents"
log_path="$HOME/Library/Logs/dsh-iphone-usb-proxy.log"
plist_path="$launch_agents/$LABEL.plist"
template="$ROOT/launchd/$LABEL.plist.in"
domain="gui/$(id -u)"
temp_plist=$(mktemp "${TMPDIR:-/tmp}/dsh-iphone-usb-proxy.XXXXXX")
trap 'rm -f "$temp_plist"' EXIT

mkdir -p "$launch_agents" "$(dirname -- "$log_path")"
sed \
  -e "s|@IPROXY@|$iproxy_path|g" \
  -e "s|@UDID@|$DEVICE_UDID|g" \
  -e "s|@LOCAL_PORT@|$LOCAL_PORT|g" \
  -e "s|@REMOTE_PORT@|$REMOTE_PORT|g" \
  -e "s|@LOG_PATH@|$log_path|g" \
  "$template" > "$temp_plist"
plutil -lint "$temp_plist" >/dev/null

launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
install -m 0644 "$temp_plist" "$plist_path"
launchctl bootstrap "$domain" "$plist_path"
launchctl kickstart -k "$domain/$LABEL"

for attempt in 1 2 3 4 5; do
  if curl -fs --max-time 2 "http://127.0.0.1:$LOCAL_PORT/" >/dev/null; then
    printf 'DSH USB proxy is ready: http://127.0.0.1:%s/?ioscompat=9\n' "$LOCAL_PORT"
    exit 0
  fi
  sleep 1
done

printf 'USB proxy installed, but DSH did not answer yet; check %s\n' "$log_path" >&2
exit 1
