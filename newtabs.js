// One place for new tabs (Tidier alone), as in Arc: the top of today's tabs, right
// under the folders, for the new tab button, ⌘T and links from other apps. Firefox
// itself would add them at the end of the window, out of sight below a long list.
// A link opened from a tab in today's list is different: it stays next to that tab, where
// Firefox puts it, since that is where you are reading. A link from a tab drawn apart
// (an essential, a tab in a folder) has nothing to stay next to, and takes the one place.

// Whether a tab is drawn among today's tabs of `space`, as viewFor (sidebar-view.js) has
// it. A tab without a container is shown in every space; a tab in a folder is drawn apart,
// under its folder, wherever it lies in the window.
function drawnToday(all, space) {
  const folders = new Set(foldersOf(all, space).map(f => f.key));
  return t => !t.pinned && (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER)
    && !folders.has(folderKeyOf(all, syncKeyByTab.get(t.id)));
}

// The index in the window that makes a tab the first of today's tabs of `space`: the
// index of the first one shown now, or the end if there are none. (Other spaces' tabs
// can lie anywhere between: the window's order is not what is drawn.)
async function topOfToday(windowId, space) {
  const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const first = tabs.find(drawnToday(await getSynced(), space));
  return first ? first.index : tabs.length;
}

// Whether the tab that opened `tab` is in today's list of `space`, so that next to it means
// something. A rule can send a link from one space to another, where its opener is not shown.
async function besideOpener(tab, space) {
  const opener = tab.openerTabId == null ? null : await browser.tabs.get(tab.openerTabId).catch(() => null);
  return !!opener && drawnToday(await getSynced(), space)(opener);
}

// Where a tab goes when it is opened again in `space` (spaces.js).
async function indexWhenReopened(tab, space) {
  return await besideOpener(tab, space) ? tab.index + 1 : topOfToday(tab.windowId, space);
}

// A link from a tab drawn apart stays a tab of its own (PLAN.md, Choices made), and Firefox
// puts it next to its opener in the window: in the middle of today's tabs, or at the end, out
// of sight, since a tab moved into a folder lies last in the window. Moved at once, before the
// view is drawn (VIEW_DEBOUNCE_MS), so there is no jump to see unless the queue is busy.
browser.tabs.onCreated.addListener(tab => {
  if (!tidierAlone || !started || tab.pinned || tab.openerTabId == null || tab.cookieStoreId === NO_CONTAINER) return;
  serial(async () => {
    if (await besideOpener(tab, tab.cookieStoreId)) return;
    const now = await browser.tabs.get(tab.id).catch(() => null);
    if (!now || now.pinned) return;
    const index = await topOfToday(now.windowId, now.cookieStoreId);
    if (index < now.index) await browser.tabs.move(now.id, { index }).catch(() => {});
  });
});

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
