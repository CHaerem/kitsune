// Tab sync: regular tabs "live" across windows, like Zen's window sync.
//
// Firefox ties a tab to one window, so a tab cannot really be in two windows.
// Instead every synced tab is *live* in exactly one window, and every other
// window has an unloaded *ghost* of it (same URL, title, container and place
// in the Sidebery tree). When you select a ghost, the live tab is moved into
// your window and the window it came from gets a ghost instead. There is
// always only one loaded copy of each tab.
//
// Sidebery folders (group pages) are not moved; each window keeps its own
// *copy* of the group page, and the ghosts are nested under that copy.
//
// - New tab / navigating a new tab to a page -> ghosts appear in other windows.
// - Closing a tab (live or ghost)            -> closed in every window.
//   Closing a folder copy only affects its own window.
// - Selecting a ghost, or focusing a window
//   whose selected tab is a ghost            -> the live tab is pulled in.
// - Closing a window                         -> its live tabs are taken over
//                                               by a ghost in another window.
// - Pinning a tab                            -> it becomes an essential and
//                                               leaves tab sync.
//
// Ghosts keep the title they had when created; the live tab brings its
// current page when it is pulled in.
//
// Tree structure is read from `openerTabId`, which Sidebery keeps equal to
// the parent in its tree.

const syncedList = storedValue("syncedTabs", () => ({})); // { [key]: { url, title, cookieStoreId, parentKey, group, added } }
const SYNC_KEY = "syncKey";   // sessions value: key of the logical tab
const SYNC_ROLE = "syncRole"; // sessions value: "live" | "ghost" | "copy"
const SETTLE_MS = 1500;       // wait for redirects / container reopen before registering

const syncKeyByTab = new Map();  // tabId -> key
const syncRoleByTab = new Map(); // tabId -> role
const syncBusy = new Set();      // tab IDs we are changing ourselves
let pulling = false;             // true while we move tabs, so activations we cause are ignored
let started = false;             // tab sync waits for startup before reacting

const syncable = tab => !tab.pinned && !tab.incognito && (isWeb(tab.url) || isSideberyGroup(tab.url));
const getSynced = () => syncedList.get();
const saveSynced = all => syncedList.set(all);
// Sidebery adds a channel suffix ("~!...!~") to group URLs; strip it when copying.
// (Ghost placeholder URLs come from ghostUrl() in common.js.)
const groupBaseUrl = url => url.replace(/~!.*!~$/, "");

function setRole(tabId, key, role) {
  syncKeyByTab.set(tabId, key);
  syncRoleByTab.set(tabId, role);
  return Promise.all([
    browser.sessions.setTabValue(tabId, SYNC_KEY, key),
    browser.sessions.setTabValue(tabId, SYNC_ROLE, role),
  ]);
}

function forget(tabId) {
  syncKeyByTab.delete(tabId);
  syncRoleByTab.delete(tabId);
}

function clearRole(tabId) {
  forget(tabId);
  return Promise.all([
    browser.sessions.removeTabValue(tabId, SYNC_KEY),
    browser.sessions.removeTabValue(tabId, SYNC_ROLE),
  ]);
}

// Tabs that represent `key` (live, ghost or copy).
function repsOf(key, tabs) {
  return tabs.filter(t => syncKeyByTab.get(t.id) === key);
}

// key -> tab ID of its representation, for the tabs of one window.
function repMap(tabs) {
  const map = new Map();
  for (const t of tabs) if (syncKeyByTab.has(t.id)) map.set(syncKeyByTab.get(t.id), t.id);
  return map;
}

function liveTabId(key) {
  for (const [id, k] of syncKeyByTab) if (k === key && syncRoleByTab.get(id) === "live") return id;
  return undefined;
}

// Rebuild the in-memory maps from the sessions values (after startup).
async function loadRoles() {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map(async t => {
    const [key, role] = await Promise.all([
      browser.sessions.getTabValue(t.id, SYNC_KEY),
      browser.sessions.getTabValue(t.id, SYNC_ROLE),
    ]);
    if (key && role) { syncKeyByTab.set(t.id, key); syncRoleByTab.set(t.id, role); }
  }));
}

// Create the representation of `key` in a window: a copy for Sidebery group
// pages, a ghost (placeholder page, see ghost.js) for everything else, nested
// under its parent.
async function createRep(windowId, key, entry, parentId, index) {
  const props = { windowId, active: false, cookieStoreId: entry.cookieStoreId };
  if (parentId !== undefined) props.openerTabId = parentId;
  if (index !== undefined) props.index = index;
  const tab = await browser.tabs.create({ ...props, url: entry.group ? groupBaseUrl(entry.url) : ghostUrl("ghost", key) });
  syncBusy.add(tab.id);
  await setRole(tab.id, key, entry.group ? "copy" : "ghost");
  setTimeout(() => syncBusy.delete(tab.id), SETTLE_MS);
  return tab;
}

// The window with the most synced tabs, other than `exceptWindowId`. Its order
// is the one Sidebery already keeps consistent, so other windows copy it.
function referenceWindow(tabs, exceptWindowId) {
  const counts = new Map();
  for (const t of tabs) {
    if (t.windowId !== exceptWindowId && syncKeyByTab.has(t.id)) counts.set(t.windowId, (counts.get(t.windowId) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// Keys in the order they appear in the reference window (parents come before
// their children there), followed by any keys it does not have, with each
// space's tabs together (see bySpace).
function keysInReferenceOrder(all, tabs, exceptWindowId) {
  const ref = referenceWindow(tabs, exceptWindowId);
  const order = tabs.filter(t => t.windowId === ref && syncKeyByTab.has(t.id))
    .sort((a, b) => a.index - b.index).map(t => syncKeyByTab.get(t.id)).filter(k => all[k]);
  const seen = new Set(order);
  for (const k of Object.keys(all)) if (!seen.has(k)) order.push(k);
  return bySpace(order, k => all[k].cookieStoreId);
}

// The same items with each container's (so each space's) together, in the
// order the spaces first appear, keeping the order within a space. The
// reference window's own order is not always that: Sidebery shows a tab
// added at the end of the window (a link from another app, a tab opened by
// another extension) in its space without moving it there, but a new
// window's sidebar assigns spaces by walking the tabs in order, and would
// put such interleaved tabs in the wrong space.
function bySpace(items, spaceOf) {
  const groups = new Map();
  for (const item of items) {
    const space = spaceOf(item);
    if (!groups.has(space)) groups.set(space, []);
    groups.get(space).push(item);
  }
  return [...groups.values()].flat();
}

// Sidebery assigns tabs to panels by walking the window's tab strip in panel
// order, so each panel's tabs must be one contiguous run, in the same panel
// order in every window. Tabs added to a fresh window can end up out of
// order, so after filling a window we give it the reference window's order.
async function sortLikeReference(windowId) {
  const tabs = await browser.tabs.query({});
  const ref = referenceWindow(tabs, windowId);
  if (ref === undefined) return;
  const refTabs = bySpace(tabs.filter(t => t.windowId === ref && !t.pinned && syncKeyByTab.has(t.id))
    .sort((a, b) => a.index - b.index), t => t.cookieStoreId);
  const refOrder = refTabs.map(t => syncKeyByTab.get(t.id));
  const here = tabs.filter(t => t.windowId === windowId && !t.pinned && syncKeyByTab.has(t.id));
  const byKey = new Map(here.map(t => [syncKeyByTab.get(t.id), t]));
  const ordered = refOrder.map(k => byKey.get(k)).filter(Boolean);
  const current = [...here].sort((a, b) => a.index - b.index);
  if (current.map(t => t.id).join() === ordered.map(t => t.id).join()) return;
  const firstUnpinned = tabs.filter(t => t.windowId === windowId && t.pinned).length;
  ordered.forEach(t => syncBusy.add(t.id));
  await browser.tabs.move(ordered.map(t => t.id), { windowId, index: firstUnpinned });
  setTimeout(() => ordered.forEach(t => syncBusy.delete(t.id)), SETTLE_MS);
}

// Sidebery puts the first pinned tab of a new window in the active panel,
// whatever its container. A throwaway pinned tab takes that place while the
// essentials are created, and is removed afterwards.
async function withPinnedPlaceholder(windowId, fn) {
  const tab = await browser.tabs.create({ windowId, url: "about:blank", active: false, pinned: true });
  syncBusy.add(tab.id);
  try { await fn(); } finally { await browser.tabs.remove(tab.id).catch(() => {}); }
}

// Give a window everything it is missing: essentials first, then a ghost or
// copy of every synced tab, in the reference window's order.
//
// In a new window the essentials wait to be pinned until Sidebery's sidebar
// there has started (see pinEssentialCopies); the ghosts are created
// meanwhile.
async function fillWindow(windowId, { fresh = false } = {}) {
  let created = 0;
  const addReps = async () => {
    const all = await getSynced();
    const tabs = await browser.tabs.query({});
    const reps = repMap(tabs.filter(t => t.windowId === windowId));
    for (const key of keysInReferenceOrder(all, tabs, windowId)) {
      if (reps.has(key)) continue;
      const entry = all[key];
      const tab = await createRep(windowId, key, entry, entry.parentKey ? reps.get(entry.parentKey) : undefined);
      reps.set(key, tab.id);
      created++;
      await sleep(CREATE_GAP_MS);
    }
  };
  if (fresh) {
    await withPinnedPlaceholder(windowId, () => ensureWindow(windowId, async essentials => {
      await addReps();
      await sidebarStarted(windowId, essentials);
    }));
  } else {
    await ensureWindow(windowId);
  }
  await addReps(); // everything, if no essentials were missing; else whatever came meanwhile
  if (created > 1) {
    await sleep(SORT_SETTLE_MS); // let Sidebery finish placing the new tabs first
    await sortLikeReference(windowId);
  }
}

// Sidebery's sidebar has no signal meant for other extensions, but two of
// the things it does when it starts in a window can be seen: it hides the tabs
// of the spaces you are not in (its setting "hide tabs of inactive panels"),
// and it tells Firefox which tab to select when you close the current one
// (successorTabId, unless "after closing the active tab" is set to nothing).
// Meanwhile the essentials' placeholders are loaded again every PROBE_MS, so
// once the sidebar runs it moves each to its container's space. Without either
// sign it gives up after SIDEBAR_WAIT_MS.
async function sidebarStarted(windowId, essentials) {
  const t0 = Date.now();
  let probed = t0, probes = 0;
  while (Date.now() - t0 < SIDEBAR_WAIT_MS) {
    const sign = await sidebarSign(windowId);
    if (sign) { noteSidebarWait({ ms: Date.now() - t0, probes, sign }); return; }
    if (Date.now() - probed >= PROBE_MS) { probed = Date.now(); probes++; await reloadPlaceholders(essentials); }
    await sleep(100);
  }
  noteSidebarWait({ ms: Date.now() - t0, probes, sign: null });
}

async function sidebarSign(windowId) {
  const tabs = await browser.tabs.query({ windowId }).catch(() => []);
  if (tabs.some(t => t.hidden)) return "hidden";
  const active = tabs.find(t => t.active);
  if (active && active.successorTabId !== undefined && active.successorTabId !== browser.tabs.TAB_ID_NONE) return "successor";
  return null;
}

// The last few waits, for the smoke test's timing report.
const sidebarWaits = [];
const noteSidebarWait = w => { sidebarWaits.push(w); if (sidebarWaits.length > 20) sidebarWaits.shift(); };
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "sidebarWaits" || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return Promise.resolve(sidebarWaits);
});

// Make sure every synced tab has exactly one live tab and every window exactly
// one representation of it, then fill in what is missing. Safe to run repeatedly.
async function reconcileAll() {
  const all = await getSynced();
  const wins = await normalWindows();
  const winIds = new Set(wins.map(w => w.id));
  const tabs = (await browser.tabs.query({})).filter(t => winIds.has(t.windowId));

  // Drop tabs whose key is no longer synced (e.g. state from an old install).
  // A placeholder of such a tab has nothing to show, so it is closed.
  const gone = [];
  for (const t of tabs) {
    const key = syncKeyByTab.get(t.id);
    if (!key || all[key]) continue;
    if (isGhostUrl(t.url)) { gone.push(key); syncBusy.add(t.id); forget(t.id); await browser.tabs.remove(t.id).catch(() => {}); }
    else await clearRole(t.id);
  }
  if (gone.length) await forgetClosedPlaceholders("ghost", gone);

  for (const key of Object.keys(all)) {
    const reps = repsOf(key, tabs);
    if (!reps.length) { delete all[key]; continue; } // nothing left anywhere: the tab is gone
    if (!all[key].group) {
      const live = reps.filter(t => syncRoleByTab.get(t.id) === "live");
      // Exactly one live tab: prefer a loaded one.
      const keep = live.find(t => !t.discarded) || live[0] || reps.find(t => !t.discarded) || reps[0];
      if (syncRoleByTab.get(keep.id) !== "live") await setRole(keep.id, key, "live");
      // Keep title and icon current (older entries have no icon).
      if (isWeb(keep.url)) Object.assign(all[key], { title: keep.title || all[key].title, icon: keep.favIconUrl || all[key].icon });
      for (const t of live) if (t.id !== keep.id) await setRole(t.id, key, "ghost");
    }
    for (const w of wins) {
      // More than one representation in a window: remove the extra ghosts.
      // Live tabs and folder copies are never removed here; they may hold
      // your page or Sidebery children.
      const here = reps.filter(t => t.windowId === w.id);
      const ghosts = here.filter(t => syncRoleByTab.get(t.id) === "ghost");
      const extra = here.length > ghosts.length ? ghosts : ghosts.slice(1);
      for (const t of extra) { syncBusy.add(t.id); forget(t.id); await browser.tabs.remove(t.id); }
      if (extra.length) await forgetClosedPlaceholders("ghost", [key]);
    }
  }
  saveSynced(all);
  for (const w of wins) await fillWindow(w.id);
}

// A real tab that is not synced yet: register it and add ghosts elsewhere.
async function register(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || syncKeyByTab.has(tab.id) || !syncable(tab)) return;
  // Only tabs in ordinary windows: a sign-in popup (window.open) is not a tab
  // you keep, and pulling its tab into another window would break the sign-in.
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  if (!win || win.type !== "normal" || win.incognito) return;
  const all = await getSynced();
  const key = crypto.randomUUID();
  const parentKey = tab.openerTabId ? syncKeyByTab.get(tab.openerTabId) || null : null;
  const entry = { url: tab.url, title: tab.title, icon: tab.favIconUrl, cookieStoreId: tab.cookieStoreId, parentKey, group: isSideberyGroup(tab.url), added: Date.now() };
  all[key] = entry;
  saveSynced(all);
  await setRole(tab.id, key, entry.group ? "copy" : "live");
  const tabs = await browser.tabs.query({});
  for (const w of await normalWindows()) {
    if (w.id === tab.windowId) continue;
    const parentId = parentKey ? repMap(tabs.filter(t => t.windowId === w.id)).get(parentKey) : undefined;
    await createRep(w.id, key, entry, parentId);
  }
}

// The tab was closed by you (not by closing its window): close it everywhere.
// Live folder tabs closed by you are remembered (see livefolders.js).
async function closeEverywhere(key, { dismiss = true } = {}) {
  const all = await getSynced();
  if (dismiss) await noteLiveFolderDismissed(all[key]);
  delete all[key];
  lastRefresh.delete(key);
  saveSynced(all);
  const reps = repsOf(key, await browser.tabs.query({}));
  reps.forEach(t => { syncBusy.add(t.id); forget(t.id); });
  if (reps.length) await browser.tabs.remove(reps.map(t => t.id));
  await forgetClosedPlaceholders("ghost", [key]);
}

// Forget a synced entry once no window has a tab for it any more.
async function dropIfUnused(key) {
  if (repsOf(key, await browser.tabs.query({})).length) return;
  const all = await getSynced();
  delete all[key];
  saveSynced(all);
}

// The live tab's window is closing: a ghost in another window takes over.
async function handOver(key, closingWindowId) {
  const reps = repsOf(key, await browser.tabs.query({})).filter(t => t.windowId !== closingWindowId);
  if (reps.length) await setRole(reps[0].id, key, "live");
}

// Pull the live tab for `ghostId` into the ghost's window. The part you see
// (moving the tab in and selecting it) happens first; the bookkeeping after.
async function pull(ghostId) {
  const key = syncKeyByTab.get(ghostId);
  if (!key || syncRoleByTab.get(ghostId) !== "ghost") return;
  const liveId = liveTabId(key);
  const [ghost, live] = await Promise.all([
    browser.tabs.get(ghostId).catch(() => null),
    liveId === undefined ? null : browser.tabs.get(liveId).catch(() => null),
  ]);
  if (!ghost) return;
  if (!live || live.windowId === ghost.windowId) {
    // No live tab to pull: the ghost becomes the live tab and loads itself.
    await setRole(ghostId, key, "live");
    return;
  }
  pulling = true;
  syncBusy.add(live.id); syncBusy.add(ghostId);
  try {
    const fromWindow = live.windowId, fromIndex = live.index, fromOpener = live.openerTabId;
    if (live.active) {
      // Leave the old window on a tab that is already loaded, preferably in the
      // same space, so the old window does not load anything in the background.
      const oldTabs = await browser.tabs.query({ windowId: fromWindow, hidden: false, discarded: false });
      const calm = oldTabs.find(t => t.id !== live.id && t.cookieStoreId === live.cookieStoreId) ||
        oldTabs.find(t => t.id !== live.id);
      if (calm) await browser.tabs.update(calm.id, { active: true });
    }
    await browser.tabs.move(live.id, { windowId: ghost.windowId, index: ghost.index });
    await browser.tabs.update(live.id, { active: true });

    // Bookkeeping.
    forget(ghostId);
    const all = await getSynced();
    const entry = all[key];
    const tabsHere = await browser.tabs.query({ windowId: ghost.windowId });
    const parentId = entry?.parentKey ? repMap(tabsHere).get(entry.parentKey) : undefined;
    await Promise.all([
      browser.tabs.remove(ghostId),
      parentId !== undefined ? browser.tabs.update(live.id, { openerTabId: parentId }).catch(() => {}) : null,
    ]);
    await forgetClosedPlaceholders("ghost", [key]);
    if (entry) {
      // A never-loaded live tab is still a placeholder page; keep the real URL then.
      if (isWeb(live.url)) Object.assign(entry, { url: live.url, title: live.title, icon: live.favIconUrl || entry.icon });
      saveSynced(all);
      // The old window gets a ghost where the live tab was.
      const opener = fromOpener !== undefined && (await browser.tabs.get(fromOpener).catch(() => null));
      await createRep(fromWindow, key, entry, opener && opener.windowId === fromWindow ? opener.id : undefined, fromIndex);
    }
  } finally {
    setTimeout(() => { syncBusy.delete(live.id); syncBusy.delete(ghostId); pulling = false; }, 600);
  }
}

// --- Events ---------------------------------------------------------------

const pending = new Map(); // tabId -> timer, for registering new tabs after they settle
function registerSoon(tabId) {
  clearTimeout(pending.get(tabId));
  pending.set(tabId, setTimeout(() => { pending.delete(tabId); serial(() => register(tabId)); }, SETTLE_MS));
}

browser.tabs.onCreated.addListener(tab => {
  if (!started || syncBusy.has(tab.id) || syncKeyByTab.has(tab.id)) return;
  registerSoon(tab.id);
});

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!started || syncBusy.has(tabId)) return;
  const key = syncKeyByTab.get(tabId);
  if (!key) {
    // A new tab that has navigated to a page, e.g. "New Tab" -> a URL.
    if (change.url || change.status === "complete") registerSoon(tabId);
    return;
  }
  if (change.pinned === true) {
    // Pinned tabs are essentials; they leave tab sync.
    serial(async () => {
      const all = await getSynced(); delete all[key]; saveSynced(all);
      await clearRole(tabId);
      const others = repsOf(key, await browser.tabs.query({})).filter(t => t.id !== tabId);
      others.forEach(t => { syncBusy.add(t.id); forget(t.id); });
      if (others.length) await browser.tabs.remove(others.map(t => t.id));
      await forgetClosedPlaceholders("ghost", [key]);
    });
    return;
  }
  if (syncRoleByTab.get(tabId) === "live" && (change.status === "complete" || change.favIconUrl || change.title)) {
    serial(async () => {
      const all = await getSynced();
      const entry = all[key];
      if (!entry || !isWeb(tab.url)) return;
      const changed = entry.title !== tab.title || (tab.favIconUrl && entry.icon !== tab.favIconUrl);
      Object.assign(entry, { url: tab.url, title: tab.title, icon: tab.favIconUrl || entry.icon });
      saveSynced(all);
      if (changed) refreshGhostsSoon(key);
    });
  }
});

// The live tab's title or icon changed: reload its ghosts so they show it.
// Reloading a ghost only loads the local placeholder page, which unloads itself.
// The first change is shown after REFRESH_DELAY_MS; a page whose title keeps
// changing (a timer, an unread count) refreshes its ghosts at most once every
// REFRESH_GAP_MS, with the newest title, so the ghosts neither churn nor go
// stale while it changes.
const REFRESH_DELAY_MS = 3000, REFRESH_GAP_MS = 60000;
const refreshTimers = new Map(), lastRefresh = new Map();
function refreshGhostsSoon(key) {
  if (refreshTimers.has(key)) return; // the pending refresh will show the newest title
  const wait = Math.max(REFRESH_DELAY_MS, (lastRefresh.get(key) || 0) + REFRESH_GAP_MS - Date.now());
  refreshTimers.set(key, setTimeout(() => serial(async () => {
    refreshTimers.delete(key);
    lastRefresh.set(key, Date.now());
    for (const t of repsOf(key, await browser.tabs.query({ discarded: true }))) {
      if (syncRoleByTab.get(t.id) === "ghost") await browser.tabs.update(t.id, { url: ghostUrl("ghost", key) }).catch(() => {});
    }
  }), wait));
}

// --- Placeholder pages (ghost.js) ----------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab;
  if (!tab || sender.id !== browser.runtime.id) return;
  if (msg.type === "ghostInfo") return ghostInfo(msg.kind, msg.key);
  if (msg.type === "ghostReady") { unloadWhenIconShown(tab.id, sender.url, msg.icon); return; }
  if (msg.type === "ghostOrphan") return serial(() => closeOrphan(tab.id, msg.kind, msg.key));
  // A ghost is being shown. It loads the real page itself only when there is
  // no live tab to pull in (the pull runs from onActivated, in the queue).
  if (msg.type === "ghostShown") {
    return serial(async () => {
      const key = syncKeyByTab.get(tab.id);
      if (!key) return { load: true };
      if (syncRoleByTab.get(tab.id) === "live" || liveTabId(key) === undefined) {
        await setRole(tab.id, key, "live");
        return { load: true };
      }
      return { load: false };
    });
  }
});

// A placeholder is unloaded once Firefox shows its icon: an unloaded tab keeps
// the icon it has, so unloaded sooner it would have none. Only the load that
// asked is unloaded: a placeholder loaded again meanwhile (a new address, or
// the same one still loading) would be unloaded before it has its title, and
// show its address instead. That load asks again when it is ready.
const awaitingIcon = new Map(); // tabId -> address of the placeholder that is ready
function unloadWhenIconShown(tabId, url, hasIcon) {
  awaitingIcon.set(tabId, url);
  browser.tabs.get(tabId).then(t => { if (!hasIcon || t.favIconUrl) unloadGhost(tabId); }, () => awaitingIcon.delete(tabId));
}
function unloadGhost(tabId, tries = 0) {
  const url = awaitingIcon.get(tabId);
  if (!awaitingIcon.delete(tabId)) return;
  browser.tabs.get(tabId).then(t => {
    if (t.active || !isGhostUrl(t.url) || t.url !== url) return;
    if (t.status === "complete") return browser.tabs.discard(tabId);
    // Still finishing its own load: look again shortly.
    if (tries < 10) setTimeout(() => { if (!awaitingIcon.has(tabId)) { awaitingIcon.set(tabId, url); unloadGhost(tabId, tries + 1); } }, 300);
  }).catch(() => {});
}
browser.tabs.onUpdated.addListener(tabId => {
  if (awaitingIcon.has(tabId)) unloadGhost(tabId);
}, { properties: ["favIconUrl"] });

// A placeholder whose tab or essential no longer exists (left from before a
// restart, or by an older version) has nothing to show or open: it is closed.
async function closeOrphan(tabId, kind, key) {
  if (!["ghost", "essential", "lazy"].includes(kind) || (await ghostInfo(kind, key))) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || !isGhostUrl(tab.url)) return;
  syncBusy.add(tabId); busy.add(tabId); forget(tabId);
  await browser.tabs.remove(tabId).catch(() => {});
  await forgetClosedPlaceholders(kind, [key]);
}

async function ghostInfo(kind, key) {
  const entry = kind === "essential"
    ? (await getList()).find(e => e.key === key)
    : (await getSynced())[key];
  return entry ? { url: entry.url, title: entry.name || entry.title, icon: entry.icon } : null;
}

browser.tabs.onRemoved.addListener((tabId, info) => {
  clearTimeout(pending.get(tabId)); pending.delete(tabId);
  awaitingIcon.delete(tabId);
  const key = syncKeyByTab.get(tabId), role = syncRoleByTab.get(tabId);
  forget(tabId);
  if (!started || !key || syncBusy.has(tabId)) { syncBusy.delete(tabId); return; }
  if (info.isWindowClosing) {
    if (role === "live") serial(() => handOver(key, info.windowId));
    return;
  }
  // Folder copies belong to their window: closing one leaves the others alone
  // (Sidebery itself may close a group page, and that must not spread).
  if (role === "copy") { serial(() => dropIfUnused(key)); return; }
  serial(() => closeEverywhere(key));
});

// Selecting a ghost in the window you are using pulls the live tab in.
browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!started || pulling || syncRoleByTab.get(tabId) !== "ghost" || windowId !== focusedWindowId) return;
  serial(() => pull(tabId));
});

// Switching to a window whose selected tab is a ghost pulls the live tab in.
browser.windows.onFocusChanged.addListener(windowId => {
  if (!started || pulling || windowId === browser.windows.WINDOW_ID_NONE) return;
  serial(async () => {
    const [active] = await browser.tabs.query({ windowId, active: true });
    if (active && syncRoleByTab.get(active.id) === "ghost") await pull(active.id);
  });
});

// You dragged a tab to another window: fix up both windows.
browser.tabs.onAttached.addListener(tabId => {
  if (!started || pulling || syncBusy.has(tabId) || !syncKeyByTab.has(tabId)) return;
  serial(reconcileAll);
});

// A new window gets essentials and ghosts of every synced tab.
// A window you reopened (History → Recently Closed Windows, ⌘⇧N) comes back
// with its tabs' Kitsune values: its tabs are taken back instead, so nothing
// is doubled (see adoptRestored).
browser.windows.onCreated.addListener(win => {
  if (!started || win.type !== "normal" || win.incognito) return;
  setTimeout(() => serial(async () => {
    if (await adoptRestored(win.id)) await reconcileAll();
    else await fillWindow(win.id, { fresh: true });
  }), NEW_WINDOW_DELAY_MS);
});

// Tabs restored with their Kitsune values: a tab still synced is taken back
// as what it was (reconcileAll then keeps one live tab and one tab per window);
// a placeholder of a tab closed since is removed; any other tab is left to be
// registered as new. Returns whether the window had any.
async function adoptRestored(windowId) {
  const all = await getSynced();
  let found = false;
  const removed = [];
  for (const t of await browser.tabs.query({ windowId })) {
    if (syncKeyByTab.has(t.id)) continue;
    const [key, role] = await Promise.all([
      browser.sessions.getTabValue(t.id, SYNC_KEY),
      browser.sessions.getTabValue(t.id, SYNC_ROLE),
    ]);
    if (!key || !role) continue;
    found = true;
    if (all[key]) { syncKeyByTab.set(t.id, key); syncRoleByTab.set(t.id, role); continue; }
    if (isGhostUrl(t.url)) { syncBusy.add(t.id); removed.push(key); await browser.tabs.remove(t.id).catch(() => {}); }
    else await clearRole(t.id);
  }
  if (removed.length) await forgetClosedPlaceholders("ghost", removed);
  return found;
}

// --- Startup --------------------------------------------------------------

// First run: every real tab that can be synced becomes a live tab.
async function initSynced() {
  if (Object.keys(await getSynced()).length) return;
  const all = {};
  for (const w of await normalWindows()) {
    const tabs = (await browser.tabs.query({ windowId: w.id })).sort((a, b) => a.index - b.index);
    for (const t of tabs) {
      if (!syncable(t)) continue;
      const key = crypto.randomUUID();
      const parentKey = t.openerTabId ? syncKeyByTab.get(t.openerTabId) || null : null;
      all[key] = { url: t.url, title: t.title, icon: t.favIconUrl, cookieStoreId: t.cookieStoreId, parentKey, group: isSideberyGroup(t.url), added: Date.now() };
      await setRole(t.id, key, all[key].group ? "copy" : "live");
    }
  }
  saveSynced(all);
}

// Session restore and Sidebery need a moment after startup before we act.
async function start(delayMs) {
  await sleep(delayMs);
  await serial(async () => {
    await initList();
    await loadRoles();
    await initSynced();
    await reconcileAll(); // also adds missing essentials, via fillWindow
    await foldersFirstAll(); // folders.js
  });
  started = true;
}
let startRequested = false;
function requestStart(delayMs) {
  if (startRequested) return;
  startRequested = true;
  start(delayMs);
}
browser.runtime.onStartup.addListener(() => requestStart(5000));
browser.runtime.onInstalled.addListener(() => requestStart(1000));
// Enabled again after being disabled: neither event fires, so start anyway.
// onStartup/onInstalled arrive right after the background page loads, well
// within this delay.
setTimeout(() => requestStart(1000), 2000);
