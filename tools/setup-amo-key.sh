#!/bin/zsh
# Set up once: lets the release workflow sign Kitsune on addons.mozilla.org.
#
# 1. Create an API key at https://addons.mozilla.org/developers/addon/api/key/
#    (signed in to the account that owns Kitsune).
# 2. Run this in your own terminal and paste the two values when asked.
#
# They go straight into this repository's secrets AMO_JWT_ISSUER and
# AMO_JWT_SECRET (read from standard input, so they are never in a file, the
# command line or your shell history). Uses your gh login. Running it again
# replaces the key; revoke an old key on the same AMO page.
set -euo pipefail

read "issuer?JWT issuer (user:...): "
read -s "secret?JWT secret (not shown): "
echo
# Pasting easily picks up stray whitespace.
issuer="${issuer//[[:space:]]/}"
secret="${secret//[[:space:]]/}"
[[ "$issuer" == user:* && -n "$secret" ]] || { echo "That does not look like an AMO key" >&2; exit 1; }

print -rn -- "$issuer" | gh secret set AMO_JWT_ISSUER --repo CHaerem/kitsune
print -rn -- "$secret" | gh secret set AMO_JWT_SECRET --repo CHaerem/kitsune
unset issuer secret
echo "CHaerem/kitsune can now sign releases"
