#!/usr/bin/python3 -I
"""A stand-in for native/github-prs.py, for the smoke test.

The test Firefox starts this instead of the real host (see testfirefox.py),
so the live folders are tested without your gh login or GitHub. It answers
from the file in TIDIER_FAKE_PRS, which the test rewrites between refreshes:

    {"folders": [{"id", "name", "container"}], "items": {"<folder id>": [{url, title, number, repo}]}}
"""
import json
import os
import struct
import sys


def main():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return
    (length,) = struct.unpack("@I", raw)
    msg = json.loads(sys.stdin.buffer.read(length))
    try:
        data = json.load(open(os.environ["TIDIER_FAKE_PRS"]))
    except (KeyError, OSError, ValueError):
        data = {}
    if "backup" in msg:
        json.dump(msg["backup"], open(os.environ["TIDIER_FAKE_PRS"] + ".copy", "w"))
        reply = {"saved": "copy"}
    elif msg.get("list"):
        reply = {"folders": data.get("folders", [])}
    elif msg.get("folder") in data.get("items", {}):
        reply = {"items": data["items"][msg["folder"]]}
    else:
        reply = {"error": "unknown folder"}
    out = json.dumps(reply).encode()
    sys.stdout.buffer.write(struct.pack("@I", len(out)) + out)
    sys.stdout.buffer.flush()


main()
