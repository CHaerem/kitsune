// New tabs have one place (newtabs.js): the real background scripts on a fake Firefox.
// What Firefox really does with them is checked in the smoke test (alone_new_tab).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2", NONE = "firefox-default";
const page = key => `https://${key}.example/`;
const entry = (key, more = {}) => ({ url: page(key), title: key, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const folder = (cookieStoreId = C1) => ({ group: true, own: true, name: "Kept", cookieStoreId, parentKey: null, rank: 1 });

async function start(ff, { alone = true } = {}) {
  if (alone) ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// A window with tabs given as [key, container, record fields]; each is in the record,
// live here or a placeholder when `role` says so. The first of the active space is selected.
function fill(ff, w, tabs, role = "live") {
  ff.store.syncedTabs ??= {};
  return tabs.map(([key, cookieStoreId = C1, more = {}]) => {
    ff.store.syncedTabs[key] ??= entry(key, { cookieStoreId, ...more });
    return ff.addTab(w.id, { url: role === "live" ? page(key) : `moz-extension://tidier/ghost.html?kind=ghost&key=${key}`, cookieStoreId, discarded: role !== "live" }, { syncKey: key, syncRole: role });
  });
}
const keysIn = (ff, windowId, space = C1) => ff.list(windowId).filter(t => t.cookieStoreId === space && !t.pinned).map(t => ff.values.get(t.id)?.syncKey ?? t.url);

// The sidebar's port, as sidebar.js opens it.
function sidebar(x, windowId) {
  const listeners = [];
  x.b.runtime.onConnect.fire({ name: "sidebar", sender: { id: "tidier" }, onMessage: { addListener: f => listeners.push(f) }, onDisconnect: { addListener() {} }, postMessage() {} });
  const send = msg => Promise.all(listeners.map(f => f(msg)));
  return send({ type: "hello", windowId }).then(() => send);
}

// What viewFor draws first among today's tabs: topOfToday must agree with it.
const firstDrawn = async (x, windowId) => (await x.js("viewFor")(windowId)).tabs[0]?.id;

test("topOfToday: a tab placed there is drawn first, with folders and other spaces' tabs before and between", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder() };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { pinned: true, url: "https://essential.example/", cookieStoreId: C1 });
  const [inFolder, other, first] = fill(ff, w, [["kept", C1, { parentKey: "F" }], ["other", C2], ["first"], ["otherToo", C2], ["second"]]);
  first.active = true;
  const x = await start(ff);
  assert.equal(await x.js("topOfToday")(w.id, C1), ff.index(first), "not the folder's tab, not the other space's");
  assert.ok(ff.index(inFolder) < ff.index(first) && ff.index(other) < ff.index(first));
  const made = await x.b.tabs.create({ windowId: w.id, cookieStoreId: C1, index: await x.js("topOfToday")(w.id, C1) });
  await wait(100);
  assert.equal(await firstDrawn(x, w.id), made.id);
  x.kill();
});

test("topOfToday: the end of the window when today's list is empty", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder() };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { pinned: true, url: "https://essential.example/", cookieStoreId: C1, active: true });
  fill(ff, w, [["kept", C1, { parentKey: "F" }], ["other", C2]]);
  const x = await start(ff);
  assert.equal(await x.js("topOfToday")(w.id, C1), 3);
  assert.equal(await x.js("topOfToday")(w.id, "firefox-container-3"), 3, "a space with nothing at all");
  x.kill();
});

test("topOfToday: a tab without a container is a row of every space; another space's folder draws nothing here", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F2: folder(C2) };
  const w = ff.addWindow({ focused: true });
  const [strayed] = fill(ff, w, [["strayed", C1, { parentKey: "F2" }], ["today"]]);
  strayed.active = true;
  const settings = ff.addTab(w.id, { url: "about:addons", cookieStoreId: NONE, index: 0 });
  const x = await start(ff);
  assert.equal(await x.js("topOfToday")(w.id, C1), ff.index(settings));
  ff.rm(settings.id);
  await wait(100);
  assert.equal(await x.js("topOfToday")(w.id, C1), ff.index(strayed), "as viewFor: in the list, since its folder is not in this space");
  assert.equal(await firstDrawn(x, w.id), strayed.id);
  x.kill();
});

test("the new tab button opens first among today's tabs; with the setting off, at the end as before", async () => {
  for (const alone of [true, false]) {
    const ff = new FakeFirefox();
    const w = ff.addWindow({ focused: true });
    const [first] = fill(ff, w, [["a"], ["b"]]);
    first.active = true;
    const x = await start(ff, { alone });
    const send = await sidebar(x, w.id);
    await send({ type: "newTab", space: C1 });
    await wait(100);
    const fresh = ff.list(w.id).find(t => !ff.values.has(t.id));
    assert.equal(fresh.cookieStoreId, C1);
    assert.equal(fresh.index, alone ? 0 : 2, alone ? "at the top" : "at the end");
    x.kill();
  }
});

test("⌘T: a new tab page without a container is opened again at the top, and selected", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder() };
  const w = ff.addWindow({ focused: true });
  const [kept, first] = fill(ff, w, [["kept", C1, { parentKey: "F" }], ["a"], ["b"]]);
  first.active = true;
  const x = await start(ff);
  const t = ff.addTab(w.id, { url: "about:newtab" });
  ff.select(t.id);
  x.b.tabs.onCreated.fire(ff.snap(t));
  await wait(300);
  assert.ok(!ff.tabs.has(t.id), "the tab without a container is gone");
  const list = ff.list(w.id);
  assert.equal(list.length, 4);
  assert.equal(list[1].cookieStoreId, C1);
  assert.equal(list[1].active, true);
  assert.equal(await firstDrawn(x, w.id), list[1].id);
  assert.equal(ff.index(kept), 0, "the folder's tab stays where it was");
  x.kill();
});

test("a link from another app opens at the top, also with an essential selected", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const essential = ff.addTab(w.id, { pinned: true, url: "https://essential.example/", cookieStoreId: C1, active: true });
  fill(ff, w, [["a"], ["b"]]);
  const x = await start(ff);
  const t = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  await wait(50);
  ff.navigate(t.id, "https://link.example/");
  await wait(300);
  assert.ok(!ff.tabs.has(t.id));
  assert.deepEqual(ff.urls(w.id).slice(1), ["https://link.example/", page("a"), page("b")]);
  assert.equal(ff.list(w.id)[1].cookieStoreId, C1);
  assert.equal(ff.index(essential), 0);
  x.kill();
});

test("a link opened from a tab without a container stays next to it; from an essential it has no list to stay in", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const essential = ff.addTab(w.id, { pinned: true, url: "https://essential.example/", cookieStoreId: NONE });
  const [a] = fill(ff, w, [["a"]]);
  a.active = true;
  const addons = ff.addTab(w.id, { url: "about:addons" });
  fill(ff, w, [["b"]]);
  const x = await start(ff);
  const beside = ff.addTab(w.id, { url: "about:blank", openerTabId: addons.id, index: ff.index(addons) + 1 });
  x.b.tabs.onCreated.fire(ff.snap(beside));
  await wait(50);
  ff.navigate(beside.id, "https://from-page.example/");
  await wait(300);
  assert.deepEqual(ff.urls(w.id).slice(1), [page("a"), "about:addons", "https://from-page.example/", page("b")]);
  const fromEssential = ff.addTab(w.id, { url: "about:blank", openerTabId: essential.id, index: 1 });
  x.b.tabs.onCreated.fire(ff.snap(fromEssential));
  await wait(50);
  ff.navigate(fromEssential.id, "https://from-essential.example/");
  await wait(300);
  assert.equal(ff.urls(w.id)[1], "https://from-essential.example/");
  x.kill();
});

test("a rule sends a link to the top of its space, also a link opened from a tab in another space", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: C2 }];
  const w = ff.addWindow({ focused: true });
  fill(ff, w, [["two", C2]]);
  const [here] = fill(ff, w, [["here"]]);
  here.active = true;
  fill(ff, w, [["twoToo", C2]]);
  const x = await start(ff);
  const open = async (url, more) => {
    const t = ff.addTab(w.id, { url: "about:blank", ...more });
    x.b.tabs.onCreated.fire(ff.snap(t));
    await wait(50);
    ff.navigate(t.id, url);
    await wait(300);
    assert.ok(!ff.tabs.has(t.id));
    return keysIn(ff, w.id, C2);
  };
  // From the other app: no opener.
  assert.deepEqual(await open("https://work.example/one"), ["https://work.example/one", "two", "twoToo"]);
  // From the tab here: beside its opener would be in the middle of the other space's list.
  assert.deepEqual(await open("https://work.example/two", { cookieStoreId: C1, openerTabId: here.id, index: ff.index(here) + 1 }),
    ["https://work.example/two", "https://work.example/one", "two", "twoToo"]);
  x.kill();
});

test("a new tab's placeholder in another window goes before the same neighbour, once it has an address", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true }), v = ff.addWindow();
  const [a] = fill(ff, w, [["a"], ["other", C2], ["b"]]);
  a.active = true;
  // The other window has them in another mix of spaces, and each tab of the space in the same order.
  fill(ff, v, [["other", C2], ["a"], ["b"]], "ghost");
  const x = await start(ff);
  const send = await sidebar(x, w.id);
  await send({ type: "newTab", space: C1 });
  await wait(100);
  const fresh = ff.list(w.id)[0];
  assert.equal(ff.list(v.id).length, 3, "a new tab page is not in the record yet");
  ff.navigate(fresh.id, "https://fresh.example/");
  await wait(3000); // a new tab is registered once it has settled (SETTLE_MS)
  const key = ff.values.get(fresh.id).syncKey;
  assert.deepEqual(keysIn(ff, w.id), [key, "a", "b"]);
  assert.deepEqual(keysIn(ff, v.id), [key, "a", "b"]);
  x.kill();
});

test("a link from a tab has the same neighbours in another window", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true }), v = ff.addWindow();
  const [a] = fill(ff, w, [["a"], ["b"]]);
  a.active = true;
  fill(ff, v, [["a"], ["b"]], "ghost");
  const x = await start(ff);
  // Firefox opens it next to its opener, in its container, before the address is known.
  const link = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1, openerTabId: a.id, index: 1 });
  x.b.tabs.onCreated.fire(ff.snap(link));
  await wait(50);
  ff.navigate(link.id, "https://link.example/");
  await wait(3000); // a new tab is registered once it has settled (SETTLE_MS)
  assert.ok(ff.tabs.has(link.id), "it stays where Firefox put it");
  const key = ff.values.get(link.id).syncKey;
  assert.deepEqual(keysIn(ff, w.id), ["a", key, "b"]);
  assert.deepEqual(keysIn(ff, v.id), ["a", key, "b"]);
  // The last of its space here is the last there too.
  const last = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1, openerTabId: ff.list(w.id).at(-1).id });
  x.b.tabs.onCreated.fire(ff.snap(last));
  await wait(50);
  ff.navigate(last.id, "https://last.example/");
  await wait(3000); // a new tab is registered once it has settled (SETTLE_MS)
  assert.equal(keysIn(ff, v.id).at(-1), ff.values.get(last.id).syncKey);
  x.kill();
});

test("with the setting off, another window's placeholder is added at the end, as before", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true }), v = ff.addWindow();
  const [a] = fill(ff, w, [["a"], ["b"]]);
  a.active = true;
  fill(ff, v, [["a"], ["b"]], "ghost");
  const x = await start(ff, { alone: false });
  // (No opener: with Sidebery an opener is its tree, which has its own rules for the place.)
  const link = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1, index: 1 });
  x.b.tabs.onCreated.fire(ff.snap(link));
  await wait(50);
  ff.navigate(link.id, "https://link.example/");
  await wait(3000); // a new tab is registered once it has settled (SETTLE_MS)
  assert.deepEqual(keysIn(ff, v.id), ["a", "b", ff.values.get(link.id).syncKey]);
  x.kill();
});

test("a tab about to be opened again is not drawn, so it does not jump; a page that stays is drawn at once", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const [a] = fill(ff, w, [["a"]]);
  a.active = true;
  const x = await start(ff);
  const drawn = async () => (await x.js("viewFor")(w.id)).tabs.map(t => t.id);
  const created = props => { const t = ff.addTab(w.id, props); x.b.tabs.onCreated.fire(ff.snap(t)); return t; };
  const link = created({ url: "about:blank" });
  await wait(50);
  assert.deepEqual([...await drawn()], [a.id], "its address is not known yet");
  ff.navigate(link.id, "https://link.example/");
  await wait(300);
  assert.equal((await drawn()).length, 2);
  assert.equal(ff.list(w.id)[0].url, "https://link.example/");
  const addons = created({ url: "about:addons" });
  await wait(50);
  assert.ok((await drawn()).includes(addons.id));
  // A blank tab that never gets an address is drawn after all, without another event.
  const blank = created({ url: "about:blank" });
  await wait(50);
  assert.ok(!(await drawn()).includes(blank.id));
  await wait(3200);
  assert.ok((await drawn()).includes(blank.id));
  x.kill();
});
