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
WIDGET_SETUP_DIRECTORY=$(dirname -- "$MANIFEST")
WIDGET_SETUP="$WIDGET_SETUP_DIRECTORY/DSHWidgetSetup"
WIDGET_SETUP_ENTITLEMENTS="$WIDGET_SETUP_DIRECTORY/DSHWidgetSetup.entitlements"
# Validate both privileged helper inputs before any write to the device.
python3 "$HELPER" --manifest "$MANIFEST" verify-widget-setup "$WIDGET_SETUP" "$WIDGET_SETUP_ENTITLEMENTS"
WIDGET_SETUP_REQUIRED=$(python3 -c 'import json,sys; print(1 if "root-live-activity-widget-v1" in json.load(open(sys.argv[1])).get("capabilities", []) else 0)' "$MANIFEST")

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
if [ "$WIDGET_SETUP_REQUIRED" = 1 ]; then
  "${SCP[@]}" "$WIDGET_SETUP" "$REMOTE:$STAGE/artifacts/DSHWidgetSetup"
  "${SCP[@]}" "$WIDGET_SETUP_ENTITLEMENTS" "$REMOTE:$STAGE/artifacts/DSHWidgetSetup.entitlements"
fi
"${SSH[@]}" /var/jb/bin/sh -s <<'NATIVE_INSTALL'
set -e
cd /var/root/dsh-native-client
native_reload_stale_chronod() {
  # Only the pinned helper's explicit stale-build code reaches this function.
  # Do not use comm/name matching, killall, service-wide cache reset or respring.
  python3 - <<'NATIVE_RELOAD_CHRONOD'
import ctypes
import json
import os
import signal
import subprocess
import sys
import time

target = '/System/Library/PrivateFrameworks/ChronoCore.framework/Support/chronod'
try:
    if os.geteuid() != 0:
        raise RuntimeError('root is required to reload the mobile Widget renderer')
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    library.proc_pidpath.restype = ctypes.c_int
    def path_for(pid):
        buffer = ctypes.create_string_buffer(4096)
        return os.fsdecode(buffer.value) if library.proc_pidpath(pid, buffer, len(buffer)) > 0 else None
    def uid_for(pid):
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'uid='], text=True, capture_output=True, timeout=3)
        value = result.stdout.strip()
        return int(value) if value.isdecimal() else None
    candidates = []
    for line in subprocess.check_output(['ps', '-A', '-o', 'pid=,uid='], text=True, timeout=3).splitlines():
        fields = line.split()
        if len(fields) != 2 or not all(value.isdecimal() for value in fields):
            raise RuntimeError('unexpected process identity listing')
        pid, uid = map(int, fields)
        if pid > 1 and uid == 501 and path_for(pid) == target:
            candidates.append(pid)
    if len(candidates) > 1:
        raise RuntimeError('multiple mobile Widget renderers require manual inspection')
    pid = candidates[0] if candidates else None
    if pid is None or uid_for(pid) != 501 or path_for(pid) != target:
        print(json.dumps({'status': 'not-running', 'service': 'chronod'}))
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 3
        while path_for(pid) == target and time.monotonic() < deadline:
            time.sleep(0.1)
        if path_for(pid) == target:
            raise RuntimeError('the stale Widget renderer did not exit after TERM')
        print(json.dumps({'status': 'reloaded', 'service': 'chronod', 'pid': pid}))
except Exception as error:
    print('Native Widget renderer reload failed: ' + str(error), file=sys.stderr)
    sys.exit(1)
NATIVE_RELOAD_CHRONOD
}
native_run_widget_setup() {
  if native_widget_setup_result=$(./artifacts/DSHWidgetSetup); then
    native_widget_setup_status=0
  else
    native_widget_setup_status=$?
  fi
  if [ "$native_widget_setup_status" -eq 2 ]; then
    native_reload_stale_chronod || return 1
    # Exactly one retry. A second stale result never reloads the service again.
    if native_widget_setup_result=$(./artifacts/DSHWidgetSetup); then
      :
    else
      return $?
    fi
  elif [ "$native_widget_setup_status" -ne 0 ]; then
    return "$native_widget_setup_status"
  fi
  printf "%s" "$native_widget_setup_result" | python3 -c 'import json,sys; manifest=json.load(open("ios/native/app-release.json")); result=json.load(sys.stdin); sys.exit(0 if result.get("status")=="ready" and result.get("widgetBundleId")==manifest["widgetBundleId"] and result.get("appBuild")==manifest["build"] and result.get("widgetBuild")==manifest["build"] else 1)'
}
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
if python3 -c 'import json,sys; sys.exit(0 if "root-live-activity-widget-v1" in json.load(open("ios/native/app-release.json")).get("capabilities", []) else 1)'; then
  if python3 ios/native/native_client.py verify-widget-setup artifacts/DSHWidgetSetup artifacts/DSHWidgetSetup.entitlements &&
     ldid -Cadhoc -Iai.deepseek.dsh.widget-setup -Sartifacts/DSHWidgetSetup.entitlements artifacts/DSHWidgetSetup &&
     native_run_widget_setup; then
    printf "%s\n" "$native_widget_setup_result"
  else
    python3 ios/native/native_client.py clear-activity-support
    printf "Native Widget setup failed; activity support was not published.\n" >&2
    exit 1
  fi
fi
python3 ios/native/native_client.py publish-activity-support
NATIVE_INSTALL
printf 'Native app installed. Pair once in its UI; DSH service and app data were not reset.\n'
