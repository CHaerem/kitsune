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

// Kept apart from whether the active space changed: switching sets that first (switchSpace),
// and a space not kept would be back to an old one after a restart, with a link that starts
// Firefox opening there, with that space's login.
const keptSpace = new Map(); // windowId -> what its sessions value says
async function setSpace(windowId, space) {
  activeSpace.set(windowId, space);
  if (keptSpace.get(windowId) !== space) {
    keptSpace.set(windowId, space);
    await browser.sessions.setWindowValue(windowId, SPACE_KEY, space).catch(() => {});
  }
  await showSpace(windowId);
  viewSoon(windowId); // sidebar-view.js
}

// Show the active space's tabs and hide the others', and those in a closed folder
// (foldrest.js). A tab without a container is shown wherever you are (it is about to be
// opened in the space, see below, or is a page that cannot be: about:, extensions'
// pages). Firefox cannot hide a pinned tab or the selected one.
async function showSpace(windowId) {
  if (!tidierAlone) return;
  const space = activeSpace.get(windowId);
  if (!space) return;
  const tabs = await browser.tabs.query({ windowId, pinned: false }).catch(() => []);
  const all = await getSynced();
  const visible = t => (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER) && !restsInFolder(all, syncKeyByTab.get(t.id));
  const show = tabs.filter(t => t.hidden && visible(t)).map(t => t.id);
  const hide = tabs.filter(t => !t.hidden && !visible(t) && !t.active).map(t => t.id);
  if (show.length) await browser.tabs.show(show).catch(() => {});
  // Without the permission (asked for in the sidebar) tabs.hide is not there.
  if (hide.length) await browser.tabs.hide?.(hide).catch(() => {});
}

// The tab to go back to in a space: the one used last, an essential counts.
async function lastUsedIn(windowId, space, ...except) {
  const tabs = await browser.tabs.query({ windowId, cookieStoreId: space }).catch(() => []);
  return tabs.filter(t => !except.includes(t.id)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

// The tab to land on when the selected one closes. You did not ask for this tab, so it
// should not load a page by itself or open up a folder you closed: the tabs outside closed
// folders if there are any, else all of them, and among those the one used last that is
// already loaded in this window, else the one used last. An essential counts. (Switching
// space is different: there you asked for that space, and lastUsedIn takes you back to the
// tab you were on, loaded or not.)
async function nextAfterClosing(windowId, space, exceptId) {
  const here = (await browser.tabs.query({ windowId, cookieStoreId: space }).catch(() => [])).filter(t => t.id !== exceptId);
  const all = await getSynced();
  const outside = here.filter(t => !restsInFolder(all, syncKeyByTab.get(t.id)));
  const choice = outside.length ? outside : here;
  const loaded = choice.filter(t => !t.discarded && !isGhostUrl(t.url));
  if (loaded.length) return loaded.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  return usedLastOf(choice);
}

// The one used last among tabs that may be placeholders. A placeholder's own lastAccessed
// says when Tidier made it or passed over it, so its real page's is read, in whichever
// window that is; with no real page anywhere it counts as never used. Only here are all
// windows' tabs needed, and this is rare: a window you use has a loaded tab.
async function usedLastOf(tabs) {
  const keysOf = t => [syncKeyByTab.get(t.id), keyByTab.get(t.id)].filter(Boolean);
  const realUse = new Map();
  for (const t of await browser.tabs.query({}).catch(() => [])) {
    if (!isGhostUrl(t.url)) for (const k of keysOf(t)) realUse.set(k, Math.max(realUse.get(k) || 0, t.lastAccessed || 0));
  }
  const usedAt = t => isGhostUrl(t.url) ? Math.max(0, ...keysOf(t).map(k => realUse.get(k) || 0)) : t.lastAccessed || 0;
  return tabs.sort((a, b) => usedAt(b) - usedAt(a))[0];
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
const closedIn = new Map(); // windowId -> { space } a tab was closed in, for a moment
browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  // (Not while Firefox starts: restoring a session closes the window's first tab, which is no tab you left.)
  if (!tidierAlone || !started || isWindowClosing || !activeSpace.has(windowId)) return;
  const closed = { space: activeSpace.get(windowId) };
  closedIn.set(windowId, closed);
  // Only its own moment: with several tabs closing, an earlier one's timer must not end
  // the last one's, which is the one Firefox may answer by selecting another space's tab.
  setTimeout(() => { if (closedIn.get(windowId) === closed) closedIn.delete(windowId); }, 200);
});
browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const stay = closedIn.get(windowId)?.space; // now: the queue may be busy for longer than this is kept
  closedIn.delete(windowId);
  serial(async () => {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    // No longer selected, its own event is on its way: going through every tab selected
    // for a moment (each page an Undo brings back) would show each one's space in turn.
    if (!tab?.active) { viewSoon(windowId); return; }
    if (tab.cookieStoreId === NO_CONTAINER) { await setSuccessor(tab); viewSoon(windowId); return; }
    if (tidierAlone && stay && stay !== tab.cookieStoreId) {
      const next = await nextAfterClosing(windowId, stay);
      if (next) { await browser.tabs.update(next.id, { active: true }).catch(() => {}); return; }
      // Refused when the space has just been removed (safemoves.js): then this tab's space it is.
      if (await browser.tabs.create({ windowId, cookieStoreId: stay }).catch(() => null)) return;
    }
    await setSpace(windowId, tab.cookieStoreId);
    await setSuccessor(tab);
    viewSoon(windowId);
  });
});

// What Firefox selects when the selected tab closes: see nextAfterClosing, not the
// next tab it happens to be able to show. A page without a container (about:, Tidier's
// settings) is shown in the space you are in, so closing it lands there too; left to
// Firefox, it would land on whatever is beside it, an unloaded tab or a closed folder's.
async function setSuccessor(tab) {
  if (!tidierAlone) return;
  const space = tab.cookieStoreId === NO_CONTAINER ? activeSpace.get(tab.windowId) : tab.cookieStoreId;
  if (!space) return;
  const next = await nextAfterClosing(tab.windowId, space, tab.id);
  await browser.tabs.update(tab.id, { successorTabId: next ? next.id : browser.tabs.TAB_ID_NONE }).catch(() => {});
}

// The choice is made when a tab is selected, and Firefox cannot ask at the moment it
// closes. So while you stay on a tab, what the choice rests on is looked at again when
// it changes: a folder folded (foldFolder), a tab put in a folder (moveTab), a tab unloaded,
// or moved to another window and leaving a placeholder here. At most one look waits per
// window, however long the queue is busy (filling a new window is a tab event per tab):
// it reads what is true when its turn comes, and only a change after that asks for another.
const successorDue = new Set(); // windows with a look on its way
function successorSoon(windowId) {
  if (!tidierAlone || !started || successorDue.has(windowId)) return;
  successorDue.add(windowId);
  setTimeout(() => serial(async () => {
    successorDue.delete(windowId);
    const [active] = await browser.tabs.query({ windowId, active: true }).catch(() => []);
    if (active) await setSuccessor(active);
  }), SPACE_DEBOUNCE_MS);
}
browser.tabs.onCreated.addListener(tab => successorSoon(tab.windowId));
browser.tabs.onMoved.addListener((tabId, { windowId }) => successorSoon(windowId));
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => successorSoon(newWindowId));
browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => successorSoon(oldWindowId));
browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => { if (!isWindowClosing) successorSoon(windowId); });
browser.tabs.onUpdated.addListener((tabId, change, tab) => { if ("discarded" in change) successorSoon(tab.windowId); }, { properties: ["discarded"] });

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
  keptSpace.delete(windowId);
  clearTimeout(showTimers.get(windowId));
  showTimers.delete(windowId);
});
// A new window starts in the space you are in, and keeps Firefox's first tab there.
browser.windows.onCreated.addListener(win => {
  if (tidierAlone && activeSpace.has(focusedWindowId)) activeSpace.set(win.id, activeSpace.get(focusedWindowId));
});

// --- A tab without a container is opened again in the space you are in -----
// ⌘T opens a new tab page, a link from another app (Slack, Mail) an address, both
// without a container. A new tab page is opened again at once. A link is stopped
// before its first request leaves, with the permission for that (isolation.js).
// Without it, a link is opened again once its address is known (Firefox creates the
// tab on about:blank first), within REOPEN_WINDOW_MS, and its first request has then
// gone out without a container: it carries no login, since those are all in
// containers. Pages a container cannot have (about:, extensions' own pages, files)
// stay as they are.
const REOPEN_WINDOW_MS = 3000;
const NEW_TAB_PAGES = new Set(["about:newtab", "about:home", "about:blank"]);
const newTabs = new Map(); // tabId -> when it was created, for tabs that may need reopening

browser.tabs.onCreated.addListener(tab => {
  if (!tidierAlone || !started || tab.pinned || tab.incognito || syncBusy.has(tab.id)) return;
  if (!isWeb(tab.url) && !isGhostUrl(tab.url)) firstPage.add(tab.id);
  if (tab.cookieStoreId !== NO_CONTAINER) return;
  newTabs.set(tab.id, Date.now());
  setTimeout(() => { if (newTabs.has(tab.id)) serial(() => drawAfterAll(tab.id)); }, REOPEN_WINDOW_MS);
  if (tab.url === "about:newtab" || tab.url === "about:home") serial(() => intoSpace(tab.id));
});
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url) return;
  if (isWeb(change.url) && requestsGuarded()) {
    // Its request was already looked at, and a redirect does not count. Unless Firefox never showed it (isolation.js).
    const wasFirst = firstPage.delete(tabId);
    newTabs.delete(tabId);
    if (notLookedAt(tabId, tab, wasFirst)) serial(() => moveShown(tabId, change.url, wasFirst));
    return;
  }
  if (isWeb(change.url) && firstPage.delete(tabId)) serial(() => byRule(tabId, change.url));
  else if (newTabs.has(tabId) && (isWeb(change.url) || change.url === "about:newtab" || change.url === "about:home")) serial(() => intoSpace(tabId));
}, { properties: ["url"] });
browser.tabs.onRemoved.addListener(tabId => { newTabs.delete(tabId); firstPage.delete(tabId); });

// --- Rules: an address always opens in a given space (Arc's Air Traffic Control) ---
// A rule is text to find in the address, or /a regular expression/. It is looked at
// for a tab's first page only (and, with the permission, when you type or choose an
// address: isolation.js): a sign-in passing through the address on its way back to
// the page you were on must not move your tab (with Sidebery's rules, which look at
// every address a tab loads, it did).
const rulesList = storedValue("rules", () => []); // [{ url, space }]
const firstPage = new Set(); // tabs that have not shown a web page yet

async function byRule(tabId, url) {
  const matching = (await rulesList.get()).filter(r => ruleMatches(r.url, url)); // rulematch.js
  const rule = matching.find(ruleCounts); // isolation.js
  // One whose space is gone counts for nothing, but a rule that quietly stopped working
  // should say which it is (safemoves.js). One with no space at all never worked.
  const gone = !rule && matching.find(r => r.space && r.space !== NO_CONTAINER);
  if (gone) await ruleFailed(gone);
  const tab = rule && await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId === rule.space || await exemptFromRules(tabId)) return intoSpace(tabId);
  const opened = await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: rule.space, url, active: tab.active, index: await indexWhenReopened(tab, rule.space) }).catch(err => ruleFailed(rule, err));
  if (!opened) return intoSpace(tabId); // closing it now would lose the link (safemoves.js)
  await browser.tabs.remove(tabId).catch(() => {});
}

// (The tab stays in newTabs until it is gone, so no view draws it meanwhile: reopensSoon.)
async function intoSpace(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId !== NO_CONTAINER) return;
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  // (A new window's first tab can come before the window is announced.)
  const space = activeSpace.get(tab.windowId) ?? activeSpace.get(focusedWindowId);
  if (!win || win.type !== "normal" || !space) return;
  const url = NEW_TAB_PAGES.has(tab.url) ? undefined : tab.url;
  if (url !== undefined && !isWeb(url)) return;
  await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: space, url, active: tab.active, index: await indexWhenReopened(tab, space) });
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
  for (const w of await normalWindows()) {
    const tabs = await browser.tabs.query({ windowId: w.id });
    const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
    const space = await spaceOf(w.id, tabs, await spaceList(used));
    await showSpace(w.id);
    const active = tabs.find(t => t.active);
    if (active && (active.cookieStoreId === space || active.cookieStoreId === NO_CONTAINER)) await setSuccessor(active);
  }
}
