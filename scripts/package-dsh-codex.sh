#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command cmp
require_command node
require_command rg
require_command tar
"$SCRIPT_DIR/fetch-pnpm.sh" >/dev/null
PNPM=(node "$ROOT/build/pnpm-$PNPM_VERSION/bin/pnpm.cjs")

SOURCE=${DSH_CODEX_SOURCE:-"$ROOT/../dsh-codex"}
OUTPUT="$ROOT/dist/dsh-codex-$DSH_CODEX_VERSION.tgz"

[ -f "$SOURCE/package.json" ] || \
  die "missing shared dsh-codex checkout at $SOURCE; set DSH_CODEX_SOURCE to override it"

package_name=$(node -p "require('$SOURCE/package.json').name")
package_version=$(node -p "require('$SOURCE/package.json').version")
[ "$package_name" = "dsh-codex" ] || die "unexpected package name: $package_name"
[ "$package_version" = "$DSH_CODEX_VERSION" ] || \
  die "dsh-codex is $package_version, expected $DSH_CODEX_VERSION"

"${PNPM[@]}" --dir "$SOURCE" run check
node "$SCRIPT_DIR/check-provider-components.mjs" local --source "$SOURCE"
mkdir -p "$ROOT/dist"
rm -f "$OUTPUT"
"${PNPM[@]}" --dir "$SOURCE" pack --pack-destination "$ROOT/dist" >/dev/null
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

# Materialize the locked production closure on the Mac. The phone installs
# this self-contained tarball without contacting a registry.
DEPENDENCIES_ROOT="$TEMP_ROOT/dependencies"
mkdir -p "$DEPENDENCIES_ROOT"
cp "$SOURCE/package.json" "$SOURCE/pnpm-lock.yaml" "$DEPENDENCIES_ROOT/"
cp -R "$SOURCE/patches" "$DEPENDENCIES_ROOT/patches"
"${PNPM[@]}" --dir "$DEPENDENCIES_ROOT" install --prod --frozen-lockfile \
  --ignore-scripts --config.node-linker=hoisted
mkdir -p "$TEMP_ROOT/package/node_modules"
cp -RL "$DEPENDENCIES_ROOT/node_modules/." "$TEMP_ROOT/package/node_modules/"
node - "$TEMP_ROOT/package/package.json" <<'NODE'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const path = require('node:path')
const manifestPath = process.argv[2]
const root = path.dirname(manifestPath)
const metadata = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
metadata.bundledDependencies = Object.keys(metadata.dependencies)
for (const name of metadata.bundledDependencies) {
  const dependency = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'))
  assert.equal(dependency.name, name, `missing bundled dependency: ${name}`)
}
for (const entry of fs.readdirSync(path.join(root, 'node_modules'), { recursive: true })) {
  assert.ok(!entry.endsWith('.node'), `iOS bundle contains an unverified native module: ${entry}`)
  assert.ok(!/(^|\/)@deepseek-ai\/dsh(?:-|\/)/.test(entry), `DSH peer was bundled: ${entry}`)
}
fs.writeFileSync(manifestPath, JSON.stringify(metadata, null, 2) + '\n')
NODE
rm -f "$OUTPUT"
COPYFILE_DISABLE=1 tar -czf "$OUTPUT" -C "$TEMP_ROOT" package
tar -tzf "$OUTPUT" | rg '^package/node_modules/@earendil-works/pi-ai/package.json$' >/dev/null || \
  die "Provider tarball is missing its bundled pi-ai runtime"

printf '%s\n' "$OUTPUT"
