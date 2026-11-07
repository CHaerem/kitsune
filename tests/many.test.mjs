// What keeps Tidier light with many tabs, on its real background scripts: nothing asks
// Firefox to describe every tab for a change to one, views follow what is shown, and
// the index of a key's tabs agrees with the tabs. How long it all takes in a real
// Firefox is measured by the smoke test (alone_many).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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

// The tests below wait for a state, not for a time: the machine may be busy.
async function until(test, ms = 5000) {
  for (const end = performance.now() + ms; performance.now() < end && !test();) await realSleep(1);
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
// (Asking for the tabs that play or are muted is not every tab: Firefox describes only those,
// and the sidebar shows where sound comes from, sounds.js.)
const everyTab = q => !q.windowId && !q.active && !q.pinned && !q.hidden && !q.discarded && !q.cookieStoreId && !q.audible && !q.muted;
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

test("a start with Tidier alone reads each tab's values once", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 5);
  const read = new Map();
  ff.hooks.getTabValue = (id, name) => { if (name === "syncKey") read.set(id, (read.get(id) || 0) + 1); };
  const x = await alone(ff);
  delete ff.hooks.getTabValue;
  assert.deepEqual([...read.values()], ff.list(w.id).map(() => 1));
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

// The record's icon follows the page's site (keptIcon, tabsync.js): Firefox drops a tab's
// icon as a new page comes in, and on the same site the record's is still right.
test("a loaded page shows an icon of its own, else the record's for its site; an unloaded one the record's", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    a: entry("https://new.example/", { title: "Loaded", icon: "https://new.example/i.png" }),
    b: entry("https://b.example/", { title: "Own icon", icon: "https://b.example/old.png" }),
    c: entry("https://c.example/", { title: "Unloaded", icon: "https://c.example/i.png" }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://new.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", favIconUrl: "https://b.example/new.png", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  ff.addTab(w.id, { url: "https://c.example/", discarded: true, cookieStoreId: C1 }, { syncKey: "c", syncRole: "live" });
  const x = await alone(ff);
  const icons = Object.fromEntries((await x.js("viewFor")(w.id)).tabs.map(t => [t.title, t.icon]));
  assert.equal(icons.Loaded, "https://new.example/i.png");
  assert.equal(icons["Own icon"], "https://b.example/new.png");
  assert.equal(icons.Unloaded, "https://c.example/i.png");
  x.kill();
});

test("an address in the record that cannot be read does not stop the sidebar, and a login in one is not sent for its icon", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    bad: entry("http://", { title: "Bad", cookieStoreId: C1 }),
    login: entry("https://me:secret@c.example/x", { title: "Login" }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  ff.addTab(w.id, { url: GHOST("ghost", "bad"), discarded: true, cookieStoreId: C1 }, { syncKey: "bad", syncRole: "ghost" });
  ff.addTab(w.id, { url: GHOST("ghost", "login"), discarded: true, cookieStoreId: C1 }, { syncKey: "login", syncRole: "ghost" });
  const x = await alone(ff);
  const icons = Object.fromEntries((await x.js("viewFor")(w.id)).tabs.map(t => [t.title, t.icon]));
  assert.equal(icons.Bad, null);
  assert.equal(icons.Login, "https://c.example/favicon.ico");
  x.kill();
});

// The sidebar's own script, with just enough of a page around it.
function sidebarPage() {
  const element = () => ({ dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, append() {}, replaceWith() {}, replaceChildren() {} });
  const ctx = vm.createContext({
    browser: { runtime: { connect: () => ({ onMessage: { addListener() {} }, postMessage() {} }) }, windows: { getCurrent: async () => ({ id: 1 }) }, storage: { managed: { get: async () => ({}) } } },
    document: { createElement: element, getElementById: element, documentElement: element(), head: element(), addEventListener() {} },
    addEventListener() {},
  });
  vm.runInContext(readFileSync(new URL("../sidebar/sidebar.js", import.meta.url), "utf8"), ctx);
  return code => vm.runInContext(code, ctx);
}

test("the sidebar asks for an icon only near the view, once, and what it remembers does not grow", () => {
  const page = sidebarPage(), icon = page("icon");
  const first = icon({ icon: "https://a.example/i.png", title: "A" });
  assert.equal(first.loading, "lazy", "not seen yet: only near the view");
  first.onload();
  assert.equal(icon({ icon: "https://a.example/i.png", title: "A" }).loading, undefined, "loaded: at once, so it does not blink");
  icon({ icon: "https://b.example/i.png", title: "B" }).onerror();
  assert.equal(icon({ icon: "https://b.example/i.png", title: "B" }).className, "letter", "failed: not asked for at every draw");
  const now = Date.now(), clock = page("Date");
  clock.now = () => now + 6 * 60000;
  assert.equal(icon({ icon: "https://b.example/i.png", title: "B" }).loading, "lazy", "but asked for again at a draw after a while: it may have been the network");
  clock.now = () => now;

  // A page that draws a counter as its icon, all day.
  const data = n => `data:image/png;base64,${n}`;
  assert.equal(icon({ icon: data(0), title: "C" }).loading, undefined, "a data: address asks nobody");
  for (let n = 0; n < 3000; n++) icon({ icon: data(n), title: "C" }).onload();
  assert.equal(page("iconsLoaded.size"), 1, "and is not remembered");
  for (let n = 0; n < 3000; n++) icon({ icon: data(n), title: "C" }).onerror();
  assert.equal(page("iconsFailed.size"), 1);

  for (let n = 0; n < 3000; n++) icon({ icon: `https://c.example/${n}.png`, title: "C" }).onload();
  assert.ok(page("iconsLoaded.size") <= 1000, String(page("iconsLoaded.size")));
  for (let n = 0; n < 3000; n++) icon({ icon: `https://d.example/${n}.png`, title: "D" }).onerror();
  assert.ok(page("iconsFailed.size") <= 1000, String(page("iconsFailed.size")));
});

test("after moving back, placeholders without an icon load their page, once", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  ff.store.placeholdersNeedPages = true;
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const other = ff.addWindow();
  // (With its title: one without is loaded once to get it back, titlesBack.)
  const bare = ff.addTab(other.id, { url: GHOST("ghost", "a"), discarded: true, cookieStoreId: C1, title: "A" }, { syncKey: "a", syncRole: "ghost" });
  const x = await start(ff);
  assert.ok(ff.log.some(l => l[0] === "update-url" && l[1] === bare.id), "the placeholder loads");
  assert.equal(ff.store.placeholdersNeedPages, undefined, "and only this once");
  x.kill();
  ff.log.length = 0;
  Object.assign(ff.tabs.get(bare.id), { discarded: true, title: "A" }); // unloaded again by its page, with the title it set
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
  await until(() => views() > before);
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
  await until(() => there.views.at(-1).tabs.some(t => t.title === "New title"));
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
  await until(() => bar.views.at(-1).tabs.some(t => t.title === "Title 5")); // a slow view is followed by a rest in proportion
  delete ff.hooks.query;
  assert.equal(most, 1);
  assert.ok(bar.views.at(-1).tabs.some(t => t.title === "Title 5"), JSON.stringify(bar.views.at(-1).tabs));
  x.kill();
});

test("a view Firefox never answers for does not leave the sidebar frozen", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  const bar = await sidebar(x, w.id);
  await wait(300);
  const never = new Promise(() => {});
  ff.hooks.query = q => (q.cookieStoreId && q.hidden === undefined ? never : undefined);
  const here = ff.list(w.id).find(t => t.cookieStoreId === C1);
  const change = title => { ff.tabs.get(here.id).title = title; x.b.tabs.onUpdated.fire(here.id, { title }, ff.snap(ff.tabs.get(here.id))); };
  change("Stuck");
  await wait(500);
  assert.equal(x.js("viewsBuilding").size, 1, "that view hangs");
  delete ff.hooks.query;
  await wait(16000); // past VIEW_STUCK_MS
  change("Back");
  await until(() => bar.views.at(-1).tabs.some(t => t.title === "Back"));
  assert.ok(bar.views.at(-1).tabs.some(t => t.title === "Back"), "the next one comes through");
  assert.equal(x.js("viewsBuilding").size, 0);
  x.kill();
});

test("the wait for a view: a pause in events, a limit in a long burst, and a rest after a slow one", () => {
  const ff = new FakeFirefox();
  ff.addWindow({ focused: true });
  const x = ff.boot();
  const wait = x.js("viewWait");
  assert.equal(wait(1000, 1000, 0), 30, "the first event: a pause");
  assert.equal(wait(1100, 1000, 0), 30, "another one starts the pause again");
  assert.equal(wait(1240, 1000, 0), 10, "until the limit since the first");
  assert.equal(wait(1300, 1000, 0), 0, "past it, at once");
  assert.equal(wait(1000, 1000, 1500), 500, "after a slow view, its rest");
  x.kill();
});

test("a slow view is followed by a rest, but not by a long one: what you just did must show", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  await sidebar(x, w.id);
  await wait(300);
  const rests = [], rest = x.js("viewRest"), set = rest.set.bind(rest);
  rest.set = (id, until) => { rests.push(until - x.js("performance.now()")); return set(id, until); };
  ff.hooks.query = async q => { if (q.cookieStoreId && q.hidden === undefined) await realSleep(30); }; // Firefox is busy: 3 s in the scripts' time
  x.js("viewSoon")(w.id);
  await until(() => rests.length);
  delete ff.hooks.query;
  assert.ok(rests[0] > 0 && rests[0] <= 1000, String(rests));
  x.kill();
});

test("events that keep coming do not put off a view that is due", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  await sidebar(x, w.id);
  await until(() => x.js("work.views") && !x.js("viewsBuilding").size && !x.js("viewTimers").size); // the sidebar's first view is done
  const timers = x.js("viewTimers"), viewSoon = x.js("viewSoon");
  x.js("viewRest").set(w.id, x.js("performance.now()") + 1e6); // so that it is still waiting when the next event comes
  viewSoon(w.id);
  const waiting = timers.get(w.id);
  viewSoon(w.id);
  assert.notEqual(timers.get(w.id), undefined);
  await wait(300); // past VIEW_LONGEST_WAIT_MS
  const due = timers.get(w.id);
  assert.equal(due.first, waiting.first);
  viewSoon(w.id);
  assert.equal(timers.get(w.id), due, "the same timer: another would start over");
  x.kill();
});

test("a long burst of events still shows", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 6);
  const x = await alone(ff);
  await sidebar(x, w.id);
  await wait(300);
  const before = x.js("work.views");
  const here = ff.list(w.id).find(t => t.cookieStoreId === C1);
  for (let i = 0; i < 20000 && x.js("work.views") - before < 3; i++) {
    x.b.tabs.onUpdated.fire(here.id, { audible: true }, ff.snap(ff.tabs.get(here.id)));
    await new Promise(setImmediate);
  }
  assert.ok(x.js("work.views") - before >= 3);
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

test("a sidebar that closes while Firefox does not answer for its view leaves nothing behind", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2);
  const x = await alone(ff);
  const bar = await sidebar(x, w.id);
  await wait(300);
  ff.hooks.query = q => (q.cookieStoreId && q.hidden === undefined ? new Promise(() => {}) : undefined);
  x.js("viewSoon")(w.id);
  await until(() => x.js("viewsBuilding").size);
  assert.equal(x.js("viewsBuilding").size, 1);
  bar.close();
  assert.equal(x.js("viewsBuilding").size, 0);
  delete ff.hooks.query;
  x.kill();
});

test("tabs hidden at a switch of space wake nothing, and a switch asks only for the tabs that may change", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 6);
  const x = await alone(ff);
  await sidebar(x, w.id);
  await wait(300);
  const views = x.js("work.views"), jobs = x.js("work.jobs");
  for (const t of ff.list(w.id)) x.b.tabs.onUpdated.fire(t.id, { hidden: true }, t);
  await wait(400);
  assert.equal(x.js("work.views"), views);
  assert.equal(x.js("work.jobs"), jobs);
  const asked = await queries(ff, () => x.js("showSpace")(w.id));
  assert.ok(asked.length, "it does ask");
  assert.ok(!asked.some(q => wholeWindow(q) || (q.hidden === true && !q.cookieStoreId)), JSON.stringify(asked));
  // Firefox sends a message per listener and per tab: with hundreds of tabs hidden one by
  // one, a listener without a filter costs that much at every switch, and has nothing to do.
  const woken = x.b.tabs.onUpdated.ls.filter(({ filter }) => !filter?.properties || filter.properties.includes("hidden"));
  assert.deepEqual(woken.map(l => l.f.toString().slice(0, 80)), []);
  x.kill();
});

test("a tab pinned while it is being taken into tab sync stays out of it", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await alone(ff);
  const before = ff.list(other.id).length;
  const fresh = ff.addTab(w.id, { url: "https://new.example/", cookieStoreId: C1 });
  // Pinned between the first look at the tab and the moment it gets its key.
  const look = x.b.windows.get;
  x.b.windows.get = async id => {
    x.b.windows.get = look;
    fresh.pinned = true;
    x.b.tabs.onUpdated.fire(fresh.id, { pinned: true }, ff.snap(fresh));
    return look(id);
  };
  await x.js("serial")(() => x.js("register")(fresh.id));
  assert.equal(x.js("syncKeyByTab").get(fresh.id), undefined, "it has no key");
  assert.equal(ff.values.get(fresh.id)?.syncKey, undefined, "nor one stored with the tab");
  assert.equal(ff.list(other.id).filter(t => !t.pinned).length, before, "and no ghost elsewhere");
  x.kill();
});

test("what tab sync's filter on tab changes must let through", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await alone(ff);
  const live = ff.list(w.id)[0];
  ff.tabs.get(live.id).pinned = true;
  x.b.tabs.onUpdated.fire(live.id, { pinned: true }, ff.snap(ff.tabs.get(live.id)));
  await x.js("serial")(() => {});
  assert.equal((await x.js("getSynced")()).k0, undefined, "a tab pinned leaves tab sync");
  const fresh = ff.addTab(w.id, { url: "https://new.example/", cookieStoreId: C1 });
  x.b.tabs.onUpdated.fire(fresh.id, { status: "complete" }, ff.snap(fresh));
  assert.ok(x.js("pending").has(fresh.id), "a new tab that has loaded a page is taken in");
  assert.ok(ff.list(other.id).length, "(and the other window is still there)");
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
  await until(() => !Object.keys(ff.synced).length);
  assert.equal(Object.keys(ff.synced).length, 0);
  await until(() => !ff.recentlyClosed.length); // the last look comes after a rest
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
  await until(() => !ff.recentlyClosed.length);
  assert.equal(ff.recentlyClosed.length, 0);
  x.kill();
});

test("the rests after a look at Recently Closed and at a window's order are in proportion, with a limit", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2);
  const x = await alone(ff);
  // Every delay asked for from the moment a look is done.
  const delays = [], set = x.ctx.setTimeout;
  x.ctx.setTimeout = (f, ms, ...a) => { delays.push(ms); return set(f, ms, ...a); };
  const read = x.b.sessions.getRecentlyClosed;
  x.b.sessions.getRecentlyClosed = async () => { await realSleep(30); delays.length = 0; return read(); }; // 3 s in the scripts' time
  x.js("forgetClosedPlaceholders")("ghost", ["k"]);
  delays.length = 0; // (the timer that empties the list once it is all over)
  await until(() => delays.length);
  assert.ok(delays.length && delays.every(ms => ms > 0 && ms <= 1000), `after a slow look at Recently Closed: ${delays}`);
  x.b.sessions.getRecentlyClosed = read;
  delays.length = 0;
  ff.hooks.query = async () => { await realSleep(30); delays.length = 0; };
  x.js("noteOrder")(w.id);
  x.js("noteOrder")(w.id); // changed during the look: another one follows
  await until(() => delays.length);
  delete ff.hooks.query;
  assert.ok(delays.length && delays.every(ms => ms > 0 && ms <= 1000), `after a slow look at the order: ${delays}`);
  x.kill();
});

test("a pull request never opened leaves no placeholder in Recently Closed", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2);
  const x = await alone(ff);
  ff.recentlyClosed = [{ tab: { url: GHOST("lazy", "k0"), windowId: w.id, sessionId: "s" } }, { tab: { url: "https://keep.example/", windowId: w.id, sessionId: "r" } }];
  await x.js("serial")(() => x.js("closeEverywhere")("k0", { dismiss: false }));
  await until(() => ff.recentlyClosed.length === 1);
  assert.deepEqual(ff.recentlyClosed.map(c => c.tab.sessionId), ["r"]);
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
  await until(() => !x.js("orderQueries").size);
  delete ff.hooks.query;
  assert.ok(looks < 20, `${looks} looks for 40 tabs`);
  assert.equal(x.js("lastOrder").get(w.id).at(-1).id, last.id, "the last tab is known");
  assert.equal(x.js("orderQueries").size, 0);
  x.kill();
});

test("a rest follows every look at a window's order, also if nothing changed during the look", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2);
  const x = await alone(ff);
  await until(() => !x.js("orderQueries").size);
  // The order's rests wait for this test; other timers run as usual.
  const rests = [], set = x.ctx.setTimeout;
  x.ctx.setTimeout = (f, ms, ...a) => (String(f).includes("orderQueries") ? rests.push(f) : set(f, ms, ...a));
  const looks = () => x.js("work.lookups"), first = looks(), noteOrder = x.js("noteOrder");
  noteOrder(w.id);
  await until(() => rests.length);
  assert.equal(rests.length, 1, "the look is over, and nothing changed during it: a rest all the same");
  assert.equal(looks(), first + 1);
  noteOrder(w.id);
  noteOrder(w.id);
  assert.equal(looks(), first + 1, "what changes during the rest waits for it");
  rests.shift()();
  assert.equal(looks(), first + 2, "and is looked at after it, once");
  await until(() => rests.length);
  rests.shift()();
  assert.equal(looks(), first + 2, "with nothing changed since, nothing more");
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

test("a page closed while its placeholders wait to be refreshed leaves no timer behind", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await alone(ff);
  const live = ff.list(w.id)[0];
  ff.tabs.get(live.id).title = "New title";
  x.b.tabs.onUpdated.fire(live.id, { title: "New title" }, ff.snap(ff.tabs.get(live.id)));
  await wait(100);
  assert.equal(x.js("refreshTimers").size, 1, "a refresh is on its way");
  ff.rm(live.id);
  await wait(2000); // closing it, and what selecting another tab does
  assert.equal(x.js("refreshTimers").size, 0);
  const before = x.js("work.jobs");
  await wait(4000); // the refresh would have come 3 s after the title
  assert.equal(x.js("work.jobs"), before, "nothing comes later");
  assert.equal(x.js("lastRefresh").size, 0);
  x.kill();
});

test("a page closed while its refresh waits in the queue leaves nothing behind", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 2), other = ff.addWindow();
  const x = await alone(ff);
  const live = ff.list(w.id)[0], serial = x.js("serial");
  x.js("refreshGhostsSoon")("k0");
  let release;
  serial(() => new Promise(r => { release = r; })); // the queue is busy,
  ff.rm(live.id); // the close waits there,
  await wait(4000); // and the refresh comes in after it
  assert.equal(x.js("refreshTimers").size, 1);
  release();
  await until(() => !x.js("refreshTimers").size);
  await serial(() => {});
  assert.equal(x.js("lastRefresh").size, 0);
  assert.ok(!ff.list(other.id).some(t => x.js("syncKeyByTab").get(t.id) === "k0"), "it is closed everywhere");
  x.kill();
});

test("back in a space, the tab you used there is selected, not a placeholder made since", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true }), other = ff.addWindow();
  ff.store.syncedTabs = { used: entry("https://used.example/"), since: entry("https://since.example/") };
  ff.addTab(w.id, { url: "https://away.example/", active: true, cookieStoreId: C2 });
  const used = ff.addTab(w.id, { url: "https://used.example/", cookieStoreId: C1, lastAccessed: 1000 }, { syncKey: "used", syncRole: "live" });
  ff.addTab(w.id, { url: GHOST("ghost", "since"), discarded: true, cookieStoreId: C1, lastAccessed: 2000 }, { syncKey: "since", syncRole: "ghost" });
  ff.addTab(other.id, { url: "https://since.example/", active: true, cookieStoreId: C1 }, { syncKey: "since", syncRole: "live" });
  const x = await alone(ff);
  assert.equal((await x.js("lastUsedIn")(w.id, C1)).id, used.id);
  x.kill();
});

test("a window closed while it is filled stops the filling, and is no error", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [1, 2, 3, 4].map(n => ({ key: "e" + n, url: `https://e${n}.example/`, cookieStoreId: C1, title: "E" }));
  const w = manyTabs(ff, 12);
  const x = await alone(ff);
  const errors = x.js("work.errors");
  for (const after of [2, 7]) { // among the essentials, and among the tabs
    const other = ff.addWindow();
    const create = x.b.tabs.create;
    let asked = 0;
    x.b.tabs.create = async p => {
      if (++asked === after) ff.wins.delete(other.id);
      return create(p);
    };
    await x.js("serial")(() => x.js("fillWindow")(other.id, { fresh: true }));
    x.b.tabs.create = create;
    assert.ok(asked <= after + 1, `${asked} asked for after ${after} (the tabs come after the essentials, and find out once)`);
    assert.equal(x.js("work.errors"), errors, "and it is no error");
  }
  assert.equal(ff.list(w.id).length, 16, "the window that is still there has all its tabs");
  x.kill();
});

test("a tab refused in a window that is still there is an error, and the others still come", async () => {
  const ff = new FakeFirefox();
  manyTabs(ff, 4);
  const x = await alone(ff);
  const errors = x.js("work.errors"), other = ff.addWindow();
  const create = x.b.tabs.create;
  let asked = 0;
  x.b.tabs.create = async p => { if (++asked === 2) throw new Error("refused"); return create(p); };
  await x.js("serial")(() => x.js("fillWindow")(other.id));
  x.b.tabs.create = create;
  assert.equal(x.js("work.errors"), errors + 1);
  assert.equal(ff.list(other.id).length, 3);
  x.kill();
});

test("a space with only placeholders goes back to the newest of them", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/") };
  ff.addTab(w.id, { url: "https://away.example/", active: true, cookieStoreId: C2 });
  ff.addTab(w.id, { url: GHOST("ghost", "a"), discarded: true, cookieStoreId: C1, lastAccessed: 1000 }, { syncKey: "a", syncRole: "ghost" });
  const newest = ff.addTab(w.id, { url: GHOST("ghost", "b"), discarded: true, cookieStoreId: C1, lastAccessed: 2000 }, { syncKey: "b", syncRole: "ghost" });
  const x = await alone(ff);
  assert.equal((await x.js("lastUsedIn")(w.id, C1)).id, newest.id);
  x.kill();
});

test("a tab gone when Tidier looks over its record is not remembered for a refresh", async () => {
  const ff = new FakeFirefox();
  manyTabs(ff, 2);
  const x = await alone(ff);
  const all = await x.js("getSynced")();
  all.gone = entry("https://gone.example/");
  x.js("lastRefresh").set("gone", 1);
  // (Only right after Firefox starts is a tab with no copy taken for closed: chaos test.)
  await x.js("serial")(() => x.js("reconcileAll")({ firefoxStart: true }));
  assert.equal(all.gone, undefined);
  assert.equal(x.js("lastRefresh").size, 0);
  x.kill();
});

test("a tab event with Tidier alone schedules no work that only Sidebery needs", async () => {
  const ff = new FakeFirefox();
  const w = manyTabs(ff, 4);
  const x = await alone(ff);
  const t = ff.list(w.id)[1];
  const jobs = x.js("work.jobs");
  const asked = await queries(ff, async () => {
    x.b.tabs.onMoved.fire(t.id, { windowId: w.id, fromIndex: 1, toIndex: 2 });
    await wait(600);
  });
  // The window's order is looked at once, for placing a closed tab, and nothing else.
  assert.ok(asked.filter(wholeWindow).length <= 1, JSON.stringify(asked));
  // One job at most: with Tidier alone, the look at which tab comes after the selected one
  // (successorSoon, spaces.js) follows a move. Sidebery's own work would be more.
  assert.ok(x.js("work.jobs") - jobs <= 1, "nor is anything else queued");
  assert.equal(x.js("movedTabs").size, 0);
  assert.equal(x.js("foldersTimers").size, 0);
  x.kill();
});
