// A tab dropped among the essentials, on Tidier's real background scripts on a fake
// Firefox: every window has it at that place. What the sidebar shows and sends during
// a drag is in the smoke test (alone_drag_details).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const essential = (key, cookieStoreId = C1) => ({ key, url: `https://${key}.example/`, cookieStoreId, title: key, icon: "x" });
const place = (ff, windowId) => ff.list(windowId).filter(t => t.pinned).map(t => ff.values.get(t.id)?.essentialKey);
const order = ff => ff.store.essentials.map(e => e.url.replace("https://", "").replace(".example/", ""));

// Two windows with essentials a, b (one space) and z (another), tabs x and y in the
// first with a placeholder each in the other, and a new tab page only the first has.
async function two() {
  const ff = new FakeFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.essentials = [essential("a"), essential("b"), essential("z", C2)];
  const record = (name, added) => ({ url: `https://${name}.example/`, title: name.toUpperCase(), cookieStoreId: C1, parentKey: null, group: false, added });
  ff.store.syncedTabs = { x: record("x", 1), y: record("y", 2), folder: { group: true, own: true, name: "Kept", cookieStoreId: C1, parentKey: null, rank: 1, added: 3 } };
  const w = ff.addWindow({ focused: true }), other = ff.addWindow();
  const tiles = {};
  for (const win of [w, other]) for (const e of ff.store.essentials) {
    const t = ff.addTab(win.id, { url: win === w ? e.url : GHOST("essential", e.key), pinned: true, discarded: win !== w, cookieStoreId: e.cookieStoreId }, { essentialKey: e.key });
    if (win === w) tiles[e.key] = t.id;
  }
  ff.addTab(w.id, { url: "about:blank", active: true });
  const tab = ff.addTab(w.id, { url: "https://x.example/", title: "X", cookieStoreId: C1 }, { syncKey: "x", syncRole: "live" });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "x"), discarded: true, cookieStoreId: C1 }, { syncKey: "x", syncRole: "ghost" });
  const tabY = ff.addTab(w.id, { url: "https://y.example/", title: "Y", cookieStoreId: C1 }, { syncKey: "y", syncRole: "live" });
  const ghostY = ff.addTab(other.id, { url: GHOST("ghost", "y"), discarded: true, cookieStoreId: C1 }, { syncKey: "y", syncRole: "ghost" });
  const newTab = ff.addTab(w.id, { url: "about:newtab", title: "New Tab", cookieStoreId: C1 });
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "browser_update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return { ff, x, w, other, tiles, tab, ghost, tabY, ghostY, newTab };
}

// The sidebar's end of the connection, as the background sees it.
function sidebar(x, windowId) {
  const heard = [];
  x.b.runtime.onConnect.fire({ name: "sidebar", sender: { id: "tidier" }, onMessage: { addListener: f => heard.push(f) }, onDisconnect: { addListener() {} }, postMessage() {} });
  const say = msg => heard.forEach(f => f(msg));
  say({ type: "hello", windowId });
  return say;
}

test("a tab dropped on a tile is an essential just before it, in every window", async () => {
  const { ff, x, w, other, tiles, tab } = await two();
  sidebar(x, w.id)({ type: "pin", tabId: tab.id, pinned: true, before: tiles.b });
  await wait(1500);
  assert.deepEqual(order(ff), ["a", "x", "b", "z"]);
  const key = ff.store.essentials[1].key;
  assert.deepEqual(place(ff, w.id), ["a", key, "b", "z"]);
  assert.deepEqual(place(ff, other.id), ["a", key, "b", "z"]);
  assert.equal(x.js("pinPlaces.size"), 0);
  x.kill();
});

test("a tab dropped on the right of the last tile is the last essential of its space", async () => {
  const { ff, x, w, other, tab } = await two();
  sidebar(x, w.id)({ type: "pin", tabId: tab.id, pinned: true, before: null });
  await wait(1500);
  assert.deepEqual(order(ff), ["a", "b", "x", "z"]);
  const key = ff.store.essentials[2].key;
  assert.deepEqual(place(ff, w.id), ["a", "b", key, "z"]);
  assert.deepEqual(place(ff, other.id), ["a", "b", key, "z"]);
  x.kill();
});

test("a tile gone by the time of the drop: the tab goes last, nothing is lost", async () => {
  const { ff, x, w, tab } = await two();
  sidebar(x, w.id)({ type: "pin", tabId: tab.id, pinned: true, before: 99999 });
  await wait(1500);
  assert.deepEqual(order(ff), ["a", "b", "x", "z"]);
  x.kill();
});

test("a tab that is only a placeholder here keeps its page when dropped on a tile", async () => {
  const { ff, x, other, ghost } = await two();
  const tile = ff.list(other.id).find(t => ff.values.get(t.id)?.essentialKey === "b").id;
  sidebar(x, other.id)({ type: "pin", tabId: ghost.id, pinned: true, before: tile });
  await wait(1500);
  assert.deepEqual(order(ff), ["a", "x", "b", "z"]);
  assert.equal(ff.tabs.get(ghost.id).url, GHOST("essential", ff.store.essentials[1].key));
  x.kill();
});

test("a pin that is refused leaves no place behind", async () => {
  const { ff, x, w, tiles, tab } = await two();
  ff.rm(tab.id);
  await wait(200);
  sidebar(x, w.id)({ type: "pin", tabId: tab.id, pinned: true, before: tiles.b });
  await wait(500);
  assert.equal(x.js("pinPlaces.size"), 0);
  x.kill();
});

// Each tab in a window, in its order, by what it stands for: x, y, "new", or "?".
const shown = (ff, windowId) => ff.list(windowId).filter(t => !t.pinned && t.url !== "about:blank")
  .map(t => (t.url === "about:newtab" ? "new" : ff.values.get(t.id)?.syncKey ?? "?"));

test("a tab moved right above a tab only this window has lands there, and in the other window before the next tab it has", async () => {
  const { ff, x, w, other, tab, newTab } = await two();
  sidebar(x, w.id)({ type: "moveTab", tabId: tab.id, before: newTab.id, folder: null });
  await wait(500);
  assert.deepEqual(shown(ff, w.id), ["y", "x", "new"]); // not past it, to the end of the window
  assert.deepEqual(shown(ff, other.id), ["y", "x"]);
  x.kill();
});

test("a tab moved above a new tab page with more tabs after it keeps its place among them in the other window too", async () => {
  const { ff, x, w, other, tab, tabY, newTab } = await two();
  const say = sidebar(x, w.id);
  say({ type: "moveTab", tabId: tabY.id, before: null, folder: null }); // x, new, y
  await wait(500);
  assert.deepEqual(shown(ff, w.id), ["x", "new", "y"]);
  say({ type: "moveTab", tabId: tabY.id, before: tab.id, folder: null }); // y, x, new
  await wait(500);
  say({ type: "moveTab", tabId: tab.id, before: null, folder: null }); // y, new, x
  await wait(500);
  say({ type: "moveTab", tabId: tabY.id, before: tab.id, folder: null }); // new, y, x
  await wait(500);
  assert.deepEqual(shown(ff, w.id), ["new", "y", "x"]);
  say({ type: "moveTab", tabId: tab.id, before: newTab.id, folder: null }); // x, new, y here; x, y there
  await wait(500);
  assert.deepEqual(shown(ff, w.id), ["x", "new", "y"]);
  assert.deepEqual(shown(ff, other.id), ["x", "y"]);
  x.kill();
});

test("a tab dropped on a tile right after it was moved is not left behind as a tab in the other window", async () => {
  const { ff, x, w, other, tiles, tab } = await two();
  const say = sidebar(x, w.id);
  say({ type: "moveTab", tabId: tab.id, before: null, folder: null });
  await wait(100); // tab sync still ignores this tab: it thinks the move is its own
  say({ type: "pin", tabId: tab.id, pinned: true, before: tiles.b });
  await wait(1500);
  assert.deepEqual(order(ff), ["a", "x", "b", "z"]);
  assert.deepEqual(shown(ff, other.id), ["y"]);
  assert.equal(ff.store.syncedTabs.x, undefined);
  x.kill();
});

test("a placeholder dropped on a tile and at once dragged back is an ordinary tab again, not an essential as well", async () => {
  const { ff, x, other, ghost } = await two();
  const say = sidebar(x, other.id);
  say({ type: "pin", tabId: ghost.id, pinned: true });
  await wait(300); // it is still being made the essential's copy
  say({ type: "pin", tabId: ghost.id, pinned: false });
  await wait(1500);
  assert.deepEqual(order(ff), ["a", "b", "z"]);
  assert.equal(ff.tabs.get(ghost.id).url, "https://x.example/");
  x.kill();
});

test("a placeholder dropped on a tile and at once moved among the tiles stays where you put it", async () => {
  const { ff, x, other, ghost } = await two();
  const say = sidebar(x, other.id);
  const tile = key => ff.list(other.id).find(t => ff.values.get(t.id)?.essentialKey === key).id;
  say({ type: "pin", tabId: ghost.id, pinned: true });
  await wait(300);
  say({ type: "moveEssential", tabId: ghost.id, before: tile("a") });
  await wait(1500);
  assert.deepEqual(order(ff), ["x", "a", "b", "z"]);
  x.kill();
});

test("a tab opened a moment ago, not in the record yet, goes into the folder it is dropped on", async () => {
  const { ff, x, w } = await two();
  const fresh = ff.addTab(w.id, { url: "https://fresh.example/", title: "Fresh", cookieStoreId: C1 });
  sidebar(x, w.id)({ type: "moveTab", tabId: fresh.id, before: null, folder: "folder" });
  await wait(500);
  const key = ff.values.get(fresh.id)?.syncKey;
  assert.ok(key);
  assert.equal(ff.store.syncedTabs[key].parentKey, "folder");
  await wait(2000); // tab sync's own wait for it ends without a second record
  assert.equal(Object.values(ff.store.syncedTabs).filter(e => e.url === "https://fresh.example/").length, 1);
  x.kill();
});

test("a drop on a tile for a tab pinned meanwhile leaves no place behind for a later pin", async () => {
  const { ff, x, w, tiles } = await two();
  sidebar(x, w.id)({ type: "pin", tabId: tiles.a, pinned: true, before: tiles.b });
  await wait(300);
  assert.equal(x.js("pinPlaces.size"), 0);
  assert.deepEqual(order(ff), ["a", "b", "z"]);
  x.kill();
});

test("what the sidebar is told about a tab says whether it can be more than a row: a page or its placeholder", async () => {
  const { x, w, other, ff } = await two();
  const seen = [];
  const port = { name: "sidebar", sender: { id: "tidier" }, onMessage: { addListener: f => port.say = f }, onDisconnect: { addListener() {} }, postMessage: v => seen.push(v) };
  x.b.runtime.onConnect.fire(port);
  port.say({ type: "hello", windowId: w.id });
  await wait(300);
  const rows = Object.fromEntries(seen.at(-1).tabs.map(t => [t.title, t.page]));
  assert.equal(rows["New Tab"], false);
  assert.equal(rows.X, true);
  seen.length = 0;
  port.say({ type: "hello", windowId: other.id });
  await wait(300);
  assert.equal(seen.at(-1).tabs.find(t => t.id === ff.list(other.id).find(g => g.url.includes("kind=ghost")).id).page, true);
  x.kill();
});
