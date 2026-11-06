"""An invisible Firefox with a throwaway profile, for the tests.

It never touches your own Firefox: it runs headless (no window, no focus, its
own clipboard), with its own profile and its own Marionette port, and is
deleted afterwards. The profile is built the same way every time, from:

  - dotfiles: user.js, userChrome.css, customKeys.json, and Sidebery's CSS
    and settings (sidebery.css, sidebery-settings.json) given to Sidebery as
    managed storage the way dotfiles does, so the tests check the setup as
    dotfiles says it is;
  - tests/fixtures: Sidebery's spaces and settings, and the containers
    (tests/fixtures/from_backup.py makes them from your own setup);
  - Sidebery, with the permissions and ⌃1/⌃2/⌃3 shortcuts you have;

Paths can be set with TIDIER_FIREFOX, TIDIER_SIDEBERY_XPI and TIDIER_DOTFILES
(the CI workflow does); the defaults are your own Mac's.
  - Tidier, from this folder (or a signed .xpi);
  - test tabs in each space: essentials, a folder with tabs in it, and
    ordinary tabs.

    with TestFirefox() as m:   # m is a Marionette client (chrome context)
        ...
"""
import glob
import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import zipfile

from marionette import FIREFOX, Marionette

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
DOTFILES = os.path.expanduser(os.environ.get("TIDIER_DOTFILES", "~/src/private/dotfiles/home/firefox"))
EXT_ID = "{6844a953-9931-4334-9ff6-257c246485cb}"
SIDEBERY_ID = "{3c078156-979c-498b-8990-85f7987dd929}"
PORT = 2829  # not 2828, which your own Firefox would use for Marionette

# The same as in your profile: Sidebery's optional permissions (needed to
# reopen tabs in the right container) and its shortcuts for the spaces.
SIDEBERY_PERMISSIONS = {"permissions": ["webRequest", "webRequestBlocking", "proxy"], "origins": ["<all_urls>"]}
SIDEBERY_SHORTCUTS = {"switch_to_panel_0": "MacCtrl+1", "switch_to_panel_1": "MacCtrl+2", "switch_to_panel_2": "MacCtrl+3"}

# Test prefs on top of dotfiles' user.js: no first-run pages, no updates or
# telemetry, Marionette on its own port.
TEST_PREFS = {
    "marionette.port": PORT,
    "browser.shell.checkDefaultBrowser": False,
    "browser.aboutwelcome.enabled": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "startup.homepage_welcome_url": "",
    "browser.sessionstore.resume_from_crash": False,
    "app.update.disabledForTesting": True,
    "datareporting.policy.dataSubmissionEnabled": False,
    "extensions.update.enabled": False,
    # Lets Tidier be installed for real (not as a temporary add-on, which
    # Firefox removes when it quits) where Firefox allows unsigned add-ons:
    # Developer Edition and Nightly. Release Firefox ignores it.
    "xpinstall.signatures.required": False,
    # A page's leave-page handler counts without real user input (see PAGES).
    "dom.require_user_interaction_for_beforeunload": False,
}

# Test pages served from here: what no public test page does, and no dependence on
# a site for the checks that use them.
PAGES = {
    "/unsaved": "<title>Unsaved</title><script>onbeforeunload = e => { e.preventDefault(); return 'unsaved'; };</script>unsaved input",
    "/ticking": "<title>0</title><script>let n = 0; setInterval(() => { document.title = String(++n); }, 200);</script>a title that ticks",
}


def serve_pages():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = PAGES.get(self.path.split("?")[0])
            self.send_response(200 if body else 404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write((body or "").encode())

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def sidebery_xpi():
    """Sidebery: TIDIER_SIDEBERY_XPI (an .xpi, or a folder for a temporary add-on), as you have it installed, or downloaded."""
    if os.environ.get("TIDIER_SIDEBERY_XPI"):
        return os.environ["TIDIER_SIDEBERY_XPI"]
    found = glob.glob(os.path.expanduser(f"~/Library/Application Support/Firefox/Profiles/*.default-release/extensions/{SIDEBERY_ID}.xpi"))
    if found:
        return found[0]
    return downloaded_sidebery()


SIDEBERY_URL = "https://addons.mozilla.org/firefox/downloads/latest/sidebery/latest.xpi"
SIDEBERY_CACHE = os.path.expanduser("~/Library/Caches/tidier/sidebery.xpi")


def downloaded_sidebery():
    """The newest Sidebery from addons.mozilla.org, as the CI workflow gets it.

    For a Mac where Firefox has no Sidebery of its own (a machine used only to
    work on Tidier). Kept for a day, so a run of tests downloads it once.
    """
    fresh = os.path.exists(SIDEBERY_CACHE) and time.time() - os.path.getmtime(SIDEBERY_CACHE) < 86400
    if not fresh:
        import urllib.request
        os.makedirs(os.path.dirname(SIDEBERY_CACHE), exist_ok=True)
        tmp = SIDEBERY_CACHE + ".part"
        try:
            urllib.request.urlretrieve(SIDEBERY_URL, tmp)
        except OSError as e:
            if not os.path.exists(SIDEBERY_CACHE):
                raise SystemExit(f"Sidebery not found in your Firefox profile, and the download failed: {e}")
        else:
            os.replace(tmp, SIDEBERY_CACHE)
    return SIDEBERY_CACHE


class TestFirefox:
    def __init__(self, xpi=None, port=PORT, alone=False):
        self.xpi = xpi  # a signed Tidier .xpi; default: this folder (installed for real where Firefox allows it)
        self.port = port  # each test Firefox running at the same time needs its own
        self.alone = alone  # Tidier alone (PLAN.md): no Sidebery, and the setting declared in managed storage
        self.dir = self.proc = self.m = self.pages = None

    def restart(self):
        """Quit the test Firefox and start it again with the same profile, so
        the session is restored. Only when Tidier is installed for real
        (m.can_restart): a temporary add-on is gone after a restart. The same
        Marionette object is kept, connected to the new Firefox."""
        self.m.quit()
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(10)
        m = self.m
        self._start()
        m.__dict__.update(self.m.__dict__)
        self.m = m
        self.m.js(USE_TEST_MANAGED_STORAGE, f"{self.dir}/managed")

    def __enter__(self):
        try:
            self._build_profile()
            self._start()
            self._setup()
        except BaseException:
            self.__exit__()
            raise
        return self.m

    def __exit__(self, *exc):
        if self.m:
            self.m.quit()
        if self.proc:
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.pages:
            self.pages.shutdown()
        if self.dir:
            shutil.rmtree(self.dir, ignore_errors=True)

    def _build_profile(self):
        self.dir = tempfile.mkdtemp(prefix="tidier-test-")
        os.makedirs(f"{self.dir}/chrome")
        prefs = open(f"{DOTFILES}/user.js").read() + "\n// Test profile\n"
        prefs += "".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n" for k, v in {**TEST_PREFS, "marionette.port": self.port}.items())
        open(f"{self.dir}/user.js", "w").write(prefs)
        shutil.copy(f"{DOTFILES}/userChrome.css", f"{self.dir}/chrome/userChrome.css")
        shutil.copy(f"{DOTFILES}/customKeys.json", f"{self.dir}/customKeys.json")
        shutil.copy(f"{FIXTURES}/containers.json", f"{self.dir}/containers.json")
        # Sidebery's managed storage, built like dotfiles' home/firefox.nix does.
        os.makedirs(f"{self.dir}/managed/ManagedStorage")
        json.dump({"name": SIDEBERY_ID, "description": "test", "type": "storage", "data": {
            "settings": json.load(open(f"{DOTFILES}/sidebery-settings.json")),
            "sidebarCSS": open(f"{DOTFILES}/sidebery.css").read(),
        }}, open(f"{self.dir}/managed/ManagedStorage/{SIDEBERY_ID}.json", "w"))
        # Tidier's sidebar look (tidier.css), the same way, where dotfiles has one.
        tidier = {"tidierAlone": True} if self.alone else {}
        if os.path.exists(f"{DOTFILES}/tidier.css"):
            tidier["sidebarCSS"] = open(f"{DOTFILES}/tidier.css").read()
        json.dump({"name": EXT_ID, "description": "test", "type": "storage", "data": tidier},
                  open(f"{self.dir}/managed/ManagedStorage/{EXT_ID}.json", "w"))
        # The live folders' native host is a stand-in that answers from a file
        # the test writes (fake_github_host.py), never your gh login.
        os.makedirs(f"{self.dir}/managed/NativeMessagingHosts")
        json.dump({"name": "tidier_github", "description": "test", "type": "stdio",
                   "path": os.path.join(HERE, "fake_github_host.py"), "allowed_extensions": [EXT_ID]},
                  open(f"{self.dir}/managed/NativeMessagingHosts/tidier_github.json", "w"))
        self.fake_prs = f"{self.dir}/fake-prs.json"
        json.dump({}, open(self.fake_prs, "w"))

    def _start(self):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                # Two runs on one port get in each other's way, and only show as
                # connections that break; say so instead.
                raise SystemExit(f"Port {self.port} is in use: is another smoke test running? (--port for --only and --serial)")
        env = {**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1", "MOZ_NO_REMOTE": "1", "TIDIER_FAKE_PRS": self.fake_prs}
        log = f"{self.dir}/firefox.log"
        with open(log, "ab") as out:
            self.proc = subprocess.Popen([FIREFOX, "--headless", "--marionette", "--no-remote", "--profile", self.dir],
                                         env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            self.m = Marionette(port=self.port, wait=60, alive=lambda: self.proc.poll() is None)
        except OSError as err:
            # Without Firefox's own words this is only "Connection refused".
            lines = open(log, errors="replace").read().strip().splitlines()[-15:]
            raise SystemExit(f"The test Firefox did not start ({err}). What it said:\n" + "\n".join(lines))
        self.m.fake_prs = self.fake_prs
        if not self.pages:
            self.pages = serve_pages()
        self.m.pages = f"http://127.0.0.1:{self.pages.server_address[1]}"
        self.m.update_xpi = self._newer_xpi
        self.m.cmd("WebDriver:SetWindowRect", {"width": 1600, "height": 1000})

    def _setup(self):
        m = self.m
        m.js(USE_TEST_MANAGED_STORAGE, f"{self.dir}/managed")
        if self.alone:
            m.js(SEED_TABS_ALONE)
        else:
            sb = sidebery_xpi()  # a folder is loaded as a temporary add-on (e.g. a patched Sidebery)
            m.cmd("Addon:Install", {"path": sb, "temporary": os.path.isdir(sb)})
            time.sleep(4)
            fixture = json.load(open(f"{FIXTURES}/sidebery.json"))
            m.js(SETUP_SIDEBERY, SIDEBERY_ID, fixture, SIDEBERY_PERMISSIONS, SIDEBERY_SHORTCUTS)
            seed = m.js(SEED_TABS, SIDEBERY_ID)
            if seed["restarts"] or seed["misplaced"]:
                # Shown so a setup that often needs it is noticed; the checks run either way.
                print(f"(setup: Sidebery started again {seed['restarts']}x for tabs in the wrong space; {seed['misplaced']} still are)", flush=True)
        m.can_restart = True
        if self.xpi:
            m.cmd("Addon:Install", {"path": os.path.abspath(self.xpi), "temporary": False})
        else:
            try:
                m.cmd("Addon:Install", {"path": self._unsigned_xpi(), "temporary": False})
            except RuntimeError:  # release Firefox: signed add-ons only
                if os.environ.get("TIDIER_MUST_RESTART"):  # where it should work: else the restart checks would just not run
                    raise
                m.can_restart = False
                m.cmd("Addon:Install", {"path": EXT_DIR, "temporary": True})
        m.restart = self.restart
        time.sleep(8)  # Tidier starts: essentials, tab sync, live folders
        if self.alone:
            m.js(AFTER_TIDIER_ALONE, EXT_ID)
        else:
            # Tidier's sidebar opens by itself when installed, as a sidebar does; here Sidebery stays the sidebar.
            m.js('await Services.wm.getMostRecentWindow("navigator:browser").SidebarController.show("_3c078156-979c-498b-8990-85f7987dd929_-sidebar-action"); return 1;')

    def _newer_xpi(self):
        """This folder as an .xpi with a higher version than the installed one, to update to."""
        return self._unsigned_xpi(version="1.6.999999", name="tidier-newer.xpi")

    def _unsigned_xpi(self, version=None, name="tidier.xpi"):
        """This folder as an .xpi, without what is not part of the extension."""
        path = f"{self.dir}/{name}"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for root, dirs, files in os.walk(EXT_DIR):
                dirs[:] = [d for d in dirs if root != EXT_DIR or d not in ("tests", "tools", "native", ".git", ".github", ".claude")]
                for f in files:
                    if root == EXT_DIR and f.endswith(".md"):  # as tools/release.py leaves them out
                        continue
                    full = os.path.join(root, f)
                    if version and full == os.path.join(EXT_DIR, "manifest.json"):
                        z.writestr("manifest.json", json.dumps({**json.load(open(full)), "version": version}))
                    else:
                        z.write(full, os.path.relpath(full, EXT_DIR))
        return path


# Firefox reads managed storage files and native hosts only from your own
# ~/Library (it ignores HOME), so the test Firefox is pointed at the profile's
# copies instead: Sidebery's managed storage and the live folders' stand-in
# host. Other lookups are left alone.
USE_TEST_MANAGED_STORAGE = """
  const [dir] = args;
  const {NativeManifests} = ChromeUtils.importESModule("resource://gre/modules/NativeManifests.sys.mjs");
  await NativeManifests.init();
  const lookup = NativeManifests._lookup;
  NativeManifests._lookup = (type, name, context) =>
    type === "storage" || name === "tidier_github" ? NativeManifests._tryPaths(type, name, [dir], context) : lookup(type, name, context);
"""

# Tidier alone: the same test tabs as below, in each space, and no Sidebery. Folders
# are not seeded: they are made through the sidebar by the checks themselves.
SEED_TABS_ALONE = """
  const {setTimeout: sT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const w = Services.wm.getMostRecentWindow("navigator:browser"), gB = w.gBrowser;
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  for (const ctx of [1, 2, 3]) {
    for (const i of [1, 2]) {
      const e = gB.addTrustedTab("https://example.org/?fixture-essential-" + ctx + "-" + i, {userContextId: ctx, inBackground: true});
      await wait(300); gB.pinTab(e);
    }
    for (const i of [1, 2]) { gB.addTrustedTab("https://example.org/?fixture-tab-" + ctx + "-" + i, {userContextId: ctx, inBackground: true}); await wait(300); }
  }
  await wait(1000);
  for (const t of [...gB.tabs]) if (!t.pinned && !/example\\.org/.test(t.linkedBrowser.currentURI.spec)) gB.removeTab(t);
  await wait(500);
  return 1;
"""

# What you click once in the sidebar, the same way (permissions.request needs a
# click, which a test has no way to make), and Tidier's sidebar shown.
AFTER_TIDIER_ALONE = """
  const [id] = args;
  const {ExtensionPermissions} = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
  const ext = WebExtensionPolicy.getByID(id).extension;
  await ExtensionPermissions.add(id, {permissions: ["tabHide"], origins: []}, ext);
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  await w.SidebarController.show("_6844a953-9931-4334-9ff6-257c246485cb_-sidebar-action");
  return 1;
"""

# Sidebery: permissions, shortcuts, and the fixture written to its storage
# while it is disabled (it keeps its settings in memory while it runs).
SETUP_SIDEBERY = """
  const [SB, fixture, permissions, shortcuts] = args;
  const {setTimeout: sT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const {ExtensionStorageIDB} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const {ExtensionPermissions} = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
  await ExtensionPermissions.add(SB, permissions);
  const ext = WebExtensionPolicy.getByID(SB).extension;
  for (const [name, shortcut] of Object.entries(shortcuts)) await ext.shortcuts.updateCommand({name, shortcut});
  const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(ext));
  const addon = await AddonManager.getAddonByID(SB);
  await addon.disable(); await wait(1000);
  await db.set(fixture);
  await addon.enable(); await wait(4000);
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  await w.SidebarController.show("_3c078156-979c-498b-8990-85f7987dd929_-sidebar-action");
  await wait(2000);
  return 1;
"""

# Test tabs in each space (container 1, 2, 3): two essentials, a folder with
# two tabs in it, and two ordinary tabs. Sidebery puts each tab in its
# container's space. A folder's tabs are put in it the way Sidebery stores its
# tree (parentId in its tab data, read when it starts) and opener = folder
# (which Tidier reads), with Sidebery disabled meanwhile.
SEED_TABS = """
  const [SB] = args;
  const {setTimeout: sT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tabId = t => ExtensionParent.apiManager.global.tabTracker.getId(t);
  const w = Services.wm.getMostRecentWindow("navigator:browser"), gB = w.gBrowser;
  const uuid = JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[SB];
  const key = "extension:" + SB + ":data";
  const folders = [];
  for (const ctx of [1, 2, 3]) {
    for (const i of [1, 2]) {
      const e = gB.addTrustedTab("https://example.org/?fixture-essential-" + ctx + "-" + i, {userContextId: ctx, inBackground: true});
      await wait(300); gB.pinTab(e);
    }
    const group = gB.addTrustedTab("moz-extension://" + uuid + "/sidebery/group.html#Fixture%20folder%20" + ctx, {userContextId: ctx, inBackground: true});
    await wait(800);
    const children = [];
    for (const i of [1, 2]) {
      children.push(gB.addTrustedTab("https://example.org/?fixture-in-folder-" + ctx + "-" + i, {userContextId: ctx, inBackground: true}));
      await wait(300);
    }
    for (const i of [1, 2]) { gB.addTrustedTab("https://example.org/?fixture-tab-" + ctx + "-" + i, {userContextId: ctx, inBackground: true}); await wait(300); }
    folders.push([group, children]);
  }
  await wait(3000);
  const sidebery = await AddonManager.getAddonByID(SB);
  await sidebery.disable(); await wait(1000);
  for (const [group, children] of folders) {
    for (const c of children) {
      const d = JSON.parse(w.SessionStore.getCustomTabValue(c, key) || "{}");
      Object.assign(d, {id: tabId(c), parentId: tabId(group), folded: false});
      w.SessionStore.setCustomTabValue(c, key, JSON.stringify(d));
      c.openerTab = group;
    }
  }
  // Sidebery reads the tree when it starts. Now and then (seen on GitHub) it
  // starts with a whole space's tabs in the space before it; that is the
  // test's own setup going wrong, not Tidier, so it is started again.
  const {ExtensionStorageIDB} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const misplaced = async () => {
    const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID(SB).extension));
    const panelFor = {};
    for (const p of Object.values((await db.get(["sidebar"])).sidebar.panels)) if (p.type === 2 && p.newTabCtx && p.newTabCtx !== "none") panelFor[p.newTabCtx] = p.id;
    return gB.tabs.filter(t => {
      const want = panelFor[t.userContextId ? "firefox-container-" + t.userContextId : "firefox-default"];
      const got = JSON.parse(w.SessionStore.getCustomTabValue(t, key) || "{}").panelId;
      return want && got && got !== want;
    }).length;
  };
  await sidebery.enable(); await wait(4000);
  let restarts = 0;
  for (; restarts < 3 && await misplaced(); restarts++) { await sidebery.disable(); await wait(1000); await sidebery.enable(); await wait(4000); }
  await w.SidebarController.show("_3c078156-979c-498b-8990-85f7987dd929_-sidebar-action");
  // Close the start tab, so every tab is one of the test tabs.
  for (const t of [...gB.tabs]) if (!t.pinned && !/example\\.org|group\\.html/.test(t.linkedBrowser.currentURI.spec)) gB.removeTab(t);
  await wait(1500);
  return {restarts, misplaced: await misplaced()};
"""
