// A small window for links from other apps, like Little Arc (Tidier alone). A link
// from Slack or Mail opens in a window of its own that you read and close, or keep with
// one click, so that it does not end up in your list just because someone sent it.
//
// How such a link is told apart, measured in Firefox 158. Container and focus do not do it:
//   - Firefox opens a link from another app with no container, unless another visible tab
//     is on the same host: then it guesses that tab's container (URILoadingHelper's
//     guessUserContextId). A pinned tab is always visible to it, so an essential of another
//     space counts. A bookmark has no container either.
//   - On a Mac the app comes to the front around the time the link arrives, in either
//     order, so "Firefox is in the background" misses some links, and it would catch
//     anything else that happens to open while you are away.
//   - What does tell, in every try in Firefox 158 and 160, in front or behind: such a new
//     tab reports its first about:blank as an address, before its real one. Going by
//     Firefox's code, that is its load for a link from outside (LOAD_FLAGS_FROM_EXTERNAL)
//     ending that about:blank early. A bookmark, an address typed with ⌥⏎, a page's own
//     new tab (target=_blank, window.open), a sign-in popup, ⌘⇧T, a reopened window, a
//     duplicated tab and tabs.create do not.
// That is a detail of Firefox's, not a promise. Should it go, links simply open as
// ordinary tabs again, and the smoke test, which also runs on Developer Edition a month
// ahead, says so.
//
// That guess is why a new tab on about:blank does not get to decide the space yet (see
// littleHolds): selected in another space's container, it would take your window there
// for as long as the page takes to answer, only to come back.
//
// A link Firefox is started with is not told apart: Tidier is not running yet.
//
// A window that extensions open has no address bar and no toolbar at all, whatever the
// look says (Firefox marks it web-extension-popup-window and hides them), so nothing can be
// drawn in it without a script in the page. Firefox puts the page's address in its title
// instead, and Tidier adds the space. "Keep" is on the right click in the page, and the
// sidebar of the window behind it has a row for it for as long as it is open. Closing is ⌘W.
//
// It is left out of tab sync until you keep it (`register` skips all but normal windows).
//
// The same window is Tidier's link preview (Zen's Glance, Arc's Peek): "Open link in" on
// a link's menu needs nothing, and ⌥-click needs a script in every page, so that only
// with the access to all websites, which is optional and asked for on the settings page.

const LITTLE_WIDTH = 900, LITTLE_HEIGHT = 700;
const LITTLE_KEY = "little"; // sessions window value: this window is one of these, also after a restart
const LITTLE_SETTING = "littleWindow"; // on unless you turned it off in the settings
const littleSetting = storedValue(LITTLE_SETTING, () => true);
const littles = new Map(); // a small window's id -> the window it came from
const newBlanks = new Map(); // new tabs on their first about:blank -> { fromOutside: Firefox marked it, space: the one you were in, held: see littleHolds, taken: on its way to a small window }

// --- Telling a link from another app ------------------------------------------------
browser.tabs.onCreated.addListener(tab => {
  if (tidierAlone && started && tab.url === "about:blank" && tab.openerTabId === undefined && !tab.pinned && !tab.incognito && !syncBusy.has(tab.id)) {
    newBlanks.set(tab.id, { fromOutside: false, space: activeSpace.get(tab.windowId), held: false });
  }
});
browser.tabs.onUpdated.addListener((tabId, change) => {
  const blank = newBlanks.get(tabId);
  if (!blank || !change.url) return;
  if (change.url === "about:blank") blank.fromOutside = true;
  else if (!blank.fromOutside || !isWeb(change.url)) settleBlank(tabId); // a page of its own, a placeholder, a new tab page
}, { properties: ["url"] });
browser.tabs.onRemoved.addListener(tabId => newBlanks.delete(tabId));

// Asked by spaces.js for a selected tab: whether it must wait with taking the window to its
// space, since it may still turn out to be a link on its way to a small window.
function littleHolds(tab) {
  const blank = newBlanks.get(tab.id);
  if (!blank?.space || blank.space === tab.cookieStoreId) return false;
  blank.held = true;
  return true;
}

// It is an ordinary tab after all: selected meanwhile, it now does what it was held from.
function settleBlank(tabId) {
  const held = newBlanks.get(tabId)?.held;
  newBlanks.delete(tabId);
  if (!held) return;
  serial(async () => {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab?.active) return;
    await setSpace(tab.windowId, tab.cookieStoreId);
    await setSuccessor(tab);
  });
}

// Asked by spaces.js with a tab's first web address, before it looks at that address
// itself: whether this is a link from another app, which is then taken care of here.
// Asking changes nothing if it is not (yet): isolation.js asks at the request, which
// comes before Firefox's mark.
function littleTakes(tabId, url) {
  const blank = newBlanks.get(tabId);
  if (!blank?.fromOutside) return false;
  if (blank.taken) return true; // on its way: an address can change again before the queue gets to it
  blank.taken = true;
  firstPage.delete(tabId);
  serial(async () => {
    const opened = await littleSetting.get() && await littleForLink(tabId, url).catch(async err => {
      if (await browser.tabs.get(tabId).catch(() => null)) noteError(err); // closed meanwhile is no fault
      return false;
    });
    // (In newTabs up to here: until then no view draws its row, only for it to go. reopensSoon, newtabs.js.)
    if (opened) { newBlanks.delete(tabId); newTabs.delete(tabId); return; }
    await byRule(tabId, url); // what any new tab gets: it is off, or there is no window for it
    newTabs.delete(tabId);
    settleBlank(tabId);
  });
  return true;
}

// isolation.js stops a request that would go out in the wrong container and opens the page
// in the right one itself, so the tab never gets its address here. Firefox's mark comes
// just after the request, while the new tab is still being made: asked with both tabs once
// the new one is there, before the old one is closed. A mark that comes later still means
// an ordinary tab, which loses nothing.
async function littleAfterReopen(oldTab, tab) {
  if (!newBlanks.get(oldTab.id)?.fromOutside || !tab?.id || !await littleSetting.get()) return;
  await openLittle(oldTab.windowId, { tabId: tab.id }, tab.cookieStoreId, oldTab.width).catch(noteError);
}

// A rule's space, if it still exists: a window opened in a removed container is refused,
// and the link would be gone with its first tab.
async function ruledSpace(url) {
  const rule = (await rulesList.get()).find(r => ruleCounts(r) && ruleMatches(r.url, url)); // isolation.js
  return rule && (await containerSpaces()).some(s => s.id === rule.space) ? rule.space : null;
}

// The rule's space, else the space you are in.
async function littleSpace(url, windowId, fallback) {
  return await ruledSpace(url) ?? activeSpace.get(windowId) ?? activeSpace.get(focusedWindowId) ?? (fallback !== NO_CONTAINER ? fallback : null);
}

// The tab itself moves if it is in the right container: a link can work only once (a
// sign-in sent by mail), and it has already been asked for. Otherwise, and that is most
// links, since a site you have no tab on gets no container, it is opened again there,
// as a tab in the wrong space always is.
async function littleForLink(tabId, url) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return true; // closed meanwhile: nothing left to do
  if (syncKeyByTab.has(tabId)) return false;
  // Never one that is in a popup already: a sign-in's window must stay the one its page opened.
  if ((await browser.windows.get(tab.windowId).catch(() => null))?.type !== "normal") return false;
  const space = await littleSpace(url, tab.windowId, tab.cookieStoreId);
  if (!space) return false;
  const moves = tab.cookieStoreId === space;
  await openLittle(tab.windowId, moves ? { tabId } : { url, cookieStoreId: space }, space, tab.width);
  if (moves) return true;
  // Closed by Tidier, not by you: ⌘⇧T must bring back what you closed, not this (common.js).
  toForget.set(url, Date.now() + FORGET_MS);
  setTimeout(forgetClosedNow, FORGET_MS + 100);
  await browser.tabs.remove(tabId).catch(() => {});
  return true;
}

// --- The window ----------------------------------------------------------------------
// Centred over the page rather than the window, so the sidebar stays in view with its row.
function littleBounds(win, pageWidth) {
  const page = pageWidth > 0 && pageWidth < win.width ? pageWidth : win.width;
  const pageLeft = win.left + win.width - page;
  return {
    width: LITTLE_WIDTH, height: LITTLE_HEIGHT,
    left: Math.round(pageLeft + Math.max(0, (page - LITTLE_WIDTH) / 2)),
    top: Math.round(win.top + Math.max(0, (win.height - LITTLE_HEIGHT) / 2)),
  };
}

const spaceName = async space => (await containerSpaces()).find(s => s.id === space)?.name ?? null;

async function openLittle(fromWindowId, where, space, pageWidth) {
  const from = await browser.windows.get(fromWindowId).catch(() => null);
  const titlePreface = `${await spaceName(space) ?? "Tidier"} · `;
  const made = await browser.windows.create({ type: "popup", ...(from ? littleBounds(from, pageWidth) : { width: LITTLE_WIDTH, height: LITTLE_HEIGHT }), titlePreface, ...where });
  littles.set(made.id, fromWindowId);
  if (where.tabId) await browser.windows.update(made.id, { titlePreface }).catch(() => {}); // with a tab moved in, Firefox drops it on the way
  await browser.sessions.setWindowValue(made.id, LITTLE_KEY, true).catch(() => {});
  viewAllSoon();
  return made;
}

browser.windows.onRemoved.addListener(windowId => { if (littles.delete(windowId)) viewAllSoon(); });
// ⌘⇧T right after closing one, or ⌘⇧N: Firefox brings it back, with its mark but not its title.
browser.windows.onCreated.addListener(win => { if (tidierAlone && started && win.type === "popup") serial(() => adoptLittle(win)); });
browser.tabs.onUpdated.addListener((tabId, change, tab) => { if (littles.has(tab.windowId)) viewAllSoon(); }, { properties: ["title", "favIconUrl"] });

// --- Keeping it ----------------------------------------------------------------------
// The normal window a page goes to: the one asked for, else the one you are using.
async function normalWindowFor(preferred) {
  const wins = await normalWindows();
  return wins.find(w => w.id === preferred) ?? wins.find(w => w.id === focusedWindowId) ?? wins[0] ?? null;
}

// The row a kept page goes above: the first of today's tabs of its space, as drawn.
// Only a tab with a record, since other windows place theirs by the record's key.
async function firstOfToday(windowId, space) {
  const all = await getSynced();
  const tabs = (await browser.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  return tabs.find(t => !t.pinned && t.cookieStoreId === space && syncKeyByTab.has(t.id) && !folderKeyOf(all, syncKeyByTab.get(t.id)))?.id ?? null;
}

// Into your list, where a new tab goes, in every window. Firefox moves the page across
// without loading it again, and closes the small window with its last tab. It stays
// selected: you were reading it, and it would be odd for it to vanish from under you. In
// another space that takes you there, as selecting any tab does (spaces.js).
async function keepLittle(tabId, windowId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || !littles.has(tab.windowId)) return;
  const target = await normalWindowFor(windowId ?? littles.get(tab.windowId));
  let into;
  if (target) {
    const before = await firstOfToday(target.id, tab.cookieStoreId);
    // Refused only if the tab or the window closed just now: it stays where it is, or is gone.
    if (!await browser.tabs.move(tabId, { windowId: target.id, index: -1 }).catch(() => null)) return;
    await register(tabId);
    await moveTab(target.id, tabId, before);
    into = target.id;
  } else {
    into = (await browser.windows.create({ tabId })).id; // tab sync fills it, as any new window
    await register(tabId);
  }
  await browser.tabs.update(tabId, { active: true }).catch(() => {});
  await browser.windows.update(into, { focused: true }).catch(() => {});
}

// --- What the sidebar shows, and what it asks ----------------------------------------
async function littleRows(spaces) {
  const rows = [];
  for (const windowId of littles.keys()) {
    const [tab] = await browser.tabs.query({ windowId }).catch(() => []);
    if (tab) rows.push({ id: tab.id, title: tab.title || tab.url, icon: iconForView(tab), space: spaces.find(s => s.id === tab.cookieStoreId)?.name ?? "" });
  }
  return rows;
}

async function littleAction(windowId, msg) {
  if (msg.type === "little:keep") await keepLittle(msg.tabId, windowId);
  else if (msg.type === "little:show") {
    // Behind the window you clicked: this brings it back.
    const tab = await browser.tabs.get(msg.tabId).catch(() => null);
    if (tab && littles.has(tab.windowId)) await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

// --- Menus: a link in the page, and the small window's own page -----------------------
// The first needs no access to the page: Firefox gives the link's address with the click.
// "Small window" is also link preview for those who never give access to all websites.
const MENU_OPEN_IN = "tidier-open-in", MENU_OPEN_LITTLE = "tidier-open-little", MENU_KEEP = "tidier-keep";
let linkChoices = [], keepShown = false;

// (Started again when a permission is given, and an id that is there already is an error.)
function startLittleMenus() {
  browser.menus.removeAll();
  linkChoices = [];
  browser.menus.create({ id: MENU_OPEN_IN, title: "Open link in", contexts: ["link"], targetUrlPatterns: ["http://*/*", "https://*/*"] });
  browser.menus.create({ id: MENU_OPEN_LITTLE, parentId: MENU_OPEN_IN, title: "Small window", contexts: ["link"] });
  browser.menus.create({ id: MENU_KEEP, title: "Keep", contexts: ["page", "frame", "selection", "link", "image", "video", "audio", "editable"], visible: false });
}

browser.menus.onShown.addListener(async (info, tab) => {
  if (!tidierAlone || !tab || info.contexts.includes("tab")) return;
  let changed = false;
  if (info.contexts.includes("link")) {
    for (const id of linkChoices) browser.menus.remove(id).catch(() => {});
    linkChoices = [];
    // A private window's link stays private: no space, and no small window that is not.
    if (!tab.incognito) linkChoices = (await containerSpaces()).filter(s => s.id !== tab.cookieStoreId).map(s => {
      const id = `${MENU_OPEN_IN}:${s.id}`;
      browser.menus.create({ id, parentId: MENU_OPEN_IN, title: s.name, contexts: ["link"] });
      return id;
    });
    await browser.menus.update(MENU_OPEN_IN, { visible: !tab.incognito }).catch(() => {});
    changed = true;
  }
  if (littles.has(tab.windowId)) {
    const name = await spaceName(tab.cookieStoreId);
    await browser.menus.update(MENU_KEEP, { visible: true, title: name ? `Keep in ${name}` : "Keep" }).catch(() => {});
    keepShown = true;
    changed = true;
  }
  if (changed) browser.menus.refresh();
});

// Hidden again right away: the next menu, in a normal window, would show it until it is told.
browser.menus.onHidden.addListener(() => {
  if (keepShown) browser.menus.update(MENU_KEEP, { visible: false }).catch(() => {});
  keepShown = false;
});

browser.menus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (!tidierAlone || !tab || tab.incognito) return;
  if (id === MENU_KEEP) serial(() => keepLittle(tab.id));
  else if (id === MENU_OPEN_LITTLE) serial(() => linkInLittle(tab, info.linkUrl));
  else if (id.startsWith(MENU_OPEN_IN + ":")) serial(() => linkInSpace(tab, info.linkUrl, id.slice(MENU_OPEN_IN.length + 1)));
});

// In the space of the page it is on, or the rule's, as a link from another app would be.
async function linkInLittle(tab, url) {
  if (!isWeb(url)) return;
  const space = await ruledSpace(url) ?? (tab.cookieStoreId !== NO_CONTAINER ? tab.cookieStoreId : activeSpace.get(tab.windowId));
  const from = littles.get(tab.windowId) ?? tab.windowId;
  await openLittle(from, space ? { url, cookieStoreId: space } : { url }, space, tab.width);
}

// Where you chose, past any rule, and you stay where you are. A tab added to a small
// window would be a tab nobody can reach, so from there it goes to a normal window.
async function linkInSpace(tab, url, space) {
  if (!isWeb(url)) return;
  const win = await normalWindowFor(littles.get(tab.windowId) ?? tab.windowId);
  if (!win) { await browser.windows.create({ url, cookieStoreId: space }); return; }
  await openUnruled({ windowId: win.id, url, cookieStoreId: space, active: false, index: await topOfToday(win.id, space) });
  say(win.id, `Opened in ${await spaceName(space)}`);
}

// --- ⌥-click, with the access to all websites -----------------------------------------
// peek.js, in every page while the access is given, and in none otherwise. Firefox forgets
// a registered script at each start. One change at a time: a permission given also makes
// Tidier start its spaces again (spaces.js), and the two calls would each register one,
// of which only the last could be taken back.
const ALL_SITES = { origins: ["<all_urls>"] };
let peekScript = null, peekChange = Promise.resolve();
function startPeek() {
  peekChange = peekChange.then(async () => {
    const given = tidierAlone && await browser.permissions.contains(ALL_SITES).catch(() => false);
    if (given && !peekScript) peekScript = await browser.contentScripts.register({ matches: ["http://*/*", "https://*/*"], js: [{ file: "peek.js" }], runAt: "document_start" });
    else if (!given && peekScript) { await peekScript.unregister().catch(() => {}); peekScript = null; }
  }).catch(noteError);
  return peekChange;
}
browser.permissions.onAdded.addListener(() => { if (started) startPeek(); });
browser.permissions.onRemoved.addListener(() => { if (started) startPeek(); });

// --- Messages: the settings page's, and ⌥-click's -------------------------------------
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg?.type?.startsWith("little:") || sender.id !== browser.runtime.id) return;
  if (msg.type === "little:peek") {
    if (tidierAlone && sender.tab && !sender.tab.incognito) serial(() => linkInLittle(sender.tab, msg.url));
    return;
  }
  if (!sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return serial(async () => {
    if (msg.type === "little:set") littleSetting.set(!!msg.on);
    return { alone: tidierAlone, on: await littleSetting.get() };
  });
});

// --- When Tidier starts --------------------------------------------------------------
// Firefox brings a small window back after a restart, without its title's space, and
// Tidier starts again with an update while one is open: without this, either would be a
// window nothing can keep.
async function startLittleWindow() {
  if (!tidierAlone) return;
  startLittleMenus();
  await startPeek();
  for (const w of await browser.windows.getAll({ populate: true, windowTypes: ["popup"] })) await adoptLittle(w);
}

// One of these, by the mark it keeps through a restart: Keep works again, and the title has its space.
async function adoptLittle(win) {
  if (littles.has(win.id) || !await browser.sessions.getWindowValue(win.id, LITTLE_KEY).catch(() => undefined)) return;
  const [tab] = win.tabs ?? await browser.tabs.query({ windowId: win.id }).catch(() => []);
  littles.set(win.id, null);
  await browser.windows.update(win.id, { titlePreface: `${await spaceName(tab?.cookieStoreId) ?? "Tidier"} · ` }).catch(() => {});
  viewAllSoon();
}
