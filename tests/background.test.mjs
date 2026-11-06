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
