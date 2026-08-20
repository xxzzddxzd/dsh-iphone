#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ROOT=$(repo_root)
TARGET_REF=${1:-}
require_command git

[ -n "$TARGET_REF" ] || \
  die "usage: ./scripts/update-upstream.sh <released-tag-or-commit>"

git -C "$ROOT" submodule update --init upstream/deepseek-harness
git -C "$ROOT/upstream/deepseek-harness" fetch --tags origin
git -C "$ROOT/upstream/deepseek-harness" checkout --detach "$TARGET_REF"

commit=$(git -C "$ROOT/upstream/deepseek-harness" rev-parse HEAD)
printf 'Upstream checked out at %s\n' "$commit"
printf 'Now update versions.env, dsh-runtime/package.json, package-lock.json, and patch preimages.\n'
