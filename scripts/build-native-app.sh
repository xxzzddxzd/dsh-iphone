#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
for native_build_command in git python3 xcrun xcodebuild plutil rsync zip; do require_command "$native_build_command"; done
[ -n "${NATIVE_APP_SOURCE:-}" ] || die "set NATIVE_APP_SOURCE to the reviewed Whaleness checkout"
SOURCE=$(CDPATH= cd -- "$NATIVE_APP_SOURCE" && pwd)
OUTPUT="$ROOT/build/native-app"
FRAMEWORK="$SOURCE/shared/build/bin/iosArm64/releaseFramework/DeepSeekHarnessShared.framework/DeepSeekHarnessShared"
SKIP_KMP=${NATIVE_SKIP_KMP_BUILD:-0}
case "$SKIP_KMP" in 0|1) ;; *) die "NATIVE_SKIP_KMP_BUILD must be 0 or 1" ;; esac

python3 "$ROOT/ios/native/apply_source.py" "$SOURCE"
NATIVE_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/ios/native/source-patch.json")
NATIVE_BUILD=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["build"])' "$ROOT/ios/native/source-patch.json")
[[ "$NATIVE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid native version pin"
[[ "$NATIVE_BUILD" =~ ^[1-9][0-9]*$ ]] || die "invalid native build pin"
git -C "$SOURCE" diff --quiet -- shared build.gradle.kts gradle || \
  die "shared Kotlin/build inputs differ from the reviewed source; audit before building"

if [ "$SKIP_KMP" = 0 ]; then
  NATIVE_JAVA_HOME=${NATIVE_JAVA_HOME:-$(/usr/libexec/java_home -v 17)}
  NATIVE_ANDROID_SDK=${NATIVE_ANDROID_SDK:-${ANDROID_HOME:-"$HOME/Library/Android/sdk"}}
  [ -x "$NATIVE_JAVA_HOME/bin/java" ] || die "JDK 17 is unavailable; set NATIVE_JAVA_HOME"
  [ -d "$NATIVE_ANDROID_SDK" ] || die "Android SDK is unavailable; set NATIVE_ANDROID_SDK"
  JAVA_HOME="$NATIVE_JAVA_HOME" ANDROID_HOME="$NATIVE_ANDROID_SDK" ANDROID_SDK_ROOT="$NATIVE_ANDROID_SDK" \
    "$SOURCE/gradlew" --project-dir "$SOURCE" :shared:linkReleaseFrameworkIosArm64 --no-daemon
fi
[ -s "$FRAMEWORK" ] || die "missing built arm64 Release KMP framework"
xcrun lipo -verify_arch arm64 "$FRAMEWORK"

reset_build_dir "$OUTPUT"
PROJECT_ROOT="$OUTPUT/project"
mkdir -p "$PROJECT_ROOT"
# Keep the reviewed source untouched. Only this private project copy replaces
# the unconditional Gradle phase with a check of the framework built above.
python3 - "$SOURCE" "$PROJECT_ROOT" <<'PY'
from pathlib import Path
import json, plistlib, shutil, subprocess, sys
source, target = map(Path, sys.argv[1:])
for path in source.iterdir():
    if path.name in {'.git', '.gradle', '.kotlin', 'build'}:
        continue
    destination = target / path.name
    if path.name == 'DeepSeekHarnessMobile.xcodeproj':
        shutil.copytree(path, destination)
    else:
        destination.symlink_to(path, target_is_directory=path.is_dir())
project = target / 'DeepSeekHarnessMobile.xcodeproj/project.pbxproj'
data = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(project)]))
phases = [obj for obj in data['objects'].values() if obj.get('isa') == 'PBXShellScriptBuildPhase' and obj.get('name') == 'Build KMP Framework']
if len(phases) != 1 or ':shared:link${KMP_BUILD_TYPE}Framework${KMP_TARGET}' not in phases[0].get('shellScript', ''):
    raise SystemExit('Reviewed KMP Xcode phase changed; audit its build contract')
phases[0]['shellScript'] = 'set -eu\ntest -s "$SRCROOT/shared/build/bin/iosArm64/releaseFramework/DeepSeekHarnessShared.framework/DeepSeekHarnessShared"\n'
with project.open('wb') as stream:
    plistlib.dump(data, stream, fmt=plistlib.FMT_XML, sort_keys=False)
PY

ARCHIVE="$OUTPUT/Whaleness.xcarchive"
xcodebuild archive \
  -project "$PROJECT_ROOT/DeepSeekHarnessMobile.xcodeproj" \
  -scheme DeepSeekHarnessMobile \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$OUTPUT/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' CODE_SIGN_ENTITLEMENTS='' \
  DEVELOPMENT_TEAM='' LOCAL_DEVELOPMENT_TEAM='' \
  LOCAL_BUNDLE_IDENTIFIER=com.clark.dshmobile.dev \
  IPHONEOS_DEPLOYMENT_TARGET=16.1 CURRENT_PROJECT_VERSION="$NATIVE_BUILD" MARKETING_VERSION="$NATIVE_VERSION"

APP="$ARCHIVE/Products/Applications/DshMobile.app"
[ -d "$APP" ] || die "archive did not contain the reviewed native app product"
mkdir -p "$OUTPUT/Payload/DshMobile.app"
rsync -a --delete "$APP/" "$OUTPUT/Payload/DshMobile.app/"
IPA="$OUTPUT/Whaleness-iphone-$NATIVE_VERSION-build$NATIVE_BUILD.ipa"
(
  cd "$OUTPUT"
  COPYFILE_DISABLE=1 zip -qry "$(basename -- "$IPA")" Payload
)

python3 - "$ROOT/ios/native/app-release.json" "$ROOT/ios/native/source-patch.json" "$IPA" "$OUTPUT/native-app-manifest.json" <<'PY'
from pathlib import Path
import hashlib, json, sys
base, patch, archive, output = map(Path, sys.argv[1:])
manifest = json.loads(base.read_text())
source = json.loads(patch.read_text())
manifest.pop('url', None)  # This artifact is a reproducible local build, not the upstream binary.
manifest.update(version=source['version'], build=source['build'], commit=source['commit'],
                capabilities=source['capabilities'], sourcePatchSHA256=source['sha256'],
                artifact=archive.name, sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
output.write_text(json.dumps(manifest, indent=2) + '\n')
PY
python3 "$ROOT/ios/native/native_client.py" --manifest "$OUTPUT/native-app-manifest.json" verify-ipa "$IPA"
printf 'Native IPA: %s\nManifest: %s\n' "$IPA" "$OUTPUT/native-app-manifest.json"
