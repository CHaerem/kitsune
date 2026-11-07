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
const viewTimers = new Map(); // windowId -> { timer, first }: the next view, and when it was first asked for
const viewsBuilding = new Map(); // windowId -> { since, changed }: the view being built, and whether something changed meanwhile
const viewRest = new Map(); // windowId -> not before when its next view is built
const VIEW_DEBOUNCE_MS = 30; // a burst of tab events becomes one view...
const VIEW_LONGEST_WAIT_MS = 250; // ... and a long burst still shows, every so often
// Times what the last view took, so that views never take most of the time, however
// many tabs. With a limit: a view is slow when Firefox is busy, and what you just did
// must still show soon after.
const VIEW_REST = 3, VIEW_LONGEST_REST_MS = 1000;
const VIEW_STUCK_MS = 15000; // a view Firefox never answers for must not leave a sidebar frozen

// What the sidebar shows of a tab. A placeholder's own title and icon are the
// page's (see ghost.js); an essential shows its short name if it has one. The icon in
// the record is for what is not loaded: a loaded page without an icon has none, and the
// record may still have the icon of the site it was on before.
const tabItem = (t, title, icon) => ({
  id: t.id, title: title || t.title || t.url, icon: t.favIconUrl || (isLoadedCopy(t) ? null : icon) || null,
  active: t.active, loaded: !t.discarded && !isGhostUrl(t.url), audible: !!t.audible, muted: !!t.mutedInfo?.muted,
});

// The icon in the record, for a placeholder that has none of its own (createRep,
// tabsync.js). One from Firefox's own icon cache (page-icon:) cannot be shown in an
// extension's page, so then the site's, which is what ghost.js would look for. (By
// its origin: this is asked for outside the tab's container, and a login in the address
// must not go along. A record taken in from a copy can hold any address, and one
// that cannot be read must not stop the whole sidebar from drawing.)
function recordIcon(entry) {
  if (!entry) return null;
  if (/^(https?:|data:|moz-extension:)/.test(entry.icon || "")) return entry.icon;
  try { return isWeb(entry.url) ? new URL(entry.url).origin + "/favicon.ico" : null; } catch { return null; }
}

const folderName = url => decodeURIComponent((url.split("#")[1] || "").replace(/~!.*!~$/, "")) || "Folder";

async function viewFor(windowId) {
  const list = await getList();
  // Firefox builds a full description of every tab it is asked for, so a view asks only
  // for the space it shows, unless the bar itself depends on the other tabs (spaceList).
  const whole = !tidierAlone || Array.isArray(await declaredSpaces()) ? await browser.tabs.query({ windowId }) : null;
  // Spaces in use: a container with essentials or tabs (with Tidier alone, also the empty ones).
  const used = new Set(whole ? [...list.map(e => e.cookieStoreId), ...whole.map(t => t.cookieStoreId)] : []);
  const spaces = await spaceList(used);
  const space = await spaceOf(windowId, whole, spaces);
  const tabs = (whole ?? await browser.tabs.query({ windowId, cookieStoreId: space ? [space, NO_CONTAINER] : [NO_CONTAINER] })).sort((a, b) => a.index - b.index);

  const rank = new Map(list.map((e, i) => [e.key, i]));
  const byEssentialKey = new Map(list.map(e => [e.key, e]));
  const pinned = tabs.filter(t => t.pinned && (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER));
  const keys = await Promise.all(pinned.map(keyOf));
  const essentials = pinned.map((t, i) => ({ t, entry: byEssentialKey.get(keys[i]) }))
    .sort((a, b) => (rank.get(a.entry?.key) ?? Infinity) - (rank.get(b.entry?.key) ?? Infinity))
    .map(({ t, entry }) => tabItem(t, entry?.name || entry?.title, recordIcon(entry)));

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
    const folder = byKey.get(folderKeyOf(all, syncKeyByTab.get(t.id))), entry = all[syncKeyByTab.get(t.id)];
    (folder ? folder.tabs : loose).push(tabItem(t, entry?.title, recordIcon(entry)));
  }
  return { alone: tidierAlone, needsHiding: tidierAlone && !browser.tabs.hide, problem: [...notices.values()][0] ?? null, spaces, space, essentials, folders, tabs: loose };
}

// A window without a sidebar costs nothing here. The next view comes once tab events
// have paused for VIEW_DEBOUNCE_MS, at the latest VIEW_LONGEST_WAIT_MS after the first
// of them, and one at a time: a view started while another is being built could
// otherwise overtake it, and the sidebar would end up showing the older one.
function viewSoon(windowId) {
  if (!sidebarPorts.get(windowId)?.size) return;
  const now = performance.now(), building = viewsBuilding.get(windowId);
  if (building && now - building.since < VIEW_STUCK_MS) { building.changed = true; return; }
  const waiting = viewTimers.get(windowId), first = waiting?.first ?? now;
  if (waiting && now - first >= VIEW_LONGEST_WAIT_MS) return; // it is due: events that keep coming must not put it off again
  clearTimeout(waiting?.timer);
  viewTimers.set(windowId, { first, timer: setTimeout(() => buildView(windowId), viewWait(now, first, viewRest.get(windowId) ?? 0)) });
}
const viewWait = (now, first, restUntil) => Math.max(Math.min(VIEW_DEBOUNCE_MS, first + VIEW_LONGEST_WAIT_MS - now), restUntil - now, 0);
async function buildView(windowId) {
  viewTimers.delete(windowId);
  const t0 = performance.now(), building = { since: t0, changed: false };
  viewsBuilding.set(windowId, building);
  work.views++;
  const view = await viewFor(windowId).catch(err => (console.error("Tidier: sidebar", err), null));
  const ms = performance.now() - t0;
  work.viewMs += ms;
  work.longestViewMs = Math.max(work.longestViewMs, ms);
  if (viewsBuilding.get(windowId) !== building) return; // given up on: a newer one is on its way
  viewsBuilding.delete(windowId);
  if (view) for (const port of sidebarPorts.get(windowId) || []) port.postMessage(view);
  if (sidebarPorts.has(windowId)) viewRest.set(windowId, performance.now() + Math.min(VIEW_REST * ms, VIEW_LONGEST_REST_MS));
  if (building.changed) viewSoon(windowId);
}
const viewAllSoon = () => { for (const windowId of sidebarPorts.keys()) viewSoon(windowId); };
// Only the sidebars that show tabs of this space: a page in another space can change
// its title all day without any sidebar having anything to draw.
const showsSpace = (windowId, space) => { const shown = activeSpace.get(windowId); return !shown || space === shown || space === NO_CONTAINER; };
const viewSpaceSoon = space => { for (const windowId of sidebarPorts.keys()) if (showsSpace(windowId, space)) viewSoon(windowId); };

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
    if (!set.size) { sidebarPorts.delete(windowId); clearTimeout(viewTimers.get(windowId)?.timer); viewTimers.delete(windowId); viewRest.delete(windowId); viewsBuilding.delete(windowId); }
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
browser.tabs.onUpdated.addListener((tabId, change, tab) => { if (showsSpace(tab.windowId, tab.cookieStoreId)) viewSoon(tab.windowId); },
  { properties: ["title", "favIconUrl", "status", "discarded", "audible", "mutedInfo", "pinned", "url"] }); // not "hidden": a switch of space hides hundreds of tabs one by one
for (const event of ["onCreated", "onUpdated", "onRemoved"]) browser.contextualIdentities[event].addListener(viewAllSoon);
