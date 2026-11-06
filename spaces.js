// DRAFT (branch "spaces", 2026-11-06): not in manifest.json yet, not tested.
// Left to do before it goes in:
// - Move the space code that sidebar-view.js has today (SPACE_KEY,
//   activeSpace, containerSpaces, spaceOf, setSpace, its onActivated
//   listener) here, so it is defined once: the unit test "no two background
//   scripts define the same top-level name" stops a duplicate. sidebar-view.js
//   then calls switchSpace for its "space" message.
// - Replace the managed-storage switch nativeSpaces with a setting in Tidier
//   itself (README: as much as possible in Tidier); off while Sidebery is in
//   use, since both would hide and reopen the same tabs.
// - Add "tabHide" to the manifest's permissions.
// - A test Firefox without Sidebery (TestFirefox option) and smoke checks:
//   switching hides the other spaces' tabs and shows the space's; ⌘T and a
//   link without a container open in the active space; selecting an essential
//   of another space switches space; essentials (pinned) are never hidden.
// - Watch: pull() in tabsync.js moving a hidden live tab into a window, and
//   ghosts created in a window whose space is another (showSpaceSoon hides them).
//
// Spaces, like Zen's and Arc's: each Firefox container is a space, with its
// own essentials, folders and tabs. A window shows one space at a time: the
// other spaces' tabs are hidden (Firefox's tabs.hide, so ⌃Tab skips them too),
// and a tab opened without a container (⌘T, a link from another app) is
// opened again in the space you are in, so logins never mix between spaces.
// The active space follows the tab you select, and is kept with the window (a
// sessions value), so it survives a restart. Switching is done in the sidebar
// (sidebar-view.js) or by selecting a tab of another space.
//
// Hiding and reopening only run with nativeSpaces in the managed storage
// (dotfiles), set once Sidebery is gone: Sidebery hides and reopens tabs by
// its own rules, and the two would fight over them.

const SPACE_KEY = "space"; // sessions window value: the active space's container
const activeSpace = new Map(); // windowId -> cookieStoreId
let nativeSpaces = null; // read once from managed storage

async function isNativeSpaces() {
  if (nativeSpaces === null) {
    nativeSpaces = !!(await browser.storage.managed.get("nativeSpaces").catch(() => ({}))).nativeSpaces;
  }
  return nativeSpaces;
}

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
  if (activeSpace.get(windowId) !== space) {
    activeSpace.set(windowId, space);
    await browser.sessions.setWindowValue(windowId, SPACE_KEY, space).catch(() => {});
  }
  await showSpace(windowId);
  viewSoon(windowId); // sidebar-view.js
}

// Show the active space's tabs and hide the others'. A tab without a container
// is shown wherever you are (it is about to be opened in the space, see below,
// or is a page that cannot be: about:, extensions' pages). Firefox cannot hide
// a pinned tab or the selected one.
async function showSpace(windowId) {
  if (!(await isNativeSpaces())) return;
  const space = activeSpace.get(windowId);
  if (!space) return;
  const tabs = await browser.tabs.query({ windowId, pinned: false });
  const visible = t => t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER;
  const show = tabs.filter(t => t.hidden && visible(t)).map(t => t.id);
  const hide = tabs.filter(t => !t.hidden && !visible(t) && !t.active).map(t => t.id);
  if (show.length) await browser.tabs.show(show).catch(() => {});
  if (hide.length) await browser.tabs.hide(hide).catch(() => {});
}

// Switching in the sidebar: back to the tab you used last in that space (an
// essential counts), else a new tab there.
async function switchSpace(windowId, space) {
  const last = (await browser.tabs.query({ windowId, cookieStoreId: space }))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  activeSpace.set(windowId, space); // before the tab is selected, so onActivated agrees
  if (last) await browser.tabs.update(last.id, { active: true }).catch(() => {});
  else if (await isNativeSpaces()) await browser.tabs.create({ windowId, cookieStoreId: space });
  await setSpace(windowId, space);
}

// The selected tab decides the space: a tab in another space (a link, an
// essential, ⌃Tab) takes you there.
browser.tabs.onActivated.addListener(({ tabId, windowId }) => serial(async () => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab && tab.cookieStoreId !== NO_CONTAINER && activeSpace.get(windowId) !== tab.cookieStoreId) await setSpace(windowId, tab.cookieStoreId);
}));

// A tab created in another space (a ghost or essential copy from tab sync, a
// tab moved in) is hidden at once.
const showTimers = new Map();
function showSpaceSoon(windowId) {
  clearTimeout(showTimers.get(windowId));
  showTimers.set(windowId, setTimeout(() => { showTimers.delete(windowId); serial(() => showSpace(windowId)); }, VIEW_DEBOUNCE_MS));
}
browser.tabs.onCreated.addListener(tab => showSpaceSoon(tab.windowId));
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => showSpaceSoon(newWindowId));
browser.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.pinned === false) showSpaceSoon(tab.windowId); }, { properties: ["pinned"] });
browser.windows.onRemoved.addListener(windowId => { activeSpace.delete(windowId); clearTimeout(showTimers.get(windowId)); showTimers.delete(windowId); });

// --- A tab without a container is opened again in the space you are in -----
// ⌘T opens a new tab page, a link from another app (Slack, Mail) an address,
// both without a container. A new tab page is opened again at once; a link
// once its address is known (Firefox creates the tab on about:blank first),
// within REOPEN_WINDOW_MS. Pages a container cannot have (about:, extensions'
// own pages, files) stay as they are.
const REOPEN_WINDOW_MS = 3000;
const NEW_TAB_PAGES = new Set(["about:newtab", "about:home", "about:blank"]);
const newTabs = new Map(); // tabId -> when it was created, for tabs that may need reopening

browser.tabs.onCreated.addListener(tab => {
  if (tab.cookieStoreId !== NO_CONTAINER || tab.pinned || tab.incognito || syncBusy.has(tab.id)) return;
  newTabs.set(tab.id, Date.now());
  setTimeout(() => newTabs.delete(tab.id), REOPEN_WINDOW_MS);
  if (tab.url === "about:newtab" || tab.url === "about:home") serial(() => intoSpace(tab.id));
});
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (newTabs.has(tabId) && isWeb(change.url)) serial(() => intoSpace(tabId));
}, { properties: ["url"] });
browser.tabs.onRemoved.addListener(tabId => newTabs.delete(tabId));

async function intoSpace(tabId) {
  if (!newTabs.delete(tabId) || !(await isNativeSpaces())) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId !== NO_CONTAINER) return;
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  const space = activeSpace.get(tab.windowId);
  if (!win || win.type !== "normal" || !space) return;
  const url = NEW_TAB_PAGES.has(tab.url) ? undefined : tab.url;
  if (url !== undefined && !isWeb(url)) return;
  await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: space, url, active: tab.active, index: tab.index + 1 });
  await browser.tabs.remove(tab.id).catch(() => {});
}
