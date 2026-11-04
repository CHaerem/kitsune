#!/usr/bin/python3
"""Put every tab back in its own Sidebery space (the space of its container).

Sidebery keeps the space ("panel") of each tab itself. It does not apply its
container rules to pinned tabs, and a tab can also end up in the wrong space
in other ways. Other extensions cannot change that, so this script does it:

    tools/fix_spaces.py          # fix, then restart Firefox normally
    tools/fix_spaces.py --check  # only report

It restarts Firefox with Marionette. Essentials: it disables Sidebery, sets
each pinned tab's space from its container (the container each Sidebery space
opens new tabs in), in Sidebery's tab cache and the tab's session data, and
enables Sidebery again. Other tabs: Sidebery gives a tab the space it sits in
in the tab strip, so a tab in the wrong space is moved to just before the first
tab of its own space (or after its last tab, or before it, until Sidebery
puts it in the right space; at a border, Sidebery's choice is not predictable).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests"))
from marionette import start_with_marionette, restart_normally  # noqa: E402

SIDEBERY_ID = "{3c078156-979c-498b-8990-85f7987dd929}"

SCRIPT = """
  const {setTimeout: sT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const {ExtensionStorageIDB} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const [SB, fix] = args, key = "extension:" + SB + ":data";
  const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(WebExtensionPolicy.getByID(SB).extension));
  const {sidebar} = await db.get(["sidebar"]);
  // The space for a container: the tabs panel that opens new tabs in it.
  const panelFor = {};
  for (const p of Object.values(sidebar.panels)) if (p.type === 2 && p.newTabCtx && p.newTabCtx !== "none") panelFor[p.newTabCtx] = p.id;
  const ctxOf = t => t.userContextId ? "firefox-container-" + t.userContextId : "firefox-default";
  const data = (w, t) => { try { return JSON.parse(w.SessionStore.getCustomTabValue(t, key) || "{}"); } catch (e) { return {}; } };
  const wrongTabs = (pinned = true) => [...Services.wm.getEnumerator("navigator:browser")].flatMap(w =>
    w.gBrowser.tabs.filter(t => t.pinned === pinned && t.userContextId && panelFor[ctxOf(t)] && data(w, t).panelId
      && data(w, t).panelId !== panelFor[ctxOf(t)]).map(t => [w, t]));
  const describe = list => list.map(([w, t]) => [t.label, data(w, t).panelId, panelFor[ctxOf(t)]]);
  const before = describe([...wrongTabs(true), ...wrongTabs(false)]);
  if (!fix || !before.length) return {wrong: before};
  // Other tabs, while Sidebery runs: move each into its own space. Which space
  // Sidebery gives a moved tab at a border is not predictable, so try a few
  // places and keep the first that Sidebery puts in the right space.
  for (const [w, t] of wrongTabs(false)) {
    const want = panelFor[ctxOf(t)];
    const home = () => w.gBrowser.tabs.filter(x => !x.pinned && x !== t && data(w, x).panelId === want);
    const places = [h => w.gBrowser.moveTabBefore(t, h[0]), h => w.gBrowser.moveTabAfter(t, h[h.length - 1]), h => w.gBrowser.moveTabBefore(t, h[h.length - 1])];
    for (const place of places) {
      const h = home();
      if (!h.length) break;
      place(h); await wait(2000);
      if (data(w, t).panelId === want) break;
    }
  }
  if (!wrongTabs(true).length) { await wait(3000); return {wrong: before, stillWrong: describe(wrongTabs(false)).map(x => x[0])}; }
  const sb = await AddonManager.getAddonByID(SB);
  await sb.disable(); await wait(1500);
  const {tabsDataCache} = await db.get(["tabsDataCache"]);
  for (const win of tabsDataCache || []) for (const t of win) if (t.pin && panelFor[t.ctx]) t.panelId = panelFor[t.ctx];
  await db.set({tabsDataCache});
  for (const [w, t] of wrongTabs()) { const d = data(w, t); d.panelId = panelFor[ctxOf(t)]; w.SessionStore.setCustomTabValue(t, key, JSON.stringify(d)); }
  await sb.enable(); await wait(8000);
  return {wrong: before, stillWrong: describe([...wrongTabs(true), ...wrongTabs(false)]).map(x => x[0])};
"""


def main():
    fix = "--check" not in sys.argv
    m = start_with_marionette()
    try:
        r = m.js(SCRIPT, SIDEBERY_ID, fix)
    finally:
        restart_normally(m)
    print(json.dumps(r, ensure_ascii=False, indent=1))
    if not r["wrong"]:
        print("All tabs are in their own space.")
    elif fix:
        print("Still wrong: %d" % len(r["stillWrong"]) if r["stillWrong"] else "Fixed %d tabs." % len(r["wrong"]))
    sys.exit(1 if (r.get("stillWrong") or (not fix and r["wrong"])) else 0)


main()
