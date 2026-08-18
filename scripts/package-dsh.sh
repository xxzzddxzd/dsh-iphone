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
node "$SCRIPT_DIR/patch-dsh.mjs" --root "$RUNTIME_ROOT" --check

reset_build_dir "$STAGE"
mkdir -p \
  "$STAGE/DEBIAN" \
  "$STAGE/var/jb/Library/LaunchDaemons" \
  "$STAGE/var/jb/usr/local/bin" \
  "$STAGE/var/jb/usr/local/lib/dsh"

cp -R "$RUNTIME_ROOT/." "$STAGE/var/jb/usr/local/lib/dsh/"
install -m 0755 "$ROOT/packaging/dsh/dsh22" "$STAGE/var/jb/usr/local/bin/dsh22"
install -m 0644 "$ROOT/launchd/ai.deepseek.dsh.plist" \
  "$STAGE/var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist"
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
