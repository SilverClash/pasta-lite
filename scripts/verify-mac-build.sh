#!/bin/sh
# Check a release build (npm run dist:mac): the signature, Gatekeeper's verdict and the stapled
# notarization ticket of every .app and .dmg in dist/ (or of the paths given). Exits 1 if any
# check fails. An unsigned build (npm run dist:mac:unsigned) is expected to fail the Gatekeeper
# and stapler checks.
#
#   sh scripts/verify-mac-build.sh                 # dist/mac*/Pasta Lite.app and dist/*.dmg
#   sh scripts/verify-mac-build.sh path/to/X.dmg   # specific files
set -u
cd "$(dirname "$0")/.." || exit 1

if [ "$#" -eq 0 ]; then
  set -- dist/mac*/*.app dist/*.dmg
fi

failed=0
check() {
  label=$1; shift
  if out=$("$@" 2>&1); then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s\n' "$label"
    printf '%s\n' "$out" | sed 's/^/          /'
    failed=1
  fi
}

# Informational: printed, never fails the run. `spctl -t install` is meant for installer packages,
# and its verdict on a DMG varies between macOS versions; `-t open` above is the DMG check.
info() {
  label=$1; shift
  out=$("$@" 2>&1)
  printf '  info  %s: %s\n' "$label" "$(printf '%s' "$out" | tr '\n' ' ')"
}

for f in "$@"; do
  if [ ! -e "$f" ]; then
    printf 'missing: %s\n' "$f"
    failed=1
    continue
  fi
  printf '%s\n' "$f"
  codesign -dv --verbose=2 "$f" 2>&1 | grep -E '^(Authority|TeamIdentifier|Signature|Runtime Version)=' | head -3 | sed 's/^/        /'
  case "$f" in
    *.app)
      check 'codesign --verify --deep --strict' codesign --verify --deep --strict --verbose=2 "$f"
      check 'spctl -a -t exec (Gatekeeper)' spctl -a -vvv -t exec "$f"
      check 'stapler validate' xcrun stapler validate "$f"
      ;;
    *.dmg)
      check 'codesign --verify --strict' codesign --verify --strict --verbose=2 "$f"
      check 'spctl -a -t open (Gatekeeper)' spctl -a -vvv -t open --context context:primary-signature "$f"
      info 'spctl -a -t install' spctl -a -vvv -t install "$f"
      check 'stapler validate' xcrun stapler validate "$f"
      ;;
  esac
done

if [ "$failed" -ne 0 ]; then
  echo 'Some checks failed.'
  exit 1
fi
echo 'All checks passed.'
