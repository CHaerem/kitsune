// Folders first: in each space, Sidebery's folders (with the tabs in them)
// come before the ordinary tabs, like the pinned part of a space in Zen and
// Arc. Sidebery has no setting for it, and reordering with CSS would only
// change the picture (dragging and the keyboard would still follow the real
// order), so the real tab order is kept instead.
//
// The window's own tree is read with treeParent (common.js) and put in tree
// order (treeOrder in common.js, which puts folders first). Tabs are then
// moved one at a time, never one with tabs in it (placeInOrder): ordinary tabs
// above a folder move below it, the folder stays. Moving whole folders at once
// made Sidebery put every tab after a folder into it. A tab without a
// container belongs to the space it sits in.
//
// It runs after Tidier has started and whenever a tab is created, moved,
// attached or becomes a folder page. Our own moves are not answered.

const ownFolderMoves = new Set();

async function foldersFirst(windowId) {
  if (tidierAlone) return; // Tidier's sidebar draws folders first itself
  const win = await browser.windows.get(windowId).catch(() => null);
  if (!win || win.type !== "normal" || win.incognito) return;
  const tabs = (await browser.tabs.query({ windowId, pinned: false })).sort((a, b) => a.index - b.index);
  const byId = new Map(tabs.map(t => [t.id, t]));
  const order = treeOrder(tabs.map(t => ({ id: t.id, parent: treeParent(t, byId)?.id, space: t.cookieStoreId, folder: isSideberyGroup(t.url) })));
  if (order.join() === tabs.map(t => t.id).join()) return;
  const moved = [];
  await placeInOrder(windowId, order, id => { ownFolderMoves.add(id); syncBusy.add(id); moved.push(id); });
  setTimeout(() => moved.forEach(id => { ownFolderMoves.delete(id); syncBusy.delete(id); }), SETTLE_MS);
}

async function foldersFirstAll() {
  for (const w of await normalWindows()) await foldersFirst(w.id);
}

// A moment later: Sidebery sets a moved tab's new parent just after the move,
// and a tab dragged out of a folder must not still count as in it.
const foldersTimers = new Map();
const foldersFirstSoon = windowId => {
  if (!started) return;
  clearTimeout(foldersTimers.get(windowId));
  foldersTimers.set(windowId, setTimeout(() => { foldersTimers.delete(windowId); serial(() => foldersFirst(windowId)); }, FOLDERS_SETTLE_MS));
};
browser.tabs.onMoved.addListener((tabId, info) => { if (!ownFolderMoves.has(tabId)) foldersFirstSoon(info.windowId); });
browser.tabs.onAttached.addListener((tabId, info) => foldersFirstSoon(info.newWindowId));
browser.tabs.onCreated.addListener(tab => { if (!tab.pinned) foldersFirstSoon(tab.windowId); });
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (isSideberyGroup(change.url)) foldersFirstSoon(tab.windowId);
}, { properties: ["url"] });
