// Tidier's real background scripts on a fake Firefox (fake_firefox.mjs): what
// must hold when a start goes wrong, since a mistake there can lose tabs for good.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";
import { ChaosFirefox } from "./chaos_firefox.mjs";

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
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const other = ff.addWindow();
  const shows = ff.addTab(other.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const never = ff.addTab(other.id, { url: GHOST("ghost", "b"), cookieStoreId: C1 }, { syncKey: "b", syncRole: "ghost" });
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


// --- Found by random use (chaos.test.mjs) ----------------------------------------------
// On the fake that follows Firefox's source, with virtual time: each of these once left
// tabs in the wrong state, for good.
async function chaosStart({ windows = 2, ...options } = {}) {
  const ff = new ChaosFirefox(options);
  const made = [];
  for (let i = 0; i < windows; i++) {
    const w = ff.addWindow({ focused: i === 0 });
    ff.addTab(w.id, { url: "about:home", active: true });
    made.push(w);
  }
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "install" });
  await ff.clock.run(3000);
  return { ff, x, windows: made };
}

test("a window closed right after it opened leaves nothing behind", async () => {
  const { ff, x } = await chaosStart({ windows: 1 });
  const { window: w } = ff.openWindow();
  ff.closeWindow(w.id);
  await ff.clock.idle(60000);
  assert.ok(!x.js("lastOrder").has(w.id));
  x.kill();
});

test("a window closed while it is being filled is not an error", async () => {
  const { ff, x, windows: [w] } = await chaosStart({ windows: 1 });
  ff.openTab(w.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const { window: fresh } = ff.openWindow();
  await ff.clock.run(205); // the moment Tidier starts on it
  ff.closeWindow(fresh.id);
  await ff.clock.idle(60000);
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

test("a tab opened while Tidier is starting is seen when it has started", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "about:home", active: true });
  ff.boot().b.runtime.onInstalled.fire({ reason: "install" });
  await ff.clock.run(300);
  const t = ff.openTab(w.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.idle(60000);
  const key = ff.values.get(t.id)?.syncKey;
  assert.ok(ff.synced[key], "it is in the record");
  assert.ok(ff.list(other.id).some(y => ff.values.get(y.id)?.syncKey === key), "and in the other window");
  ff.ext.kill();
});

test("a link that started Firefox goes to the active space (Tidier alone)", async () => {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: "firefox-container-2", title: "E", icon: "x" }];
  ff.store.syncedTabs = { a: entry("https://a.example/", { cookieStoreId: "firefox-container-2" }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://e.example/", pinned: true, active: true, cookieStoreId: "firefox-container-2" }, { essentialKey: "e" });
  ff.addTab(w.id, { url: "https://a.example/", discarded: true, cookieStoreId: "firefox-container-2" }, { syncKey: "a", syncRole: "live" });
  ff.boot().b.runtime.onStartup.fire();
  await ff.clock.run(300);
  ff.openTab(w.id, { url: "https://link.example/", active: true });
  await ff.clock.idle(60000);
  const opened = ff.list(w.id).filter(t => t.url === "https://link.example/");
  assert.deepEqual(opened.map(t => t.cookieStoreId), ["firefox-container-2"]);
  assert.ok(ff.values.get(opened[0].id)?.syncKey, "and it is synced");
  ff.ext.kill();
});

test("a window reopened after the last one closed has an active space, and hides the others", async () => {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.syncedTabs = {
    a: entry("https://a.example/", { cookieStoreId: "firefox-container-1" }),
    b: entry("https://b.example/", { cookieStoreId: "firefox-container-2" }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: "firefox-container-1" }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", discarded: true, hidden: true, cookieStoreId: "firefox-container-2" }, { syncKey: "b", syncRole: "live" });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.run(8000);
  ff.closeWindow(w.id);
  await ff.clock.run(1000);
  assert.equal(x.js("activeSpace").size, 0);
  const { window: fresh } = ff.openWindow();
  await ff.clock.idle(60000);
  assert.ok(x.js("activeSpace").get(fresh.id), "it has a space");
  const shownSpaces = new Set(ff.list(fresh.id).filter(t => !t.hidden && t.url.includes("ghost")).map(t => t.cookieStoreId));
  assert.ok(shownSpaces.size <= 1, `tabs of ${[...shownSpaces]} are shown`);
  x.kill();
});

test("an unloaded essential you closed is not left in Recently Closed", async () => {
  const { ff, x, windows: [w] } = await chaosStart({ windows: 1 });
  ff.store.essentials = [];
  const t = ff.openTab(w.id, { url: "https://e.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.run(3000);
  const other = ff.openWindow().window;
  await ff.clock.idle(60000);
  const copy = ff.list(other.id).find(y => y.pinned);
  assert.ok(copy.url.includes("ghost.html"), "the other window has a placeholder");
  ff.closeTab(copy.id);
  await ff.clock.idle(60000);
  assert.deepEqual(ff.closedItems.filter(c => c.kind === "tab" && c.state.url.includes("ghost.html")), []);
  assert.equal(ff.list(other.id).filter(y => y.pinned).length, 1, "and the copy is back");
  x.kill();
});

test("a tab dragged to another window just after it was created is handled", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(1700); // registered, and its ghost in the other window is just there
  const key = ff.values.get(t.id).syncKey;
  const ghost = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key);
  ff.moveTabs([ghost.id], { windowId: a.id, index: -1 });
  await ff.clock.idle(60000);
  for (const w of [a, b]) assert.equal(ff.list(w.id).filter(y => ff.values.get(y.id)?.syncKey === key).length, 1, `one in window ${w.id}`);
  x.kill();
});

test("a window is not closed because its last tab is used in another", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart({ closeWindowWithLastTab: true });
  const t = ff.openTab(a.id, { url: "https://a.example/", active: true, cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.closeTab(ff.list(a.id).find(y => y.url === "about:home").id); // only the live tab is left in the first window
  await ff.clock.run(1000);
  ff.focusWindow(b.id);
  const ghost = ff.list(b.id).find(y => y.url.includes("ghost.html"));
  ff.select(ghost.id);
  await ff.clock.idle(60000);
  assert.ok(ff.wins.has(a.id), "the first window is still there");
  assert.equal(ff.tabs.get(t.id).windowId, b.id, "the tab came");
  assert.ok(ff.list(a.id).some(y => y.url.includes("ghost.html")), "and left a ghost");
  assert.deepEqual([...x.js("problems")], []);
  assert.deepEqual(ff.unhandled, []);
  x.kill();
});

test("a ghost closing at the same moment does not leave the tab's other ghosts behind", async () => {
  // Firefox refuses a whole list of tabs if one has closed, whenever it happens to fall.
  for (const delay of [0, 1, 2, 3, 4, 5, 6, 8, 10, 13, 16, 20]) {
    const { ff, x, windows: [a, b, c] } = await chaosStart({ windows: 3 });
    const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
    await ff.clock.run(3000);
    const key = ff.values.get(t.id).syncKey;
    const inB = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key);
    ff.closeTab(t.id);
    await ff.clock.run(delay);
    ff.closeTab(inB.id);
    await ff.clock.idle(60000);
    assert.deepEqual(ff.list(c.id).filter(y => ff.values.get(y.id)?.syncKey === key), [], `with ${delay} ms between them`);
    assert.deepEqual([...x.js("problems")], [], `with ${delay} ms between them`);
    x.kill();
  }
});

test("a tab closed while it is being pinned does not stop the rest", async () => {
  for (const delay of [0, 2, 4, 6, 8, 10, 13, 16, 20, 30]) {
    const { ff, x, windows: [a, b] } = await chaosStart();
    const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
    await ff.clock.run(3000);
    const key = ff.values.get(t.id).syncKey;
    ff.pinTab(t);
    await ff.clock.run(delay);
    ff.closeTab(t.id);
    await ff.clock.idle(60000);
    assert.deepEqual(ff.list(b.id).filter(y => ff.values.get(y.id)?.syncKey === key), [], `with ${delay} ms between them`);
    assert.deepEqual([...x.js("problems")], [], `with ${delay} ms between them`);
    x.kill();
  }
});

test("the space you switched to with the bar is the one you are in after a restart", async () => {
  const C2 = "firefox-container-2";
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/", { cookieStoreId: C2 }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const inC2 = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C2 }, { syncKey: "b", syncRole: "live" });
  let x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.run(8000);
  ff.select(inC2.id); // written, as it always was
  await ff.clock.run(500);
  await ff.clock.settled(x.js(`switchSpace(${w.id}, "${C1}")`));
  await ff.clock.idle(60000);
  x = ff.restart();
  await ff.clock.idle(60000);
  const [win] = ff.wins.values();
  assert.equal(x.js("activeSpace").get(win.id), C1);
  assert.equal(ff.list(win.id).find(t => t.active).cookieStoreId, C1);
  x.kill();
});

test("an essential's copy closed just after it was created comes back", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  // Its copy in the other window has just appeared.
  while (!ff.list(b.id).some(y => y.pinned)) await ff.clock.step();
  await ff.clock.run(100);
  ff.closeTab(ff.list(b.id).find(y => y.pinned).id);
  await ff.clock.idle(60000);
  assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1);
  x.kill();
});

test("a new tab you dragged a moment ago still gets synced when it gets an address", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const fresh = ff.openTab(a.id, { url: "about:newtab", active: true });
  await ff.clock.run(2000); // long after its creation was looked at
  await ff.clock.settled(x.js("moveInWindow")(ff.list(a.id), fresh.id, ff.list(a.id)[0].id)); // as the sidebar's drag does
  ff.load(fresh, "https://typed.example/");
  await ff.clock.idle(60000);
  const key = ff.values.get(fresh.id)?.syncKey;
  assert.ok(key, "it has a key");
  assert.ok(ff.list(b.id).some(y => ff.values.get(y.id)?.syncKey === key), "and a ghost in the other window");
  x.kill();
});

test("a tab pinned while Tidier was just busy with it leaves tab sync", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", active: true, cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  await ff.clock.settled(x.js("moveInWindow")(ff.list(a.id), t.id, ff.list(a.id)[0].id)); // busy for a while
  ff.pinTab(t);
  await ff.clock.idle(60000);
  assert.ok(!(key in ff.synced));
  assert.equal(ff.values.get(t.id)?.syncKey, undefined);
  assert.equal(ff.list(b.id).filter(y => ff.values.get(y.id)?.syncKey === key).length, 0, "its ghost has gone");
  assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1, "and there is a copy");
  x.kill();
});

test("a tab pinned in the moment of an update becomes an essential", async () => {
  const { ff, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  ff.pinTab(t);
  const x = ff.update();
  await ff.clock.idle(60000);
  assert.ok(!(key in ff.synced));
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://a.example/"]);
  assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1);
  x.kill();
});

test("a tab whose last copy Firefox closes at an update comes back, saved or not", async () => {
  const { ff, x: first, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  ff.openTab(b.id, { url: "https://other.example/", cookieStoreId: "firefox-container-1" }); // the session is here
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  // Only its placeholder in the other window is left, selected and so loaded, there.
  ff.closeWindow(a.id);
  await ff.clock.run(1000);
  ff.focusWindow(-1);
  ff.select(ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key).id);
  await ff.clock.run(1000);
  assert.ok(ff.list(b.id).every(y => ff.values.get(y.id)?.syncKey !== key || !y.discarded));
  const x = ff.update();
  await ff.clock.idle(60000);
  assert.ok(ff.synced[key], "it is still in the record");
  assert.ok(ff.list(b.id).some(y => ff.values.get(y.id)?.syncKey === key), "and in the window");
  first.kill(); x.kill();
});

test("a placeholder whose values were lost is taken back at a start, not doubled", async () => {
  const { ff, x: first, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  const ghost = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key);
  ff.values.delete(ghost.id); // as Firefox does for an unloaded tab moved to another window
  first.kill();
  const x = ff.update();
  await ff.clock.idle(60000);
  assert.equal(ff.list(b.id).filter(y => y.url === GHOST("ghost", key)).length, 1);
  assert.equal(ff.values.get(ghost.id)?.syncKey, key);
  assert.equal(ff.values.get(ghost.id)?.syncRole, "ghost");
  x.kill();
});

test("an essential's placeholder whose value was lost is known by its address", async () => {
  const ff = new ChaosFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.idle(60000);
  assert.equal(ff.list(w.id).filter(t => t.pinned).length, 1);
  x.kill();
});

test("a new tab page you pinned is an essential once it has an address", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "about:newtab", active: true });
  await ff.clock.run(1000);
  ff.pinTab(t);
  await ff.clock.run(1000);
  ff.load(t, "https://later.example/");
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://later.example/"]);
  assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1, "the other window has it");
  x.kill();
});

test("a copy whose value is refused does not stay busy for good", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.run(10);
  ff.refusePattern = /^sessions\.setTabValue$/;
  ff.refuseRate = 1;
  await ff.clock.idle(60000);
  assert.ok(ff.refusals > 0);
  assert.deepEqual([...x.js("busy")].filter(id => ff.list(b.id).some(y => y.id === id)), []);
  x.kill();
});

test("at a start, a pinned page the list does not know is an essential, and a placeholder of none goes", async () => {
  const ff = new ChaosFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const page = ff.addTab(w.id, { url: "https://cut-off.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "made-a-moment-before" });
  const stale = ff.addTab(w.id, { url: GHOST("essential", "gone"), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "gone" });
  ff.addTab(w.id, { url: "about:home", active: true });
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "about:home", active: true });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials.map(e => e.key).sort(), ["e", "made-a-moment-before"]);
  assert.equal(ff.values.get(page.id).essentialKey, "made-a-moment-before");
  assert.ok(!ff.tabs.has(stale.id));
  assert.equal(ff.list(other.id).filter(t => t.pinned).length, 2);
  x.kill();
});

test("a tab pinned just as it gets an address is not opened again in a space", async () => {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.run(8000);
  const t = ff.openTab(w.id, { url: "about:blank" });
  await ff.clock.run(10);
  ff.load(t, "https://link.example/");
  await ff.clock.run(6);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  assert.ok(ff.tabs.has(t.id), "your tab stays");
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://link.example/"]);
  assert.equal(ff.list(w.id).filter(y => y.pinned).length, 1, "and is there once");
  x.kill();
});

test("a tab dragged to another window right after a pull is handled", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  ff.focusWindow(b.id);
  ff.select(ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key).id);
  while (ff.tabs.get(t.id).windowId !== b.id) await ff.clock.step();
  await ff.clock.run(200); // the pull is done, and has marked the tab for a little longer
  ff.moveTabs([t.id], { windowId: a.id, index: -1 });
  await ff.clock.idle(60000);
  for (const w of [a, b]) assert.equal(ff.list(w.id).filter(y => ff.values.get(y.id)?.syncKey === key).length, 1, `one in window ${w.id}`);
  x.kill();
});

test("an essential reopened with ⌘⇧T while loaded in another window ends up loaded once", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", active: true, cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.run(3000);
  ff.focusWindow(b.id);
  ff.select(ff.list(b.id).find(y => y.pinned).id); // it moves to the second window
  await ff.clock.idle(60000);
  ff.closeTab(ff.list(b.id).find(y => y.pinned).id); // closed there, it stays in Recently Closed
  await ff.clock.run(1000);
  const again = ff.list(a.id).find(y => y.pinned);
  ff.focusWindow(a.id);
  ff.select(again.id); // and is opened again in the first
  await ff.clock.idle(60000);
  ff.focusWindow(b.id);
  ff.reopenLast();
  await ff.clock.idle(60000);
  const loaded = [...ff.tabs.values()].filter(y => y.pinned && !y.discarded && y.url === "https://e.example/");
  assert.equal(loaded.length, 1, `loaded in ${loaded.map(y => y.windowId)}`);
  x.kill();
});

test("a copy unpinned just after it appeared becomes an ordinary tab", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  while (!ff.list(b.id).some(y => y.pinned)) await ff.clock.step();
  await ff.clock.run(100);
  ff.unpinTab(ff.tabs.get(ff.list(b.id).find(y => y.pinned).id));
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials, []);
  assert.ok(!ff.list(b.id).some(y => y.url.includes("ghost.html") && !ff.values.get(y.id)?.syncKey), "no placeholder stands for nothing");
  x.kill();
});

test("a tab whose only copy is in a closing window goes to the other windows", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  // The other window does not have it (still being filled, say).
  const ghost = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key);
  x.js(`forget(${ghost.id})`);
  ff.closeTab(ghost.id);
  await ff.clock.run(1000);
  ff.closeWindow(a.id);
  await ff.clock.idle(60000);
  assert.ok(ff.synced[key], "it is in the record");
  assert.ok(ff.list(b.id).some(y => ff.values.get(y.id)?.syncKey === key), "and in the window left");
  x.kill();
});

test("a tab dragged to another window while it is being registered gets its ghost right", async () => {
  // It depends on the moment, so every moment around it.
  for (let delay = 1490; delay < 1560; delay++) {
    const { ff, x, windows: [a, b] } = await chaosStart({ seed: delay });
    const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
    await ff.clock.run(delay);
    ff.moveTabs([t.id], { windowId: b.id, index: -1 });
    await ff.clock.idle(60000);
    const key = ff.values.get(t.id).syncKey;
    for (const w of [a, b]) assert.equal(ff.list(w.id).filter(y => ff.values.get(y.id)?.syncKey === key).length, 1, `after ${delay} ms, one in window ${w.id}`);
    x.kill();
  }
});

test("a ghost selected before the roles are read, with the live tab loaded, ends up unloaded", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  const live = ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const here = ff.addWindow();
  ff.addTab(here.id, { url: "about:home", active: true });
  const ghost = ff.addTab(here.id, { url: GHOST("ghost", "a"), discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.run(50);
  ff.select(ghost.id); // in the window you are not using: shown, and asks if it should open; nothing is known yet
  await ff.clock.idle(60000);
  const loaded = [...ff.tabs.values()].filter(t => !t.discarded && t.url === "https://a.example/");
  assert.deepEqual(loaded.map(t => t.id), [live.id], "loaded once, the page you had");
  assert.equal(ff.values.get(live.id).syncRole, "live");
  x.kill();
});

test("a tab dragged to a window that then closes at once is not lost", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart({ closeWindowWithLastTab: false });
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  ff.openTab(a.id, { url: "https://other.example/", cookieStoreId: "firefox-container-1" }); // the session is here
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  ff.moveTabs([t.id], { windowId: b.id, index: -1 });
  ff.closeWindow(b.id);
  await ff.clock.idle(60000);
  assert.ok(ff.synced[key], "it is in the record");
  assert.ok(ff.list(a.id).some(y => ff.values.get(y.id)?.syncKey === key), "and in the window left");
  x.kill();
});

test("after a start the selected tab decides the space, whatever the window remembers", async () => {
  const C2 = "firefox-container-2";
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/", { cookieStoreId: C2 }) };
  const w = ff.addWindow({ focused: true });
  ff.winValues.set(w.id, { space: C2 });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addTab(w.id, { url: "https://b.example/", discarded: true, cookieStoreId: C2 }, { syncKey: "b", syncRole: "live" });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.idle(60000);
  assert.equal(x.js("activeSpace").get(w.id), C1);
  assert.equal(ff.winValues.get(w.id).space, C1);
  assert.equal(ff.tabs.get(other.id).hidden, true);
  x.kill();
});

test("a tab pinned and closed at once, reopened, is an essential and no synced tab", async () => {
  const { ff, x, windows: [a] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", active: true, cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.run(40); // its essential's key is on it, its synced key not yet gone
  ff.closeTab(t.id);
  await ff.clock.idle(60000);
  const reopened = ff.reopenLast();
  await ff.clock.idle(60000);
  assert.equal(ff.values.get(reopened.id)?.syncKey, undefined);
  assert.equal(ff.values.get(reopened.id)?.syncRole, undefined);
  assert.equal(x.js("syncKeyByTab").get(reopened.id), undefined);
  x.kill();
});

test("what could not be written is tried again", async () => {
  const { ff, x, windows: [a] } = await chaosStart({ windows: 1 });
  ff.refusePattern = /^storage\.local\.set$/;
  ff.refuseRate = 1;
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  assert.ok(!ff.store.syncedTabs?.[key], "refused so far");
  ff.refuseRate = 0;
  await ff.clock.idle(120000);
  assert.ok(ff.store.syncedTabs[key]);
  x.kill();
});

test("a copy not pinned at an update: you unpinned it with Tidier alone, with Sidebery it was on its way", async () => {
  const start = async alone => {
    const ff = new ChaosFirefox();
    if (alone) ff.managed = { tidierAlone: true };
    const a = ff.addWindow({ focused: true }), b = ff.addWindow();
    ff.addTab(a.id, { url: "about:home", active: true });
    ff.addTab(b.id, { url: "about:home", active: true });
    ff.boot().b.runtime.onInstalled.fire({ reason: "install" });
    await ff.clock.run(3000);
    const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
    await ff.clock.run(3000);
    ff.pinTab(t);
    return { ff, b };
  };
  {
    const { ff, b } = await start(true);
    await ff.clock.idle(60000);
    ff.unpinTab(ff.tabs.get(ff.list(b.id).find(y => y.pinned).id));
    const x = ff.update();
    await ff.clock.idle(60000);
    assert.deepEqual(ff.store.essentials, []);
    assert.ok(![...ff.tabs.values()].some(y => y.url.includes("kind=essential")));
    x.kill();
  }
  {
    const { ff, b } = await start(false);
    while (!ff.list(b.id).some(y => y.url.includes("kind=essential"))) await ff.clock.step(); // created, not pinned yet
    await ff.clock.run(400);
    assert.ok(ff.list(b.id).some(y => y.url.includes("kind=essential") && !y.pinned));
    await ff.clock.settled(ff.ext.js("flushWrites()"));
    const x = ff.update();
    await ff.clock.idle(60000);
    assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://e.example/"], "the essential stays");
    assert.equal(ff.list([...ff.wins.keys()][1]).filter(y => y.pinned).length, 1, "and the copy is pinned");
    x.kill();
  }
});

test("a window opened while Tidier is starting gets its tabs when it has started", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  // After the look over the windows, before the start is done: a sweep, since it depends on timing.
  await ff.clock.run(5040);
  const { window: fresh } = ff.openWindow();
  await ff.clock.idle(60000);
  assert.ok(ff.list(fresh.id).some(t => ff.values.get(t.id)?.syncKey === "a"));
  x.kill();
});

test("a placeholder reopened before Recently Closed forgets it is no double", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  const ghost = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key);
  // As SessionStore brings it back: a new tab, with the values it had.
  const reopened = ff.openTab(b.id, { url: ghost.url, active: false, cookieStoreId: ghost.cookieStoreId, restored: { tab: { url: ghost.url, title: ghost.title }, values: ff.values.get(ghost.id) } });
  await ff.clock.idle(60000);
  assert.equal(ff.list(b.id).filter(y => y.url === ghost.url).length, 1);
  assert.equal(x.js("syncKeyByTab").has(reopened.id) === ff.tabs.has(reopened.id), true);
  x.kill();
});

test("an essential reopened after you unpinned it is an essential again", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", active: true, cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  ff.closeTab(t.id); // the loaded copy, closed by you: an unloaded one takes its place
  await ff.clock.idle(60000);
  ff.unpinTab(ff.tabs.get(ff.list(b.id).find(y => y.pinned).id));
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials, []);
  ff.focusWindow(a.id);
  const reopened = ff.reopenLast();
  await ff.clock.idle(60000);
  assert.ok(reopened.pinned);
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://e.example/"]);
  assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1, "the other window has it");
  x.kill();
});

test("an essential's copy closed in the moment it is created comes back", async () => {
  for (const delay of [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30]) {
    const { ff, x, windows: [a, b] } = await chaosStart({ seed: delay });
    x.js("tidierAlone = true"); // created pinned, so it can be closed at once
    const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: "firefox-container-1" });
    await ff.clock.run(3000);
    ff.pinTab(t);
    while (!ff.list(b.id).some(y => y.pinned)) await ff.clock.step();
    await ff.clock.run(delay);
    const copy = ff.list(b.id).find(y => y.pinned);
    if (copy) ff.closeTab(copy.id);
    await ff.clock.idle(60000);
    assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1, `closed after ${delay} ms`);
    x.kill();
  }
});

test("an essential's copy dragged just after it appeared is not there twice", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(t);
  while (!ff.list(b.id).some(y => y.pinned)) await ff.clock.step();
  await ff.clock.run(100);
  ff.moveTabs([ff.list(b.id).find(y => y.pinned).id], { windowId: a.id, index: 1 });
  await ff.clock.idle(60000);
  for (const w of [a, b]) assert.equal(ff.list(w.id).filter(y => y.pinned).length, 1, `one in window ${w.id}`);
  x.kill();
});

test("a tab pinned the moment its window comes back is not also a synced tab", async () => {
  const { ff, x, windows: [a] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", active: true, cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  ff.closeWindow(a.id);
  await ff.clock.run(1000);
  const back = ff.reopenLast();
  const again = ff.list(back.id).find(y => ff.values.get(y.id)?.syncKey === key && y.url === "https://a.example/");
  ff.pinTab(ff.tabs.get(again.id));
  await ff.clock.idle(60000);
  assert.ok(!(key in ff.synced));
  assert.equal(ff.values.get(again.id)?.syncKey, undefined);
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://a.example/"]);
  x.kill();
});

test("an unloaded essential dragged to a window arrives once, also if it looks unpinned at first", async () => {
  // Firefox shows it unpinned for a moment: the arrival is looked at in that moment or after.
  for (let seed = 1; seed <= 12; seed++) {
    const { ff, x, windows: [a, b] } = await chaosStart({ seed });
    const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: "firefox-container-1" });
    await ff.clock.run(3000);
    ff.pinTab(t);
    await ff.clock.idle(60000);
    const copy = ff.list(b.id).find(y => y.pinned && y.discarded);
    ff.moveTabs([copy.id], { windowId: a.id, index: ff.pinnedCount(a) });
    await ff.clock.idle(60000);
    for (const w of [a, b]) assert.equal(ff.list(w.id).filter(y => y.pinned).length, 1, `seed ${seed}: one in window ${w.id}`);
    x.kill();
  }
});

test("a tab closed in the moment it is registered gets no ghosts", async () => {
  // It depends on the moment, so every moment around it.
  for (let delay = 1490; delay < 1560; delay++) {
    const { ff, x, windows: [a, b] } = await chaosStart({ seed: delay });
    const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
    await ff.clock.run(delay);
    const url = t.url;
    ff.closeTab(t.id);
    await ff.clock.idle(60000);
    assert.deepEqual(ff.list(b.id).filter(y => y.url.includes("ghost.html")).map(y => y.url), [], `closed after ${delay} ms`);
    assert.deepEqual(Object.values(ff.synced ?? {}).filter(e => e.url === url), [], `closed after ${delay} ms`);
    x.kill();
  }
});

test("a window reopened while Tidier is starting is taken back, not doubled", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", discarded: true, cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const other = ff.addWindow();
  const gone = ff.addTab(other.id, { url: GHOST("ghost", "a"), active: true, discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  ff.addTab(other.id, { url: GHOST("ghost", "b"), discarded: true, cookieStoreId: C1 }, { syncKey: "b", syncRole: "ghost" });
  assert.ok(gone);
  ff.closeWindow(other.id); // it is in Recently Closed
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.run(5100); // past the look over the windows, not done yet
  const back = ff.reopenLast();
  await ff.clock.idle(60000);
  assert.equal(ff.list(back.id).filter(t => ff.values.get(t.id)?.syncKey === "a").length, 1);
  assert.equal(ff.list(back.id).filter(t => ff.values.get(t.id)?.syncKey === "b").length, 1);
  for (const t of ff.list(back.id)) assert.equal(x.js("syncKeyByTab").get(t.id), ff.values.get(t.id)?.syncKey, "and known again");
  x.kill();
});

test("in the moment after an update Tidier alone knows it is alone", async () => {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  const a = ff.addWindow({ focused: true }), b = ff.addWindow();
  ff.addTab(a.id, { url: "about:home", active: true });
  ff.addTab(b.id, { url: "about:home", active: true });
  ff.boot().b.runtime.onInstalled.fire({ reason: "install" });
  await ff.clock.run(3000);
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  const x = ff.update();
  await ff.clock.run(100);
  assert.equal(x.js("tidierAlone"), true);
  ff.pinTab(t); // before Tidier has started again
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://e.example/"], "it stays an essential");
  assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1, "with a copy in the other window");
  x.kill();
});

test("a window that closes after its live tab was dragged out does not make a second live tab", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  const third = ff.openWindow().window;
  await ff.clock.idle(60000);
  // Live in the first window, dragged to the last, then the first closes at once.
  ff.moveTabs([t.id], { windowId: third.id, index: -1 });
  ff.closeWindow(a.id);
  await ff.clock.idle(60000);
  const live = [...ff.tabs.values()].filter(y => ff.values.get(y.id)?.syncKey === key && ff.values.get(y.id)?.syncRole === "live");
  assert.deepEqual(live.map(y => y.id), [t.id]);
  assert.equal(ff.list(b.id).filter(y => ff.values.get(y.id)?.syncKey === key).length, 1);
  x.kill();
});

test("a placeholder you are looking at opens when the window with its page closes", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", active: true, cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  const ghost = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === key);
  ff.select(ghost.id); // selected in the window you are not using: it stays a placeholder there
  await ff.clock.run(1000);
  assert.ok(ff.tabs.get(ghost.id).url.includes("ghost.html"));
  ff.closeWindow(a.id);
  await ff.clock.idle(60000);
  assert.equal(ff.tabs.get(ghost.id).url, "https://a.example/");
  x.kill();
});

test("a move Firefox ignores does not make the next one you make not count", async () => {
  const { ff, x, windows: [a] } = await chaosStart({ windows: 1 });
  const one = ff.openTab(a.id, { url: "https://one.example/", cookieStoreId: "firefox-container-1" });
  const two = ff.openTab(a.id, { url: "https://two.example/", cookieStoreId: "firefox-container-1" });
  await ff.clock.run(3000);
  ff.pinTab(one);
  ff.pinTab(two);
  await ff.clock.idle(60000);
  const stale = ff.list(a.id).filter(y => y.pinned).map(y => y.id);
  await ff.clock.settled(x.js("sortEssentials")(a.id, [...ff.store.essentials].reverse())); // moved, as if in another order
  await ff.clock.settled(x.js("sortEssentials")(a.id, ff.store.essentials));
  assert.equal(x.js("ownMoves").size, 0);
  assert.equal(stale.length, 2);
  x.kill();
});

test("an essential's tile shows the title its page has now", async () => {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "install" });
  await ff.clock.run(3000);
  ff.connectSidebar(w.id);
  const t = ff.openTab(w.id, { url: "https://e.example/", active: true, cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  t.title = "(3) E";
  ff.updated(t, { title: t.title });
  await ff.clock.idle(60000);
  assert.equal(ff.views.get(w.id).essentials[0].title, "(3) E");
  x.kill();
});

// --- What ⌘⇧T brings back, and what else a second look at the chaos test found ------------
const closedPages = ff => ff.closedItems.filter(c => c.kind === "tab").map(c => c.state.url);
async function aloneStart({ windows = 2 } = {}) {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  const made = [];
  for (let i = 0; i < windows; i++) {
    const w = ff.addWindow({ focused: i === 0 });
    ff.addTab(w.id, { url: "about:home", active: true, cookieStoreId: C1 });
    made.push(w);
  }
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "install" });
  await ff.clock.run(3000);
  return { ff, x, windows: made };
}

test("a link opened again in its space is not left in Recently Closed, but the page you then close is", async () => {
  const { ff, x, windows: [w] } = await aloneStart({ windows: 1 });
  ff.openTab(w.id, { url: "https://link.example/", active: true }); // from another app: no container
  await ff.clock.run(1000);
  const page = ff.list(w.id).find(t => t.url === "https://link.example/");
  assert.equal(page.cookieStoreId, C1, "it is in the space");
  assert.deepEqual(closedPages(ff), [], "and its first copy is not what ⌘⇧T brings back");
  ff.closeTab(page.id);
  await ff.clock.idle(60000);
  assert.deepEqual(closedPages(ff), ["https://link.example/"]);
  x.kill();
});

test("a tab moved to another space is not left in Recently Closed in the space it left", async () => {
  const { ff, x, windows: [w] } = await aloneStart({ windows: 1 });
  const t = ff.openTab(w.id, { url: "https://m.example/", active: true, cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.connectSidebar(w.id);
  await ff.clock.run(100);
  ff.sidebarSays(w.id, { type: "moveToSpace", tabId: t.id, space: "firefox-container-2" });
  await ff.clock.idle(60000);
  assert.deepEqual(ff.list(w.id).filter(y => y.url === "https://m.example/").map(y => y.cookieStoreId), ["firefox-container-2"]);
  assert.deepEqual(closedPages(ff), []);
  x.kill();
});

test("a placeholder you pin does not leave its page in Recently Closed, to come back beside the essential", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://p.example/", active: true, cookieStoreId: C1 });
  await ff.clock.run(3000);
  const ghost = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === ff.values.get(t.id).syncKey);
  ff.pinTab(ff.tabs.get(ghost.id));
  await ff.clock.idle(60000);
  assert.ok(!ff.tabs.has(t.id), "the page was closed");
  assert.deepEqual(closedPages(ff), []);
  x.kill();
});

test("a loaded essential closed because you unpinned its copy is not left in Recently Closed", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", active: true, cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  ff.unpinTab(ff.tabs.get(ff.list(b.id).find(y => y.pinned).id));
  await ff.clock.idle(60000);
  assert.ok(!ff.tabs.has(t.id), "the loaded copy was closed");
  assert.deepEqual(closedPages(ff), [], "the page is open in the other window now");
  x.kill();
});

test("a ghost with a real address that goes as a double is not left in Recently Closed", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  ff.addTab(w.id, { url: "https://a.example/", discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  // As a window reopened and then dragged from: Firefox unloaded it, and it stayed a ghost.
  ff.addTab(w.id, { url: "https://a.example/", discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  assert.equal(ff.list(w.id).filter(t => t.url === "https://a.example/").length, 1);
  assert.deepEqual(closedPages(ff), []);
  x.kill();
});

test("a placeholder reopened and selected before Recently Closed forgets it does not open the page twice", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://b.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  const ghost = ff.list(b.id).find(y => ff.values.get(y.id)?.syncKey === ff.values.get(t.id).syncKey);
  ff.focusWindow(b.id);
  // As SessionStore brings it back, selected. Nothing asks for its values yet: registering waits.
  ff.openTab(b.id, { url: ghost.url, active: true, cookieStoreId: C1, restored: { tab: { url: ghost.url, title: ghost.title }, values: {} } });
  await ff.clock.idle(60000);
  const pages = [...ff.tabs.values()].filter(y => y.url === "https://b.example/");
  assert.equal(pages.length, 1, "the page is open once");
  assert.equal(Object.values(ff.synced).filter(e => e.url === "https://b.example/").length, 1, "and is one tab");
  x.kill();
});

test("a ghost created a moment ago does not take over from an unloaded live tab", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const live = ff.addTab(w.id, { url: "https://a.example/", discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const v = ff.addWindow();
  ff.addTab(v.id, { url: "about:home", active: true });
  // Firefox says about:blank until the placeholder's address is known.
  const fresh = ff.addTab(v.id, { url: "about:blank", cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  assert.equal(ff.values.get(live.id).syncRole, "live");
  assert.equal(ff.values.get(fresh.id).syncRole, "ghost");
  x.kill();
});

test("a pinned tab in a private window does not become an essential, at a start or when pinned", async () => {
  const ff = new ChaosFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const p = ff.addWindow();
  p.incognito = true;
  const pinned = ff.addTab(p.id, { url: "https://private.example/", pinned: true, active: true, incognito: true, cookieStoreId: "firefox-private" });
  ff.containers.add("firefox-private");
  const later = ff.addTab(p.id, { url: "https://private2.example/", incognito: true, cookieStoreId: "firefox-private" });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  assert.ok((ff.store.essentials ?? []).every(e => !e.url.includes("private")));
  ff.pinTab(later);
  await ff.clock.idle(60000);
  assert.ok((ff.store.essentials ?? []).every(e => !e.url.includes("private")), "the address stays in the private window");
  assert.ok(ff.tabs.has(pinned.id));
  assert.equal(ff.list(w.id).filter(t => t.pinned).length, 0);
  x.kill();
});

test("with Sidebery a start leaves the order of the essentials alone, since Sidebery has sorted them its own way", async () => {
  const ff = new ChaosFirefox();
  ff.store.essentials = four().map((e, i) => ({ ...e, cookieStoreId: i < 2 ? C1 : "firefox-container-2" }));
  const w = ff.addWindow({ focused: true });
  // Sidebery's order of spaces has the second container first.
  const order = ["c", "d", "a", "b"];
  for (const key of order) ff.addTab(w.id, { url: GHOST("essential", key), pinned: true, discarded: true, cookieStoreId: ff.store.essentials.find(e => e.key === key).cookieStoreId }, { essentialKey: key });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.idle(120000);
  assert.deepEqual(ff.list(w.id).filter(t => t.pinned).map(t => ff.values.get(t.id).essentialKey), order);
  x.kill();
});

test("an unpinned essential whose page is slow to answer is not closed as a stray", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  const copy = ff.tabs.get(ff.list(b.id).find(y => y.pinned).id);
  const load = ff.load;
  ff.load = t => { t.status = "loading"; }; // the page has not answered yet: the tab still shows the placeholder's address
  ff.updated(copy, { status: "complete" }); // its placeholder finished loading a moment ago
  await ff.clock.run(100);
  ff.unpinTab(copy);
  await ff.clock.idle(60000);
  ff.load = load;
  assert.ok(ff.tabs.has(copy.id), "the tab you unpinned is still there");
  x.kill();
});

test("a link seen late with no space to go to is still synced", async () => {
  const ff = new ChaosFirefox({});
  ff.managed = { tidierAlone: true };
  ff.containers = new Set(["firefox-default"]); // no container, so no space at all
  ff.store.syncedTabs = { a: entry("https://a.example/", { cookieStoreId: "firefox-default" }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true }, { syncKey: "a", syncRole: "live" });
  const late = ff.addTab(w.id, { url: "https://late.example/" });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  assert.ok(ff.values.get(late.id)?.syncKey);
  x.kill();
});

test("a window that closes while its sidebar is waited for does not hold everything up", async () => {
  const { ff, x, windows: [a] } = await chaosStart();
  // An essential, so that a new window waits for Sidebery's sidebar to start there.
  const e = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(e);
  await ff.clock.idle(60000);
  const { window: w } = ff.openWindow();
  await ff.clock.run(1500);
  const t0 = ff.clock.now;
  ff.closeWindow(w.id);
  await ff.clock.settled(x.js("serial(() => 1)"));
  assert.ok(ff.clock.now - t0 < 1000, `the queue was free after ${ff.clock.now - t0} ms`);
  x.kill();
});

test("a ghost whose folder closes or leaves its window in that moment is still made", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const away = ff.openTab(a.id, { url: "about:blank" }); // the parent as last seen: in another window now
  const made = await ff.clock.settled(x.js(`createRep(${b.id}, "k", { url: "https://k.example/", cookieStoreId: "${C1}" }, ${away.id})`));
  assert.equal(made.windowId, b.id);
  const closed = await ff.clock.settled(x.js(`createRep(${b.id}, "k2", { url: "https://l.example/", cookieStoreId: "${C1}" }, 99999)`));
  assert.equal(closed.windowId, b.id);
  await assert.rejects(ff.clock.settled(x.js(`createRep(99999, "k3", { url: "https://m.example/", cookieStoreId: "${C1}" })`)), /Invalid window ID/);
  x.kill();
});

test("a ghost pinned while Tidier is starting, its values lost, is an essential with no ghost left", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { k: entry("https://k.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  ff.addTab(w.id, { url: GHOST("ghost", "k"), pinned: true, discarded: true, cookieStoreId: C1 }); // dragged, so no values, and pinned
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://k.example/"]);
  assert.equal(ff.list(w.id).filter(t => t.url.includes("kind=ghost")).length, 0);
  assert.deepEqual(Object.keys(ff.synced), []);
  x.kill();
});

test("marks on tabs being closed go also when a close is refused", async () => {
  const { ff, x, windows: [a] } = await chaosStart({ windows: 1 });
  const t = ff.openTab(a.id, { url: "about:blank" });
  ff.refusePattern = /^tabs\.remove$/;
  ff.refuseRate = 1;
  await assert.rejects(ff.clock.settled(x.js(`removeTabs([${t.id}], syncBusy)`)), /refused/);
  assert.equal(x.js("syncBusy").has(t.id), false);
  x.kill();
});

test("a tab dragged in the last moment of a start is put right when it has started", async () => {
  // When exactly it has started, from a run with nothing else in it: the same each time.
  const session = () => {
    const ff = new ChaosFirefox();
    ff.store.syncedTabs = { k: entry("https://k.example/") };
    const a = ff.addWindow({ focused: true }), b = ff.addWindow();
    ff.addTab(a.id, { url: "about:home", active: true });
    ff.addTab(b.id, { url: "about:home", active: true });
    ff.addTab(a.id, { url: "https://k.example/", discarded: true, cookieStoreId: C1 }, { syncKey: "k", syncRole: "live" });
    const ghost = ff.addTab(b.id, { url: GHOST("ghost", "k"), discarded: true, cookieStoreId: C1 }, { syncKey: "k", syncRole: "ghost" });
    const x = ff.boot();
    x.b.runtime.onInstalled.fire({ reason: "update" });
    return { ff, x, a, b, ghost };
  };
  const first = session();
  while (!first.x.js("started")) await first.ff.clock.step();
  const startedAt = first.ff.clock.now;
  first.x.kill();
  for (let before = 1; before <= 40; before++) {
    const { ff, x, a, b, ghost } = session();
    await ff.clock.run(startedAt - ff.clock.now - before);
    ff.moveTabs([ghost.id], { windowId: a.id, index: -1 });
    await ff.clock.idle(60000);
    const reps = w => ff.list(w.id).filter(t => ff.values.get(t.id)?.syncKey === "k").length;
    assert.deepEqual([reps(a), reps(b)], [1, 1], `dragged ${before} ms before it had started`);
    x.kill();
  }
});
