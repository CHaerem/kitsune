#!/usr/bin/python3
"""A long run in a real Firefox: Tidier used at random, checked as it goes.

    tests/soak.py                        # with Sidebery, 5 minutes, a random seed
    tests/soak.py --alone                # Tidier alone (no Sidebery)
    tests/soak.py --alone --minutes 30 --seed 7 --port 4410

The chaos test (tests/chaos.test.mjs) does this on a fake Firefox, fast. This does
it in the real one, slowly, for what a fake cannot show: timing, Firefox's own
events, a real sidebar, memory. It runs in the test Firefox only (testfirefox.py:
headless, a throwaway profile, its own port), never your own.

From a seed it opens, closes and selects tabs, makes and closes windows, pins,
moves, opens links from "other apps", reopens what was closed, tears tabs off into
new windows and clicks and drags in Tidier's real sidebar in every window. The seed
decides the choices; timing and Firefox do the rest, so a seed makes a similar run,
not the same one. Every --every seconds (a minute) it lets Tidier go quiet and checks
what must always hold, in the real browser:

  - every synced tab has one live tab and one representation in every window;
  - no synced tab, essential or folder is gone unless you closed or deleted it;
  - every window has every essential, once, in the list's order;
  - every tab is in its space, and only the active space is shown;
  - the sidebar shows exactly what the window has;
  - placeholders are unloaded, and a page is loaded only once;
  - no selected tab is left blank in the window you are using;
  - no error inside Tidier (`problems`), or in the browser console from its pages.

A violation counts only if it is still there after waiting: Tidier is allowed to be
on its way. Each sample records the extension process's memory and CPU and how many
jobs ran. At the end it prints a table, and fails on any violation, on memory that
grows steadily, on a list in memory that outgrows the tabs there are, or on Tidier
not doing nothing when nothing happens.
"""
import argparse
import http.server
import os
import random
import statistics
import sys
import tempfile
import threading
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testfirefox import EXT_ID, PORT, SIDEBERY_ID, TestFirefox  # noqa: E402

# How much is going on: it keeps to about this many tabs, so that memory can be
# compared over time. Tabs and windows open and close around these numbers.
MAX_TABS, MIN_TABS = 36, 10
MAX_ESSENTIALS, MIN_ESSENTIALS = 10, 2
MAX_WINDOWS = 4
SETTLE_LIMIT_S = 60       # Tidier has this long to go quiet; longer is a violation
VIOLATION_WAIT_S = 25     # and a broken promise this long to mend itself
MEMORY_WARMUP = 2         # samples left out of the memory verdict: start-up, not growth
GROWTH_MIN_MB = 30        # steady growth smaller than this is noise
GROWTH_MIN_SHARE = 0.15   # as is growth smaller than this share of the whole
SPARE_ENTRIES = 25        # what a list in memory may hold beyond the tabs and windows there are


# Sidebery alone decides these, and they are counted, not failed: what a real tab's space
# is once Sidebery has put it somewhere is out of Tidier's hands (README, "Tabs in the wrong
# space"), and this is not the setup Tidier is going to. The pin race is reported upstream
# (KNOWN_SIDEBERY_BUGS in smoke.py). In a soak, windows and tabs come and go faster than its
# sidebar settles them; tools/fix_spaces.py exists for the daily browser.
SIDEBERY_SAYS = {"an essential is in another space (pin race)", "a tab is in another space"}


def grows_steadily(samples):
    """Whether memory (a list, one number per sample) grows steadily.

    By thirds: Firefox's memory goes up and down by tens of megabytes with what it
    happens to do, and a single high sample means nothing. It must be higher in each
    third than in the one before, by more than noise, and the middle of the run must
    show it too (a jump at one moment, and flat from there on, is not a leak).
    """
    samples = samples[MEMORY_WARMUP:]
    if len(samples) < 3:
        return False
    third = len(samples) // 3 or 1
    a = statistics.median(samples[:third])
    b = statistics.median(samples[third:-third] or samples[third:third + 1])
    c = statistics.median(samples[-third:])
    return a < b < c and c - a >= max(GROWTH_MIN_MB, GROWTH_MIN_SHARE * a) and min(b - a, c - b) >= 0.1 * (c - a)


assert not grows_steadily([200, 300, 300, 310, 305, 300, 308])  # a jump, then flat
assert grows_steadily([200, 200, 300, 340, 380, 420, 460, 500, 540])
assert not grows_steadily([200, 200, 300, 310, 305, 312, 309, 311, 310])  # noise
assert not grows_steadily([200, 300])  # too few to say


# What the pages do is the test's own, so no action depends on a site being up, and
# each address is used once: two synced tabs with one address are a tab doubled.
class Pages(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/favicon.ico":
            self.send_response(404)
            self.end_headers()
            return
        icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' fill='%23396'/></svg>"
        if path.startswith("/tick/"):
            body = "<title>0</title><script>let n = 0; setInterval(() => { document.title = String(++n); }, 300);</script>a title that ticks"
        else:
            body = f"<title>Page {path.rsplit('/', 1)[-1]}</title><link rel=icon href=\"{icon}\">a page"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


def serve_pages():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Pages)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


# A frame script in one of Tidier's own pages: the only way into the real sidebar
# from a test, which Marionette does not list as a window. It is one fixed script,
# loaded once per page: a new script per call would be compiled and kept by the
# extension's process, and show up here as the memory growth this test looks for.
AGENT = r"""(() => {
  const doc = () => content.document, q = s => doc().querySelector(s);
  const qs = s => [...doc().querySelectorAll(s)];
  const page = () => content.wrappedJSObject;
  const tabIds = s => qs(s).map(e => Number(e.dataset.tab));
  const later = ms => new Promise(r => content.setTimeout(r, ms));
  const mouse = (e, type, more = {}) => e.dispatchEvent(new content.MouseEvent(type, {bubbles: true, cancelable: true, ...more}));
  const cmds = {
    ask: async ({msg}) => {
      const reply = await page().browser.runtime.sendMessage(Components.utils.cloneInto(msg, content));
      return JSON.parse(page().JSON.stringify(reply ?? null));
    },
    popup: async ({url}) => {
      await page().browser.windows.create(Components.utils.cloneInto({type: "popup", url, width: 320, height: 240}, content));
      return 1;
    },
    view: () => ({
      space: doc().documentElement.dataset.space || null,
      tiles: tabIds("#essentials .tile"),
      plain: tabIds("#tabs > .tab"),
      folders: qs("#tabs .folder").map(f => ({
        key: f.dataset.key, name: f.querySelector(".head .title")?.textContent ?? "", live: f.classList.contains("live"),
        collapsed: f.classList.contains("collapsed"), tabs: [...f.querySelectorAll(".tab")].map(r => Number(r.dataset.tab)),
      })),
      spaces: qs("#spaces .space").map(s => s.dataset.space),
      renaming: !!q(".rename"),
    }),
    click: ({sel}) => { const e = q(sel); if (!e) return false; e.click(); return true; },
    middle: ({sel}) => { const e = q(sel); if (!e) return false; mouse(e, "auxclick", {button: 1}); return true; },
    newFolder: async ({name}) => {
      q("#new-folder").click();
      for (let i = 0; i < 40 && !q(".rename"); i++) await later(50);
      const input = q(".rename");
      if (!input) return false;
      input.value = name;
      input.dispatchEvent(new content.KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
      return true;
    },
    rename: async ({sel, name}) => {
      const head = q(sel);
      if (!head) return false;
      mouse(head, "dblclick");
      for (let i = 0; i < 20 && !q(".rename"); i++) await later(50);
      const input = q(".rename");
      if (!input) return false;
      input.value = name;
      input.dispatchEvent(new content.KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
      return true;
    },
    // The folder's own menu, opened by a right click; its last item deletes.
    deleteFolder: ({sel}) => {
      const head = q(sel);
      if (!head) return false;
      mouse(head, "contextmenu", {clientX: 20, clientY: 20});
      const item = qs("#menu .item").at(-1);
      if (!item || q("#menu").hidden) return false;
      item.click();
      return true;
    },
    // A real drag cannot be made without a mouse; these are the events it sends.
    drag: ({from, to, below}) => {
      const a = q(from), b = q(to);
      if (!a || !b) return false;
      const data = new content.DataTransfer(), box = b.getBoundingClientRect();
      const at = {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + (below ? box.height - 1 : 1), dataTransfer: data};
      a.dispatchEvent(new content.DragEvent("dragstart", at));
      b.dispatchEvent(new content.DragEvent("dragover", at));
      b.dispatchEvent(new content.DragEvent("drop", at));
      a.dispatchEvent(new content.DragEvent("dragend", at));
      return true;
    },
    keys: ({keys}) => {
      for (const key of keys) content.dispatchEvent(new content.KeyboardEvent("keydown", {key, bubbles: true, cancelable: true}));
      return true;
    },
  };
  addMessageListener("soak:do", async ({data: {id, name, args}}) => {
    let r;
    try { r = await cmds[name](args ?? {}); } catch (e) { r = {error: String(e)}; }
    sendAsyncMessage("soak:done", {id, r});
  });
})();"""

# Shared by everything that runs in the browser (args[0] is what Python passes).
LIB = r"""
  const a = args[0], EXT = "$EXT", SB = "$SB", ALONE = a.alone;
  const {setTimeout: sT, clearTimeout: cT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const {ExtensionStorageIDB} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const tracker = () => ExtensionParent.apiManager.global.tabTracker;
  const idOf = t => tracker().getId(t);
  const tabOf = id => { try { return tracker().getTab(id); } catch (e) { return null; } };
  const openStorage = id => ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID(id).extension));
  const storage = async (keys, id = EXT) => (await openStorage(id)).get(keys);
  const browsers = () => [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed && w.gBrowser);
  const normal = () => browsers().filter(w => w.toolbar.visible && w.document.readyState === "complete" && w.gBrowser.tabs.length);
  const control = () => browsers().find(w => w.__soakControl);
  const es = "extension:" + EXT + ":";
  const value = (w, t, name) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, es + name) || "null"); } catch (e) { return null; } };
  const keyOf = (w, t) => value(w, t, "syncKey");
  const roleOf = (w, t) => value(w, t, "syncRole");
  const essentialOf = (w, t) => value(w, t, "essentialKey");
  const url = t => { try { return t.linkedBrowser.currentURI.spec; } catch (e) { return ""; } };
  const isGhost = t => url(t).includes("/ghost.html?") && !/kind=(test|soak)/.test(url(t));
  const isGroup = t => url(t).includes("/sidebery/group.html");
  const ctxName = c => c ? "firefox-container-" + c : "firefox-default";

  // A command in one of Tidier's own pages (AGENT).
  const agent = (browser, name, cmdArgs) => new Promise(resolve => {
    const mm = browser?.messageManager;
    if (!mm) return resolve(null);
    if (!browser.__soakAgent) {
      browser.__soakAgent = true;
      mm.loadFrameScript("data:application/javascript;charset=utf-8," + encodeURIComponent(a.agent), false);
    }
    const id = String(Math.random());
    let timer;
    const heard = ({data}) => { if (data.id !== id) return; cT(timer); mm.removeMessageListener("soak:done", heard); resolve(data.r); };
    timer = sT(() => { mm.removeMessageListener("soak:done", heard); resolve({timeout: name}); }, 90000);
    mm.addMessageListener("soak:done", heard);
    mm.sendAsyncMessage("soak:do", {id, name, args: cmdArgs ?? {}});
  });
  // The message Tidier's own pages send, from a page that is out of the way.
  const ask = msg => agent(control().gBrowser.selectedBrowser, "ask", {msg});
  const panelOf = w => { try { return w.SidebarController.browser.contentDocument.getElementById("webext-panels-browser"); } catch (e) { return null; } };
  const sidebarShown = w => { try { return (w.SidebarController.currentID || "").includes("6844a953") && !w.SidebarController.browser.hidden; } catch (e) { return false; } };
  const sb = (w, name, cmdArgs) => sidebarShown(w) ? agent(panelOf(w), name, cmdArgs) : Promise.resolve(null);
"""

SETUP = LIB + r"""
  // The control page: a popup window, which Tidier leaves out of everything, so the
  // test can ask Tidier things without opening tabs among the ones it is checking.
  // An earlier one is gone after an update. After a restart Firefox brings it back, not
  // always as a popup: it is the test's own, and goes.
  for (const b of browsers()) {
    if (!b.toolbar.visible) { b.close(); continue; }
    for (const t of [...b.gBrowser.tabs]) if (url(t).includes("kind=soak")) { if (b.gBrowser.tabs.length > 1) b.gBrowser.removeTab(t); else b.close(); }
  }
  await wait(300);
  const w = normal()[0];
  const helper = w.gBrowser.addTrustedTab("moz-extension://" + JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[EXT] + "/ghost.html?kind=test", {inBackground: true});
  for (let i = 0; i < 100 && (!helper.linkedBrowser.currentURI.spec.includes("ghost.html") || helper.getAttribute("busy")); i++) await wait(100);
  await wait(500);
  const before = new Set(browsers());
  const made = await agent(helper.linkedBrowser, "popup", {url: "/ghost.html?kind=soak"});
  let popup = null;
  for (let i = 0; i < 100 && !popup; i++) { await wait(100); popup = browsers().find(x => !before.has(x)); }
  if (!popup) return {error: "no control window: " + JSON.stringify(made)};
  popup.__soakControl = true;
  for (let i = 0; i < 100 && (!url(popup.gBrowser.selectedTab).includes("kind=soak") || popup.gBrowser.selectedTab.getAttribute("busy")); i++) await wait(100);
  w.gBrowser.removeTab(helper);
  await wait(500);
  // Not left in Recently Closed, for an action's ⌘⇧T to bring back.
  const closedTabs = w.SessionStore.getClosedTabDataForWindow(w);
  const closedHelper = closedTabs.findIndex(c => c.state?.entries?.at(-1)?.url?.includes("kind=test"));
  if (closedHelper >= 0) w.SessionStore.forgetClosedTab(w, closedHelper);
  w.focus();
  // Errors from Tidier's pages in the browser console: the sidebar's are not in `problems`.
  const uuid = JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[EXT];
  const errors = popup.__soakErrors = [];
  const listener = {
    observe(m) {
      try { m.QueryInterface(Ci.nsIScriptError); } catch (e) { return; }
      if (!(m.sourceName || "").includes(uuid) || (m.flags & Ci.nsIScriptError.warningFlag) || (m.flags & Ci.nsIScriptError.infoFlag)) return;
      // A placeholder unloaded while it waited for an answer: Firefox says so, and nothing is wrong.
      if (/after context unloaded/.test(m.errorMessage)) return;
      errors.push(m.errorMessage + " (" + m.sourceName.split("/").pop() + ":" + m.lineNumber + ")");
    },
    QueryInterface: ChromeUtils.generateQI(["nsIConsoleListener"]),
  };
  Services.console.registerListener(listener);
  popup.__soakListener = listener;
  // Marionette is moved to this window: every other can be closed by an action.
  return {ok: true};
"""

# ---- What can happen ---------------------------------------------------------------
# Each returns a description, or null when it does not apply right now. What it means
# to be gone is noted: `closed` synced tabs, `unpinned` essentials, `deleted` folders.
ACTIONS = r"""
  // A small random generator, so that the seed decides the choices.
  let state = a.seed >>> 0;
  const R = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = list => list.length ? list[Math.floor(R() * list.length)] : null;
  let serial = 0;
  const pageUrl = () => a.pages + "/p/" + a.n + "-" + (serial++);
  const note = {closed: [], unpinned: [], deleted: [], mayDouble: []};
  const here = () => {
    const f = Services.focus.activeWindow, ws = normal();
    if (ws.includes(f)) return f;
    const w = pick(ws);
    w?.focus();
    return w;
  };
  const anyWindow = () => pick(normal());
  const otherWindow = w => pick(normal().filter(x => x !== w));
  const usable = t => !t.closing && t.linkedBrowser && !/kind=(test|soak)/.test(url(t));
  const plainTabs = w => [...w.gBrowser.tabs].filter(t => usable(t) && !t.pinned);
  const syncedTabs = w => plainTabs(w).filter(t => keyOf(w, t) && !isGroup(t));
  const pins = w => [...w.gBrowser.tabs].filter(t => usable(t) && t.pinned);
  const space = w => w.gBrowser.selectedTab.userContextId || 1;
  const short = t => {
    const w = t.ownerDocument.defaultView, name = (url(t).split(/[/?]/).pop() || url(t)).slice(-20);
    return (t.pinned ? "essential " + (essentialOf(w, t) || "-").slice(0, 6) + " " : "") + (isGhost(t) && !t.pinned ? (keyOf(w, t) || "-").slice(0, 6) + " placeholder" : name) + " in window " + normal().indexOf(w);
  };
  const principal = () => Services.scriptSecurityManager.getSystemPrincipal();
  const go = (t, to) => t.linkedBrowser.fixupAndLoadURIString(to, {triggeringPrincipal: principal()});
  const closing = (w, t) => { const k = keyOf(w, t); if (k) note.closed.push(k); };
  const inThisSidebar = (w, id) => { const t = tabOf(id); return t && t.ownerDocument.defaultView === w ? t : null; };
  const rowsOf = v => [...v.plain, ...v.folders.flatMap(f => f.tabs)];
  const tile = id => `.tile[data-tab="${id}"]`, row = id => `.tab[data-tab="${id}"]`, head = key => `[data-folder-head="${key}"]`;

  const act = {
    open_tab() {
      const w = here(), ctx = R() < 0.75 ? space(w) : 1 + Math.floor(R() * 3);
      const to = pageUrl();
      w.gBrowser.addTrustedTab(to, {userContextId: ctx, inBackground: R() < 0.6});
      return "open " + to.split("/").pop() + " in container " + ctx;
    },
    ticking_tab() {
      if (a.ticking >= 1) return null;
      const w = here();
      w.gBrowser.addTrustedTab(a.pages + "/tick/" + a.n, {userContextId: space(w), inBackground: true});
      return "open a tab whose title ticks";
    },
    new_tab() {
      const w = here();
      w.gBrowser.selectedTab = w.gBrowser.addTrustedTab("about:newtab");
      return "a new tab (no container)";
    },
    address_in_new_tab() {
      // ⌘T, then an address typed in it.
      const w = here(), t = pick(plainTabs(w).filter(x => /^about:(newtab|home|blank)/.test(url(x))));
      if (!t) return null;
      w.gBrowser.selectedTab = t;
      const to = pageUrl();
      go(t, to);
      return "address " + to.split("/").pop() + " typed in a new tab, container " + t.userContextId;
    },
    link() {
      const w = here();
      const to = pageUrl();
      w.gBrowser.selectedTab = w.gBrowser.addTrustedTab(to);
      return "link " + to.split("/").pop() + " from another app (no container)";
    },
    navigate() {
      const w = anyWindow(), t = pick(plainTabs(w).filter(x => x.linkedPanel && /^http/.test(url(x))));
      if (!t) return null;
      const to = pageUrl();
      go(t, to);
      return "navigate " + short(t) + " to " + to.split("/").pop();
    },
    reload() {
      const w = anyWindow(), t = pick([...w.gBrowser.tabs].filter(x => usable(x) && x.linkedPanel && /^http/.test(url(x))));
      if (!t) return null;
      w.gBrowser.reloadTab(t);
      return "reload " + short(t);
    },
    discard() {
      // Firefox unloads tabs by itself when memory is short.
      const w = anyWindow(), t = pick([...w.gBrowser.tabs].filter(x => usable(x) && !x.selected && x.linkedPanel && /^http/.test(url(x))));
      if (!t) return null;
      w.gBrowser.discardBrowser(t);
      return "Firefox unloads " + short(t);
    },
    close_tab() {
      const w = anyWindow(), t = pick(plainTabs(w).filter(x => !isGroup(x) && !x.hidden));
      if (!t) return null;
      closing(w, t);
      const what = short(t) + " (" + roleOf(w, t) + (t.linkedPanel ? ", loaded)" : ", unloaded)");
      w.gBrowser.removeTab(t);
      return "close " + what;
    },
    close_hidden_tab() {
      const w = anyWindow(), t = pick(plainTabs(w).filter(x => !isGroup(x) && x.hidden));
      if (!t) return null;
      closing(w, t);
      w.gBrowser.removeTab(t);
      return "close a tab of another space " + short(t);
    },
    close_selected() {
      // ⌘W
      const w = here(), t = w.gBrowser.selectedTab;
      if (!usable(t) || isGroup(t) || w.gBrowser.tabs.length < 2) return null;
      closing(w, t);
      const what = short(t);
      w.gBrowser.removeTab(t);
      return "⌘W on " + what;
    },
    close_essential() {
      const w = anyWindow(), t = pick(pins(w));
      if (!t) return null;
      const what = short(t);
      w.gBrowser.removeTab(t);
      return "close " + what;
    },
    select_tab() {
      const w = here(), t = pick(w.gBrowser.visibleTabs.filter(usable));
      if (!t) return null;
      w.gBrowser.selectedTab = t;
      return "select " + short(t);
    },
    select_any_tab() {
      // ⌃Tab and links can take you to another space.
      const w = here(), t = pick([...w.gBrowser.tabs].filter(usable));
      if (!t) return null;
      w.gBrowser.selectedTab = t;
      return "select anywhere " + short(t);
    },
    select_quickly() {
      // Clicking through a few tabs, faster than a pull takes.
      const w = here();
      for (let i = 0; i < 4; i++) { const t = pick(w.gBrowser.visibleTabs.filter(usable)); if (t) w.gBrowser.selectedTab = t; }
      return "select four tabs quickly";
    },
    switch_window() {
      const w = pick(normal());
      w?.focus();
      return w ? "focus another window" : null;
    },
    pin() {
      const w = anyWindow(), t = pick(syncedTabs(w));
      if (!t) return null;
      closing(w, t);
      const what = short(t) + " (" + roleOf(w, t) + ")";
      w.gBrowser.pinTab(t);
      return "pin " + what;
    },
    unpin() {
      const w = anyWindow(), t = pick(pins(w));
      if (!t) return null;
      const k = essentialOf(w, t);
      if (k) note.unpinned.push(k);
      const what = short(t);
      w.gBrowser.unpinTab(t);
      return "unpin " + what;
    },
    move_tab() {
      // With Sidebery a tab is dragged in the tab strip or in its sidebar. With Tidier
      // alone only the sidebar moves tabs (the tab strip is not there).
      if (ALONE) return null;
      const w = here(), t = pick(syncedTabs(w));
      if (!t) return null;
      const same = plainTabs(w).filter(x => x.userContextId === t.userContextId && !isGroup(x));
      const to = pick(same);
      if (!to || to === t) return null;
      w.gBrowser.moveTabTo(t, {tabIndex: w.gBrowser.tabs.indexOf(to)});
      return "move " + short(t);
    },
    move_essential() {
      const w = here(), list = pins(w), t = pick(list);
      if (list.length < 2) return null;
      w.gBrowser.moveTabTo(t, {tabIndex: Math.floor(R() * list.length)});
      return "move " + short(t);
    },
    to_other_window() {
      // Dragged from the tab strip, or Firefox's own "Move Tab" menu.
      const w = anyWindow(), there = otherWindow(w), t = pick(plainTabs(w).filter(x => !isGroup(x)));
      if (!there || !t || w.gBrowser.tabs.length < 2) return null;
      closing(w, t); // Firefox loses the values of an unloaded tab it moves, so an action could not name it later
      const what = short(t) + " (" + roleOf(w, t) + ")";
      // Next to its own space's tabs: Sidebery gives a tab that another extension moves
      // the space of the tab it lands on (README), and its own drag does not do that.
      const same = [...there.gBrowser.tabs].filter(x => x.userContextId === t.userContextId).at(-1);
      there.gBrowser.adoptTab(t, {tabIndex: same ? there.gBrowser.tabs.indexOf(same) + 1 : there.gBrowser.tabs.length});
      return "to another window: " + what;
    },
    essential_to_other_window() {
      const w = anyWindow(), there = otherWindow(w), t = pick(pins(w));
      if (!there || !t || w.gBrowser.tabs.length < 2) return null;
      const what = short(t);
      there.gBrowser.adoptTab(t, {tabIndex: 0});
      return "to another window: " + what;
    },
    tear_off() {
      if (a.windows >= $MAX_WINDOWS) return null;
      const w = anyWindow(), t = pick(plainTabs(w).filter(x => !isGroup(x)));
      if (!t || plainTabs(w).length < 2) return null;
      closing(w, t);
      const what = short(t) + " (" + roleOf(w, t) + ")";
      w.gBrowser.replaceTabWithWindow(t);
      return "tear off into a new window: " + what;
    },
    new_window() {
      if (a.windows >= $MAX_WINDOWS) return null;
      const w = anyWindow();
      w.OpenBrowserWindow();
      return "a new window";
    },
    close_window() {
      const ws = normal();
      if (ws.length < 2) return null;
      const w = pick(ws);
      Services.prefs.setBoolPref("browser.tabs.warnOnClose", false);
      w.close();
      return "close a window";
    },
    async close_all_windows() {
      // On a Mac Firefox keeps running without windows, and ⌘N makes a new one.
      // Their tabs then have no live tab until you select one (README: a closed window's
      // tabs come back unloaded), which is what happens at a restart without a session too.
      Services.prefs.setBoolPref("browser.tabs.warnOnClose", false);
      note.noLiveOk = normal().flatMap(w => [...w.gBrowser.tabs].map(t => keyOf(w, t))).filter(Boolean);
      for (const w of normal()) w.close();
      await wait(1500);
      control().OpenBrowserWindow();
      return "close every window, then a new one";
    },
    reopen_tab() {
      const w = here();
      if (!w.SessionStore.getClosedTabCountForWindow(w)) return null;
      const closed = w.SessionStore.getClosedTabDataForWindow(w)[0]?.state, what = closed?.entries?.at(-1)?.url;
      if (closed?.pinned && what) note.mayDouble.push(what);
      w.SessionStore.undoCloseTab(w, 0);
      return "⌘⇧T: " + String(what).split(/[/?]/).pop();
    },
    reopen_window() {
      if (a.windows >= $MAX_WINDOWS || !control().SessionStore.getClosedWindowCount()) return null;
      for (const t of control().SessionStore.getClosedWindowData()[0]?.tabs ?? []) note.mayDouble.push(...t.entries.map(e => e.url));
      control().SessionStore.undoCloseWindow(0);
      return "reopen a closed window";
    },

    // ---- The real sidebar, in the window you are using (Tidier alone) ----
    async sb_select() {
      const w = here(), v = await sb(w, "view"), id = v && pick([...v.tiles, ...rowsOf(v)]);
      if (!id) return null;
      await sb(w, "click", {sel: `[data-tab="${id}"]`});
      return "sidebar: click a row";
    },
    async sb_close() {
      const w = here(), v = await sb(w, "view"), id = v && pick(rowsOf(v)), t = id && inThisSidebar(w, id);
      if (!t || isGroup(t)) return null;
      closing(w, t);
      await sb(w, "click", {sel: `${row(id)} .close`});
      return "sidebar: × on " + short(t);
    },
    async sb_middle_click() {
      const w = here(), v = await sb(w, "view"), id = v && pick(rowsOf(v)), t = id && inThisSidebar(w, id);
      if (!t || isGroup(t)) return null;
      closing(w, t);
      await sb(w, "middle", {sel: row(id)});
      return "sidebar: middle click on " + short(t);
    },
    async sb_new_tab() {
      const w = here();
      return (await sb(w, "click", {sel: "#new-tab"})) ? "sidebar: new tab button" : null;
    },
    async sb_new_folder() {
      const w = here(), v = await sb(w, "view");
      if (!v || v.renaming || v.folders.length >= 3) return null;
      await sb(w, "newFolder", {name: "Folder " + a.n});
      return "sidebar: new folder";
    },
    async sb_rename_folder() {
      const w = here(), v = await sb(w, "view"), f = v && pick(v.folders.filter(x => !x.live));
      if (!f || v.renaming) return null;
      await sb(w, "rename", {sel: head(f.key), name: "Renamed " + a.n});
      return "sidebar: rename a folder";
    },
    async sb_fold() {
      const w = here(), v = await sb(w, "view"), f = v && pick(v.folders);
      if (!f) return null;
      await sb(w, "click", {sel: head(f.key)});
      return "sidebar: fold or unfold a folder";
    },
    async sb_delete_folder() {
      const w = here(), v = await sb(w, "view"), f = v && pick(v.folders.filter(x => !x.live));
      if (!f) return null;
      note.deleted.push(f.key);
      await sb(w, "deleteFolder", {sel: head(f.key)});
      return "sidebar: delete a folder with " + f.tabs.length + " tabs";
    },
    async sb_space() {
      const w = here(), v = await sb(w, "view"), s = v && pick(v.spaces.filter(x => x !== v.space));
      if (!s) return null;
      await sb(w, "click", {sel: `#spaces .space[data-space="${s}"]`});
      return "sidebar: switch space";
    },
    async sb_keys() {
      const w = here(), v = await sb(w, "view");
      if (!v) return null;
      const keys = [];
      for (let i = 0, n = 1 + Math.floor(R() * 5); i < n; i++) keys.push(R() < 0.75 ? "ArrowDown" : "ArrowUp");
      keys.push(R() < 0.7 ? "Enter" : R() < 0.5 ? "ArrowLeft" : "ArrowRight");
      await sb(w, "keys", {keys});
      return "sidebar: keys " + keys.join(" ");
    },
    async sb_drag_into_folder() {
      const w = here(), v = await sb(w, "view"), f = v && pick(v.folders.filter(x => !x.live)), id = v && pick(rowsOf(v));
      if (!f || !id) return null;
      await sb(w, "drag", {from: row(id), to: head(f.key)});
      return "sidebar: drag a tab onto a folder";
    },
    async sb_drag_tab() {
      const w = here(), v = await sb(w, "view"), rows = v ? rowsOf(v) : [], from = pick(rows), to = pick(rows);
      if (!from || from === to) return null;
      await sb(w, "drag", {from: row(from), to: row(to), below: R() < 0.5});
      return "sidebar: drag a tab among the tabs";
    },
    async sb_drag_out_of_folder() {
      const w = here(), v = await sb(w, "view"), f = v && pick(v.folders.filter(x => x.tabs.length)), id = f && pick(f.tabs);
      if (!id) return null;
      await sb(w, "drag", {from: row(id), to: "#tabs"});
      return "sidebar: drag a tab out of its folder";
    },
    async sb_drag_to_space() {
      const w = here(), v = await sb(w, "view"), id = v && pick(rowsOf(v)), s = v && pick(v.spaces.filter(x => x !== v.space)), t = id && inThisSidebar(w, id);
      if (!t || !s || !/^http/.test(url(t)) && !isGhost(t)) return null;
      closing(w, t);
      await sb(w, "drag", {from: row(id), to: `#spaces .space[data-space="${s}"]`});
      return "sidebar: drag a tab to another space";
    },
    async sb_drag_to_essentials() {
      const w = here(), v = await sb(w, "view"), id = v && pick(rowsOf(v)), t = id && inThisSidebar(w, id);
      if (!t) return null;
      closing(w, t);
      await sb(w, "drag", {from: row(id), to: "#essentials"});
      return "sidebar: drag a tab to the essentials";
    },
    async sb_drag_essential_out() {
      const w = here(), v = await sb(w, "view"), id = v && pick(v.tiles), t = id && inThisSidebar(w, id);
      if (!t) return null;
      const k = essentialOf(w, t);
      if (k) note.unpinned.push(k);
      await sb(w, "drag", {from: tile(id), to: "#tabs"});
      return "sidebar: drag an essential to the list";
    },
    async sb_drag_essential() {
      const w = here(), v = await sb(w, "view"), from = v && pick(v.tiles), to = v && pick(v.tiles);
      if (!from || from === to) return null;
      await sb(w, "drag", {from: tile(from), to: tile(to)});
      return "sidebar: drag an essential among the essentials";
    },
    async sb_drag_folder() {
      const w = here(), v = await sb(w, "view"), from = v && pick(v.folders), to = v && pick(v.folders);
      if (!from || from === to) return null;
      await sb(w, "drag", {from: head(from.key), to: head(to.key), below: R() < 0.5});
      return "sidebar: drag a folder among the folders";
    },
  };
"""

RUN_ACTION = LIB + ACTIONS + r"""
  const name = a.name;
  let did = null, failed = null;
  try { did = await act[name](); } catch (e) { failed = String(e); }
  const ws = normal();
  const tabs = ws.length ? ws[0].gBrowser.tabs : [];
  return {did, failed, note, pop: {
    windows: ws.length, tabs: [...tabs].filter(t => !t.pinned).length, essentials: [...tabs].filter(t => t.pinned).length,
    ticking: browsers().flatMap(w => [...w.gBrowser.tabs]).filter(t => url(t).includes("/tick/")).length,
  }};
"""

# ---- What must always hold ------------------------------------------------------------
INVARIANTS = LIB + r"""
  const out = [], bad = (kind, subject, detail = "") => out.push({kind, subject: String(subject), detail: String(detail)});
  const stored = await storage(["syncedTabs", "essentials"]);
  const all = stored.syncedTabs || {}, list = stored.essentials || [];
  const ws = normal(), focused = Services.focus.activeWindow;
  const tabs = ws.flatMap((w, wi) => [...w.gBrowser.tabs].filter(t => !t.closing && t.linkedBrowser).map(t => ({
    w, wi, t, id: idOf(t), key: keyOf(w, t), role: roleOf(w, t), ek: essentialOf(w, t), url: url(t), pinned: t.pinned,
    loaded: !!t.linkedPanel, selected: t.selected, hidden: t.hidden, ctx: ctxName(t.userContextId), label: t.label,
    ghost: isGhost(t),
  })));
  const realWeb = x => /^https?:/.test(x.url);

  // --- Essentials ---
  const keys = list.map(e => e.key);
  if (new Set(keys).size !== keys.length) bad("essential twice in the list", keys.filter((k, i) => keys.indexOf(k) !== i)[0]);
  const byEssential = new Map(list.map(e => [e.key, e]));
  for (const [wi, w] of ws.entries()) {
    const pinned = tabs.filter(x => x.wi === wi && x.pinned);
    for (const e of list) {
      const n = pinned.filter(x => x.ek === e.key).length;
      if (n === 0 && /^https?:/.test(e.url)) bad("an essential is missing from a window", e.key.slice(0, 6), `${e.title}, window ${wi} has ${pinned.length}, the list ${list.length}`);
      if (n > 1) bad("an essential is twice in a window", e.title || e.url, `window ${wi}: ${n}`);
    }
    for (const x of pinned) {
      // (A page that is no web page, pinned with Firefox's own menu, is yours.)
      if ((realWeb(x) || x.ghost) && (!x.ek || !byEssential.has(x.ek))) bad("a pinned tab that is no essential", x.label, x.url.slice(0, 80) + " key " + x.ek);
      else if (!byEssential.has(x.ek)) continue;
      else if (byEssential.get(x.ek).cookieStoreId !== x.ctx) bad("an essential in another container", x.label, x.ctx + " vs " + byEssential.get(x.ek).cookieStoreId);
    }
    const order = pinned.map(x => x.ek).filter(k => byEssential.has(k)), wanted = keys.filter(k => order.includes(k));
    if (JSON.stringify(order) !== JSON.stringify(wanted)) bad("essentials not in the list's order", "window " + wi, `${order.length} here`);
  }
  for (const e of list) {
    const open = tabs.filter(x => x.ek === e.key && x.loaded && !x.ghost);
    if (open.length > 1) bad("an essential is loaded twice", e.title || e.url, open.map(x => x.wi).join(","));
  }

  // --- Synced tabs ---
  for (const [key, e] of Object.entries(all)) {
    if (e.group && e.own) continue;
    const reps = tabs.filter(x => x.key === key && !x.pinned);
    for (const [wi] of ws.entries()) {
      const n = reps.filter(x => x.wi === wi).length;
      if (n === 0) bad("a synced tab is missing from a window", e.title || e.url, `window ${wi} of ${ws.length}, role elsewhere ${reps.map(x => x.role)}`);
      if (n > 1) bad("a synced tab is twice in a window", e.title || e.url, `window ${wi}: ${reps.filter(x => x.wi === wi).map(x => x.role + (x.ghost ? "/placeholder" : "/page"))}`);
    }
    if (e.group) continue;
    const live = reps.filter(x => x.role === "live");
    if (live.length > 1) bad("a synced tab has two live tabs", e.title || e.url);
    if (live.length === 0 && reps.length && !e.saved && !e.liveFolder && !a.noLiveOk.includes(key)) bad("a synced tab has no live tab", e.title || e.url);
    const open = reps.filter(x => x.loaded && !x.ghost);
    if (open.length > 1 && !open.some(x => x.selected && x.w !== focused)) bad("a page is loaded twice", e.title || e.url, open.map(x => x.role + " in " + x.wi).join(", "));
    // A record that is behind its page: the other windows and the next start would show the old one.
    const page = live.find(x => x.loaded && realWeb(x) && !x.t.getAttribute("busy"));
    if (page && page.url !== e.url) bad("the record has another address than its page", e.title, e.url.slice(-20) + " vs " + page.url.slice(-20));
    for (const x of reps) {
      if (x.ctx !== e.cookieStoreId) bad("a synced tab in another container", e.title || e.url, x.ctx + " vs " + e.cookieStoreId);
      // (Selected in a window you are not using, it waits for you to come back, see pull.)
      if (x.role === "ghost" && x.loaded && !x.ghost && realWeb(x) && !(x.selected && x.w !== focused)) bad("a ghost has loaded the real page", e.title || e.url);
    }
  }
  for (const x of tabs) {
    if (x.pinned) continue;
    if (x.key && !all[x.key]) bad("a tab of a synced tab that is gone", x.label, x.role + " " + x.url.slice(0, 80));
    if (!x.key && realWeb(x)) bad("a web page that is not synced", x.label, x.url.slice(0, 80));
  }
  // Each address is used once (see Pages): two records with one address are a tab doubled, unless
  // you asked for it: ⌘⇧T on a tab moved to another space, on a saved tab you opened again or an
  // essential you made an ordinary tab, or a window reopened with a page you have since reopened.
  const byUrl = new Map();
  for (const e of Object.values(all)) if (!e.group && !e.liveFolder && !e.saved && !a.mayDouble.includes(e.url)) { const k = e.cookieStoreId + " " + e.url; byUrl.set(k, (byUrl.get(k) || 0) + 1); }
  for (const [k, n] of byUrl) if (n > 1) bad("a tab is doubled", k.split(" ")[1].slice(-40), n + " records, " + k.split(" ")[0]);

  // --- Placeholders ---
  for (const x of tabs) {
    if (x.ghost && x.loaded && !x.selected) bad("a placeholder stays loaded", x.label, (x.pinned ? "essential" : x.role) + " in window " + x.wi + (x.t.getAttribute("busy") ? ", still loading" : "") + (x.hidden ? ", hidden" : "") + (x.key && all[x.key]?.saved ? ", saved" : "") + (x.key && !all[x.key] ? ", not in the record" : "") + ", awaiting " + (await ask({type: "stats"}))?.sizes?.awaitingIcon);
    if (x.ghost && x.selected && x.w === focused) bad("the selected tab is left blank", x.label, x.pinned ? "essential" : x.role);
    if (x.ghost && /^(moz-extension:|[0-9a-f]{8}-[0-9a-f]{4}-)/.test(x.label || "")) bad("a placeholder shows no title", x.label.slice(0, 40), (x.pinned ? "essential" : x.role) + (x.loaded ? ", loaded" : ", unloaded") + " in window " + x.wi);
  }

  // --- Spaces ---
  const shown = [];
  for (const [wi, w] of ws.entries()) {
    const sel = w.gBrowser.selectedTab, space = sel.userContextId ? ctxName(sel.userContextId) : null;
    if (ALONE && space) {
      for (const x of tabs.filter(x => x.wi === wi && !x.pinned)) {
        if (x.ctx !== space && x.ctx !== "firefox-default" && !x.hidden && !x.selected) bad("another space's tab is shown", x.label, x.ctx + " in " + space);
        if (x.ctx === space && x.hidden) bad("a tab of the active space is hidden", x.label);
      }
    }
    if (ALONE && sidebarShown(w)) {
      const v = await sb(w, "view");
      if (!v || v.error || v.timeout) { bad("the sidebar does not answer", "window " + wi, JSON.stringify(v)); continue; }
      if (v.renaming) continue;
      const sp = v.space;
      if (space && sp !== space) bad("the sidebar shows another space than the selected tab's", "window " + wi, sp + " vs " + space);
      const here = tabs.filter(x => x.wi === wi && (x.ctx === sp || x.ctx === "firefox-default"));
      const wantRows = here.filter(x => !x.pinned).map(x => x.id).sort(), gotRows = [...v.plain, ...v.folders.flatMap(f => f.tabs)].sort();
      const wantTiles = here.filter(x => x.pinned).map(x => x.id).sort(), gotTiles = [...v.tiles].sort();
      if (JSON.stringify(wantRows) !== JSON.stringify(gotRows)) bad("the sidebar's rows are not the window's tabs", "window " + wi,
        `missing ${wantRows.filter(i => !gotRows.includes(i)).map(i => tabs.find(x => x.id === i)?.label)}, extra ${gotRows.filter(i => !wantRows.includes(i))}`);
      if (JSON.stringify(wantTiles) !== JSON.stringify(gotTiles)) bad("the sidebar's essentials are not the window's", "window " + wi, `${wantTiles.length} vs ${gotTiles.length}`);
      const folders = Object.entries(all).filter(([, e]) => e.own && e.cookieStoreId === sp).map(([k]) => k).sort();
      if (JSON.stringify(folders) !== JSON.stringify(v.folders.map(f => f.key).sort())) bad("the sidebar's folders are not the space's", "window " + wi);
      for (const f of v.folders) for (const id of f.tabs) {
        const x = tabs.find(y => y.id === id);
        if (x && all[x.key]?.parentKey !== f.key) bad("the sidebar shows a tab in a folder it is not in", x.label);
      }
      shown.push(v.plain.length + v.folders.flatMap(f => f.tabs).length);
    }
  }
  if (!ALONE) {
    const panels = {};
    for (const p of Object.values((await storage(["sidebar"], SB)).sidebar.panels)) if (p.type === 2 && p.newTabCtx && p.newTabCtx !== "none") panels[p.newTabCtx] = p.id;
    for (const x of tabs) {
      if (!x.t.userContextId || !panels[x.ctx]) continue;
      let panel;
      try { panel = JSON.parse(x.w.SessionStore.getCustomTabValue(x.t, "extension:" + SB + ":data") || "{}").panelId; } catch (e) { continue; }
      if (panel && panel !== panels[x.ctx]) bad(x.pinned ? "an essential is in another space (pin race)" : "a tab is in another space", x.label, x.ctx + " in window " + x.wi + ", role " + x.role + ", at " + x.w.gBrowser.tabs.indexOf(x.t) + " among " + x.w.gBrowser.tabs.map(t => t.userContextId).join(""));
    }
  }
  const errors = control().__soakErrors.splice(0);
  for (const e of errors) bad("an error in the browser console", e);

  const entries = Object.entries(all);
  return {
    violations: out,
    names: Object.fromEntries(entries.map(([k, e]) => [k, (e.url || e.name || "").split(/[/?]/).pop()])),
    keys: entries.filter(([, e]) => !e.group).map(([k]) => k),
    noContainer: entries.filter(([, e]) => e.cookieStoreId === "firefox-default").map(([k]) => k),
    savedKeys: entries.filter(([, e]) => e.saved).map(([k]) => k),
    essentials: keys,
    folders: entries.filter(([, e]) => e.own).map(([k]) => k),
    counts: {windows: ws.length, tabs: tabs.length, synced: entries.filter(([, e]) => !e.group).length, essentials: list.length,
             folders: entries.filter(([, e]) => e.group).length, loaded: tabs.filter(x => x.loaded).length, hidden: tabs.filter(x => x.hidden).length},
  };
"""

PROC_INFO = LIB + r"""
  // After a collection in every process, so memory says what is kept, not what is
  // waiting to be collected.
  await new Promise(resolve => Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager).minimizeMemoryUsage(resolve));
  await wait(500);
  const info = await ChromeUtils.requestProcInfo();
  const ext = info.children.filter(c => c.type === "extension");
  // Firefox's own accounts of that process: what is allocated (the process as a whole goes up and
  // down with how the system lends it memory), and pages it has closed but cannot free.
  let explicit = 0, ghostWindows = 0;
  const manager = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);
  await new Promise(done => manager.getReports((process, path, kind, units, amount) => {
    if (!/^(webExtensions|extension)/i.test(process)) return;
    if (path.startsWith("explicit/")) explicit += amount;
    else if (path === "ghost-windows") ghostWindows = amount;
  }, null, done, null, false));
  return {mb: Math.round(ext.reduce((s, c) => s + (c.memory || 0), 0) / 1048576), cpuS: ext.reduce((s, c) => s + (c.cpuTime || 0), 0) / 1e9,
          heap: Math.round(explicit / 1048576), ghostWindows};
"""

# For a report: which tabs are changing while Tidier is at work.
WHAT_CHANGES = LIB + r"""
  const look = () => new Map(normal().flatMap((w, wi) => [...w.gBrowser.tabs].map(t => [t, wi + " " + t.label + " " + (t.linkedPanel ? "loaded" : "") + (t.getAttribute("busy") ? " loading" : "")])));
  const before = look();
  await wait(3000);
  const now = look();
  return [...now].filter(([t, s]) => before.get(t) !== s).map(([t, s]) => before.get(t) + " -> " + s + " " + url(t).slice(-40)).slice(0, 8).join("; ") || "nothing";
"""

CLOSE_TICKING = LIB + r"""
  for (const w of normal()) for (const t of [...w.gBrowser.tabs]) if (url(t).includes("/tick/")) w.gBrowser.removeTab(t);
  return 1;
"""

FOCUS = LIB + r"""
  const f = Services.focus.activeWindow, ws = normal();
  if (!ws.length) { control().OpenBrowserWindow(); await wait(1500); return 1; }
  if (!ws.includes(f)) ws[0].focus();
  await wait(100);
  return 1;
"""

# A window has a sidebar in real use, which a new window takes from the window that
# opened it; Sidebery places tabs only where its sidebar runs.
SHOW_SIDEBARS = LIB + r"""
  const wanted = ALONE ? "_6844a953-9931-4334-9ff6-257c246485cb_-sidebar-action" : "_3c078156-979c-498b-8990-85f7987dd929_-sidebar-action";
  for (const w of normal()) {
    if (w.SidebarController.currentID !== wanted || w.SidebarController.browser.hidden) { await w.SidebarController.show(wanted); await wait(300); }
  }
  return 1;
"""

ASK = LIB + "return await ask(a.msg);"


def weights(alone, pop):
    """How likely each action is now: use as it might be, kept around MAX_TABS."""
    tabs, essentials, windows = pop["tabs"], pop["essentials"], pop["windows"]
    many = tabs >= MAX_TABS
    few = tabs <= MIN_TABS
    w = {
        "open_tab": 0 if many else (10 if few else 4),
        "ticking_tab": 0.1,
        "new_tab": 0 if many else 1.5,
        "address_in_new_tab": 1.5,
        "link": 0 if many else 2,
        "navigate": 2,
        "reload": 0.5,
        "discard": 1,
        "close_tab": 0 if few else (10 if many else 3),
        "close_hidden_tab": 0 if few else (3 if many else 0.7),
        "close_selected": 0 if few else 1.5,
        "close_essential": 0.7,
        "select_tab": 6,
        "select_any_tab": 2,
        "select_quickly": 1,
        "switch_window": 2,
        "pin": 0 if essentials >= MAX_ESSENTIALS else (2 if essentials <= MIN_ESSENTIALS else 0.6),
        "unpin": 0 if essentials <= MIN_ESSENTIALS else 0.6,
        "move_tab": 1.5,
        "move_essential": 0.8,
        "to_other_window": 0.6,
        "essential_to_other_window": 0.3,
        "tear_off": 0.2,
        "new_window": 0 if windows >= MAX_WINDOWS else (1 if windows > 1 else 2),
        "close_window": 0 if windows < 2 else (0.8 if windows < MAX_WINDOWS else 1.6),
        "close_all_windows": 0.03,
        "reopen_tab": 0.8,
        "reopen_window": 0.2,
    }
    if alone:
        w.update({
            "sb_select": 5, "sb_close": 0 if few else (5 if many else 1.5), "sb_middle_click": 0 if few else 0.5, "sb_new_tab": 0 if many else 0.8,
            "sb_new_folder": 0.3, "sb_rename_folder": 0.2, "sb_fold": 0.6, "sb_delete_folder": 0.12, "sb_space": 2.5, "sb_keys": 0.8,
            "sb_drag_into_folder": 1.2, "sb_drag_tab": 1.5, "sb_drag_out_of_folder": 0.6, "sb_drag_to_space": 0.5,
            "sb_drag_to_essentials": 0 if essentials >= MAX_ESSENTIALS else 0.3, "sb_drag_essential_out": 0 if essentials <= MIN_ESSENTIALS else 0.3,
            "sb_drag_essential": 0.5, "sb_drag_folder": 0.2,
        })
    return w


class Soak:
    def __init__(self, m, args):
        self.m, self.args = m, args
        self.rng = random.Random(args.seed)
        self.n = 0
        self.pop = {"windows": 1, "tabs": 10, "essentials": 6, "ticking": 0}
        self.closed, self.unpinned, self.deleted = set(), set(), set()
        self.no_live_ok = []
        self.may_double = []
        self.prev = None
        self.restarts = self.segment = 0
        self.raw, self.offset = {}, {}
        self.violations = {}    # (kind, subject) -> the first detail, when
        self.known = {}         # the same for what Sidebery decides (SIDEBERY_SAYS)
        self.action_failures = {}
        self.samples = []
        self.count = {}
        self.log = []
        self.logfile = args.log or os.path.join(tempfile.gettempdir(), f"tidier-soak-{args.seed}.log")
        self.log_out = open(self.logfile, "w", buffering=1)
        self.t0 = time.time()

    def call(self, script, **more):
        return self.m.js(script.replace("$EXT", EXT_ID).replace("$SB", SIDEBERY_ID).replace("$MAX_WINDOWS", str(MAX_WINDOWS)),
                         {"alone": self.args.alone, "agent": AGENT, "pages": self.pages, **more})

    def say(self, text):
        line = f"{time.time() - self.t0:7.1f}  {text}"
        self.log.append(line)
        self.log_out.write(line + "\n")

    def ask(self, msg):
        return self.call(ASK, msg=msg)

    def action(self):
        table = weights(self.args.alone, self.pop)
        names = list(table)
        for _ in range(20):
            name = self.rng.choices(names, [table[k] for k in names])[0]
            self.n += 1
            r = self.call(RUN_ACTION, name=name, seed=self.rng.getrandbits(32), n=self.n, windows=self.pop["windows"], ticking=self.pop["ticking"])
            self.pop = r["pop"]
            self.closed.update(r["note"]["closed"])
            self.unpinned.update(r["note"]["unpinned"])
            self.deleted.update(r["note"]["deleted"])
            self.no_live_ok += r["note"].get("noLiveOk", [])
            self.may_double += r["note"]["mayDouble"]
            if r["failed"]:
                self.action_failures[f"{name}: {r['failed']}"] = self.action_failures.get(f"{name}: {r['failed']}", 0) + 1
                self.say(f"{name}: the test's own action failed: {r['failed']}")
                return
            if r["did"]:
                self.count[name] = self.count.get(name, 0) + 1
                self.say(r["did"])
                return

    def settle(self):
        """Wait until Tidier has stopped working: its queue is empty and no jobs ran for a while."""
        t0 = time.time()
        self.call(CLOSE_TICKING)
        self.call(FOCUS)
        last, quiet_since = None, None
        while time.time() - t0 < SETTLE_LIMIT_S:
            s = self.ask({"type": "stats"})
            if not isinstance(s, dict) or "jobs" not in s:
                self.violation("Tidier does not answer", "stats", str(s))
                return time.time() - t0, None
            # Asking is a job itself (one per stats message), and a view may follow.
            now = s["jobs"]
            if last is not None and now - last <= 1:
                quiet_since = quiet_since or time.time()
                if time.time() - quiet_since >= 3 and not s["sizes"].get("pending"):
                    return time.time() - t0, s
            else:
                quiet_since = None
            last = now
            time.sleep(0.7)
        self.violation("Tidier never goes quiet", f"{SETTLE_LIMIT_S} s", f"jobs at {last}, changing: {self.call(WHAT_CHANGES)}")
        return time.time() - t0, s

    def violation(self, kind, subject, detail=""):
        id_ = (kind, subject)
        if id_ in self.violations or id_ in self.known:
            return
        if kind in SIDEBERY_SAYS and not self.args.alone:
            self.known[id_] = detail
            self.say(f"KNOWN {kind}: {subject} ({detail})")
            return
        self.violations[id_] = (detail, time.time() - self.t0)
        self.say(f"VIOLATION {kind}: {subject} ({detail})")
        print(f"VIOLATION at {round(time.time() - self.t0)} s: {kind}: {subject}" + (f" ({detail})" if detail else ""), flush=True)
        print("  the last actions:", flush=True)
        for line in self.log[-12:]:
            print("   ", line, flush=True)

    def check_everything(self):
        settle_s, stats = self.settle()
        self.call(SHOW_SIDEBARS)
        self.ask({"type": "flush"})
        t0 = time.time()
        r = None
        while True:
            r = self.call(INVARIANTS, noLiveOk=self.no_live_ok, mayDouble=self.may_double)
            if not r["violations"] or time.time() - t0 > VIOLATION_WAIT_S:
                break
            for v in r["violations"]:  # errors are taken from the console once: keep them
                if v["kind"] == "an error in the browser console":
                    self.violation(v["kind"], v["subject"], v["detail"])
            time.sleep(3)
            self.ask({"type": "flush"})
        for v in r["violations"]:
            self.violation(v["kind"], v["subject"], v["detail"])
        # What is gone without having been closed.
        if self.prev:
            for k in set(self.prev["keys"]) - set(r["keys"]) - self.closed:
                # With Sidebery, a tab without a container is Sidebery's to reopen in the active
                # space, which it does by closing that tab; Tidier then closes it everywhere.
                if self.args.alone or k not in self.prev["noContainer"]:
                    self.violation("a synced tab is gone, and nothing closed it", self.prev["names"].get(k, k), k)
            for k in set(self.prev["essentials"]) - set(r["essentials"]) - self.unpinned:
                self.violation("an essential is gone, and nothing unpinned it", k)
            for k in set(self.prev["folders"]) - set(r["folders"]) - self.deleted:
                self.violation("a folder is gone, and nothing deleted it", k)
        self.prev = r
        self.closed, self.unpinned, self.deleted = set(), set(), set()
        return settle_s, r

    def sample(self, settle_s, r):
        stats = self.ask({"type": "stats"})
        proc = self.call(PROC_INFO)
        sizes = stats["sizes"]
        room = r["counts"]["tabs"] + r["counts"]["windows"] + SPARE_ENTRIES
        for name, size in sizes.items():
            if size > room:
                self.violation("a list in memory outgrows the tabs", name, f"{size} entries, with {r['counts']['tabs']} tabs in {r['counts']['windows']} windows")
        for problem in stats["problems"][self.problems_seen:]:
            self.violation("an error inside Tidier", problem)
        self.problems_seen = len(stats["problems"])
        prev = self.samples[-1] if self.samples else None
        # Counted from the start of the run: an update or a restart starts Tidier's counts over.
        now = {"cpu": proc["cpuS"], "jobs": stats["jobs"], "queue": stats["queueMs"] / 1000, "lookups": stats["lookups"], "views": stats["views"], "errors": stats["errors"]}
        for k, v in now.items():
            if v < self.raw.get(k, 0):
                self.offset[k] = self.offset.get(k, 0) + self.raw[k]
            self.raw[k] = v
        row = {
            "t": time.time() - self.t0, "settle": settle_s, **r["counts"], "mb": proc["mb"], "heap": proc["heap"], "ghosts": proc["ghostWindows"],
            **{k: v + self.offset.get(k, 0) for k, v in now.items()},
            "actions": sum(self.count.values()), "biggest": max(sizes.items(), key=lambda kv: kv[1]),
        }
        self.samples.append(row)
        step = (lambda k: row[k] - prev[k]) if prev else (lambda k: row[k])
        print(f"{row['t'] / 60:5.1f} min  {row['windows']} windows, {row['tabs']} tabs, {row['synced']} synced, {row['essentials']} essentials, "
              f"{row['mb']} MB ({row['heap']} allocated), {step('jobs')} jobs, {step('actions')} actions, quiet in {settle_s:.0f} s, {len(self.violations)} violations", flush=True)

    def table(self):
        print("\n  min  win tabs sync ess fold loaded   MB heap ghost  cpu%   jobs  queue%  views lookups actions settle  biggest list", flush=True)
        prev = None
        for row in self.samples:
            span = row["t"] - prev["t"] if prev else row["t"]
            d = lambda k: row[k] - prev[k] if prev else row[k]
            print(f"{row['t'] / 60:5.1f} {row['windows']:4} {row['tabs']:4} {row['synced']:4} {row['essentials']:3} {row['folders']:4} {row['loaded']:6} {row['mb']:4} {row['heap']:4} {row['ghosts']:5} "
                  f"{100 * d('cpu') / span:5.1f} {d('jobs'):6} {100 * d('queue') / span:7.1f} {d('views'):6} {d('lookups'):7} {d('actions'):7} {row['settle']:6.0f}  {row['biggest'][0]} {row['biggest'][1]}", flush=True)
            prev = row

    def idle_check(self):
        self.call(CLOSE_TICKING)
        # The last of what the actions caused: a placeholder waits up to 10 s for its icon, and
        # the title of a tab that changed is shown on its ghosts up to a minute later.
        time.sleep(12)
        for _ in range(80):
            if not self.ask({"type": "stats"})["sizes"]["refreshTimers"]:
                break
            time.sleep(1)
        idle = self.ask({"type": "idle", "ms": 15000})
        if idle.get("alarms"):
            print(f"SKIP  idle check: a timed check ran meanwhile ({idle})", flush=True)
        elif idle["jobs"] or idle["lookups"] or idle["views"]:
            self.violation("Tidier works with nothing happening", str(idle))
        else:
            print("PASS  with nothing happening, Tidier does nothing (15 s)", flush=True)

    def run(self):
        args = self.args
        server, self.pages = serve_pages()
        self.problems_seen = 0
        print(f"Seed {args.seed}, {args.minutes} minutes, {'Tidier alone' if args.alone else 'with Sidebery'}, on port {args.port}. Every action: {self.logfile}", flush=True)
        r = self.call(SETUP)
        if not r.get("ok"):
            raise SystemExit(f"Could not set up: {r}")
        self.use_window(control=True)
        self.call(SHOW_SIDEBARS)
        settle_s, r = self.check_everything()
        self.sample(settle_s, r)
        end = time.time() + args.minutes * 60
        next_check = time.time() + args.every
        next_restart = time.time() + args.restart_every * 60 if args.restart_every and self.m.can_restart else float("inf")
        if args.restart_every and not self.m.can_restart:
            print("(no restarts: Tidier cannot be installed for real in this Firefox; use Developer Edition, TIDIER_FIREFOX)", flush=True)
        while time.time() < end:
            if time.time() >= next_restart:
                self.restart()
                next_restart = time.time() + args.restart_every * 60
            self.action()
            if self.n % 15 == 0:
                self.call(SHOW_SIDEBARS)
            if time.time() >= next_check:
                settle_s, r = self.check_everything()
                self.sample(settle_s, r)
                next_check = time.time() + args.every
            # Mostly as fast as someone working, now and then several at once.
            if self.rng.random() > 0.2:
                time.sleep(self.rng.uniform(0.2, args.pace))
        settle_s, r = self.check_everything()
        self.sample(settle_s, r)
        self.idle_check()
        server.shutdown()

    def restart(self):
        """Firefox quit and started again, or Tidier updated over a running session, in turns:
        nothing may be lost (check_everything compares with the last check), and the run
        goes on. Only where Tidier is installed for real: Developer Edition, or --xpi."""
        self.restarts += 1
        update = self.restarts % 2 == 1
        settle_s, r = self.check_everything()
        self.sample(settle_s, r)
        print(f"{'An update' if update else 'A restart'} at {(time.time() - self.t0) / 60:.1f} min", flush=True)
        self.say("an update of Tidier" if update else "Firefox is quit and started again")
        self.use_window(control=False)  # the control page does not survive either
        if update:
            self.m.cmd("Addon:Install", {"path": self.m.update_xpi(), "temporary": False})
        else:
            self.m.restart()
        time.sleep(15)  # Firefox restores its windows, and Tidier waits for that
        r = self.call(SETUP)
        if not r.get("ok"):
            raise RuntimeError(f"Could not set up again: {r}")
        self.use_window(control=True)
        self.call(SHOW_SIDEBARS)
        self.problems_seen = 0
        self.segment = len(self.samples)  # memory starts over too
        settle_s, r = self.check_everything()
        self.sample(settle_s, r)

    def use_window(self, control):
        # Marionette works in one window, and fails once that is closed: so the control
        # window, which no action closes, or an ordinary one where that is what goes away.
        for handle in self.m.cmd("WebDriver:GetWindowHandles"):
            self.m.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": False})
            if self.m.js("return !window.toolbar.visible;") == control:
                return
        raise RuntimeError(f"No {'control' if control else 'ordinary'} window is there")

    def report(self):
        self.table()
        print("\nActions:", ", ".join(f"{k} {v}" for k, v in sorted(self.count.items(), key=lambda kv: -kv[1])), flush=True)
        if self.action_failures:
            print("The test's own actions that failed (not counted against Tidier):", flush=True)
            for what, n in sorted(self.action_failures.items(), key=lambda kv: -kv[1])[:15]:
                print(f"  {n} x {what}", flush=True)
        # What Firefox has allocated decides: a process's total also holds what the system has not
        # taken back yet. (Where that number cannot be had, the total.)
        rows = self.samples[self.segment:]
        memory = [s["heap"] or s["mb"] for s in rows]
        steady = grows_steadily(memory)
        if memory:
            print(f"Memory of the extension process: {memory[0]} MB allocated at the start, {memory[-1]} MB at the end, highest {max(memory)} MB "
                  f"(the process: {rows[0]['mb']}, {rows[-1]['mb']}, highest {max(s['mb'] for s in rows)} MB): "
                  + ("grows steadily" if steady else "no steady growth"), flush=True)
        if self.samples:
            s = self.samples[-1]
            print(f"In {s['t'] / 60:.1f} minutes: {s['actions']} actions, {s['jobs']} jobs, queue busy {s['queue']:.0f} s, {s['cpu']:.0f} s CPU in the extension process, {s['errors']} errors", flush=True)
        if self.known:
            print(f"KNOWN  {len(self.known)} tabs that Sidebery put in another space (not failed; see SIDEBERY_SAYS and the log)", flush=True)
        if self.violations:
            print(f"\n{len(self.violations)} violations, seed {self.args.seed}:", flush=True)
            for (kind, subject), (detail, when) in self.violations.items():
                print(f"  at {round(when)} s: {kind}: {subject}" + (f" ({detail})" if detail else ""), flush=True)
        ok = not self.violations and not steady
        print(f"\n{'PASS' if ok else 'FAIL'}  soak, seed {self.args.seed}", flush=True)
        return ok


def main():
    parser = argparse.ArgumentParser(description="A long run in a real (test) Firefox, used at random.")
    parser.add_argument("--alone", action="store_true", help="Tidier alone, without Sidebery")
    parser.add_argument("--seed", type=int, default=None, help="decides the choices; printed, so that a run can be repeated")
    parser.add_argument("--minutes", type=float, default=5)
    parser.add_argument("--every", type=float, default=60, help="seconds between checks")
    parser.add_argument("--pace", type=float, default=1.2, help="most seconds between actions")
    parser.add_argument("--port", type=int, default=PORT + 100)
    parser.add_argument("--restart-every", type=float, default=0, help="minutes between a restart or an update of Tidier (Developer Edition)")
    parser.add_argument("--log", help="where every action is written")
    args = parser.parse_args()
    if args.seed is None:
        args.seed = random.randrange(1_000_000)
    ok = False
    with TestFirefox(port=args.port, alone=args.alone) as m:
        soak = Soak(m, args)
        try:
            soak.run()
        except Exception:
            # Firefox gone, or the test itself: either way the last actions say the most.
            soak.violation("the run stopped", traceback.format_exc(limit=3).strip().splitlines()[-1], "")
            print(traceback.format_exc(limit=4), flush=True)
            try:
                m.chrome()
            except Exception:
                pass
        ok = soak.report()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
