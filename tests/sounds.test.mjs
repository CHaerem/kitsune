// Where the sound is coming from (sounds.js), on the fake Firefox: a window shows the
// real page's sound, whichever window the page is in, and the mark acts on the real
// tab. What is drawn is for the smoke test (alone_sound).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, realSleep, SCALE, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });

async function start(ff, managed = { tidierAlone: true }) {
  ff.managed = managed;
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// A sidebar in a window, as far as the background can tell.
function sidebar(x, windowId) {
  const event = () => { const ls = []; return { addListener: f => ls.push(f), fire: m => ls.forEach(f => f(m)) }; };
  const views = [];
  const port = { name: "sidebar", sender: { id: "tidier" }, onMessage: event(), onDisconnect: event(), postMessage: v => views.push(JSON.parse(JSON.stringify(v))) };
  x.b.runtime.onConnect.fire(port);
  port.onMessage.fire({ type: "hello", windowId });
  return { views, send: m => port.onMessage.fire(m), get view() { return views.at(-1); } };
}
const settle = () => realSleep(600 / SCALE + 40);
const play = (ff, x, id, on = true) => { const t = ff.tabs.get(id); t.audible = on; x.b.tabs.onUpdated.fire(id, { audible: on }, ff.snap(t)); };
const row = (view, id) => [...view.essentials, ...view.folders.flatMap(f => f.tabs), ...view.tabs].find(i => i.id === id);

// Two windows: the page of `a` is loaded in the first, with a placeholder in the second.
function twoWindows(ff, space = C1) {
  ff.store.syncedTabs = { a: entry("https://a.example/", { cookieStoreId: space }), b: entry("https://b.example/") };
  const w1 = ff.addWindow({ focused: true }), w2 = ff.addWindow();
  const b1 = ff.addTab(w1.id, { url: "https://b.example/", active: true, cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const real = ff.addTab(w1.id, { url: "https://a.example/", cookieStoreId: space }, { syncKey: "a", syncRole: "live" });
  const b2 = ff.addTab(w2.id, { url: GHOST("ghost", "b"), active: true, cookieStoreId: C1, discarded: true }, { syncKey: "b", syncRole: "ghost" });
  const copy = ff.addTab(w2.id, { url: GHOST("ghost", "a"), cookieStoreId: space, discarded: true }, { syncKey: "a", syncRole: "ghost" });
  return { w1, w2, real, copy, b1, b2 };
}

test("a placeholder shows the sound of its page in another window, and acts on the real tab", async () => {
  const ff = new FakeFirefox();
  const { w1, w2, real, copy } = twoWindows(ff);
  const x = await start(ff);
  const here = sidebar(x, w2.id), there = sidebar(x, w1.id);
  await settle();
  assert.equal(row(here.view, copy.id).sound, null);
  play(ff, x, real.id);
  await settle();
  const item = row(here.view, copy.id);
  assert.equal(item.sound, "playing");
  assert.equal(item.soundTabId, real.id, "the real tab, not the placeholder");
  assert.equal(row(there.view, real.id).soundTabId, real.id);
  // Muting from the window that has only the placeholder.
  here.send({ type: "mute", tabId: item.soundTabId, muted: true });
  await settle();
  assert.equal(ff.tabs.get(real.id).mutedInfo.muted, true);
  assert.equal(ff.tabs.get(copy.id).mutedInfo, undefined);
  assert.equal(row(here.view, copy.id).sound, "muted");
  assert.equal(row(there.view, real.id).sound, "muted");
  x.kill();
});

test("a muted tab shows as muted even while its page plays, and a placeholder's own mute says nothing", async () => {
  const ff = new FakeFirefox();
  const { w1, real, b1, b2 } = twoWindows(ff);
  real.mutedInfo = { muted: true };
  real.audible = true;
  b2.mutedInfo = { muted: true }; // Firefox's own tab menu can do this to a placeholder
  const x = await start(ff);
  const here = sidebar(x, w1.id);
  await settle();
  assert.equal(row(here.view, real.id).sound, "muted");
  assert.equal(row(here.view, b1.id).sound, null);
  assert.equal(here.view.spaces.find(s => s.id === C1).soundTabId, undefined, "a space is marked only for what plays");
  x.kill();
});

test("a placeholder's own sound says nothing, also on a space", async () => {
  const ff = new FakeFirefox();
  const { w2, copy } = twoWindows(ff);
  copy.audible = true; // a page that has just become a placeholder is audible for a moment
  const x = await start(ff);
  const here = sidebar(x, w2.id);
  await settle();
  assert.equal(row(here.view, copy.id).sound, null);
  assert.equal(here.view.spaces.find(s => s.id === C1).soundTabId, undefined);
  x.kill();
});

test("a page that becomes a placeholder takes its mark with it, in every window", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e1", url: "https://e.example/", cookieStoreId: C1, title: "E" }];
  const w1 = ff.addWindow({ focused: true }), w2 = ff.addWindow();
  const real = ff.addTab(w1.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1, title: "E", mutedInfo: { muted: true } }, { essentialKey: "e1" });
  ff.addTab(w1.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const copy = ff.addTab(w2.id, { url: GHOST("essential", "e1"), pinned: true, cookieStoreId: C1, title: "E", discarded: true }, { essentialKey: "e1" });
  ff.addTab(w2.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const x = await start(ff);
  const here = sidebar(x, w2.id);
  await settle();
  assert.equal(here.view.essentials.find(e => e.id === copy.id).sound, "muted");
  // A second loaded copy of an essential goes back to its placeholder (oneLoaded): only
  // its address changes, in its own window. It keeps its mute, which now says nothing.
  // Only what Firefox would call for that (the fake's fire calls every listener).
  const change = { url: GHOST("essential", "e1") };
  Object.assign(real, change);
  for (const { f, filter } of x.b.tabs.onUpdated.ls) if (!filter?.properties || filter.properties.includes("url")) f(real.id, change, ff.snap(real));
  await settle();
  assert.equal(here.view.essentials.find(e => e.id === copy.id).sound, null);
  x.kill();
});

test("a tab without a container that plays in another window shows on the space you are in", async () => {
  const ff = new FakeFirefox();
  const { w1, w2 } = twoWindows(ff);
  const file = ff.addTab(w1.id, { url: "file:///music.ogg", cookieStoreId: "firefox-default" });
  const x = await start(ff);
  const here = sidebar(x, w2.id);
  await settle();
  play(ff, x, file.id);
  await settle();
  assert.equal(here.view.spaces.find(s => s.id === here.view.space).soundTabId, file.id);
  x.kill();
});

test("going to the tab that plays does not wait for what the queue is doing", async () => {
  const ff = new FakeFirefox();
  const { w2, real, copy } = twoWindows(ff, C2);
  const x = await start(ff);
  const here = sidebar(x, w2.id);
  await settle();
  play(ff, x, real.id);
  await settle();
  x.js("serial(() => new Promise(() => {}))"); // a job that has not finished
  here.send({ type: "goToSound", tabId: here.view.spaces.find(s => s.id === C2).soundTabId });
  await wait(500);
  assert.equal(ff.tabs.get(copy.id).active, true);
  x.kill();
});

test("another space's dot leads to this window's copy, or to the page itself if there is none", async () => {
  const ff = new FakeFirefox();
  const { w1, w2, real, copy } = twoWindows(ff, C2);
  const strange = ff.addTab(w1.id, { url: "about:logo", cookieStoreId: "firefox-container-3" });
  const x = await start(ff);
  const here = sidebar(x, w2.id);
  await settle();
  assert.deepEqual(here.view.spaces.filter(s => s.soundTabId), []);
  play(ff, x, real.id);
  play(ff, x, strange.id);
  await settle();
  const of = id => here.view.spaces.find(s => s.id === id).soundTabId;
  assert.equal(of(C2), copy.id);
  assert.equal(of("firefox-container-3"), strange.id, "a page Tidier does not keep has no copy");
  assert.equal(of(C1), undefined);
  // Going there: this window's copy is selected, which pulls the page in (in the
  // window you are using; the smoke test checks that part).
  here.send({ type: "goToSound", tabId: of(C2) });
  await wait(1000);
  assert.equal(ff.tabs.get(copy.id).active, true);
  // With no copy, its own window comes to the front.
  ff.focused = w2.id;
  here.send({ type: "goToSound", tabId: of("firefox-container-3") });
  await wait(500);
  assert.equal(ff.focused, w1.id);
  assert.equal(ff.tabs.get(strange.id).active, true);
  x.kill();
});

test("a closed folder shows what plays inside it, and an open one leaves it to its row", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Work", cookieStoreId: C1, parentKey: null, rank: 1, collapsed: true },
    O: { group: true, own: true, name: "Open", cookieStoreId: C1, parentKey: null, rank: 2 },
    a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "A" } }),
    b: entry("https://b.example/", { parentKey: "F", saved: { url: "https://b.example/", title: "B" } }),
    c: entry("https://c.example/", { parentKey: "O", saved: { url: "https://c.example/", title: "C" } }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const a = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const b = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const c = ff.addTab(w.id, { url: "https://c.example/", cookieStoreId: C1 }, { syncKey: "c", syncRole: "live" });
  const x = await start(ff);
  const here = sidebar(x, w.id);
  await settle();
  const F = () => here.view.folders.find(f => f.key === "F"), O = () => here.view.folders.find(f => f.key === "O");
  assert.equal(F().sound, undefined);
  a.mutedInfo = { muted: true };
  x.b.tabs.onUpdated.fire(a.id, { mutedInfo: a.mutedInfo }, ff.snap(a));
  await settle();
  assert.equal(F().sound, "muted");
  assert.equal(F().soundTabId, a.id);
  play(ff, x, b.id);
  await settle();
  assert.equal(F().sound, "playing", "what you can hear comes first");
  assert.equal(F().soundTabId, b.id);
  play(ff, x, c.id);
  await settle();
  assert.equal(O().sound, undefined, "an open folder's row shows it");
  assert.equal(row(here.view, c.id).sound, "playing");
  x.kill();
});

test("an essential's tile shows its page's sound from another window and another space", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e1", url: "https://e.example/", cookieStoreId: C2, title: "E" }, { key: "e2", url: "https://f.example/", cookieStoreId: C1, title: "F" }];
  const w1 = ff.addWindow({ focused: true }), w2 = ff.addWindow();
  const real = ff.addTab(w1.id, { url: "https://e.example/", pinned: true, cookieStoreId: C2, title: "E" }, { essentialKey: "e1" });
  ff.addTab(w1.id, { url: GHOST("essential", "e2"), pinned: true, cookieStoreId: C1, title: "F", discarded: true }, { essentialKey: "e2" });
  ff.addTab(w1.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const copy = ff.addTab(w2.id, { url: GHOST("essential", "e1"), pinned: true, cookieStoreId: C2, title: "E", discarded: true }, { essentialKey: "e1" });
  ff.addTab(w2.id, { url: GHOST("essential", "e2"), pinned: true, cookieStoreId: C1, title: "F", discarded: true }, { essentialKey: "e2" });
  ff.addTab(w2.id, { url: "about:blank", active: true, cookieStoreId: C2 });
  const x = await start(ff);
  const here = sidebar(x, w2.id);
  await settle();
  assert.deepEqual(here.view.essentials.map(e => e.id), [copy.id]);
  play(ff, x, real.id);
  await settle();
  const tile = here.view.essentials[0];
  assert.equal(tile.sound, "playing");
  assert.equal(tile.soundTabId, real.id);
  assert.equal(here.view.spaces.find(s => s.id === C2).soundTabId, copy.id);
  // Closing the real page sends no change of sound: the mark must go by itself.
  ff.rm(real.id);
  await settle();
  assert.equal(here.view.essentials[0].sound, null);
  assert.equal(here.view.spaces.find(s => s.id === C2).soundTabId, undefined);
  x.kill();
});

test("a change of sound refreshes every window, and only that", async () => {
  const ff = new FakeFirefox();
  const { w1, w2, real } = twoWindows(ff);
  const x = await start(ff);
  const listener = x.b.tabs.onUpdated.ls.filter(l => l.filter?.properties?.join() === "audible,mutedInfo");
  assert.equal(listener.length, 1, "one listener, for these two changes only");
  const here = sidebar(x, w2.id), there = sidebar(x, w1.id);
  await settle();
  const n = [here.views.length, there.views.length];
  listener[0].f(real.id, { audible: true }, ff.snap(real));
  await settle();
  assert.equal(here.views.length, n[0] + 1, "one view, in the window without the page");
  assert.equal(there.views.length, n[1] + 1);
  // A tab that closes with no sound is no reason to redraw another window.
  const quiet = ff.addTab(w1.id, { url: "https://q.example/", cookieStoreId: C1 });
  await settle();
  const m = here.views.length;
  x.b.tabs.onRemoved.ls.at(-1).f(quiet.id, { windowId: w1.id });
  await settle();
  assert.equal(here.views.length, m);
  x.kill();
});

test("with the setting off a row shows its own tab's sound, and nothing is asked across windows", async () => {
  const ff = new FakeFirefox();
  const { w1, w2, real, copy } = twoWindows(ff);
  const asked = [];
  ff.hooks.query = async q => { if (q.audible !== undefined || q.muted !== undefined) asked.push(q); };
  const x = await start(ff, {});
  assert.equal(x.js("tidierAlone"), false);
  const here = sidebar(x, w2.id), there = sidebar(x, w1.id);
  await settle();
  play(ff, x, real.id);
  await settle();
  assert.equal(here.views.length, 1, "as before: another window's sound does not concern this one");
  assert.equal(row(here.view, copy.id).sound, null);
  assert.equal(row(there.view, real.id).sound, "playing");
  assert.equal(row(there.view, real.id).soundTabId, real.id);
  assert.deepEqual(there.view.spaces.filter(s => s.soundTabId), []);
  assert.deepEqual(asked, []);
  x.kill();
});
