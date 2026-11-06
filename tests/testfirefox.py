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

Paths can be set with KITSUNE_FIREFOX, KITSUNE_SIDEBERY_XPI and KITSUNE_DOTFILES
(the CI workflow does); the defaults are your own Mac's.
  - Kitsune, from this folder (or a signed .xpi);
  - test tabs in each space: essentials, a folder with tabs in it, and
    ordinary tabs.

    with TestFirefox() as m:   # m is a Marionette client (chrome context)
        ...
"""
import glob
import json
import os
import shutil
import subprocess
import tempfile
import time
import zipfile

from marionette import FIREFOX, Marionette

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
DOTFILES = os.path.expanduser(os.environ.get("KITSUNE_DOTFILES", "~/src/private/dotfiles/home/firefox"))
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
    # Lets Kitsune be installed for real (not as a temporary add-on, which
    # Firefox removes when it quits) where Firefox allows unsigned add-ons:
    # Developer Edition and Nightly. Release Firefox ignores it.
    "xpinstall.signatures.required": False,
}


def sidebery_xpi():
    """Sidebery: KITSUNE_SIDEBERY_XPI (an .xpi, or a folder for a temporary add-on), as you have it installed, or downloaded."""
    if os.environ.get("KITSUNE_SIDEBERY_XPI"):
        return os.environ["KITSUNE_SIDEBERY_XPI"]
    found = glob.glob(os.path.expanduser(f"~/Library/Application Support/Firefox/Profiles/*.default-release/extensions/{SIDEBERY_ID}.xpi"))
    if found:
        return found[0]
    return downloaded_sidebery()


SIDEBERY_URL = "https://addons.mozilla.org/firefox/downloads/latest/sidebery/latest.xpi"
SIDEBERY_CACHE = os.path.expanduser("~/Library/Caches/kitsune/sidebery.xpi")


def downloaded_sidebery():
    """The newest Sidebery from addons.mozilla.org, as the CI workflow gets it.

    For a Mac where Firefox has no Sidebery of its own (a machine used only to
    work on Kitsune). Kept for a day, so a run of tests downloads it once.
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
    def __init__(self, xpi=None):
        self.xpi = xpi  # a signed Kitsune .xpi; default: this folder (installed for real where Firefox allows it)
        self.dir = self.proc = self.m = None

    def restart(self):
        """Quit the test Firefox and start it again with the same profile, so
        the session is restored. Only when Kitsune is installed for real
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
        if self.dir:
            shutil.rmtree(self.dir, ignore_errors=True)

    def _build_profile(self):
        self.dir = tempfile.mkdtemp(prefix="kitsune-test-")
        os.makedirs(f"{self.dir}/chrome")
        prefs = open(f"{DOTFILES}/user.js").read() + "\n// Test profile\n"
        prefs += "".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n" for k, v in TEST_PREFS.items())
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
        # The live folders' native host is a stand-in that answers from a file
        # the test writes (fake_github_host.py), never your gh login.
        os.makedirs(f"{self.dir}/managed/NativeMessagingHosts")
        json.dump({"name": "kitsune_github", "description": "test", "type": "stdio",
                   "path": os.path.join(HERE, "fake_github_host.py"), "allowed_extensions": [EXT_ID]},
                  open(f"{self.dir}/managed/NativeMessagingHosts/kitsune_github.json", "w"))
        self.fake_prs = f"{self.dir}/fake-prs.json"
        json.dump({}, open(self.fake_prs, "w"))

    def _start(self):
        env = {**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1", "MOZ_NO_REMOTE": "1", "KITSUNE_FAKE_PRS": self.fake_prs}
        self.proc = subprocess.Popen([FIREFOX, "--headless", "--marionette", "--no-remote", "--profile", self.dir],
                                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.m = Marionette(port=PORT, wait=60)
        self.m.fake_prs = self.fake_prs
        self.m.cmd("WebDriver:SetWindowRect", {"width": 1600, "height": 1000})

    def _setup(self):
        m = self.m
        m.js(USE_TEST_MANAGED_STORAGE, f"{self.dir}/managed")
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
                m.can_restart = False
                m.cmd("Addon:Install", {"path": EXT_DIR, "temporary": True})
        m.restart = self.restart
        time.sleep(8)  # Kitsune starts: essentials, tab sync, live folders

    def _unsigned_xpi(self):
        """This folder as an .xpi, without what is not part of the extension."""
        path = f"{self.dir}/kitsune.xpi"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for root, dirs, files in os.walk(EXT_DIR):
                dirs[:] = [d for d in dirs if root != EXT_DIR or d not in ("tests", "tools", "native", ".git", ".github")]
                for f in files:
                    full = os.path.join(root, f)
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
    type === "storage" || name === "kitsune_github" ? NativeManifests._tryPaths(type, name, [dir], context) : lookup(type, name, context);
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
# (which Kitsune reads), with Sidebery disabled meanwhile.
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
  // test's own setup going wrong, not Kitsune, so it is started again.
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
