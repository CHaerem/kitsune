// A closed folder rests (foldrest.js): Tidier's real background scripts on a fake
// Firefox. What Firefox itself does with a hidden and unloaded tab is for the smoke
// test (alone_folds_rest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1";
const folder = (more = {}) => ({ group: true, own: true, name: "Folder", url: null, cookieStoreId: C1, parentKey: null, rank: 1, added: 1, ...more });
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const inFolder = (url, more = {}) => entry(url, { parentKey: "F", saved: { url, title: url }, ...more });

async function run(ff) {
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}
async function alone(ff) {
  ff.managed = { tidierAlone: true };
  return run(ff);
}

const live = (ff, w, key, more = {}) => ff.addTab(w.id, { url: ff.store.syncedTabs[key].url, cookieStoreId: C1, ...more }, { syncKey: key, syncRole: "live" });
const ghost = (ff, w, key, more = {}) => ff.addTab(w.id, { url: GHOST("ghost", key), discarded: true, cookieStoreId: C1, ...more }, { syncKey: key, syncRole: "ghost" });
const discards = ff => ff.log.filter(l => l[0] === "discard").map(l => l[1]);
const act = (x, windowId, msg) => x.js("serial")(() => x.js("sidebarAction")(windowId, msg));
const fold = (x, windowId, collapsed, key = "F") => act(x, windowId, { type: "foldFolder", key, collapsed });

// Two tabs in a folder and one outside it in the first window, placeholders of those
// in the second, and the second window's own selected tab, with its placeholder.
function twoWindows(ff, F = folder()) {
  ff.store.syncedTabs = {
    F, a: inFolder("https://a.example/"), b: inFolder("https://b.example/"),
    here: entry("https://here.example/"), there: entry("https://there.example/"),
  };
  const w1 = ff.addWindow({ focused: true }), w2 = ff.addWindow();
  return {
    w1, w2,
    here: live(ff, w1, "here", { active: true }), a: live(ff, w1, "a"), b: live(ff, w1, "b"), thereGhost: ghost(ff, w1, "there"),
    there: live(ff, w2, "there", { active: true }), aGhost: ghost(ff, w2, "a"), bGhost: ghost(ff, w2, "b"), hereGhost: ghost(ff, w2, "here"),
  };
}

test("closing a folder hides its tabs in every window and unloads the real ones", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  await fold(x, s.w1.id, true);
  for (const t of [s.a, s.b, s.aGhost, s.bGhost]) assert.equal(t.hidden, true);
  for (const t of [s.here, s.there, s.thereGhost, s.hereGhost]) assert.equal(t.hidden, false);
  assert.deepEqual(discards(ff).sort(), [s.a.id, s.b.id].sort(), "the real tabs, and the placeholders are not touched");
  assert.equal(s.a.discarded, true);
  assert.equal(s.here.discarded, false);
  x.kill();
});

test("opening a folder shows its tabs and loads nothing", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  await fold(x, s.w1.id, true);
  ff.log.length = 0;
  await fold(x, s.w2.id, false);
  for (const t of [s.a, s.b, s.aGhost, s.bGhost]) assert.equal(t.hidden, false);
  assert.equal(s.a.discarded, true);
  assert.equal(s.b.discarded, true);
  assert.ok(!ff.log.some(l => ["update-url", "discard"].includes(l[0])));
  x.kill();
});

test("a rested tab keeps the address it is on, not its saved one", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  ff.navigate(s.a.id, "https://a.example/deeper");
  await wait(500);
  await fold(x, s.w1.id, true);
  assert.equal(s.a.url, "https://a.example/deeper");
  assert.equal(ff.synced.a.url, "https://a.example/deeper");
  assert.equal(ff.synced.a.saved.url, "https://a.example/");
  x.kill();
});

test("what keeps working stays loaded, and hidden, and one refusal does not stop the others", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: folder(), L: folder({ live: "prs", rank: 2 }),
    selected: inFolder("https://selected.example/"), loud: inFolder("https://loud.example/"),
    typed: inFolder("https://typed.example/"), call: inFolder("https://call.example/"), screen: inFolder("https://screen.example/"),
    plain: inFolder("https://plain.example/"),
    pr: entry("https://pr.example/1", { parentKey: "L", liveFolder: "prs", liveUrl: "https://pr.example/1" }),
    unopened: entry("https://pr.example/2", { parentKey: "L", liveFolder: "prs", liveUrl: "https://pr.example/2" }),
    handed: inFolder("https://handed.example/"),
  };
  const w = ff.addWindow({ focused: true });
  const selected = live(ff, w, "selected", { active: true });
  const loud = live(ff, w, "loud", { audible: true });
  const typed = live(ff, w, "typed");
  const call = live(ff, w, "call", { sharingState: { camera: true, microphone: false, screen: undefined } });
  const screen = live(ff, w, "screen", { sharingState: { camera: false, microphone: false, screen: "Window" } });
  const plain = live(ff, w, "plain");
  const pr = live(ff, w, "pr");
  // A placeholder that became the live tab (its window closed), not unloaded yet: it does that itself.
  const handed = ff.addTab(w.id, { url: GHOST("ghost", "handed"), cookieStoreId: C1 }, { syncKey: "handed", syncRole: "live" });
  const unopened = ff.addTab(w.id, { url: GHOST("lazy", "unopened"), cookieStoreId: C1 }, { syncKey: "unopened", syncRole: "live" });
  const x = await alone(ff);
  ff.log.length = 0;
  ff.refuseDiscard = new Set([typed.id]);
  await fold(x, w.id, true);
  await fold(x, w.id, true, "L");
  assert.deepEqual(discards(ff), [typed.id, plain.id], "asked of the page that refuses, and of the one after it");
  assert.equal(plain.discarded, true);
  for (const t of [selected, loud, typed, call, screen, pr, handed, unopened]) assert.equal(t.discarded, false);
  assert.equal(selected.hidden, false, "Firefox cannot hide the selected tab");
  for (const t of [loud, typed, call, screen, plain, pr, handed, unopened]) assert.equal(t.hidden, true);
  x.kill();
});

test("leaving a tab in a closed folder hides and unloads it, and only then", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  ff.select(s.a.id);
  await wait(500);
  await fold(x, s.w1.id, true);
  assert.equal(s.a.hidden, false);
  assert.equal(s.a.discarded, false);
  ff.select(s.here.id);
  await wait(500);
  assert.equal(s.a.hidden, true);
  assert.equal(s.a.discarded, true);
  // Selected again (a link, ⌃Tab cannot): back and loaded, and resting again when you leave it.
  ff.select(s.a.id);
  await wait(500);
  assert.equal(s.a.hidden, false);
  assert.equal(s.a.discarded, false);
  ff.select(s.here.id);
  await wait(500);
  assert.equal(s.a.hidden, true);
  assert.equal(s.a.discarded, true);
  x.kill();
});

test("leaving a tab in an open folder, or an ordinary tab, unloads nothing", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  ff.select(s.a.id);
  await wait(300);
  ff.select(s.b.id);
  await wait(300);
  ff.select(s.here.id);
  await wait(300);
  assert.deepEqual(discards(ff), []);
  for (const t of [s.a, s.b, s.here]) assert.equal(t.hidden, false);
  x.kill();
});

test("a tab selected from another window comes loaded, and rests when you leave it", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  await fold(x, s.w1.id, true);
  x.b.windows.onFocusChanged.fire(s.w2.id);
  await wait(200);
  ff.focused = s.w2.id;
  ff.select(s.aGhost.id);
  await wait(1500);
  assert.equal(s.a.windowId, s.w2.id, "the real tab came");
  assert.equal(s.a.active, true);
  assert.equal(s.a.discarded, false);
  assert.equal(s.a.hidden, false);
  const left = ff.list(s.w1.id).find(t => ff.values.get(t.id)?.syncKey === "a");
  assert.equal(left.hidden, true, "the placeholder it left is hidden");
  ff.select(s.there.id);
  await wait(800);
  assert.equal(s.a.hidden, true);
  assert.equal(s.a.discarded, true);
  x.kill();
});

test("a tab moved into a closed folder rests, and comes back when moved out, unloaded", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  await fold(x, s.w1.id, true);
  await act(x, s.w1.id, { type: "moveTab", tabId: s.thereGhost.id, folder: "F", before: null });
  assert.equal(s.thereGhost.hidden, true);
  assert.equal(s.there.discarded, false, "the selected tab stays, in its own window");
  assert.equal(s.there.hidden, false);
  ff.select(s.hereGhost.id);
  await wait(1500);
  assert.equal(s.there.discarded, true, "until you leave it");
  assert.equal(s.there.hidden, true);
  await act(x, s.w1.id, { type: "moveTab", tabId: s.thereGhost.id, folder: null, before: null });
  assert.equal(s.there.hidden, false);
  assert.equal(s.thereGhost.hidden, false);
  assert.equal(s.there.discarded, true);
  x.kill();
});

test("a tab that is not selected is unloaded as it arrives in a closed folder", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder({ collapsed: true }), on: entry("https://on.example/"), other: entry("https://other.example/") };
  const w = ff.addWindow({ focused: true });
  live(ff, w, "on", { active: true });
  const other = live(ff, w, "other");
  const x = await alone(ff);
  await act(x, w.id, { type: "moveTab", tabId: other.id, folder: "F", before: null });
  assert.equal(other.hidden, true);
  assert.equal(other.discarded, true);
  x.kill();
});

test("deleting a closed folder gives its tabs back", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  await fold(x, s.w1.id, true);
  await act(x, s.w1.id, { type: "deleteFolder", key: "F" });
  for (const t of [s.a, s.b, s.aGhost, s.bGhost]) assert.equal(t.hidden, false);
  assert.equal(s.a.discarded, true);
  x.kill();
});

test("a start hides a closed folder's tabs and unloads nothing", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff, folder({ collapsed: true }));
  const x = await alone(ff);
  for (const t of [s.a, s.b, s.aGhost, s.bGhost]) assert.equal(t.hidden, true);
  assert.equal(s.a.discarded, false);
  assert.deepEqual(discards(ff), []);
  x.kill();
});

test("a new window's placeholders of a closed folder's tabs are hidden, and a new one later too", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff, folder({ collapsed: true }));
  const x = await alone(ff);
  const w3 = ff.addWindow();
  ff.addTab(w3.id, { url: "https://here.example/", active: true, cookieStoreId: C1 }, { syncKey: "here", syncRole: "ghost" });
  x.b.windows.onCreated.fire({ id: w3.id, type: "normal", incognito: false });
  await wait(1500);
  const reps = key => ff.list(w3.id).filter(t => ff.values.get(t.id)?.syncKey === key);
  assert.equal(reps("a").length, 1);
  assert.equal(reps("a")[0].hidden, true);
  assert.equal(reps("b")[0].hidden, true);
  assert.equal(reps("there")[0].hidden, false);
  x.kill();
});

test("with the setting off, a closed folder hides and unloads nothing", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff, folder({ collapsed: true }));
  const x = await run(ff);
  assert.equal(x.js("tidierAlone"), false);
  ff.select(s.a.id);
  await wait(300);
  ff.select(s.here.id);
  await wait(300);
  await x.js("foldChanged")("F");
  await x.js("restMoved")("a");
  assert.ok(!ff.log.some(l => ["hide", "discard"].includes(l[0])));
  assert.equal(s.a.hidden, false);
  assert.equal(s.a.discarded, false);
  x.kill();
});

test("with nothing happening, a closed folder does nothing", async () => {
  const ff = new FakeFirefox();
  const s = twoWindows(ff);
  const x = await alone(ff);
  await fold(x, s.w1.id, true);
  await wait(500);
  ff.log.length = 0;
  const jobs = x.js("work").jobs;
  await wait(2000);
  assert.deepEqual(ff.log, []);
  assert.equal(x.js("work").jobs, jobs);
  x.kill();
});
