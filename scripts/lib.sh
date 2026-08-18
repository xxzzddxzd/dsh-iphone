#!/usr/bin/env bash

repo_root() {
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

load_versions() {
  local root
  root=$(repo_root)
  # shellcheck disable=SC1090
  . "$root/versions.env"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

reset_build_dir() {
  local root target
  root=$(repo_root)
  target=$1
  case "$target" in
    "$root"/build/* | "$root"/dist/*) ;;
    *) die "refusing to reset path outside build/dist: $target" ;;
  esac
  rm -rf "$target"
  mkdir -p "$target"
}

build_deb() {
  local stage output temp_dir gtar_bin ar_bin
  stage=$1
  output=$2
  mkdir -p "$(dirname -- "$output")"

  if command -v dpkg-deb >/dev/null 2>&1; then
    COPYFILE_DISABLE=1 dpkg-deb --build --root-owner-group "$stage" "$output"
    return
  fi

  gtar_bin=$(command -v gtar || true)
  ar_bin=$(command -v ar || true)
  [ -n "$gtar_bin" ] || die "install dpkg or GNU tar: brew install dpkg gnu-tar"
  [ -n "$ar_bin" ] || die "required command not found: ar"

  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/dsh-iphone-deb.XXXXXX")
  printf '2.0\n' > "$temp_dir/debian-binary"
  COPYFILE_DISABLE=1 "$gtar_bin" --sort=name --owner=0 --group=0 \
    --numeric-owner -C "$stage/DEBIAN" -cJf "$temp_dir/control.tar.xz" .
  COPYFILE_DISABLE=1 "$gtar_bin" --sort=name --owner=0 --group=0 \
    --numeric-owner --exclude='./DEBIAN' -C "$stage" \
    -cJf "$temp_dir/data.tar.xz" .
  (
    cd "$temp_dir"
    "$ar_bin" -rc package.deb debian-binary control.tar.xz data.tar.xz
  )
  mv "$temp_dir/package.deb" "$output"
  rm -rf "$temp_dir"
}
