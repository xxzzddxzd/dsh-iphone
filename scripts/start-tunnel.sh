#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_versions
require_command ssh

DEVICE_HOST=${DEVICE_HOST:-10.99.6.77}
DEVICE_PORT=${DEVICE_PORT:-22}
DEVICE_USER=${DEVICE_USER:-root}
LOCAL_PORT=${LOCAL_PORT:-3082}
REMOTE_PORT=${REMOTE_PORT:-3080}

printf 'Open http://127.0.0.1:%s/?ioscompat=%s\n' "$LOCAL_PORT" "$IOS_COMPAT_VERSION"
exec ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -p "$DEVICE_PORT" \
  -N \
  -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" \
  "$DEVICE_USER@$DEVICE_HOST"
