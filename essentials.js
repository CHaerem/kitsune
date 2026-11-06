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

// Each space's essentials are kept together, the spaces in the order they
// already have in the list: Sidebery shows pinned tabs by space, and when
// Firefox starts it moves them so that each space's are together, in its
// order of spaces, which would otherwise reorder the essentials.
let spaceOrder = null; // containers, in the order of their essentials in the list
async function getList() {
  const list = await essentialsList.get();
  if (!spaceOrder) spaceOrder = [...new Set(list.map(e => e.cookieStoreId))];
  return list;
}
function setList(list, options) {
  const order = [...new Set([...(spaceOrder || []), ...list.map(e => e.cookieStoreId)])];
  const grouped = [...list].sort((a, b) => order.indexOf(a.cookieStoreId) - order.indexOf(b.cookieStoreId));
  spaceOrder = [...new Set(grouped.map(e => e.cookieStoreId))];
  essentialsList.set(grouped, options);
}

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
  // A list with a key in it twice (see onEssentialMoved) stops later moves
  // being saved: repaired here, keeping the first of each.
  const once = [...new Map([...existing].reverse().map(e => [e.key, e])).values()].reverse();
  if (once.length !== existing.length) setList(once);
  if (once.length) return once;
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
    // Refused if its container was removed while Tidier was not running. One bad
    // entry must not keep a window from getting the others, or stop Tidier starting.
    // (Without Sidebery a copy can be pinned from the start.)
    const tab = await browser.tabs.create({
      windowId, url: ghostUrl("essential", entry.key), active: false,
      cookieStoreId: entry.cookieStoreId, index, ...(tidierAlone ? { pinned: true } : {}),
    }).catch(err => { noteError(err); return null; });
    if (!tab) continue;
    busy.add(tab.id);
    await tagTab(tab.id, entry.key);
    tabs.push({ tab, entry });
    await sleep(CREATE_GAP_MS);
  }
  if (!tabs.length) return;
  try {
    if (!tidierAlone) {
      await settle(tabs);
      await pinEssentialCopies(tabs);
    }
    // Created unpinned, they could not be put among the pinned tabs, and
    // pinning puts each last: now each goes to its place in the list.
    await sortEssentials(windowId, await getList());
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
  const copies = new Map(); // key -> this window's copies
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
      copies.set(key, [...(copies.get(key) || []), t]);
      const entry = list.find(e => e.key === key);
      if (entry && !entry.icon && t.favIconUrl && isWeb(t.url)) { entry.icon = t.favIconUrl; setList([...list]); }
    }
  }
  // Two copies in one window (see reopenedEssential, from before it existed):
  // the extra placeholders go; a loaded copy is yours and stays.
  const extra = [...copies.entries()].flatMap(([, ts]) => {
    const keep = ts.find(t => !isGhostUrl(t.url)) || ts[0];
    return ts.filter(t => t !== keep && isGhostUrl(t.url)).map(t => t.id);
  });
  if (extra.length) {
    extra.forEach(id => busy.add(id));
    await browser.tabs.remove(extra).catch(() => {});
    await forgetClosedPlaceholders("essential", [...copies.keys()].filter(k => copies.get(k).length > 1));
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
  await sortEssentials(tab.windowId, await getList()); // with the others of its space
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
  // A loaded page stays as it is, and nothing about it changes, so tab sync must be
  // told: it is an ordinary tab now, in every window.
  if (!isGhostUrl(tab.url)) registerSoon(tab.id);
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

// An unloaded essential dragged to another window is unpinned there for a
// moment and then pinned again (Firefox moves it as a new tab), so an unpin
// counts only if the tab is still unpinned UNPIN_SETTLE_MS later.
const UNPIN_SETTLE_MS = 500;
// With Tidier alone only you pin and unpin, so that counts even on a copy Tidier has just
// made (busy, for a moment): dragged back to the list then, the tab would be neither an
// essential nor an ordinary tab, with the essential still in the list.
const pinIgnored = tabId => !tidierAlone && busy.has(tabId);
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (pinIgnored(tabId) || !("pinned" in change)) return;
  if (change.pinned) { serial(() => onPinned(tab)); return; }
  setTimeout(() => serial(async () => {
    const now = await browser.tabs.get(tabId).catch(() => null);
    if (now && !now.pinned && !pinIgnored(tabId)) await onUnpinned(now);
  }), UNPIN_SETTLE_MS);
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
  if ((!tab.title || tab.title === entry.title) && (!tab.favIconUrl || tab.favIconUrl === entry.icon)) return;
  if (tab.title) entry.title = tab.title;
  if (tab.favIconUrl) entry.icon = tab.favIconUrl;
  setList([...list], { lazy: true });
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
  // Once each: two copies of one essential here would otherwise take two places
  // in the list, and push another essential out of it for good.
  const order = [...new Set((await Promise.all(here.map(keyOf))).filter(k => known.has(k)))];
  // The essentials in this window take their new order in the places they
  // had in the list; essentials missing from this window stay where they are.
  const byKey = new Map(list.map(e => [e.key, e]));
  const slots = list.flatMap((e, i) => (order.includes(e.key) ? [i] : []));
  const next = [...list];
  slots.forEach((slot, j) => { next[slot] = byKey.get(order[j]); });
  if (next.every((e, i) => e === list[i])) return;
  setList(next);
  // Every window, this one too: the list keeps each space's essentials together.
  for (const w of await normalWindows()) await sortEssentials(w.id, await getList());
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

// An essential reopened with ⌘⇧T: Firefox brings it back pinned, with its key,
// so no pinned event marks it, while its placeholder is already back in its
// place. Without this the window has it twice, for good. The reopened tab stays;
// Firefox sets the tab's values just after the event, so they are read in the queue.
browser.tabs.onCreated.addListener(tab => {
  if (started && tab.pinned && !busy.has(tab.id)) serial(() => reopenedEssential(tab));
});

async function reopenedEssential(tab) {
  const key = await browser.sessions.getTabValue(tab.id, TAB_KEY).catch(() => undefined);
  if (!key || busy.has(tab.id) || !(await getList()).some(e => e.key === key)) return;
  keyByTab.set(tab.id, key);
  await dropDoubleCopies(tab.id, tab.windowId);
}

// A container removed: its essentials go with it. Firefox refuses to create tabs
// in it, and Firefox closes its tabs, which onClosed would try to bring back.
browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) => {
  serial(async () => {
    const list = await getList();
    const left = list.filter(e => e.cookieStoreId !== contextualIdentity.cookieStoreId);
    if (left.length !== list.length) setList(left);
  });
});

async function dropDoubleCopies(tabId, windowId) {
  const key = keyByTab.get(tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!key || !tab?.pinned) return;
  await tagTab(tabId, key); // a tab dragged from the tab bar may arrive without its sessions values
  // An unloaded copy arrives without its title (Firefox shows its address):
  // its placeholder is loaded once more to set it, and unloads itself again.
  if (tab.discarded && isGhostUrl(tab.url)) await browser.tabs.update(tabId, { url: ghostUrl("essential", key) }).catch(() => {});
  const pinned = await browser.tabs.query({ windowId, pinned: true });
  const keys = await Promise.all(pinned.map(keyOf));
  const doubles = pinned.filter((t, i) => t.id !== tabId && keys[i] === key).map(t => t.id);
  if (!doubles.length) return;
  doubles.forEach(id => busy.add(id));
  await browser.tabs.remove(doubles).catch(() => {});
  await forgetClosedPlaceholders("essential", [key]);
  await sortEssentials(windowId, await getList());
}

// --- One loaded copy -------------------------------------------------------
// Like a synced tab (tabsync.js), an essential is loaded in one window only:
// two loaded copies of Slack would both play every notification sound, and
// take twice the memory. Every other copy is a placeholder (ghost.html).
// Selecting a placeholder in the window you are using moves the loaded copy
// in (the window it leaves gets a placeholder, as when you drag an essential
// there, see onDetached); only if no copy is loaded does it open the page
// itself. A copy that loads anyway (restored by Firefox, or unloaded by it
// and selected again) makes the other copies placeholders (oneLoaded).

const isLoadedCopy = t => !t.discarded && !isGhostUrl(t.url);

async function copiesOf(key) {
  const pinned = await browser.tabs.query({ pinned: true });
  const keys = await Promise.all(pinned.map(keyOf));
  return pinned.filter((t, i) => keys[i] === key);
}

// A placeholder shown in `tab`'s window: returns whether it should open the
// page itself. In a window you are not using it waits (it may have just become
// a placeholder, see oneLoaded); when you switch to it, onFocusChanged asks again.
async function essentialShown(tab) {
  if (tab.windowId !== focusedWindowId) return false;
  const key = await keyOf(tab);
  if (!key || !(await getList()).some(e => e.key === key)) return true;
  const loaded = (await copiesOf(key)).find(t => t.id !== tab.id && t.windowId !== tab.windowId && isLoadedCopy(t));
  if (!loaded) return true;
  if (loaded.active) {
    // Leave the old window on a tab that is already loaded, so it does not
    // load anything in the background.
    const calm = (await browser.tabs.query({ windowId: loaded.windowId, hidden: false, discarded: false }))
      .find(t => t.id !== loaded.id && !isGhostUrl(t.url));
    if (calm) await browser.tabs.update(calm.id, { active: true }).catch(() => {});
  }
  // Moved into the placeholder's place; onAttached then removes the
  // placeholder, and onDetached gives the old window one.
  await browser.tabs.move(loaded.id, { windowId: tab.windowId, index: tab.index });
  await browser.tabs.update(loaded.id, { active: true }).catch(() => {});
  return false;
}

// Keep one loaded copy of essential `key`: the one selected in the window you
// are using, else a loaded one there, else the one used last. Every other copy
// that shows the real page (loaded, or unloaded by Firefox) becomes a placeholder.
async function oneLoaded(key) {
  const real = (await copiesOf(key)).filter(t => !isGhostUrl(t.url));
  const loaded = real.filter(t => !t.discarded);
  const here = loaded.filter(t => t.windowId === focusedWindowId);
  const keep = here.find(t => t.active) || here[0] || loaded.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  for (const t of real) {
    if (t === keep) continue;
    await browser.tabs.update(t.id, { url: ghostUrl("essential", key) }).catch(() => {});
  }
}

async function oneLoadedEach() {
  for (const e of await getList()) await oneLoaded(e.key);
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "essentialShown" || !sender.tab || sender.id !== browser.runtime.id) return;
  return serial(() => essentialShown(sender.tab)).then(load => ({ load }), () => ({ load: true }));
});

// Switching to a window whose selected tab is an essential's placeholder.
browser.windows.onFocusChanged.addListener(windowId => {
  if (!started || windowId === browser.windows.WINDOW_ID_NONE) return;
  serial(async () => {
    const [active] = await browser.tabs.query({ windowId, active: true });
    if (!active?.pinned || !isGhostUrl(active.url) || !(await keyOf(active))) return;
    if (await essentialShown(active)) {
      const entry = (await getList()).find(e => e.key === keyByTab.get(active.id));
      if (entry) await browser.tabs.update(active.id, { url: entry.url }).catch(() => {});
    }
  });
});

// A copy started loading its page: the others become placeholders.
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!started || busy.has(tabId) || !tab.pinned || change.status !== "loading" || isGhostUrl(tab.url)) return;
  const key = keyByTab.get(tabId);
  if (key) serial(() => oneLoaded(key));
}, { properties: ["status"] });

// Startup is driven from tabsync.js, so both features start in one order.
async function startEssentials() {
  await initList();
  await ensureAllWindows();
}
