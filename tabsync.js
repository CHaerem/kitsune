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
// - Closing a saved tab (in a folder) while
//   it is loaded                             -> unloaded, back to its saved
//                                               address, in every window
//                                               (see closeAction, common.js).
// - Reopening it (⌘⇧T)                       -> it takes its placeholder's place.
// - Moving a tab into or out of a folder     -> the same in the other windows.
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

const syncedList = storedValue("syncedTabs", () => ({})); // { [key]: { url, title, icon, cookieStoreId, parentKey, group, added, saved: { url, title, icon } } }
const SYNC_KEY = "syncKey";   // sessions value: key of the logical tab
const SYNC_ROLE = "syncRole"; // sessions value: "live" | "ghost" | "copy"
const SETTLE_MS = 1500;       // wait for redirects / container reopen before registering

const syncKeyByTab = new Map();  // tabId -> key
const syncRoleByTab = new Map(); // tabId -> role
const syncBusy = new Set();      // tab IDs we are changing ourselves
let pulling = 0;                 // pulls in progress: tabs being moved are not moves you made
const beingPulled = new Set();   // tabs on their way to another window right now, by a pull
let started = false;             // tab sync waits for startup before reacting

const syncable = tab => !tab.pinned && !tab.incognito && (isWeb(tab.url) || isSideberyGroup(tab.url));
const getSynced = () => syncedList.get();
const saveSynced = (all, options) => { syncedList.set(all, options); viewAllSoon(); };
// Sidebery adds a channel suffix ("~!...!~") to group URLs; strip it when copying.
// (Ghost placeholder URLs come from ghostUrl() in common.js.)
const groupBaseUrl = url => url.replace(/~!.*!~$/, "");

function setRole(tabId, key, role) {
  syncKeyByTab.set(tabId, key);
  syncRoleByTab.set(tabId, role);
  return Promise.all([
    browser.sessions.setTabValue(tabId, SYNC_KEY, key),
    browser.sessions.setTabValue(tabId, SYNC_ROLE, role),
  ]).catch(err => { ifGone(err); forget(tabId); }); // its close was told before this answer
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
  ]).catch(ifGone);
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
    // Firefox refuses a tab closed since the query. That tab is simply gone;
    // the others must still be read, or reconcileAll would see half the roles.
    const [key, role] = await Promise.all([
      browser.sessions.getTabValue(t.id, SYNC_KEY),
      browser.sessions.getTabValue(t.id, SYNC_ROLE),
    ]).catch(() => []);
    if (key && role) { syncKeyByTab.set(t.id, key); syncRoleByTab.set(t.id, role); return; }
    // A value that did not get written, or was lost. Left unknown, a placeholder stays for
    // good beside the new one the window then gets, and a page is not synced.
    const shown = placeholderOf(t.url);
    if (shown.kind === "ghost" && !t.pinned) await setRole(t.id, shown.key, "ghost").catch(noteError);
    else if (key) await setRole(t.id, key, isGhostUrl(t.url) ? "ghost" : isSideberyGroup(t.url) ? "copy" : "live").catch(noteError);
  }));
}

// Create the representation of `key` in a window: a copy for Sidebery group
// pages, a ghost (placeholder page, see ghost.js) for everything else, nested
// under its parent.
async function createRep(windowId, key, entry, parentId, index) {
  const props = { windowId, active: false, cookieStoreId: entry.cookieStoreId };
  if (parentId !== undefined && !tidierAlone) props.openerTabId = parentId;
  if (index !== undefined) props.index = index;
  const tab = await browser.tabs.create({ ...props, url: entry.group ? groupBaseUrl(entry.url) : ghostUrl("ghost", key) });
  syncBusy.add(tab.id);
  setTimeout(() => syncBusy.delete(tab.id), SETTLE_MS);
  await setRole(tab.id, key, entry.group ? "copy" : "ghost");
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
  for (const k of Object.keys(all)) if (!seen.has(k) && !isOwnFolder(all[k])) order.push(k);
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

// The order a window is filled in: the reference window's order, put in tree
// order (see treeOrder in common.js) from Tidier's own record of each tab's
// folder. The reference window's own tree is not trusted: one tab dragged
// into another space's folder there would otherwise be copied into every new
// window, and with it a folder taking in every tab after it.
function fillOrder(all, tabs, windowId) {
  return treeOrder(keysInReferenceOrder(all, tabs, windowId).map(k => ({
    id: k, parent: all[k].parentKey, space: all[k].cookieStoreId, folder: all[k].group,
  })));
}

// Sidebery assigns tabs to panels by walking the window's tab strip in panel
// order, so each panel's tabs must be one contiguous run. After filling a
// window, a tab Sidebery put somewhere else (in the active space, say) is
// moved into place, without moving any tab that has tabs in it.
async function sortWindow(windowId) {
  const all = await getSynced();
  const tabs = await browser.tabs.query({});
  const reps = repMap(tabs.filter(t => t.windowId === windowId && !t.pinned));
  const ids = fillOrder(all, tabs, windowId).map(k => reps.get(k)).filter(id => id !== undefined);
  const moved = [];
  await placeInOrder(windowId, ids, id => { syncBusy.add(id); moved.push(id); });
  setTimeout(() => moved.forEach(id => syncBusy.delete(id)), SETTLE_MS);
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
// copy of every synced tab, in tree order (see fillOrder). Each is created at
// the end, after its folder or the tab before it, which is where Sidebery puts
// it anyway, so Sidebery moves nothing.
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
    for (const key of fillOrder(all, tabs, windowId)) {
      if (reps.has(key)) continue;
      const entry = all[key];
      // One refused tab (its container was removed, say) must not leave the
      // window without all the tabs after it. A window closed meanwhile is no problem:
      // it simply wants no more tabs, and you may well have closed it at once.
      const tab = await createRep(windowId, key, entry, entry.parentKey ? reps.get(entry.parentKey) : undefined)
        .catch(err => { if (!isGone(err)) noteError(err); return null; });
      if (!tab) continue;
      reps.set(key, tab.id);
      created++;
      await sleep(CREATE_GAP_MS);
    }
  };
  if (fresh && !tidierAlone) {
    await withPinnedPlaceholder(windowId, () => ensureWindow(windowId, async essentials => {
      await addReps();
      await sidebarStarted(windowId, essentials);
    }));
  } else {
    await ensureWindow(windowId);
  }
  await addReps(); // everything, if no essentials were missing; else whatever came meanwhile
  if (created > 1 && !tidierAlone) {
    await sleep(SORT_SETTLE_MS); // let Sidebery finish placing the new tabs first
    await sortWindow(windowId);
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

// For the smoke test: how much Tidier has done (work, common.js) and how big
// each list it keeps in memory is, so that idle work and lists that only grow
// show up there. A list kept per tab or window must shrink again when tabs
// and windows close.
// "idle" counts the work done in `ms` with nothing happening, after
// IDLE_SETTLE_MS for the work caused by the smoke test's own helper page.
const IDLE_SETTLE_MS = 3000;
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!["stats", "idle", "flush"].includes(msg?.type) || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  if (msg.type === "flush") return flushWrites().then(() => true); // a title's write can wait half a minute
  if (msg.type === "idle") {
    return (async () => {
      await sleep(IDLE_SETTLE_MS);
      const before = { ...work };
      await sleep(msg.ms);
      return Object.fromEntries(Object.keys(work).map(k => [k, Math.round(work[k] - before[k])]));
    })();
  }
  const lists = {
    toForget, staleOpener, busy, keyByTab, ownMoves, ownFolderMoves, foldersTimers, syncKeyByTab, syncRoleByTab,
    syncBusy, movedTabs, moveTimers, createdAt, pending, refreshTimers, lastRefresh, awaitingIcon, lastOrder, orderQueries,
    activeSpace, newTabs, firstPage, showTimers, closedIn, sidebarPorts, viewTimers,
  };
  // Counted once Tidier is done with what it was doing (the helper page
  // asking this causes a little work), so a list only shows what it keeps.
  return (async () => {
    for (let i = 0; i < 20 && (orderQueries.size || pending.size); i++) await sleep(100);
    await serial(() => {});
    return { ...work, problems, sizes: Object.fromEntries(Object.entries(lists).map(([name, list]) => [name, list.size])) };
  })();
});

// Make sure every synced tab has exactly one live tab and every window exactly
// one representation of it, then fill in what is missing. Safe to run repeatedly.
async function reconcileAll({ firefoxStart = false } = {}) {
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
    if (isGhostUrl(t.url)) { gone.push(key); forget(t.id); await removeTabs([t.id], syncBusy); }
    else await clearRole(t.id);
  }
  if (gone.length) await forgetClosedPlaceholders("ghost", gone);

  // No synced tab at all means the session is not here, not that every tab was
  // closed: on a Mac, closing the last window and quitting restores no windows,
  // and an update can arrive with none open. The record is then the only copy
  // of the tabs, so it is kept, and windows are filled from it.
  const sessionHere = Object.keys(all).some(key => repsOf(key, tabs).length);
  for (const key of Object.keys(all)) {
    if (isOwnFolder(all[key])) continue;
    const reps = repsOf(key, tabs);
    if (!reps.length) {
      // When Firefox has started, nothing left anywhere means the tab is gone: closed in a
      // moment before it quit. A saved tab stays. At any other time nothing goes here: what
      // you close while Tidier runs is taken out when you close it. At an update Firefox
      // closes a placeholder that is loaded, also a selected one in the last window, which
      // may have been the tab's last copy; and a tab's only copy can close with its window
      // while this was waiting in the queue. fillWindow gives it a new placeholder.
      if (firefoxStart && sessionHere && !all[key].saved) delete all[key];
      continue;
    }
    if (!all[key].group) {
      const live = reps.filter(t => syncRoleByTab.get(t.id) === "live");
      // Exactly one live tab: prefer a loaded one. A real page is yours, whatever
      // its role says: a ghost selected before the roles were read has opened it.
      const page = t => !t.discarded && !isGhostUrl(t.url);
      const keep = live.find(page) || reps.find(page) || live.find(t => !t.discarded) || live[0] || reps.find(t => !t.discarded) || reps[0];
      if (syncRoleByTab.get(keep.id) !== "live") await setRole(keep.id, key, "live");
      // Keep title and icon current (older entries have no icon).
      if (isWeb(keep.url)) Object.assign(all[key], { title: keep.title || all[key].title, icon: keep.favIconUrl || all[key].icon });
      for (const t of live) if (t.id !== keep.id) await setRole(t.id, key, "ghost");
      // Loaded twice: a ghost selected before the roles were read opens its page, also with
      // the live tab loaded elsewhere. Nothing else would ever unload it.
      for (const t of reps) {
        if (t.id === keep.id || !page(t)) continue;
        await setRole(t.id, key, "ghost");
        await browser.tabs.update(t.id, { url: ghostUrl("ghost", key) }).catch(ifGone);
        if (t.active) await pull(t.id); // you are looking at it: the page you had comes here
      }
    }
    for (const w of wins) {
      // More than one representation in a window: remove the extra ghosts.
      // Live tabs and folder copies are never removed here; they may hold
      // your page or Sidebery children.
      const here = reps.filter(t => t.windowId === w.id);
      const ghosts = here.filter(t => syncRoleByTab.get(t.id) === "ghost");
      const extra = here.length > ghosts.length ? ghosts : ghosts.slice(1);
      for (const t of extra) { forget(t.id); await removeTabs([t.id], syncBusy); }
      if (extra.length) await forgetClosedPlaceholders("ghost", [key]);
    }
  }
  noteSaved(all); // also gives tabs that were in folders before saved tabs existed their address
  saveSynced(all);
  // A window closed meanwhile must not keep the others from being filled.
  for (const w of wins) await fillIfOpen(w.id).catch(noteError);
}

// A window closed meanwhile wants no more tabs: what was refused for that reason is no error.
async function fillIfOpen(windowId, options) {
  await fillWindow(windowId, options).catch(ifGone);
}

// A real tab that is not synced yet: register it and add ghosts elsewhere.
async function register(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  // A placeholder Tidier closed, reopened (⌘⇧T) in the moment before Recently Closed forgets
  // it: not a tab of its own. Taken back, so that the look over the tabs removes the double.
  if (tab && !syncKeyByTab.has(tab.id) && !tab.pinned && placeholderOf(tab.url).kind === "ghost") {
    await setRole(tab.id, placeholderOf(tab.url).key, "ghost");
    await reconcileAll();
    return;
  }
  if (!tab || syncKeyByTab.has(tab.id) || !syncable(tab)) return;
  // Only tabs in ordinary windows: a sign-in popup (window.open) is not a tab
  // you keep, and pulling its tab into another window would break the sign-in.
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  if (!win || win.type !== "normal" || win.incognito) return;
  const all = await getSynced();
  if (await reopenedSaved(tab, all)) return;
  const key = crypto.randomUUID();
  // Sidebery keeps a tab's opener equal to its parent; the opener alone says nothing.
  const parentKey = tab.openerTabId && !tidierAlone ? syncKeyByTab.get(tab.openerTabId) || null : null;
  const entry = { url: tab.url, title: tab.title, icon: tab.favIconUrl, cookieStoreId: tab.cookieStoreId, parentKey, group: isSideberyGroup(tab.url), added: Date.now() };
  all[key] = entry;
  noteSaved(all);
  saveSynced(all);
  await setRole(tab.id, key, entry.group ? "copy" : "live");
  // Closed just now, by you: its close told nothing, since it had no key yet. No ghosts for it.
  if (!syncKeyByTab.has(tab.id)) { delete all[key]; saveSynced(all); return; }
  const tabs = await browser.tabs.query({});
  for (const w of await normalWindows()) {
    if (w.id === tab.windowId) continue;
    const parentId = parentKey ? repMap(tabs.filter(t => t.windowId === w.id)).get(parentKey) : undefined;
    await createRep(w.id, key, entry, parentId).catch(ifGone); // that window closed meanwhile
  }
  // Dragged to another window meanwhile: that arrival looked like nothing of ours, and the
  // ghosts just went by the window it was in.
  const now = await browser.tabs.get(tab.id).catch(() => null);
  if (now && now.windowId !== tab.windowId) await reconcileAll();
}

// A saved tab you closed and reopened (⌘⇧T, History → Recently Closed Tabs):
// Firefox brings it back with its Tidier values, while its placeholder is
// still there, unloaded. The reopened tab becomes the live tab, and its
// placeholder in this window is removed, so it is not there twice.
async function reopenedSaved(tab, all) {
  const key = await browser.sessions.getTabValue(tab.id, SYNC_KEY).catch(() => undefined);
  const entry = key && all[key];
  if (!entry || entry.group) return false;
  const tabs = await browser.tabs.query({});
  const reps = repsOf(key, tabs);
  if (reps.some(t => syncRoleByTab.get(t.id) === "live" && !t.discarded && !isGhostUrl(t.url))) return false; // open already: a copy
  await setRole(tab.id, key, "live");
  for (const t of reps) {
    if (t.windowId !== tab.windowId) { if (syncRoleByTab.get(t.id) === "live") await setRole(t.id, key, "ghost"); continue; }
    forget(t.id);
    await removeTabs([t.id], syncBusy);
  }
  await forgetClosedPlaceholders("ghost", [key]);
  if (isWeb(tab.url)) Object.assign(entry, { url: tab.url, title: tab.title, icon: tab.favIconUrl || entry.icon });
  saveSynced(all);
  return true;
}

// A tab you closed (not by closing its window). `place` is where it was (see
// closedPlace). Waits a moment, so that a folder closed with it is gone too.
async function onSyncedClosed(key, role, windowId, place) {
  const all = await getSynced();
  const entry = all[key];
  if (!entry) return;
  const inFolder = storedInFolder(all, key);
  if (inFolder && !tidierAlone) await sleep(FOLDER_CLOSE_SETTLE_MS);
  const reps = repMap(await browser.tabs.query({ windowId }).catch(() => []));
  const action = closeAction({
    role, inFolder, liveFolder: !!entry.liveFolder, folderHere: tidierAlone || reps.has(folderKeyOf(all, key)),
    // Not seen yet (just created): a live tab counts as loaded, so it is kept.
    unloaded: place ? place.unloaded : role !== "live",
  });
  if (action === "unload") await unloadSaved(key, windowId, place);
  else if (action === "close") await closeEverywhere(key);
  // "copy" and "leave": the other windows keep it (this one gets it back with
  // its folder when it is filled again); forgotten if no window has it.
  else await dropIfUnused(key);
}

// A saved tab you closed while it was loaded: it goes back to its saved
// address, unloaded, in every window. Its window gets a placeholder where it
// was, under its parent (or the nearest one still there); the other windows'
// placeholders are reloaded to show the saved page. There is no live tab
// until you select one of them (pull makes that one live and loads it).
async function unloadSaved(key, windowId, place) {
  const all = await getSynced();
  const entry = all[key];
  if (!entry) return;
  if (entry.saved) Object.assign(entry, entry.saved);
  saveSynced(all);
  const tabs = await browser.tabs.query({});
  for (const t of repsOf(key, tabs)) {
    if (!t.active && isGhostUrl(t.url)) await browser.tabs.update(t.id, { url: ghostUrl("ghost", key) }).catch(() => {});
  }
  const here = repMap(tabs.filter(t => t.windowId === windowId));
  if (here.has(key)) return;
  let parentKey = entry.parentKey;
  while (parentKey && !here.has(parentKey)) parentKey = all[parentKey]?.parentKey;
  const ghost = await createRep(windowId, key, entry, parentKey ? here.get(parentKey) : undefined);
  if (!place) return;
  if (!tidierAlone) await sleep(NEW_TAB_SETTLE_MS); // Sidebery places it by its own rules first
  await placeNextTo(windowId, ghost.id, place.before, place.after);
}

// Whether a tab can be closed without asking you. A page with unsaved input
// makes Firefox select it and ask (and Tidier's queue waits for the answer),
// which must not happen at a moment you did not choose: so a loaded tab is unloaded
// first, which such a page refuses without asking. Its copy for Recently Closed
// is kept either way.
async function closesQuietly(key) {
  const liveId = liveTabId(key);
  const live = liveId === undefined ? null : await browser.tabs.get(liveId).catch(() => null);
  if (!live || live.discarded || isGhostUrl(live.url)) return true;
  await browser.tabs.discard(live.id).catch(() => {});
  return !!(await browser.tabs.get(live.id).catch(() => null))?.discarded;
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
  reps.forEach(t => forget(t.id));
  await removeTabs(reps.map(t => t.id), syncBusy);
  await forgetClosedPlaceholders("ghost", [key]);
}

// Placeholders Firefox closed itself: it closes those loaded when Tidier updates.
// In Recently Closed they would be reopened by ⌘⇧T instead of a tab you closed.
async function forgetClosedGhosts() {
  for (const { tab } of await browser.sessions.getRecentlyClosed()) {
    if (tab && (isGhostUrl(tab.url) || (tidierAlone && isSideberyGroup(tab.url)))) await browser.sessions.forgetClosedTab(tab.windowId, tab.sessionId).catch(() => {});
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
  if (reps.length) { await setRole(reps[0].id, key, "live"); return; }
  // No other window has it yet (one still being filled, say). It was the only copy now, so
  // they must get it, or the next start takes it for a tab you closed.
  for (const w of await normalWindows()) if (w.id !== closingWindowId) await fillIfOpen(w.id);
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
  // You may have moved on while this waited in the queue: it must not take the
  // selection back.
  if (!ghost.active || ghost.windowId !== focusedWindowId) return;
  if (!live || live.windowId === ghost.windowId) {
    // No live tab to pull: the ghost becomes the live tab and loads itself.
    await setRole(ghostId, key, "live");
    return;
  }
  pulling++;
  syncBusy.add(live.id); syncBusy.add(ghostId);
  try {
    const fromWindow = live.windowId, fromIndex = live.index, fromOpener = live.openerTabId;
    // Firefox closes a window when the last tab it can show leaves it, whatever is hidden
    // in it. Using a tab in another window must not close this one: it gets its ghost first.
    const others = await browser.tabs.query({ windowId: fromWindow, hidden: false });
    const entryNow = (await getSynced())[key];
    const leftBehind = entryNow && !others.some(t => t.id !== live.id)
      ? await createRep(fromWindow, key, entryNow, undefined, fromIndex + 1) : null;
    if (live.active) {
      // Leave the old window on a tab that is already loaded, preferably in the
      // same space, so the old window does not load anything in the background.
      const oldTabs = await browser.tabs.query({ windowId: fromWindow, hidden: false, discarded: false });
      const calm = oldTabs.find(t => t.id !== live.id && t.cookieStoreId === live.cookieStoreId) ||
        oldTabs.find(t => t.id !== live.id);
      if (calm) await browser.tabs.update(calm.id, { active: true });
    }
    beingPulled.add(live.id);
    await browser.tabs.move(live.id, { windowId: ghost.windowId, index: ghost.index }).finally(() => beingPulled.delete(live.id));
    await browser.tabs.update(live.id, { active: true });

    // Bookkeeping. A tab moved before it was ever loaded (a live folder's pull
    // request) can arrive without its sessions values, so they are set again.
    forget(ghostId);
    await setRole(live.id, key, "live");
    const all = await getSynced();
    const entry = all[key];
    const tabsHere = await browser.tabs.query({ windowId: ghost.windowId });
    const parentId = entry?.parentKey ? repMap(tabsHere).get(entry.parentKey) : undefined;
    await Promise.all([
      browser.tabs.remove(ghostId).catch(ifGone),
      parentId !== undefined ? browser.tabs.update(live.id, { openerTabId: parentId }).catch(() => {}) : null,
    ]);
    await forgetClosedPlaceholders("ghost", [key]);
    if (entry) {
      // A never-loaded live tab is still a placeholder page; keep the real URL then.
      if (isWeb(live.url)) Object.assign(entry, { url: live.url, title: live.title, icon: live.favIconUrl || entry.icon });
      saveSynced(all);
      // The old window gets a ghost where the live tab was, unless you have closed it by now.
      const opener = fromOpener !== undefined && (await browser.tabs.get(fromOpener).catch(() => null));
      if (!leftBehind) {
        await createRep(fromWindow, key, entry, opener && opener.windowId === fromWindow ? opener.id : undefined, fromIndex);
      }
    }
  } catch (err) {
    ifGone(err); // the tab you selected, or the one to bring in, closed meanwhile: nothing to pull
  } finally {
    setTimeout(() => { syncBusy.delete(live.id); syncBusy.delete(ghostId); pulling--; }, 600);
  }
}

// A tab you moved into or out of a folder in one window is moved into or out
// of it in the other windows (the parent is read with treeParent, common.js).
// Sidebery takes a parent from another extension only when a tab is created,
// so the ghost there is replaced by a new one under its new parent, and then
// put next to the same synced tab of its space. A live tab, a folder copy or
// the selected tab there keeps its place. (Only the parent is copied, not the
// order: Sidebery gives a tab another extension moves the space of the tab it
// lands on, so moving tabs around in other windows could change spaces.)
async function applyMoves(windowId, ids) {
  const all = await getSynced();
  const here = (await browser.tabs.query({ windowId, pinned: false })).sort((a, b) => a.index - b.index);
  const hereById = new Map(here.map(t => [t.id, t]));
  const synced = t => all[syncKeyByTab.get(t.id)] ? syncKeyByTab.get(t.id) : null;
  const others = (await normalWindows()).filter(w => w.id !== windowId);
  const replaced = new Set(), gone = [];
  let changed = false;
  for (const t of here.filter(t => ids.has(t.id) && synced(t))) {
    const key = synced(t), entry = all[key];
    const opener = treeParent(t, hereById);
    const parentKey = (opener && synced(opener)) || null;
    if ((entry.parentKey || null) === parentKey && !replaced.has(parentKey)) continue;
    entry.parentKey = parentKey; changed = true;
    // The synced tabs of its space before and after it, nearest first.
    const space = here.filter(x => x.cookieStoreId === t.cookieStoreId);
    const before = space.slice(0, space.indexOf(t)).reverse().map(synced).filter(Boolean);
    const after = space.slice(space.indexOf(t) + 1).map(synced).filter(Boolean);
    for (const w of others) {
      const tabs = await browser.tabs.query({ windowId: w.id });
      const reps = repMap(tabs);
      const rep = tabs.find(x => x.id === reps.get(key));
      const parentRep = parentKey ? reps.get(parentKey) : undefined;
      if (!rep || rep.active || syncRoleByTab.get(rep.id) !== "ghost" || (parentKey && parentRep === undefined)) continue;
      syncBusy.add(rep.id); forget(rep.id);
      await browser.tabs.remove(rep.id);
      const ghost = await createRep(w.id, key, entry, parentRep, rep.index);
      replaced.add(key); gone.push(key);
      await sleep(NEW_TAB_SETTLE_MS); // Sidebery places it by its own rules first
      await placeNextTo(w.id, ghost.id, before, after);
    }
  }
  if (changed) { noteSaved(all); saveSynced(all); } // into a folder: saved from here; out of it: not
  if (gone.length) await forgetClosedPlaceholders("ghost", gone);
}

// Move a tab after the nearest of `before` (keys) its window has, else before
// the nearest of `after`, but only where Sidebery keeps it in its space: it
// gives a tab another extension moves the space of the tab at the new index.
// A tab without a container there is in the space it sits in (folders first
// puts the window's own "New Tab" among a space's tabs), so the first tab
// with a container from there on decides.
async function placeNextTo(windowId, tabId, before, after) {
  const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const tab = tabs.find(x => x.id === tabId);
  if (!tab) return;
  const reps = repMap(tabs), at = k => tabs.find(x => x.id === reps.get(k) && x.id !== tabId);
  const prev = before.map(at).find(Boolean), next = prev ? undefined : after.map(at).find(Boolean);
  let index = prev ? prev.index + 1 : next?.index;
  if (index === undefined) return;
  if (tab.index < index) index--;
  const spaceFrom = i => tabs.slice(i).find(x => x.id !== tabId && (x.cookieStoreId !== NO_CONTAINER || tab.cookieStoreId === NO_CONTAINER))?.cookieStoreId;
  if (index === tab.index || (!tidierAlone && spaceFrom(index) !== tab.cookieStoreId)) return;
  await browser.tabs.move(tabId, { windowId, index }).catch(() => {});
}

// A tab moved above its stored parent is out of that folder, whatever its
// opener says once folders first has moved the folder above it again (see
// treeParent, common.js).
async function leftParentSoon(tabId, windowId) {
  const entry = (await getSynced())[syncKeyByTab.get(tabId)];
  if (!entry?.parentKey) return;
  const tabs = await browser.tabs.query({ windowId }).catch(() => []);
  const tab = tabs.find(t => t.id === tabId), parent = tabs.find(t => t.id === repMap(tabs).get(entry.parentKey));
  if (tab && parent && parent.index > tab.index) staleOpener.set(tab.id, parent.id);
}

// Sidebery sets the new parent just after it moves a tab, and moves a branch
// one tab at a time, so the moves are taken together a moment later. Only
// moves you make count: in the window you are using, of tabs that are not
// new (Sidebery places a new tab, and a new window's tabs, itself).
const movedTabs = new Map(); // windowId -> tab IDs you moved there
const moveTimers = new Map();
const createdAt = new Map(); // tabId -> when it was created
browser.tabs.onCreated.addListener(tab => createdAt.set(tab.id, Date.now()));
browser.tabs.onRemoved.addListener(tabId => createdAt.delete(tabId));
browser.tabs.onMoved.addListener((tabId, { windowId }) => {
  if (!started || tidierAlone || pulling || windowId !== focusedWindowId || syncBusy.has(tabId) || !syncKeyByTab.has(tabId)) return;
  if (Date.now() - (createdAt.get(tabId) || 0) < NEW_TAB_QUIET_MS) return;
  leftParentSoon(tabId, windowId);
  if (!movedTabs.has(windowId)) movedTabs.set(windowId, new Set());
  movedTabs.get(windowId).add(tabId);
  clearTimeout(moveTimers.get(windowId));
  moveTimers.set(windowId, setTimeout(() => {
    const ids = movedTabs.get(windowId) || new Set();
    movedTabs.delete(windowId); moveTimers.delete(windowId);
    serial(() => applyMoves(windowId, ids));
  }, MOVE_SETTLE_MS));
});

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

// A tab pinned is an essential; it leaves tab sync.
async function leaveSync(tabId, key) {
  const all = await getSynced(); delete all[key]; saveSynced(all);
  await clearRole(tabId);
  const others = repsOf(key, await browser.tabs.query({})).filter(t => t.id !== tabId);
  others.forEach(t => forget(t.id));
  await removeTabs(others.map(t => t.id), syncBusy);
  await forgetClosedPlaceholders("ghost", [key]);
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!started) return;
  const key = syncKeyByTab.get(tabId);
  if (!key) {
    // A new tab that has navigated to a page, e.g. "New Tab" -> a URL. Busy or not: it may
    // be a new tab you dragged a moment ago, and no later event would tell.
    if (change.url || change.status === "complete") registerSoon(tabId);
    return;
  }
  // You pinned it, also if Tidier was just busy with it: Tidier pins no synced tab itself.
  if (change.pinned === true) { serial(() => leaveSync(tabId, key)); return; }
  if (syncBusy.has(tabId)) return;
  if (syncRoleByTab.get(tabId) === "live" && (change.status === "complete" || change.favIconUrl || change.title)) {
    serial(async () => {
      const all = await getSynced();
      const entry = all[key];
      if (!entry || !isWeb(tab.url)) return;
      const changed = entry.title !== tab.title || (tab.favIconUrl && entry.icon !== tab.favIconUrl);
      const moved = entry.url !== tab.url;
      if (!changed && !moved) return;
      Object.assign(entry, { url: tab.url, title: tab.title, icon: tab.favIconUrl || entry.icon });
      // On its saved address, a saved tab's saved title and icon follow the page.
      if (entry.saved?.url === tab.url) Object.assign(entry.saved, { title: tab.title, icon: tab.favIconUrl || entry.saved.icon });
      noteSaved(all, [key]);
      saveSynced(all, { lazy: !moved });
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
const ICON_WAIT_MS = 10000;
const awaitingIcon = new Map(); // tabId -> { url, hasIcon }: the placeholder load that is ready
function unloadWhenIconShown(tabId, url, hasIcon) {
  const waiting = { url, hasIcon };
  awaitingIcon.set(tabId, waiting);
  unloadGhost(tabId);
  // Firefox never reported this icon: better without it than loaded for good.
  if (hasIcon) setTimeout(() => {
    if (awaitingIcon.get(tabId) !== waiting) return;
    waiting.hasIcon = false;
    unloadGhost(tabId);
  }, ICON_WAIT_MS);
}
function unloadGhost(tabId) {
  const waiting = awaitingIcon.get(tabId);
  if (!waiting) return;
  browser.tabs.get(tabId).then(t => {
    // Not yet: the events below bring it back. Waiting a fixed time is not enough:
    // with a new window's tabs all loading, a placeholder can take many seconds to
    // report its load finished, and those given up on stayed loaded for good.
    if (t.status !== "complete" || (waiting.hasIcon && !t.favIconUrl)) return;
    if (awaitingIcon.get(tabId) !== waiting) return; // a newer load has asked meanwhile
    awaitingIcon.delete(tabId);
    if (!t.active && isGhostUrl(t.url) && t.url === waiting.url) return browser.tabs.discard(tabId);
  }).catch(() => awaitingIcon.delete(tabId));
}
browser.tabs.onUpdated.addListener(tabId => {
  if (awaitingIcon.has(tabId)) unloadGhost(tabId);
}, { properties: ["favIconUrl", "status"] });

// A placeholder whose tab or essential no longer exists (left from before a
// restart, or by an older version) has nothing to show or open: it is closed.
async function closeOrphan(tabId, kind, key) {
  if (!["ghost", "essential", "lazy"].includes(kind) || (await ghostInfo(kind, key))) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || !isGhostUrl(tab.url)) return;
  busy.add(tabId); forget(tabId);
  await removeTabs([tabId], syncBusy);
  busy.delete(tabId);
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
  const place = info.isWindowClosing ? null : closedPlace(info.windowId, tabId);
  const key = syncKeyByTab.get(tabId), role = syncRoleByTab.get(tabId);
  forget(tabId);
  if (info.isWindowClosing) lastOrder.delete(info.windowId); else noteOrder(info.windowId);
  // A tab Tidier closes itself has lost its key by now. A tab that is only marked
  // busy (just pulled in, say) and has its key was closed by you.
  syncBusy.delete(tabId);
  if (!started || !key) return;
  if (info.isWindowClosing) {
    if (role === "live") serial(() => handOver(key, info.windowId));
    return;
  }
  // Folder copies belong to their window: closing one leaves the others alone
  // (Sidebery itself may close a group page, and that must not spread). Saved
  // tabs are unloaded instead of closed (see onSyncedClosed).
  serial(() => onSyncedClosed(key, role, info.windowId, place));
});

// Each window's tabs as last seen, in order, so that a tab you close can be
// put back where it was: Firefox reports a closed tab by its ID only.
const lastOrder = new Map(); // windowId -> [{ id, cookieStoreId, unloaded }]
const orderQueries = new Map(); // windowId -> whether to look again when the query in progress is done
function noteOrder(windowId) {
  if (orderQueries.has(windowId)) { orderQueries.set(windowId, true); return; }
  orderQueries.set(windowId, false);
  work.lookups++;
  browser.tabs.query({ windowId }).then(tabs => {
    // No tabs: the window closed while this was on its way, and nothing will remove it again.
    if (!tabs.length) { lastOrder.delete(windowId); return; }
    lastOrder.set(windowId, tabs.sort((a, b) => a.index - b.index)
      .map(t => ({ id: t.id, cookieStoreId: t.cookieStoreId, unloaded: t.discarded || isGhostUrl(t.url) })));
  }, () => lastOrder.delete(windowId)).finally(() => {
    const again = orderQueries.get(windowId);
    orderQueries.delete(windowId);
    if (again) noteOrder(windowId);
  });
}
browser.tabs.onCreated.addListener(tab => noteOrder(tab.windowId));
browser.tabs.onMoved.addListener((tabId, { windowId }) => noteOrder(windowId));
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => noteOrder(newWindowId));
browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => noteOrder(oldWindowId));
browser.tabs.onUpdated.addListener((tabId, change, tab) => noteOrder(tab.windowId), { properties: ["discarded", "url"] });
browser.windows.onRemoved.addListener(windowId => lastOrder.delete(windowId));

// Where a closed tab was: whether it was unloaded, and the synced tabs of its
// space before and after it (nearest first), for placeNextTo.
function closedPlace(windowId, tabId) {
  const order = lastOrder.get(windowId) || [];
  const i = order.findIndex(t => t.id === tabId);
  if (i < 0) return null;
  const keysOf = list => list.filter(t => t.cookieStoreId === order[i].cookieStoreId && syncKeyByTab.has(t.id)).map(t => syncKeyByTab.get(t.id));
  return { unloaded: order[i].unloaded, before: keysOf(order.slice(0, i).reverse()), after: keysOf(order.slice(i + 1)) };
}

// Selecting a ghost in the window you are using pulls the live tab in. (A pull
// selects tabs itself too, but never a ghost in the window you are using.)
browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!started || syncRoleByTab.get(tabId) !== "ghost" || windowId !== focusedWindowId) return;
  serial(() => pull(tabId));
});

// Switching to a window whose selected tab is a ghost pulls the live tab in.
function pullSelected(windowId) {
  return serial(async () => {
    const [active] = await browser.tabs.query({ windowId, active: true });
    if (active && syncRoleByTab.get(active.id) === "ghost") await pull(active.id);
  });
}
browser.windows.onFocusChanged.addListener(windowId => {
  if (started && windowId !== browser.windows.WINDOW_ID_NONE) pullSelected(windowId);
});

// You dragged a tab to another window: fix up both windows.
browser.tabs.onAttached.addListener(tabId => {
  // A tab arriving by a pull is not yours to fix up. Any other is, also one just created, just
  // pulled, or one you drag during a pull: it would be left without its values, twice in the
  // window it went to, and missing from the one it left. (Firefox sends this event before
  // the answer to the move.)
  if (!started || beingPulled.has(tabId) || !syncKeyByTab.has(tabId)) return;
  const key = syncKeyByTab.get(tabId), role = syncRoleByTab.get(tabId);
  serial(async () => {
    // Firefox loses the sessions values of an unloaded tab moved to another window;
    // after a restart it would be a stranger, and a duplicate of itself.
    await setRole(tabId, key, role).catch(() => {});
    await reconcileAll();
  });
});

// A new window gets essentials and ghosts of every synced tab.
// A window you reopened (History → Recently Closed Windows, ⌘⇧N) comes back
// with its tabs' Tidier values: its tabs are taken back instead, so nothing
// is doubled (see adoptRestored).
browser.windows.onCreated.addListener(win => {
  if (!started || win.type !== "normal" || win.incognito) return;
  setTimeout(() => serial(async () => {
    if (await adoptRestored(win.id)) await reconcileAll();
    else await fillIfOpen(win.id, { fresh: true });
  }), NEW_WINDOW_DELAY_MS);
});

// Tabs restored with their Tidier values: a tab still synced is taken back
// as what it was (reconcileAll then keeps one live tab and one tab per window);
// a placeholder of a tab closed since is removed; any other tab is left to be
// registered as new. Returns whether the window had any.
async function adoptRestored(windowId) {
  const all = await getSynced();
  let found = false;
  const removed = [];
  for (const t of await browser.tabs.query({ windowId })) {
    if (syncKeyByTab.has(t.id)) continue;
    // Refused for a tab closed since the query: it is simply gone, and the rest still counts.
    const [key, role] = await Promise.all([
      browser.sessions.getTabValue(t.id, SYNC_KEY),
      browser.sessions.getTabValue(t.id, SYNC_ROLE),
    ]).catch(() => []);
    if (!key || !role) continue;
    found = true;
    if (all[key]) {
      syncKeyByTab.set(t.id, key); syncRoleByTab.set(t.id, role);
      if (t.pinned) await leaveSync(t.id, key); // pinned the moment it came back: not a synced tab any more
      continue;
    }
    if (isGhostUrl(t.url)) { removed.push(key); await removeTabs([t.id], syncBusy); }
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
      const parentKey = t.openerTabId && !tidierAlone ? syncKeyByTab.get(t.openerTabId) || null : null;
      all[key] = { url: t.url, title: t.title, icon: t.favIconUrl, cookieStoreId: t.cookieStoreId, parentKey, group: isSideberyGroup(t.url), added: Date.now() };
      await setRole(t.id, key, all[key].group ? "copy" : "live");
    }
  }
  saveSynced(all);
}

// Session restore and Sidebery need a moment after startup before we act.
async function start(delayMs) {
  await sleep(delayMs);
  // Every listener waits for `started`, so an error here must not stop the rest:
  // with it false a selected ghost stays blank and nothing syncs until Firefox
  // restarts, with no sign of why. This runs at every update, in the middle of work.
  const step = fn => Promise.resolve().then(fn).then(() => true, err => { noteError(err); return false; });
  await step(readAlone);
  await serial(async () => {
    await step(closeOldFolderPages); // moveover.js
    await step(initList);
    await step(essentialsAgree);
    // Without the roles every tab looks unsynced, and reconcileAll would act on that.
    if (await step(loadRoles)) {
      await step(initSynced);
      await step(() => reconcileAll({ firefoxStart: firefoxStarting })); // also adds missing essentials, via fillWindow
    }
    await step(foldersFirstAll); // folders.js
    await step(oneLoadedEach); // essentials.js: Firefox may have restored a page in several windows
    await step(forgetClosedGhosts);
    await step(startSpaces); // spaces.js: Firefox shows hidden tabs again at an update
  });
  await step(async () => { for (const w of await normalWindows()) noteOrder(w.id); });
  started = true;
  // A ghost selected while Tidier was starting was not pulled in, and waits blank.
  if (focusedWindowId !== browser.windows.WINDOW_ID_NONE) pullSelected(focusedWindowId);
  await step(seeUnseenTabs);
}

// A tab opened while Tidier was starting went unseen (a link that started Firefox, say,
// or one opened in the moment after an update), and no event will tell about it again:
// it would stay in one window, unknown, until it goes to another address. The same goes for
// a window opened or reopened meanwhile, and for a tab pinned meanwhile, which would stay
// both an essential and a synced tab.
async function seeUnseenTabs() {
  await serial(async () => {
    for (const w of await normalWindows()) {
      if (await adoptRestored(w.id)) await reconcileAll();
      else await fillIfOpen(w.id);
      if (tidierAlone) await startSpaceIn(w.id);
    }
  });
  for (const t of await browser.tabs.query({})) {
    const key = syncKeyByTab.get(t.id);
    if (key) {
      if (t.pinned) serial(async () => { await onPinned(t); await leaveSync(t.id, key); });
    } else if (!seenLateInSpace(t) && syncable(t)) registerSoon(t.id); // seenLateInSpace: spaces.js
  }
}
let startRequested = false, firefoxStarting = false;
function requestStart(delayMs) {
  if (startRequested) return;
  startRequested = true;
  start(delayMs);
}
browser.runtime.onStartup.addListener(() => { firefoxStarting = true; requestStart(5000); });
browser.runtime.onInstalled.addListener(() => requestStart(1000));
// Enabled again after being disabled: neither event fires, so start anyway.
// onStartup/onInstalled arrive right after the background page loads, well
// within this delay.
setTimeout(() => requestStart(1000), 2000);
