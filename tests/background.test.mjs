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
  const copy = { tidier: "1.6", data: {
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
  assert.deepEqual({ ...r }, { essentials: 1, folders: 1, tabs: 1, rules: 0, spaces: 0 });
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

test("a saved tab that loaded just after another closed is unloaded when it closes, not gone", async () => {
  // Closing a tab lands on the next, perhaps an unloaded one, which loads. Tabs closing
  // together keep the order from when the first closed, but not what was unloaded then.
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Work", cookieStoreId: C1, parentKey: null, rank: 1 },
    a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "a" } }),
    b: entry("https://b.example/", { parentKey: "F", saved: { url: "https://b.example/", title: "b" } }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const a = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const b = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1, discarded: true }, { syncKey: "b", syncRole: "live" });
  const x = await alone(ff);
  await wait(500);
  ff.rm(a.id);
  b.discarded = false;
  x.b.tabs.onUpdated.fire(b.id, { discarded: false }, ff.snap(b));
  await wait(20);
  ff.rm(b.id);
  await wait(1000);
  assert.ok(ff.synced.b, "still a saved tab");
  assert.ok(ff.list(w.id).some(y => y.url === GHOST("ghost", "b")));
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
      "firefox-container-1": { id: "firefox-container-1", name: "firefox-container-1", reopenRulesActive: true, reopenRules: [{ active: true, type: 1, url: "/^https:\\/\\/a\\//" }, { active: false, type: 1, url: "off" }] },
      "firefox-container-2": { id: "firefox-container-2", name: "firefox-container-2", reopenRulesActive: false, reopenRules: [{ active: true, type: 1, url: "ignored" }] },
    },
    sidebar: { nav: ["p2", "p1", "settings"], panels: { p1: { newTabCtx: "firefox-container-1" }, p2: { newTabCtx: "firefox-container-2" } } },
  });
  assert.deepEqual([r.rules, r.order, r.panelsLeftOut, r.folds], [1, 2, 0, null]);
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
  const copy = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await ff.clock.idle(60000);
  assert.deepEqual(ff.list(w.id).filter(t => t.pinned).map(t => t.id), [copy.id], "the same tab, not closed and made again");
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
  assert.equal(ff.values.get(live.id).syncRole, "live", "the page you had stays the live tab");
  assert.equal(ff.values.get(ghost.id).syncRole, "ghost");
  // Selected in a window you may well see, it stays as it is until you leave it (unloadLeftPage).
  ff.select(ff.list(here.id).find(t => t.id !== ghost.id).id);
  await ff.clock.idle(60000);
  const loaded = [...ff.tabs.values()].filter(t => !t.discarded && t.url === "https://a.example/");
  assert.deepEqual(loaded.map(t => t.id), [live.id], "then it is loaded once, the page you had");
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
  // A window that has gone gets nothing, and that is no error (createTab, common.js).
  assert.equal(await ff.clock.settled(x.js(`createRep(99999, "k3", { url: "https://m.example/", cookieStoreId: "${C1}" })`)), null);
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

// --- Each of these was only caught by a long chaos run: a test of its own -------------------
test("a live tab elsewhere is not doubled when a window with a stale live tab closes", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const third = ff.openWindow().window;
  await ff.clock.idle(60000);
  const t = ff.openTab(third.id, { url: "https://a.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  const stale = ff.list(a.id).find(y => ff.values.get(y.id)?.syncKey === key);
  await ff.clock.settled(x.js("setRole")(stale.id, key, "live")); // a ghost that became live a moment before
  ff.closeWindow(a.id);
  await ff.clock.idle(60000);
  const live = [...ff.tabs.values()].filter(y => ff.values.get(y.id)?.syncRole === "live").map(y => y.id);
  assert.deepEqual(live, [t.id], "the ghost in the other window stays a ghost");
  assert.ok(ff.list(b.id).some(y => ff.values.get(y.id)?.syncKey === key));
  x.kill();
});

test("a ghost you are looking at opens when its saved tab was unloaded and you switch to its window", async () => {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.syncedTabs = {
    F: { own: true, group: true, name: "F", url: "", title: "F", cookieStoreId: C1, rank: 1, parentKey: null, added: 1 },
    s: entry("https://s.example/", { parentKey: "F", saved: { url: "https://s.example/", title: "S" } }),
  };
  const a = ff.addWindow({ focused: true }), b = ff.addWindow();
  ff.addTab(a.id, { url: "about:home", cookieStoreId: C1 });
  ff.addTab(b.id, { url: "about:home", cookieStoreId: C1 });
  const live = ff.addTab(a.id, { url: "https://s.example/", active: true, cookieStoreId: C1 }, { syncKey: "s", syncRole: "live" });
  const ghost = ff.addTab(b.id, { url: GHOST("ghost", "s"), active: true, cookieStoreId: C1 }, { syncKey: "s", syncRole: "ghost" }); // selected in the window you are not using
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  ff.closeTab(live.id); // unloads it, everywhere
  await ff.clock.idle(60000);
  assert.equal(ff.tabs.get(ghost.id).url, GHOST("ghost", "s"), "nothing there has opened it yet");
  ff.focusWindow(b.id);
  await ff.clock.idle(60000);
  assert.equal(ff.tabs.get(ghost.id).url, "https://s.example/");
  x.kill();
});

test("an essential's placeholder reopened unpinned goes, and the window has its copy once", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  const copy = ff.list(b.id).find(y => y.pinned);
  ff.openTab(b.id, { url: copy.url, cookieStoreId: C1, restored: { tab: { url: copy.url, title: copy.title, discarded: true }, values: ff.values.get(copy.id) } });
  await ff.clock.idle(60000);
  assert.deepEqual(ff.list(b.id).filter(y => y.url.includes("kind=essential")).map(y => y.id), [copy.id]);
  x.kill();
});

test("a window closed before its copy was pinned, reopened, has its essentials once and pinned", async () => {
  const { ff, x, windows: [a] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  const { window: w } = ff.openWindow();
  while (!ff.list(w.id).some(y => y.url.includes("kind=essential"))) await ff.clock.step();
  assert.ok(ff.list(w.id).some(y => y.url.includes("kind=essential") && !y.pinned), "not pinned yet");
  ff.closeWindow(w.id);
  await ff.clock.run(1000);
  const back = ff.reopenLast();
  await ff.clock.idle(60000);
  assert.equal(ff.list(back.id).filter(y => y.url.includes("kind=essential")).length, 1);
  assert.ok(ff.list(back.id).filter(y => y.url.includes("kind=essential")).every(y => y.pinned));
  x.kill();
});

test("a tab pinned and closed at once is still an essential, in its own window too", async () => {
  const { ff, x, windows: [a] } = await chaosStart({ windows: 1 });
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.run(1);
  ff.closeTab(t.id);
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://e.example/"]);
  assert.equal(ff.list(a.id).filter(y => y.pinned).length, 1);
  x.kill();
});

test("an unloaded essential looked at while it seems unpinned after a drag still ends up once there", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  const copy = ff.list(b.id).find(y => y.pinned && y.discarded);
  ff.rng = () => 0.5; // answers come at once, and the tab seems unpinned for longer than they take
  ff.moveTabs([copy.id], { windowId: a.id, index: ff.pinnedCount(a) });
  await ff.clock.idle(60000);
  assert.equal(ff.list(a.id).filter(y => y.pinned).length, 1);
  assert.equal(ff.list(b.id).filter(y => y.pinned).length, 1);
  x.kill();
});

test("a sort's move that Firefox ignores does not leave the essential marked", async () => {
  const { ff, x, windows: [a] } = await chaosStart({ windows: 1 });
  const one = ff.openTab(a.id, { url: "https://one.example/", cookieStoreId: C1 });
  const two = ff.openTab(a.id, { url: "https://two.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(one);
  ff.pinTab(two);
  await ff.clock.idle(60000);
  const sorting = x.js("sortEssentials")(a.id, [...ff.store.essentials].reverse());
  sorting.catch(() => {});
  while (!x.js("ownMoves").size) await ff.clock.step();
  const moving = ff.tabs.get([...x.js("ownMoves")][0]);
  ff.unpinTab(moving); // unpinned on the way: Firefox ignores a move into the pinned part, without a word
  await ff.clock.idle(60000);
  assert.equal(x.js("ownMoves").size, 0);
  x.kill();
});

test("using an essential in another window does not close the window it was the only tab of", async () => {
  const ff = new ChaosFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const a = ff.addWindow(), b = ff.addWindow({ focused: true });
  ff.addTab(a.id, { url: "https://e.example/", pinned: true, active: true, cookieStoreId: C1 }, { essentialKey: "e" });
  ff.addTab(b.id, { url: "about:home", active: true });
  const copy = ff.addTab(b.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  ff.select(copy.id);
  await ff.clock.idle(60000);
  assert.ok(ff.wins.has(a.id), "the window is still there");
  assert.equal(ff.list(a.id).filter(t => t.url.includes("kind=essential") && t.pinned).length, 1, "with a placeholder");
  assert.deepEqual(ff.list(b.id).filter(t => t.pinned).map(t => t.url), ["https://e.example/"]);
  x.kill();
});

test("a tile is drawn with the new title also when the queue was busy as it changed", async () => {
  const { ff, x, windows: [w] } = await aloneStart({ windows: 1 });
  ff.connectSidebar(w.id);
  const t = ff.openTab(w.id, { url: "https://e.example/", active: true, cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  x.js("serial(() => sleep(1000))");
  await ff.clock.run(10);
  t.title = "(3) E";
  ff.updated(t, { title: t.title }); // the sidebar is told now, while the list still has the old title
  await ff.clock.idle(60000);
  assert.equal(ff.views.get(w.id).essentials[0].title, "(3) E");
  x.kill();
});

test("with Tidier alone a start puts the essentials back in the list's order", async () => {
  const ff = new ChaosFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.essentials = four();
  const w = ff.addWindow({ focused: true });
  for (const key of ["c", "a", "d", "b"]) ff.addTab(w.id, { url: GHOST("essential", key), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: key });
  ff.addTab(w.id, { url: "about:home", active: true, cookieStoreId: C1 });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  assert.deepEqual(ff.list(w.id).filter(t => t.pinned).map(t => ff.values.get(t.id).essentialKey), ["a", "b", "c", "d"]);
  x.kill();
});

test("a switch of space is written down at once, for a restart", async () => {
  const { ff, x, windows: [w] } = await aloneStart({ windows: 1 });
  ff.connectSidebar(w.id);
  await ff.clock.run(100);
  ff.sidebarSays(w.id, { type: "space", space: "firefox-container-2" });
  await ff.clock.idle(60000);
  assert.equal(ff.winValues.get(w.id)?.space, "firefox-container-2");
  x.kill();
});

test("a tab selected and dragged away at once does not decide the space of the window it left", async () => {
  const { ff, x, windows: [a, b] } = await aloneStart();
  const page = ff.openTab(a.id, { url: "about:preferences", active: true }); // no container, so it decides nothing
  const t = ff.openTab(a.id, { url: "https://o.example/", cookieStoreId: "firefox-container-2" });
  await ff.clock.idle(60000);
  assert.equal(x.js("activeSpace").get(a.id), C1);
  ff.select(t.id);
  ff.moveTabs([t.id], { windowId: b.id, index: -1 });
  await ff.clock.idle(60000);
  assert.ok(ff.tabs.get(page.id).active);
  assert.equal(x.js("activeSpace").get(a.id), C1);
  x.kill();
});

test("a loaded essential you had gone further in stays in Recently Closed when you unpin its copy", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://e.example/", active: true, cookieStoreId: C1 });
  await ff.clock.run(3000);
  ff.pinTab(t);
  await ff.clock.idle(60000);
  ff.load(t, "https://e.example/a/deep/page");
  await ff.clock.idle(60000);
  ff.unpinTab(ff.tabs.get(ff.list(b.id).find(y => y.pinned).id));
  await ff.clock.idle(60000);
  assert.deepEqual(closedPages(ff), ["https://e.example/a/deep/page"], "that place is nowhere else");
  x.kill();
});

test("a link whose rule names a space that has gone stays, in the space you are in", async () => {
  const { ff, x, windows: [w] } = await aloneStart({ windows: 1 });
  ff.store.rules = [];
  await ff.clock.settled(x.js(`rulesList.get().then(list => { list.push({ url: "ruled.example", space: "${GONE}" }); })`));
  ff.openTab(w.id, { url: "https://ruled.example/", active: true });
  await ff.clock.idle(60000);
  assert.deepEqual(ff.list(w.id).filter(t => t.url === "https://ruled.example/").map(t => t.cookieStoreId), [C1]);
  // Such a rule counts for nothing, and the sidebar says so (ruleCounts, isolation.js; sayIfRuleGone).
  x.js("problems.length = 0");
  x.kill();
});

test("moving over: one folder page closing in that moment does not leave the others", async () => {
  const ff = new ChaosFirefox();
  ff.store.tidierAlone = true;
  ff.store.syncedTabs = { F: { own: true, group: true, name: "F", url: FOLDER, oldUrl: FOLDER, title: "F", cookieStoreId: C1, rank: 1, parentKey: null, added: 1 } };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true, cookieStoreId: C1 });
  const page = ff.addTab(w.id, { url: FOLDER, cookieStoreId: C1 }, { syncKey: "F", syncRole: "copy" });
  const x = ff.boot();
  const query = x.b.tabs.query; // as if a second page had closed right after this look
  x.b.tabs.query = async q => { const tabs = await query(q); return q?.windowId === undefined && !q?.pinned ? [...tabs, { id: 99999, url: FOLDER, windowId: w.id }] : tabs; };
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  assert.ok(!ff.tabs.has(page.id));
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("the tabs of a folder no window has any more are no longer saved", async () => {
  const ff = new ChaosFirefox();
  ff.store.syncedTabs = { F: entry(FOLDER, { group: true }), s: entry("https://s.example/", { parentKey: "F", saved: { url: "https://s.example/", title: "S" } }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = ff.boot();
  await ff.clock.settled(x.js(`dropIfUnused("F")`));
  assert.equal((await ff.clock.settled(x.js("getSynced()"))).s.saved, undefined);
  x.kill();
});

test("a ghost pinned the moment its window comes back is an essential, not a placeholder of nothing", async () => {
  const { ff, x, windows: [a, b] } = await chaosStart();
  const t = ff.openTab(a.id, { url: "https://a.example/", cookieStoreId: C1 });
  await ff.clock.run(3000);
  const key = ff.values.get(t.id).syncKey;
  ff.closeWindow(b.id);
  await ff.clock.run(1000);
  const back = ff.reopenLast();
  const ghost = ff.list(back.id).find(y => ff.values.get(y.id)?.syncKey === key);
  assert.ok(ghost.url.includes("kind=ghost"));
  ff.pinTab(ff.tabs.get(ghost.id));
  await ff.clock.idle(60000);
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://a.example/"]);
  assert.ok(![...ff.tabs.values()].some(y => y.url.includes("kind=ghost")), "no placeholder of a tab that has gone");
  x.kill();
});

test("a placeholder's late word that it stands for nothing does not close what the tab has become", async () => {
  const ff = new ChaosFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const copy = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = ff.boot();
  x.b.runtime.onInstalled.fire({ reason: "update" });
  await ff.clock.idle(60000);
  // It was a ghost you pinned: the page of that ghost asked, and the answer took its time.
  await ff.clock.settled(x.send({ type: "ghostOrphan", kind: "ghost", key: "gone" }, { tab: ff.snap(copy) }));
  await ff.clock.idle(60000);
  assert.ok(ff.tabs.has(copy.id), "the essential's copy stays");
  x.kill();
});

test("a tab pinned in the last moment of a start is an essential when it has started", async () => {
  const session = () => {
    const ff = new ChaosFirefox();
    const w = ff.addWindow({ focused: true });
    ff.addTab(w.id, { url: "about:home", active: true });
    ff.store.syncedTabs = { k: entry("https://k.example/") };
    ff.addTab(w.id, { url: "https://k.example/", discarded: true, cookieStoreId: C1 }, { syncKey: "k", syncRole: "live" });
    const x = ff.boot();
    x.b.runtime.onInstalled.fire({ reason: "update" });
    return { ff, x, w };
  };
  const first = session();
  while (!first.x.js("started")) await first.ff.clock.step();
  const startedAt = first.ff.clock.now;
  first.x.kill();
  for (let before = 1; before <= 40; before += 3) {
    const { ff, x, w } = session();
    await ff.clock.run(startedAt - ff.clock.now - before);
    ff.openTab(w.id, { url: "https://p.example/", pinned: true, cookieStoreId: C1 });
    await ff.clock.idle(60000);
    assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://p.example/"], `pinned ${before} ms before it had started`);
    x.kill();
  }
});

// --- Found by the long run in a real Firefox (soak.py) ------------------------------------

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

test("a selected ghost that becomes the live tab opens its page", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "about:blank", active: true });
  const live = ff.addTab(home.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  // In a window you are not using it is selected, and it was told to wait.
  const there = ff.addWindow();
  const ghost = ff.addTab(there.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  ff.rm(live.id, { closing: true });
  ff.wins.delete(home.id);
  ff.focused = there.id;
  x.b.windows.onFocusChanged.fire(there.id);
  await wait(500);
  assert.equal(ff.tabs.get(ghost.id).url, "https://a.example/");
  x.kill();
});

test("a window closing while a new tab is copied to the windows is no error, and the others still get it", async () => {
  const ff = new FakeFirefox();
  const home = ff.addWindow({ focused: true });
  const closing = ff.addWindow();
  const other = ff.addWindow();
  for (const w of [home, closing, other]) ff.addTab(w.id, { url: "about:blank", active: true });
  const x = await run(ff);
  const create = x.b.tabs.create;
  x.b.tabs.create = async p => { if (p.windowId === closing.id && ff.wins.has(closing.id)) { for (const id of [...ff.wins.get(closing.id).order]) ff.rm(id, { closing: true }); ff.wins.delete(closing.id); } return create(p); };
  const t = ff.addTab(home.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.navigate(t.id, "https://a.example/");
  await wait(3000);
  const key = ff.values.get(t.id)?.syncKey;
  assert.ok(key, "the tab is synced");
  assert.ok(ff.list(other.id).some(y => y.url === GHOST("ghost", key)), "and the window after the closed one has it");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

// (You pinned it, so it is an essential, and an essential's copy you close comes back: the
// chaos test's "a tab pinned and closed at once is still an essential".)
test("a tab pinned and closed at once leaves no error, and is an essential", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const t = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const x = await run(ff);
  const set = x.b.sessions.setTabValue;
  x.b.sessions.setTabValue = async (id, k, v) => { if (k === "essentialKey") ff.rm(id); return set(id, k, v); };
  await x.b.tabs.update(t.id, { pinned: true });
  await wait(2000);
  assert.deepEqual((ff.store.essentials ?? []).map(e => e.url), ["https://a.example/"]);
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("a tab moved to a new window leaves its copy in the window it came from, though Firefox still lists it there for a moment", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const from = ff.addWindow({ focused: true });
  ff.addTab(from.id, { url: "about:blank", active: true });
  ff.addTab(from.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const tab = ff.addTab(from.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  const to = ff.addWindow();
  // For a moment the old window lists the tab, under the same ID: long enough for a whole
  // look at every window (each query({}) in reconcileAll and fillWindow).
  let stale = 6;
  const query = x.b.tabs.query;
  x.b.tabs.query = async q => {
    const tabs = await query(q);
    if (q.windowId === undefined && stale-- > 0) tabs.push({ ...ff.snap(ff.tabs.get(tab.id)), windowId: from.id });
    return tabs;
  };
  await x.b.tabs.move(tab.id, { windowId: to.id, index: 0 });
  await wait(2000);
  assert.ok(ff.urls(from.id).includes(GHOST("ghost", "a").replace("moz-extension://tidier/", "")), "the old window has a ghost");
  x.kill();
});

test("an unloaded tab that has lost its title gets it back, and one that has not is left alone", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const from = ff.addWindow();
  ff.addTab(from.id, { url: "about:blank", active: true });
  const ghost = ff.addTab(from.id, { url: GHOST("ghost", "a"), discarded: true, title: "A", cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const to = ff.addWindow();
  ff.addTab(to.id, { url: "about:blank", active: true });
  const x = await run(ff);
  ff.log.length = 0;
  ff.tabs.get(ghost.id).title = "tidier/ghost.html?kind=ghost&key=a"; // as Firefox moves it
  await x.b.tabs.move(ghost.id, { windowId: to.id, index: 1 });
  await wait(1500);
  assert.ok(ff.log.some(([what, id]) => what === "update-url" && id === ghost.id), "its placeholder is loaded again");
  const entries = ff.log.length;
  ff.tabs.get(ghost.id).title = "A";
  ff.tabs.get(ghost.id).discarded = true;
  await x.js("reconcileAll()");
  assert.ok(!ff.log.slice(entries).some(([what, id]) => what === "update-url" && id === ghost.id), "one with its title is left alone");
  x.kill();
});

// Pinned is what an essential is: one reopened after its essential was removed is one again,
// in every window, and not a stray pinned tab in one (chaos test: "an essential reopened after
// you unpinned it is an essential again").
test("a tab reopened pinned whose essential has been removed is an essential again", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const x = await run(ff);
  const t = ff.addTab(w.id, { url: "https://gone.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "removed" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  await wait(3000);
  assert.equal(ff.tabs.get(t.id).pinned, true, "it stays pinned");
  const made = (ff.store.essentials ?? []).find(e => e.url === "https://gone.example/");
  assert.ok(made, "as an essential");
  assert.equal(ff.values.get(t.id).essentialKey, made.key, "tagged as that one");
  assert.ok(!ff.values.get(t.id).syncKey, "and not a synced tab as well");
  x.kill();
});

test("a ghost that opened its page while its window's tab was going does not get a second heir", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const closing = ff.addWindow({ focused: true });
  ff.addTab(closing.id, { url: "about:blank", active: true });
  const live = ff.addTab(closing.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const first = ff.addWindow();
  ff.addTab(first.id, { url: "about:blank", active: true });
  ff.addTab(first.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const shown = ff.addWindow();
  const ghost = ff.addTab(shown.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  // The queue is busy. The selected ghost asks what to do, and then the window closes: by the
  // time the ghost's turn comes the live tab is gone, ahead of the hand-over.
  x.js("serial(() => sleep(300))");
  const asked = x.send({ type: "ghostShown" }, { tab: ff.snap(ff.tabs.get(ghost.id)) });
  ff.rm(live.id, { closing: true });
  await wait(1500);
  assert.equal((await asked).load, true);
  const lives = [...ff.values.values()].filter(v => v.syncKey === "a" && v.syncRole === "live").length;
  assert.equal(lives, 1, "one live tab");
  x.kill();
});

test("a window reopened with a page that is open elsewhere does not keep it loaded twice", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const one = ff.addWindow({ focused: true });
  const here = ff.addTab(one.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const two = ff.addWindow();
  ff.addTab(two.id, { url: "about:blank", active: true });
  const twin = ff.addTab(two.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  assert.equal(ff.tabs.get(here.id).discarded, false, "the one you are using stays");
  assert.equal(ff.tabs.get(twin.id).discarded, true, "the other is unloaded");
  assert.equal(ff.values.get(twin.id).syncRole, "ghost");
  x.kill();
});

test("a placeholder that never reports its load finished is unloaded all the same", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "about:blank", active: true });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "a"), status: "loading", cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  x.send({ type: "ghostReady", icon: false }, { tab: ff.snap(ghost), url: ghost.url });
  await wait(500);
  assert.equal(ff.tabs.get(ghost.id).discarded, false, "it waits at first");
  await wait(11000);
  assert.equal(ff.tabs.get(ghost.id).discarded, true);
  assert.equal(x.js("awaitingIcon.size"), 0);
  x.kill();
});

test("an essential reopened with ⌘⇧T unloads the other window's loaded copy", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:blank", active: true });
  ff.addTab(here.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const there = ff.addWindow();
  ff.addTab(there.id, { url: "about:blank", active: true });
  const open = ff.addTab(there.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  const back = ff.addTab(here.id, { url: "https://e.example/", pinned: true, active: false, cookieStoreId: C1 }, { essentialKey: "e" });
  x.b.tabs.onCreated.fire(ff.snap(back));
  await wait(1000);
  assert.ok(ff.tabs.get(open.id).url.startsWith(GHOST("essential", "e")), "the other copy is a placeholder again");
  assert.equal(ff.tabs.get(back.id).url, "https://e.example/");
  x.kill();
});

test("a copy of an essential unpinned just after it was made is an ordinary tab", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const t = ff.addTab(w.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  x.js(`busy.add(${t.id})`); // as createEssentials does for a second and a half
  await x.b.tabs.update(t.id, { pinned: false });
  await wait(3000);
  assert.deepEqual(ff.store.essentials, [], "the essential is gone");
  assert.ok(ff.synced[ff.values.get(t.id).syncKey], "and the tab is synced");
  x.kill();
});

test("a pinned tab that is no essential, unpinned, is synced", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const t = ff.addTab(w.id, { url: "https://a.example/", pinned: true, cookieStoreId: C1 });
  const x = await run(ff);
  x.js(`syncKeyByTab.delete(${t.id}); keyByTab.delete(${t.id})`);
  ff.values.delete(t.id);
  ff.store.essentials = [];
  x.js("essentialsList.set([])");
  await x.b.tabs.update(t.id, { pinned: false });
  await wait(3000);
  assert.ok(ff.synced[ff.values.get(t.id)?.syncKey], "it has a record");
  x.kill();
});

test("a new tab dragged to the essentials stays a tab", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const fresh = ff.addTab(w.id, { url: "about:newtab", active: true, cookieStoreId: C1 });
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const page = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  await x.js(`sidebarAction(${w.id}, { type: "pin", tabId: ${fresh.id}, pinned: true })`);
  assert.equal(ff.tabs.get(fresh.id).pinned, false);
  await x.js(`sidebarAction(${w.id}, { type: "pin", tabId: ${page.id}, pinned: true })`);
  assert.equal(ff.tabs.get(page.id).pinned, true, "a page does become one");
  x.kill();
});

test("a tab closed as its new window opens does not leave the window empty", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  const w = ff.addWindow();
  const first = ff.addTab(w.id, { url: "about:newtab", active: true });
  ff.hooks.getTabValue = async id => { if (id === first.id) throw new Error(`Invalid tab ID: ${id}`); };
  x.b.windows.onCreated.fire({ id: w.id, type: "normal", incognito: false });
  await wait(1500);
  assert.ok(ff.urls(w.id).includes(GHOST("ghost", "a").replace("moz-extension://tidier/", "")), "the window still gets its tabs");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("the space you switched to is kept, and an update shows the selected tab's space", async () => {
  const ff = new FakeFirefox();
  const C2 = "firefox-container-2";
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/", { cookieStoreId: C2 }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const inTwo = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C2 }, { syncKey: "b", syncRole: "live" });
  const x = await alone(ff);
  const stored = {};
  x.b.sessions.setWindowValue = async (id, k, v) => { stored[k] = v; };
  await x.js(`switchSpace(${w.id}, "${C2}")`);
  assert.equal(stored.space, C2, "the switch is stored with the window");
  // An update: a new background page, with what is stored behind the selected tab.
  const y = await (async () => { const n = ff.boot(); n.b.sessions.getWindowValue = async () => C1; n.b.runtime.onInstalled.fire({ reason: "update" }); await wait(3500); return n; })();
  assert.equal(y.js(`activeSpace.get(${w.id})`), C2);
  assert.equal(ff.tabs.get(inTwo.id).hidden, false);
  y.kill();
});

test("a tab closed just as it is synced leaves no record, and stops nothing", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "about:blank", active: true });
  const x = await run(ff);
  const t = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.navigate(t.id, "https://a.example/");
  ff.hooks.setRole = true;
  const set = x.b.sessions.setTabValue;
  x.b.sessions.setTabValue = async (id, k, v) => { if (id === t.id && k === "syncKey") ff.rm(id); return set(id, k, v); };
  await wait(2500);
  assert.deepEqual(ff.synced ?? {}, {}, "no record");
  assert.equal(ff.urls(other.id).filter(u => u.startsWith("ghost.html")).length, 0, "and no ghost of it");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("an essential's placeholder selected while Tidier starts opens its page", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  const t = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, active: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  assert.equal(ff.tabs.get(t.id).url, "https://e.example/");
  x.kill();
});

test("an essential's copy closed just after it was made comes back", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const copy = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  x.js(`busy.add(${copy.id})`); // as createEssentials does for a second and a half
  ff.rm(copy.id);
  await wait(3000); // with Sidebery a copy is pinned only after a moment
  assert.equal(ff.list(w.id).filter(t => t.pinned).length, 1, "the window has it again");
  x.kill();
});

test("of two loaded copies, the selected one stays, also in a window you are not using", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const focused = ff.addWindow({ focused: true });
  ff.addTab(focused.id, { url: "about:blank", active: true });
  const one = ff.addWindow();
  ff.addTab(one.id, { url: "about:blank", active: true });
  const live = ff.addTab(one.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const two = ff.addWindow();
  const shown = ff.addTab(two.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  assert.equal(ff.values.get(shown.id).syncRole, "live");
  assert.equal(ff.tabs.get(live.id).discarded, true);
  x.kill();
});

test("a reopened window whose tabs get their values late is not doubled", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  // Firefox opens the window, and has not set the values of its tabs yet.
  const w = ff.addWindow();
  const back = ff.addTab(w.id, { url: GHOST("ghost", "a"), active: true, discarded: true, title: "A", cookieStoreId: C1 });
  x.b.windows.onCreated.fire({ id: w.id, type: "normal", incognito: false });
  await wait(1500);
  assert.equal(ff.urls(w.id).filter(u => u.startsWith("ghost.html")).length, 2, "filled as a new window");
  ff.values.set(back.id, { syncKey: "a", syncRole: "ghost" });
  await wait(3000);
  assert.equal(ff.urls(w.id).filter(u => u.startsWith("ghost.html")).length, 1, "and the double is gone");
  x.kill();
});

test("a new tab moved by Tidier and given an address at once is synced, with Sidebery too", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const x = await run(ff);
  const fresh = ff.addTab(w.id, { url: "about:newtab", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(fresh));
  await wait(2000);
  x.js(`syncBusy.add(${fresh.id})`); // folders first has just moved it (folders.js)
  ff.navigate(fresh.id, "https://typed.example/");
  await wait(3000);
  assert.ok(ff.values.get(fresh.id)?.syncKey, "it has a key");
  x.kill();
});

test("with Tidier alone, an essential moved just after its copy was made is moved everywhere", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = ["e", "f"].map(key => ({ key, url: `https://${key}.example/`, cookieStoreId: C1, title: key, icon: "x" }));
  const w = ff.addWindow({ focused: true });
  const first = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const second = ff.addTab(w.id, { url: GHOST("essential", "f"), pinned: true, cookieStoreId: C1 }, { essentialKey: "f" });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const x = await alone(ff);
  x.js(`busy.add(${second.id})`); // as createEssentials does for a second and a half
  await x.b.tabs.move(second.id, { index: 0 });
  await wait(500);
  assert.deepEqual(ff.store.essentials.map(e => e.key), ["f", "e"]);
  assert.ok(ff.tabs.has(first.id));
  x.kill();
});

test("an essential's copy dragged to another window just after it was made is there once", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const from = ff.addWindow({ focused: true });
  ff.addTab(from.id, { url: "about:blank", active: true });
  const copy = ff.addTab(from.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const to = ff.addWindow();
  ff.addTab(to.id, { url: "about:blank", active: true });
  ff.addTab(to.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  x.js(`busy.add(${copy.id})`); // as createEssentials does for a second and a half
  await x.b.tabs.move(copy.id, { windowId: to.id, index: 0 });
  await wait(3000); // after the window it left has got its copy back
  assert.equal(ff.list(to.id).filter(t => t.pinned).length, 1);
  x.kill();
});

// What follows was found by breaking each fix above on purpose: these cases passed either way.

// A tab Firefox has closed already, while Tidier hears of it only a moment later.
function goneInFirefox(ff, x, tabId, options) {
  const fire = x.b.tabs.onRemoved.fire;
  x.b.tabs.onRemoved.fire = (...a) => setTimeout(() => fire(...a), 2);
  ff.rm(tabId, options);
  x.b.tabs.onRemoved.fire = fire;
}

test("closing everywhere closes the others, also when Firefox has closed one and Tidier does not know yet", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const windows = [ff.addWindow({ focused: true }), ff.addWindow(), ff.addWindow()];
  for (const w of windows) ff.addTab(w.id, { url: "about:blank", active: true });
  const live = ff.addTab(windows[0].id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const gone = ff.addTab(windows[1].id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const stays = ff.addTab(windows[2].id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  const query = x.b.tabs.query;
  x.b.tabs.query = async q => {
    const tabs = await query(q);
    if (q.windowId === undefined && ff.tabs.has(gone.id)) goneInFirefox(ff, x, gone.id, { closing: true });
    return tabs;
  };
  ff.rm(live.id);
  await wait(1000);
  x.b.tabs.query = query;
  assert.ok(!ff.tabs.has(stays.id), "the other ghost is closed");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("a link a rule puts in its space is not in Recently Closed either", async () => {
  const ff = new FakeFirefox();
  const C2 = "firefox-container-2";
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  ff.store.rules = [{ url: "link.example", space: C2 }];
  const x = await alone(ff);
  await wait(200);
  ff.recentlyClosed = [{ tab: { url: "https://link.example/", sessionId: "replaced", windowId: w.id } }, { tab: { url: "https://b.example/", sessionId: "yours", windowId: w.id } }];
  const link = ff.addTab(w.id, { url: "about:blank", active: true });
  x.b.tabs.onCreated.fire(ff.snap(link));
  ff.navigate(link.id, "https://link.example/");
  await wait(1000);
  assert.ok(ff.list(w.id).some(t => t.url === "https://link.example/" && t.cookieStoreId === C2), "it is in the rule's space");
  assert.deepEqual(ff.recentlyClosed.map(c => c.tab.sessionId), ["yours"]);
  x.kill();
});

test("a pinned tab closed as its window is filled does not leave the window without essentials", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "about:blank", active: true });
  ff.addTab(home.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  const w = ff.addWindow();
  ff.addTab(w.id, { url: "about:blank", active: true });
  const stray = ff.addTab(w.id, { url: "https://stray.example/", pinned: true, cookieStoreId: C1 });
  ff.hooks.getTabValue = async id => { if (id === stray.id) throw new Error(`Invalid tab ID: ${id}`); };
  x.b.windows.onCreated.fire({ id: w.id, type: "normal", incognito: false });
  await wait(6000); // with Sidebery a new window's copies are pinned only after it has started
  assert.ok(ff.urls(w.id).some(u => u.startsWith("ghost.html?kind=essential")), "the window has its essential");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("an essential moved to another window leaves a copy, though Firefox still lists it in the old one for a moment", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const from = ff.addWindow({ focused: true });
  ff.addTab(from.id, { url: "about:blank", active: true });
  const copy = ff.addTab(from.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const to = ff.addWindow();
  ff.addTab(to.id, { url: "about:blank", active: true });
  ff.addTab(to.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  let stale = 3;
  const query = x.b.tabs.query;
  x.b.tabs.query = async q => {
    const tabs = await query(q);
    if (q.windowId === undefined || q.windowId === from.id) { if (stale-- > 0) tabs.push({ ...ff.snap(ff.tabs.get(copy.id)), windowId: from.id }); }
    return tabs;
  };
  await x.b.tabs.move(copy.id, { windowId: to.id, index: 0 });
  await wait(3000);
  assert.equal(ff.list(from.id).filter(t => t.pinned).length, 1, "the window it left has a copy");
  assert.equal(ff.list(to.id).filter(t => t.pinned).length, 1, "and the window it came to has it once");
  x.kill();
});

test("an essential's placeholder opens its page itself if the loaded copy closes as it is moved in", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:blank", active: true });
  const placeholder = ff.addTab(here.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const there = ff.addWindow();
  ff.addTab(there.id, { url: "about:blank", active: true });
  ff.addTab(there.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  x.b.tabs.move = async id => { throw new Error(`Invalid tab ID: ${id}`); };
  const asked = await x.send({ type: "essentialShown" }, { tab: ff.snap(ff.tabs.get(placeholder.id)) });
  assert.equal(asked.load, true);
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("a tab closed before its record is made does not stay in the record", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "about:blank", active: true });
  const x = await run(ff);
  const t = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.navigate(t.id, "https://a.example/");
  // Closed just after Tidier looked it up. Tidier hears of it before it has a key, so that
  // its closing means nothing to the tab record: setRole is what finds out.
  ff.hooks.getTabValue = async (id, k) => { if (id === t.id && k === "syncKey" && ff.tabs.has(id)) ff.rm(id); };
  await wait(2500);
  assert.deepEqual(ff.synced ?? {}, {}, "no record");
  assert.equal(ff.urls(other.id).filter(u => u.startsWith("ghost.html")).length, 0, "and no ghost of it");
  assert.equal(x.js("syncKeyByTab.size"), 0);
  x.kill();
});

test("a window closing hands its live tab to the ghost you are looking at, which opens it", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const closing = ff.addWindow();
  ff.addTab(closing.id, { url: "about:blank", active: true });
  const live = ff.addTab(closing.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const first = ff.addWindow({ focused: true });
  ff.addTab(first.id, { url: "about:blank", active: true });
  const notThis = ff.addTab(first.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const shown = ff.addWindow();
  const ghost = ff.addTab(shown.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  x.js(`focusedWindowId = ${shown.id}`); // no event yet: as a window you have just come to
  ff.rm(live.id, { closing: true });
  await wait(500);
  assert.equal(ff.tabs.get(ghost.id).url, "https://a.example/");
  assert.equal(ff.values.get(ghost.id).syncRole, "live");
  assert.equal(ff.values.get(notThis.id).syncRole, "ghost");
  x.kill();
});

test("a selected ghost with no live tab left opens its page when it is selected", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const live = ff.addTab(ff.addWindow().id, { url: "https://a.example/", cookieStoreId: C1, active: true }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  goneInFirefox(ff, x, live.id, { closing: true });
  ff.select(ghost.id);
  await wait(500);
  assert.equal(ff.tabs.get(ghost.id).url, "https://a.example/");
  x.kill();
});

test("a placeholder that is the live tab, selected in a window you were not using, opens when you come to it", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const there = ff.addWindow();
  const placeholder = ff.addTab(there.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  assert.ok(ff.tabs.get(placeholder.id).url.startsWith("moz-extension"), "it waits");
  ff.focused = there.id;
  x.b.windows.onFocusChanged.fire(there.id);
  await wait(500);
  assert.equal(ff.tabs.get(placeholder.id).url, "https://a.example/");
  x.kill();
});

test("an essential's copy on its way to its placeholder is not sent there again and again", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:blank" });
  const open = ff.addTab(here.id, { url: "https://e.example/", pinned: true, active: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const there = ff.addWindow();
  ff.addTab(there.id, { url: "about:blank", active: true });
  const other = ff.addTab(there.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  // Firefox unloaded the other copy with the page in it. Sent to its placeholder, it says "loading"
  // while it is still about:blank; the placeholder's address comes only if the load gets through.
  Object.assign(ff.tabs.get(other.id), { url: "https://e.example/", discarded: true });
  let starts = 0;
  const update = x.b.tabs.update;
  x.b.tabs.update = async (id, p) => {
    if (id !== other.id || !p.url) return update(id, p);
    starts++;
    if (starts >= 50) return update(id, p);
    Object.assign(ff.tabs.get(id), { url: "about:blank", discarded: false, status: "loading" });
    x.b.tabs.onUpdated.fire(id, { status: "loading" }, ff.snap(ff.tabs.get(id)));
    setTimeout(() => { if (starts < 50) update(id, p); }, 100 / 100);
    return ff.snap(ff.tabs.get(id));
  };
  ff.navigate(open.id, "https://e.example/");
  await wait(500);
  assert.equal(starts, 1, "its load is started once");
  x.kill();
});

test("an essential's placeholder opens its page itself when the other copy is still on its way, on about:blank", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:blank", active: true });
  const placeholder = ff.addTab(here.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const there = ff.addWindow();
  ff.addTab(there.id, { url: "about:blank", active: true });
  const onItsWay = ff.addTab(there.id, { url: "about:blank", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await run(ff);
  const asked = await x.send({ type: "essentialShown" }, { tab: ff.snap(ff.tabs.get(placeholder.id)) });
  assert.equal(asked.load, true);
  assert.equal(ff.tabs.get(onItsWay.id).windowId, there.id, "the other copy is not moved");
  x.kill();
});

test("a ghost made a moment ago is not taken for a page, nor unloaded before it has its title", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "about:blank", active: true });
  const live = ff.addTab(home.id, { url: "https://a.example/", cookieStoreId: C1, discarded: true }, { syncKey: "a", syncRole: "live" });
  const there = ff.addWindow();
  ff.addTab(there.id, { url: "about:blank", active: true });
  const fresh = ff.addTab(there.id, { url: "about:blank", cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" }); // Firefox says about:blank until the address is known
  const x = await run(ff);
  assert.equal(ff.values.get(live.id).syncRole, "live", "the live tab keeps its role");
  assert.equal(ff.values.get(fresh.id).syncRole, "ghost");
  assert.equal(ff.tabs.get(fresh.id).discarded, false, "and the new ghost goes on loading");
  x.kill();
});

test("a window closed before it has finished starting holds nothing up", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  const w = ff.addWindow();
  ff.addTab(w.id, { url: "about:blank", active: true });
  // Firefox waits for a new window to finish starting, and never answers if it closes first.
  const create = x.b.tabs.create;
  x.b.tabs.create = p => p.windowId === w.id && ff.wins.has(w.id) ? new Promise(() => {}) : create(p);
  x.b.windows.onCreated.fire({ id: w.id, type: "normal", incognito: false });
  await wait(1000);
  ff.rm(ff.list(w.id)[0].id, { closing: true });
  ff.wins.delete(w.id);
  x.b.windows.onRemoved.fire(w.id);
  let answered = false;
  x.js("serial(() => {})").then(() => { answered = true; });
  await wait(3000);
  assert.ok(answered, "the queue goes on");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("a tab closed at the last moment stops nothing: unpinned, pinned or moved in the sidebar, or selected by a pull", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = ["e", "f"].map(key => ({ key, url: `https://${key}.example/`, cookieStoreId: C1, title: key, icon: "x" }));
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  const e = ff.addTab(w.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const f = ff.addTab(w.id, { url: GHOST("essential", "f"), pinned: true, cookieStoreId: C1 }, { essentialKey: "f" });
  const a = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  const refused = id => { throw new Error(`Invalid tab ID: ${id}`); };

  const { removeTabValue } = x.b.sessions;
  x.b.sessions.removeTabValue = async id => refused(id);
  await x.js(`serial(() => onUnpinned(${JSON.stringify(ff.snap(e))}))`);
  x.b.sessions.removeTabValue = removeTabValue;

  const { update, move } = x.b.tabs;
  x.b.tabs.update = async id => refused(id);
  await x.js(`serial(() => pinFromSidebar(${a.id}, true))`);
  x.b.tabs.update = update;
  x.b.tabs.move = async id => refused(id);
  await x.js(`serial(() => moveEssential(${w.id}, ${e.id}, null))`);
  x.b.tabs.move = move;
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("a tab closed as a pull leaves it for that tab does not stop the pull", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const there = ff.addWindow();
  const calm = ff.addTab(there.id, { url: "https://b.example/" });
  const live = ff.addTab(there.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:blank", active: true });
  const ghost = ff.addTab(here.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  const update = x.b.tabs.update;
  x.b.tabs.update = async (id, p) => { if (id === calm.id) throw new Error(`Invalid tab ID: ${id}`); return update(id, p); };
  ff.select(ghost.id);
  await wait(1500);
  assert.equal(ff.tabs.get(live.id).windowId, here.id, "the live tab has come here");
  assert.equal(x.js("problems.join()"), "");
  x.kill();
});

test("a window reopened and focused before its tabs were known opens its selected tab", async () => {
  for (const liveElsewhere of [false, true]) {
    const ff = new FakeFirefox();
    ff.store.syncedTabs = { a: entry("https://a.example/") };
    const home = ff.addWindow({ focused: true });
    ff.addTab(home.id, { url: "about:blank", active: true });
    const live = liveElsewhere ? ff.addTab(home.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" }) : null;
    const x = await run(ff);
    // Firefox brings the window back with its values; its focus and selection come first.
    const w = ff.addWindow();
    const back = ff.addTab(w.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
    ff.focused = w.id;
    x.b.windows.onFocusChanged.fire(w.id);
    x.b.windows.onCreated.fire({ id: w.id, type: "normal", incognito: false });
    await wait(1000);
    // The placeholder asks once it has loaded, on a busy machine after all that.
    if (ff.tabs.has(back.id)) await x.send({ type: "ghostShown" }, { tab: ff.snap(ff.tabs.get(back.id)) });
    await wait(500);
    const open = ff.list(w.id).find(t => t.active);
    if (liveElsewhere) assert.equal(open.id, live.id, "the live tab has come here");
    else assert.equal(open.url, "https://a.example/", "it has opened its page");
    x.kill();
  }
});

test("a ghost that shows the page, left when you come back to its window, is unloaded", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const there = ff.addWindow();
  const other = ff.addTab(there.id, { url: "about:blank" });
  const page = ff.addTab(there.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  // (At the start a page is loaded once: in the window you are not using it becomes the
  // placeholder page, reconcileAll. As if it had come back after that:)
  ff.navigate(page.id, "https://a.example/");
  // Clicking another tab in that window: Firefox selects it and focuses the window.
  for (const t of ff.list(there.id)) ff.tabs.get(t.id).active = false;
  ff.tabs.get(other.id).active = true;
  x.b.tabs.onActivated.fire({ tabId: other.id, windowId: there.id, previousTabId: page.id });
  ff.focused = there.id;
  x.b.windows.onFocusChanged.fire(there.id);
  await wait(500);
  assert.equal(ff.tabs.get(page.id).discarded, true, "and it is unloaded");
  assert.ok(ff.tabs.has(page.id), "not closed");
  x.kill();
});

test("a reopened window's placeholder whose title comes late, as an address, gets its title back", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await run(ff);
  const w = ff.addWindow();
  ff.addTab(w.id, { url: "about:blank", active: true });
  const back = ff.addTab(w.id, { url: GHOST("ghost", "a"), discarded: true, title: "A", cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  x.b.windows.onCreated.fire({ id: w.id, type: "normal", incognito: false });
  await wait(1500);
  ff.log.length = 0;
  ff.tabs.get(back.id).title = "tidier/ghost.html?kind=ghost&key=a";
  await wait(3000);
  assert.ok(ff.log.some(([what, id]) => what === "update-url" && id === back.id), "its placeholder is loaded again");
  x.kill();
});

test("a tab dragged above a new tab in the sidebar is put there, not at the end", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/"), c: entry("https://c.example/") };
  const w = ff.addWindow({ focused: true });
  const a = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const fresh = ff.addTab(w.id, { url: "about:newtab", cookieStoreId: C1 });
  ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  ff.addTab(w.id, { url: "https://c.example/", cookieStoreId: C1 }, { syncKey: "c", syncRole: "live" });
  const x = await alone(ff);
  const c = ff.list(w.id).find(t => t.url === "https://c.example/");
  await x.js(`moveTab(${w.id}, ${c.id}, ${fresh.id}, undefined)`);
  assert.deepEqual(ff.list(w.id).map(t => t.id), [a.id, c.id, fresh.id, ff.list(w.id).find(t => t.url === "https://b.example/").id]);
  x.kill();
});

test("a placeholder that was selected just as it was ready is unloaded when you have gone past it", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const home = ff.addWindow({ focused: true });
  ff.addTab(home.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  const stay = ff.addTab(other.id, { url: "about:blank" });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await run(ff);
  x.send({ type: "ghostReady", icon: false }, { tab: ff.snap(ghost), url: ghost.url });
  await wait(100);
  assert.equal(ff.tabs.get(ghost.id).discarded, false, "selected, it stays");
  for (const t of ff.list(other.id)) ff.tabs.get(t.id).active = false;
  ff.tabs.get(stay.id).active = true;
  x.b.tabs.onActivated.fire({ tabId: stay.id, windowId: other.id, previousTabId: ghost.id });
  await wait(100);
  assert.equal(ff.tabs.get(ghost.id).discarded, true);
  assert.equal(x.js("awaitingIcon.size"), 0);
  x.kill();
});
