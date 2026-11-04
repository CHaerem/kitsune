"""An invisible Firefox with a throwaway profile, for the tests.

It never touches your own Firefox: it runs headless (no window, no focus, its
own clipboard), with its own profile and its own Marionette port, and is
deleted afterwards. The profile is built the same way every time, from:

  - dotfiles: user.js, userChrome.css, customKeys.json and Sidebery's CSS
    (sidebery.css), so the tests check the setup as dotfiles says it is;
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
}


def sidebery_xpi():
    """Sidebery: KITSUNE_SIDEBERY_XPI (an .xpi, or a folder for a temporary add-on), or as you have it installed."""
    if os.environ.get("KITSUNE_SIDEBERY_XPI"):
        return os.environ["KITSUNE_SIDEBERY_XPI"]
    found = glob.glob(os.path.expanduser(f"~/Library/Application Support/Firefox/Profiles/*.default-release/extensions/{SIDEBERY_ID}.xpi"))
    if not found:
        raise SystemExit("Sidebery not found in your Firefox profile")
    return found[0]


class TestFirefox:
    def __init__(self, xpi=None):
        self.xpi = xpi  # a signed Kitsune .xpi; default: this folder, as a temporary add-on
        self.dir = self.proc = self.m = None

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

    def _start(self):
        env = {**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1", "MOZ_NO_REMOTE": "1"}
        self.proc = subprocess.Popen([FIREFOX, "--headless", "--marionette", "--no-remote", "--profile", self.dir],
                                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.m = Marionette(port=PORT, wait=60)
        self.m.cmd("WebDriver:SetWindowRect", {"width": 1600, "height": 1000})

    def _setup(self):
        m = self.m
        sb = sidebery_xpi()  # a folder is loaded as a temporary add-on (e.g. a patched Sidebery)
        m.cmd("Addon:Install", {"path": sb, "temporary": os.path.isdir(sb)})
        time.sleep(4)
        fixture = json.load(open(f"{FIXTURES}/sidebery.json"))
        fixture["sidebarCSS"] = open(f"{DOTFILES}/sidebery.css").read()
        m.js(SETUP_SIDEBERY, SIDEBERY_ID, fixture, SIDEBERY_PERMISSIONS, SIDEBERY_SHORTCUTS)
        m.js(SEED_TABS, SIDEBERY_ID)
        if self.xpi:
            m.cmd("Addon:Install", {"path": os.path.abspath(self.xpi), "temporary": False})
        else:
            m.cmd("Addon:Install", {"path": EXT_DIR, "temporary": True})
        time.sleep(8)  # Kitsune starts: essentials, tab sync, live folders


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
  await sidebery.enable(); await wait(4000);
  await w.SidebarController.show("_3c078156-979c-498b-8990-85f7987dd929_-sidebar-action");
  // Close the start tab, so every tab is one of the test tabs.
  for (const t of [...gB.tabs]) if (!t.pinned && !/example\\.org|group\\.html/.test(t.linkedBrowser.currentURI.spec)) gB.removeTab(t);
  await wait(1500);
  return gB.tabs.length;
"""
