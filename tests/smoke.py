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
    m.cmd("Marionette:SetContext", {"value": "content"})
    for h in m.cmd("WebDriver:GetWindowHandles"):
        m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
        if "ghost.html?kind=test" in m.cmd("WebDriver:GetCurrentURL"):
            break
    # The answer comes before the message goes: the page is gone once it has.
    m.cmd("WebDriver:ExecuteAsyncScript", {"script": """const done = arguments[arguments.length - 1], msg = arguments[0], page = window.wrappedJSObject || window;
      setTimeout(() => page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify(msg))), 300); done(1);""", "args": [msg]})
    m.chrome()
    time.sleep(1)


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
    m.cmd("Marionette:SetContext", {"value": "content"})
    for h in m.cmd("WebDriver:GetWindowHandles"):
        m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
        if path in m.cmd("WebDriver:GetCurrentURL"):
            break
    reply = m.cmd("WebDriver:ExecuteAsyncScript", {"script": """
      const args = [...arguments], done = args.pop(), wait = ms => new Promise(r => setTimeout(r, ms));
      const page = window.wrappedJSObject || window, doc = page.document;
      const rows = () => [...doc.querySelectorAll("#tabs .tab")].map(r => r.querySelector(".title").textContent);
      const folders = () => [...doc.querySelectorAll("#tabs .folder")].map(f => ({name: f.querySelector(".head .title")?.textContent, tabs: [...f.querySelectorAll(".tab .title")].map(t => t.textContent), collapsed: f.classList.contains("collapsed")}));
      const tiles = () => [...doc.querySelectorAll("#essentials .tile")].map(t => t.title);
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
    r = m.js(H + """const counts = wins().map(w => w.gBrowser.tabs.filter(t => !t.pinned && t.linkedBrowser && !key(w, t) && /^https:/.test(url(t))).length); return counts;""")
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
    m.js(ISOLATION_JS + """await closeAll("rule-typed"); await closeAll("saved-one"); return 1;""")
    sidebar_page(m, """send({type: "deleteFolder", key: args[0]}); await wait(800); return 1;""", folder)

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
      await until(() => url(t).includes("rule-back")); await wait(400);
      typed(t, args[1]); await until(() => url(t) === args[1]); await wait(400);
      t.linkedBrowser.goBack(); await until(() => url(t).includes("rule-back")); await wait(1000);
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


def alone_idle(m):
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
    before = m.js(SNAP_ALONE)
    m.restart()
    m.js(H + """for (let i = 0; i < 100 && wins().length < 2; i++) await wait(200); await wait(12000); return 1;""")
    after = m.js(SNAP_ALONE)
    check("after a restart with Tidier alone, the same tabs, folders and one space shown", before == after, f"{before} -> {after}")


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
      for (let i = 0; i <= reach.indexOf(plainTabs()[0]); i++) key("ArrowDown");
      const chosen = doc.querySelector(".cursor");
      out.cursor = chosen === plainTabs()[0];
      await wait(100);
      return out;""")
    check("the arrow keys move through the sidebar", r.get("cursor") is True, str(r))
    check("a tab dragged onto a folder goes into it", r.get("into") == {"left": True, "inFolder": True}, str(r))
    check("a tab dragged out of a folder is an ordinary tab, where you put it", r.get("out") == {"back": True, "last": True}, str(r))
    check("a tab dragged above another is there", r.get("before") is True, str(r))
    check("a tab dragged to the essentials is an essential, and dragged back an ordinary tab", r.get("pinned") is True and r.get("unpinned") is True, str(r))


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
    check("a copy says what it holds per space", summary.get("firefox-container-1", {}).get("essentials") == 2, str(summary))
    merged = extension_message(m, {"type": "settings:merge", "copy": copy, "spaces": ["firefox-container-1"]})
    check("taking in a copy of what is already here adds nothing", merged == {"essentials": 0, "folders": 0, "tabs": 0}, str(merged))


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


def alone_end(m):
    no_problems(m, "with Tidier alone")


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
                alone_settings, alone_copy, alone_isolation, alone_requests, alone_crossing, alone_idle, alone_update, alone_end, alone_restart, alone_isolation_start)


GROUPS = (external_links, new_window, more_windows, essentials, folders, tab_sync, folder_pull, tab_moves, saved_tabs, ghost_title,
          pinned_ghost, orphans, popups, archiving, shortcuts, look, live_folders, many_tabs, trees, handover, reopened_window, update, restart, move_over)
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
    (external_links, new_window, more_windows, orphans, popups, shortcuts, look, ghost_title, saved_tabs),
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
