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
  b.windows.getAll = async ({ windowTypes, populate } = {}) => [...ff.wins.values()].filter(w => !windowTypes || windowTypes.includes(w.type)).map(w => ({ ...info(w), ...(populate ? { tabs: ff.list(w.id) } : {}) }));
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
      if (ff.wasOn?.has(tab.id) && ff.tabs.has(ff.wasOn.get(tab.id))) ff.select(ff.wasOn.get(tab.id));
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
  b.tabs.move = async (id, p) => {
    const from = ff.tabs.get(id).windowId;
    const r = await move(id, p);
    if (ff.tabs.get(id).windowId !== from) ff.tabs.get(id).active = false; // a tab that arrives in a window is not selected there
    closeIfEmpty(from);
    return r;
  };
  b.commands.update ??= async () => {};
  b.tabs.remove = async ids => {
    const from = [ids].flat().map(id => ff.tabs.get(id)?.windowId);
    // Measured: a link's tab that closes gives the selection back to the tab you were on.
    for (const id of [ids].flat()) if (ff.tabs.get(id)?.active && ff.tabs.has(ff.wasOn?.get(id))) ff.select(ff.wasOn.get(id));
    await remove(ids);
    from.forEach(closeIfEmpty);
  };
  ff.winValues ??= new Map();
  b.sessions.setWindowValue = async (id, k, v) => { ff.winValues.set(`${id}/${k}`, v); (ff.winValueLog ??= []).push([id, k, v]); };
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

// What a real Firefox does with a link from another app: a new tab on about:blank, with no
// container, or that of another visible tab on the same host (Firefox's guess, which is
// what `container` plays), selected, the first about:blank ended early, then the address.
function linkFromOutside(ff, x, windowId, { url = LINK, container = C1, marked = true } = {}) {
  const on = ff.wins.get(windowId).order.find(id => ff.tabs.get(id).active);
  const t = ff.addTab(windowId, { url: "about:blank", title: url, cookieStoreId: container });
  (ff.wasOn ??= new Map()).set(t.id, on);
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.select(t.id);
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
  assert.equal(small.titlePreface, `${C1} · `);
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

test("a link another part of Tidier opened again goes on to a small window, the new tab itself", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const blank = ff.addTab(w.id, { url: "about:blank", cookieStoreId: NONE, active: true });
  x.b.tabs.onCreated.fire(ff.snap(blank));
  x.b.tabs.onUpdated.fire(blank.id, { status: "complete", url: "about:blank" }, ff.snap(blank));
  const made = await x.b.tabs.create({ windowId: w.id, url: LINK, cookieStoreId: C1, active: true });
  await x.ctx.littleAfterReopen(ff.snap(blank), made);
  assert.equal(tabOf(popups(ff)[0]), made.id);
  // A tab without the mark is left where it was opened.
  const plain = ff.addTab(w.id, { url: "about:blank", cookieStoreId: NONE });
  x.b.tabs.onCreated.fire(ff.snap(plain));
  const other = await x.b.tabs.create({ windowId: w.id, url: "https://b.example/", cookieStoreId: C1 });
  await x.ctx.littleAfterReopen(ff.snap(plain), other);
  assert.equal(ff.tabs.get(other.id).windowId, w.id);
  x.kill();
});

test("a space chosen on the bar is the one you are in after Tidier starts again", async () => {
  // Found here: Keep can leave you in another space, and a click on the bar then went unsaved.
  const ff = new FakeFirefox();
  const { w } = session(ff);
  ff.addTab(w.id, { url: "https://two.example/", title: "Two", cookieStoreId: C2 }, { syncKey: "two", syncRole: "live" });
  ff.store.syncedTabs.two = { url: "https://two.example/", title: "Two", cookieStoreId: C2, parentKey: null, group: false, added: 1 };
  let x = await start(ff);
  await x.js(`serial(() => switchSpace(${w.id}, "${C2}"))`);
  await wait(100);
  assert.equal(ff.winValues.get(`${w.id}/space`), C2);
  x = await start(ff);
  assert.equal(x.js(`activeSpace.get(${w.id})`), C2);
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
  popups(ff)[0].titlePreface = null; // as after a restart
  x = await start(ff);
  assert.equal(x.js(`littles.size`), 1);
  assert.equal(popups(ff)[0].titlePreface, `${C1} · `);
  x.js(`serial(() => keepLittle(${t.id}))`);
  await wait(800);
  assert.equal(ff.tabs.get(t.id).windowId, w.id);
  assert.deepEqual(popups(ff), []);
  x.kill();
});

test("⌥-click: a script in every page only while the access is given", async () => {
  const ff = new FakeFirefox();
  const { on } = session(ff);
  const x = withWindows(ff, ff.boot());
  const scripts = [];
  x.b.contentScripts = { register: async o => { const s = { ...o, unregister: async () => { scripts.splice(scripts.indexOf(s), 1); } }; scripts.push(s); return s; } };
  let given = false;
  x.b.permissions.contains = async () => given;
  ff.store.tidierAlone = true;
  x.b.runtime.onStartup.fire();
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  assert.equal(scripts.length, 0);
  given = true;
  x.b.permissions.onAdded.fire({ origins: ["<all_urls>"] }); // spaces.js starts again on the same event
  await wait(300);
  assert.equal(scripts.length, 1, "once");
  x.send({ type: "little:peek", url: LINK }, { url: "https://here.example/", tab: ff.snap(on) });
  await wait(300);
  assert.equal(ff.tabs.get(tabOf(popups(ff)[0])).cookieStoreId, C1);
  given = false;
  x.b.permissions.onRemoved.fire({ origins: ["<all_urls>"] });
  await wait(100);
  assert.equal(scripts.length, 0);
  x.kill();
});

test("only Tidier's own pages can change the setting", async () => {
  const ff = new FakeFirefox();
  session(ff);
  const x = await start(ff);
  assert.equal(x.send({ type: "little:set", on: false }, { url: "https://any.example/" }), undefined);
  await wait(500);
  assert.equal(ff.store.littleWindow, undefined);
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

test("Keep is on the page's menu only in a small window, and on a link there too", async () => {
  const ff = new FakeFirefox();
  const { w, on } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  const shown = async (tab, contexts = ["page"]) => {
    ff.menuUpdates = [];
    for (const { f } of x.b.menus.onShown.ls) await f({ contexts }, ff.snap(tab));
    return ff.menuUpdates.filter(([id]) => id === "tidier-keep").at(-1)?.[1];
  };
  assert.equal(await shown(on), undefined, "in a normal window it is left hidden");
  const inSmall = await shown(ff.tabs.get(t.id));
  assert.equal(inSmall.visible, true);
  assert.equal(inSmall.title, `Keep in ${C1}`);
  assert.equal((await shown(ff.tabs.get(t.id), ["link"])).visible, true);
  // Hidden again when the menu closes: the next one, in a normal window, must not start with it.
  ff.menuUpdates = [];
  x.b.menus.onHidden.fire();
  assert.equal(JSON.stringify(ff.menuUpdates), JSON.stringify([["tidier-keep", { visible: false }]]));
  ff.menuUpdates = [];
  x.b.menus.onHidden.fire();
  assert.equal(ff.menuUpdates.length, 0, "and nothing to do after any other menu");
  x.b.menus.onClicked.fire({ menuItemId: "tidier-keep" }, ff.snap(ff.tabs.get(t.id)));
  await wait(800);
  assert.equal(ff.tabs.get(t.id).windowId, w.id);
  x.kill();
});

test("Firefox's guess puts a link in another space: your window stays, and it opens in your space", async () => {
  const ff = new FakeFirefox();
  const { w, on } = session(ff);
  ff.addTab(w.id, { url: "https://link.example/essential", title: "Essential", cookieStoreId: C2, pinned: true });
  const x = await start(ff);
  ff.winValueLog = [];
  const t = linkFromOutside(ff, x, w.id, { container: C2 });
  await wait(300);
  const [small] = popups(ff);
  assert.equal(ff.tabs.get(tabOf(small)).cookieStoreId, C1, "in the space you are in");
  assert.equal(ff.tabs.get(tabOf(small)).url, LINK);
  assert.ok(!ff.tabs.has(t.id), "the first tab goes");
  assert.equal(x.js(`activeSpace.get(${w.id})`), C1);
  assert.ok(!ff.winValueLog.some(([id, k, v]) => id === w.id && k === "space" && v === C2), "not even for a moment");
  assert.ok(!ff.log.some(([what, ids]) => what === "hide" && [ids].flat().includes(on.id)), "your tabs stay shown");
  assert.equal(x.js(`newBlanks.size`), 0);
  x.kill();
});

test("a new tab in another space that is no link still takes you there, once it has an address", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id, { container: C2, marked: false });
  await wait(300);
  assert.deepEqual(popups(ff), []);
  assert.equal(x.js(`activeSpace.get(${w.id})`), C2);
  assert.ok(ff.tabs.get(t.id).active);
  assert.equal(x.js(`newBlanks.size`), 0);
  // And one that stops on a page that is no web page.
  const u = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(u));
  ff.select(u.id);
  await wait(100);
  assert.equal(x.js(`activeSpace.get(${w.id})`), C2, "held for now");
  ff.navigate(u.id, "about:newtab");
  await wait(300);
  assert.equal(x.js(`activeSpace.get(${w.id})`), C1);
  assert.equal(x.js(`newBlanks.size`), 0);
  x.kill();
});

test("off in the settings, a link Firefox guessed into another space goes there as any tab does", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  ff.store.littleWindow = false;
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id, { container: C2 });
  await wait(300);
  assert.deepEqual(popups(ff), []);
  assert.ok(ff.wins.get(w.id).order.includes(t.id));
  assert.equal(x.js(`activeSpace.get(${w.id})`), C2);
  x.kill();
});

test("asked at the request, before Firefox's mark (isolation.js), it can still become a link", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(t));
  assert.equal(x.ctx.littleTakes(t.id, LINK), false);
  x.b.tabs.onUpdated.fire(t.id, { url: "about:blank" }, ff.snap(t));
  ff.navigate(t.id, LINK);
  await wait(300);
  assert.equal(tabOf(popups(ff)[0]), t.id);
  x.kill();
});

test("a link's first tab, closed by Tidier, is not what ⌘⇧T brings back", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  ff.recentlyClosed = [{ tab: { url: "https://yours.example/", sessionId: "yours", windowId: w.id } }];
  linkFromOutside(ff, x, w.id, { container: NONE });
  await wait(300);
  ff.recentlyClosed.unshift({ tab: { url: LINK, sessionId: "first", windowId: w.id } }); // a moment after it closed
  x.b.sessions.onChanged.fire();
  await wait(100);
  assert.deepEqual(ff.recentlyClosed.map(c => c.tab.sessionId), ["yours"]);
  x.kill();
});

test("an address that changes right away is one link: one small window, and a rule looks at the first", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  ff.store.rules = [{ url: "next.example", space: C2 }];
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id); // both before the queue gets to it
  ff.navigate(t.id, "https://next.example/");
  await wait(300);
  assert.equal(popups(ff).length, 1);
  assert.equal(tabOf(popups(ff)[0]), t.id);
  assert.equal(ff.tabs.get(t.id).url, "https://next.example/", "not opened again by the rule");
  x.kill();
});

test("a rule's removed space loses no link: it opens in the space you are in", async () => {
  const ff = new FakeFirefox();
  const { w, on } = session(ff);
  ff.store.rules = [{ url: "link.example", space: "firefox-container-9" }];
  const x = await start(ff);
  linkFromOutside(ff, x, w.id, { container: NONE });
  await wait(300);
  const [small] = popups(ff);
  assert.equal(ff.tabs.get(tabOf(small)).cookieStoreId, C1);
  assert.equal(ff.tabs.get(tabOf(small)).url, LINK);
  // And the menu's small window, for the same link.
  x.b.menus.onClicked.fire({ menuItemId: "tidier-open-little", linkUrl: LINK }, ff.snap(on));
  await wait(200);
  assert.equal(popups(ff).length, 2);
  assert.equal(ff.tabs.get(tabOf(popups(ff)[1])).cookieStoreId, C1);
  x.kill();
});

test("a window that opens as a popup is never taken for a small window", async () => {
  // Measured: a sign-in's window.open does not carry the mark. Should Firefox change that,
  // moving it would still be wrong: its page expects to stay in the window it opened.
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const signIn = ff.addWindow({ type: "popup" });
  const t = linkFromOutside(ff, x, signIn.id);
  await wait(300);
  assert.equal(ff.tabs.get(t.id).windowId, signIn.id);
  assert.equal(popups(ff).length, 1);
  assert.equal(x.js(`littles.size`), 0);
  assert.equal(ff.wins.get(w.id).order.length, 2);
  x.kill();
});

test("⌃2 in a small window adds no tab to it", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  ff.addTab(w.id, { url: "https://two.example/", title: "Two", cookieStoreId: C2 }, { syncKey: "two", syncRole: "live" });
  ff.store.syncedTabs.two = { url: "https://two.example/", title: "Two", cookieStoreId: C2, parentKey: null, group: false, added: 1 };
  const x = await start(ff);
  const t = linkFromOutside(ff, x, w.id);
  await wait(300);
  const [small] = popups(ff);
  assert.equal(ff.focused, small.id);
  const made = ff.log.filter(([what]) => what === "create").length;
  x.b.commands.onCommand.fire("space-2");
  await wait(300);
  assert.deepEqual(small.order, [t.id]);
  assert.equal(ff.log.filter(([what]) => what === "create").length, made);
  // From your window it works as ever.
  ff.focused = w.id;
  x.b.commands.onCommand.fire("space-2");
  await wait(300);
  assert.equal(x.js(`activeSpace.get(${w.id})`), C2);
  x.kill();
});

test("a closed small window reopened (⌘⇧T, ⌘⇧N) is one again; a sign-in's popup is not", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const back = ff.addWindow({ type: "popup" });
  ff.addTab(back.id, { url: LINK, title: "Link", cookieStoreId: C1, active: true });
  ff.winValues.set(`${back.id}/little`, true);
  const signIn = ff.addWindow({ type: "popup" });
  ff.addTab(signIn.id, { url: "https://sign.example/", title: "Sign in", cookieStoreId: C1, active: true });
  x.b.windows.onCreated.fire({ id: back.id, type: "popup" });
  x.b.windows.onCreated.fire({ id: signIn.id, type: "popup" });
  await wait(300);
  assert.equal(x.js(`littles.has(${back.id})`), true);
  assert.equal(back.titlePreface, `${C1} · `);
  assert.equal(x.js(`littles.has(${signIn.id})`), false);
  assert.equal(signIn.titlePreface, undefined);
  x.js(`serial(() => keepLittle(${tabOf(back)}))`);
  await wait(800);
  assert.ok(ff.wins.get(w.id).order.some(id => ff.tabs.get(id).url === LINK));
  assert.ok(!ff.wins.has(back.id));
  x.kill();
});

test("a private window's link goes nowhere else", async () => {
  const ff = new FakeFirefox();
  const { on } = session(ff);
  const x = await start(ff);
  ff.containers.add("firefox-private"); // the fake would refuse it for the wrong reason
  const priv = { ...ff.snap(on), incognito: true, cookieStoreId: "firefox-private" };
  ff.menuUpdates = [];
  for (const { f } of x.b.menus.onShown.ls) await f({ contexts: ["link"] }, priv);
  assert.ok(ff.menuUpdates.some(([id, p]) => id === "tidier-open-in" && p.visible === false), "the menu is hidden");
  assert.equal(x.js(`linkChoices.length`), 0);
  x.b.menus.onClicked.fire({ menuItemId: "tidier-open-little", linkUrl: LINK }, priv);
  x.b.menus.onClicked.fire({ menuItemId: `tidier-open-in:${C2}`, linkUrl: LINK }, priv);
  x.send({ type: "little:peek", url: LINK }, { url: "https://here.example/", tab: priv });
  await wait(300);
  assert.deepEqual(popups(ff), []);
  assert.ok(![...ff.tabs.values()].some(t => t.url === LINK));
  // A normal window's menu shows it again.
  ff.menuUpdates = [];
  for (const { f } of x.b.menus.onShown.ls) await f({ contexts: ["link"] }, ff.snap(on));
  assert.ok(ff.menuUpdates.some(([id, p]) => id === "tidier-open-in" && p.visible === true));
  x.kill();
});

test("nothing is kept for tabs that are gone", async () => {
  const ff = new FakeFirefox();
  const { w } = session(ff);
  const x = await start(ff);
  const a = linkFromOutside(ff, x, w.id);
  await wait(200);
  const b = linkFromOutside(ff, x, w.id, { marked: false, url: "https://b.example/" });
  const blank = ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(blank));
  assert.equal(x.js(`newBlanks.size`), 1, "one still on about:blank");
  await x.b.tabs.remove([a.id, b.id, blank.id]);
  await wait(300);
  assert.equal(x.js(`newBlanks.size`), 0);
  assert.equal(x.js(`littles.size`), 0);
  x.kill();
});
