#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REMOTE="${DEVICE_USER:-root}@${DEVICE_HOST:-10.99.1.41}"
PORT=${DEVICE_PORT:-22}
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT" "$REMOTE" \
  'mkdir -p /var/root/.dsh-history-recovery; chmod 700 /var/root/.dsh-history-recovery'
scp -q -o BatchMode=yes -o ConnectTimeout=10 -P "$PORT" \
  "$SCRIPT_DIR/migrate-provider-history.mjs" "$SCRIPT_DIR/migrate-provider-history.py" \
  "$REMOTE:/var/root/.dsh-history-recovery/"
MODE=
if [ "${1:-}" = --apply ]; then MODE=--apply; elif [ "$#" -ne 0 ]; then
  printf 'Usage: %s [--apply]\n' "$0" >&2
  exit 2
fi
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT" "$REMOTE" \
  "NODE_OPTIONS='--no-jitless --disable-wasm-trap-handler' python3 /var/root/.dsh-history-recovery/migrate-provider-history.py /var/jb/usr/local/lib/dsh /var/root/.dsh/sessions --node /var/jb/usr/local/lib/nodejs22/node $MODE"
