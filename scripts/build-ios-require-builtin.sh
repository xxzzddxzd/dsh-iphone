#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
load_versions
require_command xcrun
require_command node

RUNTIME_ROOT=${DSH_RUNTIME_ROOT:-"$ROOT/build/dsh-runtime"}
[ -f "$RUNTIME_ROOT/package.json" ] || "$SCRIPT_DIR/prepare-dsh.sh" >/dev/null
package_version=$(node -p "require('$RUNTIME_ROOT/node_modules/node-addon-require-builtin/package.json').version")
[ "$package_version" = "$REQUIRE_BUILTIN_VERSION" ] || die "unexpected require-builtin runtime version: $package_version"
"$SCRIPT_DIR/fetch-require-builtin.sh" >/dev/null
[ -f "$ROOT/build/node-v$NODE_VERSION/src/node_api.h" ] || "$SCRIPT_DIR/fetch-node.sh" >/dev/null

SOURCE_DIR="$ROOT/build/require-builtin-$REQUIRE_BUILTIN_VERSION/packages/native"
API_DIR="$ROOT/build/require-builtin-addon-api-$REQUIRE_BUILTIN_ADDON_API_VERSION"
OUTPUT_DIR="$RUNTIME_ROOT/node_modules/node-addon-require-builtin/build/napi/napi-v9-ios-arm64"
mkdir -p "$OUTPUT_DIR"

sources=()
while IFS= read -r source; do
  sources+=("$SOURCE_DIR/$source")
done < <(node - "$SOURCE_DIR/binding.gyp" <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const target = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).targets[0];
assert.deepEqual(target.defines, ['NAPI_VERSION=9', 'NODE_ADDON_API_DISABLE_CPP_EXCEPTIONS']);
const napi = target.conditions[0][2];
assert.deepEqual(napi.defines, ['NARB_BACKEND=1']);
for (const source of [...target.sources, ...napi.sources]) {
  assert.match(source, /^src\/[a-z0-9_/]+\.cc$/);
  assert.ok(!source.includes('nodeabi'), 'N-API build must not include Node ABI sources');
  console.log(source);
}
JS
)
[ "${#sources[@]}" -eq 29 ] || die "require-builtin source list changed"

IOS_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
CXX=$(xcrun --sdk iphoneos -f clang++)
# This backend includes only public node_api.h/node_version.h, with no private
# Node headers or fixed runtime offsets. All upstream probes stay unchanged.
"$CXX" \
  -std=c++17 -arch arm64 -isysroot "$IOS_SDK" \
  -miphoneos-version-min="$NODE_IOS_MIN_VERSION" \
  -O2 -Wall -Wextra -Wno-unused-parameter -Wno-cast-function-type-mismatch \
  -fPIC -fno-exceptions -fvisibility=hidden \
  -DNAPI_VERSION=9 -DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS \
  -DNARB_BACKEND=1 -DNARB_PRODUCT=1 \
  -I "$API_DIR" -I "$ROOT/build/node-v$NODE_VERSION/src" \
  -bundle -Wl,-undefined,dynamic_lookup \
  -o "$OUTPUT_DIR/require_builtin.node" "${sources[@]}"
install -m 0644 "$ROOT/build/require-builtin-$REQUIRE_BUILTIN_VERSION/LICENSE" "$OUTPUT_DIR/LICENSE"
printf 'Built %s\n' "$OUTPUT_DIR/require_builtin.node"
