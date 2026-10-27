#!/usr/bin/env bash
# Build the iPhone bundle from an exact public npm input, without changing the
# installed Mac profile or asking the phone to resolve any registry package.
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
load_versions
require_command node
require_command npm
require_command tar
require_command rsync

# Cline Pass has no direct dependencies. Its DSH peers are supplied by the
# already-installed Host, never auto-installed into this build-only prefix.
npm ci --prefix "$ROOT/cline-pass" --legacy-peer-deps --ignore-scripts --omit=dev --no-audit --no-fund >&2
SOURCE=${DSH_CLINE_PASS_SOURCE:-"$ROOT/cline-pass/node_modules/dsh-cline-pass"}
node - "$SOURCE/package.json" "$DSH_CLINE_PASS_VERSION" <<'NODE'
const fs = require('node:fs')
const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (metadata.name !== 'dsh-cline-pass' || metadata.version !== process.argv[3] || metadata.version !== '0.2.13') {
  throw new Error('Cline Pass source, supported version and versions.env do not match')
}
if (Object.keys(metadata.dependencies ?? {}).length) throw new Error('Cline Pass production dependencies changed; audit its closure')
NODE
STAGE="$ROOT/build/cline-pass"
reset_build_dir "$STAGE"
mkdir -p "$STAGE/package" "$ROOT/dist"
rsync -a --exclude=node_modules "$SOURCE/" "$STAGE/package/"
for relative in cordis.patch.yml lib/index.js lib/client.js; do
  [ -f "$STAGE/package/$relative" ] || die "Cline Pass is missing $relative"
done
node "$SCRIPT_DIR/patch-dsh-cline-pass.mjs" "$STAGE/package/lib/client.js" >&2
node "$ROOT/tests/test-cline-pass.mjs" --root "$STAGE/package" >&2
OUTPUT="$ROOT/dist/dsh-cline-pass-$DSH_CLINE_PASS_VERSION.tgz"
COPYFILE_DISABLE=1 tar -czf "$OUTPUT" -C "$STAGE" package
printf '%s\n' "$OUTPUT"
