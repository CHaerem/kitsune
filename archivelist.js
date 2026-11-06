// Find archived tabs again, as in Arc (Tidier alone). Every tab archiving closes, and
// every ordinary tab you close, goes in a list of its space: newest first, at most
// ARCHIVED_PER_SPACE per space and none older than ARCHIVED_KEEP_MS.
//
// Firefox's Recently Closed cannot be that list: it knows no container, it is kept per
// window, and it has nothing for a placeholder (a tab whose real page was in a window
// you closed, see keepReason in archive.js). So this list decides the space, and holds
// the address from the tab record, not the placeholder's own.
//
// It works only when something closes: then it is written, and old entries go. With
// nothing happening it does nothing, and the view (sidebar/archived.js) reads from memory.
//
// A tab moved to another space, a live folder's pull request and a saved tab that only
// unloads are not closed for good, so they never come here: only the two callers of
// noteArchived decide what does (archiveIdleTabs, and onSyncedClosed in tabsync.js).

const ARCHIVED_PER_SPACE = 200, ARCHIVED_KEEP_MS = 30 * 24 * 3600e3;
// An icon can be a whole picture written out as a data: address, and all of this is
// written as one value at every close. A big one is left out: the row then shows
// the first letter of the title, and the page brings its icon back when it is reopened.
const ARCHIVED_ICON_MAX = 4096;

const archivedList = storedValue("archivedTabs", () => ({})); // { [container]: [{ url, title, icon, when, why }] }, newest first
// One load for everyone: the view reads this outside the queue, and two first reads at
// once would each make an object of their own, and a change to the first would be lost.
let archivedLoading = null;
const archivedNow = () => (archivedLoading ??= archivedList.get().catch(err => { archivedLoading = null; throw err; }));
const saveArchived = list => { archivedList.set(list); viewAllSoon(); }; // an open view looks again when a view arrives

// `entry` is the tab's record, `why` "archived" or "closed". A later close of the same
// address in the same space replaces the earlier one: it is the same way back. A list
// that cannot be read is no reason not to close your tab, so this never fails the close.
async function noteArchived(entry, why) {
  if (!tidierAlone || !entry || entry.group || entry.liveFolder || !isWeb(entry.url)) return;
  const list = await archivedNow().catch(noteError), now = Date.now();
  if (!list) return;
  const icon = entry.icon?.length <= ARCHIVED_ICON_MAX ? entry.icon : null;
  list[entry.cookieStoreId] = [
    { url: entry.url, title: entry.title || entry.url, icon, when: now, why },
    ...(list[entry.cookieStoreId] || []).filter(r => r.url !== entry.url),
  ];
  for (const [space, rows] of Object.entries(list)) {
    list[space] = rows.filter(r => now - r.when < ARCHIVED_KEEP_MS).slice(0, ARCHIVED_PER_SPACE);
    if (!list[space].length) delete list[space];
  }
  saveArchived(list);
}

// What the list holds, newest first, as { url, title, icon, when, why, space }: one
// space's (a tab without a container belongs to whichever space you are in, as in the
// sidebar), or every space's with no `space` (the command bar). Old entries are left out
// here too, since they are only removed at the next close.
async function archivedTabs(space) {
  if (!tidierAlone) return [];
  const list = await archivedNow(), now = Date.now();
  return [...new Set(space ? [space, NO_CONTAINER] : Object.keys(list))]
    .flatMap(s => (list[s] || []).filter(r => now - r.when < ARCHIVED_KEEP_MS).map(r => ({ ...r, space: s })))
    .sort((a, b) => b.when - a.when);
}

async function dropArchived(space, url) {
  const list = await archivedNow(), rows = list[space] || [];
  const at = rows.findIndex(r => r.url === url);
  if (at < 0) return;
  rows.splice(at, 1);
  if (!rows.length) delete list[space];
  saveArchived(list);
}

// Open it again in its own space (`item`: { space, url }, as archivedTabs gives them), at
// the place new tabs go, and select it. In the window asked for, else the ordinary window
// you used last. Never call this from inside the queue: it waits its turn there.
//
// The tab is created unloaded and then selected. Created that way it has its address
// and title from the start, so the row and the other windows' placeholders show them
// at once, even if the page never loads. It also never is a blank tab that gets an
// address, which is what sends a tab through the rules (firstPage, spaces.js), so a
// rule cannot send it away from the space it is coming back to. Its row goes only
// once the tab is there: a tab Firefox refuses stays in the list.
function reopenArchived(item, windowId) {
  return serial(async () => {
    const row = (await archivedNow())[item.space]?.find(r => r.url === item.url);
    const windows = await normalWindows(), last = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    const win = windows.find(w => w.id === windowId) ?? windows.find(w => w.id === last?.id) ?? windows[0];
    if (!tidierAlone || !row || !win) return false;
    const space = item.space === NO_CONTAINER ? activeSpace.get(win.id) ?? item.space : item.space;
    const index = await globalThis.topOfToday?.(win.id, space);
    const props = { windowId: win.id, cookieStoreId: space, url: row.url, title: row.title, discarded: true, ...(index === undefined ? {} : { index }) };
    let tab;
    try {
      tab = await (globalThis.openUnruled?.(props) ?? browser.tabs.create(props));
    } catch (err) {
      globalThis.say?.(win.id, "That tab could not be opened again");
      throw err;
    }
    await dropArchived(item.space, item.url);
    await register(tab.id); // now, not when it has settled: the other windows get it at once
    const all = await getSynced(), entry = all[syncKeyByTab.get(tab.id)];
    if (entry && row.icon) { entry.icon = row.icon; saveSynced(all); } // Firefox has no way to give an unloaded tab one
    await browser.tabs.update(tab.id, { active: true });
    return true;
  });
}

const forgetArchived = item => serial(() => dropArchived(item.space, item.url));

// A space that is gone takes its list along: its tabs cannot be opened in it any more.
browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) => {
  if (!tidierAlone) return;
  serial(async () => {
    const list = await archivedNow();
    if (!list[contextualIdentity.cookieStoreId]) return;
    delete list[contextualIdentity.cookieStoreId];
    saveArchived(list);
  });
});

// From Tidier's own pages only.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  if (msg?.type === "archivedTabs") return archivedTabs(msg.space);
  if (msg?.type === "reopenArchived") return reopenArchived(msg.item, msg.windowId);
  if (msg?.type === "forgetArchived") return forgetArchived(msg.item);
});
