#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
for native_required_command in python3 ssh scp curl; do require_command "$native_required_command"; done

MANIFEST=${NATIVE_APP_MANIFEST:-"$ROOT/ios/native/app-release.json"}
HELPER="$ROOT/ios/native/native_client.py"
DEVICE_HOST=${DEVICE_HOST:-10.99.1.139}
DEVICE_PORT=${DEVICE_PORT:-22}
DEVICE_USER=${DEVICE_USER:-root}
[[ "$DEVICE_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || die "invalid device host"
[[ "$DEVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid device user"
[[ "$DEVICE_PORT" =~ ^[0-9]+$ ]] && [ "$DEVICE_PORT" -ge 1 ] && [ "$DEVICE_PORT" -le 65535 ] || die "invalid SSH port"
[ "$DEVICE_USER" = root ] || die "TrollStoreLite installation requires the configured device root account"

CACHE="$ROOT/.cache/native-client/1.7.11"
mkdir -p "$CACHE"
IPA=${NATIVE_APP_IPA:-"$CACHE/Whaleness-1.7.11-unsigned.ipa"}
if [ ! -f "$IPA" ]; then
  [ -z "${NATIVE_APP_IPA:-}" ] || die "NATIVE_APP_IPA does not exist"
  release_url=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$MANIFEST")
  curl --fail --location --retry 2 --output "$IPA.download" "$release_url"
  mv "$IPA.download" "$IPA"
fi
python3 "$HELPER" --manifest "$MANIFEST" verify-ipa "$IPA"

REMOTE="$DEVICE_USER@$DEVICE_HOST"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$DEVICE_PORT" "$REMOTE")
SCP=(scp -o BatchMode=yes -o ConnectTimeout=10 -P "$DEVICE_PORT")
STAGE=/var/root/dsh-native-client
"${SSH[@]}" /var/jb/bin/sh -s <<'NATIVE_PREPARE'
umask 077
mkdir -p /var/root/dsh-native-client/scripts /var/root/dsh-native-client/ios/native /var/root/dsh-native-client/artifacts
NATIVE_PREPARE
"${SCP[@]}" "$MANIFEST" "$REMOTE:$STAGE/ios/native/app-release.json"
"${SCP[@]}" "$HELPER" "$REMOTE:$STAGE/ios/native/"
"${SCP[@]}" "$SCRIPT_DIR/open-native-app.py" "$REMOTE:$STAGE/scripts/"
"${SCP[@]}" "$IPA" "$REMOTE:$STAGE/artifacts/app.ipa"
"${SSH[@]}" /var/jb/bin/sh -s <<'NATIVE_INSTALL'
set -e
cd /var/root/dsh-native-client
python3 ios/native/native_client.py verify-ipa artifacts/app.ipa
native_installed_state=$(python3 ios/native/native_client.py installed)
printf "%s\n" "$native_installed_state"
if printf "%s" "$native_installed_state" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["status"] == "current" else 1)'; then
  printf "Pinned native app is already installed; existing data retained.\n"
else
  test -x /var/jb/Applications/TrollStoreLite.app/trollstorehelper
  /var/jb/Applications/TrollStoreLite.app/trollstorehelper install /var/root/dsh-native-client/artifacts/app.ipa
  python3 ios/native/native_client.py installed
fi
NATIVE_INSTALL
printf 'Native app installed. Pair once in its UI; DSH service and app data were not reset.\n'
