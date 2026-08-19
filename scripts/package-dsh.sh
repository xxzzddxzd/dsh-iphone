#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions

RUNTIME_ROOT="$ROOT/build/dsh-runtime"
STAGE="$ROOT/build/dsh-deb-root"
OUTPUT="$ROOT/dist/dsh_${DSH_DEBIAN_VERSION}_iphoneos-arm64.deb"

"$SCRIPT_DIR/prepare-dsh.sh" >/dev/null
DSH_RUNTIME_ROOT="$RUNTIME_ROOT" "$SCRIPT_DIR/build-node-pty.sh"
"$SCRIPT_DIR/build-ios-notifier.sh" >/dev/null
node "$SCRIPT_DIR/patch-dsh.mjs" --root "$RUNTIME_ROOT" --check

reset_build_dir "$STAGE"
mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/var/jb/Applications" \
  "$STAGE/var/jb/Library/MobileSubstrate/DynamicLibraries" \
  "$STAGE/var/jb/Library/LaunchDaemons" \
  "$STAGE/var/jb/usr/local/bin" \
  "$STAGE/var/jb/usr/local/lib/dsh" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios"

cp -R "$RUNTIME_ROOT/." "$STAGE/var/jb/usr/local/lib/dsh/"
install -m 0755 "$ROOT/packaging/dsh/dsh22" "$STAGE/var/jb/usr/local/bin/dsh22"
install -m 0755 "$ROOT/ios/notifications/dsh-notify.mjs" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios/dsh-notify.mjs"
ln -s ../lib/dsh/ios/dsh-notify.mjs "$STAGE/var/jb/usr/local/bin/dsh-notify"
install -m 0755 "$ROOT/ios/activity/dsh-activity.mjs" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios/dsh-activity.mjs"
ln -s ../lib/dsh/ios/dsh-activity.mjs "$STAGE/var/jb/usr/local/bin/dsh-activity"
install -m 0644 "$ROOT/ios/activity/DSHActivity.entitlements" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios/DSHActivity.entitlements"
install -m 0644 "$ROOT/ios/activity/DSHActivityExtension.entitlements" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios/DSHActivityExtension.entitlements"
install -m 0755 "$ROOT/build/ios-notifier/DSHActivityOp" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios/DSHActivityOp"
install -m 0755 "$ROOT/build/ios-notifier/DSHActivityD" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios/DSHActivityD"
install -m 0644 "$ROOT/ios/activity/DSHActivityWorker.entitlements" \
  "$STAGE/var/jb/usr/local/lib/dsh/ios/DSHActivityWorker.entitlements"
install -m 0755 "$ROOT/build/ios-notifier/DSHNotifierBridge.dylib" \
  "$STAGE/var/jb/Library/MobileSubstrate/DynamicLibraries/DSHNotifierBridge.dylib"
install -m 0644 "$ROOT/ios/notifications/DSHNotifierBridge.plist" \
  "$STAGE/var/jb/Library/MobileSubstrate/DynamicLibraries/DSHNotifierBridge.plist"
cp -R "$ROOT/build/ios-notifier/DSH.app" "$STAGE/var/jb/Applications/DSH.app"
install -m 0644 "$ROOT/launchd/ai.deepseek.dsh.plist" \
  "$STAGE/var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist"
install -m 0644 "$ROOT/launchd/ai.deepseek.dsh-activity.plist" \
  "$STAGE/var/jb/Library/LaunchDaemons/ai.deepseek.dsh-activity.plist"
install -m 0755 "$ROOT/packaging/dsh/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$ROOT/packaging/dsh/prerm" "$STAGE/DEBIAN/prerm"

installed_size=$(du -sk "$STAGE" | awk '{print $1}')
sed \
  -e "s/@PACKAGE_VERSION@/$DSH_DEBIAN_VERSION/g" \
  -e "s/@NODE_VERSION@/$NODE_VERSION/g" \
  -e "s/@PNPM_VERSION@/$PNPM_VERSION/g" \
  -e "s/@INSTALLED_SIZE@/$installed_size/g" \
  "$ROOT/packaging/dsh/control.in" > "$STAGE/DEBIAN/control"

build_deb "$STAGE" "$OUTPUT"
printf '%s\n' "$OUTPUT"
