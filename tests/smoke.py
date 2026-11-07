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
        m.cmd("Marionette:SetContext", {"value": "content"})
        for h in m.cmd("WebDriver:GetWindowHandles"):
            m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
            if text in m.cmd("WebDriver:GetCurrentURL"):
                break
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
    m.cmd("Marionette:SetContext", {"value": "content"})
    for h in m.cmd("WebDriver:GetWindowHandles"):
        m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
        if path in m.cmd("WebDriver:GetCurrentURL"):
            break
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(x), "y": int(y), "duration": 0},
        {"type": "pointerDown", "button": button}, {"type": "pointerUp", "button": button}]}]})
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
        at = sidebar_page(m, MENU_PAGE + """const r = rowOf(args[0]).getBoundingClientRect(), x = r.left + 30, y = r.top + 8;
          await rightClick(rowOf(args[0])); const first = rowOf(args[0]).getBoundingClientRect();
          const item = [...menu.querySelectorAll(".item")].find(i => i.textContent === "Copy address").getBoundingClientRect();
          menu.hidden = true;
          return {x, y, dx: item.left + 12 - (first.left + 8), dy: item.top + 8 - (first.top + 8)};""", b)
        base = m.js(H + """const w = main(); w.focus(); await wait(300);
          // A panel of Firefox's own (it says when an extension hides tabs) would take the first click.
          for (const p of w.document.querySelectorAll("panel, menupopup")) if (p.state === "open") p.hidePopup();
          await wait(300); const r = w.SidebarController.browser.getBoundingClientRect(); return [r.left, r.top];""")
        m.js(clipboard + 'Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("before"); return 1;')
        pointer = lambda x, y, button: m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(x), "y": int(y), "duration": 0}, {"type": "pointerDown", "button": button}, {"type": "pointerUp", "button": button}]}]})
        x, y = base[0] + at["x"], base[1] + at["y"]
        pointer(x, y, 2)
        m.cmd("WebDriver:ReleaseActions")
        time.sleep(0.5)
        pointer(x + at["dx"], y + at["dy"], 0)
        m.cmd("WebDriver:ReleaseActions")
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


def alone_tab_names(m):
    # Real keys and clicks in the sidebar page, in front. renameKept is what the tab
    # menu's Rename calls; everything after that is what you do in the box.
    ENTER, ESC, BACKSPACE = "\ue007", "\ue00c", "\ue003"
    PAGE = "/sidebar/sidebar.html"
    pages = {}
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
        """To the tab with `text` in its address. Switching to a tab loads it, so a walk through
        placeholders leaves them loaded for the groups after this one: only once. A tab can close
        during the walk."""
        m.cmd("Marionette:SetContext", {"value": "content"})
        if text in pages:
            m.cmd("WebDriver:SwitchToWindow", {"handle": pages[text], "focus": False})
            return
        for _ in range(100):
            for h in m.cmd("WebDriver:GetWindowHandles"):
                try:
                    m.cmd("WebDriver:SwitchToWindow", {"handle": h, "focus": False})
                    if text in m.cmd("WebDriver:GetCurrentURL"):
                        pages[text] = h
                        return
                except RuntimeError as e:
                    if "no such window" not in str(e):
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
      const drag = (from, to, below = false) => {
        const data = new page.DataTransfer(), box = to.getBoundingClientRect();
        const at = {bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + (below ? box.height - 1 : 1), dataTransfer: data};
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
      drag(row(y1), doc.getElementById("essentials"));
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
    ELSEWHERE, IN_SPACE = ["Rename", "Unload this space", "Settings"], ["Rename", "Unload this space", "Clear today's tabs", "Settings"]
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
    r = menu_on(m, EMPTY_LIST, ["New folder", "Clear today's tabs", "Settings"])
    check("the empty part of the list has its own short menu", r == ["New folder", "Clear today's tabs", "Settings"], str(r))
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


def alone_end(m):
    no_problems(m, "with Tidier alone")


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
                alone_settings, alone_copy,
                alone_safe_moves,
                alone_quiet_undo,
                alone_tab_menu,
                alone_tab_names,
                alone_selection,
                alone_space_menu,
                alone_idle, alone_update, alone_end, alone_restart)


GROUPS = (external_links, new_window, more_windows, essentials, folders, tab_sync, folder_pull, tab_moves, saved_tabs, quiet_off, ghost_title,
          pinned_ghost, orphans, popups, archiving, shortcuts, look,
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
    (external_links, new_window, more_windows, orphans, popups, shortcuts, look, ghost_title, saved_tabs, quiet_off, tab_menu_off),
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
