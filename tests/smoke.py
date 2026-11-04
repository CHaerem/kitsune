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
    essentials and folders per container, each container in one Sidebery space;
  - every tab sits in its container's space in every window, also after an
    essential is closed (and brought back) or newly pinned, and after a tab is
    pulled in from another window;
  - selecting a ghost pulls the live tab in; closing a tab closes it
    everywhere; closing a window hands its tabs over;
  - pinning a tab makes it an essential everywhere; unpinning a copy removes
    it everywhere; an essential copy opens the real page in its container;
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
  - live folders (when the native host is installed) are in both windows.
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
NATIVE_HOST = os.path.expanduser("~/Library/Application Support/Mozilla/NativeMessagingHosts/kitsune_github.json")

# Shared helpers for the chrome-context scripts below.
H = """
  const {setTimeout: sT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const {ExtensionStorageIDB} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const storage = async (id, keys) => (await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID(id).extension))).get(keys);
  const wins = () => [...Services.wm.getEnumerator("navigator:browser")];
  const main = () => wins().find(w => !w.__smoke), other = () => wins().find(w => w.__smoke);
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


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


def press(m, key, *mods):
    acts = [{"type": "keyDown", "value": k} for k in mods] + [{"type": "keyDown", "value": key}, {"type": "keyUp", "value": key}]
    acts += [{"type": "keyUp", "value": k} for k in reversed(mods)]
    m.cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kb", "actions": acts}]})
    m.cmd("WebDriver:ReleaseActions")


def extension_message(m, msg):
    """Send a runtime message from one of the extension's own pages, and return the reply."""
    m.js(H + """const w = main(); w.focus();
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
    m.cmd("WebDriver:CloseWindow")
    m.chrome()
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
      if (copy) { other().gBrowser.unpinTab(copy); await wait(4000); }
      r.leftPinned = wins().map(w => w.gBrowser.tabs.filter(x => x.pinned && ek(w, x) === k).length);
      await removeWhere((w, x) => url(x).includes("smoke-pin"));
      return r;""")
    check("a pinned tab becomes an essential in every window, in its space", r["key"] and r["copy"] and r["spaces"] == [r["want"]] * 2, str(r))
    check("unpinning a copy removes the essential everywhere", r["leftPinned"] == [0, 0], str(r))
    r = m.js(H + """
      const w = other(); w.focus(); await wait(500);
      const e = w.gBrowser.tabs.find(t => t.pinned && url(t).includes("ghost.html") && !t.linkedPanel);
      if (!e) return null;
      const ctx = e.userContextId; w.gBrowser.selectedTab = e; await wait(4000);
      return {web: /^https?:/.test(url(e)), pinned: e.pinned, sameContainer: e.userContextId === ctx};""")
    check("an essential copy opens the real page, pinned, in its container", r and all(r.values()), str(r))
    r = m.js(H + """
      const byKey = Object.fromEntries((await storage("%s", ["essentials"])).essentials.map(e => [e.key, e.name || e.title]));
      const w = other(), copies = w.gBrowser.tabs.filter(t => t.pinned && !t.linkedPanel && ek(w, t));
      return {copies: copies.length, wrong: copies.filter(t => t.label !== byKey[ek(w, t)]).map(t => [t.label, byKey[ek(w, t)]])};""" % EXT_ID)
    check("unloaded essentials show their name", r["copies"] > 0 and not r["wrong"], str(r))


def tab_sync(m):
    r = m.js(H + """
      const t = main().gBrowser.addTrustedTab("https://example.org/?smoke-sync", {userContextId: 3, inBackground: true});
      await wait(4500); const k = key(main(), t), created = find(k);
      const w = other(); w.focus(); await wait(800);
      const t0 = Date.now(), ghost = w.gBrowser.tabs.find(x => key(w, x) === k); w.gBrowser.selectedTab = ghost;
      let ms = null; for (let i = 0; i < 100 && ms === null; i++) { await wait(15); if (w.gBrowser.selectedTab !== ghost && key(w, w.gBrowser.selectedTab) === k) ms = Date.now() - t0; }
      await wait(2500); const pulled = find(k);
      const pf = await panelFor(), moved = w.gBrowser.tabs.find(x => key(w, x) === k), left = main().gBrowser.tabs.find(x => key(main(), x) === k);
      const spaces = [sbPanel(w, moved) === pf[ctxOf(moved)], left && sbPanel(main(), left) === pf[ctxOf(left)]];
      w.gBrowser.removeTab(moved); await wait(3000);
      return {created, ms, pulled, spaces, closed: find(k)};""")
    check("a new tab gets a ghost in the other window", r["created"] == [["live/loaded"], ["ghost/unloaded"]], str(r["created"]))
    check(f"selecting a ghost pulls the live tab in ({r['ms']} ms)", r["pulled"] == [["ghost/unloaded"], ["live/loaded"]], str(r["pulled"]))
    check("a pulled tab and the ghost left behind stay in their space", r["spaces"] == [True, True], str(r["spaces"]))
    check("closing a tab closes it everywhere", r["closed"] == [[], []], str(r["closed"]))
    r = m.js(H + """
      const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const a = await AddonManager.getAddonByID("%s"); await a.disable(); await wait(1500); await a.enable(); await wait(6000);
      const t = main().gBrowser.addTrustedTab("https://example.org/?smoke-restart", {userContextId: 3, inBackground: true});
      await wait(4500); const r = find(key(main(), t)); main().gBrowser.removeTab(t); await wait(3000); return r;""" % EXT_ID)
    check("the extension starts again after being disabled and enabled", r == [["live/loaded"], ["ghost/unloaded"]], str(r))


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
    if not os.path.exists(NATIVE_HOST):
        print("SKIP  live folders (native host not installed: native/install.sh)")
        return
    live = m.js(H + """const groups = Object.values((await storage("%s", ["liveFolders"])).liveFolders || {}).map(f => JSON.stringify(f.groupKey));
      const n = w => w.gBrowser.tabs.filter(t => groups.includes(key(w, t))).length; return [n(main()), n(other())];""" % EXT_ID)
    check("live folders are in both windows", live[0] > 0 and live[0] == live[1], f"main {live[0]}, new {live[1]}")


def handover(m):
    r = m.js(H + """
      const t = other().gBrowser.addTrustedTab("https://example.org/?smoke-handover", {userContextId: 1, inBackground: true});
      await wait(4500); const k = key(other(), t);
      await close(other());
      return find(k);""")
    check("closing a window hands its tabs over", r in ([["live/unloaded"]], [["live/loaded"]]), str(r))
    wrong = m.js(H + "return await misplaced(main());")
    check("every tab in the main window is still in its container's space", not wrong, str(wrong[:5]))


def main():
    xpi = None
    if "--xpi" in sys.argv:
        xpi = sys.argv[sys.argv.index("--xpi") + 1]
    elif "--installed" in sys.argv:
        xpi = glob.glob(os.path.expanduser(f"~/Library/Application Support/Firefox/Profiles/*.default-release/extensions/{EXT_ID}.xpi"))[0]
    print(f"Testing {xpi or EXT_DIR} in a test Firefox", flush=True)
    t0 = time.time()
    with TestFirefox(xpi=xpi) as m:
        for group in (external_links, new_window, essentials, tab_sync, archiving, shortcuts, look, live_folders, handover):
            try:
                group(m)
            except Exception:
                check(f"{group.__name__} ran", False, traceback.format_exc(limit=2).strip().splitlines()[-1])
                m.chrome()
    print(f"\n{sum(results)}/{len(results)} passed in {round(time.time() - t0)} s")
    sys.exit(0 if all(results) else 1)


main()
