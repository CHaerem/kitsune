// Tidier's own sidebar (sidebar/), like Zen and Arc: the active space's
// essentials at the top, its folders and tabs below, and the spaces at the
// bottom. This part runs in the background: it builds each window's view and
// sends it to that window's sidebar whenever something it shows changes, and
// carries out what you do there.
//
// A space is a Firefox container (spaces.js): its name, colour and icon are the
// container's own (Firefox's settings, or the container menu).
//
// The order shown is the window's tab order. Folders are Tidier's own with Tidier
// alone (ownfolders.js), else Sidebery's folder pages, read from tab sync's record.

const sidebarPorts = new Map(); // windowId -> Set of ports (a window has one sidebar; a reload may briefly add a second)
const viewTimers = new Map(); // windowId -> timer for the next view
const VIEW_DEBOUNCE_MS = 30; // a burst of tab events becomes one view

// What the sidebar shows of a tab. A placeholder's own title and icon are the
// page's (see ghost.js); an essential shows its short name if it has one.
const tabItem = (t, title) => ({
  id: t.id, title: title || t.title || t.url, icon: t.favIconUrl || null,
  active: t.active, loaded: !t.discarded && !isGhostUrl(t.url), audible: !!t.audible, muted: !!t.mutedInfo?.muted,
});

const folderName = url => decodeURIComponent((url.split("#")[1] || "").replace(/~!.*!~$/, "")) || "Folder";

async function viewFor(windowId) {
  const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const list = await getList();
  // Spaces in use: a container with essentials or tabs (with Tidier alone, also the empty ones).
  const used = new Set([...list.map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
  const spaces = await spaceList(used);
  const space = await spaceOf(windowId, tabs, spaces);

  const rank = new Map(list.map((e, i) => [e.key, i]));
  const pinned = tabs.filter(t => t.pinned && (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER));
  const keys = await Promise.all(pinned.map(keyOf));
  const essentials = pinned.map((t, i) => ({ t, entry: list.find(e => e.key === keys[i]) }))
    .sort((a, b) => (rank.get(a.entry?.key) ?? Infinity) - (rank.get(b.entry?.key) ?? Infinity))
    .map(({ t, entry }) => tabItem(t, entry?.name || entry?.title));

  // A tab without a container (a new tab) belongs to the space you are in.
  const all = await getSynced();
  const here = tabs.filter(t => !t.pinned && (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER));
  const folders = tidierAlone
    ? foldersOf(all, space).map(f => ({ key: f.key, name: f.name, collapsed: !!f.collapsed, live: f.live || null, tabs: [] }))
    : here.filter(t => isSideberyGroup(t.url)).map(t => ({ key: syncKeyByTab.get(t.id), id: t.id, name: folderName(t.url), tabs: [] }));
  const byKey = new Map(folders.map(f => [f.key, f]));
  const loose = [];
  for (const t of here) {
    if (isSideberyGroup(t.url)) continue;
    const folder = byKey.get(folderKeyOf(all, syncKeyByTab.get(t.id)));
    (folder ? folder.tabs : loose).push(tabItem(t, all[syncKeyByTab.get(t.id)]?.title));
  }
  return { alone: tidierAlone, needsHiding: tidierAlone && !browser.tabs.hide, problem: [...notices.values()][0] ?? null, spaces, space, essentials, folders, tabs: loose };
}

function viewSoon(windowId) {
  if (!sidebarPorts.get(windowId)?.size) return;
  clearTimeout(viewTimers.get(windowId));
  viewTimers.set(windowId, setTimeout(async () => {
    viewTimers.delete(windowId);
    work.views++;
    const t0 = performance.now();
    const view = await viewFor(windowId).catch(err => (console.error("Tidier: sidebar", err), null));
    const ms = performance.now() - t0;
    work.viewMs += ms;
    work.longestViewMs = Math.max(work.longestViewMs, ms);
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
      await serial(() => switchSpace(windowId, msg.space));
    } else if (msg.type === "newTab") {
      await browser.tabs.create({ windowId, cookieStoreId: msg.space });
    } else if (msg.type === "mute") {
      await browser.tabs.update(msg.tabId, { muted: msg.muted }).catch(() => {});
    } else if (tidierAlone) {
      await serial(() => sidebarAction(windowId, msg)).catch(() => {}); // logged by serial()
    }
  });
  port.onDisconnect.addListener(() => {
    const set = sidebarPorts.get(windowId);
    if (!set) return;
    set.delete(port);
    if (!set.size) { sidebarPorts.delete(windowId); clearTimeout(viewTimers.get(windowId)); viewTimers.delete(windowId); }
  });
});

// What you do in the sidebar with Tidier alone (ownfolders.js).
async function sidebarAction(windowId, msg) {
  if (msg.type === "newFolder") await createFolder(msg.name || "New folder", msg.space);
  else if (msg.type === "renameFolder") await renameFolder(msg.key, msg.name);
  else if (msg.type === "foldFolder") await foldFolder(msg.key, msg.collapsed);
  else if (msg.type === "deleteFolder") await deleteFolder(msg.key);
  else if (msg.type === "moveFolder") await moveFolder(msg.key, msg.before ?? null);
  else if (msg.type === "moveTab") await moveTab(windowId, msg.tabId, msg.before ?? null, msg.folder);
  else if (msg.type === "moveToSpace") await moveToSpace(msg.tabId, msg.space);
  else if (msg.type === "pin") await browser.tabs.update(msg.tabId, { pinned: msg.pinned });
  else if (msg.type === "moveEssential") await moveEssential(windowId, msg.tabId, msg.before ?? null);
  viewSoon(windowId);
}

// An essential's tile moved: moving its tab is what the rest of Tidier listens to.
async function moveEssential(windowId, tabId, beforeId) {
  const tabs = await browser.tabs.query({ windowId, pinned: true });
  const before = tabs.find(t => t.id === beforeId), tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  let index = before ? before.index : tabs.at(-1).index;
  if (before && tab.index < before.index) index--;
  if (index !== tab.index) await browser.tabs.move(tabId, { index });
}

// The toolbar button shows or hides the sidebar: without a sidebar, a window has
// no list of tabs at all (the tab bar is hidden in userChrome.css).
browser.browserAction.onClicked.addListener(() => browser.sidebarAction.toggle());
for (const event of ["onCreated", "onMoved", "onAttached", "onDetached"]) {
  browser.tabs[event].addListener((tabOrId, info) => viewSoon(tabOrId.windowId ?? info?.windowId ?? info?.newWindowId ?? info?.oldWindowId));
}
browser.tabs.onRemoved.addListener((tabId, info) => viewSoon(info.windowId));
browser.tabs.onUpdated.addListener((tabId, change, tab) => viewSoon(tab.windowId),
  { properties: ["title", "favIconUrl", "status", "discarded", "audible", "mutedInfo", "pinned", "url", "hidden"] });
for (const event of ["onCreated", "onUpdated", "onRemoved"]) browser.contextualIdentities[event].addListener(viewAllSoon);
