#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions

SOURCE_DIR=${PNPM_SOURCE_PATH:-"$ROOT/build/pnpm-$PNPM_VERSION"}
STAGE="$ROOT/build/pnpm-deb-root"
PACKAGE_VERSION="$PNPM_VERSION-$PNPM_PACKAGE_REVISION"
OUTPUT="$ROOT/dist/pnpm10_${PACKAGE_VERSION}_iphoneos-arm64.deb"

[ -f "$SOURCE_DIR/bin/pnpm.cjs" ] || die "missing pnpm source; run ./scripts/fetch-pnpm.sh first"
reset_build_dir "$STAGE"
mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/var/jb/usr/local/bin" \
  "$STAGE/var/jb/usr/local/lib/pnpm10"

COPYFILE_DISABLE=1 cp -R "$SOURCE_DIR/." "$STAGE/var/jb/usr/local/lib/pnpm10/"
node "$ROOT/scripts/patch-pnpm.mjs" \
  --root "$STAGE/var/jb/usr/local/lib/pnpm10"
install -m 0755 "$ROOT/packaging/pnpm/pnpm" "$STAGE/var/jb/usr/local/bin/pnpm"
install -m 0755 "$ROOT/packaging/pnpm/pnpx" "$STAGE/var/jb/usr/local/bin/pnpx"
install -m 0755 "$ROOT/packaging/pnpm/postinst" "$STAGE/DEBIAN/postinst"

installed_size=$(du -sk "$STAGE" | awk '{print $1}')
sed \
  -e "s/@PACKAGE_VERSION@/$PACKAGE_VERSION/g" \
  -e "s/@NODE_VERSION@/$NODE_VERSION/g" \
  -e "s/@PNPM_VERSION@/$PNPM_VERSION/g" \
  -e "s/@INSTALLED_SIZE@/$installed_size/g" \
  "$ROOT/packaging/pnpm/control.in" > "$STAGE/DEBIAN/control"

build_deb "$STAGE" "$OUTPUT"
printf '%s\n' "$OUTPUT"
