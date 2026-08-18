#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions

BINARY=${NODE_BINARY_PATH:-"$ROOT/build/node-v$NODE_VERSION/out/Release/node"}
STAGE="$ROOT/build/node-deb-root"
PACKAGE_VERSION="$NODE_VERSION-$NODE_PACKAGE_REVISION"
OUTPUT="$ROOT/dist/nodejs22_${PACKAGE_VERSION}_iphoneos-arm64.deb"

[ -f "$BINARY" ] || die "missing Node binary; run ./scripts/build-node.sh first"
reset_build_dir "$STAGE"
mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/var/jb/usr/local/bin" \
  "$STAGE/var/jb/usr/local/lib/nodejs22"

install -m 0755 "$BINARY" "$STAGE/var/jb/usr/local/lib/nodejs22/node"
install -m 0755 "$ROOT/packaging/node/node22" "$STAGE/var/jb/usr/local/bin/node22"
install -m 0644 "$ROOT/packaging/node/entitlements.xml" \
  "$STAGE/var/jb/usr/local/lib/nodejs22/entitlements.xml"
install -m 0755 "$ROOT/packaging/node/postinst" "$STAGE/DEBIAN/postinst"

installed_size=$(du -sk "$STAGE" | awk '{print $1}')
sed \
  -e "s/@PACKAGE_VERSION@/$PACKAGE_VERSION/g" \
  -e "s/@NODE_VERSION@/$NODE_VERSION/g" \
  -e "s/@IOS_MIN_VERSION@/$NODE_IOS_MIN_VERSION/g" \
  -e "s/@INSTALLED_SIZE@/$installed_size/g" \
  "$ROOT/packaging/node/control.in" > "$STAGE/DEBIAN/control"

build_deb "$STAGE" "$OUTPUT"
printf '%s\n' "$OUTPUT"
