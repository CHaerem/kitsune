#!/bin/zsh
# Register github-prs.py and tidier-bridge.py as Firefox native messaging hosts, so
# only the Tidier extension can start them. Run again if this folder moves.
set -euo pipefail
here="${0:A:h}"
dir="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
mkdir -p "$dir"
chmod +x "$here/github-prs.py"
cat > "$dir/tidier_github.json" <<EOF
{
  "name": "tidier_github",
  "description": "GitHub pull request search for Tidier live folders",
  "path": "$here/github-prs.py",
  "type": "stdio",
  "allowed_extensions": ["{6844a953-9931-4334-9ff6-257c246485cb}"]
}
EOF
echo "Installed: $dir/tidier_github.json"
# The bridge to agents (README). It only runs while you have it turned on in Tidier's settings.
chmod +x "$here/tidier-bridge.py" "$here/tidier-mcp.py"
cat > "$dir/tidier_bridge.json" <<EOF
{
  "name": "tidier_bridge",
  "description": "The bridge between Tidier and agents, only while it is turned on",
  "path": "$here/tidier-bridge.py",
  "type": "stdio",
  "allowed_extensions": ["{6844a953-9931-4334-9ff6-257c246485cb}"]
}
EOF
echo "Installed: $dir/tidier_bridge.json"
# From when the extension was called Kitsune: its host is no longer used.
if [ -e "$dir/kitsune_github.json" ]; then
  rm "$dir/kitsune_github.json"
  echo "Removed the old $dir/kitsune_github.json"
fi

# Your live folders: names, containers and GitHub searches (see the example).
config="${XDG_CONFIG_HOME:-$HOME/.config}/tidier/live-folders.json"
old="${XDG_CONFIG_HOME:-$HOME/.config}/kitsune"
if [ ! -e "${config:h}" ] && [ -d "$old" ]; then
  mv "$old" "${config:h}"
  echo "Moved your live folders from $old to ${config:h}"
fi
if [ ! -e "$config" ]; then
  mkdir -p "${config:h}"
  cp "$here/live-folders.example.json" "$config"
  echo "Created $config from the example; edit it to set up your folders."
fi
