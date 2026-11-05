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
// their children there), followed by any keys it does not have.
function keysInReferenceOrder(all, tabs, exceptWindowId) {
  const ref = referenceWindow(tabs, exceptWindowId);
  const order = tabs.filter(t => t.windowId === ref && syncKeyByTab.has(t.id))
    .sort((a, b) => a.index - b.index).map(t => syncKeyByTab.get(t.id)).filter(k => all[k]);
  const seen = new Set(order);
  for (const k of Object.keys(all)) if (!seen.has(k)) order.push(k);
  return order;
}

// Sidebery assigns tabs to panels by walking the window's tab strip in panel
// order, so each panel's tabs must be one contiguous run, in the same panel
// order in every window. Tabs added to a fresh window can end up out of
// order, so after filling a window we give it the reference window's order.
async function sortLikeReference(windowId) {
  const tabs = await browser.tabs.query({});
  const ref = referenceWindow(tabs, windowId);
  if (ref === undefined) return;
  const refOrder = tabs.filter(t => t.windowId === ref && syncKeyByTab.has(t.id))
    .sort((a, b) => a.index - b.index).map(t => syncKeyByTab.get(t.id));
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
// there has started (see pinEssentialCopies): the ghosts are created
// meanwhile, and Sidebery hiding the tabs of the other spaces (its setting
// "hide tabs of inactive panels") shows that it has. Without that sign it
// waits SIDEBAR_WAIT_MS.
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
    await withPinnedPlaceholder(windowId, () => ensureWindow(windowId, async () => {
      await addReps();
      await sidebarStarted(windowId);
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

// Resolves once Sidebery has hidden a tab in the window (it hides the tabs of
// the spaces you are not in), or after SIDEBAR_WAIT_MS.
async function sidebarStarted(windowId) {
  const t0 = Date.now();
  while (Date.now() - t0 < SIDEBAR_WAIT_MS) {
    const hidden = await browser.tabs.query({ windowId, hidden: true }).catch(() => []);
    if (hidden.length) return;
    await sleep(100);
  }
}

// Make sure every synced tab has exactly one live tab and every window exactly
// one representation of it, then fill in what is missing. Safe to run repeatedly.
async function reconcileAll() {
  const all = await getSynced();
  const wins = await normalWindows();
  const winIds = new Set(wins.map(w => w.id));
  const tabs = (await browser.tabs.query({})).filter(t => winIds.has(t.windowId));

  // Drop tabs whose key is no longer synced (e.g. state from an old install).
  for (const t of tabs) {
    const key = syncKeyByTab.get(t.id);
    if (key && !all[key]) await clearRole(t.id);
  }

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
    }
  }
  saveSynced(all);
  for (const w of wins) await fillWindow(w.id);
}

// A real tab that is not synced yet: register it and add ghosts elsewhere.
async function register(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || syncKeyByTab.has(tab.id) || !syncable(tab)) return;
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
  saveSynced(all);
  const reps = repsOf(key, await browser.tabs.query({}));
  reps.forEach(t => { syncBusy.add(t.id); forget(t.id); });
  if (reps.length) await browser.tabs.remove(reps.map(t => t.id));
  await forgetClosedGhosts(key);
}

// Closed ghosts would show up in Recently Closed Tabs, and reopen as an
// empty placeholder. Only the real tab should be there.
async function forgetClosedGhosts(key) {
  const ghost = ghostUrl("ghost", key);
  for (const item of await browser.sessions.getRecentlyClosed()) {
    const t = item.tab;
    if (t?.url === ghost) await browser.sessions.forgetClosedTab(t.windowId, t.sessionId).catch(() => {});
  }
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
      forget(tabId);
      const others = repsOf(key, await browser.tabs.query({})).filter(t => t.id !== tabId);
      others.forEach(t => { syncBusy.add(t.id); forget(t.id); });
      if (others.length) await browser.tabs.remove(others.map(t => t.id));
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
const refreshTimers = new Map();
function refreshGhostsSoon(key) {
  clearTimeout(refreshTimers.get(key));
  refreshTimers.set(key, setTimeout(() => serial(async () => {
    refreshTimers.delete(key);
    for (const t of repsOf(key, await browser.tabs.query({ discarded: true }))) {
      if (syncRoleByTab.get(t.id) === "ghost") await browser.tabs.update(t.id, { url: ghostUrl("ghost", key) }).catch(() => {});
    }
  }), 3000));
}

// --- Placeholder pages (ghost.js) ----------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab;
  if (!tab || sender.id !== browser.runtime.id) return;
  if (msg.type === "ghostInfo") return ghostInfo(msg.kind, msg.key);
  if (msg.type === "ghostReady") { unloadWhenIconShown(tab.id, msg.icon); return; }
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
// the icon it has, so unloaded sooner it would have none.
const awaitingIcon = new Set();
function unloadWhenIconShown(tabId, hasIcon) {
  awaitingIcon.add(tabId);
  browser.tabs.get(tabId).then(t => { if (!hasIcon || t.favIconUrl) unloadGhost(tabId); }, () => awaitingIcon.delete(tabId));
}
function unloadGhost(tabId) {
  if (!awaitingIcon.delete(tabId)) return;
  browser.tabs.get(tabId).then(t => { if (!t.active && isGhostUrl(t.url)) return browser.tabs.discard(tabId); }).catch(() => {});
}
browser.tabs.onUpdated.addListener(tabId => {
  if (awaitingIcon.has(tabId)) unloadGhost(tabId);
}, { properties: ["favIconUrl"] });

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
browser.windows.onCreated.addListener(win => {
  if (!started || win.type !== "normal" || win.incognito) return;
  setTimeout(() => serial(() => fillWindow(win.id, { fresh: true })), NEW_WINDOW_DELAY_MS);
});

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
