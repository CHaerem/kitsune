#!/usr/bin/python3
# Native messaging host for Tidier's live folders.
#
# The folders are set up in a local file, not in the extension or this
# repository: $XDG_CONFIG_HOME/tidier/live-folders.json (default
# ~/.config/tidier/), see live-folders.example.json. The extension can
# ask for the list of folders ({"list": true}) and for one folder's pull
# requests ({"folder": id}); it cannot run any other search or gh command, and
# no GitHub token ever reaches the browser. The search runs with the gh CLI
# and your existing gh login.
#
# Installed for Firefox by install.sh.
import getpass
import json
import os
import shutil
import struct
import subprocess
import sys

CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "tidier", "live-folders.json")
# Every folder shows open pull requests you are involved in, within its search.
BASE = "is:open is:pr archived:false (review-requested:@me OR author:@me OR assignee:@me)"
JQ = '[.items[] | {url: .html_url, title, number, draft, repo: (.repository_url | split("/") | .[-1])}]'


def folders():
    try:
        items = json.load(open(CONFIG))
    except FileNotFoundError:
        return []
    ok = lambda f: all(isinstance(f.get(k), str) and f[k] for k in ("id", "name", "container", "search"))
    return [f for f in items if ok(f) and f["container"].startswith("firefox-")]


def gh():
    # Firefox starts the host with a short PATH; look where gh is usually installed too.
    extra = ["/opt/homebrew/bin", "/usr/local/bin", f"/etc/profiles/per-user/{getpass.getuser()}/bin",
             os.path.expanduser("~/.nix-profile/bin"), "/run/current-system/sw/bin"]
    return shutil.which("gh", path=os.pathsep.join([os.environ.get("PATH", ""), *extra]))


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return {}
    (length,) = struct.unpack("@I", raw)
    return json.loads(sys.stdin.buffer.read(length))


def send(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("@I", len(data)) + data)
    sys.stdout.buffer.flush()


def main():
    msg = read_message()
    if msg.get("list"):
        send({"folders": [{k: f[k] for k in ("id", "name", "container")} for f in folders()]})
        return
    folder = next((f for f in folders() if f["id"] == msg.get("folder")), None)
    if not folder:
        send({"error": "unknown folder"})
        return
    if not gh():
        send({"error": "gh not found"})
        return
    try:
        result = subprocess.run(
            [gh(), "api", "-X", "GET", "search/issues", "-f", f"q={BASE} {folder['search']}",
             "-f", "advanced_search=true", "-f", "per_page=100", "--jq", JQ],
            capture_output=True, text=True, timeout=30,
        )
    except Exception as err:  # timeout, ...
        send({"error": str(err)[:300]})
        return
    if result.returncode != 0:
        send({"error": result.stderr.strip()[:300]})
    else:
        send({"items": json.loads(result.stdout or "[]")})


main()
