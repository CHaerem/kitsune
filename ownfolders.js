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
// then tidies as usual. (A live folder's tabs go with it: the search decides them.)
async function deleteFolder(key) {
  const all = await getSynced();
  if (!isOwnFolder(all[key])) return;
  const gone = Object.keys(all).filter(k => all[k].parentKey === key);
  for (const k of gone) {
    if (all[k].liveFolder) await closeEverywhere(k, { dismiss: false });
    else all[k].parentKey = all[key].parentKey ?? null;
  }
  delete all[key];
  noteSaved(all);
  saveSynced(all);
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
      all[key].parentKey = folderKey;
      noteSaved(all, [key]);
      saveSynced(all);
    }
    for (const w of await normalWindows()) {
      const tabs = await browser.tabs.query({ windowId: w.id });
      const reps = repMap(tabs);
      if (reps.has(key)) await moveInWindow(tabs, reps.get(key), beforeKey ? reps.get(beforeKey) : null);
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
  syncBusy.add(tabId);
  await browser.tabs.move(tabId, { index }).catch(() => {});
  setTimeout(() => syncBusy.delete(tabId), SETTLE_MS);
}

// A tab moved to another space: Firefox cannot change a tab's container, so it is
// opened again there and closed here, in every window.
async function moveToSpace(tabId, space) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId === space || tab.pinned) return;
  const all = await getSynced();
  const key = syncKeyByTab.get(tabId);
  const url = key ? all[key]?.url : tab.url;
  if (!isWeb(url)) return;
  await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: space, url, active: false });
  if (key) await closeEverywhere(key, { dismiss: false });
  else await browser.tabs.remove(tabId).catch(() => {});
}
