// A closed folder rests (Tidier alone): closed means out of the list, out of ⌃Tab and
// out of memory. Sidebery has settings for those and a delay before it unloads; here it
// is one fixed behaviour, with neither.
//
// Hiding is showSpace's (spaces.js): a tab in a closed folder is not `visible`. Firefox
// cannot hide the selected tab, so that one goes when you leave it. Selecting a hidden
// tab shows it again: Firefox does that itself.
//
// Unloading is here, and only at a moment you chose: closing a folder, a tab arriving in
// a closed one, and leaving a tab in one. So there is nothing to cancel, no idle work,
// and nothing at a start or an update, when a page must not be thrown away just because
// Tidier started. Opening a folder loads nothing: a page loads when you select it, as
// any unloaded tab does.

// Whether the stored entry `key` is in a closed folder.
const restsInFolder = (all, key) => !!all[folderKeyOf(all, key)]?.collapsed;

// Unload one tab, which is its real tab wherever that is: a row or a placeholder says
// nothing about what is loaded (and a placeholder unloads itself once Firefox shows its
// icon, see unloadGhost in tabsync.js; sooner, it would have none).
//
// tabs.discard and not unloadSaved: the tab keeps the address it is on, since only
// closing a saved tab takes it back to its saved address. A page with unsaved input
// refuses without asking (see closesQuietly, tabsync.js), stays loaded, and nothing more
// happens: no retry, and no message about something you did not ask for.
//
// What keeps working stays loaded: the tab you are on, a tab playing sound, and a call
// or a shared screen (no sound is heard in a silence, and unloading would hang up). A
// live folder's tabs are left to its search (livefolders.js).
async function restTab(all, key) {
  const id = liveTabId(key);
  const tab = id === undefined ? null : await browser.tabs.get(id).catch(() => null);
  if (!tab || tab.discarded || isGhostUrl(tab.url) || all[key]?.liveFolder) return;
  const { camera, microphone, screen } = tab.sharingState ?? {};
  if (tab.active || tab.audible || camera || microphone || screen) return;
  await browser.tabs.discard(id).catch(() => {});
}

// One at a time, each on its own: a page that refuses must not keep the others loaded.
async function restFolder(key) {
  const all = await getSynced();
  for (const k of Object.keys(all)) if (folderKeyOf(all, k) === key) await restTab(all, k);
}

async function restIfInClosedFolder(key) {
  const all = await getSynced();
  if (restsInFolder(all, key)) await restTab(all, key);
}

// A fold is the same in every window, so every window follows.
async function showSpaceEverywhere() {
  for (const w of await normalWindows()) await showSpace(w.id);
}

// A folder was closed, opened or deleted. Hidden first, so a folder with many tabs
// looks closed at once. (Deleted, its tabs are ordinary tabs and come back.)
async function foldChanged(key) {
  if (!tidierAlone) return;
  await showSpaceEverywhere();
  if ((await getSynced())[key]?.collapsed) await restFolder(key);
}

// A tab moved in the sidebar: it may have come into a closed folder, or out of one.
async function restMoved(key) {
  if (!tidierAlone) return;
  await showSpaceEverywhere();
  await restIfInClosedFolder(key);
}

// You left a tab in a closed folder: now it can be hidden and unloaded. (showSpace
// runs for most selections anyway, but not for one going to a tab without a container.)
// Looked at again in the queue: the folder may be open by then, or the tab selected in
// another window, as a pull does (tabsync.js), which also makes this event in the
// window it leaves.
browser.tabs.onActivated.addListener(async ({ previousTabId, windowId }) => {
  if (!tidierAlone || !started) return;
  const key = syncKeyByTab.get(previousTabId);
  if (!key || !restsInFolder(await getSynced(), key)) return;
  serial(async () => {
    await showSpace(windowId);
    await restIfInClosedFolder(key);
  });
});
