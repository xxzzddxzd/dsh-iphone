#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"
ROOT=$(repo_root)
load_versions
"$SCRIPT_DIR/fetch-pnpm.sh" >/dev/null

MAC_TOOLS_ROOT=${DSH_MAC_TOOLS_ROOT:-"$HOME/.local/share/dsh-iphone"}
MAC_PNPM_ROOT="$MAC_TOOLS_ROOT/pnpm10"
mkdir -p "$MAC_PNPM_ROOT" "$MAC_TOOLS_ROOT/bin"
cp -R "$ROOT/build/pnpm-$PNPM_VERSION/." "$MAC_PNPM_ROOT/"
ln -sfn ../pnpm10/bin/pnpm.cjs "$MAC_TOOLS_ROOT/bin/pnpm"

python3 - "$MAC_TOOLS_ROOT/bin" <<'PY'
from pathlib import Path
import plistlib
import shutil
import sys

plist = Path.home() / "Library/LaunchAgents/ai.deepseek.dsh-mac.plist"
if not plist.is_file():
    raise SystemExit("Mac DSH LaunchAgent is missing")
backup = plist.with_suffix(".plist.before-pnpm10")
if not backup.exists():
    shutil.copy2(plist, backup)
data = plistlib.loads(plist.read_bytes())
environment = data.setdefault("EnvironmentVariables", {})
paths = environment.get("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin").split(":")
environment["PATH"] = ":".join(dict.fromkeys([sys.argv[1], *paths]))
plist.write_bytes(plistlib.dumps(data))
PY

"$MAC_TOOLS_ROOT/bin/pnpm" --version
printf 'Mac DSH package manager: %s\n' "$MAC_TOOLS_ROOT/bin/pnpm"
