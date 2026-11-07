// Tidier's own folders (Tidier alone): a folder is an entry in the tab record
// (`group`, `own`, with a name and a place among its space's folders), with no tab
// of its own. A tab is in a folder by its `parentKey`, as with Sidebery's folder
// pages, so saved tabs and archiving work the same on both. Only what you do here
// changes a folder; no tab event can delete one.

const newFolderKey = () => crypto.randomUUID();

async function createFolder(name, cookieStoreId, { live, before } = {}) {
  const all = await getSynced();
  const key = newFolderKey();
  const others = foldersOf(all, cookieStoreId);
  all[key] = { group: true, own: true, name, cookieStoreId, parentKey: null, rank: (others.at(-1)?.rank ?? 0) + 1, added: Date.now(), ...(live ? { live } : {}) };
  saveSynced(all);
  if (before !== undefined) await moveFolder(key, before);
  return key;
}

// A space's folders, in the order they are shown.
function foldersOf(all, cookieStoreId) {
  return Object.entries(all).filter(([, e]) => isOwnFolder(e) && e.cookieStoreId === cookieStoreId)
    .map(([key, e]) => ({ key, ...e })).sort((a, b) => a.rank - b.rank);
}

async function renameFolder(key, name) {
  const all = await getSynced();
  if (!isOwnFolder(all[key]) || !name.trim()) return;
  all[key].name = name.trim();
  saveSynced(all);
}

async function foldFolder(key, collapsed) {
  const all = await getSynced();
  if (!isOwnFolder(all[key])) return;
  all[key].collapsed = !!collapsed;
  saveSynced(all);
}

// Deleting a folder loses nothing: its tabs become ordinary tabs, which archiving
// then tidies as usual. (A live folder's tabs go with it: the search decides them. But a
// page with unsaved input must not make Firefox ask at a moment you did not choose, so
// that one stays, as an ordinary tab.)
// Archiving would otherwise take a tab last used over 12 hours ago at its next look,
// so "its tabs stay" would not be true: a tab that leaves counts as new from here.
// In the sidebar (`windowId`) the line offers to undo it (quiet.js).
async function deleteFolder(key, windowId) {
  const all = await getSynced();
  if (!isOwnFolder(all[key])) return;
  const undo = windowId === undefined ? undefined : await rememberFolder(all, key, windowId);
  const gone = Object.keys(all).filter(k => all[k].parentKey === key);
  for (const k of gone) {
    if (all[k].liveFolder && await closesQuietly(k)) { await closeEverywhere(k, { dismiss: false }); continue; }
    Object.assign(all[k], { parentKey: all[key].parentKey ?? null, added: Date.now() });
    delete all[k].liveFolder;
    delete all[k].liveUrl;
  }
  delete all[key];
  noteSaved(all);
  saveSynced(all);
  if (undo) say(windowId, "Folder deleted", { undo });
}

// A folder moved among its space's folders (`beforeKey` null: last).
async function moveFolder(key, beforeKey) {
  const all = await getSynced();
  if (!isOwnFolder(all[key])) return;
  const order = foldersOf(all, all[key].cookieStoreId).map(f => f.key).filter(k => k !== key);
  const at = beforeKey ? order.indexOf(beforeKey) : -1;
  order.splice(at < 0 ? order.length : at, 0, key);
  order.forEach((k, i) => { all[k].rank = i + 1; });
  saveSynced(all);
}

// A tab moved in the sidebar: into or out of a folder (`folderKey`, or null) and
// before another tab (`beforeTabId`, or null: last there). Every window follows,
// and without Sidebery's rules about what may move where, any tab can simply move.
async function moveTab(windowId, tabId, beforeTabId, folderKey) {
  const all = await getSynced();
  const key = syncKeyByTab.get(tabId), beforeKey = beforeTabId ? syncKeyByTab.get(beforeTabId) : null;
  if (key && all[key]) {
    if (folderKey !== undefined && !all[key].liveFolder && !all[folderKey]?.live) {
      // Out of its folder it counts as new, or archiving could take it at its next look.
      if (!folderKey && all[key].parentKey) all[key].added = Date.now();
      all[key].parentKey = folderKey;
      noteSaved(all, [key]);
      saveSynced(all);
    }
    for (const w of await normalWindows()) {
      const tabs = await browser.tabs.query({ windowId: w.id });
      const reps = repMap(tabs);
      // A tab with no record (a new tab page) is in this window only: its id is the place here.
      if (reps.has(key)) await moveInWindow(tabs, reps.get(key), beforeKey ? reps.get(beforeKey) : beforeTabId);
    }
  } else {
    await moveInWindow(await browser.tabs.query({ windowId }), tabId, beforeTabId);
  }
  viewSoon(windowId);
}

async function moveInWindow(tabs, tabId, beforeId) {
  const tab = tabs.find(t => t.id === tabId), before = tabs.find(t => t.id === beforeId);
  if (!tab) return;
  let index = before ? before.index : -1;
  if (before && tab.index < before.index) index--;
  if (index === tab.index) return;
  // Not marked as Tidier's own (syncBusy): without Sidebery nothing listens to a move, and for
  // that moment a pin or a new title would go unseen. A tab dragged on to the essentials
  // right after a move stayed in the tab record too, and so was there twice.
  await browser.tabs.move(tabId, { index }).catch(() => {});
}

// A tab moved to another space: Firefox cannot change a tab's container, so it is
// opened again there and closed here, in every window. A page that may hold unsaved
// input stays, and so does a tab that cannot be opened there; no rule sends it back,
// since you moved it; and you stay where you are (safemoves.js).
//
// The address is the page's own while it is loaded: the record follows a page once it
// has finished loading, and a tab can be moved before that. A placeholder's own address
// says nothing, so then it is the record's.
async function moveToSpace(tabId, space) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId === space || tab.pinned) return;
  const key = syncKeyByTab.get(tabId), live = await pageTab(tab, key);
  const url = isWeb(live?.url) ? live.url : (await getSynced())[key]?.url;
  if (!isWeb(url)) return;
  const noSpace = () => void globalThis.say?.(tab.windowId, "That space could not be opened, so the tab stayed here");
  // Asked first, since leaving unloads the tab and selects another one. (Only a window
  // closing or a space removed this very moment can still refuse the new tab below.)
  if (await spaceGone(space)) return noSpace();
  if (!(await leavesQuietly(live, key))) return sayStayed(tab.windowId);
  const opened = await openUnruled({ windowId: tab.windowId, cookieStoreId: space, url, active: false }).catch(() => null);
  if (!opened) return noSpace();
  // (A live folder's pull request counts as closed, or the next search brings it back.)
  if (key) await closeEverywhere(key);
  else await browser.tabs.remove(tabId).catch(() => {});
}
