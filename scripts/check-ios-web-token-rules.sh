#!/usr/bin/env bash
# Test fixed client bundles with the phone's actual JavaScriptCore parser.
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
WEB_TOKEN_RUNTIME="$ROOT/build/dsh-runtime"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime)
      [ "$#" -ge 2 ] && [ -n "$2" ] || die "--runtime requires a directory"
      WEB_TOKEN_RUNTIME=$2
      shift 2
      ;;
    -h|--help)
      printf 'Usage: check-ios-web-token-rules.sh [--runtime directory]\nDevice: DEVICE_HOST, DEVICE_PORT, DEVICE_USER=root\n'
      exit 0
      ;;
    *) die "unknown token-rule probe argument" ;;
  esac
done
for WEB_TOKEN_COMMAND in python3 xcrun ssh scp; do require_command "$WEB_TOKEN_COMMAND"; done
WEB_TOKEN_HOST=${DEVICE_HOST:-10.99.1.139}
WEB_TOKEN_PORT=${DEVICE_PORT:-22}
WEB_TOKEN_USER=${DEVICE_USER:-root}
[ "$WEB_TOKEN_USER" = root ] || die "the private device probe requires DEVICE_USER=root"
[[ "$WEB_TOKEN_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "invalid device host"
[[ "$WEB_TOKEN_PORT" =~ ^[0-9]+$ ]] && [ "$WEB_TOKEN_PORT" -ge 1 ] && [ "$WEB_TOKEN_PORT" -le 65535 ] || die "invalid SSH port"
[ -d "$WEB_TOKEN_RUNTIME" ] || die "runtime directory is unavailable"
WEB_TOKEN_RUNTIME=$(CDPATH= cd -- "$WEB_TOKEN_RUNTIME" && pwd -P)
# Complete every source/parameter check before compiling or writing to a device.
python3 - "$WEB_TOKEN_RUNTIME" "$WEB_TOKEN_HOST" <<'PY'
from pathlib import Path
import ipaddress, sys
root = Path(sys.argv[1])
host = sys.argv[2]
if len(host) > 253:
    raise SystemExit('Invalid device host')
if ':' in host:
    try:
        ipaddress.IPv6Address(host)
    except ValueError:
        raise SystemExit('Invalid device IPv6 address; use DEVICE_PORT separately')
for name in ('skill', 'reference', 'goal'):
    source = root / 'node_modules/@deepseek-ai' / ('dsh-client-ui-' + name) / 'lib/client.js'
    if not source.is_file() or not 0 < source.stat().st_size <= 2 * 1024 * 1024:
        raise SystemExit('A fixed token-rule source is missing or exceeds the probe limit')
    try:
        source.read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        raise SystemExit('A fixed token-rule source cannot be read as UTF-8')
PY

WEB_TOKEN_LOCAL_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/dsh-web-token-probe.XXXXXX")
WEB_TOKEN_RUN=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
WEB_TOKEN_REMOTE_STAGE="/var/root/dsh-web-token-probes/$WEB_TOKEN_RUN"
WEB_TOKEN_REMOTE="$WEB_TOKEN_USER@$WEB_TOKEN_HOST"
WEB_TOKEN_SCP_REMOTE="$WEB_TOKEN_REMOTE"
if [[ "$WEB_TOKEN_HOST" == *:* ]]; then WEB_TOKEN_SCP_REMOTE="$WEB_TOKEN_USER@[$WEB_TOKEN_HOST]"; fi
WEB_TOKEN_SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 -p "$WEB_TOKEN_PORT" "$WEB_TOKEN_REMOTE")
WEB_TOKEN_SCP=(scp -o BatchMode=yes -o ConnectTimeout=8 -P "$WEB_TOKEN_PORT")
cleanup_web_token_probe() {
  # The only removed remote path is a generated 32-hex child of this private prefix.
  "${WEB_TOKEN_SSH[@]}" "/var/jb/bin/sh -c 'rm -rf -- $WEB_TOKEN_REMOTE_STAGE'" >/dev/null 2>&1 || true
  rm -rf -- "$WEB_TOKEN_LOCAL_STAGE"
}
trap cleanup_web_token_probe EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$WEB_TOKEN_RUNTIME" "$WEB_TOKEN_LOCAL_STAGE" <<'PY'
from pathlib import Path
import shutil, sys
root, stage = map(Path, sys.argv[1:])
for name in ('skill', 'reference', 'goal'):
    shutil.copyfile(root / 'node_modules/@deepseek-ai' / ('dsh-client-ui-' + name) / 'lib/client.js', stage / (name + '.js'))
PY
WEB_TOKEN_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
WEB_TOKEN_CC=$(xcrun --sdk iphoneos -f clang)
"$WEB_TOKEN_CC" -arch arm64 -isysroot "$WEB_TOKEN_SDK" -miphoneos-version-min=16.1 \
  -fobjc-arc -framework Foundation -framework JavaScriptCore \
  "$ROOT/ios/research/WebTokenRulesProbe.m" -o "$WEB_TOKEN_LOCAL_STAGE/WebTokenRulesProbe"
"${WEB_TOKEN_SSH[@]}" /var/jb/bin/sh -s <<REMOTE_PREPARE
set -eu
test -x /var/jb/usr/bin/ldid
test ! -L /var/root/dsh-web-token-probes
umask 077
mkdir -p /var/root/dsh-web-token-probes
chmod 0700 /var/root/dsh-web-token-probes
test ! -e '$WEB_TOKEN_REMOTE_STAGE'
mkdir '$WEB_TOKEN_REMOTE_STAGE'
REMOTE_PREPARE
"${WEB_TOKEN_SCP[@]}" "$WEB_TOKEN_LOCAL_STAGE/WebTokenRulesProbe" "$ROOT/ios/research/WebTokenRulesProbe.entitlements" \
  "$WEB_TOKEN_LOCAL_STAGE/skill.js" "$WEB_TOKEN_LOCAL_STAGE/reference.js" "$WEB_TOKEN_LOCAL_STAGE/goal.js" \
  "$WEB_TOKEN_SCP_REMOTE:$WEB_TOKEN_REMOTE_STAGE/"
"${WEB_TOKEN_SSH[@]}" /var/jb/bin/sh -s <<REMOTE_RUN
set -eu
chmod 0700 '$WEB_TOKEN_REMOTE_STAGE'
chmod 0600 '$WEB_TOKEN_REMOTE_STAGE/skill.js' '$WEB_TOKEN_REMOTE_STAGE/reference.js' '$WEB_TOKEN_REMOTE_STAGE/goal.js'
chmod 0700 '$WEB_TOKEN_REMOTE_STAGE/WebTokenRulesProbe'
/var/jb/usr/bin/ldid -Iai.deepseek.dsh.web-token-probe -S'$WEB_TOKEN_REMOTE_STAGE/WebTokenRulesProbe.entitlements' '$WEB_TOKEN_REMOTE_STAGE/WebTokenRulesProbe'
'$WEB_TOKEN_REMOTE_STAGE/WebTokenRulesProbe' '$WEB_TOKEN_REMOTE_STAGE'
REMOTE_RUN
