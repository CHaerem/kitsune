// One place for new tabs (Tidier alone), as in Arc: the top of today's tabs, right
// under the folders, for the new tab button, ⌘T and links from other apps. Firefox
// itself would add them at the end of the window, out of sight below a long list.
// A link opened from a tab is different: it stays next to that tab, where Firefox
// puts it, since that is where you are reading.

// The index in the window that makes a tab the first of today's tabs of `space`: the
// index of the first one shown now, or the end if there are none. This walks the
// window as viewFor (sidebar-view.js) draws it. A tab without a container is shown in
// every space, and other spaces' tabs can lie anywhere between; a tab in a folder
// is drawn apart, under its folder, wherever it lies in the window.
async function topOfToday(windowId, space) {
  const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const all = await getSynced();
  const folders = new Set(foldersOf(all, space).map(f => f.key));
  const first = tabs.find(t => !t.pinned && (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER)
    && !folders.has(folderKeyOf(all, syncKeyByTab.get(t.id))));
  return first ? first.index : tabs.length;
}

// Where a tab goes when it is opened again in `space` (spaces.js). Beside the tab that
// opened it only if that tab is in the same list. Essentials are drawn apart, and a
// rule can send a link from one space to another, where its opener is not shown: "next
// to it" would then be some place in the middle of that list, so it takes the one place.
async function indexWhenReopened(tab, space) {
  const opener = tab.openerTabId == null ? null : await browser.tabs.get(tab.openerTabId).catch(() => null);
  const besideOpener = opener && !opener.pinned && (opener.cookieStoreId === space || opener.cookieStoreId === NO_CONTAINER);
  return besideOpener ? tab.index + 1 : topOfToday(tab.windowId, space);
}

// A tab without a container that is about to be opened again in the space is not drawn.
// Firefox adds it at the end of the window, so its row would show there, selected, and
// jump to the top when the new one comes: a link from another app takes a while to report
// its address. (A page a container cannot have, such as about:addons, stays as it is.)
// A blank tab that never gets an address is drawn after REOPEN_WINDOW_MS (spaces.js).
const reopensSoon = t => newTabs.has(t.id) && (NEW_TAB_PAGES.has(t.url) || isWeb(t.url));

// Where another window's placeholder of `tabId` goes (`tabs`: every window's, from
// tabs.query): before the same neighbour it has in its own window. A new tab page is
// not in the record until it has an address, so its placeholders come late, and at the
// end of the window they would show it last there and first here. Created in the right
// place from the start, there is no move to see. With nothing after it in its space
// here, the end is right there too (undefined: tabs.create's own default).
function indexBeforeSameNeighbour(tabs, tabId, windowId) {
  const tab = tabs.find(t => t.id === tabId);
  const there = repMap(tabs.filter(t => t.windowId === windowId));
  const after = tabs.filter(t => t.windowId === tab?.windowId && t.cookieStoreId === tab.cookieStoreId && !t.pinned && t.index > tab.index)
    .sort((a, b) => a.index - b.index);
  for (const t of after) {
    const rep = there.get(syncKeyByTab.get(t.id));
    if (rep !== undefined) return tabs.find(x => x.id === rep).index;
  }
  return undefined;
}
