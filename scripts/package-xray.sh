#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions

"$SCRIPT_DIR/fetch-xray.sh" >/dev/null

BINARY=${XRAY_BINARY_PATH:-"$ROOT/build/xray-ios-$XRAY_VERSION/xray"}
STAGE="$ROOT/build/xray-deb-root"
PACKAGE_VERSION="$XRAY_VERSION-$XRAY_PACKAGE_REVISION"
OUTPUT="$ROOT/dist/dsh-vless_${PACKAGE_VERSION}_iphoneos-arm64.deb"

[ -f "$BINARY" ] || die "missing Xray binary; run ./scripts/build-xray.sh first"
reset_build_dir "$STAGE"
mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/var/jb/Library/LaunchDaemons" \
  "$STAGE/var/jb/usr/local/bin" \
  "$STAGE/var/jb/usr/local/lib/dsh-vless" \
  "$STAGE/var/jb/usr/local/share/dsh-vless"

install -m 0755 "$BINARY" "$STAGE/var/jb/usr/local/lib/dsh-vless/xray"
install -m 0644 "$ROOT/packaging/xray/entitlements.xml" \
  "$STAGE/var/jb/usr/local/lib/dsh-vless/entitlements.xml"
install -m 0644 "$ROOT/config/xray/fail-closed.json" \
  "$STAGE/var/jb/usr/local/lib/dsh-vless/fail-closed.json"
install -m 0644 "$ROOT/config/xray/vless-ws-tls.json.example" \
  "$STAGE/var/jb/usr/local/share/dsh-vless/vless-ws-tls.json.example"
install -m 0644 "$ROOT/build/xray-core-$XRAY_VERSION/LICENSE" \
  "$STAGE/var/jb/usr/local/share/dsh-vless/LICENSE"
install -m 0755 "$ROOT/packaging/xray/dsh-vless" \
  "$STAGE/var/jb/usr/local/bin/dsh-vless"
install -m 0644 "$ROOT/launchd/ai.deepseek.dsh-vless.plist" \
  "$STAGE/var/jb/Library/LaunchDaemons/ai.deepseek.dsh-vless.plist"
install -m 0755 "$ROOT/packaging/xray/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$ROOT/packaging/xray/prerm" "$STAGE/DEBIAN/prerm"

installed_size=$(du -sk "$STAGE" | awk '{print $1}')
sed \
  -e "s/@PACKAGE_VERSION@/$PACKAGE_VERSION/g" \
  -e "s/@IOS_MIN_VERSION@/$XRAY_IOS_MIN_VERSION/g" \
  -e "s/@INSTALLED_SIZE@/$installed_size/g" \
  "$ROOT/packaging/xray/control.in" > "$STAGE/DEBIAN/control"

build_deb "$STAGE" "$OUTPUT"
printf '%s\n' "$OUTPUT"
