// One quiet line in the sidebar, and what makes it worth having (Tidier alone): undo
// after closing several tabs or deleting a folder, instead of asking first, and Clear,
// which closes today's tabs of a space in one go.
//
// say() is the only way to the line: one note per window, shown for NOTE_MS or until
// the next say, with at most one action. It is not the lasting notice (setNotice,
// common.js), and nothing is kept of it afterwards. Its timer starts only from
// something you did, so with nothing happening there is no work here.
//
// What undo needs is kept in memory, by the note that offers it, and goes with it.
// Firefox's own Recently Closed cannot be what decides what comes back: it says nothing
// of a tab's container, it is per window, and it has no entry for a tab that was never
// loaded, while every placeholder Tidier closes is forgotten from it on purpose
// (forgetClosedPlaceholders, common.js).

const NOTE_MS = 10000;
const CLOSE_GROUP_MS = 300; // closes this close together are one thing you did
const quietNotes = new Map(); // windowId -> { id, text, undo, timer }
const closeGroups = new Map(); // windowId -> the closes being taken together
let noteCount = 0;
let bringingBack = 0; // undos in progress, see the rules below

// `undo` is run in the queue when you click it: it must not wait for serial() itself,
// which would wait for it in turn.
function say(windowId, text, { undo } = {}) {
  if (!tidierAlone) return;
  clearTimeout(quietNotes.get(windowId)?.timer);
  quietNotes.set(windowId, { id: ++noteCount, text, undo, timer: setTimeout(() => dropNote(windowId), NOTE_MS) });
  viewSoon(windowId);
}

function dropNote(windowId) {
  clearTimeout(quietNotes.get(windowId)?.timer);
  if (quietNotes.delete(windowId)) viewSoon(windowId);
}
browser.windows.onRemoved.addListener(windowId => {
  clearTimeout(quietNotes.get(windowId)?.timer);
  quietNotes.delete(windowId);
});

// The part of a note a sidebar sees (viewFor, sidebar-view.js).
function noteFor(windowId) {
  const note = quietNotes.get(windowId);
  return note ? { id: note.id, text: note.text, undo: !!note.undo } : null;
}

// You clicked Undo. A click that comes just after the note went finds nothing to do.
async function undoNote(windowId, id) {
  const note = quietNotes.get(windowId);
  if (note?.id !== id) return;
  dropNote(windowId);
  await note.undo?.();
}

// --- Remembering a tab ----------------------------------------------------------
// A window's tabs as they are now, in order, keys included: closed tabs have lost theirs
// by the time you click Undo. The order is what puts them back.
async function tabsNow(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  return tabs.filter(t => !t.pinned).sort((a, b) => a.index - b.index).map(t => ({
    id: t.id, key: syncKeyByTab.get(t.id), space: t.cookieStoreId, unloaded: t.discarded || isGhostUrl(t.url),
  }));
}

// A row is not its tab: the page, if there is one, is on the live tab, maybe in another
// window, whichever copy was closed.
async function rememberTab(key, entry) {
  const liveId = liveTabId(key);
  const live = liveId === undefined ? null : await browser.tabs.get(liveId).catch(() => null);
  const page = isWeb(live?.url);
  return { key, entry: { ...entry }, page, url: page ? live.url : entry.url };
}

// --- Closes in the sidebar ------------------------------------------------------
// Each tab of a selection is closed by a message of its own, so what belongs together is
// seen from the time alone. The order is read once, at the first close, before any of
// them is gone, or the second tab's place would no longer count the first.
function closeGroup(windowId) {
  let group = closeGroups.get(windowId);
  if (!group) {
    group = { windowId, tabs: tabsNow(windowId), items: [], removals: [], timer: null };
    closeGroups.set(windowId, group);
  }
  clearTimeout(group.timer);
  group.timer = setTimeout(() => endCloseGroup(group), CLOSE_GROUP_MS);
  return group;
}

// A loaded saved tab only unloads and an essential comes back unloaded, so neither is
// gone and neither is remembered. This is closeAction's own answer (common.js).
async function rememberClose(group, tabId) {
  const key = syncKeyByTab.get(tabId), role = syncRoleByTab.get(tabId);
  const [tabs, all] = await Promise.all([group.tabs, getSynced()]);
  const tab = tabs.find(t => t.id === tabId), entry = all[key];
  if (!tab || !entry || entry.group) return;
  const action = closeAction({ role, inFolder: storedInFolder(all, key), liveFolder: !!entry.liveFolder, folderHere: true, unloaded: tab.unloaded });
  if (action === "close") group.items.push({ ...await rememberTab(key, entry), tabId });
}

async function closeFromSidebar(windowId, tabId) {
  if (!tidierAlone) { await browser.tabs.remove(tabId).catch(() => {}); return; }
  const group = closeGroup(windowId);
  const removed = rememberClose(group, tabId).catch(noteError).then(() => browser.tabs.remove(tabId)).catch(() => {});
  group.removals.push(removed);
  await removed;
}

// One ordinary tab says nothing: ⌘⇧T has it. A saved tab removed for good has no such
// way back, since its placeholder is forgotten from Recently Closed. A page that asked
// and that you kept was not closed, which only shows once Firefox has its answer.
function endCloseGroup(group) {
  closeGroups.delete(group.windowId);
  Promise.all(group.removals).then(async () => {
    const gone = [];
    for (const item of group.items) if (!(await browser.tabs.get(item.tabId).catch(() => null))) gone.push(item);
    const tabs = await group.tabs;
    const undo = () => bringBack(group.windowId, gone, tabs);
    if (gone.length > 1) say(group.windowId, `${gone.length} tabs closed`, { undo });
    else if (gone[0]?.entry.saved) say(group.windowId, "Tab removed", { undo });
  }).catch(noteError);
}

// --- Clear ----------------------------------------------------------------------
// Today's tabs of a space, as drawn in this window: not the folders, not the essentials,
// and not a tab selected in any window, so nothing jumps and nothing else loads. A page
// with unsaved input stays, without asking (closesQuietly, tabsync.js). A new tab page
// has nothing to lose, and goes. Any other page without a record, such as Firefox's own
// settings, could not come back with Undo, and stays.
async function clearSpace(windowId, space) {
  const all = await getSynced();
  const everywhere = await browser.tabs.query({});
  const selected = new Set(everywhere.filter(t => t.active).map(t => syncKeyByTab.get(t.id)));
  const tabs = await tabsNow(windowId);
  const drawn = everywhere.filter(t => t.windowId === windowId && !t.pinned && (t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER));
  const items = [];
  let stayed = 0;
  for (const t of drawn) {
    if (t.active) continue;
    const key = syncKeyByTab.get(t.id), entry = all[key];
    if (!entry) {
      if (NEW_TAB_PAGES.has(t.url)) await browser.tabs.remove(t.id).catch(() => {});
      continue;
    }
    if (entry.group || storedInFolder(all, key) || selected.has(key)) continue;
    const item = await rememberTab(key, entry); // first: closesQuietly unloads the page
    if (!(await closesQuietly(key))) { stayed++; continue; }
    await closeEverywhere(key, { dismiss: false }).catch(noteError);
    items.push(item);
  }
  const closed = items.length === 1 ? "1 tab" : `${items.length} tabs`;
  if (items.length) say(windowId, `${closed} closed${stayed ? `, ${stayed} stayed` : ""}`, { undo: () => bringBack(windowId, items, tabs) });
  else if (stayed) say(windowId, `${stayed === 1 ? "1 tab" : `${stayed} tabs`} with unsaved input stayed`);
}

// --- Undo ------------------------------------------------------------------------
// A tab brought back is not a new tab: no rule may send it to another space, nor may it
// be opened again in the active one (spaces.js). This listener comes after theirs
// (manifest.json), and before any address of the tab is known.
browser.tabs.onCreated.addListener(tab => {
  if (bringingBack) { firstPage.delete(tab.id); newTabs.delete(tab.id); }
});

// Each tab back under its own key: first the record, which everything else reads, then
// the pages, then a placeholder wherever there is none, then each in its place, from
// the last to the first, so that the tab each goes before is already there. (A place is
// among the tabs with a record, the only ones every window has.)
async function bringBack(windowId, items, tabs) {
  const all = await getSynced();
  const back = items.filter(i => !all[i.key]);
  for (const { key, entry } of back) {
    all[key] = { ...entry };
    if (entry.parentKey && !all[entry.parentKey]) { all[key].parentKey = null; delete all[key].saved; }
    if (entry.liveFolder) await forgetDismissed(entry);
  }
  saveSynced(all);
  bringingBack++;
  try {
    await reopenPages(back);
    for (const w of await normalWindows()) {
      const reps = repMap(await browser.tabs.query({ windowId: w.id }));
      for (const { key } of back) if (!reps.has(key)) await createRep(w.id, key, all[key]).catch(noteError);
    }
    const here = repMap(await browser.tabs.query({ windowId }));
    const wanted = new Set(back.map(i => i.key));
    for (let n = tabs.length - 1; n >= 0; n--) {
      if (!wanted.has(tabs[n].key) || !here.has(tabs[n].key)) continue;
      const next = tabs.slice(n + 1).find(t => t.space === tabs[n].space && here.has(t.key));
      await moveTab(windowId, here.get(tabs[n].key), next ? here.get(next.key) : null);
    }
  } finally { bringingBack--; }
}

// Pages come back from Recently Closed, which keeps their history. Firefox selects each
// one it reopens and starts loading it, whatever is asked, so the tab you were on is
// selected again and they are unloaded: you asked for your tabs back, not for all those
// pages. What such a page says in that moment must not rewrite its title in the record,
// so tab sync looks away for a while. An address open in another container is not this
// tab (Recently Closed cannot tell, and logins must not mix), so it goes again, and a
// placeholder takes its place.
async function reopenPages(back) {
  const pages = back.filter(i => i.page);
  if (!pages.length) return;
  const closed = (await browser.sessions.getRecentlyClosed().catch(() => [])).map(c => c.tab).filter(Boolean);
  const selected = new Map(); // windowId -> the tab selected there before
  const opened = [];
  for (const { key, url, entry } of pages) {
    const at = closed.findIndex(t => t.url === url);
    if (at < 0) continue;
    const [{ sessionId, windowId }] = closed.splice(at, 1);
    if (!selected.has(windowId)) selected.set(windowId, (await browser.tabs.query({ windowId, active: true }).catch(() => []))[0]?.id);
    const tab = (await browser.sessions.restore(sessionId).catch(() => null))?.tab;
    if (!tab) continue;
    if (tab.cookieStoreId !== entry.cookieStoreId) { await browser.tabs.remove(tab.id).catch(() => {}); continue; }
    syncBusy.add(tab.id);
    setTimeout(() => syncBusy.delete(tab.id), SETTLE_MS);
    await setRole(tab.id, key, "live");
    opened.push(tab.id);
  }
  for (const id of selected.values()) if (id !== undefined) await browser.tabs.update(id, { active: true }).catch(() => {});
  for (const id of opened) await browser.tabs.discard(id).catch(() => {});
}

// A pull request tab you closed stays closed until it leaves the search, unless you
// take that back (livefolders.js).
async function forgetDismissed(entry) {
  const state = await folderState(entry.liveFolder);
  state.dismissed = state.dismissed.filter(url => url !== entry.liveUrl);
  await saveFolderState();
}

// What deleting a folder changes, as a way to change it back (deleteFolder, ownfolders.js).
// A live folder's tabs go with it, and come back with it. Each other tab has only left
// the folder and is where it was, so it needs its folder, its `saved` address and its
// age back, and nothing else.
async function rememberFolder(all, key, windowId) {
  const folder = { ...all[key] };
  const inside = Object.keys(all).filter(k => all[k].parentKey === key);
  const stay = inside.filter(k => !all[k].liveFolder).map(k => ({ key: k, added: all[k].added, saved: all[k].saved }));
  const items = await Promise.all(inside.filter(k => all[k].liveFolder).map(k => rememberTab(k, all[k])));
  const tabs = await tabsNow(windowId);
  return async () => {
    const now = await getSynced();
    now[key] = folder;
    for (const t of stay) {
      if (!now[t.key]) continue;
      now[t.key].parentKey = key;
      now[t.key].added = t.added;
      if (t.saved) now[t.key].saved = t.saved;
    }
    noteSaved(now, stay.map(t => t.key));
    saveSynced(now);
    if (items.length) await bringBack(windowId, items, tabs);
  };
}
