#!/usr/bin/env python3
"""Build, sign and release Tidier, so Firefox updates itself to it.

Run by .github/workflows/release.yml after the smoke test has passed on main.
Does nothing if no file that goes into the extension has changed since the
last release.

- Version: "major.minor" from manifest.json plus the number of commits, e.g.
  1.6.7. It grows with every commit, so every release has a new version
  (addons.mozilla.org, AMO, never accepts a version twice) without anyone
  bumping it. Change major.minor in manifest.json for bigger changes.
- Signing: Firefox only installs signed extensions. AMO signs it as
  "unlisted" (not published in its catalogue), with the API key in the
  secrets AMO_JWT_ISSUER and AMO_JWT_SECRET (tools/setup-amo-key.sh).
- Release: the signed .xpi and updates.json go on a GitHub Release (tag
  v<version>). manifest.json's update_url points at the latest release's
  updates.json, so Firefox finds and installs the new version by itself.

Re-running is safe: a version that AMO already has is not uploaded again,
and a version that already has a release is skipped.

  tools/release.py --dry-run DIR   build the .xpi and updates.json into DIR only
"""
import base64, hashlib, hmac, json, os, subprocess, sys, time, uuid, zipfile
import urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "CHaerem/tidier"
AMO = "https://addons.mozilla.org/api/v5"
# Everything in git goes into the extension, except these.
EXCLUDE = ("README.md", "FEATURES.md", "CLAUDE.md", ".gitignore", ".github/", "native/", "tests/", "tools/")
POLL_SECONDS, POLL_LIMIT_SECONDS = 10, 30 * 60  # AMO usually signs within minutes
GET_ATTEMPTS, GET_RETRY_SECONDS = 5, 30  # a passing fault at AMO must not end a 30-minute wait


def git(*args):
    return subprocess.run(["git", "-C", ROOT, *args], check=True, capture_output=True, text=True).stdout.strip()


def extension_files():
    return sorted(f for f in git("ls-files").splitlines() if not f.startswith(EXCLUDE))


def manifest():
    return json.load(open(os.path.join(ROOT, "manifest.json")))


def version():
    major_minor = ".".join(manifest()["version"].split(".")[:2])
    return f"{major_minor}.{git('rev-list', '--count', 'HEAD')}"


def last_release_tag():
    tags = git("tag", "--list", "v*", "--sort=-v:refname").splitlines()
    return tags[0] if tags else None


def changed_since(tag):
    if tag is None:
        return True
    changed = git("diff", "--name-only", tag, "HEAD").splitlines()
    return any(not f.startswith(EXCLUDE) for f in changed)


def build(out_dir, ver):
    """The .xpi, with the version filled in. Same input gives the same bytes."""
    path = os.path.join(out_dir, f"tidier-{ver}.xpi")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in extension_files():
            data = open(os.path.join(ROOT, f), "rb").read()
            if f == "manifest.json":
                m = json.loads(data)
                m["version"] = ver
                data = (json.dumps(m, indent=2, ensure_ascii=False) + "\n").encode()
            z.writestr(zipfile.ZipInfo(f, date_time=(1980, 1, 1, 0, 0, 0)), data, zipfile.ZIP_DEFLATED)
    return path


def updates_json(out_dir, ver):
    """What Firefox reads from update_url."""
    gecko_id = manifest()["browser_specific_settings"]["gecko"]["id"]
    link = f"https://github.com/{REPO}/releases/download/v{ver}/tidier-{ver}.xpi"
    path = os.path.join(out_dir, "updates.json")
    json.dump({"addons": {gecko_id: {"updates": [{"version": ver, "update_link": link}]}}}, open(path, "w"), indent=2)
    return path


# --- addons.mozilla.org ----------------------------------------------------

def jwt():
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
    now = int(time.time())
    claims = {"iss": os.environ["AMO_JWT_ISSUER"], "jti": str(uuid.uuid4()), "iat": now, "exp": now + 60}
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()) + b"." + b64(json.dumps(claims).encode())
    sig = hmac.new(os.environ["AMO_JWT_SECRET"].encode(), head, hashlib.sha256).digest()
    return (head + b"." + b64(sig)).decode()


def amo(method, url, json_body=None, form=None, file=None, raw=False):
    """One AMO request with a fresh token (a token lives one minute here).

    A GET is tried again if AMO has a passing fault: release.py is run once per
    release, and without this one bad answer while polling loses the release.
    Anything else is not tried again: a POST could upload the version twice.
    """
    for attempt in range(1, GET_ATTEMPTS + 1 if method == "GET" else 2):
        try:
            return amo_once(method, url, json_body, form, file, raw)
        except (urllib.error.URLError, TimeoutError) as e:  # HTTPError (a URLError) only for 5xx, see amo_once
            if attempt == (GET_ATTEMPTS if method == "GET" else 1):
                raise SystemExit(f"AMO {method} {url}: {e}")
            print(f"AMO {method} {url}: {e}; trying again in {GET_RETRY_SECONDS} s")
            time.sleep(GET_RETRY_SECONDS)


def amo_once(method, url, json_body, form, file, raw):
    headers = {"Authorization": f"JWT {jwt()}"}
    body = None
    if file:
        boundary = uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in (form or {}).items()]
        name = os.path.basename(file)
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="upload"; filename="{name}"\r\n'
                     f"Content-Type: application/x-xpinstall\r\n\r\n".encode() + open(file, "rb").read() + b"\r\n")
        body = b"".join(parts) + f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url if url.startswith("https:") else AMO + url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404 and method == "GET":
            return None
        if e.code >= 500:
            raise
        raise SystemExit(f"AMO {method} {url}: HTTP {e.code}: {e.read().decode(errors='replace')[:2000]}")
    return data if raw else json.loads(data)


def poll(what, fetch, done):
    deadline = time.time() + POLL_LIMIT_SECONDS
    while True:
        value = fetch()
        if done(value):
            return value
        if time.time() > deadline:
            raise SystemExit(f"AMO: {what} not done after {POLL_LIMIT_SECONDS // 60} minutes")
        time.sleep(POLL_SECONDS)


def sign(xpi, ver, out_dir):
    """The signed .xpi from AMO."""
    if not (os.environ.get("AMO_JWT_ISSUER") and os.environ.get("AMO_JWT_SECRET")):
        raise SystemExit("No AMO API key: run tools/setup-amo-key.sh once (see its first lines)")
    gecko_id = manifest()["browser_specific_settings"]["gecko"]["id"]
    versions = f"/addons/addon/{gecko_id}/versions/"
    existing = amo("GET", f"{versions}v{ver}/")
    if existing:
        print(f"AMO already has {ver}; downloading it")
        version_id = existing["id"]
    else:
        upload = amo("POST", "/addons/upload/", form={"channel": "unlisted"}, file=xpi)
        upload = poll("validation", lambda: amo("GET", f"/addons/upload/{upload['uuid']}/"), lambda u: u["processed"])
        if not upload["valid"]:
            msgs = [m.get("message") for m in upload.get("validation", {}).get("messages", []) if m.get("type") == "error"]
            raise SystemExit("AMO rejected the upload:\n- " + "\n- ".join(msgs or ["(no message)"]))
        version_id = amo("POST", versions, json_body={"upload": upload["uuid"]})["id"]
    version = poll("signing", lambda: amo("GET", f"{versions}{version_id}/"), lambda v: v["file"]["status"] != "unreviewed")
    if version["file"]["status"] != "public":
        raise SystemExit(f"AMO did not sign {ver}: file status {version['file']['status']}")
    signed = os.path.join(out_dir, f"tidier-{ver}.xpi")
    open(signed, "wb").write(amo("GET", version["file"]["url"], raw=True))
    return signed


# --- GitHub ----------------------------------------------------------------

def release(ver, files, tag):
    commits = git("log", "--format=- %s", f"{tag}..HEAD" if tag else "HEAD")
    subprocess.run(["gh", "release", "create", f"v{ver}", *files, "--repo", REPO, "--target", git("rev-parse", "HEAD"),
                    "--title", f"Tidier {ver}", "--notes", commits or "-", "--latest"], check=True)


def main():
    ver = version()
    if len(sys.argv) == 3 and sys.argv[1] == "--dry-run":
        out = sys.argv[2]
        os.makedirs(out, exist_ok=True)
        print(build(out, ver)); print(updates_json(out, ver))
        return
    tag = last_release_tag()
    as_tuple = lambda v: tuple(int(p) for p in v.lstrip("v").split("."))
    if tag and as_tuple(ver) <= as_tuple(tag):
        # Already released, or an older commit finishing after a newer one.
        print(f"{ver} is not newer than the last release {tag}; no release"); return
    if not changed_since(tag):
        print(f"Nothing in the extension has changed since {tag}; no release"); return
    out = os.environ.get("RUNNER_TEMP") or os.path.join(ROOT, "web-ext-artifacts")
    os.makedirs(out, exist_ok=True)
    unsigned_dir = os.path.join(out, "unsigned")
    os.makedirs(unsigned_dir, exist_ok=True)
    signed = sign(build(unsigned_dir, ver), ver, out)
    release(ver, [signed, updates_json(out, ver)], tag)
    print(f"Released Tidier {ver}")


if __name__ == "__main__":
    main()
