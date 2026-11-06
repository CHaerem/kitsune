// What keeps Tidier light with many tabs, on its real background scripts: nothing asks
// Firefox to describe every tab for a change to one, views follow what is shown, and
// the index of a key's tabs agrees with the tabs. How long it all takes in a real
// Firefox is measured by the smoke test (alone_many).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, realSleep, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const plain = value => JSON.parse(JSON.stringify(value));

async function start(ff, event = "onStartup") {
  const x = ff.boot();
  x.b.runtime[event].fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

async function alone(ff) {
  ff.managed = { tidierAlone: true };
  return start(ff);
}

// A sidebar that has said hello, and the views it was sent.
async function sidebar(x, windowId) {
  const listeners = [], gone = [], views = [];
  x.b.runtime.onConnect.fire({
    name: "sidebar", sender: { id: "tidier" }, postMessage: view => views.push(plain(view)),
    onMessage: { addListener: f => listeners.push(f) }, onDisconnect: { addListener: f => gone.push(f) },
  });
  listeners[0]({ type: "hello", windowId });
  await wait(200);
  return { views, close: () => gone.forEach(f => f()) };
}

// `n` synced tabs in one window, half in each of two spaces, with the first selected.
function manyTabs(ff, n, w = ff.addWindow({ focused: true })) {
  ff.store.syncedTabs = {};
  for (let i = 0; i < n; i++) {
    const cookieStoreId = i % 2 ? C2 : C1;
    ff.store.syncedTabs["k" + i] = entry(`https://a.example/${i}`, { cookieStoreId });
    ff.addTab(w.id, { url: `https://a.example/${i}`, active: i === 0, cookieStoreId }, { syncKey: "k" + i, syncRole: "live" });
  }
  return w;
}

// The questions the next `fn` asks about tabs.
async function queries(ff, fn) {
  const asked = [];
  ff.hooks.query = q => { asked.push(q); };
  await fn();
  delete ff.hooks.query;
  return asked;
}
const everyTab = q => !q.windowId && !q.active && !q.pinned && !q.hidden && !q.discarded && !q.cookieStoreId;
const wholeWindow = q => q.windowId && Object.keys(q).length === 1;

test("the index of a key's tabs agrees with the tabs, whatever happens to them", async () => {
  const ff = new FakeFirefox();
  ff.addWindow({ focused: true });
  const x = ff.boot();
  const keys = x.js("syncKeyByTab");
  const model = new Map();
  let seed = 7;
  const next = m => (seed = (seed * 31 + 11) % 1009) % m;
  for (let i = 0; i < 3000; i++) {
    const id = next(40), key = "k" + next(8);
    if (next(3)) { keys.set(id, key); model.set(id, key); } else { keys.delete(id); model.delete(id); }
    if (i % 100) continue;
    for (let k = 0; k < 8; k++) {
      const walk = [...model].filter(([, v]) => v === "k" + k).map(([t]) => t).sort((a, b) => a - b);
      assert.deepEqual([...keys.tabsOf("k" + k)].sort((a, b) => a - b), walk);
    }
    assert.deepEqual(plain([...keys].sort((a, b) => a[0] - b[0])), plain([...model].sort((a, b) => a[0] - b[0])));
  }
  keys.clear();
  assert.equal(keys.size, 0);
  assert.equal(keys.tabsOf("k1").length, 0);
  x.kill();
});

test("every way a key's tab appears or goes keeps the index right", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true }), other = ff.addWindow();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const live = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "a"), active: true, cookieStoreId: C1, discarded: true }, { syncKey: "a", syncRole: "ghost" });
  const x = await alone(ff);
  const tabs = () => [...x.js("syncKeyByTab").tabsOf("a")].sort((a, b) => a - b);
  assert.deepEqual(tabs(), [live.id, ghost.id]);
  assert.equal(x.js(`liveTabId("a")`), live.id);
  ff.rm(ghost.id);
  await wait(300);
  assert.ok(!tabs().includes(ghost.id), "a closed tab is out of the index");
  x.kill();
});

test("a view asks only for the tabs of the space it shows", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 40);
  const x = await alone(ff);
  const asked = await queries(ff, () => x.js("viewFor")(w.id));
  assert.ok(asked.length, "it does ask");
  assert.ok(!asked.some(q => everyTab(q) || wholeWindow(q)), JSON.stringify(asked));
  const view = await x.js("viewFor")(w.id);
  assert.equal(view.tabs.length, 20, "and it shows them all");
  assert.equal(view.space, C1);
  x.kill();
});

test("with declared spaces, or with the setting off, the bar still sees every tab of the window", async () => {
  for (const managed of [{ tidierAlone: true, spaces: [C1] }, {}]) {
    const ff = new FakeFirefox();
    const w = manyTabs(ff, 4);
    ff.managed = managed;
    const x = await start(ff);
    const view = await x.js("viewFor")(w.id);
    assert.deepEqual(plain(view.spaces.map(s => s.id)).sort(), [C1, C2], "a space in use is listed");
    x.kill();
  }
});

test("a space that no longer exists falls back to the selected tab's, also without a whole window", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  x.js("activeSpace").set(w.id, "firefox-container-9");
  assert.equal((await x.js("viewFor")(w.id)).space, C1);
  x.kill();
});

test("a new tab asks for no list of every tab", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 10), other = ff.addWindow();
  const x = await alone(ff);
  const asked = await queries(ff, async () => {
    const fresh = ff.addTab(w.id, { url: "https://new.example/", cookieStoreId: C1 });
    x.b.tabs.onCreated.fire(ff.snap(fresh));
    await wait(2500);
  });
  assert.ok(Object.values(ff.synced).some(e => e.url === "https://new.example/"), "it is synced");
  assert.ok(ff.list(other.id).length > 10, "and in the other window");
  assert.ok(!asked.some(everyTab), JSON.stringify(asked.filter(everyTab)));
  x.kill();
});

test("closing a tab everywhere asks for no list of every tab", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 10), other = ff.addWindow();
  const x = await alone(ff);
  const before = ff.list(other.id).length;
  const asked = await queries(ff, async () => {
    ff.rm(ff.list(w.id)[3].id);
    await wait(500);
  });
  assert.equal(ff.list(other.id).length, before - 1, "closed in the other window");
  assert.ok(!asked.some(everyTab), JSON.stringify(asked.filter(everyTab)));
  x.kill();
});

test("a window closing hands its tabs over without a list of every tab per tab", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 20), other = ff.addWindow();
  const x = await alone(ff);
  const asked = await queries(ff, async () => {
    for (const t of ff.list(w.id)) ff.rm(t.id, { closing: true });
    await wait(500);
  });
  assert.equal(asked.filter(everyTab).length, 0);
  const live = ff.list(other.id).filter(t => ff.values.get(t.id)?.syncRole === "live");
  assert.equal(live.length, 20, "every tab has a live tab again");
  x.kill();
});

test("with Tidier alone a placeholder is made without a page, an essential too, and pinned", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "Mail", icon: "https://e.example/i.png" }];
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await alone(ff);
  const copies = ff.list(other.id);
  assert.equal(copies.length, 3);
  for (const t of copies) assert.ok(t.discarded, `${t.url} is unloaded from the start`);
  const essential = copies.find(t => t.pinned);
  assert.equal(essential.title, "Mail");
  assert.equal(essential.url, GHOST("essential", "e"));
  assert.equal(copies.find(t => !t.pinned).title, "https://a.example/0");
  x.kill();
});

test("with the setting off a placeholder still loads its page, since Sidebery draws the tab", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await start(ff);
  const copies = ff.list(other.id);
  assert.equal(copies.length, 2);
  for (const t of copies) assert.ok(!t.discarded, `${t.url} is not made unloaded`);
  x.kill();
});

test("a placeholder's row takes its icon from the record, or the site's when that cannot be shown", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "Mail", icon: "page-icon:https://e.example/" }];
  ff.store.syncedTabs = {
    a: entry("https://a.example/x", { title: "A", icon: "https://a.example/a.png" }),
    b: entry("https://b.example/x", { title: "B", icon: "page-icon:https://b.example/x" }),
    c: entry("https://c.example/x", { title: "C" }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  const view = await x.js("viewFor")(w.id);
  const icons = Object.fromEntries(view.tabs.map(t => [t.title, t.icon]));
  assert.equal(icons.A, "https://a.example/a.png");
  assert.equal(icons.B, "https://b.example/favicon.ico");
  assert.equal(icons.C, "https://c.example/favicon.ico");
  assert.equal(view.essentials[0].icon, "https://e.example/favicon.ico");
  x.kill();
});

test("after moving back, placeholders without an icon load their page, once", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  ff.store.placeholdersNeedPages = true;
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  const bare = ff.addTab(other.id, { url: GHOST("ghost", "a"), discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await start(ff);
  assert.ok(ff.log.some(l => l[0] === "update-url" && l[1] === bare.id), "the placeholder loads");
  assert.equal(ff.store.placeholdersNeedPages, undefined, "and only this once");
  x.kill();
  ff.log.length = 0;
  ff.tabs.get(bare.id).discarded = true;
  const y = await start(ff);
  assert.ok(!ff.log.some(l => l[0] === "update-url"), "an ordinary start loads nothing");
  y.kill();
});

test("a page in another space builds no view, a page in this one does", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  await sidebar(x, w.id);
  await wait(300);
  const views = () => x.js("work.views");
  const away = ff.list(w.id).find(t => t.cookieStoreId === C2), here = ff.list(w.id).find(t => t.cookieStoreId === C1);
  let before = views();
  ff.tabs.get(away.id).title = "ticks";
  x.b.tabs.onUpdated.fire(away.id, { title: "ticks" }, ff.snap(ff.tabs.get(away.id)));
  await wait(400);
  assert.equal(views(), before, "nothing to draw");
  assert.equal((await x.js("getSynced")()).k1.title, "ticks", "while the record follows");
  before = views();
  ff.tabs.get(here.id).title = "changes";
  x.b.tabs.onUpdated.fire(here.id, { title: "changes" }, ff.snap(ff.tabs.get(here.id)));
  await wait(400);
  assert.ok(views() > before, "drawn");
  x.kill();
});

test("every other sidebar showing a space follows a title from another window", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await alone(ff);
  const there = await sidebar(x, other.id);
  await wait(300);
  const live = ff.list(w.id).find(t => t.cookieStoreId === C1);
  ff.tabs.get(live.id).title = "New title";
  x.b.tabs.onUpdated.fire(live.id, { title: "New title" }, ff.snap(ff.tabs.get(live.id)));
  await wait(400);
  assert.ok(there.views.at(-1).tabs.some(t => t.title === "New title"), JSON.stringify(there.views.at(-1).tabs));
  x.kill();
});

test("views are built one at a time, and the last one sent is the newest", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 6);
  const x = await alone(ff);
  const bar = await sidebar(x, w.id);
  await wait(300);
  let building = 0, most = 0, slowOnce = true;
  ff.hooks.query = async q => {
    if (!q.cookieStoreId || q.hidden !== undefined) return;
    building++; most = Math.max(most, building);
    // The first takes long, so that the ones after it would overtake it.
    await realSleep(slowOnce ? (slowOnce = false, 30) : 1);
    building--;
  };
  const here = ff.list(w.id).find(t => t.cookieStoreId === C1);
  for (let i = 0; i < 6; i++) {
    ff.tabs.get(here.id).title = "Title " + i;
    x.b.tabs.onUpdated.fire(here.id, { title: "Title " + i }, ff.snap(ff.tabs.get(here.id)));
    await realSleep(6);
  }
  await realSleep(200); // a slow view is followed by a rest in proportion
  delete ff.hooks.query;
  assert.equal(most, 1);
  assert.ok(bar.views.at(-1).tabs.some(t => t.title === "Title 5"), JSON.stringify(bar.views.at(-1).tabs));
  x.kill();
});

test("a long burst of events still shows, and does not build a view per event", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 6);
  const x = await alone(ff);
  await sidebar(x, w.id);
  await wait(300);
  const before = x.js("work.views");
  const here = ff.list(w.id).find(t => t.cookieStoreId === C1);
  const end = performance.now() + 40; // in the scripts' time: 4 s, with hardly a pause in it
  let events = 0;
  while (performance.now() < end) {
    x.b.tabs.onUpdated.fire(here.id, { audible: true }, ff.snap(ff.tabs.get(here.id)));
    events++;
    await new Promise(setImmediate);
  }
  const built = x.js("work.views") - before;
  assert.ok(built >= 2, `shown along the way (${built})`);
  assert.ok(built < events / 5, `${built} views for ${events} events`);
  x.kill();
});

test("a sidebar that closes leaves nothing behind, also in the middle of a view", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2);
  const x = await alone(ff);
  const bar = await sidebar(x, w.id);
  x.js("viewSoon")(w.id);
  bar.close();
  await wait(300);
  for (const name of ["sidebarPorts", "viewTimers", "viewRest", "viewsBuilding"]) assert.equal(x.js(name).size, 0, name);
  x.kill();
});

test("a window with no sidebar builds no views", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  const before = x.js("work.views");
  const t = ff.list(w.id)[0];
  x.b.tabs.onUpdated.fire(t.id, { title: "x" }, ff.snap(ff.tabs.get(t.id)));
  x.b.tabs.onMoved.fire(t.id, { windowId: w.id, fromIndex: 0, toIndex: 1 });
  await wait(300);
  assert.equal(x.js("work.views"), before);
  x.kill();
});

test("closing many tabs looks at Recently Closed far less than once per tab, and forgets every placeholder", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 40), other = ff.addWindow();
  const x = await alone(ff);
  const keys = Object.keys(ff.synced);
  let looks = 0;
  ff.recentlyClosed = keys.map((k, i) => ({ tab: { url: GHOST("ghost", k), windowId: other.id, sessionId: "s" + i } }));
  const read = x.b.sessions.getRecentlyClosed;
  x.b.sessions.getRecentlyClosed = async () => { looks++; await realSleep(1); return read(); };
  for (const t of ff.list(w.id)) { ff.rm(t.id); x.b.sessions.onChanged.fire(); }
  for (let i = 0; i < 200 && Object.keys(ff.synced).length; i++) await wait(100);
  assert.equal(Object.keys(ff.synced).length, 0);
  await realSleep(100); // the last look comes after a rest
  assert.equal(ff.recentlyClosed.length, 0, "no placeholder is left there");
  assert.ok(looks < keys.length / 2, `${looks} looks for ${keys.length} tabs`);
  x.kill();
});

test("a placeholder that reaches Recently Closed late is still forgotten, during a rest too", async () => {
  const ff = new FakeFirefox();
  ff.addWindow({ focused: true });
  const x = ff.boot();
  const read = x.b.sessions.getRecentlyClosed;
  x.b.sessions.getRecentlyClosed = async () => { await realSleep(3); return read(); };
  x.js("forgetClosedPlaceholders")("ghost", ["late"]);
  await realSleep(10); // the first look is done and resting
  ff.recentlyClosed = [{ tab: { url: GHOST("ghost", "late"), windowId: 1, sessionId: "s" } }];
  x.b.sessions.onChanged.fire();
  await realSleep(100);
  assert.equal(ff.recentlyClosed.length, 0);
  x.kill();
});

test("a placeholder with &placed= in its address is forgotten too", async () => {
  const ff = new FakeFirefox();
  ff.addWindow({ focused: true });
  const x = ff.boot();
  ff.recentlyClosed = [{ tab: { url: GHOST("essential", "e") + "&placed=3", windowId: 1, sessionId: "s" } }, { tab: { url: "https://keep.example/", windowId: 1, sessionId: "r" } }];
  x.js("forgetClosedPlaceholders")("essential", ["e"]);
  await wait(100);
  assert.deepEqual(ff.recentlyClosed.map(c => c.tab.sessionId), ["r"]);
  x.kill();
});

test("the order of a window is looked at in bursts, and is right after them", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 5);
  const x = await alone(ff);
  await wait(300);
  let looks = 0;
  ff.hooks.query = async q => { if (wholeWindow(q)) { looks++; await realSleep(2); } };
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 });
    x.b.tabs.onCreated.fire(ff.snap(last));
    await realSleep(0.2);
  }
  await wait(1500);
  delete ff.hooks.query;
  assert.ok(looks < 15, `${looks} looks for 40 tabs`);
  assert.equal(x.js("lastOrder").get(w.id).at(-1).id, last.id, "the last tab is known");
  assert.equal(x.js("orderQueries").size, 0);
  x.kill();
});

test("a window that has gone is not kept in the order, also if a look comes late", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await alone(ff);
  await wait(300);
  x.js("noteOrder")(other.id);
  for (const t of ff.list(other.id)) ff.rm(t.id, { closing: true });
  ff.wins.delete(other.id);
  x.b.windows.onRemoved.fire(other.id);
  x.js("noteOrder")(other.id);
  await wait(300);
  assert.ok(!x.js("lastOrder").has(other.id));
  x.kill();
});

test("a tab event with Tidier alone schedules no work that only Sidebery needs", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  const t = ff.list(w.id)[1];
  const asked = await queries(ff, async () => {
    x.b.tabs.onMoved.fire(t.id, { windowId: w.id, fromIndex: 1, toIndex: 2 });
    await wait(600);
  });
  // The window's order is looked at once, for placing a closed tab, and nothing else.
  assert.ok(asked.filter(wholeWindow).length <= 1, JSON.stringify(asked));
  assert.equal(x.js("foldersTimers").size, 0);
  x.kill();
});
