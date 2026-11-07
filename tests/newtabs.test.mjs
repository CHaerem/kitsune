// New tabs have one place (newtabs.js): the real background scripts on a fake Firefox.
// What Firefox really does with them is checked in the smoke test (alone_new_tab).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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
  const listeners = [], views = [];
  x.b.runtime.onConnect.fire({ name: "sidebar", sender: { id: "tidier" }, onMessage: { addListener: f => listeners.push(f) }, onDisconnect: { addListener() {} }, postMessage: v => views.push(v) });
  const send = msg => Promise.all(listeners.map(f => f(msg)));
  send.views = views;
  return send({ type: "hello", windowId }).then(() => send);
}

// Waits for a state. A chain of timers (the wait, then the job, then the view) has no end
// one can wait past: on a busy machine a fixed wait can run out in the middle of it.
const until = async (test, ms = 100000) => { for (let t = 0; !test() && t < ms; t += 100) await wait(100); };

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
  // A blank tab that never gets an address is drawn after all, without another event: the
  // sidebar is sent a view by itself.
  const send = await sidebar(x, w.id);
  const blank = created({ url: "about:blank" });
  await wait(50);
  assert.ok(!(await drawn()).includes(blank.id));
  send.views.length = 0;
  await until(() => send.views.at(-1)?.tabs.some(t => t.id === blank.id));
  assert.equal(send.views.at(-1)?.tabs[0].id, blank.id, "in the one place");
  x.kill();
});

test("a link that takes longer than the wait shows in the one place meanwhile, and stays there", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder() };
  const w = ff.addWindow({ focused: true });
  const [, a] = fill(ff, w, [["kept", C1, { parentKey: "F" }], ["a"], ["b"]]);
  a.active = true;
  const x = await start(ff);
  const send = await sidebar(x, w.id);
  const slow = ff.addTab(w.id, { url: "about:blank", active: true });
  x.b.tabs.onCreated.fire(ff.snap(slow));
  await until(() => !x.js("newTabs").has(slow.id));
  assert.equal(ff.tabs.get(slow.id).url, "about:blank", "still waiting for the site");
  assert.equal(await firstDrawn(x, w.id), slow.id);
  assert.equal(ff.index(slow), 1, "under the folder's tab");
  send.views.length = 0;
  ff.navigate(slow.id, "https://slow.example/");
  await wait(300);
  assert.ok(!ff.tabs.has(slow.id), "opened again in the space");
  const made = ff.list(w.id)[1];
  assert.equal(made.url, "https://slow.example/");
  assert.equal(made.cookieStoreId, C1);
  assert.equal(await firstDrawn(x, w.id), made.id);
  x.kill();
});

test("a blank tab already in the one place is drawn after the wait too, with nothing moved to say so", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder() };
  const w = ff.addWindow({ focused: true });
  const [kept] = fill(ff, w, [["kept", C1, { parentKey: "F" }]]);
  kept.active = true;
  const x = await start(ff);
  const send = await sidebar(x, w.id);
  const blank = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(blank));
  await wait(50);
  send.views.length = 0;
  await until(() => !x.js("newTabs").has(blank.id));
  await wait(200); // the view that says so comes right after (VIEW_DEBOUNCE_MS); later ones come from elsewhere
  assert.equal(send.views.at(-1)?.tabs[0]?.id, blank.id);
  assert.ok(!ff.log.some(([what]) => what === "move"));
  x.kill();
});

test("a page that stays as it is keeps its place: nothing moves it after the wait", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const [a] = fill(ff, w, [["a"], ["b"]]);
  a.active = true;
  const x = await start(ff);
  const addons = ff.addTab(w.id, { url: "about:addons" });
  x.b.tabs.onCreated.fire(ff.snap(addons));
  await until(() => !x.js("newTabs").has(addons.id));
  assert.equal(ff.index(addons), 2);
  assert.ok(!ff.log.some(([what, id]) => what === "move" && id === addons.id));
  assert.equal(x.js("newTabs").size, 0, "nothing is kept");
  x.kill();
});

test("while a tab is opened again its row is not drawn, up to when it is gone", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const [a] = fill(ff, w, [["a"]]);
  a.active = true;
  const x = await start(ff);
  const seen = new Set();
  const link = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(link));
  await wait(50);
  // Whenever Tidier looks at the tabs on the way, so also in the middle of opening it again.
  let looking = false;
  ff.hooks.query = async () => {
    if (looking) return;
    looking = true;
    for (const t of (await x.js("viewFor")(w.id)).tabs) seen.add(t.id);
    looking = false;
  };
  ff.navigate(link.id, "https://link.example/");
  await wait(300);
  assert.ok(!ff.tabs.has(link.id), "it has been opened again");
  assert.ok(seen.has(a.id), "the views were looked at");
  assert.ok(!seen.has(link.id));
  x.kill();
});

// The double click (sidebar/newtab.js), on a small stand-in for the sidebar page.
function sidebarPage({ alone = true } = {}) {
  const on = {}, sent = [], list = { addEventListener: (type, f) => { on[`list:${type}`] = f; } };
  const ctx = vm.createContext({
    view: { alone, space: C1 }, send: m => sent.push({ ...m }),
    document: { getElementById: () => list }, addEventListener: (type, f, capture) => { on[`window:${type}:${!!capture}`] = f; },
  });
  vm.runInContext(readFileSync(new URL("../sidebar/newtab.js", import.meta.url), "utf8"), ctx);
  // A click, as Firefox delivers it: the window first (capture), the list only if it is on the list.
  const press = (target, detail) => { on["window:mousedown:true"]?.({ target, detail }); if (target === list) on["list:mousedown"]?.({ target, detail }); };
  const twice = (first, second = first) => { press(first, 1); press(second, 2); if (second === list) on["list:dblclick"]({ target: second }); return sent; };
  return { list, twice, sent };
}

test("a double click on the empty part opens a tab; only there, and only with the setting on", () => {
  const empty = sidebarPage();
  assert.deepEqual(empty.twice(empty.list), [{ type: "newTab", space: C1 }]);
  const row = sidebarPage();
  assert.deepEqual(row.twice({ className: "row" }, row.list), [], "the first click was on a row, which went from under the pointer");
  const off = sidebarPage({ alone: false });
  assert.deepEqual(off.twice(off.list), [], "with the setting off a double click does nothing");
});

test("a double click that began outside the list opens nothing, whatever a click long ago was on", () => {
  const p = sidebarPage();
  p.twice(p.list);
  p.sent.length = 0;
  // An essential's tile, say: what is under the pointer moves between the two clicks.
  p.twice({ className: "tile" }, p.list);
  assert.deepEqual(p.sent, []);
});

// A link from a tab drawn apart (Firefox puts it next to that tab, which says nothing in
// today's list). `opener` is one of the tabs of the window; the link opens as Firefox opens it.
async function linkFrom(ff, x, w, opener, url) {
  const link = ff.addTab(w.id, { url: "about:blank", cookieStoreId: opener.cookieStoreId, openerTabId: opener.id, index: Math.max(ff.index(opener) + 1, ff.list(w.id).filter(t => t.pinned).length) });
  x.b.tabs.onCreated.fire(ff.snap(link));
  await wait(50);
  ff.navigate(link.id, url);
  await wait(3000); // a new tab is registered once it has settled (SETTLE_MS)
  return link;
}

test("a link from a tab in a folder takes the one place, in every window; it is not next to a tab drawn apart", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder() };
  const w = ff.addWindow({ focused: true }), v = ff.addWindow();
  // A tab moved into a folder lies last in the window (moveTab), so next to it is out of sight.
  const [a, , kept] = fill(ff, w, [["a"], ["b"], ["kept", C1, { parentKey: "F" }], ["c"]]);
  a.active = true;
  fill(ff, v, [["a"], ["b"], ["kept"], ["c"]], "ghost");
  const x = await start(ff);
  const link = await linkFrom(ff, x, w, kept, "https://from-folder.example/");
  const key = ff.values.get(link.id).syncKey;
  assert.equal(await firstDrawn(x, w.id), link.id);
  assert.deepEqual(keysIn(ff, w.id), [key, "a", "b", "kept", "c"]);
  assert.deepEqual(keysIn(ff, v.id), [key, "a", "b", "kept", "c"]);
  assert.equal(ff.synced[key].parentKey, null, "it is an ordinary tab");
  x.kill();
});

test("every link from an essential takes the one place, not only the first", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const essential = ff.addTab(w.id, { pinned: true, url: "https://essential.example/", cookieStoreId: C1, active: true });
  fill(ff, w, [["a"], ["b"]]);
  const x = await start(ff);
  const first = await linkFrom(ff, x, w, essential, "https://one.example/");
  // Firefox puts the next one after the last link from the same tab.
  const second = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1, openerTabId: essential.id, index: ff.index(first) + 1 });
  x.b.tabs.onCreated.fire(ff.snap(second));
  await wait(100);
  assert.equal(await firstDrawn(x, w.id), second.id);
  x.kill();
});

test("a link from a tab in another space's folder stays next to it: that tab is drawn in today's list", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F2: folder(C2) };
  const w = ff.addWindow({ focused: true });
  const [a, strayed] = fill(ff, w, [["a"], ["strayed", C1, { parentKey: "F2" }], ["b"]]);
  a.active = true;
  const x = await start(ff);
  const link = await linkFrom(ff, x, w, strayed, "https://next.example/");
  assert.equal(ff.index(link), ff.index(strayed) + 1);
  x.kill();
});

test("with the setting off a link from a tab is never moved, wherever its opener is", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const essential = ff.addTab(w.id, { pinned: true, url: "https://essential.example/", cookieStoreId: C1, active: true });
  fill(ff, w, [["a"], ["b"]]);
  const x = await start(ff, { alone: false });
  const first = await linkFrom(ff, x, w, essential, "https://one.example/");
  // Firefox puts the next one after the last link from the same tab: with Tidier alone, the
  // one place would be above it.
  const second = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1, openerTabId: essential.id, index: ff.index(first) + 1 });
  x.b.tabs.onCreated.fire(ff.snap(second));
  await wait(100);
  assert.equal(ff.index(second), ff.index(first) + 1);
  assert.ok(!ff.log.some(([what, id]) => what === "move" && id === second.id));
  x.kill();
});
