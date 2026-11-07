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
const declaredSpaces = () => browser.storage.managed.get("spaces").then(stored => stored.spaces, () => undefined);
async function spaceList(used) {
  const all = (await containerSpaces()).filter(s => !isHiddenSpace(s.id)); // hiddenspaces.js
  if (!tidierAlone) return all.filter(s => used.has(s.id));
  const declared = await declaredSpaces();
  const { spaceOrder } = await browser.storage.local.get("spaceOrder"); // from Sidebery's export (moveover.js)
  const first = Array.isArray(declared) ? declared : spaceOrder ?? (await getList()).map(e => e.cookieStoreId);
  const rank = new Map([...new Set(first)].map((id, i) => [id, i]));
  const listed = s => used.has(s.id) || (!bridgeRests(s.id) && (!Array.isArray(declared) || rank.has(s.id)));
  return all.filter(listed).sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

// The window's active space: the one it has, else the selected tab's (`tabs`: the
// window's, if you have them).
async function spaceOf(windowId, tabs, spaces) {
  let space = activeSpace.get(windowId) ?? await browser.sessions.getWindowValue(windowId, SPACE_KEY).catch(() => undefined);
  if (!spaces.some(s => s.id === space)) {
    const selected = tabs ? tabs.find(t => t.active) : (await browser.tabs.query({ windowId, active: true }).catch(() => []))[0];
    space = spaces.some(s => s.id === selected?.cookieStoreId) ? selected.cookieStoreId : spaces[0]?.id;
    // A space removed lands here first if a view comes before the queue gets to it
    // (spaceRemoved, safemoves.js), and then nothing else would show this space's tabs.
    showSpaceSoon(windowId);
  }
  // Asked for a window that has closed meanwhile, nothing would remove it from here again.
  if (activeSpace.get(windowId) !== space && await browser.windows.get(windowId).catch(() => null)) activeSpace.set(windowId, space);
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
  // Only tabs that may have to change, as this runs for every burst of new tabs: the hidden
  // ones that may show here (usually none), and those shown (not the other spaces' hidden ones).
  const tabs = (await Promise.all([
    browser.tabs.query({ windowId, pinned: false, hidden: true, cookieStoreId: [space, NO_CONTAINER, ...hiddenSpaceIds] }),
    browser.tabs.query({ windowId, pinned: false, hidden: false }),
  ]).catch(() => [])).flat();
  const all = await getSynced();
  const visible = t => shownInSpace(t, space) && !restsInFolder(all, syncKeyByTab.get(t.id)); // hiddenspaces.js, foldrest.js
  const show = tabs.filter(t => t.hidden && visible(t)).map(t => t.id);
  const hide = tabs.filter(t => !t.hidden && !visible(t) && !t.active).map(t => t.id);
  if (show.length) await browser.tabs.show(show).catch(() => {});
  // Without the permission (asked for in the sidebar) tabs.hide is not there.
  if (hide.length) await browser.tabs.hide?.(hide).catch(() => {});
}

// The tab to go back to in a space: the one used last, an essential counts. A placeholder
// only if there is nothing else: its lastAccessed is when it was made, not when you used
// it, so a tab opened in another window meanwhile would count as the one used last here,
// and going back to the space would pull it out of the window you opened it in.
async function lastUsedIn(windowId, space, ...except) {
  const tabs = await browser.tabs.query({ windowId, cookieStoreId: space }).catch(() => []);
  return tabs.filter(t => !except.includes(t.id))
    .sort((a, b) => isGhostUrl(a.url) - isGhostUrl(b.url) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
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
  if (!await browser.windows.get(windowId).catch(() => null)) return; // closed meanwhile
  activeSpace.set(windowId, space); // before the tab is selected, so onActivated agrees
  // And written here, since setSpace below now sees no change: this is what a restart reads.
  await browser.sessions.setWindowValue(windowId, SPACE_KEY, space).catch(() => {});
  if (last) await browser.tabs.update(last.id, { active: true }).catch(() => {});
  else if (tidierAlone) await createTab({ windowId, cookieStoreId: space }).catch(ifGone); // common.js
  if (activeSpace.has(windowId)) await setSpace(windowId, space); // else closed meanwhile
}

// The n-th space on the bar (⌃1, ⌃2, ...).
async function switchToNth(windowId, n) {
  const tabs = await browser.tabs.query({ windowId });
  const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
  const space = (await spaceList(used))[n];
  if (space) await switchSpace(windowId, space.id);
}

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
    // (A tab that has moved to another window since does not decide this window's space.)
    if (!tab?.active || tab.windowId !== windowId) { viewSoon(windowId); return; }
    if (tab.cookieStoreId === NO_CONTAINER) { await setSuccessor(tab); viewSoon(windowId); return; }
    if (littleHolds(tab)) { viewSoon(windowId); return; } // littlewindow.js
    if (isHiddenSpace(tab.cookieStoreId)) { viewSoon(windowId); return; } // what is left open of a hidden space is shown in every space (hiddenspaces.js)
    if (tidierAlone && stay && stay !== tab.cookieStoreId) {
      const next = await nextAfterClosing(windowId, stay);
      if (next) { await browser.tabs.update(next.id, { active: true }).catch(() => {}); return; }
      // Refused when the space has just been removed (safemoves.js): then this tab's space it is.
      if (await createTab({ windowId, cookieStoreId: stay }).catch(() => null)) return;
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
  if (isWeb(change.url) && littleTakes(tabId, change.url)) return; // littlewindow.js
  if (isWeb(change.url) && requestsGuarded()) {
    // Its request was already looked at, and a redirect does not count. Unless Firefox never showed it (isolation.js).
    const wasFirst = firstPage.delete(tabId);
    if (notLookedAt(tabId, tab, wasFirst)) serial(() => moveShown(tabId, change.url, wasFirst));
    else newTabs.delete(tabId);
    if (wasFirst) serial(() => sayIfRuleGone(change.url, tab.windowId));
    return;
  }
  if (isWeb(change.url) && firstPage.delete(tabId)) serial(() => byRule(tabId, change.url));
  else if (newTabs.has(tabId) && (isWeb(change.url) || change.url === "about:newtab" || change.url === "about:home")) serial(() => intoSpace(tabId));
}, { properties: ["url"] });
browser.tabs.onRemoved.addListener(tabId => { newTabs.delete(tabId); firstPage.delete(tabId); });

// A tab opened while Tidier was starting, seen only now (seeUnseenTabs, tabsync.js). A
// link that started Firefox has no container, and would stay in none. Returns whether it
// is being opened again, which then gets seen as a new tab.
function seenLateInSpace(tab) {
  if (!tidierAlone || tab.pinned || tab.incognito) return false;
  if (!isWeb(tab.url)) { if (!isGhostUrl(tab.url)) firstPage.add(tab.id); return false; }
  if (tab.cookieStoreId !== NO_CONTAINER) return false;
  // A loaded page is moved by moveStragglers (isolation.js), which keeps what the record
  // knows of it, and a known one is stopped when it loads: reopened here as well, it would
  // become another tab.
  if (!tab.discarded || syncKeyByTab.has(tab.id)) return false;
  // (With no space to go to it stays where it is, and is a tab like any other.)
  serial(async () => { await byRule(tab.id, tab.url); registerSoon(tab.id); });
  return true;
}

// --- Rules: an address always opens in a given space (Arc's Air Traffic Control) ---
// A rule is text to find in the address, or /a regular expression/. It is looked at
// for a tab's first page only (and, with the permission, when you type or choose an
// address: isolation.js): a sign-in passing through the address on its way back to
// the page you were on must not move your tab (with Sidebery's rules, which look at
// every address a tab loads, it did).
const rulesList = storedValue("rules", () => []); // [{ url, space }]
const firstPage = new Set(); // tabs that have not shown a web page yet

// A rule whose space is gone counts for nothing (ruleCounts, isolation.js), but a rule that
// quietly stopped working should say which it is (ruleFailed, safemoves.js). One with no
// space at all never worked. For a first page, whichever way it was looked at.
async function sayIfRuleGone(url, windowId) {
  const matching = (await rulesList.get()).filter(r => ruleMatches(r.url, url));
  if (matching.some(ruleCounts)) return;
  // A hidden space gets no tabs: the page stays in the space you are in, and you are told why.
  const hidden = matching.find(r => isHiddenSpace(r.space));
  if (hidden) {
    if (windowId !== undefined) say(windowId, `Opened here: ${(await containerSpaces()).find(s => s.id === hidden.space)?.name ?? "its space"} is hidden on this machine`);
    return;
  }
  const gone = matching.find(r => r.space && r.space !== NO_CONTAINER);
  if (gone) await ruleFailed(gone);
}

async function byRule(tabId, url) {
  const rule = (await rulesList.get()).find(r => ruleCounts(r) && ruleMatches(r.url, url)); // rulematch.js, isolation.js
  if (!rule) await sayIfRuleGone(url, (await browser.tabs.get(tabId).catch(() => null))?.windowId);
  const tab = rule && await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.cookieStoreId === rule.space || await exemptFromRules(tabId) || bridgeKeeps(tab)) return intoSpace(tabId); // bridge.js: an agent's tab stays in its space
  const opened = await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: rule.space, url, active: tab.active, index: await indexWhenReopened(tab, rule.space) }).catch(err => ruleFailed(rule, err));
  if (!opened) return intoSpace(tabId); // closing it now would lose the link (safemoves.js)
  await browser.tabs.remove(tabId).catch(() => {});
  await forgetClosedPages([url]); // the same as in intoSpace, below
}

// (The tab stays in newTabs until it is gone, so no view draws it meanwhile: reopensSoon.)
async function intoSpace(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.pinned || tab.cookieStoreId !== NO_CONTAINER) return; // (pinned meanwhile: an essential now)
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  // (A new window's first tab can come before the window is announced.)
  const space = activeSpace.get(tab.windowId) ?? activeSpace.get(focusedWindowId);
  if (!win || win.type !== "normal" || !space) return;
  const url = NEW_TAB_PAGES.has(tab.url) ? undefined : tab.url;
  if (url !== undefined && !isWeb(url)) return;
  await createTab({ windowId: tab.windowId, cookieStoreId: space, url, active: tab.active, index: await indexWhenReopened(tab, space) }).catch(ifGone);
  await browser.tabs.remove(tab.id).catch(() => {});
  // The page is open in its space: in Recently Closed it would come back by ⌘⇧T, a second
  // time, instead of the tab you closed.
  if (url) await forgetClosedPages([url]);
}

// --- When Tidier starts ------------------------------------------------------
// The permission to hide tabs was given in the sidebar.
browser.permissions.onAdded.addListener(() => { if (started) serial(startSpaces); });

// Each window's active space, shown again: Firefox shows every hidden tab again
// when an add-on with this permission as an optional one is updated.
async function startSpaces() {
  if (!tidierAlone) return takeKeysBackIfGiven(); // keys-commands.js
  await giveKeys().catch(noteError); // here and not in the manifest, so that they are not taken from Sidebery while it is in use; keys must not stop the rest
  await startLittleWindow(); // littlewindow.js
  for (const w of await normalWindows()) await startSpaceIn(w.id);
  await leaveHiddenSpaces(); // a window restored on a tab of a space that is hidden now
  await closeHiddenTabs(); // hiddenspaces.js: restored with the session
}
async function startSpaceIn(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
  const spaces = await spaceList(used);
  const space = await spaceOf(windowId, tabs, spaces);
  await showSpace(windowId);
  const active = tabs.find(t => t.active);
  if (active && (active.cookieStoreId === space || active.cookieStoreId === NO_CONTAINER)) await setSuccessor(active);
  // The selected tab decides. What the window remembers can be behind (a job cut off by an
  // update or a crash), and it would show you a list without the tab you are looking at.
  else if (active && spaces.some(s => s.id === active.cookieStoreId)) {
    await setSpace(windowId, active.cookieStoreId);
    await setSuccessor(active);
  }
}
// A window that opens with no other window to take its space from (reopened after the
// last one closed), or whose first tab has no container, still has one: without it the
// tabs of every space stay shown, and a new tab opens in no space, until a sidebar asks.
// After the tabs it gets (tabsync.js adds its job first).
browser.windows.onCreated.addListener(win => {
  if (!tidierAlone || !started || win.type !== "normal" || win.incognito) return;
  setTimeout(() => serial(() => startSpaceIn(win.id)), NEW_WINDOW_DELAY_MS);
});
