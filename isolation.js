// Isolation (Tidier alone): a space is a container, with logins of its own, and
// nothing ever goes out in the wrong one. It should be something nobody has to think
// about, so nearly all of it has no face; what has one is on the settings page
// (settings/spaces.js) and in the menus (sidebar/isolation.js).
//
//   1. Every top-level request is looked at before it leaves. A web page outside any
//      container, or one a rule sends elsewhere, is stopped and opened in the right
//      place. Without the permission (it is optional, so no update ever waits for a
//      click) spaces.js reopens the tab afterwards, as it always did: then the first
//      request has gone out in the wrong container.
//   2. A space can have a proxy and a user agent of its own.
//   3. Signing out: one site's cookies in a space, or everything in a space.
//   4. New, edited and deleted spaces, so Firefox's container settings aren't needed.
//   5. A container that vanished behind Tidier's back comes back.
//   6. A copy of a tab, and a whole folder, to another space.
//
// Nothing here contacts anyone by itself, and with nothing happening nothing runs.

// --- 1. No request in the wrong container ------------------------------------------
const ISOLATION_PERMISSIONS = { permissions: ["webRequest", "webRequestBlocking"], origins: ["<all_urls>"] };
const AT_START = "isolationAtStart"; // localStorage: what must already work while Firefox starts, see below
const REOPEN_LIMIT_MS = 5000; // a tab Firefox never finishes creating must not hold a request for ever
const BY_HAND_MS = 5000;

// Where a page belongs: the container to open it in, or null to leave it where it is.
// Decides from what it is given, so all of it can be tested without a Firefox.
//   url          the address asked for
//   tab          { cookieStoreId, url, incognito }; its url is what it shows now
//   originUrl    who asked: empty for typed, a bookmark, another app. A page, or an
//                extension's own page, gives its address.
//   firstPage    the tab has not shown a web page yet
//   redirect     a hop of a request already under way
//   popup        the tab is in a window that is not a normal one
//   rules        [{ url, space }]
//   activeSpace  the space you are in
//   exempt       opened by hand into its space, or an essential: no rule may send it away
//
// A page outside any container goes to a space, always: with Tidier alone no web page is
// ever loaded outside one, so no login can land there. To the rule's if one matches, else
// the active one.
//
// In a space, a rule counts only for what you chose yourself: a tab's first page, or a
// navigation nobody's page asked for. A link followed inside a page and a redirect do not,
// so a sign-in passing through an address does not move your tab (with Sidebery's rules it
// did: README). The same address again, with no page asking, is a reload or Firefox
// restoring the tab, and you chose neither. A popup is a sign-in talking to the page that
// opened it, which moving it would break.
//
// Never a loop: whatever this returns, the same address then stays there.
function whereItBelongs({ url, tab, originUrl, firstPage, redirect = false, popup = false, rules = [], activeSpace, exempt = false }) {
  if (!isWeb(url) || tab.incognito) return null;
  const here = tab.cookieStoreId;
  const chosen = here === NO_CONTAINER || (!redirect && !exempt && !popup && (firstPage || (!originUrl && tab.url !== url)));
  const rule = chosen ? rules.find(r => r.space !== NO_CONTAINER && ruleMatches(r.url, url)) : null;
  if (rule) return rule.space === here ? null : rule.space;
  return here === NO_CONTAINER ? activeSpace ?? null : null;
}

// A tab opened by hand into a space (moved there, a copy, undo) has a first page like
// any new tab, and a rule would send it straight back. The request can arrive before
// tabs.create has answered, so there is no tab id to mark yet: what is marked is the
// address in that container, for the moment the tab takes to start loading. One mark per
// tab: two tabs with the same address moved together are both yours. This wraps
// openUnruled from safemoves.js, which does the same for the path without the permission.
const byHand = new Map(); // "container address" -> { tabs still to come, until when }
const handKey = (space, url) => `${space} ${String(url).split("#")[0]}`;
function markByHand({ cookieStoreId, url }) {
  if (!url) return;
  const now = Date.now();
  for (const [key, mark] of byHand) if (mark.until < now) byHand.delete(key);
  try {
    const key = handKey(cookieStoreId, new URL(url).href);
    byHand.set(key, { tabs: (byHand.get(key)?.tabs ?? 0) + 1, until: now + BY_HAND_MS });
  } catch (err) { /* not an address */ }
}
function takeByHand(space, url) {
  const key = handKey(space, url), mark = byHand.get(key);
  if (!mark) return false;
  if (--mark.tabs < 1) byHand.delete(key);
  return mark.until >= Date.now();
}

// Addresses a rule sends elsewhere but where this tab was allowed to be: a sign-in it
// passed through in a redirect, a page you moved here by hand. Going back to one, Firefox
// asks again with no page's name on it, just as for an address you type, and the tab must
// not leave for it. (A link followed inside a page keeps that page's name when you go
// back, so it needs nothing here.) Only until Firefox restarts: then a tab's history is
// not known here, and going back through such an address opens it in its space.
const settled = new Map(); // tabId -> addresses
const SETTLED_PER_TAB = 20;
const withoutFragment = url => String(url).split("#")[0];
function settle(tabId, url) {
  const here = settled.get(tabId) ?? settled.set(tabId, new Set()).get(tabId);
  here.add(withoutFragment(url));
  if (here.size > SETTLED_PER_TAB) here.delete(here.values().next().value);
}
const isSettled = (tabId, url) => !!settled.get(tabId)?.has(withoutFragment(url));
const opensUnruled = globalThis.openUnruled;
globalThis.openUnruled = props => {
  markByHand(props);
  return opensUnruled(props);
};

const requestOfTab = new Map(); // tabId -> its latest top-level request: a redirect has the same one
const reopening = new Set(); // tabs being opened elsewhere: more of their requests are stopped too
const leaving = new Set(); // tabs replaced by a new one, waiting in the queue to close: the same, or there would be two
let guarding = false;
const requestsGuarded = () => guarding; // spaces.js: then the tab need not be reopened afterwards

// A rule that can do anything: it says where, and that space is there. A rule for a
// container that is gone counts for nothing (spaces.js, here). It may come back at the
// next start (bringBackSpaces); until then the address goes where it would without one.
// Nor does one for a space hidden on this machine, which gets no tabs here: the address
// opens in the space you are in, and the sidebar says why (sayIfRuleGone, hiddenspaces.js).
let knownSpaces = null; // containers Firefox has; null: not read yet
const ruleCounts = r => typeof r?.url === "string" && !!r.url && !!r.space && r.space !== NO_CONTAINER && (!knownSpaces || knownSpaces.has(r.space)) && !isHiddenSpace(r.space);
const spaceIsThere = id => !!id && id !== NO_CONTAINER && (!knownSpaces || knownSpaces.has(id));

// A page can send its own tab on with no name on the request (a frame with sandbox and
// allow-top-navigation does), which looks just like an address you type. Two such pages
// under two rules would send each other from space to space for ever, with a new tab each
// time and taking you along. Nobody types this fast, so after a few the tab stays.
const TYPED_MOVES = 3, TYPED_MOVES_MS = 10000;
let typedMoves = [];
function typedTooFast() {
  const now = Date.now();
  typedMoves = typedMoves.filter(when => when > now - TYPED_MOVES_MS);
  if (typedMoves.length >= TYPED_MOVES) return true;
  typedMoves.push(now);
  return false;
}

// The listener. Every page in every tab waits for what this says, so whatever else
// happens it must answer: an API that stops answering while Firefox starts, or an error
// here, would otherwise mean no page loads anywhere, with no sign of why. Far above
// any real wait, and the timer only runs while a request is being looked at.
const GUARD_LIMIT_MS = 10000;
function beforeTopLevelRequest(details) {
  const look = { given: false };
  let timer;
  const limit = new Promise(resolve => { timer = setTimeout(() => { look.given = true; resolve({}); }, GUARD_LIMIT_MS); });
  // (A page with no container that gets through either way is moved once it shows: notLookedAt.)
  const answer = lookAtRequest(details, look).catch(err => { noteError(err); return {}; });
  return Promise.race([answer, limit]).finally(() => clearTimeout(timer));
}

// A page whose request this listener never saw. Firefox hides those to its own restricted
// addresses from every extension (addons.mozilla.org, accounts.firefox.com and the like),
// and for a moment during an update nothing is listening. All that can be seen is the
// address showing up in a tab, too late to stop it, but a page left outside any space
// would stay there for good, and its next login with it. So it is moved as soon as it
// shows, as without the permission. (spaces.js, from tabs.onUpdated.) Only while it
// loads: a tab Firefox restores unloaded takes on its address too, and sends nothing until
// it is selected, when it is stopped like any other.
const notLookedAt = (tabId, tab, wasFirstPage) => tidierAlone && tab.status === "loading" && !tab.discarded && !tab.incognito &&
  (tab.cookieStoreId === NO_CONTAINER || (wasFirstPage && !requestOfTab.has(tabId)));
async function moveShown(tabId, url, wasFirstPage) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab && !reopening.has(tabId)) await moveOutOfPlace(tab, url, wasFirstPage);
}
async function moveOutOfPlace(tab, url, wasFirstPage = false) {
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  const popup = !!win && win.type !== "normal";
  const home = tab.cookieStoreId === NO_CONTAINER ? await homeOf(tab) : null;
  const rules = home?.inFolder ? [] : (await rulesList.get()).filter(ruleCounts);
  const space = whereItBelongs({ url, tab, firstPage: wasFirstPage, popup, rules, activeSpace: home?.space });
  if (!space) return;
  reopening.add(tab.id); // a request it makes meanwhile is stopped too
  try {
    await openElsewhere(tab, url, space, popup, wasFirstPage);
  } finally {
    reopening.delete(tab.id);
  }
}

// This runs for every top-level navigation, and the request waits for it, so a tab in
// the right container passes after nothing but a look at the rules. A tab is only
// looked up when it may have to move. Never through the queue, which can be busy for
// seconds. (Sub-resources and frames are not even sent here: see the filter.)
async function lookAtRequest(details, look) {
  await isolationKnown;
  const { tabId, requestId, url, cookieStoreId: here } = details;
  if (!tidierAlone || tabId < 0 || details.incognito || !isWeb(url)) return {};
  const redirect = requestOfTab.get(tabId) === requestId;
  requestOfTab.set(tabId, requestId);
  if (reopening.has(tabId) || leaving.has(tabId)) return { cancel: true };
  const rules = await rulesList.get();
  if (here !== NO_CONTAINER) {
    const rule = rules.find(r => ruleCounts(r) && ruleMatches(r.url, url)); // the first that matches decides
    if (!rule || rule.space === here) return {};
    if (redirect) { settle(tabId, url); return {}; }
    // (A form sent to a new tab cannot be sent again from another tab, so no rule takes it.)
    if ((details.method ?? "GET") !== "GET" || isSettled(tabId, url)) return {};
  }

  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return {};
  const win = await browser.windows.get(tab.windowId).catch(() => null);
  const popup = !!win && win.type !== "normal";
  // ⌘⇧T brings a tab back on about:blank with its Tidier values: it is not a new tab.
  const firstPage = !isWeb(tab.url) && !isGhostUrl(tab.url) && !syncKeyByTab.has(tabId) &&
    !(await browser.sessions.getTabValue(tabId, SYNC_KEY).catch(() => undefined));
  const home = here === NO_CONTAINER ? await homeOf(tab) : null;
  const byHandNow = !tab.pinned && takeByHand(here, url);
  if (byHandNow) settle(tabId, url);
  const space = whereItBelongs({
    url, tab: { ...tab, cookieStoreId: here }, originUrl: details.originUrl, firstPage, redirect, popup, rules: home?.inFolder ? [] : rules.filter(ruleCounts),
    activeSpace: home?.space, exempt: tab.pinned || byHandNow,
  });
  if (!space) return {};
  // The tab has moved on to another address meanwhile (Enter pressed twice): Firefox has
  // dropped this request, and opening it would only give you the page twice.
  if (look.given || requestOfTab.get(tabId) !== requestId) return {};
  if (here !== NO_CONTAINER && !firstPage && typedTooFast()) {
    settle(tabId, url); // for good: such a page goes on asking, and must not get a tab out once the time is up
    say(tab.windowId, "A page kept sending this tab to other spaces, so it stays here");
    return {};
  }
  // A link from another app that a rule sends elsewhere goes to its small window there (littlewindow.js).
  if (littleTakes(tabId, url)) return { cancel: true };
  reopening.add(tabId);
  try {
    if (await openElsewhere(tab, url, space, popup)) return { cancel: true };
  } finally {
    reopening.delete(tabId);
  }
  // It could not be opened there, and is still not sent from here: a page that has no
  // container is where a login must not land, and this space's login must not go to an
  // address that belongs to another. (A rule whose space is gone counts for nothing, so
  // this is a Firefox refusing for a moment, not an address that can never load.) The
  // address goes with what is said, since it is then nowhere else.
  say(tab.windowId, here === NO_CONTAINER ? `This could not be opened in a space, so it was not loaded: ${url}` : `This could not be opened in its space, so it was not loaded: ${url}`);
  return { cancel: true };
}

// The space you are in. Also while Firefox is still starting and Tidier has not read
// the window's space yet: the tab Firefox restores can load before that. Never one that
// has gone: opening in it is refused, and the page would not load at all.
async function spaceToOpenIn(tab) {
  // Its own window's first, also when that has not been read yet and another's has: going by
  // the other window here would give a page that window's space, and its login.
  const kept = await browser.sessions.getWindowValue(tab.windowId, SPACE_KEY).catch(() => undefined);
  const known = [activeSpace.get(tab.windowId), kept, activeSpace.get(focusedWindowId), ...activeSpace.values()].find(spaceIsThere);
  if (known) return known;
  const tabs = await browser.tabs.query({ windowId: tab.windowId });
  const used = new Set([...(await getList()).map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
  activeSpace.delete(tab.windowId);
  return spaceOf(tab.windowId, tabs, await spaceList(used));
}

// Where a tab with no container belongs when no rule says: with its folder, if it is in
// one (Sidebery's spaces can hold tabs with no container, and moving over keeps them
// there), else the space you are in.
async function homeOf(tab) {
  const all = await getSynced();
  const folderSpace = all[folderKeyOf(all, await recordKeyOf(tab.id))]?.cookieStoreId;
  return spaceIsThere(folderSpace) ? { space: folderSpace, inFolder: true } : { space: await spaceToOpenIn(tab) };
}

// In the same place, with the same selection. Only a tab holding nothing is closed, and
// only once the new one is there. A tab in a space showing a page or standing for one
// (a saved tab, one in a folder, a placeholder, any page with its history) stays as it
// was: what you asked for opens in its space, and what you had isn't lost for it. A tab
// outside any container can't stay, so what it is goes with it (recordIntoSpace). A first
// page that showed before it could be stopped (moveOutOfPlace) leaves too: it holds nothing
// else. Returns whether it worked.
async function openElsewhere(tab, url, space, popup, leaves = false) {
  if (tab.pinned && await essentialIntoSpace(tab, space)) return true;
  const opening = placeOfReopened(tab, space).then(index => openIn(tab, url, space, popup, index));
  let timer;
  const created = await Promise.race([
    opening,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), REOPEN_LIMIT_MS); }),
  ]).catch(() => null);
  clearTimeout(timer);
  const stays = !leaves && tab.cookieStoreId !== NO_CONTAINER && (syncKeyByTab.has(tab.id) || isWeb(tab.url) || isGhostUrl(tab.url));
  if (!created) {
    // Too late to count, but it may still come. The request has been stopped, so then
    // this is the page: it is kept, and the old tab goes if it would have.
    opening.then(late => { if (late?.id && !stays) return closeOldTab(tab, late, space); }).catch(() => {});
    return false;
  }
  await littleAfterReopen(tab, created); // littlewindow.js: Firefox's mark on a link from another app comes after this request
  if (!stays) await closeOldTab(tab, created, space);
  newTabs.delete(tab.id); // only now: until it has gone, no view draws it (reopensSoon, newtabs.js)
  return true;
}

// What a tab is in the record. A tab Firefox restores can ask for its page while Tidier is
// still starting, before the map has been read: it would be taken for a new tab, and come
// back as a placeholder as well.
const recordKeyOf = async tabId => syncKeyByTab.get(tabId) ?? await browser.sessions.getTabValue(tabId, SYNC_KEY).catch(() => undefined);

async function closeOldTab(tab, created, space) {
  const key = await recordKeyOf(tab.id);
  // A tab Tidier knows has placeholders in other windows and a record, which only the
  // queue may change. One it doesn't know yet (nearly all of them: this is its first
  // page) is simply closed, now, so you don't see it hanging around.
  if (!key) return browser.tabs.remove(tab.id).catch(() => {});
  // Now, not in the queue: or the new tab would be taken for a new one there.
  if (created.id) await setRole(created.id, key, "live").catch(noteError);
  leaving.add(tab.id);
  serial(() => recordIntoSpace(key, created, space)).catch(() => {}).finally(() => leaving.delete(tab.id));
}

// A tab with a record, reopened from outside any container: the same tab, in a space. It
// keeps its key, so it stays in its folder with its saved address, and each other window
// gets its placeholder in the new container, in the same place and with the same
// selection, before the old one goes: closing a window's last tab would close the window.
async function recordIntoSpace(key, created, space) {
  // Its copies in two windows can both load at once, and each asks here. The first one
  // to get here closes the other's new tab along with the rest, and that is the end of it.
  if (created.id && !await browser.tabs.get(created.id).catch(() => null)) return;
  if (!started) await loadRoles(); // (at a start this can come first in the queue)
  const all = await getSynced();
  if (all[key]) {
    all[key].cookieStoreId = space;
    saveSynced(all);
  }
  const old = repsOf(key, await browser.tabs.query({})).filter(t => t.id !== created.id);
  old.forEach(t => { syncBusy.add(t.id); forget(t.id); });
  const perWindow = new Map();
  for (const t of old) if (t.windowId !== created.windowId && (t.active || !perWindow.has(t.windowId))) perWindow.set(t.windowId, t);
  for (const t of all[key] ? perWindow.values() : []) {
    const rep = await createRep(t.windowId, key, all[key], undefined, t.index).catch(noteError);
    if (rep && t.active) await browser.tabs.update(rep.id, { active: true }).catch(() => {});
  }
  await browser.tabs.remove(old.map(t => t.id)).catch(() => {});
  await forgetClosedPlaceholders("ghost", [key]);
}

// An essential, or a tab with a record that comes out of no container, is the same tab in
// a space, so it stays where it was. Anything else is a page arriving in that space, for
// which there is one place (newtabs.js): the window's order says nothing about what is
// drawn, so next to the old tab can be anywhere, or at the end, below a long list.
async function placeOfReopened(tab, space) {
  if (tab.pinned || (tab.cookieStoreId === NO_CONTAINER && await recordKeyOf(tab.id))) return tab.index + 1;
  return indexWhenReopened(tab, space);
}

async function openIn(tab, url, space, popup, index) {
  if (!popup) return browser.tabs.create({ windowId: tab.windowId, cookieStoreId: space, url, active: tab.active, index, ...(tab.pinned ? { pinned: true } : {}) });
  // A popup window takes no second tab: the page goes to the normal window you were using.
  const wins = await normalWindows();
  const win = wins.find(w => w.id === focusedWindowId) ?? wins[0];
  if (win) return browser.tabs.create({ windowId: win.id, cookieStoreId: space, url, active: true, index: await topOfToday(win.id, space) });
  return browser.windows.create({ cookieStoreId: space, url }).then(made => made.tabs?.[0] ?? made);
}

// An essential with no container: from before Tidier alone, say. It cannot stay what it
// is, or its login lands outside every space, so it becomes an essential of the space
// you are in, in every window, and the copy you were opening opens there. Its copies in
// two windows can both load at once (Firefox restoring them), and each asks here.
async function essentialIntoSpace(tab, space) {
  const key = await keyOf(tab);
  if (!key || !(await getList()).some(e => e.key === key)) return false;
  serial(() => moveEssentialIntoSpace(key, space));
  return true;
}
async function moveEssentialIntoSpace(key, space) {
  const list = await getList();
  const entry = list.find(e => e.key === key);
  if (entry?.cookieStoreId !== NO_CONTAINER) return; // the other window's copy got here first
  entry.cookieStoreId = space;
  setList([...list]);
  const old = await copiesOf(key);
  const selected = new Set(old.filter(t => t.active).map(t => t.windowId));
  // Unmarked first, so that each window counts it as missing and gets a new copy
  // before the old one goes: closing a window's last tab would close the window.
  for (const t of old) { busy.add(t.id); keyByTab.delete(t.id); await browser.sessions.removeTabValue(t.id, TAB_KEY).catch(() => {}); }
  await ensureAllWindows();
  for (const copy of await copiesOf(key)) if (selected.has(copy.windowId)) await browser.tabs.update(copy.id, { active: true }).catch(() => {});
  await browser.tabs.remove(old.map(t => t.id)).catch(() => {});
  await forgetClosedPlaceholders("essential", [key]);
}

// The listener must be added while the background page loads, or a request made while
// Firefox starts is not held for it. Firefox holds those for a blocking listener it
// remembers from last time (webRequest is "startup blocking"), but it only remembers one
// that was added while the page was loading, and forgets it if it isn't back by then.
// That is a link from another app with Firefox closed: the very request this is for.
// Reading whether Tidier alone is on takes longer than that, so what was true last time
// is kept where it can be read at once. So a permission given while Tidier runs holds
// requests from the second start after it, and in the first one a page that slipped
// through is moved as soon as Tidier has started (moveStragglers). Moving over reloads
// the page, so it is there from the first (guardAfterReload).
function guardRequests() {
  if (guarding || !browser.webRequest?.onBeforeRequest) return;
  browser.webRequest.onBeforeRequest.addListener(beforeTopLevelRequest, { urls: ["<all_urls>"], types: ["main_frame"] }, ["blocking"]);
  guarding = true;
}
function unguardRequests() {
  if (guarding) browser.webRequest?.onBeforeRequest.removeListener(beforeTopLevelRequest);
  guarding = false;
}
browser.tabs.onRemoved.addListener(tabId => { requestOfTab.delete(tabId); settled.delete(tabId); });

async function guardAfterReload() {
  if (!await browser.permissions.contains?.(ISOLATION_PERMISSIONS).catch(() => false)) return;
  try { localStorage.setItem(AT_START, JSON.stringify({ guard: true, network: networkNow })); } catch (err) { /* then from the next start */ }
}

// A web page already loaded outside any space when Tidier starts: it got there before
// anything could stop it, with no login, since those are all in spaces, and it must not
// stay there, where its next login would land. Only what is loaded: an unloaded tab is
// stopped when it loads. A pinned one too: Firefox loads those at once when it restores
// them, so it is the likeliest to have got out, and it never navigates by itself.
async function moveStragglers() {
  if (!tidierAlone) return;
  for (const tab of await browser.tabs.query({ cookieStoreId: NO_CONTAINER })) {
    if (tab.incognito || tab.discarded || !isWeb(tab.url) || reopening.has(tab.id)) continue;
    await moveOutOfPlace(tab, tab.url);
  }
}

// --- 2. A space's own network and identity -----------------------------------------
// Set on the settings page. Nothing runs unless a space has one set. A proxy is `proxy`
// and the host permission; a user agent is the same permissions as above.
const spaceNetwork = storedValue("spaceNetwork", () => ({})); // { [container]: { proxy: { type, host, port }, userAgent } }
let networkNow = {}; // the same, for listeners that must answer at once
let startingAlone = false; // last time Tidier alone was on, and whether it still is has not been read yet
const PROXY_TYPES = ["http", "https", "socks", "socks4"];

// What was typed, as Firefox wants it, or null: Firefox rejects a bad one at each
// request and then goes direct, which is the last thing you would want from a proxy.
function cleanProxy(proxy) {
  const { type } = proxy ?? {}, host = String(proxy?.host ?? "").trim(), port = Number(proxy?.port);
  if (!PROXY_TYPES.includes(type) || !host || /[\s/:@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { type, host, port };
}

// SOCKS: names are looked up by the proxy too, or your own DNS sees where you go.
function proxyFor(details) {
  const proxy = networkNow[details.cookieStoreId]?.proxy;
  return proxy ? { ...proxy, ...(proxy.type.startsWith("socks") ? { proxyDNS: true } : {}) } : undefined;
}

// Firefox decides on a proxy as it opens a request, and at a start it opens the tabs it
// restores before any extension has run. The listeners are there in time to hold such a
// request, but too late for that decision: it would go out directly, with your own
// address, from the very space that has a proxy so that it doesn't. So a page's request
// says, just before anything is sent, how it is going, and if that is past the proxy it
// is stopped and asked for again, which now goes the right way. Only pages: whatever a
// page then asks for is opened with the proxy in place. An address on this machine never
// goes through a proxy (Firefox's rule), and asking once is enough: more would be a loop.
const ASK_AGAIN_MS = 5000;
const askedAgain = new Set();
const onThisMachine = url => /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(url).hostname);
function notPastProxy(details) {
  const proxy = networkNow[details.cookieStoreId]?.proxy;
  if (!proxy || onThisMachine(details.url) || (details.proxyInfo?.host === proxy.host && details.proxyInfo.port === proxy.port)) return undefined;
  const { tabId, url } = details;
  if (tabId >= 0 && !askedAgain.has(tabId)) {
    askedAgain.add(tabId);
    setTimeout(() => browser.tabs.update(tabId, { url, loadReplace: true }).catch(() => {}), 0); // once this one has gone
    setTimeout(() => askedAgain.delete(tabId), ASK_AGAIN_MS);
  } else if (tabId >= 0) {
    browser.tabs.get(tabId).then(tab => say(tab.windowId, `This could not go through its space's proxy, so it was not loaded: ${url}`)).catch(() => {});
  }
  return { cancel: true };
}

// A page's scripts can still read the real one (navigator.userAgent): an extension can
// only change the header without touching every page. README says so.
function agentFor(details) {
  const agent = networkNow[details.cookieStoreId]?.userAgent;
  if (!agent) return undefined;
  const header = details.requestHeaders.find(h => h.name.toLowerCase() === "user-agent");
  if (header) header.value = agent;
  return { requestHeaders: details.requestHeaders };
}

// A tab's icon as the sidebar may fetch it. The sidebar is an extension's page, in no
// container and past every proxy, so a remote icon of a tab in a space with a proxy would
// show the site your own address at the moment the proxy hides it. Such a tab shows its
// first letter instead; an icon Firefox has inline costs no request.
// (The record's icon, for a page that has none at the moment, is as remote as the page's own.)
const iconForView = (t, entry) => {
  const icon = t.favIconUrl || (tidierAlone && entry?.icon) || null;
  return networkNow[t.cookieStoreId]?.proxy && isWeb(icon) ? null : icon;
};

// Adds and removes the listeners to match what is set: added only for as long as a
// space has one. One a space asks for but cannot have is said, never silently ignored:
// you would think you were behind a proxy.
function applyNetwork() {
  const all = Object.values(tidierAlone || startingAlone ? networkNow : {});
  const wantsProxy = all.some(n => n.proxy), wantsAgent = all.some(n => n.userAgent);
  const proxyEvent = browser.proxy?.onRequest, agentEvent = browser.webRequest?.onBeforeSendHeaders;
  if (agentEvent) {
    if (wantsProxy && !agentEvent.hasListener(notPastProxy)) agentEvent.addListener(notPastProxy, { urls: ["<all_urls>"], types: ["main_frame"] }, ["blocking"]);
    if (!wantsProxy && agentEvent.hasListener(notPastProxy)) agentEvent.removeListener(notPastProxy);
  }
  if (proxyEvent) {
    if (wantsProxy && !proxyEvent.hasListener(proxyFor)) proxyEvent.addListener(proxyFor, { urls: ["<all_urls>"] });
    if (!wantsProxy && proxyEvent.hasListener(proxyFor)) proxyEvent.removeListener(proxyFor);
  }
  if (agentEvent) {
    if (wantsAgent && !agentEvent.hasListener(agentFor)) agentEvent.addListener(agentFor, { urls: ["<all_urls>"] }, ["blocking", "requestHeaders"]);
    if (!wantsAgent && agentEvent.hasListener(agentFor)) agentEvent.removeListener(agentFor);
  }
  if (!tidierAlone) return;
  const missing = (wantsProxy || wantsAgent) && (!hostsGiven || (wantsProxy && !proxyEvent) || !agentEvent);
  setNotice("spaceNetwork", missing ? "A space's proxy or user agent is not in use: Tidier no longer has the permission for it. It can be given on the settings page." : null);
}

function rememberForStart() {
  try {
    if (tidierAlone && (guarding || Object.keys(networkNow).length)) localStorage.setItem(AT_START, JSON.stringify({ guard: guarding, network: networkNow }));
    else localStorage.removeItem(AT_START);
  } catch (err) { /* private storage off: then these start a moment later */ }
}

async function setSpaceNetwork(id, { proxy, userAgent }) {
  const all = await spaceNetwork.get();
  const clean = cleanProxy(proxy), agent = String(userAgent ?? "").trim();
  if (clean || agent) all[id] = { ...(clean ? { proxy: clean } : {}), ...(agent ? { userAgent: agent } : {}) };
  else delete all[id];
  spaceNetwork.set({ ...all });
  networkNow = await spaceNetwork.get();
  applyNetwork();
  rememberForStart();
  return all[id] ?? {};
}

// --- Starting ----------------------------------------------------------------------
// While the page loads, before anything has been read: see guardRequests.
try {
  const atStart = JSON.parse(localStorage.getItem(AT_START) || "null");
  if (atStart) {
    startingAlone = true;
    networkNow = atStart.network ?? {};
    if (atStart.guard) guardRequests();
    applyNetwork();
  }
} catch (err) { /* then they start a moment later */ }

async function startIsolation() {
  await readAlone();
  startingAlone = false;
  if (!tidierAlone) return stopIsolation();
  await readSpaces();
  networkNow = await spaceNetwork.get();
  hostsGiven = !!await browser.permissions.contains?.({ origins: ["<all_urls>"] }).catch(() => false);
  if (await browser.permissions.contains?.(ISOLATION_PERMISSIONS).catch(() => false)) guardRequests();
  else unguardRequests();
  applyNetwork();
  rememberForStart();
  await rememberSpaces();
  addToCommandBar();
}
async function readSpaces() {
  // Containers turned off in Firefox: there is nothing a rule or a tab could go to.
  knownSpaces = new Set((await identities().catch(() => [])).map(c => c.cookieStoreId));
}
function stopIsolation() {
  unguardRequests();
  networkNow = {};
  applyNetwork();
  try { localStorage.removeItem(AT_START); } catch (err) { /* nothing was kept then */ }
}
const isolationKnown = startIsolation().catch(noteError);
for (const event of ["onAdded", "onRemoved"]) browser.permissions[event].addListener(() => { isolationKnown.then(startIsolation).catch(noteError); viewAllSoon(); });

// --- 3. Signing out ----------------------------------------------------------------
// This site's cookies in a space. There is no list of what a site is that an extension
// can read, and a guess would clear every .co.uk site at once: so the site is the widest
// domain any cookie sent to this address is set for, which Firefox has checked. Its
// siblings go too (mail.example.com and example.com are one login).
const COOKIE_ALL = { firstPartyDomain: null, partitionKey: {} }; // every partition: Firefox otherwise hides what a page's frames set
let hostsGiven = false; // without access to all websites, the cookies API shows nothing

function widestDomain(host, cookieDomains) {
  return [host, ...cookieDomains.map(d => d.replace(/^\./, "")).filter(d => host === d || host.endsWith("." + d))]
    .sort((a, b) => a.length - b.length)[0];
}

const cookieUrl = c => `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;

async function clearSiteCookies(tabId, windowId) {
  const found = await addressOfTab(tabId);
  if (!found) return { cleared: 0 };
  const { url, space } = found;
  const storeId = space;
  const sent = await browser.cookies.getAll({ ...COOKIE_ALL, storeId, url });
  const site = widestDomain(new URL(url).hostname, sent.map(c => c.domain));
  const cookies = await browser.cookies.getAll({ ...COOKIE_ALL, storeId, domain: site });
  const key = c => ({ url: cookieUrl(c), name: c.name, storeId, firstPartyDomain: c.firstPartyDomain, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) });
  await Promise.all(cookies.map(c => browser.cookies.remove(key(c)).catch(noteError)));
  // Undo instead of asking: cookies can simply be put back.
  const undo = () => Promise.all(cookies.map(c => browser.cookies.set({
    ...key(c), value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    ...(c.hostOnly ? {} : { domain: c.domain }), ...(c.session ? {} : { expirationDate: c.expirationDate }),
  }).catch(noteError)));
  const name = (await containerSpaces()).find(s => s.id === space)?.name ?? "this space";
  say(windowId ?? found.tab.windowId, cookies.length ? `${site}'s cookies cleared in ${name}` : `${site} has no cookies in ${name}`, cookies.length ? { undo } : {});
  return { cleared: cookies.length, site, undo: cookies.length ? undo : null };
}

// Everything in a space, for every site. Firefox can do this for one container only with
// these kinds of data, and refuses the lot if asked for one it can't (localStorage,
// without its newer storage). A cache and service workers stay: they hold no login.
async function signOutSpace(id) {
  const kinds = { cookies: true, indexedDB: true, localStorage: true };
  await browser.browsingData.remove({ cookieStoreId: id }, kinds).catch(() => browser.browsingData.remove({ cookieStoreId: id }, { cookies: true, indexedDB: true }));
  return true;
}

// The real address behind a row or a tile: a placeholder's own says nothing.
async function addressOfTab(tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  let urls;
  if (tab.pinned) {
    const key = await keyOf(tab);
    urls = [(await copiesOf(key)).find(isLoadedCopy)?.url, (await getList()).find(e => e.key === key)?.url];
  } else {
    const key = syncKeyByTab.get(tabId), liveId = key ? liveTabId(key) : undefined;
    urls = [liveId === undefined ? null : (await browser.tabs.get(liveId).catch(() => null))?.url, key ? (await getSynced())[key]?.url : null];
  }
  const url = [...urls, tab.url].find(isWeb);
  return url ? { tab, url, space: tab.cookieStoreId } : null;
}

// --- 4. Spaces are managed in Tidier -----------------------------------------------
// Firefox's lists are per version (158 added colours and renamed some), so they are read
// from it where it can say, and a name this Firefox has no longer is simply not offered.
const OLD_COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple", "toolbar"];
const OLD_COLOR_CODES = { blue: "#37adff", turquoise: "#00c79a", green: "#51cd00", yellow: "#ffcb00", orange: "#ff9f00", red: "#ff613d", pink: "#ff4bda", purple: "#af51f5", toolbar: "#7c7c7d" };
const OLD_ICONS = ["fingerprint", "briefcase", "dollar", "cart", "circle", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"];

async function spaceLooks() {
  const api = browser.contextualIdentities;
  const colors = await api.getSupportedColors?.().catch(() => null);
  const icons = await api.getSupportedIcons?.().catch(() => null);
  return {
    colors: colors ?? OLD_COLORS.map(color => ({ color, colorCode: OLD_COLOR_CODES[color] })),
    icons: icons ?? OLD_ICONS.map(icon => ({ icon, iconUrl: `resource://usercontext-content/${icon}.svg` })),
  };
}

// The first colour and icon no space has, so a new space looks like itself at once.
function nextLook(spaces, colors, icons) {
  const free = (list, used) => list.find(x => !used.includes(x)) ?? list[spaces.length % list.length];
  return { color: free(colors, spaces.map(s => s.color)), icon: free(icons, spaces.map(s => s.icon)) };
}

// A container's data as Firefox has it (containerSpaces gives the colour's code only).
const identities = () => browser.contextualIdentities.query({});

async function newSpace(name) {
  const looks = await spaceLooks();
  const look = nextLook(await identities(), looks.colors.map(c => c.color), looks.icons.map(i => i.icon));
  return browser.contextualIdentities.create({ name: name?.trim() || "New space", ...look });
}

// A new space with these tabs in it: you stay where you are.
async function newSpaceWith(tabIds, windowId) {
  const space = await newSpace();
  await tabAction(windowId, { action: "space", tabIds, space: space.cookieStoreId }); // a row may be a placeholder; several go in order
  say(windowId, `Moved to ${space.name}. Its name can be changed in the space's menu`);
  return space.cookieStoreId;
}

// What goes with a space, to say before it goes.
async function spaceContents(id) {
  const all = Object.values(await getSynced());
  return {
    essentials: (await getList()).filter(e => e.cookieStoreId === id).length,
    folders: all.filter(e => e.cookieStoreId === id && isOwnFolder(e)).length,
    tabs: all.filter(e => e.cookieStoreId === id && !e.group).length,
  };
}

// Deleting a space. Asked first on the page, since it cannot be undone: its logins are
// gone with it. Its essentials and folders go in the copy first. What is in the record
// goes before its tabs close, or their close events would bring them back. You are
// taken out of it first: Firefox would otherwise select whatever it can show.
async function deleteSpace(id) {
  const others = (await containerSpaces()).filter(s => s.id !== id);
  if (!others.length) return { refused: "It is the only space." };
  for (const w of await normalWindows()) if (activeSpace.get(w.id) === id) await switchSpace(w.id, others[0].id);
  // A page with unsaved input would ask, in a tab you can't see, holding up the queue.
  // It stays then, and so does the space.
  const open = await browser.tabs.query({ cookieStoreId: id });
  for (const t of open) if (!t.discarded && !isGhostUrl(t.url) && !t.active) await browser.tabs.discard(t.id).catch(() => {});
  const refusing = (await browser.tabs.query({ cookieStoreId: id })).filter(t => !t.discarded && !isGhostUrl(t.url) && !NEW_TAB_PAGES.has(t.url) && !t.active);
  if (refusing.length) return { refused: refusing.length === 1 ? "A page in it holds unsaved input: " + refusing[0].title : `${refusing.length} pages in it hold unsaved input.` };

  const copy = await makeCopy();
  if (!copy?.saved) await browser.storage.local.set({ copyBeforeDelete: await theCopy() }); // no helper here: at least inside Firefox's storage
  await forgetSpace(id);
  await flushWrites();
  // Firefox does not close a container's tabs when it is removed by an extension.
  await browser.contextualIdentities.remove(id);
  return { deleted: true };
}

// What Tidier keeps about a space that no longer is: its essentials, folders, tabs,
// rules and settings, and any tab still open in it. Used for a space deleted here and
// one removed in Firefox's own settings. The record goes first, so that no tab's close
// event brings anything back.
//
// Each window in it goes to another space first, before its tabs close, and then its
// rules, folders and tabs go: spaceRemoved, safemoves.js. One handler for both, since
// Firefox gives no order between two listeners: a tab closed first under you would leave
// you on whatever tab Firefox picks, in no space.
async function forgetSpace(id) {
  await spaceRemoved(id);
  const list = await getList();
  const essentials = list.filter(e => e.cookieStoreId === id);
  if (essentials.length) {
    setList(list.filter(e => e.cookieStoreId !== id));
    const keys = new Set(essentials.map(e => e.key));
    const copies = (await browser.tabs.query({ cookieStoreId: id, pinned: true })).filter(t => keys.has(keyByTab.get(t.id)));
    copies.forEach(t => { busy.add(t.id); keyByTab.delete(t.id); });
    await browser.tabs.remove(copies.map(t => t.id)).catch(() => {});
    await forgetClosedPlaceholders("essential", [...keys]);
  }
  const network = await spaceNetwork.get();
  if (network[id]) { delete network[id]; spaceNetwork.set({ ...network }); networkNow = await spaceNetwork.get(); applyNetwork(); rememberForStart(); }
  const memory = await spaceMemory.get();
  if (memory[id]) { delete memory[id]; spaceMemory.set({ ...memory }); }
  const { spaceOrder } = await browser.storage.local.get("spaceOrder");
  if (spaceOrder?.includes(id)) await browser.storage.local.set({ spaceOrder: spaceOrder.filter(s => s !== id) });
  const left = await browser.tabs.query({ cookieStoreId: id });
  left.forEach(t => { syncBusy.add(t.id); forget(t.id); busy.add(t.id); keyByTab.delete(t.id); });
  await browser.tabs.remove(left.map(t => t.id)).catch(() => {});
}

// --- 5. A vanished container comes back --------------------------------------------
// Firefox's containers live in a file of their own: after "Refresh Firefox", or with that
// file lost, Tidier's essentials and folders point at containers that are not there, and
// Firefox refuses to open anything in them. So Tidier remembers each space's name, colour
// and icon, and at a start makes the container again, rewrites what points at it to the
// new id, and says so: with a new id the logins are gone.
// One you removed yourself while Tidier ran stays removed: that is forgotten at once.
const spaceMemory = storedValue("spaceMemory", () => ({})); // { [container]: { name, color, icon } }

async function rememberSpaces() {
  const memory = await spaceMemory.get();
  let changed = false;
  for (const c of await identities().catch(() => [])) {
    const look = { name: c.name, color: c.color, icon: c.icon };
    if (JSON.stringify(memory[c.cookieStoreId]) === JSON.stringify(look)) continue;
    memory[c.cookieStoreId] = look;
    changed = true;
  }
  if (changed) spaceMemory.set({ ...memory });
}

// The containers that are pointed at but not there. What you keep counts: essentials,
// folders and saved tabs. An ordinary tab or a rule counts only if the space is remembered:
// a tab left over, or a rule in Sidebery's export for a container removed long ago, is no
// reason for a space called "Space".
function vanishedSpaces({ essentials, record, rules, have, memory = {} }) {
  const pointedAt = [
    ...essentials.map(e => e.cookieStoreId),
    ...Object.values(record).filter(e => e.group || e.saved || memory[e.cookieStoreId]).map(e => e.cookieStoreId),
    ...rules.map(r => r.space).filter(id => memory[id]),
  ];
  return [...new Set(pointedAt)].filter(id => id && id !== NO_CONTAINER && !id.startsWith("firefox-private") && !have.has(id));
}

async function bringBackSpaces() {
  await startIsolation(); // what was read while the page loaded may have changed: managed storage is read again here too
  if (!tidierAlone) return;
  // Containers turned off in Firefox: not known whether anything is gone.
  const containers = await identities().catch(() => null);
  if (!containers) return;
  const have = new Set(containers.map(c => c.cookieStoreId));
  const list = await getList(), all = await getSynced(), rules = await rulesList.get(), memory = await spaceMemory.get();
  const gone = vanishedSpaces({ essentials: list, record: all, rules, have, memory });
  if (!gone.length) return;
  const map = new Map(), names = [];
  const number = id => Number(id.split("-").pop());
  for (const id of gone.sort((a, b) => number(a) - number(b))) {
    const look = { name: "Space", color: "blue", icon: "circle", ...memory[id] };
    // A colour or icon this Firefox doesn't know must not stop it coming back.
    const make = () => browser.contextualIdentities.create(look)
      .catch(() => browser.contextualIdentities.create({ name: look.name, color: "blue", icon: "circle" })).catch(noteError);
    let made = await make();
    // Firefox numbers containers anew when its file is lost, while the cookies stay under
    // their old numbers. Lowest first gives each its own number back where it can, with its
    // logins. A number that was another vanished space's would have that space's logins, so
    // it is removed again (which clears it), and one nobody remembers is cleared.
    while (made && made.cookieStoreId !== id && gone.includes(made.cookieStoreId)) {
      await browser.contextualIdentities.remove(made.cookieStoreId).catch(noteError);
      made = await make();
    }
    if (!made) continue;
    if (made.cookieStoreId !== id) await wipeContainer(made.cookieStoreId).catch(noteError);
    map.set(id, made.cookieStoreId);
    names.push(look.name);
    delete memory[id];
    memory[made.cookieStoreId] = look;
  }
  const moved = id => map.get(id) ?? id;
  setList(list.map(e => ({ ...e, cookieStoreId: moved(e.cookieStoreId) })));
  for (const e of Object.values(all)) e.cookieStoreId = moved(e.cookieStoreId);
  saveSynced(all);
  rulesList.set(rules.map(r => ({ ...r, space: moved(r.space) })));
  spaceMemory.set({ ...memory });
  const network = await spaceNetwork.get();
  for (const [from, to] of map) if (network[from]) { network[to] = network[from]; delete network[from]; }
  spaceNetwork.set({ ...network });
  networkNow = await spaceNetwork.get();
  applyNetwork();
  rememberForStart();
  await readSpaces();
  const { spaceOrder } = await browser.storage.local.get("spaceOrder");
  if (spaceOrder) await browser.storage.local.set({ spaceOrder: spaceOrder.map(moved) });
  await flushWrites();
  await tabsIntoNewContainers(map);
  setNotice("spaceBack", `${names.join(", ")} had gone from Firefox and ${names.length === 1 ? "has" : "have"} been made again, with ${names.length === 1 ? "its" : "their"} essentials and folders. You may have to sign in there again.`);
}

async function wipeContainer(id) {
  if (browser.browsingData) return signOutSpace(id);
  if (!hostsGiven) return;
  const cookies = await browser.cookies.getAll({ ...COOKIE_ALL, storeId: id });
  await Promise.all(cookies.map(c => browser.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: id, firstPartyDomain: c.firstPartyDomain, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) })));
}

// Tabs Firefox still has in a container it no longer knows (a session restored over a
// lost file): each is opened again in the new one, as what it was, or it would be out of
// reach of the sidebar and of every space.
async function tabsIntoNewContainers(map) {
  for (const [from, to] of map) {
    for (const t of await browser.tabs.query({ cookieStoreId: from }).catch(() => [])) {
      const [key, role, essential] = await Promise.all([SYNC_KEY, SYNC_ROLE, TAB_KEY].map(k => browser.sessions.getTabValue(t.id, k).catch(() => undefined)));
      // A page that wasn't selected stays unloaded; a page Firefox won't open by address (about:) opens as a new tab.
      const page = isWeb(t.url) ? { url: t.url, ...(t.active || t.pinned ? {} : { discarded: true, title: t.title }) } : isGhostUrl(t.url) ? { url: t.url } : {};
      const made = await browser.tabs.create({ windowId: t.windowId, cookieStoreId: to, active: t.active, index: t.index + 1, pinned: t.pinned, ...page }).catch(noteError);
      if (!made) continue;
      if (key && role) { syncBusy.add(made.id); await setRole(made.id, key, role); setTimeout(() => syncBusy.delete(made.id), SETTLE_MS); }
      if (essential) { busy.add(made.id); await tagTab(made.id, essential); setTimeout(() => busy.delete(made.id), SETTLE_MS); }
      syncBusy.add(t.id); busy.add(t.id); forget(t.id); keyByTab.delete(t.id);
      await browser.tabs.remove(t.id).catch(() => {});
    }
  }
}

// Your own changes, while Tidier runs. A start has already seen what was there before.
browser.contextualIdentities.onCreated.addListener(({ contextualIdentity }) => {
  knownSpaces?.add(contextualIdentity?.cookieStoreId);
  if (tidierAlone) serial(rememberSpaces);
});
browser.contextualIdentities.onUpdated.addListener(() => { if (tidierAlone) serial(rememberSpaces); });
browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) => {
  // At once, not in the queue: a request now must not go to a space that is gone.
  knownSpaces?.delete(contextualIdentity.cookieStoreId);
  if (tidierAlone) serial(() => forgetSpace(contextualIdentity.cookieStoreId));
});

// --- 6. A copy in another space, and a folder moved to one ----------------------------
// A copy: the same address opened there, and nothing closed. You stay where you are.
async function copyToSpace(tabIds, space, windowId) {
  let copies = 0;
  for (const id of tabIds) {
    const found = await addressOfTab(id);
    if (!found || found.space === space) continue;
    const opened = await openUnruled({ windowId: found.tab.windowId, cookieStoreId: space, url: found.url, active: false }).catch(() => null);
    if (opened) copies++;
  }
  const name = (await containerSpaces()).find(s => s.id === space)?.name ?? "that space";
  if (copies) say(windowId, copies === 1 ? `A copy is open in ${name}` : `${copies} copies are open in ${name}`);
  return copies;
}

// A folder to another space: a tab cannot change container, so each of its tabs is
// opened again there. As a placeholder under the same key, so it stays in its folder,
// keeps its saved address, and no page loads until you select it. A page with unsaved
// input stays behind, as an ordinary tab, and the line says so: closesQuietly finds out.
// You stay in the space you are in: the selected tab, if it is in the folder, first
// gives way to one that isn't, since Firefox never unloads a selected tab.
async function moveFolderToSpace(key, space, windowId) {
  const all = await getSynced();
  const folder = all[key];
  if (!isOwnFolder(folder) || folder.cookieStoreId === space) return { moved: 0, stayed: 0 };
  const inFolder = Object.keys(all).filter(k => folderKeyOf(all, k) === key);
  await leaveTabsOf(new Set(inFolder));
  let moved = 0, stayed = 0;
  const rank = (foldersOf(all, space).at(-1)?.rank ?? 0) + 1;
  const wins = await normalWindows();
  for (const k of inFolder) {
    if (!(await closesQuietly(k))) {
      all[k].parentKey = null;
      stayed++;
      continue;
    }
    all[k].cookieStoreId = space;
    const reps = repsOf(k, await browser.tabs.query({}));
    reps.forEach(t => { syncBusy.add(t.id); forget(t.id); });
    await browser.tabs.remove(reps.map(t => t.id)).catch(() => {});
    await forgetClosedPlaceholders("ghost", [k]);
    for (const w of wins) await createRep(w.id, k, all[k]).catch(noteError);
    moved++;
  }
  Object.assign(folder, { cookieStoreId: space, rank });
  noteSaved(all);
  saveSynced(all);
  await showSpaceEverywhere(); // foldrest.js: what came with a closed folder rests there, and what stayed behind shows here
  if (stayed) say(windowId, stayed === 1 ? "One tab holds unsaved input and stayed here" : `${stayed} tabs hold unsaved input and stayed here`);
  return { moved, stayed };
}

// Any selected tab that is one of these goes to the tab used last that isn't, else a
// new tab, in each window. A placeholder's row is no reason to load another: only tabs
// outside these count.
async function leaveTabsOf(keys) {
  const selected = await browser.tabs.query({ active: true });
  for (const tab of selected.filter(t => keys.has(syncKeyByTab.get(t.id)))) {
    const here = await browser.tabs.query({ windowId: tab.windowId, cookieStoreId: tab.cookieStoreId });
    const next = here.filter(t => !keys.has(syncKeyByTab.get(t.id))).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (next) await browser.tabs.update(next.id, { active: true }).catch(() => {});
    else await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: tab.cookieStoreId, active: true }).catch(noteError);
  }
}

// The command bar's table, where it is there (commandbar.js). Looked for once things
// have loaded, since the order of the scripts decides nothing then.
// (commandbar.js loads after this file; this runs once startIsolation has read storage, by then it is there.)
function addToCommandBar() {
  if (BAR_COMMANDS.some(c => c.name === "clear-site-cookies")) return;
  BAR_COMMANDS.push(
    { name: "clear-site-cookies", label: "Clear this site's cookies in this space",
      when: ctx => hostsGiven && ctx.picked.length === 1 && !!ctx.tab,
      run: ctx => clearSiteCookies(ctx.tab.id, ctx.windowId) },
    { name: "copy-to-space", label: "Open a copy in another space", when: ctx => ctx.picked.length > 0,
      list: ctx => ctx.spaces.filter(s => !ctx.picked.every(t => t.cookieStoreId === s.id)).map(s => ({ label: s.name, value: s.id, space: s.id })),
      placeholder: "Which space?",
      run: (ctx, space) => copyToSpace(ctx.picked.map(t => t.id), space, ctx.windowId) },
  );
}

// --- The settings page and the sidebar -------------------------------------------------
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg?.type?.startsWith("isolation:") || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return serial(() => isolationAction(msg));
});

async function isolationAction(msg) {
  switch (msg.type.slice("isolation:".length)) {
    case "get": {
      const network = await spaceNetwork.get();
      const spaces = await Promise.all((await identities().catch(() => [])).map(async c => ({
        id: c.cookieStoreId, name: c.name, color: c.color, colorCode: c.colorCode, icon: c.icon, iconUrl: c.iconUrl,
        network: network[c.cookieStoreId] ?? {}, contents: await spaceContents(c.cookieStoreId),
      })));
      return { spaces, looks: await spaceLooks(), guarding, proxyTypes: PROXY_TYPES };
    }
    case "new": return (await newSpace(msg.name)).cookieStoreId;
    case "edit": await browser.contextualIdentities.update(msg.id, msg.changes); return true;
    case "network": return setSpaceNetwork(msg.id, msg);
    case "signOut": return signOutSpace(msg.id);
    case "delete": return deleteSpace(msg.id);
    case "clearCookies": return { cleared: (await clearSiteCookies(msg.tabId, msg.windowId)).cleared };
    case "copy": return copyToSpace(msg.tabIds, msg.space, msg.windowId);
    case "moveFolder": return moveFolderToSpace(msg.key, msg.space, msg.windowId);
    case "newSpaceWith": return newSpaceWith(msg.tabIds, msg.windowId);
    case "seen": setNotice("spaceBack", null); return true;
  }
}
