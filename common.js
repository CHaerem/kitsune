// Shared helpers for essentials.js and tabsync.js.

// All changes run one after another, so two events never race each other
// into duplicate tabs. Both features share this one queue.
//
// One job that never ends would stop everything after it, until Firefox restarts
// (a tab Firefox never finishes creating, say), so a job has a time limit. It is
// far above any real job: past it the next job can overlap with this one.
const JOB_LIMIT_MS = 5 * 60000;
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(async () => {
    const t0 = performance.now();
    work.jobs++;
    let limit;
    try {
      return await Promise.race([fn(), new Promise((_, reject) => {
        limit = setTimeout(() => reject(new Error("a job did not finish within the time limit")), JOB_LIMIT_MS);
      })]);
    } finally {
      clearTimeout(limit);
      const ms = performance.now() - t0;
      work.queueMs += ms;
      work.longestJobMs = Math.max(work.longestJobMs, ms);
    }
  });
  queue = run.catch(err => noteError(err, fn));
  return run;
}

// Errors inside Tidier. Firefox only shows them in a console nobody looks at,
// so they are also kept for the smoke test ("stats" in tabsync.js), which fails
// on any: an error there is a tab that was not handled.
const problems = [];
function noteError(err, job) {
  console.error("Tidier:", err);
  work.errors++;
  // Where it happened, shortly: a message alone does not say which of many calls it was.
  // Firefox's own refusals have no stack, so the job they stopped says it instead.
  const where = String(err?.stack ?? "").split("\n").filter(Boolean).slice(0, 3).map(f => f.replace(/@.*\//, " ").replace(/:\d+$/, "")).join(" < ")
    || String(job ?? "").replace(/\s+/g, " ").slice(0, 80);
  problems.push(String(err?.message ?? err) + (where ? ` (${where})` : ""));
  if (problems.length > 20) problems.shift();
}
globalThis.addEventListener?.("unhandledrejection", event => noteError(event.reason));

// How much Tidier does, for the smoke test (the "stats" message, tabsync.js):
// jobs run in the queue and how long they held it (waits for Sidebery
// included), tab lookups made outside it (noteOrder, tabsync.js), the timed
// checks (archiving, live folders), the only work with nothing happening, and
// the sidebar's views: how many were built and how long that took.
const work = { jobs: 0, queueMs: 0, longestJobMs: 0, lookups: 0, alarms: 0, errors: 0, views: 0, viewMs: 0, longestViewMs: 0 };
browser.alarms.onAlarm.addListener(() => { work.alarms++; });

// Tidier alone: Tidier's own sidebar, spaces and folders, with no Sidebery. Off by
// default, since Sidebery and Tidier would fight over the same tabs: every commit
// reaches the daily browser, which runs Sidebery until it is moved over (PLAN.md).
// Set in the extension's storage, or declared for a machine in managed storage.
// Everything that exists only because of Sidebery is skipped when it is on.
let tidierAlone = false;
async function readAlone() {
  const managed = await browser.storage.managed.get("tidierAlone").catch(() => ({}));
  const local = await browser.storage.local.get("tidierAlone");
  tidierAlone = !!(managed.tidierAlone ?? local.tidierAlone);
}
// Read at once too, and not only when Tidier starts (tabsync.js), seconds later: a sidebar
// open when Firefox starts asks for its first view long before that. Drawn without the
// setting, its rows could not be dragged until it was closed, and its folders, tabs and
// spaces all moved when the setting came (viewFor, sidebar-view.js). And first in the
// queue: Tidier starts a moment after its page loads, and a job in that moment (a tab you
// pinned, say) would otherwise work as if Sidebery were there. (serial notes an error.)
const aloneRead = serial(readAlone).catch(() => {});

// Something you should know and would otherwise not see, such as a live folder that
// has stopped: shown on Tidier's button (in the Extensions menu) and in its sidebar.
const notices = new Map(); // kind -> text
function setNotice(kind, text) {
  if ((notices.get(kind) ?? null) === (text ?? null)) return;
  if (text) notices.set(kind, text); else notices.delete(kind);
  const first = [...notices.values()][0];
  browser.browserAction.setBadgeText({ text: first ? "!" : "" });
  browser.browserAction.setTitle({ title: first ? "Tidier: " + first : "Tidier" });
  viewAllSoon();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// A tab or window can close at any moment, between one call and the next, and Firefox then
// refuses the next call about it. That is no error, and must not stop the job halfway: the
// tab is simply gone. Anything else Firefox refuses still counts.
const isGone = err => /^Invalid (tab|window) ID/.test(err?.message);
const ifGone = err => { if (!isGone(err)) throw err; };
// Closed one by one: Firefox refuses a whole list if one of them has already closed. `marks`
// tells the listeners it is Tidier closing them; a tab that closed before it was marked gets
// no event that would unmark it, so that is done here. (The event comes before the answer.)
async function removeTabs(ids, marks) {
  ids.forEach(id => marks?.add(id));
  try {
    await Promise.all(ids.map(id => browser.tabs.remove(id).catch(ifGone)));
  } finally {
    ids.forEach(id => marks?.delete(id));
  }
}
// A tab moved to another window: Firefox announces the move while it is still closing the
// tab in the old window, under the same ID, so for a moment the old window lists it. Looked
// at then, the window it left seems to have it still, and is not given its copy. (`stale`
// says whether a tab listed with that ID is still the old one.)
async function movedAway(tabId, stale) {
  for (let i = 0; i < 40; i++) {
    if (!(await browser.tabs.query({}).catch(() => [])).some(t => t.id === tabId && stale(t))) return;
    await sleep(25);
  }
}
// A new tab, or nothing if its window has closed meanwhile: a window you close at any
// moment is no error, and must not stop the work for the other windows. Any other
// refusal is passed on. Firefox answers only once a new window has finished starting, and
// never if it is closed before that: the whole queue would wait for the answer, for a job's
// time limit, so the closing of the window is an answer too.
const tabsOnTheirWay = new Set(); // what to do when a window closes (one listener: each new one is a message to Firefox)
browser.windows.onRemoved.addListener(windowId => { for (const heard of tabsOnTheirWay) heard(windowId); });
function createTab(props) {
  const { windowId } = props;
  const made = browser.tabs.create(props).catch(async err => {
    if (windowId !== undefined && !(await browser.windows.get(windowId).catch(() => null))) return null;
    throw err;
  });
  let heard;
  const closed = new Promise(resolve => {
    heard = id => { if (id === windowId) resolve(null); };
    tabsOnTheirWay.add(heard);
  });
  return Promise.race([made, closed]).finally(() => tabsOnTheirWay.delete(heard));
}
const isWeb = url => /^https?:/i.test(url || "");
// Same host, ignoring a leading "www.".
const sameSite = (a, b) => {
  try { const h = u => new URL(u).hostname.replace(/^www\./, ""); return h(a) === h(b); } catch (e) { return false; }
};
// Sidebery folders are "group" pages served by Sidebery itself.
const isSideberyGroup = url => /^moz-extension:\/\/[^/]+\/sidebery\/group\.html/.test(url || "");

// Placeholder page for ghosts and essential copies (see ghost.js). Asked for once:
// it never changes while Tidier runs, and this is looked at for every tab in a view.
const GHOST_PAGE = browser.runtime.getURL("ghost.html");
const ghostUrl = (kind, key) => `${GHOST_PAGE}?kind=${kind}&key=${encodeURIComponent(key)}`;
const isGhostUrl = url => (url || "").startsWith(GHOST_PAGE);
// What a placeholder stands for, from its own address: a tab's session values can be lost
// (Firefox loses them for an unloaded tab moved to another window), this cannot.
const placeholderOf = url => {
  if (!isGhostUrl(url)) return {};
  const params = new URL(url).searchParams;
  return { kind: params.get("kind"), key: params.get("key") };
};

// Placeholders we close ourselves would show up in Recently Closed Tabs, and
// ⌘⇧T would bring one back instead of the tab you closed. Only real pages
// should be there, so they are forgotten. A loaded tab reaches Recently Closed
// a moment after it is closed (Firefox saves its state first), so each is
// looked for again whenever that list changes, for FORGET_MS. (An essential
// copy's address may end in "&placed=N", see essentials.js.)
//
// The same goes for a real page Tidier closed because it is open elsewhere (opened again in
// its space, say). That is looked for only until it is found, and not for long: a moment
// later you may close the page itself, and that one ⌘⇧T must bring back.
//
// Closing many tabs changes that list once per tab, and a look makes Firefox copy
// everything in it, also a closed window with all its tabs. So nobody waits for a look,
// one runs at a time, and if the list changed meanwhile, another follows after a rest in
// proportion to what this one took. With a few tabs that rest is hardly anything. It has
// a limit, well below FORGET_PAGE_MS: past that a placeholder would no longer be looked for,
// and would stay in the list, on a machine that is merely busy.
const FORGET_MS = 10000, FORGET_PAGE_MS = 3000, FORGET_REST = 9, FORGET_LONGEST_REST_MS = 1000;
const toForget = new Map(); // address -> { until when to look for it, whether once is enough }
let forgetTimer = null, forgetBusy = false, forgetAgain = false;
function forgetClosedPlaceholders(kind, keys) {
  // A synced tab's placeholder is a "ghost", or "lazy" if it stands for a pull request
  // never opened (createLiveItem); ⌘⇧T would bring that back with nothing to show.
  const kinds = kind === "ghost" ? ["ghost", "lazy"] : [kind];
  forgetClosed(keys.flatMap(k => kinds.map(x => ghostUrl(x, k))), FORGET_MS, false);
}
const forgetClosedPages = urls => forgetClosed(urls, FORGET_PAGE_MS, true);
function forgetClosed(urls, ms, once) {
  if (!urls.length) return;
  for (const url of urls) toForget.set(url, { until: Date.now() + ms, once });
  // So the list empties also if nothing else changes: at the last of them.
  clearTimeout(forgetTimer);
  const last = Math.max(...[...toForget.values()].map(f => f.until));
  forgetTimer = setTimeout(forgetClosedNow, last - Date.now() + 100);
  forgetClosedNow();
}
async function forgetClosedNow() {
  if (forgetBusy) { forgetAgain = true; return; }
  for (const [url, { until }] of toForget) if (until < Date.now()) toForget.delete(url);
  if (!toForget.size) return;
  forgetBusy = true;
  const t0 = performance.now();
  // (An essential copy's address may end in "&placed=N", see essentials.js.)
  const ours = url => toForget.has(url) ? url : [...toForget.keys()].find(p => url?.startsWith(p + "&"));
  try {
    const closed = await browser.sessions.getRecentlyClosed().catch(() => []);
    for (const t of closed.map(item => item.tab).filter(Boolean)) {
      const found = ours(t.url);
      if (found === undefined) continue;
      if (toForget.get(found)?.once) toForget.delete(found);
      await browser.sessions.forgetClosedTab(t.windowId, t.sessionId).catch(() => {});
    }
  } finally {
    // The rest counts as busy, so that what changes during it waits for the look after it.
    setTimeout(() => {
      forgetBusy = false;
      if (forgetAgain) { forgetAgain = false; forgetClosedNow(); }
    }, Math.min(FORGET_REST * (performance.now() - t0), FORGET_LONGEST_REST_MS));
  }
}
browser.sessions.onChanged.addListener(() => { forgetClosedNow(); });

// Sidebery's tree, and how to change tab order without breaking it.
//
// Sidebery rebuilds its whole tree after every single tab move it did not make
// itself. A tab whose parent is further up, with other tabs in between, takes
// all those tabs into the parent (Sidebery's updateTabsTree, 5.6). So a folder
// that is apart from its tabs for even one move swallows every tab between
// them, also tabs from other spaces; and a tab moved above its parent loses
// it. Tabs are therefore only ever put in an order where each tab comes right
// after its parent or the tab before it in the same folder (treeOrder), and
// moved one at a time, never a tab that has tabs in it (placeInOrder).

const NO_CONTAINER = "firefox-default";

// The order of `items` ({ id, parent, space, folder }, given in their current
// order) that Sidebery can show as it is: each space one run, the spaces in
// the order they mostly have now, folders first in each space (as in Zen and
// Arc), and every tab right after its parent, its folder's tabs in their
// current order. A tab without a container belongs to the space it sits in.
function treeOrder(items) {
  const byId = new Map(items.map(x => [x.id, x]));
  const kids = new Map(), roots = [];
  for (const x of items) {
    const p = byId.get(x.parent);
    if (p && p !== x) (kids.get(p.id) ?? kids.set(p.id, []).get(p.id)).push(x);
    else roots.push(x);
  }
  const run = new Map();
  let last = null;
  for (const r of roots) { if (r.space !== NO_CONTAINER) last = r.space; run.set(r, r.space !== NO_CONTAINER ? r.space : last); }
  let next = null;
  for (const r of [...roots].reverse()) { if (run.get(r) !== null) next = run.get(r); else run.set(r, next); }
  const where = new Map();
  roots.forEach((r, i) => (where.get(run.get(r)) ?? where.set(run.get(r), []).get(run.get(r))).push(i));
  const median = list => list[list.length >> 1];
  const spaces = [...where.keys()].sort((a, b) => median(where.get(a)) - median(where.get(b)));
  const out = [], seen = new Set();
  const visit = x => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    out.push(x.id);
    for (const c of kids.get(x.id) || []) visit(c);
  };
  for (const s of spaces) {
    const here = roots.filter(r => run.get(r) === s);
    for (const r of [...here.filter(r => r.folder), ...here.filter(r => !r.folder)]) visit(r);
  }
  for (const x of items) visit(x); // left over: tabs whose parents point at each other
  return out;
}

// Move a window's tabs towards `ids` order (tab IDs), one tab at a time, each
// right after the tab that should come before it. A tab with tabs in it is
// left where it is; its tabs then follow it there. `mark(id)` is called before
// each move, so listeners can ignore our own moves.
async function placeInOrder(windowId, ids, mark) {
  let tabs = await browser.tabs.query({ windowId });
  const firstUnpinned = tabs.filter(t => t.pinned).length;
  ids = ids.filter(id => tabs.some(t => t.id === id && !t.pinned));
  for (let i = 0; i < ids.length; i++) {
    const byId = new Map(tabs.map(t => [t.id, t]));
    const tab = byId.get(ids[i]), prev = i ? byId.get(ids[i - 1]) : null;
    if (!tab || tabs.some(t => treeParent(t, byId) === tab)) continue;
    const index = !prev ? firstUnpinned : tab.index < prev.index ? prev.index : prev.index + 1;
    if (tab.index === index) continue;
    mark(tab.id);
    await browser.tabs.move(tab.id, { windowId, index }).catch(() => {});
    tabs = await browser.tabs.query({ windowId });
  }
}

async function normalWindows() {
  return (await browser.windows.getAll({ windowTypes: ["normal"] })).filter(w => !w.incognito);
}

// A tab refused while filling a window: if the window has been closed meanwhile, that is
// no error, and there is nothing left to do there (with many tabs, each of them would be
// refused in turn). Returns whether to go on with the next tab.
async function refusedInWindow(windowId, err) {
  if (!(await browser.windows.get(windowId).catch(() => null))) return false;
  noteError(err);
  return true;
}

// Timing for filling a new window, measured with Sidebery 5.6 on Firefox 159:
// - the window is filled shortly after it opens (tabs appear within ~0.7 s);
// - tabs can be created back to back;
// - Sidebery needs ~1.5 s to finish placing them before any tab it put
//   elsewhere is moved into place (see sortWindow). Sorting sooner puts tabs
//   in the wrong panel.
// - Essentials added to an existing window are created unpinned and pinned
//   PIN_SETTLE_MS later (see createEssentials): Sidebery puts a new tab in its
//   container's panel, and a pinned tab keeps its panel; pinned too soon,
//   Sidebery gives it the active panel instead. Seen on a slower machine
//   (GitHub's), not on a fast Mac.
const NEW_WINDOW_DELAY_MS = 200;
const RESTORED_LATE_MS = 3000; // see windows.onCreated in tabsync.js
const CREATE_GAP_MS = 0;
const SORT_SETTLE_MS = 1500;
const PIN_SETTLE_MS = 800;
// In a new window, essentials are pinned only after Sidebery's sidebar there
// has started (see fillWindow and pinEssentialCopies): it waits at most
// SIDEBAR_WAIT_MS for that, probing every PROBE_MS (see sidebarStarted), and
// RULE_SETTLE_MS for Sidebery to move each copy to its own space before
// pinning it.
const SIDEBAR_WAIT_MS = 4000;
const RULE_SETTLE_MS = 600;
const PROBE_MS = 500;
// A tab moved into or out of a folder is moved the same way in the other
// windows MOVE_SETTLE_MS later, once Sidebery has set its new parent (see
// applyMoves); the new ghost there gets NEW_TAB_SETTLE_MS for Sidebery to
// place it before it is put in its place. Moves of a tab in its first
// NEW_TAB_QUIET_MS are Sidebery placing it.
const MOVE_SETTLE_MS = 800;
const NEW_TAB_SETTLE_MS = 500;
const NEW_TAB_QUIET_MS = 5000;
// Folders are moved first in their space FOLDERS_SETTLE_MS after a change
// (see folders.js), before the move is copied to the other windows.
const FOLDERS_SETTLE_MS = 400;
// A saved tab you closed is handled FOLDER_CLOSE_SETTLE_MS later, once a
// folder closed with it is gone too (see onSyncedClosed in tabsync.js).
const FOLDER_CLOSE_SETTLE_MS = 300;

// A folder of Tidier's own (Tidier alone): only an entry in the tab record, with no
// tab of its own, so no tab event can delete it (ownfolders.js).
const isOwnFolder = entry => !!entry?.group && !!entry.own;

// --- Saved tabs --------------------------------------------------------------
// A tab in a Sidebery folder (at any depth) is *saved*, like a tab in Arc's
// pinned section: ⌘W unloads it instead of closing it, and it goes back to the
// address it had when it came into the folder (`saved` in its synced entry).
// Closing it while it is unloaded removes it; so does dragging it out of the
// folder, which makes it an ordinary tab again. A live folder's pull requests
// are not saved: the search decides what is in them (livefolders.js).

// The nearest folder above the stored entry `key`, by the stored parents.
function folderKeyOf(all, key) {
  for (let k = all[key]?.parentKey, seen = new Set(); k && all[k] && !seen.has(k); k = all[k].parentKey) {
    seen.add(k);
    if (all[k].group) return k;
  }
  return null;
}
function storedInFolder(all, key) { return folderKeyOf(all, key) !== null; }

// Keep each entry's `saved` address current: set it when a tab is first seen
// in a folder (from its address then), remove it when the tab leaves. Only
// `keys` when given (a page load concerns its own tab only).
function noteSaved(all, keys = Object.keys(all)) {
  for (const key of keys) {
    const e = all[key];
    if (!e) continue;
    if (e.group || e.liveFolder || !storedInFolder(all, key)) delete e.saved;
    else if (!e.saved && isWeb(e.url)) e.saved = { url: e.url, title: e.title, icon: e.icon };
    // An ordinary tab has no name (tabnames.js), and its placeholders must stop showing it. A folder's is its own.
    if (!e.group && !e.saved && e.name) { delete e.name; refreshGhostsSoon(key); }
  }
}

// What closing a synced tab (not by closing its window) means:
//   "copy"   a folder copy: only its own window (tabsync.js)
//   "leave"  a tab in a folder that was closed in that window with it: the
//            other windows keep it (Sidebery closes a folded folder's tabs)
//   "unload" a saved tab you closed while it was loaded
//   "close"  everything else: closed in every window
function closeAction({ role, inFolder, liveFolder, unloaded, folderHere }) {
  if (role === "copy") return "copy";
  if (inFolder && !folderHere) return "leave";
  if (inFolder && !liveFolder && !unloaded) return "unload";
  return "close";
}

// The focused window, tracked here so tab events need no round trip to ask.
// Registered before the other scripts' listeners, so it is current when they run.
let focusedWindowId = browser.windows.WINDOW_ID_NONE;
browser.windows.getLastFocused().then(w => { if (w.focused) focusedWindowId = w.id; }).catch(() => {});
browser.windows.onFocusChanged.addListener(id => { focusedWindowId = id; });

// A value saved to storage.local a moment after the last change, so bursts of
// changes become one write. Reads come from memory.
//
// A change that is only a title or an icon is `lazy`: a page whose title ticks (a
// timer, an unread count) would otherwise rewrite everything at every tick, all day.
// It is written at most once every LAZY_WRITE_MS; a title lost in a crash comes back
// with the page. Any other change is written at once and takes the lazy one along.
const WRITE_DELAY_MS = 300, LAZY_WRITE_MS = 30000;
const unwritten = new Set(); // what `flushWrites` must write now
function storedValue(storageKey, empty) {
  let value = null, timer = null, lastWrite = 0;
  const write = () => {
    clearTimeout(timer);
    timer = null;
    unwritten.delete(write);
    lastWrite = Date.now();
    // Refused (a full disk, say): tried again later, or only memory would have it, and a
    // start would lose what no other change happened to write.
    return browser.storage.local.set({ [storageKey]: value }).catch(err => {
      noteError(err);
      unwritten.add(write);
      timer ??= setTimeout(write, LAZY_WRITE_MS);
    });
  };
  return {
    async get() {
      if (value === null) value = (await browser.storage.local.get(storageKey))[storageKey] ?? empty();
      return value;
    },
    set(next, { lazy = false } = {}) {
      value = next;
      unwritten.add(write);
      if (lazy && timer !== null) return; // a write is on its way anyway
      clearTimeout(timer);
      timer = setTimeout(write, lazy ? Math.max(WRITE_DELAY_MS, lastWrite + LAZY_WRITE_MS - Date.now()) : WRITE_DELAY_MS);
    },
  };
}

const flushWrites = () => Promise.all([...unwritten].map(write => write()));

// A tab's parent in Sidebery's tree, from openerTabId, which Sidebery keeps
// equal to the parent. Sidebery counts a parent only before its children, and
// cannot clear openerTabId when it makes a tab a root (Firefox keeps the old
// opener), so a tab once seen with its opener after it is a root, also after
// the opener has moved up again (folders first), until its opener changes.
// (Dragged back into the same folder, it still counts as a root: Sidebery
// then sets the same opener again, which cannot be seen.)
const staleOpener = new Map(); // tabId -> the opener it had when it became a root
function treeParent(tab, byId) {
  const p = byId.get(tab.openerTabId);
  if (!p || p.id === tab.id || p.windowId !== tab.windowId) return undefined;
  if (p.index > tab.index) { staleOpener.set(tab.id, p.id); return undefined; }
  if (staleOpener.get(tab.id) === p.id) return undefined;
  staleOpener.delete(tab.id);
  return p;
}
// Seen at once when a tab moves, before folders first moves its old parent up. (With
// Tidier alone there is no such tree, and this would ask for every tab at every move.)
browser.tabs.onMoved.addListener(async (tabId, { windowId }) => {
  if (tidierAlone) return;
  const tabs = await browser.tabs.query({ windowId }).catch(() => []);
  const byId = new Map(tabs.map(t => [t.id, t])), tab = byId.get(tabId);
  if (tab) treeParent(tab, byId);
});
browser.tabs.onRemoved.addListener(tabId => staleOpener.delete(tabId));
