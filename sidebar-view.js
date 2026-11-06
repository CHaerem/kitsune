// Tidier's own sidebar (sidebar/), like Zen and Arc: the active space's
// essentials at the top, its folders and tabs below, and the spaces at the
// bottom. This part runs in the background: it builds each window's view and
// sends it to that window's sidebar whenever something it shows changes, and
// carries out what you do there (select, close, switch space).
//
// A space is a Firefox container: its name, colour and icon are the
// container's own (Firefox's settings, or the container menu). The active
// space of a window follows the tab you select, and is kept with the window
// (a sessions value), so it survives a restart.
//
// The order shown is the window's tab order for now; folders are read from
// tab sync's record (Sidebery's folder pages) until Tidier keeps its own.

const SPACE_KEY = "space"; // sessions window value: the active space's container
const activeSpace = new Map(); // windowId -> cookieStoreId
const sidebarPorts = new Map(); // windowId -> Set of ports (a window has one sidebar; a reload may briefly add a second)
const viewTimers = new Map(); // windowId -> timer for the next view
const VIEW_DEBOUNCE_MS = 30; // a burst of tab events becomes one view

async function containerSpaces() {
  const ids = await browser.contextualIdentities.query({}).catch(() => []);
  return ids.map(c => ({ id: c.cookieStoreId, name: c.name, color: c.colorCode, icon: c.icon }));
}

// The window's active space: the one it has, else the selected tab's.
async function spaceOf(windowId, tabs, spaces) {
  let space = activeSpace.get(windowId) ?? await browser.sessions.getWindowValue(windowId, SPACE_KEY).catch(() => undefined);
  if (!spaces.some(s => s.id === space)) {
    const selected = tabs.find(t => t.active);
    space = spaces.some(s => s.id === selected?.cookieStoreId) ? selected.cookieStoreId : spaces[0]?.id;
  }
  activeSpace.set(windowId, space);
  return space;
}

async function setSpace(windowId, space) {
  if (activeSpace.get(windowId) === space) return;
  activeSpace.set(windowId, space);
  await browser.sessions.setWindowValue(windowId, SPACE_KEY, space).catch(() => {});
  viewSoon(windowId);
}

// What the sidebar shows of a tab. A placeholder's own title and icon are the
// page's (see ghost.js); an essential shows its short name if it has one.
const tabItem = (t, title) => ({
  id: t.id, title: title || t.title || t.url, icon: t.favIconUrl || null,
  active: t.active, loaded: !t.discarded && !isGhostUrl(t.url), audible: !!t.audible,
});

const folderName = url => decodeURIComponent((url.split("#")[1] || "").replace(/~!.*!~$/, "")) || "Folder";

async function viewFor(windowId) {
  const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const allSpaces = await containerSpaces();
  const list = await getList();
  // Spaces in use: a container with essentials or tabs.
  const used = new Set([...list.map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
  const spaces = allSpaces.filter(s => used.has(s.id));
  const space = await spaceOf(windowId, tabs, spaces);

  const rank = new Map(list.map((e, i) => [e.key, i]));
  const pinned = tabs.filter(t => t.pinned && t.cookieStoreId === space);
  const keys = await Promise.all(pinned.map(keyOf));
  const essentials = pinned.map((t, i) => ({ t, entry: list.find(e => e.key === keys[i]) }))
    .sort((a, b) => (rank.get(a.entry?.key) ?? Infinity) - (rank.get(b.entry?.key) ?? Infinity))
    .map(({ t, entry }) => tabItem(t, entry?.name || entry?.title));

  // A tab without a container (a new tab) belongs to the space you are in.
  const all = await getSynced();
  const here = tabs.filter(t => !t.pinned && (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER));
  const folders = here.filter(t => isSideberyGroup(t.url)).map(t => ({ key: syncKeyByTab.get(t.id), id: t.id, name: folderName(t.url), tabs: [] }));
  const byKey = new Map(folders.map(f => [f.key, f]));
  const loose = [];
  for (const t of here) {
    if (isSideberyGroup(t.url)) continue;
    const folder = byKey.get(folderKeyOf(all, syncKeyByTab.get(t.id)));
    (folder ? folder.tabs : loose).push(tabItem(t, all[syncKeyByTab.get(t.id)]?.title));
  }
  return { spaces, space, essentials, folders, tabs: loose };
}

function viewSoon(windowId) {
  if (!sidebarPorts.get(windowId)?.size) return;
  clearTimeout(viewTimers.get(windowId));
  viewTimers.set(windowId, setTimeout(async () => {
    viewTimers.delete(windowId);
    const view = await viewFor(windowId).catch(err => (console.error("Tidier: sidebar", err), null));
    if (view) for (const port of sidebarPorts.get(windowId) || []) port.postMessage(view);
  }, VIEW_DEBOUNCE_MS));
}
const viewAllSoon = () => { for (const windowId of sidebarPorts.keys()) viewSoon(windowId); };

browser.runtime.onConnect.addListener(port => {
  if (port.name !== "sidebar" || port.sender?.id !== browser.runtime.id) return;
  let windowId = null;
  port.onMessage.addListener(async msg => {
    if (msg.type === "hello") {
      windowId = msg.windowId;
      if (!sidebarPorts.has(windowId)) sidebarPorts.set(windowId, new Set());
      sidebarPorts.get(windowId).add(port);
      viewSoon(windowId);
    } else if (windowId === null) {
      return;
    } else if (msg.type === "select") {
      await browser.tabs.update(msg.tabId, { active: true }).catch(() => {});
    } else if (msg.type === "close") {
      await browser.tabs.remove(msg.tabId).catch(() => {});
    } else if (msg.type === "space") {
      await setSpace(windowId, msg.space);
      // Back to the tab you used last in that space, if it has one.
      const last = (await browser.tabs.query({ windowId, cookieStoreId: msg.space }))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      if (last) await browser.tabs.update(last.id, { active: true }).catch(() => {});
    }
  });
  port.onDisconnect.addListener(() => {
    const set = sidebarPorts.get(windowId);
    if (!set) return;
    set.delete(port);
    if (!set.size) { sidebarPorts.delete(windowId); clearTimeout(viewTimers.get(windowId)); viewTimers.delete(windowId); }
  });
});

// The selected tab decides the space: a tab in another space (a link, ⌃Tab)
// takes you there.
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab && tab.cookieStoreId !== NO_CONTAINER) await setSpace(windowId, tab.cookieStoreId);
  viewSoon(windowId);
});
for (const event of ["onCreated", "onMoved", "onAttached", "onDetached"]) {
  browser.tabs[event].addListener((tabOrId, info) => viewSoon(tabOrId.windowId ?? info?.windowId ?? info?.newWindowId ?? info?.oldWindowId));
}
browser.tabs.onRemoved.addListener((tabId, info) => viewSoon(info.windowId));
browser.tabs.onUpdated.addListener((tabId, change, tab) => viewSoon(tab.windowId),
  { properties: ["title", "favIconUrl", "status", "discarded", "audible", "pinned", "url"] });
browser.windows.onRemoved.addListener(windowId => activeSpace.delete(windowId));
for (const event of ["onCreated", "onUpdated", "onRemoved"]) browser.contextualIdentities[event].addListener(viewAllSoon);
