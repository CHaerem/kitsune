// Folders first: in each space, Sidebery's folders (with the tabs in them)
// come before the ordinary tabs, like the pinned part of a space in Zen and
// Arc. Sidebery has no setting for it, and reordering with CSS would only
// change the picture (dragging and the keyboard would still follow the real
// order), so the real tab order is kept instead.
//
// A space is one contiguous run of tabs in its container (Sidebery requires
// that, see sortLikeReference). When a run does not start with its folder
// branches, they are moved to its start in one tabs.move call, in their own
// order, so each branch stays together and the run stays contiguous. The tree
// is read with treeParent (common.js).
//
// It runs after Kitsune has started and whenever a tab is created, moved,
// attached or becomes a folder page. Our own moves are not answered.

const ownFolderMoves = new Set();

async function foldersFirst(windowId) {
  const win = await browser.windows.get(windowId).catch(() => null);
  if (!win || win.type !== "normal" || win.incognito) return;
  const tabs = (await browser.tabs.query({ windowId, pinned: false })).sort((a, b) => a.index - b.index);
  const byId = new Map(tabs.map(t => [t.id, t]));
  const rootOf = tab => {
    let root = tab;
    for (let p = treeParent(root, byId), seen = new Set([tab.id]); p && !seen.has(p.id) && p.cookieStoreId === tab.cookieStoreId; p = treeParent(p, byId)) {
      seen.add(p.id);
      root = p;
    }
    return root;
  };
  for (const space of new Set(tabs.map(t => t.cookieStoreId))) {
    const run = tabs.filter(t => t.cookieStoreId === space);
    const inFolders = run.filter(t => isSideberyGroup(rootOf(t).url));
    if (run.slice(0, inFolders.length).every((t, i) => t === inFolders[i])) continue;
    const ids = inFolders.map(t => t.id);
    ids.forEach(id => { ownFolderMoves.add(id); syncBusy.add(id); });
    try {
      await browser.tabs.move(ids, { windowId, index: run[0].index });
    } finally {
      setTimeout(() => ids.forEach(id => { ownFolderMoves.delete(id); syncBusy.delete(id); }), SETTLE_MS);
    }
  }
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
