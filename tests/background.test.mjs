// Tidier's real background scripts on a fake Firefox (fake_firefox.mjs): what
// must hold when a start goes wrong, since a mistake there can lose tabs for good.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", GONE = "firefox-container-9";
const FOLDER = "moz-extension://sb/sidebery/group.html#F";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });

function record(ff) {
  ff.store.syncedTabs = {
    F: entry(FOLDER, { group: true }),
    saved: entry("https://a.example/board", { parentKey: "F", saved: { url: "https://a.example/board", title: "Board" } }),
    plain: entry("https://b.example/plain"),
  };
}

// Firefox started with one window holding only a new tab.
function emptySession(ff) {
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  return w;
}

async function run(ff, event = "onStartup") {
  const x = ff.boot();
  x.b.runtime[event].fire({ reason: "update" });
  await wait(1200);
  // A window being filled takes a while; give up long after any real start.
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

test("a start with no synced tab keeps the record, and the window gets every tab", async () => {
  const ff = new FakeFirefox();
  record(ff);
  const w = emptySession(ff);
  const x = await run(ff);
  assert.deepEqual(Object.keys(ff.synced).sort(), ["F", "plain", "saved"]);
  assert.equal(ff.urls(w.id).filter(u => u.startsWith("ghost.html")).length, 2);
  assert.ok(ff.urls(w.id).includes(FOLDER));
  x.kill();
});

test("an update with no window open keeps the record", async () => {
  const ff = new FakeFirefox();
  record(ff);
  const x = await run(ff, "onInstalled");
  assert.deepEqual(Object.keys(ff.synced).sort(), ["F", "plain", "saved"]);
  x.kill();
});

test("with other tabs still there, a tab with no copy is gone, but a saved one comes back", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    here: entry("https://c.example/"),
    closed: entry("https://b.example/plain"),
    saved: entry("https://a.example/board", { saved: { url: "https://a.example/board", title: "Board" } }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://c.example/", active: true }, { syncKey: "here", syncRole: "live" });
  const x = await run(ff);
  assert.deepEqual(Object.keys(ff.synced).sort(), ["here", "saved"]);
  assert.ok(ff.urls(w.id).includes(GHOST("ghost", "saved").replace("moz-extension://tidier/", "")));
  x.kill();
});

test("an essential in a removed container does not stop Tidier", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [
    { key: "dead", url: "https://dead.example/", cookieStoreId: GONE, title: "Dead", icon: "x" },
    { key: "fine", url: "https://fine.example/", cookieStoreId: C1, title: "Fine", icon: "x" },
  ];
  record(ff);
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://b.example/plain", active: true, cookieStoreId: C1 }, { syncKey: "plain", syncRole: "live" });
  const other = ff.addWindow();
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "plain"), active: false, cookieStoreId: C1 }, { syncKey: "plain", syncRole: "ghost" });
  const x = await run(ff);
  assert.equal(x.started(), true);
  assert.ok(ff.list(w.id).some(t => t.pinned && t.url.startsWith(GHOST("essential", "fine"))), "the other essential still arrives");
  assert.ok(ff.list(other.id).some(t => t.url === GHOST("ghost", "saved")), "the window still gets its tabs");
  // Selecting the ghost pulls the live tab in; with Tidier stopped it stays blank.
  ff.focused = other.id;
  x.b.windows.onFocusChanged.fire(other.id);
  await wait(500);
  ff.select(ghost.id);
  await wait(3000);
  assert.ok(ff.list(other.id).some(t => t.url === "https://b.example/plain"));
  x.kill();
});

test("a tab refused while reading roles leaves the record whole", async () => {
  const ff = new FakeFirefox();
  record(ff);
  const w = ff.addWindow({ focused: true });
  const live = ff.addTab(w.id, { url: "https://b.example/plain", active: true, cookieStoreId: C1 }, { syncKey: "plain", syncRole: "live" });
  ff.addTab(w.id, { url: "https://a.example/board", cookieStoreId: C1 }, { syncKey: "saved", syncRole: "live" });
  ff.addTab(w.id, { url: FOLDER, cookieStoreId: C1 }, { syncKey: "F", syncRole: "copy" });
  const closing = ff.addTab(w.id, { url: "https://gone.example/" });
  ff.hooks.getTabValue = async id => { if (id === closing.id) throw new Error(`Invalid tab ID: ${id}`); };
  const x = await run(ff);
  assert.equal(x.started(), true);
  assert.deepEqual(Object.keys(ff.synced).sort(), ["F", "plain", "saved"]);
  assert.equal(ff.tabs.get(live.id).url, "https://b.example/plain");
  x.kill();
});

test("removing a container removes its essentials", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [
    { key: "dead", url: "https://dead.example/", cookieStoreId: GONE, title: "Dead", icon: "x" },
    { key: "fine", url: "https://fine.example/", cookieStoreId: C1, title: "Fine", icon: "x" },
  ];
  emptySession(ff);
  const x = await run(ff);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: GONE } });
  await wait(1000);
  assert.deepEqual(ff.store.essentials.map(e => e.key), ["fine"]);
  x.kill();
});

// --- Archiving --------------------------------------------------------------
async function keepReason(ff, x, key) {
  const r = await x.send({ type: "archiveNow", now: Date.now() + 13 * 3600e3, keys: [key], explain: true });
  return r.kept[key] ?? (r.archived.length ? "archived" : "?");
}

test("a live tab that is only a placeholder is not archived, a real page is", async () => {
  const ff = new FakeFirefox();
  ff.store.archiveSince = 1;
  ff.store.syncedTabs = { handed: entry("https://a.example/"), real: entry("https://b.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  ff.addTab(w.id, { url: GHOST("ghost", "handed"), discarded: true, cookieStoreId: C1, lastAccessed: 1 }, { syncKey: "handed", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", discarded: true, cookieStoreId: C1, lastAccessed: 1 }, { syncKey: "real", syncRole: "live" });
  const x = await run(ff);
  assert.equal(await keepReason(ff, x, "handed"), "placeholder");
  assert.equal(await keepReason(ff, x, "real"), "archived");
  x.kill();
});

// --- Essentials -------------------------------------------------------------
const four = () => ["a", "b", "c", "d"].map(key => ({ key, url: `https://${key}.example/`, cookieStoreId: C1, title: key, icon: "x" }));
const essentialTab = (ff, w, key, url = GHOST("essential", key)) =>
  ff.addTab(w.id, { url, pinned: true, discarded: url !== `https://${key}.example/`, cookieStoreId: C1 }, { essentialKey: key });

test("an essential reopened with ⌘⇧T is there once, and a move keeps every essential", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = four();
  const w = ff.addWindow({ focused: true });
  for (const k of ["a", "b", "c", "d"]) essentialTab(ff, w, k);
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = await run(ff);
  // As SessionStore does it: created pinned, with its key, while the placeholder is back.
  const reopened = essentialTab(ff, w, "a", "https://a.example/");
  x.b.tabs.onCreated.fire(ff.snap(reopened));
  await wait(1000);
  const copies = ff.list(w.id).filter(t => ff.values.get(t.id)?.essentialKey === "a");
  assert.deepEqual(copies.map(t => t.id), [reopened.id]);
  await ff.ext.b.tabs.move(ff.list(w.id).find(t => ff.values.get(t.id)?.essentialKey === "d").id, { index: 1 });
  await wait(1000);
  assert.deepEqual([...ff.store.essentials.map(e => e.key)].sort(), ["a", "b", "c", "d"]);
  x.kill();
});

test("two copies of one essential in a window never push another out of the list", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = four();
  const w = ff.addWindow({ focused: true });
  // The order that lost an essential: a, a, d, b, c. (The real page first, so
  // the start does not take the double away before the move.)
  const first = essentialTab(ff, w, "a", "https://a.example/");
  for (const k of ["d", "b", "c"]) essentialTab(ff, w, k);
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = await run(ff);
  const second = ff.addTab(w.id, { url: "https://a.example/", pinned: true, cookieStoreId: C1, index: 1 }, { essentialKey: "a" });
  await x.js("onEssentialMoved")(w.id);
  await wait(500);
  assert.deepEqual([...ff.store.essentials.map(e => e.key)].sort(), ["a", "b", "c", "d"]);
  assert.ok(ff.tabs.has(first.id) && ff.tabs.has(second.id), "a loaded copy is not closed");
  x.kill();
});

test("a list that already holds a key twice is repaired at start", async () => {
  const ff = new FakeFirefox();
  const [a, b] = four();
  ff.store.essentials = [a, a, b];
  emptySession(ff);
  const x = await run(ff);
  assert.deepEqual(ff.store.essentials.map(e => e.key), ["a", "b"]);
  x.kill();
});

test("an extra placeholder of an essential goes at start, a loaded copy stays", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = four().slice(0, 1);
  const w = ff.addWindow({ focused: true });
  const ghost = essentialTab(ff, w, "a");
  const real = essentialTab(ff, w, "a", "https://a.example/");
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = await run(ff);
  assert.ok(!ff.tabs.has(ghost.id));
  assert.ok(ff.tabs.has(real.id));
  x.kill();
});

// --- Placeholders -----------------------------------------------------------
async function placeholderReady(ff, x, t, icon) {
  x.send({ type: "ghostReady", icon }, { tab: ff.snap(t), url: t.url });
  await wait(100);
}
function finishLoad(ff, x, t) {
  t.status = "complete";
  x.b.tabs.onUpdated.fire(t.id, { status: "complete" }, ff.snap(t));
}

test("a placeholder that takes long to finish loading still unloads", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  const t = ff.addTab(other.id, { url: GHOST("ghost", "a"), status: "loading", cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  await placeholderReady(ff, x, t, false);
  await wait(6000); // longer than the three seconds it used to wait before giving up
  assert.equal(t.discarded, false);
  finishLoad(ff, x, t);
  await wait(100);
  assert.equal(t.discarded, true);
  assert.equal(x.js("awaitingIcon.size"), 0);
  x.kill();
});

test("a placeholder waits for its icon, but not for ever", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  const shows = ff.addTab(other.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const never = ff.addTab(other.id, { url: GHOST("ghost", "b"), cookieStoreId: C1 });
  const x = await run(ff);
  await placeholderReady(ff, x, shows, true);
  await placeholderReady(ff, x, never, true);
  await wait(1000);
  assert.equal(shows.discarded, false, "not before its icon shows");
  shows.favIconUrl = "https://a.example/favicon.ico";
  x.b.tabs.onUpdated.fire(shows.id, { favIconUrl: shows.favIconUrl }, ff.snap(shows));
  await wait(100);
  assert.equal(shows.discarded, true);
  await wait(10000);
  assert.equal(never.discarded, true);
  x.kill();
});

// --- In daily use -----------------------------------------------------------
// Two windows and two tabs live in the first, with ghosts in the second, which you use.
async function twoWindows(ff) {
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/") };
  const home = ff.addWindow();
  const liveA = ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const liveB = ff.addTab(home.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:home", active: true });
  const ghostA = ff.addTab(here.id, { url: GHOST("ghost", "a"), cookieStoreId: C1, discarded: true }, { syncKey: "a", syncRole: "ghost" });
  const ghostB = ff.addTab(here.id, { url: GHOST("ghost", "b"), cookieStoreId: C1, discarded: true }, { syncKey: "b", syncRole: "ghost" });
  const x = await run(ff);
  return { x, home, here, liveA, liveB, ghostA, ghostB };
}

test("a ghost selected right after another is pulled in too", async () => {
  const ff = new FakeFirefox();
  const { x, here, liveA, liveB, ghostA, ghostB } = await twoWindows(ff);
  ff.select(ghostA.id);
  await wait(150);
  ff.select(ghostB.id);
  await wait(2000);
  assert.equal(ff.tabs.get(liveB.id).windowId, here.id, "the second live tab came");
  assert.equal(ff.tabs.get(liveB.id).active, true);
  assert.equal(ff.tabs.get(liveA.id).windowId, here.id, "the first one too");
  x.kill();
});

test("a pull that waited in the queue does not take the selection back", async () => {
  const ff = new FakeFirefox();
  const { x, home, liveA, ghostA } = await twoWindows(ff);
  const other = ff.addTab(ghostA.windowId, { url: "about:blank", cookieStoreId: C1 });
  x.js("serial(() => sleep(500))");
  ff.select(ghostA.id);
  ff.select(other.id);
  await wait(1500);
  assert.equal(ff.tabs.get(other.id).active, true);
  assert.equal(ff.tabs.get(liveA.id).windowId, home.id);
  x.kill();
});

test("a tab closed right after it was pulled in closes everywhere", async () => {
  const ff = new FakeFirefox();
  const { x, liveA, ghostA } = await twoWindows(ff);
  ff.select(ghostA.id);
  await wait(100);
  ff.rm(liveA.id);
  await wait(1500);
  assert.ok(!("a" in ff.synced), "gone from the record");
  assert.ok(![...ff.values.values()].some(v => v.syncKey === "a"), "gone from every window");
  x.kill();
});

test("a title that ticks does not rewrite the record at every tick", async () => {
  const ff = new FakeFirefox();
  const { x, liveA } = await twoWindows(ff);
  await wait(1000);
  const before = ff.storeWrites || 0;
  for (let i = 0; i < 15; i++) {
    liveA.title = `(${i}) A`;
    x.b.tabs.onUpdated.fire(liveA.id, { title: liveA.title }, ff.snap(liveA));
    await wait(1000);
  }
  assert.ok((ff.storeWrites || 0) - before <= 2, `${(ff.storeWrites || 0) - before} writes`);
  // Anything that matters is still written at once.
  liveA.title = "(x) A";
  x.b.tabs.onUpdated.fire(liveA.id, { title: liveA.title }, ff.snap(liveA));
  x.js(`getSynced().then(all => { delete all.b; saveSynced(all); })`);
  await wait(600);
  assert.ok(!("b" in ff.synced));
  assert.equal(ff.synced.a.title, "(x) A");
  x.kill();
});

test("a page load that changes nothing writes nothing", async () => {
  const ff = new FakeFirefox();
  const { x, liveA } = await twoWindows(ff);
  liveA.title = ff.store.syncedTabs.a.title;
  await wait(1000);
  const before = ff.storeWrites || 0;
  x.b.tabs.onUpdated.fire(liveA.id, { status: "complete" }, ff.snap(liveA));
  await wait(1000);
  assert.equal((ff.storeWrites || 0) - before, 0);
  x.kill();
});

test("a loaded page with unsaved input is kept when archiving, and the others go", async () => {
  const ff = new FakeFirefox();
  ff.store.archiveSince = 1;
  ff.store.syncedTabs = { typed: entry("https://a.example/"), plain: entry("https://b.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const typed = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1, lastAccessed: 1 }, { syncKey: "typed", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1, lastAccessed: 1 }, { syncKey: "plain", syncRole: "live" });
  const x = await run(ff);
  ff.refuseDiscard = new Set([typed.id]);
  const r = await x.send({ type: "archiveNow", now: Date.now() + 13 * 3600e3, keys: ["typed", "plain"], explain: true });
  assert.equal(r.kept.typed, "unsaved");
  assert.deepEqual([...r.archived], ["https://b.example/"]);
  assert.ok(ff.tabs.has(typed.id));
  x.kill();
});

test("a job that never ends does not stop the queue for good", async () => {
  const ff = new FakeFirefox();
  emptySession(ff);
  const x = await run(ff);
  x.js("serial(() => new Promise(() => {}))");
  x.js(`globalThis.ranAfter = false; serial(() => { globalThis.ranAfter = true; })`);
  await wait(1000);
  assert.equal(x.js("ranAfter"), false);
  await wait(5 * 60000 + 500);
  assert.equal(x.js("ranAfter"), true);
  assert.match(x.js("problems.join()"), /time limit/);
  x.kill();
});

test("errors inside Tidier are kept for the tests to see", async () => {
  const ff = new FakeFirefox();
  emptySession(ff);
  const x = await run(ff);
  x.js(`serial(() => { throw new Error("on purpose"); })`);
  await wait(100);
  assert.match(x.js("problems.join()"), /on purpose/);
  assert.equal(x.js("work.errors"), 1);
  x.kill();
});

test("an unloaded tab moved to another window keeps its values", async () => {
  const ff = new FakeFirefox();
  const { x, home, here, liveB } = await twoWindows(ff);
  ff.tabs.get(liveB.id).discarded = true;
  ff.values.delete(liveB.id); // as Firefox does for an unloaded tab
  await x.b.tabs.move(liveB.id, { windowId: here.id, index: 0 });
  await wait(1500);
  assert.equal(ff.values.get(liveB.id)?.syncKey, "b");
  assert.equal(ff.values.get(liveB.id)?.syncRole, "live");
  assert.ok(ff.list(home.id).some(t => ff.values.get(t.id)?.syncKey === "b"), "the window it left has its ghost");
  x.kill();
});

test("a ghost selected before a start is done opens its tab then", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow();
  const live = ff.addTab(home.id, { url: "https://a.example/", cookieStoreId: C1, active: true }, { syncKey: "a", syncRole: "live" });
  const here = ff.addWindow({ focused: true });
  const ghost = ff.addTab(here.id, { url: GHOST("ghost", "a"), cookieStoreId: C1, active: true }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  assert.equal(ff.tabs.get(live.id).windowId, here.id);
  assert.ok(!ff.tabs.has(ghost.id));
  x.kill();
});

test("a real page counts as the live tab, whatever its role says", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w1 = ff.addWindow({ focused: true });
  const loaded = ff.addTab(w1.id, { url: "https://a.example/", cookieStoreId: C1, active: true }, { syncKey: "a", syncRole: "ghost" });
  const w2 = ff.addWindow();
  const old = ff.addTab(w2.id, { url: "https://a.example/", cookieStoreId: C1, discarded: true }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  assert.equal(ff.values.get(loaded.id).syncRole, "live");
  assert.equal(ff.values.get(old.id).syncRole, "ghost");
  x.kill();
});

test("placeholders Firefox closed at an update are not left in Recently Closed", async () => {
  const ff = new FakeFirefox();
  emptySession(ff);
  ff.recentlyClosed = [{ tab: { url: GHOST("ghost", "x"), windowId: 1, sessionId: "1" } }, { tab: { url: "https://real.example/", windowId: 1, sessionId: "2" } }];
  const x = await run(ff);
  assert.deepEqual(ff.recentlyClosed.map(c => c.tab.sessionId), ["2"]);
  x.kill();
});

// --- A copy of Tidier's data ---------------------------------------------------------
test("a copy can be made, and a failure to is shown", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = four().slice(0, 1);
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  emptySession(ff);
  const x = await run(ff);
  x.b.runtime.sendNativeMessage = async (host, msg) => { ff.copied = msg.backup; return { saved: "file" }; };
  await x.js("makeCopy()");
  assert.deepEqual(Object.keys(ff.copied.data.syncedTabs), ["a"]);
  assert.equal(ff.copied.data.essentials[0].key, "a");
  assert.ok(ff.store.lastCopy > 0);
  x.b.runtime.sendNativeMessage = async () => { throw new Error("no host"); };
  await x.js("makeCopy()");
  assert.equal(ff.badge, "!");
  x.kill();
});

test("a copy is taken in by merging: only the chosen spaces, and nothing removed", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "here", url: "https://here.example/", cookieStoreId: C1, title: "Here", icon: "x" }];
  ff.store.syncedTabs = { mine: entry("https://mine.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://mine.example/", active: true, cookieStoreId: C1 }, { syncKey: "mine", syncRole: "live" });
  const x = await run(ff);
  const C2 = "firefox-container-2";
  const copy = { data: {
    essentials: [
      { key: "e1", url: "https://e1.example/", cookieStoreId: C1, title: "E1" },
      { key: "e2", url: "https://e2.example/", cookieStoreId: C2, title: "E2" },
      { key: "dup", url: "https://here.example/", cookieStoreId: C1, title: "Here" },
    ],
    syncedTabs: {
      F: entry("moz-extension://sb/sidebery/group.html#Work", { group: true }),
      kept: entry("https://kept.example/deep", { parentKey: "F", saved: { url: "https://kept.example/", title: "Kept" } }),
      skip: entry("https://skip.example/"),
      other: entry("https://other.example/", { cookieStoreId: C2, parentKey: "G", saved: { url: "https://other.example/", title: "Other" } }),
      G: entry("moz-extension://sb/sidebery/group.html#Elsewhere", { group: true, cookieStoreId: C2 }),
    },
  } };
  const r = await x.js("mergeCopy")(copy, [C1]);
  assert.deepEqual({ ...r }, { essentials: 1, folders: 1, tabs: 1 });
  await wait(1000);
  assert.deepEqual(ff.store.essentials.map(e => e.key).sort(), ["e1", "here"]);
  assert.deepEqual(Object.keys(ff.synced).sort(), ["F", "kept", "mine"]);
  assert.equal(ff.synced.kept.url, "https://kept.example/", "back at its saved address");
  assert.ok(ff.urls(w.id).includes("https://mine.example/"));
  assert.ok(ff.list(w.id).some(t => t.url === GHOST("ghost", "kept")));
  x.kill();
});

// --- Tidier alone ----------------------------------------------------------------------
async function alone(ff) {
  ff.managed = { tidierAlone: true };
  ff.containers.add("firefox-container-4");
  return run(ff);
}

test("with the setting off, nothing is hidden or reopened", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/", { cookieStoreId: "firefox-container-2" }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: "firefox-container-2" }, { syncKey: "b", syncRole: "live" });
  const x = await run(ff);
  ff.select(ff.list(w.id)[1].id);
  await wait(500);
  const fresh = ff.addTab(w.id, { url: "about:newtab" });
  x.b.tabs.onCreated.fire(ff.snap(fresh));
  await wait(500);
  assert.equal(x.js("tidierAlone"), false);
  assert.ok(ff.tabs.has(fresh.id), "not opened again");
  assert.ok(!ff.log.some(l => l[0] === "hide"));
  assert.equal(ff.commandsSet, undefined, "keys are left to Sidebery");
  x.kill();
});

test("folders are in the record and no tab event can delete them", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  const t = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  const key = await x.js("createFolder")("Work", C1);
  await x.js("moveTab")(w.id, t.id, null, key);
  await wait(500);
  assert.equal(ff.synced[key].name, "Work");
  assert.equal(ff.synced.a.parentKey, key);
  assert.ok(ff.synced.a.saved, "a tab in a folder is saved");
  // Another start: the folder has no tab, and stays. No tab appears for it.
  x.kill();
  const y = await run(ff);
  assert.ok(ff.synced[key]);
  assert.equal(ff.list(w.id).length, 1);
  // Deleting it keeps the tab, as an ordinary tab.
  await y.js("deleteFolder")(key);
  await wait(500);
  assert.ok(!ff.synced[key]);
  assert.equal(ff.synced.a.parentKey, null);
  assert.ok(!ff.synced.a.saved);
  y.kill();
});

test("closing a saved tab in Tidier's own folder unloads it", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: { group: true, own: true, name: "Work", cookieStoreId: C1, parentKey: null, rank: 1 }, a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "A" } }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const t = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  await wait(500);
  ff.rm(t.id);
  await wait(1000);
  assert.ok(ff.synced.a);
  assert.ok(ff.list(w.id).some(y => y.url === GHOST("ghost", "a")));
  x.kill();
});

test("a rule opens an address in its space, for a tab's first page only", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "/^https:\\/\\/work\\.example\\//", space: "firefox-container-2" }];
  const w = ff.addWindow({ focused: true });
  const home = ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(t));
  await wait(100);
  ff.navigate(t.id, "https://work.example/page");
  await wait(500);
  assert.ok(!ff.tabs.has(t.id), "the first page moved it");
  assert.ok(ff.list(w.id).some(y => y.url === "https://work.example/page" && y.cookieStoreId === "firefox-container-2"));
  // A tab that already has a page stays when it passes through the address (a sign-in).
  const other = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(other));
  ff.navigate(other.id, "https://other.example/");
  await wait(200);
  ff.navigate(other.id, "https://work.example/sign-in");
  await wait(500);
  assert.ok(ff.tabs.has(other.id));
  assert.ok(ff.tabs.has(home.id));
  x.kill();
});

// --- Moving over from Sidebery ------------------------------------------------------------
test("moving over keeps every folder and tab, and moving back brings the pages back", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: entry("moz-extension://sb/sidebery/group.html#Work", { group: true }),
    a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "A" } }),
    b: entry("https://b.example/"),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "moz-extension://sb/sidebery/group.html#Work", cookieStoreId: C1 }, { syncKey: "F", syncRole: "copy" });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const x = await run(ff);
  let reloaded = 0;
  x.b.runtime.reload = () => { reloaded++; };
  x.b.runtime.sendNativeMessage = async () => ({ saved: "file" });
  const report = await x.js("moveReport")();
  assert.deepEqual(JSON.parse(JSON.stringify(report.folders.map(f => [f.name, f.tabs]))), [["Work", 1]]);
  await x.js("moveOver")();
  assert.equal(reloaded, 1);
  assert.equal(ff.store.tidierAlone, true);
  assert.equal(ff.store.syncedTabs.F.own, true, "the record is written before Tidier starts again");
  assert.equal(ff.store.syncedTabs.F.name, "Work");
  // Tidier starts again: only now is the page closed, and every tab stays.
  x.kill();
  const y = await run(ff, "onInstalled");
  assert.equal(y.js("tidierAlone"), true);
  assert.ok(!ff.list(w.id).some(t => t.url.includes("group.html")));
  assert.deepEqual(Object.keys(ff.synced).sort(), ["F", "a", "b"]);
  assert.ok(ff.synced.a.saved);
  // And back.
  let again = 0;
  y.b.runtime.reload = () => { again++; };
  await y.js("moveBack")();
  assert.equal(again, 1);
  assert.equal(ff.store.tidierAlone, false);
  assert.ok(ff.list(w.id).some(t => t.url.includes("group.html")));
  assert.equal(ff.store.syncedTabs.F.url, "moz-extension://sb/sidebery/group.html#Work");
  assert.ok(!ff.store.syncedTabs.F.own);
  y.kill();
});

test("Sidebery's rules and order of spaces come from its export", async () => {
  const ff = new FakeFirefox();
  emptySession(ff);
  const x = await run(ff);
  const r = await x.js("importSidebery")({
    containers: {
      "firefox-container-1": { id: "firefox-container-1", reopenRulesActive: true, reopenRules: [{ active: true, url: "/^https:\\/\\/a\\//" }, { active: false, url: "off" }] },
      "firefox-container-2": { id: "firefox-container-2", reopenRulesActive: false, reopenRules: [{ active: true, url: "ignored" }] },
    },
    sidebar: { nav: ["p2", "p1", "settings"], panels: { p1: { newTabCtx: "firefox-container-1" }, p2: { newTabCtx: "firefox-container-2" } } },
  });
  assert.deepEqual({ ...r }, { rules: 1, order: 2 });
  await wait(500);
  assert.deepEqual(ff.store.rules, [{ url: "/^https:\\/\\/a\\//", space: "firefox-container-1" }]);
  assert.deepEqual(ff.store.spaceOrder, ["firefox-container-2", "firefox-container-1"]);
  x.kill();
});

test("a tab's first web page in no container is opened again in the active space", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const home = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const x = await alone(ff);
  await wait(200);
  const typed = ff.addTab(w.id, { url: "about:blank", active: false });
  x.b.tabs.onCreated.fire(ff.snap(typed));
  await wait(4000); // long after a new tab is expected to have got an address
  ff.navigate(typed.id, "https://typed.example/");
  await wait(500);
  assert.ok(!ff.tabs.has(typed.id));
  assert.ok(ff.list(w.id).some(t => t.url === "https://typed.example/" && t.cookieStoreId === C1));
  assert.ok(ff.tabs.has(home.id));
  x.kill();
});

test("an essential unpinned while loaded is an ordinary synced tab again", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const t = ff.addTab(w.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const other = ff.addWindow();
  ff.addTab(other.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  await x.b.tabs.update(t.id, { pinned: false });
  await wait(3000);
  const key = ff.values.get(t.id)?.syncKey;
  assert.ok(key, "it has a key");
  assert.ok(ff.synced[key]);
  assert.ok(ff.list(other.id).some(y => y.url === GHOST("ghost", key)), "and a ghost in the other window");
  x.kill();
});


test("a new tab dragged in the sidebar and given an address at once is synced", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const other = ff.addWindow();
  ff.addTab(other.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await alone(ff);
  const fresh = ff.addTab(w.id, { url: "about:newtab", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(fresh));
  await wait(2000); // long after a new tab is looked at for the first time
  await x.js(`moveTab(${w.id}, ${fresh.id}, ${ff.list(w.id)[0].id}, undefined)`);
  ff.navigate(fresh.id, "https://typed.example/");
  await wait(3000);
  const key = ff.values.get(fresh.id)?.syncKey;
  assert.ok(key, "it has a key");
  assert.ok(ff.list(other.id).some(t => t.url === GHOST("ghost", key)), "and a ghost in the other window");
  x.kill();
});

test("a tab dragged to another window during a pull, or just after it was made, leaves no gap", async () => {
  for (const mark of ["pulling++", id => `syncBusy.add(${id})`]) {
    const ff = new FakeFirefox();
    ff.store.syncedTabs = { a: entry("https://a.example/") };
    const home = ff.addWindow({ focused: true });
    ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
    const from = ff.addWindow();
    ff.addTab(from.id, { url: "about:blank", active: true });
    const ghost = ff.addTab(from.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
    const to = ff.addWindow();
    ff.addTab(to.id, { url: "about:blank", active: true });
    ff.addTab(to.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
    const x = await run(ff);
    x.js(typeof mark === "string" ? mark : mark(ghost.id));
    await x.b.tabs.move(ghost.id, { windowId: to.id, index: 1 });
    await wait(3000);
    assert.equal(ff.urls(from.id).filter(u => u.startsWith("ghost.html")).length, 1, "the window it left gets it back");
    assert.equal(ff.urls(to.id).filter(u => u.startsWith("ghost.html")).length, 1, "and the window it came to has it once");
    x.kill();
  }
});

test("a ghost pinned just after it was made leaves tab sync, and is an essential", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "about:blank", active: true });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  x.js(`syncBusy.add(${ghost.id})`); // as createRep does for a second and a half
  await x.b.tabs.update(ghost.id, { pinned: true });
  await wait(3000);
  assert.deepEqual(Object.keys(ff.synced), [], "it has left the record");
  assert.equal(ff.store.essentials.length, 1);
  x.kill();
});

test("a page that finishes loading just after a pull still updates the record", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  const live = ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  x.js(`syncBusy.add(${live.id})`);
  ff.navigate(live.id, "https://a.example/next", "Next");
  await wait(1000);
  assert.equal(ff.synced.a.url, "https://a.example/next");
  x.kill();
});

test("a link put in its space is not in Recently Closed, so ⌘⇧T does not open it twice", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const x = await alone(ff);
  await wait(200);
  // The newest is the tab Tidier replaces; the one before it, with the same address, you closed.
  ff.recentlyClosed = [
    { tab: { url: "https://link.example/", sessionId: "replaced", windowId: w.id } },
    { tab: { url: "https://b.example/", sessionId: "yours", windowId: w.id } },
    { tab: { url: "https://link.example/", sessionId: "yours too", windowId: w.id } },
  ];
  const link = ff.addTab(w.id, { url: "about:blank", active: true });
  x.b.tabs.onCreated.fire(ff.snap(link));
  ff.navigate(link.id, "https://link.example/");
  await wait(1000);
  assert.ok(ff.list(w.id).some(t => t.url === "https://link.example/" && t.cookieStoreId === C1), "it is in the space");
  assert.deepEqual(ff.recentlyClosed.map(c => c.tab.sessionId), ["yours", "yours too"]);
  x.kill();
});

test("a tab closed in the middle of its pull does not leave its ghost behind", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow();
  ff.addTab(home.id, { url: "about:blank", active: true });
  const live = ff.addTab(home.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:blank", active: true });
  const ghost = ff.addTab(here.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  // ⌘W comes as the tab arrives, before the bookkeeping is done: its values are refused.
  const update = x.b.tabs.update;
  x.b.tabs.update = async (id, p) => { const r = await update(id, p); if (id === live.id && p.active) ff.rm(live.id); return r; };
  ff.select(ghost.id);
  await wait(3000);
  assert.deepEqual(ff.synced, {}, "it is closed");
  assert.equal(ff.list(here.id).filter(t => t.url.startsWith("moz-extension")).length, 0, "and no placeholder is left of it");
  assert.equal(x.js("syncKeyByTab.size"), 0, "and Tidier does not remember it");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("closing a tab everywhere closes the others, also when one of them is gone by then", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const windows = [ff.addWindow({ focused: true }), ff.addWindow(), ff.addWindow()];
  for (const w of windows) ff.addTab(w.id, { url: "about:blank", active: true });
  const live = ff.addTab(windows[0].id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const gone = ff.addTab(windows[1].id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const stays = ff.addTab(windows[2].id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  // The window with the other ghost is closing at this very moment: Firefox no longer has it.
  const query = x.b.tabs.query;
  x.b.tabs.query = async q => { const tabs = await query(q); if (ff.tabs.has(gone.id) && q.windowId === undefined) ff.rm(gone.id, { closing: true }); return tabs; };
  ff.rm(live.id);
  await wait(1000);
  x.b.tabs.query = query;
  assert.ok(!ff.tabs.has(stays.id), "the other ghost is closed");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});
