#!/usr/bin/python3
"""Smoke test for Tidier and the Firefox setup in dotfiles.

    tests/smoke.py              # this folder, as a temporary add-on
    tests/smoke.py --installed  # the signed version installed in your Firefox
    tests/smoke.py --xpi FILE   # a given signed .xpi
    tests/smoke.py --only trees,folders  # only these groups (the def names below)
    tests/smoke.py --serial     # all groups in one test Firefox (as on GitHub)
    tests/smoke.py --port 3000  # on other ports, to run beside another smoke test

By default the groups run in three test Firefoxes at once (SHARDS). The
logic that needs no Firefox has unit tests instead, in under a second:
`node --test` (in this repo).

It runs in an invisible test Firefox with a throwaway profile (see
testfirefox.py), so it never touches your own Firefox: no restart, no window,
no clipboard. The profile is built from dotfiles and tests/fixtures, with test
tabs in each space. Each group of checks runs on its own; a check that crashes
is reported as failed. It checks that:

  - a new window gets every essential and synced tab, unloaded, with the same
    essentials and folders per container, each container in one Sidebery space,
    also in three more new windows opened while another space is active;
  - a new window gets every folder with its own tabs, also after a tab was
    dragged into another space's folder in the window it is copied from;
  - every tab sits in its container's space in every window, also after an
    essential is closed (and brought back) or newly pinned, and after a tab is
    pulled in from another window;
  - selecting a ghost pulls the live tab in, and leaves no placeholder in
    Recently Closed; a ghost takes its live tab's new title; closing a tab
    closes it everywhere; closing a window hands its tabs over, and reopening
    it doubles nothing;
  - a tab in a folder is saved: closing it while loaded unloads it in its
    place in every window, back to the address it had when it came into the
    folder; ⌘⇧T takes its placeholder's place; closing it unloaded, or after
    dragging it out of the folder, closes it everywhere;
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
    where Tidier can be installed for real: Developer Edition, or --xpi).
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testfirefox import EXT_DIR, EXT_ID, PORT, SIDEBERY_ID, TestFirefox  # noqa: E402

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


setup_only = False  # True while a group runs only to set up others (see run_groups)


def check(name, ok, detail="", sidebery_bug=None):
    if setup_only:  # reported only when it fails, by the run that owns the group
        if not ok:
            results.append(False)
            print(f"FAIL  {name}  (setup for the checks below{'; ' + detail if detail else ''})", flush=True)
        return
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


def fire_message(m, msg):
    """Send a runtime message that makes the extension start again, and with it close the page sending it."""
    m.js(H + """const w = main(); w.focus();
      const t = w.gBrowser.addTrustedTab("moz-extension://" + JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[args[0]] + "/ghost.html?kind=test", {inBackground: false});
      w.gBrowser.selectedTab = t; await wait(1500); return 1;""", EXT_ID)
    into_page(m, "ghost.html?kind=test")
    # The answer comes before the message goes: the page is gone once it has.
    m.cmd("WebDriver:ExecuteAsyncScript", {"script": """const done = arguments[arguments.length - 1], msg = arguments[0], page = window.wrappedJSObject || window;
      setTimeout(() => page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify(msg))), 300); done(1);""", "args": [msg]})
    m.chrome()
    time.sleep(1)


def into_page(m, part, exact=False):
    """Run the next scripts in the page of the tab with `part` in its address, main()'s first. Its
    handle is asked for, since switching through the tabs until the right one loads every unloaded
    tab on the way (Marionette reads each one's message manager), and then a tab that should stay
    unloaded no longer is, because of the test itself. That page would even say something new, as
    it loads in the background, and get a dot."""
    m.chrome()
    handle = m.js(H + """const {NavigableManager} = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
      const t = [main(), ...wins()].flatMap(w => w.gBrowser.tabs).find(t => args[1] ? url(t) === args[0] : url(t).includes(args[0]));
      return t ? NavigableManager.getIdForBrowser(t.linkedBrowser) : null;""", part, exact)
    if not handle:
        raise RuntimeError(f"no tab with {part}")
    m.cmd("Marionette:SetContext", {"value": "content"})
    m.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": False})


def extension_message(m, msg):
    """Send a runtime message from one of the extension's own pages, and return the reply."""
    m.js(H + """const w = main(); w.focus(); w.__beforeHelper = w.gBrowser.selectedTab;
      const t = w.gBrowser.addTrustedTab("moz-extension://" + JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[args[0]] + "/ghost.html?kind=test", {});
      w.gBrowser.selectedTab = t; await wait(1500); return 1;""", EXT_ID)
    into_page(m, "ghost.html?kind=test")
    reply = m.cmd("WebDriver:ExecuteAsyncScript", {"script": """
      const done = arguments[arguments.length - 1];
      (window.wrappedJSObject || window).browser.runtime.sendMessage(arguments[0]).then(r => done(JSON.parse(JSON.stringify(r ?? null))), e => done({error: String(e)}));""",
      "args": [msg]})
    m.chrome()
    # Close the helper page with the tab selected before it back in front;
    # otherwise Firefox selects a neighbour, which may be a ghost that Tidier
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
    # An essential in another space is Sidebery's pin race (seen when the
    # machine is busy); anything else is strict.
    for ctx, v in sorted(old.items()):
        n = new.get(ctx, {})
        same = (n.get("essentials"), n.get("folders")) == (v["essentials"], v["folders"])
        check(f"container {ctx}: the same essentials and folders in the new window", same, f"main {v} / new {n}")
        check(f"container {ctx}: in one space in the new window", len(n.get("spaces", [])) == 1, f"main {v} / new {n}",
              sidebery_bug="pin race" if same else None)
    for which in ("main", "other"):
        wrong = m.js(H + f"return await misplaced({which}());")
        name = f"every tab in the {'main' if which == 'main' else 'new'} window is in its container's space"
        check(name, not wrong, str(wrong[:5]), sidebery_bug="pin race" if all(x.startswith("essential ") for x in wrong) else None)


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
          sidebery_bug="pin race" if all(y.startswith("essential ") for x in wrong for y in x) else None)
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
      // The copy opens the page, or the copy loaded in the other window is moved in in its place.
      const ctx = e.userContextId, k = ek(w, e); w.gBrowser.selectedTab = e; await wait(4000);
      const s = w.gBrowser.selectedTab;
      return {web: /^https?:/.test(url(s)), pinned: s.pinned, sameContainer: s.userContextId === ctx, same: ek(w, s) === k};""")
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
    # The same with an unloaded copy, which Firefox unpins for a moment on the way.
    r = m.js(H + """
      const w = main(), t = w.gBrowser.tabs.find(x => x.pinned && ek(w, x) && !x.selected);
      if (!t) return null;
      if (t.linkedPanel) { w.gBrowser.discardBrowser(t); await wait(500); }
      const k = ek(w, t);
      other().gBrowser.adoptTab(t, {tabIndex: 0}); await wait(5000);
      const list = (await storage("%s", ["essentials"])).essentials, entry = list.find(e => e.key === k);
      const there = other().gBrowser.tabs.find(y => y.pinned && ek(other(), y) === k);
      return {inList: !!entry, copies: wins().map(x => x.gBrowser.tabs.filter(y => y.pinned && ek(x, y) === k).length),
              named: !!there && there.label === (entry?.name || entry?.title)};""" % EXT_ID)
    check("an unloaded essential dragged to the other window stays an essential, there once with its name, and back in the window it left",
          r == {"inList": True, "copies": [1, 1], "named": True}, str(r))
    r = m.js(H + """
      const byKey = Object.fromEntries((await storage("%s", ["essentials"])).essentials.map(e => [e.key, e.name || e.title]));
      const w = other(), copies = w.gBrowser.tabs.filter(t => t.pinned && !t.linkedPanel && ek(w, t));
      return {copies: copies.length, wrong: copies.filter(t => t.label !== byKey[ek(w, t)]).map(t => [t.label, byKey[ek(w, t)]])};""" % EXT_ID)
    check("unloaded essentials show their name", r["copies"] > 0 and not r["wrong"], str(r))
    essential_once(m)
    essential_title(m)


def essential_once(m):
    # An essential is loaded in one window only (two loaded Slacks play every
    # notification sound twice): selecting its copy in the other window moves
    # the loaded tab there and leaves a placeholder behind, and a copy that
    # loads its page anyway (as after a restart) makes the other a placeholder.
    r = m.js(H + """
      const a = main(), b = other(), pf = await panelFor();
      const loaded = k => wins().flatMap(w => w.gBrowser.tabs.filter(t => t.pinned && ek(w, t) === k && t.linkedPanel && !url(t).includes("ghost.html"))
        .map(t => (w === a ? "main" : "other") + (t.selected ? "/selected" : "")));
      const copyIn = (w, k) => w.gBrowser.tabs.find(t => t.pinned && ek(w, t) === k);
      a.focus(); await wait(500);
      const e = a.gBrowser.tabs.find(t => t.pinned && ek(a, t) && t.userContextId === 3);
      if (!e) return null;
      const k = ek(a, e); a.gBrowser.selectedTab = e; await wait(4000);
      const out = {first: loaded(k)};
      b.focus(); await wait(500); b.gBrowser.selectedTab = copyIn(b, k); await wait(5000);
      const there = copyIn(b, k), left = copyIn(a, k);
      out.pulled = {loaded: loaded(k), copies: wins().map(w => w.gBrowser.tabs.filter(t => t.pinned && ek(w, t) === k).length),
                    leftIsPlaceholder: !!left && url(left).includes("ghost.html"), spaces: [there && sbPanel(b, there), left && sbPanel(a, left)], want: pf["firefox-container-3"]};
      // Restored by Firefox in the window you are not using, selected there (as
      // after a restart): that copy loads its page itself.
      a.gBrowser.selectedTab = left; await wait(1500);  // selected in a window you are not using, it stays a placeholder
      out.waits = {selectedThere: url(left).includes("ghost.html"), loaded: loaded(k)};
      left.linkedBrowser.loadURI(Services.io.newURI(url(there)), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      await wait(5000);
      out.restored = loaded(k);
      out.misplaced = [...await misplaced(a), ...await misplaced(b)];
      a.focus(); await wait(500);
      return out;""")
    check("an essential is loaded in one window: selecting its copy moves the loaded tab in, in its space, and leaves a placeholder",
          r and r["first"] == ["main/selected"] and r["pulled"]["loaded"] == ["other/selected"] and r["pulled"]["copies"] == [1, 1]
          and r["pulled"]["leftIsPlaceholder"] and r["pulled"]["spaces"] == [r["pulled"]["want"]] * 2 and not r["misplaced"], str(r))
    check("an essential's placeholder selected in a window you are not using stays a placeholder",
          r and r["waits"] == {"selectedThere": True, "loaded": ["other/selected"]}, str(r))
    check("an essential copy that loads its page in another window makes that one a placeholder again", r and r["restored"] == ["other/selected"], str(r))


def set_title(m, address, title):
    """Set the title of the (loaded) page at `address`, in its own tab."""
    try:
        into_page(m, address, exact=True)
        m.cmd("WebDriver:ExecuteScript", {"script": "document.title = arguments[0];", "args": [title]})
        return True
    except RuntimeError as e:
        if "no tab with" not in str(e):
            raise
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
    extension_message(m, {"type": "flush"})
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


def trees(m):
    # A tab dragged into another space's folder (Sidebery then changes its
    # space and folder) must not spread to a new window: there, tabs used to
    # be moved into the dragged order one by one, and Sidebery put every tab
    # between a folder and one of its tabs into that folder (all of them, in
    # every space). The new window must get Tidier's own record of the tree
    # (each tab's folder), tab by tab, whatever the other windows look like.
    r = m.js(H + """
      const SB = "extension:%s:data", m0 = main();
      const sbData = (w, t) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, SB) || "{}"); } catch (e) { return {}; } };
      const tree = w => {
        const tabs = w.gBrowser.tabs.filter(t => !t.pinned && value(w, t, "syncKey")), byId = new Map(tabs.map(t => [sbData(w, t).id, t]));
        return Object.fromEntries(tabs.map(t => { const p = byId.get(sbData(w, t).parentId); return [value(w, t, "syncKey"), p ? value(w, p, "syncKey") : null]; }));
      };
      const name = {}; for (const t of m0.gBrowser.tabs) name[value(m0, t, "syncKey")] = (url(t).match(/fixture-[a-z-]+[0-9-]+|#[^~]+/) || [t.label])[0];
      const gB = m0.gBrowser, byUrl = s => gB.tabs.find(t => url(t).includes(s));
      const dragged = byUrl("fixture-in-folder-1-1"), home = byUrl("fixture-in-folder-1-2");
      gB.moveTabTo(dragged, {tabIndex: gB.tabs.indexOf(byUrl("fixture-in-folder-3-1")) + 1});
      await wait(3000);
      const synced = (await storage("%s", ["syncedTabs"])).syncedTabs || {};
      const before = Object.fromEntries(Object.keys(tree(m0)).filter(k => synced[k]).map(k => [k, synced[k].parentKey || null]));
      const w = m0.OpenBrowserWindow(); w.__extra = true;
      let wrong;
      try {
        for (let i = 0; i < 100 && !w.gBrowser; i++) await wait(100);
        for (let i = 0; i < 100 && Object.keys(tree(w)).length < Object.keys(before).length; i++) await wait(100);
        // Until the tree has stayed the same for 2 s (at most 12 s): Tidier sorts 1.5 s after filling.
        let now = tree(w), same = 0;
        for (let i = 0; i < 24 && same < 4; i++) { await wait(500); const t = tree(w); same = JSON.stringify(t) === JSON.stringify(now) ? same + 1 : 0; now = t; }
        // Named by their stored address (a ghost's own address is its placeholder's).
        const nm = k => (synced[k]?.url?.match(/fixture-[a-z-]+[0-9-]+|#[^~]+|smoke-[a-z-]+/) || [synced[k]?.title || name[k] || k])[0];
        const folder = k => k ? nm(k) : "no folder";
        wrong = Object.keys(before).filter(k => now[k] !== before[k]).map(k => nm(k) + " in " + folder(now[k]) + ", not " + folder(before[k]));
        if (wrong.length) {
          // For finding out why: each window's tabs in the spaces concerned,
          // indented by Sidebery's tree, with their role, and Tidier's record.
          const ctxs = new Set(Object.keys(before).filter(k => now[k] !== before[k]).map(k => synced[k]?.cookieStoreId));
          const strip = x => { const ts = x.gBrowser.tabs.filter(t => !t.pinned && ctxs.has(ctxOf(t))), byId = new Map(ts.map(t => [sbData(x, t).id, t]));
            const depth = t => { let d = 0; for (let p = byId.get(sbData(x, t).parentId); p && d < 9; p = byId.get(sbData(x, p).parentId)) d++; return d; };
            return ts.map(t => "  ".repeat(depth(t)) + (value(x, t, "syncKey") ? nm(value(x, t, "syncKey")) : t.label) + " [" + (role(x, t) || "-") + "]"); };
          wrong.push({main: strip(m0), other: strip(other()), new: strip(w),
            stored: Object.keys(synced).filter(k => ctxs.has(synced[k].cookieStoreId)).map(k => nm(k) + " < " + folder(synced[k].parentKey))});
        }
      } finally { await close(w); }
      gB.moveTabBefore(dragged, home);  // put it back for the checks after this one
      await wait(4000);
      return {tabs: Object.keys(before).length, wrong};""" % (SIDEBERY_ID, EXT_ID))
    wrong = [x for x in r["wrong"] if isinstance(x, str)]
    check("a tab dragged into another space's folder leaves new windows' folders alone", r["tabs"] > 0 and not wrong,
          f"{len(wrong)} of {r['tabs']} tabs in the wrong folder: {wrong[:6]}; " + json.dumps([x for x in r["wrong"] if not isinstance(x, str)]))


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
      const a = main(), urls = ["https://example.org/?smoke-quick-1", "https://example.org/?smoke-quick-2", "https://example.org/?smoke-quick-3"];
      const tabs = urls.map(u => a.gBrowser.addTrustedTab(u, {userContextId: 3, inBackground: true}));
      await wait(4500);
      const ks = tabs.map(t => key(a, t)), w = other(), ghost = k => w.gBrowser.tabs.find(x => key(w, x) === k);
      w.focus(); await wait(800);
      // Two selected right after each other: both come, and the last stays selected.
      w.gBrowser.selectedTab = ghost(ks[0]); await wait(150); w.gBrowser.selectedTab = ghost(ks[1]);
      await wait(3000);
      const both = [find(ks[0]), find(ks[1])], selected = key(w, w.gBrowser.selectedTab) === ks[1] && !!w.gBrowser.selectedTab.linkedPanel && !url(w.gBrowser.selectedTab).includes("ghost.html");
      // Closed right after it came: closed everywhere, not only here.
      w.gBrowser.selectedTab = ghost(ks[2]);
      for (let i = 0; i < 40 && !(key(w, w.gBrowser.selectedTab) === ks[2] && !url(w.gBrowser.selectedTab).includes("ghost.html")); i++) await wait(25);
      w.gBrowser.removeTab(w.gBrowser.selectedTab);
      await wait(2500);
      const closed = find(ks[2]);
      await removeWhere((x, t) => ks.includes(key(x, t)));
      return {both, selected, closed};""")
    check("two ghosts selected right after each other both come, and the last is selected",
          r["both"] == [[["ghost/unloaded"], ["live/loaded"]]] * 2 and r["selected"], str(r))
    check("a tab closed right after it was pulled in closes everywhere", r["closed"] == [[], []], str(r))
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


def tab_moves(m):
    # A tab moved into a folder in one window, then out of it again: the other
    # window's ghost follows, in Sidebery's own tree and next to the same tab,
    # and the stored parent follows too (new windows). The move into the folder is
    # made the way Sidebery adopts a tab: placed before the folder's first tab.
    r = m.js(H + """
      const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const id = t => ExtensionParent.apiManager.global.tabTracker.getId(t);
      const sbParent = (w, t) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, "extension:%s:data") || "{}").parentId; } catch (e) { return undefined; } };
      const folderOf = w => w.gBrowser.tabs.find(t => url(t).includes("group.html#Fixture%%20folder%%202"));
      const a = main(), b = other();
      a.focus(); await wait(500);
      const t = a.gBrowser.addTrustedTab("https://example.org/?smoke-move", {userContextId: 2, inBackground: true});
      await wait(6000);  // moves of a tab in its first seconds are Sidebery placing it
      const k = key(a, t);
      // Where the tab is in a window: its Sidebery parent (the folder, or none)
      // and the synced tab right after it.
      const place = w => { const ts = [...w.gBrowser.tabs], x = ts.find(y => key(w, y) === k);
        if (!x) return null; const next = ts.slice(ts.indexOf(x) + 1).find(y => key(w, y));
        const p = sbParent(w, x), name = y => y === x ? "*moved*" : (url(y).match(/fixture-[a-z-]+[0-9-]+|#Fixture[^~]+|smoke-[a-z-]+/) || [y.label.slice(0, 12)])[0];
        return {inFolder: p === id(folderOf(w)), root: p === -1, next: next ? key(w, next) : null,
          opener: x.openerTab ? ts.indexOf(x.openerTab) : null, at: ts.indexOf(x), folderAt: ts.indexOf(folderOf(w)),
          space: ts.filter(y => !y.pinned && y.userContextId === 2).map(y => (sbParent(w, y) > 0 ? "  " : "") + name(y))}; };
      const stored = async () => (await storage("%s", ["syncedTabs"])).syncedTabs?.[JSON.parse(k)]?.parentKey ?? null;
      const folderKey = JSON.parse(key(a, folderOf(a)));
      const first = a.gBrowser.tabs[a.gBrowser.tabs.indexOf(folderOf(a)) + 1];
      a.gBrowser.moveTabBefore(t, first); await wait(5000);
      const into = {a: place(a), b: place(b), stored: (await stored()) === folderKey};
      a.gBrowser.moveTabBefore(t, folderOf(a)); await wait(6000);
      const out = {a: place(a), b: place(b), stored: await stored()};
      await removeWhere((w, x) => key(w, x) === k);
      return {into, out};""" % (SIDEBERY_ID, EXT_ID))
    into, out = (r or {}).get("into"), (r or {}).get("out")
    check("a tab moved into a folder is in that folder in the other window too, in the same place",
          into and into["a"] and into["a"]["inFolder"] and into["b"] and into["b"]["inFolder"] and into["b"]["next"] == into["a"]["next"] and into["stored"], str(into))
    check("a tab moved out of a folder leaves it in the other window too, in the same place",
          out and out["a"] and out["a"]["root"] and out["b"] and out["b"]["root"] and out["b"]["next"] == out["a"]["next"] and out["stored"] is None, str(out))


def saved_tabs(m):
    # A tab in a folder is saved: closing it while it is loaded (⌘W) unloads it
    # back to the address it had when it came into the folder, in the same
    # place and in every window; ⌘⇧T takes its placeholder's place; selecting
    # the placeholder opens the saved address. Dragged out of the folder it is
    # an ordinary tab again, which closing closes everywhere; closing a saved
    # tab that is unloaded removes it everywhere too.
    r = m.js(H + """
      const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const id = t => ExtensionParent.apiManager.global.tabTracker.getId(t);
      const sbParent = (w, t) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, "extension:%s:data") || "{}").parentId; } catch (e) { return undefined; } };
      const folderOf = w => w.gBrowser.tabs.find(t => url(t).includes("group.html#Fixture%%20folder%%202"));
      const entry = async k => (await storage("%s", ["syncedTabs"])).syncedTabs?.[JSON.parse(k)] ?? null;
      const a = main(), b = other(), gB = a.gBrowser, SAVED = "https://example.org/?smoke-saved";
      const tabOf = (w, k) => w.gBrowser.tabs.find(t => key(w, t) === k);
      // The tab's folder in this window and the synced tab right after it.
      const place = (w, k) => { const ts = [...w.gBrowser.tabs], x = tabOf(w, k); if (!x) return null;
        const next = ts.slice(ts.indexOf(x) + 1).find(y => key(w, y)); return {inFolder: sbParent(w, x) === id(folderOf(w)), next: next ? key(w, next) : null}; };
      const intoFolder = async address => {
        const t = gB.addTrustedTab(address, {userContextId: 2, inBackground: true});
        await wait(6000);  // moves of a tab in its first seconds are Sidebery placing it
        gB.moveTabBefore(t, gB.tabs[gB.tabs.indexOf(folderOf(a)) + 1]); await wait(5000);
        return t;
      };
      a.focus(); await wait(500);
      const out = {};
      let t = await intoFolder(SAVED);
      const k = key(a, t);
      t.linkedBrowser.loadURI(Services.io.newURI(SAVED + "-later"), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      await wait(3000);
      out.before = {place: place(a, k), url: (await entry(k))?.url, saved: (await entry(k))?.saved?.url};
      gB.selectedTab = t; await wait(500); gB.removeTab(t); await wait(3500);
      out.closed = {tabs: find(k), place: place(a, k), url: (await entry(k))?.url};
      a.SessionStore.undoCloseTab(a, 0); await wait(4500);
      out.reopened = find(k);
      gB.removeTab(tabOf(a, k)); await wait(3500);
      gB.selectedTab = tabOf(a, k); await wait(4000);
      out.opened = {tabs: find(k), url: url(tabOf(a, k))};
      gB.moveTabBefore(tabOf(a, k), folderOf(a)); await wait(6000);  // dragged out of the folder
      out.out = {saved: (await entry(k))?.saved ?? null, parent: (await entry(k))?.parentKey ?? null};
      gB.removeTab(tabOf(a, k)); await wait(3500);
      out.outClosed = {tabs: find(k), stored: await entry(k)};
      t = await intoFolder(SAVED + "-unloaded");
      const k2 = key(a, t);
      gB.selectedTab = folderOf(a); await wait(500); gB.discardBrowser(t); await wait(500);
      gB.removeTab(t); await wait(3500);
      out.unloadedClosed = {tabs: find(k2), stored: await entry(k2)};
      return out;""" % (SIDEBERY_ID, EXT_ID))
    b, c = r["before"], r["closed"]
    check("a tab moved into a folder keeps the address it had then as its saved address",
          b["place"] and b["place"]["inFolder"] and b["url"].endswith("-later") and b["saved"] == "https://example.org/?smoke-saved", str(b))
    check("closing a loaded saved tab unloads it in every window, in its folder and place, back to its saved address",
          c["tabs"] in ([["ghost/unloaded"], ["ghost/unloaded"]], [["live/unloaded"], ["ghost/unloaded"]]) and c["place"]
          and c["place"]["inFolder"] and c["place"]["next"] == b["place"]["next"] and c["url"] == "https://example.org/?smoke-saved", f"before {b}, after {c}")
    check("reopening a closed saved tab (⌘⇧T) takes its placeholder's place", r["reopened"] == [["live/loaded"], ["ghost/unloaded"]], str(r["reopened"]))
    check("selecting a saved tab's placeholder opens its saved address",
          r["opened"]["tabs"] == [["live/loaded"], ["ghost/unloaded"]] and r["opened"]["url"] == "https://example.org/?smoke-saved", str(r["opened"]))
    check("a saved tab dragged out of its folder is an ordinary tab, which closing closes everywhere",
          r["out"] == {"saved": None, "parent": None} and r["outClosed"] == {"tabs": [[], []], "stored": None}, f"{r['out']}, {r['outClosed']}")
    check("closing a saved tab while it is unloaded removes it everywhere",
          r["unloadedClosed"] == {"tabs": [[], []], "stored": None}, str(r["unloadedClosed"]))


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
    # A page with unsaved input: closing it would make Firefox select it and ask.
    setup = m.js(H + """const w = main(), selected = w.gBrowser.selectedTab;
      const t = w.gBrowser.addTrustedTab(args[0] + "/unsaved", {userContextId: 3, inBackground: true});
      await wait(5000);
      return {k: key(w, t), selected: selected.linkedPanel};""", m.pages)
    now = int(time.time() * 1000)
    late = extension_message(m, {"type": "archiveNow", "now": now + 13 * 3600 * 1000, "keys": [json.loads(setup["k"])], "explain": True})
    r = m.js(H + """const k = args[0], there = find(k); await removeUnsaved(k); return there;""".replace("removeUnsaved(k)", """(async k => {
        for (const w of wins()) for (const t of [...w.gBrowser.tabs]) if (key(w, t) === k) w.gBrowser.removeTab(t, {skipPermitUnload: true});
        await wait(2500); })(k)"""), setup["k"])
    check("archiving keeps a page with unsaved input, without asking", late.get("archived") == [] and late.get("kept", {}).get(json.loads(setup["k"])) == "unsaved"
          and sum(len(x) for x in r) == 2, f"{late}, {r}")


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


def tab_menu_off(m):
    # Without the setting a right click on a row only asks Firefox for its tab menu, as it
    # always has, and Tidier's own menu stays out of the daily browser.
    r = sidebar_page(m, """await wait(800); const row = doc.querySelector("#tabs .tab"); const box = row.getBoundingClientRect(); return {id: Number(row.dataset.tab), at: [box.left + 30, box.top + 8], alone: doc.documentElement.classList.contains("alone")};""")
    m.js(H + """const w = main(); w.__before = w.gBrowser.selectedTab; w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(800); return 1;""")
    real_click(m, "/sidebar/sidebar.html", r["at"][0], r["at"][1], button=2)
    time.sleep(1)
    asked = m.js(H + """const w = main(), popup = w.document.getElementById("contentAreaContextMenu"); const data = w.gContextMenu?.contentData?.webExtContextData;
      const got = {state: popup?.state, context: data?.overrideContext ?? null, tabId: data?.tabId ?? null}; popup?.hidePopup(); await wait(300); return got;""")
    own = sidebar_page(m, "return doc.getElementById('menu').hidden;")
    m.js(H + """const w = main(); if (w.__before && !w.__before.closing) w.gBrowser.selectedTab = w.__before; await wait(300);
      for (const t of [...w.gBrowser.tabs]) if (url(t).includes("/sidebar/sidebar.html")) w.gBrowser.removeTab(t); await wait(300); return 1;""")
    check("with the setting off, a right click on a row only asks Firefox for its tab menu", not r["alone"] and own and asked["context"] == "tab" and asked["tabId"] == r["id"], f"{r}, {asked}, {own}")


def live_folders(m):
    # The native host is a stand-in (fake_github_host.py) that answers from
    # m.fake_prs; the test rewrites the file and asks Tidier to refresh.
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


# The extension process's memory and CPU time so far (Tidier shares it with
# Sidebery and Firefox's own extensions).
PROC_INFO = """const info = await ChromeUtils.requestProcInfo();
  const ext = info.children.filter(c => c.type === "extension");
  return {mb: Math.round(ext.reduce((s, c) => s + (c.memory || 0), 0) / 1048576), cpuS: ext.reduce((s, c) => s + (c.cpuTime || 0), 0) / 1e9};"""


def many_tabs(m):
    # Closer to a real setup (yours has about 30 essentials and 50 tabs): ten
    # more essentials and thirty more tabs over the three spaces, then a new
    # window, which must get them all, in their spaces, unloaded.
    before, proc0 = extension_message(m, {"type": "stats"}), m.js(PROC_INFO)
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
    wrong = [x for found in r["misplaced"].values() for x in found]
    check("with that many, every tab is in its container's space in every window", not wrong, str(r),
          sidebery_bug="pin race" if all(x.startswith("essential ") for x in wrong) else None)
    check("with that many, the placeholders unload", not r["stillLoaded"], str(r))
    left = m.js(H + """await wait(2000); return wins().map(w => w.gBrowser.tabs.filter(t => url(t).includes("smoke-many") || (t.pinned && !ek(w, t))).map(t => t.label));""")
    check("and they are all gone again once closed", all(not x for x in left), str(left))
    # Memory and work. Tidier's lists of tabs and windows are back to their
    # size once the tabs and the window are gone (after the 10 s in which
    # closed placeholders are looked for in Recently Closed), and with nothing
    # happening Tidier does nothing (unless a timed check came by).
    time.sleep(12)
    after = extension_message(m, {"type": "stats"})
    grown = {k: (before["sizes"][k], n) for k, n in after["sizes"].items() if n > before["sizes"].get(k, 0)}
    check("Tidier's lists in memory are back to their size once the tabs and the window are closed", not grown, f"grown (before, after): {grown}")
    idle = extension_message(m, {"type": "idle", "ms": 15000})
    if idle["alarms"]:
        print(f"SKIP  idle check: a timed check ran meanwhile ({idle})", flush=True)
    else:
        check("with nothing happening, Tidier does nothing (15 s)", idle["jobs"] == 0 and idle["lookups"] == 0, str(idle))
    # A page whose title ticks must not rewrite Tidier's record at every tick.
    r = m.js(H + """const w = main();
      const t = w.gBrowser.addTrustedTab(args[0] + "/ticking", {userContextId: 3, inBackground: true});
      await wait(5000);
      const k = JSON.parse(key(w, t));
      const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID("%s").extension));
      const seen = new Set(), read = async () => JSON.stringify((await db.get(["syncedTabs"])).syncedTabs);
      for (let i = 0; i < 30; i++) { seen.add(await read()); await wait(500); }
      await removeWhere((x, y) => key(x, y) === key(w, t));
      return {writes: seen.size};""" % EXT_ID, m.pages)
    check("a page whose title ticks writes Tidier's record rarely", r["writes"] <= 3, str(r))
    proc = m.js(PROC_INFO)
    print(f"INFO  for 30 tabs and 10 essentials, a new window and closing them all: {after['jobs'] - before['jobs']} jobs, "
          f"queue busy {round((after['queueMs'] - before['queueMs']) / 1000, 1)} s (Sidebery waits included), "
          f"{after['lookups'] - before['lookups']} tab lookups; extension process (Tidier and Sidebery) "
          f"{proc['mb']} MB, {round(proc['cpuS'] - proc0['cpuS'], 1)} s CPU", flush=True)


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
    # Tidier values; nothing may be doubled.
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


AFTER_MOVE_OVER = """
  const [id] = args;
  const {ExtensionPermissions} = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
  await ExtensionPermissions.add(id, {permissions: ["tabHide"], origins: []}, WebExtensionPolicy.getByID(id).extension);
  return 1;
"""


def no_problems(m, when):
    """Errors inside Tidier (common.js, noteError): each is a tab that was not handled."""
    problems = extension_message(m, {"type": "stats"})["problems"]
    check(f"no errors inside Tidier {when}", not problems, str(problems[-5:]))


# Every window's essentials and tabs, to compare a session before and after.
SNAP = H + """
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


def update(m):
    # What every release does in the daily browser: a new version installed over a
    # running session. Firefox stops Tidier and closes its pages that are loaded,
    # here a placeholder selected in the window you are not using; the record and
    # the unloaded tabs carry everything over.
    if not m.can_restart:
        print("SKIP  update (needs Tidier installed for real: Developer Edition, or --xpi)", flush=True)
        return
    selected = m.js(H + """let a = wins().find(w => w !== main());
      if (!a) { a = main().OpenBrowserWindow(); a.__extra = true; for (let i = 0; i < 100 && !a.gBrowser; i++) await wait(100); await wait(9000); }
      const g = a.gBrowser.tabs.find(t => role(a, t) === "ghost" && !t.pinned && !t.selected);
      a.gBrowser.selectedTab = g; main().focus(); await wait(2000);
      return {key: key(a, g), loaded: !!g.linkedPanel};""")
    before = m.js(SNAP)
    m.cmd("Addon:Install", {"path": m.update_xpi(), "temporary": False})
    m.js(H + "await wait(9000); return 1;")
    after = m.js(SNAP)
    r = m.js(H + """const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const closed = wins().flatMap(w => w.SessionStore.getClosedTabDataForWindow(w)).map(c => c.state.entries?.[c.state.index - 1]?.url || "");
      const lastTab = main().gBrowser.addTrustedTab("https://example.org/?smoke-after-update", {userContextId: 1, inBackground: true});
      await wait(5000);
      const k = key(main(), lastTab), got = find(k);
      await removeWhere((w, x) => key(w, x) === k);
      return {version: (await AddonManager.getAddonByID("%s")).version, closedGhosts: closed.filter(u => u.includes("ghost.html")).length, got};""" % EXT_ID)
    check("an update is installed over the running session", r["version"] == "1.6.999999", str(r))
    bw, aw = before["windows"], after["windows"]
    check("after an update, every window has the same essentials and tabs as before",
          len(aw) == len(bw) and [w["essentials"] for w in aw] == [w["essentials"] for w in bw] and [w["keys"] for w in aw] == [w["keys"] for w in bw]
          and after["synced"] == before["synced"],
          f"selected {selected}; tabs gone {[sorted(set(b['keys']) - set(a['keys'])) for a, b in zip(aw, bw)]}, new {[sorted(set(a['keys']) - set(b['keys'])) for a, b in zip(aw, bw)]}; "
          f"essentials before {[w['essentials'] for w in bw]}, after {[w['essentials'] for w in aw]}; {before['synced']} -> {after['synced']}")
    lives = sorted(k for w in aw for k in w["live"])
    check("after an update, every tab is live in one window only", lives == sorted(k for w in bw for k in w["live"]) and len(lives) == len(set(lives)), f"{lives}")
    check("after an update, no placeholder is left in Recently Closed", r["closedGhosts"] == 0, str(r))
    check("after an update, a new tab gets a ghost in the other window", sorted(r["got"]) == [["ghost/unloaded"], ["live/loaded"]], str(r))
    no_problems(m, "after an update")


def restart(m):
    # Quitting and starting Firefox again restores both windows with their
    # tabs' Tidier values: the same essentials and tabs in each, one live tab
    # each, folders with their tabs, every tab in its space, and tab sync and
    # new windows work as before.
    if not m.can_restart:
        check("the restart test can run here", not os.environ.get("TIDIER_MUST_RESTART"), "TIDIER_MUST_RESTART is set")
        print("SKIP  restart (Tidier is a temporary add-on here, which Firefox removes when it quits; "
              "runs where unsigned add-ons are allowed, as in Developer Edition, or with --xpi)", flush=True)
        return
    no_problems(m, "before a restart")
    snap = SNAP
    m.js(H + """if (wins().length < 2) { const w = main().OpenBrowserWindow(); for (let i = 0; i < 100 && !w.gBrowser; i++) await wait(100); await wait(9000); } return 1;""")
    before = m.js(snap)
    t0 = time.time()
    m.restart()
    # Tidier starts 5 s after Firefox (onStartup), then fills in what is missing.
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


def real_sidebery_export(m):
    """What Sidebery's export of this browser holds, with a snapshot Sidebery itself made (its Create snapshot button)."""
    m.js(H + """const w = main(); w.focus();
      w.gBrowser.addTrustedTab("moz-extension://" + JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[args[0]] + "/page.setup/setup.html#settings_snapshots", {inBackground: true});
      await wait(4000); return 1;""", SIDEBERY_ID)
    m.cmd("Marionette:SetContext", {"value": "content"})
    for h in m.cmd("WebDriver:GetWindowHandles"):
        m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
        if "page.setup" in m.cmd("WebDriver:GetCurrentURL"):
            break
    clicked = m.cmd("WebDriver:ExecuteScript", {"script": """
      const button = [...document.querySelectorAll(".btn")].find(b => b.textContent.trim() === "Create snapshot");
      if (button) button.click();
      return !!button;"""})
    m.chrome()
    return clicked, m.js(H + """for (let i = 0; i < 40 && !(await storage(args[0], ["snapshots"])).snapshots?.length; i++) await wait(250);
      await removeWhere((w, t) => url(t).includes("page.setup"));
      return {ver: "5.6.1", ...(await storage(args[0], ["containers", "sidebar", "snapshots"]))};""", SIDEBERY_ID)


def move_over(m):
    # Moving this browser from Sidebery to Tidier alone, and back (PLAN.md, part D): every
    # folder and tab stays, folder pages go, and the record is what carries it.
    record = H + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      const name = e => e.own ? e.name : decodeURIComponent((e.url.split("#")[1] || "").replace(/~!.*!~$/, ""));
      const folders = {};
      for (const [k, e] of Object.entries(all)) if (e.group) folders[name(e)] = Object.entries(all).filter(([, x]) => x.parentKey === k).map(([x]) => x).sort();
      return {folders, tabs: Object.keys(all).filter(k => !all[k].group).sort(), saved: Object.values(all).filter(e => e.saved).length,
              pages: wins().map(w => w.gBrowser.tabs.filter(t => url(t).includes("group.html")).length)};""" % EXT_ID
    tabs_here = H + """return wins().map(w => w.gBrowser.tabs.filter(t => !t.pinned && role(w, t) && role(w, t) !== "copy").map(t => key(w, t)).sort()).sort();"""
    before, tabs0 = m.js(record), m.js(tabs_here)
    report = extension_message(m, {"type": "settings:get"})["report"]
    check("the report before moving names the folders and their tabs", len(report["folders"]) == len(before["folders"]) and not report["alone"] and report["tabs"] == len(before["tabs"]), str(report))
    # Sidebery's real export, with one folder closed in its snapshot: the record has an address
    # with a suffix Sidebery adds, the snapshot one without. (Closing it in Sidebery's sidebar for
    # real is out of reach here: the sidebar's page cannot be scripted, so `folded` is set here.)
    clicked, export = real_sidebery_export(m)
    closed_folder = sorted(before["folders"])[0]
    in_snapshot = 0
    for window in export.get("snapshots", [{}])[-1].get("tabs", []):
        for panel in window:
            for tab in panel:
                if isinstance(tab, dict) and "group.html#" + closed_folder.replace(" ", "%20") in tab["url"]:
                    tab["folded"] = True
                    in_snapshot += 1
    imported = extension_message(m, {"type": "settings:importSidebery", "backup": export})
    check("Sidebery's own export and snapshot are understood, and a closed folder is found by its address", clicked and in_snapshot == len(before["pages"]) and imported["folds"] == 1 and imported["order"] == 3, f"{clicked}, {in_snapshot}, {imported}")
    check("taking its folds in changes nothing until the move", m.js(tabs_here) == tabs0 and m.js(record) == before, str(m.js(record)))
    m.js(H + """const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID("%s")).disable(); await wait(1500); return 1;""" % SIDEBERY_ID)
    still = m.js(tabs_here)
    check("disabling Sidebery closes no folder page and no tab", m.js(record)["pages"] == before["pages"] and still == tabs0, f"{before['pages']} -> {m.js(record)['pages']}")
    fire_message(m, {"type": "settings:moveOver"})
    m.js(H + "await wait(10000); return 1;")
    m.js(AFTER_MOVE_OVER, EXT_ID)
    after = m.js(record)
    check("after moving over, every folder has its tabs, and the pages are gone",
          after["folders"] == before["folders"] and after["tabs"] == before["tabs"] and after["saved"] == before["saved"] and after["pages"] == [0, 0], f"{before} -> {after}")
    check("after moving over, every window has its tabs", m.js(tabs_here) == tabs0, f"{tabs0} -> {m.js(tabs_here)}")
    folds = m.js(H + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs; return Object.values(all).filter(e => e.group && e.collapsed).map(e => e.name);""" % EXT_ID)
    check("after moving over, the folder closed in Sidebery's snapshot is closed, and no other", folds == [closed_folder], f"{folds}, {closed_folder}")
    r = m.js(H + "await wait(1500); return wins().map(w => [...new Set(w.gBrowser.tabs.filter(t => !t.pinned && !t.hidden && t.userContextId).map(t => t.userContextId))].length);")
    check("after moving over, each window shows one space", all(x == 1 for x in r), str(r))
    no_problems(m, "after moving over")
    # And back: Sidebery on first, and its folder pages return.
    m.js(H + """const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID("%s")).enable(); await wait(4000); return 1;""" % SIDEBERY_ID)
    fire_message(m, {"type": "settings:moveBack"})
    m.js(H + "await wait(10000); return 1;")
    back = m.js(record)
    check("after moving back, every folder has its tabs and its pages", back["folders"] == before["folders"] and back["tabs"] == before["tabs"] and back["pages"] == before["pages"], f"{before} -> {back}")


# The windows whose essentials (pinned tabs) are not together by space, with
# the containers of their pinned tabs in order.
PINS_APART = """
  const apart = cs => !cs.every((c, i) => i === 0 || c === cs[i - 1] || !cs.slice(0, i).includes(c));
  const ws = wins().map(w => w.gBrowser.tabs.filter(t => t.pinned).map(t => t.userContextId + ":" + (ek(w, t) || "-").slice(0, 4)));
  if (!ws.some(cs => apart(cs.map(c => c.split(":")[0])))) return null;
  const list = (await storage("%s", ["essentials"])).essentials.map(e => e.cookieStoreId.slice(-1) + ":" + e.key.slice(0, 4));
  return {windows: ws, list};""" % EXT_ID
apart_after = []


# --- Tidier alone (PLAN.md): no Sidebery, the setting on --------------------------
# In a test Firefox of its own, with test tabs in each space. The sidebar is
# used for real: its page is opened in a tab, where the test can read and click it.

def sidebar_page(m, script, *args):
    """Run `script` in Tidier's sidebar page (opened in a tab of the main window, once)."""
    return ext_page(m, "/sidebar/sidebar.html", script, *args)


def ext_page(m, path, script, *args):
    """Run `script` in one of Tidier's own pages, opened in a tab of the main window, once."""
    m.js(H + """const w = main(); w.focus();
      if (!w.gBrowser.tabs.some(t => url(t).includes(args[1]))) {
        const t = w.gBrowser.addTrustedTab("moz-extension://" + JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[args[0]] + args[1], {inBackground: true});
        await wait(1500);
      }
      return 1;""", EXT_ID, path)
    into_page(m, path)
    reply = m.cmd("WebDriver:ExecuteAsyncScript", {"script": """
      const args = [...arguments], done = args.pop(), wait = ms => new Promise(r => setTimeout(r, ms));
      const page = window.wrappedJSObject || window, doc = page.document;
      const rows = () => [...doc.querySelectorAll("#tabs .tab")].map(r => r.querySelector(".title").textContent);
      const folders = () => [...doc.querySelectorAll("#tabs .folder")].map(f => ({name: f.querySelector(".head .title")?.textContent, tabs: [...f.querySelectorAll(".tab .title")].map(t => t.textContent), collapsed: f.classList.contains("collapsed")}));
      const tiles = () => [...doc.querySelectorAll("#essentials .tile")].map(t => t.title.split("\\n")[0]);
      const spaces = () => [...doc.querySelectorAll("#spaces .space")].map(b => ({id: b.dataset.space, active: b.classList.contains("active")}));
      const plainTabs = () => [...doc.querySelectorAll("#tabs > .tab")].filter(r => r.querySelector(".title").textContent !== "Tidier");
      (async () => {
        const port = page.browser.runtime.connect({name: "sidebar"});
        const send = msg => port.postMessage(page.JSON.parse(JSON.stringify(msg)));
        send({type: "hello", windowId: (await page.browser.windows.getCurrent()).id});
        await wait(100);
        try { """ + script + """ } finally { port.disconnect(); }
      })().then(r => done(JSON.parse(JSON.stringify(r ?? null))), e => done({error: String(e)}));""",
      "args": list(args)})
    m.chrome()
    return reply


def alone_setup(m):
    r = m.js(H + """const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const w = main(); await wait(1500);
      return {sidebery: !!(await AddonManager.getAddonByID("%s")), panel: w.SidebarController.currentID, hidden: w.gBrowser.tabs.filter(t => t.hidden).length, visible: w.gBrowser.tabs.filter(t => !t.hidden).length};""" % SIDEBERY_ID)
    check("Tidier alone runs with no Sidebery, and its sidebar is the sidebar", not r["sidebery"] and "6844a953" in r["panel"], str(r))
    check("Tidier hides the other spaces' tabs", r["hidden"] > 0, str(r))


def alone_second_window(m):
    # A new window gets every essential and tab, in one go, without Sidebery's waits.
    r = m.js(H + """const a = main(), pinned0 = a.gBrowser.tabs.filter(t => t.pinned).length, want = a.gBrowser.tabs.filter(t => !t.pinned && role(a, t)).length;
      const t0 = Date.now(), w = a.OpenBrowserWindow(); w.__smoke = true;
      let ms = null;
      for (let i = 0; i < 200 && ms === null; i++) { await wait(50);
        if (w.gBrowser && w.gBrowser.tabs.filter(t => t.pinned).length >= pinned0 && w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length >= want) ms = Date.now() - t0; }
      await wait(3000);
      const loaded = w.gBrowser.tabs.filter(t => t.linkedPanel && !t.selected && url(t).includes("ghost.html")).map(t => t.label);
      return {ms, want: [pinned0, want], got: [w.gBrowser.tabs.filter(t => t.pinned).length, w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length], loaded,
              pins: w.gBrowser.tabs.filter(t => t.pinned).map(t => t.userContextId), hidden: w.gBrowser.tabs.filter(t => t.hidden).length};""")
    check(f"a new window gets every essential and tab ({r['ms']} ms)", r["want"] == r["got"] and r["ms"] is not None, str(r))
    check("a new window's placeholders unload", not r["loaded"], str(r))
    check("a new window shows one space", r["hidden"] > 0, str(r))


def alone_spaces(m):
    r = sidebar_page(m, """
      await wait(500);
      const before = spaces(), other = before.find(s => !s.active);
      doc.querySelector(`#spaces .space[data-space="${other.id}"]`).click();
      await wait(1500);
      return {before, after: spaces(), wanted: other.id, essentials: tiles().length, name: doc.getElementById("space-name").textContent};""")
    check("the bar shows the spaces, and one is active", len(r["before"]) >= 3 and sum(s["active"] for s in r["before"]) == 1, str(r))
    check("the bar switches space", [s["id"] for s in r["after"] if s["active"]] == [r["wanted"]], str(r))
    check("a space shows its own essentials and its name", r["essentials"] == 2 and r["name"], str(r))
    shown = m.js(H + """const w = main(), selected = w.gBrowser.selectedTab;
      return {space: selected.userContextId, shown: [...new Set(w.gBrowser.tabs.filter(t => !t.pinned && !t.hidden && t.userContextId).map(t => t.userContextId))],
              ctrlTab: w.gBrowser.visibleTabs.filter(t => !t.pinned && t.userContextId && t.userContextId !== selected.userContextId).length};""")
    check("switching hides the other spaces' tabs and shows this one's", shown["shown"] == [shown["space"]] and shown["ctrlTab"] == 0, str(shown))
    r = m.js(H + """const w = main(); w.focus(); await wait(300); const space = w.gBrowser.selectedTab.userContextId;
      // ⌘T: Firefox opens a tab without a container, Tidier opens it again in the space.
      const t = w.gBrowser.addTrustedTab("about:newtab"); w.gBrowser.selectedTab = t; await wait(1500);
      const s = w.gBrowser.selectedTab, got = {space, newTab: s.userContextId, page: url(s), gone: !t.linkedBrowser};
      w.gBrowser.removeTab(s); await wait(800);
      got.afterClose = w.gBrowser.selectedTab.userContextId;
      // A link from another app: an address, without a container.
      const l = w.gBrowser.addTrustedTab("https://example.org/?smoke-alone-link", {inBackground: false}); await wait(4000);
      got.link = wins().map(x => x.gBrowser.tabs.filter(y => url(y).includes("smoke-alone-link")).map(y => y.userContextId));
      await removeWhere((x, y) => url(y).includes("smoke-alone-link") || (y.linkedBrowser && value(x, y, "syncKey") && String(y.label).includes("smoke-alone-link")));
      return got;""")
    check("a new tab opens in the active space", r["newTab"] == r["space"], str(r))
    check("closing it stays in the space", r["afterClose"] == r["space"], str(r))
    check("a link without a container opens in the active space", r["link"][0] == [r["space"]], str(r))
    # An empty space: a new tab there, and closing the last tab stays there.
    r = sidebar_page(m, """
      const empty = doc.querySelector('#spaces .space[data-space="firefox-container-4"]');
      if (!empty) return {missing: true};
      empty.click();
      await wait(1500);
      return {active: spaces().find(s => s.active).id};""")
    check("an empty space can be switched to", r.get("active") == "firefox-container-4", str(r))
    r = m.js(H + """const w = main(); w.focus();
      for (const t of [...w.gBrowser.tabs]) if (url(t).includes("/sidebar/sidebar.html")) w.gBrowser.removeTab(t);  // the test's own
      await wait(500);
      const before = w.gBrowser.selectedTab, got = {before: before.userContextId};
      w.gBrowser.removeTab(before); await wait(1500);
      got.after = w.gBrowser.selectedTab.userContextId;
      got.page = url(w.gBrowser.selectedTab);
      return got;""")
    check("closing the last tab of a space stays in the space, with a new tab", r["before"] == 4 and r["after"] == 4, str(r))
    press(m, "1", CTRL)
    time.sleep(1)
    m.js(H + """const w = main(); await removeWhere((x, t) => !t.pinned && t.userContextId === 4); return 1;""")


def alone_keys(m):
    r = []
    for digit in ("1", "2", "3"):
        press(m, digit, CTRL)
        time.sleep(1)
        r.append(m.js(H + "const w = main(); return {selected: w.gBrowser.selectedTab.userContextId, shown: [...new Set(w.gBrowser.tabs.filter(t => !t.pinned && !t.hidden && t.userContextId).map(t => t.userContextId))]};"))
    check("⌃1, ⌃2 and ⌃3 switch space", len({x["selected"] for x in r}) == 3 and all(x["shown"] == [x["selected"]] for x in r), str(r))


def alone_folders(m):
    r = sidebar_page(m, """
      const n0 = folders().length;
      send({type: "newFolder", space: spaces().find(s => s.active).id, name: "Smoke folder"});
      await wait(1000);
      const made = folders();
      const tab = plainTabs()[0];
      const title = tab.querySelector(".title").textContent, tabId = Number(tab.dataset.tab);
      const head = doc.querySelector("#tabs .folder .head"), key = head.dataset.folderHead;
      send({type: "moveTab", tabId, folder: key, before: null});
      await wait(2500);
      const moved = folders();
      head.click(); await wait(800);
      const closed = folders();
      head.click(); await wait(800);
      send({type: "renameFolder", key, name: "Renamed"});
      await wait(800);
      const renamed = folders();
      return {n0, made, title, tabId, key, moved, closed, renamed};""")
    check("a folder is made in the sidebar", len(r["made"]) == r["n0"] + 1 and r["made"][-1]["name"] == "Smoke folder", str(r))
    check("a tab goes into a folder", r["title"] in r["moved"][-1]["tabs"], str(r))
    check("a folder folds and unfolds", r["closed"][-1]["collapsed"] is True and r["renamed"][-1]["collapsed"] is False, str(r))
    check("a folder is renamed", r["renamed"][-1]["name"] == "Renamed", str(r))
    s = m.js(H + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs, f = all[args[0]];
      const tabs = Object.entries(all).filter(([, e]) => e.parentKey === args[0]);
      return {folder: f && {name: f.name, own: f.own}, saved: tabs.map(([k, e]) => !!e.saved), key: tabs[0]?.[0],
              pages: wins().flatMap(w => w.gBrowser.tabs).filter(t => url(t).includes("group.html")).length,
              reps: tabs[0] ? wins().map(w => w.gBrowser.tabs.filter(t => key(w, t) === JSON.stringify(tabs[0][0])).length) : []};""" % EXT_ID, r["key"])
    check("a folder is Tidier's own data, with no tab of its own, and its tab is saved", s["folder"] == {"name": "Renamed", "own": True} and s["saved"] == [True] and s["pages"] == 0, str(s))
    # ⌘W on a saved tab unloads it, in its place; closing it unloaded removes it.
    k = json.dumps(s["key"])
    u = m.js(H + """const k = args[0], w = main(), t = w.gBrowser.tabs.find(x => key(w, x) === k);
      w.gBrowser.selectedTab = t; await wait(2000);
      const live = w.gBrowser.tabs.find(x => key(w, x) === k);
      w.gBrowser.removeTab(live); await wait(2500);
      return {state: find(k), stored: !!(await storage("%s", ["syncedTabs"])).syncedTabs[JSON.parse(k)]};""" % EXT_ID, k)
    check("⌘W on a tab in a folder unloads it, in every window", u["stored"] and all(len(x) == 1 and x[0].endswith("/unloaded") for x in u["state"]), str(u))
    # The folder survives a tab event, a restart of the background, and deleting it keeps its tabs.
    r = sidebar_page(m, """
      const key = args[0];
      send({type: "deleteFolder", key});
      await wait(1500);
      return {folders: folders(), rows: rows()};""", r["key"])
    check("deleting a folder keeps its tabs, as ordinary tabs", not [f for f in r["folders"] if f["name"] == "Renamed"], str(r))


def alone_moves(m):
    # Tabs moved in the sidebar move in every window; essentials too.
    r = sidebar_page(m, """
      const tabs = plainTabs().map(x => Number(x.dataset.tab));
      const first = tabs[0], last = tabs.at(-1);
      send({type: "moveTab", tabId: last, before: first, folder: null});
      await wait(1500);
      const tiles0 = [...doc.querySelectorAll("#essentials .tile")].map(t => Number(t.dataset.tab));
      send({type: "moveEssential", tabId: tiles0.at(-1), before: tiles0[0]});
      await wait(2000);
      return {count: tabs.length, moved: last, was: first, order: plainTabs().map(x => Number(x.dataset.tab)), tiles0, tiles1: [...doc.querySelectorAll("#essentials .tile")].map(t => Number(t.dataset.tab))};""")
    check("a tab moved in the sidebar is where you put it", r["order"][0] == r["moved"] and r["order"][1] == r["was"], str(r))
    check("an essential moved in the sidebar is where you put it", r["tiles1"][0] == r["tiles0"][-1], str(r))
    same = m.js(H + """const order = w => w.gBrowser.tabs.filter(t => !t.pinned && key(w, t) && t.userContextId === main().gBrowser.selectedTab.userContextId).map(t => key(w, t));
      const pins = w => w.gBrowser.tabs.filter(t => t.pinned).map(t => ek(w, t));
      return {tabs: wins().map(order), pins: wins().map(pins)};""")
    check("other windows have the same order of tabs", all(x == same["tabs"][0] for x in same["tabs"]) and same["tabs"][0], str(same))
    check("other windows have the same order of essentials", all(x == same["pins"][0] for x in same["pins"]), str(same))
    # Pinned and unpinned from the sidebar: an essential in every window, and back.
    r = sidebar_page(m, """
      const tab = plainTabs()[0], tabId = Number(tab.dataset.tab), n = tiles().length, was = tab.querySelector(".title").textContent;
      send({type: "pin", tabId, pinned: true});
      await wait(2000);
      const pinned = tiles().length;
      send({type: "pin", tabId, pinned: false});
      await wait(2500);
      return {n, pinned, after: tiles().length, url: was};""")
    check("a tab pinned in the sidebar is an essential, and unpinned an ordinary tab again", r["pinned"] == r["n"] + 1 and r["after"] == r["n"], str(r))
    r = m.js(H + """let counts;
      for (let i = 0; i < 60; i++) { counts = wins().map(w => w.gBrowser.tabs.filter(t => !t.pinned && t.linkedBrowser && !key(w, t) && /^https:/.test(url(t))).length); if (counts.every(x => x === 0)) break; await wait(100); }
      return counts;""")
    check("an essential unpinned while loaded is synced again, with a ghost in every window", all(x == 0 for x in r), str(r))
    # Moved to another space: there, and gone here, in every window.
    r = sidebar_page(m, """
      const tab = plainTabs()[0], tabId = Number(tab.dataset.tab), there = spaces().find(s => !s.active && s.id !== "firefox-container-4").id;
      const before = plainTabs().length;
      send({type: "moveToSpace", tabId, space: there});
      await wait(3500);
      return {before, after: plainTabs().length, there};""")
    check("a tab moved to another space is gone from this one", r["after"] == r["before"] - 1, str(r))


def alone_live_folders(m):
    # A live folder is one of Tidier's own folders, with no tab of its own.
    m.js(H + """return 1;""")
    open(m.fake_prs, "w").write(json.dumps({"folders": [{"id": "prs", "name": "Pull requests", "container": "firefox-container-1"}],
                                            "items": {"prs": [{"url": "https://example.org/?smoke-pr-1", "title": "One", "number": 1, "repo": "r"},
                                                              {"url": "https://example.org/?smoke-pr-2", "title": "Two", "number": 2, "repo": "r"}]}}))
    extension_message(m, {"type": "refreshLiveFolders"})
    r = m.js(H + """await wait(1500); const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      const f = Object.entries(all).find(([, e]) => e.live === "prs"), tabs = Object.entries(all).filter(([, e]) => e.liveFolder === "prs");
      return {folder: f && {own: f[1].own, name: f[1].name}, tabs: tabs.map(([, e]) => [e.parentKey === f[0], !!e.saved]), reps: tabs.map(([k]) => find(JSON.stringify(k)))};""" % EXT_ID)
    check("a live folder is Tidier's own folder, with its pull requests unloaded in every window", r["folder"] == {"own": True, "name": "Pull requests"}
          and r["tabs"] == [[True, False], [True, False]] and all(all(len(x) == 1 and x[0].endswith("/unloaded") for x in rep) for rep in r["reps"]), str(r))
    open(m.fake_prs, "w").write(json.dumps({"folders": [{"id": "prs", "name": "Pull requests", "container": "firefox-container-1"}], "items": {"prs": []}}))
    extension_message(m, {"type": "refreshLiveFolders"})
    r = m.js(H + """await wait(1500); const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      return {tabs: Object.values(all).filter(e => e.liveFolder === "prs").length, left: wins().flatMap(w => w.gBrowser.tabs).filter(t => t.label.includes("r#")).length, folder: Object.values(all).some(e => e.live === "prs")};""" % EXT_ID)
    check("a pull request that leaves the search is removed, and the folder stays", r["tabs"] == 0 and r["left"] == 0 and r["folder"], str(r))


def alone_safe_moves(m):
    # Moves that cannot lose anything (safemoves.js), and a sidebar that comes back.
    # Where the tab with this address is: the container of each tab that has it (only the
    # real tab does), and of every copy in every window once it is in the record.
    where_script = H + """const pairs = wins().flatMap(w => w.gBrowser.tabs.filter(t => url(t).includes(args[0])).map(t => [w, t]));
      const k = pairs[0] && key(pairs[0][0], pairs[0][1]);
      return {at: pairs.map(([w, t]) => ctxOf(t)), selected: pairs.some(([w, t]) => t.selected && w === main()), loaded: pairs.every(([w, t]) => !!t.linkedPanel),
              registered: !!k, copies: k ? wins().flatMap(w => w.gBrowser.tabs.filter(t => key(w, t) === k).map(t => ctxOf(t))) : [], windows: wins().length};"""
    # In the sidebar: a real drag of a tab's row onto a space's dot, and the queue done with it.
    drop_on_space = """
      const dropOnSpace = async (tabId, space) => {
        const from = doc.querySelector(`#tabs .tab[data-tab="${tabId}"]`), to = doc.querySelector(`#spaces .space[data-space="${space}"]`);
        if (!from || !to) return false;
        const data = new page.DataTransfer(), box = to.getBoundingClientRect();
        const at = {bubbles: true, cancelable: true, clientX: box.left + 2, clientY: box.top + 2, dataTransfer: data};
        from.dispatchEvent(new page.DragEvent("dragstart", at));
        to.dispatchEvent(new page.DragEvent("dragover", at));
        to.dispatchEvent(new page.DragEvent("drop", at));
        from.dispatchEvent(new page.DragEvent("dragend", at));
        await wait(300);
        await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "stats"})));
        return true;
      };
      const tabWith = async text => (await page.browser.tabs.query({})).find(t => t.url.includes(text))?.id;
    """

    def until(what, tries=60):
        """What `what()` returns, as soon as its "done" says so, tried for up to 15 s."""
        for _ in range(tries):
            r = what()
            if r.get("done"):
                break
            time.sleep(0.25)
        return r

    def registered_where(text):
        """Where it is, once it is in the record and has a copy in every window."""
        def seen():
            r = m.js(where_script, text)
            return {**r, "done": r["registered"] and len(r["copies"]) == r["windows"]}
        return until(seen)

    def set_rules(rules):
        sidebar_page(m, """await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "settings:rules", rules: args[0]}))); return 1;""", rules)

    def open_in(address, space):
        m.js(H + """main().gBrowser.addTrustedTab(args[0], {userContextId: Number(args[1].split("-").pop()), inBackground: true}); return 1;""", address, space)

    def select_tab(text):
        m.js(H + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes(args[0])); await wait(400); return 1;""", text)

    def in_page(text, script):
        """Run `script` in the web page whose address has this text."""
        into_page(m, text)
        reply = m.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})
        m.chrome()
        return reply

    spaces = sidebar_page(m, """return {here: spaces().find(s => s.active).id, there: spaces().find(s => !s.active && s.id !== "firefox-container-4").id};""")
    here, there = spaces["here"], spaces["there"]

    # A rule for a site in this space; the tab moved by hand to another stays there.
    set_rules([{"url": "smoke-safe-rule", "space": here}])
    open_in("https://example.org/?smoke-safe-rule", here)
    r = registered_where("smoke-safe-rule")
    check("a tab that matches a rule for its own space stays there", r["at"] == [here], str(r))
    moved = sidebar_page(m, drop_on_space + """return await dropOnSpace(await tabWith("smoke-safe-rule"), args[0]);""", there)
    check("a tab can be dropped on a space", moved is True, str(moved))
    r = registered_where("smoke-safe-rule")
    check("a tab moved by hand is not sent back by a rule", r["at"] == [there] and set(r["copies"]) == {there}, str(r))
    time.sleep(1)
    r = m.js(where_script, "smoke-safe-rule")
    check("and it is still there a moment later, once", r["at"] == [there], str(r))
    set_rules([])

    # The selected tab: it goes, and you stay in the space, on a tab that was there.
    open_in("https://example.org/?smoke-safe-selected", here)
    registered_where("smoke-safe-selected")
    select_tab("smoke-safe-selected")
    r = sidebar_page(m, drop_on_space + """const id = await tabWith("smoke-safe-selected"), dropped = await dropOnSpace(id, args[0]);
      const [on] = await page.browser.tabs.query({active: true, windowId: (await page.browser.windows.getCurrent()).id});
      return {dropped, on: on.cookieStoreId, gone: !doc.querySelector(`#tabs .tab[data-tab="${id}"]`), active: spaces().find(s => s.active).id};""", there)
    where = registered_where("smoke-safe-selected")
    check("the selected tab can be moved, and you stay in your space", r["dropped"] and r["on"] == here and r["active"] == here and where["at"] == [there] and not where["selected"], f"{r} {where}")

    # A page still loading has its new address, and the record follows when it has finished.
    open_in(m.pages + "/plain?smoke-safe-app", here)
    registered_where("smoke-safe-app")
    in_page("smoke-safe-app", """location.href = "/slow?smoke-safe-deeper"; return 1;""")

    def going():
        state = m.js(where_script, "smoke-safe-deeper")
        return {**state, "done": state["at"] == [here]}
    until(going)
    moved = sidebar_page(m, drop_on_space + """return await dropOnSpace(await tabWith("smoke-safe-deeper"), args[0]);""", there)

    def deeper():
        state = m.js(where_script, "smoke-safe-deeper")
        return {**state, "done": state["at"] == [there]}
    r = until(deeper)
    left = m.js(where_script, "smoke-safe-app")
    check("a page still loading, moved, takes its new address", moved is True and r["at"] == [there] and left["at"] == [], f"{moved} {r} {left}")

    # A space that is gone by the time of the move: nothing happens to the tab, selected or not.
    open_in("https://example.org/?smoke-safe-nowhere", here)
    registered_where("smoke-safe-nowhere")
    for selected in (False, True):
        if selected:
            select_tab("smoke-safe-nowhere")
        r = sidebar_page(m, drop_on_space + """const id = await tabWith("smoke-safe-nowhere"); send({type: "moveToSpace", tabId: id, space: "firefox-container-99"}); await wait(300);
          await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "stats"})));
          const t = await page.browser.tabs.get(id); return {active: t.active, loaded: !t.discarded};""")
        where = m.js(where_script, "smoke-safe-nowhere")
        check(f"a move to a space that is gone leaves the tab {'selected' if selected else 'where it is'}, loaded", r == {"active": selected, "loaded": True} and where["at"] == [here], f"{r} {where}")

    # A row that is a placeholder: its page is loaded and selected in the other window.
    if m.js(H + """return wins().length;""") < 2:
        print("SKIP  a placeholder with its page in the other window (needs alone_second_window)", flush=True)
    else:
        open_in("https://example.org/?smoke-safe-away", here)
        registered_where("smoke-safe-away")
        away = sidebar_page(m, """const here = (await page.browser.windows.getCurrent()).id, all = (await page.browser.tabs.query({})).filter(t => t.url.includes("smoke-safe-away") || t.title.includes("smoke-safe-away"));
          const windows = await page.browser.windows.getAll({windowTypes: ["normal"]}), other = windows.find(w => w.id !== here);
          const keys = await Promise.all((await page.browser.tabs.query({windowId: other.id})).map(async t => [t.id, await page.browser.sessions.getTabValue(t.id, "syncKey")]));
          const live = all[0], key = await page.browser.sessions.getTabValue(live.id, "syncKey");
          return {here, other: other.id, ghost: keys.find(([, k]) => k === key)[0], live: live.id, key};""")
        m.js(H + """const w = wins().find(x => x.gBrowser.tabs.some(t => key(x, t) === JSON.stringify(args[0]) && !url(t).includes("smoke-safe-away")));
          w.focus(); await wait(300);
          w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => key(w, t) === JSON.stringify(args[0]));
          for (let i = 0; i < 40 && !url(w.gBrowser.selectedTab).includes("smoke-safe-away"); i++) await wait(100);
          main().focus(); await wait(300); return 1;""", away["key"])
        r = sidebar_page(m, """const rep = (await page.browser.tabs.query({windowId: args[0]})), keys = await Promise.all(rep.map(t => page.browser.sessions.getTabValue(t.id, "syncKey")));
          const row = rep[keys.indexOf(args[1])], real = (await page.browser.tabs.query({})).find(t => t.url.includes("smoke-safe-away"));
          send({type: "moveToSpace", tabId: row.id, space: args[2]}); await wait(300);
          await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "stats"})));
          return {rowUnloaded: row.discarded || row.url.includes("ghost.html"), realElsewhere: real.windowId !== args[0], realSelected: real.active};""", away["here"], away["key"], there)
        where = registered_where("smoke-safe-away")
        selected_there = m.js(H + """const w = wins().find(x => x !== main()); return w.gBrowser.selectedTab.userContextId ? "firefox-container-" + w.gBrowser.selectedTab.userContextId : "firefox-default";""")
        check("a placeholder moves, with its page selected in the other window: once, and that window stays in its space", r["rowUnloaded"] and r["realElsewhere"] and r["realSelected"] and where["at"] == [there] and set(where["copies"]) == {there} and selected_there == here, f"{r} {where} {selected_there}")

    # Tabs Firefox brings back: not sent away by a rule, for they are not new.
    set_rules([{"url": "smoke-safe-back", "space": here}])
    open_in("https://example.org/?smoke-safe-back", there)  # a tab opened with an address goes by the rule, so to `here`
    r = registered_where("smoke-safe-back")
    check("a new tab goes by the rule", r["at"] == [here], str(r))
    sidebar_page(m, drop_on_space + """return await dropOnSpace(await tabWith("smoke-safe-back"), args[0]);""", there)
    r = registered_where("smoke-safe-back")
    check("(moved by hand, it stays)", r["at"] == [there], str(r))
    # Closed for good, then ⌘⇧T: Firefox's own undo, with the tab's own values.
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("smoke-safe-back")); w.gBrowser.removeTab(t); await wait(1500); return 1;""")
    gone = m.js(where_script, "smoke-safe-back")
    m.js(H + """main().SessionStore.undoCloseTab(main(), 0); await wait(3000); return 1;""")
    r = registered_where("smoke-safe-back")
    check("a tab brought back with ⌘⇧T is not sent away by a rule", gone["at"] == [] and r["at"] == [there], f"{gone} {r}")
    # In a folder, closed while loaded, and selected again: its placeholder loads itself.
    folder = sidebar_page(m, """send({type: "newFolder", space: args[0], name: "smoke-safe-folder"}); await wait(500);
      const all = (await page.browser.storage.local.get("syncedTabs")).syncedTabs; return Object.entries(all).find(([, e]) => e.name === "smoke-safe-folder")?.[0];""", there)
    sidebar_page(m, """const id = (await page.browser.tabs.query({})).find(t => t.url.includes("smoke-safe-back")).id;
      send({type: "moveTab", tabId: id, before: null, folder: args[0]}); await wait(500); return 1;""", folder)
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("smoke-safe-back")); w.gBrowser.removeTab(t); await wait(1500); return 1;""")
    unloaded = sidebar_page(m, """const all = (await page.browser.storage.local.get("syncedTabs")).syncedTabs, k = Object.keys(all).find(k => all[k].url?.includes("smoke-safe-back"));
      const windowId = (await page.browser.windows.getCurrent()).id, tabs = await page.browser.tabs.query({windowId});
      const keys = await Promise.all(tabs.map(t => page.browser.sessions.getTabValue(t.id, "syncKey")));
      const t = tabs[keys.indexOf(k)]; return t ? {id: t.id, placeholder: t.url.includes("ghost.html")} : null;""")
    r = sidebar_page(m, """await page.browser.tabs.update(args[0], {active: true}); for (let i = 0; i < 60; i++) { const t = await page.browser.tabs.get(args[0]); if (t.url.includes("smoke-safe-back")) break; await wait(100); }
      await wait(600); const t = await page.browser.tabs.get(args[0]); return {at: t.cookieStoreId, url: t.url};""", unloaded["id"])
    where = m.js(where_script, "smoke-safe-back")
    check("a saved tab's placeholder that loads itself is not sent away by a rule", unloaded["placeholder"] and r["at"] == there and "smoke-safe-back" in r["url"] and where["at"] == [there], f"{unloaded} {r} {where}")
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(300); const id = (await page.browser.tabs.query({})).find(t => t.url.includes("smoke-safe-back")).id; send({type: "close", tabId: id}); await wait(500);
      send({type: "space", space: args[1]}); for (let i = 0; i < 40 && spaces().find(s => s.active)?.id !== args[1]; i++) await wait(100); return 1;""", folder, here)
    set_rules([])

    # A page with unsaved input stays, unasked: first in the background, then selected.
    open_in(m.pages + "/unsaved?smoke-safe-input", here)
    r = registered_where("smoke-safe-input")
    check("a page with unsaved input is here to begin with", r["at"] == [here] and r["loaded"], str(r))
    in_page("smoke-safe-input", """document.querySelector("input").value = "typed here"; return 1;""")
    r = sidebar_page(m, drop_on_space + """const dropped = await dropOnSpace(await tabWith("smoke-safe-input"), args[0]); await wait(200);
      return {dropped, line: doc.querySelector("#note")?.textContent ?? null};""", there)
    where = m.js(where_script, "smoke-safe-input")
    check("a page with unsaved input stays where it is, and stays loaded", r["dropped"] and where["at"] == [here] and where["loaded"], f"{r} {where}")
    if r["line"] is None:  # quiet.js draws the line; what is said is checked on the fake Firefox
        print("SKIP  the line about the page that stayed (no line in this build)", flush=True)
    else:
        check("the line says the page stayed", "unsaved input" in r["line"], str(r))
    select_tab("smoke-safe-input")
    r = sidebar_page(m, drop_on_space + """const id = await tabWith("smoke-safe-input"); const dropped = await dropOnSpace(id, args[0]);
      const on = await page.browser.tabs.get(id); return {dropped, selected: on.active, loaded: !on.discarded};""", there)
    where = m.js(where_script, "smoke-safe-input")
    check("selected, it stays too, and you stay on it", r == {"dropped": True, "selected": True, "loaded": True} and where["at"] == [here], f"{r} {where}")
    typed = in_page("smoke-safe-input", """return document.querySelector("input").value;""")
    check("and what was typed is still there", typed == "typed here", str(typed))
    # Closing it for real would ask: this check must leave no question open for what follows.
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("smoke-safe-input"));
      w.gBrowser.selectedTab = w.gBrowser.tabs.find(x => !x.pinned && x !== t && x.userContextId === t.userContextId && !x.hidden);
      w.gBrowser.removeTab(t, {skipPermitUnload: true}); await wait(800); return 1;""")

    # The last tab of a space, selected: it can only step aside onto a new tab there, which goes
    # again if the page refuses, and stays if it does not, so that you stay in that space.
    alone_there = sidebar_page(m, """return (await page.browser.contextualIdentities.create(page.JSON.parse(JSON.stringify({name: "smoke-last", color: "orange", icon: "circle"})))).cookieStoreId;""")
    open_in(m.pages + "/unsaved?smoke-last-input", alone_there)
    registered_where("smoke-last-input")
    sidebar_page(m, """send({type: "space", space: args[0]}); for (let i = 0; i < 40 && spaces().find(s => s.active)?.id !== args[0]; i++) await wait(100); return 1;""", alone_there)
    select_tab("smoke-last-input")
    last_state = """const windowId = (await page.browser.windows.getCurrent()).id, [on] = await page.browser.tabs.query({active: true, windowId});
      return {on: on.url, space: on.cookieStoreId, active: spaces().find(s => s.active)?.id, inSpace: (await page.browser.tabs.query({cookieStoreId: args[0], windowId})).length};"""
    # (The list is drawn for the page's own window, whose rows are now this space's.)
    sidebar_page(m, drop_on_space + """return await dropOnSpace(await tabWith("smoke-last-input"), args[1]);""", alone_there, here)
    r = sidebar_page(m, last_state, alone_there)
    check("the last tab of a space with unsaved input stays selected, and nothing is left beside it", "smoke-last-input" in r["on"] and r["space"] == alone_there and r["active"] == alone_there and r["inSpace"] == 1, str(r))
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("smoke-last-input")); w.gBrowser.addTrustedTab(args[0] + "/plain?smoke-last-plain", {userContextId: t.userContextId, inBackground: true}); await wait(600);
      w.gBrowser.selectedTab = w.gBrowser.tabs.find(x => url(x).includes("smoke-last-plain")); w.gBrowser.removeTab(t, {skipPermitUnload: true}); await wait(800); return 1;""", m.pages)
    registered_where("smoke-last-plain")
    select_tab("smoke-last-plain")
    sidebar_page(m, drop_on_space + """return await dropOnSpace(await tabWith("smoke-last-plain"), args[1]);""", alone_there, here)
    where = registered_where("smoke-last-plain")
    r = sidebar_page(m, last_state, alone_there)
    check("the last tab of a space moves, and you stay in that space, on a new tab", where["at"] == [here] and r["space"] == alone_there and r["active"] == alone_there and r["inSpace"] == 1 and "smoke-last" not in r["on"], f"{where} {r}")
    sidebar_page(m, """send({type: "space", space: args[0]}); for (let i = 0; i < 40 && spaces().find(s => s.active)?.id !== args[0]; i++) await wait(100);
      await page.browser.contextualIdentities.remove(args[1]); await wait(600); return 1;""", here, alone_there)

    # A rule pointing at a space that does not exist: the link stays, and you see which rule.
    set_rules([{"url": "smoke-safe-dead", "space": "firefox-container-99"}])
    open_in("https://example.org/?smoke-safe-dead", here)
    r = registered_where("smoke-safe-dead")
    shown = sidebar_page(m, """const p = doc.getElementById("problem"); for (let i = 0; i < 30 && p.hidden; i++) await wait(100); return p.hidden ? null : p.textContent;""")
    check("a rule whose space is gone leaves the tab where it is", r["at"] == [here], str(r))
    check("and the sidebar says which rule", "smoke-safe-dead" in (shown or ""), str(shown))
    set_rules([])
    gone = sidebar_page(m, """const p = doc.getElementById("problem"); for (let i = 0; i < 30 && !p.hidden; i++) await wait(100); return p.hidden;""")
    check("and it says so no longer once the rule is changed", gone is True, str(gone))
    # In the settings such a rule shows as it is, and saving another rule does not send it elsewhere.
    set_rules([{"url": "smoke-safe-dead", "space": "firefox-container-99"}])
    r = ext_page(m, "/settings/settings.html?safe-moves", """const select = () => doc.querySelector("#rules select"); for (let i = 0; i < 40 && !select(); i++) await wait(100);
      const shown = select().selectedOptions[0].textContent;
      doc.querySelector("#rules input").dispatchEvent(new page.Event("change")); await wait(300);
      return {shown, saved: (await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "settings:get"})))).rules};""")
    check("the settings show a rule whose space is gone as gone, and saving keeps it", "gone" in r["shown"] and r["saved"] == [{"url": "smoke-safe-dead", "space": "firefox-container-99"}], str(r))
    m.chrome()
    m.js(H + """await removeWhere((w, t) => url(t).includes("settings.html?safe-moves")); return 1;""")
    set_rules([])

    # A removed container takes its rules, folders and saved tabs along.
    made = sidebar_page(m, """const c = await page.browser.contextualIdentities.create(page.JSON.parse(JSON.stringify({name: "smoke-gone", color: "blue", icon: "circle"})));
      await wait(300); return c.cookieStoreId;""")
    keep = {"url": "smoke-kept-rule", "space": here}
    set_rules([{"url": "smoke-gone-rule", "space": made}, keep])
    open_in("https://example.org/?smoke-gone-saved", made)
    open_in("https://example.org/?smoke-gone-plain", made)
    registered_where("smoke-gone-saved")
    registered_where("smoke-gone-plain")
    folder = sidebar_page(m, """send({type: "newFolder", space: args[0], name: "smoke-gone-folder"}); await wait(600);
      const all = (await page.browser.storage.local.get("syncedTabs")).syncedTabs; return Object.entries(all).find(([, e]) => e.name === "smoke-gone-folder")?.[0];""", made)
    sidebar_page(m, """const id = (await page.browser.tabs.query({})).find(t => t.url.includes("smoke-gone-saved")).id;
      send({type: "moveTab", tabId: id, before: null, folder: args[0]}); await wait(600); return 1;""", folder)
    sidebar_page(m, """await page.browser.contextualIdentities.remove(args[0]); await wait(200); return 1;""", made)

    def after_removal():
        state = m.js(H + """const all = await storage("%s", ["syncedTabs", "rules"]);
          return {tabs: wins().flatMap(w => w.gBrowser.tabs).filter(t => ctxOf(t) === args[0]).map(t => url(t)), rules: all.rules, record: Object.values(all.syncedTabs).filter(e => e.cookieStoreId === args[0]).map(e => e.name || e.url)};""" % EXT_ID, made)
        return {**state, "done": not state["tabs"] and not state["record"] and len(state["rules"]) == 1}
    r = until(after_removal)
    check("a removed container's rules, folders and tabs go with it, and other rules stay", r["done"] and r["rules"] == [keep], str(r))
    set_rules([])

    # The space you are in is removed: you land in another one, with its tabs shown.
    made = sidebar_page(m, """return (await page.browser.contextualIdentities.create(page.JSON.parse(JSON.stringify({name: "smoke-gone-here", color: "red", icon: "circle"})))).cookieStoreId;""")
    open_in("https://example.org/?smoke-gone-here-tab", made)
    registered_where("smoke-gone-here-tab")
    r = sidebar_page(m, """send({type: "space", space: args[0]}); for (let i = 0; i < 40 && spaces().find(s => s.active)?.id !== args[0]; i++) await wait(100);
      return spaces().find(s => s.active)?.id;""", made)
    check("a new space can be gone into", r == made, str(r))
    sidebar_page(m, """await page.browser.contextualIdentities.remove(args[0]); return 1;""", made)

    def fell_back():
        state = sidebar_page(m, """const windowId = (await page.browser.windows.getCurrent()).id, active = spaces().find(s => s.active)?.id;
          const [on] = await page.browser.tabs.query({active: true, windowId}), tabs = await page.browser.tabs.query({windowId, pinned: false});
          return {active, on: on.cookieStoreId, left: (await page.browser.tabs.query({cookieStoreId: args[0]})).length,
                  hiddenHere: tabs.filter(t => t.cookieStoreId === active && t.hidden).length,
                  shownElsewhere: tabs.filter(t => t.cookieStoreId !== active && t.cookieStoreId !== "firefox-default" && !t.hidden && !t.active).length};""", made)
        return {**state, "done": state["left"] == 0 and state["active"] not in (None, made) and state["on"] == state["active"] and state["hiddenHere"] == 0 and state["shownElsewhere"] == 0}
    r = until(fell_back)
    check("the space you are in removed: you are in another space, on one of its tabs, with only its tabs shown", r["done"], str(r))
    sidebar_page(m, """send({type: "space", space: args[0]}); for (let i = 0; i < 40 && spaces().find(s => s.active)?.id !== args[0]; i++) await wait(100); return 1;""", here)

    # The same from Firefox's settings page, as that page does it: it closes the tabs, then removes
    # the container. There the selected tab is in no space, and stays selected.
    made = sidebar_page(m, """return (await page.browser.contextualIdentities.create(page.JSON.parse(JSON.stringify({name: "smoke-gone-settings", color: "green", icon: "circle"})))).cookieStoreId;""")
    open_in("https://example.org/?smoke-gone-settings-tab", made)
    registered_where("smoke-gone-settings-tab")
    r = sidebar_page(m, """send({type: "space", space: args[0]}); for (let i = 0; i < 40 && spaces().find(s => s.active)?.id !== args[0]; i++) await wait(100);
      return spaces().find(s => s.active)?.id;""", made)
    m.js(H + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.addTrustedTab("about:preferences#containers", {}); await wait(800);
      const svc = w.ContextualIdentityService ?? ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs").ContextualIdentityService;
      const id = Number(args[0].split("-").pop());
      await svc.closeContainerTabs(id); svc.remove(id); await wait(600); return 1;""", made)

    def left_settings():
        state = sidebar_page(m, """const windowId = (await page.browser.windows.getCurrent()).id, active = spaces().find(s => s.active)?.id;
          const [on] = await page.browser.tabs.query({active: true, windowId}), tabs = await page.browser.tabs.query({windowId, pinned: false});
          return {active, on: on.url, left: (await page.browser.tabs.query({cookieStoreId: args[0]})).length, record: Object.values((await page.browser.storage.local.get("syncedTabs")).syncedTabs).filter(e => e.cookieStoreId === args[0]).length,
                  hiddenHere: tabs.filter(t => t.cookieStoreId === active && t.hidden).length};""", made)
        return {**state, "done": state["left"] == 0 and state["record"] == 0 and state["active"] not in (None, made) and state["hiddenHere"] == 0}
    r = until(left_settings)
    check("a space removed from Firefox's settings page: the page stays selected, and the window is in another space, its tabs shown", r["done"] and r["on"].startswith("about:preferences"), str(r))
    m.js(H + """await removeWhere((w, t) => url(t).startsWith("about:preferences")); return 1;""")
    sidebar_page(m, """send({type: "space", space: args[0]}); for (let i = 0; i < 40 && spaces().find(s => s.active)?.id !== args[0]; i++) await wait(100); return 1;""", here)
    no_problems(m, "after moves and a removed container")

    # The background part starts again: the sidebar's connection is dead, and it comes back.
    views = """page.browser.extension.getViews({type: "sidebar"})"""
    before = sidebar_page(m, """for (const v of %s) v.document.documentElement.dataset.old = "1";
      doc.documentElement.dataset.old = "1";
      const bg = page.browser.extension.getBackgroundPage(); setTimeout(() => bg.location.reload(), 100);
      return {rows: rows().length, reals: %s.map(v => v.document.querySelectorAll("#tabs .tab").length)};""" % (views, views))
    check("before: the sidebar has its list, in its tab and in the window", before["rows"] > 0 and any(before["reals"]), str(before))
    time.sleep(0.5)

    def back():
        state = sidebar_page(m, """return {old: doc.documentElement.dataset.old ?? null, rows: rows().length,
          reals: %s.map(v => ({old: v.document.documentElement.dataset.old ?? null, rows: v.document.querySelectorAll("#tabs .tab").length}))};""" % views)
        # (A window's own sidebar can rightly be empty: its space may have no tabs.)
        return {**state, "done": state["old"] is None and state["rows"] > 0 and all(v["old"] is None for v in state["reals"]) and any(v["rows"] for v in state["reals"])}
    r = until(back)
    check("after the background part starts again, the sidebar has connected anew and shows its list", r["done"], str(r))
    # In one piece again before the next group: the tabs known again, and the queue done with that.
    until(lambda: {"done": sidebar_page(m, """return (await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "stats"})))).sizes.syncKeyByTab > 0;""") is True})


def alone_quiet_undo(m):
    # Clear by a real click, the quiet line, and Undo, compared with before in two windows;
    # closes with the ×, a saved tab removed for good, and a folder deleted (quiet.js).
    more_tabs_here(m, "quiet")
    # Two windows; alone_second_window has usually opened the other one, and it stays open.
    m.js(H + """if (!other()) { const w = main().OpenBrowserWindow(); w.__smoke = true; await wait(4000); } return 1;""")
    # What is compared: the tabs of the active space, in order, per window.
    # (Each window's tab strip can have them in another order; what counts is the list drawn.)
    LIST = H + """const ctx = Number(args[0].split("-").pop()), all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      return wins().map(w => { const keys = w.gBrowser.tabs.filter(t => !t.pinned && t.userContextId === ctx && key(w, t)).map(t => key(w, t));
        return [keys.filter(k => !all[JSON.parse(k)]?.parentKey), keys.filter(k => all[JSON.parse(k)]?.parentKey)]; });""" % EXT_ID
    setup = sidebar_page(m, """
      const space = spaces().find(s => s.active).id;
      send({type: "newFolder", space, name: "Quiet"});
      for (let i = 0; i < 50 && !folders().some(f => f.name === "Quiet"); i++) await wait(100);
      const head = () => [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Quiet");
      const [inside, also] = plainTabs().map(r => Number(r.dataset.tab));
      send({type: "moveTab", tabId: inside, folder: head().dataset.folderHead, before: null});
      send({type: "moveTab", tabId: also, folder: head().dataset.folderHead, before: null});
      // A placeholder with no page anywhere: into a folder, unloaded there, and out again.
      const third = plainTabs()[2], thirdId = Number(third.dataset.tab);
      send({type: "moveTab", tabId: thirdId, folder: head().dataset.folderHead, before: null});
      for (let i = 0; i < 60 && folders().find(f => f.name === "Quiet").tabs.length < 3; i++) await wait(100);
      await wait(800);
      doc.querySelector(`#tabs .folder .tab[data-tab="${thirdId}"] .close`).click();
      for (let i = 0; i < 60 && !doc.querySelector("#tabs .folder .tab.unloaded"); i++) await wait(100);
      await wait(1500);
      const placeholder = doc.querySelector("#tabs .folder .tab.unloaded");
      send({type: "moveTab", tabId: Number(placeholder.dataset.tab), folder: null, before: null});
      for (let i = 0; i < 60 && folders().find(f => f.name === "Quiet").tabs.length > 2; i++) await wait(100);
      // A page with unsaved input.
      await page.browser.tabs.create(page.JSON.parse(JSON.stringify({url: args[0] + "/unsaved", cookieStoreId: space, active: false})));
      for (let i = 0; i < 60 && !rows().includes("Unsaved"); i++) await wait(100);
      // A tab that has never been loaded, as a link opened in the background can be.
      await page.browser.tabs.create(page.JSON.parse(JSON.stringify({url: "https://example.org/?smoke-quiet-never", title: "Never loaded", cookieStoreId: space, discarded: true, active: false})));
      for (let i = 0; i < 60 && folders().find(f => f.name === "Quiet").tabs.length < 2; i++) await wait(100);
      for (let i = 0; i < 60 && !rows().includes("Never loaded"); i++) await wait(100);
      // A tab with a page before this one, which only Firefox's own memory can give back.
      const history = await page.browser.tabs.create(page.JSON.parse(JSON.stringify({url: "https://example.org/?smoke-quiet-one", cookieStoreId: space, active: false})));
      await wait(1500);
      await page.browser.tabs.update(history.id, page.JSON.parse(JSON.stringify({url: "https://example.org/?smoke-quiet-two"})));
      await wait(3000); // all of it is in the other window too
      // Stand on one of today's tabs, with a real click.
      const here = plainTabs()[0];
      here.click();
      await wait(1500);
      return {space, key: head().dataset.folderHead, here: Number(here.dataset.tab), rows: rows(), folders: folders()};""", m.pages)
    space = setup["space"]
    before = m.js(LIST, space)
    check("a tab that was never loaded is on today's list, for Clear to take", "Never loaded" in setup["rows"], str(setup))
    # Placeholders of today's tabs with no page anywhere, in this window.
    NO_PAGE = H + """const ctx = Number(args[0].split("-").pop()), all = (await storage("%s", ["syncedTabs"])).syncedTabs, w = main();
      return w.gBrowser.tabs.filter(t => !t.pinned && t.userContextId === ctx && url(t).includes("ghost.html") && key(w, t) && !all[JSON.parse(key(w, t))]?.parentKey
        && !wins().some(o => o.gBrowser.tabs.some(x => key(o, x) === key(w, t) && role(o, x) === "live"))).map(t => key(w, t));""" % EXT_ID
    no_page = m.js(NO_PAGE, space)
    check("a tab with no page anywhere is on today's list, as a placeholder", len(no_page) == 1, str(no_page))

    # A tab selected in either window stays, so that nothing jumps there; so does the page
    # with unsaved input, which is not on the list of what is compared with this.
    selected = m.js(H + """return wins().map(w => key(w, w.gBrowser.selectedTab));""")
    stays = len(set(before[0][0]) & set(selected))
    goes = len(before[0][0]) - stays - 1
    # Pages with no record stay too, such as the settings page a group before this left
    # open (and this sidebar page itself, which plainTabs leaves out).
    strangers = len(setup["rows"]) - len(before[0][0]) - len(before[0][1]) - 1
    r = sidebar_page(m, """
      const out = {};
      const button = doc.querySelector("#tabs .divider .clear"), box = button.parentElement.getBoundingClientRect();
      out.reach = box.height; out.divider = doc.querySelector("#tabs .divider").getBoundingClientRect().height;
      out.faded = page.getComputedStyle(button).opacity;
      // The area is the gap and no more: the rows next to it keep all of themselves.
      const line = doc.querySelector("#tabs .divider").getBoundingClientRect(), at = y => doc.elementFromPoint(line.left + 40, y);
      out.gap = [line.top - 4, line.bottom + 4].map(y => !!at(y)?.closest(".clear-reach"));
      out.neighbours = [line.top - 9, line.bottom + 9].map(y => !!at(y)?.closest(".row"));
      // A button you tabbed to keeps Enter, which the list takes everywhere else (keys.js).
      const enter = e => e.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
      out.enter = enter(button);
      const act = doc.querySelector("#note .act");
      out.undoHidden = page.getComputedStyle(act).visibility;  // so that no key can reach it
      button.click();
      for (let i = 0; i < 100 && !doc.getElementById("note").classList.contains("shown"); i++) await wait(100);
      out.shown = doc.getElementById("note").classList.contains("shown");
      out.line = doc.querySelector("#note .text").textContent;
      out.undoShown = page.getComputedStyle(act).visibility;
      out.enterUndo = enter(act);
      out.rows = plainTabs().filter(r => r.querySelector(".title").textContent !== "Unsaved").map(r => Number(r.dataset.tab));
      out.stayed = rows().includes("Unsaved");
      out.asked = !!page.browser.tabs && (await page.browser.tabs.query({active: true, currentWindow: true}))[0].title;
      out.folders = folders();
      out.tiles = tiles().length;
      return out;""", setup["here"])
    check("Clear shows only near the line, in an area that takes no room", r["reach"] >= 16 and r["divider"] <= 2 and r["faded"] == "0", str(r))
    check("the area Clear listens on covers the gap and no part of a row", r["gap"] == [True, True] and r["neighbours"] == [True, True], str(r))
    check("Undo cannot be reached by a key while there is no line, and Enter works on it and on Clear", r["undoHidden"] == "hidden" and r["undoShown"] == "visible" and r["enter"] and r["enterUndo"], str(r))
    check("Clear by a real click closes today's tabs, except any selected in a window", setup["here"] in r["rows"] and len(r["rows"]) == stays + strangers, f"{stays} stay, and {strangers} with no record: {r}")
    check("Clear leaves the folders", r["folders"] == setup["folders"], str(r))
    check("the line says how many went, and how many stayed", r["shown"] and r["line"] == f"{goes} tabs closed, 1 stayed", f"{goes} go: {r}")
    check("a page with unsaved input stays, without asking", r["stayed"] and r["asked"] != "Unsaved", str(r))
    after = m.js(LIST, space)
    check("Clear closes them in the other window too", len(after) == 2 and after[0] == after[1] and len(after[0][0]) == stays + 1 and after[0][1] == before[0][1], f"{before} -> {after}")

    r = sidebar_page(m, """
      const selected = async () => (await page.browser.tabs.query({active: true, currentWindow: true}))[0].id;
      const was = await selected();
      doc.querySelector("#note .act").click();
      const gone = !doc.getElementById("note").classList.contains("shown");
      for (let i = 0; i < 100 && rows().length < args[0].length; i++) await wait(100);
      await wait(1500);
      return {gone, rows: rows(), folders: folders(), still: was === await selected()};""", setup["rows"])
    check("Undo brings the same list back, in order", r["rows"] == setup["rows"], f"{setup['rows']} -> {r['rows']}")
    check("Undo leaves the folders as they were", r["folders"] == setup["folders"], str(r))
    check("Undo stays on the tab you are on, and the line goes at once", r["still"] and r["gone"], str(r))
    back = m.js(LIST, space)
    check("Undo brings them back under their own keys, in order, in both windows", back == before, f"{before} -> {back}")
    loaded = m.js(H + """await wait(1500); const w = main(), ctx = Number(args[0].split("-").pop());
      return wins().flatMap(w => w.gBrowser.tabs.filter(t => !t.pinned && t.userContextId === ctx && t.linkedPanel && !t.selected && key(w, t)).map(t => t.label));""", space)
    check("nothing loads because of Clear and Undo but what was loaded and not cleared", not [x for x in loaded if x == "Never loaded" or "smoke-quiet" in x], str(loaded))

    again = m.js(NO_PAGE, space)
    check("a tab with no page anywhere comes back as a placeholder, unloaded, under its own key", again == no_page, f"{no_page} -> {again}")
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => x.label === "Unsaved"); if (t) w.gBrowser.removeTab(t, {skipPermitUnload: true}); await wait(1500); return 1;""")

    # The page's history is back, once it is selected and loads.
    h = m.js(H + """const w = main(), was = w.gBrowser.selectedTab, t = w.gBrowser.tabs.find(x => url(x).includes("smoke-quiet-two"));
      if (!t) return {missing: true};
      const unloaded = !t.linkedPanel;
      w.gBrowser.selectedTab = t; await wait(2500);
      const out = {unloaded, count: t.linkedBrowser.browsingContext?.sessionHistory?.count, at: url(t), ctx: t.userContextId};
      w.gBrowser.selectedTab = was; await wait(800);
      return out;""")
    check("a page brought back is unloaded, in its container, and keeps its history", h.get("unloaded") and h.get("count", 0) >= 2 and "smoke-quiet-two" in h.get("at", "") and h.get("ctx") == int(space.split("-")[-1]), str(h))

    # Two closed with the ×: a group, and the line goes by itself.
    r = sidebar_page(m, """
      const chosen = plainTabs().filter(r => !r.classList.contains("active")).slice(0, 2);
      const ids = chosen.map(r => Number(r.dataset.tab));
      for (const r of chosen) r.querySelector(".close").click();
      const note = doc.getElementById("note");
      for (let i = 0; i < 50 && !note.classList.contains("shown"); i++) await wait(100);
      const line = doc.querySelector("#note .text").textContent, t0 = Date.now();
      for (let i = 0; i < 300 && note.classList.contains("shown"); i++) await wait(100);
      return {line, ids, ms: Date.now() - t0, shown: note.classList.contains("shown"), rows: plainTabs().map(r => Number(r.dataset.tab))};""")
    check("two tabs closed with the × are one line", r["line"] == "2 tabs closed", str(r))
    check("the line goes by itself, after about ten seconds", not r["shown"] and 8000 < r["ms"] < 13000, str(r))
    check("they stay closed", not set(r["ids"]) & set(r["rows"]), str(r))

    # A saved tab: closing it loaded says nothing, closing its placeholder removes it for good.
    s = m.js(H + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      return Object.keys(all).filter(k => all[k].parentKey === args[0]);""" % EXT_ID, setup["key"])
    inside_before = m.js(LIST, space)
    r = sidebar_page(m, """
      const row = () => [...doc.querySelectorAll("#tabs .folder")].find(f => f.querySelector(".head .title").textContent === "Quiet").querySelector(".tab");
      const note = doc.getElementById("note"), count = () => folders().find(f => f.name === "Quiet").tabs;
      row().querySelector(".close").click();
      await wait(1500);
      const unloaded = {said: note.classList.contains("shown"), tabs: count(), dim: row().classList.contains("unloaded")};
      row().querySelector(".close").click();
      for (let i = 0; i < 50 && !note.classList.contains("shown"); i++) await wait(100);
      const line = doc.querySelector("#note .text").textContent, gone = count();
      doc.querySelector("#note .act").click();
      for (let i = 0; i < 50 && folders().find(f => f.name === "Quiet").tabs.length < unloaded.tabs.length; i++) await wait(100);
      await wait(1000);
      return {unloaded, line, gone, tabs: count()};""")
    check("a loaded saved tab only unloads, with no line", r["unloaded"]["said"] is False and r["unloaded"]["dim"] and len(r["unloaded"]["tabs"]) == 2, str(r))
    check("its placeholder closed is removed for good, and the line offers it back", r["line"] == "Tab removed" and len(r["gone"]) == 1, str(r))
    check("Undo puts it back in its place in the folder", r["tabs"] == r["unloaded"]["tabs"], str(r))
    check("and in both windows", m.js(LIST, space) == inside_before, str(m.js(LIST, space)))
    stored = m.js(H + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs; await wait(800);
      return Object.keys((await storage("%s", ["syncedTabs"])).syncedTabs).filter(k => all[k]?.parentKey === args[0]);""" % (EXT_ID, EXT_ID), setup["key"])
    check("under its own key, in its folder", sorted(stored) == sorted(s), f"{s} -> {stored}")

    # A folder deleted: its tabs stay, and Undo gives it back.
    r = sidebar_page(m, """
      const note = doc.getElementById("note"), was = folders();
      send({type: "deleteFolder", key: args[0]});
      for (let i = 0; i < 50 && !note.classList.contains("shown"); i++) await wait(100);
      const line = doc.querySelector("#note .text").textContent, without = folders(), rowsThen = rows();
      doc.querySelector("#note .act").click();
      for (let i = 0; i < 50 && !folders().some(f => f.name === "Quiet"); i++) await wait(100);
      await wait(500);
      return {was, line, without, rowsThen, folders: folders()};""", setup["key"])
    check("a folder deleted keeps its tabs, and says so with an undo", r["line"] == "Folder deleted" and not [f for f in r["without"] if f["name"] == "Quiet"]
          and all(t in r["rowsThen"] for t in [t for f in r["was"] if f["name"] == "Quiet" for t in f["tabs"]]), str(r))
    check("Undo gives the folder back, with its name, place and tabs", r["folders"] == r["was"], str(r))

    # Clear by a real pointer: it fades in anywhere near the line, and out again away from it.
    # (Only in the selected tab has the sidebar's page a pointer, so it is selected for this.)
    m.js(H + """const w = main(); w.__was = w.gBrowser.selectedTab; w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(800); return 1;""")
    near = sidebar_page(m, """const r = doc.querySelector("#tabs .divider").getBoundingClientRect(), row = doc.querySelector("#tabs > .tab").getBoundingClientRect();
      return {line: [Math.round(r.left + 30), Math.round(r.top) - 4], away: [Math.round(row.left + 30), Math.round(row.top + row.height / 2)]};""")
    def pointer_to(at):
        m.cmd("Marionette:SetContext", {"value": "content"})
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [{"type": "pointerMove", "x": at[0], "y": at[1], "duration": 0, "origin": "viewport"}]}]})
        m.chrome()
    OPACITY = """const b = doc.querySelector("#tabs .clear");
      for (let i = 0; i < 40 && page.getComputedStyle(b).opacity !== args[0]; i++) await wait(50);
      return page.getComputedStyle(b).opacity;"""
    pointer_to(near["line"])
    shows_near = sidebar_page(m, OPACITY, "1")
    pointer_to(near["away"])
    goes_away = sidebar_page(m, OPACITY, "0")
    m.js(H + """const w = main(); w.gBrowser.selectedTab = w.__was; delete w.__was; await wait(800); return 1;""")
    check("Clear fades in with a real pointer near the line, and out away from it", shows_near == "1" and goes_away == "0", f"{near} {shows_near} {goes_away}")

    # Undo from another space: the tabs come back there, and this window stays where it is.
    more_tabs_here(m, "quiet-away")
    # (Going through a space would show its hidden tabs for a moment, too quick for the list.)
    m.js(H + """const w = main(); w.__shows = []; w.__onShow = () => w.__shows.push(Date.now()); w.gBrowser.tabContainer.addEventListener("TabShow", w.__onShow); return 1;""")
    r = sidebar_page(m, """
      const note = doc.getElementById("note"), n = plainTabs().length;
      const chosen = plainTabs().filter(r => !r.classList.contains("active")).slice(-2);
      for (const r of chosen) r.querySelector(".close").click();
      for (let i = 0; i < 50 && !note.classList.contains("shown"); i++) await wait(100);
      const home = spaces().find(s => s.active).id, away = spaces().find(s => !s.active).id;
      doc.querySelector(`#spaces .space[data-space="${away}"]`).click();
      for (let i = 0; i < 50 && spaces().find(s => s.active).id !== away; i++) await wait(100);
      await wait(300);
      const selected = async () => (await page.browser.tabs.query({active: true, currentWindow: true}))[0].id;
      const was = await selected(), seen = [];
      const watch = new page.MutationObserver(() => seen.push(doc.documentElement.dataset.space));
      watch.observe(doc.documentElement, {attributes: true, attributeFilter: ["data-space"]});
      const shown = note.classList.contains("shown"), t0 = Date.now();
      doc.querySelector("#note .act").click();
      await wait(2500);
      watch.disconnect();
      const t1 = Date.now(), still = was === await selected(), stayed = spaces().find(s => s.active).id === away;
      doc.querySelector(`#spaces .space[data-space="${home}"]`).click();
      for (let i = 0; i < 50 && plainTabs().length < n; i++) await wait(100);
      return {shown, away, seen, still, stayed, n, t0, t1, back: plainTabs().length};""")
    shows = m.js(H + """const w = main(); w.gBrowser.tabContainer.removeEventListener("TabShow", w.__onShow); return w.__shows;""")
    check("Undo from another space brings the tabs back there", r["shown"] and r["back"] == r["n"], str(r))
    check("and this window stays where it is, with no other space shown for a moment", r["stayed"] and r["still"] and all(x == r["away"] for x in r["seen"]) and not [t for t in shows if r["t0"] <= t <= r["t1"]], f"{r} {shows}")

    # With no line between folders and tabs, Clear is in the list's menu. Then quiet
    # again, for alone_idle: the line gone, and its timer with it.
    r = sidebar_page(m, """
      const note = doc.getElementById("note");
      send({type: "deleteFolder", key: args[0]});
      for (let i = 0; i < 50 && folders().some(f => f.name === "Quiet"); i++) await wait(100);
      const others = folders();
      const menu = doc.getElementById("tabs");
      menu.dispatchEvent(new page.MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: 40, clientY: 200}));
      const items = [...doc.querySelectorAll("#menu .item")];
      const labels = items.map(b => b.textContent), n = plainTabs().length;
      items.find(b => b.textContent === "Clear today's tabs")?.click();
      await wait(1500);
      const line = doc.querySelector("#note .text").textContent, left = plainTabs().length;
      doc.querySelector("#note .act").click();
      for (let i = 0; i < 50 && plainTabs().length < n; i++) await wait(100);
      const back = plainTabs().length;
      for (let i = 0; i < 20 && !doc.getElementById("note").classList.contains("shown"); i++) await wait(50);
      return {others, labels, line, left, n, back, shown: note.classList.contains("shown")};""", setup["key"])
    check("the list's menu has Clear too, and it can be undone", "Clear today's tabs" in r["labels"] and r["line"].endswith("closed") and 1 <= r["left"] <= 2 and r["back"] == r["n"], str(r))
    check("Undo leaves no line behind", r["shown"] is False, str(r))
    sizes = extension_message(m, {"type": "stats"})["sizes"]
    check("and nothing is kept for it", sizes["quietNotes"] == 0 and sizes["closeGroups"] == 0, str(sizes))
    # The placeholders with no page have done their work: an update would give each a live
    # tab (reconcileAll), which alone_update would see as a change.
    m.js(H + """await removeWhere((w, t) => args[0].includes(key(w, t))); return 1;""", m.js(NO_PAGE, space))
    no_problems(m, "after Clear and Undo")


def quiet_off(m):
    # The setting off, as in the daily browser on Sidebery: a close only closes, with no
    # line and nothing remembered, and neither Clear nor a key can find what is not shown.
    more_tabs_here(m, "off")
    r = sidebar_page(m, """
      const note = doc.getElementById("note"), act = doc.querySelector("#note .act");
      const out = {alone: doc.documentElement.classList.contains("alone"), height: note.getBoundingClientRect().height, undo: page.getComputedStyle(act).visibility, clear: !!doc.querySelector(".clear, .clear-reach")};
      const n = plainTabs().length;
      for (const r of plainTabs().slice(-2)) r.querySelector(".close").click();
      for (let i = 0; i < 50 && plainTabs().length > n - 2; i++) await wait(100);
      await wait(1000);
      return {...out, n, left: plainTabs().length, shown: note.classList.contains("shown")};""")
    check("with the setting off, the sidebar has no line and no Clear", r["alone"] is False and r["height"] == 0 and r["undo"] == "hidden" and not r["clear"], str(r))
    check("with the setting off, closes in the sidebar only close, and nothing is said", r["left"] == r["n"] - 2 and r["shown"] is False, str(r))
    sizes = extension_message(m, {"type": "stats"})["sizes"]
    check("with the setting off, nothing is remembered", sizes["quietNotes"] == 0 and sizes["closeGroups"] == 0, str(sizes))
    m.js(H + """await removeWhere((w, t) => url(t).includes("/sidebar/sidebar.html") || url(t).includes("smoke-off-")); return 1;""")


def real_click(m, path, x, y, button=0):
    """A real click, through Marionette's actions, in one of Tidier's own pages in front."""
    into_page(m, path)
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(x), "y": int(y), "duration": 0},
        {"type": "pointerDown", "button": button}, {"type": "pointerUp", "button": button}]}]})
    m.cmd("WebDriver:ReleaseActions")
    m.chrome()


def pointer_over(m, *points):
    """Move a real pointer over the sidebar page, which must be the selected tab and where sidebar_page last ran: to each point in turn, with no way in between."""
    m.cmd("Marionette:SetContext", {"value": "content"})
    for x, y in points:
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"},
                                                        "actions": [{"type": "pointerMove", "x": round(x), "y": round(y), "duration": 0, "origin": "viewport"}]}]})
        time.sleep(0.2)
    m.cmd("WebDriver:ReleaseActions")
    m.chrome()


# In the sidebar's page: right clicks and the menu, waiting for what they lead to.
MENU_PAGE = """
  const until = async (test, ms = 10000) => { const t0 = Date.now(); let r; while (!(r = test()) && Date.now() - t0 < ms) await wait(50); return r; };
  const menu = doc.getElementById("menu");
  const shown = () => [...menu.children].map(c => c.classList.contains("line") ? "|" : c.textContent);
  // Rename has its own checks, below and in alone_tab_names.
  const plain = list => list.filter(x => x !== "Rename").filter((x, i, a) => x !== "|" || a[i - 1] !== "|");
  const rowOf = id => doc.querySelector(`[data-tab="${id}"]`);
  const inFolder = id => rowOf(id)?.closest(".folder")?.querySelector(".head .title")?.textContent ?? null;
  const rightClick = async el => {
    menu.hidden = true;
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new page.MouseEvent("contextmenu", {bubbles: true, cancelable: true, button: 2, clientX: box.left + 8, clientY: box.top + 8}));
    await until(() => !menu.hidden);
    return plain(shown());
  };
  const choose = label => { const b = [...menu.querySelectorAll(".item")].find(x => x.textContent === label); if (!b) throw new Error(label + " is not in " + shown()); b.click(); };
"""

# In the browser: tabs by the id the extension knows them by, and waiting for them.
MENU_TABS = H + """
  const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const idOf = t => ExtensionParent.apiManager.global.tabTracker.getId(t);
  const tabs = () => wins().flatMap(w => w.gBrowser.tabs.map(t => ({w, t})));
  const byId = id => tabs().find(x => idOf(x.t) === id)?.t;
  const until = async (test, ms = 10000) => { const t0 = Date.now(); let r; while (!(r = test()) && Date.now() - t0 < ms) await wait(50); return r; };
  const record = async () => { await wait(400); return (await storage(%r, ["syncedTabs"])).syncedTabs; };
  const entriesOf = (all, text) => Object.entries(all).filter(([, e]) => e.url?.includes(text));
""" % EXT_ID

ROW_MENU = ["Reload", "Mute", "Unload", "|", "Duplicate", "Copy address", "|", "Make essential", "Move to folder", "Move to space", "Always open this site here", "|", "Close"]


def alone_tab_menu(m):
    # Tidier's own menu on a row and a tile: what it offers, and what each item does.
    space = sidebar_page(m, "return spaces().find(s => s.active).id;")
    ctx = int(space.split("-")[-1])

    def open_tab(name, where="main()", address=None):
        """A tab in the active space, registered, and its id."""
        return m.js(MENU_TABS + """const w = %s; const t = w.gBrowser.addTrustedTab(args[0], {userContextId: args[1], inBackground: true});
          await until(() => role(w, t) === "live"); return idOf(t);""" % where, address or f"https://example.org/?smoke-menu-{name}", ctx)

    def act(tab, *labels):
        """Right click its row, choose (going through a list if several), and leave the rest to the checks."""
        return sidebar_page(m, MENU_PAGE + """await until(() => rowOf(args[0]));
          await rightClick(rowOf(args[0]));
          for (const label of args.slice(1)) choose(label);
          await wait(50); return 1;""", tab, *labels)

    def clear_rules():
        extension_message(m, {"type": "settings:rules", "rules": []})

    def page_loads(tab):
        return m.js(MENU_TABS + "return byId(args[0]).linkedBrowser.innerWindowID;", tab)

    a, b, c = open_tab("a"), open_tab("b"), open_tab("c")
    try:
        # What it offers.
        r = sidebar_page(m, MENU_PAGE + """
          const row = await until(() => rowOf(args[0]));
          const labels = await rightClick(row), about = row.classList.contains("menu-for");
          page.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
          const closed = menu.hidden, left = row.classList.contains("menu-for");
          const tile = doc.querySelector("#essentials .tile"), tileLabels = await rightClick(tile);
          menu.hidden = true;
          // The keys: ↑ from the top is the last item, → opens a list with its first item ready, ← goes back.
          await rightClick(row);
          const key = k => doc.activeElement.dispatchEvent(new page.KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
          const at = () => doc.activeElement.textContent;
          const inMenu = doc.activeElement === menu;
          key("ArrowDown"); const first = at();
          key("ArrowUp"); const last = at();
          const more = [...menu.querySelectorAll(".item")].find(x => x.textContent === "Move to space"); more.focus();
          key("ArrowRight"); const sub = {top: menu.firstChild.textContent, focus: doc.activeElement.classList.contains("back"), at: at()};
          key("ArrowLeft"); const back = menu.querySelectorAll(".back").length;
          // A click outside only closes it: the row under the pointer stays as it is.
          const selectedBefore = doc.querySelector("#tabs .tab.active")?.dataset.tab;
          rowOf(args[1]).click();
          await wait(500);
          const outside = {closed: menu.hidden, selected: doc.querySelector("#tabs .tab.active")?.dataset.tab === selectedBefore};
          return {labels, about, closed, left, tileLabels, keys: {inMenu, first, last, sub, back}, outside};""", a, b)
        check("a right click on a row shows Tidier's menu, in its order", r["labels"] == ROW_MENU, str(r))
        check("the menu marks the row it is about, and Esc closes it", r["about"] and r["closed"] and not r["left"], str(r))
        k = r["keys"]
        check("the arrow keys go through the menu, and into a list and back", k["inMenu"] and k["first"] == "Reload" and k["last"] == "Close" and k["sub"]["top"] == "Move to space"
              and not k["sub"]["focus"] and k["sub"]["at"] and k["back"] == 0, str(k))
        check("a click outside the menu only closes it", r["outside"] == {"closed": True, "selected": True}, str(r["outside"]))
        tile_rest = ["Duplicate", "Copy address", "|", "Remove from essentials"]
        check("a right click on a tile offers no folder, space or rule", r["tileLabels"] in (tile_rest, ["Reload", "Mute", "Unload", "|", *tile_rest, "|", "Close"]), str(r))
        r = sidebar_page(m, MENU_PAGE + """const row = rowOf(args[0]), opts = o => page.JSON.parse(JSON.stringify(o));
          // A redraw of its row (here: the sound mark) resets the row's classes.
          await rightClick(row);
          await page.browser.tabs.update(args[0], opts({muted: true}));
          await until(() => row.querySelector(".sound"));
          const redrawn = {open: !menu.hidden, mark: row.classList.contains("menu-for")};
          await page.browser.tabs.update(args[0], opts({muted: false}));
          await until(() => !row.querySelector(".sound"));
          const data = new page.DataTransfer(), at = {bubbles: true, cancelable: true, dataTransfer: data};
          row.dispatchEvent(new page.DragEvent("dragstart", at));
          const dragged = menu.hidden;
          row.dispatchEvent(new page.DragEvent("dragend", at));
          await rightClick(row);
          doc.activeElement.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Tab", bubbles: true, cancelable: true}));
          const tabbed = menu.hidden;
          await rightClick(row);
          menu.dispatchEvent(new page.WheelEvent("wheel", {bubbles: true, deltaY: 10}));
          const scrolledIn = !menu.hidden;
          doc.getElementById("tabs").dispatchEvent(new page.WheelEvent("wheel", {bubbles: true, deltaY: 10}));
          const scrolled = menu.hidden;
          // A middle click outside only closes it too: the tab under the pointer stays.
          await rightClick(row);
          row.dispatchEvent(new page.MouseEvent("auxclick", {bubbles: true, cancelable: true, button: 1}));
          const middle = menu.hidden;
          await wait(500);
          return {redrawn, dragged, tabbed, scrolledIn, scrolled, middle, here: !!rowOf(args[0]), left: !!doc.querySelector(".menu-for")};""", a)
        check("the mark stays while its row is drawn anew", r["redrawn"] == {"open": True, "mark": True}, str(r))
        check("a drag, the Tab key or scrolling the list closes the menu, and scrolling in it does not", r["dragged"] and r["tabbed"] and r["scrolledIn"] and r["scrolled"] and not r["left"], str(r))
        check("a middle click outside the menu only closes it", r["middle"] and r["here"], str(r))
        g = open_tab("gone")
        r = sidebar_page(m, MENU_PAGE + """await until(() => rowOf(args[0])); await rightClick(rowOf(args[0])); const open = !menu.hidden;
          await page.browser.tabs.remove(args[0]); await until(() => menu.hidden, 3000); return {open, closed: menu.hidden};""", g)
        check("a menu about a tab that has gone closes", r == {"open": True, "closed": True}, str(r))

        # Reload and mute.
        before = page_loads(a)
        act(a, "Reload")
        after = m.js(MENU_TABS + "await until(() => byId(args[0]).linkedBrowser.innerWindowID !== args[1]); return byId(args[0]).linkedBrowser.innerWindowID;", a, before)
        check("Reload loads the page again", after != before, f"{before}, {after}")
        act(a, "Mute")
        muted = m.js(MENU_TABS + "await until(() => byId(args[0]).linkedBrowser.audioMuted); return byId(args[0]).linkedBrowser.audioMuted;", a)
        r = sidebar_page(m, MENU_PAGE + "const l = await rightClick(rowOf(args[0])); choose('Unmute'); return l;", a)
        unmuted = m.js(MENU_TABS + "await until(() => !byId(args[0]).linkedBrowser.audioMuted); return byId(args[0]).linkedBrowser.audioMuted;", a)
        check("Mute mutes, and then the menu offers Unmute", muted and not unmuted and "Unmute" in r and "Mute" not in r, f"{muted}, {unmuted}, {r}")

        # Unload, a tab not selected: it stays, in its place, and the page goes.
        selected = m.js(MENU_TABS + "return idOf(main().gBrowser.selectedTab);")
        act(a, "Unload")
        r = m.js(MENU_TABS + """const t = byId(args[0]); await until(() => !t.linkedPanel); const all = await record();
          return {unloaded: !t.linkedPanel, url: url(t), stored: entriesOf(all, "smoke-menu-a").length, selected: idOf(main().gBrowser.selectedTab)};""", a)
        check("Unload unloads a tab, which stays, and the selection stays too", r["unloaded"] and "smoke-menu-a" in r["url"] and r["stored"] == 1 and r["selected"] == selected, str(r))
        r = sidebar_page(m, MENU_PAGE + "await until(() => rowOf(args[0]).classList.contains('unloaded')); const l = await rightClick(rowOf(args[0])); menu.hidden = true; return {l, faded: rowOf(args[0]).classList.contains('unloaded')};", a)
        check("an unloaded tab's menu has nothing to reload, mute or unload", r["l"] == ROW_MENU[4:] and r["faded"], str(r))

        # Duplicate of what is not loaded: the address, in the same container, an ordinary tab.
        act(a, "Duplicate")
        r = m.js(MENU_TABS + """const has = () => tabs().filter(x => x.t.linkedPanel && idOf(x.t) !== args[0] && url(x.t).includes("smoke-menu-a"));
          await until(() => has().length && role(has()[0].w, has()[0].t) === "live");
          const copy = has()[0]?.t, all = await record();
          return {found: !!copy, id: copy && idOf(copy), container: copy?.userContextId, pinned: copy?.pinned, stored: entriesOf(all, "smoke-menu-a").length, selected: idOf(main().gBrowser.selectedTab)};""", a)
        check("Duplicate of an unloaded tab opens its address in the same container, and you stay", r["found"] and r["container"] == ctx and not r["pinned"] and r["stored"] == 2 and r["selected"] == selected, str(r))
        d = r["id"]

        # Duplicate of a loaded saved tab, with a rule that would send it away: an ordinary
        # tab of its own, here, and the saved tab keeps its record.
        sidebar_page(m, """send({type: "newFolder", space: spaces().find(s => s.active).id, name: "Menu kept"});
          await wait(600);
          const head = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Menu kept");
          send({type: "moveTab", tabId: args[0], folder: head.dataset.folderHead, before: null});
          await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "settings:rules", rules: [{url: "smoke-menu-b", space: spaces().find(s => !s.active && s.id !== "firefox-container-4").id}]})));
          await wait(800);
          return 1;""", b)
        r = sidebar_page(m, MENU_PAGE + """const head = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Menu kept");
          await rightClick(head); const folder = shown(), list = await rightClick(doc.getElementById("tabs")); menu.hidden = true; return {folder, list};""")
        check("a folder and the empty list keep their own short menus", r["folder"] == ["Rename", "Delete folder (its tabs stay)"] and r["list"][0] == "New folder" and "Reload" not in r["list"], str(r))
        # Rename on a tile and on a saved tab's row opens the box, ready for typing. (What you
        # then do in it is for alone_tab_names.) Esc leaves everything as it was.
        r = sidebar_page(m, MENU_PAGE + """const named = async el => {
            await rightClick(el);
            choose("Rename");
            const box = await until(() => doc.querySelector("input.rename"));
            const out = {open: !!box, focus: !!box && doc.activeElement === box};
            box?.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
            await until(() => !doc.querySelector("input.rename"));
            return {...out, left: !!doc.querySelector("input.rename")};
          };
          return {tile: await named(doc.querySelector("#essentials .tile")), row: await named(rowOf(args[0]))};""", b)
        check("Rename on a tile opens the box, with the focus in it", r["tile"] == {"open": True, "focus": True, "left": False}, str(r))
        check("Rename on a saved tab's row opens the box, with the focus in it", r["row"] == {"open": True, "focus": True, "left": False}, str(r))
        act(b, "Duplicate")
        r = m.js(MENU_TABS + """const has = () => tabs().filter(x => idOf(x.t) !== args[0] && url(x.t).includes("smoke-menu-b") && x.t.linkedPanel);
          await until(() => has().length && role(has()[0].w, has()[0].t) === "live");
          const copy = has()[0]?.t, w = has()[0]?.w; await wait(1000); const all = await record();
          const list = entriesOf(all, "smoke-menu-b"), mine = list.find(([k]) => JSON.stringify(k) === key(main(), byId(args[0])));
          const theirs = list.find(([k]) => w && JSON.stringify(k) === key(w, copy));
          return {copy: !!copy, container: copy?.userContextId, keys: list.length, saved: !!mine?.[1].saved, parent: !!mine?.[1].parentKey, copySaved: !!theirs?.[1].saved, copyParent: theirs?.[1].parentKey ?? null, id: copy && idOf(copy), left: tabs().filter(x => url(x.t).includes("smoke-menu-b") && x.t.userContextId !== args[1]).length};""", b, ctx)
        check("a copy of a saved tab is an ordinary tab of its own, and the saved tab keeps its record", r["copy"] and r["keys"] == 2 and r["saved"] and r["parent"] and not r["copySaved"] and r["copyParent"] is None, str(r))
        check("a rule does not send a copy to another space", r["container"] == ctx and r["left"] == 0, str(r))
        clear_rules()

        # Unload on the selected tab: to another tab of the space first.
        sidebar_page(m, MENU_PAGE + "rowOf(args[0]).click(); return 1;", c)
        was = m.js(MENU_TABS + "await until(() => idOf(main().gBrowser.selectedTab) === args[0]); return idOf(main().gBrowser.selectedTab);", c)
        act(c, "Unload")
        r = m.js(MENU_TABS + """const t = byId(args[0]); await until(() => !t.linkedPanel); const s = main().gBrowser.selectedTab;
          return {unloaded: !t.linkedPanel, selected: idOf(s), container: s.userContextId};""", c)
        check("Unload on the selected tab goes to another tab of the space, and unloads it", was == c and r["unloaded"] and r["selected"] != c and r["container"] == ctx, str(r))

        # A page with unsaved input stays, selected, without asking.
        u = open_tab("unsaved", address=m.pages + "/unsaved?smoke-menu-unsaved")
        sidebar_page(m, MENU_PAGE + "await until(() => rowOf(args[0])); rowOf(args[0]).click(); return 1;", u)
        m.js(MENU_TABS + "await until(() => idOf(main().gBrowser.selectedTab) === args[0]); await wait(800); return 1;", u)
        act(u, "Unload")
        time.sleep(1.5)
        r = m.js(MENU_TABS + """const t = byId(args[0]); return {loaded: !!t.linkedPanel, selected: main().gBrowser.selectedTab === t};""", u)
        check("Unload leaves a page with unsaved input loaded and selected, without asking", r == {"loaded": True, "selected": True}, str(r))
        m.js(MENU_TABS + """const t = byId(args[0]); const k = key(main(), t);
          for (const w of wins()) for (const x of [...w.gBrowser.tabs]) if (key(w, x) === k) w.gBrowser.removeTab(x, {skipPermitUnload: true});
          await wait(1500); return 1;""", u)

        # Copy address: the page's, never the placeholder's; on the real clipboard of the test Firefox.
        clipboard = MENU_TABS + """const read = () => { const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable); t.init(null); t.addDataFlavor("text/plain");
          Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, main().browsingContext.currentWindowContext);
          const o = {}; try { t.getTransferData("text/plain", o); return o.value.QueryInterface(Ci.nsISupportsString).data; } catch (e) { return ""; } };"""
        m.js(clipboard + 'Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("before"); return 1;')
        act(a, "Copy address")
        copied = m.js(clipboard + 'await until(() => read() !== "before", 3000); return read();')
        check("Copy address copies the page's address from an unloaded tab", copied == "https://example.org/?smoke-menu-a", repr(copied))

        # A row that is only a placeholder here, with the page loaded in another window.
        opened = m.js(H + """if (other()) return false; const w = main().OpenBrowserWindow(); w.__smoke = true;
          for (let i = 0; i < 100 && !w.gBrowser?.tabs.some(t => key(w, t)); i++) await wait(100); await wait(1500); return true;""")
        far = open_tab("far", where="other()")
        ghost = m.js(MENU_TABS + """const k = key(other(), byId(args[0]));
          await until(() => main().gBrowser.tabs.some(t => key(main(), t) === k)); return idOf(main().gBrowser.tabs.find(t => key(main(), t) === k));""", far)
        before = page_loads(far)
        r = sidebar_page(m, MENU_PAGE + """await until(() => rowOf(args[0])); const l = await rightClick(rowOf(args[0])); choose("Reload"); return l;""", ghost)
        after = m.js(MENU_TABS + "await until(() => byId(args[0]).linkedBrowser.innerWindowID !== args[1]); return byId(args[0]).linkedBrowser.innerWindowID;", far, before)
        check("a placeholder's Reload loads the page in the other window again", ghost != far and r == ROW_MENU and after != before, f"{ghost}, {far}, {r}, {before}, {after}")
        m.js(clipboard + 'Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("before"); return 1;')
        act(ghost, "Copy address")
        copied = m.js(clipboard + 'await until(() => read() !== "before", 3000); return read();')
        check("a placeholder's Copy address is the page's", copied == "https://example.org/?smoke-menu-far", repr(copied))
        act(ghost, "Close")
        r = m.js(MENU_TABS + """await until(() => !byId(args[0]) && !byId(args[1])); return [!!byId(args[0]), !!byId(args[1])];""", far, ghost)
        check("a placeholder's Close closes the page in every window", r == [False, False], str(r))

        def placeholder_of(tab):
            return m.js(MENU_TABS + """const k = key(other(), byId(args[0]));
              await until(() => main().gBrowser.tabs.some(t => key(main(), t) === k)); return idOf(main().gBrowser.tabs.find(t => key(main(), t) === k));""", tab)
        far, far2, far3 = open_tab("far", where="other()"), open_tab("far2", where="other()"), open_tab("far3", where="other()")
        ghost, ghost3 = placeholder_of(far), placeholder_of(far3)

        # Duplicate: Firefox would put the copy over there, and its row at the end of this list.
        act(ghost, "Duplicate")
        r = m.js(MENU_TABS + """const w = main(), page = "https://example.org/?smoke-menu-far", has = () => w.gBrowser.tabs.find(t => url(t) === page);
          await until(() => has() && role(w, has()) === "live");
          const copy = has(), list = [...w.gBrowser.tabs], there = other().gBrowser.tabs.filter(t => url(t) === page && idOf(t) !== args[0]).length;
          return {found: !!copy, next: list.indexOf(copy) === list.indexOf(byId(args[1])) + 1, container: copy?.userContextId, there, id: copy && idOf(copy), selected: copy?.selected};""", far, ghost)
        check("Duplicate of a placeholder opens the page here, next to its row, and you stay", r["found"] and r["next"] and r["container"] == ctx and r["there"] == 0 and not r["selected"], str(r))
        act(r["id"], "Close")

        # Unload: the page in the other window goes, and the placeholder here stays.
        act(ghost, "Unload")
        r = m.js(MENU_TABS + """await until(() => !byId(args[0]).linkedPanel); return {page: !!byId(args[0]).linkedPanel, url: url(byId(args[0])), here: !!byId(args[1])};""", far, ghost)
        check("a placeholder's Unload unloads the page in the other window", r == {"page": False, "url": "https://example.org/?smoke-menu-far", "here": True}, str(r))
        r = sidebar_page(m, MENU_PAGE + "const l = await rightClick(rowOf(args[0])); menu.hidden = true; return l;", ghost)
        check("after which its menu has nothing to reload, mute or unload", r == ROW_MENU[4:], str(r))

        # Make essential: the page itself is pinned where it is, and stays loaded.
        ghost2 = placeholder_of(far2)
        act(ghost2, "Make essential")
        r = m.js(MENU_TABS + """const t = byId(args[0]); await until(() => t.pinned && ek(other(), t) && !byId(args[1]));
          const k = ek(other(), t); await until(() => main().gBrowser.tabs.some(x => ek(main(), x) === k));
          const here = main().gBrowser.tabs.find(x => ek(main(), x) === k);
          return {pinned: t.pinned, loaded: !!t.linkedPanel, placeholder: !!byId(args[1]), tile: here && idOf(here), record: entriesOf(await record(), "smoke-menu-far2").length};""", far2, ghost2)
        check("a placeholder's Make essential pins the page where it is, loaded, with a tile here", r["pinned"] and r["loaded"] and not r["placeholder"] and r["tile"] and r["record"] == 0, str(r))
        act(r["tile"], "Remove from essentials")
        r = m.js(MENU_TABS + """const t = byId(args[0]); await until(() => !t.pinned && role(other(), t) === "live" && !byId(args[1]));
          return {pinned: t.pinned, loaded: !!t.linkedPanel, tile: !!byId(args[1]), record: entriesOf(await record(), "smoke-menu-far2").length};""", far2, r["tile"])
        check("Remove from essentials on its tile leaves the page there as an ordinary tab", r == {"pinned": False, "loaded": True, "tile": False, "record": 1}, str(r))

        # Move to space: the page, wherever it is, and you stay.
        selected = m.js(MENU_TABS + "return idOf(main().gBrowser.selectedTab);")
        act(ghost3, "Move to space", "Space 2")
        r = m.js(MENU_TABS + """await until(() => !byId(args[0]) && !byId(args[1]) && tabs().some(x => url(x.t).includes("smoke-menu-far3")));
          return {gone: [!!byId(args[0]), !!byId(args[1])], there: tabs().filter(x => url(x.t).includes("smoke-menu-far3")).map(x => x.t.userContextId !== args[2]), selected: idOf(main().gBrowser.selectedTab)};""", far3, ghost3, ctx)
        check("a placeholder's Move to space moves the page, and you stay", r["gone"] == [False, False] and r["there"] and all(r["there"]) and r["selected"] == selected, str(r))

        # Close, on a saved tab: closing the placeholder here would remove it for good.
        far4 = open_tab("far4", where="other()")
        ghost4 = placeholder_of(far4)
        sidebar_page(m, MENU_PAGE + """const head = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Menu kept");
          send({type: "moveTab", tabId: args[0], folder: head.dataset.folderHead, before: null}); await wait(500); return 1;""", ghost4)
        act(ghost4, "Close")
        r = m.js(MENU_TABS + """await until(() => !byId(args[0])); const list = entriesOf(await record(), "smoke-menu-far4");
          return {page: !!byId(args[0]), here: !!byId(args[1]), kept: list.length, saved: !!list[0]?.[1].saved};""", far4, ghost4)
        check("a placeholder's Close on a saved tab only unloads it", r == {"page": False, "here": True, "kept": 1, "saved": True}, str(r))
        if opened:
            m.js(H + """await close(other()); return 1;""")

        # A tile's own: a copy is an ordinary tab, and its Unload and Close leave the essential.
        tile = sidebar_page(m, "return Number(doc.querySelector('#essentials .tile').dataset.tab);")
        n = sidebar_page(m, "return tiles().length;")
        act(tile, "Duplicate")
        r = m.js(MENU_TABS + """const w = main(), has = () => w.gBrowser.tabs.find(t => !t.pinned && url(t).includes("fixture-essential"));
          await until(() => has() && role(w, has()) === "live");
          const copy = has(), s = await storage(%r, ["essentials"]);
          return {found: !!copy, pinned: copy?.pinned, essential: copy && ek(w, copy), id: copy && idOf(copy), container: copy?.userContextId, list: s.essentials.length};""" % EXT_ID)
        count = sidebar_page(m, "await wait(300); return tiles().length;")
        check("Duplicate of a tile is an ordinary tab of its own, and the essential stays one", r["found"] and not r["pinned"] and not r["essential"] and r["container"] == ctx and count == n, str(r))
        act(r["id"], "Close")
        sidebar_page(m, MENU_PAGE + "rowOf(args[0]).click(); return 1;", tile)
        m.js(MENU_TABS + "await until(() => idOf(main().gBrowser.selectedTab) === args[0]); await wait(800); return 1;", tile)
        act(tile, "Unload")
        r = m.js(MENU_TABS + """const t = byId(args[0]); await until(() => !t.linkedPanel); const s = main().gBrowser.selectedTab;
          return {unloaded: !t.linkedPanel, pinned: t.pinned, selected: idOf(s) !== args[0], container: s.userContextId};""", tile)
        check("Unload on the selected tile goes to another tab of the space, and unloads it", r == {"unloaded": True, "pinned": True, "selected": True, "container": ctx}, str(r))
        sidebar_page(m, MENU_PAGE + "rowOf(args[0]).click(); return 1;", tile)
        m.js(MENU_TABS + "await until(() => idOf(main().gBrowser.selectedTab) === args[0]); await wait(800); return 1;", tile)
        act(tile, "Close")
        r = sidebar_page(m, """for (let i = 0; i < 100 && !(tiles().length === args[1] && !doc.querySelector(`[data-tab="${args[0]}"]`)); i++) await wait(100); await wait(500);
          return {tiles: tiles().length, active: !!doc.querySelector("#essentials .tile.active")};""", tile, n)
        check("Close on the selected tile brings it back unloaded, and selects something else", r == {"tiles": n, "active": False}, str(r))

        # Make essential, and back.
        r = sidebar_page(m, MENU_PAGE + """const n = tiles().length; await rightClick(rowOf(args[0])); choose("Make essential");
          await until(() => tiles().length === n + 1 && rowOf(args[0])?.classList.contains("tile"));
          const pinned = tiles().length, tile = rowOf(args[0]); const labels = await rightClick(tile); choose("Remove from essentials");
          await until(() => tiles().length === n && rowOf(args[0])?.classList.contains("tab"));
          return {n, pinned, labels, after: tiles().length, row: rowOf(args[0])?.classList.contains("tab")};""", d)
        check("Make essential makes a tile, and its menu takes it back to an ordinary tab", r["pinned"] == r["n"] + 1 and r["after"] == r["n"] and r["row"] and "Remove from essentials" in r["labels"] and "Move to folder" not in r["labels"], str(r))
        m.js(MENU_TABS + """await until(() => { const t = byId(args[0]); return t && role(main(), t) === "live"; }); return 1;""", d)

        # Move to folder, and a new folder that takes the tab and starts renaming.
        r = sidebar_page(m, MENU_PAGE + """const n = folders().length; await rightClick(rowOf(args[0])); choose("Move to folder");
          const list = shown(), back = menu.firstChild.classList.contains("back");
          choose("New folder");
          const input = await until(() => doc.querySelector("#tabs .folder .rename"));
          await until(() => input?.closest(".folder").contains(rowOf(args[0])));
          const got = {n, list, back, value: input?.value, typing: doc.activeElement === input, selected: input && input.selectionStart === 0 && input.selectionEnd === input.value.length};
          input?.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
          await until(() => folders().length === n + 1 && folders().every(f => f.name));
          got.name = inFolder(args[0]); got.gone = !doc.querySelector("#tabs .folder .rename");
          return got;""", d)
        check("Move to folder lists the folders, then New folder, with a way back", r["back"] and r["list"][:2] == ["Move to folder", "|"] and "Menu kept" in r["list"] and r["list"][-1] == "New folder", str(r))
        check("a new folder takes the tab, with a good name selected, and Enter accepts it", r["value"] == "Example" and r["typing"] and r["selected"] and r["name"] == "Example" and r["gone"], str(r))
        r = sidebar_page(m, MENU_PAGE + """await rightClick(rowOf(args[0])); choose("Move to folder"); const list = shown(); choose("No folder");
          await until(() => inFolder(args[0]) === null);
          return {list, out: inFolder(args[0]), plain: !!rowOf(args[0]).closest("#tabs > .tab")};""", d)
        check("Move to folder lists No folder and not its own, and No folder takes it out", r["out"] is None and r["plain"] and "No folder" in r["list"] and "Example" not in r["list"], str(r))
        s = m.js(MENU_TABS + "const all = await record(); return Object.values(all).filter(x => x.url?.includes('smoke-menu-a')).map(x => !!x.saved);")
        check("a tab taken out of a folder is not saved any more", not any(s), str(s))

        # Move to space: there, gone here, and you stay.
        selected = m.js(MENU_TABS + "return idOf(main().gBrowser.selectedTab);")
        r = sidebar_page(m, MENU_PAGE + """await rightClick(rowOf(args[0])); choose("Move to space");
          const list = shown(), dots = menu.querySelectorAll(".dot").length;
          menu.querySelector(".back").click(); const again = plain(shown());
          choose("Move to space"); choose(list[2]);
          await until(() => !rowOf(args[0]));
          return {list, dots, again, gone: !rowOf(args[0]), active: spaces().find(s => s.active).id};""", d)
        check("Move to space lists the other spaces with their colours, and the row back goes back", r["dots"] == len(r["list"]) - 2 and r["dots"] >= 2 and r["again"] == ROW_MENU, str(r))
        moved = m.js(MENU_TABS + """await until(() => tabs().some(x => url(x.t).includes("smoke-menu-a") && x.t.userContextId !== args[0]));
          return {there: tabs().filter(x => url(x.t).includes("smoke-menu-a") && x.t.userContextId !== args[0]).length, selected: idOf(main().gBrowser.selectedTab)};""", ctx)
        check("Move to space moves the tab, and you stay where you are", r["gone"] and r["active"] == space and moved["there"] >= 1 and moved["selected"] == selected, f"{r}, {moved}")

        # Several tabs, as window.selectedTabs says (a function of the page's own: this is how
        # to make one where no script can be added). What the selection itself does has its own checks.
        s1, s2, s3 = open_tab("s1"), open_tab("s2"), open_tab("s3")

        def several(script):
            return sidebar_page(m, MENU_PAGE + """const before = page.selectedTabs, picked = args.slice(0, 3);
              page.selectedTabs = page.Array.prototype.slice.bind(page.JSON.parse(JSON.stringify(picked)), 0, 3);
              try { """ + script + """ } finally { page.selectedTabs = before; }""", s1, s2, s3)

        sidebar_page(m, MENU_PAGE + "await until(() => rowOf(args[0])); rowOf(args[0]).click(); return 1;", s2)
        m.js(MENU_TABS + "await until(() => idOf(main().gBrowser.selectedTab) === args[0]); await wait(500); return 1;", s2)
        many = ["Reload 3 tabs", "Mute 3 tabs", "Unload 3 tabs", "|", "Copy 3 addresses", "|", "Make 3 tabs essential", "Move 3 tabs to folder", "Move 3 tabs to space", "|", "Close 3 tabs"]
        m.js(clipboard + 'Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("before"); return 1;')
        r = several("""const labels = await rightClick(rowOf(picked[0])), marks = picked.filter(id => rowOf(id).classList.contains("menu-for")).length;
          choose("Copy 3 addresses"); return {labels, marks};""")
        copied = m.js(clipboard + 'await until(() => read() !== "before", 3000); return read();')
        check("with several tabs the menu counts them, marks them all, and leaves out what takes one", r == {"labels": many, "marks": 3}, str(r))
        check("Copy takes one address per line", copied == "https://example.org/?smoke-menu-s1\nhttps://example.org/?smoke-menu-s2\nhttps://example.org/?smoke-menu-s3", repr(copied))
        several("""await rightClick(rowOf(picked[0])); choose("Unload 3 tabs"); return 1;""")
        r = m.js(MENU_TABS + """const ids = [...args], list = ids.map(byId); await until(() => list.every(t => !t.linkedPanel)); const s = main().gBrowser.selectedTab;
          return {unloaded: list.filter(t => !t.linkedPanel).length, stays: !ids.includes(idOf(s)), container: s.userContextId, kept: entriesOf(await record(), "smoke-menu-s").length};""", s1, s2, s3)
        check("Unload takes them all, the selected one too, and the selection goes to another tab", r == {"unloaded": 3, "stays": True, "container": ctx, "kept": 3}, str(r))
        r = several("""const labels = await rightClick(rowOf(picked[0])); choose("Move 3 tabs to folder"); choose("New folder");
          const input = await until(() => doc.querySelector("#tabs .folder .rename"));
          await until(() => picked.every(id => input?.closest(".folder").contains(rowOf(id))));
          const folder = input?.closest(".folder"), value = input?.value;
          input?.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
          await until(() => !doc.querySelector("#tabs .folder .rename"));
          return {labels, value, order: [...folder.querySelectorAll(".tab")].map(e => Number(e.dataset.tab))};""")
        check("unloaded, they offer what is left, and go to a new folder in the order shown", r == {"labels": many[4:], "value": "Example", "order": [s1, s2, s3]}, str(r))
        r = several("""await rightClick(rowOf(picked[0])); choose("Close 3 tabs"); await until(() => picked.every(id => !rowOf(id))); return picked.filter(id => rowOf(id)).length;""")
        left = m.js(MENU_TABS + """const ids = [...args]; await until(() => ids.every(id => !byId(id))); return {tabs: ids.filter(id => byId(id)).length, kept: entriesOf(await record(), "smoke-menu-s").length};""", s1, s2, s3)
        check("Close takes them all, and saved tabs that are not loaded are gone for good", r == 0 and left == {"tabs": 0, "kept": 0}, f"{r}, {left}")

        # Always open this site here: a rule anchored to the start of the address, for this space.
        e = open_tab("rule")
        act(e, "Always open this site here")
        rules = m.js(MENU_TABS + """await wait(800); return (await storage(%r, ["rules"])).rules;""" % EXT_ID)
        r = sidebar_page(m, MENU_PAGE + "const l = await rightClick(rowOf(args[0])); menu.hidden = true; return l;", e)
        check("Always open this site here adds an anchored rule for this space", rules == [{"url": "/^https?:\\/\\/(www\\.)?example\\.org\\//", "space": space}], str(rules))
        check("the menu no longer offers a rule that is there", "Always open this site here" not in r, str(r))
        clear_rules()

        # Close.
        act(e, "Close")
        r = m.js(MENU_TABS + """await until(() => !byId(args[0])); const all = await record(); return {gone: !byId(args[0]), stored: entriesOf(all, "smoke-menu-rule").length};""", e)
        check("Close closes the tab", r == {"gone": True, "stored": 0}, str(r))

        # A real right click, and a real click on an item: the menu opens, Firefox's own does not.
        m.js(MENU_TABS + """const w = main(); w.__before = w.gBrowser.selectedTab; w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(500); return 1;""")
        box = sidebar_page(m, MENU_PAGE + "await until(() => rowOf(args[0])); const r = rowOf(args[0]).getBoundingClientRect(); return [r.left + 30, r.top + 8];", b)
        real_click(m, "/sidebar/sidebar.html", box[0], box[1], button=2)
        r = sidebar_page(m, MENU_PAGE + """await until(() => !menu.hidden, 3000);
          const item = [...menu.querySelectorAll(".item")].find(x => x.textContent === "Copy address").getBoundingClientRect();
          return {open: !menu.hidden, labels: plain(shown()), at: [item.left + 8, item.top + 8]};""")
        own = m.js(H + """const d = main().document; return {state: d.getElementById("contentAreaContextMenu")?.state, tabMenu: d.getElementById("tabContextMenu")?.state, ctx: !!main().gContextMenu};""")
        check("a real right click opens Tidier's menu and not Firefox's", r["open"] and "Copy address" in r["labels"] and own == {"state": "closed", "tabMenu": "closed", "ctx": False}, f"{r}, {own}")
        m.js(clipboard + 'Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("before"); return 1;')
        real_click(m, "/sidebar/sidebar.html", r["at"][0], r["at"][1])
        copied = m.js(clipboard + 'await until(() => read() !== "before", 3000); return read();')
        closed = sidebar_page(m, "return doc.getElementById('menu').hidden;")
        check("a real click on an item does it, and closes the menu", copied == "https://example.org/?smoke-menu-b" and closed, f"{copied!r}, {closed}")
        m.js(H + """const w = main(); if (w.__before && !w.__before.closing) w.gBrowser.selectedTab = w.__before; await wait(300); return 1;""")

        # The same in the real sidebar, where a page in a tab cannot say what it is like: its
        # contents cannot be read from here, but where things are can be, and the clipboard shows the result.
        # Its list has a scroll of its own, so the place of the row is read there too.
        real_row = f"""doc.querySelector('[data-tab="{b}"]')"""
        in_sidebar(m, f"""() => {{ {real_row}.scrollIntoView({{block: "center"}}); return 1; }}""")
        m.js(H + """const w = main(); w.focus(); await wait(300);
          // A panel of Firefox's own (it says when an extension hides tabs) would take the first click.
          for (const p of w.document.querySelectorAll("panel, menupopup")) if (p.state === "open") p.hidePopup();
          await wait(300); return 1;""")
        m.js(clipboard + 'Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("before"); return 1;')
        menu_on(m, real_row)
        choose(m, "Copy address")
        copied = m.js(clipboard + 'await until(() => read() !== "before", 3000); return read();')
        check("in the real sidebar, a real right click opens the menu and its item copies the address", copied == "https://example.org/?smoke-menu-b", repr(copied))
    finally:
        # Nothing of this for the groups after it. The folders' tabs first, as they are saved.
        clear_rules()
        sidebar_page(m, """for (const f of [...doc.querySelectorAll("#tabs .folder .head")]) if (["Menu kept", "Example"].includes(f.querySelector(".title")?.textContent)) send({type: "deleteFolder", key: f.dataset.folderHead});
          await wait(800); return 1;""")
        m.js(MENU_TABS + """const all = await record(), keys = new Set(entriesOf(all, "smoke-menu").map(([k]) => JSON.stringify(k)));
          for (const w of wins()) for (const t of [...w.gBrowser.tabs]) if (keys.has(key(w, t)) || url(t).includes("smoke-menu")) w.gBrowser.removeTab(t, {skipPermitUnload: true});
          await wait(2000); return 1;""")
    no_problems(m, "after the tab menu")


def alone_new_tab(m):
    # New tabs have one place, the top of today's tabs, for the button, ⌘T and a link
    # from another app. Each tab's row is read from the real sidebar, once it has settled.
    settled = """const settled = async (test, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = test(); if (v || Date.now() - t0 > ms) return v; await wait(50); } };"""
    rows = settled + """const ids = () => plainTabs().map(r => Number(r.dataset.tab));"""
    # Waits for a tab to be first among today's, with the others as they were. Every view the
    # sidebar is sent meanwhile is kept: a new row anywhere but first is a jump.
    new_first = rows + """const before = args[0], known = [...doc.querySelectorAll("#tabs > .tab")].map(r => Number(r.dataset.tab)), views = [];
      port.onMessage.addListener(v => views.push(v.tabs.map(t => t.id)));
      await settled(() => !before.includes(ids()[0]) && ids().length === before.length + 1);
      await wait(300);
      const top = plainTabs()[0];
      const jumped = views.filter(v => v.some(id => !known.includes(id)) && known.includes(v[0])).length;
      return {before, after: ids(), active: top.classList.contains("active"), above: top.previousElementSibling?.className, jumped};"""
    # Waits for tab `t` to be in the record and in the second window, and gives each window's order of its space.
    both_orders = """const w = main(), ctx = t.userContextId;
      const order = x => x.gBrowser.tabs.filter(y => !y.pinned && key(x, y) && y.userContextId === ctx).map(y => key(x, y));
      await settled(() => key(w, t) && order(other()).includes(key(w, t)));
      return {me: key(w, t), main: order(w), other: order(other()), ctx};"""
    opened = m.js(H + settled + """if (other()) return false;
      const a = main(), want = a.gBrowser.tabs.filter(t => !t.pinned && role(a, t)).length, w = a.OpenBrowserWindow(); w.__smoke = true;
      await settled(() => w.gBrowser && w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length >= want, 20000);
      a.focus(); await wait(500); return true;""")
    more_tabs_here(m, "newtab")

    # The button, with a folder drawn above. (moveTab puts the folder's tab last in the window; the unit test has one before.)
    r = sidebar_page(m, rows + """
      send({type: "newFolder", space: spaces().find(s => s.active).id, name: "Above the new tabs"});
      const head = await settled(() => [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Above the new tabs"));
      send({type: "moveTab", tabId: ids()[0], folder: head.dataset.folderHead, before: null});
      await settled(() => head.parentElement.querySelector(".tab"));
      const before = ids();
      doc.getElementById("new-tab").click();
      await settled(() => ids().length === before.length + 1);
      const top = plainTabs()[0];
      return {folder: head.dataset.folderHead, before, after: ids(), active: top.classList.contains("active"), above: top.previousElementSibling?.className};""")
    folder = r["folder"]
    check("the new tab button opens the tab first among today's tabs, under the folders, selected",
          r["after"][1:] == r["before"] and r["active"] and r["above"] == "divider", str(r))
    s = m.js(H + settled + """const t = main().gBrowser.selectedTab, was = key(main(), t);
      t.linkedBrowser.loadURI(Services.io.newURI("https://example.org/?smoke-newtab-button"), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      """ + both_orders.replace("return {", "return {was, "))
    check("a new tab is not in the other window until it has an address", not s["was"], str(s))
    check("once it has one, the other window shows the same order", s["me"] and s["main"] == s["other"], str(s))

    # ⌘T, through Firefox's own key. The tab comes without a container, and is opened again here.
    before = sidebar_page(m, rows + "return ids();")
    m.js(H + "main().focus(); await wait(300); return 1;")
    press(m, "t", CMD)
    r = sidebar_page(m, new_first, before)
    t = m.js(H + "const t = main().gBrowser.selectedTab; return {ctx: t.userContextId, page: url(t)};")
    check("⌘T opens the tab first among today's tabs, in the space, selected",
          r["after"][1:] == r["before"] and r["active"] and t["ctx"] == s["ctx"], str((r, t)))

    # A link from another app: an address, without a container.
    before = r["after"]
    # (A moment from now, once the views are being kept. Its row must never show at the end. A link
    # is created on about:blank, and its address comes later: how much later is made sure here, or
    # the check would depend on how fast Firefox is.)
    m.js(H + """sT(() => { const t = main().gBrowser.addTrustedTab("about:blank", {inBackground: false});
      sT(() => t.linkedBrowser.loadURI(Services.io.newURI("https://example.org/?smoke-newtab-link"), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()}), 800); }, 3000); return 1;""")
    r = sidebar_page(m, new_first, before)
    check("a link without a container opens first among today's tabs, selected", r["after"][1:] == r["before"] and r["active"], str(r))
    check("its row never shows anywhere else first", r["jumped"] == 0, str(r))
    s = m.js(H + settled + "const t = main().gBrowser.tabs.find(x => url(x).includes('smoke-newtab-link'));" + both_orders)
    check("the other window has the link in the same place", s["me"] and s["main"] == s["other"], str(s))
    check("the link is in the space", s["ctx"] == t["ctx"], str(s))

    # A site that takes long to answer: the row shows after a while, in the same place, and stays there.
    before = r["after"]
    m.js(H + """sT(() => { const t = main().gBrowser.addTrustedTab("about:blank", {inBackground: false});
      sT(() => t.linkedBrowser.loadURI(Services.io.newURI("https://example.org/?smoke-newtab-slow"), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()}), 4500); }, 3000); return 1;""")
    r = sidebar_page(m, new_first, before)
    check("a link that takes long shows first among today's while it waits", r["after"][1:] == r["before"] and r["jumped"] == 0, str(r))
    r = sidebar_page(m, rows + """const waiting = args[0];
      await settled(() => ids()[0] !== waiting);
      return {waiting, after: ids(), active: plainTabs()[0].classList.contains("active")};""", r["after"][0])
    check("and is still first once the site answers", r["after"][1:] == before and r["active"], str(r))
    before = r["after"]

    # A link from a tab: Firefox puts it next to that tab, in its container, and there it stays, in both windows.
    s = m.js(H + settled + """const first = main(), space = first.gBrowser.selectedTab.userContextId;
      const from = first.gBrowser.tabs.filter(t => !t.pinned && t.userContextId === space && url(t).includes("smoke-newtab-") && !/-(link|button|slow)/.test(url(t)))[1];
      first.gBrowser.selectedTab = from; await settled(() => from.selected); await wait(300);
      const t = first.gBrowser.addTrustedTab("https://example.org/?smoke-newtab-from-tab", {relatedToCurrent: true, inBackground: true});
      """ + both_orders.replace("return {", "return {beside: first.gBrowser.tabs.indexOf(t) === first.gBrowser.tabs.indexOf(from) + 1, opener: key(first, from), "))
    check("a link opened from a tab stays next to it", s["beside"] and s["main"][s["main"].index(s["opener"]) + 1] == s["me"], str(s))
    check("and the other window has it there too", s["main"] == s["other"], str(s))

    # A link from a tab drawn apart has nothing to stay next to. Next to the folder's tab would be the end of
    # the list (moveTab puts it last in the window). A moment from now again, once the views are being kept.
    before = sidebar_page(m, rows + "return ids();")
    m.js(H + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.tabs.at(-1);
      sT(() => w.gBrowser.addTrustedTab("https://example.org/?smoke-newtab-from-folder", {relatedToCurrent: true, inBackground: true}), 3000); return 1;""")
    r = sidebar_page(m, new_first, before)
    check("a link from a tab in a folder opens first among today's tabs", r["after"][1:] == r["before"], str(r))
    s = m.js(H + settled + "const t = main().gBrowser.tabs.find(x => url(x).includes('smoke-newtab-from-folder'));" + both_orders)
    check("and the other window has it there too (a folder's tab)", s["me"] and s["main"] == s["other"], str(s))
    before = r["after"]
    m.js(H + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => t.pinned && t.userContextId === args[0]);
      sT(() => w.gBrowser.addTrustedTab("https://example.org/?smoke-newtab-from-essential", {relatedToCurrent: true, inBackground: true}), 3000); return 1;""", s["ctx"])
    r = sidebar_page(m, new_first, before)
    check("a link from an essential opens first among today's tabs", r["after"][1:] == r["before"], str(r))

    # A double click on the empty part of the list; on a row it is only a click.
    r = sidebar_page(m, rows + """
      const fire = (e, type, detail) => e.dispatchEvent(new page.MouseEvent(type, {bubbles: true, cancelable: true, detail, button: 0}));
      const twice = (first, second = first) => {
        for (const [e, n] of [[first, 1], [second, 2]]) for (const type of ["mousedown", "mouseup", "click"]) fire(e, type, n);
        fire(second, "dblclick", 2);
      };
      const list = doc.getElementById("tabs"), before = ids().length;
      twice(plainTabs()[0]);
      await wait(1200);
      const onRow = ids().length;
      // The row under the pointer can go between the clicks (its ×): the second then lands on the empty part.
      twice(plainTabs()[1], list);
      await wait(1200);
      return {before, onRow, fromRow: ids().length};""")
    check("a double click on a row opens no tab", r["onRow"] == r["before"], str(r))
    check("a double click that began on a row opens no tab", r["fromRow"] == r["before"], str(r))
    # The empty part with Firefox's own mouse events, on the sidebar page in front. Two
    # clicks too far apart on a busy machine are no double click, so it may take another try.
    before = sidebar_page(m, rows + "return ids();")
    for _ in range(3):
        m.js(H + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(500); return 1;""")
        into_page(m, "/sidebar/sidebar.html")
        # (A list longer than the sidebar has no empty part in view, so for the test it gets one at its end.)
        spot = m.cmd("WebDriver:ExecuteScript", {"args": [], "script": """const l = document.getElementById("tabs"), box = l.getBoundingClientRect(), x = Math.round(box.left + box.width / 2), y = Math.round(box.bottom - 4);
          if (l.lastElementChild.getBoundingClientRect().bottom + 16 > box.bottom) { l.style.paddingBottom = "24px"; l.scrollTop = l.scrollHeight; }
          return {x, y, empty: document.elementFromPoint(x, y) === l};"""})
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": spot["x"], "y": spot["y"], "duration": 0},
            {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}, {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]})
        m.cmd("WebDriver:ReleaseActions")
        m.chrome()
        r = sidebar_page(m, new_first, before)
        if r["after"][1:] == r["before"]:
            break
    sidebar_page(m, """doc.getElementById("tabs").style.paddingBottom = ""; return 1;""")
    check("a double click on the empty part of the list opens a tab first among today's, selected", spot["empty"] and r["after"][1:] == r["before"] and r["active"], str((spot, r)))

    # What this group added goes again. The tabs are live in this window, so the other follows.
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(500); return 1;""", folder)
    r = m.js(H + settled + """const a = main(), ours = t => url(t).includes("smoke-newtab") || /^about:(newtab|home)/.test(url(t));
      for (const t of a.gBrowser.tabs.filter(t => !t.pinned && ours(t))) a.gBrowser.removeTab(t);
      await settled(() => !other().gBrowser.tabs.some(t => !t.pinned && String(t.label).includes("smoke-newtab")));
      await wait(2000);
      if (args[0]) await close(other());
      return 1;""", opened)
    no_problems(m, "after opening new tabs")


def sidebar_press(m, find):
    """Press the real mouse button on what the expression `find` gives in the sidebar page, and leave it down. Returns how to let go: there, or at x, y. Let go before doing anything else with Marionette: its mouse belongs to this page's context."""
    # In this order: the page is a row too, and selecting it can scroll the list. A row below
    # the window, in a long list, is out of reach of a pointer until it is brought into view.
    sidebar_page(m, "return 1;")
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("/sidebar/sidebar.html")); w.focus();
      if (w.gBrowser.selectedTab !== t) { w.gBrowser.selectedTab = t; await wait(500); } return 1;""")
    # (The quiet line can lie over the end of the list for its ten seconds, and a row can be
    # drawn again at any moment, so what is found is found anew each time.)
    at = sidebar_page(m, f"""const find = () => {find}; if (!find()) return null;
      find().scrollIntoView({{block: "center"}});
      const spot = () => {{ const e = find(), box = e?.getBoundingClientRect(), x = box?.left + box?.width / 2, y = box?.top + box?.height / 2; return box && {{x: Math.round(x), y: Math.round(y), free: e.contains(doc.elementFromPoint(x, y))}}; }};
      for (let i = 0; i < 120 && !spot()?.free; i++) await wait(100);
      return spot();""")
    if not at:
        return None
    into_page(m, "/sidebar/sidebar.html")
    mouse = lambda *actions: m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": list(actions)}]})
    mouse({"type": "pointerMove", "duration": 0, "x": at["x"], "y": at["y"]}, {"type": "pointerDown", "button": 0})

    def let_go(x=None, y=None):
        mouse(*([{"type": "pointerMove", "duration": 0, "x": x, "y": y}] if x is not None else []), {"type": "pointerUp", "button": 0})
        m.cmd("WebDriver:ReleaseActions")
        m.chrome()
    return let_go


def sidebar_click(m, find, hold=0):
    """A real click on what the expression `find` gives in the sidebar page: Firefox itself decides what is under the pointer. `hold`: seconds between press and release."""
    let_go = sidebar_press(m, find)
    if not let_go:
        return False
    time.sleep(hold)
    let_go()
    return True


def alone_sound(m):
    # Firefox's own audible state, set from chrome code as a page playing sound sets it:
    # the same for Tidier, with no noise from a test machine and no need for a sound
    # device on GitHub's. The real pages are all in the other window, so this sidebar's
    # rows and tiles are placeholders: what they show can only come from the real tab.
    SOUND = """
      const winOf = t => wins().find(w => w.gBrowser.tabs.includes(t));
      const play = (t, on) => { t.toggleAttribute("soundplaying", on); winOf(t).gBrowser._tabAttrModified(t, ["soundplaying"]); };
      const real = name => { for (const w of wins()) for (const t of w.gBrowser.tabs) if (t.label === name && !url(t).includes("ghost.html") && !url(t).startsWith("about:blank")) return t; return null; };
    """
    active = sidebar_page(m, """return {active: spaces().find(s => s.active).id, other: spaces().find(s => !s.active).id};""")
    here, away = active["active"], active["other"]
    opened = m.js(H + """const a = main(); a.focus(); await wait(300);
      let b = other(); const opened = !b;
      if (opened) { b = a.OpenBrowserWindow(); b.__smoke = true; for (let i = 0; i < 100 && !b.gBrowser; i++) await wait(100); await wait(4000); }
      const [pages, hereCtx, awayCtx] = args, page = name => pages + "/titled?" + encodeURIComponent(name);
      for (const [name, ctx] of [["sound tile", hereCtx], ["sound row", hereCtx], ["sound inside", hereCtx], ["sound away", awayCtx]]) {
        b.gBrowser.addTrustedTab(page(name), {userContextId: ctx, inBackground: true}); await wait(300);
      }
      for (let i = 0; i < 50 && !b.gBrowser.tabs.some(t => t.label === "sound tile"); i++) await wait(100);
      b.gBrowser.pinTab(b.gBrowser.tabs.find(t => t.label === "sound tile"));
      await wait(3000);
      return opened;""", m.pages, int(here.split("-")[-1]), int(away.split("-")[-1]))

    FIND = """
      const tile = name => [...doc.querySelectorAll("#essentials .tile")].find(e => e.title.split("\\n")[0] === name);
      const row = name => [...doc.querySelectorAll("#tabs .tab")].find(e => e.title.split("\\n")[0] === name);
      const head = name => [...doc.querySelectorAll("#tabs .head")].find(e => e.title === name);
      const dot = id => doc.querySelector(`#spaces .space[data-space="${id}"]`);
      const until = async (f, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (f()) return true; await wait(100); } return false; };
      const box = e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); };
      // Where things are, also inside a tile, a row, a closed head and a dot: their
      // own box stays the same whatever is in them.
      const places = away => { const t = tile("sound tile"), r = row("sound row"), h = head("Sound folder"), d = dot(away);
        return {tile: box(t), tileIcon: box(t.querySelector("img, .letter")), row: box(r), rowIcon: box(r.querySelector("img, .letter")), titleLeft: box(r.querySelector(".title"))[0],
                close: box(r.querySelector(".close")), head: box(h), headTitleLeft: box(h.querySelector(".title"))[0], countRight: Math.round(h.querySelector(".count").getBoundingClientRect().right),
                space: box(d), dot: box(d.querySelector(".dot"))}; };
    """
    # In this window everything is a placeholder, and a folder is closed with a tab in it.
    r = sidebar_page(m, FIND + """
      const [here] = args;
      await until(() => tile("sound tile") && row("sound row") && row("sound inside"));
      send({type: "newFolder", space: here, name: "Sound folder"});
      await until(() => head("Sound folder"));
      send({type: "moveTab", tabId: Number(row("sound inside").dataset.tab), folder: head("Sound folder").dataset.folderHead, before: null});
      await until(() => head("Sound folder").parentElement.querySelector(".tab"));
      const fold = () => head("Sound folder").click();
      fold();
      await until(() => head("Sound folder").parentElement.classList.contains("collapsed"));
      return {tile: !!tile("sound tile"), row: !!row("sound row"), unloaded: row("sound row").classList.contains("unloaded") && tile("sound tile").classList.contains("unloaded"),
              marks: doc.querySelectorAll(".sound").length, boxes: places(args[1])};""", here, away)
    check("with nothing playing there is no mark anywhere", r["marks"] == 0, str(r))
    check("this window has only placeholders of those tabs", r["tile"] and r["row"] and r["unloaded"], str(r))
    before = r["boxes"]

    # It starts playing, in the other window.
    m.js(H + SOUND + """for (const name of ["sound tile", "sound row", "sound inside", "sound away"]) play(real(name), true); return 1;""")
    r = sidebar_page(m, FIND + """
      const [here, away] = args;
      await until(() => tile("sound tile").querySelector(".sound") && row("sound row").querySelector(".sound") && head("Sound folder").querySelector(".sound") && dot(away).querySelector(".sound"));
      const inside = (e, mark) => { const a = e.getBoundingClientRect(), b = mark.getBoundingClientRect(); return b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom; };
      return {tile: !!tile("sound tile").querySelector(".sound"), row: !!row("sound row").querySelector(".sound"), head: !!head("Sound folder").querySelector(".sound"),
              dotAway: !!dot(away).querySelector(".sound"), dotHere: !!dot(here).querySelector(".sound"), silentDots: [...doc.querySelectorAll("#spaces .space")].filter(b => b.querySelector(".sound")).length,
              onlyThose: [...doc.querySelectorAll(".sound")].length, svg: !!tile("sound tile").querySelector(".sound svg"), emoji: /[\\u{1F500}-\\u{1F5FF}]/u.test(doc.body.textContent),
              insideTile: inside(tile("sound tile"), tile("sound tile").querySelector(".sound")), insideDot: inside(dot(away), dot(away).querySelector(".sound")),
              boxes: places(away)};""", here, away)
    check("the sound of a page in another window shows on an essential's tile", r["tile"] and r["svg"] and r["insideTile"], str(r))
    check("and on a tab's row, drawn and not as an emoji", r["row"] and not r["emoji"], str(r))
    check("and on the head of a closed folder it is in", r["head"], str(r))
    check("and on the dot of another space, and of this space, as both play", r["dotAway"] and r["insideDot"] and r["dotHere"] and r["silentDots"] == 2, str(r))
    check("the marks move nothing", r["boxes"] == before, f"{before} became {r['boxes']}")

    # A click on a mark mutes the real page, wherever it is, and selects nothing.
    def state():
        return m.js(H + SOUND + """const a = main(), b = other();
          return {selected: [a.gBrowser.selectedTab.label, b.gBrowser.selectedTab.label], muted: Object.fromEntries(["sound tile", "sound row", "sound inside"].map(n => [n, real(n).muted])),
                  windows: Object.fromEntries(["sound tile", "sound row", "sound inside", "sound away"].map(n => [n, winOf(real(n)) === b ? "other" : "main"]))};""")

    def state_until(test):
        for _ in range(40):
            s = state()
            if test(s):
                break
            time.sleep(0.2)
        return s
    ok = sidebar_click(m, '[...doc.querySelectorAll("#essentials .tile")].find(e => e.title.split("\\n")[0] === "sound tile")?.querySelector(".sound")')
    state_until(lambda s: s["muted"]["sound tile"])
    time.sleep(0.5)  # a selection, if the click went on to the tile, would have come with it
    s0 = state()
    r = sidebar_page(m, FIND + """await until(() => tile("sound tile").querySelector(".sound.muted"));
      return {muted: !!tile("sound tile").querySelector(".sound.muted"), title: tile("sound tile").querySelector(".sound").title, active: tile("sound tile").classList.contains("active"), row: !!row("sound row").querySelector(".sound.muted")};""")
    check("a click on a tile's mark mutes the real tab in the other window", ok and s0["muted"]["sound tile"] and s0["windows"]["sound tile"] == "other", str(s0))
    check("and does not select it", not r["active"] and s0["selected"][0].startswith("Tidier") and s0["selected"][1] != "sound tile", str((r, s0)))
    check("the tile then offers to unmute, and only it changed", r["muted"] and r["title"] == "Unmute" and not r["row"], str(r))
    sidebar_click(m, '[...doc.querySelectorAll("#essentials .tile")].find(e => e.title.split("\\n")[0] === "sound tile")?.querySelector(".sound")')
    s = state_until(lambda s: not s["muted"]["sound tile"])
    check("a second click unmutes it", s["muted"]["sound tile"] is False, str(s))
    # The row's and the closed head's.
    ok = sidebar_click(m, '[...doc.querySelectorAll("#tabs .tab")].find(e => e.title.split("\\n")[0] === "sound row")?.querySelector(".sound")')
    ok2 = sidebar_click(m, '[...doc.querySelectorAll("#tabs .head")].find(e => e.title === "Sound folder")?.querySelector(".sound")')
    s1 = state_until(lambda s: s["muted"]["sound row"] and s["muted"]["sound inside"])
    r = sidebar_page(m, FIND + """await until(() => head("Sound folder").querySelector(".sound.muted"));
      return {collapsed: head("Sound folder").parentElement.classList.contains("collapsed"), mark: !!head("Sound folder").querySelector(".sound.muted"), dotHere: !!dot(args[0]).querySelector(".sound")};""", here)
    check("a click on a row's mark on a placeholder mutes the real tab", ok and s1["muted"]["sound row"] and s1["windows"]["sound row"] == "other", str(s1))
    check("a click on a closed folder's mark mutes what is in it, and it stays closed", ok2 and s1["muted"]["sound inside"] and r["collapsed"] and r["mark"], str((s1, r)))
    m.js(H + SOUND + """play(real("sound tile"), false); return 1;""")
    r = sidebar_page(m, FIND + """await until(() => !dot(args[0]).querySelector(".sound"));
      return {dotHere: !!dot(args[0]).querySelector(".sound"), row: !!row("sound row").querySelector(".sound.muted"), tile: !!tile("sound tile").querySelector(".sound")};""", here)
    check("with only muted sound left, this space's dot has no mark, and the muted row keeps its", not r["dotHere"] and r["row"], str(r))
    check("a tile that stopped playing has no mark", not r["tile"], str(r))
    idle = extension_message(m, {"type": "idle", "ms": 5000})
    if not idle["alarms"]:
        check("while something plays, Tidier does nothing", idle["jobs"] == 0 and idle["views"] == 0, str(idle))

    # A click on a dot itself switches, as always; on its mark it goes to the tab. The
    # bar notes a click that reaches it: one on the mark must end there, or it switches too.
    sidebar_page(m, """doc.getElementById("spaces").addEventListener("click", () => { doc.documentElement.dataset.barClicked = "1"; }); return 1;""")
    sidebar_click(m, f"""doc.querySelector('#spaces .space[data-space="{away}"] .dot')""")
    r = sidebar_page(m, FIND + """await until(() => dot(args[0]).classList.contains("active"), 3000); return {active: dot(args[0]).classList.contains("active"), bar: doc.documentElement.dataset.barClicked};""", away)
    tab = m.js(H + """const w = main(); return w.gBrowser.selectedTab.label;""")
    check("a click on a dot with a mark switches space, as always", r["active"] and r["bar"] == "1", str((r, tab)))
    sidebar_page(m, f"""delete doc.documentElement.dataset.barClicked; send({{type: "space", space: "{here}"}}); await wait(1200); return 1;""")
    ok = sidebar_click(m, f"""doc.querySelector('#spaces .space[data-space="{away}"] .sound')""")
    s2 = state_until(lambda s: s["selected"][0] == "sound away" and s["windows"]["sound away"] == "main")
    r = sidebar_page(m, FIND + """await until(() => dot(args[0]).classList.contains("active"));
      return {active: dot(args[0]).classList.contains("active"), row: !!row("sound away")?.querySelector(".sound"), selected: !!row("sound away")?.classList.contains("active"), dot: !!dot(args[0]).querySelector(".sound"), bar: doc.documentElement.dataset.barClicked ?? null};""", away)
    check("a click on a dot's mark goes to the tab that plays, and pulls it into this window", ok and s2["selected"][0] == "sound away" and s2["windows"]["sound away"] == "main" and r["bar"] is None, str((s2, r)))
    check("and to its space, where its row shows it", r["active"] and r["row"] and r["selected"] and r["dot"], str(r))
    # An essential in another space comes over another way (essentialShown, essentials.js).
    m.js(H + SOUND + """play(real("sound tile"), true); return 1;""")
    sidebar_page(m, FIND + """await until(() => dot(args[0]).querySelector(".sound")); return 1;""", here)
    ok = sidebar_click(m, f"""doc.querySelector('#spaces .space[data-space="{here}"] .sound')""")
    s3 = state_until(lambda s: s["selected"][0] == "sound tile" and s["windows"]["sound tile"] == "main")
    r = sidebar_page(m, FIND + """await until(() => tile("sound tile")?.classList.contains("active"));
      return {active: !!tile("sound tile")?.classList.contains("active"), mark: !!tile("sound tile")?.querySelector(".sound:not(.muted)"), loaded: !tile("sound tile")?.classList.contains("unloaded")};""")
    check("a dot's mark also brings an essential from another space and window, still playing", ok and s3["selected"][0] == "sound tile" and s3["windows"]["sound tile"] == "main" and r["active"] and r["mark"] and r["loaded"], str((s3, r)))

    # All quiet again, and gone.
    m.js(H + SOUND + """for (const w of wins()) for (const t of w.gBrowser.tabs) { if (t.soundPlaying) play(t, false); if (t.muted) t.toggleMuteAudio(); } return 1;""")
    r = sidebar_page(m, FIND + """await until(() => !doc.querySelector(".sound")); const marks = doc.querySelectorAll(".sound").length;
      send({type: "space", space: args[0]}); await until(() => head("Sound folder"));
      send({type: "deleteFolder", key: head("Sound folder").dataset.folderHead}); await wait(800);
      return {marks};""", here)
    check("when it stops, every mark is gone", r["marks"] == 0, str(r))

    # A page whose title ticks is drawn again all the time, and a redraw replaces what is
    # under the pointer: a press must still do what it was for, however long it takes.
    m.js(H + SOUND + """const a = main(), t = a.gBrowser.addTrustedTab(args[0] + "/ticking", {userContextId: args[1], inBackground: true});
      a.__ticking = t;
      for (let i = 0; i < 80 && !/^[0-9]+$/.test(t.label); i++) await wait(100);
      play(t, true); return 1;""", m.pages, int(here.split("-")[-1]))
    TICKING = '[...doc.querySelectorAll("#tabs .tab")].find(e => /^[0-9]+$/.test(e.title.split("\\n")[0]))'
    r = sidebar_page(m, FIND + f"""const ticking = () => {TICKING}; await until(() => ticking()?.querySelector(".sound"));
      const first = ticking().title; await until(() => ticking().title !== first); return {{ticks: ticking().title !== first}};""")
    ok = sidebar_click(m, TICKING + '?.querySelector(".sound")', hold=1.5)
    ticked = m.js(H + """const t = main().__ticking; for (let i = 0; i < 40 && !t.muted; i++) await wait(100); return {muted: t.muted, selected: main().gBrowser.selectedTab === t};""")
    check("a press on a mark mutes, also while its row is being drawn again", ok and r["ticks"] and ticked["muted"] and not ticked["selected"], str((ok, r, ticked)))
    r = sidebar_page(m, FIND + f"""const ticking = () => {TICKING}; await until(() => ticking()?.querySelector(".sound.muted"));
      const first = ticking().title; await until(() => ticking().title !== first); return {{muted: !!ticking().querySelector(".sound.muted"), ticks: ticking().title !== first}};""")
    check("and what waited is drawn once it is let go", r["muted"] and r["ticks"], str(r))
    ok = sidebar_click(m, TICKING + '?.querySelector(".close")', hold=1.5)
    closed = m.js(H + """const a = main(); for (let i = 0; i < 40 && a.gBrowser.tabs.includes(a.__ticking); i++) await wait(100); return !a.gBrowser.tabs.includes(a.__ticking);""")
    check("a press on a row's × closes, also while the row is being drawn again", ok and closed, str(closed))
    # One change during a press that ends elsewhere: no click and no later event, so it
    # has to be drawn because you let go. The page itself makes the change, a moment into
    # the press, and notes what is drawn a moment later. On a dot's mark, as moving away
    # from a row would drag the row, and in a headless Firefox such a drag never ends.
    m.js(H + SOUND + """play(real("sound row"), true); return 1;""")
    sidebar_page(m, FIND + """const [here] = args; await until(() => dot(here).querySelector(".sound"));
      const [tab] = await page.browser.tabs.query({title: "sound row", audible: true});
      const note = (name, was) => { doc.documentElement.dataset[name] = was ? "drawn" : "waits"; };
      doc.addEventListener("pointerdown", () => {
        setTimeout(() => page.browser.tabs.update(tab.id, {muted: true}), 200);
        setTimeout(() => note("whilePressed", !dot(here).querySelector(".sound")), 1000);
      }, {once: true});
      // Noted here: looking from outside (sidebar_page) asks for a view itself.
      doc.addEventListener("pointerup", async () => { await until(() => !dot(here).querySelector(".sound"), 3000); note("letGo", !dot(here).querySelector(".sound")); }, {once: true});
      return 1;""", here)
    let_go = sidebar_press(m, f"""doc.querySelector('#spaces .space[data-space="{here}"] .sound')""")
    time.sleep(1.5)
    let_go(5, 5)
    time.sleep(3.5)
    r = sidebar_page(m, """return {...doc.documentElement.dataset};""")
    check("what is pressed waits, and a press that ends elsewhere still shows what changed", r.get("whilePressed") == "waits" and r.get("letGo") == "drawn", str(r))
    m.js(H + SOUND + """const t = real("sound row"); play(t, false); t.toggleMuteAudio(); return 1;""")
    m.js(H + """for (const w of wins()) for (const t of w.gBrowser.tabs) if (t.pinned && t.label === "sound tile") { w.gBrowser.unpinTab(t); break; }
      await wait(2500);
      await removeWhere((w, t) => t.label.startsWith("sound ") || t === main().__ticking);
      if (args[0]) await close(other());
      return 1;""", opened)


def alone_news(m):
    # Pages in the background, each named by its address so that its row can be found:
    # one in the list, one in a folder that closes, one as an essential, one in another space.
    name = "smoke-news-"
    page = lambda which: f"{m.pages}/titled?{name}{which}"
    spaces = sidebar_page(m, "return spaces();")
    remembered = extension_message(m, {"type": "stats"})["sizes"]["newsSeen"]
    here = next(s["id"] for s in spaces if s["active"])
    there = next(s["id"] for s in spaces if not s["active"] and s["id"] != "firefox-container-4")
    number = lambda space: int(space.rsplit("-", 1)[1])
    opened = m.js(H + """const [pages, here, there] = args, w = main(); w.focus();
      const tabs = pages.map(([address, inHere]) => w.gBrowser.addTrustedTab(address, {userContextId: inHere ? here : there, inBackground: true}));
      for (let i = 0; i < 100 && !tabs.every(t => role(w, t) === "live"); i++) await wait(100);
      return tabs.map(t => role(w, t));""", [[page("row"), True], [page("folder"), True], [page("tile"), True], [page("there"), False], [f"{m.pages}/ticking?{name}clock", True]], number(here), number(there))
    check("the test's background pages are Tidier's tabs", opened == ["live"] * 5, str(opened))
    pinned = m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes(args[0])); w.gBrowser.pinTab(t);
      for (let i = 0; i < 100 && !ek(w, t); i++) await wait(100);
      return !!ek(w, t);""", name + "tile")
    check("one of them is an essential", pinned, str(pinned))
    # JavaScript for each check: what has a mark now, under a rule the sidebar draws by.
    marked = """
      const named = which => [...doc.querySelectorAll(".tab, .tile")].find(r => r.title.includes(args[0] + which));
      const has = () => ({
        rows: [...doc.querySelectorAll("#tabs .tab.news")].filter(r => r.offsetParent).map(r => r.title.split("\\n")[0].replace(args[0], "")),
        heads: [...doc.querySelectorAll(".folder.collapsed.news")].map(f => f.querySelector(".head .title").textContent),
        tiles: [...doc.querySelectorAll(".tile.news")].map(r => r.title.split("\\n")[0].replace(args[0], "")),
        spaces: [...doc.querySelectorAll(".space.news")].map(b => b.dataset.space),
      });
      // By the clock: this page is a tab in the background, whose timers Firefox slows down.
      const when = async test => { for (const end = Date.now() + 8000; Date.now() < end && !test();) await wait(100); };
      const until = async test => { await when(() => test(has())); return has(); };
      const bar = id => doc.querySelector(`.space[data-space="${id}"]`);
      const inSpace = id => when(() => spaces().find(s => s.active).id === id);
      // What is really drawn of a dot, which a class alone does not tell: an empty box, a wrong
      // selector or a missing colour would all leave the class in place and nothing to see.
      const colour = css => { const probe = doc.createElement("i"); probe.style.color = css; doc.body.append(probe); const c = page.getComputedStyle(probe).color; probe.remove(); return c; };
      const dot = (e, which) => { const d = page.getComputedStyle(e, which); return {content: d.content, width: parseFloat(d.width), height: parseFloat(d.height), position: d.position, animation: d.animationName, color: d.backgroundColor}; };
      const accent = () => colour(page.getComputedStyle(doc.documentElement).getPropertyValue("--accent"));
      // What another window's sidebar is told: this page can ask as that window's sidebar does.
      const viewOf = windowId => new Promise(done => {
        const p = page.browser.runtime.connect({name: "sidebar"});
        p.onMessage.addListener(view => { const got = JSON.parse(page.JSON.stringify(view)); p.disconnect(); done(got); });
        p.postMessage(page.JSON.parse(JSON.stringify({type: "hello", windowId})));
      });
      const inView = (view, which) => [...view.tabs, ...view.folders.flatMap(f => f.tabs)].find(t => t.title.includes(args[0] + which));"""
    r = sidebar_page(m, marked + """
      send({type: "newFolder", space: args[1], name: args[0] + "kept"});
      let head = null;
      for (let i = 0; i < 50 && !head; i++) { await wait(100); head = [...doc.querySelectorAll(".folder .head")].find(h => h.title === args[0] + "kept"); }
      send({type: "moveTab", tabId: Number(named("folder").dataset.tab), folder: head.dataset.folderHead, before: null});
      for (let i = 0; i < 50 && !head.parentElement.querySelector(".tab"); i++) await wait(100);
      // A tab here is the last used, or coming back to this space below selects the newest of these
      // pages: Firefox counts a tab opened in the background as used then, and a selected tab has no dot.
      const mine = [...doc.querySelectorAll("#essentials .tile, #tabs .tab")].find(x => !x.title.includes(args[0]) && !x.title.includes("moz-extension:"));
      mine.click();
      await when(() => mine.classList.contains("active"));
      // The other space's last used tab is another one, so that going there does not select this page.
      bar(args[2]).click();
      await inSpace(args[2]);
      const other = [...doc.querySelectorAll("#tabs .tab")].find(x => !x.title.includes(args[0]));
      other.click();
      await when(() => other.classList.contains("active"));
      bar(args[1]).click();
      await inSpace(args[1]);
      return {key: head.dataset.folderHead, filled: !!head.parentElement.querySelector(".tab"), back: spaces().find(s => s.active).id};""", name, here, there)
    check("a folder has one of them in it", r["filled"] and r["back"] == here, str(r))
    folder_key = r["key"]
    # Past the quiet after loading. A title that only ticks says nothing, however long it does.
    time.sleep(6)
    r = sidebar_page(m, marked + """
      const ticking = [...doc.querySelectorAll("#tabs .tab")].filter(x => /^\\d+$/.test(x.title.split("\\n")[0]));
      return {ticking: ticking.length, seconds: ticking.map(x => Number(x.title.split("\\n")[0])), has: has()};""", name)
    check("a title that only ticks has no dot", r["ticking"] == 1 and r["has"] == {"rows": [], "heads": [], "tiles": [], "spaces": []}, str(r))
    m.js(H + """const w = main(); await removeWhere((x, t) => url(t).includes("/ticking?")); return 1;""")

    place = """const r = named("row"), t = r.querySelector(".title").getBoundingClientRect(), i = r.querySelector("img, .letter").getBoundingClientRect();
      return {title: [t.left, t.top, t.width], icon: [i.left, i.top], row: r.getBoundingClientRect().height};"""
    before = sidebar_page(m, marked + place, name)
    set_title(m, page("row"), f"{name}row Anna wrote")
    r = sidebar_page(m, marked + """
      const got = await until(h => h.rows.length);
      const row = named("row");
      const t = row.querySelector(".title").getBoundingClientRect(), i = row.querySelector("img, .letter").getBoundingClientRect();
      return {got, dot: dot(row, "::before"), accent: accent(), title: [t.left, t.top, t.width], icon: [i.left, i.top], row: row.getBoundingClientRect().height};""", name)
    check("a background page's new title gives its row a dot", r["got"]["rows"] == ["row Anna wrote"], str(r))
    shows = lambda d, color: d and d["content"] != "none" and d["width"] >= 5 and d["height"] >= 5 and d["position"] == "absolute" and d["animation"] == "none" and d["color"] == color
    check("the dot is drawn, still, and in the space's colour", shows(r["dot"], r["accent"]), str(r))
    check("the dot moves nothing in the row", all(before[k] == r[k] for k in ("title", "icon", "row")), f"{before} -> {r}")
    set_title(m, page("folder"), f"{name}folder (1) unread")
    set_title(m, page("tile"), f"{name}tile (1) unread")
    set_title(m, page("there"), f"{name}there (1) unread")
    r = sidebar_page(m, marked + """
      await until(h => h.rows.length === 2 && h.tiles.length && h.spaces.length);
      [...doc.querySelectorAll(".folder .head")].find(h => h.title === args[0] + "kept").click();
      // Closed, it rests: an unloaded page says nothing more, and what it said stays.
      await until(h => h.heads.length);
      await when(() => named("folder").classList.contains("unloaded"));
      const got = has(), seen = (selector, pseudo) => { const e = doc.querySelector(selector); return e && dot(e, pseudo); };
      return {...got, rested: named("folder").classList.contains("unloaded"), accent: accent(), other: colour(bar(args[1]).style.getPropertyValue("--color")),
        head: seen(".folder.collapsed.news > .head", "::before"), tile: seen(".tile.news", "::before"), space: seen(".space.news", "::after")};""", name, there)
    check("a closed folder shows that a tab in it has news, also once the tab has unloaded", r.get("heads") == [name + "kept"] and r["rested"] and shows(r["head"], r["accent"]), str(r))
    check("an essential's tile shows it", len(r["tiles"]) == 1 and r["tiles"][0].startswith("tile") and shows(r["tile"], r["accent"]), str(r))
    check("another space's dot shows it, in that space's colour", r["spaces"] == [there] and shows(r["space"], r["other"]), str(r))

    # Selecting clears each, by real clicks in the sidebar.
    r = sidebar_page(m, marked + """
      const out = {};
      named("row").click();
      out.row = await until(h => !h.rows.length);
      named("tile").click();
      out.tile = await until(h => !h.tiles.length);
      const head = [...doc.querySelectorAll(".folder .head")].find(h => h.title === args[0] + "kept");
      head.click();
      await when(() => !head.parentElement.classList.contains("collapsed"));
      out.open = await until(h => h.rows.length);  // an open folder's head has no dot: its row has it
      named("folder").click();
      out.folder = await until(h => !h.rows.length);
      bar(args[2]).click();
      out.inThere = await until(h => !h.spaces.length && h.rows.length);  // in the space itself, its list shows it, not the bar
      named("there").click();
      out.there = await until(h => !h.rows.length);
      bar(args[1]).click();
      await inSpace(args[1]);
      out.back = has();
      return out;""", name, here, there)
    empty = {"rows": [], "heads": [], "tiles": [], "spaces": []}
    check("selecting the row clears its dot", not r["row"]["rows"], str(r))
    check("selecting the essential clears its tile's dot", not r["tile"]["tiles"], str(r))
    check("an open folder shows the dot on its row, not on its head", not r["open"]["heads"] and r["open"]["rows"] == ["folder (1) unread"], str(r))
    check("selecting the tab clears its folder's dot", r["folder"] == {**empty, "spaces": [there]}, str(r))
    check("in the space itself its list shows the news, and the bar does not", r["inThere"]["rows"] == ["there (1) unread"] and not r["inThere"]["spaces"], str(r))
    check("selecting the tab clears the space's dot, and nothing is left", r["there"] == empty and r["back"] == empty, str(r))

    # The same tab in another window, where it is a placeholder.
    far = page("far")
    r = m.js(H + """const [address, here] = args, a = main(); a.focus();
      const t = a.gBrowser.addTrustedTab(address, {userContextId: here, inBackground: true});
      for (let i = 0; i < 100 && role(a, t) !== "live"; i++) await wait(100);
      const k = key(a, t), w = a.OpenBrowserWindow(); w.__extra = true; w.__news = true;
      const copy = () => w.gBrowser?.tabs.find(x => key(w, x) === k);
      for (let i = 0; i < 100 && !copy(); i++) await wait(100);
      a.focus(); await wait(500);
      return {copy: role(w, copy()), id: w.docShell.outerWindowID};""", far, number(here))
    check("another window has a placeholder of the page", r["copy"] == "ghost", str(r))
    second = r["id"]
    in_use = H + """const w = wins().find(x => x.__news); w.focus(); await wait(500); return 1;"""
    # Firefox's own audible state, set from chrome code as a page playing sound sets it.
    sound = H + """const [address, on] = args, w = main(), t = w.gBrowser.tabs.find(x => url(x) === address);
      t.toggleAttribute("soundplaying", on); w.gBrowser._tabAttrModified(t, ["soundplaying"]); return 1;"""
    time.sleep(6)  # past the quiet, for both pages
    m.js(sound, page("row"), True)
    set_title(m, page("row"), f"{name}row (1) ding")
    set_title(m, far, f"{name}far (1) unread")
    r = sidebar_page(m, marked + """
      const got = await until(h => h.rows.length === 2);
      return {got, elsewhere: inView(await viewOf(args[1]), "far")};""", name, second)
    check("a sound that has only just begun does not stop the dot", "row (1) ding" in r["got"]["rows"], str(r))
    check("in the other window the placeholder has the dot too", r["elsewhere"]["news"] and not r["elsewhere"]["loaded"], str(r))
    # Selecting the placeholder there is seeing it: the page comes to that window, and nothing is left.
    r = m.js(H + """const [address] = args, a = main(), w = wins().find(x => x.__news), page = () => a.gBrowser.tabs.find(x => url(x) === address);
      const k = key(a, page());
      w.focus(); await wait(500);
      w.gBrowser.selectedTab = w.gBrowser.tabs.find(x => key(w, x) === k);
      const here = () => a.gBrowser.tabs.filter(x => key(a, x) === k).map(x => role(a, x));
      for (let i = 0; i < 100 && !(url(w.gBrowser.selectedTab) === address && here().length); i++) await wait(100);
      return {pulled: url(w.gBrowser.selectedTab) === address, here: here()};""", far)
    check("selecting the placeholder brings the page to that window", r["pulled"] and r["here"] == ["ghost"], str(r))
    r = sidebar_page(m, marked + """
      const first = await until(h => h.rows.length === 1);
      named("row").click();
      const all = await until(h => !h.rows.length);
      const elsewhere = inView(await viewOf(args[1]), "far");
      named("folder").click();  // leave the page that plays, so that it is a page in the background
      await when(() => named("folder").classList.contains("active"));
      return {first, all, elsewhere};""", name, second)
    check("selecting the placeholder clears the dot in both windows", r["first"]["rows"] == ["row (1) ding"] and not r["elsewhere"]["news"], str(r))
    check("selecting the row clears the other dot", not r["all"]["rows"], str(r))
    # In the window you are using, the selected tab is what you are looking at. A song that goes on is no news.
    m.js(in_use)
    time.sleep(6)
    set_title(m, far, f"{name}far as you read it")
    set_title(m, page("row"), f"{name}row (2) the next song")
    r = sidebar_page(m, marked + """
      await when(() => named("far").title.includes("as you read it") && named("row").title.includes("next song"));
      return {titles: [named("far").title, named("row").title], has: has()};""", name)
    check("no dot on what you are looking at in the other window", "far" not in str(r["has"]["rows"]) and "as you read it" in r["titles"][0], str(r))
    check("no dot on a page that has been playing for a while", "row" not in str(r["has"]["rows"]) and "next song" in r["titles"][1], str(r))
    m.js(sound, page("row"), False)
    # Selected there, but with you here: it is not seen, and going there is.
    time.sleep(6)
    set_title(m, far, f"{name}far (2) unread")
    r = sidebar_page(m, marked + """
      const got = await until(h => h.rows.length);
      return {got, elsewhere: inView(await viewOf(args[1]), "far")};""", name, second)
    check("a tab selected in a window you are not using gets a dot", r["got"]["rows"] == ["far (2) unread"] and r["elsewhere"]["news"] and r["elsewhere"]["active"], str(r))
    m.js(in_use)
    stats = extension_message(m, {"type": "stats"})
    check("going to that window clears it", stats["sizes"]["newsMarks"] == 0, str(stats["sizes"]))
    # Closing that window with a dot on its page: the page is gone, and with it the dot.
    time.sleep(6)
    set_title(m, far, f"{name}far (3) unread")
    r = sidebar_page(m, marked + "return await until(h => h.rows.length);", name)
    check("and a new message gives it a dot again", r["rows"] == ["far (3) unread"], str(r))
    m.js(H + """await close(wins().find(x => x.__news)); return 1;""")
    r = sidebar_page(m, marked + """
      const got = await until(h => !h.rows.length), far = named("far");
      if (far) send({type: "close", tabId: Number(far.dataset.tab)});
      await when(() => !named("far"));
      return {got, far: !!far, unloaded: far?.classList.contains("unloaded")};""", name)
    check("closing the window with the page clears the dot, and the placeholder stays", not r["got"]["rows"] and r["far"] and r["unloaded"], str(r))

    # What was opened goes again; nothing stays behind in memory.
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(800); return 1;""", folder_key)
    m.js(H + """const w = main();
      for (const t of w.gBrowser.tabs.filter(t => t.pinned && url(t).includes(args[0]))) w.gBrowser.unpinTab(t);
      await wait(3000);
      await removeWhere((x, t) => url(t).includes(args[0]));
      return 1;""", name)
    stats = extension_message(m, {"type": "stats"})
    check("no mark stays once its pages are gone, and nothing is kept of them", stats["sizes"]["newsMarks"] == 0 and stats["sizes"]["newsSeen"] <= remembered, f"{remembered} -> {stats['sizes']}")


def alone_touches(m):
    # What nobody has to know about: tooltips, kept icons, warming a tab up, the sign of a slow load.
    space = int(sidebar_page(m, """return spaces().find(s => s.active).id;""").split("-")[-1])
    opened = m.js(H + """const a = main();
      let w = other(), opened = !w;
      if (opened) { w = a.OpenBrowserWindow(); w.__smoke = true; for (let i = 0; i < 100 && !w.gBrowser?.tabs.some(t => t.pinned); i++) await wait(100); await wait(1000); }
      // In the other window, so that this window has only its placeholder.
      w.gBrowser.addTrustedTab(args[0] + "/icon?elsewhere=secret", {userContextId: args[1], inBackground: true});
      await wait(300);
      a.gBrowser.addTrustedTab(args[0] + "/icon?warm", {userContextId: args[1], inBackground: true});
      a.gBrowser.addTrustedTab(args[0] + "/icon?record", {userContextId: args[1], inBackground: true});
      a.gBrowser.addTrustedTab(args[0] + "/icon?cross", {userContextId: args[1], inBackground: true});
      a.gBrowser.addTrustedTab(args[0] + "/slow-icon", {userContextId: args[1], inBackground: true});
      // A loaded essential: the sign and the warm-up are for a tile as well.
      a.gBrowser.pinTab(a.gBrowser.addTrustedTab(args[0] + "/icon?tile", {userContextId: args[1], inBackground: true}));
      await wait(1000);
      // Sees what the extension's call reaches, also what it should not.
      a.__warmed = [];
      const warmup = a.__warmup = a.gBrowser.warmupTab;
      a.gBrowser.warmupTab = function (t) { a.__warmed.push(url(t)); return warmup.call(this, t); };
      // The sidebar page in front: timers in a page behind other tabs run late, and a pointer does not reach it.
      a.__selected = a.gBrowser.selectedTab;
      a.gBrowser.selectedTab = a.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html"));
      await wait(500);
      return opened;""", m.pages, space)
    until = """const until = async (test, ms = 15000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(20)) { const v = await test(); if (v) return v; } return null; };
      const here = await page.browser.windows.getCurrent();
      // The row of the tab in this window whose address holds `part`.
      const rowOf = async part => { const t = (await page.browser.tabs.query({windowId: here.id})).find(x => x.url.includes(part));
        return t && doc.querySelector(`#tabs .tab[data-tab="${t.id}"]`); };
      const status = async id => (await page.browser.tabs.get(id)).status;"""
    r = sidebar_page(m, until + """
      const pages = arguments[0], ctx = arguments[1], icon = "img[src^='data:image/svg']", out = {};

      // Tooltips: a placeholder knows its real address only from the record.
      const ghost = await until(() => doc.querySelector("#tabs .tab.unloaded[title*='/icon']"));
      out.ghostTip = ghost?.title;
      out.ghostId = Number(ghost?.dataset.tab);
      out.tileTip = doc.querySelector("#essentials .tile")?.title;

      // Where to take the pointer, below.
      const warm = await until(() => rowOf("/icon?warm"));
      const at = e => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
      out.warmId = Number(warm.dataset.tab);
      const tile = await until(async () => { const t = (await page.browser.tabs.query({windowId: here.id, pinned: true})).find(x => x.url.includes("/icon?tile"));
        const e = t && doc.querySelector(`#essentials .tile[data-tab="${t.id}"]`); return e?.querySelector(icon) && !e.matches(".unloaded") && e; });

      out.tileId = Number(tile?.dataset.tab);
      // The record's icon: a page without one keeps what the tab had, rather than a letter.
      const record = await until(async () => { const r = await rowOf("/icon?record"); return r?.querySelector(icon) && r; });
      if (record) {
        const id = Number(record.dataset.tab);
        await page.browser.tabs.update(id, {url: pages + "/no-icon"});
        await until(async () => record.querySelector(".title")?.textContent === "No icon" && await status(id) === "complete");
        await wait(500);
        out.record = {own: (await page.browser.tabs.get(id)).favIconUrl ?? null, image: !!record.querySelector(icon), letter: !!record.querySelector(".letter")};
      }

      // A page changing its address and nothing else, as some do as you scroll: the tooltip
      // follows, and the row is not drawn again, which could lose a click or a drag under way.
      const parts = () => [...warm.children];
      const before = parts();
      await page.browser.tabs.update(out.warmId, {url: pages + "/icon?warm#further"});
      await until(() => warm.title.endsWith("/icon#further"), 5000);
      out.addressOnly = {tip: warm.title, same: parts().every((e, i) => e === before[i])};

      // On another site the record's icon is the old site's, which says something untrue.
      const cross = await until(async () => { const r = await rowOf("/icon?cross"); return r?.querySelector(icon) && r; });
      if (cross) {
        await page.browser.tabs.update(Number(cross.dataset.tab), {url: arguments[2] + "/no-icon"});
        await until(() => cross.querySelector(".letter"), 5000);
        out.cross = {image: !!cross.querySelector(icon), letter: !!cross.querySelector(".letter"), tip: cross.title};
      }

      // A slow load: nothing at first, then a sign on the icon, then nothing, all on the same element.
      const slow = await until(async () => { const r = await rowOf("/slow-icon"); return r?.querySelector(icon) && r; });
      if (!slow) return out;
      const slowId = out.slowId = Number(slow.dataset.tab);
      const finished = async () => { await until(async () => await status(slowId) === "complete"); await wait(300); };
      await finished();
      const img = slow.querySelector("img"), signed = () => slow.querySelector("img, .letter").classList.contains("slow-load");
      out.quietBefore = !signed();
      const t0 = Date.now();
      await page.browser.tabs.reload(slowId);
      await until(signed, 6000); // the load ends no sooner than this waits: it starts late too on a busy machine
      out.shownAfter = Date.now() - t0;
      out.shown = signed();
      const moving = slow.querySelector(".slow-load")?.getAnimations()[0];
      out.animation = moving && {state: moving.playState, name: moving.animationName, iterations: moving.effect.getComputedTiming().iterations};
      // A page that takes longer than the breathing lasts: moved to the end of it, not waited for.
      moving?.finish();
      out.settled = {state: moving?.playState, opacity: page.getComputedStyle(img).opacity, stillSigned: signed()};
      // Seen in the moment the sign goes: on a busy machine the fade may be over by the first look below.
      const fading = new Promise(done => { const o = new page.MutationObserver(() => { if (!signed()) { o.disconnect(); done(img.getAnimations().map(x => x.effect.getTiming().duration)); } }); o.observe(img, {attributes: true}); });
      await until(() => !signed(), 6000);
      out.gone = !signed();
      out.fading = await Promise.race([fading, wait(1000)]);
      out.brightening = [];
      for (let i = 0; i < 25; i++) { out.brightening.push(Number(page.getComputedStyle(img).opacity)); await wait(20); }
      await finished();
      out.sameIcon = slow.querySelector("img") === img && img.isConnected;

      // A title arriving during a load draws the row again: the sign goes on from where it was.
      const drip = (await page.browser.tabs.create({windowId: here.id, url: pages + "/drip", cookieStoreId: "firefox-container-" + ctx, active: false})).id;
      const dripping = () => doc.querySelector(`#tabs .tab[data-tab="${drip}"]`);
      const first = await until(() => dripping()?.querySelector(".slow-load"), 6000);
      const started = first?.getAnimations()[0]?.startTime;
      await until(() => dripping()?.querySelector(".title").textContent === "Dripped", 6000);
      const second = dripping()?.querySelector(".slow-load");
      out.redrawn = {icon: !!first && !!second && second !== first, sameStart: second?.getAnimations()[0]?.startTime === started};
      await until(() => !dripping()?.querySelector(".slow-load"), 5000);
      out.dripEnded = !dripping()?.querySelector(".slow-load");

      // The same on a tile.
      if (tile) {
        await page.browser.tabs.update(Number(tile.dataset.tab), {url: pages + "/slow-icon?tile"});
        out.tileSign = !!(await until(() => tile.querySelector(".slow-load"), 6000));
        out.tileEnded = !!(await until(() => !tile.querySelector(".slow-load"), 6000));
      }
      return out;""", m.pages, space, m.pages.replace("127.0.0.1", "localhost"))
    check("a placeholder's tooltip shows its title and real address, without the query part", r.get("ghostTip") == f"Touched\n{m.pages}/icon", str(r))
    check("an essential's tooltip shows its address, without the query part", "\nhttps://example.org/" in (r.get("tileTip") or "") and "?" not in r["tileTip"], str(r))
    check("a page with no icon keeps the one in the record, not a letter", r.get("record") == {"own": None, "image": True, "letter": False}, str(r))
    check("an address changing alone changes the tooltip and draws nothing again", (r.get("addressOnly") or {}).get("same") is True and r["addressOnly"]["tip"].endswith("/icon#further"), str(r))
    check("a page on another site with no icon has a letter, not the old site's icon, and the new address", (r.get("cross") or {}).get("letter") is True and r["cross"]["image"] is False and r["cross"]["tip"].endswith("localhost:" + m.pages.rsplit(":", 1)[1] + "/no-icon"), str(r))
    check("a slow load shows nothing at first, and on the icon after half a second", r.get("quietBefore") is True and r.get("shown") is True and r.get("shownAfter", 0) >= 500, str(r))
    a = r.get("animation") or {}
    check("the sign breathes, and comes to rest by itself", a.get("name") == "slow-load" and a.get("state") == "running" and 0 < (a.get("iterations") or 0) < 100, str(r))
    fade = r.get("brightening") or [0]
    check("a page that never finishes leaves the sign still and dimmed, with nothing running", r.get("settled") == {"state": "finished", "opacity": "0.45", "stillSigned": True}, str(r))
    check("the sign goes softly when the page is there", r.get("gone") is True and r.get("fading") == [300] and fade == sorted(fade) and fade[-1] == 1, str(r))
    check("a load does not replace the icon", r.get("sameIcon") is True, str(r))
    check("a row drawn again during a load keeps its sign where it was", r.get("redrawn") == {"icon": True, "sameStart": True} and r.get("dripEnded") is True, str(r))
    check("a tile shows the sign too, and it goes", r.get("tileSign") is True and r.get("tileEnded") is True, str(r))

    # A real pointer. On the same row twice, then away and back each time: to a placeholder,
    # to the tab that is showing, and to nothing. Then to a tile, loaded and not.
    # An essential unloaded, as in every window but the one it was used in. Only now: looking
    # through the tabs to find the sidebar page, as sidebar_page does, makes Firefox load it again.
    sidebar_page(m, until + """
      const home = doc.querySelector("#essentials .tile");
      await page.browser.tabs.discard(Number(home.dataset.tab));
      await until(() => home.matches(".unloaded"));""")
    # A long list has rows below the window, out of reach of a pointer: for this moment the others make way.
    p = sidebar_page(m, until + """
      const rowBy = id => doc.querySelector(`#tabs .tab[data-tab="${id}"]`), warm = rowBy(arguments[0]), ghost = rowBy(arguments[1]), showing = doc.querySelector("#tabs .tab.active, #essentials .tile.active");
      const tile = doc.querySelector(`#essentials .tile[data-tab="${arguments[2]}"]`);
      for (const e of doc.querySelectorAll("#tabs > *")) if (![warm, ghost, showing].some(x => e === x || e.contains(x))) e.style.display = "none";
      doc.getElementById("tabs").scrollTop = 0;
      await wait(100);
      const at = e => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, box = warm.getBoundingClientRect();
      return {title: at(warm.querySelector(".title")), close: [box.right - 18, box.top + box.height / 2], ghost: at(ghost), showing: at(showing), nothing: at(doc.getElementById("space-name")), tile: at(tile), ghostTile: at(doc.querySelector("#essentials .tile"))};""", r.get("warmId"), r.get("ghostId"), r.get("tileId"))
    check("the rows for the pointer are there", "title" in p, str(p))
    pointer_over(m, p["title"], p["close"], p["ghost"], p["title"], p["showing"], p["close"], p["nothing"], p["title"], p["ghostTile"], p["tile"], p["tile"])
    sidebar_page(m, """for (const e of doc.querySelectorAll("#tabs > *")) e.style.display = ""; return 1;""")
    warmed = m.js(H + "for (let i = 0; i < 40 && main().__warmed.length < 5; i++) await wait(50); await wait(200); return main().__warmed;")
    check("a tab is warmed once for each time the pointer comes to it, and only a loaded one", len(warmed) == 5 and all("/icon?warm" in u for u in warmed[:4]) and "?tile" in warmed[4], str(warmed))

    # The sidebar panel itself, as in use: the page above is the same page, opened in a tab, since
    # a test can take a real pointer only there. Here a pointer's event is sent to a row instead.
    r2 = sidebar_page(m, until + """
      const panel = page.browser.extension.getViews({type: "sidebar", windowId: here.id})[0];
      if (!panel) return {panel: false};
      const rowThere = id => panel.document.querySelector(`#tabs .tab[data-tab="${id}"]`), slow = rowThere(arguments[0]);
      const out = {panel: true, tip: slow?.title};
      rowThere(arguments[1])?.dispatchEvent(new panel.MouseEvent("mouseover", {bubbles: true}));
      await page.browser.tabs.reload(arguments[0]);
      out.sign = !!(await until(() => slow.querySelector(".slow-load"), 6000));
      out.ended = !!(await until(() => !slow.querySelector(".slow-load"), 6000));
      return out;""", r.get("slowId"), r.get("warmId"))
    warmed_there = m.js(H + "for (let i = 0; i < 40 && main().__warmed.length < 6; i++) await wait(50); return main().__warmed;")
    check("in the sidebar panel itself, the tooltip, the sign and the warm-up are the same",
          r2.get("panel") is True and "/slow-icon" in (r2.get("tip") or "") and r2.get("sign") is True and r2.get("ended") is True and len(warmed_there) == 6 and "/icon?warm" in warmed_there[5], f"{r2} {warmed_there}")

    # Asked for less motion: the sign is a still dim, and what moved in the sidebar stands still.
    m.js('Services.prefs.setIntPref("ui.prefersReducedMotion", 1); return 1;')
    r = sidebar_page(m, until + """
      const slowId = arguments[0], row = doc.querySelector(`#tabs .tab[data-tab="${slowId}"]`);
      await until(() => page.getComputedStyle(doc.documentElement).transitionDuration === "0s", 2000);
      await page.browser.tabs.reload(slowId);
      const icon = await until(() => row.querySelector(".slow-load"), 6000);
      const style = icon && page.getComputedStyle(icon);
      const out = {name: style?.animationName, opacity: style?.opacity, moving: icon?.getAnimations().length, window: page.getComputedStyle(doc.documentElement).transitionDuration};
      // The setting off has a sidebar too, which stays as it was.
      doc.documentElement.classList.remove("alone");
      out.withoutAlone = page.getComputedStyle(doc.documentElement).transitionDuration;
      doc.documentElement.classList.add("alone");
      await until(async () => await status(slowId) === "complete");
      await wait(300);
      out.after = row.querySelector("img").getAnimations().length;
      return out;""", r.get("slowId"))
    m.js(H + """Services.prefs.clearUserPref("ui.prefersReducedMotion");
      const a = main();
      a.gBrowser.selectedTab = a.__selected;
      // Unpinned first: a closed essential comes back.
      a.gBrowser.tabs.filter(t => t.pinned && url(t).includes("?tile")).forEach(t => a.gBrowser.unpinTab(t));
      await wait(1500);
      await removeWhere((w, t) => url(t).startsWith(args[0]) || url(t).startsWith(args[2]));
      a.gBrowser.warmupTab = a.__warmup;
      if (args[1]) { other()?.close(); await wait(2500); }
      return 1;""", m.pages, opened, m.pages.replace("127.0.0.1", "localhost"))
    check("with less motion asked for, a slow load is a still dim", r.get("name") == "none" and r.get("moving") == 0 and r.get("opacity") == "0.55" and r.get("after") == 0, str(r))
    check("with less motion asked for, nothing in the sidebar moves", r.get("window") == "0s", str(r))
    check("with the setting off, what is in the sidebar's style stays as it was", r.get("withoutAlone") == "0.25s", str(r))
    no_problems(m, "after the small touches")


# --- Isolation: nothing goes out in the wrong container ------------------------------
# The check that matters most. The server records each request and its Cookie header, so
# this is what really left the browser, not what Tidier thinks it did.
GIVE_PERMISSIONS = """const [id, permissions, origins] = args;
  const {ExtensionPermissions} = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
  await ExtensionPermissions.add(id, {permissions, origins}, WebExtensionPolicy.getByID(id).extension);
  await new Promise(r => ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(r, 800));
  return 1;"""

ISOLATION_JS = H + """
  const system = Services.scriptSecurityManager.getSystemPrincipal();
  const typed = (t, u) => t.linkedBrowser.loadURI(Services.io.newURI(u), {triggeringPrincipal: system});  // no page asked: as the address bar
  const until = async (f, ms = 8000) => { for (let i = 0; i < ms / 100 && !f(); i++) await wait(100); return f(); };
  const inTab = (ctx, u) => main().gBrowser.addTrustedTab(u, {userContextId: ctx, inBackground: true});
  const containersOf = part => wins().flatMap(w => w.gBrowser.tabs.filter(t => url(t).includes(part)).map(t => t.userContextId));
  const closeAll = async part => { for (const w of wins()) for (const t of [...w.gBrowser.tabs]) if (url(t).includes(part) || String(t.label).includes(part)) w.gBrowser.removeTab(t, {skipPermitUnload: true}); await wait(2500); };
"""


def seen(m, part):
    return [r for r in m.page_requests if part in r["path"]]


def visit(m, ctx, address, wait_for=None):
    """Open `address` in container `ctx`, and wait for it to have loaded."""
    m.js(ISOLATION_JS + """const [ctx, u] = args; const t = inTab(ctx, u); await until(() => url(t) === u, 8000); await wait(300); return 1;""", ctx, address)


def alone_isolation(m):
    base = m.pages
    # Tidier alone stays on one space while this runs; the tabs made here are hidden or not, but they load either way.
    press(m, "1", CTRL)
    time.sleep(1)
    space = m.js(H + "return main().gBrowser.selectedTab.userContextId;")
    other = 2 if space != 2 else 3
    visit(m, space, f"{base}/set-cookie?v=here")
    visit(m, other, f"{base}/set-cookie?v=there")
    here, there = "login=here", "login=there"
    m.js("""const [id] = args; const {ExtensionPermissions} = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      await ExtensionPermissions.remove(id, {permissions: ["webRequest", "webRequestBlocking"], origins: ["<all_urls>"]}, WebExtensionPolicy.getByID(id).extension);
      await new Promise(r => ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(r, 800)); return 1;""", EXT_ID)
    visit(m, space, f"{base}/r/baseline-here")
    check("a cookie set in a space is sent there", [r["cookie"] for r in seen(m, "baseline-here")] == [here], str(seen(m, "baseline-here")))
    visit(m, other, f"{base}/r/baseline-there")
    check("and that space's cookie in another", [r["cookie"] for r in seen(m, "baseline-there")] == [there], str(seen(m, "baseline-there")))

    r = sidebar_page(m, """await wait(300); return {line: !doc.querySelector(".ask-line").hidden, words: doc.querySelector(".ask-line button").textContent};""")
    check("without the permission, one line in the sidebar asks for it", r["line"] and "wrong space" in r["words"], str(r))
    r = ext_page(m, "/settings/settings.html", """await wait(800); return !doc.getElementById("allow-isolation").hidden;""")
    check("and the settings page can ask for it", r is True, str(r))

    # Without the permission: this is what the permission is for, and shows the checks below can fail.
    r = m.js(ISOLATION_JS + """main().gBrowser.addTrustedTab(args[0], {inBackground: true}); await until(() => containersOf("old-path").some(c => c), 8000); await wait(500); return containersOf("old-path");""", f"{base}/r/old-path")
    check("without the permission, a link's first request goes out with no login, and the tab then lands in the space", any(not x["cookie"] for x in seen(m, "old-path")) and r and all(r), f"{r} {seen(m, 'old-path')}")

    m.js(GIVE_PERMISSIONS, EXT_ID, ["webRequest", "webRequestBlocking"], ["<all_urls>"])
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "rule-there", "space": f"firefox-container-{other}"}]})
    r = sidebar_page(m, """await wait(500); return doc.querySelector(".ask-line").hidden;""")
    check("given, the line is gone", r is True, str(r))

    def only(part, cookie, what):
        got = seen(m, part)
        check(what, len(got) >= 1 and all(x["cookie"] == cookie for x in got), f"{part}: {got}")

    # A rule, from a tab in another space, the way you type an address.
    r = m.js(ISOLATION_JS + """const t = inTab(args[1], "about:blank"); await wait(400); typed(t, args[0]); await until(() => containersOf("rule-there-typed").length, 8000); await wait(500); return containersOf("rule-there-typed");""", f"{base}/r/rule-there-typed", space)
    only("rule-there-typed", there, "by a rule: the server saw only the rule's space's cookie, from the first request on")
    check("by a rule: the tab is in the rule's space, once", r == [other], str(r))

    # A link from another app, with no container.
    r = m.js(ISOLATION_JS + """main().gBrowser.addTrustedTab(args[0], {inBackground: true}); await until(() => containersOf("rule-there-link").length, 8000); await wait(500); return containersOf("rule-there-link");""", f"{base}/r/rule-there-link")
    only("rule-there-link", there, "a link with no container, by a rule: the same")
    check("a link with no container, by a rule: it is in the rule's space, once", r == [other], str(r))
    r = m.js(ISOLATION_JS + """main().gBrowser.addTrustedTab(args[0], {inBackground: true}); await until(() => containersOf("no-rule-link").length, 8000); await wait(500); return containersOf("no-rule-link");""", f"{base}/r/no-rule-link")
    only("no-rule-link", here, "a link with no container: every request carries the active space's cookie, never none")
    check("a link with no container: it is in the active space, once", r == [space], str(r))

    # A new tab: ⌘T, then an address.
    r = m.js(ISOLATION_JS + """const w = main(); const t = w.gBrowser.addTrustedTab("about:newtab"); w.gBrowser.selectedTab = t; await wait(1500);
      const s = w.gBrowser.selectedTab, ctx = s.userContextId; typed(s, args[0]); await until(() => containersOf("new-tab-typed").length, 8000); await wait(500); return {ctx, got: containersOf("new-tab-typed")};""", f"{base}/r/new-tab-typed")
    only("new-tab-typed", here, "a new tab, then an address: the same")
    check("a new tab is in the active space", r["ctx"] == space and r["got"] == [space], str(r))

    # What does not count: a link followed inside a page, and a redirect under way.
    # (Encoded: the rule is text to find in the address, and must not match the page before it.)
    link = f"{base}/go?to={base}/r/rule%2Dthere-by-link"
    r = m.js(ISOLATION_JS + """const t = inTab(args[2], args[1]); await until(() => url(t) === args[1], 8000); await wait(300); typed(t, args[0]);
      await until(() => containersOf("rule-there-by-link").length, 8000); await wait(500); return containersOf("rule-there-by-link");""", link, f"{base}/r/start-a", space)
    only("rule-there-by-link", here, "a link followed inside a page stays in the space, with its cookie")
    check("a link followed inside a page does not move the tab", r == [space], str(r))
    hop = f"{base}/redirect?to={base}/r/rule%2Dthere-by-redirect"
    r = m.js(ISOLATION_JS + """const t = inTab(args[2], args[1]); await until(() => url(t) === args[1], 8000); await wait(300); typed(t, args[0]);
      await until(() => containersOf("rule-there-by-redirect").length, 8000); await wait(800); return containersOf("rule-there-by-redirect");""", hop, f"{base}/r/start-b", space)
    only("rule-there-by-redirect", here, "a redirect under way stays in the space, with its cookie")
    check("a redirect under way does not move the tab", r == [space], str(r))

    # What a page can read.
    r = m.js(ISOLATION_JS + """const [u, a, b] = args; const one = inTab(a, u), two = inTab(b, u); await until(() => /cookie=/.test(one.label) && /cookie=/.test(two.label), 8000);
      return [one.label, two.label];""", f"{base}/see-cookie", space, other)
    check("what a page can read of its cookies is its own space's", r == ["cookie=login=here", "cookie=login=there"], str(r))
    extension_message(m, {"type": "settings:rules", "rules": []})

    # A space's user agent and proxy.
    third = next(c for c in (1, 2, 3) if c not in (space, other))
    more = """
      const id = args[0], card = () => doc.querySelector(`#spaces .space-card[data-space="${id}"]`);
      await wait(800);
      if (!card().querySelector(".space-more")) { card().querySelector(".more").click(); await wait(400); }
      const set = (el, value) => { el.value = value; el.dispatchEvent(new page.Event("input", {bubbles: true})); };
      // Saved, or refused: the page says which, in a line that is new each time.
      const saved = async () => { const old = card().querySelector(".fact"); card().querySelector(".save").click();
        for (let i = 0; i < 80 && card().querySelector(".fact") === old; i++) await wait(100); await wait(100); return card().querySelector(".fact")?.textContent; };
    """
    r = ext_page(m, "/settings/settings.html", more + """
      const out = {saveHidden: card().querySelector(".save").hidden, hostHidden: card().querySelector(".host").hidden};
      set(card().querySelector("select"), "http");
      out.hostShown = !card().querySelector(".host").hidden;
      set(card().querySelector(".host"), "127.0.0.1");
      set(card().querySelector(".port"), "3128");
      out.refused = await saved();
      return out;""", f"firefox-container-{third}")
    check("a space's More has a proxy, with Save only once something changed", r.get("saveHidden") is True and r.get("hostHidden") is True and r.get("hostShown") is True, str(r))
    check("without the permission for a proxy it says so, and nothing changes", "did not give" in (r.get("refused") or ""), str(r))
    m.js(GIVE_PERMISSIONS, EXT_ID, ["proxy"], ["<all_urls>"])
    r = ext_page(m, "/settings/settings.html", more + """
      const out = {};
      set(card().querySelector("select"), "http");
      out.incomplete = await saved();
      set(card().querySelector("select"), "");
      set(card().querySelector("input[placeholder*=own]"), "Smoke agent");
      out.saved = await saved();
      out.kept = card().querySelector("input[placeholder*=own]").value;
      card().querySelector(".more").click();
      return out;""", f"firefox-container-{third}")
    check("a proxy that is not complete is said, and not used", "not complete" in (r.get("incomplete") or ""), str(r))
    check("a user agent set in a space's More is kept", r.get("saved") == "Saved." and r.get("kept") == "Smoke agent", str(r))
    time.sleep(1)
    visit(m, third, f"{base}/r/agent-own")
    visit(m, space, f"{base}/r/agent-other")
    own, others = seen(m, "agent-own"), seen(m, "agent-other")
    check("a space's user agent reaches the server", [x["agent"] for x in own] == ["Smoke agent"], str(own))
    check("other spaces' requests are untouched", others and "Smoke agent" not in others[0]["agent"] and "Firefox" in others[0]["agent"], str(others))
    server_port = base.rsplit(":", 1)[1]
    r = extension_message(m, {"type": "isolation:network", "id": f"firefox-container-{third}", "proxy": {"type": "http", "host": "127.0.0.1", "port": server_port}})
    check("a proxy is taken as given", r and r.get("proxy", {}).get("port") == int(server_port), str(r))
    time.sleep(1)
    m.js(ISOLATION_JS + """inTab(args[0], "http://proxied.invalid/r/through-proxy"); inTab(args[1], "http://proxied.invalid/r/past-proxy"); await wait(3000); return 1;""", third, space)
    got = seen(m, "through-proxy")
    check("a space's proxy carries its requests", got and all(x["proxied"] for x in got), str(got))
    check("other spaces' requests do not go through it", not seen(m, "past-proxy"), str(seen(m, "past-proxy")))
    # A proxy that does not answer (README says so, and this shows if Firefox changes it).
    # The test's own server is on this machine, which Firefox otherwise never sends through
    # a proxy: that is what the setting is for.
    extension_message(m, {"type": "isolation:network", "id": f"firefox-container-{third}", "proxy": {"type": "http", "host": "127.0.0.1", "port": 1}})
    time.sleep(1)
    direct = m.js(ISOLATION_JS + """Services.prefs.setBoolPref("network.proxy.allow_hijacking_localhost", true); inTab(args[0], args[1]); await wait(5000);
      Services.prefs.clearUserPref("network.proxy.allow_hijacking_localhost"); return Services.prefs.getBoolPref("network.proxy.failover_direct", null);""", third, f"{base}/r/dead-proxy")
    check("a proxy that does not answer means no page, not going directly", not seen(m, "dead-proxy"), f"failover_direct: {direct}, {seen(m, 'dead-proxy')}")
    r = extension_message(m, {"type": "isolation:network", "id": f"firefox-container-{third}"})
    time.sleep(1)
    visit(m, third, f"{base}/r/agent-unset")
    check("unset again, a space's requests are as they were", "Smoke agent" not in seen(m, "agent-unset")[0]["agent"] and r == {}, str(r))

    # Signing out: one site in one space, and everything in a space.
    # With the tab menu's table, by its item, on the real sidebar; without it, by the message it sends.
    r = sidebar_page(m, """
      await wait(400);
      const row = plainTabs().find(x => x.querySelector(".title").textContent === "Recorded");
      if (!row) return {row: false};
      const box = row.getBoundingClientRect();
      row.dispatchEvent(new page.MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5}));
      await wait(500);
      const menu = doc.getElementById("menu"), items = menu.hidden ? [] : [...menu.querySelectorAll(".item")];
      const labels = items.map(i => i.textContent);
      const item = items.find(i => i.textContent === "Clear this site's cookies in this space");
      if (item) { item.click(); await wait(800); }
      return {row: true, labels, clicked: !!item};""")
    if r.get("labels"):
        check("the tab menu has Clear this site's cookies and Open a copy in space", r.get("clicked") and "Open a copy in space" in r["labels"], str(r))
    else:
        tab = m.js(ISOLATION_JS + """const w = main(), {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const t = w.gBrowser.tabs.find(x => url(x).includes("baseline-here")); return ExtensionParent.apiManager.global.tabTracker.getId(t);""")
        extension_message(m, {"type": "isolation:clearCookies", "tabId": tab, "windowId": None})
    visit(m, space, f"{base}/r/after-clear")
    visit(m, other, f"{base}/r/after-clear-other")
    check("clearing a site's cookies in a space takes them there", [x["cookie"] for x in seen(m, "after-clear") if "other" not in x["path"]] == [""], str(seen(m, "after-clear")))
    check("and leaves another space's alone", [x["cookie"] for x in seen(m, "after-clear-other")] == [there], str(seen(m, "after-clear-other")))
    m.js(GIVE_PERMISSIONS, EXT_ID, ["browsingData"], [])
    visit(m, third, f"{base}/set-cookie?v=third")
    r = ext_page(m, "/settings/settings.html", """
      const id = args[0], card = () => doc.querySelector(`#spaces .space-card[data-space="${id}"]`);
      await wait(800);
      if (!card().querySelector(".space-more")) { card().querySelector(".more").click(); await wait(400); }
      card().querySelector(".sign-out").click();
      await wait(300);
      const out = {question: card().querySelector(".question").textContent};
      card().querySelector(".danger + button").click();
      await wait(300);
      out.kept = !card().querySelector(".question");
      card().querySelector(".sign-out").click();
      await wait(300);
      card().querySelector(".danger").click();
      await wait(1200);
      out.fact = card().querySelector(".fact")?.textContent;
      card().querySelector(".more").click();
      return out;""", f"firefox-container-{other}")
    check("signing out asks first, and Keep keeps", "for good" in r.get("question", "") and r.get("kept") is True, str(r))
    visit(m, other, f"{base}/r/signed-out")
    check("signing out of a space takes its logins", [x["cookie"] for x in seen(m, "signed-out")] == [""] and "Signed out" in (r.get("fact") or ""), f"{r} {seen(m, 'signed-out')}")
    visit(m, third, f"{base}/r/not-signed-out")
    check("and another space's stay", [x["cookie"] for x in seen(m, "not-signed-out")] == ["login=third"], str(seen(m, "not-signed-out")))
    m.js(ISOLATION_JS + """await closeAll("127.0.0.1"); return 1;""")

    # New, edited and deleted, with clicks on the real settings page.
    r = ext_page(m, "/settings/settings.html", """
      await wait(800);
      const cards = () => [...doc.querySelectorAll("#spaces .space-card")];
      const before = cards().length;
      doc.getElementById("new-space").click();
      await wait(1000);
      const card = cards().at(-1), id = card.dataset.space;
      const out = {before, after: cards().length, focus: doc.activeElement === card.querySelector("input"), name: card.querySelector("input").value};
      const name = card.querySelector("input");
      name.value = "Smoke space";
      name.dispatchEvent(new page.Event("change", {bubbles: true}));
      await wait(500);
      const now = () => doc.querySelector(`#spaces .space-card[data-space="${id}"]`);
      now().querySelector(".swatch[data-color=red], .swatch[data-color=orange]").click();
      await wait(600);
      now().querySelector(".icon-choice[data-icon=tree]").click();
      await wait(600);
      const c = await page.browser.contextualIdentities.get(id);
      out.saved = {name: c.name, color: c.color, icon: c.icon};
      out.shown = {swatch: now().querySelector(".swatch.chosen")?.dataset.color, icon: now().querySelector(".icon-choice.chosen")?.dataset.icon};
      out.id = id;
      return out;""")
    check("New space on the settings page makes one, ready to name, with a look of its own", r.get("after") == r.get("before", 0) + 1 and r.get("focus") and r.get("name") == "New space", str(r))
    check("its name, colour and icon are changed there", r["saved"]["name"] == "Smoke space" and r["saved"]["color"] in ("red", "orange") and r["saved"]["icon"] == "tree" and r["shown"] == {"swatch": r["saved"]["color"], "icon": "tree"}, str(r))
    new_id = r["id"]
    r = sidebar_page(m, """
      const dot = doc.querySelector(`#spaces .space[data-space="${args[0]}"]`);
      if (!dot) return {dot: false};
      const color = dot.style.getPropertyValue("--color"), tint0 = getComputedStyle(doc.documentElement).backgroundColor;
      dot.click();
      await wait(1200);
      const tint1 = getComputedStyle(doc.documentElement).backgroundColor;
      return {dot: true, color, tint0, tint1, name: doc.getElementById("space-name").textContent};""", new_id)
    check("the bar has the new space, in its colour, and its name", r.get("dot") and r.get("color") and r.get("name") == "Smoke space", str(r))
    check("the window's tint in the sidebar follows a new space with no line in tidier.css", r.get("tint0") != r.get("tint1"), str(r))
    time.sleep(1)
    number = int(new_id.rsplit("-", 1)[1])
    visit(m, number, f"{base}/set-cookie?v=doomed")
    r = ext_page(m, "/settings/settings.html", """
      const id = args[0], now = () => doc.querySelector(`#spaces .space-card[data-space="${id}"]`);
      now().querySelector(".delete").click();
      await wait(300);
      const question = now().querySelector(".question").textContent;
      now().querySelector(".danger + button").click();
      await wait(300);
      const kept = !!now() && !now().querySelector(".question");
      now().querySelector(".delete").click();
      await wait(300);
      now().querySelector(".danger").click();
      await wait(2500);
      const left = (await page.browser.contextualIdentities.query({})).some(c => c.cookieStoreId === id);
      return {question, kept, left, card: !!now()};""", new_id)
    check("deleting a space asks, naming what goes, and Keep keeps it", "all its logins" in r.get("question", "") and r.get("kept"), str(r))
    check("and then it is gone", r.get("left") is False and r.get("card") is False, str(r))
    r = m.js(H + """return Services.cookies.cookies.filter(c => c.originAttributes.userContextId === args[0]).length;""", number)
    check("and its logins with it", r == 0, str(r))
    press(m, "1", CTRL)
    time.sleep(1.5)
    r = m.js(H + """return {selected: main().gBrowser.selectedTab.userContextId, stray: wins().flatMap(w => w.gBrowser.tabs.filter(t => t.userContextId > 4).map(t => t.userContextId))};""")
    check("you are not left in it, and no tab of it is", r["selected"] == space and not r["stray"], str(r))

    # A copy in another space, and a folder moved to one.
    visit(m, space, f"{base}/r/copy-me")
    visit(m, space, f"{base}/r/in-folder")
    visit(m, space, f"{base}/unsaved")
    time.sleep(2.5)  # registered as tabs of the record
    ids = m.js(ISOLATION_JS + """const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs"), id = t => ExtensionParent.apiManager.global.tabTracker.getId(t);
      const of = part => id(main().gBrowser.tabs.find(x => url(x).includes(part))); return {copy: of("copy-me"), folder: of("in-folder"), unsaved: of("/unsaved")};""")
    copies = extension_message(m, {"type": "isolation:copy", "tabIds": [ids["copy"]], "space": f"firefox-container-{other}", "windowId": None})
    time.sleep(1.5)
    r = m.js(ISOLATION_JS + """return containersOf("copy-me").sort();""")
    check("a copy in another space leaves the original", copies == 1 and r == sorted([space, other]), f"{copies} {r}")
    r = sidebar_page(m, """
      send({type: "newFolder", space: "firefox-container-" + args[0], name: "Going over"});
      await wait(1000);
      send({type: "moveTab", tabId: args[1], folder: [...doc.querySelectorAll("#tabs .folder")].find(f => f.querySelector(".head .title").textContent === "Going over").dataset.key, before: null});
      send({type: "moveTab", tabId: args[2], folder: [...doc.querySelectorAll("#tabs .folder")].find(f => f.querySelector(".head .title").textContent === "Going over").dataset.key, before: null});
      await wait(1500);
      return [...doc.querySelectorAll("#tabs .folder")].find(f => f.querySelector(".head .title").textContent === "Going over").dataset.key;""", space, ids["folder"], ids["unsaved"])
    key = r
    moved = extension_message(m, {"type": "isolation:moveFolder", "key": key, "space": f"firefox-container-{other}", "windowId": None})
    time.sleep(1.5)
    r = m.js(ISOLATION_JS + """const all = (await storage(args[0], ["syncedTabs"])).syncedTabs, folder = args[1];
      const inFolder = Object.entries(all).filter(([k, e]) => e.parentKey === folder);
      return {folder: all[folder].cookieStoreId, inFolder: inFolder.map(([k, e]) => [new URL(e.url).pathname, e.cookieStoreId]), unsaved: containersOf("/unsaved"), ghost: inFolder.map(([k]) => wins().flatMap(w => w.gBrowser.tabs.filter(t => value(w, t, "syncKey") === k).map(t => [t.userContextId, url(t).includes("ghost.html") || !t.linkedPanel])))};""", EXT_ID, key)
    check("a folder moved to another space goes there, its tab with it, unloaded", moved == {"moved": 1, "stayed": 1} and r["folder"] == f"firefox-container-{other}" and [x[1] for x in r["inFolder"]] == [f"firefox-container-{other}"] and r["ghost"][0] and all(x == [other, True] for x in r["ghost"][0]), f"{moved} {r}")
    check("a page holding unsaved input stays, where it was", r["unsaved"] == [space], str(r))
    m.js(ISOLATION_JS + """await closeAll("127.0.0.1"); return 1;""")
    extension_message(m, {"type": "flush"})
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(800); return 1;""", key)

    # New space in the space's menu, where there is one: its name is then ready to change.
    r = sidebar_page(m, """
      const dot = doc.querySelector("#spaces .space"), box = dot.getBoundingClientRect();
      dot.dispatchEvent(new page.MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5}));
      await wait(300);
      const menu = doc.getElementById("menu"), item = menu.hidden ? null : [...menu.querySelectorAll(".item")].find(i => i.textContent === "New space");
      if (!item) return {item: false};
      const before = spaces().map(s => s.id);
      item.click();
      await wait(1500);
      const name = doc.querySelector(".space-box");
      const out = {item: true, made: spaces().map(s => s.id).filter(id => !before.includes(id)), box: name?.value};
      name?.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
      return out;""")
    if r.get("item"):
        check("New space in a space's menu makes one, with its name ready to change", len(r["made"]) == 1 and r.get("box") == "New space", str(r))
        m.js(H + """const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"); c.remove(args[0]); await wait(1000); return 1;""", int(r["made"][0].rsplit("-", 1)[1]))

    # The same from the folder's menu, and a tab dropped on the bar for a new space.
    r = sidebar_page(m, """
      send({type: "newFolder", space: spaces().find(s => s.active).id, name: "By menu"});
      await wait(1000);
      const head = () => [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "By menu");
      const box = head().getBoundingClientRect();
      head().dispatchEvent(new page.MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5}));
      await wait(200);
      const items = [...doc.querySelectorAll("#menu .item")];
      const out = {labels: items.map(i => i.textContent)};
      const item = items.find(i => i.textContent.startsWith("Move to space"));
      item.click();
      await wait(100);
      // A list in place, where the menu can do that.
      const inner = doc.getElementById("menu").hidden ? [] : [...doc.querySelectorAll("#menu .item:not(.back)")];
      if (inner.length) inner[0].click();
      await wait(1500);
      out.left = !head();
      return out;""")
    check("a folder's menu moves it to another space", r.get("left") is True and sum(x.startswith("Move to space") for x in r["labels"]) >= 1, str(r))
    before = m.js(H + """const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"); return c.getPublicIdentities().length;""")
    visit(m, space, f"{base}/r/dropped")
    time.sleep(2.5)
    r = sidebar_page(m, """
      const row = plainTabs().find(x => x.title === "Recorded" || x.querySelector(".title").textContent === "Recorded");
      const spot = doc.querySelector(".new-space");
      const out = {row: !!row, hiddenBefore: spot.hidden};
      if (!row) return out;
      const box = row.getBoundingClientRect(), data = new page.DataTransfer();
      const at = {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 1, dataTransfer: data};
      row.dispatchEvent(new page.DragEvent("dragstart", at));
      out.shownInDrag = !spot.hidden;
      spot.dispatchEvent(new page.DragEvent("dragover", at));
      spot.dispatchEvent(new page.DragEvent("drop", at));
      row.dispatchEvent(new page.DragEvent("dragend", at));
      out.hiddenAfter = spot.hidden;
      await wait(2500);
      return out;""")
    check("while a tab is dragged there is a place on the bar for a new space, and only then", r.get("hiddenBefore") is True and r.get("shownInDrag") is True and r.get("hiddenAfter") is True, str(r))
    r = m.js(ISOLATION_JS + """const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      return {count: c.getPublicIdentities().length, where: containersOf("/r/dropped"), newest: Math.max(...c.getPublicIdentities().map(i => i.userContextId))};""")
    check("a tab dropped there is in a new space of its own, and you stay", r["count"] == before + 1 and r["where"] == [r["newest"]], f"{before} {r}")
    m.js(ISOLATION_JS + """await closeAll("/r/dropped"); const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"); c.remove(args[0]); await wait(1000); return 1;""", r["newest"])

    # A container removed while Tidier runs stays removed; one that vanishes while Tidier is off comes back.
    made = m.js(H + """const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      const one = c.create("Removed by hand", "tree", "red"), two = c.create("Comes back", "cart", "purple"); await wait(1000);
      return [one.userContextId, two.userContextId];""")
    gone_id, back_id = [f"firefox-container-{x}" for x in made]
    sidebar_page(m, """send({type: "newFolder", space: args[0], name: "Mine"}); send({type: "newFolder", space: args[1], name: "Theirs"}); await wait(800); return 1;""", gone_id, back_id)
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "vanished-rule", "space": back_id}]})
    extension_message(m, {"type": "flush"})
    m.js(H + """const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      c.remove(args[0]); await wait(1000); return 1;""", made[0])
    extension_message(m, {"type": "flush"})
    # Firefox's own file lost, seen by a Tidier that was not running to see it.
    r = m.js(H + """const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      const addon = await AddonManager.getAddonByID(args[0]);
      await addon.disable(); await wait(1000);
      c.remove(args[1]); await wait(500);
      await addon.enable(); await wait(8000);
      const names = c.getPublicIdentities().map(i => c.getUserContextLabel(i.userContextId));
      const data = await storage(args[0], ["rules", "syncedTabs"]);
      return {names, rule: data.rules[0], folder: Object.values(data.syncedTabs).filter(e => e.own && (e.name === "Theirs" || e.name === "Mine")).map(e => [e.name, e.cookieStoreId])};""", EXT_ID, made[1])
    check("a container vanished while Tidier was not looking comes back, with its name", "Comes back" in r["names"], str(r))
    check("what pointed at it follows it", r["rule"]["space"] != back_id and r["folder"] == [["Theirs", r["rule"]["space"]]], str(r))
    check("one removed while Tidier ran stays removed", "Removed by hand" not in r["names"], str(r))
    r = ext_page(m, "/settings/settings.html", """await wait(800); return doc.getElementById("notices").textContent;""")
    check("Tidier says so", "Comes back had gone from Firefox" in str(r), str(r))
    extension_message(m, {"type": "settings:rules", "rules": []})
    extension_message(m, {"type": "isolation:seen"})
    m.js(H + """const {ContextualIdentityService: c} = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      for (const i of c.getPublicIdentities()) if (c.getUserContextLabel(i.userContextId) === "Comes back") c.remove(i.userContextId);
      await wait(1000); return 1;""")
    press(m, "1", CTRL)
    time.sleep(1)


def alone_requests(m):
    # Nothing is lost, doubled or held up when a request is stopped: the cases are in
    # tests/isolation-requests.test.mjs, and here Firefox itself asks.
    base = m.pages
    m.js(GIVE_PERMISSIONS, EXT_ID, ["webRequest", "webRequestBlocking"], ["<all_urls>"])
    press(m, "1", CTRL)
    time.sleep(1)
    space = m.js(H + "return main().gBrowser.selectedTab.userContextId;")
    other, third = [c for c in (1, 2, 3) if c != space][:2]
    here, there = "login=here", "login=there"
    visit(m, space, f"{base}/set-cookie?v=here")
    visit(m, other, f"{base}/set-cookie?v=there")

    def rules(*pairs):
        extension_message(m, {"type": "settings:rules", "rules": [{"url": u, "space": f"firefox-container-{c}"} for u, c in pairs]})

    def only(part, cookie, what):
        got = seen(m, part)
        check(what, len(got) >= 1 and all(x["cookie"] == cookie for x in got), f"{part}: {got}")

    # A regular expression that takes for ever on Firefox's own engine, on every navigation.
    rules(("/(a+)+$/", other), ("/(x|x)*y/", other))
    evil = f"{base}/r/catastrophe-{'a' * 60}!"
    r = m.js(ISOLATION_JS + """const t = inTab(args[1], "about:blank"); await wait(400); const t0 = Date.now(); typed(t, args[0]);
      const ok = await until(() => url(t) === args[0], 15000); return {ok, ms: Date.now() - t0};""", evil, space)
    check(f"a catastrophic regular expression in a rule holds up no page ({r['ms']} ms)", r["ok"], str(r))
    m.js(ISOLATION_JS + """await closeAll("catastrophe"); return 1;""")

    # A rule for a space that is gone: Firefox refuses to open anything in it.
    rules(("dead-rule", 99))
    r = m.js(ISOLATION_JS + """main().gBrowser.addTrustedTab(args[0], {inBackground: true}); await until(() => containersOf("dead-rule").length); await wait(500); return containersOf("dead-rule");""", f"{base}/r/dead-rule")
    check("a link a rule sends to a removed space opens in the active space all the same", r == [space], str(r))
    only("dead-rule", here, "and goes out with that space's cookie")
    m.js(ISOLATION_JS + """await closeAll("settings.html"); return 1;""")
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "dead-rule", "space": "firefox-container-99"}, {"url": "/(a)\\1/", "space": f"firefox-container-{other}"}, {"url": "/^https?:\\/\\/(www\\.)?x/", "space": f"firefox-container-{other}"}]})
    r = ext_page(m, "/settings/settings.html", """await wait(800); return [...doc.querySelectorAll("#rules .line")].map(l => ({space: l.querySelector("select").selectedOptions[0].textContent, why: l.querySelector(".rule-problem").hidden ? "" : l.querySelector(".rule-problem").textContent}));""")
    check("the settings page says a rule's space is gone, and doesn't pick another", "gone" in r[0]["space"] and "gone" in r[0]["why"], str(r))
    check("and why an expression can't be used, and nothing about one that can", "back-references" in r[1]["why"] and r[2]["why"] == "", str(r))
    m.js(ISOLATION_JS + """await closeAll("settings.html"); return 1;""")

    # An address typed in a saved tab, selected, in a folder: the tab stays as it was.
    rules()
    visit(m, space, f"{base}/r/saved-one")
    time.sleep(2.5)  # registered as a tab of the record
    tab = m.js(ISOLATION_JS + """const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      return ExtensionParent.apiManager.global.tabTracker.getId(main().gBrowser.tabs.find(x => url(x).includes("saved-one")));""")
    folder = sidebar_page(m, """
      send({type: "newFolder", space: "firefox-container-" + args[0], name: "Kept"});
      await wait(1000);
      const key = [...doc.querySelectorAll("#tabs .folder")].find(f => f.querySelector(".head .title").textContent === "Kept").dataset.key;
      send({type: "moveTab", tabId: args[1], folder: key, before: null});
      await wait(1000);
      return key;""", space, tab)
    rules(("rule-typed", other))
    r = m.js(ISOLATION_JS + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("saved-one"));
      w.gBrowser.selectedTab = t; await wait(800);
      typed(t, args[0]); await until(() => containersOf("rule-typed").length); await wait(1500);
      const n = wins().flatMap(x => x.gBrowser.tabs).find(x => url(x).includes("rule-typed"));
      const all = (await storage(args[1], ["syncedTabs"])).syncedTabs, entry = all[JSON.parse(key(w, t))];
      return {shows: url(t), kept: t.isConnected, ctx: t.userContextId, new: n.userContextId, selected: w.gBrowser.selectedTab === n, beside: w.gBrowser.tabs.indexOf(n) === w.gBrowser.tabs.indexOf(t) + 1, parent: entry.parentKey, saved: entry.saved?.url};""", f"{base}/r/rule-typed", EXT_ID)
    check("an address typed in a saved tab that a rule sends elsewhere: the saved tab stays as it was", r["kept"] and "saved-one" in r["shows"] and r["ctx"] == space and r["parent"] == folder and "saved-one" in (r["saved"] or ""), str(r))
    check("and the address opens selected, in the rule's space, next to it", r["new"] == other and r["selected"] and r["beside"], str(r))
    only("rule-typed", there, "and goes out with that space's cookie, from the first request on")
    press(m, "1", CTRL)
    time.sleep(1)

    # A placeholder whose address a rule sends elsewhere opens where it is: it is yours.
    rules()
    r = m.js(ISOLATION_JS + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("saved-one")), k = key(w, t);
      w.gBrowser.removeTab(t, {skipPermitUnload: true}); await wait(2500);
      return {k, placeholder: url(w.gBrowser.tabs.find(x => key(w, x) === k))};""")
    check("(a saved tab closed is unloaded)", "ghost.html" in r["placeholder"], str(r))
    k = r["k"]
    rules(("saved-one", other))
    r = m.js(ISOLATION_JS + """const w = main(), k = args[0], t = w.gBrowser.tabs.find(x => key(w, x) === k);
      w.gBrowser.selectedTab = t; await until(() => containersOf("saved-one").length, 5000); await wait(1000);
      const entry = (await storage(args[1], ["syncedTabs"])).syncedTabs[JSON.parse(k)];
      return {where: containersOf("saved-one"), same: w.gBrowser.tabs.filter(x => key(w, x) === k).length, parent: entry.parentKey};""", k, EXT_ID)
    check("a saved tab selected opens where it is, whatever a rule says about its address", r["where"] == [space] and r["same"] == 1 and r["parent"] == folder, str(r))
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(800); return 1;""", folder)
    m.js(ISOLATION_JS + """await closeAll("rule-typed"); await closeAll("saved-one"); return 1;""")

    # An essential stays one, wherever a rule says an address belongs.
    rules(("rule-essential", other))
    r = m.js(ISOLATION_JS + """const w = main(), t = w.gBrowser.tabs.find(x => x.pinned && x.userContextId === args[1]);
      typed(t, args[0]); await until(() => url(t) === args[0]); await wait(800);
      return {where: containersOf("rule-essential"), pinned: t.pinned, ctx: t.userContextId, connected: t.isConnected};""", f"{base}/r/rule-essential", space)
    check("an address typed in an essential stays there, and it stays an essential", r["where"] == [space] and r["pinned"] and r["connected"], str(r))
    m.js(ISOLATION_JS + """await closeAll("rule-essential"); return 1;""")

    # Back through a sign-in it passed through: Firefox asks with no page's name on it, as for a typed address.
    rules(("rule-back", other))
    hop = f"{base}/redirect?to={base}/no-bfcache%3Frule%2Dback"
    r = m.js(ISOLATION_JS + """const t = inTab(args[2], "about:blank"); await wait(400); typed(t, args[0]);
      Services.prefs.setIntPref("browser.sessionhistory.max_total_viewers", 0); // no back-forward cache: Firefox must ask
      await until(() => url(t).includes("rule-back")); await wait(400);
      typed(t, args[1]); await until(() => url(t) === args[1]); await wait(400);
      t.linkedBrowser.goBack(); await until(() => url(t).includes("rule-back")); await wait(1000);
      Services.prefs.clearUserPref("browser.sessionhistory.max_total_viewers");
      return {shows: url(t), where: containersOf("rule-back")};""", hop, f"{base}/no-bfcache?after", space)
    check("going back through an address a rule has does not move the tab it passed through", "rule-back" in r["shows"] and r["where"] == [space], str(r))
    check("(Firefox did ask again)", len(seen(m, "rule-back")) >= 2, str(seen(m, "rule-back")))
    m.js(ISOLATION_JS + """await closeAll("no-bfcache"); return 1;""")

    # The same address, by hand, twice.
    rules()
    for _ in range(2):
        visit(m, space, f"{base}/r/copy-twice")
    time.sleep(2.5)
    ids = m.js(ISOLATION_JS + """const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs"), id = t => ExtensionParent.apiManager.global.tabTracker.getId(t);
      return main().gBrowser.tabs.filter(x => url(x).includes("copy-twice")).map(id);""")
    rules(("copy-twice", other))
    copies = extension_message(m, {"type": "isolation:copy", "tabIds": ids, "space": f"firefox-container-{third}", "windowId": None})
    time.sleep(2)
    r = m.js(ISOLATION_JS + """return containersOf("copy-twice").sort();""")
    check("two tabs with the same address copied by hand are both where you put them, whatever a rule says", copies == 2 and r == sorted([space, space, third, third]), f"{copies} {r}")
    m.js(ISOLATION_JS + """await closeAll("copy-twice"); return 1;""")

    # Two windows at once.
    rules(("rule-windows", other))
    r = m.js(ISOLATION_JS + """const a = main(); let b = other(), made = false;
      if (!b) { b = a.OpenBrowserWindow(); b.__smoke = true; made = true; await wait(4000); }
      const u = args[0];
      a.gBrowser.addTrustedTab(u + "/rule-windows-a", {inBackground: true}); b.gBrowser.addTrustedTab(u + "/rule-windows-b", {inBackground: true});
      a.gBrowser.addTrustedTab(u + "/plain-windows-a", {inBackground: true}); b.gBrowser.addTrustedTab(u + "/plain-windows-b", {inBackground: true});
      await until(() => ["rule-windows-a", "rule-windows-b", "plain-windows-a", "plain-windows-b"].every(p => containersOf(p).length)); await wait(800);
      const inWin = (w, p) => w.gBrowser.tabs.filter(t => url(t).includes(p)).map(t => t.userContextId);
      const out = {a: [inWin(a, "rule-windows-a"), inWin(a, "plain-windows-a")], b: [inWin(b, "rule-windows-b"), inWin(b, "plain-windows-b")], crossed: [inWin(a, "windows-b"), inWin(b, "windows-a")], space: b.gBrowser.selectedTab.userContextId, made};
      await closeAll("windows-"); if (made) await close(b);
      return out;""", f"{base}/r", )
    check("links in two windows at once: each opens once, in its own window", r["a"][0] == [other] and r["b"][0] == [other] and r["a"][1] == [space] and len(r["b"][1]) == 1 and r["crossed"] == [[], []], str(r))

    # A redirect loop between two rules' addresses, on a real server.
    rules(("bounce/one", other), ("bounce/two", third))
    r = m.js(ISOLATION_JS + """const w = main(), count = () => w.gBrowser.tabs.length, t = inTab(args[1], "about:blank"); await wait(400);
      const before = count(); typed(t, args[0]); await wait(4000);
      const after = count();
      await closeAll("bounce"); await closeAll("about:neterror");
      return {before, after};""", f"{base}/bounce/one", space)
    check("a redirect loop between two rules' addresses opens one tab, and Firefox ends it", r["after"] == r["before"] and len(seen(m, "/bounce/")) >= 2, f"{r} {len(seen(m, '/bounce/'))}")

    # Two pages sending each other on from a sandboxed frame, which looks like an address you type.
    rules(("pp-one", other), ("pp-two", third))
    r = m.js(ISOLATION_JS + """const w = main(), part = "/pp-", count = () => containersOf(part).length; const t = inTab(args[1], args[2]); await until(() => url(t) === args[2]); await wait(400);
      typed(t, args[0]); await wait(4000);
      const first = count(); await wait(3000); const later = count();
      const tabs = w.gBrowser.tabs.length;
      await closeAll(part);
      return {first, later};""", f"{base}/pp-one", space, f"{base}/r/pp-start")
    check("two pages sending each other between two rules stop, with no storm of tabs", 1 <= r["first"] <= 4 and r["later"] == r["first"], str(r))

    rules()
    m.js(ISOLATION_JS + """await closeAll("127.0.0.1"); return 1;""")
    stats = extension_message(m, {"type": "stats"})
    check("nothing is kept of the tabs that have gone", stats["sizes"]["settled"] == 0, str(stats["sizes"]))
    no_problems(m, "after all this")
    press(m, "1", CTRL)
    time.sleep(1)


def alone_crossing(m):
    # Every other way a page gets loaded than the ones alone_isolation looks at, each with
    # the server recording what left the browser: a request must carry the cookie of its own
    # space from the first one on, and no page may end up outside a space.
    base = m.pages
    press(m, "1", CTRL)
    time.sleep(1)
    space = m.js(H + "return main().gBrowser.selectedTab.userContextId;")
    other = 2 if space != 2 else 3
    m.js(GIVE_PERMISSIONS, EXT_ID, ["webRequest", "webRequestBlocking"], ["<all_urls>"])
    visit(m, space, f"{base}/set-cookie?v=cross-here")
    visit(m, other, f"{base}/set-cookie?v=cross-there")
    here, there = "login=cross-here", "login=cross-there"
    m.js(ISOLATION_JS + """Services.prefs.setBoolPref("dom.disable_open_during_load", false); await closeAll("/set-cookie"); return 1;""")
    # (The page sending a tab on names where in a form that a check for that address doesn't find.)
    sent_to = lambda path: urllib.parse.quote(base + path, safe="").replace("-", "%2D")

    def only(part, cookie, what):
        got = seen(m, part)
        check(what, len(got) >= 1 and all(x["cookie"] == cookie for x in got), f"{part}: {got}")

    def where(part):
        return m.js(ISOLATION_JS + """await until(() => containersOf(args[0]).length, 6000); await wait(800); return containersOf(args[0]);""", part)

    # A page opening another.
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "rule-opened", "space": f"firefox-container-{other}"}]})
    m.js(ISOLATION_JS + """inTab(args[0], args[1]); return 1;""", space, f"{base}/open?to={sent_to('/r/opened')}")
    r = where("/r/opened")
    only("/r/opened", here, "a page opening a tab: it goes out with its space's cookie")
    check("and the tab stays in that space", r == [space], str(r))
    m.js(ISOLATION_JS + """inTab(args[0], args[1]); return 1;""", space, f"{base}/open?to={sent_to('/r/rule-opened')}")
    r = where("/r/rule-opened")
    only("/r/rule-opened", there, "a page opening a tab that a rule sends elsewhere: only the rule's space's cookie is sent, from the first request on")
    check("and it is in the rule's space, once", r == [other], str(r))
    m.js(ISOLATION_JS + """inTab(args[0], args[1]); return 1;""", space, f"{base}/popup?to={sent_to('/r/in-popup')}")
    r = where("/r/in-popup")
    only("/r/in-popup", here, "a page opening a window of its own: its space's cookie")
    check("and that window's tab is in the space", r == [space], str(r))
    m.js(ISOLATION_JS + """for (const w of wins()) if (w.gBrowser.tabs.some(t => url(t).includes("/r/in-popup"))) await close(w); return 1;""")
    extension_message(m, {"type": "settings:rules", "rules": []})
    press(m, "1", CTRL)  # a page's new tab is selected, and the one the rule moved took you along
    time.sleep(1)

    # With no container, in every way Firefox has of opening something by itself.
    def no_container(script, part, what, *args):
        m.js(ISOLATION_JS + script, f"{base}{part}", *args)
        r = where(part)
        only(part, here, f"{what}: every request carries the active space's cookie, never none")
        check(f"{what}: its tab is in the active space, once", r == [space], str(r))

    no_container("""main().openTrustedLinkIn(args[0], "tab", {inBackground: true}); return 1;""", "/r/link-tab", "a link opened as a tab")
    no_container("""main().openTrustedLinkIn(args[0], "window"); return 1;""", "/r/link-window", "a link opened as a window")
    m.js(ISOLATION_JS + """for (const w of wins()) if (w.gBrowser.tabs.some(t => url(t).includes("/r/link-window"))) await close(w); return 1;""")
    no_container("""const t = main().gBrowser.addTrustedTab("about:blank", {inBackground: true}); await wait(300); typed(t, args[0]); return 1;""", "/r/from-blank", "an address in a blank tab")
    no_container("""main().gBrowser.addTrustedTab("view-source:" + args[0], {inBackground: true}); return 1;""", "/r/view-source", "a page's source")
    m.js(ISOLATION_JS + """main().gBrowser.addTrustedTab(args[0], {inBackground: true}); return 1;""", f"{base}/redirect?to={sent_to('/r/after-hop')}")
    r = where("/r/after-hop")
    only("after-hop", here, "a link that redirects: its first hop carries the space's cookie, and so does where it ends up")
    check("and its tab is in the active space", r == [space], str(r))
    sidebar_page(m, """await page.browser.windows.create({type: "popup", url: args[0]}); await wait(300); return 1;""", f"{base}/r/ext-popup")
    r = where("/r/ext-popup")
    only("/r/ext-popup", here, "a window another extension opens: the active space's cookie")
    check("and the page is in the active space, not left in that window", r == [space], str(r))
    # A burst, as when a bookmark folder opens.
    m.js(ISOLATION_JS + """const w = main(); for (let i = 0; i < 15; i++) w.gBrowser.addTrustedTab(args[0] + i, {inBackground: true}); await until(() => containersOf("/r/burst-").length === 15, 15000); await wait(1000); return 1;""", f"{base}/r/burst-")
    r = m.js(ISOLATION_JS + """return containersOf("/r/burst-");""")
    check("a burst of links: each is in the space, once", r == [space] * 15, str(r))
    only("/r/burst-", here, "and none went out without the space's cookie")
    m.js(ISOLATION_JS + """await closeAll("127.0.0.1"); return 1;""")

    # A tab Firefox restores unloaded, loading only when selected, with no container.
    r = m.js(ISOLATION_JS + """const w = main(), t = w.gBrowser.addTrustedTab("about:blank", {inBackground: true}); await wait(600);
      w.SessionStore.setTabState(t, JSON.stringify({entries: [{url: args[0], triggeringPrincipal_base64: '{"3":{}}', title: "Unloaded"}], lastAccessed: 1, index: 1, userContextId: 0}));
      await wait(1500);
      return {unloaded: t.hasAttribute("pending"), ctx: t.userContextId};""", f"{base}/r/resting")
    check("a restored tab with no container waits, sending nothing", r == {"unloaded": True, "ctx": 0} and not seen(m, "/r/resting"), f"{r} {seen(m, '/r/resting')}")
    m.js(ISOLATION_JS + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/r/resting")); return 1;""")
    r = where("/r/resting")
    only("/r/resting", here, "selected, it loads with the active space's cookie")
    check("and in the active space", r == [space], str(r))

    # A tab unloaded in a space loads there, even if a rule has come to want its address.
    visit(m, space, f"{base}/r/unloaded-here")
    time.sleep(2.5)
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "unloaded-here", "space": f"firefox-container-{other}"}]})
    m.js(ISOLATION_JS + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("/r/unloaded-here")); w.gBrowser.discardBrowser(t, true); await wait(400); w.gBrowser.selectedTab = t; await wait(1800); return 1;""")
    r = where("/r/unloaded-here")
    only("/r/unloaded-here", here, "an unloaded tab selected: its own space's cookie")
    check("and no rule moves it", r == [space], str(r))

    # Dragged out to a window of its own and back: no request at all, and the same container.
    before = len(seen(m, "/r/unloaded-here"))
    r = m.js(ISOLATION_JS + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("/r/unloaded-here")); const count = wins().length; w.gBrowser.replaceTabWithWindow(t); await wait(5000);
      const out = {windows: wins().length - count, where: containersOf("/r/unloaded-here")};
      const from = wins().find(x => x !== w && x.gBrowser.tabs.some(y => url(y).includes("/r/unloaded-here")));
      if (from) { w.gBrowser.adoptTab(from.gBrowser.tabs.find(y => url(y).includes("/r/unloaded-here")), {tabIndex: w.gBrowser.tabs.length}); await wait(3000); }
      out.back = containersOf("/r/unloaded-here");
      // (That window stays, with its placeholders. It is closed so that the groups after this have the windows they had.)
      if (from && wins().includes(from)) await close(from);
      w.focus();
      return out;""")
    check("a tab dragged to a window of its own and back keeps its container", r["where"] == [space] and r["back"] == [space], str(r))
    check("and sends nothing for it, rule or no rule", len(seen(m, "/r/unloaded-here")) == before, str(seen(m, "/r/unloaded-here")))
    extension_message(m, {"type": "settings:rules", "rules": []})
    m.js(ISOLATION_JS + """await closeAll("127.0.0.1"); return 1;""")

    # Between windows: a live tab pulled in, and a placeholder loading its own page.
    made = m.js(H + """if (wins().some(w => w !== main())) return false; const w = main().OpenBrowserWindow(); await wait(5000); w.__extra = true; return true;""")
    time.sleep(3)
    visit(m, space, f"{base}/r/pulled")
    time.sleep(3)
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "/r/pulled", "space": f"firefox-container-{other}"}]})
    count = len(seen(m, "/r/pulled"))
    r = m.js(ISOLATION_JS + """const live = main().gBrowser.tabs.find(x => url(x).includes("/r/pulled")), k = key(main(), live);
      const w = wins().find(x => x !== main()), t = w.gBrowser.tabs.find(x => key(w, x) === k);
      if (!t) return {placeholder: false};
      w.focus(); await wait(300); w.gBrowser.selectedTab = t; await wait(3000);
      return {placeholder: true, here: w.gBrowser.tabs.filter(x => url(x).includes("/r/pulled")).map(x => x.userContextId), all: containersOf("/r/pulled")};""")
    check("a live tab pulled into another window keeps its container", r.get("here") == [space] and r.get("all") == [space], str(r))
    check("and sends nothing for it", len(seen(m, "/r/pulled")) == count, str(seen(m, "/r/pulled")))
    folder = sidebar_page(m, """send({type: "newFolder", space: "firefox-container-" + args[0], name: "Crossing"}); await wait(1000);
      return [...doc.querySelectorAll("#tabs .folder")].find(f => f.querySelector(".head .title").textContent === "Crossing").dataset.key;""", space)
    tab = m.js(ISOLATION_JS + """const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs"); return ExtensionParent.apiManager.global.tabTracker.getId(wins().flatMap(w => w.gBrowser.tabs).find(x => url(x).includes("/r/pulled")));""")
    sidebar_page(m, """send({type: "moveTab", tabId: args[0], folder: args[1], before: null}); await wait(1500); return 1;""", tab, folder)
    time.sleep(1.5)
    r = m.js(ISOLATION_JS + """const [w, t] = wins().flatMap(w => w.gBrowser.tabs.filter(x => url(x).includes("/r/pulled")).map(x => [w, x]))[0], k = key(w, t);
      w.gBrowser.removeTab(t, {skipPermitUnload: true}); await wait(2500);
      const [w2, g] = wins().flatMap(w => w.gBrowser.tabs.filter(x => key(w, x) === k).map(x => [w, x]))[0] ?? [];
      if (!g) return {saved: false};
      w2.focus(); await wait(300); w2.gBrowser.selectedTab = g; await until(() => url(g).includes("/r/pulled"), 6000); await wait(800);
      return {saved: true, ctx: g.userContextId, all: containersOf("/r/pulled")};""")
    check("a placeholder loading its own page does so in its space, and no rule takes it", r.get("ctx") == space and r.get("all") == [space], str(r))
    only("/r/pulled", here, "with that space's cookie")
    extension_message(m, {"type": "settings:rules", "rules": []})
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(800); return 1;""", folder)
    m.js(ISOLATION_JS + """await closeAll("127.0.0.1"); if (args[0]) await close(wins().find(w => w.__extra)); main().focus(); return 1;""", made)

    # What Firefox shows no extension at all: its restricted addresses (addons.mozilla.org
    # and the like). Here the test server's own name is made one, with its own cookie.
    hidden = "http://localhost:" + base.rsplit(":", 1)[1]
    visit(m, space, f"{hidden}/set-cookie?v=cross-hidden")
    restricted = m.js(ISOLATION_JS + """Services.prefs.setStringPref("extensions.webextensions.restrictedDomains", "localhost"); await wait(500); return WebExtensionPolicy.isRestrictedURI(Services.io.newURI(args[0]));""", hidden)
    if not restricted:
        print("SKIP  a restricted address (Firefox did not take the test's one)", flush=True)
    else:
        m.js(ISOLATION_JS + """main().gBrowser.addTrustedTab(args[0], {inBackground: true}); return 1;""", f"{hidden}/r/hidden-link")
        r = m.js(ISOLATION_JS + """await until(() => containersOf("/r/hidden-link").some(c => c), 8000); await wait(800); return containersOf("/r/hidden-link");""")
        check("a restricted address with no container: it can't be stopped, but it doesn't stay outside a space", r == [space], str(r))
        got = [x["cookie"] for x in seen(m, "/r/hidden-link")]
        check("it goes out once with no login, and then with the space's", got == ["", "login=cross-hidden"], str(got))
        extension_message(m, {"type": "settings:rules", "rules": [{"url": "/r/hidden-rule", "space": f"firefox-container-{other}"}]})
        m.js(ISOLATION_JS + """inTab(args[0], args[1]); return 1;""", space, f"{hidden}/r/hidden-rule")
        r = m.js(ISOLATION_JS + """await until(() => containersOf("/r/hidden-rule").includes(args[0]), 8000); await wait(800); return containersOf("/r/hidden-rule");""", other)
        check("and a first page there still follows a rule, once it shows", r == [other], str(r))
        extension_message(m, {"type": "settings:rules", "rules": []})
    m.js(ISOLATION_JS + """Services.prefs.clearUserPref("extensions.webextensions.restrictedDomains"); Services.prefs.clearUserPref("dom.disable_open_during_load"); await closeAll("localhost"); await closeAll("127.0.0.1"); return 1;""")
    press(m, "1", CTRL)
    time.sleep(1)




def alone_archived(m):
    # Tidier's own list of what was closed: reached from the list's menu, on the real
    # sidebar, with Firefox's own mouse where it matters (the × shows on hover only).
    settled = """const settled = async (test, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await test(); if (v || Date.now() - t0 > ms) return v; await wait(50); } };"""
    opened = m.js(H + settled + """if (other()) return false;
      const a = main(), want = a.gBrowser.tabs.filter(t => !t.pinned && role(a, t)).length, w = a.OpenBrowserWindow(); w.__smoke = true;
      await settled(() => w.gBrowser && w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length >= want, 20000);
      a.focus(); await wait(500); return true;""")
    space = sidebar_page(m, "return spaces().find(s => s.active).id;")
    ctx = int(space.rsplit("-", 1)[1])
    TITLE = "A page with a title"
    s = m.js(H + settled + """const w = main(), [pages, ctx] = args, away = ctx === 1 ? 2 : 1;
      const open = (q, c) => w.gBrowser.addTrustedTab(pages + "/with-title?smoke-archived-" + q, {userContextId: c, inBackground: true});
      const made = [open("forget", ctx), open("back-slow", ctx), open("away", away)];
      await settled(() => made.every(t => key(w, t) && t.label === %s && other().gBrowser.tabs.some(x => key(other(), x) === key(w, t))));
      await wait(500);
      return {keys: made.map(t => JSON.parse(key(w, t))), urls: made.map(url), away: "firefox-container-" + away, labels: made.map(t => t.label)};""" % json.dumps(TITLE), m.pages, ctx)
    forget_url, back_url, away_url = s["urls"]

    now = int(time.time() * 1000)
    late = extension_message(m, {"type": "archiveNow", "now": now + 13 * 3600 * 1000, "keys": s["keys"], "explain": True})
    check("archiving closes tabs unused for longer than the limit (for the list)", sorted(late.get("archived", [])) == sorted(s["urls"]), str(late))

    # The sidebar page in front, as a sidebar always is: a page behind others is not drawn.
    m.js(H + """const w = main(); w.focus(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(500); return 1;""")

    def mouse(x, y, click=True, double=False):
        """Firefox's own mouse, on the sidebar page in front. A double click has the slide's time between its clicks."""
        m.cmd("Marionette:SetContext", {"value": "content"})
        for h in m.cmd("WebDriver:GetWindowHandles"):
            m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
            if "/sidebar/sidebar.html" in m.cmd("WebDriver:GetCurrentURL"):
                break
        acts = [{"type": "pointerMove", "x": round(x), "y": round(y), "duration": 0}]
        press = [{"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]
        if click:
            acts += press
        if double:
            acts += [{"type": "pause", "duration": 350}] + press
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": acts}]})
        m.cmd("WebDriver:ReleaseActions")
        m.chrome()

    box = settled + """const box = doc.getElementById("archived"), open = () => box.classList.contains("open");
      const rowsHere = () => [...box.querySelectorAll(".rows .row")];
      const middle = e => { const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; };
      const describe = r => ({title: r.querySelector(".title").textContent, age: r.querySelector(".age").textContent, tip: r.title});
      const key = k => page.dispatchEvent(new page.KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));"""

    # The list's menu opens the view, over the list, and the list stays as it is.
    r = sidebar_page(m, box + """
      const list = doc.getElementById("tabs"), around = list.getBoundingClientRect();
      const before = rows();
      list.dispatchEvent(new page.MouseEvent("contextmenu", {bubbles: true, cancelable: true, button: 2, clientX: around.left + 8, clientY: around.bottom - 4}));
      const items = [...doc.querySelectorAll("#menu .item")], labels = items.map(b => b.textContent);
      items.find(b => b.textContent === "Archived tabs").click();
      await settled(() => open() && rowsHere().length);
      await settled(() => box.getBoundingClientRect().left === 0);
      const r = box.getBoundingClientRect(), actions = doc.getElementById("actions").getBoundingClientRect(), at = middle(rowsHere()[0]);
      return {labels, rows: rowsHere().map(describe), under: doc.elementFromPoint(at.x, at.y) === rowsHere()[0] || rowsHere()[0].contains(doc.elementFromPoint(at.x, at.y)), covers: r.top === actions.top && r.bottom === around.bottom,
              list: before.length === rows().length, back: box.querySelector(".back").textContent};""")
    check("the list's menu has Archived tabs", "Archived tabs" in r.get("labels", []), str(r))
    check("the view shows this space's tabs, newest first, each with its title and age", [x["tip"].split("\n")[1] for x in r.get("rows", [])] == [back_url, forget_url]
          and all(x["title"] == TITLE and re.fullmatch(r"now|\d+ min", x["age"]) for x in r["rows"]), str(r))
    check("the view lies over the list, on top, and the list is still there under it", r.get("under") and r.get("covers") and r.get("list"), str(r))

    # Esc goes back; the keys stay out of the list under it.
    r = sidebar_page(m, box + """
      const under = doc.querySelector("#tabs .cursor");  // the list keeps its own, if an earlier check left one
      key("ArrowDown");
      const cursor = rowsHere()[0].classList.contains("cursor"), moved = doc.querySelector("#tabs .cursor") !== under;
      key("Escape");
      const closed = !open();
      page.openArchived();
      await settled(() => open());
      await settled(() => box.getBoundingClientRect().left === 0);
      return {cursor, moved, closed, back: middle(box.querySelector(".back"))};""")
    check("the arrow keys move in the view, not in the list under it", r.get("cursor") and r.get("moved") is False, str(r))
    check("Esc goes back to the list", r.get("closed"), str(r))
    mouse(r["back"]["x"], r["back"]["y"])
    r = sidebar_page(m, box + """await settled(() => !open()); return {open: open()};""")
    check("the back row goes back to the list", r["open"] is False, str(r))

    # The × shows on hover, and forgets. Two rows, one for each.
    r = sidebar_page(m, box + """
      page.openArchived();
      await settled(() => open() && rowsHere().length === 2);
      await settled(() => box.getBoundingClientRect().left === 0);
      const row = rowsHere().find(x => x.title.includes("smoke-archived-forget"));
      return {x: row.getBoundingClientRect().right - 16, y: middle(row).y, shows: page.getComputedStyle(row.querySelector(".close")).visibility};""")
    check("the × of a row does not show without the pointer on it", r.get("shows") == "hidden", str(r))
    mouse(r["x"], r["y"], click=False)
    h = sidebar_page(m, box + """const row = rowsHere().find(x => x.title.includes("smoke-archived-forget"));
      return {close: page.getComputedStyle(row.querySelector(".close")).visibility, age: page.getComputedStyle(row.querySelector(".age")).visibility};""")
    check("with the pointer on it, the × takes the age's place", h == {"close": "visible", "age": "hidden"}, str(h))
    mouse(r["x"], r["y"])
    r = sidebar_page(m, box + """await settled(() => rowsHere().length === 1);
      return {tips: rowsHere().map(x => x.title), open: open(), reply: await page.browser.runtime.sendMessage({type: "archivedTabs", space: args[0]}).then(l => JSON.parse(JSON.stringify(l)))};""", space)
    check("the × forgets it, and the view stays", r["open"] and len(r["tips"]) == 1 and [x["url"] for x in r["reply"]] == [back_url], str(r))

    # A tab you close while it is open comes in by itself, marked as closed, not archived.
    closing = m.js(H + settled + """const w = main(), t = w.gBrowser.addTrustedTab(args[0] + "/with-title?smoke-archived-closing", {userContextId: args[1], inBackground: true});
      await settled(() => key(w, t) && t.label === %s && other().gBrowser.tabs.some(x => key(other(), x) === key(w, t)));
      const u = url(t); w.gBrowser.removeTab(t); return u;""" % json.dumps(TITLE), m.pages, ctx)
    r = sidebar_page(m, box + """await settled(() => rowsHere().length === 2);
      return {tip: rowsHere()[0].title, older: rowsHere()[1].title};""")
    check("a tab you close while the view is open comes in by itself, as closed", closing in r.get("tip", "") and "\nClosed " in r["tip"] and "\nArchived " in r.get("older", ""), str(r))
    # ⌘⇧T brings it back: it leaves the list by itself. (Firefox's own way back, with its history.)
    m.js(H + settled + """const w = main(), page = w.gBrowser.selectedTab; w.SessionStore.undoCloseTab(w, 0);
      await settled(() => w.gBrowser.tabs.some(t => url(t) === args[0] && key(w, t)));
      w.gBrowser.selectedTab = page; await wait(300); return 1;""", closing)
    r = sidebar_page(m, box + """await settled(() => rowsHere().length === 1); return {tips: rowsHere().map(x => x.title), open: open()};""")
    check("a tab that comes back by ⌘⇧T leaves the list", r["open"] and len(r["tips"]) == 1 and closing not in r["tips"][0], str(r))

    # A click outside the view closes it, and still does what it does.
    r = sidebar_page(m, box + """
      const dot = doc.querySelector("#spaces .space:not(.active)"), to = dot.dataset.space;
      dot.click();
      const closed = !open();
      await settled(() => spaces().find(s => s.active).id === to);
      const then = spaces().find(s => s.active).id;
      send({type: "space", space: args[0]});
      await settled(() => spaces().find(s => s.active).id === args[0]);
      return {closed, went: then === to};""", space)
    check("a click on a space closes the view, and goes there", r.get("closed") and r.get("went"), str(r))
    r = sidebar_page(m, box + """page.openArchived(); await settled(() => open() && rowsHere().length); await settled(() => box.getBoundingClientRect().left === 0); return rowsHere().length;""")

    # A click brings it back: with its title from the very first view, long before its page
    # has answered, selected, in its space, also with a rule for its address: it is coming
    # back to where it was, not a new tab.
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "smoke-archived-back", "space": s["away"]}]})
    # (Firefox can find a title in its history by itself; the list must not depend on that.)
    m.js(H + """await main().PlacesUtils.history.remove(args[0]); return 1;""", back_url)
    r = sidebar_page(m, box + """
      const seen = [];
      port.onMessage.addListener(v => { for (const t of v.tabs) if (!seen.some(x => x.id === t.id)) seen.push({id: t.id, title: t.title}); });
      const known = new Set(rows()), n0 = plainTabs().length;
      await wait(200);
      seen.length = 0;
      const had = new Set([...doc.querySelectorAll("#tabs > .tab")].map(x => Number(x.dataset.tab)));
      rowsHere()[0].click();
      const closed = !open();
      await settled(() => plainTabs().length === n0 + 1);
      await settled(() => doc.querySelector("#tabs > .tab.active"));
      const row = doc.querySelector("#tabs > .tab.active");
      const fresh = seen.filter(x => !had.has(x.id));
      const title = row.querySelector(".title").textContent;
      await wait(1000);
      return {closed, title, later: row.querySelector(".title").textContent, first: fresh.map(x => x.title),
              list: await page.browser.runtime.sendMessage({type: "archivedTabs", space: args[0]}).then(l => JSON.parse(JSON.stringify(l)))};""", space)
    check("a click on a row closes the view, and the tab comes back selected, with its title at once", r.get("closed") and r.get("title") == TITLE and r.get("later") == TITLE and r.get("first") and r["first"][0] == TITLE, str(r))
    check("it leaves the list", r.get("list") == [], str(r))
    t = m.js(H + settled + """const u = args[0];
      await settled(() => wins().every(w => w.gBrowser.tabs.some(t => key(w, t) && (url(t) === u || value(w, t, "syncRole") === "ghost" && String(t.label) === %s))));
      await settled(() => other().gBrowser.tabs.some(t => t.label === %s && !t.linkedPanel));
      await wait(1500);
      const a = main(), here = a.gBrowser.tabs.find(t => url(t) === u), k = here && key(a, here);
      const there = other().gBrowser.tabs.filter(t => key(other(), t) === k);
      const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      return {selected: here?.selected, ctx: here?.userContextId, role: here && role(a, here), there: there.map(t => ({role: role(other(), t), ctx: t.userContextId, label: t.label, unloaded: !t.linkedPanel})), record: k && all[JSON.parse(k)]?.title};""" % (json.dumps(TITLE), json.dumps(TITLE), EXT_ID), back_url)
    check("it opens in its space, live here and a placeholder in the second window, with its title",
          t["selected"] and t["ctx"] == ctx and t["role"] == "live" and t["record"] == TITLE and t["there"] == [{"role": "ghost", "ctx": ctx, "label": TITLE, "unloaded": True}], str(t))

    extension_message(m, {"type": "settings:rules", "rules": []})

    # Another space's list can be looked at without going there; opening a row goes there.
    r = sidebar_page(m, box + """
      page.openArchived(args[0]);
      await settled(() => open() && rowsHere().length);
      const shown = rowsHere().map(x => x.title.split("\\n")[1]), back = box.querySelector(".back").textContent, stayed = spaces().find(s => s.active).id;
      rowsHere()[0].click();
      await settled(() => spaces().find(s => s.active).id === args[0]);
      return {shown, back, stayed, then: spaces().find(s => s.active).id};""", s["away"])
    check("another space's list shows without going there", r.get("shown") == [away_url] and r.get("stayed") == space and "Archived tabs in" in r.get("back", ""), str(r))
    check("opening a row from it goes to that space", r.get("then") == s["away"], str(r))
    t = m.js(H + settled + """const u = args[0], ctx = args[1];
      await settled(() => main().gBrowser.selectedTab.userContextId === ctx && url(main().gBrowser.selectedTab) === u);
      const t = main().gBrowser.selectedTab; return {ctx: t.userContextId, url: url(t)};""", away_url, int(s["away"].rsplit("-", 1)[1]))
    check("that tab is selected, in its own container", t == {"ctx": int(s["away"].rsplit("-", 1)[1]), "url": away_url}, str(t))
    sidebar_page(m, """send({type: "space", space: args[0]}); await wait(1000); return 1;""", space)

    # A tab whose real page was in a window you closed: only a placeholder is left, and the list has its real address.
    h = m.js(H + settled + """const a = main(), [pages, ctx] = args, w = a.OpenBrowserWindow(); w.__extra = true;
      await settled(() => w.gBrowser && w.gBrowser.tabs.some(t => role(w, t)));
      const t = w.gBrowser.addTrustedTab(pages + "/with-title?smoke-archived-held", {userContextId: ctx, inBackground: true});
      await settled(() => key(w, t) && t.label === %s && wins().every(x => x.gBrowser.tabs.some(y => key(x, y) === key(w, t))));
      await wait(500);
      const k = key(w, t), u = url(t);
      await close(w);
      await settled(() => wins().some(x => x.gBrowser.tabs.some(y => key(x, y) === k && role(x, y) === "live")));
      return {key: JSON.parse(k), url: u, live: wins().flatMap(x => x.gBrowser.tabs.filter(y => key(x, y) === k && role(x, y) === "live").map(url))};""" % json.dumps(TITLE), m.pages, ctx)
    check("a closed window's tab is live as a placeholder elsewhere", len(h["live"]) == 1 and "ghost.html" in h["live"][0], str(h))
    now = int(time.time() * 1000)
    first = extension_message(m, {"type": "archiveNow", "now": now, "keys": [h["key"]], "explain": True})
    check("a placeholder's time starts when it became one", str(first.get("kept", {}).get(h["key"])).startswith("used"), str(first))
    late = extension_message(m, {"type": "archiveNow", "now": now + 13 * 3600 * 1000, "keys": [h["key"]], "explain": True})
    check("a tab that is only a placeholder is archived after that time", late.get("archived") == [h["url"]], str(late))
    r = sidebar_page(m, box + """page.openArchived(); await settled(() => open() && rowsHere().length);
      const shown = rowsHere().map(describe); key("Escape"); return shown;""")
    check("the list has its real address and title", [x["tip"].split("\n")[1] for x in r] == [h["url"]] and r[0]["title"] == TITLE, str(r))
    c = m.js(H + """return {left: wins().flatMap(w => w.gBrowser.tabs.filter(t => key(w, t) === JSON.stringify(args[0]))).length,
              recently: wins().flatMap(w => w.SessionStore.getClosedTabDataForWindow(w).map(c => c.state.entries.at(-1)?.url)).filter(u => u?.includes("ghost.html") && u.includes(encodeURIComponent(args[0]))).length};""", h["key"])
    check("nothing of it is left, in the tabs or as a placeholder in Recently Closed", c == {"left": 0, "recently": 0}, str(c))

    # A double click is one click: what comes under the pointer after the first does not get
    # the second. Three rows of their own, with the sidebar page in front again.
    urls = m.js(H + settled + """const w = main(), [pages, ctx] = args;
      const made = ["a", "b", "c"].map(q => w.gBrowser.addTrustedTab(pages + "/with-title?smoke-archived-twice-" + q, {userContextId: ctx, inBackground: true}));
      await settled(() => made.every(t => key(w, t) && t.label === %s));
      const urls = made.map(url);
      for (const t of made) { w.gBrowser.removeTab(t); await wait(150); }
      w.focus(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(500);
      return urls;""" % json.dumps(TITLE), m.pages, ctx)
    tab_count = """return main().gBrowser.tabs.length;"""
    opened_view = box + """page.openArchived(); await settled(() => open() && rowsHere().length >= args[0]); await settled(() => box.getBoundingClientRect().left === 0);"""
    r = sidebar_page(m, opened_view + """const row = rowsHere()[0]; return {x: row.getBoundingClientRect().right - 16, y: middle(row).y, n: rowsHere().length};""", 3)
    n0 = m.js(H + tab_count)
    mouse(r["x"], r["y"], double=True)
    t = sidebar_page(m, box + """await settled(() => rowsHere().length < args[0]); await wait(500); return {n: rowsHere().length, open: open(), first: rowsHere()[0]?.title};""", r["n"])
    check("a double click on × forgets one row, and opens nothing", t.get("n") == r["n"] - 1 and t.get("open") and m.js(H + tab_count) == n0 and urls[1] in t.get("first", ""), str(t))
    b = sidebar_page(m, box + """return middle(box.querySelector(".back"));""")
    mouse(b["x"], b["y"], double=True)
    t = sidebar_page(m, box + """await settled(() => !open()); await wait(500); return {open: open()};""")
    check("a double click on the back row goes back, and presses nothing under it", t.get("open") is False and m.js(H + tab_count) == n0, f"{t} {n0} -> {m.js(H + tab_count)}")
    # A row selects its tab, and then this page is behind it and gets no real mouse here, so the
    # second click is the same event Firefox would send to the row of the list come into sight.
    r = sidebar_page(m, opened_view + """
      const under = doc.querySelector("#tabs > .tab"), row = rowsHere()[0], tip = row.title;
      const click = (e, detail) => e.dispatchEvent(new page.MouseEvent("click", {bubbles: true, cancelable: true, detail}));
      click(row, 1);
      const closed = !open();
      await wait(300);
      click(under, 2);
      await wait(800);
      return {closed, tip};""", 2)
    t = m.js(H + settled + """const w = main(); await settled(() => url(w.gBrowser.selectedTab) === args[0], 5000); return url(w.gBrowser.selectedTab);""", urls[1])
    check("a double click on a row opens that tab, and the list under it does not get the second click", r.get("closed") and t == urls[1], f"{r} {t}")

    # With the view closed nothing of it is kept, and it opens again at the top.
    m.js(H + """const w = main(); w.focus(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(500); return 1;""")
    r = sidebar_page(m, opened_view + """
      const scroller = box.querySelector(".rows");
      scroller.style.maxHeight = "20px"; scroller.scrollTop = 20;
      const scrolled = scroller.scrollTop;
      key("Escape");
      await settled(() => !rowsHere().length, 3000);
      const left = rowsHere().length;
      scroller.style.maxHeight = "";
      page.openArchived();
      await settled(() => open() && rowsHere().length);
      return {scrolled, left, top: scroller.scrollTop};""", 1)
    check("a closed view keeps no rows, and opens again at the top", r.get("scrolled") and r.get("left") == 0 and r.get("top") == 0, str(r))

    # The age changes with the minute, and only the age: a row redrawn under a click would take
    # the click from its × (the row then opens instead of forgets), and fetch its icon again.
    r = sidebar_page(m, box + """
      await settled(() => open() && rowsHere().length);
      const row = rowsHere()[0], close = row.querySelector(".close"), title = row.querySelector(".title"), now = page.Date.now;
      page.Date.now = page.Function.prototype.bind.call(page.Number, null, Date.now() + 5 * 3600e3 + 60000);
      await page.refreshArchived();
      page.Date.now = now;
      return {same: row.isConnected && row.querySelector(".close") === close && row.querySelector(".title") === title, age: row.querySelector(".age").textContent};""")
    check("when only time has passed a row shows its new age, and nothing else of it is drawn again", r.get("same") and r.get("age") == "5 h", str(r))

    # A key or a link can change the space under the view: it was about the space you were in.
    r = sidebar_page(m, box + """
      await settled(() => open());
      const away = spaces().find(s => !s.active).id;
      send({type: "space", space: away});
      await settled(() => spaces().find(s => s.active).id === away);
      await settled(() => !open(), 3000);
      const closed = !open();
      send({type: "space", space: args[0]});
      await settled(() => spaces().find(s => s.active).id === args[0]);
      return {closed};""", space)
    check("a space changed by a key closes the view", r.get("closed"), str(r))

    # A container removed in Firefox's settings: its tabs close first, each one lands in the
    # list, and then the container goes. Neither its rows nor a view of them are left.
    c = m.js(H + settled + """const w = main(), C = w.ContextualIdentityService, made = C.create("Smoke gone", "circle", "blue");
      const t = w.gBrowser.addTrustedTab(args[0] + "/with-title?smoke-archived-gone", {userContextId: made.userContextId, inBackground: true});
      await settled(() => key(w, t) && t.label === %s);
      return {id: made.userContextId, url: url(t)};""" % json.dumps(TITLE), m.pages)
    gone = "firefox-container-%d" % c["id"]
    r = sidebar_page(m, box + """await settled(() => doc.querySelector(`#spaces .space[data-space="${args[0]}"]`));
      page.openArchived(args[0]); await settled(() => open()); return open();""", gone)
    m.js(H + settled + """const C = main().ContextualIdentityService; await C.closeContainerTabs(args[0]); C.remove(args[0]); return 1;""", c["id"])
    r = sidebar_page(m, box + """await settled(() => !open(), 5000);
      await settled(() => !doc.querySelector(`#spaces .space[data-space="${args[0]}"]`), 5000);
      await wait(1000);
      const every = await page.browser.runtime.sendMessage({type: "archivedTabs"}).then(l => JSON.parse(JSON.stringify(l)));
      const stored = await page.browser.storage.local.get("archivedTabs").then(l => JSON.parse(JSON.stringify(l)));
      return {open: open(), every: every.filter(x => x.space === args[0]), stored: Object.keys(stored.archivedTabs || {}).includes(args[0])};""", gone)
    check("a removed container's rows and its open view go with it", r.get("open") is False and r.get("every") == [], str(r))

    # Firefox's own keyboard, on the sidebar page in front: ↓ moves, ⌫ forgets, ← goes back, Enter opens.
    def keyboard(*keys):
        m.cmd("Marionette:SetContext", {"value": "content"})
        for h in m.cmd("WebDriver:GetWindowHandles"):
            m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
            if "/sidebar/sidebar.html" in m.cmd("WebDriver:GetCurrentURL"):
                break
        acts = [a for k in keys for a in ({"type": "keyDown", "value": k}, {"type": "keyUp", "value": k})]
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "keyboard", "actions": acts}]})
        m.cmd("WebDriver:ReleaseActions")
        m.chrome()
    DOWN, LEFT, BACKSPACE, ENTER = "\uE015", "\uE012", "\uE003", "\uE007"
    r = sidebar_page(m, opened_view + """return {tips: rowsHere().map(x => x.title.split("\\n")[1]), under: doc.querySelector("#tabs .cursor")?.dataset.tab ?? null};""", 2)
    keyboard(DOWN, BACKSPACE)
    t = sidebar_page(m, box + """await settled(() => rowsHere().length === args[0] - 1, 5000);
      return {tips: rowsHere().map(x => x.title.split("\\n")[1]), open: open(), cursor: rowsHere().findIndex(x => x.classList.contains("cursor")), under: doc.querySelector("#tabs .cursor")?.dataset.tab ?? null};""", len(r["tips"]))
    check("↓ and ⌫ on the keyboard forget the first row, and stay in the view", t.get("tips") == r["tips"][1:] and t.get("open") and t.get("cursor") == 0 and t.get("under") == r["under"], f"{r} {t}")
    keyboard(LEFT)
    t = sidebar_page(m, box + """await settled(() => !open(), 5000); return {open: open()};""")
    check("← on the keyboard goes back", t.get("open") is False, str(t))
    r = sidebar_page(m, opened_view + """return rowsHere().map(x => x.title.split("\\n")[1]);""", 1)
    keyboard(DOWN, ENTER)
    t = m.js(H + settled + """const w = main(); await settled(() => url(w.gBrowser.selectedTab) === args[0], 8000); return url(w.gBrowser.selectedTab);""", r[0])
    check("↓ and Enter on the keyboard open the first row", t == r[0], f"{r} {t}")

    # What this group added goes again.
    m.js(H + settled + """const a = main(), ours = (w, t) => url(t).includes("smoke-archived") || String(t.label) === %s;
      await removeWhere(ours);
      if (args[0]) await close(other());
      return 1;""" % json.dumps(TITLE), opened)
    no_problems(m, "after using the list of archived tabs")


def alone_idle(m):
    # What the groups before did can still have a timer running, started by what they did:
    # the quiet line (10 s) and a placeholder's new title (up to a minute, refreshGhostsSoon).
    # Nothing is happening only once those have run out.
    for _ in range(150):
        sizes = extension_message(m, {"type": "stats"})["sizes"]
        if not sizes["quietNotes"] and not sizes["refreshTimers"]:
            break
        time.sleep(0.5)
    idle = extension_message(m, {"type": "idle", "ms": 15000})
    if idle["alarms"]:
        print(f"SKIP  idle check: a timed check ran meanwhile ({idle})", flush=True)
    else:
        check("with nothing happening, Tidier and its sidebar do nothing (15 s)", idle["jobs"] == 0 and idle["lookups"] == 0 and idle["views"] == 0, str(idle))


def alone_update(m):
    # An update shows every tab Tidier hid again (the permission is an optional one): hidden again by the time it has started.
    if not m.can_restart:
        print("SKIP  alone_update (needs Tidier installed for real: Developer Edition, or --xpi)", flush=True)
        return
    before = m.js(SNAP_ALONE)
    m.cmd("Addon:Install", {"path": m.update_xpi(), "temporary": False})
    m.js(H + "await wait(9000); return 1;")
    after = m.js(SNAP_ALONE)
    check("after an update with Tidier alone, the same tabs, folders and one space shown", before == after, f"{before} -> {after}")
    r = m.js(H + "return main().SidebarController.currentID;")
    check("after an update, Tidier's sidebar is still the sidebar", "6844a953" in (r or ""), str(r))


def alone_restart(m):
    if not m.can_restart:
        print("SKIP  alone_restart (needs Tidier installed for real: Developer Edition, or --xpi)", flush=True)
        return
    no_problems(m, "before a restart with Tidier alone")
    # Names, as the record and the list keep them: an essential's, and a saved tab's.
    more_tabs_here(m, "restart")
    named = sidebar_page(m, """
      const until = async f => { for (const end = Date.now() + 8000; Date.now() < end; await wait(50)) { const v = f(); if (v) return v; } return f(); };
      const tile = doc.querySelector("#essentials .tile"), space = spaces().find(s => s.active).id;
      send({type: "newFolder", space, name: "Named"});
      const head = await until(() => [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Named"));
      const tab = Number(plainTabs().at(-1).dataset.tab);
      send({type: "moveTab", tabId: tab, folder: head.dataset.folderHead, before: null});
      await until(() => doc.querySelector(`#tabs .tab[data-tab="${tab}"]`)?.dataset.folder);
      send({type: "renameTab", tabId: Number(tile.dataset.tab), name: "Named essential"});
      send({type: "renameTab", tabId: tab, name: "Named tab"});
      await until(() => tile.title.startsWith("Named essential") && rows().includes("Named tab"));
      return {tile: tile.title, rows: rows()};""")
    check("names: an essential and a saved tab named before the restart", named.get("tile", "").startswith("Named essential") and "Named tab" in named.get("rows", []), str(named))
    # Which tab each window is on says why a page has moved between them.
    on_now = H + """return wins().map(w => { const t = w.gBrowser.selectedTab; return [url(t).slice(0, 60), role(w, t) ?? null, !!t.pinned]; });"""
    archived = extension_message(m, {"type": "archivedTabs"})
    before, on_before = m.js(SNAP_ALONE), m.js(on_now)
    # Also in the extension's own storage, as a browser moved over has it: this test Firefox is
    # only pointed at its managed storage once it has started (USE_TEST_MANAGED_STORAGE), too
    # late for the first view of a sidebar that is open, which a real file is not.
    sidebar_page(m, """await page.browser.storage.local.set(page.JSON.parse(JSON.stringify({tidierAlone: true}))); return 1;""")
    m.restart()
    m.js(H + """for (let i = 0; i < 100 && wins().length < 2; i++) await wait(200); await wait(12000); return 1;""")
    after, on_after = m.js(SNAP_ALONE), m.js(on_now)
    # As many pages, not in the same windows: a window you are not using can be on a placeholder,
    # which waits unloaded until you use that window (pull, tabsync.js), and Firefox can come
    # back with that window in front. Its page then comes over, as it would for a click.
    def wherever(snap):
        return {**snap, "windows": [{k: v for k, v in w.items() if k != "live"} for w in snap["windows"]], "pages": sum(w["live"] for w in snap["windows"])}
    check("after a restart with Tidier alone, the same tabs, folders and one space shown", wherever(before) == wherever(after), f"on {on_before} -> {on_after}; {before} -> {after}")
    check("after a restart, the list of archived tabs is still there", extension_message(m, {"type": "archivedTabs"}) == archived, str(archived))
    # Its rows, not only the tabs: in a sidebar page opened now, and in the window's own sidebar.
    r = ext_page(m, "/sidebar/sidebar.html?after-restart", """for (let i = 0; i < 40 && !rows().length; i++) await wait(250);
      const own = page.browser.extension.getViews({type: "sidebar"}).map(v => [...v.document.querySelectorAll("#tabs .tab")]);
      return {rows: rows().length, spaces: spaces().length, reals: own.map(list => list.length), fixed: own.flat().filter(e => !e.draggable).length};""")
    check("after a restart the sidebar shows its list", r["rows"] > 0 and r["spaces"] > 0, str(r))
    check("after a restart the window's own sidebar has connected and shows its list", any(r["reals"]), str(r))
    check("after a restart the rows of the window's own sidebar can be dragged", r["fixed"] == 0, str(r))
    # The page from before the restart is not loaded again by itself: a new one.
    m.js(H + """for (const t of [...main().gBrowser.tabs]) if (url(t).includes("/sidebar/sidebar.html")) main().gBrowser.removeTab(t); await wait(300); return 1;""")
    r = sidebar_page(m, """for (const end = Date.now() + 8000; Date.now() < end && !tiles().length; await wait(50)); return {tiles: tiles().map(t => t.split("\\n")[0]), rows: rows()};""")
    check("after a restart, an essential and a saved tab keep their names", "Named essential" in r.get("tiles", []) and "Named tab" in r.get("rows", []), str(r))
    r = m.js(H + """const labels = w => w.gBrowser.tabs.filter(t => !t.selected && !t.linkedPanel).map(t => t.label); return wins().map(labels).flat();""")
    check("after a restart, their placeholders still show them", "Named essential" in r and "Named tab" in r, str(r))


def more_tabs_here(m, name):
    """Three more tabs in the active space, for checks that use up tabs."""
    space = sidebar_page(m, """return spaces().find(s => s.active).id;""")
    m.js(H + """const w = main(), ctx = Number(args[0].split("-").pop());
      for (const i of [1, 2, 3]) { w.gBrowser.addTrustedTab("https://example.org/?smoke-" + args[1] + "-" + i, {userContextId: ctx, inBackground: true}); await wait(200); }
      await wait(3500); return 1;""", space, name)


def alone_drag(m):
    # Real drag events on the real sidebar: into a folder, among the tabs, to the essentials.
    more_tabs_here(m, "drag")
    r = sidebar_page(m, """
      const drag = async (from, to, below = false) => {
        const data = new page.DataTransfer(), box = to.getBoundingClientRect();
        const at = {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + (below ? box.height - 1 : 1), dataTransfer: data};
        from.dispatchEvent(new page.DragEvent("dragstart", at));
        to.dispatchEvent(new page.DragEvent("dragover", at));
        to.dispatchEvent(new page.DragEvent("drop", at));
        from.dispatchEvent(new page.DragEvent("dragend", at));
        await wait(1800);
      };
      send({type: "newFolder", space: spaces().find(s => s.active).id, name: "Dragged"});
      await wait(1000);
      const row = () => plainTabs(), head = () => [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Dragged");
      const out = {};
      const a = row()[0], aTitle = Number(a.dataset.tab);
      const n0 = row().length, inFolder0 = head().parentElement.querySelectorAll(".tab").length;
      await drag(a, head());
      out.into = {left: row().length === n0 - 1, inFolder: head().parentElement.querySelectorAll(".tab").length === inFolder0 + 1};
      const back = head().parentElement.querySelector(".tab");
      await drag(back, row().at(-1), true);
      out.out = {back: row().length === n0, last: Number(row().at(-1).dataset.tab) === aTitle};
      const first = row()[0], last = row().at(-1), lastId = Number(last.dataset.tab);
      await drag(last, first);
      out.before = Number(row()[0].dataset.tab) === lastId;
      const tiles0 = tiles().length;
      const pinned = row()[0], pinnedId = Number(pinned.dataset.tab);
      await drag(pinned, doc.getElementById("essentials"));
      out.pinned = tiles().length === tiles0 + 1;
      const tile = doc.querySelector(`#essentials .tile[data-tab="${pinnedId}"]`);
      if (tile) await drag(tile, doc.getElementById("tabs"));
      out.unpinned = tiles().length === tiles0;
      send({type: "deleteFolder", key: head().dataset.folderHead});
      await wait(1000);
      // Keys: down to a tab, Enter selects it.
      const key = k => page.dispatchEvent(new page.KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
      const reach = [...doc.querySelectorAll(".tile, #tabs .head, #tabs .tab")];
      for (let i = 0; i <= reach.length; i++) key("ArrowUp");  // to the top, from wherever the first key starts
      for (let i = 0; i < reach.indexOf(plainTabs()[0]); i++) key("ArrowDown");
      const chosen = doc.querySelector(".cursor");
      out.cursor = chosen === plainTabs()[0];
      await wait(100);
      return out;""")
    check("the arrow keys move through the sidebar", r.get("cursor") is True, str(r))
    check("a tab dragged onto a folder goes into it", r.get("into") == {"left": True, "inFolder": True}, str(r))
    check("a tab dragged out of a folder is an ordinary tab, where you put it", r.get("out") == {"back": True, "last": True}, str(r))
    check("a tab dragged above another is there", r.get("before") is True, str(r))
    check("a tab dragged to the essentials is an essential, and dragged back an ordinary tab", r.get("pinned") is True and r.get("unpinned") is True, str(r))


def alone_tab_names(m):
    # Real keys and clicks in the sidebar page, in front. renameKept is what the tab
    # menu's Rename calls; everything after that is what you do in the box.
    ENTER, ESC, BACKSPACE = "\ue007", "\ue00c", "\ue003"
    PAGE = "/sidebar/sidebar.html"
    # By the clock: a page in a background tab has its timers slowed to one a second or less.
    UNTIL = """const until = async (f, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = f(); if (v) return v; } return f(); };
      const row = id => doc.querySelector(`#tabs .tab[data-tab="${id}"]`), tile = id => doc.querySelector(`#essentials .tile[data-tab="${id}"]`);
      const nameOf = id => row(id)?.querySelector(".title")?.textContent;
      const tip = e => e?.title.split("\\n")[0];
      const box = () => doc.querySelector("input.rename");
      const state = () => ({open: !!box(), value: box()?.value ?? null, focused: !!box() && doc.activeElement === box(), caret: box()?.selectionStart ?? null});"""

    def keys(*texts):
        acts = [a for text in texts for ch in text for a in ({"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch})]
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": acts}]})
        m.cmd("WebDriver:ReleaseActions")

    def click(x, y):
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(x), "y": int(y), "duration": 0, "origin": "viewport"},
            {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]})
        m.cmd("WebDriver:ReleaseActions")

    def in_front(script, *args):
        """Run `script` in the sidebar page, which stays in the content context for keys() and click()."""
        return m.cmd("WebDriver:ExecuteAsyncScript", {"script": """
          const args = [...arguments], done = args.pop(), wait = ms => new Promise(r => setTimeout(r, ms));
          const page = window.wrappedJSObject || window, doc = page.document;
          """ + UNTIL + """
          (async () => { """ + script + """ })().then(r => done(JSON.parse(JSON.stringify(r ?? null))), e => done({error: String(e)}));""", "args": list(args)})

    def switch_to(text):
        """To the tab with `text` in its address, once it is there."""
        for _ in range(100):
            try:
                return into_page(m, text)
            except RuntimeError as e:
                if "no tab with" not in str(e) and "no such window" not in str(e):
                    raise
            time.sleep(0.1)
        raise RuntimeError(f"no tab with {text}")

    def front():
        m.js(H + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes(args[0])); w.focus();
          if (w.gBrowser.selectedTab !== t) { w.__beforeNames ??= w.gBrowser.selectedTab; w.gBrowser.selectedTab = t; await wait(500); }
          return 1;""", PAGE)
        switch_to(PAGE)

    def behind(body, *args):
        """Something that happens beside the open box, from the browser's side, while the page keeps its focus."""
        m.chrome()
        out = m.js(H + body, *args)
        front()
        return out

    # Firefox's notice that an extension hides tabs opens at every hide until you keep them hidden,
    # and takes the focus, which closes an open box. A person answers it once; so does this.
    m.js(H + """const {ExtensionSettingsStore} = ChromeUtils.importESModule("resource://gre/modules/ExtensionSettingsStore.sys.mjs");
      await ExtensionSettingsStore.initialize();
      await ExtensionSettingsStore.addSetting(args[0], "tabHideNotification", args[0], true, () => false);
      for (const w of wins()) for (const p of w.document.querySelectorAll("panel")) if (p.state === "open") p.hidePopup();
      await wait(300); return 1;""", EXT_ID)

    # Two folders, the first only to go away while the box is open, two saved tabs, and a second window.
    more_tabs_here(m, "names")
    setup = sidebar_page(m, UNTIL + """
      const space = spaces().find(s => s.active).id;
      for (const name of ["Above", "Names"]) { send({type: "newFolder", space, name}); await until(() => folders().some(f => f.name === name)); }
      const heads = [...doc.querySelectorAll("#tabs .folder .head")];
      const headOf = name => heads.find(h => h.querySelector(".title").textContent === name).dataset.folderHead;
      // Its own tabs: the first row can be any page, such as a settings page with no record,
      // which can be neither saved nor named, once earlier groups have closed what came before it.
      const mine = new Set(Array.from(await page.browser.tabs.query({})).filter(t => t.url.includes("smoke-names-")).map(t => t.id));
      const tabs = plainTabs().map(x => Number(x.dataset.tab)).filter(id => mine.has(id));
      send({type: "moveTab", tabId: tabs[0], folder: headOf("Names"), before: null});
      await until(() => row(tabs[0])?.dataset.folder);
      const tileEl = doc.querySelector("#essentials .tile");
      return {space, above: headOf("Above"), names: headOf("Names"), saved: tabs[0], plain: tabs[1], tile: Number(tileEl.dataset.tab), tileTitle: tip(tileEl), page: nameOf(tabs[0])};""")
    check("names: a folder with a saved tab to name", setup.get("saved") and setup.get("page") and setup.get("tile"), str(setup))
    m.js(H + """if (!other()) { const w = main().OpenBrowserWindow(); w.__smoke = true; await wait(4000); } return 1;""")
    saved, tile_id, page_title = setup["saved"], setup["tile"], setup["page"]
    front()
    try:
        # Only what is kept, and only from the menu: an ordinary tab opens no box, and a double click neither.
        r = in_front("""
          page.renameKept(args[0]);
          const plain = !!box();
          row(args[1]).dispatchEvent(new page.MouseEvent("dblclick", {bubbles: true}));
          return {plain, dbl: !!box()};""", setup["plain"], saved)
        check("an ordinary tab gets no box, and a double click on a saved tab opens none", r == {"plain": False, "dbl": False}, str(r))

        # A menu item opens the box from inside a real click, which must not take the focus back.
        # Enter on a box you did not change names nothing, or the title would stop following its page.
        at = in_front("""const line = doc.getElementById("space-name"), b = line.getBoundingClientRect();
          line.addEventListener("click", () => page.renameKept(args[0]), {once: true});
          return {x: b.left + b.width / 2, y: b.top + b.height / 2};""", saved)
        click(at["x"], at["y"])
        r = in_front("return state();")
        check("a box opened by a real click has the focus", r.get("open") and r.get("focused"), str(r))
        keys(ENTER)
        r = in_front("await until(() => !box()); await wait(500); return {open: !!box(), name: nameOf(args[0])};", saved)
        m.chrome()
        named = m.js(H + """return Object.values((await storage("%s", ["syncedTabs"])).syncedTabs).filter(e => !e.group && e.name).length;""" % EXT_ID)
        front()
        check("Enter on an unchanged box names nothing", r == {"open": False, "name": page_title} and named == 0, f"{r}, {named}")

        # A saved tab: the box is in its row, the title selected, and nothing moves.
        r = in_front("""
          const was = row(args[0]).getBoundingClientRect().height;
          page.renameKept(args[0]);
          return {...state(), selected: box().selectionEnd - box().selectionStart, inRow: row(args[0]).contains(box()), same: row(args[0]).getBoundingClientRect().height === was};""", saved)
        check("a saved tab's box opens in its row, with its title selected", r.get("focused") and r.get("inRow") and r.get("same") and r.get("value") == page_title and r.get("selected") == len(page_title), str(r))
        keys("Sprint")

        # What happens elsewhere must not touch the box: a new tab, and a folder above it removed
        # (drawing that moves everything below it, which silently takes the focus away).
        behind("""const w = main(), space = w.gBrowser.tabs.find(t => t.userContextId && !t.hidden && !t.pinned).userContextId;
          w.gBrowser.addTrustedTab("https://example.org/?smoke-names-beside", {userContextId: space, inBackground: true}); await wait(2500); return 1;""")
        r = in_front("return state();")
        check("a view that changes nothing here leaves the open box alone", r.get("open") and r.get("focused") and r.get("value") == "Sprint" and r.get("caret") == 6, str(r))

        side = in_front("""
          const port = page.browser.runtime.connect({name: "sidebar"});
          const send = msg => port.postMessage(page.JSON.parse(JSON.stringify(msg)));
          send({type: "hello", windowId: (await page.browser.windows.getCurrent()).id});
          await wait(100);
          send({type: "deleteFolder", key: args[0]});
          await until(() => ![...doc.querySelectorAll("#tabs .folder .head .title")].some(t => t.textContent === "Above"));
          await wait(300);
          const gone = state();
          // And its own folder moving, with the row in it: it has to be moved, and gets the focus back.
          send({type: "newFolder", space: page.document.documentElement.dataset.space, name: "Last"});
          await until(() => [...doc.querySelectorAll("#tabs .folder .head .title")].some(t => t.textContent === "Last"));
          await wait(300);
          send({type: "moveFolder", key: args[1], before: null});
          await until(() => [...doc.querySelectorAll("#tabs .folder")].at(-1).dataset.key === args[1]);
          await wait(300);
          port.disconnect();
          return {gone, moved: state()};""", setup["above"], setup["names"])
        check("a folder above removed leaves the open box alone", side.get("gone", {}).get("open") and side["gone"]["focused"] and side["gone"]["value"] == "Sprint" and side["gone"]["caret"] == 6, str(side))
        check("its own folder moved: the box stays open, with the focus", side.get("moved", {}).get("open") and side["moved"]["focused"] and side["moved"]["value"] == "Sprint", str(side))
        keys(" board", ENTER)
        r = in_front("""await until(() => !box() && tip(row(args[0])) === "Sprint board");
          return {name: nameOf(args[0]), tip: tip(row(args[0])), open: !!box(), renaming: row(args[0]).classList.contains("renaming"), draggable: row(args[0]).draggable, close: !!row(args[0]).querySelector(".close")};""", saved)
        check("Enter saves a saved tab's name, typed with real keys", r == {"name": "Sprint board", "tip": "Sprint board", "open": False, "renaming": False, "draggable": True, "close": True}, str(r))
        m.chrome()
        r = m.js(H + """const named = async () => Object.entries((await storage("%s", ["syncedTabs"])).syncedTabs).find(([, e]) => e.name === "Sprint board")?.[0];
          let k = await named(); for (let i = 0; i < 100 && !k; i++) { await wait(100); k = await named(); }
          const there = () => other().gBrowser.tabs.find(x => key(other(), x) === JSON.stringify(k));
          for (let i = 0; i < 100 && (there()?.label !== "Sprint board" || there()?.linkedPanel); i++) await wait(100);
          const e = (await storage("%s", ["syncedTabs"])).syncedTabs[k];
          return {k, label: there()?.label, loaded: !!there()?.linkedPanel, title: e?.title, name: e?.name};""" % (EXT_ID, EXT_ID))
        check("the name is kept apart from the page's title, and the other window's placeholder takes it and unloads again", r.get("name") == "Sprint board" and r.get("title") == page_title and r.get("label") == "Sprint board" and r.get("loaded") is False, str(r))
        front()

        # Esc cancels; leaving the box saves; empty brings back the page's title.
        in_front("page.renameKept(args[0]); return 1;", saved)
        keys("Not this", ESC)
        r = in_front("""await until(() => !box()); await wait(300); return {name: nameOf(args[0]), open: !!box()};""", saved)
        check("Esc cancels", r == {"name": "Sprint board", "open": False}, str(r))
        in_front("page.renameKept(args[0]); return 1;", saved)
        keys("Elsewhere")
        at = in_front("""const b = doc.getElementById("space-name").getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2};""")
        click(at["x"], at["y"])
        r = in_front("""await until(() => !box() && nameOf(args[0]) === "Elsewhere"); return {name: nameOf(args[0]), open: !!box()};""", saved)
        check("a real click elsewhere saves", r == {"name": "Elsewhere", "open": False}, str(r))
        in_front("page.renameKept(args[0]); return 1;", saved)
        keys(BACKSPACE, ENTER)
        r = in_front("""await until(() => !box() && nameOf(args[0]) === args[1]); return nameOf(args[0]);""", saved, page_title)
        check("an empty box brings back the page's title", r == page_title, str(r))

        # What starts in the box stays there. Text dragged in it (all of it is selected at first) is not its
        # row: a drop on the list would take the tab out of its folder, and its name with it. A folder's box is
        # the same. Headless Firefox starts no drag of its own for a real pointer, so these events are made here.
        # While an input method composes, Enter and Esc are its own.
        drag_in_box = """const dragInBox = over_what => { const data = new page.DataTransfer();
            box().dispatchEvent(new page.DragEvent("dragstart", {bubbles: true, cancelable: true, dataTransfer: data}));
            const over = new page.DragEvent("dragover", {bubbles: true, cancelable: true, dataTransfer: data, clientX: 5, clientY: 5});
            over_what.dispatchEvent(over);
            page.dispatchEvent(new page.DragEvent("dragend", {bubbles: true}));
            return over.defaultPrevented; };"""
        r = in_front(drag_in_box + """
          page.renameKept(args[0]);
          const droppable = dragInBox(doc.getElementById("tabs"));
          for (const key of ["Enter", "Escape"]) box().dispatchEvent(new page.KeyboardEvent("keydown", {key, isComposing: true, bubbles: true}));
          return {droppable, ...state()};""", saved)
        check("text dragged in the box does not pick up its row, and Enter or Esc while composing leave the box open", r.get("droppable") is False and r.get("open") and r.get("focused"), str(r))
        keys(ESC)
        r = in_front(drag_in_box + """await until(() => !box());
          page.rename(args[0]);
          const other = [...doc.querySelectorAll("#tabs .folder")].find(f => f.dataset.key !== args[0]);
          return {droppable: dragInBox(other.querySelector(".head")), open: !!box()};""", setup["names"])
        check("nor in a folder's box", r == {"droppable": False, "open": True}, str(r))
        # And a folder's box keeps the focus when its folder is moved, as a tab's does.
        r = in_front("""
          const port = page.browser.runtime.connect({name: "sidebar"});
          port.postMessage(page.JSON.parse(JSON.stringify({type: "hello", windowId: (await page.browser.windows.getCurrent()).id})));
          await wait(100);
          const keysNow = () => [...doc.querySelectorAll("#tabs .folder")].map(f => f.dataset.key);
          const other = keysNow().find(k => k !== args[0]);
          port.postMessage(page.JSON.parse(JSON.stringify({type: "moveFolder", key: args[0], before: other})));
          await until(() => keysNow()[0] === args[0]);
          await wait(300);
          port.disconnect();
          return state();""", setup["names"])
        check("a folder's box moved with its folder keeps the focus", r.get("open") and r.get("focused"), str(r))
        keys(ESC)
        in_front("await until(() => !box()); return 1;")

        # A tile: the line with the space's name becomes the box, at its height, and the list stays where it was.
        r = in_front("""
          const line = doc.getElementById("space-name"), top = doc.getElementById("tabs").getBoundingClientRect().top, left = line.getBoundingClientRect().left;
          const text = line.textContent;
          page.renameKept(args[0]);
          const b = box()?.getBoundingClientRect();
          return {...state(), id: box()?.id, marked: tile(args[0]).classList.contains("renaming"), shifted: doc.getElementById("tabs").getBoundingClientRect().top - top, lineHidden: line.hidden, text, boxLeft: b?.left, left};""", tile_id)
        check("a tile's box takes the space name's line, and the list stays where it was", r.get("focused") and r.get("id") == "name-box" and r.get("marked") and r.get("shifted") == 0 and r.get("lineHidden") and r.get("value") == setup["tileTitle"] and r.get("boxLeft") == r.get("left"), str(r))
        keys("Ji")
        behind("""const w = main(), space = w.gBrowser.tabs.find(t => t.userContextId && !t.hidden && !t.pinned).userContextId;
          w.gBrowser.addTrustedTab("https://example.org/?smoke-names-beside-2", {userContextId: space, inBackground: true}); await wait(2500); return 1;""")
        r = in_front("""return {...state(), line: doc.getElementById("space-name").hidden, boxes: doc.querySelectorAll("input.rename").length};""")
        check("a view does not disturb a tile's box", r.get("open") and r.get("focused") and r.get("value") == "Ji" and r.get("line") and r.get("boxes") == 1, str(r))
        keys("ra", ENTER)
        r = in_front("""await until(() => !box() && tip(tile(args[0])) === "Jira");
          return {tip: tip(tile(args[0])), open: !!box(), line: doc.getElementById("space-name").hidden, text: doc.getElementById("space-name").textContent, marked: tile(args[0]).classList.contains("renaming")};""", tile_id)
        check("Enter saves a tile's name, shown as its tooltip, and the space's name is back", r.get("tip") == "Jira" and not r.get("open") and not r.get("line") and r.get("text") and not r.get("marked"), str(r))
        m.chrome()

        # Every window: the second window's real sidebar, read through the extension's own views, and
        # its placeholder. It may be in another space, whose essentials are others; then to this one and
        # back. (Not the window you are using, so that selects a placeholder without pulling its tab in.)
        m.js(H + """const S = other().SidebarController;
          if (!S.isOpen) await S.show("_6844a953-9931-4334-9ff6-257c246485cb_-sidebar-action");
          await wait(800); return 1;""")
        front()
        r = in_front("""const here = (await page.browser.windows.getCurrent()).id;
          const there = (await page.browser.windows.getAll({windowTypes: ["normal"]})).find(w => w.id !== here).id;
          const [view] = page.browser.extension.getViews({type: "sidebar", windowId: there});
          const second = (view.wrappedJSObject || view).document;
          const names = () => [...second.querySelectorAll("#essentials .tile")].map(tip);
          const button = id => second.querySelector(`#spaces .space[data-space="${id}"]`);
          const was = await until(() => second.documentElement.dataset.space);
          if (was !== args[0]) button(args[0]).click();
          await until(() => names().includes("Jira"));
          const seen = names();
          if (was !== args[0]) button(was).click();
          await until(() => second.documentElement.dataset.space === was);
          return seen;""", setup["space"])
        check("a second window's sidebar shows the same name", "Jira" in (r or []), str(r))
        m.chrome()
        r = m.js(H + """const list = (await storage("%s", ["essentials"])).essentials, e = list.find(x => x.name === "Jira");
          const there = () => other().gBrowser.tabs.find(t => t.pinned && ek(other(), t) === e?.key);
          for (let i = 0; i < 100 && (there()?.label !== "Jira" || there()?.linkedPanel); i++) await wait(100);
          return {name: e?.name, title: e?.title, label: there()?.label, loaded: !!there()?.linkedPanel};""" % EXT_ID)
        check("an essential's name is in its list entry, and its placeholder in the other window takes it and unloads again", r.get("name") == "Jira" and r.get("label") == "Jira" and r.get("loaded") is False, str(r))
        front()
        in_front("page.renameKept(args[0]); return 1;", tile_id)
        keys(BACKSPACE, ENTER)
        r = in_front("""await until(() => !box() && tip(tile(args[0])) !== "Jira"); return tip(tile(args[0]));""", tile_id)
        check("an empty box brings back an essential's title", r == setup["tileTitle"], str(r))

        # What is being named goes away without the box losing the focus: an essential unpinned
        # from another window, or (in a real sidebar, which stays in front) a space left by a key.
        # A box left open here would be a line that never comes back.
        r = in_front("""
          const port = page.browser.runtime.connect({name: "sidebar"});
          page.__names = {port, send: msg => port.postMessage(page.JSON.parse(JSON.stringify(msg)))};
          page.__names.send({type: "hello", windowId: (await page.browser.windows.getCurrent()).id});
          await wait(100);
          page.__names.send({type: "pin", tabId: args[0], pinned: true});
          return !!(await until(() => tile(args[0])));""", setup["plain"])
        check("names: another essential to lose", r is True, str(r))
        in_front("page.renameKept(args[0]); return 1;", setup["plain"])
        keys("Typed")
        r = in_front("""
          page.__names.send({type: "pin", tabId: args[0], pinned: false});
          await until(() => !tile(args[0]) && !box());
          const out = {open: !!box(), line: doc.getElementById("space-name").hidden};
          await until(() => row(args[0])?.title && tip(row(args[0])) !== "Typed", 5000);
          page.__names.port.disconnect();
          return {...out, tip: tip(row(args[0]))};""", setup["plain"])
        check("what is being named goes away: the box closes, and an ordinary tab has no name", r.get("open") is False and r.get("line") is False and r.get("tip") and r.get("tip") != "Typed", str(r))

        # The same in the real sidebar, which a page in a tab cannot stand in for: the page beside it can
        # take the focus, and a key can take its space away. Its contents can be read through the extension's
        # own views. Tidier's menu is another file's; here a real click on the name line stands in for its item.
        m.chrome()
        panel = lambda script, *args: sidebar_page(m, """
          const [view] = page.browser.extension.getViews({type: "sidebar", windowId: (await page.browser.windows.getCurrent()).id});
          const side = view.wrappedJSObject || view;
          return await (async doc => { """ + UNTIL + script + """ })(side.document);""", *args)
        base = m.js(H + """const w = main(); w.focus(); await wait(300);
          for (const p of w.document.querySelectorAll("panel, menupopup")) if (p.state === "open") p.hidePopup();
          await wait(300); const r = w.SidebarController.browser.getBoundingClientRect(); return {x: r.left, y: r.top, right: r.right};""")

        def open_in_panel(tab):
            at = panel("""const line = doc.getElementById("space-name"), b = line.getBoundingClientRect();
              line.addEventListener("click", () => side.renameKept(args[0]), {once: true});
              return {x: b.left + b.width / 2, y: b.top + b.height / 2};""", tab)
            click(base["x"] + at["x"], base["y"] + at["y"])

        def press_in_box_release_on_icon(button):
            at = panel("""const b = box().getBoundingClientRect(), i = row(args[0]).querySelector("img, .letter").getBoundingClientRect();
              return {x0: b.left + 20, y0: b.top + b.height / 2, x1: i.left + 4, y1: i.top + i.height / 2};""", saved)
            m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
                {"type": "pointerMove", "x": int(base["x"] + at["x0"]), "y": int(base["y"] + at["y0"]), "duration": 0, "origin": "viewport"}, {"type": "pointerDown", "button": button},
                {"type": "pointerMove", "x": int(base["x"] + at["x1"]), "y": int(base["y"] + at["y1"]), "duration": 50, "origin": "viewport"}, {"type": "pointerUp", "button": button}]}]})
            m.cmd("WebDriver:ReleaseActions")

        open_in_panel(saved)
        r = panel("return {...state(), document: doc.hasFocus()};")
        check("in the real sidebar, a real click opens the box, and the focus is really in it", r.get("focused") and r.get("document"), str(r))
        keys("In the panel", ENTER)
        r = panel("""await until(() => !box() && tip(row(args[0])) === "In the panel"); return {open: !!box(), tip: tip(row(args[0]))};""", saved)
        check("in the real sidebar, real keys type the name and Enter saves it", r == {"open": False, "tip": "In the panel"}, str(r))

        # A press in the box and a release beside it, on its row: a middle click there would close the tab.
        selected = """const w = main(); return w.gBrowser.selectedTab.linkedPanel;"""
        before = m.js(H + selected)
        open_in_panel(saved)
        press_in_box_release_on_icon(1)
        press_in_box_release_on_icon(0)
        r = panel("""await wait(500); return {...state(), there: !!row(args[0])};""", saved)
        check("in the real sidebar, a press in the box and a release on its row neither close nor select the tab", r.get("open") and r.get("there") and r.get("focused") and m.js(H + selected) == before, str(r))

        # The page beside it takes the focus: what was typed is saved, and the box is gone.
        panel("box().select(); return 1;")
        keys("Left for the page")
        free = sidebar_page(m, """return [...doc.querySelectorAll("#tabs .row")].at(-1).getBoundingClientRect().bottom + 40;""")
        click(base["right"] + 300, base["y"] + free)
        r = panel("""await until(() => !box() && tip(row(args[0])) === "Left for the page"); return {open: !!box(), tip: tip(row(args[0]))};""", saved)
        check("in the real sidebar, a real click in the page saves what was typed", r == {"open": False, "tip": "Left for the page"}, str(r))

        # A space left by a real key closes a tile's box, whose line would otherwise never come back.
        m.js(H + """main().focus(); await wait(200); return 1;""")
        open_in_panel(tile_id)
        keys("Short")
        at = panel("""return {index: [...doc.querySelectorAll("#spaces .space")].findIndex(s => s.classList.contains("active")), name: doc.getElementById("space-name").textContent, ...state()};""")
        press(m, "2" if at["index"] == 0 else "1", CTRL)
        r = panel("""await until(() => !box()); await until(() => doc.getElementById("space-name").textContent !== args[0]);
          return {open: !!box(), hidden: doc.getElementById("space-name").hidden, text: doc.getElementById("space-name").textContent};""", at["name"])
        check("in the real sidebar, a space left by a key closes a tile's box and its line is back", r.get("open") is False and r.get("hidden") is False and r.get("text") and r.get("text") != at["name"], str(r))
        press(m, str(at["index"] + 1), CTRL)
        r = panel("""await until(() => tip(tile(args[0])) === "Short"); const out = tip(tile(args[0]));
          send({type: "renameTab", tabId: args[0], name: ""}); await until(() => tip(tile(args[0])) !== "Short"); return out;""", tile_id)
        check("what was typed before the space was left is saved", r == "Short", str(r))
        r = m.js(H + """const loaded = () => other().gBrowser.tabs.filter(t => !t.selected && url(t).includes("ghost.html") && t.linkedPanel).map(t => t.label);
          for (let i = 0; i < 150 && loaded().length; i++) await wait(100);
          return loaded();""")
        check("all this naming left no placeholder loaded in the second window", r == [], str(r))
    finally:
        m.chrome()
        m.js(H + """const w = main(); if (w.__beforeNames && !w.__beforeNames.closing) w.gBrowser.selectedTab = w.__beforeNames; delete w.__beforeNames; await wait(500); return 1;""")
    sidebar_page(m, """const heads = [...doc.querySelectorAll("#tabs .folder")].filter(f => ["Names", "Last", "Above"].includes(f.querySelector(".head .title").textContent));
      for (const f of heads) send({type: "deleteFolder", key: f.dataset.key});
      await wait(4500);""")  # a tab that lost its name tells its placeholders a moment later (refreshGhostsSoon)


# What the selection's checks do in the sidebar: real events on the real rows, carrying
# the modifier this machine uses, and waits for a state rather than for a time.
PICKING = """
      const MOD = (await page.browser.runtime.getPlatformInfo()).os === "mac" ? "metaKey" : "ctrlKey";
      const press = (e, mods = {}) => { for (const type of ["mousedown", "mouseup", "click"]) e.dispatchEvent(new page.MouseEvent(type, {bubbles: true, cancelable: true, button: 0, ...mods})); };
      const add = e => press(e, {[MOD]: true}), range = e => press(e, {shiftKey: true});
      const idOf = e => Number(e.dataset.tab);
      const picks = () => [...doc.querySelectorAll(".picked")].map(idOf);
      const row = id => doc.querySelector(`#tabs .tab[data-tab="${id}"]`), tile = id => doc.querySelector(`#essentials .tile[data-tab="${id}"]`);
      const ids = () => plainTabs().map(idOf), tileIds = () => [...doc.querySelectorAll("#essentials .tile")].map(idOf);
      const head = name => [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === name);
      const inFolder = name => [...head(name).parentElement.querySelectorAll(".tab")].map(idOf);
      const activeId = async () => (await page.browser.tabs.query({active: true, currentWindow: true}))[0].id;
      const activeSpace = () => spaces().find(s => s.active).id;
      const until = async (test, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (test()) return true; await wait(50); } return !!test(); };
      const key = k => doc.body.dispatchEvent(new page.KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const select = async e => { const id = idOf(e); press(e); await until(() => (row(id) || tile(id))?.classList.contains("active")); };
      const keysOf = list => Promise.all(list.map(id => page.browser.sessions.getTabValue(id, "syncKey")));
      const drag = (from, to, below = false, right = false) => {
        const data = new page.DataTransfer(), box = to.getBoundingClientRect();
        const at = {bubbles: true, cancelable: true, clientX: right ? box.right - 2 : box.left + 5, clientY: box.top + (below ? box.height - 1 : 1), dataTransfer: data};
        from.dispatchEvent(new page.DragEvent("dragstart", at));
        to.dispatchEvent(new page.DragEvent("dragover", at));
        to.dispatchEvent(new page.DragEvent("drop", at));
        from.dispatchEvent(new page.DragEvent("dragend", at));
      };
"""


def order_everywhere(m, keys):
    """Each window's order of these tabs, once it is as wanted (or the time is up)."""
    return m.js(H + """const [want] = args; let got;
      for (let i = 0; i < 100; i++) {
        got = wins().map(w => w.gBrowser.tabs.map(t => value(w, t, "syncKey")).filter(k => want.includes(k)));
        if (got.every(g => JSON.stringify(g) === JSON.stringify(want))) break;
        await wait(100);
      }
      return got;""", keys)


def alone_selection(m):
    # Tabs to use up: at once, so this group need not wait for each lot. The last two
    # are opened in the second window, so here they are placeholders.
    space = sidebar_page(m, """return spaces().find(s => s.active).id;""")
    fresh = m.js(H + """const ctx = Number(args[0].split("-").pop());
      if (!other()) { const w = main().OpenBrowserWindow(); w.__smoke = true; await wait(4000); }
      main().focus();
      for (let i = 0; i < 28; i++) { (i < 26 ? main() : other()).gBrowser.addTrustedTab("https://example.org/?smoke-pick-" + i, {userContextId: ctx, inBackground: true}); await wait(100); }
      let keys;
      for (let i = 0; i < 300; i++) {  // until each window has all of them, with a record
        const all = (await storage(args[1], ["syncedTabs"])).syncedTabs;
        keys = Object.keys(all).filter(k => (all[k].url || "").includes("smoke-pick"));
        if (keys.length === 28 && wins().every(w => w.gBrowser.tabs.filter(t => keys.includes(value(w, t, "syncKey"))).length === 28)) break;
        await wait(100);
      }
      return keys;""", space, EXT_ID)
    r = sidebar_page(m, PICKING + """
      // The test's own page is a row too: last, out of the way.
      const own = [...doc.querySelectorAll("#tabs > .tab")].find(x => x.querySelector(".title").textContent === "Tidier");
      if (own) { send({type: "moveTab", tabId: idOf(own), before: null, folder: null}); await until(() => [...doc.querySelectorAll("#tabs > .tab")].at(-1) === own); }
      const space = activeSpace();
      send({type: "newFolder", space, name: "Picks"});
      await until(() => head("Picks"));
      send({type: "newFolder", space, name: "Picks closed"});
      await until(() => head("Picks closed"));
      const rowsNow = ids(), rowKeys = await keysOf(rowsNow), fresh = rowsNow.filter((id, i) => args[0].includes(rowKeys[i]));
      const unloaded = id => row(id).classList.contains("unloaded");
      const [f1, f2, g1, r0, r1, r2, r3, r4, r5, a, b, c, d, e, f, y1, y2, y3, s1, s2, s3, h1, h2, h3, h4, h5] = fresh.filter(id => !unloaded(id)), [p1, p2] = fresh.filter(unloaded);
      const open = head("Picks").dataset.folderHead, closed = head("Picks closed").dataset.folderHead;
      send({type: "moveTab", tabId: f1, before: null, folder: open});
      send({type: "moveTab", tabId: f2, before: null, folder: open});
      send({type: "moveTab", tabId: g1, before: null, folder: closed});
      await until(() => inFolder("Picks").length === 2 && inFolder("Picks closed").length === 1);
      send({type: "foldFolder", key: closed, collapsed: true});
      await until(() => head("Picks closed").parentElement.classList.contains("collapsed"));
      const out = {};

      // Add and remove; the first click takes the selected tab in; the page stays.
      await select(row(r0));
      const selected = await activeId();
      out.selectedFirst = selected === r0;
      add(row(r2));
      out.first = same(picks(), [r0, r2]);
      add(row(r3));
      out.added = same(picks(), [r0, r2, r3]);
      add(row(r2));
      out.removed = same(picks(), [r0, r3]);
      out.forMenu = same(Array.from(page.selectedTabs(r3)), [r0, r3]) && same(Array.from(page.selectedTabs(r1)), [r1]);
      await wait(400);
      out.pageStays = (await activeId()) === selected && row(r0).classList.contains("active");

      // A press on a picked row keeps them until release, and a plain click then ends it.
      row(r3).dispatchEvent(new page.MouseEvent("mousedown", {bubbles: true, cancelable: true, button: 0}));
      out.pressed = same(picks(), [r0, r3]);
      row(r3).dispatchEvent(new page.MouseEvent("mouseup", {bubbles: true, cancelable: true, button: 0}));
      row(r3).dispatchEvent(new page.MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
      out.released = picks().length === 0;
      await until(() => row(r3).classList.contains("active"));
      out.plainSelects = (await activeId()) === r3;

      // A range: from the selected tab, again from there, over a folder as drawn.
      range(row(r5));
      out.range = same(picks(), [r3, r4, r5]);
      range(row(r1));
      out.rangeAgain = same(picks(), [r1, r2, r3]);
      range(row(f1));
      out.overFolders = same(picks(), [f1, f2, ...ids().slice(0, ids().indexOf(r3) + 1)]);
      out.notClosedFolder = !picks().includes(g1) && !doc.querySelector(".folder.collapsed .picked");
      await wait(400);
      out.pageStaysRange = (await activeId()) === r3;

      // What clears: empty space, Esc after the menu, a space switch.
      press(doc.getElementById("tabs"));
      out.emptySpace = picks().length === 0;
      add(row(r1));
      doc.getElementById("menu").hidden = false;
      key("Escape");
      out.escMenu = doc.getElementById("menu").hidden && same(picks(), [r1, r3]);
      key("Escape");
      out.escPicks = picks().length === 0;
      key("ArrowDown");
      const hadCursor = !!doc.querySelector(".cursor");
      key("Escape");
      out.escCursor = hadCursor && !doc.querySelector(".cursor");
      add(row(r2));
      const there = spaces().find(s => !s.active && s.id !== "firefox-container-4").id;
      const hadPicks = picks().length === 2;
      send({type: "space", space: there});
      await until(() => activeSpace() === there);
      out.spaceSwitch = hadPicks && picks().length === 0;
      send({type: "space", space});
      await until(() => activeSpace() === space && row(r3)?.classList.contains("active"));
      out.spaceBack = picks().length === 0;

      // Another tab selected by other means than a click here: you have moved on.
      add(row(r2));
      const hadThem = same(picks(), [r2, r3]);
      await page.browser.tabs.update(r1, {active: true});
      await until(() => row(r1).classList.contains("active") && !picks().length);
      out.movedOn = hadThem && picks().length === 0;
      await select(row(r3));

      // One kind: a tile and a row cannot both be picked.
      add(row(r2));
      add(doc.querySelector("#essentials .tile"));
      out.tileAlone = doc.querySelectorAll(".tile.picked").length === 1 && !doc.querySelector(".tab.picked");
      range(row(r2));
      out.rowsAlone = !doc.querySelector(".tile.picked") && same(picks(), [r2, r3]);

      // A row drawn again keeps its mark.
      send({type: "mute", tabId: r2, muted: true});
      await until(() => row(r2).querySelector(".sound"));
      out.redraw = !!row(r2).querySelector(".sound") && same(picks(), [r2, r3]);
      send({type: "mute", tabId: r2, muted: false});
      await until(() => !row(r2).querySelector(".sound"));
      out.redrawBack = same(picks(), [r2, r3]);

      // A row in a folder you close leaves the selection: nothing acts on what you cannot see.
      add(row(f1));
      const hadF1 = picks().includes(f1);
      send({type: "foldFolder", key: open, collapsed: true});
      await until(() => !picks().includes(f1));
      out.foldLeaves = hadF1 && same(picks(), [r2, r3]);
      send({type: "foldFolder", key: open, collapsed: false});
      await until(() => !head("Picks").parentElement.classList.contains("collapsed"));
      out.unfoldStaysOut = same(picks(), [r2, r3]);
      key("Escape");
      return {out, f1, f2, g1, r0, r1, r2, r3, r4, r5, a, b, c, d, e, f, y1, y2, y3, s1, s2, s3, h1, h2, h3, h4, h5, p1, p2, space, there, open, closed};""", fresh)
    out = r.get("out", {})
    check("the first ⌘-click takes the selected tab in", out.get("selectedFirst") and out.get("first"), str(r))
    check("⌘-click adds and removes", out.get("added") and out.get("removed"), str(out))
    check("the tab menu's list is the selection if the tab is in it, else that tab", out.get("forMenu"), str(out))
    check("the selected page does not change while you pick", out.get("pageStays") and out.get("pageStaysRange"), str(out))
    check("a press on a picked row keeps the selection until release; a plain click then ends it and selects", out.get("pressed") and out.get("released") and out.get("plainSelects"), str(out))
    check("⇧-click takes a range from the selected tab, and again changes it", out.get("range") and out.get("rangeAgain"), str(out))
    check("a range goes over the rows as drawn, past a folder, not into a closed one", out.get("overFolders") and out.get("notClosedFolder"), str(out))
    check("a click on empty space clears", out.get("emptySpace"), str(out))
    check("Esc goes back a step at a time: menu, selection, cursor", out.get("escMenu") and out.get("escPicks") and out.get("escCursor"), str(out))
    check("a space switch clears", out.get("spaceSwitch") and out.get("spaceBack"), str(out))
    check("another tab selected (⌃Tab, a link) ends the selection", out.get("movedOn"), str(out))
    check("a tile and a row cannot both be picked", out.get("tileAlone") and out.get("rowsAlone"), str(out))
    check("the selection survives a redraw", out.get("redraw") and out.get("redrawBack"), str(out))
    check("a row in a folder you close leaves the selection", out.get("foldLeaves") and out.get("unfoldStaysOut"), str(out))
    tabs = {k: v for k, v in r.items() if k != "out"}

    # Carrying: three rows that are not together go into a folder, in order, in every window.
    r = sidebar_page(m, PICKING + """
      const [{f1, f2, r0, r2, r3}] = args, out = {};
      await select(doc.querySelector("#essentials .tile"));
      add(row(r0)); add(row(r2)); add(row(r3));
      out.picked = same(picks(), [r0, r2, r3]);
      drag(row(r2), head("Picks"));
      await until(() => inFolder("Picks").length === 5);
      out.intoFolder = same(inFolder("Picks"), [f1, f2, r0, r2, r3]);
      out.stillPicked = same(picks(), [r0, r2, r3]);
      return {out, keys: await keysOf([f1, f2, r0, r2, r3])};""", tabs)
    out = r.get("out", {})
    check("a drag from a picked row carries them all into a folder, in order", out.get("picked") and out.get("intoFolder") and out.get("stillPicked"), str(r))
    got = order_everywhere(m, r.get("keys"))
    check("a second window has the same order in the folder", len(got) > 1 and all(g == r.get("keys") for g in got), str(got))

    # Out of the folder to a place; a row that is not picked moves alone; dropped on their own, the order holds.
    r = sidebar_page(m, PICKING + """
      const [{f1, f2, r0, r1, r2, r3, r4, r5}] = args, out = {};
      const mine = () => ids().filter(x => [r0, r1, r2, r3, r4, r5].includes(x));
      drag(row(r0), row(r1));
      await until(() => inFolder("Picks").length === 2 && same(mine(), [r0, r2, r3, r1, r4, r5]));
      out.outOfFolder = same(inFolder("Picks"), [f1, f2]) && same(mine(), [r0, r2, r3, r1, r4, r5]);
      drag(row(r4), row(r0));
      await until(() => same(mine(), [r4, r0, r2, r3, r1, r5]));
      out.loneRow = same(mine(), [r4, r0, r2, r3, r1, r5]) && same(picks(), [r0, r2, r3]);
      drag(row(r0), row(r3), true);
      await wait(800);
      out.ontoOwn = same(mine(), [r4, r0, r2, r3, r1, r5]) && same(picks(), [r0, r2, r3]);
      add(row(r5));
      drag(row(r5), row(r2), true);
      await until(() => same(mine(), [r4, r0, r2, r3, r5, r1]));
      out.gathered = same(mine(), [r4, r0, r2, r3, r5, r1]);
      // A row with no record (the test's own page, like a new tab page) is a place too.
      const own = [...doc.querySelectorAll("#tabs > .tab")].at(-1);
      drag(row(r4), own);
      await until(() => row(r4).nextElementSibling === own);
      out.beforeUnsynced = row(r4).nextElementSibling === own;
      return {out, keys: await keysOf(mine())};""", tabs)
    out = r.get("out", {})
    check("picked rows dragged out of a folder are ordinary tabs, in order, where you put them", out.get("outOfFolder"), str(r))
    check("a row that is not picked moves alone, and the selection stays", out.get("loneRow"), str(out))
    check("dropped on themselves, picked rows stay as they were", out.get("ontoOwn"), str(out))
    check("picked rows apart are brought together where you drop them", out.get("gathered"), str(out))
    check("a tab dropped above a row with no record lands there", out.get("beforeUnsynced"), str(out))
    got = order_everywhere(m, r.get("keys"))
    check("a second window has the same order of the tabs", len(got) > 1 and all(g == r.get("keys") for g in got), str(got))

    # To a space's dot, the selected tab among them: there in order, in every window, and you stay.
    r = sidebar_page(m, PICKING + """
      const [{r0, r2, r3}] = args;
      press(doc.getElementById("tabs"));
      await select(row(r0));
      add(row(r2)); add(row(r3));
      return {picked: same(picks(), [r0, r2, r3]), keys: await keysOf([r0, r2, r3])};""", tabs)
    urls = m.js(H + """const all = (await storage(args[1], ["syncedTabs"])).syncedTabs; return args[0].map(k => all[k]?.url);""", r.get("keys"), EXT_ID)
    r = sidebar_page(m, PICKING + """
      const [{r0, r2, r3, space, there}] = args;
      drag(row(r2), doc.querySelector(`#spaces .space[data-space="${there}"]`));
      await until(() => !row(r0) && !row(r2) && !row(r3));
      await until(() => tileIds().length && doc.querySelector(".active"));
      return {gone: !row(r0) && !row(r2) && !row(r3), stayed: activeSpace() === space, picks: picks().length};""", tabs)
    check("picked rows dragged to a space's dot leave this space, and you stay", r.get("gone") and r.get("stayed") and r.get("picks") == 0, str(r))
    moved = m.js(H + """const [urls, ctx, ext] = args, wanted = JSON.stringify(urls); let got;
      for (let i = 0; i < 100; i++) {
        const all = (await storage(ext, ["syncedTabs"])).syncedTabs;
        got = wins().map(w => w.gBrowser.tabs.filter(t => urls.includes(all[value(w, t, "syncKey")]?.url) && t.userContextId === ctx).map(t => all[value(w, t, "syncKey")].url));
        if (got.every(g => JSON.stringify(g) === wanted)) break;
        await wait(100);
      }
      return got;""", urls, int(tabs["there"].split("-")[-1]), EXT_ID)
    check("they are in the other space in order, in every window", len(moved) > 1 and all(g == urls for g in moved), str(moved))

    # Closing: ⌫ with the selected tab among them; × and a middle click; another row's own ×.
    r = sidebar_page(m, PICKING + """
      const [{r1, r4, r5, space}] = args;
      await select(row(r1));
      add(row(r4)); add(row(r5));
      const had = same(picks(), [r5, r1, r4]);
      key("Backspace");
      await until(() => !row(r1) && !row(r4) && !row(r5));
      await until(() => doc.querySelector(".active"));
      return {had, gone: !row(r1) && !row(r4) && !row(r5), stayed: activeSpace() === space, picks: picks().length};""", tabs)
    check("⌫ closes all picked rows, and you stay in the space", r.get("had") and r.get("gone") and r.get("stayed") and r.get("picks") == 0, str(r))
    r = sidebar_page(m, PICKING + """
      const [{a, b, c, d, e, f}] = args, out = {};
      await select(doc.querySelector("#essentials .tile"));
      add(row(a)); add(row(b));
      press(row(c).querySelector(".close"));
      await until(() => !row(c));
      out.ownClose = !row(c) && same(picks(), [a, b]);
      press(row(a).querySelector(".close"));
      await until(() => !row(a) && !row(b));
      out.close = !row(a) && !row(b) && picks().length === 0;
      add(row(d)); add(row(e));
      row(e).dispatchEvent(new page.MouseEvent("auxclick", {bubbles: true, cancelable: true, button: 1}));
      await until(() => !row(d) && !row(e));
      out.middle = !row(d) && !row(e) && !!row(f) && picks().length === 0;
      row(f).dispatchEvent(new page.MouseEvent("auxclick", {bubbles: true, cancelable: true, button: 1}));
      await until(() => !row(f));
      out.middleOne = !row(f);
      return out;""", tabs)
    check("× on a row that is not picked closes that row only", r.get("ownClose"), str(r))
    check("× on a picked row closes them all", r.get("close"), str(r))
    check("a middle click on a picked row closes them all", r.get("middle"), str(r))
    check("a middle click with nothing picked closes that row", r.get("middleOne"), str(r))

    # Saved tabs closed together come back as placeholders where they were, here and elsewhere.
    r = sidebar_page(m, PICKING + """
      const [{f1, f2, s1, s2, s3, open}] = args;
      for (const tabId of [s1, s2, s3]) send({type: "moveTab", tabId, before: f2, folder: open});
      await until(() => same(inFolder("Picks"), [f1, s1, s2, s3, f2]));
      const keys = await keysOf(inFolder("Picks"));
      await wait(300);
      await select(row(s2));
      add(row(s1)); add(row(s3));
      const had = same(picks(), [s1, s2, s3]);
      key("Backspace");
      await until(() => ![s1, s2, s3].some(row) && inFolder("Picks").length === 5);
      let got;
      for (let i = 0; i < 100; i++) { got = await keysOf(inFolder("Picks")); if (same(got, keys)) break; await wait(100); }
      await until(() => doc.querySelector(".active"));
      return {had, keys, got, unloaded: inFolder("Picks").slice(1, 4).every(id => row(id).classList.contains("unloaded"))};""", tabs)
    check("saved tabs closed together are unloaded where they were, in order", r.get("had") and r.get("keys") == r.get("got") and r.get("unloaded"), str(r))
    got = order_everywhere(m, r.get("keys"))
    check("a second window has the same order in the folder after closing them", len(got) > 1 and all(g == r.get("keys") for g in got), str(got))

    # What is left behind by a row that goes at the wrong moment.
    r = sidebar_page(m, PICKING + """
      const [{h1, h2, h3, h4, h5}] = args, out = {};
      await select(doc.querySelector("#essentials .tile"));
      add(row(h2)); add(row(h3));
      for (let i = 0; i < 80 && !doc.querySelector(`.cursor[data-tab="${h1}"]`); i++) key("ArrowDown");
      out.cursorOn = !!doc.querySelector(`.cursor[data-tab="${h1}"]`);
      send({type: "close", tabId: h1});
      await until(() => !row(h1) && !doc.querySelector(".cursor"));
      out.cursorGone = !doc.querySelector(".cursor");
      const tiles0 = tileIds().length;
      key("Backspace");
      await until(() => !row(h2) && !row(h3));
      out.backspace = !row(h2) && !row(h3) && tileIds().length === tiles0;
      add(row(h4)); add(row(h5));
      const carrying = () => doc.documentElement.classList.contains("carrying");
      row(h4).dispatchEvent(new page.DragEvent("dragstart", {bubbles: true, cancelable: true, dataTransfer: new page.DataTransfer()}));
      await until(carrying);
      out.carrying = carrying();
      send({type: "close", tabId: h4});
      await until(() => !row(h4) && !carrying());
      out.notFaded = !carrying() && same(picks(), [h5]);
      key("Escape");
      return out;""", tabs)
    check("a cursor on a tab that has gone is gone too, and ⌫ closes the picked rows, not another", r.get("cursorOn") and r.get("cursorGone") and r.get("backspace"), str(r))
    check("the row you drag closes meanwhile: the others do not stay faded", r.get("carrying") and r.get("notFaded"), str(r))

    # The selected tab, and placeholders Firefox would select in turn: all closed, in every window.
    r = sidebar_page(m, PICKING + """
      const [{y3, p1, p2}] = args;
      const placeholders = row(p1).classList.contains("unloaded") && row(p2).classList.contains("unloaded");
      await select(row(y3));
      add(row(p1)); add(row(p2));
      const keys = await keysOf([y3, p1, p2]);
      key("Backspace");
      await until(() => !row(y3) && !row(p1) && !row(p2));
      return {placeholders, keys, gone: !row(y3) && !row(p1) && !row(p2)};""", tabs)
    left = m.js(H + """const [keys] = args; let left;
      for (let i = 0; i < 100; i++) { left = wins().flatMap(w => w.gBrowser.tabs.filter(t => keys.includes(value(w, t, "syncKey")))).length; if (!left) break; await wait(100); }
      return left;""", r.get("keys"))
    check("closing the selected tab and placeholders together closes them all, in every window", r.get("placeholders") and r.get("gone") and left == 0, str([r, left]))

    # Essentials: two rows to the essentials, the two tiles among them, and back, each in order.
    r = sidebar_page(m, PICKING + """
      const [{y1, y2}] = args, out = {};
      await select(doc.querySelector("#essentials .tile"));
      const tiles0 = tileIds();
      add(row(y1)); add(row(y2));
      out.rowsOnly = same(picks(), [y1, y2]);
      out.keys = await keysOf([y1, y2]);
      // Carried, and at once on to the essentials: the selection stays after a drop for this.
      drag(row(y1), doc.getElementById("tabs"));
      drag(row(y1), tile(tiles0.at(-1)), false, true);  // on the right of the last tile: after it
      await until(() => tileIds().length === tiles0.length + 2);
      out.pinned = same(tileIds(), [...tiles0, y1, y2]);
      out.pinnedLeft = picks().length === 0;
      await select(plainTabs()[0]);
      add(tile(y1)); add(tile(y2));
      out.tilesOnly = same(picks(), [y1, y2]);
      drag(tile(y2), tile(tiles0[0]));
      await until(() => same(tileIds(), [y1, y2, ...tiles0]));
      out.tilesMoved = same(tileIds(), [y1, y2, ...tiles0]);
      return out;""", tabs)
    check("picked rows dragged to the essentials are essentials, in order", r.get("rowsOnly") and r.get("pinned") and r.get("pinnedLeft"), str(r))
    left = m.js(H + """const [keys, ext] = args; let left;
      for (let i = 0; i < 100; i++) {
        const all = (await storage(ext, ["syncedTabs"])).syncedTabs;
        left = {records: keys.filter(k => all[k]).length, tabs: wins().flatMap(w => w.gBrowser.tabs.filter(t => keys.includes(value(w, t, "syncKey")))).length};
        if (!left.records && !left.tabs) break;
        await wait(100);
      }
      return left;""", r.get("keys"), EXT_ID)
    check("carried and at once dragged to the essentials, they are not ordinary tabs as well", left == {"records": 0, "tabs": 0}, str(left))
    check("picked essentials dragged among the essentials stay in order", r.get("tilesOnly") and r.get("tilesMoved"), str(r))
    pins = m.js(H + """let got;
      for (let i = 0; i < 100; i++) { got = wins().map(w => w.gBrowser.tabs.filter(t => t.pinned).map(t => ek(w, t))); if (got.every(g => JSON.stringify(g) === JSON.stringify(got[0]))) break; await wait(100); }
      return got;""")
    check("a second window has the same order of essentials", len(pins) > 1 and all(g == pins[0] for g in pins), str(pins))
    # Closed together, with the selected one: back in their places, unloaded, once each.
    r = sidebar_page(m, PICKING + """
      const [{y1, y2}] = args, before = tileIds(), two = before.filter(id => id !== y1 && id !== y2).slice(0, 2);
      await select(tile(two[0]));
      add(tile(two[1]));
      const had = same(picks(), two);
      key("Backspace");
      await until(() => tileIds().length === before.length && !two.some(tile));
      await until(() => tileIds().every(id => tile(id)) && doc.querySelector(".active"));
      const at = tileIds();
      return {had, n: at.length === before.length, kept: at.includes(y1) && at.includes(y2), unloaded: at.filter(id => !before.includes(id)).every(id => tile(id).classList.contains("unloaded"))};""", tabs)
    back = m.js(H + """const [want] = args; let got;
      for (let i = 0; i < 100; i++) { got = wins().map(w => w.gBrowser.tabs.filter(t => t.pinned).map(t => ek(w, t))); if (got.every(g => JSON.stringify(g) === JSON.stringify(want))) break; await wait(100); }
      return got;""", pins[0])
    check("picked essentials closed together come back in their places, unloaded, once each", r.get("had") and r.get("n") and r.get("kept") and r.get("unloaded") and all(g == pins[0] for g in back), str([r, back]))
    r = sidebar_page(m, PICKING + """
      const [{y1, y2}] = args, tiles0 = tileIds().length;
      await select(plainTabs()[0]);
      add(tile(y1)); add(tile(y2));
      drag(tile(y1), doc.getElementById("tabs"));
      await until(() => tileIds().length === tiles0 - 2 && row(y1) && row(y2));
      const list = ids();
      let keys;
      for (let i = 0; i < 100; i++) { keys = await keysOf([y1, y2]); if (keys.every(Boolean)) break; await wait(100); }
      return {back: !!row(y1) && !!row(y2) && list.indexOf(y2) === list.indexOf(y1) + 1, list, y1, y2, keys};""", tabs)
    check("picked essentials dragged to the list are ordinary tabs, in order", r.get("back"), str(r))
    got = order_everywhere(m, r.get("keys"))
    check("a second window has them in the same order", len(got) > 1 and all(g == r.get("keys") for g in got), str(got))

    # What this group added goes again.
    sidebar_page(m, PICKING + """
      const [{f1, f2, g1, y1, y2, open, closed}] = args;
      send({type: "deleteFolder", key: open});
      send({type: "deleteFolder", key: closed});
      await until(() => !head("Picks") && !head("Picks closed"));
      for (const tabId of [f1, f2, g1, y1, y2]) send({type: "close", tabId});
      await until(() => ![f1, f2, g1, y1, y2].some(row));
      return 1;""", tabs)
    m.js(H + """const all = (await storage(args[0], ["syncedTabs"])).syncedTabs;
      await removeWhere((w, t) => (all[value(w, t, "syncKey")]?.url || "").includes("smoke-pick"));
      return 1;""", EXT_ID)


# What a drag shows, for the checks below: dragover says whether a drop would do something
# (drag.js cancels it, and only then does a drop send anything), and what is marked.
DRAG_TOOLS = """
  const list = doc.getElementById("tabs"), grid = doc.getElementById("essentials");
  const marked = () => [...doc.querySelectorAll(".drop-before, .drop-after, .drop-left, .drop-right, .drop-into")].map(e => [...e.classList].find(c => c.startsWith("drop-")));
  const ev = (type, el, x = .5, y = .5) => { const b = el.getBoundingClientRect();
    return new page.DragEvent(type, {bubbles: true, cancelable: true, clientX: b.left + b.width * x, clientY: b.top + b.height * y, dataTransfer: new page.DataTransfer()}); };
  const start = el => el.dispatchEvent(ev("dragstart", el));
  const end = el => el.dispatchEvent(ev("dragend", el));
  const over = (el, x, y) => [!el.dispatchEvent(ev("dragover", el, x, y)), ...marked()];
  const drop = (el, x, y) => !el.dispatchEvent(ev("drop", el, x, y));
  // By the clock: this page is a background tab here, where each wait can take a second.
  const until = async (test, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms && !test();) await wait(50); return !!test(); };
  const ids = els => [...els].map(e => Number(e.dataset.tab));
  const tileEls = () => [...doc.querySelectorAll("#essentials .tile")];
"""


def alone_drag_details(m):
    # Honest dragging, in drag events on the real sidebar: a mark only where a drop does
    # something, places among the essentials, and a click that shakes. A second window to follow.
    more_tabs_here(m, "details")
    m.js(H + """if (other()) return 1;
      const a = main(), n = a.gBrowser.tabs.filter(t => t.pinned).length, w = a.OpenBrowserWindow(); w.__smoke = true;
      for (let i = 0; i < 200 && !(w.gBrowser && w.gBrowser.tabs.filter(t => t.pinned).length >= n); i++) await wait(50);
      await wait(2000); return 1;""")
    r = sidebar_page(m, DRAG_TOOLS + """
      // The newest three: side by side, with nothing of the test's own between them.
      const out = {}, rows = plainTabs(), [a, b, c] = rows.slice(-3), last = c, order = ids(rows);
      start(b);
      out.belowPrevious = over(a, .5, .8);
      out.aboveNext = over(c, .5, .2);
      out.itself = over(b);
      out.dropNext = drop(c, .5, .2);
      end(b);
      start(b);
      out.belowNext = over(c, .5, .8);
      out.abovePrevious = over(a, .5, .2);
      doc.body.dispatchEvent(new page.DragEvent("dragleave", {bubbles: true, relatedTarget: null}));
      out.leftTheSidebar = marked();
      out.back = over(a, .5, .2);
      end(b);
      out.afterEnd = marked();
      start(last);
      out.endFromLast = over(list, .5, .999);
      end(last);
      start(a);
      out.end = over(list, .5, .999);
      end(a);
      out.stayed = JSON.stringify(ids(plainTabs())) === JSON.stringify(order);
      return out;""")
    check("no mark and nothing sent right above or below the dragged row, or on it",
          r["belowPrevious"] == [False] and r["aboveNext"] == [False] and r["itself"] == [False] and r["dropNext"] is False and r["stayed"], str(r))
    check("a mark where a drop does move the row", r["belowNext"] == [True, "drop-after"] and r["abovePrevious"] == [True, "drop-before"], str(r))
    check("a mark goes when the drag leaves the sidebar, and comes back, and goes at the end of the drag",
          r["leftTheSidebar"] == [] and r["back"] == [True, "drop-before"] and r["afterEnd"] == [], str(r))
    check("the empty end of the list is a line after the last tab, and nothing for the last tab itself",
          r["end"] == [True, "drop-after"] and r["endFromLast"] == [False], str(r))

    r = sidebar_page(m, DRAG_TOOLS + """
      const out = {}, space = spaces().find(s => s.active).id;
      const head = name => [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === name);
      for (const name of ["Drag 1", "Drag 2", "Drag 3"]) { send({type: "newFolder", space, name}); await until(() => head(name)); }
      const [h1, h2, h3] = ["Drag 1", "Drag 2", "Drag 3"].map(head);
      start(h2);
      out.belowPrevious = over(h1, .5, .8);
      out.aboveNext = over(h3, .5, .2);
      out.itself = over(h2);
      out.belowNext = over(h3, .5, .8);
      out.abovePrevious = over(h1, .5, .2);
      end(h2);
      // A tab in a folder.
      const row = plainTabs()[0], rowId = Number(row.dataset.tab);
      start(row); drop(h1); end(row);
      await until(() => h1.parentElement.querySelector(".tab"));
      const inside = h1.parentElement.querySelector(".tab");
      start(inside);
      out.ownFolderLast = over(h1);
      out.otherFolder = over(h2);
      out.indent = over(h1.parentElement.lastChild, .01, .5);
      out.gap = over(doc.querySelector("#tabs .divider"));
      // A live folder keeps its tabs: nothing but the essentials or a space is a place for them.
      h1.parentElement.classList.add("live");
      out.liveToRow = over(plainTabs()[0], .5, .2);
      out.liveToFolder = over(h2);
      out.liveToEnd = over(list, .5, .999);
      h1.parentElement.classList.remove("live");
      end(inside);
      // A new tab page: no folder, essential or other space can have it, only a place among the tabs.
      const known = new Set(plainTabs().map(r => r.dataset.tab));
      send({type: "newTab", space});
      await until(() => plainTabs().some(r => !known.has(r.dataset.tab)));
      const bareId = plainTabs().find(r => !known.has(r.dataset.tab)).dataset.tab, bareRow = () => plainTabs().find(r => r.dataset.tab === bareId);
      // (A new tab is the first of today's tabs, so the row after it is the next one, and right above that is no move.)
      const bare = bareRow(), web = plainTabs().find(r => r !== bare);
      start(bare);
      out.bareTile = over(tileEls()[0], .25);
      out.bareSpace = over(doc.querySelector(".space:not(.active)"));
      out.bareFolder = over(h2);
      out.bareInFolder = over(inside, .5, .2);
      out.bareAmong = over(web, .5, .8);
      end(bare);
      // Pinned, as Firefox's own menu can: a tile with no essential behind it, so no place among them.
      send({type: "pin", tabId: Number(bareId), pinned: true});
      await until(() => !bareRow());
      const bareTile = doc.querySelector(`#essentials .tile[data-tab="${bareId}"]`);
      start(bareTile);
      out.bareAmongTiles = over(tileEls()[0], .25);
      out.bareToList = over(list, .5, .999);
      end(bareTile);
      send({type: "pin", tabId: Number(bareId), pinned: false});
      await until(() => bareRow());
      // A tab dropped right above it lands there, not past it at the end.
      out.aboveBare = {want: Number(web.dataset.tab)};
      start(web); drop(bareRow(), .5, .2); end(web);
      await until(() => plainTabs().indexOf(web) === plainTabs().indexOf(bareRow()) - 1);
      out.aboveBare.got = Number(plainTabs()[plainTabs().indexOf(bareRow()) - 1]?.dataset.tab);
      send({type: "close", tabId: Number(bareId)});
      await until(() => !bareRow());
      start(inside); drop(plainTabs()[0], .5, .2); end(inside);
      await until(() => !h1.parentElement.querySelector(".tab"));
      for (const h of [h1, h2, h3]) send({type: "deleteFolder", key: h.dataset.folderHead});
      await until(() => !doc.querySelector("#tabs .folder"));
      return out;""")
    check("no mark and nothing sent right above or below a dragged folder, or on it",
          r["belowPrevious"] == [False] and r["aboveNext"] == [False] and r["itself"] == [False]
          and r["belowNext"] == [True, "drop-after"] and r["abovePrevious"] == [True, "drop-before"], str(r))
    check("no mark on the folder a tab is last in already; a mark on another", r["ownFolderLast"] == [False] and r["otherFolder"] == [True, "drop-into"], str(r))
    check("a folder's indent is no place, and the gap above the tabs is the top of them", r["indent"] == [False] and r["gap"] == [True, "drop-before"], str(r))
    check("a tab in a live folder has no place among the other tabs", r["liveToRow"] == [False] and r["liveToFolder"] == [False] and r["liveToEnd"] == [False], str(r))
    check("a new tab page has no mark on an essential, a space or a folder, only among the tabs",
          r["bareTile"] == [False] and r["bareSpace"] == [False] and r["bareFolder"] == [False] and r["bareInFolder"] == [False] and r["bareAmong"][0] is True, str(r))
    check("and pinned it has no place among the essentials, only the way back", r["bareAmongTiles"] == [False] and r["bareToList"] == [True, "drop-into"], str(r))
    check("a tab dropped right above a new tab page lands there", r["aboveBare"]["got"] == r["aboveBare"]["want"], str(r))

    def essentials_here():
        return m.js(H + """const ctx = main().gBrowser.selectedTab.userContextId || Number(args[0].split("-").pop());
          return wins().map(w => w.gBrowser.tabs.filter(t => t.pinned && t.userContextId === ctx).map(t => ek(w, t)));""", space)
    space = sidebar_page(m, "return spaces().find(s => s.active).id;")
    keys0 = essentials_here()
    r = sidebar_page(m, DRAG_TOOLS + """
      const out = {}, [t0, t1] = tileEls(), first = Number(t0.dataset.tab), second = Number(t1.dataset.tab);
      start(t0);
      out.itselfLeft = over(t0, .25);
      out.itselfRight = over(t0, .75);
      out.nextLeft = over(t1, .25);
      out.nextRight = over(t1, .75);
      out.emptyEnd = over(grid, .999, .5);
      out.placed = drop(t1, .75);
      end(t0);
      out.order = await until(() => ids(tileEls())[1] === first) && ids(tileEls());
      out.want = [second, first];
      const row = plainTabs()[0];
      start(row);
      out.tabGap = over(grid, 0, .5);
      out.tabLeft = over(t1, .25);
      out.tabRight = over(t1, .75);
      out.nameWithTiles = over(doc.getElementById("space-name"));
      end(row);
      return out;""")
    keys1 = essentials_here()
    check("no mark on a tile itself or at the place right after it", r["itselfLeft"] == [False] and r["itselfRight"] == [False] and r["nextLeft"] == [False], str(r))
    check("a tile's left or right half decides the side of the line", r["nextRight"] == [True, "drop-right"] and r["tabLeft"] == [True, "drop-left"] and r["tabRight"] == [True, "drop-right"], str(r))
    check("the empty end of the essentials' last line is the last place", r["emptyEnd"] == [True, "drop-right"], str(r))
    check("the gaps of the grid are places too, so a line does not flicker on its way", r["tabGap"][0] is True, str(r))
    check("the space's name is no place while it has essentials", r["nameWithTiles"] == [False], str(r))
    check("a tile dragged to the right half of the last tile lands last", r["placed"] is True and r["order"] == r["want"], str(r))
    check("and last in every window", len(keys1) > 1 and all(k == keys0[0][1:] + keys0[0][:1] for k in keys1), f"{keys0} -> {keys1}")

    keys0 = essentials_here()
    r = sidebar_page(m, DRAG_TOOLS + """
      const out = {}, [t0, t1] = tileEls(), row = plainTabs()[0], id = Number(row.dataset.tab);
      out.want = [Number(t0.dataset.tab), id, Number(t1.dataset.tab)];
      start(row); out.placed = drop(t1, .25); end(row);
      out.order = await until(() => tileEls().length === 3) && ids(tileEls());
      out.left = !plainTabs().some(r => Number(r.dataset.tab) === id);
      return {...out, id};""")
    keys1 = essentials_here()
    check("a tab dropped on a tile's left half is an essential right before it", r["placed"] is True and r["order"] == r["want"] and r["left"], str(r))
    check("and in that place in every window", len(keys1) > 1 and all(len(k) == 3 and k[0] == keys0[0][0] and k[2] == keys0[0][1] and k[1] == keys1[0][1] for k in keys1), f"{keys0} -> {keys1}")
    r = sidebar_page(m, DRAG_TOOLS + """
      const tile = tileEls().find(t => Number(t.dataset.tab) === args[0]);
      start(tile); drop(list); end(tile);
      await until(() => tileEls().length === 2);
      const row = plainTabs().find(r => Number(r.dataset.tab) === args[0]) || plainTabs()[0], id = Number(row.dataset.tab), [, t1] = tileEls();
      const want = [...ids(tileEls()), id];
      await wait(1000); // an unpin counts only after a moment (essentials.js, UNPIN_SETTLE_MS)
      start(row); const placed = drop(t1, .75); end(row);
      const order = await until(() => tileEls().length === 3) && ids(tileEls());
      const tile2 = tileEls().at(-1);
      start(tile2); drop(list); end(tile2);
      await until(() => tileEls().length === 2);
      await wait(1000);
      return {placed, order, want};""", r["id"])
    check("a tab dropped on the right half of the last tile is the last essential", r["placed"] is True and r["order"] == r["want"], str(r))

    # A move, and at once a drop on a tile: tab sync still counts the tab as moved by itself.
    row = sidebar_page(m, "return Number(plainTabs()[0].dataset.tab);")
    sync_key = m.js(H + """const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
      const ids = ExtensionParent.apiManager.global.tabTracker;
      for (const w of wins()) for (const t of w.gBrowser.tabs) if (ids.getId(t) === args[0]) return key(w, t);""", row)
    r = sidebar_page(m, DRAG_TOOLS + """
      const [row, next] = plainTabs(), id = Number(row.dataset.tab);
      start(row); const moved = drop(next, .5, .8); end(row);
      start(row); const pinned = drop(tileEls()[0], .25); end(row);
      await until(() => tileEls().some(t => Number(t.dataset.tab) === id));
      return {moved, pinned, id};""")
    left = m.js(H + """for (let i = 0; i < 100 && find(args[0]).flat().length; i++) await wait(50);
      await wait(2000); // a placeholder that comes back would do it by now
      return {left: find(args[0]), copies: wins().map(w => w.gBrowser.tabs.filter(t => t.pinned).length)};""", sync_key)
    check("a tab moved and at once dropped on a tile is an essential in every window, and no longer a tab in any",
          sync_key and r["moved"] is True and r["pinned"] is True and r["id"] == row and all(not x for x in left["left"]) and len(set(left["copies"])) == 1, f"{sync_key} {r} {left}")
    sidebar_page(m, DRAG_TOOLS + """
      const tile = tileEls().find(t => Number(t.dataset.tab) === args[0]);
      start(tile); drop(list); end(tile);
      await until(() => !tile.isConnected);
      await wait(2500);
      return 1;""", r["id"])

    # What is being dragged goes during the drag: no mark, and no drag left over for it.
    more_tabs_here(m, "gone")
    r = sidebar_page(m, DRAG_TOOLS + """
      const out = {}, rows = plainTabs(), gone = rows.at(-1), row = rows[0], other = rows[1], id = Number(row.dataset.tab);
      start(gone);
      out.before = over(rows[0], .5, .2);
      send({type: "close", tabId: Number(gone.dataset.tab)});
      await until(() => !gone.isConnected);
      out.markGone = marked();
      out.after = over(rows[0], .5, .2);
      // A space and back: the row is drawn anew, and its dragend will never come.
      const here = spaces().find(s => s.active).id, away = spaces().find(s => !s.active && s.id !== "firefox-container-4").id;
      start(row);
      send({type: "space", space: away});
      await until(() => !doc.querySelector(`#tabs [data-tab="${id}"]`));
      send({type: "space", space: here});
      await until(() => doc.querySelector(`#tabs [data-tab="${id}"]`));
      out.cameBack = over(doc.querySelector(`#tabs [data-tab="${id}"]`).nextElementSibling, .5, .8);
      return out;""")
    check("a tab closing during its own drag takes the mark with it, and marks nothing after", r["before"][0] is True and r["markGone"] == [] and r["after"] == [False], str(r))
    check("a drag whose row went does not start again when the row comes back", r["cameBack"] == [False], str(r))

    # A space with no essentials has no grid: its name is where the first one goes.
    m.js(H + """main().gBrowser.addTrustedTab("https://example.org/?smoke-first-essential", {userContextId: 4, inBackground: true}); await wait(2500); return 1;""")
    r = sidebar_page(m, DRAG_TOOLS + """
      const out = {}, here = spaces().find(s => s.active).id, name = doc.getElementById("space-name");
      send({type: "space", space: "firefox-container-4"});
      await until(() => spaces().find(s => s.active).id === "firefox-container-4" && !tileEls().length && plainTabs().length);
      const row = plainTabs()[0], id = Number(row.dataset.tab);
      start(row);
      out.over = over(name);
      out.placed = drop(name);
      end(row);
      out.tiles = await until(() => tileEls().length === 1) && ids(tileEls());
      out.want = [id];
      send({type: "space", space: here});
      await until(() => spaces().find(s => s.active).id === here);
      return out;""")
    check("a space's first essential is dropped on the space's name, where the grid would be", r["over"] == [True, "drop-into"] and r["placed"] is True and r["tiles"] == r["want"], str(r))
    r = m.js(H + """for (let i = 0; i < 100 && wins().some(w => !w.gBrowser.tabs.some(t => t.pinned && t.userContextId === 4)); i++) await wait(50);
      const copies = wins().map(w => w.gBrowser.tabs.filter(t => t.pinned && t.userContextId === 4).map(t => !!ek(w, t)));
      const tile = main().gBrowser.tabs.find(t => t.pinned && t.userContextId === 4);
      if (tile) main().gBrowser.unpinTab(tile);
      await wait(3000);
      await removeWhere((w, t) => t.userContextId === 4);
      return copies;""")
    check("and every window has it", len(r) > 1 and r == [[True]] * len(r), str(r))

    # × inside a draggable row. A drag from it is refused, and the next drag is not.
    r = sidebar_page(m, DRAG_TOOLS + """
      const out = {}, [row, other] = plainTabs(), x = row.querySelector(".close"), press = el => el.dispatchEvent(new page.MouseEvent("mousedown", {bubbles: true}));
      press(x);
      out.refused = !start(row);
      out.over = over(other, .5, .8);
      out.drop = drop(other, .5, .8);
      end(row);
      press(row.querySelector(".title"));
      out.fromTitle = start(row);
      out.overAfter = over(other, .5, .8);
      end(row);
      send({type: "mute", tabId: Number(row.dataset.tab), muted: true});
      await until(() => row.querySelector(".sound"));
      press(row.querySelector(".sound"));
      out.soundRefused = !start(row);
      end(row);
      send({type: "mute", tabId: Number(row.dataset.tab), muted: false});
      await until(() => !row.querySelector(".sound"));
      const icon = doc.createElement("img");
      row.append(icon);
      out.iconTakesNoMouse = page.getComputedStyle(icon).pointerEvents === "none";
      icon.remove();
      return out;""")
    check("a drag that starts on × or the sound button is refused, and does nothing", r["refused"] is True and r["soundRefused"] is True and r["over"] == [False] and r["drop"] is False, str(r))
    check("a drag that starts on the row itself still works", r["fromTitle"] is True and r["overAfter"] == [True, "drop-after"], str(r))
    check("a row is dragged whole, also when grabbed by its icon", r["iconTakesNoMouse"] is True, str(r))

    # The rest with what only a real pointer does, in the sidebar page as the selected tab:
    # real mouse events, a real drag session, and what Firefox itself does with them.
    m.js(H + """const w = main(); w.__beforeDrag = w.gBrowser.selectedTab;
      w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(500); return 1;""")
    into_page(m, "/sidebar/sidebar.html")

    def here(script):
        return m.cmd("WebDriver:ExecuteAsyncScript", {"sandbox": "system", "script": """
          const done = arguments[arguments.length - 1], wait = ms => new Promise(r => setTimeout(r, ms));
          const until = async (test, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms && !test();) await wait(50); return !!test(); };
          const rows = () => [...document.querySelectorAll("#tabs > .tab")].filter(r => r.querySelector(".title").textContent !== "Tidier");
          const list = document.getElementById("tabs");
          (async () => { """ + script + """ })().then(r => done(r ?? null), e => done({error: String(e)}));""", "args": []})

    def pointer(*steps):
        m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "drag", "parameters": {"pointerType": "mouse"}, "actions": list(steps)}]})

    def to(x, y):
        return {"type": "pointerMove", "x": x, "y": y, "origin": "viewport", "duration": 0}
    down, up, pause = {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}, {"type": "pause", "duration": 40}

    try:
        # A click whose hand shakes, on ×: past the distance that starts a drag, still on the button.
        at = here("""const [row] = rows(), b = row.querySelector(".close").getBoundingClientRect();
          return {n: rows().length, id: row.dataset.tab, order: rows().slice(1).map(r => r.dataset.tab), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2)};""")
        pointer(to(at["x"] - 40, at["y"]), pause, to(at["x"], at["y"]), pause)
        here("""window.__heard = 0; window.addEventListener("dragstart", () => window.__heard++, {capture: true, once: true}); return 1;""")
        pointer(down, to(at["x"] + 3, at["y"] + 3), to(at["x"] + 6, at["y"] + 6), pause, up)
        r = here("""await until(() => rows().length < arguments[0]); return {n: rows().length, heard: window.__heard, order: rows().map(r => r.dataset.tab)};""".replace("arguments[0]", str(at["n"])))
        check("a click on × that shakes (Firefox starts a drag) stays a click, and closes the tab",
              r["heard"] == 1 and r["n"] == at["n"] - 1 and r["order"] == at["order"], f"{at} -> {r}")

        # A long list: the pointer resting at its edge in a real drag session. Firefox's own
        # scrolling takes one step at most here, so anything more is Tidier's (drag.js).
        m.chrome()
        m.js(H + """const w = main(), ctx = Number(args[0].split("-").pop());
          for (let i = 0; i < 40; i++) w.gBrowser.addTrustedTab("https://example.org/?smoke-long-" + i, {userContextId: ctx, inBackground: true});
          for (let i = 0; i < 200 && w.gBrowser.tabs.filter(t => url(t).includes("smoke-long")).length < 40; i++) await wait(100);
          return 1;""", space)
        into_page(m, "/sidebar/sidebar.html")
        at = here("""await until(() => list.scrollHeight > list.clientHeight + 200);
          list.scrollTop = 0; await wait(100);
          const box = list.getBoundingClientRect(), b = rows()[1].getBoundingClientRect();
          return {x: Math.round(b.left + 60), y: Math.round(b.top + b.height / 2), top: Math.ceil(box.top), bottom: Math.floor(box.bottom), overflow: list.scrollHeight - list.clientHeight};""")
        pointer(to(at["x"], at["y"]), pause, down, to(at["x"], at["y"] + 8), pause, to(at["x"], at["y"] + 16), pause, to(at["x"], at["bottom"] - 200), pause)
        r0 = here("""const session = !!window.windowUtils.dragSession; await wait(100); return {session, top: list.scrollTop, marks: document.querySelectorAll(".drop-before, .drop-after").length};""")
        check("a real drag starts from a row, and marks where it would land", r0["session"] and r0["top"] == 0 and r0["marks"] == 1, str(r0))

        def rate():  # how far the list goes in a while, with the pointer resting
            return here("""const a = list.scrollTop, t = performance.now(); await wait(600); return (list.scrollTop - a) / (performance.now() - t);""")
        pointer(to(at["x"], at["bottom"] - 35), pause)
        slow = rate()
        pointer(to(at["x"], at["bottom"] - 2), pause)
        fast = rate()
        check("with the pointer resting at the bottom edge the list goes on scrolling, faster the closer", 0 < slow and slow * 2 < fast, f"{slow} {fast}")
        r1 = here("""await until(() => list.scrollTop >= list.scrollHeight - list.clientHeight - 1);
          await wait(300); // the last step or two
          return {top: list.scrollTop, marks: document.querySelectorAll(".drop-before, .drop-after").length};""")
        # More to scroll, with the pointer still there and no new dragover: nothing keeps it running at the end.
        r1b = here("""const a = list.scrollTop; list.style.paddingBottom = "600px"; await wait(500); const b = list.scrollTop; list.style.paddingBottom = ""; await wait(100); return [a, b];""")
        check("it reaches the end of the list, with a mark, and stops there", r1["marks"] == 1 and r1["top"] >= at["overflow"] - 2 and r1b[0] == r1b[1], f"{at} {r1} {r1b}")
        pointer(to(at["x"], at["top"] + 6), pause)
        back = here("""const a = list.scrollTop; await until(() => list.scrollTop < a - 100, 3000); return [a, list.scrollTop];""")
        check("at the top edge it scrolls back up", back[1] < back[0] - 100, str(back))
        pointer(to(at["x"] + 1, at["bottom"] - 200), pause)
        r2 = here("""await wait(100); const a = list.scrollTop; await wait(500); return [a, list.scrollTop];""")
        pointer(to(at["x"], at["bottom"] - 2), pause)
        r3 = here("""const a = list.scrollTop; await until(() => list.scrollTop > a + 40, 3000); const moving = list.scrollTop > a + 40;
          window.windowUtils.dragSession.endDragSession(true); await wait(300);
          const b = list.scrollTop; await wait(500); return {moving, session: !!window.windowUtils.dragSession, top: [b, list.scrollTop], marks: document.querySelectorAll(".drop-before, .drop-after").length};""")
        check("away from the edge it does not, and after the drag nothing moves or stays marked", r2[0] == r2[1] and r3["moving"] and not r3["session"] and r3["top"][0] == r3["top"][1] and r3["marks"] == 0, f"{r2} {r3}")
        # Other ways a drag ends or leaves, and an essential: with events alone, so no scrolling of Firefox's own.
        r = here("""const ev = (type, el, y) => new DragEvent(type, {bubbles: true, cancelable: true, clientX: 60, clientY: y, dataTransfer: new DataTransfer()});
          const bottom = list.getBoundingClientRect().bottom - 2, tile = document.querySelector("#essentials .tile"), out = {};
          const moves = async () => { const a = list.scrollTop; await wait(300); return list.scrollTop !== a; };
          list.scrollTop = 0;
          const row = rows()[0];
          row.dispatchEvent(ev("dragstart", row, 0)); list.dispatchEvent(ev("dragover", list, bottom));
          out.scrolls = await moves();
          document.body.dispatchEvent(new DragEvent("dragleave", {bubbles: true, relatedTarget: null}));
          out.afterLeaving = await moves();
          list.dispatchEvent(ev("dragover", list, bottom));
          out.back = await moves();
          document.getElementById("spaces").dispatchEvent(ev("dragover", document.getElementById("spaces"), bottom + 40));
          out.overTheBar = await moves();
          list.dispatchEvent(ev("dragover", list, bottom));
          list.dispatchEvent(ev("drop", list, 200)); row.dispatchEvent(ev("dragend", row, 0));
          out.afterDrop = await moves();
          list.scrollTop = 0;
          tile.dispatchEvent(ev("dragstart", tile, 0)); list.dispatchEvent(ev("dragover", list, bottom));
          out.essential = await moves();
          tile.dispatchEvent(ev("dragend", tile, 0));
          return out;""")
        check("it stops when the drag leaves the sidebar, goes on when it is back, and stops over the bar and after a drop",
              r["scrolls"] is True and r["afterLeaving"] is False and r["back"] is True and r["overTheBar"] is False and r["afterDrop"] is False, str(r))
        check("an essential dragged over the list does not scroll it: anywhere there unpins it", r["essential"] is False, str(r))
    finally:
        here("""window.windowUtils.dragSession?.endDragSession(true); return 1;""")
        pointer(up)
        m.cmd("WebDriver:ReleaseActions")
        m.chrome()
        m.js(H + """const w = main(); for (const t of [...w.gBrowser.tabs]) if (url(t).includes("smoke-long")) w.gBrowser.removeTab(t);
          if (w.__beforeDrag?.isConnected) w.gBrowser.selectedTab = w.__beforeDrag; await wait(2500); return 1;""")


def alone_settings(m):
    # The settings page draws, and rules work: a tab's first page, in the rule's space.
    r = ext_page(m, "/settings/settings.html", """
      await wait(800);
      return {state: doc.getElementById("alone-state").textContent, spaces: doc.querySelectorAll("#spaces .line").length, hours: doc.getElementById("archive-hours").value,
              saved: await page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify({type: "settings:rules", rules: [{url: "smoke-rule", space: "firefox-container-2"}]})))};""")
    check("the settings page shows Tidier alone, the spaces and the time for archiving", "on its own" in r["state"] and r["spaces"] >= 3 and r["hours"] == "12", str(r))
    r = m.js(H + """const w = main(); w.focus(); await wait(300);
      const space = w.gBrowser.selectedTab.userContextId === 2 ? 1 : w.gBrowser.selectedTab.userContextId;
      const t = w.gBrowser.addTrustedTab("about:blank", {userContextId: 1, inBackground: true}); await wait(300);
      t.linkedBrowser.loadURI(Services.io.newURI("https://example.org/?smoke-rule"), {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
      await wait(4000);
      const got = wins().map(x => x.gBrowser.tabs.filter(y => (url(y) + y.label).includes("smoke-rule")).map(y => y.userContextId));
      await removeWhere((x, y) => url(y).includes("smoke-rule"));
      const all = (await storage("%s", ["syncedTabs"])).syncedTabs, k = Object.keys(all).find(k => all[k].url?.includes("smoke-rule"));
      if (k) await removeWhere((x, y) => key(x, y) === JSON.stringify(k));
      await wait(1500);
      return got;""" % EXT_ID)
    check("a rule opens an address in its space", r[0] == [2], str(r))
    r = extension_message(m, {"type": "settings:rules", "rules": []})
    # The sidebar's key: without a sidebar a window has no list of tabs.
    r = m.js(H + """const w = main(); w.focus(); w.SidebarController.hide(); await wait(600); return w.SidebarController.isOpen;""")
    press(m, "s", CTRL, SHIFT)
    time.sleep(1)
    after = m.js(H + "return {open: main().SidebarController.isOpen, id: main().SidebarController.currentID};")
    check("a key brings Tidier's sidebar back", r is False and after["open"] and "6844a953" in (after["id"] or ""), f"{r}, {after}")
    if not after["open"]:
        m.js(H + 'await main().SidebarController.show("_6844a953-9931-4334-9ff6-257c246485cb_-sidebar-action"); return 1;')


def alone_copy(m):
    r = extension_message(m, {"type": "settings:copyNow"})
    copy = json.load(open(m.fake_prs + ".copy")) if os.path.exists(m.fake_prs + ".copy") else {}
    check("Tidier keeps a copy of its essentials and folders through the helper", r == {"saved": "copy"} and len(copy.get("data", {}).get("essentials", [])) >= 6 and copy["data"].get("syncedTabs"), f"{r}, {list(copy.get('data', {}))}")
    # What a copy holds, for choosing what to take in on another machine.
    summary = extension_message(m, {"type": "settings:copySummary", "copy": copy})
    check("a copy of what is here says, per space, that nothing would come", summary.get("firefox-container-1", {}).get("name") == "Space 1" and summary["firefox-container-1"]["essentials"] == 0, str(summary))
    merged = extension_message(m, {"type": "settings:merge", "copy": copy, "spaces": ["firefox-container-1"]})
    check("taking in a copy of what is already here adds nothing", merged == {"essentials": 0, "folders": 0, "tabs": 0, "rules": 0, "spaces": 0}, str(merged))


def choose_file(m, input_id, contents):
    """Give a file input on the settings page a file, the way the file picker does: it fires `change`. Returns once the page has answered."""
    ext_page(m, "/settings/settings.html", "return 1;")
    result = {"copy-file": "merge-result", "sidebery-file": "sidebery-result"}[input_id]
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "chosen.json")
        with open(path, "w") as out:
            out.write(contents if isinstance(contents, str) else json.dumps(contents))
        m.cmd("Marionette:SetContext", {"value": "content"})
        for h in m.cmd("WebDriver:GetWindowHandles"):
            m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
            if "/settings/settings.html" in m.cmd("WebDriver:GetCurrentURL"):
                break
        m.cmd("WebDriver:ExecuteScript", {"script": f'document.getElementById("{result}").textContent = ""; document.getElementById("merge").hidden = true;'})
        found = m.cmd("WebDriver:FindElement", {"using": "css selector", "value": "#" + input_id})
        m.cmd("WebDriver:ElementSendKeys", {"id": next(iter(found.values())), "text": path})
        # The file must still be there while the page reads it.
        for _ in range(300):
            if m.cmd("WebDriver:ExecuteScript", {"script": f'return !!document.getElementById("{result}").textContent || !document.getElementById("merge").hidden;'}):
                break
            time.sleep(0.1)
        m.chrome()


def alone_copy_and_import(m):
    # A copy from a machine where Space 1 and Space 2 have each other's ids, with a space
    # that is not here: everything must land under the right names.
    one, two = "firefox-container-1", "firefox-container-2"
    gone = "firefox-container-77"
    copy = {
        "tidier": "1.6", "when": 1,
        "spaces": [{"id": one, "name": "Space 2", "colorCode": "#ff9f00", "color": "orange", "icon": "briefcase"},
                   {"id": two, "name": "Space 1", "colorCode": "#37adff", "color": "blue", "icon": "fingerprint"},
                   {"id": gone, "name": "Brought along", "colorCode": "#af51f5", "color": "purple", "icon": "gift"}],
        "data": {
            "essentials": [{"key": "smoke-two", "url": "https://example.org/?in-space-2", "cookieStoreId": one, "title": "In Space 2"},
                           {"key": "smoke-new", "url": "https://example.org/?in-new", "cookieStoreId": gone, "title": "In the new space"}],
            "syncedTabs": {
                "smoke-folder": {"group": True, "url": "moz-extension://00000000-0000-4000-8000-000000000000/sidebery/group.html#Reading", "title": "Reading",
                                 "cookieStoreId": two, "parentKey": None, "added": 1},
                "smoke-saved": {"url": "https://example.org/?saved", "title": "Saved", "cookieStoreId": two, "parentKey": "smoke-folder", "added": 1,
                                "saved": {"url": "https://example.org/?saved", "title": "Saved"}},
            },
            "rules": [{"url": "copy-rule.example.org", "space": one}],
            "spaceOrder": [gone, two, one],
        },
    }
    named = H + """const ids = main().ContextualIdentityService;
      const nameOf = c => ids.getPublicIdentities().find(i => i.userContextId === c)?.name;
      const stored = await storage("%s", ["essentials", "syncedTabs", "rules", "spaceOrder"]);
      const tabs = k => wins().map(w => w.gBrowser.tabs.filter(t => t.pinned && ek(w, t) === k).map(t => nameOf(t.userContextId)));
      const spaceName = id => nameOf(Number(id.split("-").pop()));
      return {two: tabs("smoke-two"), fresh: tabs("smoke-new"), folder: stored.syncedTabs["smoke-folder"], saved: stored.syncedTabs["smoke-saved"],
              folderIn: stored.syncedTabs["smoke-folder"] && spaceName(stored.syncedTabs["smoke-folder"].cookieStoreId),
              rules: (stored.rules || []).map(r => [r.url, spaceName(r.space)]), order: (stored.spaceOrder || []).map(spaceName),
              made: ids.getPublicIdentities().filter(i => i.name === "Brought along").map(i => [i.color, i.icon])};""" % EXT_ID
    before = m.js(named)
    choose_file(m, "copy-file", copy)
    lines = ext_page(m, "/settings/settings.html", """return {lines: [...doc.querySelectorAll("#merge-spaces .line")].map(l => l.textContent.trim()), shown: !doc.getElementById("merge").hidden};""")
    check("a copy shows, per space, its name here and what would come, and which is new",
          lines["shown"] and lines["lines"] == ["●Space 2: 1 essential, 1 rule", "●Space 1: 1 folder, 1 saved tab", "●Brought along: 1 essential, a new space"], str(lines))
    check("nothing is written before you say so", m.js(named) == before, str(m.js(named)))
    done = ext_page(m, "/settings/settings.html", """doc.getElementById("merge-go").click();
      const goneAtOnce = doc.getElementById("merge").hidden; // a second click would find it all here, and say only that
      for (let i = 0; i < 60 && !doc.getElementById("merge-result").textContent; i++) await wait(200);
      return {result: doc.getElementById("merge-result").textContent, goneAtOnce, shown: !doc.getElementById("merge").hidden, ruleLines: doc.querySelectorAll("#rules .line").length, back: !doc.getElementById("move-back").hidden};""")
    check("taking it in says what came", done["result"] == "Took in 2 essentials, 1 folder, 1 saved tab, 1 rule and 1 new space. Nothing here was removed." and done["goneAtOnce"] and not done["shown"], str(done))
    check("and the page's rules follow, and no way back to a Sidebery this browser never had appears", done["ruleLines"] >= 1 and not done["back"], str(done))
    time.sleep(2)
    after = m.js(named)
    check("an essential whose ids are swapped lands under the right space's name, in every window", after["two"] and all(x == ["Space 2"] for x in after["two"]), str(after))
    check("a space not here is made, with its colour and icon, and its essential is in it", after["made"] == [["purple", "gift"]] and all(x == ["Brought along"] for x in after["fresh"]), str(after))
    check("a folder and its saved tab land under the right space's name", after["folderIn"] == "Space 1" and after["saved"] and after["saved"]["cookieStoreId"] == after["folder"]["cookieStoreId"] and after["folder"]["own"], str(after))
    check("rules come, in the right space, and the order of spaces where there was none", ["copy-rule.example.org", "Space 2"] in after["rules"] and after["order"][:3] == ["Brought along", "Space 1", "Space 2"], str(after))
    # A long space name must not push a rule's address out of its line (a select is as wide as its longest name).
    r = ext_page(m, "/settings/settings.html", """const select = doc.querySelector("#rules select"), line = select.parentElement;
      select.append(Object.assign(doc.createElement("option"), {textContent: "A space with a name long enough to fill the whole line it is shown on, and then a good deal more than that"}));
      const box = {text: line.querySelector("input").getBoundingClientRect().width, line: line.getBoundingClientRect().width, overflows: line.scrollWidth > line.clientWidth};
      select.lastChild.remove();
      return box;""")
    check("a long space name leaves a rule's address its room", r["text"] > r["line"] / 2 and not r["overflows"], str(r))
    # The same copy again has nothing for you to choose.
    choose_file(m, "copy-file", copy)
    r = ext_page(m, "/settings/settings.html", """return {line: doc.getElementById("merge-result").textContent, offered: !doc.getElementById("merge").hidden};""")
    check("the same copy again says nothing is new, and offers nothing", r == {"line": "Nothing new: all of it is here already.", "offered": False}, str(r))
    # A damaged copy shows what can be used, and what it calls a colour stays out of the page's style.
    choose_file(m, "copy-file", {"tidier": "1.6", "spaces": [None, {"id": "firefox-container-50", "name": "Odd", "colorCode": "red;background:url(https://example.org/x.png)"}],
                                 "data": {"essentials": [None, 3, {"key": "smoke-odd", "url": "https://example.org/?odd", "cookieStoreId": "firefox-container-50"}, {"key": "smoke-no-address", "cookieStoreId": "firefox-container-50"}]}})
    r = ext_page(m, "/settings/settings.html", """const dot = doc.querySelector("#merge-spaces .line span");
      return {lines: [...doc.querySelectorAll("#merge-spaces .line")].map(l => l.textContent.trim()), background: dot?.style.backgroundImage, line: doc.getElementById("merge-result").textContent};""")
    check("a damaged copy shows what can be used, and no address gets into the page's style", r == {"lines": ["●Odd: 1 essential, a new space"], "background": "", "line": ""}, str(r))
    # A wrong file says so, in one line, and offers nothing to take in.
    choose_file(m, "copy-file", {"hello": 1})
    r = ext_page(m, "/settings/settings.html", """return {line: doc.getElementById("merge-result").textContent, offered: !doc.getElementById("merge").hidden};""")
    check("a file that is no copy says so", r == {"line": "This is not a Tidier copy.", "offered": False}, str(r))
    choose_file(m, "copy-file", "not json at all")
    r = ext_page(m, "/settings/settings.html", """return doc.getElementById("merge-result").textContent;""")
    check("a file that is not even JSON says so", r == "This is not a Tidier copy.", str(r))
    choose_file(m, "sidebery-file", copy)
    r = ext_page(m, "/settings/settings.html", """return doc.getElementById("sidebery-result").textContent;""")
    check("a Tidier copy is not taken for Sidebery's export", r == "This is not Sidebery's export.", str(r))
    # Sidebery's export: address rules from panels, and the folder it had closed closes at once.
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "sidebery_export.json")) as f:
        choose_file(m, "sidebery-file", f.read())
    r = ext_page(m, "/settings/settings.html", """return doc.getElementById("sidebery-result").textContent;""")
    check("Sidebery's export says what came, and what it left out", r == "Imported 3 rules, the order of 2 spaces and 1 closed folder. Left out the rules of 1 panel with no container.", str(r))
    s = m.js(named)
    check("its address rules go to their panel's space", ["two.example.org", "Space 2"] in s["rules"] and ["reopen.example.org", "Space 1"] in s["rules"] and not [x for x in s["rules"] if "nowhere" in x[0] or "excluded" in x[0]], str(s))
    shown = sidebar_page(m, """doc.querySelector('#spaces .space[data-space="firefox-container-1"]').click();
      for (let i = 0; i < 40 && !folders().some(f => f.name === "Reading"); i++) await wait(200);
      return folders().filter(f => f.name === "Reading");""")
    check("the folder Sidebery had closed is closed in the sidebar", [f["collapsed"] for f in shown] == [True], str(shown))
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "sidebery_export.json")) as f:
        choose_file(m, "sidebery-file", {k: v for k, v in json.load(f).items() if k != "snapshots"})
    r = ext_page(m, "/settings/settings.html", """return doc.getElementById("sidebery-result").textContent;""")
    check("an export with no snapshot says folders start open", "no snapshot in this export, so folders start open" in r, str(r))
    no_problems(m, "taking in a copy and an export")
    # Leave no trace for the groups after this one.
    extension_message(m, {"type": "settings:rules", "rules": []})
    sidebar_page(m, """send({type: "deleteFolder", key: "smoke-folder"}); await wait(1000); return 1;""")
    ext_page(m, "/settings/settings.html", """const all = await page.browser.contextualIdentities.query(page.JSON.parse('{"name": "Brought along"}'));
      for (const c of all) await page.browser.contextualIdentities.remove(c.cookieStoreId);
      await wait(1000); return 1;""")
    m.js(H + """for (const w of wins()) for (const t of [...w.gBrowser.tabs]) if (t.pinned && ek(w, t) === "smoke-two") { w.gBrowser.unpinTab(t); break; }
      await wait(2000);
      await removeWhere((w, t) => key(w, t) === '"smoke-saved"' || url(t).includes("?in-space-2") || url(t).includes("?saved"));
      const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID("%s").extension));
      await db.remove(["spaceOrder"]);
      return 1;""" % EXT_ID)
    left = m.js(named)
    check("what was taken in can be taken away again", left["two"] and not any(left["two"]) and not left["made"] and not left["folder"] and not left["saved"], str(left))


def alone_archive(m):
    # A tab in a folder is kept by archiving; an ordinary one goes.
    more_tabs_here(m, "archive")
    r = sidebar_page(m, """
      send({type: "newFolder", space: spaces().find(s => s.active).id, name: "Kept"});
      await wait(1000);
      const key = [...doc.querySelectorAll("#tabs .folder .head")].at(-1).dataset.folderHead;
      const [a, b] = plainTabs().map(x => Number(x.dataset.tab));
      send({type: "moveTab", tabId: a, folder: key, before: null});
      await wait(2000);
      return {key, a, b};""")
    s = m.js(H + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      return {kept: Object.keys(all).find(k => all[k].parentKey === args[0])};""" % EXT_ID, r["key"])
    now = int(time.time() * 1000)
    late = extension_message(m, {"type": "archiveNow", "now": now + 13 * 3600 * 1000, "keys": [s["kept"]], "explain": True})
    check("archiving keeps a tab in a folder", late.get("kept", {}).get(s["kept"]) == "folder", str(late))


# The real sidebar, not a copy in a tab (sidebar_page): what the mouse and the keyboard
# do there, focus included, can only be seen in the real one. Its page is read with a
# frame script; the mouse and keys are WebDriver's, in the window.
IN_SIDEBAR = """
  const inSidebar = (source, ...a) => {
    const mm = main().SidebarController.browser.contentDocument.getElementById("webext-panels-browser").messageManager;
    const tag = "smoke:" + Math.random();
    const answer = new Promise(done => mm.addMessageListener(tag, function got(msg) { mm.removeMessageListener(tag, got); done(msg.data); }));
    mm.loadFrameScript("data:,(" + encodeURIComponent(`function() {
      const doc = content.document, dot = id => doc.querySelector('#spaces .space[data-space="' + id + '"]');
      const labels = () => [...doc.querySelectorAll("#menu:not([hidden]) .item")].map(i => i.textContent);
      const item = label => [...doc.querySelectorAll("#menu .item")].find(i => i.textContent === label);
      const box = () => doc.querySelector(".space-box");
      const top = id => doc.getElementById(id).getBoundingClientRect().top;
      let out; try { out = (${source})(...${JSON.stringify(a)}); } catch (e) { out = {error: String(e)}; }
      sendAsyncMessage(${JSON.stringify(tag)}, out);
    }`) + ")()", false);
    return answer;
  };"""
# (A list longer than the sidebar has no empty part in view, so for the test it gets one at its end.
# Below the last row without that is the bar, with a menu of its own.)
EMPTY_LIST = """({getBoundingClientRect: () => { const list = doc.getElementById("tabs");
  if (list.lastElementChild.getBoundingClientRect().bottom + 16 > list.getBoundingClientRect().bottom) { list.style.paddingBottom = "24px"; list.scrollTop = list.scrollHeight; }
  const r = list.getBoundingClientRect(); return {x: r.x, y: list.lastElementChild.getBoundingClientRect().bottom + 8, width: r.width, height: 2}; }})"""
ENTER = "\ue007"  # WebDriver's key, as CMD and the others above


def in_sidebar(m, source, *args):
    return m.js(H + IN_SIDEBAR + "return await inSidebar(...args);", source, *args)


def sidebar_until(m, source, *args, timeout=15):
    """A state of the real sidebar: a click reaches it in its own time on a busy machine."""
    deadline = time.time() + timeout
    while True:
        r = in_sidebar(m, source, *args)
        if (r and not (isinstance(r, dict) and r.get("wait"))) or time.time() > deadline:
            return r
        time.sleep(0.1)


def sidebar_mouse(m, target, button=0):
    """A real click (button 2: right) on the middle of what the script `target` finds."""
    x, y = m.js(H + IN_SIDEBAR + """const b = main().SidebarController.browser.getBoundingClientRect();
      const [x, y] = await inSidebar(args[0]); return [b.x + x, b.y + y];""",
      f"() => {{ const r = ({target}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }}")
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(x), "y": int(y), "origin": "viewport", "duration": 0},
        {"type": "pointerDown", "button": button}, {"type": "pointerUp", "button": button}]}]})
    m.cmd("WebDriver:ReleaseActions")


def sidebar_key(m, key):
    """A key for the sidebar. Firefox's own panel about hidden tabs can open at any moment
    after Tidier hides a tab, and while it is open a key closes it and goes no further."""
    m.js(H + """main().document.getElementById("extension-notification-panel")?.hidePopup?.(); return 1;""")
    press(m, key)


def menu_on(m, target, offers=None):
    """Right click on `target`: what its menu offers, once what is expected is there."""
    sidebar_mouse(m, target, 2)
    return sidebar_until(m, "(want) => { const now = labels(); return now.length && (!want || want === now.join()) ? now : null; }", offers and ",".join(offers)) or in_sidebar(m, "() => labels()")


def choose(m, label):
    sidebar_mouse(m, f"item({json.dumps(label)})")
    sidebar_until(m, "() => !labels().length")


def alone_space_menu(m):
    # Copies of Tidier's pages are rows too, and stay loaded: they have no container.
    m.js(H + """const w = main(); w.focus();
      for (const t of [...w.gBrowser.tabs]) if (/sidebar\\/sidebar\\.html|settings\\/settings\\.html/.test(url(t))) w.gBrowser.removeTab(t);
      await wait(500); return 1;""")
    here = sidebar_until(m, """() => doc.querySelector("#spaces .space.active")?.dataset.space""")
    all_spaces = in_sidebar(m, """() => [...doc.querySelectorAll("#spaces .space")].map(b => b.dataset.space)""")
    there = next(s for s in all_spaces if s != here and s != "firefox-container-4")
    # Loaded tabs in two spaces, and you are on one of them.
    SPACE_TABS = H + """const ctxOfId = id => Number(id.split("-").pop());
      const ordinary = (w, ctx) => w.gBrowser.tabs.filter(t => !t.pinned && t.userContextId === ctx && role(w, t) === "live");
      const pins = (w, ctx) => w.gBrowser.tabs.filter(t => t.pinned && t.userContextId === ctx);"""
    m.js(SPACE_TABS + """const w = main();
      for (const [space, name] of args[0]) for (const i of [1, 2, 3]) { w.gBrowser.addTrustedTab("https://example.org/?smoke-menu-" + name + "-" + i, {userContextId: ctxOfId(space), inBackground: true}); await wait(200); }
      const ready = () => w.gBrowser.tabs.filter(t => url(t).includes("smoke-menu-") && t.linkedPanel && role(w, t) === "live").length;
      for (let i = 0; i < 300 && ready() < 6; i++) await wait(100);
      w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("smoke-menu-here-1"));
      await wait(1000); return 1;""", [[here, "here"], [there, "there"]])

    # What it offers.
    ELSEWHERE, IN_SPACE = ["Rename", "Unload this space", "Archived tabs", "New space", "Settings"], ["Rename", "Unload this space", "Clear today's tabs", "Archived tabs", "New space", "Settings"]
    r = menu_on(m, f"dot({json.dumps(there)})", ELSEWHERE)
    place = in_sidebar(m, """(id) => ({menuBottom: doc.getElementById("menu").getBoundingClientRect().bottom, bar: doc.getElementById("spaces").getBoundingClientRect().top, marked: dot(id).classList.contains("menu-for"), active: doc.querySelector("#spaces .space.active").dataset.space})""", there)
    check("a right click on another space's dot opens its menu", r == ELSEWHERE, str(r))
    check("the menu opens above the bar, and its dot is marked", place["menuBottom"] <= place["bar"] and place["marked"] and place["active"] == here, str(place))
    sidebar_key(m, ESC)
    closed = sidebar_until(m, """(id) => !labels().length && !dot(id).classList.contains("menu-for")""", there)
    if closed is not True:  # says where the key went
        closed = {"sidebar": in_sidebar(m, """(id) => ({labels: labels(), marked: dot(id).classList.contains("menu-for"), has: doc.hasFocus()})""", there),
                  "focus": m.js(H + """const b = Services.focus.focusedContentBrowsingContext; return b?.currentURI?.spec?.slice(0, 70) ?? null;""")}
    check("Esc closes it, and the mark goes", closed is True, str(closed))
    r = menu_on(m, f"dot({json.dumps(here)})", IN_SPACE)
    check("the space you are in also has Clear", r == IN_SPACE, str(r))
    # A right click elsewhere takes the open menu away, and the list has its own.
    # (A long list's empty part lies under that menu, which stands above the bar, and a right
    # click on a menu does nothing, so there it goes first.)
    if in_sidebar(m, f"""() => {{ const p = {EMPTY_LIST}.getBoundingClientRect(), box = doc.getElementById("menu").getBoundingClientRect(); return p.y + 1 >= box.top && p.y <= box.bottom; }}"""):
        sidebar_key(m, ESC)
        sidebar_until(m, "() => !labels().length")
    r = menu_on(m, EMPTY_LIST, ["New folder", "Clear today's tabs", "Archived tabs", "Settings"])
    check("the empty part of the list has its own short menu", r == ["New folder", "Clear today's tabs", "Archived tabs", "Settings"], str(r))
    r = menu_on(m, 'doc.getElementById("space-name")', IN_SPACE)
    check("the name above the list has the space's menu", r == IN_SPACE, str(r))
    sidebar_key(m, ESC)
    sidebar_until(m, "() => !labels().length")

    # Unloading another space: you stay where you are.
    STATE = SPACE_TABS + """const w = main(), ctx = ctxOfId(args[0]);
      return {loaded: ordinary(w, ctx).filter(t => t.linkedPanel).map(t => url(t)), essentials: pins(w, ctx).filter(t => t.linkedPanel && !url(t).includes("ghost.html")).length, selected: url(w.gBrowser.selectedTab)};"""
    before = m.js(STATE, there)
    menu_on(m, f"dot({json.dumps(there)})")
    choose(m, "Unload this space")
    for _ in range(100):
        after = m.js(STATE, there)
        if not after["loaded"]:
            break
        time.sleep(0.1)
    check("unloading another space unloads its tabs", len(before["loaded"]) >= 3 and not after["loaded"], f"{before} -> {after}")
    check("and leaves its essentials, and you where you are", after["essentials"] == before["essentials"] > 0 and after["selected"] == before["selected"], f"{before} -> {after}")

    # Unloading this one: the rows dim, except the selected tab, and a page with unsaved input stays.
    m.js(H + """const t = main().gBrowser.tabs.find(t => url(t).includes("smoke-menu-here-2"));
      t.linkedBrowser.messageManager.loadFrameScript("data:,content.addEventListener('beforeunload', e => e.preventDefault()); content.document.notifyUserGestureActivation();", false);
      await wait(300); return 1;""")
    ROWS = """() => [...doc.querySelectorAll("#tabs .tab")].filter(r => !r.classList.contains("unloaded")).map(r => r.classList.contains("active") ? "selected" : "loaded")"""
    before = in_sidebar(m, ROWS)
    essentials = m.js(STATE, here)["essentials"]
    menu_on(m, f"dot({json.dumps(here)})")
    choose(m, "Unload this space")
    for _ in range(100):
        rows = in_sidebar(m, ROWS)
        if rows.count("loaded") <= 1:
            break
        time.sleep(0.1)
    state = m.js(STATE, here)
    check("unloading the space you are in dims its rows", before.count("loaded") >= 2 and rows.count("loaded") == 1 and "selected" in rows, f"{before} -> {rows}")
    check("and leaves the selected tab, its essentials and a page with unsaved input, without asking", "smoke-menu-here-1" in state["selected"] and any("smoke-menu-here-1" in u for u in state["loaded"]) and any("smoke-menu-here-2" in u for u in state["loaded"]) and state["essentials"] == essentials, str(state))
    # (Closed here, or the page would ask later.) A dim row's page comes back when selected.
    m.js(H + """const w = main(), t = w.gBrowser.tabs.find(t => url(t).includes("smoke-menu-here-2")); w.gBrowser.removeTab(t, {skipPermitUnload: true}); await wait(1000); return 1;""")
    sidebar_mouse(m, """doc.querySelector("#tabs .tab.unloaded")""")
    for _ in range(100):
        back = m.js(H + """const t = main().gBrowser.selectedTab; return {page: url(t), loaded: !!t.linkedPanel, was: url(t).includes("smoke-menu-here-1")};""")
        if not back["was"] and back["loaded"] and "ghost.html" not in back["page"]:
            break
        time.sleep(0.1)
    check("an unloaded row's page comes back when you select it", not back["was"] and back["loaded"], str(back))
    # Back on a tab of this test, for the checks below.
    m.js(H + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("smoke-menu-here-1")); await wait(800); return 1;""")

    # A page loaded in another window: the row here is a placeholder, and the page goes too.
    # Selecting the placeholder then brings the page here, once.
    other = m.js(SPACE_TABS + """const a = main(), w = a.OpenBrowserWindow(); w.__extra = true;
      for (let i = 0; i < 100 && !(w.gBrowser?.tabs.some(t => t.pinned)); i++) await wait(100);
      const t = w.gBrowser.addTrustedTab("https://example.org/?smoke-menu-other-window", {userContextId: ctxOfId(args[0]), inBackground: true});
      const placeholder = () => a.gBrowser.tabs.find(g => key(w, t) && key(a, g) === key(w, t));
      for (let i = 0; i < 200 && !(t.linkedPanel && url(t).includes("smoke-menu") && placeholder()); i++) await wait(100);
      a.focus(); await wait(500);
      return {role: role(w, t), key: key(w, t), placeholder: !!placeholder()};""", here)
    menu_on(m, f"dot({json.dumps(here)})")
    choose(m, "Unload this space")
    GONE = H + """const t = wins().find(w => w.__extra).gBrowser.tabs.find(t => url(t).includes("smoke-menu-other-window")); return {loaded: !!t?.linkedPanel, kept: !!t};"""
    for _ in range(100):
        gone = m.js(GONE)
        if not gone["loaded"]:
            break
        time.sleep(0.1)
    check("unloading reaches a page loaded in another window", other["role"] == "live" and other["placeholder"] and gone == {"loaded": False, "kept": True}, f"{other} -> {gone}")
    m.js(H + """const a = main(); a.gBrowser.selectedTab = a.gBrowser.tabs.find(t => key(a, t) === args[0]); return 1;""", other["key"])
    settled = lambda b: "smoke-menu-other-window" in b["page"] and b["loaded"] and sorted(set(s for w in b["everywhere"] for s in w)) == ["ghost/unloaded", "live/loaded"] and sum(w.count("live/loaded") for w in b["everywhere"]) == 1
    for _ in range(300):  # the pull has steps: only its end says anything
        back = m.js(H + """const a = main(), t = a.gBrowser.selectedTab; return {page: url(t), loaded: !!t.linkedPanel, everywhere: find(args[0])};""", other["key"])
        if settled(back):
            break
        time.sleep(0.1)
    check("and its placeholder brings it here, once", settled(back), str(back))
    m.js(H + """const w = wins().find(w => w.__extra), a = main(); await close(w); a.focus(); a.gBrowser.selectedTab = a.gBrowser.tabs.find(t => url(t).includes("smoke-menu-here-1")); await wait(800); return 1;""")

    # Rename, with real typing. Reading the container's name is reading what Firefox has.
    NAME = H + """return main().ContextualIdentityService.getPublicIdentityFromId(Number(args[0].split("-").pop())).name;"""
    name_here, name_there = m.js(NAME, here), m.js(NAME, there)
    line = in_sidebar(m, """() => top("actions")""")
    menu_on(m, f"dot({json.dumps(here)})")
    choose(m, "Rename")
    r = sidebar_until(m, """() => box() ? {value: box().value, selected: [box().selectionStart, box().selectionEnd], focus: doc.activeElement === box() && doc.hasFocus(), lineHidden: doc.getElementById("space-name").hidden, actions: top("actions")} : {wait: 1}""")
    check("Rename turns the name line into a box, with the name selected", r.get("value") == name_here and r["selected"] == [0, len(name_here)] and r["focus"] and r["lineHidden"], str(r))
    check("and the list does not move", r.get("actions") == line, f"{line} -> {r.get('actions')}")
    for ch in "Smoked":
        sidebar_key(m, ch)
    sidebar_key(m, ENTER)
    r = sidebar_until(m, """() => !box() && doc.querySelector("#spaces .space.active").title === "Smoked" ? {name: doc.getElementById("space-name").textContent, hidden: doc.getElementById("space-name").hidden} : {wait: 1}""")
    check("typing and Enter rename the space: the line, the dot and the container", r.get("name") == "Smoked" and r.get("hidden") is False and m.js(NAME, here) == "Smoked", f"{r}, {m.js(NAME, here)}")
    # The list stays put whatever the name is called and whatever the font: a long name
    # stays on one line, and the box takes the height of the line it replaces.
    r = in_sidebar(m, """() => { const line = doc.getElementById("space-name"), name = line.textContent, before = top("actions");
      line.textContent = name + " and a very long name that goes on".repeat(9); const after = top("actions"); line.textContent = name; return {before, after}; }""")
    check("a long name stays on one line, and the list does not move", r["before"] == r["after"], str(r))
    in_sidebar(m, """() => { doc.getElementById("space-name").style.fontSize = "19px"; return 1; }""")
    line = in_sidebar(m, """() => top("actions")""")
    menu_on(m, f"dot({json.dumps(here)})")
    choose(m, "Rename")
    r = sidebar_until(m, """() => box() ? {actions: top("actions")} : {wait: 1}""")
    check("with another font too", r.get("actions") == line, f"{line} -> {r}")
    sidebar_key(m, ESC)
    sidebar_until(m, "() => !box()")
    in_sidebar(m, """() => { doc.getElementById("space-name").style.fontSize = ""; return 1; }""")
    # A space without a name has no line, so the box is simply put there, over nothing.
    in_sidebar(m, """() => { const line = doc.getElementById("space-name"); line.dataset.was = line.textContent; line.textContent = ""; return 1; }""")
    menu_on(m, f"dot({json.dumps(here)})")
    choose(m, "Rename")
    r = sidebar_until(m, """() => { if (!box()) return {wait: 1}; const b = box().getBoundingClientRect(); return {bottom: b.bottom, actions: top("actions")}; }""")
    check("a space with no name opens a box that covers nothing", r.get("bottom", 1e9) <= r.get("actions", 0), str(r))
    sidebar_key(m, ESC)
    sidebar_until(m, "() => !box()")
    in_sidebar(m, """() => { const line = doc.getElementById("space-name"); line.textContent = line.dataset.was; delete line.dataset.was; return 1; }""")
    # Esc leaves it as it was; leaving the box saves.
    menu_on(m, f"dot({json.dumps(here)})")
    choose(m, "Rename")
    sidebar_until(m, "() => !!box()")
    for ch in "xy":
        sidebar_key(m, ch)
    sidebar_key(m, ESC)
    r = sidebar_until(m, """() => box() ? {wait: 1} : {name: doc.getElementById("space-name").textContent}""")
    check("Esc leaves the name as it was", r.get("name") == "Smoked" and m.js(NAME, here) == "Smoked", str(r))
    # Another space: in its place on the bar and in the box, and you stay.
    menu_on(m, f"dot({json.dumps(there)})")
    choose(m, "Rename")
    r = sidebar_until(m, """(id, here) => box() ? {value: box().value, focus: doc.activeElement === box() && doc.hasFocus(), marked: dot(id).classList.contains("menu-for"), active: dot(here).classList.contains("active")} : {wait: 1}""", there, here)
    check("another space's name opens in the box, its dot marked, and you stay in your space", r.get("value") == name_there and r["focus"] and r["marked"] and r["active"], str(r))
    for ch in "Other":
        sidebar_key(m, ch)
    sidebar_mouse(m, EMPTY_LIST)
    r = sidebar_until(m, """(id) => box() || dot(id).title !== "Other" ? {wait: 1} : {line: doc.getElementById("space-name").textContent, marked: dot(id).classList.contains("menu-for")}""", there)
    check("leaving the box saves it, and this space's name stays on the line", r.get("line") == "Smoked" and r.get("marked") is False and m.js(NAME, there) == "Other", f"{r}, {m.js(NAME, there)}")
    extension_message(m, {"type": "settings:space", "id": here, "changes": {"name": name_here}})
    extension_message(m, {"type": "settings:space", "id": there, "changes": {"name": name_there}})

    # Settings: the page, selected, in the window you are in, and you stay in your space.
    menu_on(m, f"dot({json.dumps(there)})")
    choose(m, "Settings")
    for _ in range(100):
        r = m.js(H + """const t = main().gBrowser.selectedTab; return url(t);""")
        if "settings/settings.html" in r:
            break
        time.sleep(0.1)
    check("Settings opens the settings page", "settings/settings.html" in r, r)
    active = in_sidebar(m, """() => doc.querySelector("#spaces .space.active").dataset.space""")
    check("and you stay in your space", active == here, active)
    m.js(H + """const w = main(); w.gBrowser.removeTab(w.gBrowser.selectedTab); await wait(1000); return 1;""")
    in_sidebar(m, """() => { doc.getElementById("tabs").style.paddingBottom = ""; return 1; }""")
    no_problems(m, "after a space's menu")


# Helpers for alone_stay_put. These checks work on the real sidebar, not on its page in a
# tab: a background tab gets its scroll events some seconds late, and its timers at most
# once a second, so waiting goes by the sidebar's clock too. The list is made shorter,
# which takes the place of some fifty tabs.
STAY_PUT = """
  const obj = o => page.JSON.parse(JSON.stringify(o));
  const side = page.browser.extension.getViews(obj({type: "sidebar", windowId: (await page.browser.windows.getCurrent()).id}))[0], doc = side.document;
  const wait = ms => new Promise(done => side.setTimeout(() => done(), ms));
  const list = doc.getElementById("tabs");
  list.style.cssText = "flex:none;height:160px";
  const plainTabs = () => [...doc.querySelectorAll("#tabs > .tab")];
  const folders = () => [...doc.querySelectorAll("#tabs .folder")].map(f => ({name: f.querySelector(".head .title")?.textContent}));
  const spaces = () => [...doc.querySelectorAll("#spaces .space")].map(b => ({id: b.dataset.space, active: b.classList.contains("active")}));
  const until = async (test, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(30)) if (await test()) return true; return false; };
  const tabs = page.browser.tabs;
  const activeRow = () => doc.querySelector("#tabs .tab.active");
  const box = () => list.getBoundingClientRect();
  const fromTop = r => Math.round(r.getBoundingClientRect().top - box().top), fromBottom = r => Math.round(box().bottom - r.getBoundingClientRect().bottom);
  const inView = r => fromTop(r) >= 0 && fromBottom(r) >= 0;
  const mine = async () => {
    const ids = new Set((await tabs.query(obj({windowId: (await page.browser.windows.getCurrent()).id}))).filter(t => t.url.includes("smoke-stay")).map(t => t.id));
    return () => plainTabs().filter(r => ids.has(Number(r.dataset.tab)));
  };
  const select = async r => { const id = r.dataset.tab; await tabs.update(Number(id), obj({active: true})); await until(() => activeRow()?.dataset.tab === id); await wait(50); };
  const scrollTo = y => new Promise(done => {
    const was = list.scrollTop;
    list.addEventListener("scroll", () => done(), {once: true});
    list.scrollTop = y;
    if (list.scrollTop === was) done();  // already there: no event comes
    wait(3000).then(() => done("no scroll event"));
  });
  const switchTo = async id => {
    doc.querySelector(`#spaces .space[data-space="${id}"]`).click();
    await until(() => spaces().find(s => s.active).id === id && doc.querySelector(".tab.active, .tile.active"));
    await wait(300);  // nothing may move after this either
  };
"""


# A real wheel, real clicks and real keys from outside the page, aimed at the sidebar (its
# page sits in two nested browsers in the window). A headless Firefox has no trackpad, but
# these take Firefox's own way to the page, with focus and scrolling as they really are.
SIDEBAR_AT = H + """const w = main(), a = w.SidebarController.browser.getBoundingClientRect(),
    b = w.SidebarController.browser.contentDocument.getElementById("webext-panels-browser").getBoundingClientRect();
  return {x: a.x + b.x, y: a.y + b.y};"""
FOCUS_SIDEBAR = H + """const w = main(); w.focus(); w.SidebarController.browser.contentDocument.getElementById("webext-panels-browser").focus(); await wait(200); return 1;"""


def real_wheel(m, at, x, y, dy):
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "wheel", "id": "wheel", "actions": [
        {"type": "scroll", "x": int(at["x"] + x), "y": int(at["y"] + y), "deltaX": 0, "deltaY": dy, "duration": 0, "origin": "viewport"}]}]})
    m.cmd("WebDriver:ReleaseActions")


def click_at(m, at, x, y):
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "duration": 0, "x": int(at["x"] + x), "y": int(at["y"] + y), "origin": "viewport"},
        {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]})
    m.cmd("WebDriver:ReleaseActions")


def sidebar_setting_off(m):
    # The setting off is the daily browser: should Tidier's sidebar be opened beside
    # Sidebery, the list keeps behaving as it always did (compare alone_stay_put).
    r = sidebar_page(m, """
      await wait(1000);
      const obj = o => page.JSON.parse(JSON.stringify(o)), tabs = page.browser.tabs, out = {};
      const list = doc.getElementById("tabs"), key = k => page.dispatchEvent(new page.KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
      const until = async test => { for (const t0 = Date.now(); Date.now() - t0 < 5000 && !test(); ) await wait(30); };
      list.style.cssText = "flex:none;height:64px";
      const folder = doc.querySelector("#tabs .folder"), far = [...doc.querySelectorAll("#tabs > .tab")].at(-1);
      if (!folder || !far) return {missing: true};
      const before = (await tabs.query(obj({active: true, currentWindow: true})))[0].id;
      await tabs.update(Number(far.dataset.tab), obj({active: true}));
      await until(() => doc.querySelector("#tabs > .tab.active"));
      await wait(300);
      out.listStays = list.scrollTop === 0 && !!doc.querySelector("#tabs > .tab.active");
      const inside = folder.querySelector(".tab");
      await tabs.update(Number(inside.dataset.tab), obj({active: true}));
      await until(() => folder.querySelector(".tab.active"));
      folder.querySelector(".head").click();
      await until(() => folder.classList.contains("collapsed"));
      out.closedHidesAll = !!folder.querySelector(".tab.active") && [...folder.querySelectorAll(".tab")].every(x => x.offsetParent === null);
      key("ArrowDown");
      out.keyAtTop = doc.querySelector(".cursor") === doc.querySelector(".tile, #tabs .head, #tabs .tab");
      page.dispatchEvent(new page.Event("blur"));
      out.cursorStays = !!doc.querySelector(".cursor");
      await tabs.update(before, obj({active: true}));
      return out;""")
    check("with the setting off, the list does not follow the selected tab", r.get("listStays") is True, str(r))
    check("with the setting off, a closed folder hides all its tabs", r.get("closedHidesAll") is True, str(r))
    check("with the setting off, the first arrow key starts at the top, and the cursor stays", r.get("keyAtTop") is True and r.get("cursorStays") is True, str(r))
    m.js(H + """const w = main(); for (const t of [...w.gBrowser.tabs]) if (url(t).includes("/sidebar/sidebar.html")) w.gBrowser.removeTab(t);
      await wait(300); return 1;""")


def alone_stay_put(m):
    m.js(H + """const w = main(); for (const t of [...w.gBrowser.tabs]) if (url(t).includes("/sidebar/sidebar.html")) w.gBrowser.removeTab(t);
      await wait(300); return 1;""")
    home, second = sidebar_page(m, STAY_PUT + """await wait(300);
      side.dispatchEvent(new side.Event("blur"));
      const a = spaces().find(s => s.active).id, others = spaces().filter(s => !s.active).map(s => s.id);
      return [a, ...others];""")[:2]
    # A space of its own, which is sure to be short: the groups before this one can have filled the others.
    short = sidebar_page(m, """const id = (await page.browser.contextualIdentities.create(page.JSON.parse(JSON.stringify({name: "smoke-short", color: "pink", icon: "circle"})))).cookieStoreId;
      await wait(500); return id;""")
    m.js(H + """const w = main(); for (const ctx of args) { for (let i = 0; i < 8; i++) { w.gBrowser.addTrustedTab("https://example.org/?smoke-stay-" + ctx + "-" + i, {userContextId: ctx, inBackground: true}); await wait(60); } }
      return 1;""", int(home.split("-")[-1]), int(second.split("-")[-1]))

    # Each space keeps its place: also over a space too short to scroll, whose
    # position of 0 must not be written to another.
    r = sidebar_page(m, STAY_PUT + """
      const [home, second, short] = args, out = {};
      let rows = await mine();
      await until(() => rows().length >= 8);
      await select(rows()[5]);
      await scrollTo(list.scrollTop - 17);
      out.home = list.scrollTop;
      await switchTo(second);
      rows = await mine();
      await until(() => rows().length >= 8);
      await select(rows()[4]);
      await scrollTo(list.scrollTop - 5);
      out.second = list.scrollTop;
      await switchTo(short);
      out.short = list.scrollTop;
      await switchTo(home);
      out.homeBack = list.scrollTop;
      await switchTo(second);
      out.secondBack = list.scrollTop;
      await switchTo(home);
      out.homeAgain = list.scrollTop;
      // Back and forth faster than the views come: only the last one counts, with nothing mixed up.
      for (const id of [second, short, home, second, home]) { doc.querySelector(`#spaces .space[data-space="${id}"]`).click(); await wait(10); }
      await until(() => spaces().find(s => s.active).id === home);
      await wait(600);
      out.homeQuick = list.scrollTop;
      await switchTo(second);
      out.secondQuick = list.scrollTop;
      await switchTo(home);
      // Restored first, then the selected tab shown by the least distance: from where
      // you left the list, the row comes in at the top edge; from the top of the list, at the bottom.
      rows = await mine();
      await select(rows()[1]);
      await scrollTo(list.scrollHeight);
      out.away = !inView(activeRow());
      await switchTo(short);
      await switchTo(home);
      out.restoredThenShown = {top: fromTop(activeRow()), bottom: fromBottom(activeRow())};
      return out;""", home, second, short)
    sidebar_page(m, STAY_PUT + """await switchTo(args[0]); await page.browser.contextualIdentities.remove(args[1]); await wait(600); return 1;""", home, short)
    check("each space keeps its place in the list", r.get("home") and r["homeBack"] == r["home"] and r["homeAgain"] == r["home"] and r["secondBack"] == r["second"], str(r))
    check("a space too short to scroll does not change another's place", r.get("short") == 0 and r["home"] != r["second"], str(r))
    check("switching back and forth quickly mixes up no place", r.get("homeQuick") == r.get("home") and r.get("secondQuick") == r.get("second"), str(r))
    check("a selected tab you scrolled away from comes back by the least distance from your place", r.get("away") and r["restoredThenShown"]["top"] == 0, str(r))

    # The list moves only for a selected tab wholly out of view.
    r = sidebar_page(m, STAY_PUT + """
      const out = {}, rows = await mine(), r = rows();
      await scrollTo(1 + list.scrollHeight);
      await select(r[0]);
      out.up = fromTop(r[0]);
      await select(r.at(-1));
      out.down = fromBottom(r.at(-1));
      // Partly in view: it stays where it is.
      const part = r[2], y = list.scrollTop + fromTop(part) + 10;
      await scrollTo(y);
      await select(part);
      await wait(200);
      out.partly = {moved: list.scrollTop - y, cut: fromTop(part)};
      // A click on a row in view.
      const y1 = list.scrollTop, seen = r.find(x => inView(x) && x !== activeRow());
      seen.click();
      await until(() => activeRow() === seen);
      await wait(200);
      out.clicked = {selected: activeRow() === seen, moved: list.scrollTop - y1};
      // A tab opened in the background, below what is shown.
      const before = plainTabs().length;
      await tabs.create(obj({url: "https://example.org/?smoke-stay-background", active: false, cookieStoreId: doc.documentElement.dataset.space}));
      await until(() => plainTabs().length > before);
      await wait(200);
      out.background = {added: plainTabs().length > before, moved: list.scrollTop - y1};
      // And nothing moves by itself when the selected tab is out of view and something else changes.
      await select(r.at(-1));
      await scrollTo(0);
      const out0 = !inView(activeRow());
      await tabs.create(obj({url: "https://example.org/?smoke-stay-background2", active: false, cookieStoreId: doc.documentElement.dataset.space}));
      await wait(500);
      out.staysAway = {away: out0, moved: list.scrollTop};
      // A tab that comes in above what is shown (moved there here or in another window).
      await scrollTo(list.scrollTop + fromTop(r[1]));
      const shown = r[1], top = fromTop(shown), mover = r.at(-1), first = plainTabs()[0];
      send({type: "moveTab", tabId: Number(mover.dataset.tab), before: Number(first.dataset.tab), folder: null});
      await until(() => plainTabs()[0] === mover);
      await wait(200);
      out.above = {arrived: plainTabs()[0] === mover, moved: fromTop(shown) - top};
      return out;""")
    check("a selected tab above the list comes in at the top edge, below it at the bottom edge", r.get("up") == 0 and r.get("down") == 0, str(r))
    check("a partly shown selected tab does not move the list", r.get("partly", {}).get("moved") == 0 and r["partly"]["cut"] < 0, str(r))
    check("clicking a row in view does not move the list", r.get("clicked") == {"selected": True, "moved": 0}, str(r))
    check("a tab opened in the background does not move the list", r.get("background") == {"added": True, "moved": 0}, str(r))
    check("with the selected tab scrolled away, other changes leave the list alone", r.get("staysAway") == {"away": True, "moved": 0}, str(r))
    check("a tab that comes in above what is shown does not move what you see", r.get("above") == {"arrived": True, "moved": 0}, str(r))

    # A closed folder shows the selected tab, and only that; nothing is unfolded or written.
    r = sidebar_page(m, STAY_PUT + """
      const out = {}, rows = await mine();
      const space = doc.documentElement.dataset.space;
      send({type: "newFolder", space, name: "Stay"});
      await until(() => folders().some(f => f.name === "Stay"));
      const head = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Stay"), folder = head.parentElement, key = head.dataset.folderHead;
      for (const r of rows().slice(0, 3)) send({type: "moveTab", tabId: Number(r.dataset.tab), folder: key, before: null});
      const inFolder = () => [...folder.querySelectorAll(".tab")];
      await until(() => inFolder().length === 3);
      const shown = () => inFolder().filter(r => r.offsetParent !== null).map(r => r.dataset.tab);
      const stored = async () => (await page.browser.storage.local.get("syncedTabs")).syncedTabs[key]?.collapsed;  // written a moment later
      const a = inFolder()[0], b = inFolder()[1];
      await select(b);
      head.click();
      await until(() => folder.classList.contains("collapsed") && shown().length < 3);
      await until(async () => (await stored()) === true);
      out.foldedHere = {shown: shown(), want: [b.dataset.tab], stored: await stored(), inView: inView(b)};
      await select(rows()[0]);
      await wait(150);
      out.left = {shown: shown(), stored: await stored(), closed: folder.classList.contains("collapsed")};
      await scrollTo(list.scrollHeight);
      await select(a);
      await wait(150);
      out.selectedInside = {shown: shown(), want: [a.dataset.tab], stored: await stored(), closed: folder.classList.contains("collapsed"), inView: inView(a), headInView: inView(head)};
      // Its row goes when you leave it: from above what is shown, without moving what you see.
      await scrollTo(list.scrollHeight);
      const seen = rows().filter(inView).at(-1), seenAt = fromTop(seen), above = !inView(a);
      seen.click();
      await until(() => activeRow() === seen && shown().length === 0);
      await wait(150);
      out.leftFromBelow = {above, gone: shown().length, moved: fromTop(seen) - seenAt};
      head.click();
      await until(() => !folder.classList.contains("collapsed"));
      await until(async () => (await stored()) === false);
      out.unfolded = {shown: shown().length, stored: await stored()};
      return {...out, key};""")
    check("folding the selected tab's folder keeps that row and hides the others", r.get("foldedHere") and r["foldedHere"]["shown"] == r["foldedHere"]["want"] and r["foldedHere"]["stored"] is True and r["foldedHere"]["inView"], str(r))
    check("leaving the tab hides it, and the folder stays closed", r.get("left") == {"shown": [], "stored": True, "closed": True}, str(r))
    check("selecting a tab in a closed folder shows it, in view, and unfolds nothing", r.get("selectedInside") and r["selectedInside"]["shown"] == r["selectedInside"]["want"] and r["selectedInside"]["stored"] is True and r["selectedInside"]["closed"] and r["selectedInside"]["inView"] and r["selectedInside"]["headInView"], str(r))
    check("leaving a tab in a closed folder above the view does not move what you see", r.get("leftFromBelow") == {"above": True, "gone": 0, "moved": 0}, str(r))
    check("unfolding brings back all its tabs", r.get("unfolded") == {"shown": 3, "stored": False}, str(r))
    folder_key = r.get("key")

    # After closing: not an unloaded tab, even if used later, and not into a closed folder.
    r = sidebar_page(m, STAY_PUT + """
      const out = {}, rows = await mine();
      const folder = doc.querySelector(`.folder[data-key="${args[0]}"]`), head = folder.firstChild, inFolder = () => [...folder.querySelectorAll(".tab")];
      const told = (id, next) => until(async () => (await tabs.get(id)).successorTabId === next);
      const id = r => Number(r.dataset.tab);
      const [l, u, s] = rows().slice(-3).map(id);
      for (const r of rows().slice(-3)) await select(r);
      await tabs.discard(u);
      out.unloaded = (await tabs.get(u)).discarded;
      out.toldLoaded = await told(s, l);
      await tabs.remove(s);
      await until(() => activeRow() && activeRow().dataset.tab !== String(s));
      out.afterUnloaded = {selected: id(activeRow()), want: l};
      // Used just before, in a folder you then close while on another tab.
      const f = inFolder()[0], t = rows().at(-1);
      await select(f);
      await select(t);
      out.toldFolder = await told(id(t), id(f));
      head.click();
      await until(() => folder.classList.contains("collapsed"));
      out.toldOutside = await until(async () => { const n = (await tabs.get(id(t))).successorTabId; return n !== id(f) && n !== undefined; });
      const tId = id(t);
      await tabs.remove(tId);
      await until(() => activeRow() && activeRow().dataset.tab !== String(tId));
      out.afterFolded = {outside: !folder.contains(activeRow()), closed: folder.classList.contains("collapsed")};
      // Closing the selected tab inside a closed folder: a tab in a folder only unloads, in its
      // place, so nothing is lost; you land outside, and its row goes with the folder still closed.
      const kept = inFolder()[0], keptId = id(kept), count = inFolder().length; // (unloaded, as a closed folder's tabs are: selecting it loads it)
      await select(kept);
      await until(() => !kept.classList.contains("unloaded")); // only a loaded tab that closes stays, unloaded: an unloaded one you close is gone
      out.toldOut = await until(async () => { const n = (await tabs.get(keptId)).successorTabId; return n !== undefined && !inFolder().some(r => id(r) === n); });
      await tabs.remove(keptId);
      await until(() => activeRow() && activeRow().dataset.tab !== String(keptId) && inFolder().length === count && !inFolder().some(r => id(r) === keptId));
      await wait(200);
      out.counted = [count, inFolder().length];
      out.closedInside = {landedOutside: !folder.contains(activeRow()), kept: inFolder().length === count, hidden: inFolder().every(r => r.offsetParent === null), closed: folder.classList.contains("collapsed")};
      // Put into the closed folder with no move for Firefox to report: the window's last
      // tab, used just before this one, once Tidier has it in its record.
      const last = (await tabs.create(obj({url: "https://example.org/?smoke-stay-last", active: true, cookieStoreId: doc.documentElement.dataset.space}))).id;
      await until(() => activeRow()?.dataset.tab === String(last));
      await wait(2000);
      const on = rows()[2];
      await select(on);
      out.toldLast = await told(id(on), last);
      out.lastIsLast = (await tabs.get(last)).index === (await tabs.query(obj({windowId: (await page.browser.windows.getCurrent()).id}))).length - 1;
      send({type: "moveTab", tabId: last, folder: args[0], before: null});
      await until(() => inFolder().some(r => id(r) === last));
      out.inClosed = inFolder().some(r => id(r) === last);
      out.toldNotLast = await until(async () => { const n = (await tabs.get(id(on))).successorTabId; return n !== last && n !== undefined; });
      return out;""", folder_key)
    check("Firefox knows the next tab as soon as a tab is unloaded", r.get("unloaded") is True and r.get("toldLoaded") is True, str(r))
    check("closing a tab selects a loaded tab, not an unloaded one used later", r.get("afterUnloaded", {}).get("selected") == r.get("afterUnloaded", {}).get("want"), str(r))
    check("closing a tab does not select into a folder closed meanwhile", r.get("toldFolder") is True and r.get("toldOutside") is True and r.get("afterFolded") == {"outside": True, "closed": True}, str(r))
    check("closing the selected tab in a closed folder keeps it there unloaded, and lands outside", r.get("toldOut") and r.get("closedInside") == {"landedOutside": True, "kept": True, "hidden": True, "closed": True}, str(r))
    check("nor into a closed folder a tab was put in without moving", r.get("toldLast") and r.get("lastIsLast") and r.get("inClosed") and r.get("toldNotLast"), str(r))

    # A page without a container (about:, Tidier's settings) belongs to no space, and is
    # shown in the one you are in: closing it lands as closing any tab there does, not on
    # the unloaded tab Firefox would take for being next to it.
    m.js(H + """main().gBrowser.addTrustedTab("about:robots", {inBackground: true}); await wait(500); return 1;""")
    r = sidebar_page(m, STAY_PUT + """
      const out = {}, rows = await mine(), id = r => Number(r.dataset.tab);
      const windowId = (await page.browser.windows.getCurrent()).id;
      const all = await tabs.query(obj({windowId})), robots = all.find(t => t.url === "about:robots").id;
      const visible = all.filter(t => !t.hidden && !t.pinned && t.id !== robots).sort((a, b) => a.index - b.index);
      const beside = visible.at(-1).id, used = rows().find(r => id(r) !== beside);
      await select(used);
      await tabs.discard(beside);
      await tabs.update(robots, obj({active: true}));
      await until(() => activeRow()?.dataset.tab === String(robots));
      out.besideUnloaded = (await tabs.get(beside)).discarded;
      out.told = await until(async () => (await tabs.get(robots)).successorTabId === id(used));
      await tabs.remove(robots);
      await until(() => activeRow() && activeRow().dataset.tab !== String(robots));
      await wait(200);
      out.landed = activeRow()?.dataset.tab === String(id(used));
      return out;""")
    check("closing a page without a container lands on the loaded tab used last, not the unloaded one beside it", r == {"besideUnloaded": True, "told": True, "landed": True}, str(r))

    # The first key starts at the selected row, also after going away.
    r = sidebar_page(m, STAY_PUT + """
      const out = {}, rows = await mine(), key = k => side.dispatchEvent(new side.KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true}));
      const cursor = () => doc.querySelector(".cursor"), reach = () => [...doc.querySelectorAll(".tile, #tabs .head, #tabs .tab")].filter(e => e.offsetParent !== null);
      const r = rows()[3];
      await select(r);
      out.none = !cursor();
      key("ArrowDown");
      out.first = cursor() === r;
      key("ArrowDown");
      out.second = reach().indexOf(cursor()) === reach().indexOf(r) + 1;
      side.dispatchEvent(new side.Event("blur"));
      out.gone = !cursor();
      key("ArrowUp");
      out.againUp = cursor() === r;
      // Its row drawn again (a page's title, a sound): the mark stays, or you lose your place.
      await tabs.update(Number(r.dataset.tab), obj({muted: true}));
      await until(() => r.querySelector(".sound"));
      out.markStays = !!r.querySelector(".sound") && r.classList.contains("cursor");
      await tabs.update(Number(r.dataset.tab), obj({muted: false}));
      await until(() => !r.querySelector(".sound"));
      side.dispatchEvent(new side.Event("blur"));
      const tile = doc.querySelector("#essentials .tile");
      await tabs.update(Number(tile.dataset.tab), obj({active: true}));
      await until(() => tile.classList.contains("active"));
      key("ArrowDown");
      out.onTile = cursor() === tile;
      side.dispatchEvent(new side.Event("blur"));
      // Walking by key: the cursor brings a row in by the least distance, and Enter selects
      // it without moving the list again.
      await select(r);
      await scrollTo(0);
      key("ArrowDown");
      for (let i = 0; i < 30 && cursor() !== rows().at(-1); i++) key("ArrowDown");
      out.walked = {on: cursor() === rows().at(-1), bottom: fromBottom(cursor())};
      const y = list.scrollTop;
      key("Enter");
      await until(() => activeRow() === rows().at(-1));
      await wait(200);
      out.entered = {selected: activeRow() === rows().at(-1), moved: list.scrollTop - y};
      side.dispatchEvent(new side.Event("blur"));
      // A cursor on a row that is hidden since (its folder folded by a click): ⌫ and Enter do
      // nothing to a tab you cannot see, and the next arrow key starts at the selected row.
      const space = doc.documentElement.dataset.space, name = "Fold under cursor";
      send({type: "newFolder", space, name});
      await until(() => folders().some(f => f.name === name));
      const hide = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === name), child = rows()[0], childId = Number(child.dataset.tab);
      send({type: "moveTab", tabId: childId, folder: hide.dataset.folderHead, before: null});
      await until(() => hide.parentElement.contains(child));
      await select(rows().at(-1));
      side.dispatchEvent(new side.Event("blur"));
      for (let i = 0; i < 40 && cursor() !== child; i++) key("ArrowUp");
      out.onChild = cursor() === child;
      hide.click();
      await until(() => child.offsetParent === null);
      key("Backspace");
      key("Enter");
      await wait(300);
      out.hiddenAlive = await tabs.get(childId).then(() => true, () => false);
      out.hiddenNotSelected = activeRow() === rows().at(-1);
      key("ArrowDown");
      out.fromSelected = cursor() === rows().at(-1);
      side.dispatchEvent(new side.Event("blur"));
      send({type: "deleteFolder", key: hide.dataset.folderHead});
      await until(() => !folders().some(f => f.name === name));
      // Ready for a real ⌃Tab from outside the sidebar, whichever way Firefox orders it: to the
      // tab after this one or the tab used before it, the same one here, below what is shown.
      await select(rows().at(-1));
      await select(rows().at(-2));
      await scrollTo(0);
      out.target = rows().at(-1).dataset.tab;
      return out;""")
    check("the first arrow key starts at the selected row", r.get("none") and r.get("first") and r.get("second"), str(r))
    check("the cursor goes when the sidebar loses the focus, and the next key starts at the selected row", r.get("gone") and r.get("againUp"), str(r))
    check("the cursor's mark stays when its row is drawn again", r.get("markStays") is True, str(r))
    check("the first arrow key starts at the selected essential", r.get("onTile") is True, str(r))
    check("walking down by key brings a row in by the least distance, and Enter leaves the list where it is",
          r.get("walked") == {"on": True, "bottom": 0} and r.get("entered") == {"selected": True, "moved": 0}, str(r))
    check("a cursor on a row hidden since closes and selects nothing, and the next key starts at the selected row",
          r.get("onChild") and r.get("hiddenAlive") and r.get("hiddenNotSelected") and r.get("fromSelected"), str(r))
    m.js(H + "main().focus(); await wait(300); return 1;")
    press(m, "\ue004", CTRL)
    k = sidebar_page(m, STAY_PUT + """
      await until(() => activeRow()?.dataset.tab === args[0]);
      await wait(100);
      return {selected: activeRow()?.dataset.tab === args[0], bottom: activeRow() && fromBottom(activeRow())};""", r.get("target"))
    check("⌃Tab to a tab below the list brings it in at the bottom edge", k == {"selected": True, "bottom": 0}, str(k))

    # The same for real: the wheel, clicks on the bar and on a row, and keys.
    at = m.js(SIDEBAR_AT)
    settled = """let last = -1; await until(async () => { const same = list.scrollTop === last; last = list.scrollTop; await wait(100); return same; });"""
    centre = """const middle = e => { const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; };
      const dot = id => middle(doc.querySelector(`#spaces .space[data-space="${id}"]`));
      const until_space = id => until(() => spaces().find(s => s.active).id === id && doc.querySelector(".tab.active, .tile.active"));"""
    place_home = sidebar_page(m, STAY_PUT + centre + """
      const rows = await mine(), r = rows()[4];
      await select(r);
      await scrollTo(list.scrollTop + fromTop(r) - 64);
      return {list: middle(list), was: list.scrollTop};""")
    real_wheel(m, at, place_home["list"]["x"], place_home["list"]["y"], -25)
    wheeled = sidebar_page(m, STAY_PUT + centre + "await until(() => list.scrollTop !== args[1]);" + settled + "return {y: list.scrollTop, dot: dot(args[0])};", second, place_home["was"])
    click_at(m, at, wheeled["dot"]["x"], wheeled["dot"]["y"])
    there = sidebar_page(m, STAY_PUT + centre + """
      await until_space(args[0]);
      const rows = await mine(), r = rows()[3];
      await select(r);
      await scrollTo(list.scrollTop + fromTop(r) - 32);
      return {list: middle(list), was: list.scrollTop, dot: dot(args[1])};""", second, home)
    real_wheel(m, at, there["list"]["x"], there["list"]["y"], -15)
    y2 = sidebar_page(m, STAY_PUT + "await until(() => list.scrollTop !== args[0]);" + settled + "return list.scrollTop;", there["was"])
    click_at(m, at, there["dot"]["x"], there["dot"]["y"])
    back = sidebar_page(m, STAY_PUT + centre + """
      await until_space(args[0]);
      await wait(300);
      const rows = await mine(), seen = rows().find(x => inView(x) && x !== activeRow());
      return {y: list.scrollTop, row: middle(seen), tab: seen.dataset.tab, active: activeRow()?.dataset.tab};""", home)
    check("with a real wheel and real clicks on the bar, each space keeps its place",
          wheeled["y"] < place_home["was"] and y2 < there["was"] and back.get("y") == wheeled["y"], f"{place_home} {wheeled} {there} {y2} {back}")
    click_at(m, at, back["row"]["x"], back["row"]["y"])
    clicked = sidebar_page(m, STAY_PUT + """
      await until(() => activeRow()?.dataset.tab === args[0]);
      await wait(200);
      return {selected: activeRow()?.dataset.tab === args[0], y: list.scrollTop, focus: doc.hasFocus(), cursor: !!doc.querySelector(".cursor")};""", back["tab"])
    check("a real click on a row in view selects it and does not move the list, and the page has the focus after",
          clicked == {"selected": True, "y": back["y"], "focus": False, "cursor": False}, str(clicked))
    m.js(FOCUS_SIDEBAR)
    press(m, "\ue015")  # ↓
    first = sidebar_page(m, STAY_PUT + """await until(() => doc.querySelector(".cursor"));
      return {on: doc.querySelector(".cursor")?.dataset.tab, selected: activeRow()?.dataset.tab, focus: doc.hasFocus()};""")
    m.js(FOCUS_SIDEBAR)
    press(m, "\ue015")
    second_key = sidebar_page(m, STAY_PUT + """const c = () => doc.querySelector(".cursor"), reach = [...doc.querySelectorAll(".tile, #tabs .head, #tabs .tab")].filter(e => e.offsetParent !== null);
      await until(() => c()?.dataset.tab !== args[0]);
      return {next: reach.indexOf(c()) === reach.findIndex(e => e.dataset.tab === args[0]) + 1, tab: c()?.dataset.tab};""", first.get("on"))
    m.js(FOCUS_SIDEBAR)
    press(m, "\ue007")  # Enter
    entered = sidebar_page(m, STAY_PUT + """await until(() => activeRow()?.dataset.tab === args[0] && !doc.hasFocus());
      await wait(100);
      return {selected: activeRow()?.dataset.tab === args[0], cursor: !!doc.querySelector(".cursor"), focus: doc.hasFocus()};""", second_key.get("tab"))
    check("real keys: the first ↓ starts at the selected row, the next moves on", first.get("on") == first.get("selected") and first.get("focus") is True and second_key.get("next") is True, f"{first} {second_key}")
    check("real keys: Enter selects, the page has the focus, and the cursor's mark is gone", entered == {"selected": True, "cursor": False, "focus": False}, str(entered))

    # For real: placeholders here, whose pages are live in another window. Selecting one
    # gives the row another tab, from another window, while you look at the list.
    opened = m.js(H + """if (other()) return false;
      const w = main().OpenBrowserWindow(); w.__smoke = true;
      for (let i = 0; i < 100 && !(w.gBrowser?.tabs.length > 3); i++) await wait(100);
      await wait(2500); return true;""")
    space = sidebar_page(m, STAY_PUT + "await wait(100); return doc.documentElement.dataset.space;")
    m.js(H + """const o = other(), context = args[0];
      for (let i = 0; i < 5; i++) { o.gBrowser.addTrustedTab("https://example.org/?smoke-stay-far-" + i, {userContextId: context, inBackground: true}); await wait(80); }
      await wait(2500); main().focus(); await wait(500); return 1;""", int(space.split("-")[-1]))
    r = sidebar_page(m, STAY_PUT + """
      const out = {}, id = r => Number(r.dataset.tab), folderKey = args[0], title = r => r.querySelector(".title").textContent;
      const ghosts = async () => { const g = []; for (const r of plainTabs()) if ((await tabs.get(id(r))).url.includes("ghost.html")) g.push(r); return g; };
      const pulled = (was, name) => until(() => activeRow() && activeRow().dataset.tab !== was && title(activeRow()) === name && !activeRow().classList.contains("unloaded"));
      let g = await ghosts();
      out.placeholders = g.length;
      // A click on one at the very top of what is shown: the list does not move, though the tab does.
      const c = g[0], was = c.dataset.tab, name = title(c);
      await scrollTo(list.scrollTop + fromTop(c));
      const y = list.scrollTop, moves = [];
      list.addEventListener("scroll", () => moves.push(list.scrollTop));
      c.click();
      out.clickPulled = await pulled(was, name);
      await wait(400);
      out.click = {moved: list.scrollTop - y, events: moves.length, top: fromTop(activeRow())};
      // One out of view, selected from outside the list: it comes in, and stays in while the tab arrives.
      g = await ghosts();
      const f = g.at(-1), fWas = f.dataset.tab, fName = title(f);
      await scrollTo(0);
      await tabs.update(id(f), obj({active: true}));
      out.farPulled = await pulled(fWas, fName);
      await wait(400);
      out.farInView = inView(activeRow());
      // One in a closed folder: its row shows, it stays the only one when the tab arrives, and the folder stays closed.
      const folder = doc.querySelector(`.folder[data-key="${folderKey}"]`), inside = () => [...folder.querySelectorAll(".tab")];
      const shown = () => inside().filter(r => r.offsetParent !== null);
      g = await ghosts();
      const p = g[0], pName = title(p);
      send({type: "moveTab", tabId: id(p), folder: folderKey, before: null});
      await until(() => inside().some(r => r === p));
      const pWas = p.dataset.tab;
      await tabs.update(id(p), obj({active: true}));
      out.closedPulled = await pulled(pWas, pName);
      await wait(400);
      out.closed = {only: shown().length === 1 && shown()[0] === activeRow(), closed: folder.classList.contains("collapsed"), inView: inView(activeRow()), stored: (await page.browser.storage.local.get("syncedTabs")).syncedTabs[folderKey].collapsed};
      // Ready for closing: a loaded tab used just before this one, and then a placeholder made.
      g = await ghosts();
      const [before, onTab] = plainTabs().filter(r => !r.classList.contains("unloaded") && !g.includes(r));
      await select(before);
      await select(onTab);
      return {...out, before: id(before), onTab: id(onTab)};""", folder_key)
    check("clicking a placeholder at the top of the list does not move it", r.get("placeholders", 0) >= 3 and r.get("clickPulled") and r.get("click") == {"moved": 0, "events": 0, "top": 0}, str(r))
    check("selecting a placeholder out of view brings it in, and it stays in while its tab arrives", r.get("farPulled") and r.get("farInView"), str(r))
    check("a placeholder in a closed folder shows while selected, and only it, with the folder closed", r.get("closedPulled") and r.get("closed") == {"only": True, "closed": True, "inView": True, "stored": True}, str(r))
    m.js(H + """other().gBrowser.addTrustedTab("https://example.org/?smoke-stay-later", {userContextId: args[0], inBackground: true}); await wait(2500); main().focus(); await wait(300); return 1;""", int(space.split("-")[-1]))
    r2 = sidebar_page(m, STAY_PUT + """
      const out = {}, [before, onTab] = args;
      const all = await tabs.query(obj({windowId: (await page.browser.windows.getCurrent()).id}));
      const used = all.find(x => x.id === before).lastAccessed;
      out.placeholderLater = all.some(t => t.url.includes("ghost.html") && t.lastAccessed > used);
      out.told = await until(async () => (await tabs.get(onTab)).successorTabId === before);
      await tabs.remove(onTab);
      await until(() => activeRow() && activeRow().dataset.tab !== String(onTab));
      await wait(300);
      out.landed = activeRow()?.dataset.tab === String(before);
      return out;""", r.get("before"), r.get("onTab"))
    check("closing a tab passes over a placeholder used later, for the loaded tab used before", r2 == {"placeholderLater": True, "told": True, "landed": True}, str(r2))
    # Nothing was lost or doubled by all that: each tab once per window, loaded once.
    r = m.js(H + """const out = {doubled: [], loadedTwice: []};
      const keys = new Set(wins().flatMap(w => w.gBrowser.tabs.map(t => key(w, t)).filter(Boolean)));
      for (const k of keys) {
        if (wins().some(w => w.gBrowser.tabs.filter(t => key(w, t) === k).length > 1)) out.doubled.push(k);
        if (wins().flatMap(w => w.gBrowser.tabs.filter(t => key(w, t) === k && role(w, t) === "live")).length > 1) out.loadedTwice.push(k);
      }
      return out;""")
    check("each tab is in a window once and live in one window, after all this", r == {"doubled": [], "loadedTwice": []}, str(r))

    # Its tabs must be out of the folder before closing them, or they only unload; and one
    # that is only a placeholder by now, having no page, is closed for good from the folder.
    sidebar_page(m, STAY_PUT + """for (const head of doc.querySelectorAll("#tabs .folder .head")) if (head.querySelector(".title").textContent === "Stay") {
        const unloaded = () => [...head.parentElement.querySelectorAll(".tab.unloaded")];
        for (const r of unloaded()) await tabs.remove(Number(r.dataset.tab));
        await until(() => !unloaded().length);
        send({type: "deleteFolder", key: head.dataset.folderHead});
      }
      await until(() => !folders().some(f => f.name === "Stay")); list.style.cssText = "";""")
    m.js(H + """await removeWhere((x, t) => url(t).includes("smoke-stay"));
      const w = main(); for (const t of [...w.gBrowser.tabs]) if (url(t).includes("/sidebar/sidebar.html")) w.gBrowser.removeTab(t);
      if (args[0]) await close(other());
      await wait(500); return 1;""", opened)


def alone_end(m):
    no_problems(m, "with Tidier alone")


# A folder's tabs as Firefox itself has them, in the main window and a window of this
# group's own: hidden or not, and loaded or not (an unloaded tab has no linkedPanel).
# `k` is a tab's key as it is stored.
REST = H + """
  const until = async (test, ms = 12000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(50)) if (test()) return true; return false; };
  const rest = () => wins().find(w => w.__rest), two = () => [main(), rest()];
  const tabsOf = (w, k) => w.gBrowser.tabs.filter(t => key(w, t) === JSON.stringify(k));
  const state = k => two().map(w => tabsOf(w, k).map(t => (t.hidden ? "hidden" : "shown") + (t.linkedPanel ? "/loaded" : "/unloaded")).join());
  const roles = k => two().map(w => tabsOf(w, k).map(t => role(w, t) + (t.linkedPanel ? "/loaded" : "/unloaded")).join());
  const rep = (w, k) => tabsOf(w, k)[0];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const resting = (ks, wanted = ["hidden/unloaded", "hidden/unloaded"]) => ks.every(k => same(state(k), wanted));
  const each = ks => Object.fromEntries(ks.map(k => [k, state(k)]));
"""


def real_clicks(m, x, y, clicks):
    """Clicks with the mouse, from Firefox itself: unlike .click() in a page they count as a
    double click when they come quickly, and the page must be in the selected tab."""
    press_release = [{"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]
    acts = [{"type": "pointerMove", "x": x, "y": y, "duration": 0, "origin": "viewport"}] + press_release
    for _ in range(clicks - 1):
        acts += [{"type": "pause", "duration": 60}] + press_release
    into_page(m, "/sidebar/sidebar.html")
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": acts}]})
    m.cmd("WebDriver:ReleaseActions")
    m.chrome()


def alone_folds_rest(m):
    # A closed folder rests, with real clicks and drags on the real sidebar, and read from
    # Firefox itself rather than from what Tidier thinks. In two windows, since a fold is
    # the same in every window and a tab is only loaded in one. The second is a new one,
    # since it starts in the space you are in, while other groups leave theirs anywhere.
    sidebar_page(m, "return 1;")
    m.js(H + """const a = main(); a.focus(); await wait(500);
      const want = a.gBrowser.tabs.filter(t => !t.pinned && role(a, t)).length, w = a.OpenBrowserWindow(); w.__rest = w.__extra = true;
      for (let i = 0; i < 200 && !(w.gBrowser && w.gBrowser.tabs.filter(t => !t.pinned && role(w, t)).length >= want); i++) await wait(50);
      await wait(2000); a.focus(); await wait(500); return 1;""")
    more_tabs_here(m, "rest")
    more_tabs_here(m, "drop")
    s = sidebar_page(m, """
      const space = spaces().find(s => s.active).id;
      send({type: "newFolder", space, name: "Resting"});
      await wait(1000);
      const key = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Resting").dataset.folderHead;
      const tabs = [...await page.browser.tabs.query({})];
      const rest = tabs.filter(t => t.url.includes("smoke-rest-")).map(t => t.id);
      for (const tabId of rest) { send({type: "moveTab", tabId, folder: key, before: null}); await wait(200); }
      await wait(1500);
      return {space, key, ctx: Number(space.split("-").pop()), rest, drop: tabs.filter(t => t.url.includes("smoke-drop-")).map(t => t.id)};""")
    ctx = s["ctx"]
    keys = m.js(REST + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
      return Object.keys(all).filter(k => all[k].parentKey === args[0]);""" % EXT_ID, s["key"])
    click_head = lambda name="Resting": sidebar_page(m, """
      [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === args[0]).click();
      await wait(50); return 1;""", name)
    first, second, selected = keys
    before = m.js(REST + """await until(() => resting(args[0], ["shown/loaded", "shown/unloaded"])); return each(args[0]);""", keys)

    # Renaming by a double click must not cost the pages: its first click closes the folder.
    # With the mouse, so with the page in front, which is put back afterwards.
    m.js(H + """const w = main(); w.__beforeRename = w.gBrowser.selectedTab; w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("/sidebar/sidebar.html")); await wait(500); return 1;""")
    head_at = sidebar_page(m, """const b = doc.querySelector(`[data-folder-head="${args[0]}"]`).getBoundingClientRect(); return {x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2)};""", s["key"])
    real_clicks(m, head_at["x"], head_at["y"], 2)
    r = sidebar_page(m, """await wait(1200);  // longer than a click waits for a second one
      const box = doc.querySelector(`[data-folder-head="${args[0]}"]`).parentElement, input = box.querySelector("input.rename");
      const was = {renaming: !!input, closed: box.classList.contains("collapsed")};
      input?.dispatchEvent(new page.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
      await wait(100);
      return {...was, name: box.querySelector(".head .title").textContent};""", s["key"])
    t = m.js(REST + """return {tabs: each(args[0]), still: resting(args[0], ["shown/loaded", "shown/unloaded"])};""", keys)
    check("a double click on a folder renames it, and leaves it open", r["renaming"] and not r["closed"] and r["name"] == "Resting", str(r))
    check("a double click on a folder unloads and hides nothing", t["still"], str(t))
    # Closed, by one click with the mouse: the head shows it at once, and once no second click
    # has come the tabs are hidden in both windows, and the real ones unloaded, on the address
    # they had. Then the page's tab gives way to the tab that was selected.
    real_clicks(m, head_at["x"], head_at["y"], 1)
    fold_seen = sidebar_page(m, """const box = doc.querySelector(`[data-folder-head="${args[0]}"]`).parentElement;
      return {closed: box.classList.contains("collapsed"), count: box.querySelector(".count").textContent};""", s["key"])
    m.js(H + "const w = main(); w.gBrowser.selectedTab = w.__beforeRename; delete w.__beforeRename; return 1;")
    check("one click with the mouse closes a folder at once, with its count", fold_seen == {"closed": True, "count": "3"}, str(fold_seen))
    r = m.js(REST + """const ok = await until(() => resting(args[0]));
      return {ok, tabs: each(args[0]), urls: args[0].map(k => url(rep(main(), k))), selected: url(main().gBrowser.selectedTab),
              ctrlTab: args[0].filter(k => main().ctrlTab.tabList.includes(rep(main(), k))).length};""", keys)
    check("a folder's tabs are loaded and shown before it closes", all(v[0] == "shown/loaded" and v[1] == "shown/unloaded" for v in before.values()), str(before))
    check("closing a folder hides its tabs in both windows and unloads them", r["ok"], str(r))
    check("a tab that rests keeps the address it was on", all("smoke-rest-" in u for u in r["urls"]), str(r))
    check("a closed folder's tabs are out of Firefox's own ⌃Tab list", r["ctrlTab"] == 0, str(r))
    r = sidebar_page(m, """const f = folders().find(f => f.name === "Resting"), head = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Resting");
      return {collapsed: f.collapsed, count: head.querySelector(".count").textContent, height: head.parentElement.querySelector(".children").offsetHeight};""")
    check("the closed folder shows how many tabs it holds, and no rows", r["collapsed"] and r["count"] == "3" and r["height"] == 0, str(r))

    # Opened: shown again, and nothing loads by itself.
    click_head()
    r = m.js(REST + """const ok = await until(() => resting(args[0], ["shown/unloaded", "shown/unloaded"])); await wait(1500);
      return {ok, tabs: each(args[0]), still: resting(args[0], ["shown/unloaded", "shown/unloaded"]), ctrlTab: args[0].filter(k => main().ctrlTab.tabList.includes(rep(main(), k))).length};""", keys)
    check("opening a folder shows its tabs and loads nothing", r["ok"] and r["still"], str(r))
    check("an open folder's tabs are back in ⌃Tab's list", r["ctrlTab"] == 3, str(r))

    # The selected tab stays until you leave it, then rests too.
    r = m.js(REST + """const w = main(), t = rep(w, args[0]); w.__beforeRest = w.gBrowser.selectedTab;
      w.gBrowser.selectedTab = t; return await until(() => t.linkedPanel && !url(t).includes("ghost.html"));""", selected)
    check("a tab in a folder is selected and loaded", r, str(r))
    click_head()
    r = m.js(REST + """const ok = await until(() => resting(args[0])); await wait(500);
      const w = main(), during = state(args[1]);
      w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("smoke-drop-3"));
      const left = await until(() => resting([args[1]]));
      return {ok, during, left, after: state(args[1])};""", [first, second], selected)
    check("the selected tab stays shown and loaded when its folder closes", r["ok"] and r["during"] == ["shown/loaded", "hidden/unloaded"], str(r))
    check("leaving a tab in a closed folder hides and unloads it", r["left"], str(r))

    # Selected again, Firefox shows and loads it; left again, it rests again.
    r = m.js(REST + """const w = main(), t = rep(w, args[0]), back = w.gBrowser.selectedTab;
      w.gBrowser.selectedTab = t;
      const shown = await until(() => !t.hidden && t.linkedPanel && t.linkedBrowser.browsingContext?.currentWindowContext); await wait(500);
      const during = state(args[0]), folder = args[1].map(state);
      w.gBrowser.selectedTab = back;
      return {shown, during, folder, left: await until(() => resting([args[0]])), after: state(args[0])};""", selected, [first, second])
    check("selecting a resting tab shows and loads it, and only it", r["shown"] and r["during"][0] == "shown/loaded" and all(x == ["hidden/unloaded", "hidden/unloaded"] for x in r["folder"]), str(r))
    check("left again, it rests again", r["left"], str(r))

    # Selected in the other window: the real tab comes along, loaded; left there, it rests there.
    r = m.js(REST + """const w = rest(), back = w.gBrowser.selectedTab; w.focus(); await wait(800);
      w.gBrowser.selectedTab = rep(w, args[0]);
      // The placeholder it leaves behind unloads itself once it shows its icon.
      const came = await until(() => same(roles(args[0]), ["ghost/unloaded", "live/loaded"]) && same(state(args[0]), ["hidden/unloaded", "shown/loaded"]) && !url(rep(w, args[0])).includes("ghost.html"));
      const during = {roles: roles(args[0]), state: state(args[0]), selected: rep(w, args[0]).selected};
      w.gBrowser.selectedTab = back;
      const left = await until(() => resting([args[0]]));
      main().focus(); await wait(800);
      return {came, during, left, after: state(args[0])};""", first)
    check("a resting tab selected in another window comes loaded, and its placeholder is hidden", r["came"] and r["during"]["selected"], str(r))
    check("left in that window, it rests there", r["left"], str(r))

    # Dropped on the closed folder's head, with a real drag: it rests, and the folder stays closed.
    drop = sidebar_page(m, """
      const head = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Resting");
      const from = doc.querySelector(`#tabs .tab[data-tab="${args[0]}"]`);
      const data = new page.DataTransfer(), box = head.getBoundingClientRect();
      const at = {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5, dataTransfer: data};
      from.dispatchEvent(new page.DragEvent("dragstart", at));
      head.dispatchEvent(new page.DragEvent("dragover", at));
      head.dispatchEvent(new page.DragEvent("drop", at));
      from.dispatchEvent(new page.DragEvent("dragend", at));
      await wait(50);
      return 1;""", s["drop"][0])
    r = m.js(REST + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs, k = () => Object.keys(all).find(k => !args[1].includes(k) && all[k].parentKey === args[0]);
      let dropped; await until(() => { for (const w of wins()) for (const t of w.gBrowser.tabs) if (url(t).includes("smoke-drop-1")) dropped = JSON.parse(key(w, t)); return dropped; });
      const ok = await until(() => resting([dropped]));
      return {ok, dropped, tabs: state(dropped), url: url(rep(main(), dropped))};""" % EXT_ID, s["key"], keys)
    check("a tab dropped on a closed folder's head is hidden and unloaded, in both windows", r["ok"], str(r))
    dropped = r["dropped"]
    r = sidebar_page(m, """await wait(500); const f = folders().find(f => f.name === "Resting"), head = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Resting");
      return {collapsed: f.collapsed, count: head.querySelector(".count").textContent};""")
    check("the folder stays closed, and counts the tab", r == {"collapsed": True, "count": "4"}, str(r))

    # What keeps working stays loaded: a page with unsaved input refuses, without asking,
    # and a tab playing sound is left alone. Hidden, both.
    r = m.js(REST + """const w = main(), selected = w.gBrowser.selectedTab;
      const typed = w.gBrowser.addTrustedTab(args[0] + "/unsaved", {userContextId: args[1], inBackground: true});
      await until(() => key(w, typed) && typed.linkedPanel);
      await wait(800);
      const loud = w.gBrowser.tabs.find(t => url(t).includes("smoke-drop-2"));
      loud.setAttribute("soundplaying", "true");
      return {typed: JSON.parse(key(w, typed)), loud: JSON.parse(key(w, loud))};""", m.pages, ctx)
    ids = sidebar_page(m, """const tabs = [...await page.browser.tabs.query({})];
      const typed = tabs.find(t => t.url.includes("/unsaved")), loud = tabs.find(t => t.url.includes("smoke-drop-2"));
      send({type: "moveTab", tabId: typed.id, folder: args[0], before: null}); await wait(300);
      send({type: "moveTab", tabId: loud.id, folder: args[0], before: null}); await wait(300);
      return {typed: typed.id, loud: loud.id, audible: loud.audible};""", s["key"])
    t = m.js(REST + """const w = main(), selected = w.gBrowser.selectedTab, was = url(selected);
      const ok = await until(() => state(args[0])[0].startsWith("hidden") && state(args[1])[0].startsWith("hidden"));
      await wait(1500);
      return {ok, typed: state(args[0]), loud: state(args[1]), selected: url(w.gBrowser.selectedTab) === was};""", r["typed"], r["loud"])
    check("Firefox reports the test's tab as playing sound", ids["audible"] is True, str(ids))
    check("a page with unsaved input is hidden and stays loaded, without asking", t["ok"] and t["typed"] == ["hidden/loaded", "hidden/unloaded"] and t["selected"], str(t))
    check("a tab playing sound is hidden and stays loaded", t["loud"] == ["hidden/loaded", "hidden/unloaded"], str(t))
    # Out again, and gone: shown again everywhere, and still as it was.
    sidebar_page(m, """send({type: "moveTab", tabId: args[0], folder: null, before: null}); await wait(300);
      send({type: "moveTab", tabId: args[1], folder: null, before: null}); await wait(300); return 1;""", ids["typed"], ids["loud"])
    o = m.js(REST + """const shown = await until(() => [args[0], args[1]].every(k => state(k)[0] === "shown/loaded" && state(k)[1] === "shown/unloaded"));
      const during = each([args[0], args[1]]);
      main().gBrowser.removeTab(rep(main(), args[0]), {skipPermitUnload: true});
      await until(() => !rep(main(), args[0]) && !rep(rest(), args[0]));
      rep(main(), args[1]).removeAttribute("soundplaying");
      return {shown, during};""", r["typed"], r["loud"])
    check("a tab moved out of a closed folder is shown again", o["shown"], str(o))

    # Deleting a closed folder gives its tabs back, shown and unloaded.
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(50); return 1;""", s["key"])
    gone = keys + [dropped]
    r = m.js(REST + """const ok = await until(() => resting(args[0], ["shown/unloaded", "shown/unloaded"])); return {ok, tabs: each(args[0])};""", gone)
    check("deleting a closed folder shows its tabs again, unloaded", r["ok"], str(r))
    m.js(REST + """const w = main(); if (w.__beforeRest && !w.__beforeRest.closing) w.gBrowser.selectedTab = w.__beforeRest; await wait(300);
      for (const k of args[0]) { const t = rep(w, k); if (t) w.gBrowser.removeTab(t); await wait(100); }
      await until(() => args[0].every(k => !rep(w, k) && !rep(rest(), k))); return 1;""", gone)

    # Left closed, for the checks after an update and a restart (alone_folds_rest_kept).
    s = sidebar_page(m, """
      send({type: "newFolder", space: args[0], name: "Resting still"}); await wait(1000);
      const key = [...doc.querySelectorAll("#tabs .folder .head")].find(h => h.querySelector(".title").textContent === "Resting still").dataset.folderHead;
      const tab = [...await page.browser.tabs.query({})].find(t => t.url.includes("smoke-drop-2"));
      send({type: "moveTab", tabId: tab.id, folder: key, before: null}); await wait(1200);
      return {key};""", s["space"])
    click_head("Resting still")
    r = m.js(REST + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs, k = Object.keys(all).find(k => all[k].parentKey === args[0]);
      return {k, ok: await until(() => resting([k])), tabs: state(k)};""" % EXT_ID, s["key"])
    check("another folder closes the same way, to stay closed", r["ok"], str(r))
    # A window you close and reopen comes back with its tabs hidden as they were. Reopened,
    # it knows them only once Tidier has taken them back, which is after it showed them.
    k = r["k"]
    r = m.js(REST + """await close(rest()); main().focus(); await wait(500);
      const w = main().SessionStore.undoCloseWindow(0); w.__rest = w.__extra = true;
      for (let i = 0; i < 200 && !w.gBrowser; i++) await wait(50);
      // Past the moment it is taken back, or a tab that was shown later would not be seen.
      for (let i = 0; i < 200 && !tabsOf(w, args[0]).length; i++) await wait(50);
      await wait(3000);
      return {ok: await until(() => resting([args[0]])), tabs: state(args[0])};""", k)
    check("a closed folder's tabs stay hidden in a window you reopen", r["ok"], str(r))
    m.js(REST + "await close(rest()); main().focus(); await wait(500); return 1;")
    no_problems(m, "with closed folders")


def alone_folds_rest_kept(m):
    # Firefox shows every hidden tab again at an update, and a start only hides (nothing is
    # unloaded then): a closed folder's tabs are hidden again by the time Tidier has started.
    r = m.js(H + """const all = (await storage("%s", ["syncedTabs"])).syncedTabs, f = Object.keys(all).find(k => all[k].name === "Resting still");
      const ks = Object.keys(all).filter(k => f && all[k].parentKey === f).map(k => JSON.stringify(k));
      const tabs = () => wins().flatMap(w => w.gBrowser.tabs.filter(t => ks.includes(key(w, t))).map(t => (t.hidden ? "hidden" : "shown") + (t.linkedPanel ? "/loaded" : "/unloaded")));
      for (let i = 0; i < 300 && !(tabs().length && tabs().every(t => t === "hidden/unloaded")); i++) await wait(50);
      return {f, tabs: tabs(), collapsed: f && all[f].collapsed};""" % EXT_ID)
    if not r["f"]:
        print("SKIP  alone_folds_rest_kept (needs alone_folds_rest before it)", flush=True)
        return
    check("a closed folder stays closed and its tabs hidden and unloaded, also after an update and a restart", r["collapsed"] and r["tabs"] and all(t == "hidden/unloaded" for t in r["tabs"]), str(r))


def alone_isolation_start(m):
    # Firefox closed, and a link from another app starts it: the request is held for
    # Tidier's listener, which comes back while its background page loads.
    if not m.can_restart:
        print("SKIP  alone_isolation_start (needs Tidier installed for real: Developer Edition, or --xpi)", flush=True)
        return
    base = m.pages
    # To another space and back by the key: that it is the last one is what must be kept for the start.
    press(m, "2", CTRL)
    time.sleep(1)
    press(m, "1", CTRL)
    time.sleep(1)
    space = m.js(H + "return main().gBrowser.selectedTab.userContextId;")
    m.js(GIVE_PERMISSIONS, EXT_ID, ["webRequest", "webRequestBlocking"], ["<all_urls>"])
    # The test declares Tidier alone through a stand-in for managed storage that exists only once
    # it has connected, which is later than this is about: so the setting as the settings page stores it.
    m.js(H + """const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID(args[0]).extension)); await db.set({tidierAlone: true}); return 1;""", EXT_ID)
    visit(m, space, f"{base}/set-cookie?v=at-start")
    m.js(ISOLATION_JS + """await closeAll("/set-cookie"); return 1;""")
    # A page you opened before there was a rule for it: Firefox restoring it, or you reloading it, is no reason to move it.
    visit(m, space, f"{base}/r/before-the-rule")
    other = 2 if space != 2 else 3
    extension_message(m, {"type": "settings:rules", "rules": [{"url": "before-the-rule", "space": f"firefox-container-{other}"}]})
    time.sleep(2.5)  # registered, so that it comes back
    extension_message(m, {"type": "flush"})
    time.sleep(1)
    # The first start since the permission came while Tidier ran: Firefox does not remember the
    # listener yet, so the page goes out, and is moved once Tidier has started. A pinned page
    # with no container too: Firefox loads those at once when it restores them.
    def page_with_no_container(address, **more):
        return {"entries": [{"url": address, "title": "x", "triggeringPrincipal_base64": '{"3":{}}'}], "index": 1, "lastAccessed": 1, "hidden": False, "attributes": {}, "userContextId": 0, **more}

    def with_pinned(state):
        state["windows"][0]["tabs"].insert(0, page_with_no_container(f"{base}/r/pinned-too-soon", pinned=True))
        state["windows"][0]["selected"] = state["windows"][0].get("selected", 1) + 1
    m.restart(f"{base}/r/link-too-soon", session=with_pinned)
    time.sleep(12)
    r = m.js(ISOLATION_JS + """return containersOf("link-too-soon");""")
    check("in the first start after the permission, a page that got out is moved to a space", r == [space], str(r))
    r = m.js(ISOLATION_JS + """return wins().flatMap(w => w.gBrowser.tabs.filter(t => url(t).includes("pinned-too-soon")).map(t => [t.userContextId, t.pinned]));""")
    check("and so is a pinned one, still pinned", r == [[space, True]], str(r))
    m.js(ISOLATION_JS + """await closeAll("link-too-soon"); await closeAll("pinned-too-soon"); return 1;""")
    extension_message(m, {"type": "flush"})
    time.sleep(1)
    m.restart(f"{base}/r/link-at-start")
    time.sleep(12)
    got = seen(m, "link-at-start")
    r = m.js(ISOLATION_JS + """return containersOf("link-at-start");""")
    check("a link that starts Firefox goes out in a space, from its first request", got and all(x["cookie"] == "login=at-start" for x in got), str(got))
    check("and its tab is there, in a space", r == [space], str(r))
    r = m.js(ISOLATION_JS + """const w = main(), t = w.gBrowser.tabs.find(x => url(x).includes("before-the-rule"));
      if (!t) return {missing: true};
      const before = {ctx: t.userContextId, loaded: !!t.linkedPanel};
      w.gBrowser.selectedTab = t; await wait(2000);
      const restored = containersOf("before-the-rule");
      w.gBrowser.reloadTab(t); await wait(1500);
      return {before, restored, reloaded: containersOf("before-the-rule")};""")
    check("a tab Firefox restores is not moved by a rule, nor when you reload it", r.get("restored") == [space] and r.get("reloaded") == [space], str(r))
    extension_message(m, {"type": "settings:rules", "rules": []})
    m.js(ISOLATION_JS + """await closeAll("/r/"); return 1;""")
    extension_message(m, {"type": "flush"})
    time.sleep(1)

    # A session holding pages with no container: selected (Firefox loads it at once), pinned
    # (the same) and in the background (only when selected). Held, all of them.
    def with_pages(state):
        tabs = state["windows"][0]["tabs"]
        tabs.insert(0, page_with_no_container(f"{base}/r/restored-pinned", pinned=True))
        tabs.append(page_with_no_container(f"{base}/r/restored-behind"))
        tabs.append(page_with_no_container(f"{base}/r/restored-selected"))
        state["windows"][0]["selected"] = len(tabs)
    m.restart(session=with_pages)
    time.sleep(12)
    r = m.js(ISOLATION_JS + """const w = main(); return {selected: containersOf("restored-selected"), pinned: wins().flatMap(w => w.gBrowser.tabs.filter(t => url(t).includes("restored-pinned")).map(t => [t.userContextId, t.pinned])), behind: w.gBrowser.tabs.filter(t => url(t).includes("restored-behind")).map(t => [t.userContextId, !!t.linkedPanel])};""")
    check("a restored page with no container, selected, is in the space", r["selected"] == [space], str(r))
    check("a pinned one too, still pinned", r["pinned"] == [[space, True]], str(r))
    for part in ("restored-selected", "restored-pinned"):
        got = seen(m, part)
        check(f"{part}: every request carries the space's cookie, from the first one on", got and all(x["cookie"] == "login=at-start" for x in got), str(got))
    check("one in the background waits, sending nothing", r["behind"] == [[0, False]] and not seen(m, "restored-behind"), f"{r} {seen(m, 'restored-behind')}")
    r = m.js(ISOLATION_JS + """const w = main(); w.gBrowser.selectedTab = w.gBrowser.tabs.find(t => url(t).includes("restored-behind")); await until(() => containersOf("restored-behind").some(c => c), 6000); await wait(800); return containersOf("restored-behind");""")
    check("selected, it loads in the space", r == [space], str(r))
    got = seen(m, "restored-behind")
    check("with its cookie, from the first request on", got and all(x["cookie"] == "login=at-start" for x in got), str(got))
    m.js(ISOLATION_JS + """await closeAll("/r/restored-"); return 1;""")

    # An update: for a moment nothing is listening. A link opened then may go out, but with
    # no login, and every one ends up in a space.
    r = m.js(ISOLATION_JS + """const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"), {FileUtils} = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
      const w = main(), install = await AddonManager.getInstallForFile(new FileUtils.File(args[0]));
      const done = install.install();
      for (let i = 0; i < 20; i++) { w.gBrowser.addTrustedTab(args[1] + i, {inBackground: true}); await wait(100); }
      await done; await wait(10000);
      return containersOf("/r/during-update-");""", m.update_xpi(), f"{base}/r/during-update-")
    check("links opened during an update are each in the space, once", sorted(r) == [space] * 20, str(r))
    got = seen(m, "/r/during-update-")
    check("and each request carried the space's cookie or none, never another's", got and all(x["cookie"] in ("", "login=at-start") for x in got), str(got))
    m.js(ISOLATION_JS + """await closeAll("/r/during-update-"); return 1;""")

    # A space's proxy: Firefox decides on it as it opens a request, before any extension has
    # run at a start. Here this is the first start since it was set, the hardest one: only an
    # address nothing can reach but the proxy shows that it went that way. Going directly it
    # would never reach the server.
    third = next(c for c in (1, 2, 3) if c not in (space, other))
    m.js(GIVE_PERMISSIONS, EXT_ID, ["proxy"], ["<all_urls>"])
    extension_message(m, {"type": "isolation:network", "id": f"firefox-container-{third}", "proxy": {"type": "http", "host": "127.0.0.1", "port": base.rsplit(":", 1)[1]}})
    time.sleep(1)
    far = "http://proxied.invalid/r/proxied-at-start"
    r = m.js(ISOLATION_JS + """const w = main(), t = inTab(args[0], args[1]); await until(() => url(t) === args[1], 8000); await wait(2500); w.gBrowser.selectedTab = t; await wait(1500); return url(t);""", third, far)
    check("a page in a space with a proxy goes through it", r == far and all(x["proxied"] for x in seen(m, "proxied-at-start")), f"{r} {seen(m, 'proxied-at-start')}")
    extension_message(m, {"type": "flush"})
    time.sleep(1)
    before = len(seen(m, "proxied-at-start"))
    m.restart()
    time.sleep(12)
    got = seen(m, "proxied-at-start")[before:]
    r = m.js(ISOLATION_JS + """const w = main(); return {selected: url(w.gBrowser.selectedTab), ctx: w.gBrowser.selectedTab.userContextId};""")
    check("restored at a start, that page still reaches the server, through the proxy", got and all(x["proxied"] for x in got) and r == {"selected": far, "ctx": third}, f"{r} {got}")
    extension_message(m, {"type": "isolation:network", "id": f"firefox-container-{third}"})
    m.js(ISOLATION_JS + """await closeAll("proxied.invalid"); return 1;""")
    press(m, "1", CTRL)
    time.sleep(1)
    no_problems(m, "after a start by a link")


# Each window's tabs and space, and the folders.
SNAP_ALONE = H + """
  const all = (await storage("%s", ["syncedTabs"])).syncedTabs;
  const windows = wins().map(w => ({
    essentials: w.gBrowser.tabs.filter(t => t.pinned).map(t => ek(w, t)).sort(),
    tabs: w.gBrowser.tabs.filter(t => !t.pinned && key(w, t)).map(t => key(w, t)).sort(),
    shown: [...new Set(w.gBrowser.tabs.filter(t => !t.pinned && !t.hidden && t.userContextId).map(t => t.userContextId))].length,
    live: w.gBrowser.tabs.filter(t => !t.pinned && role(w, t) === "live").length,
  })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return {windows, folders: Object.values(all).filter(e => e.own).map(e => e.name).sort(), inFolders: Object.values(all).filter(e => e.saved).length};""" % EXT_ID

ALONE_GROUPS = (alone_setup, alone_second_window, alone_spaces, alone_keys, alone_folders, alone_moves, alone_drag, alone_archive, alone_live_folders,
                alone_drag_details,
                alone_settings, alone_copy, alone_copy_and_import,
                alone_safe_moves,
                alone_quiet_undo,
                alone_tab_menu,
                alone_tab_names,
                alone_selection,
                alone_space_menu,
                alone_stay_put,
                alone_new_tab,
                alone_folds_rest,
                alone_sound,
                alone_news,
                alone_touches,
                alone_isolation,
                alone_requests,
                alone_crossing,
                alone_archived,
                alone_idle, alone_update, alone_folds_rest_kept, alone_end, alone_restart, alone_folds_rest_kept, alone_isolation_start)


GROUPS = (external_links, new_window, more_windows, essentials, folders, tab_sync, folder_pull, tab_moves, saved_tabs, quiet_off, ghost_title,
          pinned_ghost, orphans, popups, archiving, shortcuts, look,
          sidebar_setting_off,
          tab_menu_off,
          live_folders, many_tabs, trees, handover, reopened_window, update, restart, move_over)
# What a group needs run before it (as setup, reported only if it fails) when
# it runs without it: the second window new_window opens, and the window
# handover closes, which reopened_window reopens.
NEEDS = {g: [new_window] for g in (essentials, folders, tab_sync, folder_pull, tab_moves, saved_tabs, ghost_title, pinned_ghost,
                                   archiving, live_folders, many_tabs, handover)}
NEEDS[reopened_window] = [new_window, handover]
NEEDS[update] = [new_window]
NEEDS[move_over] = [new_window]
# By default the groups run in these parallel runs, each in its own test
# Firefox, about equally long (the whole test in about a third of the time).
SHARDS = (  # measured: about 120, 145 and 140 s on a Mac, before saved_tabs (about 60 s)
    (external_links, new_window, more_windows, orphans, popups, shortcuts, look, sidebar_setting_off, ghost_title, saved_tabs, quiet_off, tab_menu_off),
    (essentials, folders, tab_sync, folder_pull, tab_moves, trees, pinned_ghost),
    (archiving, live_folders, many_tabs, handover, reopened_window, update, restart),
    (move_over,),
)

def run_alone(groups, xpi, port):
    """Run Tidier-alone groups in a test Firefox of their own, in ALONE_GROUPS order."""
    with TestFirefox(xpi=xpi, port=port, alone=True) as m:
        for group in [g for g in ALONE_GROUPS if g in groups]:
            t0 = time.time()
            try:
                group(m)
            except Exception:
                check(f"{group.__name__} ran", False, traceback.format_exc(limit=2).strip().splitlines()[-1])
                m.chrome()
            print(f"TIME  {group.__name__} {round(time.time() - t0)} s", flush=True)


def run_groups(groups, xpi, port):
    """Run some groups in one test Firefox, in GROUPS order."""
    global sidebery_version, setup_only
    with TestFirefox(xpi=xpi, port=port) as m:
        sidebery_version = m.js("""const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          return (await AddonManager.getAddonByID(args[0])).version;""", SIDEBERY_ID)
        print(f"Sidebery {sidebery_version}", flush=True)
        needed = {n for g in groups for n in NEEDS.get(g, [])} - set(groups)
        setup = [g for g in GROUPS if g in needed]
        for group in setup + [g for g in GROUPS if g in groups]:
            setup_only = group in setup
            t0 = time.time()
            try:
                group(m)
            except Exception:
                check(f"{group.__name__} ran", False, traceback.format_exc(limit=2).strip().splitlines()[-1])
                m.chrome()
            # Sidebery sorts pinned tabs by space when Firefox starts, so
            # essentials apart from their space would be reordered then.
            apart = m.js(H + PINS_APART)
            if apart:
                apart_after.append((group.__name__, apart))
                print(f"INFO  essentials apart from their space after {group.__name__}: {apart}", flush=True)
            if not setup_only:
                print(f"TIME  {group.__name__} {round(time.time() - t0)} s", flush=True)
        setup_only = False
        if restart not in groups and move_over not in groups:  # which end with a new background page, and check before it
            no_problems(m, "by the end of the run")
    check("every window's essentials stay together by space", not apart_after, str(apart_after[:2]))


def run_parallel(argv, base=PORT):
    """Run SHARDS at the same time, each as `smoke.py --only ... --port ...`, and add up."""
    procs = [subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), "--only", ",".join(g.__name__ for g in shard),
                               "--port", str(base + 1 + i), *argv], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
             for i, shard in enumerate(SHARDS)]
    procs.append(subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), "--only", ",".join(g.__name__ for g in ALONE_GROUPS),
                                   "--port", str(base + 1 + len(SHARDS)), *argv], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
    passed = total = known_bugs = 0
    for p in procs:
        out = p.communicate()[0]
        for line in out.splitlines():
            if line.startswith(("PASS", "FAIL", "KNOWN", "SKIP", "INFO", "TIME")):
                print(line, flush=True)
            elif m := re.match(r"(\d+)/(\d+) passed.*?(?:\((\d+) known)?", line):
                passed, total, known_bugs = passed + int(m[1]), total + int(m[2]), known_bugs + int(m[3] or 0)
        if p.returncode and not re.search(r"^\d+/\d+ passed", out, re.M):
            print(f"FAIL  a parallel run crashed:\n{out[-1500:]}", flush=True)
            total += 1
    return passed, total, known_bugs


def main():
    args = sys.argv[1:]
    xpi, passthrough = None, []
    if "--xpi" in args:
        xpi = args[args.index("--xpi") + 1]
        passthrough = ["--xpi", xpi]
    elif "--installed" in args:
        xpi = glob.glob(os.path.expanduser(f"~/Library/Application Support/Firefox/Profiles/*.default-release/extensions/{EXT_ID}.xpi"))[0]
        passthrough = ["--installed"]
    port = int(args[args.index("--port") + 1]) if "--port" in args else PORT
    t0 = time.time()
    if "--only" in args:
        names = args[args.index("--only") + 1].split(",")
        unknown = [n for n in names if n not in {g.__name__ for g in GROUPS + ALONE_GROUPS}]
        if unknown:
            raise SystemExit(f"Unknown group(s) {unknown}; groups: {', '.join(g.__name__ for g in GROUPS + ALONE_GROUPS)}")
        print(f"Testing {xpi or EXT_DIR} in a test Firefox: {', '.join(names)}", flush=True)
        if any(g.__name__ in names for g in GROUPS):
            run_groups({g for g in GROUPS if g.__name__ in names}, xpi, port)
        if any(g.__name__ in names for g in ALONE_GROUPS):
            run_alone({g for g in ALONE_GROUPS if g.__name__ in names}, xpi, port)
        passed, total, known_bugs = sum(results), len(results), len(known)
    elif "--serial" in args:
        print(f"Testing {xpi or EXT_DIR} in a test Firefox", flush=True)
        run_groups(set(GROUPS), xpi, port)
        run_alone(set(ALONE_GROUPS), xpi, port)
        passed, total, known_bugs = sum(results), len(results), len(known)
    else:
        print(f"Testing {xpi or EXT_DIR} in {len(SHARDS)} test Firefoxes at once", flush=True)
        passed, total, known_bugs = run_parallel(passthrough, port)
    print(f"\n{passed}/{total} passed in {round(time.time() - t0)} s"
          + (f" ({known_bugs} known Sidebery bug)" if known_bugs else ""))
    sys.exit(0 if passed == total else 1)


main()
