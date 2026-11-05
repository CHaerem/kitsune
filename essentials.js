// Essentials: the same essentials (pinned tabs) in every window.
//
// Firefox ties each tab to one window, so "the same" essential in two windows
// is two tabs. This extension keeps a list of essentials and makes sure every
// window has an (unloaded) copy of each, in the same container. Each copy is
// tagged with a key (a sessions value) so it is recognised after a restart.
//
// - Pin a tab            -> new essential, added to every window.
// - Unpin an essential   -> removed from the list and from the other windows.
// - Close an essential   -> comes back unloaded (like Zen).
// - New window / startup -> missing essentials are added (driven from tabsync.js).
//
// Essentials keep the URL they were pinned with; navigating inside one does
// not change the list.

const essentialsList = storedValue("essentials", () => []); // [{ key, url, cookieStoreId, title, icon, name? }]
// `name` is an optional short name (e.g. "Jira") shown on unloaded copies in
// place of the page title; set it in the extension storage.
const TAB_KEY = "essentialKey"; // sessions value on each essential tab

// Tab IDs we create, pin, unpin or close ourselves. The listeners ignore
// these so our own changes are not mirrored back in a loop.
const busy = new Set();
// Tab ID -> key, so we know which essential a closed tab was.
const keyByTab = new Map();

const getList = () => essentialsList.get();
const setList = list => essentialsList.set(list);

function tagTab(tabId, key) {
  keyByTab.set(tabId, key);
  return browser.sessions.setTabValue(tabId, TAB_KEY, key);
}

async function keyOf(tab) {
  if (keyByTab.has(tab.id)) return keyByTab.get(tab.id);
  const key = await browser.sessions.getTabValue(tab.id, TAB_KEY);
  if (key) keyByTab.set(tab.id, key);
  return key;
}

// First run: take the essentials from the window with the most pinned tabs.
async function initList() {
  const existing = await getList();
  if (existing.length) return existing;
  const wins = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  wins.sort((a, b) => b.tabs.filter(t => t.pinned).length - a.tabs.filter(t => t.pinned).length);
  const list = [];
  for (const t of wins[0]?.tabs.filter(t => t.pinned && isWeb(t.url)) || []) {
    const key = crypto.randomUUID();
    list.push({ key, url: t.url, cookieStoreId: t.cookieStoreId, title: t.title, icon: t.favIconUrl });
    await tagTab(t.id, key);
  }
  setList(list);
  return list;
}

// Create essential copies as placeholder pages (see ghost.js): each shows the
// real page's title and icon, unloads itself, and opens the real page when
// you select it. They are created unpinned, so Sidebery puts each in its
// container's space, and pinned together a moment later; a pinned tab keeps
// its space (see PIN_SETTLE_MS).
async function createEssentials(windowId, items) { // [{ entry, index }]
  const tabs = [];
  for (const { entry, index } of items) {
    const tab = await browser.tabs.create({
      windowId, url: ghostUrl("essential", entry.key), active: false,
      cookieStoreId: entry.cookieStoreId, index,
    });
    busy.add(tab.id);
    await tagTab(tab.id, entry.key);
    tabs.push(tab);
    await sleep(CREATE_GAP_MS);
  }
  if (!tabs.length) return;
  await sleep(PIN_SETTLE_MS);
  try {
    for (const tab of tabs) await browser.tabs.update(tab.id, { pinned: true }).catch(() => {});
  } finally {
    setTimeout(() => tabs.forEach(t => busy.delete(t.id)), 1500);
  }
}

// Add any essentials a window is missing. Safe to run repeatedly.
async function ensureWindow(windowId) {
  const list = await getList();
  if (!list.length) return;
  const win = await browser.windows.get(windowId).catch(() => null);
  if (!win || win.type !== "normal" || win.incognito) return;
  const pinned = await browser.tabs.query({ windowId, pinned: true });
  const keys = await Promise.all(pinned.map(keyOf));
  const known = new Set(list.map(e => e.key));
  const have = new Set();
  for (const [i, t] of pinned.entries()) {
    let key = keys[i];
    if (!key || !known.has(key)) {
      // Untagged pinned tab (from before the extension, or tagged by an earlier
      // install whose list is gone): match on URL + container.
      key = null;
      const match = list.find(e => !have.has(e.key) && e.url === t.url && e.cookieStoreId === t.cookieStoreId);
      if (match) { key = match.key; await tagTab(t.id, key); }
    }
    if (key) {
      have.add(key);
      const entry = list.find(e => e.key === key);
      if (entry && !entry.icon && t.favIconUrl && isWeb(t.url)) { entry.icon = t.favIconUrl; setList([...list]); }
    }
  }
  let index = 0;
  const missing = [];
  for (const entry of list) {
    if (have.has(entry.key)) { index++; continue; }
    if (!isWeb(entry.url)) continue;
    missing.push({ entry, index: index++ });
  }
  await createEssentials(windowId, missing);
}

async function ensureAllWindows() {
  for (const w of await normalWindows()) await ensureWindow(w.id);
}

// New essential (the tab was pinned).
async function onPinned(tab) {
  if (!isWeb(tab.url)) return;
  const list = await getList();
  const key = crypto.randomUUID();
  await tagTab(tab.id, key);
  setList([...list, { key, url: tab.url, cookieStoreId: tab.cookieStoreId, title: tab.title, icon: tab.favIconUrl }]);
  for (const w of await normalWindows()) if (w.id !== tab.windowId) await ensureWindow(w.id);
}

// Essential removed (the tab was unpinned): remove the copies in other windows.
async function onUnpinned(tab) {
  const key = await keyOf(tab);
  if (!key) return;
  keyByTab.delete(tab.id);
  await browser.sessions.removeTabValue(tab.id, TAB_KEY);
  setList((await getList()).filter(e => e.key !== key));
  const pinned = await browser.tabs.query({ pinned: true });
  const keys = await Promise.all(pinned.map(keyOf));
  const copies = pinned.filter((t, i) => t.id !== tab.id && keys[i] === key).map(t => t.id);
  copies.forEach(id => busy.add(id));
  await browser.tabs.remove(copies);
}

// Essential closed: add it back, unloaded, in the same window.
async function onClosed(tabId, windowId) {
  const key = keyByTab.get(tabId);
  keyByTab.delete(tabId);
  if (!key) return;
  if (!(await getList()).some(e => e.key === key)) return;
  await ensureWindow(windowId);
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (busy.has(tabId) || !("pinned" in change)) return;
  serial(() => (change.pinned ? onPinned(tab) : onUnpinned(tab)));
}, { properties: ["pinned"] });

// Keep each essential's title and icon current, from whichever copy is loaded.
// Only from its own site: an essential that redirects to a sign-in page
// (another host) would otherwise be named and drawn as that sign-in page.
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!isWeb(tab.url) || !(change.title || change.favIconUrl)) return;
  const key = keyByTab.get(tabId);
  if (key && tab.pinned) serial(() => updateFromCopy(key, tab));
  else if (tab.favIconUrl) serial(() => fillMissingIcons(tab));
}, { properties: ["title", "favIconUrl"] });

async function updateFromCopy(key, tab) {
  const list = await getList();
  const entry = list.find(e => e.key === key);
  if (!entry || !sameSite(tab.url, entry.url)) return;
  if (tab.title) entry.title = tab.title;
  if (tab.favIconUrl) entry.icon = tab.favIconUrl;
  setList([...list]);
}

// An essential with no icon saved yet (not opened since it became one) takes
// the icon of any tab on its site, and its unloaded copies are redrawn.
async function fillMissingIcons(tab) {
  const list = await getList();
  const missing = list.filter(e => !e.icon && sameSite(tab.url, e.url));
  if (!missing.length) return;
  missing.forEach(e => { e.icon = tab.favIconUrl; });
  setList([...list]);
  const keys = new Set(missing.map(e => e.key));
  const copies = await browser.tabs.query({ pinned: true, discarded: true });
  const copyKeys = await Promise.all(copies.map(keyOf));
  for (const [i, t] of copies.entries()) {
    // Reloading only loads the placeholder page, which unloads itself again.
    if (keys.has(copyKeys[i]) && isGhostUrl(t.url)) await browser.tabs.update(t.id, { url: ghostUrl("essential", copyKeys[i]) }).catch(() => {});
  }
}

browser.tabs.onRemoved.addListener((tabId, info) => {
  if (busy.has(tabId)) { busy.delete(tabId); keyByTab.delete(tabId); return; }
  if (info.isWindowClosing) { keyByTab.delete(tabId); return; }
  serial(() => onClosed(tabId, info.windowId));
});

// An essential dragged to another window: fill the gap in the window it left.
browser.tabs.onDetached.addListener((tabId, info) => {
  if (!keyByTab.has(tabId)) return;
  serial(() => ensureWindow(info.oldWindowId));
});

// Startup is driven from tabsync.js, so both features start in one order.
async function startEssentials() {
  await initList();
  await ensureAllWindows();
}
