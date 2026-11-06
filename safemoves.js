// Moves that cannot lose anything (Tidier alone).
//
// Firefox cannot change a tab's container, so a move to another space is a reopen:
// a new tab there, and the old one closed. Three things can then go wrong, and each
// would lose something you did not choose to lose: a rule sends the new tab straight
// back (spaces.js), the old tab held unsaved input, or the new tab cannot be opened
// at all. moveToSpace (ownfolders.js) and byRule (spaces.js) use what is here.

// --- A tab no rule may send away ------------------------------------------------
// Firefox creates a tab on about:blank and loads its address a moment later, so a
// tab opened with an address still counts as new, and its first page goes past the
// rules (firstPage, byRule). The events and the answer to tabs.create can come in any
// order. So: if the tab is still waiting for its first page, it stops waiting; if
// that page has already been seen, a byRule is queued, and the mark tells it to leave
// this tab alone. A byRule that runs while a tab is still being opened (openUnruled
// can be called outside the queue) waits for the answer first; the answer does not
// depend on the queue, so this cannot hang.
const unruled = new Set(); // tabs opened with openUnruled that a queued byRule must skip
let openings = Promise.resolve(); // settled once no openUnruled is under way

function openUnruled(props) {
  const opened = browser.tabs.create(props).then(tab => {
    if (!firstPage.delete(tab.id)) unruled.add(tab.id);
    return tab;
  });
  openings = Promise.allSettled([openings, opened]);
  return opened;
}
browser.tabs.onRemoved.addListener(tabId => unruled.delete(tabId));

// Rules are for new tabs. A tab that is already one of yours is not new when its first
// web page arrives: a placeholder that loads itself (you moved the tab here by hand,
// the window that had it loaded closed), or a tab brought back with ⌘⇧T, which Firefox
// returns with its Tidier values.
async function exemptFromRules(tabId) {
  await openings;
  return unruled.delete(tabId) || syncKeyByTab.has(tabId) || !!(await browser.sessions.getTabValue(tabId, SYNC_KEY).catch(() => undefined));
}

// A rule that could not open its space: closing the tab now would lose the link, so it
// stays, and you see which rule until the rules are changed in the settings. This is
// a container removed while Tidier was not looking, or a rule that came from elsewhere:
// one removed here takes its rules along (below).
function ruleFailed(rule) {
  setNotice("rule", `The rule for ${rule.url} points at a space that is gone, so the tab stayed here.`);
}

// --- Leaving a space without losing input -----------------------------------------
// Whether a tab can be closed without Firefox asking you anything. closesQuietly finds
// out by unloading it, which a page with unsaved input refuses without asking, but
// Firefox refuses to unload the selected tab whatever it holds. So you are first taken
// to the tab you used last in that space, which is where closing it would take you
// anyway, or to a new tab if it was the last one there, and you come back if the page
// refuses. Which tab is real is read from the record: a row can be a placeholder, its
// page loaded and selected in another window.
async function leavesQuietly(tab, key) {
  const liveId = key ? liveTabId(key) : tab.id;
  const live = liveId === undefined ? null : await browser.tabs.get(liveId).catch(() => null);
  if (!live?.active || live.discarded || isGhostUrl(live.url)) return closesQuietly(key, liveId);
  const last = await lastUsedIn(live.windowId, live.cookieStoreId, live.id);
  const step = last ?? await browser.tabs.create({ windowId: live.windowId, cookieStoreId: live.cookieStoreId, active: false });
  await browser.tabs.update(step.id, { active: true });
  if (await closesQuietly(key, liveId)) return true;
  await browser.tabs.update(live.id, { active: true });
  if (!last) await browser.tabs.remove(step.id).catch(() => {});
  return false;
}

// One line for all the tabs of one move, however they are sent: the selection's tabs
// arrive one by one.
const STAYED_GROUP_MS = 2000;
let stayed = 0, stayedTimer = null;
function sayStayed(windowId) {
  stayed++;
  clearTimeout(stayedTimer);
  stayedTimer = setTimeout(() => { stayed = 0; }, STAYED_GROUP_MS);
  globalThis.say?.(windowId, stayed === 1 ? "One tab holds unsaved input and stayed here" : `${stayed} tabs hold unsaved input and stayed here`);
}

// --- A container removed -----------------------------------------------------------
// A removed space leaves nothing behind: its rules would fail for every link they
// match, its folders would stay in the record, shown nowhere, and its saved tabs would
// be refused at every start (Firefox has no such container any more). Removing a space
// is the one thing besides your own hand that takes a folder away (ownfolders.js).
// With Sidebery the record and the rules are not Tidier's to change like this.
async function spaceRemoved(space) {
  const rules = await rulesList.get();
  const left = rules.filter(r => r.space !== space);
  if (left.length !== rules.length) { rulesList.set(left); setNotice("rule", null); }
  const all = await getSynced();
  for (const key of Object.keys(all).filter(k => all[k].cookieStoreId === space)) {
    if (isOwnFolder(all[key])) { delete all[key]; saveSynced(all); }
    else await closeEverywhere(key, { dismiss: false }).catch(() => {}); // Firefox may be closing these tabs itself right now
  }
}
browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) => {
  if (tidierAlone) serial(() => spaceRemoved(contextualIdentity.cookieStoreId));
});
