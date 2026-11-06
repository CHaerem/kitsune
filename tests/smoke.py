#!/usr/bin/python3
"""Smoke test for Kitsune and the Firefox setup in dotfiles.

    tests/smoke.py              # this folder, as a temporary add-on
    tests/smoke.py --installed  # the signed version installed in your Firefox
    tests/smoke.py --xpi FILE   # a given signed .xpi

It runs in an invisible test Firefox with a throwaway profile (see
testfirefox.py), so it never touches your own Firefox: no restart, no window,
no clipboard. The profile is built from dotfiles and tests/fixtures, with test
tabs in each space. Each group of checks runs on its own; a check that crashes
is reported as failed. It checks that:

  - a new window gets every essential and synced tab, unloaded, with the same
    essentials and folders per container, each container in one Sidebery space,
    also in three more new windows opened while another space is active;
  - every tab sits in its container's space in every window, also after an
    essential is closed (and brought back) or newly pinned, and after a tab is
    pulled in from another window;
  - selecting a ghost pulls the live tab in, and leaves no placeholder in
    Recently Closed; a ghost takes its live tab's new title; closing a tab
    closes it everywhere; closing a window hands its tabs over, and reopening
    it doubles nothing;
  - pinning a tab makes it an essential everywhere, also when the tab is a
    ghost; unpinning a copy removes it everywhere, and the copy you unpinned
    opens its page; an essential copy opens the real page in its container;
    an essential dragged to another window is there once, and comes back in
    the window it left;
    an essential is renamed by its own page, but not by a page on another
    site (a sign-in it redirects to);
  - a placeholder of a tab that no longer exists closes itself;
  - a popup window (as for signing in) is left out of tab sync;
  - unloaded essential copies show the essential's name;
  - the extension starts again after being disabled and enabled;
  - a tab opened without a container, as links from other apps are, lands in
    the active space's container (spaces switched with ⌃1/⌃2/⌃3), so logins
    never mix between spaces;
  - archiving closes a tab unused for longer than the limit everywhere, keeps
    newer tabs, folder tabs and selected tabs, and leaves only the real page
    (no placeholders) in Recently Closed;
  - ⌘⇧C copies the address; ⌘B leaves Sidebery in the sidebar; ⌘S switches
    compact mode on and off;
  - the toolbar follows the sidebar's width (220–480 px), and ⌘L opens the
    address bar centred with its results under it, also in compact mode;
  - a live folder (with a stand-in for the native host) is in every window,
    first in its space, with its pull requests unloaded; a closed pull request
    stays closed, one that leaves the search is removed everywhere, a
    renamed one takes its new title, and a failed search changes nothing;
  - with ten more essentials and thirty more tabs, a new window still gets
    them all, in their spaces, and they all go when closed;
  - after Firefox is quit and started again, both windows come back with the
    same essentials and tabs, one live tab each, folders with their tabs and
    every tab in its space, and tab sync and new windows still work (only
    where Kitsune can be installed for real: Developer Edition, or --xpi).
"""
import glob
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testfirefox import EXT_DIR, EXT_ID, SIDEBERY_ID, TestFirefox  # noqa: E402

CMD, SHIFT, CTRL, ESC = "", "", "", ""

# Shared helpers for the chrome-context scripts below.
H = """
  const {setTimeout: sT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const {ExtensionStorageIDB} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const storage = async (id, keys) => (await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID(id).extension))).get(keys);
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const main = () => wins().find(w => !w.__smoke && !w.__extra), other = () => wins().find(w => w.__smoke);
  const es = "extension:%(ext)s:";
  const value = (w, t, name) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, es + name) || "null"); } catch (e) { return null; } };
  const key = (w, t) => w.SessionStore.getCustomTabValue(t, es + "syncKey");  // JSON-encoded, as stored
  const ek = (w, t) => value(w, t, "essentialKey");
  const role = (w, t) => value(w, t, "syncRole");
  const url = t => { try { return t.linkedBrowser.currentURI.spec; } catch (e) { return ""; } };
  const find = k => wins().map(w => w.gBrowser.tabs.filter(t => key(w, t) === k).map(t => role(w, t) + (t.linkedPanel ? "/loaded" : "/unloaded")));
  const sbPanel = (w, t) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, "extension:%(sb)s:data") || "{}").panelId; } catch (e) { return undefined; } };
  const ctxOf = t => t.userContextId ? "firefox-container-" + t.userContextId : "firefox-default";
  const panelFor = async () => {
    const out = {};
    for (const p of Object.values((await storage("%(sb)s", ["sidebar"])).sidebar.panels)) if (p.type === 2 && p.newTabCtx && p.newTabCtx !== "none") out[p.newTabCtx] = p.id;
    return out;
  };
  // Tabs whose Sidebery space is not their container's (tabs without a stored space yet are skipped).
  const misplaced = async w => { const pf = await panelFor();
    return w.gBrowser.tabs.filter(t => t.userContextId && pf[ctxOf(t)] && sbPanel(w, t) && sbPanel(w, t) !== pf[ctxOf(t)]).map(t => (t.pinned ? "essential " : "") + t.label); };
  const close = async w => { Services.prefs.setBoolPref("browser.tabs.warnOnClose", false); w.close(); await wait(2500); };
  const removeWhere = async test => { for (const w of wins()) for (const t of [...w.gBrowser.tabs]) if (test(w, t)) w.gBrowser.removeTab(t); await wait(2500); };
""" % {"ext": EXT_ID, "sb": SIDEBERY_ID}

results = []
known = []
sidebery_version = None  # set in main()

# Failures caused by a Sidebery bug that is reported upstream: up to the
# Sidebery version named here they are printed as KNOWN and do not fail the
# run; with a newer Sidebery the check is strict again, so a release without
# the fix shows up. Remove an entry when the fix is released.
KNOWN_SIDEBERY_BUGS = {
    # A pinned tab created before a new window's sidebar is ready ignores the
    # container rules (seen on GitHub's slower machines; PIN_SETTLE_MS in common.js).
    "pin race": ("5.6.1", "https://github.com/mbnuqw/sidebery/pull/2497"),
}


def as_version(v):
    return tuple(int(p) for p in v.split(".") if p.isdigit())


def check(name, ok, detail="", sidebery_bug=None):
    if not ok and sidebery_bug and sidebery_version:
        upto, link = KNOWN_SIDEBERY_BUGS[sidebery_bug]
        if as_version(sidebery_version) <= as_version(upto):
            known.append(name)
            results.append(True)
            print(f"KNOWN {name}  ({detail}; Sidebery {sidebery_version} bug, {link})", flush=True)
            return
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


def press(m, key, *mods):
    acts = [{"type": "keyDown", "value": k} for k in mods] + [{"type": "keyDown", "value": key}, {"type": "keyUp", "value": key}]
    acts += [{"type": "keyUp", "value": k} for k in reversed(mods)]
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": acts}]})
    m.cmd("WebDriver:ReleaseActions")


def extension_message(m, msg):
    """Send a runtime message from one of the extension's own pages, and return the reply."""
    m.js(H + """const w = main(); w.focus(); w.__beforeHelper = w.gBrowser.selectedTab;
      const t = w.gBrowser.addTrustedTab("moz-extension://" + JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[args[0]] + "/ghost.html?kind=test", {});
      w.gBrowser.selectedTab = t; await wait(1500); return 1;""", EXT_ID)
    m.cmd("Marionette:SetContext", {"value": "content"})
    for h in m.cmd("WebDriver:GetWindowHandles"):
        m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
        if "ghost.html?kind=test" in m.cmd("WebDriver:GetCurrentURL"):
            break
    reply = m.cmd("WebDriver:ExecuteAsyncScript", {"script": """
      const done = arguments[arguments.length - 1];
      (window.wrappedJSObject || window).browser.runtime.sendMessage(arguments[0]).then(r => done(JSON.parse(JSON.stringify(r ?? null))), e => done({error: String(e)}));""",
      "args": [msg]})
    m.chrome()
    # Close the helper page with the tab selected before it back in front;
    # otherwise Firefox selects a neighbour, which may be a ghost that Kitsune
    # then (rightly) pulls in, and the test would be testing its own clicks.
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("ghost.html?kind=test"));
      if (w.__beforeHelper && !w.__beforeHelper.closing) w.gBrowser.selectedTab = w.__beforeHelper;
      if (t) w.gBrowser.removeTab(t); await wait(500); return 1;""")
    return reply


def new_window(m):
    fill = m.js(H + """
      const m0 = main(), want = m0.gBrowser.tabs.filter(t => !t.pinned && role(m0, t)).length, pinned0 = m0.gBrowser.tabs.filter(t => t.pinned).length;
      const t0 = Date.now(), w = m0.OpenBrowserWindow(); w.__smoke = true;
      let ms = null;
      for (let i = 0; i < 200 && ms === null; i++) {
        await wait(100);
        if (w.gBrowser.tabs.filter(t => t.pinned).length >= pinned0 && w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length >= want) ms = Date.now() - t0;
      }
      const loaded = () => w.gBrowser.tabs.filter(t => t.linkedPanel && !t.selected && url(t).includes("ghost.html"));
      for (let i = 0; i < 40 && (i < 12 || loaded().length); i++) await wait(250);  // sorting; placeholders unloading (up to 10 s)
      return {ms, essentials: [pinned0, w.gBrowser.tabs.filter(t => t.pinned).length], tabs: [want, w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length],
              stillLoaded: loaded().map(t => t.label)};""")
    check(f"a new window gets all essentials and tabs ({fill['ms']} ms)", fill["ms"] is not None and fill["essentials"][0] == fill["essentials"][1]
          and fill["tabs"][0] == fill["tabs"][1], f"essentials {fill['essentials']}, tabs {fill['tabs']}")
    check("placeholders unload themselves", not fill["stillLoaded"], f"still loaded: {fill['stillLoaded']}")
    waits = extension_message(m, {"type": "sidebarWaits"})
    print(f"INFO  waiting for Sidebery's sidebar in new windows: {waits}", flush=True)
    time.sleep(3)  # Sidebery stores its spaces shortly after the tabs settle
    view = """const w = args[0] ? other() : main(), out = {};
      for (const t of w.gBrowser.tabs) {
        if (!t.pinned && !url(t).includes("/sidebery/group.html")) continue;
        const c = out[t.userContextId] ??= {essentials: 0, folders: [], spaces: []};
        if (t.pinned) c.essentials++; else c.folders.push(t.label);
        if (sbPanel(w, t) && !c.spaces.includes(sbPanel(w, t))) c.spaces.push(sbPanel(w, t));
      }
      for (const c of Object.values(out)) c.folders.sort();
      return out;"""
    old, new = m.js(H + view, False), m.js(H + view, True)
    for ctx, v in sorted(old.items()):
        n = new.get(ctx, {})
        check(f"container {ctx}: the same essentials and folders in the new window, in one space",
              (n.get("essentials"), n.get("folders")) == (v["essentials"], v["folders"]) and len(n.get("spaces", [])) == 1, f"main {v} / new {n}")
    for which in ("main", "other"):
        wrong = m.js(H + f"return await misplaced({which}());")
        check(f"every tab in the {'main' if which == 'main' else 'new'} window is in its container's space", not wrong, str(wrong[:5]))


def more_windows(m):
    # Three more new windows, each opened while another space is active: an
    # essential pinned before Sidebery placed it would land in that space.
    wrong = m.js(H + """const out = [], m0 = main(), pinned = () => m0.gBrowser.tabs.filter(t => t.pinned).length;
      for (const ctx of [1, 2, 3]) {
        m0.gBrowser.selectedTab = m0.gBrowser.tabs.find(t => !t.pinned && !t.hidden && t.userContextId === ctx) || m0.gBrowser.selectedTab;
        await wait(800);
        const w = m0.OpenBrowserWindow(); w.__extra = true;
        try {
          for (let i = 0; i < 100 && !w.gBrowser; i++) await wait(100);  // the window is still being built
          for (let i = 0; i < 100 && w.gBrowser.tabs.filter(t => t.pinned).length < pinned(); i++) await wait(100);
          await wait(4000);
          out.push(await misplaced(w));
        } finally { await close(w); }
      }
      return out;""")
    check("essentials and tabs land in their own space in three more new windows", all(not x for x in wrong), str(wrong),
          sidebery_bug="pin race")
    print(f"INFO  waiting for Sidebery's sidebar in those windows: {extension_message(m, {'type': 'sidebarWaits'})[-3:]}", flush=True)


def essentials(m):
    r = m.js(H + """
      const w = main(), pf = await panelFor();
      w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => !t.pinned && !t.hidden && t.userContextId === 3);
      await wait(800);  // another space (3) is active
      const victim = w.gBrowser.tabs.find(t => t.pinned && t.userContextId === 1 && ek(w, t)), k = ek(w, victim);
      w.gBrowser.removeTab(victim); await wait(5000);
      const back = w.gBrowser.tabs.find(t => t.pinned && ek(w, t) === k);
      return {back: !!back, space: back && sbPanel(w, back), want: pf["firefox-container-1"], misplaced: await misplaced(w)};""")
    check("a closed essential comes back, in its own space", r["back"] and r["space"] == r["want"] and not r["misplaced"], str(r))
    r = m.js(H + """
      const pf = await panelFor(), t = main().gBrowser.addTrustedTab("https://example.org/?smoke-pin", {userContextId: 1, inBackground: true});
      await wait(2500); main().gBrowser.pinTab(t); await wait(5000);
      const k = ek(main(), t), copy = other().gBrowser.tabs.find(x => x.pinned && ek(other(), x) === k);
      const r = {key: !!k, copy: !!copy, spaces: [sbPanel(main(), t), copy && sbPanel(other(), copy)], want: pf["firefox-container-1"]};
      // Each space's essentials together (Sidebery would sort them so at the next start).
      r.order = wins().map(w => w.gBrowser.tabs.filter(x => x.pinned).map(x => x.userContextId));
      r.grouped = r.order.map(cs => cs.every((c, i) => i === 0 || c === cs[i - 1] || !cs.slice(0, i).includes(c)));
      if (copy) { other().gBrowser.unpinTab(copy); await wait(4000); r.unpinnedOpens = url(copy); }
      r.leftPinned = wins().map(w => w.gBrowser.tabs.filter(x => x.pinned && ek(w, x) === k).length);
      await removeWhere((w, x) => url(x).includes("smoke-pin"));
      return r;""")
    check("a pinned tab becomes an essential in every window, in its space", r["key"] and r["copy"] and r["spaces"] == [r["want"]] * 2, str(r))
    check("a new essential is put with the other essentials of its space, in every window", r.get("grouped") == [True, True], str(r.get("order")))
    check("unpinning a copy removes the essential everywhere", r["leftPinned"] == [0, 0], str(r))
    check("an unloaded copy you unpin opens its page as an ordinary tab", r.get("unpinnedOpens") == "https://example.org/?smoke-pin", str(r))
    r = m.js(H + """
      const w = other(); w.focus(); await wait(500);
      const e = w.gBrowser.tabs.find(t => t.pinned && url(t).includes("ghost.html") && !t.linkedPanel);
      if (!e) return null;
      const ctx = e.userContextId; w.gBrowser.selectedTab = e; await wait(4000);
      return {web: /^https?:/.test(url(e)), pinned: e.pinned, sameContainer: e.userContextId === ctx};""")
    check("an essential copy opens the real page, pinned, in its container", r and all(r.values()), str(r))
    r = m.js(H + """
      const w = main(), order = x => x.gBrowser.tabs.filter(t => t.pinned && ek(x, t)).map(t => ek(x, t));
      const mine = w.gBrowser.tabs.filter(t => t.pinned && ek(w, t) && t.userContextId === 1);
      if (mine.length < 2) return null;
      w.gBrowser.moveTabBefore(mine[mine.length - 1], mine[0]);  // last essential of space 1 to its front
      await wait(3000);
      const here = order(w), there = order(other()), both = here.filter(k => there.includes(k));
      const saved = (await storage("%s", ["essentials"])).essentials.map(e => e.key).filter(k => both.includes(k));
      return {moved: here.indexOf(ek(w, mine[mine.length - 1])) < here.indexOf(ek(w, mine[0])),
              otherFollows: JSON.stringify(there.filter(k => both.includes(k))) === JSON.stringify(both),
              saved: JSON.stringify(saved) === JSON.stringify(both), misplaced: [...await misplaced(w), ...await misplaced(other())]};""" % EXT_ID)
    check("a moved essential keeps its place, in the list and in the other window", r and r["moved"] and r["otherFollows"] and r["saved"]
          and not r["misplaced"], str(r))
    # Dragging an essential to the other window, which has its own copy of it.
    r = m.js(H + """
      const count = () => wins().map(w => { const by = {}; for (const t of w.gBrowser.tabs) if (t.pinned && ek(w, t)) by[ek(w, t)] = (by[ek(w, t)] || 0) + 1; return by; });
      const before = count(), w = main(), t = w.gBrowser.tabs.find(x => x.pinned && ek(w, x) && x.userContextId === 2), k = ek(w, t);
      other().gBrowser.adoptTab(t, {tabIndex: 0}); await wait(5000);
      const after = count();
      return {k, before: before.map(b => b[k]), after: after.map(a => a[k]), same: JSON.stringify(before.map(b => Object.keys(b).sort())) === JSON.stringify(after.map(a => Object.keys(a).sort())),
              doubled: after.flatMap(a => Object.entries(a).filter(([, n]) => n > 1)), misplaced: [...await misplaced(w), ...await misplaced(other())],
              pinnedThere: [main(), other()].map(x => x.gBrowser.tabs.filter(y => y.pinned).map(y => [(ek(x, y) || "").slice(0, 4), url(y).slice(-24)]))};""")
    check("an essential dragged to the other window is there once, and comes back in the window it left",
          r["after"] == [1, 1] and r["same"] and not r["doubled"] and not r["misplaced"], str(r))
    r = m.js(H + """
      const byKey = Object.fromEntries((await storage("%s", ["essentials"])).essentials.map(e => [e.key, e.name || e.title]));
      const w = other(), copies = w.gBrowser.tabs.filter(t => t.pinned && !t.linkedPanel && ek(w, t));
      return {copies: copies.length, wrong: copies.filter(t => t.label !== byKey[ek(w, t)]).map(t => [t.label, byKey[ek(w, t)]])};""" % EXT_ID)
    check("unloaded essentials show their name", r["copies"] > 0 and not r["wrong"], str(r))
    essential_title(m)


def set_title(m, address, title):
    """Set the title of the (loaded) page at `address`, in its own tab."""
    m.cmd("Marionette:SetContext", {"value": "content"})
    try:
        for h in m.cmd("WebDriver:GetWindowHandles"):
            m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
            if m.cmd("WebDriver:GetCurrentURL") == address:
                m.cmd("WebDriver:ExecuteScript", {"script": "document.title = arguments[0];", "args": [title]})
                return True
        return False
    finally:
        m.chrome()


def essential_title(m):
    # An essential's name follows its page, but only on its own site: a page on
    # another site (a sign-in it redirects to) does not rename it.
    stored = H + """const k = args[0]; return (await storage("%s", ["essentials"])).essentials.find(e => e.key === k)?.title;""" % EXT_ID
    k = m.js(H + """
      const w = main(), e = w.gBrowser.tabs.find(t => t.pinned && ek(w, t) && t.userContextId === 1), k = ek(w, e);
      w.__beforeTitleTest = w.gBrowser.selectedTab; w.gBrowser.selectedTab = e; await wait(4000);
      w.__essentialHome = url(e);
      w.gBrowser.selectedTab.linkedBrowser.loadURI(Services.io.newURI("https://example.com/?smoke-sign-in"), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      await wait(4000); return k;""")
    before = m.js(stored, k)
    other_site = set_title(m, "https://example.com/?smoke-sign-in", "Smoke sign-in")
    time.sleep(2)
    after_other = m.js(stored, k)
    home = m.js(H + """const w = main(), t = w.gBrowser.selectedTab;
      t.linkedBrowser.loadURI(Services.io.newURI(w.__essentialHome), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      await wait(4000); return w.__essentialHome;""")
    own_site = set_title(m, home, "Smoke own title")
    time.sleep(2)
    after_own = m.js(stored, k)
    set_title(m, home, before or "Example Domain")
    m.js(H + """const w = main(); if (w.__beforeTitleTest && !w.__beforeTitleTest.closing) w.gBrowser.selectedTab = w.__beforeTitleTest; await wait(2000); return 1;""")
    check("an essential is not renamed by a page on another site (a sign-in), but is by its own",
          other_site and own_site and after_other == before and after_own == "Smoke own title", f"{before!r} -> {after_other!r} -> {after_own!r}")


def folders(m):
    r = m.js(H + """
      const w = main(), SB = "extension:%s:data";
      const sbParent = t => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, SB) || "{}").parentId; } catch (e) { return undefined; } };
      const run = () => w.gBrowser.tabs.filter(t => !t.pinned && t.userContextId === 1);
      const group = run().find(t => url(t).includes("/sidebery/group.html"));
      const plain = run().filter(t => !url(t).includes("/sidebery/group.html") && t.openerTab !== group).pop();
      if (!group || !plain) return null;
      const children = run().filter(t => t.openerTab === group);
      w.gBrowser.moveTabBefore(plain, group);  // an ordinary tab above the folder
      await wait(4000);
      const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const now = run(), gid = ExtensionParent.apiManager.global.tabTracker.getId(group);
      return {first: now.slice(0, 1 + children.length).map(t => t === group ? "folder" : children.includes(t) ? "in folder" : url(t)),
              children: children.length, treeKept: children.every(c => sbParent(c) === gid),
              misplaced: [...await misplaced(w), ...await misplaced(other())]};""" % SIDEBERY_ID)
    check("folders stay first in their space, with their tabs, when a tab is moved above them",
          r and r["first"] == ["folder"] + ["in folder"] * r["children"] and r["children"] > 0 and r["treeKept"] and not r["misplaced"], str(r))


def tab_sync(m):
    r = m.js(H + """
      const t = main().gBrowser.addTrustedTab("https://example.org/?smoke-sync", {userContextId: 3, inBackground: true});
      await wait(4500); const k = key(main(), t), created = find(k);
      const w = other(); w.focus(); await wait(800);
      const t0 = Date.now(), ghost = w.gBrowser.tabs.find(x => key(w, x) === k); w.gBrowser.selectedTab = ghost;
      let ms = null; for (let i = 0; i < 100 && ms === null; i++) { await wait(15); if (w.gBrowser.selectedTab !== ghost && key(w, w.gBrowser.selectedTab) === k) ms = Date.now() - t0; }
      await wait(2500); const pulled = find(k);
      const closedUrls = wins().flatMap(x => x.SessionStore.getClosedTabDataForWindow(x)).map(c => c.state.entries?.[c.state.index - 1]?.url || "");
      const closedGhosts = closedUrls.filter(u => u.includes("ghost.html") && u.includes(encodeURIComponent(JSON.parse(k)))).length;
      const pf = await panelFor(), moved = w.gBrowser.tabs.find(x => key(w, x) === k), left = main().gBrowser.tabs.find(x => key(main(), x) === k);
      const spaces = [sbPanel(w, moved) === pf[ctxOf(moved)], left && sbPanel(main(), left) === pf[ctxOf(left)]];
      w.gBrowser.removeTab(moved); await wait(3000);
      return {created, ms, pulled, spaces, closedGhosts, closed: find(k)};""")
    check("a new tab gets a ghost in the other window", r["created"] == [["live/loaded"], ["ghost/unloaded"]], str(r["created"]))
    check(f"selecting a ghost pulls the live tab in ({r['ms']} ms)", r["pulled"] == [["ghost/unloaded"], ["live/loaded"]], str(r["pulled"]))
    check("a pulled tab and the ghost left behind stay in their space", r["spaces"] == [True, True], str(r["spaces"]))
    check("pulling a tab in leaves no placeholder in Recently Closed (⌘⇧T reopens what you closed)", r["closedGhosts"] == 0, str(r["closedGhosts"]))
    check("closing a tab closes it everywhere", r["closed"] == [[], []], str(r["closed"]))
    r = m.js(H + """
      const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const a = await AddonManager.getAddonByID("%s"); await a.disable(); await wait(1500); await a.enable(); await wait(6000);
      const t = main().gBrowser.addTrustedTab("https://example.org/?smoke-restart", {userContextId: 3, inBackground: true});
      await wait(4500); const r = find(key(main(), t)); main().gBrowser.removeTab(t); await wait(3000); return r;""" % EXT_ID)
    check("the extension starts again after being disabled and enabled", r == [["live/loaded"], ["ghost/unloaded"]], str(r))


def folder_pull(m):
    # A tab in a folder, pulled into the other window: the ghost left behind is
    # in the folder of the window it came from (Sidebery's own tree, from its
    # tab data). In the window it moved to, Sidebery places it as a tab another
    # extension moved in, outside the folder (README, Known limitations), so
    # only its role is checked there.
    r = m.js(H + """
      const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const id = t => ExtensionParent.apiManager.global.tabTracker.getId(t);
      const sbParent = (w, t) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, "extension:%s:data") || "{}").parentId; } catch (e) { return undefined; } };
      const folderOf = (w, ctx) => w.gBrowser.tabs.find(t => url(t).includes("group.html#Fixture%%20folder%%20" + ctx));
      const a = main(), b = other();
      const live = a.gBrowser.tabs.find(t => role(a, t) === "live" && t.userContextId === 2 && t.openerTab === folderOf(a, 2) && !t.selected);
      if (!live) return null;
      const k = key(a, live), ghost = b.gBrowser.tabs.find(t => key(b, t) === k);
      const before = [sbParent(a, live) === id(folderOf(a, 2)), ghost && sbParent(b, ghost) === id(folderOf(b, 2))];
      b.focus(); await wait(500); b.gBrowser.selectedTab = ghost; await wait(4000);
      const moved = b.gBrowser.tabs.find(t => key(b, t) === k), left = a.gBrowser.tabs.find(t => key(a, t) === k);
      const r = {before, leftInFolder: left && sbParent(a, left) === id(folderOf(a, 2)), roles: [role(b, moved), role(a, left)]};
      a.focus(); await wait(500);
      return r;""" % SIDEBERY_ID)
    check("a tab pulled in from a folder leaves its ghost in the folder (Sidebery's tree)",
          r and r["before"] == [True, True] and r["leftInFolder"] and r["roles"] == ["live", "ghost"], str(r))


def ghost_title(m):
    # A live tab whose title changes: its ghost in the other window shows the
    # new title a few seconds later.
    m.js(H + """main().gBrowser.addTrustedTab("https://example.org/?smoke-title", {userContextId: 3, inBackground: true}); await wait(4500); return 1;""")
    m.cmd("Marionette:SetContext", {"value": "content"})
    for h in m.cmd("WebDriver:GetWindowHandles"):
        m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
        if "smoke-title" in m.cmd("WebDriver:GetCurrentURL"):
            break
    m.cmd("WebDriver:ExecuteScript", {"script": 'document.title = "Smoke title 1"; return 1;'})
    m.chrome()
    r = m.js(H + """await wait(6000);
      const t = main().gBrowser.tabs.find(t => url(t).includes("smoke-title")), k = t && key(main(), t), w = other();
      const ghost = k && w.gBrowser.tabs.find(x => key(w, x) === k);
      const r = {live: t?.label, ghost: ghost?.label, unloaded: ghost ? !ghost.linkedPanel : null};
      await removeWhere((w, t) => url(t).includes("smoke-title")); return r;""")
    check("a ghost shows its live tab's new title, still unloaded", r["live"] == "Smoke title 1" and r["ghost"] == "Smoke title 1" and r["unloaded"], str(r))


def pinned_ghost(m):
    r = m.js(H + """
      const t = main().gBrowser.addTrustedTab("https://example.org/?smoke-pin-ghost", {userContextId: 1, inBackground: true});
      await wait(4500); const k = key(main(), t), w = other();
      const ghost = w.gBrowser.tabs.find(x => key(w, x) === k);
      if (!ghost) return null;
      w.gBrowser.pinTab(ghost); await wait(6000);
      const saved = (await storage("%s", ["essentials"])).essentials.filter(e => e.url === "https://example.org/?smoke-pin-ghost");
      const copies = wins().map(x => x.gBrowser.tabs.filter(y => y.pinned && saved[0] && ek(x, y) === saved[0].key).length);
      const r = {saved: saved.length, copies, synced: find(k), unloaded: !ghost.linkedPanel};
      for (const x of wins()) for (const y of [...x.gBrowser.tabs]) if (y.pinned && saved[0] && ek(x, y) === saved[0].key) { x.gBrowser.unpinTab(y); break; }
      await wait(4000);
      await removeWhere((x, y) => url(y).includes("smoke-pin-ghost") || (saved[0] && ek(x, y) === saved[0].key));
      return r;""" % EXT_ID)
    check("pinning a ghost makes its page an essential in every window, still unloaded",
          r and r["saved"] == 1 and r["copies"] == [1, 1] and r["synced"] == [[], []] and r["unloaded"], str(r))


def orphans(m):
    # A placeholder whose tab or essential no longer exists (left from before a
    # restart) is closed, and is not left in Recently Closed. (Opened in the
    # background: selecting one first would make the test depend on which
    # neighbour Firefox selects when it closes.)
    r = m.js(H + """
      const base = "moz-extension://" + JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))["%s"] + "/ghost.html";
      const w = main(), before = w.gBrowser.selectedTab;
      w.gBrowser.addTrustedTab(base + "?kind=ghost&key=smoke-orphan-1", {inBackground: true});
      w.gBrowser.addTrustedTab(base + "?kind=essential&key=smoke-orphan-2", {inBackground: true});
      await wait(3000);
      const left = wins().flatMap(x => x.gBrowser.tabs.filter(t => url(t).includes("smoke-orphan")).map(t => url(t)));
      const closed = wins().flatMap(x => x.SessionStore.getClosedTabDataForWindow(x)).filter(c => JSON.stringify(c.state.entries || []).includes("smoke-orphan")).length;
      if (!before.closing) w.gBrowser.selectedTab = before;
      await removeWhere((x, t) => url(t).includes("smoke-orphan"));
      return {left, closed};""" % EXT_ID)
    check("a placeholder of a tab that no longer exists closes itself, and is not in Recently Closed", not r["left"] and r["closed"] == 0, str(r))


def popups(m):
    # A sign-in popup (window.open with "popup") must not be synced: no ghosts
    # of it elsewhere, and nothing to pull out of the popup.
    m.js(H + """Services.prefs.setBoolPref("dom.disable_open_during_load", false);
      const w = main(); w.focus(); w.__beforeHelper = w.gBrowser.selectedTab;
      w.gBrowser.selectedTab = w.gBrowser.addTrustedTab("https://example.org/?smoke-opener", {userContextId: 3}); await wait(3000); return 1;""")
    m.cmd("Marionette:SetContext", {"value": "content"})
    for h in m.cmd("WebDriver:GetWindowHandles"):
        m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
        if "smoke-opener" in m.cmd("WebDriver:GetCurrentURL"):
            break
    m.cmd("WebDriver:ExecuteScript", {"script": 'window.open("https://example.org/?smoke-popup", "_blank", "popup,width=500,height=400"); return 1;'})
    m.chrome()
    r = m.js(H + """await wait(5000);
      const all = [...Services.wm.getEnumerator("navigator:browser")];
      const popup = all.find(w => w.gBrowser?.tabs.some(t => url(t).includes("smoke-popup")) && !w.toolbar.visible);
      const elsewhere = wins().filter(w => w !== popup).flatMap(w => w.gBrowser.tabs.filter(t => key(w, t) && (url(t).includes("smoke-popup") || t.label.includes("smoke-popup"))));
      const r = {popup: !!popup, synced: popup ? popup.gBrowser.tabs.filter(t => key(popup, t)).length : null, ghosts: elsewhere.length};
      if (popup) { popup.close(); await wait(1500); }
      Services.prefs.clearUserPref("dom.disable_open_during_load");
      const w = main(); if (w.__beforeHelper && !w.__beforeHelper.closing) w.gBrowser.selectedTab = w.__beforeHelper;
      await removeWhere((w, t) => url(t).includes("smoke-opener") || url(t).includes("smoke-popup"));
      return r;""")
    check("a popup window (as for signing in) is left out of tab sync", r["popup"] and r["synced"] == 0 and r["ghosts"] == 0, str(r))


def external_links(m):
    for digit, ctx in (("2", 3), ("3", 1), ("1", 2)):
        m.js(H + "main().focus(); await wait(300); return 1;")
        press(m, digit, CTRL)
        time.sleep(1.5)
        tag = f"smoke-external-{digit}"
        got = m.js(H + """
          // A tab without a container, which is how links from other apps arrive.
          // (Emulating the macOS hand-over itself does not behave like the real
          // one in a headless Firefox; the real route was checked by hand.)
          main().gBrowser.selectedTab = main().gBrowser.addTrustedTab("https://example.org/?" + args[0], {});
          await wait(6000);
          const pf = await panelFor();
          const r = wins().flatMap(w => w.gBrowser.tabs.filter(t => url(t).includes(args[0])).map(t => [t.userContextId, sbPanel(w, t) === pf[ctxOf(t)]]));
          await removeWhere((w, t) => url(t).includes(args[0]));
          return r;""", tag)
        check(f"a tab without a container (as links from other apps) lands in the active space's container (⌃{digit})", got == [[ctx, True]], str(got))


def archiving(m):
    # Pretending time has passed. An old test tab, a tab selected in the other
    # window, and a fixture folder tab; all must be kept within the limit.
    setup = m.js(H + """
      const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      const inFolder = k => { for (let x = k, n = 0; x && all[x] && n < 50; x = all[x].parentKey, n++) if (all[x].group) return true; return false; };
      const old = main().gBrowser.addTrustedTab("https://example.org/?smoke-archive", {userContextId: 3, inBackground: true});
      const o = other(); o.focus(); await wait(300);
      const sel = o.gBrowser.addTrustedTab("https://example.org/?smoke-archive-selected", {userContextId: 3}); o.gBrowser.selectedTab = sel;
      await wait(5000);
      return {old: key(main(), old), selected: key(o, sel), folder: Object.keys(all).find(k => !all[k].group && inFolder(k)) || null};""" % EXT_ID)
    plain = {"old": json.loads(setup["old"]), "selected": json.loads(setup["selected"]), "folder": setup["folder"]}
    now = int(time.time() * 1000)
    soon = extension_message(m, {"type": "archiveNow", "now": now + 3600 * 1000, "keys": list(plain.values()), "explain": True})
    kept = soon.get("kept", {})
    check("archiving keeps tabs used within the limit, folder tabs and selected tabs", soon.get("archived") == []
          and kept.get(plain["old"], "").startswith("used") and kept.get(plain["selected"]) == "selected" and kept.get(plain["folder"]) == "folder", str(soon))
    late = extension_message(m, {"type": "archiveNow", "now": now + 13 * 3600 * 1000, "keys": list(plain.values()), "explain": True})
    r = m.js(H + """
      const [k, selected, plainKey] = args;
      const closed = w => w.SessionStore.getClosedTabDataForWindow(w).map(c => c.state.entries?.[c.state.index - 1]?.url || "");
      const r = {left: find(k), selectedKept: find(selected).map(x => x.length),
                 closedReal: wins().flatMap(closed).filter(u => u === "https://example.org/?smoke-archive").length,
                 closedGhosts: wins().flatMap(closed).filter(u => u.includes("ghost.html") && u.includes(encodeURIComponent(plainKey))).length};
      await removeWhere((w, t) => key(w, t) === selected);
      return r;""", setup["old"], setup["selected"], plain["old"])
    check("archiving closes a tab unused for longer than the limit everywhere", late.get("archived") == ["https://example.org/?smoke-archive"] and r["left"] == [[], []],
          f"{late}, {r}")
    check("an archived tab is in Recently Closed as the real page only", r["closedReal"] == 1 and r["closedGhosts"] == 0, str(r))
    check("archiving keeps the folder tab and the selected tab after the limit", r["selectedKept"] == [1, 1] and late.get("kept", {}).get(plain["folder"]) == "folder", f"{late}, {r}")


def shortcuts(m):
    clipboard = H + """
      const read = () => { const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable); t.init(null); t.addDataFlavor("text/plain");
        Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, main().browsingContext.currentWindowContext);
        const o = {}; try { t.getTransferData("text/plain", o); return o.value.QueryInterface(Ci.nsISupportsString).data; } catch (e) { return ""; } };"""
    target = m.js(H + """const w = main(); w.focus();
      const t = w.gBrowser.addTrustedTab("https://example.org/?smoke-copy", {userContextId: 3}); w.gBrowser.selectedTab = t; await wait(3000);
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("before");
      return url(t);""")
    press(m, "c", CMD, SHIFT)
    time.sleep(1)
    copied = m.js(clipboard + "const r = read(); await removeWhere((w, t) => url(t).includes('smoke-copy')); return r;")
    check("⌘⇧C copies the address of the current tab", copied == target, repr(copied))
    before = m.js(H + "main().focus(); await wait(300); return main().SidebarController.currentID;")
    press(m, "b", CMD)
    time.sleep(1.2)
    after = m.js(H + "const S = main().SidebarController; return [S.isOpen, S.currentID];")
    check("⌘B leaves Sidebery in the sidebar", after == [True, before], f"{before} -> {after}")
    look = H + """const d = main().document;
      return [Math.round(d.getElementById("tabbrowser-tabbox").getBoundingClientRect().left), Math.round(d.getElementById("navigator-toolbox").getBoundingClientRect().right)];"""
    start = m.js(look)
    press(m, "s", CMD); time.sleep(1.2); compact = m.js(look)
    press(m, "s", CMD); time.sleep(1.2); back = m.js(look)
    check("⌘S switches compact mode on (sidebar and toolbar hidden, page full width) and off",
          compact[0] < 20 and compact[1] <= 0 and back == start, f"start {start}, ⌘S {compact}, ⌘S again {back}")


def look(m):
    widths = m.js(H + """const d = main().document, box = d.getElementById("sidebar-box"), before = box.style.width, out = [];
      const width = id => Math.round(d.getElementById(id).getBoundingClientRect().width);
      for (const px of [360, 150, 900]) { box.style.width = px + "px"; await wait(300); out.push([width("sidebar-box"), width("navigator-toolbox")]); }
      box.style.width = before; await wait(300); return out;""")
    check("the toolbar follows the sidebar's width (220–480 px)", widths == [[360, 360], [220, 220], [480, 480]], str(widths))
    rows = m.js(H + """const d = main().document, box = d.getElementById("sidebar-box"), before = box.style.width, out = [];
      const r = id => d.getElementById(id).getBoundingClientRect();
      for (const px of [220, 300, 480]) {
        box.style.width = px + "px"; await wait(400);
        const row1 = ["back-button", "forward-button", "stop-reload-button", "PanelUI-button"].map(r), row2 = ["urlbar-container", "unified-extensions-button"].map(r);
        const one = rs => rs.every(x => Math.abs(x.top - rs[0].top) < 8), apart = rs => rs.every((x, i) => i === 0 || x.left >= rs[i - 1].right - 0.5);
        out.push(!d.getElementById("nav-bar").hasAttribute("overflowing") && one(row1) && one(row2) && row2[0].top > row1[0].top
                 && apart(row1) && apart(row2) && [...row1, ...row2].every(x => x.right <= px + 0.5));
      }
      box.style.width = before; await wait(300); return out;""")
    check("the top row is back, forward, reload and ☰, with the address bar and 🧩 below, at 220–480 px (nothing behind »)", all(rows), str(rows))
    full = m.js(H + """const w = main(), d = w.document, root = d.documentElement;
      root.setAttribute("inDOMFullscreen", true); await wait(400);  // as Firefox marks a fullscreen video
      const b = d.getElementById("tabbrowser-tabbox").getBoundingClientRect(), side = d.getElementById("sidebar-box").getBoundingClientRect();
      const out = [Math.round(b.left), Math.round(b.top), Math.round(b.width) === w.innerWidth, Math.round(b.height) === w.innerHeight, side.width];
      root.removeAttribute("inDOMFullscreen"); await wait(300); return out;""")
    check("a fullscreen video fills the whole window (no frame, no sidebar)", full == [0, 0, True, True, 0], str(full))
    bar = H + """const w = main(), d = w.document, u = d.getElementById("urlbar").getBoundingClientRect(), v = d.querySelector(".urlbarView")?.getBoundingClientRect();
      return {open: d.getElementById("urlbar").hasAttribute("popover-open"), centre: Math.round(u.left + u.width / 2 - w.innerWidth / 2), list: v ? Math.round(v.left - u.left) : null};"""
    for compact in (False, True):
        m.js(H + "main().focus(); return 1;")
        if compact:
            press(m, "s", CMD); time.sleep(1.2)
        press(m, "l", CMD); time.sleep(1)
        got = m.js(bar)
        press(m, ESC); press(m, ESC); time.sleep(0.5)
        if compact:
            press(m, "s", CMD); time.sleep(1.2)
        check(f"⌘L opens the address bar centred, results under it ({'compact' if compact else 'normal'})",
              got["open"] and abs(got["centre"]) <= 2 and got["list"] is not None and abs(got["list"]) <= 5, str(got))


def live_folders(m):
    # The native host is a stand-in (fake_github_host.py) that answers from
    # m.fake_prs; the test rewrites the file and asks Kitsune to refresh.
    def answer(items, renamed=()):
        json.dump({"folders": [{"id": "smoke", "name": "Smoke PRs", "container": "firefox-container-2"}],
                   "items": {"smoke": [{"url": f"https://example.org/?smoke-pr-{n}", "title": f"Pull request {n}" + (" renamed" if n in renamed else ""),
                                        "number": n, "repo": "smoke"} for n in items]}}, open(m.fake_prs, "w"))
        return extension_message(m, {"type": "refreshLiveFolders"})

    state = H + """
      const pf = await panelFor(), out = [], isGroup = t => url(t).includes("/sidebery/group.html");
      for (const w of [main(), other()]) {
        const group = w.gBrowser.tabs.find(t => !t.pinned && url(t).includes("/sidebery/group.html#Smoke%20PRs"));
        const prs = w.gBrowser.tabs.filter(t => t.label.includes("Pull request "));
        const run = w.gBrowser.tabs.filter(t => !t.pinned && t.userContextId === 2);
        const before = group ? run.slice(0, run.indexOf(group)) : [];
        out.push({group: !!group, inFolder: prs.filter(t => group && t.openerTab === group).map(t => t.label.replace(/^.*Pull/, "Pull")).sort(),
                  outside: prs.filter(t => !group || t.openerTab !== group).map(t => t.label),
                  loaded: prs.filter(t => t.linkedPanel && !t.hasAttribute("pending") && !t.selected).map(t => t.label),  // pending: not loaded yet
                  first: before.every(t => isGroup(t) || (t.openerTab && isGroup(t.openerTab))),
                  space: !!group && sbPanel(w, group) === pf["firefox-container-2"]});
      }
      return out;"""
    replied = answer([1, 2])
    time.sleep(4)
    first = m.js(state)
    want = ["Pull request 1", "Pull request 2"]
    check("a live folder is in every window, first in its space, with its pull requests unloaded",
          replied is True and all(w["group"] and w["inFolder"] == want and not w["outside"] and not w["loaded"] and w["first"] and w["space"]
                                  for w in first), f"{replied}, {first}")
    m.js(H + """const t = main().gBrowser.tabs.find(t => t.label.endsWith("Pull request 1")); if (t) main().gBrowser.removeTab(t); await wait(3000); return 1;""")
    answer([1, 2, 3])
    time.sleep(4)
    second = m.js(state)
    check("a closed pull request tab stays closed when the folder is refreshed",
          all(w["inFolder"] == ["Pull request 2", "Pull request 3"] and not w["outside"] for w in second), str(second))
    # Merged while you read it: the selected tab stays until you leave it. (In
    # the other window: the refresh is asked for from a page in the main one.)
    k = m.js(H + """const w = other(), t = w.gBrowser.tabs.find(t => t.label.endsWith("Pull request 2"));
      if (!t) return null; const k = key(w, t);
      w.focus(); await wait(500); w.__smokePrev = w.gBrowser.selectedTab; w.gBrowser.selectedTab = t; await wait(3000);
      return [k, find(k), wins().map(x => x.gBrowser.tabs.filter(y => key(x, y) === k).map(y => [y.selected, url(y).slice(0, 60)]))];""")
    k, selected, sel_detail = k if k else (None, None, None)
    answer([3])
    time.sleep(4)
    kept = m.js(H + "return find(%s).map(roles => roles.length);" % json.dumps(k))
    check("a pull request that leaves the search keeps its tabs while you are looking at it", k and kept == [1, 1], f"{k}, {kept}, when selected {selected} {sel_detail}")
    m.js(H + """const w = other(); if (w.__smokePrev) w.gBrowser.selectedTab = w.__smokePrev; delete w.__smokePrev; await wait(1500); return 1;""")
    answer([3])
    time.sleep(4)
    third = m.js(state)
    check("a pull request that leaves the search is removed from every window",
          all(w["inFolder"] == ["Pull request 3"] and not w["outside"] for w in third), str(third))
    answer([3], renamed=[3])
    time.sleep(5)
    fourth = m.js(state)
    check("a renamed pull request's unloaded tabs take the new title",
          all(w["inFolder"] == ["Pull request 3 renamed"] and not w["loaded"] for w in fourth), str(fourth))
    # A search that fails (gh logged out, no network) changes nothing.
    json.dump({"folders": [{"id": "smoke", "name": "Smoke PRs", "container": "firefox-container-2"}], "items": {}}, open(m.fake_prs, "w"))
    extension_message(m, {"type": "refreshLiveFolders"})
    time.sleep(3)
    fifth = m.js(state)
    content = lambda ws: [(w["group"], w["inFolder"], w["outside"]) for w in ws]
    check("a failed search leaves the live folder as it was", content(fifth) == content(fourth), f"{fourth} -> {fifth}")
    json.dump({}, open(m.fake_prs, "w"))
    m.js(H + """await removeWhere((w, t) => url(t).includes("group.html#Smoke%20PRs") || t.label.includes("Pull request ")); return 1;""")


def many_tabs(m):
    # Closer to a real setup (yours has about 30 essentials and 50 tabs): ten
    # more essentials and thirty more tabs over the three spaces, then a new
    # window, which must get them all, in their spaces, unloaded.
    r = m.js(H + """
      const w = main();
      for (let i = 0; i < 30; i++) { w.gBrowser.addTrustedTab("https://example.org/?smoke-many-" + i, {userContextId: 1 + i % 3, inBackground: true}); await wait(150); }
      await wait(4000);
      for (let i = 0; i < 10; i++) {
        const t = w.gBrowser.addTrustedTab("https://example.org/?smoke-many-e" + i, {userContextId: 1 + i % 3, inBackground: true});
        await wait(1500); w.gBrowser.pinTab(t); await wait(500);
      }
      await wait(6000);
      const pinned0 = w.gBrowser.tabs.filter(t => t.pinned).length, want = w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length;
      const t0 = Date.now(), n = w.OpenBrowserWindow(); n.__extra = true;
      let ms = null;
      try {
        for (let i = 0; i < 100 && !n.gBrowser; i++) await wait(100);
        for (let i = 0; i < 300 && ms === null; i++) {
          await wait(100);
          if (n.gBrowser.tabs.filter(t => t.pinned).length >= pinned0 && n.gBrowser.tabs.filter(t => !t.pinned && role(n, t)).length >= want) ms = Date.now() - t0;
        }
        const loaded = () => n.gBrowser.tabs.filter(t => t.linkedPanel && !t.selected && url(t).includes("ghost.html"));
        const await_pf = await panelFor();
        for (let i = 0; i < 60 && (i < 16 || loaded().length); i++) await wait(250);
        return {ms, essentials: [pinned0, n.gBrowser.tabs.filter(t => t.pinned).length], tabs: [want, n.gBrowser.tabs.filter(t => !t.pinned && role(n, t)).length],
                stillLoaded: loaded().length, misplaced: {main: await misplaced(w), other: await misplaced(other()), new: await misplaced(n)},
                strip: [w, n].map(x => { const pf = await_pf, runs = [];
                  for (const t of x.gBrowser.tabs) { if (t.pinned) continue; const cell = t.userContextId + ":" + (Object.entries(pf).find(([, id]) => id === sbPanel(x, t))?.[0].slice(-1) ?? "?");
                    if (runs.length && runs[runs.length - 1][0] === cell) runs[runs.length - 1][1]++; else runs.push([cell, 1]); }
                  return runs.map(([c, k]) => c + "x" + k).join(" "); })};
      } finally {
        await close(n);
        // Unpinning one copy removes an essential everywhere; then the tabs go.
        for (const t of w.gBrowser.tabs.filter(t => t.pinned && url(t).includes("smoke-many"))) w.gBrowser.unpinTab(t);
        await wait(4000);
        await removeWhere((x, t) => !t.pinned && url(t).includes("smoke-many"));
      }""")
    check(f"with {r['essentials'][0]} essentials and {r['tabs'][0]} tabs, a new window gets them all ({r['ms']} ms)",
          r["ms"] is not None and r["essentials"][0] == r["essentials"][1] and r["tabs"][0] == r["tabs"][1], str(r))
    check("with that many, every tab is in its container's space in every window, and the placeholders unload",
          not any(r["misplaced"].values()) and not r["stillLoaded"], str(r), sidebery_bug="pin race")
    left = m.js(H + """await wait(2000); return wins().map(w => w.gBrowser.tabs.filter(t => url(t).includes("smoke-many") || (t.pinned && !ek(w, t))).map(t => t.label));""")
    check("and they are all gone again once closed", all(not x for x in left), str(left))


def handover(m):
    r = m.js(H + """
      const t = other().gBrowser.addTrustedTab("https://example.org/?smoke-handover", {userContextId: 1, inBackground: true});
      await wait(4500); const k = key(other(), t);
      await close(other());
      return find(k);""")
    check("closing a window hands its tabs over", r in ([["live/unloaded"]], [["live/loaded"]]), str(r))
    wrong = m.js(H + "return await misplaced(main());")
    check("every tab in the main window is still in its container's space", not wrong, str(wrong[:5]))


def reopened_window(m):
    # Reopening the window closed above (⌘⇧N) brings its tabs back with their
    # Kitsune values; nothing may be doubled.
    r = m.js(H + """
      const count = () => { const by = {};
        for (const [i, w] of wins().entries()) for (const t of w.gBrowser.tabs) { const k = key(w, t); if (!k) continue;
          const c = by[k] ??= {perWindow: wins().map(() => 0), live: 0}; c.perWindow[i]++; if (role(w, t) === "live") c.live++; if (role(w, t) === "copy") c.copy = true; }
        return by; };
      const synced = async () => Object.keys((await storage("%s", ["syncedTabs"])).syncedTabs).length;
      const before = await synced();
      const w = main().SessionStore.undoCloseWindow(0); w.__smoke = true;
      for (let i = 0; i < 100 && !w.gBrowser; i++) await wait(100);
      await wait(9000);
      const by = count(), after = await synced();
      const doubled = Object.entries(by).filter(([, c]) => (!c.copy && c.live !== 1) || c.perWindow.some(n => n !== 1)).map(([k, c]) => [k, c]);
      const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      const dead = w.gBrowser.tabs.filter(t => url(t).includes("ghost.html") && !key(w, t) && !t.pinned)
        .map(t => { const q = new URLSearchParams(url(t).split("?")[1]); return [t.label, q.get("kind"), q.get("kind") === "essential" ? "" : all[q.get("key")] ? "synced" : "gone"]; });
      const pinned = wins().map(x => x.gBrowser.tabs.filter(t => t.pinned).length);
      await close(w);
      return {before, after, doubled: doubled.slice(0, 5), dead, pinned};""" % (EXT_ID, EXT_ID))
    check("a reopened window takes its tabs back, with nothing doubled", r["before"] == r["after"] and not r["doubled"] and not r["dead"]
          and r["pinned"][0] == r["pinned"][1], str(r))


def restart(m):
    # Quitting and starting Firefox again restores both windows with their
    # tabs' Kitsune values: the same essentials and tabs in each, one live tab
    # each, folders with their tabs, every tab in its space, and tab sync and
    # new windows work as before.
    if not m.can_restart:
        print("SKIP  restart (Kitsune is a temporary add-on here, which Firefox removes when it quits; "
              "runs where unsigned add-ons are allowed, as in Developer Edition, or with --xpi)", flush=True)
        return
    snap = H + """
      const out = [];
      for (const w of wins()) {
        const tabs = w.gBrowser.tabs;
        out.push({essentials: tabs.filter(t => t.pinned).map(t => ek(w, t) || "untagged " + t.label),
                  keys: tabs.filter(t => !t.pinned && key(w, t)).map(t => key(w, t)).sort(),
                  live: tabs.filter(t => !t.pinned && role(w, t) === "live").map(t => key(w, t)),
                  untagged: tabs.filter(t => !t.pinned && !key(w, t)).map(t => t.label + " " + url(t).slice(0, 60)),
                  inFolders: tabs.filter(t => /fixture-in-folder/.test(t.label + url(t)) && !(t.openerTab && url(t.openerTab).includes("/sidebery/group.html"))).map(t => t.label),
                  wrong: await misplaced(w)});
      }
      const order = w => JSON.stringify([w.keys, w.essentials, w.untagged]);
      out.sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0);
      const synced = Object.keys((await storage("%s", ["syncedTabs"])).syncedTabs).length;
      return {windows: out, synced};""" % EXT_ID
    m.js(H + """const w = main().OpenBrowserWindow(); for (let i = 0; i < 100 && !w.gBrowser; i++) await wait(100); await wait(9000); return 1;""")
    before = m.js(snap)
    t0 = time.time()
    m.restart()
    # Kitsune starts 5 s after Firefox (onStartup), then fills in what is missing.
    m.js(H + """for (let i = 0; i < 100 && wins().length < 2; i++) await wait(200); await wait(15000); return 1;""")
    after = m.js(snap)
    print(f"INFO  restarted in {round(time.time() - t0)} s: {len(before['windows'])} -> {len(after['windows'])} windows", flush=True)
    bw, aw = before["windows"], after["windows"]
    check("after a restart, both windows have the same essentials and tabs as before",
          len(aw) == len(bw) == 2 and all(w["essentials"] and w["keys"] for w in bw) and [w["essentials"] for w in aw] == [w["essentials"] for w in bw]
          and [w["keys"] for w in aw] == [w["keys"] for w in bw] and after["synced"] == before["synced"],
          f"before {[(len(w['essentials']), len(w['keys'])) for w in bw]} {before['synced']}, after {[(len(w['essentials']), len(w['keys'])) for w in aw]} {after['synced']}; "
          f"same essentials {[a['essentials'] == b['essentials'] for a, b in zip(aw, bw)]}, same tabs {[a['keys'] == b['keys'] for a, b in zip(aw, bw)]}, "
          f"essentials before {[w['essentials'] for w in bw]}, after {[w['essentials'] for w in aw]}, "
          f"tabs gone {[sorted(set(b['keys']) - set(a['keys'])) for a, b in zip(aw, bw)]}, new {[sorted(set(a['keys']) - set(b['keys'])) for a, b in zip(aw, bw)]}")
    lives = sorted(k for w in aw for k in w["live"])
    check("after a restart, every tab is live in one window only, and no other tab came or went",
          len(lives) == len(set(lives)) and sorted(w["untagged"] for w in aw) == sorted(w["untagged"] for w in bw),
          f"doubled {[k for k in lives if lives.count(k) > 1][:3]}, others before {[w['untagged'] for w in bw]}, after {[w['untagged'] for w in aw]}")
    check("after a restart, folders keep their tabs and every tab is in its container's space",
          all(not w["inFolders"] and not w["wrong"] for w in aw), str([(w["inFolders"][:3], w["wrong"][:3]) for w in aw]))
    # Tab sync works as before: a new tab gets a ghost in the other window.
    r = m.js(H + """
      const [a] = wins(); const t = a.gBrowser.addTrustedTab("https://example.org/?smoke-after-restart", {userContextId: 1, inBackground: true});
      await wait(5000); const k = key(a, t), got = find(k);
      await removeWhere((w, x) => key(w, x) === k);
      return got;""")
    check("after a restart, a new tab gets a ghost in the other window", sorted(r) == [["ghost/unloaded"], ["live/loaded"]], str(r))
    r = m.js(H + """
      const [a] = wins(), pinned0 = a.gBrowser.tabs.filter(t => t.pinned).length, want = a.gBrowser.tabs.filter(t => !t.pinned && role(a, t)).length;
      const w = a.OpenBrowserWindow(); for (let i = 0; i < 100 && !w.gBrowser; i++) await wait(100);
      await wait(8000);
      const got = [w.gBrowser.tabs.filter(t => t.pinned).length, w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length];
      await close(w);
      return {want: [pinned0, want], got};""")
    check("after a restart, a new window gets all essentials and tabs", r["want"] == r["got"], str(r))


def main():
    xpi = None
    if "--xpi" in sys.argv:
        xpi = sys.argv[sys.argv.index("--xpi") + 1]
    elif "--installed" in sys.argv:
        xpi = glob.glob(os.path.expanduser(f"~/Library/Application Support/Firefox/Profiles/*.default-release/extensions/{EXT_ID}.xpi"))[0]
    print(f"Testing {xpi or EXT_DIR} in a test Firefox", flush=True)
    t0 = time.time()
    with TestFirefox(xpi=xpi) as m:
        global sidebery_version
        sidebery_version = m.js("""const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          return (await AddonManager.getAddonByID(args[0])).version;""", SIDEBERY_ID)
        print(f"Sidebery {sidebery_version}", flush=True)
        for group in (external_links, new_window, more_windows, essentials, folders, tab_sync, folder_pull, ghost_title, pinned_ghost, orphans, popups, archiving, shortcuts, look, live_folders, many_tabs, handover, reopened_window, restart):
            try:
                group(m)
            except Exception:
                check(f"{group.__name__} ran", False, traceback.format_exc(limit=2).strip().splitlines()[-1])
                m.chrome()
    print(f"\n{sum(results)}/{len(results)} passed in {round(time.time() - t0)} s"
          + (f" ({len(known)} known Sidebery bug)" if known else ""))
    sys.exit(0 if all(results) else 1)


main()
