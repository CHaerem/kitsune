#!/bin/zsh
# Sign Kitsune as an unlisted add-on on addons.mozilla.org.
#
# The AMO API key is kept in the macOS Keychain (service "amo-web-ext"). The
# first run asks for it and stores it; later runs sign without asking.
# Get a key at https://addons.mozilla.org/developers/addon/api/key/
# Bump "version" in manifest.json before signing a new release.
set -euo pipefail
cd "$(dirname "$0")"

if ! security find-generic-password -s amo-web-ext >/dev/null 2>&1; then
  read "issuer?JWT issuer (user:...): "
  security add-generic-password -U -s amo-web-ext -a "$issuer" -w
fi

# Whitespace is stripped: pasting the secret easily picks up stray spaces.
key="$(security find-generic-password -s amo-web-ext | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')"
secret="$(security find-generic-password -s amo-web-ext -w)"
export WEB_EXT_API_KEY="${key//[[:space:]]/}"
export WEB_EXT_API_SECRET="${secret//[[:space:]]/}"
unset key secret

npx web-ext sign --channel=unlisted --source-dir . --artifacts-dir ../kitsune-dist \
  --ignore-files sign.sh README.md 'native/**' 'tests/**' 'tools/**'
