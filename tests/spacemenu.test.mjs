// A space's menu: what it offers (sidebar/spacemenu.js, sidebar/menu.js) and what it
// does (spaceactions.js, on the fake Firefox). What it looks like, real clicks and
// real typing are in the smoke test (alone_space_menu).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";

// --- What it does ---------------------------------------------------------------
async function alone(ff) {
  ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const live = key => ({ syncKey: key, syncRole: "live" });

// A space with what must stay and what must go, in two windows.
function session(ff) {
  ff.store.syncedTabs = {
    here: entry("https://here.example/"), selected: entry("https://selected.example/"),
    sound: entry("https://sound.example/"), there: entry("https://there.example/"), call: entry("https://call.example/"),
    refuses: entry("https://refuses.example/"), selected2: entry("https://selected2.example/"),
    elsewhere: entry("https://elsewhere.example/", { cookieStoreId: C2 }),
  };
  const a = ff.addWindow({ focused: true }), b = ff.addWindow();
  const tab = (w, key, url, props = {}) => ff.addTab(w.id, { url, cookieStoreId: C1, ...props }, live(key));
  const placeholder = (w, key, props = {}) => ff.addTab(w.id, { url: GHOST("ghost", key), cookieStoreId: C1, discarded: true, ...props }, { syncKey: key, syncRole: "ghost" });
  const tabs = {
    here: tab(a, "here", "https://here.example/"),
    selected: tab(a, "selected", "https://selected.example/", { active: true }),
    sound: tab(a, "sound", "https://sound.example/", { audible: true }),
    call: tab(a, "call", "https://call.example/", { sharingState: { camera: false, microphone: true, screen: undefined } }),
    refuses: tab(a, "refuses", "https://refuses.example/"),
    // Its page is loaded in the other window, as a row in this window does not show.
    there: tab(b, "there", "https://there.example/"),
    // The other window's selected tab is one you are looking at too.
    otherSelected: tab(b, "selected2", "https://selected2.example/", { active: true }),
    elsewhere: ff.addTab(a.id, { url: "https://elsewhere.example/", cookieStoreId: C2 }, live("elsewhere")),
    essential: ff.addTab(a.id, { url: "https://essential.example/", cookieStoreId: C1, pinned: true }),
  };
  placeholder(a, "there");
  for (const key of ["selected", "sound", "call", "refuses"]) placeholder(b, key);
  // Still waiting for its icon: unloaded now, it would have none (unloadGhost, tabsync.js).
  tabs.gettingIcon = placeholder(b, "here", { discarded: false });
  return { a, b, tabs };
}

test("unloading a space leaves essentials, selected tabs, sound and calls, and reaches another window", async () => {
  const ff = new FakeFirefox();
  const { a, tabs } = session(ff);
  ff.refuseDiscard = new Set([tabs.refuses.id]);
  const x = await alone(ff);
  await x.js(`sidebarAction(${a.id}, { type: "unloadSpace", space: "${C1}" })`);
  assert.equal(tabs.here.discarded, true, "an ordinary loaded tab");
  assert.equal(tabs.there.discarded, true, "a tab whose page is in another window");
  for (const name of ["selected", "otherSelected", "sound", "call", "essential", "elsewhere", "refuses", "gettingIcon"]) assert.equal(tabs[name].discarded, false, name);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a selected tab that is not in the tab record yet stays too", async () => {
  // A new tab page, which is never in the record, or a tab opened a moment ago.
  const ff = new FakeFirefox();
  session(ff);
  const w = ff.addWindow();
  const tab = ff.addTab(w.id, { url: "about:newtab", cookieStoreId: C1, active: true });
  const x = await alone(ff);
  await x.js(`unloadSpace("${C1}")`);
  assert.equal(tab.discarded, false);
  x.kill();
});

test("a tab whose placeholder is selected is on its way to you, and stays", async () => {
  const ff = new FakeFirefox();
  const { a, tabs } = session(ff);
  const x = await alone(ff);
  // As after a click on a row, before the page has been pulled into this window.
  const ghost = ff.list(a.id).find(t => t.url === GHOST("ghost", "there"));
  ff.tabs.get(ghost.id).active = true;
  ff.tabs.get(tabs.selected.id).active = false;
  await x.js(`unloadSpace("${C1}")`);
  assert.equal(tabs.there.discarded, false);
  assert.equal(tabs.selected.discarded, true, "the one you left");
  assert.equal(ff.tabs.get(ghost.id).url, GHOST("ghost", "there"), "and the placeholder is not touched");
  x.kill();
});

test("one tab closed meanwhile does not stop the others from unloading", async () => {
  const ff = new FakeFirefox();
  const { tabs } = session(ff);
  const x = await alone(ff);
  const discard = x.b.tabs.discard;
  x.b.tabs.discard = async id => { if (id === tabs.here.id) throw new Error(`Invalid tab ID: ${id}`); return discard(id); };
  await x.js(`unloadSpace("${C1}")`);
  assert.equal(tabs.there.discarded, true);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("no space given unloads nothing: a query without a container is every space's tabs", async () => {
  const ff = new FakeFirefox();
  const { a, tabs } = session(ff);
  const x = await alone(ff);
  await x.js(`sidebarAction(${a.id}, { type: "unloadSpace" })`);
  await x.js(`unloadSpace(null)`);
  for (const name of ["here", "there", "elsewhere"]) assert.equal(tabs[name].discarded, false, name);
  x.kill();
});

test("renaming a space changes its container, and an empty name does nothing", async () => {
  const ff = new FakeFirefox();
  const { a } = session(ff);
  const x = await alone(ff);
  const calls = [];
  x.b.contextualIdentities.update = async (id, changes) => { calls.push([id, changes]); };
  await x.js(`sidebarAction(${a.id}, { type: "renameSpace", space: "${C2}", name: "  Home " })`);
  await x.js(`sidebarAction(${a.id}, { type: "renameSpace", space: "${C2}", name: "   " })`);
  assert.deepEqual(calls.map(c => [c[0], { ...c[1] }]), [[C2, { name: "Home" }]]);
  x.kill();
});

// The way in from a sidebar: what its port does with a message.
async function sidebarPort(x, windowId) {
  const heard = [];
  x.b.runtime.onConnect.fire({ name: "sidebar", sender: { id: x.b.runtime.id }, postMessage() {}, onMessage: { addListener: f => heard.push(f) }, onDisconnect: { addListener() {} } });
  const say = msg => Promise.all(heard.map(f => f(msg)));
  await say({ type: "hello", windowId });
  return say;
}

test("with the setting off a space's messages do nothing, and with it on they do", async () => {
  for (const setting of [false, true]) {
    const ff = new FakeFirefox();
    const { a, tabs } = session(ff);
    const x = setting ? await alone(ff) : ff.boot();
    const calls = [];
    x.b.contextualIdentities.update = async id => { calls.push(id); };
    const say = await sidebarPort(x, a.id);
    await say({ type: "unloadSpace", space: C1 });
    await say({ type: "renameSpace", space: C1, name: "Home" });
    assert.equal(tabs.here.discarded, setting);
    assert.equal(calls.length, setting ? 1 : 0);
    x.kill();
  }
});

// --- What it offers ---------------------------------------------------------------
// The sidebar's own scripts, with the little of a page that they need. Text-only, as a
// menu is: what is drawn is for the smoke test.
function sidebar({ alone = true, active = C1, tabs = [{ id: 1, active: true }, { id: 2 }] } = {}) {
  const listeners = {}, sent = [], menus = [], options = [];
  const box = { hidden: true, style: {}, offsetHeight: 90, getBoundingClientRect: () => ({ top: 500 }), addEventListener() {} };
  const ctx = vm.createContext({
    browser: { runtime: { openOptionsPage: async () => { options.push(1); } }, menus: { overrideContext() {} } },
    document: { getElementById: () => box, querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: (type, f, capture) => { (listeners[type] ??= []).push({ f, capture }); },
    MutationObserver: class { observe() {} },
    port: { onMessage: { addListener() {} } },
    send: msg => sent.push(msg),
    renameNext: false, innerWidth: 300, innerHeight: 600,
    el() {},
  });
  const REPO = new URL("../", import.meta.url);
  vm.runInContext(`let view = ${JSON.stringify({ alone, space: active, tabs, spaces: [{ id: C1, name: "One", color: "#000" }, { id: C2, name: "Two", color: "#000" }] })};`, ctx);
  for (const f of ["sidebar/menu.js", "sidebar/spacemenu.js"]) vm.runInContext(readFileSync(new URL(f, REPO), "utf8"), ctx, { filename: f });
  vm.runInContext("var openMenu = (e, items) => { e.preventDefault(); __opened(items); }", Object.assign(ctx, { __opened: items => menus.push(items) }));
  const rightClick = (selector, dataset) => {
    const prevented = [];
    const target = { closest: s => (s === selector ? { dataset, classList: { add() {}, remove() {} } } : null), id: selector === "#space-name" ? "space-name" : "" };
    for (const { f, capture } of listeners.contextmenu) if (capture) f({ target, preventDefault: () => prevented.push(1), stopPropagation() {} });
    return prevented.length > 0;
  };
  const labels = items => Array.from(items, i => i[0]); // arrays of another realm
  return { ctx, sent, menus, options, rightClick, labels, list: () => vm.runInContext("listMenu()", ctx) };
}

test("a space's menu: Clear only for the space you are in, and only with something to clear", () => {
  const s = sidebar();
  assert.ok(s.rightClick("#spaces .space", { space: C1 }));
  assert.deepEqual(s.labels(s.menus.at(-1)), ["Rename", "Unload this space", "Clear today's tabs", "Settings"]);
  assert.ok(s.rightClick("#spaces .space", { space: C2 }));
  assert.deepEqual(s.labels(s.menus.at(-1)), ["Rename", "Unload this space", "Settings"]);
  const lone = sidebar({ tabs: [{ id: 1, active: true }] });
  lone.rightClick("#spaces .space", { space: C1 });
  assert.deepEqual(lone.labels(lone.menus.at(-1)), ["Rename", "Unload this space", "Settings"]);
});

test("the name above the list has the same menu, for the space you are in", () => {
  const s = sidebar();
  assert.ok(s.rightClick("#space-name"));
  assert.deepEqual(s.labels(s.menus.at(-1)), ["Rename", "Unload this space", "Clear today's tabs", "Settings"]);
});

test("the items send what the background knows, and Settings needs no message", () => {
  const s = sidebar();
  s.rightClick("#spaces .space", { space: C1 });
  const item = name => s.menus.at(-1).find(i => i[0] === name)[1];
  item("Unload this space")();
  item("Clear today's tabs")();
  assert.deepEqual(s.sent.map(m => ({ ...m })), [{ type: "unloadSpace", space: C1 }, { type: "clearSpace", space: C1 }]);
  item("Settings")();
  assert.equal(s.options.length, 1);
});

test("Clear acts on the space it was offered for, wherever the window is by the time of the click", () => {
  const s = sidebar();
  s.rightClick("#spaces .space", { space: C1 });
  const fromDot = s.menus.at(-1).find(i => i[0] === "Clear today's tabs")[1], fromList = s.list()[1][1];
  vm.runInContext(`view.space = ${JSON.stringify(C2)}`, s.ctx);
  fromDot();
  fromList();
  assert.deepEqual(s.sent.map(m => m.space), [C1, C1]);
});

test("the list's menu is New folder, Clear today's tabs, Settings, and stays that short", () => {
  const s = sidebar();
  assert.deepEqual(s.labels(s.list()), ["New folder", "Clear today's tabs", "Settings"]);
  s.list()[1][1]();
  assert.deepEqual({ ...s.sent.at(-1) }, { type: "clearSpace", space: C1 });
  s.list()[2][1]();
  assert.equal(s.options.length, 1);
  const lone = sidebar({ tabs: [{ id: 1, active: true }] });
  assert.deepEqual(lone.labels(lone.list()), ["New folder", "Settings"]);
});

test("without Tidier alone a right click on a dot is Firefox's, as today", () => {
  const s = sidebar({ alone: false });
  assert.equal(s.rightClick("#spaces .space", { space: C1 }), false);
  assert.equal(s.rightClick("#space-name"), false);
  assert.equal(s.menus.length, 0);
});

// The sidebar's scripts share one scope as well, and here it is worse than in the
// background: a `const` declared again stops the whole later script from loading.
test("no two sidebar scripts define the same top-level name", () => {
  const page = readFileSync(new URL("../sidebar/sidebar.html", import.meta.url), "utf8");
  const seen = new Map(), twice = [];
  for (const [, file] of page.matchAll(/<script src="([^"]+)"/g)) {
    const src = readFileSync(new URL("../sidebar/" + file, import.meta.url), "utf8");
    for (const [, name] of src.matchAll(/^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(name)) twice.push(`${name} (${seen.get(name)}, ${file})`);
      else seen.set(name, file);
    }
  }
  assert.deepEqual(twice, []);
});
