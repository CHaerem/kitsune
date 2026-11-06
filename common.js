// Shared helpers for essentials.js and tabsync.js.

// All changes run one after another, so two events never race each other
// into duplicate tabs. Both features share this one queue.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(async () => {
    const t0 = performance.now();
    work.jobs++;
    try { return await fn(); } finally { work.queueMs += performance.now() - t0; }
  });
  queue = run.catch(err => console.error("Tidier:", err));
  return run;
}

// How much Tidier does, for the smoke test (the "stats" message, tabsync.js):
// jobs run in the queue and how long they held it (waits for Sidebery
// included), tab lookups made outside it (noteOrder, tabsync.js), and the
// timed checks (archiving, live folders), the only work with nothing happening.
const work = { jobs: 0, queueMs: 0, lookups: 0, alarms: 0 };
browser.alarms.onAlarm.addListener(() => { work.alarms++; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isWeb = url => /^https?:/i.test(url || "");
// Same host, ignoring a leading "www.".
const sameSite = (a, b) => {
  try { const h = u => new URL(u).hostname.replace(/^www\./, ""); return h(a) === h(b); } catch (e) { return false; }
};
// Sidebery folders are "group" pages served by Sidebery itself.
const isSideberyGroup = url => /^moz-extension:\/\/[^/]+\/sidebery\/group\.html/.test(url || "");

// Placeholder page for ghosts and essential copies (see ghost.js).
const ghostUrl = (kind, key) => browser.runtime.getURL(`ghost.html?kind=${kind}&key=${encodeURIComponent(key)}`);
const isGhostUrl = url => (url || "").startsWith(browser.runtime.getURL("ghost.html"));

// Placeholders we close ourselves would show up in Recently Closed Tabs, and
// ⌘⇧T would bring one back instead of the tab you closed. Only real pages
// should be there, so they are forgotten. A loaded tab reaches Recently Closed
// a moment after it is closed (Firefox saves its state first), so each is
// looked for again whenever that list changes, for FORGET_MS. (An essential
// copy's address may end in "&placed=N", see essentials.js.)
const FORGET_MS = 10000;
const toForget = new Map(); // placeholder URL -> until when to look for it
async function forgetClosedPlaceholders(kind, keys) {
  for (const k of keys) toForget.set(ghostUrl(kind, k), Date.now() + FORGET_MS);
  setTimeout(forgetClosedNow, FORGET_MS + 100); // so the list empties also if nothing else changes
  await forgetClosedNow();
}
async function forgetClosedNow() {
  for (const [url, until] of toForget) if (until < Date.now()) toForget.delete(url);
  if (!toForget.size) return;
  const ours = url => [...toForget.keys()].some(p => url === p || url?.startsWith(p + "&"));
  const closed = await browser.sessions.getRecentlyClosed().catch(() => []);
  for (const t of closed.map(item => item.tab).filter(Boolean)) {
    if (ours(t.url)) await browser.sessions.forgetClosedTab(t.windowId, t.sessionId).catch(() => {});
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
function storedValue(storageKey, empty) {
  let value = null, timer = null;
  return {
    async get() {
      if (value === null) value = (await browser.storage.local.get(storageKey))[storageKey] ?? empty();
      return value;
    },
    set(next) {
      value = next;
      clearTimeout(timer);
      timer = setTimeout(() => browser.storage.local.set({ [storageKey]: value }), 300);
    },
  };
}

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
// Seen at once when a tab moves, before folders first moves its old parent up.
browser.tabs.onMoved.addListener(async (tabId, { windowId }) => {
  const tabs = await browser.tabs.query({ windowId }).catch(() => []);
  const byId = new Map(tabs.map(t => [t.id, t])), tab = byId.get(tabId);
  if (tab) treeParent(tab, byId);
});
browser.tabs.onRemoved.addListener(tabId => staleOpener.delete(tabId));
