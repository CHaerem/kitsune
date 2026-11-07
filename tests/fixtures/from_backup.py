#!/usr/bin/python3
"""Make the test fixtures from your own setup, without any addresses.

    tests/fixtures/from_backup.py [sidebery-backup.json]

Run it again when you change spaces or containers. It reads a Sidebery backup
(default: the newest in ~/Library/Application Support/Firefox/oppsett-backup)
and Firefox' containers.json, and writes:

  sidebery.json   – Sidebery's spaces, settings and containers; the rules with
                    an address (reopenRules, moveRules) are dropped.
                    Sidebery's CSS is not here: the tests take it from dotfiles.
  containers.json – the containers (colours, icons), from your profile.

Names are replaced by neutral ones ("Space 1", space ids "space1"), so the
fixtures say nothing about you; the tests only rely on which container
belongs to which space.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKUPS = os.path.expanduser("~/Library/Application Support/Firefox/oppsett-backup")
PROFILES = os.path.expanduser("~/Library/Application Support/Firefox/Profiles")

backup = sys.argv[1] if len(sys.argv) > 1 else max(glob.glob(f"{BACKUPS}/sidebery-*.json"), key=os.path.getmtime)
b = json.load(open(backup))
for c in b["containers"].values():
    c["reopenRules"] = []
    c["name"] = "Space " + c["id"].rsplit("-", 1)[-1]
# Space ids and names from the container each space opens new tabs in.
renamed = {}
for old, p in list(b["sidebar"]["panels"].items()):
    p["moveRules"] = [r for r in p.get("moveRules", []) if not r.get("url")]  # they hold addresses too
    n = p.get("newTabCtx", "").rsplit("-", 1)[-1]
    renamed[old] = new = f"space{n}" if n.isdigit() else old
    p.update(id=new, name=f"Space {n}" if n.isdigit() else p.get("name", ""))
b["sidebar"]["panels"] = {renamed[k]: p for k, p in b["sidebar"]["panels"].items()}
b["sidebar"]["nav"] = [renamed.get(x, x) for x in b["sidebar"]["nav"]]
fixture = json.dumps({k: b[k] for k in ("ver", "settings", "sidebar", "containers")}, ensure_ascii=False, indent=1)
for old, new in sorted(renamed.items(), key=lambda x: -len(x[0])):  # also ids derived from them
    fixture = fixture.replace(old, new)
open(f"{HERE}/sidebery.json", "w").write(fixture + "\n")

profile = glob.glob(f"{PROFILES}/*.default-release")[0]
containers = json.load(open(f"{profile}/containers.json"))
for c in containers["identities"]:
    if c.get("public") and c.get("name"):
        c["name"] = f"Space {c['userContextId']}"
json.dump(containers, open(f"{HERE}/containers.json", "w"), ensure_ascii=False, indent=1)
print(f"from {backup}: sidebery.json, containers.json")
