#!/usr/bin/env bash
# Package the installed Mac dsh-cline-pass bundle for the iPhone deployment.
#
# The iPhone profile installs bundles from a local tarball (the same way
# dsh-codex does via /var/root/dsh-codex-shared.tgz), so the phone never needs
# registry access.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command node
require_command pnpm
require_command tar

DEFAULT_SOURCE="$HOME/.dsh/profiles/web/node_modules/dsh-cline-pass"
SOURCE=${DSH_CLINE_PASS_SOURCE:-"$DEFAULT_SOURCE"}
OUTPUT="$ROOT/dist/dsh-cline-pass-$DSH_CLINE_PASS_VERSION.tgz"

if [ -e "$SOURCE" ]; then
  SOURCE=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SOURCE")
fi

[ -f "$SOURCE/package.json" ] || \
  die "missing dsh-cline-pass at $SOURCE; set DSH_CLINE_PASS_SOURCE to override it"

package_name=$(node -p "require('$SOURCE/package.json').name")
package_version=$(node -p "require('$SOURCE/package.json').version")
[ "$package_name" = "dsh-cline-pass" ] || die "unexpected package name: $package_name"
[ "$package_version" = "$DSH_CLINE_PASS_VERSION" ] || \
  die "dsh-cline-pass is $package_version, expected $DSH_CLINE_PASS_VERSION"

for relative in cordis.patch.yml lib/index.js lib/client.js; do
  [ -f "$SOURCE/$relative" ] || die "dsh-cline-pass is missing $relative"
done

mkdir -p "$ROOT/dist"
rm -f "$OUTPUT"
pnpm --dir "$SOURCE" pack --pack-destination "$ROOT/dist" >/dev/null
[ -f "$OUTPUT" ] || die "pnpm did not create $OUTPUT"

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dsh-cline-pass-pack.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT INT TERM
tar -xzf "$OUTPUT" -C "$TEMP_ROOT"

for relative in cordis.patch.yml lib/index.js lib/client.js; do
  [ -f "$TEMP_ROOT/package/$relative" ] || die "packed dsh-cline-pass is missing $relative"
done

node "$SCRIPT_DIR/patch-dsh-cline-pass.mjs" "$TEMP_ROOT/package/lib/client.js"
tar -czf "$OUTPUT" -C "$TEMP_ROOT" package

printf '%s\n' "$OUTPUT"
