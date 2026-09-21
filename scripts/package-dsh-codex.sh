#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command cmp
require_command node
require_command pnpm
require_command tar

SOURCE=${DSH_CODEX_SOURCE:-"$ROOT/../dsh-codex"}
OUTPUT="$ROOT/dist/dsh-codex-$DSH_CODEX_VERSION.tgz"

[ -f "$SOURCE/package.json" ] || \
  die "missing shared dsh-codex checkout at $SOURCE; set DSH_CODEX_SOURCE to override it"

package_name=$(node -p "require('$SOURCE/package.json').name")
package_version=$(node -p "require('$SOURCE/package.json').version")
[ "$package_name" = "dsh-codex" ] || die "unexpected package name: $package_name"
[ "$package_version" = "$DSH_CODEX_VERSION" ] || \
  die "dsh-codex is $package_version, expected $DSH_CODEX_VERSION"

pnpm --dir "$SOURCE" run check
mkdir -p "$ROOT/dist"
rm -f "$OUTPUT"
pnpm --dir "$SOURCE" pack --pack-destination "$ROOT/dist" >/dev/null
[ -f "$OUTPUT" ] || die "pnpm did not create $OUTPUT"

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dsh-codex-pack.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT INT TERM
tar -xzf "$OUTPUT" -C "$TEMP_ROOT"

node - "$SOURCE/package.json" "$TEMP_ROOT/package/package.json" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const [sourcePath, packedPath] = process.argv.slice(2)
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const packed = JSON.parse(fs.readFileSync(packedPath, 'utf8'))
delete source.scripts.prepublishOnly
delete source.pnpm
assert.deepEqual(packed, source, 'packed package metadata differs from the shared checkout')
NODE

for relative in cordis.patch.yml lib/index.js lib/client.js lib/bin.js; do
  [ -f "$TEMP_ROOT/package/$relative" ] || die "packed dsh-codex is missing $relative"
  cmp "$SOURCE/$relative" "$TEMP_ROOT/package/$relative" >/dev/null || \
    die "packed dsh-codex differs from the shared checkout: $relative"
done

printf '%s\n' "$OUTPUT"
