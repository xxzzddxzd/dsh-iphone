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
done < <(rg --files scripts shims tests ios web -g '*.mjs' -g '*.js')

plutil -lint \
  "$ROOT/launchd/ai.deepseek.dsh.plist" \
  "$ROOT/launchd/ai.deepseek.dsh-iphone-usb-proxy.plist.in" \
  "$ROOT/launchd/ai.deepseek.dsh-activity.plist" \
  "$ROOT/launchd/ai.deepseek.dsh-vless.plist" \
  "$ROOT/packaging/node/entitlements.xml" \
  "$ROOT/packaging/xray/entitlements.xml" \
  "$ROOT/ios/activity/DSHActivityHost-Info.plist" \
  "$ROOT/ios/activity/DSHLiveActivity-Info.plist" \
  "$ROOT/ios/activity/DSHActivity.entitlements" \
  "$ROOT/ios/activity/DSHActivityExtension.entitlements" \
  "$ROOT/ios/activity/DSHActivityWorker.entitlements" >/dev/null
if [ "${DSH_INCLUDE_LEGACY_WEB_CLIENT:-0}" = 1 ]; then
  plutil -lint "$ROOT/ios/client/DSHWebClient-Info.plist" "$ROOT/ios/client/DSHClient.entitlements" >/dev/null
  node "$ROOT/tests/test-ios-client.mjs"
fi

# Plugin executables use `#!/usr/bin/env node`; they must inherit Node 22 rather
# than the jailbreak's legacy `/var/jb/usr/local/bin/node` (currently Node 18).
rg -F 'export PATH="/var/jb/usr/local/lib/nodejs22:' \
  "$ROOT/packaging/dsh/dsh22" >/dev/null
rg -F 'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-jitless --disable-wasm-trap-handler"' \
  "$ROOT/packaging/dsh/dsh22" >/dev/null
rg -F 'export NARB_DISABLE_NATIVE_CACHE=1' "$ROOT/packaging/dsh/dsh22" >/dev/null
if rg -F -- '--expose-internals' "$ROOT/packaging/dsh/dsh22"; then
  die "DSH must use the native builtin loader without exposing internal modules"
fi
rg -F '<string>/var/jb/usr/local/lib/nodejs22:/var/jb/usr/local/bin:' \
  "$ROOT/launchd/ai.deepseek.dsh.plist" >/dev/null

node "$ROOT/tests/test-lockfile.mjs"
node "$ROOT/tests/test-provider-history.mjs"
node "$ROOT/tests/test-shims.mjs"
node "$ROOT/tests/test-ios-image-tool.mjs"
node "$ROOT/tests/test-vless-config.mjs"
node "$ROOT/tests/test-ios-notifications.mjs"
node "$ROOT/tests/test-ios-connection.mjs"
node "$ROOT/tests/test-ios-mobile-shell.mjs"
node "$ROOT/tests/test-ios-json-values.mjs"
node "$ROOT/tests/test-ios-token-rules.mjs"
node "$ROOT/tests/test-mac-purge-restart.mjs"
node "$ROOT/tests/test-grok-cooling-policy.mjs"
node "$ROOT/tests/test-web-auth.mjs"
node "$ROOT/tests/test-upgrade-validation.mjs"
node "$ROOT/tests/test-release-report.mjs"
node "$ROOT/tests/test-provider-components.mjs"
node "$ROOT/tests/test-native-navigation.mjs"
node "$ROOT/tests/test-activity-target.mjs"
node "$ROOT/tests/test-activity-validation.mjs"
node "$ROOT/tests/test-native-widget-setup.mjs"
node "$ROOT/tests/test-native-widget-install.mjs"
node "$ROOT/tests/test-native-gateway.mjs"
node "$ROOT/tests/test-check-native-settings.mjs"
node "$ROOT/tests/test-deploy-native.mjs"
node "$ROOT/tests/test-profile-migration.mjs"
node "$ROOT/tests/test-cline-pass.mjs"
node "$ROOT/tests/test-mobile-gateway.mjs"
node "$ROOT/tests/test-native-settings-bridge.mjs"
node "$ROOT/tests/test-native-credentials-bridge.mjs"
python3 -B "$ROOT/tests/test-native-app.py"
if [ -n "${NATIVE_APP_SOURCE:-}" ]; then
  node "$ROOT/tests/test-native-subscription-timeout.mjs" "$NATIVE_APP_SOURCE/DeepSeekHarnessMobile/Core/GatewayClient.swift"
  node "$ROOT/tests/test-native-subscription-buffer.mjs" "$NATIVE_APP_SOURCE"
  node "$ROOT/tests/test-native-subscription-transport.mjs" "$NATIVE_APP_SOURCE"
  node "$ROOT/tests/test-native-settings-client.mjs" "$NATIVE_APP_SOURCE"
  node "$ROOT/tests/test-native-settings-models.mjs" "$NATIVE_APP_SOURCE"
fi
python3 -B "$ROOT/tests/test-open-device.py"
"$ROOT/tests/test-xray-package.sh"

VENDOR="$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-DcuzkuQH.js"
INDEX="$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js"
if [ -f "$VENDOR" ] && [ -f "$INDEX" ]; then
  node "$ROOT/tests/test-ios16-frontend.mjs" "$VENDOR" "$INDEX"
  node "$ROOT/tests/test-official-web-ui.mjs"
  node "$ROOT/tests/test-require-builtin.mjs"
  node "$ROOT/tests/test-ios-subprocess.mjs"
  node "$ROOT/scripts/patch-dsh.mjs" --root "$ROOT/build/dsh-runtime" --check
  node --input-type=module -e "await import('$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js')"
  node --input-type=module -e "await import('$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/index.js')"
else
  node "$ROOT/tests/test-ios16-frontend.mjs"
fi

PTY_NODE="$ROOT/build/dsh-runtime/node_modules/node-pty/prebuilds/ios-arm64/pty.node"
PTY_HELPER="$ROOT/build/dsh-runtime/node_modules/node-pty/prebuilds/ios-arm64/spawn-helper"
FLOCK_NODE="$ROOT/build/dsh-runtime/node_modules/@deepseek-ai/node-addon-system/prebuilds/ios-arm64/system.node"
REQUIRE_BUILTIN_NODE="$ROOT/build/dsh-runtime/node_modules/node-addon-require-builtin/build/napi/napi-v9-ios-arm64/require_builtin.node"
if [ -f "$PTY_NODE" ] || [ -f "$PTY_HELPER" ]; then
  require_command file
  require_command vtool
  [ -f "$PTY_NODE" ] && [ -x "$PTY_HELPER" ] || die "incomplete ios-arm64 node-pty output"
  file "$PTY_NODE" | rg 'Mach-O 64-bit bundle arm64' >/dev/null
  file "$PTY_HELPER" | rg 'Mach-O 64-bit executable arm64' >/dev/null
  vtool -show-build "$PTY_NODE" | rg 'platform IOS' >/dev/null
  vtool -show-build "$PTY_NODE" | rg "minos $NODE_IOS_MIN_VERSION" >/dev/null
fi

if [ -f "$FLOCK_NODE" ]; then
  require_command file
  require_command vtool
  file "$FLOCK_NODE" | rg 'Mach-O 64-bit bundle arm64' >/dev/null
  vtool -show-build "$FLOCK_NODE" | rg 'platform IOS' >/dev/null
  vtool -show-build "$FLOCK_NODE" | rg "minos $NODE_IOS_MIN_VERSION" >/dev/null
fi

if [ -f "$PTY_NODE" ] || [ -f "$FLOCK_NODE" ]; then
  [ -f "$REQUIRE_BUILTIN_NODE" ] || die "missing iOS require-builtin native module; rebuild DSH"
  file "$REQUIRE_BUILTIN_NODE" | rg 'Mach-O 64-bit bundle arm64' >/dev/null
  vtool -show-build "$REQUIRE_BUILTIN_NODE" | rg 'platform IOS' >/dev/null
  vtool -show-build "$REQUIRE_BUILTIN_NODE" | rg "minos $NODE_IOS_MIN_VERSION" >/dev/null
fi

IMAGE_TOOL="$ROOT/build/ios-image-tool/dsh-image-tool"
if [ -f "$IMAGE_TOOL" ]; then
  require_command file
  require_command vtool
  file "$IMAGE_TOOL" | rg 'Mach-O 64-bit executable arm64' >/dev/null
  vtool -show-build "$IMAGE_TOOL" | rg 'platform IOS' >/dev/null
  vtool -show-build "$IMAGE_TOOL" | rg "minos $NODE_IOS_MIN_VERSION" >/dev/null
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
  rg '(^|/)(build|dist|node_modules|\.cache)(/|$)|\.(deb|dylib|node|tar|tar\.gz|tar\.xz|tgz|zip|ipa)$'; then
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
