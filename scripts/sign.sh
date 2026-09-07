#!/usr/bin/env bash
# Signs release artifacts when signing material is configured; exits
# successfully with a notice when it isn't, so unsigned local builds work.
#
# macOS (codesign, plus notarization when a keychain profile is set):
#   MACOS_SIGN_IDENTITY="Developer ID Application: ..." \
#   [MACOS_NOTARY_PROFILE=agency-notary] \
#   scripts/sign.sh --os darwin --file dist/agency-darwin-arm64
#
# Linux (detached Ed25519 signature via openssl):
#   scripts/sign.sh --os linux --file dist/agency-linux-x64 --key agency-ed25519.key
set -euo pipefail

usage() {
  echo "usage: sign.sh --os darwin --file <binary>" >&2
  echo "       sign.sh --os linux --file <binary> --key <ed25519 private key>" >&2
  exit 2
}

OS=""
FILE=""
KEY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --os) OS="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$OS" ] && [ -n "$FILE" ] || usage
[ -f "$FILE" ] || { echo "sign: file not found: $FILE" >&2; exit 1; }

case "$OS" in
  darwin)
    IDENTITY="${MACOS_SIGN_IDENTITY:-}"
    if [ -z "$IDENTITY" ]; then
      echo "sign: MACOS_SIGN_IDENTITY not set; skipping codesign (unsigned build)"
      exit 0
    fi
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$FILE"
    if [ -n "${MACOS_NOTARY_PROFILE:-}" ]; then
      xcrun notarytool submit "$FILE" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
      xcrun stapler staple "$FILE"
    else
      echo "sign: MACOS_NOTARY_PROFILE not set; signed but not notarized" >&2
    fi
    codesign --verify --strict "$FILE"
    echo "sign: $FILE signed (codesign identity: $IDENTITY)"
    ;;
  linux)
    if [ -z "$KEY" ]; then
      echo "sign: no --key given; skipping Linux signature (unsigned build)"
      exit 0
    fi
    openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$FILE" -out "$FILE.sig"
    echo "sign: $FILE signed (detached signature in $FILE.sig)"
    ;;
  *)
    echo "sign: unsupported OS '$OS' (darwin or linux)" >&2
    exit 2
    ;;
esac
