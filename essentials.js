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
// - Move an essential    -> the new order is kept, and the other windows follow.
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
// its space (see PIN_SETTLE_MS). In a new window `settle` waits for Sidebery's
// sidebar there first (see fillWindow), so it is passed in.
async function createEssentials(windowId, items, settle = () => sleep(PIN_SETTLE_MS)) { // [{ entry, index }]
  const tabs = [];
  for (const { entry, index } of items) {
    const tab = await browser.tabs.create({
      windowId, url: ghostUrl("essential", entry.key), active: false,
      cookieStoreId: entry.cookieStoreId, index,
    });
    busy.add(tab.id);
    await tagTab(tab.id, entry.key);
    tabs.push({ tab, entry });
    await sleep(CREATE_GAP_MS);
  }
  if (!tabs.length) return;
  try {
    await settle(tabs);
    await pinEssentialCopies(tabs);
  } finally {
    setTimeout(() => tabs.forEach(({ tab }) => busy.delete(tab.id)), 1500);
  }
}

// Sidebery gives a tab that existed before a window's sidebar was ready the
// last active space, ignoring its container rules, and a pinned tab keeps its
// space (mbnuqw/sidebery#2497). Its container rules are applied again when an
// unpinned tab's address changes, so each copy loads its placeholder once
// more, gets a moment to be moved to its own space, and is pinned only then.
async function pinEssentialCopies(tabs) {
  await reloadPlaceholders(tabs);
  await sleep(RULE_SETTLE_MS);
  for (const { tab } of tabs) await browser.tabs.update(tab.id, { pinned: true }).catch(() => {});
}

// Load each copy's placeholder again (a new address, so Sidebery sees a change).
let placedCount = 0;
async function reloadPlaceholders(tabs) {
  placedCount++;
  for (const { tab, entry } of tabs) {
    await browser.tabs.update(tab.id, { url: ghostUrl("essential", entry.key) + "&placed=" + placedCount }).catch(() => {});
  }
}

// Add any essentials a window is missing. Safe to run repeatedly.
async function ensureWindow(windowId, settle) {
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
  await createEssentials(windowId, missing, settle);
}

async function ensureAllWindows() {
  for (const w of await normalWindows()) await ensureWindow(w.id);
}

// New essential (the tab was pinned). A placeholder that is pinned (a ghost,
// or a live folder tab never opened) stands for its synced tab's page; tab
// sync forgets that tab right after this (tabsync.js), so it is read first.
async function onPinned(tab) {
  // An essential dragged to another window arrives there as a pinned tab, as
  // if it was just pinned; it is still the same essential (see onAttached).
  const known = keyByTab.get(tab.id);
  if (known && (await getList()).some(e => e.key === known)) { await tagTab(tab.id, known); return; }
  let { url, title, favIconUrl: icon } = tab;
  if (isGhostUrl(url)) {
    const entry = (await getSynced())[syncKeyByTab.get(tab.id)];
    if (!entry || !isWeb(entry.url)) return;
    ({ url, title, icon } = entry);
  }
  if (!isWeb(url)) return;
  const list = await getList();
  const key = crypto.randomUUID();
  await tagTab(tab.id, key);
  setList([...list, { key, url, cookieStoreId: tab.cookieStoreId, title, icon }]);
  // The pinned placeholder becomes this essential's copy, still unloaded.
  if (isGhostUrl(tab.url)) {
    busy.add(tab.id);
    await browser.tabs.update(tab.id, { url: ghostUrl("essential", key) }).catch(() => {});
    setTimeout(() => busy.delete(tab.id), 1500);
  }
  for (const w of await normalWindows()) if (w.id !== tab.windowId) await ensureWindow(w.id);
}

// Essential removed (the tab was unpinned): remove the copies in other windows.
// An unloaded copy you unpin is still the placeholder page, which has nothing
// to show once the essential is gone, so it opens the real page and becomes
// an ordinary tab.
async function onUnpinned(tab) {
  const key = await keyOf(tab);
  if (!key) return;
  keyByTab.delete(tab.id);
  await browser.sessions.removeTabValue(tab.id, TAB_KEY);
  const list = await getList();
  const entry = list.find(e => e.key === key);
  setList(list.filter(e => e.key !== key));
  if (isGhostUrl(tab.url)) {
    if (entry) await browser.tabs.update(tab.id, { url: entry.url }).catch(() => {});
    else {
      // Unpinned while the essential was being removed from another window
      // (its copies are removed then): it goes the same way.
      busy.add(tab.id);
      await browser.tabs.remove(tab.id).catch(() => {});
    }
  }
  const pinned = await browser.tabs.query({ pinned: true });
  const keys = await Promise.all(pinned.map(keyOf));
  const copies = pinned.filter((t, i) => t.id !== tab.id && keys[i] === key).map(t => t.id);
  copies.forEach(id => busy.add(id));
  await browser.tabs.remove(copies);
  await forgetClosedPlaceholders("essential", [key]);
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

// An essential moved to a new place: the list takes that window's order, and
// the copies in the other windows are moved to match. Our own moves are
// ignored (ownMoves), so the windows do not answer each other.
const ownMoves = new Set();
browser.tabs.onMoved.addListener((tabId, info) => {
  if (ownMoves.delete(tabId) || busy.has(tabId) || !keyByTab.has(tabId)) return;
  serial(() => onEssentialMoved(info.windowId));
});

async function onEssentialMoved(windowId) {
  const list = await getList();
  const here = await browser.tabs.query({ windowId, pinned: true });
  const known = new Set(list.map(e => e.key));
  const order = (await Promise.all(here.map(keyOf))).filter(k => known.has(k));
  // The essentials in this window take their new order in the places they
  // had in the list; essentials missing from this window stay where they are.
  const byKey = new Map(list.map(e => [e.key, e]));
  const slots = list.flatMap((e, i) => (order.includes(e.key) ? [i] : []));
  const next = [...list];
  slots.forEach((slot, j) => { next[slot] = byKey.get(order[j]); });
  if (next.every((e, i) => e === list[i])) return;
  setList(next);
  for (const w of await normalWindows()) if (w.id !== windowId) await sortEssentials(w.id, next);
}

// Put a window's essentials in the list's order (pinned tabs come first).
async function sortEssentials(windowId, list) {
  const rank = new Map(list.map((e, i) => [e.key, i]));
  const pinned = await browser.tabs.query({ windowId, pinned: true });
  const keys = await Promise.all(pinned.map(keyOf));
  const wanted = pinned.map((t, i) => [t.id, rank.get(keys[i]) ?? Infinity]).sort((a, b) => a[1] - b[1]);
  for (const [index, [tabId]] of wanted.entries()) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.index === index) continue;
    ownMoves.add(tabId);
    await browser.tabs.move(tabId, { index }).catch(() => ownMoves.delete(tabId));
  }
}

// An essential dragged to another window: fill the gap in the window it left,
// and in the window it came to, where it now is twice, keep the one you
// brought (it may be loaded) and put it in the copy's place.
browser.tabs.onDetached.addListener((tabId, info) => {
  if (!keyByTab.has(tabId)) return;
  serial(() => ensureWindow(info.oldWindowId));
});
browser.tabs.onAttached.addListener((tabId, info) => {
  if (!keyByTab.has(tabId) || busy.has(tabId)) return;
  serial(() => dropDoubleCopies(tabId, info.newWindowId));
});

async function dropDoubleCopies(tabId, windowId) {
  const key = keyByTab.get(tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!key || !tab?.pinned) return;
  await tagTab(tabId, key); // a tab dragged from the tab bar may arrive without its sessions values
  const pinned = await browser.tabs.query({ windowId, pinned: true });
  const keys = await Promise.all(pinned.map(keyOf));
  const doubles = pinned.filter((t, i) => t.id !== tabId && keys[i] === key).map(t => t.id);
  if (!doubles.length) return;
  doubles.forEach(id => busy.add(id));
  await browser.tabs.remove(doubles).catch(() => {});
  await forgetClosedPlaceholders("essential", [key]);
  await sortEssentials(windowId, await getList());
}

// Startup is driven from tabsync.js, so both features start in one order.
async function startEssentials() {
  await initList();
  await ensureAllWindows();
}
