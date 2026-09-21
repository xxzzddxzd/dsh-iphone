#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_command ssh

DEVICE_HOST=${DEVICE_HOST:-10.99.1.41}
DEVICE_PORT=${DEVICE_PORT:-22}
DEVICE_USER=${DEVICE_USER:-root}
REMOTE="$DEVICE_USER@$DEVICE_HOST"

ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$DEVICE_PORT" "$REMOTE" \
  python3 - < "$SCRIPT_DIR/open-device.py"
