#!/bin/bash
set -euo pipefail

repository="Verbiflow/mako"
base_url="${MAKO_RELEASE_BASE_URL:-https://github.com/$repository/releases/latest/download}"
install_dir="${MAKO_INSTALL_DIR:-/Applications}"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/mako-install.XXXXXX")"
mount="$temporary/mount"
staging="$install_dir/.Mako.installing.$$"
target="$install_dir/Mako.app"
attached=0

run_installer() {
  if [[ -w "$install_dir" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

cleanup() {
  if (( attached )); then
    hdiutil detach "$mount" >/dev/null 2>&1 || true
  fi
  if [[ -e "$staging" ]]; then
    run_installer rm -rf -- "$staging" || true
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Mako currently installs only on macOS.\n' >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" && "${MAKO_ALLOW_NON_ARM64:-0}" != "1" ]]; then
  printf 'This Mako release requires an Apple-silicon Mac.\n' >&2
  exit 1
fi

cat >&2 <<'NOTICE'
Mako is currently distributed without Apple notarization.
This installer verifies the release checksum, copies only Mako.app to
Applications, and removes macOS quarantine only from that copied app.
NOTICE

mkdir -p "$mount"
if [[ "$base_url" == https://* ]]; then
  curl --proto '=https' --tlsv1.2 -fsSLo "$temporary/Mako-arm64.dmg" \
    "$base_url/Mako-arm64.dmg"
  curl --proto '=https' --tlsv1.2 -fsSLo "$temporary/SHA256SUMS.txt" \
    "$base_url/SHA256SUMS.txt"
else
  curl -fsSLo "$temporary/Mako-arm64.dmg" "$base_url/Mako-arm64.dmg"
  curl -fsSLo "$temporary/SHA256SUMS.txt" "$base_url/SHA256SUMS.txt"
fi

expected="$(awk '$2 == "Mako-arm64.dmg" { print $1; exit }' "$temporary/SHA256SUMS.txt")"
actual="$(shasum -a 256 "$temporary/Mako-arm64.dmg" | awk '{ print $1 }')"
if [[ -z "$expected" || "$actual" != "$expected" ]]; then
  printf 'Mako download checksum verification failed. Nothing was installed.\n' >&2
  exit 1
fi

hdiutil attach "$temporary/Mako-arm64.dmg" \
  -nobrowse \
  -readonly \
  -mountpoint "$mount" >/dev/null
attached=1
if [[ ! -d "$mount/Mako.app" ]]; then
  printf 'The verified DMG does not contain Mako.app. Nothing was installed.\n' >&2
  exit 1
fi

run_installer rm -rf -- "$staging"
run_installer ditto "$mount/Mako.app" "$staging"
if [[ -w "$install_dir" ]]; then
  xattr -dr com.apple.quarantine "$staging" 2>/dev/null || true
else
  sudo xattr -dr com.apple.quarantine "$staging" 2>/dev/null || true
fi
run_installer rm -rf -- "$target"
run_installer mv "$staging" "$target"

hdiutil detach "$mount" >/dev/null
attached=0

printf 'Mako was installed at %s\n' "$target"
if [[ "${MAKO_SKIP_LAUNCH:-0}" != "1" ]]; then
  open "$target"
fi
