// Where isolation meets the other packages: what is wrong only when both are there. The
// real background scripts on a fake Firefox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const A = "firefox-container-1", B = "firefox-container-2";
const GUARD = ["webRequest", "webRequestBlocking", "<all_urls>"];
const PROXY = { type: "http", host: "proxy.example", port: 8080 };
const WORK = "https://work.example/x";

async function run(ff) {
  ff.managed = { tidierAlone: true };
  ff.granted ??= new Set(GUARD);
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}
const closedFolder = ff => {
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Closed", cookieStoreId: A, parentKey: null, rank: 1, collapsed: true },
    s: { url: "https://s.example/", title: "S", cookieStoreId: A, parentKey: "F", group: false, added: 1, saved: { url: "https://s.example/", title: "S" } },
    t: { url: "https://t.example/", title: "T", cookieStoreId: A, parentKey: "F", group: false, added: 1, saved: { url: "https://t.example/", title: "T" } },
  };
};

test("a link stopped at its request opens where new tabs go, not after the tab it was in, at the end of the window", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A });
  ff.addTab(w.id, { url: "https://other.example/", cookieStoreId: A });
  const x = await run(ff);
  const t = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true);
  await wait(500);
  assert.ok(!ff.tabs.has(t.id), "the empty tab went");
  assert.equal(ff.list(w.id)[0].url, WORK, "first of today's tabs");
  assert.equal(ff.list(w.id)[0].cookieStoreId, A);
  x.kill();
});

test("a tab a rule sends away from a typed address also opens where new tabs go, in that space", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const w = ff.addWindow({ focused: true });
  const there = ff.addTab(w.id, { url: "https://there.example/", cookieStoreId: B });
  const home = ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: home.id, url: WORK })).cancel, true);
  await wait(500);
  assert.ok(ff.tabs.has(home.id), "the tab it was typed in stays");
  const order = ff.list(w.id).map(t => t.url);
  assert.ok(order.indexOf(WORK) < order.indexOf(there.url), order.join());
  x.kill();
});

test("a closed folder whose tabs all stay behind: they are rows again here, though no new tab came to show them", async () => {
  const ff = new FakeFirefox();
  closedFolder(ff);
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A });
  const s = ff.addTab(w.id, { url: "https://s.example/", cookieStoreId: A }, { syncKey: "s", syncRole: "live" });
  const t = ff.addTab(w.id, { url: "https://t.example/", cookieStoreId: A }, { syncKey: "t", syncRole: "live" });
  ff.refuseDiscard = new Set([s.id, t.id]); // unsaved input
  const x = await run(ff);
  assert.equal(ff.tabs.get(s.id).hidden, true, "resting at first");
  assert.deepEqual({ ...await x.js("moveFolderToSpace")("F", B, w.id) }, { moved: 0, stayed: 2 });
  await wait(1000);
  assert.equal(ff.tabs.get(s.id).hidden, false);
  assert.equal(ff.tabs.get(t.id).hidden, false);
  x.kill();
});

test("a copy with a closed folder: its tabs rest at once", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A });
  const x = await run(ff);
  closedFolder(ff);
  const { syncedTabs } = ff.store;
  delete ff.store.syncedTabs;
  await x.js("mergeCopy")({ tidier: "1.6", data: { syncedTabs } });
  await wait(300);
  const reps = ff.list(w.id).filter(t => t.url === GHOST("ghost", "s") || t.url === GHOST("ghost", "t"));
  assert.equal(reps.length, 2);
  assert.ok(reps.every(t => t.hidden), "not in the list or in ⌃Tab");
  x.kill();
});

test("a new space with several tabs: they go in order, and the selected one steps onto none of them", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const home = ff.addTab(w.id, { url: "https://home.example/", cookieStoreId: A });
  const one = ff.addTab(w.id, { url: "https://one.example/", cookieStoreId: A, active: true });
  const two = ff.addTab(w.id, { url: "https://two.example/", cookieStoreId: A });
  const x = await run(ff);
  ff.tabs.get(home.id).lastAccessed = 1;
  ff.tabs.get(two.id).lastAccessed = Date.now(); // used last, so what a move of the selected tab alone would step onto
  const stepped = [];
  x.b.tabs.onActivated.addListener(({ tabId }) => stepped.push(tabId));
  const space = await x.js("newSpaceWith")([one.id, two.id], w.id);
  await wait(300);
  assert.deepEqual(stepped, [home.id]);
  assert.deepEqual(ff.list(w.id).filter(t => t.cookieStoreId === space).map(t => t.url), ["https://one.example/", "https://two.example/"]);
  assert.equal(ff.tabs.get(home.id).active, true, "you stay in your space");
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a remote icon stays out of sight in a space with a proxy, also the record's and the archived list's", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A });
  const x = await run(ff);
  const icon = x.js("iconForView"), remote = "https://a.example/i.png", inline = "data:image/png;base64,AA";
  assert.equal(icon({ cookieStoreId: A, favIconUrl: undefined }, { icon: remote }), remote, "no proxy: the record's, while a page has none");
  await x.js("setSpaceNetwork")(A, { proxy: PROXY });
  assert.equal(icon({ cookieStoreId: A, favIconUrl: remote }), null);
  assert.equal(icon({ cookieStoreId: A, favIconUrl: undefined }, { icon: remote }), null);
  assert.equal(icon({ cookieStoreId: A, favIconUrl: inline }), inline, "inline costs no request");
  assert.equal(icon({ cookieStoreId: B, favIconUrl: remote }), remote);
  await x.js("noteArchived")({ url: "https://b.example/", title: "B", cookieStoreId: A, icon: remote }, "closed");
  assert.equal((await x.js("archivedTabs")(A))[0].icon, null);
  x.kill();
});

test("the small window's menus can be started again: an id that is there is an error, and nothing else clears them now", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A });
  const x = await run(ff);
  const ids = new Set();
  x.b.menus.removeAll = async () => ids.clear();
  x.b.menus.create = ({ id }) => { assert.ok(!ids.has(id), id); ids.add(id); };
  x.js("startLittleMenus")();
  x.js("startLittleMenus")();
  assert.equal(ids.size, 3);
  x.kill();
});

test("with the request looked at first, a rule whose space is gone still says which rule", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: "firefox-container-9" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A });
  const x = await run(ff);
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: A });
  x.b.tabs.onCreated.fire(ff.snap(t));
  assert.deepEqual({ ...await ff.request({ tabId: t.id, url: WORK }) }, {}, "it counts for nothing, so the page loads here");
  ff.navigate(t.id, WORK);
  await wait(500);
  assert.ok(ff.tabs.has(t.id));
  assert.match((await x.js("viewFor")(w.id)).problem ?? "", /work\.example/);
  x.kill();
});

test("a space removed: the window goes to another space before its tabs close, so you are on one of that space's tabs", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const a = ff.addTab(w.id, { url: "https://home.example/", cookieStoreId: A, lastAccessed: 1000, hidden: true });
  const b = ff.addTab(w.id, { url: "https://there.example/", active: true, cookieStoreId: B, lastAccessed: 2000 });
  ff.addTab(w.id, { url: "moz-extension://tidier/sidebar/sidebar.html", lastAccessed: 1500 });
  w.order.unshift(w.order.pop()); // what the fake selects once the selected tab closes
  const x = await run(ff);
  ff.containers.delete(B);
  await x.js("serial")(() => x.js("forgetSpace")(B)); // the one handler: Firefox gives two listeners no order
  await wait(500);
  assert.ok(!ff.tabs.has(b.id));
  assert.equal(ff.tabs.get(a.id).active, true);
  assert.equal(x.js("activeSpace").get(w.id), A);
  x.kill();
});
