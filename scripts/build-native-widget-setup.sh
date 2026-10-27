#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
for widget_setup_command in python3 xcrun; do require_command "$widget_setup_command"; done
[ "$#" -eq 0 ] || die "build-native-widget-setup.sh accepts no arguments"
OUTPUT="$ROOT/build/native-app"
[ -f "$OUTPUT/native-app-manifest.json" ] || die "build the pinned native IPA and manifest first"
WIDGET_SETUP_SDK=$(xcrun --sdk iphoneos --show-sdk-path)
WIDGET_SETUP_CC=$(xcrun --sdk iphoneos -f clang)
"$WIDGET_SETUP_CC" -isysroot "$WIDGET_SETUP_SDK" -target arm64-apple-ios16.1 \
  -fobjc-arc -fblocks -O2 -framework Foundation -lsqlite3 \
  "$ROOT/ios/native/DSHWidgetSetup.m" -o "$OUTPUT/DSHWidgetSetup"
install -m 0644 "$ROOT/ios/native/DSHWidgetSetup.entitlements" "$OUTPUT/DSHWidgetSetup.entitlements"
python3 - "$OUTPUT" <<'PY'
from pathlib import Path
import hashlib, json, os, sys
output = Path(sys.argv[1])
path = output / 'native-app-manifest.json'
manifest = json.loads(path.read_text())
if 'root-live-activity-widget-v1' not in manifest.get('capabilities', []):
    raise SystemExit('Widget setup is only built for the reviewed Root Activity client')
ipa = output / manifest['artifact']
if hashlib.sha256(ipa.read_bytes()).hexdigest() != manifest['sha256']:
    raise SystemExit('Native IPA changed before Widget helper metadata was added')
manifest['helperSHA256'] = hashlib.sha256((output / 'DSHWidgetSetup').read_bytes()).hexdigest()
manifest['helperEntitlementsSHA256'] = hashlib.sha256((output / 'DSHWidgetSetup.entitlements').read_bytes()).hexdigest()
temporary = path.with_suffix('.json.tmp')
temporary.write_text(json.dumps(manifest, indent=2) + '\n')
os.replace(temporary, path)
PY
python3 "$ROOT/ios/native/native_client.py" --manifest "$OUTPUT/native-app-manifest.json" \
  verify-widget-setup "$OUTPUT/DSHWidgetSetup" "$OUTPUT/DSHWidgetSetup.entitlements"
