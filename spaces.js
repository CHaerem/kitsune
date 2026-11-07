// Spaces, like Zen's and Arc's: each Firefox container is a space, with its own
// essentials, folders and tabs, and its own logins. A window shows one space at
// a time. The active space follows the tab you select, and is kept with the window
// (a sessions value), so it survives a restart.
//
// With Tidier alone (common.js), the other spaces' tabs are hidden (so ⌃Tab skips
// them too), a tab opened without a container (⌘T, a link from another app) is
// opened again in the space you are in, so logins never mix, and ⌃1/⌃2/⌃3 switch
// space. Until then Sidebery does all that, and the two must not fight over the
// tabs, so here the active space only decides what Tidier's sidebar shows.
//
// Firefox cannot hide a pinned tab, so other spaces' essentials stay in ⌃Tab;
// selecting one takes you to its space.

const SPACE_KEY = "space"; // sessions window value: the active space's container
const activeSpace = new Map(); // windowId -> cookieStoreId
const SPACE_DEBOUNCE_MS = 30; // a burst of new tabs is hidden in one go

// Which spaces there are, in the order of the bar: declared for a machine in
// managed storage ({ spaces: [container ids] }), else Sidebery's order if imported,
// else the ones the essentials have, in their order, then the other containers.
async function containerSpaces() {
  const ids = await browser.contextualIdentities.query({}).catch(() => []);
  return ids.map(c => ({ id: c.cookieStoreId, name: c.name, color: c.colorCode, icon: c.icon, iconUrl: c.iconUrl }));
}
async function spaceList(used) {
  const all = await containerSpaces();
  if (!tidierAlone) return all.filter(s => used.has(s.id));
  const declared = (await browser.storage.managed.get("spaces").catch(() => ({}))).spaces;
  const { spaceOrder } = await browser.storage.local.get("spaceOrder"); // from Sidebery's export (moveover.js)
  const first = Array.isArray(declared) ? declared : spaceOrder ?? (await getList()).map(e => e.cookieStoreId);
  const rank = new Map([...new Set(first)].map((id, i) => [id, i]));
  const listed = s => !Array.isArray(declared) || rank.has(s.id) || used.has(s.id);
  return all.filter(listed).sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

// The window's active space: the one it has, else the selected tab's.
async function spaceOf(windowId, tabs, spaces) {
  let space = activeSpace.get(windowId) ?? await browser.sessions.getWindowValue(windowId, SPACE_KEY).catch(() => undefined);
  if (!spaces.some(s => s.id === space)) {
    const selected = tabs.find(t => t.active);
    space = spaces.some(s => s.id === selected?.cookieStoreId) ? selected.cookieStoreId : spaces[0]?.id;
    // A space removed lands here first if a view comes before the queue gets to it
    // (spaceRemoved, safemoves.js), and then nothing else would show this space's tabs.
    showSpaceSoon(windowId);
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

// Show the active space's tabs and hide the others'. A tab without a container is
// shown wherever you are (it is about to be opened in the space, see below, or is a
// page that cannot be: about:, extensions' pages). Firefox cannot hide a pinned tab
// or the selected one.
async function showSpace(windowId) {
  if (!tidierAlone) return;
  const space = activeSpace.get(windowId);
  if (!space) return;
  const tabs = await browser.tabs.query({ windowId, pinned: false }).catch(() => []);
  const visible = t => t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER;
  const show = tabs.filter(t => t.hidden && visible(t)).map(t => t.id);
  const hide = tabs.filter(t => !t.hidden && !visible(t) && !t.active).map(t => t.id);
  if (show.length) await browser.tabs.show(show).catch(() => {});
  // Without the permission (asked for in the sidebar) tabs.hide is not there.
  if (hide.length) await browser.tabs.hide?.(hide).catch(() => {});
}

// The tab to go back to in a space: the one used last, an essential counts.
async function lastUsedIn(windowId, space, exceptId) {
  const tabs = await browser.tabs.query({ windowId, cookieStoreId: space }).catch(() => []);
  return tabs.filter(t => t.id !== exceptId).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

// Switching: back to the tab you used last in that space, else a new tab there.
async function switchSpace(windowId, space) {
  const last = await lastUsedIn(windowId, space);
  activeSpace.set(windowId, space); // before the tab is selected, so onActivated agrees
  if (last) await browser.tabs.update(last.id, { active: true }).catch(() => {});
  else if (tidierAlone) await browser.tabs.create({ windowId, cookieStoreId: space });
  await setSpace(windowId, space);
}

// The n-th space on the bar (⌃1, ⌃2, ...).
async function switchToNth(n) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const tabs = await browser.tabs.query({ windowId: tab.windowId });
  const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
  const space = (await spaceList(used))[n];
  if (space) await switchSpace(tab.windowId, space.id);
}
browser.commands.onCommand.addListener(name => {
  const n = /^space-(\d)$/.exec(name);
  if (n && tidierAlone) serial(() => switchToNth(n[1] - 1));
});

// The selected tab decides the space: a tab in another space (a link, an essential,
// ⌃Tab) takes you there. Closing the last tab of a space is different: Firefox then
// selects any tab it can show, and you stay in the space, with a new tab.
const closedIn = new Map(); // windowId -> the space a tab was closed in, for a moment
browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  // (Not while Firefox starts: restoring a session closes the window's first tab, which is no tab you left.)
  if (!tidierAlone || !started || isWindowClosing || !activeSpace.has(windowId)) return;
  closedIn.set(windowId, activeSpace.get(windowId));
  setTimeout(() => closedIn.delete(windowId), 200);
});
browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const stay = closedIn.get(windowId); // now: the queue may be busy for longer than this is kept
  closedIn.delete(windowId);
  serial(async () => {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    // No longer selected, its own event is on its way: going through every tab selected
    // for a moment (each page an Undo brings back) would show each one's space in turn.
    if (!tab?.active || tab.cookieStoreId === NO_CONTAINER) { viewSoon(windowId); return; }
    if (tidierAlone && stay && stay !== tab.cookieStoreId) {
      const last = await lastUsedIn(windowId, stay);
      if (last) { await browser.tabs.update(last.id, { active: true }).catch(() => {}); return; }
      // Refused when the space has just been removed (safemoves.js): then this tab's space it is.
      if (await browser.tabs.create({ windowId, cookieStoreId: stay }).catch(() => null)) return;
    }
    await setSpace(windowId, tab.cookieStoreId);
    await setSuccessor(tab);
    viewSoon(windowId);
  });
});

// What Firefox selects when the selected tab closes: the one used last in its
// space, not the next tab it happens to be able to show.
async function setSuccessor(tab) {
  if (!tidierAlone) return;
  const next = await lastUsedIn(tab.windowId, tab.cookieStoreId, tab.id);
  await browser.tabs.update(tab.id, { successorTabId: next ? next.id : browser.tabs.TAB_ID_NONE }).catch(() => {});
}

// A tab created in another space (a ghost or essential copy from tab sync, a tab
// moved in) is hidden at once.
const showTimers = new Map();
function showSpaceSoon(windowId) {
  if (!tidierAlone || !started) return;
  clearTimeout(showTimers.get(windowId));
  showTimers.set(windowId, setTimeout(() => { showTimers.delete(windowId); serial(() => showSpace(windowId)); }, SPACE_DEBOUNCE_MS));
}
browser.tabs.onCreated.addListener(tab => showSpaceSoon(tab.windowId));
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => showSpaceSoon(newWindowId));
browser.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.pinned === false) showSpaceSoon(tab.windowId); }, { properties: ["pinned"] });
browser.windows.onRemoved.addListener(windowId => {
  activeSpace.delete(windowId);
  clearTimeout(showTimers.get(windowId));
  showTimers.delete(windowId);
});
// A new window starts in the space you are in, and keeps Firefox's first tab there.
browser.windows.onCreated.addListener(win => {
  if (tidierAlone && activeSpace.has(focusedWindowId)) activeSpace.set(win.id, activeSpace.get(focusedWindowId));
});

// --- A tab without a container is opened again in the space you are in -----
// ⌘T opens a new tab page, a link from another app (Slack, Mail) an address, both
// without a container. A new tab page is opened again at once; a link once its
// address is known (Firefox creates the tab on about:blank first), within
// REOPEN_WINDOW_MS. Pages a container cannot have (about:, extensions' own pages,
// files) stay as they are. A link's first request has then gone out without a
// container: it carries no login, since those are all in containers.
const REOPEN_WINDOW_MS = 3000;
const NEW_TAB_PAGES = new Set(["about:newtab", "about:home", "about:blank"]);
const newTabs = new Map(); // tabId -> when it was created, for tabs that may need reopening

browser.tabs.onCreated.addListener(tab => {
  if (!tidierAlone || !started || tab.pinned || tab.incognito || syncBusy.has(tab.id)) return;
  if (!isWeb(tab.url) && !isGhostUrl(tab.url)) firstPage.add(tab.id);
  if (tab.cookieStoreId !== NO_CONTAINER) return;
  newTabs.set(tab.id, Date.now());
  setTimeout(() => newTabs.delete(tab.id), REOPEN_WINDOW_MS);
  if (tab.url === "about:newtab" || tab.url === "about:home") serial(() => intoSpace(tab.id));
});
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  if (isWeb(change.url) && firstPage.delete(tabId)) serial(() => byRule(tabId, change.url));
  else if (newTabs.has(tabId) && (isWeb(change.url) || change.url === "about:newtab" || change.url === "about:home")) serial(() => intoSpace(tabId));
}, { properties: ["url"] });
browser.tabs.onRemoved.addListener(tabId => { newTabs.delete(tabId); firstPage.delete(tabId); });

// --- Rules: an address always opens in a given space (Arc's Air Traffic Control) ---
// A rule is text to find in the address, or /a regular expression/. It is looked at
// for a tab's first page only: a sign-in passing through the address on its way
// back to the page you were on must not move your tab (with Sidebery's rules, which
// look at every address a tab loads, it did).
const rulesList = storedValue("rules", () => []); // [{ url, space }]
const firstPage = new Set(); // tabs that have not shown a web page yet

function ruleMatches(rule, url) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(rule);
  if (!re) return url.includes(rule);
  try { return new RegExp(re[1], re[2]).test(url); } catch (err) { return false; }
}

async function byRule(tabId, url) {
  const rule = (await rulesList.get()).find(r => ruleMatches(r.url, url));
  const tab = rule && await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId === rule.space || await exemptFromRules(tabId)) return intoSpace(tabId);
  newTabs.delete(tabId);
  const opened = await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: rule.space, url, active: tab.active, index: tab.index + 1 }).catch(err => ruleFailed(rule, err));
  if (!opened) return intoSpace(tabId); // closing it now would lose the link (safemoves.js)
  await browser.tabs.remove(tabId).catch(() => {});
}

async function intoSpace(tabId) {
  newTabs.delete(tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId !== NO_CONTAINER) return;
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  // (A new window's first tab can come before the window is announced.)
  const space = activeSpace.get(tab.windowId) ?? activeSpace.get(focusedWindowId);
  if (!win || win.type !== "normal" || !space) return;
  const url = NEW_TAB_PAGES.has(tab.url) ? undefined : tab.url;
  if (url !== undefined && !isWeb(url)) return;
  await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: space, url, active: tab.active, index: tab.index + 1 });
  await browser.tabs.remove(tab.id).catch(() => {});
}

// --- When Tidier starts ------------------------------------------------------
// ⌃1/⌃2/... are given here, not in the manifest, so that they are not taken from
// Sidebery while it is in use. A key you have changed yourself stays.
const SPACE_KEYS = 5;
async function setSpaceKeys() {
  const { os } = await browser.runtime.getPlatformInfo();
  const control = os === "mac" ? "MacCtrl" : "Ctrl";
  const commands = await browser.commands.getAll();
  for (let n = 1; n <= SPACE_KEYS; n++) {
    const command = commands.find(c => c.name === `space-${n}`);
    if (command && !command.shortcut) await browser.commands.update({ name: command.name, shortcut: `${control}+${n}` }).catch(noteError);
  }
  // Without a sidebar a window has no list of tabs at all: a key to bring it back.
  if (commands.some(c => c.name === "_execute_sidebar_action" && !c.shortcut)) {
    await browser.commands.update({ name: "_execute_sidebar_action", shortcut: `${control}+Shift+S` }).catch(noteError);
  }
}

async function resetSpaceKeys() {
  for (const c of await browser.commands.getAll()) if (c.name.startsWith("space-") || c.name === "_execute_sidebar_action") await browser.commands.reset(c.name).catch(() => {});
}

// The permission to hide tabs was given in the sidebar.
browser.permissions.onAdded.addListener(() => { if (started) serial(startSpaces); });

// Each window's active space, shown again: Firefox shows every hidden tab again
// when an add-on with this permission as an optional one is updated.
async function startSpaces() {
  if (!tidierAlone) return;
  await setSpaceKeys();
  startMenus(); // ownfolders.js
  for (const w of await normalWindows()) {
    const tabs = await browser.tabs.query({ windowId: w.id });
    const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
    const space = await spaceOf(w.id, tabs, await spaceList(used));
    await showSpace(w.id);
    const active = tabs.find(t => t.active);
    if (active && active.cookieStoreId === space) await setSuccessor(active);
  }
}
