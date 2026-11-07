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
  let stored = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
  if (!Array.isArray(stored)) stored = [];
  const spaces = await containerSpaces();
  if (!spaces.length) return; // Firefox did not say (containers turned off): that is no reason to show anything
  const named = spaces.filter(s => Array.isArray(declared) && declared.includes(s.name)).map(s => s.id);
  // A space declared by name that is renamed (here or by sync) stays hidden: until now only
  // its old name said so, and showing a workplace on the wrong machine is what this is for.
  // Seen here rather than in the event for it: a round that renames it reads this at once.
  const renamed = spaces.map(s => s.id).filter(id => hiddenSpacesDeclared.has(id) && !named.includes(id));
  if (renamed.length) {
    stored = [...new Set([...stored, ...renamed])];
    await browser.storage.local.set({ [HIDDEN_KEY]: stored });
  }
  const hidden = [...new Set([...named, ...spaces.filter(s => stored.includes(s.id)).map(s => s.id)])];
  // A window must have a space to show.
  if (hidden.length >= spaces.length) hidden.splice(hidden.indexOf(spaces[0].id), 1);
  // In one go, with nothing awaited: tab sync may ask at any moment.
  hiddenSpaceIds.clear();
  hiddenSpacesDeclared.clear();
  hidden.forEach(id => hiddenSpaceIds.add(id));
  named.forEach(id => { if (hiddenSpaceIds.has(id)) hiddenSpacesDeclared.add(id); });
}

// Read again, and do what follows from it: a space's name is what can declare it hidden, so a
// rename or a new container can hide one, and a removed container can show one (a window needs
// a space). In the queue, as all of it changes tabs.
async function rereadHiddenSpaces() {
  const before = new Set(hiddenSpaceIds);
  await readHiddenSpaces();
  await hiddenChanged(before);
}
const hiddenMayChange = () => { if (tidierAlone && started) serial(rereadHiddenSpaces); };
browser.contextualIdentities.onUpdated.addListener(hiddenMayChange);
browser.contextualIdentities.onCreated.addListener(hiddenMayChange);
// A container removed: Firefox closes its tabs and refuses new ones, and essentials.js drops its
// essentials. What the record has of it goes too, or a hidden space's folders and saved tabs, which
// have no tab to be closed, would be refused at every window filled, for ever. With sync on, the
// other machines still have them, and they come back with a container of that name (sync.js).
browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity: { cookieStoreId: id } }) => {
  if (!tidierAlone || !started) return;
  serial(async () => {
    const all = await getSynced();
    const left = Object.keys(all).filter(k => all[k].cookieStoreId === id);
    left.forEach(k => { delete all[k]; });
    if (left.length) saveSynced(all);
    await rereadHiddenSpaces();
  });
});

async function hiddenChanged(before) {
  const newly = new Set([...hiddenSpaceIds].filter(id => !before.has(id)));
  const back = new Set([...before].filter(id => !hiddenSpaceIds.has(id)));
  if (!newly.size && !back.size) return;
  if (newly.size) {
    await leaveHiddenSpaces(newly);
    const stayed = await closeHiddenTabs();
    if (stayed) globalThis.say?.(focusedWindowId, stayed > 1 ? `${stayed} tabs hold unsaved input and stayed open` : "One tab holds unsaved input and stayed open");
  }
  if (back.size) {
    // What is open of it and not in tab sync (opened from Firefox's own menu) now is a tab of its space.
    for (const t of await browser.tabs.query({})) if (back.has(t.cookieStoreId) && !syncKeyByTab.has(t.id)) await register(t.id).catch(noteError);
    // Filled first: reconcileAll then makes one of each tab's placeholders the live one, as after a closed window.
    for (const w of await normalWindows()) await fillWindow(w.id).catch(noteError);
    await reconcileAll();
  }
  for (const w of await normalWindows()) await showSpace(w.id); // what stayed is shown, wherever you are
  viewAllSoon();
}

// Whether a tab of this window's space, wherever you are. What is left open of a hidden
// space (a page with unsaved input, a tab you opened in that container from Firefox's own
// menu) is shown in every space, as a tab with no container is: it can always be reached,
// saved and closed, and a tab that cannot be seen is the one thing that must not happen.
const shownInSpace = (tab, space) => tab.cookieStoreId === space || tab.cookieStoreId === NO_CONTAINER || isHiddenSpace(tab.cookieStoreId);

// Close the tabs of hidden spaces, keeping their place in Tidier's record (a tab Tidier
// closes itself has lost its key by then, see tabsync.js, so nothing about it changes). A page
// is unloaded first, which one with unsaved input refuses without asking; that one stays,
// with its other windows' placeholders. Returns how many stayed.
//
// Only what can be brought back is closed: what the record knows, placeholders, and an empty new
// tab. A real page it does not know (opened from Firefox's own menu, or moments ago and not
// registered yet) would be gone without a trace, so it stays, shown wherever you are, as above.
async function closeHiddenTabs() {
  if (!hiddenSpaceIds.size) return 0;
  const tabs = (await browser.tabs.query({})).filter(t => isHiddenSpace(t.cookieStoreId));
  if (!tabs.length) return 0;
  const essentials = new Set((await getList()).map(e => e.key));
  const known = new Set();
  for (const t of tabs) if (isGhostUrl(t.url) || NEW_TAB_PAGES.has(t.url) || syncKeyByTab.has(t.id) || (t.pinned && essentials.has(await keyOf(t).catch(() => null)))) known.add(t.id);
  await keepHiddenOrder(tabs);
  const keepKeys = new Set();
  let stayed = 0;
  for (const t of tabs) {
    if (!known.has(t.id) || t.discarded || isGhostUrl(t.url) || NEW_TAB_PAGES.has(t.url)) continue;
    if (!t.active) await browser.tabs.discard(t.id).catch(() => {}); // (Firefox keeps the selected tab: that says nothing about input)
    if ((await browser.tabs.get(t.id).catch(() => null))?.discarded !== false) continue;
    if (!t.active) stayed++;
    const key = syncKeyByTab.get(t.id);
    if (key) keepKeys.add(key);
  }
  const closing = [], ghosts = new Set(), copies = new Set(), pages = new Set();
  for (const t of tabs) {
    if (!known.has(t.id)) continue;
    const now = await browser.tabs.get(t.id).catch(() => null);
    if (!now || (!now.discarded && !isGhostUrl(now.url) && !NEW_TAB_PAGES.has(now.url))) continue; // gone, or the one that stayed
    const key = syncKeyByTab.get(t.id);
    if (key && keepKeys.has(key)) continue;
    if (now.active) continue; // a selected tab cannot be left: its window has nothing to show yet
    if (key) { syncBusy.add(t.id); forget(t.id); ghosts.add(key); }
    if (t.pinned) { busy.add(t.id); const essential = await keyOf(t).catch(() => null); if (essential) copies.add(essential); }
    if (isWeb(now.url)) pages.add(now.url);
    closing.push(t.id);
  }
  // Told in the record, for when the space shows again in a way that is not the settings page
  // (the machine's declaration taken away while Firefox was closed): see reconcileAll.
  const all = await getSynced();
  for (const key of ghosts) if (all[key]) all[key].wasHidden = true;
  if (ghosts.size) saveSynced(all);
  if (closing.length) await browser.tabs.remove(closing).catch(noteError);
  // Hiding is not closing, and the record brings these back: ⌘⇧T stays with what you closed
  // yourself, and does not open a page of a space that is hidden here.
  for (const url of pages) toForget.set(url, Date.now() + FORGET_MS);
  if (ghosts.size) await forgetClosedPlaceholders("ghost", [...ghosts]);
  if (copies.size) await forgetClosedPlaceholders("essential", [...copies]);
  return stayed;
}

// The order of a space's tabs is its windows' order, written nowhere else, and a hidden space
// has no tabs. So it is kept in the order of the record, which is the order a window is filled
// in when it has none to copy (keysInReferenceOrder, tabsync.js). Without it, showing a space
// again would give its folders any order, and sync would then give it to every machine.
async function keepHiddenOrder(tabs) {
  const ref = referenceWindow(tabs, undefined);
  const inOrder = tabs.filter(t => t.windowId === ref && !t.pinned && syncKeyByTab.has(t.id)).sort((a, b) => a.index - b.index).map(t => syncKeyByTab.get(t.id));
  if (!inOrder.length) return;
  const all = await getSynced();
  for (const key of inOrder) {
    const entry = all[key];
    if (entry) { delete all[key]; all[key] = entry; }
  }
  saveSynced(all);
}

// Every window leaves a space that is now hidden (`spaces`: those it should leave). A window on a
// tab with no container (this settings page, say) keeps that tab: only what is shown around it
// changes. A page of a space hidden earlier that you have selected is left alone.
async function leaveHiddenSpaces(spaces = hiddenSpaceIds) {
  if (!spaces.size) return;
  for (const w of await normalWindows()) {
    const tabs = await browser.tabs.query({ windowId: w.id });
    const selected = tabs.find(t => t.active), space = activeSpace.get(w.id);
    if (!spaces.has(space) && !spaces.has(selected?.cookieStoreId)) continue;
    const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
    const next = isHiddenSpace(space) || !space ? (await spaceList(used))[0]?.id : space;
    if (!next) continue;
    const stays = selected?.cookieStoreId === NO_CONTAINER || (isHiddenSpace(selected?.cookieStoreId) && !spaces.has(selected.cookieStoreId));
    // (One window closing meanwhile must not leave the others in a space that is hidden.)
    await (stays ? setSpace(w.id, next) : switchSpace(w.id, next)).catch(noteError);
  }
}

// From the settings page. Hiding the last space that shows is not done: a window must
// have a space (the page does not offer it either, but two ticks can pass each other).
async function setSpaceHidden(id, hidden) {
  if (!tidierAlone) return;
  if (hidden && !(await containerSpaces()).some(s => s.id !== id && !isHiddenSpace(s.id))) return;
  const stored = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
  const list = (Array.isArray(stored) ? stored : []).filter(x => x !== id);
  if (hidden) list.push(id);
  await browser.storage.local.set({ [HIDDEN_KEY]: list });
  await rereadHiddenSpaces();
}
