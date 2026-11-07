// Random use must never break what Tidier promises (PLAN.md: "Very robust").
//
// From a seed, a long random sequence of what can happen in a browser is played on
// Tidier's real background scripts, on a fake Firefox that follows Firefox's source
// (chaos_firefox.mjs). Then everything settles, and what must always hold is checked:
// one live tab per tab, one representation per window, no essential twice, nothing lost
// across an update or a restart, no job stuck, no error, no list that only grows.
//
// Time is virtual, so a run does not depend on how busy the machine is: a failure comes
// with a line that replays it exactly, and is first made as short as it can be.
//
//   node --test tests/chaos.test.mjs                        the default, under 20 seconds
//   CHAOS_SEQUENCES=20000 CHAOS_SECONDS=0 node --test ...   longer, for a night (0: no time limit)
//   CHAOS_FIRST=5000 ...                                    start from another seed
//   CHAOS_REPLAY='<line from a failure>' node --test ...    one sequence again
//   CHAOS_TRACE=1 CHAOS_REPLAY=... node --test ...          with every call and event printed
//
// What a sequence can do is OPS below; what must hold is check(). A failure says which
// check, in which phase: "settled" (after the random use), "update" or "restart".
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChaosFirefox, randoms, REFUSED, isPlaceholder, isFolderPage } from "./chaos_firefox.mjs";

const SPACES = ["firefox-container-1", "firefox-container-2", "firefox-container-3"];
const NO_CONTAINER = "firefox-default";
const isWeb = url => /^https?:/i.test(url || "");
const isNewTabPage = url => /^about:/.test(url || "");
const pick = (list, f) => (list.length ? list[Math.floor(f * list.length) % list.length] : undefined);
const FOLDER_URL = n => `moz-extension://sb/sidebery/group.html#F${n}`;

function inFolderOf(all, key) {
  for (let p = all[key]?.parentKey, seen = new Set(); p && all[p] && !seen.has(p); p = all[p].parentKey) { seen.add(p); if (all[p].group) return true; }
  return false;
}

// A sequence's whole world: the fake Firefox, the running scripts, and what the checks
// must remember (which tabs may be gone, because you closed them).
class World {
  constructor(seq) {
    this.seq = seq;
    this.ff = new ChaosFirefox({ seed: seq.seed, closeWindowWithLastTab: seq.closeWithLast, loadFactor: seq.loadFactor });
    this.alone = seq.alone;
    this.pageCounter = 0;
    this.known = new Map();      // key -> what was last seen of it in the record
    this.excused = new Set();    // keys you did away with
    this.essentials = new Map(); // essential key -> its address
    this.goneEssentials = new Set();
    this.closedAddresses = new Set();
    this.relaxed = false;        // a folder page closed in one window: that window lacks tabs until it is filled again
    this.violations = [];
    this.x = null;
  }
  get clock() { return this.ff.clock; }
  bad(cat, msg) { this.violations.push({ cat, msg: `${cat}: ${msg}` }); }
  windows() { return [...this.ff.wins.values()].filter(w => w.type === "normal"); }
  tabsOf(w) { return w.order.map(id => this.ff.tabs.get(id)); }
  allTabs() { return this.windows().flatMap(w => this.tabsOf(w)); }
  focused() { return this.ff.wins.get(this.ff.focused) ?? this.windows()[0]; }
  value(t, k) { return this.ff.values.get(t.id)?.[k]; }
  keyOf(t) { return this.value(t, "syncKey") ?? this.x.js("syncKeyByTab").get(t.id); }
  newUrl() { const n = ++this.pageCounter; return `https://s${n % 4}.example/p${n}`; }
  read(code) { return this.clock.settled(this.x.js(code)); }
  // Learn what the record holds now, so that what later goes missing can be told apart.
  async observe() {
    const all = await this.read("getSynced()"), list = await this.read("getList()");
    for (const [key, e] of Object.entries(all)) {
      const k = this.known.get(key) ?? { urls: new Set() };
      if (e.url) k.urls.add(e.url);
      if (e.saved?.url) k.urls.add(e.saved.url);
      Object.assign(k, { group: !!e.group, own: !!e.own, name: e.name, saved: !!e.saved, parentKey: e.parentKey ?? null });
      this.known.set(key, k);
    }
    for (const e of list) this.essentials.set(e.key, e.url);
    return all;
  }
  // The page stops without a word. What was made a moment ago is not written yet. A tab is
  // known again by its address; a folder has none, and is then gone with that moment.
  async hardStop() {
    const all = await this.read("getSynced()"), list = await this.read("getList()");
    for (const [key, e] of Object.entries(all)) if (e.group && !this.ff.store.syncedTabs?.[key]) this.excused.add(key);
    for (const e of list) if (!this.ff.store.essentials?.some(x => x.key === e.key)) this.goneEssentials.add(e.key);
  }
  // You closed `t`, or are about to.
  async closing(t) {
    const key = this.keyOf(t), all = await this.read("getSynced()");
    if (!key) {
      // Just being registered, perhaps: then it is only known by its address.
      this.closedAddresses.add(t.url);
      if (this.ff.pages.get(t)?.url) this.closedAddresses.add(this.ff.pages.get(t).url); // on its way there
      return;
    }
    const e = all[key];
    const inFolder = inFolderOf(all, key);
    const unloaded = t.discarded || isPlaceholder(t.url);
    if (!e || !inFolder || unloaded) this.excused.add(key);
    if (this.value(t, "syncRole") === "copy") { this.relaxed = true; this.excused.add(key); }
  }
  // A tab in a folder that has none in this window can go too (closeAction: "leave").
  shownRows(windowId) {
    const v = this.ff.views.get(windowId);
    return v ? { essentials: v.essentials, folders: v.folders, tabs: [...v.folders.flatMap(f => f.tabs), ...v.tabs], view: v } : null;
  }
}

// --- What can happen ------------------------------------------------------------------
// Each takes the World and an action with numbers in [0, 1) (a, b, c), which choose among
// what is there at that moment. So a shortened sequence still makes sense.
const OPS = {
  // ⌘T: a new tab page, without a container, at the end.
  newTab: { weight: 6, run(W, { a }) {
    const w = pick(W.windows(), a);
    if (w) W.ff.openTab(w.id, { url: "about:newtab", active: true });
  } },
  // An address typed into a new tab page.
  type: { weight: 8, run(W, { a }) {
    const t = pick(W.allTabs().filter(t => isNewTabPage(t.url) && t.url !== "about:blank"), a);
    if (t) W.ff.load(t, W.newUrl());
  } },
  // A link in a page opens a tab next to it, in its container.
  link: { weight: 9, run(W, { a, b }) {
    const w = pick(W.windows(), a), from = w && W.ff.activeOf(w);
    if (!from || from.incognito) return;
    W.ff.openTab(w.id, { url: W.newUrl(), active: b < 0.3, cookieStoreId: from.cookieStoreId, index: W.ff.index(from) + 1, openerTabId: from.id });
  } },
  // A link from another app, without a container.
  outsideLink: { weight: 4, run(W) {
    const w = W.focused();
    if (w) W.ff.openTab(w.id, { url: W.newUrl(), active: true });
  } },
  // A tab opened in a space directly.
  spaceTab: { weight: 5, run(W, { a, b }) {
    const w = pick(W.windows(), a);
    if (w) W.ff.openTab(w.id, { url: W.newUrl(), active: true, cookieStoreId: pick(SPACES, b) });
  } },
  // Going to another address in a page.
  navigate: { weight: 4, run(W, { a }) {
    const t = pick(W.allTabs().filter(t => isWeb(t.url) && !t.discarded), a);
    if (t) W.ff.load(t, W.newUrl());
  } },
  title: { weight: 3, run(W, { a, b }) {
    const t = pick(W.allTabs().filter(t => isWeb(t.url) && !t.discarded), a);
    if (!t) return;
    t.title = `(${Math.floor(b * 100)}) ${t.url}`;
    W.ff.updated(t, { title: t.title });
  } },
  // Selecting: mostly what can be seen in the window you are using.
  select: { weight: 18, run(W, { a, b, c }) {
    const w = pick(W.windows(), a);
    if (!w) return;
    if (c < 0.85) W.ff.focusWindow(w.id);
    const shown = W.tabsOf(w).filter(t => !t.hidden);
    const t = pick(c < 0.97 ? shown : W.tabsOf(w), b);
    if (t) W.ff.select(t.id);
  } },
  focus: { weight: 4, run(W, { a }) {
    const w = pick(W.windows(), a);
    if (w) W.ff.focusWindow(w.id);
  } },
  // ⌘W or the ×.
  close: { weight: 12, async run(W, { a, b }) {
    const w = pick(W.windows(), a);
    const t = w && pick(W.tabsOf(w).filter(t => !t.hidden), b);
    if (!t) return;
    await W.closing(t);
    W.ff.closeTab(t.id);
  } },
  newWindow: { weight: 3, run(W) { W.ff.openWindow(); } },
  closeWindow: { weight: 3, run(W, { a }) {
    const w = pick(W.windows(), a);
    if (!w) return;
    // In the moment before Tidier has started, a window closing cannot hand anything over,
    // and a tab that is just being registered there has nothing to hand over to.
    for (const t of W.tabsOf(w)) {
      if (!W.x.js("started") && W.value(t, "syncKey")) W.excused.add(W.value(t, "syncKey"));
      if (!W.value(t, "syncRole")) W.closedAddresses.add(t.url);
    }
    W.ff.closeWindow(w.id);
  } },
  // ⌘⇧T: the last thing closed, a tab or a whole window.
  reopen: { weight: 4, run(W) { W.ff.reopenLast(); } },
  // A sign-in popup: not a tab you keep.
  popup: { weight: 1, run(W) { W.ff.openWindow({ type: "popup", url: W.newUrl() }); } },
  closePopup: { weight: 1, run(W) { for (const w of [...W.ff.wins.values()]) if (w.type !== "normal") W.ff.closeWindow(w.id); } },
  pin: { weight: 5, async run(W, { a, b }) {
    const w = pick(W.windows(), a);
    const t = w && pick(W.tabsOf(w).filter(t => !t.pinned && !t.hidden && (isWeb(t.url) || isPlaceholder(t.url))), b);
    if (!t) return;
    if (W.keyOf(t)) W.excused.add(W.keyOf(t));
    W.ff.pinTab(t);
  } },
  unpin: { weight: 3, async run(W, { a, b }) {
    const w = pick(W.windows(), a);
    const t = w && pick(W.tabsOf(w).filter(t => t.pinned), b);
    if (!t) return;
    const key = W.value(t, "essentialKey");
    if (key) W.goneEssentials.add(key);
    else W.unpinnedUnknown = true; // pinned a moment ago: which essential goes cannot be told here
    W.ff.unpinTab(t);
  } },
  // A tab or essential dragged within its window: in the tab strip, with Sidebery as without.
  dragInWindow: { weight: 5, run(W, { a, b, c }) {
    const w = pick(W.windows(), a), t = w && pick(W.tabsOf(w), b);
    if (!t) return;
    const n = W.ff.pinnedCount(w), lo = t.pinned ? 0 : n, hi = t.pinned ? n - 1 : w.order.length - 1;
    W.ff.moveTabs([t.id], { index: lo + Math.floor(c * (hi - lo + 1)) });
  } },
  // A tab or essential dragged to another window.
  dragToWindow: { weight: 5, run(W, { a, b, c }) {
    // (Not a Sidebery folder page: Sidebery does not offer it, and it is not looked after.)
    const w = pick(W.windows(), a), t = w && pick(W.tabsOf(w).filter(t => !isFolderPage(t.url)), b);
    const to = pick(W.windows().filter(x => x !== w), c);
    if (t && to) W.ff.moveTabs([t.id], { windowId: to.id, index: t.pinned ? W.ff.pinnedCount(to) : -1 });
  } },
  // ------ Tidier alone: what the sidebar sends, from what it has drawn ------
  sidebarOpen: { weight: 3, alone: true, run(W, { a }) {
    const w = pick(W.windows(), a);
    if (w) W.ff.connectSidebar(w.id);
  } },
  rowSelect: { weight: 10, alone: true, run(W, { a, b }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id);
    if (!rows) return;
    W.ff.focusWindow(w.id);
    const item = pick([...rows.essentials, ...rows.tabs], b);
    if (item) W.ff.sidebarSays(w.id, { type: "select", tabId: item.id });
  } },
  rowClose: { weight: 8, alone: true, async run(W, { a, b }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id);
    const item = rows && pick(rows.tabs, b), t = item && W.ff.tabs.get(item.id);
    if (!t) return;
    await W.closing(t);
    W.ff.sidebarSays(w.id, { type: "close", tabId: item.id });
  } },
  space: { weight: 7, alone: true, run(W, { a, b }) {
    const w = pick(W.windows(), a);
    if (!w) return;
    if (W.ff.ports.has(w.id)) W.ff.sidebarSays(w.id, { type: "space", space: pick(SPACES, b) });
    else { W.ff.focusWindow(w.id); W.x.b.commands.onCommand.fire(`space-${1 + Math.floor(b * 3)}`); }
  } },
  sidebarNewTab: { weight: 4, alone: true, run(W, { a }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id);
    if (rows) W.ff.sidebarSays(w.id, { type: "newTab", space: rows.view.space });
  } },
  newFolder: { weight: 5, alone: true, run(W, { a, b }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id);
    if (rows) W.ff.sidebarSays(w.id, { type: "newFolder", space: rows.view.space, name: `Folder ${Math.floor(b * 100)}` });
  } },
  deleteFolder: { weight: 2, alone: true, run(W, { a, b }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), f = rows && pick(rows.folders, b);
    if (!f) return;
    W.excused.add(f.key);
    W.ff.sidebarSays(w.id, { type: "deleteFolder", key: f.key });
  } },
  renameFolder: { weight: 1, alone: true, run(W, { a, b }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), f = rows && pick(rows.folders, b);
    if (f) W.ff.sidebarSays(w.id, { type: "renameFolder", key: f.key, name: `Renamed ${Math.floor(b * 100)}` });
  } },
  foldFolder: { weight: 2, alone: true, run(W, { a, b }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), f = rows && pick(rows.folders, b);
    if (f) W.ff.sidebarSays(w.id, { type: "foldFolder", key: f.key, collapsed: !f.collapsed });
  } },
  moveFolder: { weight: 1, alone: true, run(W, { a, b, c }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), f = rows && pick(rows.folders, b);
    if (f) W.ff.sidebarSays(w.id, { type: "moveFolder", key: f.key, before: pick(rows.folders, c)?.key ?? null });
  } },
  // A row dragged: before another row, into a folder, or out of it.
  rowMove: { weight: 9, alone: true, run(W, { a, b, c }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), item = rows && pick(rows.tabs, b);
    if (!item) return;
    const target = c < 0.4 ? pick(rows.folders.filter(f => !f.live), c / 0.4) : null;
    if (target) { W.ff.sidebarSays(w.id, { type: "moveTab", tabId: item.id, folder: target.key, before: null }); return; }
    const over = pick(rows.tabs, c), folder = rows.folders.find(f => f.tabs.some(x => x.id === over?.id))?.key ?? null;
    if (over && over.id !== item.id) W.ff.sidebarSays(w.id, { type: "moveTab", tabId: item.id, folder, before: over.id });
    else W.ff.sidebarSays(w.id, { type: "moveTab", tabId: item.id, folder: null, before: null });
  } },
  rowToSpace: { weight: 4, alone: true, run(W, { a, b, c }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), item = rows && pick(rows.tabs, b), t = item && W.ff.tabs.get(item.id);
    if (!t) return;
    if (W.keyOf(t)) W.excused.add(W.keyOf(t));
    W.ff.sidebarSays(w.id, { type: "moveToSpace", tabId: item.id, space: pick(SPACES, c) });
  } },
  rowPin: { weight: 3, alone: true, run(W, { a, b }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), item = rows && pick(rows.tabs, b), t = item && W.ff.tabs.get(item.id);
    if (!t) return;
    if (W.keyOf(t)) W.excused.add(W.keyOf(t));
    W.ff.sidebarSays(w.id, { type: "pin", tabId: item.id, pinned: true });
  } },
  tileMove: { weight: 4, alone: true, run(W, { a, b, c }) {
    const w = pick(W.windows(), a), rows = w && W.shownRows(w.id), item = rows && pick(rows.essentials, b), before = rows && pick(rows.essentials, c);
    if (item && before && before.id !== item.id) W.ff.sidebarSays(w.id, { type: "moveEssential", tabId: item.id, before: before.id });
  } },
  // ------ With Sidebery: its folder pages, and what it does to a tab dragged into one ------
  folderPage: { weight: 5, sidebery: true, run(W, { a, b }) {
    const w = pick(W.windows(), a);
    if (w) W.ff.openTab(w.id, { url: FOLDER_URL(++W.pageCounter), active: false, cookieStoreId: pick(SPACES, b) });
  } },
  intoFolderPage: { weight: 6, sidebery: true, async run(W, { a, b, c }) {
    const w = pick(W.windows(), a);
    if (!w) return;
    W.ff.focusWindow(w.id);
    const tabs = W.tabsOf(w), page = pick(tabs.filter(t => isFolderPage(t.url)), b);
    const t = page && pick(tabs.filter(t => !t.pinned && !isFolderPage(t.url) && t.cookieStoreId === page.cookieStoreId), c);
    if (!t) return;
    W.ff.moveTabs([t.id], { index: W.ff.index(page) + (W.ff.index(t) < W.ff.index(page) ? 0 : 1) });
    t.openerTabId = page.id; // Sidebery keeps openerTabId equal to the parent
  } },
  outOfFolderPage: { weight: 3, sidebery: true, run(W, { a, b }) {
    const w = pick(W.windows(), a);
    if (!w) return;
    W.ff.focusWindow(w.id);
    const t = pick(W.tabsOf(w).filter(t => !t.pinned && t.openerTabId !== undefined), b);
    if (!t) return;
    delete t.openerTabId;
    W.ff.moveTabs([t.id], { index: -1 });
  } },
  // ------ The big things ------
  update: { weight: 1, async run(W) {
    await W.hardStop();
    W.x = W.ff.update();
  } },
  restart: { weight: 1, async run(W, { a }) {
    // A tab with no copy in the session when Firefox quits, because its window closed the
    // moment before, cannot be told from one you closed. (A saved tab can, and stays.)
    const all = await W.read("getSynced()");
    for (const key of Object.keys(all)) if (!all[key].saved && !W.allTabs().some(t => W.value(t, "syncKey") === key)) W.excused.add(key);
    await W.hardStop();
    // With no session either, a tab not written yet is gone without a trace.
    if (a >= 0.85) for (const key of Object.keys(all)) if (!W.ff.store.syncedTabs?.[key]) W.excused.add(key);
    W.x = W.ff.restart({ session: a < 0.85 });
  } },
  // A long time passes, and archiving looks at everything that is not in a folder.
  archive: { weight: 1, async run(W) {
    await W.clock.run(13 * 3600e3);
    const all = await W.read("getSynced()");
    for (const [key, e] of Object.entries(all)) if (!e.group && !inFolderOf(all, key)) W.excused.add(key);
    W.x.b.alarms.onAlarm.fire({ name: "archive" });
  } },
  // Refused calls, for a while: a tab closed at that moment, a disk that is full.
  refuseOn: { weight: 1, run(W, { a }) { if (W.seq.refuseRate) W.ff.refuseRate = W.seq.refuseRate * (0.5 + a); } },
  refuseOff: { weight: 1, run(W) { W.ff.refuseRate = 0; } },
};
const FORCED_ACTION = { d: 0, a: 0, b: 0, c: 0, r: 0 };

export function generate(seed, alone) {
  const rng = randoms(seed * 2 + (alone ? 1 : 0));
  const ops = Object.entries(OPS).filter(([, o]) => (alone ? !o.sidebery : !o.alone));
  const total = ops.reduce((n, [, o]) => n + o.weight, 0);
  const pickOp = () => { let r = rng() * total; for (const [name, o] of ops) { r -= o.weight; if (r < 0) return name; } return ops[0][0]; };
  const delay = () => {
    const r = rng();
    if (r < 0.35) return 0;
    if (r < 0.6) return Math.floor(rng() * 30);
    if (r < 0.85) return Math.floor(rng() * 1000);
    return Math.floor(rng() * 8000);
  };
  const length = 20 + Math.floor(rng() * 60);
  const actions = [];
  for (let i = 0; i < length; i++) actions.push({ op: pickOp(), a: rng(), b: rng(), c: rng(), d: delay(), r: Math.floor(rng() * 2 ** 32) });
  // Most sequences start with a sidebar to send from and a few tabs to work on.
  if (alone) actions.unshift({ ...FORCED_ACTION, op: "sidebarOpen", d: 300 });
  return {
    seed, alone, closeWithLast: rng() < 0.5, loadFactor: rng() < 0.2 ? 6 : 1,
    refuseRate: rng() < 0.3 ? 0.03 + 0.1 * rng() : 0, windows: 1 + Math.floor(rng() * 2.5), actions,
  };
}

// --- What must always hold ----------------------------------------------------------------
const TAB_SETS = ["syncKeyByTab", "syncRoleByTab", "keyByTab", "createdAt", "staleOpener", "firstPage", "newTabs"];
const WINDOW_SETS = ["lastOrder", "activeSpace"];
const EMPTY_WHEN_IDLE = ["syncBusy", "busy", "pending", "movedTabs", "moveTimers", "orderQueries", "refreshTimers", "showTimers", "viewTimers", "closedIn", "newTabs", "toForget", "awaitingIcon", "foldersTimers", "ownFolderMoves", "ownMoves"];
function logical(all, list) {
  const tabs = {};
  for (const [key, e] of Object.entries(all)) tabs[key] = { group: !!e.group, parentKey: e.parentKey ?? null, saved: e.saved?.url ?? null, name: e.own ? e.name : undefined, cookieStoreId: e.cookieStoreId, rank: e.rank };
  return { tabs, essentials: list.map(e => e.key) };
}

async function check(W, phase, { strong }) {
  const { ff, x } = W;
  const bad = (cat, msg) => W.bad(cat, `[${phase}] ${msg}`);
  // Nothing stuck: a job added now runs, within a job's time limit, and nothing keeps waking up.
  const before = W.violations.length;
  const answered = await W.clock.settled(x.js("serial(() => 'done')"), 6 * 60000).catch(() => null);
  if (answered !== "done") { bad("stuck", "the queue does not empty"); return; }
  if (!await W.clock.idle(30 * 60000)) bad("not-idle", "timers keep coming with nothing happening");

  const others = [...x.errors, ...ff.unhandled].filter(e => !e.includes(REFUSED));
  for (const e of new Set(others)) bad("error", e);

  const refused = ff.refusals > 0 && !strong; // the state may be off until the next start heals it
  const all = await W.read("getSynced()"), list = await W.read("getList()");
  const wins = W.windows(), tabs = W.allTabs();
  const mem = name => { try { return x.js(name); } catch { return null; } };
  const liveIds = new Set(ff.tabs.keys()), winIds = new Set(ff.wins.keys());

  // Memory and the session values say the same (the values are what a restart has).
  const keyOf = mem("syncKeyByTab"), roleOf = mem("syncRoleByTab");
  if (!refused) {
    for (const t of tabs) {
      if (keyOf.get(t.id) !== W.value(t, "syncKey") || (W.value(t, "syncKey") && roleOf.get(t.id) !== W.value(t, "syncRole"))) {
        bad("memory", `tab ${t.id} ${t.url}: memory ${keyOf.get(t.id)}/${roleOf.get(t.id)}, session ${W.value(t, "syncKey")}/${W.value(t, "syncRole")}`);
      }
    }
  }

  if (!refused) {
    // Every tab of the record: one representation in every window, one live tab.
    for (const [key, e] of Object.entries(all)) {
      // (A Sidebery folder page has quirks of its own that will go with Sidebery: a window
      // reopened brings its page back beside the one it was given, say.)
      if (e.group) continue;
      const reps = tabs.filter(t => W.value(t, "syncKey") === key);
      if (!(W.relaxed && !strong)) {
        for (const w of wins) {
          const n = reps.filter(t => t.windowId === w.id).length;
          if (n !== 1) bad("reps", `${key} ${e.url} has ${n} tabs in window ${w.id}`);
        }
      }
      const live = reps.filter(t => W.value(t, "syncRole") === "live");
      if (live.length > 1) bad("two-live", `${key} ${e.url} is live in ${live.map(t => t.id)}`);
      // None is fine, as long as nothing shows the page: a saved tab you closed, or tabs
      // brought back after a start with no session, have none until you select one.
      for (const t of reps) {
        // (An unloaded tab with the real address can be a ghost: see reconcileAll.)
        // (Where such a tab is then loaded by going to an address, it is put right at the next start.)
        if (strong && isWeb(t.url) && !t.discarded && W.value(t, "syncRole") !== "live") bad("page-not-live", `${key}: tab ${t.id} shows ${t.url} but is a ${W.value(t, "syncRole")}`);
      }
    }
    // No tab outside the record, except new tab pages and what is not a page.
    for (const t of tabs) {
      if (t.pinned) continue;
      const key = W.value(t, "syncKey");
      if (key && !all[key]) bad("stale-key", `tab ${t.id} ${t.url} has key ${key}, which is not in the record`);
      if (!key && (isWeb(t.url) || isPlaceholder(t.url) || isFolderPage(t.url))) bad("no-key", `tab ${t.id} in window ${t.windowId}: ${t.url} has no key`);
    }
    // Essentials: once in the list, once in every window, in the list's order, loaded once.
    const keys = list.map(e => e.key);
    if (new Set(keys).size !== keys.length) bad("essential-list", `twice in the list: ${keys}`);
    for (const w of wins) {
      const pinned = W.tabsOf(w).filter(t => t.pinned);
      for (const e of list) {
        const n = pinned.filter(t => W.value(t, "essentialKey") === e.key).length;
        if (n !== 1) bad("essential-copies", `${e.key} ${e.url} has ${n} copies in window ${w.id}`);
      }
      for (const t of pinned) {
        const k = W.value(t, "essentialKey");
        if (isWeb(t.url) && !keys.includes(k)) bad("essential-unknown", `pinned tab ${t.id} ${t.url} is no essential (${k})`);
        // (A value that was refused can stay behind on a placeholder: it shows and opens by its address.)
        if (isPlaceholder(t.url) && !keys.includes(k) && !ff.refusals) bad("essential-unknown", `pinned placeholder ${t.id} ${t.url}`);
      }
      // (A move in the moment a copy appears is not looked at: put right at the next start.)
      const shown = pinned.map(t => W.value(t, "essentialKey")).filter(k => keys.includes(k));
      if (strong && shown.join() !== keys.filter(k => shown.includes(k)).join()) bad("essential-order", `window ${w.id} has ${shown}, the list ${keys}`);
    }
    for (const e of list) {
      const loaded = tabs.filter(t => t.pinned && W.value(t, "essentialKey") === e.key && !t.discarded && isWeb(t.url));
      if (loaded.length > 1) bad("essential-loaded-twice", `${e.key} ${e.url} is loaded in ${loaded.map(t => t.id)}`);
    }
    // A placeholder costs nothing once settled, and nothing you look at stays blank.
    for (const t of tabs) {
      if (isPlaceholder(t.url) && !t.discarded && !t.active) bad("placeholder-loaded", `tab ${t.id} ${t.url} stays loaded`);
      if (t.active && isPlaceholder(t.url) && t.windowId === ff.focused) bad("blank", `tab ${t.id} ${t.url} is selected and stays blank`);
    }
    // Spaces: only the active space's tabs are shown (Tidier alone).
    if (W.alone) {
      const spaces = mem("activeSpace");
      for (const w of wins) {
        const space = spaces.get(w.id);
        if (!space) { bad("space", `window ${w.id} has no active space`); continue; }
        for (const t of W.tabsOf(w)) {
          const here = t.cookieStoreId === space || t.cookieStoreId === NO_CONTAINER;
          if (t.active && !here) bad("space-selected", `window ${w.id} is in ${space} but tab ${t.id} of ${t.cookieStoreId} is selected`);
          if (t.pinned) continue;
          if (here && t.hidden) bad("space-hidden", `window ${w.id} in ${space}: tab ${t.id} ${t.url} is hidden`);
          if (!here && !t.hidden && !t.active) bad("space-shown", `window ${w.id} in ${space}: tab ${t.id} of ${t.cookieStoreId} is shown`);
        }
        // What the sidebar has drawn is what is true now.
        if (ff.ports.has(w.id)) {
          const drawn = ff.views.get(w.id), fresh = await W.read(`viewFor(${w.id})`);
          if (JSON.stringify(drawn) !== JSON.stringify(fresh)) bad("stale-view", `window ${w.id}: drawn ${JSON.stringify(drawn)?.slice(0, 300)} is not ${JSON.stringify(fresh).slice(0, 300)}`);
        }
      }
    }
    // Recently Closed holds real pages, not placeholders.
    for (const c of ff.closedItems) if (c.kind === "tab" && isPlaceholder(c.state.url) && ff.wins.has(c.windowId)) bad("closed-placeholder", `${c.state.url}`);
  }

  // Nothing you did not close is gone. After a hard stop the last moment's change may not have
  // been written; such a tab is then known again by its address.
  // (Pinned, it is an essential now, at that address.)
  const addresses = new Set([...Object.values(all).flatMap(e => [e.url, e.saved?.url].filter(Boolean)), ...W.essentials.values()]);
  // (A tab opened again in its space is the same page under a new key: what you did to the
  // new one goes for the old one.)
  for (const [key, k] of W.known) if (W.excused.has(key)) for (const u of k.urls) W.closedAddresses.add(u);
  for (const [key, k] of W.known) {
    if (W.excused.has(key) || all[key] || (k.group && !W.alone)) continue;
    if ([...k.urls].some(u => addresses.has(u) || W.closedAddresses.has(u))) continue;
    bad("lost", `${key} (${[...k.urls].join(" ")}${k.saved ? ", saved" : ""}${k.group ? ", folder" : ""}) is gone`);
  }
  const listed = new Set(list.map(e => e.key));
  const listedUrls = new Set(list.map(e => e.url));
  for (const [key, url] of W.essentials) {
    if (W.goneEssentials.has(key) || listed.has(key) || listedUrls.has(url) || W.unpinnedUnknown) continue;
    bad("lost-essential", `${key} ${url} is gone from the list`);
  }

  // Lists in memory: nothing left of tabs and windows that are gone, nothing left waiting.
  for (const name of TAB_SETS) {
    const set = mem(name);
    if (!set) continue;
    for (const id of set.keys()) if (!liveIds.has(id)) bad("leak", `${name} still has tab ${id}`);
  }
  for (const name of WINDOW_SETS) {
    const set = mem(name);
    if (!set) continue;
    for (const id of set.keys()) if (!winIds.has(id)) bad("leak", `${name} still has window ${id}`);
  }
  // (After a refused call the tab it was about stays marked until the next start.)
  for (const name of refused ? [] : EMPTY_WHEN_IDLE) {
    const set = mem(name);
    if (set?.size) bad("leak", `${name} holds ${[...set.keys()].slice(0, 5)} with nothing happening`);
  }
  return W.violations.length === before;
}

async function start(W) {
  const { ff, seq } = W;
  W.x = null;
  if (seq.alone) ff.managed = { tidierAlone: true };
  for (let i = 0; i < seq.windows; i++) {
    const w = ff.addWindow({ focused: i === 0 });
    ff.addTab(w.id, { url: "about:home", active: true });
  }
  W.x = ff.boot();
  W.x.b.runtime.onInstalled.fire({ reason: "install" });
  await W.clock.run(1500);
  // Tidier starts a moment after its page, and is not to be used before it can answer.
  await W.observe();
}

// One sequence, from start to the last check. Returns what went wrong.
export async function play(seq, { trace = false } = {}) {
  const W = new World(seq);
  if (trace) W.ff.tracer = line => console.error(line);
  // A promise nobody handled is an error in Tidier, shown by `check`. node:test's own
  // listener would stop the run with no way to replay it, so it steps aside meanwhile.
  const onUnhandled = reason => { W.ff.noteUnhandled(reason, "a promise nobody handled"); };
  const runnerListeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", onUnhandled);
  try {
    await start(W);
    for (const act of seq.actions) {
      W.ff.rng = randoms(act.r);
      if (trace) console.error(`--- ${JSON.stringify(act)}`);
      await W.observe();
      await OPS[act.op].run(W, act);
      await W.clock.run(act.d);
    }
    W.ff.refuseRate = 0;
    await W.clock.run(2000);
    await W.observe();
    await check(W, "settled", { strong: false });
    if (W.violations.length) return W.violations;
    // Nothing may be lost across an update, or a restart. All is written by now.
    const a = logical(await W.read("getSynced()"), await W.read("getList()"));
    W.x = W.ff.update();
    await W.clock.run(5000);
    await check(W, "update", { strong: true });
    if (W.violations.length) return W.violations;
    const b = logical(await W.read("getSynced()"), await W.read("getList()"));
    if (W.ff.refusals === 0 && JSON.stringify(a) !== JSON.stringify(b)) W.bad("changed", `by an update: ${difference(a, b)}`);
    W.x = W.ff.restart();
    await W.clock.run(8000);
    await check(W, "restart", { strong: true });
    if (W.violations.length) return W.violations;
    const c = logical(await W.read("getSynced()"), await W.read("getList()"));
    if (JSON.stringify(b) !== JSON.stringify(c)) W.bad("changed", `by a restart: ${difference(b, c)}`);
    return W.violations;
  } catch (err) {
    return [{ cat: "crash", msg: `crash: ${err?.stack ?? err}` }];
  } finally {
    W.x?.kill();
    await new Promise(resolve => setImmediate(resolve)); // what is still on its way is told to us, not to the runner
    process.off("unhandledRejection", onUnhandled);
    for (const f of runnerListeners) process.on("unhandledRejection", f);
  }
}
function difference(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.tabs), ...Object.keys(b.tabs)])) {
    if (JSON.stringify(a.tabs[k]) !== JSON.stringify(b.tabs[k])) out.push(`${k}: ${JSON.stringify(a.tabs[k])} -> ${JSON.stringify(b.tabs[k])}`);
  }
  if (a.essentials.join() !== b.essentials.join()) out.push(`essentials ${a.essentials} -> ${b.essentials}`);
  return out.join("; ");
}

// --- Making a failure small ---------------------------------------------------------------
// The same kind of failure with fewer actions, by leaving out ever smaller parts.
export async function shrink(seq, kinds, { maxRuns = 400, maxMs = 60000 } = {}) {
  const t0 = Date.now();
  let runs = 0, best = seq;
  const still = async actions => {
    runs++;
    const v = await play({ ...best, actions });
    return v.some(x => kinds.has(x.cat));
  };
  for (let size = Math.ceil(best.actions.length / 2); size >= 1;) {
    let shrunk = false;
    for (let at = 0; at < best.actions.length && runs < maxRuns && Date.now() - t0 < maxMs;) {
      const without = [...best.actions.slice(0, at), ...best.actions.slice(at + size)];
      if (await still(without)) { best = { ...best, actions: without }; shrunk = true; } else at += size;
    }
    if (runs >= maxRuns || Date.now() - t0 >= maxMs) break;
    if (size === 1 && !shrunk) break;
    size = shrunk ? size : Math.ceil(size / 2);
    if (size < 1) size = 1;
  }
  // Waiting that the failure does not need.
  for (let i = 0; i < best.actions.length && runs < maxRuns && Date.now() - t0 < maxMs; i++) {
    if (!best.actions[i].d) continue;
    const actions = best.actions.map((a, j) => (j === i ? { ...a, d: 0 } : a));
    if (await still(actions)) best = { ...best, actions };
  }
  return best;
}

export function describe(seq, violations) {
  const line = JSON.stringify(seq);
  return [
    `Seed ${seq.seed}, ${seq.alone ? "Tidier alone" : "the Sidebery paths"}, ${seq.actions.length} actions:`,
    ...seq.actions.map(a => `  ${a.op} (then ${a.d} ms)`),
    "What went wrong:",
    ...[...new Set(violations.map(v => v.msg))].slice(0, 12).map(m => `  ${m}`),
    "To replay it:",
    `  CHAOS_REPLAY='${line}' node --test tests/chaos.test.mjs`,
    `  (CHAOS_TRACE=1 in front shows every call and event)`,
  ].join("\n");
}

// --- The tests -----------------------------------------------------------------------------
const env = process.env;
const FIRST = Number(env.CHAOS_FIRST ?? 1);
const SEQUENCES = Number(env.CHAOS_SEQUENCES ?? 120);
const SECONDS = Number(env.CHAOS_SECONDS ?? 8); // for each of the two tests; 0: no limit

async function campaign(alone) {
  const t0 = Date.now();
  let played = 0;
  for (let seed = FIRST; seed < FIRST + SEQUENCES; seed++) {
    if (SECONDS && Date.now() - t0 > SECONDS * 1000) break;
    const seq = generate(seed, alone);
    const v = await play(seq);
    played++;
    if (!v.length) continue;
    const small = await shrink(seq, new Set(v.map(x => x.cat)));
    const again = await play(small);
    assert.fail(`\n${describe(small, again.length ? again : v)}\n`);
  }
  console.log(`# chaos: ${played} sequences in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${alone ? "Tidier alone" : "Sidebery paths"}`);
}

// All seeds, on past a failure: how many of each kind, and one short example of each.
async function survey(alone) {
  const t0 = Date.now(), kinds = new Map(), errors = new Map();
  let played = 0, failed = 0;
  for (let seed = FIRST; seed < FIRST + SEQUENCES; seed++) {
    if (SECONDS && Date.now() - t0 > SECONDS * 1000) break;
    const seq = generate(seed, alone), v = await play(seq);
    played++;
    if (v.length) failed++;
    for (const cat of new Set(v.map(x => x.cat))) {
      if (!kinds.has(cat)) kinds.set(cat, { n: 0, seq });
      kinds.get(cat).n++;
    }
    for (const e of v.filter(x => x.cat === "error")) { const m = e.msg.replace(/ID: \d+/g, "ID"); errors.set(m, (errors.get(m) ?? 0) + 1); }
  }
  console.log(`# chaos survey (${alone ? "Tidier alone" : "Sidebery paths"}): ${failed} of ${played} sequences failed, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const [cat, k] of [...kinds].sort((a, b) => b[1].n - a[1].n)) console.log(`#   ${cat}: ${k.n} (first: seed ${k.seq.seed})`);
  for (const [m, n] of [...errors].sort((a, b) => b[1] - a[1])) console.log(`#     ${n} × ${m}`);
  const show = Number(env.CHAOS_SHOW ?? 3);
  for (const [cat, k] of [...kinds].sort((a, b) => b[1].n - a[1].n).slice(0, show)) {
    const small = await shrink(k.seq, new Set([cat]), { maxMs: 20000 });
    console.log(`\n=== ${cat}\n${describe(small, (await play(small)).filter(v => v.cat === cat))}`);
  }
  return failed;
}

if (env.CHAOS_SURVEY) {
  test("survey", async () => { await survey(env.CHAOS_SURVEY !== "off"); });
} else if (env.CHAOS_REPLAY) {
  test("the sequence asked for", async () => {
    const seq = JSON.parse(env.CHAOS_REPLAY);
    const v = await play(seq, { trace: !!env.CHAOS_TRACE });
    if (v.length) assert.fail(`\n${describe(seq, v)}\n`);
  });
} else {
  test("random use breaks nothing Tidier promises (Tidier alone)", () => campaign(true));
  test("random use breaks nothing Tidier promises (the Sidebery paths)", () => campaign(false));
  test("the same seed gives the same run", async () => {
    const seq = generate(7, true);
    const once = async () => {
      const W = new World({ ...seq, refuseRate: 0 });
      await start(W);
      for (const act of seq.actions.slice(0, 15)) {
        W.ff.rng = randoms(act.r);
        await W.observe();
        await OPS[act.op].run(W, act);
        await W.clock.run(act.d);
      }
      const shape = [...W.ff.wins.values()].map(w => w.order.map(id => { const t = W.ff.tabs.get(id); return [t.id, t.url, t.active, t.hidden]; }));
      W.x.kill();
      return JSON.stringify(shape);
    };
    assert.equal(await once(), await once());
  });
}
