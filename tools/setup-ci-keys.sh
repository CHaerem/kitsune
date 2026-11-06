#!/bin/zsh
# Set up once: lets the smoke test on GitHub read the Firefox files in your
# private dotfiles. dotfiles gets a read-only deploy key, and its private key
# goes straight into this repository's secret DOTFILES_DEPLOY_KEY. Deploy keys
# do not expire. The private key only exists in a temporary folder while this
# runs. Run it in your own terminal; it uses your gh login. Running it again
# replaces the key.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
title=smoke-test-reads-dotfiles

ssh-keygen -q -t ed25519 -N "" -C "$title" -f "$tmp/key"
for id in $(gh api repos/CHaerem/dotfiles/keys --jq ".[] | select(.title == \"$title\") | .id"); do
  gh api -X DELETE "repos/CHaerem/dotfiles/keys/$id" >/dev/null
done
gh repo deploy-key add "$tmp/key.pub" --repo CHaerem/dotfiles --title "$title"
gh secret set DOTFILES_DEPLOY_KEY --repo CHaerem/tidier < "$tmp/key"
echo "CHaerem/tidier can now read CHaerem/dotfiles"
