// A space hidden on this machine, for example a workplace's space that should show only
// on that workplace's Mac (Tidier alone). It is hiding only: nothing is deleted, and its
// essentials, folders and tabs stay in Tidier's record, so they still sync and come back
// when it is shown again. While hidden, it is not on the bar and gets no tab in any window
// here, ⌃1/⌃2/⌃3 skip it, and nothing opens in it.
//
// Which spaces are hidden is this machine's own and never syncs: hiddenSpaces in the
// extension's storage holds container ids (settings page), and hiddenSpaces in managed
// storage holds names, since ids differ per profile and a file written for a machine can
// only know the name. The whole set is in memory, so tab sync can ask without waiting.

const hiddenSpaceIds = new Set();
const hiddenSpacesDeclared = new Set(); // those of them declared for this machine, which only that file can change
const isHiddenSpace = id => hiddenSpaceIds.has(id);
const HIDDEN_KEY = "hiddenSpaces";

async function readHiddenSpaces() {
  if (!tidierAlone) return;
  const declared = (await browser.storage.managed.get(HIDDEN_KEY).catch(() => ({})))[HIDDEN_KEY];
  const stored = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
  const spaces = await containerSpaces();
  const named = spaces.filter(s => Array.isArray(declared) && declared.includes(s.name)).map(s => s.id);
  const hidden = [...new Set([...named, ...spaces.filter(s => Array.isArray(stored) && stored.includes(s.id)).map(s => s.id)])];
  // A window must have a space to show.
  if (spaces.length && hidden.length >= spaces.length) hidden.splice(hidden.indexOf(spaces[0].id), 1);
  // In one go, with nothing awaited: tab sync may ask at any moment.
  hiddenSpaceIds.clear();
  hiddenSpacesDeclared.clear();
  hidden.forEach(id => hiddenSpaceIds.add(id));
  named.forEach(id => { if (hiddenSpaceIds.has(id)) hiddenSpacesDeclared.add(id); });
}

// A space declared by name that is renamed (here or by sync) stays hidden: until now only
// its old name said so, and showing a workplace on the wrong machine is what this is for.
browser.contextualIdentities.onUpdated.addListener(({ contextualIdentity: { cookieStoreId: id } }) => {
  if (!hiddenSpacesDeclared.has(id)) { readHiddenSpaces().catch(noteError); return; }
  serial(async () => {
    const stored = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
    await browser.storage.local.set({ [HIDDEN_KEY]: [...new Set([...(Array.isArray(stored) ? stored : []), id])] });
    await readHiddenSpaces();
  });
});
// A space that has just come here, by sync, may be one declared as hidden.
browser.contextualIdentities.onCreated.addListener(() => { readHiddenSpaces().catch(noteError); });
browser.contextualIdentities.onRemoved.addListener(() => { readHiddenSpaces().catch(noteError); });

// Whether a tab of this window's space, wherever you are. What is left open of a hidden
// space (a page with unsaved input, a tab you opened in that container from Firefox's own
// menu) is shown in every space, as a tab with no container is: it can always be reached,
// saved and closed, and a tab that cannot be seen is the one thing that must not happen.
const shownInSpace = (tab, space) => tab.cookieStoreId === space || tab.cookieStoreId === NO_CONTAINER || isHiddenSpace(tab.cookieStoreId);

// Close the tabs of hidden spaces, keeping their place in Tidier's record (a tab Tidier
// closes itself has lost its key by then, see tabsync.js, so nothing about it changes). A page
// is unloaded first, which one with unsaved input refuses without asking; that one stays,
// with its other windows' placeholders. Returns how many stayed.
async function closeHiddenTabs() {
  if (!hiddenSpaceIds.size) return 0;
  const tabs = (await browser.tabs.query({})).filter(t => isHiddenSpace(t.cookieStoreId));
  const keepKeys = new Set();
  let stayed = 0;
  for (const t of tabs) {
    if (t.discarded || isGhostUrl(t.url)) continue;
    await browser.tabs.discard(t.id).catch(() => {});
    if ((await browser.tabs.get(t.id).catch(() => null))?.discarded !== false) continue;
    stayed++;
    const key = syncKeyByTab.get(t.id);
    if (key) keepKeys.add(key);
  }
  const closing = [], ghosts = new Set(), copies = new Set();
  for (const t of tabs) {
    const now = await browser.tabs.get(t.id).catch(() => null);
    if (!now || (!now.discarded && !isGhostUrl(now.url))) continue; // gone, or the one that stayed
    const key = syncKeyByTab.get(t.id);
    if (key && keepKeys.has(key)) continue;
    if (now.active) continue; // a selected tab cannot be left: its window has nothing to show yet
    if (key) { syncBusy.add(t.id); forget(t.id); ghosts.add(key); }
    if (t.pinned) { busy.add(t.id); const essential = await keyOf(t).catch(() => null); if (essential) copies.add(essential); }
    closing.push(t.id);
  }
  if (closing.length) await browser.tabs.remove(closing).catch(noteError);
  if (ghosts.size) await forgetClosedPlaceholders("ghost", [...ghosts]);
  if (copies.size) await forgetClosedPlaceholders("essential", [...copies]);
  return stayed;
}

// Every window leaves a space that is now hidden. A window on a tab with no container (this
// settings page, say) keeps that tab: only what is shown around it changes.
async function leaveHiddenSpaces() {
  if (!hiddenSpaceIds.size) return;
  for (const w of await normalWindows()) {
    const tabs = await browser.tabs.query({ windowId: w.id });
    const selected = tabs.find(t => t.active), space = activeSpace.get(w.id);
    if (!isHiddenSpace(space) && !isHiddenSpace(selected?.cookieStoreId)) continue;
    const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
    const next = isHiddenSpace(space) || !space ? (await spaceList(used))[0]?.id : space;
    if (!next) continue;
    if (selected?.cookieStoreId === NO_CONTAINER) await setSpace(w.id, next);
    else await switchSpace(w.id, next);
  }
}

// From the settings page. Hiding the last space that shows is not done: a window must
// have a space (the page does not offer it either).
async function setSpaceHidden(id, hidden) {
  if (!tidierAlone) return;
  const stored = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
  const list = (Array.isArray(stored) ? stored : []).filter(x => x !== id);
  if (hidden) list.push(id);
  await browser.storage.local.set({ [HIDDEN_KEY]: list });
  await readHiddenSpaces();
  if (isHiddenSpace(id)) {
    await leaveHiddenSpaces();
    const stayed = await closeHiddenTabs();
    for (const w of await normalWindows()) await showSpace(w.id); // what stayed is shown, wherever you are
    if (stayed) globalThis.say?.(focusedWindowId, stayed > 1 ? `${stayed} tabs hold unsaved input and stayed open` : "One tab holds unsaved input and stayed open");
  } else {
    // Filled first: reconcileAll counts an ordinary tab with no tab left as closed. Then it
    // makes one of each tab's placeholders the live one, as after a closed window.
    for (const w of await normalWindows()) await fillWindow(w.id).catch(noteError);
    await reconcileAll();
    for (const w of await normalWindows()) await showSpace(w.id);
  }
  viewAllSoon();
}
