// Names for essentials and saved tabs (tabnames.js), on Tidier's real background
// scripts on a fake Firefox: what can change a name and what cannot, and that every
// window is told. The box you type in is checked in the smoke test (alone_tab_names).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const folder = name => ({ group: true, own: true, name, cookieStoreId: C1, parentKey: null, rank: 1, added: 1 });
const savedEntry = (url, title, more = {}) => entry(url, { title, parentKey: "F", saved: { url, title }, ...more });

async function start(ff, { tidierAlone = true } = {}) {
  ff.managed = { tidierAlone };
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// The sidebar of a window, through the same port a real one uses.
function sidebar(x, windowId) {
  const listeners = [], views = [];
  const port = {
    name: "sidebar", sender: { id: "tidier" }, views,
    onMessage: { addListener: f => listeners.push(f) }, onDisconnect: { addListener() {} },
    postMessage: v => views.push(v),
    send: msg => Promise.all(listeners.map(f => f(msg))),
    last: () => views.at(-1),
  };
  x.b.runtime.onConnect.fire(port);
  port.send({ type: "hello", windowId });
  return port;
}

// Two windows: a saved tab live in the first with a placeholder in the second, and an
// ordinary tab the same way.
async function twoWindows(ff, options) {
  ff.store.syncedTabs = {
    F: folder("Kept"),
    s: savedEntry("https://a.example/board", "Board"),
    o: entry("https://b.example/", { title: "Plain" }),
  };
  const one = ff.addWindow({ focused: true });
  const liveSaved = ff.addTab(one.id, { url: "https://a.example/board", title: "Board", active: true, cookieStoreId: C1 }, { syncKey: "s", syncRole: "live" });
  const liveOrdinary = ff.addTab(one.id, { url: "https://b.example/", title: "Plain", cookieStoreId: C1 }, { syncKey: "o", syncRole: "live" });
  const two = ff.addWindow();
  ff.addTab(two.id, { url: "about:home", active: true });
  const ghostSaved = ff.addTab(two.id, { url: GHOST("ghost", "s"), title: "Board", discarded: true, cookieStoreId: C1 }, { syncKey: "s", syncRole: "ghost" });
  const ghostOrdinary = ff.addTab(two.id, { url: GHOST("ghost", "o"), title: "Plain", discarded: true, cookieStoreId: C1 }, { syncKey: "o", syncRole: "ghost" });
  const x = await start(ff, options);
  return { x, one, two, liveSaved, liveOrdinary, ghostSaved, ghostOrdinary };
}

const row = (view, id) => [...view.tabs, ...view.folders.flatMap(f => f.tabs)].find(t => t.id === id);
const flush = async x => { await x.js("flushWrites()"); await wait(100); };

test("a saved tab's name is shown in every window, survives its page's title and an unload", async () => {
  const ff = new FakeFirefox();
  const { x, one, two, liveSaved, ghostSaved } = await twoWindows(ff);
  const a = sidebar(x, one.id), b = sidebar(x, two.id);
  await wait(200);
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "  Sprint board " });
  await wait(200);
  assert.equal(row(a.last(), liveSaved.id).title, "Sprint board", "trimmed, and shown here");
  assert.equal(row(b.last(), ghostSaved.id).title, "Sprint board", "and in the other window");
  assert.ok(ff.log.some(l => l[0] === "update-url" && l[1] === ghostSaved.id), "the placeholder is loaded again, to take the name as its own title");
  assert.equal((await x.send({ type: "ghostInfo", kind: "ghost", key: "s" }, { tab: ghostSaved })).title, "Sprint board");

  // The page changes its title: the record follows it, and the name stays.
  ff.tabs.get(liveSaved.id).title = "Board (3 new)";
  x.b.tabs.onUpdated.fire(liveSaved.id, { title: "Board (3 new)" }, ff.snap(ff.tabs.get(liveSaved.id)));
  await wait(200);
  const all = await x.js("getSynced()");
  assert.equal(all.s.title, "Board (3 new)");
  assert.equal(all.s.name, "Sprint board");
  assert.equal(row(a.last(), liveSaved.id).title, "Sprint board");

  // Closing it while loaded unloads it, back to its saved address and title.
  await x.js("unloadSaved")("s", one.id, null);
  await wait(200);
  const after = await x.js("getSynced()");
  assert.equal(after.s.title, "Board (3 new)", "the saved title followed the page on its saved address");
  assert.equal(after.s.name, "Sprint board");

  // Cleared: the page's title again, everywhere.
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "" });
  await wait(200);
  assert.ok(!("name" in (await x.js("getSynced()")).s));
  assert.equal(row(b.last(), ghostSaved.id).title, "Board (3 new)");
  assert.equal((await x.send({ type: "ghostInfo", kind: "ghost", key: "s" }, { tab: ghostSaved })).title, "Board (3 new)");
  x.kill();
});

test("an ordinary tab gets no name, and a live folder's tab neither", async () => {
  const ff = new FakeFirefox();
  const { x, one, liveOrdinary } = await twoWindows(ff);
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: liveOrdinary.id, name: "Mine" });
  const all = await x.js("getSynced()");
  assert.ok(!("name" in all.o));
  // A live folder's tab is in a folder, but not saved: its search decides what it is.
  all.o.liveFolder = "L";
  all.o.parentKey = "F";
  x.js("noteSaved")(all);
  await a.send({ type: "renameTab", tabId: liveOrdinary.id, name: "Mine" });
  assert.ok(!("name" in (await x.js("getSynced()")).o));
  x.kill();
});

test("a tab that left its folder has no name any more, and a folder keeps its own", async () => {
  const ff = new FakeFirefox();
  const { x, one, liveSaved, ghostSaved } = await twoWindows(ff);
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "Sprint board" });
  ff.tabs.get(ghostSaved.id).discarded = true; // it unloads itself; the fake leaves it loaded
  await a.send({ type: "moveTab", tabId: liveSaved.id, before: null, folder: null });
  await wait(200);
  const all = await x.js("getSynced()");
  assert.ok(!("saved" in all.s) && !("name" in all.s));
  assert.equal(all.F.name, "Kept");
  assert.equal(row(a.last(), liveSaved.id).title, "Board");
  await wait(4000);
  const reloaded = ff.log.filter(l => l[0] === "update-url" && l[1] === ghostSaved.id).length;
  assert.ok(reloaded >= 2, "the placeholder took the name, and is told when it is gone");
  x.kill();
});

test("a name outlives a restart, and an unknown tab or a long paste does no harm", async () => {
  const ff = new FakeFirefox();
  const { x, one, liveSaved } = await twoWindows(ff);
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: 99999, name: "Nothing" });
  assert.deepEqual(x.errors, []);
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "x".repeat(5000) });
  await wait(100);
  assert.equal((await x.js("getSynced()")).s.name.length, 200);
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "Sprint board" });
  await flush(x);
  x.kill();
  assert.equal(ff.store.syncedTabs.s.name, "Sprint board");
  const y = await start(ff);
  const again = sidebar(y, one.id);
  await wait(200);
  assert.equal(row(again.last(), liveSaved.id).title, "Sprint board");
  y.kill();
});

// One essential with a loaded copy here and a placeholder in the other window.
async function essential(ff, options) {
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "Sign in", icon: "x" }];
  const one = ff.addWindow({ focused: true });
  const loaded = ff.addTab(one.id, { url: "https://e.example/", title: "Sign in", pinned: true, active: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const two = ff.addWindow();
  const copy = ff.addTab(two.id, { url: GHOST("essential", "e"), title: "Sign in", pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "e" });
  ff.addTab(two.id, { url: "about:home", active: true });
  const x = await start(ff, options);
  return { x, one, two, loaded, copy };
}

test("an essential's name goes in its list entry, is shown everywhere, and its page's title cannot change it", async () => {
  const ff = new FakeFirefox();
  const { x, one, two, loaded, copy } = await essential(ff);
  const a = sidebar(x, one.id), b = sidebar(x, two.id);
  await wait(200);
  await a.send({ type: "renameTab", tabId: loaded.id, name: "Jira" });
  await wait(200);
  assert.equal(a.last().essentials[0].title, "Jira");
  assert.equal(b.last().essentials[0].title, "Jira", "told every window, not only the one that asked");
  assert.ok(ff.log.some(l => l[0] === "update-url" && l[1] === copy.id), "the placeholder takes the name as its own title");
  assert.equal((await x.send({ type: "ghostInfo", kind: "essential", key: "e" }, { tab: copy })).title, "Jira");

  ff.tabs.get(loaded.id).title = "Board - Jira";
  x.b.tabs.onUpdated.fire(loaded.id, { title: "Board - Jira" }, ff.snap(ff.tabs.get(loaded.id)));
  await wait(200);
  assert.deepEqual([(await x.js("getList()"))[0].title, (await x.js("getList()"))[0].name], ["Board - Jira", "Jira"]);
  assert.equal(a.last().essentials[0].title, "Jira");

  await b.send({ type: "renameTab", tabId: copy.id, name: "   " });
  await wait(200);
  assert.ok(!("name" in (await x.js("getList()"))[0]));
  assert.equal(a.last().essentials[0].title, "Board - Jira", "named from the other window's copy, cleared the same way");
  x.kill();
});

test("a saved tab made an essential keeps its name, and an essential made an ordinary tab loses it", async () => {
  const ff = new FakeFirefox();
  const { x, one, liveSaved } = await twoWindows(ff);
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "Sprint board" });
  await a.send({ type: "pin", tabId: liveSaved.id, pinned: true });
  await wait(500);
  const list = await x.js("getList()");
  assert.equal(list[0].name, "Sprint board");
  assert.equal(a.last().essentials[0].title, "Sprint board");
  await a.send({ type: "pin", tabId: liveSaved.id, pinned: false });
  await wait(3000);
  const key = ff.values.get(liveSaved.id)?.syncKey;
  assert.ok(key, "an ordinary tab again");
  assert.ok(!("name" in (await x.js("getSynced()"))[key]));
  x.kill();
});

// Seen in a real Firefox, without any name: the unpin was taken for Tidier's own change, so
// the tab stayed an unpinned placeholder of an essential that also stayed in the list.
test("a placeholder made an essential and at once taken back is an ordinary tab with its page", async () => {
  const ff = new FakeFirefox();
  const { x, two, ghostOrdinary } = await twoWindows(ff);
  const b = sidebar(x, two.id);
  await b.send({ type: "pin", tabId: ghostOrdinary.id, pinned: true });
  await b.send({ type: "pin", tabId: ghostOrdinary.id, pinned: false });
  await wait(1000);
  assert.equal((await x.js("getList()")).length, 0);
  assert.equal(ff.tabs.get(ghostOrdinary.id).url, "https://b.example/");
  x.kill();
});

// Firefox gives a duplicate its tab's values, so this tab has the essential's key
// (seen in a real Firefox) and is not that essential.
test("a duplicate of an essential, saved in a folder, gets a name of its own", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "Sign in", icon: "x", name: "Jira" }];
  ff.store.syncedTabs = { F: folder("Kept"), d: savedEntry("https://e.example/", "Sign in") };
  const one = ff.addWindow({ focused: true });
  const loaded = ff.addTab(one.id, { url: "https://e.example/", title: "Sign in", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const dup = ff.addTab(one.id, { url: "https://e.example/", title: "Sign in", active: true, cookieStoreId: C1 }, { essentialKey: "e", syncKey: "d", syncRole: "live" });
  const x = await start(ff);
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: dup.id, name: "Mine" });
  await wait(200);
  assert.equal((await x.js("getList()"))[0].name, "Jira", "the essential keeps its own");
  assert.equal((await x.js("getSynced()")).d.name, "Mine");
  assert.equal(row(a.last(), dup.id).title, "Mine");
  assert.equal(a.last().essentials.find(t => t.id === loaded.id).title, "Jira");
  assert.equal(await x.js(`keyByTab.has(${dup.id})`), false, "nor does it count as a copy of the essential from now on");
  x.kill();
});

test("a pinned tab that is no essential stays as it is", async () => {
  const ff = new FakeFirefox();
  const one = ff.addWindow({ focused: true });
  const pinned = ff.addTab(one.id, { url: "about:preferences", title: "Settings", pinned: true, active: true });
  const x = await start(ff);
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: pinned.id, name: "Mine" });
  await wait(100);
  assert.equal((await x.js("getList()")).length, 0);
  assert.deepEqual(x.errors, []);
  x.kill();
});

// A name is often given because the title is noisy, so this is the case to get right.
test("a named tab's new title reloads no placeholder, while its new icon does, and an unnamed tab's title too", async () => {
  const ff = new FakeFirefox();
  const { x, one, liveSaved, ghostSaved, liveOrdinary, ghostOrdinary } = await twoWindows(ff);
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "Sprint board" });
  await wait(200);
  const reloads = id => ff.log.filter(l => l[0] === "update-url" && l[1] === id).length;
  const change = (tab, values) => {
    Object.assign(ff.tabs.get(tab.id), values);
    x.b.tabs.onUpdated.fire(tab.id, values, ff.snap(ff.tabs.get(tab.id)));
  };
  ff.tabs.get(ghostSaved.id).discarded = true; // the fake leaves it loaded
  const before = reloads(ghostSaved.id);
  change(liveSaved, { title: "Board (3 new)" });
  await wait(5000);
  assert.equal(reloads(ghostSaved.id), before, "its title is not what they show");
  assert.equal((await x.js("getSynced()")).s.title, "Board (3 new)", "still followed, for when the name is cleared");
  change(liveSaved, { favIconUrl: "https://a.example/new.png" });
  await wait(5000);
  assert.equal(reloads(ghostSaved.id), before + 1, "its icon is");
  change(liveOrdinary, { title: "Plain (1)" });
  await wait(5000);
  assert.equal(reloads(ghostOrdinary.id), 1);
  x.kill();
});

test("names travel with a copy", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = await start(ff);
  await x.js("mergeCopy")({ data: {
    essentials: [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "Sign in", icon: "x", name: "Jira" }],
    syncedTabs: { F: folder("Kept"), s: savedEntry("https://a.example/board", "Board", { name: "Sprint board" }) },
  } });
  await wait(100);
  assert.equal((await x.js("getList()"))[0].name, "Jira");
  assert.equal((await x.js("getSynced()")).s.name, "Sprint board");
  x.kill();
});

test("with the setting off, a rename does nothing", async () => {
  const ff = new FakeFirefox();
  const { x, one, liveSaved } = await twoWindows(ff, { tidierAlone: false });
  const a = sidebar(x, one.id);
  await a.send({ type: "renameTab", tabId: liveSaved.id, name: "Sprint board" });
  await wait(100);
  assert.ok(!("name" in (await x.js("getSynced()")).s));
  x.kill();
});
