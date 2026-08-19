#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
load_versions
require_command bash
require_command git
require_command node
require_command plutil
require_command rg

while IFS= read -r script; do
  bash -n "$ROOT/$script"
done < <(rg --files scripts packaging tests -g '*.sh' -g 'node22' -g 'dsh22' -g 'dsh-vless' -g 'pnpm' -g 'pnpx' -g 'postinst' -g 'prerm')

while IFS= read -r module; do
  node --check "$ROOT/$module"
done < <(rg --files scripts shims tests ios -g '*.mjs')

plutil -lint \
  "$ROOT/launchd/ai.deepseek.dsh.plist" \
  "$ROOT/launchd/ai.deepseek.dsh-activity.plist" \
  "$ROOT/launchd/ai.deepseek.dsh-vless.plist" \
  "$ROOT/packaging/node/entitlements.xml" \
  "$ROOT/packaging/xray/entitlements.xml" \
  "$ROOT/ios/activity/DSHActivityHost-Info.plist" \
  "$ROOT/ios/activity/DSHLiveActivity-Info.plist" \
  "$ROOT/ios/activity/DSHActivity.entitlements" \
  "$ROOT/ios/activity/DSHActivityWorker.entitlements" >/dev/null

node "$ROOT/tests/test-lockfile.mjs"
node "$ROOT/tests/test-shims.mjs"
node "$ROOT/tests/test-vless-config.mjs"
node "$ROOT/tests/test-ios-notifications.mjs"
"$ROOT/tests/test-xray-package.sh"

VENDOR="$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-Cjbwl5VI.js"
INDEX="$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-C-1AiF3k.js"
if [ -f "$VENDOR" ] && [ -f "$INDEX" ]; then
  node "$ROOT/tests/test-ios16-frontend.mjs" "$VENDOR" "$INDEX"
  node "$ROOT/scripts/patch-dsh.mjs" --root "$ROOT/build/dsh-runtime" --check
  node --input-type=module -e "await import('$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js')"
  node --input-type=module -e "await import('$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/index.js')"
else
  node "$ROOT/tests/test-ios16-frontend.mjs"
fi

PTY_NODE="$ROOT/build/dsh-runtime/node_modules/node-pty/prebuilds/ios-arm64/pty.node"
PTY_HELPER="$ROOT/build/dsh-runtime/node_modules/node-pty/prebuilds/ios-arm64/spawn-helper"
if [ -f "$PTY_NODE" ] || [ -f "$PTY_HELPER" ]; then
  require_command file
  require_command vtool
  [ -f "$PTY_NODE" ] && [ -x "$PTY_HELPER" ] || die "incomplete ios-arm64 node-pty output"
  file "$PTY_NODE" | rg 'Mach-O 64-bit bundle arm64' >/dev/null
  file "$PTY_HELPER" | rg 'Mach-O 64-bit executable arm64' >/dev/null
  vtool -show-build "$PTY_NODE" | rg 'platform IOS' >/dev/null
  vtool -show-build "$PTY_NODE" | rg "minos $NODE_IOS_MIN_VERSION" >/dev/null
fi

if [ -n "${NODE_ARCHIVE_PATH:-}" ] || [ -f "$ROOT/.cache/$NODE_ARCHIVE" ]; then
  "$ROOT/tests/test-source-patches.sh"
else
  printf 'Node source patch test skipped: run ./scripts/fetch-node.sh first\n'
fi

if [ -n "${PNPM_ARCHIVE_PATH:-}" ] || [ -f "$ROOT/.cache/$PNPM_ARCHIVE" ]; then
  "$ROOT/scripts/fetch-pnpm.sh" >/dev/null
  "$ROOT/tests/test-pnpm-package.sh"
else
  printf 'pnpm package test skipped: run ./scripts/fetch-pnpm.sh first\n'
fi

if [ -n "${XRAY_ARCHIVE_PATH:-}" ] || [ -f "$ROOT/.cache/$XRAY_ARCHIVE" ]; then
  "$ROOT/scripts/fetch-xray.sh" >/dev/null
else
  printf 'Xray source test skipped: run ./scripts/fetch-xray.sh first\n'
fi

actual_upstream=$(git -C "$ROOT/upstream/deepseek-harness" rev-parse HEAD)
[ "$actual_upstream" = "$DSH_UPSTREAM_COMMIT" ] || \
  die "upstream submodule is $actual_upstream, expected $DSH_UPSTREAM_COMMIT"
[ -z "$(git -C "$ROOT/upstream/deepseek-harness" status --porcelain)" ] || \
  die "upstream submodule has local changes; iOS compatibility must stay outside official DSH"
upstream_version=$(node -p "require('$ROOT/upstream/deepseek-harness/package.json').version")
[ "$upstream_version" = "$DSH_VERSION" ] || \
  die "upstream package version is $upstream_version, expected $DSH_VERSION"

if git -C "$ROOT" ls-files --cached --others --exclude-standard | \
  rg '(^|/)(build|dist|node_modules|\.cache)/|\.(deb|dylib|node|tar|tar\.gz|tar\.xz|tgz|zip)$'; then
  die "generated artifact would be tracked"
fi

mac_user_root="/""Users/"
if rg -n "${mac_user_root}[^/]+/" "$ROOT" \
  -g '!upstream/deepseek-harness/**' \
  -g '!build/**' \
  -g '!dsh-runtime/node_modules/**'; then
  die "user-specific absolute path found"
fi

git -C "$ROOT" diff --check
git -C "$ROOT" diff --cached --check
printf 'Repository verification passed\n'
