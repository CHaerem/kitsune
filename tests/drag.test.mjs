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

// Two windows with essentials a, b (one space) and z (another), and a tab in the first.
async function two() {
  const ff = new FakeFirefox();
  ff.managed = { tidierAlone: true };
  ff.store.essentials = [essential("a"), essential("b"), essential("z", C2)];
  ff.store.syncedTabs = { x: { url: "https://x.example/", title: "X", cookieStoreId: C1, parentKey: null, group: false, added: 1 } };
  const w = ff.addWindow({ focused: true }), other = ff.addWindow();
  const tiles = {};
  for (const win of [w, other]) for (const e of ff.store.essentials) {
    const t = ff.addTab(win.id, { url: win === w ? e.url : GHOST("essential", e.key), pinned: true, discarded: win !== w, cookieStoreId: e.cookieStoreId }, { essentialKey: e.key });
    if (win === w) tiles[e.key] = t.id;
  }
  ff.addTab(w.id, { url: "about:blank", active: true });
  const tab = ff.addTab(w.id, { url: "https://x.example/", title: "X", cookieStoreId: C1 }, { syncKey: "x", syncRole: "live" });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "x"), discarded: true, cookieStoreId: C1 }, { syncKey: "x", syncRole: "ghost" });
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "browser_update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return { ff, x, w, other, tiles, tab, ghost };
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
