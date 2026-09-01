#!/usr/bin/env bash
# Installs the Agency binary from a GitHub release. Fails closed: a missing or
# mismatched checksum aborts the install, nothing is written.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Pixeless001/Agency/master/scripts/install.sh | bash
# Env overrides: AGENCY_VERSION (default: latest release), AGENCY_INSTALL_DIR (default: ~/.local/bin).
set -euo pipefail

REPO="Pixeless001/Agency"
INSTALL_DIR="${AGENCY_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os_name="linux" ;;
  Darwin) os_name="darwin" ;;
  *) echo "install: unsupported OS '$os' (Linux or macOS required)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64) arch_name="x64" ;;
  arm64 | aarch64) arch_name="arm64" ;;
  *) echo "install: unsupported architecture '$arch'" >&2; exit 1 ;;
esac

if [ -n "${AGENCY_VERSION:-}" ]; then
  version="${AGENCY_VERSION#v}"
else
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$version" ] || { echo "install: could not determine the latest release" >&2; exit 1; }
fi

asset="agency-$os_name-$arch_name"
base_url="https://github.com/$REPO/releases/download/v$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "install: downloading agency v$version ($os_name-$arch_name)"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base_url/$asset"
curl -fsSL --retry 3 -o "$tmp/checksums.txt" "$base_url/checksums.txt"

expected="$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/checksums.txt")"
if [ -z "$expected" ]; then
  echo "install: FAIL - no checksum for $asset in checksums.txt; refusing to install" >&2
  exit 1
fi
if ! echo "$expected  $tmp/$asset" | sha256sum -c --strict >/dev/null 2>&1; then
  echo "install: FAIL - checksum mismatch for $asset; refusing to install" >&2
  exit 1
fi
echo "install: checksum verified"

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp/$asset" "$INSTALL_DIR/agency"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "install: note: $INSTALL_DIR is not on your PATH; add it to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo "install: agency v$version installed to $INSTALL_DIR/agency"
echo "install: run 'agency --help' to get started"
