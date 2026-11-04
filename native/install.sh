#!/bin/zsh
# Register github-prs.py as a Firefox native messaging host, so only the
# Kitsune extension can start it. Run again if this folder moves.
set -euo pipefail
here="${0:A:h}"
dir="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
mkdir -p "$dir"
chmod +x "$here/github-prs.py"
cat > "$dir/kitsune_github.json" <<EOF
{
  "name": "kitsune_github",
  "description": "GitHub pull request search for Kitsune live folders",
  "path": "$here/github-prs.py",
  "type": "stdio",
  "allowed_extensions": ["{6844a953-9931-4334-9ff6-257c246485cb}"]
}
EOF
echo "Installed: $dir/kitsune_github.json"

# Your live folders: names, containers and GitHub searches (see the example).
config="${XDG_CONFIG_HOME:-$HOME/.config}/kitsune/live-folders.json"
if [ ! -e "$config" ]; then
  mkdir -p "${config:h}"
  cp "$here/live-folders.example.json" "$config"
  echo "Created $config from the example; edit it to set up your folders."
fi
