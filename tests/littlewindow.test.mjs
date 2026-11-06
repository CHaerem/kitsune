// The small window for links from other apps (littlewindow.js), on the fake Firefox.
// What a real Firefox does with such a link is measured in the smoke test
// (alone_little_window); the fake only plays back what was seen there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2", NONE = "firefox-default";
const LINK = "https://link.example/page";

// What the fake has no need of elsewhere: windows that can be opened, popups that close
// with their last tab, window values that are kept.
function withWindows(ff, x) {
  const { b } = x;
  const geometry = w => ({ left: w.left ?? 100, top: w.top ?? 50, width: w.width ?? 1600, height: w.height ?? 1000 });
  const closeIfEmpty = id => {
    const w = ff.wins.get(id);
    if (!w || w.order.length) return;
    ff.wins.delete(id);
    b.windows.onRemoved.fire(id);
  };
  const info = w => ({ id: w.id, type: w.type, incognito: w.incognito, focused: ff.focused === w.id, ...geometry(w) });
  b.windows.getAll = async ({ windowTypes } = {}) => [...ff.wins.values()].filter(w => !windowTypes || windowTypes.includes(w.type)).map(info);
  b.windows.get = async id => { const w = ff.wins.get(id); if (!w) throw new Error(`Invalid window ID: ${id}`); return info(w); };
  b.windows.create = async p => {
    if (ff.refuseWindows) throw new Error("refused");
    if (p.cookieStoreId && !ff.containers.has(p.cookieStoreId)) throw new Error(`No cookie store exists with ID ${p.cookieStoreId}`);
    const w = ff.addWindow({ type: p.type ?? "normal" });
    Object.assign(w, { left: p.left, top: p.top, width: p.width, height: p.height, titlePreface: p.titlePreface });
    ff.log.push(["window", w.id, w.type, p.tabId ?? p.url]);
    b.windows.onCreated.fire(info(w));
    let tab;
    if (p.tabId) {
      tab = ff.tabs.get(p.tabId);
      const from = tab.windowId, i = ff.wins.get(from).order.indexOf(tab.id);
      ff.wins.get(from).order.splice(i, 1);
      b.tabs.onDetached.fire(tab.id, { oldWindowId: from, oldPosition: i });
      tab.windowId = w.id; w.order.push(tab.id);
      b.tabs.onAttached.fire(tab.id, { newWindowId: w.id, newPosition: 0 });
      closeIfEmpty(from);
    } else {
      tab = ff.addTab(w.id, { url: p.url, title: p.url, cookieStoreId: p.cookieStoreId ?? NONE, active: true });
      b.tabs.onCreated.fire(ff.snap(tab));
    }
    ff.focused = w.id;
    b.windows.onFocusChanged.fire(w.id);
    return { ...info(w), tabs: [ff.snap(tab)] };
  };
  b.windows.update = async (id, p) => {
    const w = ff.wins.get(id);
    if (p.titlePreface !== undefined) w.titlePreface = p.titlePreface;
    if (p.focused) { ff.focused = id; b.windows.onFocusChanged.fire(id); }
  };
  const move = b.tabs.move, remove = b.tabs.remove;
  b.tabs.move = async (id, p) => { const from = ff.tabs.get(id).windowId; const r = await move(id, p); closeIfEmpty(from); return r; };
  b.tabs.remove = async ids => {
    const from = [ids].flat().map(id => ff.tabs.get(id)?.windowId);
    await remove(ids);
    from.forEach(closeIfEmpty);
  };
  ff.winValues ??= new Map();
  b.sessions.setWindowValue = async (id, k, v) => { ff.winValues.set(`${id}/${k}`, v); };
  b.sessions.getWindowValue = async (id, k) => ff.winValues.get(`${id}/${k}`);
  b.menus.update = async (id, p) => { (ff.menuUpdates ??= []).push([id, p]); };
  return x;
}

async function start(ff) {
  ff.store.tidierAlone ??= true;
  const x = withWindows(ff, ff.boot());
  x.b.runtime.onStartup.fire();
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// One window in the first space, with a tab you are on and a second, older one.
function session(ff) {
  const w = ff.addWindow({ focused: true });
  const on = ff.addTab(w.id, { url: "https://here.example/", title: "Here", active: true, cookieStoreId: C1 }, { syncKey: "here", syncRole: "live" });
  const old = ff.addTab(w.id, { url: "https://old.example/", title: "Old", cookieStoreId: C1 }, { syncKey: "old", syncRole: "live" });
  ff.store.syncedTabs = {
    here: { url: on.url, title: on.title, cookieStoreId: C1, parentKey: null, group: false, added: 1 },
    old: { url: old.url, title: old.title, cookieStoreId: C1, parentKey: null, group: false, added: 1 },
  };
  return { w, on, old };
}

// What a real Firefox does with a link from another app: a new tab on about:blank in
// the selected tab's container, the first about:blank ended early, then the address.
function linkFromOutside(ff, x, windowId, { url = LINK, container = C1, marked = true } = {}) {
  for (const id of ff.wins.get(windowId).order) ff.tabs.get(id).active = false;
  const t = ff.addTab(windowId, { url: "about:blank", title: url, cookieStoreId: container, active: true });
  x.b.tabs.onCreated.fire(ff.snap(t));
  if (marked) x.b.tabs.onUpdated.fire(t.id, { status: "complete", url: "about:blank" }, ff.snap(t));
  ff.navigate(t.id, url);
  return t;
}

const popups = ff => [...ff.wins.values()].filter(w => w.type === "popup");
const tabOf = w => w.order[0];

test("a link from another app moves into a small window: same tab, not loaded again", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  const [small] = popups(ff);
  assert.ok(small, "a small window");
  assert.equal(tabOf(small), t.id);
  assert.equal(ff.tabs.get(t.id).cookieStoreId, C1);
  assert.deepEqual([small.width, small.height], [900, 700]);
  assert.match(small.titlePreface, /^link\.example · firefox-container-1 · /);
  assert.ok(!ff.wins.get(w.id).order.includes(t.id));
  assert.ok(!ff.log.some(([what, id]) => what === "create" && id !== t.id && ff.tabs.get(id)?.url === LINK), "not opened twice");
  x.kill();
});

test("it stays out of the record until it is kept, and closing it leaves nothing", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const before = Object.keys(ff.synced).sort();
  const t = linkFromOutside(ff, x, w.id);
  await wait(3000); // long past the moment tab sync registers a new tab
  assert.deepEqual(Object.keys(ff.synced).sort(), before);
  assert.equal(x.js(`littles.size`), 1);
  await x.b.tabs.remove(t.id);
  await wait(300);
  assert.deepEqual(Object.keys(ff.synced).sort(), before);
  assert.equal(x.js(`littles.size`), 0);
  assert.deepEqual(popups(ff), []);
  x.kill();
});

test("with no container, it opens in the space you are in, and the first tab goes", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id, { container: NONE });
  await wait(300);
  const [small] = popups(ff);
  assert.equal(ff.tabs.get(tabOf(small)).cookieStoreId, C1);
  assert.equal(ff.tabs.get(tabOf(small)).url, LINK);
  assert.ok(!ff.tabs.has(t.id));
  x.kill();
});

test("a rule decides its space", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  ff.store.rules = [{ url: "link.example", space: C2 }];
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  const [small] = popups(ff);
  assert.equal(ff.tabs.get(tabOf(small)).cookieStoreId, C2);
  assert.ok(!ff.tabs.has(t.id));
  assert.equal(popups(ff).length, 1);
  x.kill();
});

test("a tab opened any other way is what it always was", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id, { marked: false, container: NONE });
  const u = linkFromOutside(ff, x, w.id, { marked: false, url: "https://b.example/" });
  await wait(300);
  assert.deepEqual(popups(ff), []);
  assert.ok(!ff.tabs.has(t.id), "reopened in the space");
  assert.ok(ff.list(w.id).some(s => s.url === LINK && s.cookieStoreId === C1));
  assert.ok(ff.tabs.has(u.id));
  x.kill();
});

test("a tab that loads a placeholder first is never taken for a link", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(t));
  x.b.tabs.onUpdated.fire(t.id, { url: "about:blank" }, ff.snap(t));
  ff.navigate(t.id, "moz-extension://tidier/ghost.html?kind=ghost&key=k");
  ff.navigate(t.id, LINK);
  await wait(300);
  assert.deepEqual(popups(ff), []);
  x.kill();
});

test("Keep puts it first among today's tabs in every window, selected, and it is synced", async () => {
  const ff = new FakeFirefox();
  const { w, on } = session(ff);
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "moz-extension://tidier/ghost.html?kind=ghost&key=here", title: "Here", cookieStoreId: C1 }, { syncKey: "here", syncRole: "ghost" });
  ff.addTab(other.id, { url: "moz-extension://tidier/ghost.html?kind=ghost&key=old", title: "Old", cookieStoreId: C1 }, { syncKey: "old", syncRole: "ghost" });
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  const rows = await x.js(`littleRows([{ id: "${C1}", name: "Work" }])`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].space, "Work");
  x.js(`serial(() => keepLittle(${t.id}, ${w.id}))`);
  await wait(800);
  assert.deepEqual(popups(ff), [], "the small window closes with its last tab");
  assert.equal(x.js(`littles.size`), 0);
  const here = ff.list(w.id).filter(s => !s.pinned);
  assert.equal(here[0].id, t.id, "first of today's tabs");
  assert.equal(here[1].id, on.id);
  assert.ok(ff.tabs.get(t.id).active, "you stay on it");
  assert.equal(ff.focused, w.id);
  const key = x.js(`syncKeyByTab.get(${t.id})`);
  assert.equal(ff.synced[key].url, LINK);
  const there = ff.list(other.id).filter(s => !s.pinned);
  assert.ok(there[0].url.includes(encodeURIComponent(key)), "the other window shows it in the same place");
  x.kill();
});

test("Keep goes under the folders, and asks no window that is closed", async () => {
  const ff = new FakeFirefox();
  const { w, old } = session(ff);
  ff.store.syncedTabs.F = { group: true, own: true, name: "F", cookieStoreId: C1, parentKey: null, rank: 1, added: 1 };
  ff.store.syncedTabs.here.parentKey = "F";
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  x.js(`littles.set(${ff.tabs.get(t.id).windowId}, 9999)`); // the window it came from has gone
  x.js(`serial(() => keepLittle(${t.id}))`);
  await wait(800);
  const order = ff.list(w.id).filter(s => !s.pinned).map(s => s.id);
  assert.ok(order.indexOf(t.id) === order.indexOf(old.id) - 1, `right before the first of today's tabs: ${order}`);
  x.kill();
});

test("Keep with no normal window left opens one", async () => {
  const ff = new FakeFirefox();
  const { w, on, old } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  await x.b.tabs.remove([on.id, old.id]);
  ff.wins.delete(w.id);
  x.b.windows.onRemoved.fire(w.id);
  await wait(300);
  x.js(`serial(() => keepLittle(${t.id}))`);
  await wait(1500);
  const win = ff.wins.get(ff.tabs.get(t.id).windowId);
  assert.equal(win.type, "normal");
  assert.ok(x.js(`syncKeyByTab.has(${t.id})`));
  x.kill();
});

test("off in the settings, a link is an ordinary tab", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  ff.store.littleWindow = false;
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  assert.deepEqual(popups(ff), []);
  assert.ok(ff.wins.get(w.id).order.includes(t.id));
  x.kill();
});

test("the setting is read and written through the settings page", async () => {
  const ff = new FakeFirefox();
  session(ff);
  const x = await start(ff);
  assert.deepEqual({ ...await x.send({ type: "little:get" }) }, { alone: true, on: true });
  assert.deepEqual({ ...await x.send({ type: "little:set", on: false }) }, { alone: true, on: false });
  await wait(1000);
  assert.equal(ff.store.littleWindow, false);
  assert.equal(x.send({ type: "little:get" }, { id: "someone-else" }), undefined);
  x.kill();
});

test("without Tidier alone, nothing changes", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  ff.store.tidierAlone = false;
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  assert.deepEqual(popups(ff), []);
  assert.ok(ff.wins.get(w.id).order.includes(t.id));
  assert.equal(ff.menuUpdates, undefined);
  x.kill();
});

test("if the window cannot be opened, the link stays a tab", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  ff.refuseWindows = true;
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  assert.ok(ff.wins.get(w.id).order.includes(t.id));
  x.kill();
});

test("a small window is still one after Tidier starts again", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  let x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  x = await start(ff);
  assert.equal(x.js(`littles.size`), 1);
  x.js(`serial(() => keepLittle(${t.id}))`);
  await wait(800);
  assert.equal(ff.tabs.get(t.id).windowId, w.id);
  assert.deepEqual(popups(ff), []);
  x.kill();
});

test("the title follows the page, for want of an address bar", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  ff.navigate(t.id, "https://next.example/");
  await wait(100);
  assert.match(popups(ff)[0].titlePreface, /^next\.example · /);
  x.kill();
});

test("centred over the page, not over the sidebar next to it", async () => {
  const ff = new FakeFirefox();
  session(ff);
  const x = await start(ff);
  const place = (win, page) => x.js(`littleBounds(${JSON.stringify(win)}, ${page})`);
  assert.deepEqual({ ...place({ left: 0, top: 0, width: 1600, height: 1000 }, 1260) }, { width: 900, height: 700, left: 520, top: 150 });
  assert.deepEqual({ ...place({ left: 100, top: 20, width: 1600, height: 1000 }, undefined) }, { width: 900, height: 700, left: 450, top: 170 });
  // Smaller than the small window: from the page's left edge, not over the sidebar.
  assert.deepEqual({ ...place({ left: 0, top: 0, width: 1000, height: 600 }, 660) }, { width: 900, height: 700, left: 340, top: 0 });
  x.kill();
});

test("a link's menu: another space opens behind you, past the rules", async () => {
  const ff = new FakeFirefox();
  const { w, on } = session(ff);
  const x = await start(ff);
  const seen = [];
  x.ctx.openUnruled = props => { seen.push(props); return x.b.tabs.create(props); };
  x.b.menus.onClicked.fire({ menuItemId: `tidier-open-in:${C2}`, linkUrl: LINK }, ff.snap(on));
  await wait(300);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].windowId, seen[0].cookieStoreId, seen[0].url, seen[0].active], [w.id, C2, LINK, false]);
  assert.ok(ff.tabs.get(on.id).active, "you stay where you are");
  x.kill();
});

test("a link's menu from a small window goes to a normal window, not into the small one", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  x.b.menus.onClicked.fire({ menuItemId: `tidier-open-in:${C2}`, linkUrl: "https://c.example/" }, ff.snap(ff.tabs.get(t.id)));
  await wait(300);
  assert.equal(popups(ff)[0].order.length, 1);
  assert.ok(ff.list(w.id).some(s => s.url === "https://c.example/" && s.cookieStoreId === C2));
  x.kill();
});

test("a link's menu: the small window opens in the page's space, or the rule's", async () => {
  const ff = new FakeFirefox();
  const { on } = session(ff);
  ff.store.rules = [{ url: "ruled.example", space: C2 }];
  const x = await start(ff);
  x.b.menus.onClicked.fire({ menuItemId: "tidier-open-little", linkUrl: LINK }, ff.snap(on));
  await wait(200);
  x.b.menus.onClicked.fire({ menuItemId: "tidier-open-little", linkUrl: "https://ruled.example/" }, ff.snap(on));
  await wait(200);
  const opened = popups(ff).map(p => ff.tabs.get(tabOf(p)));
  assert.deepEqual(opened.map(t => [t.url, t.cookieStoreId]), [[LINK, C1], ["https://ruled.example/", C2]]);
  assert.equal(x.js(`littles.size`), 2);
  x.b.menus.onClicked.fire({ menuItemId: "tidier-open-little", linkUrl: "javascript:alert(1)" }, ff.snap(on));
  await wait(200);
  assert.equal(popups(ff).length, 2);
  x.kill();
});

test("Keep is on the page's menu only in a small window", async () => {
  const ff = new FakeFirefox();
  const { w, on } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  const shown = async tab => {
    ff.menuUpdates = [];
    for (const { f } of x.b.menus.onShown.ls) await f({ contexts: ["page"] }, ff.snap(tab));
    return ff.menuUpdates.at(-1)[1];
  };
  assert.equal((await shown(on)).visible, false);
  const inSmall = await shown(ff.tabs.get(t.id));
  assert.equal(inSmall.visible, true);
  assert.equal(inSmall.title, `Keep in ${C1}`);
  x.b.menus.onClicked.fire({ menuItemId: "tidier-keep" }, ff.snap(ff.tabs.get(t.id)));
  await wait(800);
  assert.equal(ff.tabs.get(t.id).windowId, w.id);
  x.kill();
});
