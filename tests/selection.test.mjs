// sidebar/selection.js on a tiny stand-in for the sidebar's page: which tabs a gesture
// picks, which messages come out, and in what order. What really happens to the tabs,
// with real events, is for the smoke test (alone_selection).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const SOURCE = readFileSync(new URL("../sidebar/selection.js", import.meta.url), "utf8");
const MOD = { mac: "metaKey", linux: "ctrlKey" };

class El {
  constructor(id, cls) {
    this.id = id;
    this.dataset = { tab: String(id) };
    this.classes = new Set(cls.split(" "));
    this.offsetParent = {};
    this.isConnected = true;
    const c = this.classes;
    this.classList = { contains: x => c.has(x), add: x => c.add(x), remove: (...xs) => xs.forEach(x => c.delete(x)), toggle: (x, on) => (on ? c.add(x) : c.delete(x)) };
  }
  closest(sel) { return sel === "[data-tab]" ? this : null; }
  get previousElementSibling() { const list = this.list.filter(e => e.classes.has("tile") === this.classes.has("tile")); return list[list.indexOf(this) - 1] ?? null; }
}

async function sidebar({ os = "mac", alone = true, rows = [1, 2, 3, 4, 5], tiles = [8, 9], active = 1 } = {}) {
  const els = [...rows.map(id => new El(id, "row tab")), ...tiles.map(id => new El(id, "tile"))];
  for (const e of els) { e.list = els; if (e.id === active) e.classes.add("active"); }
  const kept = new Map(els.map(e => [`${e.classes.has("tile") ? "tile" : "tab"}:${e.id}`, e]));
  const listeners = {}, sent = [], viewListeners = [];
  const ctx = {
    view: { alone, space: "s" }, kept, send: m => sent.push(m), closeMenu() {}, cursor: null, moveCursor(c) { ctx.cursor = c || null; },
    reachable: () => els, dragging: null, marks() {}, dropAt: () => null,
    nextTab: e => { const list = els.filter(x => x.classes.has("tab")); return list[list.indexOf(e) + 1] ?? null; },
    port: { onMessage: { addListener: f => viewListeners.push(f) } },
    browser: { runtime: { getPlatformInfo: async () => ({ os }) } },
    addEventListener: (type, f, capture) => { assert.equal(capture, true, "selection.js listens in the capture phase"); listeners[type] = f; },
    setTimeout: f => f(),
    document: {
      documentElement: new El(0, ""),
      getElementById: id => (id === "menu" ? ctx.menu : { lastElementChild: els.filter(e => e.classes.has(id === "essentials" ? "tile" : "tab")).at(-1) }),
      querySelector: () => els.find(e => e.classes.has("active")) ?? null,
      querySelectorAll: sel => els.filter(e => (sel === ".picked" ? e.classes.has("picked") : sel.endsWith(".tile") ? e.classes.has("tile") : e.classes.has("tab")) && (sel === ".picked" || e.offsetParent !== null)),
    },
    menu: { hidden: true },
  };
  ctx.window = ctx;
  vm.runInNewContext(SOURCE, ctx);
  await null;
  await null;
  const fire = (type, target, props = {}) => {
    const e = { target, stopped: false, prevented: false, button: 0, stopPropagation() { e.stopped = true; }, preventDefault() { e.prevented = true; }, ...props };
    listeners[type](e);
    return e;
  };
  const el = id => els.find(e => e.id === id);
  return {
    ctx, sent, fire, el, sentCopy: () => JSON.parse(JSON.stringify(sent)),
    click: (id, props = {}) => fire("click", el(id), props),
    add: id => fire("click", el(id), { [MOD[os]]: true }),
    range: id => fire("click", el(id), { shiftKey: true }),
    picked: () => els.filter(e => e.classes.has("picked")).map(e => e.id),
    view: next => { Object.assign(ctx.view, next); viewListeners.forEach(f => f()); },
  };
}
// A click on something inside a row, or on something a plain click leaves alone.
const target = ({ item = null, button = null, keeps = false } = {}) => ({
  closest: sel => (sel === "[data-tab]" ? item : sel === "button" ? button : keeps && sel.includes("#menu") ? {} : null),
});
const xButton = { classList: { contains: x => x === "close" } }, otherButton = { classList: { contains: () => false } };

test("with the setting off, a click is the row's own and nothing is picked", async () => {
  const s = await sidebar({ alone: false });
  assert.equal(s.add(2).stopped, false);
  assert.equal(s.range(3).stopped, false);
  assert.equal(s.fire("keydown", s.el(2), { key: "Backspace" }).stopped, false);
  assert.equal(s.fire("auxclick", s.el(2), { button: 1 }).stopped, false);
  assert.deepEqual(s.picked(), []);
  assert.deepEqual([...s.ctx.selectedTabs(2)], [2]);
});

test("the first ⌘-click takes the selected tab in; the next add and remove; the click stops there", async () => {
  const s = await sidebar();
  assert.equal(s.add(3).stopped, true);
  assert.deepEqual(s.picked(), [1, 3]);
  s.add(4);
  assert.deepEqual(s.picked(), [1, 3, 4]);
  s.add(3);
  assert.deepEqual(s.picked(), [1, 4]);
  assert.deepEqual([...s.ctx.selectedTabs(4)], [1, 4]);
  assert.deepEqual([...s.ctx.selectedTabs(2)], [2]);
  // Taking out the last one ends it: the next first pick starts over.
  s.add(1);
  s.add(4);
  assert.deepEqual(s.picked(), []);
  s.add(2);
  assert.deepEqual(s.picked(), [1, 2]);
});

test("Ctrl-click is the key elsewhere; on a Mac it is a right click and picks nothing", async () => {
  const linux = await sidebar({ os: "linux" });
  linux.click(3, { ctrlKey: true });
  assert.deepEqual(linux.picked(), [1, 3]);
  linux.click(4, { metaKey: true });
  assert.deepEqual(linux.picked(), [], "⌘ means nothing there, so it is a plain click");
  const mac = await sidebar();
  const e = mac.click(3, { ctrlKey: true });
  assert.equal(e.stopped, true, "the tab is not selected as well");
  assert.deepEqual(mac.picked(), []);
});

test("⇧-click takes a range from the selected tab, clicking again changes it, picks made with ⌘ stay", async () => {
  const s = await sidebar({ active: 2 });
  assert.equal(s.range(4).stopped, true);
  assert.deepEqual(s.picked(), [2, 3, 4]);
  s.range(1);
  assert.deepEqual(s.picked(), [1, 2]);
  s.click(5); // plain: clears
  const t = await sidebar({ active: 1 });
  t.add(3); // 1, 3, and the range starts at 3
  t.range(5);
  assert.deepEqual(t.picked(), [1, 3, 4, 5]);
  t.range(4);
  assert.deepEqual(t.picked(), [1, 3, 4]);
});

test("a range goes over what is drawn, and starts at the clicked tab if the selected one is not", async () => {
  const s = await sidebar({ active: 2 });
  s.el(3).offsetParent = null; // in a closed folder
  s.range(4);
  assert.deepEqual(s.picked(), [2, 4]);
  const t = await sidebar({ active: 9 }); // on an essential
  t.range(3);
  assert.deepEqual(t.picked(), [3]);
  t.range(5);
  assert.deepEqual(t.picked(), [3, 4, 5]);
});

test("a range from a tab that has gone starts at the clicked one; earlier picks stay", async () => {
  const s = await sidebar();
  s.view({});
  s.add(3);
  s.el(3).offsetParent = null; // the last one picked, in a folder now closed
  s.view({});
  assert.deepEqual(s.picked(), [1]);
  s.range(5);
  assert.deepEqual(s.picked(), [1, 5]);
  s.range(4);
  assert.deepEqual(s.picked(), [1, 4, 5], "and from there it is a range again");
});

test("essentials and rows never mix: a click on the other kind starts over", async () => {
  const s = await sidebar();
  s.add(2);
  s.add(8);
  assert.deepEqual(s.picked(), [8]);
  s.add(9);
  assert.deepEqual(s.picked(), [8, 9]);
  s.range(3);
  assert.deepEqual(s.picked(), [1, 2, 3]);
});

test("a plain click clears, but not on a folder's head or a row's own button", async () => {
  const s = await sidebar();
  s.add(2);
  const e = s.fire("click", target({ keeps: true }));
  assert.equal(e.stopped, false, "the head folds");
  assert.deepEqual(s.picked(), [1, 2]);
  s.fire("click", target({ item: s.el(4), button: otherButton, keeps: true }));
  assert.deepEqual(s.picked(), [1, 2], "the × or the sound of another row");
  assert.equal(s.click(2).stopped, false, "a press on a picked row ends in the row's own click");
  assert.deepEqual(s.picked(), []);
  s.add(2);
  s.fire("click", target());
  assert.deepEqual(s.picked(), [], "empty space");
});

test("Esc goes back one step at a time: menu, selection, cursor", async () => {
  const s = await sidebar();
  const body = { closest: () => null };
  s.add(2);
  s.ctx.cursor = s.el(4);
  s.ctx.menu.hidden = false;
  assert.equal(s.fire("keydown", body, { key: "Escape" }).prevented, false, "menu.js closes the menu");
  assert.deepEqual(s.picked(), [1, 2]);
  s.ctx.menu.hidden = true;
  s.fire("keydown", body, { key: "Escape" });
  assert.deepEqual(s.picked(), []);
  assert.equal(s.ctx.cursor, s.el(4));
  s.fire("keydown", body, { key: "Escape" });
  assert.equal(s.ctx.cursor, null);
  assert.equal(s.fire("keydown", body, { key: "Escape" }).prevented, false, "nothing left to cancel");
});

test("× on a picked row, ⌫ and a middle click close them all, the selected tab last", async () => {
  const closes = async act => {
    const s = await sidebar();
    s.add(2);
    s.add(3);
    act(s);
    assert.deepEqual(s.picked(), []);
    return s.sentCopy();
  };
  const want = [{ type: "close", tabId: 2 }, { type: "close", tabId: 3 }, { type: "close", tabId: 1 }];
  assert.deepEqual(await closes(s => s.fire("keydown", { closest: () => null }, { key: "Backspace" })), want);
  assert.deepEqual(await closes(s => s.fire("auxclick", s.el(3), { button: 1 })), want);
  assert.deepEqual(await closes(s => s.fire("click", target({ item: s.el(2), button: xButton }))), want);
});

test("⌫ held down closes once: the repeats do not go on to the rows after", async () => {
  const s = await sidebar();
  const body = { closest: () => null };
  s.add(2);
  s.ctx.cursor = s.el(2);
  s.fire("keydown", body, { key: "Backspace" });
  assert.deepEqual(s.sent.map(m => m.tabId), [2, 1]);
  const repeat = s.fire("keydown", body, { key: "Backspace", repeat: true });
  assert.equal(repeat.stopped, true, "keys.js does not see it, or it closes the row the cursor went to");
  assert.equal(s.sent.length, 2);
  // Nothing picked: a first press is still keys.js's own.
  assert.equal(s.fire("keydown", body, { key: "Backspace" }).stopped, false);
});

test("× or ⌫ on a tab that is not picked is that tab's own", async () => {
  const s = await sidebar();
  s.add(2);
  assert.equal(s.fire("click", target({ item: s.el(4), button: xButton, keeps: true })).stopped, false);
  s.ctx.cursor = s.el(4);
  assert.equal(s.fire("keydown", { closest: () => null }, { key: "Backspace" }).stopped, false);
  assert.equal(s.fire("auxclick", s.el(4), { button: 1 }).stopped, false);
  assert.deepEqual(s.sent, []);
  assert.deepEqual(s.picked(), [1, 2]);
});

const dropOf = async (msg, dragged = 3) => {
  const s = await sidebar();
  s.add(3);
  s.add(5);
  s.ctx.dragging = { kind: "tab", tabId: dragged };
  s.ctx.dropAt = () => ({ msg });
  const e = s.fire("drop", s.el(2));
  return { s, e, sent: s.sentCopy() };
};

test("a drop carries them all, in order, to the same place", async () => {
  const { e, sent, s } = await dropOf({ type: "moveTab", tabId: 3, folder: "f", before: 4 });
  assert.equal(e.stopped, true, "drag.js must not move the one row as well");
  assert.deepEqual(sent, [1, 3, 5].map(tabId => ({ type: "moveTab", tabId, folder: "f", before: 4 })));
  assert.equal(s.ctx.dragging, null);
});

test("dropped on a tab that is moving too, the place is in front of the next that is not", async () => {
  const { sent } = await dropOf({ type: "moveTab", tabId: 1, folder: null, before: 3 }, 1);
  assert.deepEqual(sent.map(m => m.before), [4, 4, 4]);
  const last = await dropOf({ type: "moveTab", tabId: 1, folder: null, before: 5 }, 1);
  assert.deepEqual(last.sent.map(m => m.before), [null, null, null], "nothing after it: last there");
});

test("tabs already together in that place do not move", async () => {
  const dropping = async (picks, before) => {
    const s = await sidebar({ active: 9 });
    for (const id of picks) s.add(id);
    s.ctx.dragging = { kind: "tab", tabId: picks[0] };
    s.ctx.dropAt = () => ({ msg: { type: "moveTab", tabId: picks[0], folder: null, before } });
    s.fire("drop", s.el(2));
    return s.sent.length;
  };
  assert.equal(await dropping([2, 3], 3), 0, "on its own neighbour");
  assert.equal(await dropping([2, 3], 4), 0, "right in front of the next");
  assert.equal(await dropping([2, 4], 3), 2, "not together");
  assert.equal(await dropping([2, 3], 5), 2, "further on");
  assert.equal(await dropping([4, 5], null), 0, "last already");
});

test("to a space or the essentials they go in order; essentials unpinned in reverse, since each lands first", async () => {
  const space = await dropOf({ type: "moveToSpace", tabId: 3, space: "b" });
  assert.deepEqual(space.sent.map(m => m.tabId), [1, 3, 5]);
  const pin = await dropOf({ type: "pin", tabId: 3, pinned: true });
  assert.deepEqual(pin.sent.map(m => m.tabId), [1, 3, 5]);
  const unpin = await dropOf({ type: "pin", tabId: 3, pinned: false });
  assert.deepEqual(unpin.sent.map(m => m.tabId), [5, 3, 1]);
});

test("dragging a row that is not picked leaves it to drag.js, and the selection as it is", async () => {
  const { e, sent, s } = await dropOf({ type: "moveTab", tabId: 2, before: 4 }, 2);
  assert.equal(e.stopped, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(s.picked(), [1, 3, 5]);
});

test("a view puts the marks back, drops tabs no longer drawn, and a new space clears", async () => {
  const s = await sidebar();
  s.view({});
  s.add(2);
  s.add(3);
  s.el(2).classes.delete("picked"); // a row drawn again
  s.view({});
  assert.deepEqual(s.picked(), [1, 2, 3]);
  s.el(3).offsetParent = null; // its folder was closed
  s.view({});
  assert.deepEqual(s.picked(), [1, 2]);
  assert.deepEqual([...s.ctx.selectedTabs(3)], [3]);
  s.view({ space: "other" });
  assert.deepEqual(s.picked(), []);
});

test("a view puts the keys' cursor back too: drawing a row resets its classes", async () => {
  const s = await sidebar();
  s.ctx.cursor = s.el(4);
  s.view({});
  assert.equal(s.el(4).classes.has("cursor"), true);
});

test("nothing happens on a view with nothing picked: no look at the page", async () => {
  const s = await sidebar();
  s.view({});
  s.ctx.document.querySelectorAll = () => { throw new Error("looked at the page"); };
  s.view({});
});

test("the cursor goes when its row has gone or is folded away, so ⌫ is the selection's again", async () => {
  const s = await sidebar();
  s.view({});
  s.add(2);
  s.ctx.cursor = s.el(4);
  s.el(4).offsetParent = null; // gone, or in a closed folder
  s.view({});
  assert.equal(s.ctx.cursor, null);
  s.fire("keydown", { closest: () => null }, { key: "Backspace" });
  assert.deepEqual(s.sent.map(m => m.tabId), [2, 1], "picked tabs, the selected one last");
});

test("another tab selected ends the selection; the same tab drawn again does not", async () => {
  const s = await sidebar();
  s.view({});
  s.add(2);
  s.view({});
  assert.deepEqual(s.picked(), [1, 2]);
  s.el(1).classes.delete("active");
  s.el(4).classes.add("active");
  s.view({});
  assert.deepEqual(s.picked(), []);
  assert.deepEqual([...s.ctx.selectedTabs(2)], [2]);
});

test("the row being dragged has gone: the others do not stay faded", async () => {
  const s = await sidebar();
  const root = s.ctx.document.documentElement;
  s.view({});
  s.add(2);
  s.add(3);
  s.ctx.dragging = { kind: "tab", tabId: 3 };
  s.fire("dragstart", s.el(3));
  assert.equal(root.classes.has("carrying"), true);
  s.view({});
  assert.equal(root.classes.has("carrying"), true, "a redraw during a drag changes nothing");
  s.el(3).offsetParent = null;
  s.view({});
  assert.equal(root.classes.has("carrying"), false);
  assert.deepEqual(s.picked(), [1, 2]);
});

// --- What the background does with many at once, on the fake Firefox ---------------------
const C1 = "firefox-container-1";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const savedIn = (folder, url) => entry(url, { parentKey: folder, saved: { url, title: url } });
const FOLDER = { group: true, own: true, name: "Work", cookieStoreId: C1, parentKey: null, rank: 1 };

async function start(ff, alone = true) {
  if (alone) ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// Window: the page you are on (with `prior`, a synced tab before the folder's), three loaded
// saved tabs and an ordinary one after them. A second window has placeholders of them all.
function savedRow(prior) {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: FOLDER, a: savedIn("F", "https://a.example/"), b: savedIn("F", "https://b.example/"), c: savedIn("F", "https://c.example/"), z: entry("https://z.example/"),
    ...(prior ? { p: entry("https://p.example/") } : {}),
  };
  const w = ff.addWindow({ focused: true }), o = ff.addWindow();
  ff.addTab(w.id, { url: "about:blank", active: true });
  if (prior) ff.addTab(w.id, { url: "https://p.example/", cookieStoreId: C1 }, { syncKey: "p", syncRole: "live" });
  const tabs = Object.fromEntries(["a", "b", "c", "z"].map(k => [k, ff.addTab(w.id, { url: `https://${k}.example/`, cookieStoreId: C1 }, { syncKey: k, syncRole: "live" })]));
  ff.addTab(o.id, { url: "about:blank", active: true });
  for (const k of [...(prior ? ["p"] : []), "a", "b", "c", "z"]) ff.addTab(o.id, { url: GHOST("ghost", k), discarded: true, cookieStoreId: C1 }, { syncKey: k, syncRole: "ghost" });
  return { ff, w, o, tabs };
}
const keysIn = (ff, w) => ff.list(w.id).map(t => ff.values.get(t.id)?.syncKey).filter(Boolean);

for (const [name, prior, closing] of [
  ["in order", true, ["a", "b", "c"]],
  ["in order, with nothing before them", false, ["a", "b", "c"]],
  ["with the selected tab last", true, ["b", "c", "a"]],
  ["with the selected tab last, nothing before them", false, ["b", "c", "a"]],
  ["last to first", true, ["c", "b", "a"]],
]) {
  test(`saved tabs closed together stay in order, in every window: ${name}`, async () => {
    const { ff, w, o, tabs } = savedRow(prior);
    const x = await start(ff);
    await wait(100); // the window's order is noted
    for (const k of closing) ff.rm(tabs[k].id);
    await wait(2000);
    const want = [...(prior ? ["p"] : []), "a", "b", "c", "z"];
    assert.deepEqual(keysIn(ff, w), want);
    assert.deepEqual(keysIn(ff, o), want);
    assert.equal(x.js("closingOrder").size, 0, "kept only for a moment");
    x.kill();
  });
}

test("with the setting off, a place is read as before", async () => {
  const { ff, w, tabs } = savedRow(true);
  // Sidebery's own folder page, since that is what a folder is then.
  ff.store.syncedTabs.F = entry("moz-extension://sb/sidebery/group.html#F", { group: true });
  ff.addTab(w.id, { url: "moz-extension://sb/sidebery/group.html#F", cookieStoreId: C1, index: 2 }, { syncKey: "F", syncRole: "copy" });
  const x = await start(ff, false);
  await wait(100);
  ff.rm(tabs.a.id);
  assert.equal(x.js("closingOrder").size, 0, "nothing is held");
  await wait(2000);
  x.kill();
});

test("a tab pinned right after a move, or while Tidier is busy with it, leaves the tab record", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/"), n: entry("https://n.example/") };
  const w = ff.addWindow({ focused: true }), o = ff.addWindow();
  ff.addTab(w.id, { url: "about:blank", active: true });
  const a = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const b = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const n = ff.addTab(w.id, { url: "https://n.example/", cookieStoreId: C1 }, { syncKey: "n", syncRole: "live" });
  ff.addTab(o.id, { url: "about:blank", active: true });
  for (const k of ["a", "b", "n"]) ff.addTab(o.id, { url: GHOST("ghost", k), discarded: true, cookieStoreId: C1 }, { syncKey: k, syncRole: "ghost" });
  const x = await start(ff);
  await x.js("moveTab")(w.id, a.id, n.id, null);
  assert.equal(x.js("syncBusy").has(a.id), false, "a move is not marked as Tidier's own");
  await x.b.tabs.update(a.id, { pinned: true });
  await wait(1000);
  assert.equal(ff.synced.a, undefined, "an essential now, not an ordinary tab as well");
  assert.ok(ff.store.essentials.some(e => e.url === "https://a.example/"));
  // The same for a tab Tidier has just pulled in or created.
  x.js("syncBusy").add(b.id);
  await x.b.tabs.update(b.id, { pinned: true });
  await wait(1000);
  assert.equal(ff.synced.b, undefined);
  assert.deepEqual(keysIn(ff, o), ["n"], "the other window has no placeholder left of either");
  x.kill();
});

test("with the setting off, a tab Tidier is busy with is left alone when pinned, as before", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const a = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await start(ff, false);
  x.js("syncBusy").add(a.id);
  await x.b.tabs.update(a.id, { pinned: true });
  await wait(1000);
  assert.ok(ff.synced.a);
  x.kill();
});

test("tabs opened together keep their order in another window, whichever settles first", async () => {
  const order = async alone => {
    const ff = new FakeFirefox();
    ff.store.syncedTabs = { h: entry("https://h.example/") };
    const w = ff.addWindow({ focused: true }), o = ff.addWindow();
    ff.addTab(w.id, { url: "https://h.example/", active: true, cookieStoreId: C1 }, { syncKey: "h", syncRole: "live" });
    ff.addTab(o.id, { url: "about:blank", active: true });
    ff.addTab(o.id, { url: GHOST("ghost", "h"), discarded: true, cookieStoreId: C1 }, { syncKey: "h", syncRole: "ghost" });
    const x = await start(ff, alone);
    const t = ["a", "b", "c"].map(n => ff.addTab(w.id, { url: `https://${n}.example/`, cookieStoreId: C1 }));
    for (const i of [2, 0, 1]) await x.js("register")(t[i].id);
    await x.js("flushWrites")();
    const got = ff.list(o.id).filter(y => y.url.includes("ghost.html")).map(y => ff.synced[ff.values.get(y.id).syncKey].url[8]);
    x.kill();
    return got.join("");
  };
  assert.equal(await order(true), "habc");
  assert.equal(await order(false), "hcab", "with the setting off, each is simply added at the end");
});

test("a tab with no record is a place too: a move lands right before it, in its window", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/") };
  const w = ff.addWindow({ focused: true }), o = ff.addWindow();
  const a = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const blank = ff.addTab(w.id, { url: "about:newtab" });
  ff.addTab(w.id, { url: "about:config" });
  ff.addTab(o.id, { url: "about:blank", active: true });
  for (const k of ["a", "b"]) ff.addTab(o.id, { url: GHOST("ghost", k), discarded: true, cookieStoreId: C1 }, { syncKey: k, syncRole: "ghost" });
  const x = await start(ff);
  await x.js("moveTab")(w.id, a.id, blank.id, undefined);
  const here = ff.list(w.id).map(t => t.id);
  assert.equal(here.indexOf(a.id), here.indexOf(blank.id) - 1);
  assert.deepEqual(keysIn(ff, o), ["b", "a"], "elsewhere it goes last");
  x.kill();
});

test("an essential's pin counts even on a copy Tidier has just made", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true }), o = ff.addWindow();
  ff.addTab(w.id, { url: "about:blank", active: true });
  ff.addTab(o.id, { url: "about:blank", active: true });
  const t = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "e" });
  ff.addTab(o.id, { url: GHOST("essential", "e"), pinned: true, discarded: true, cookieStoreId: C1 }, { essentialKey: "e" });
  ff.addTab(o.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const g = ff.addTab(w.id, { url: GHOST("ghost", "a"), discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await start(ff);
  // A placeholder dragged to the essentials and straight back: an ordinary tab again.
  await x.b.tabs.update(g.id, { pinned: true });
  await wait(300);
  await x.b.tabs.update(g.id, { pinned: false });
  await wait(4000);
  await x.js("flushWrites")();
  assert.deepEqual(ff.store.essentials.map(e => e.url), ["https://e.example/"]);
  assert.ok(Object.values(ff.synced).some(e => e.url === "https://a.example/"));
  assert.equal(ff.values.get(g.id).essentialKey, undefined);
  // An essential closed, and its new copy straight to the list: no longer an essential.
  ff.rm(t.id);
  await wait(300);
  const copy = ff.list(w.id).find(y => y.pinned);
  await x.b.tabs.update(copy.id, { pinned: false });
  await wait(4000);
  await x.js("flushWrites")();
  assert.deepEqual(ff.store.essentials, []);
  assert.equal(ff.list(o.id).filter(y => y.pinned).length, 0, "and the other window's copy went too");
  x.kill();
});

test("with the setting off, a copy Tidier is busy with is left alone when unpinned, as before", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E", icon: "x" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true });
  const t = ff.addTab(w.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await start(ff, false);
  x.js("busy").add(t.id);
  await x.b.tabs.update(t.id, { pinned: false });
  await wait(1000);
  await x.js("flushWrites")();
  assert.equal(ff.store.essentials.length, 1);
  x.kill();
});

test("each closed tab keeps the space for its own moment: an earlier timer does not end a later one", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const x = await start(ff);
  // The moments are run by hand: real timers would make this a race of its own.
  const moments = [], real = x.ctx.setTimeout;
  x.ctx.setTimeout = (f, ms, ...a) => { if (ms === 200) { moments.push(f); return 0; } return real(f, ms, ...a); };
  for (const tabId of [9001, 9002]) x.b.tabs.onRemoved.fire(tabId, { windowId: w.id, isWindowClosing: false });
  x.ctx.setTimeout = real;
  assert.equal(moments.length, 2);
  moments[0]();
  assert.equal(x.js("closedIn").has(w.id), true, "the first one's time is up, the last one's is not");
  moments[1]();
  assert.equal(x.js("closedIn").has(w.id), false);
  x.kill();
});
