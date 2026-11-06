// The quiet line, undo and Clear (quiet.js) on the fake Firefox: what is remembered,
// what comes back, and what must stay put. What is drawn is in the smoke test
// (alone_quiet_undo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, realSleep, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const folder = (name, rank, more = {}) => ({ group: true, own: true, name, cookieStoreId: C1, parentKey: null, rank, added: 1, ...more });
const addr = k => `https://${k}.example/`;

async function alone(ff, { on = true } = {}) {
  if (on) ff.managed = { tidierAlone: true };
  closedList(ff);
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  sessionsRestore(ff, x);
  return x;
}

// Recently Closed as Firefox's source has it: a real page goes in, with no container,
// per window; a tab marked as never loaded has no entry at all.
function closedList(ff) {
  const rm = ff.rm.bind(ff);
  let id = 0;
  ff.recentlyClosed = [];
  ff.rm = (tabId, o) => {
    const t = ff.tabs.get(tabId);
    if (t && !t.neverLoaded && !t.url.startsWith("about:")) {
      ff.recentlyClosed.unshift({ lastModified: Date.now(), tab: { sessionId: String(++id), url: t.url, title: t.title, windowId: t.windowId, was: { ...t }, values: { ...ff.values.get(tabId) } } });
    }
    rm(tabId, o);
  };
}

// sessions.restore as in Firefox's source: the tab is back selected, on about:blank for a
// moment, with its values, and the page follows.
function sessionsRestore(ff, x) {
  ff.restored = [];
  x.b.sessions.restore = async sessionId => {
    const at = ff.recentlyClosed.findIndex(c => c.tab.sessionId === sessionId);
    if (at < 0) throw new Error(`Could not restore object using sessionId ${sessionId}.`);
    const [{ tab: c }] = ff.recentlyClosed.splice(at, 1);
    const t = ff.addTab(c.windowId, { url: "about:blank", title: c.title, cookieStoreId: c.was.cookieStoreId }, c.values);
    ff.restored.push(t.id);
    x.b.tabs.onCreated.fire(ff.snap(t));
    ff.select(t.id);
    // (Unloaded meanwhile, it still has its address.)
    setTimeout(() => { const now = ff.tabs.get(t.id); if (!now) return; const { discarded } = now; ff.navigate(t.id, c.url, c.title); now.discarded = discarded; }, 0);
    return { lastModified: Date.now(), tab: ff.snap(t) };
  };
}

// The sidebar's end of it: what a window's sidebar sends, and every view it is sent.
function sidebar(x, windowId) {
  const listeners = [];
  const port = {
    name: "sidebar", sender: { id: "tidier" }, views: [],
    onMessage: { addListener: f => listeners.push(f) },
    onDisconnect: { addListener() {} },
    postMessage(v) { this.views.push(v); },
    send(msg) { for (const f of listeners) f(msg); },
  };
  for (const { f } of x.b.runtime.onConnect.ls) f(port);
  port.send({ type: "hello", windowId });
  return port;
}

const noteIn = (x, windowId) => x.js("noteFor")(windowId);
// A note's own undo, so that a busy machine letting the note's short time in the fake
// Firefox run out does not fail the test. The message itself is the smoke test's.
const undoOf = (x, windowId) => { const n = x.js("quietNotes").get(windowId); assert.ok(n?.undo, "there is an undo"); return x.js("serial")(n.undo); };
const said = port => port.views.map(v => v.note?.text).filter(Boolean);

// Two windows with the same tabs, a live one in the first and a ghost in the second.
function twoWindows(ff, keys, { active = keys[0] } = {}) {
  ff.store.syncedTabs = { ...ff.store.syncedTabs };
  const w = ff.addWindow({ focused: true }), other = ff.addWindow();
  for (const k of keys) {
    ff.store.syncedTabs[k] ??= entry(addr(k));
    ff.addTab(w.id, { url: addr(k), title: k, active: k === active, cookieStoreId: C1 }, { syncKey: k, syncRole: "live" });
    ff.addTab(other.id, { url: GHOST("ghost", k), title: k, discarded: true, active: k === keys.at(-1), cookieStoreId: C1 }, { syncKey: k, syncRole: "ghost" });
  }
  return { w, other };
}
const keysOf = (ff, windowId) => ff.list(windowId).filter(t => !t.pinned).map(t => ff.values.get(t.id)?.syncKey);
const tabOf = (ff, windowId, k) => ff.list(windowId).find(t => ff.values.get(t.id)?.syncKey === k);

test("closes within a moment are one group, and the line offers to undo them", async () => {
  const ff = new FakeFirefox();
  const { w } = twoWindows(ff, ["a", "b", "c", "d"]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  for (const k of ["b", "c", "d"]) port.send({ type: "close", tabId: tabOf(ff, w.id, k).id });
  await wait(1000);
  assert.deepEqual(keysOf(ff, w.id), ["a"]);
  assert.ok(said(port).includes("3 tabs closed"), String(said(port)));
  assert.equal(port.views.filter(v => v.note).at(-1).note.undo, true);
  x.kill();
});

test("closes apart from each other are not a group", async () => {
  const ff = new FakeFirefox();
  const { w } = twoWindows(ff, ["a", "b", "c"]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  port.send({ type: "close", tabId: tabOf(ff, w.id, "b").id });
  await wait(1000);
  port.send({ type: "close", tabId: tabOf(ff, w.id, "c").id });
  await wait(1000);
  assert.deepEqual(said(port), [], "an ordinary tab closed on its own says nothing: ⌘⇧T has it");
  assert.equal(x.js("closeGroups").size, 0);
  x.kill();
});

test("a saved tab removed for good is offered back, and a loaded one only unloads", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: folder("Work", 1),
    placeholder: entry(addr("placeholder"), { parentKey: "F", saved: { url: addr("placeholder"), title: "P" } }),
    loaded: entry(addr("loaded"), { parentKey: "F", saved: { url: addr("loaded"), title: "L" } }),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: addr("here"), active: true, cookieStoreId: C1 });
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "placeholder"), discarded: true, cookieStoreId: C1 }, { syncKey: "placeholder", syncRole: "ghost" });
  const loaded = ff.addTab(w.id, { url: addr("loaded"), cookieStoreId: C1 }, { syncKey: "loaded", syncRole: "live" });
  const x = await alone(ff);
  const port = sidebar(x, w.id);

  port.send({ type: "close", tabId: loaded.id });
  await wait(1000);
  assert.deepEqual(said(port), [], "it is still there, unloaded");
  assert.ok(ff.synced.loaded);

  port.send({ type: "close", tabId: ghost.id });
  await wait(1000);
  assert.ok(!ff.synced.placeholder);
  assert.deepEqual([...new Set(said(port))], ["Tab removed"]);
  await undoOf(x, w.id);
  await wait(500);
  assert.equal(ff.synced.placeholder.parentKey, "F");
  assert.deepEqual(ff.synced.placeholder.saved, { url: addr("placeholder"), title: "P" });
  assert.ok(tabOf(ff, w.id, "placeholder"));
  x.kill();
});

test("an essential closed in the sidebar is not remembered", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: addr("e"), cookieStoreId: C1, title: "E", icon: "x" }];
  ff.store.syncedTabs = { a: entry(addr("a")) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: addr("a"), active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const pin = ff.addTab(w.id, { url: addr("e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  port.send({ type: "close", tabId: pin.id });
  await wait(2000);
  assert.deepEqual(said(port), []);
  x.kill();
});

test("undo brings tabs back in their place in every window, with no new key and the selection kept", async () => {
  const ff = new FakeFirefox();
  const { w, other } = twoWindows(ff, ["a", "b", "c", "d", "e"]);
  const never = tabOf(ff, w.id, "d");
  ff.tabs.get(never.id).neverLoaded = true;
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  const before = [keysOf(ff, w.id), keysOf(ff, other.id)];
  for (const k of ["b", "c", "d"]) port.send({ type: "close", tabId: tabOf(ff, w.id, k).id });
  await wait(1000);
  assert.deepEqual(keysOf(ff, w.id), ["a", "e"]);
  assert.deepEqual(keysOf(ff, other.id), ["a", "e"], "gone in the other window too");
  await undoOf(x, w.id);
  await wait(1000);
  assert.deepEqual([keysOf(ff, w.id), keysOf(ff, other.id)], before);
  assert.equal(ff.restored.length, 2, "pages with history come back from Recently Closed");
  assert.equal(ff.list(w.id).find(t => t.active).id, tabOf(ff, w.id, "a").id, "the tab you were on is still selected");
  for (const k of ["b", "c"]) assert.equal(tabOf(ff, w.id, k).discarded, true, "brought back, not loaded");
  assert.ok(tabOf(ff, w.id, "d").url.startsWith(GHOST("ghost", "d")), "a tab never loaded has no entry there, and comes back as a placeholder");
  assert.equal(tabOf(ff, other.id, "b").url, GHOST("ghost", "b"));
  assert.deepEqual(Object.keys(ff.synced).sort(), ["a", "b", "c", "d", "e"]);
  // Each has one tab in each window, and the page is its live tab.
  for (const k of ["b", "c"]) {
    assert.equal(ff.list(w.id).filter(t => ff.values.get(t.id)?.syncKey === k).length, 1);
    assert.equal(ff.values.get(tabOf(ff, w.id, k).id).syncRole, "live");
  }
  // Nothing registers them a second time once they have settled.
  await wait(2500);
  assert.deepEqual(Object.keys(ff.synced).sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("what a page says for a moment while it comes back does not rewrite its title", async () => {
  const ff = new FakeFirefox();
  const { w } = twoWindows(ff, ["a", "b", "c"]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  const was = ff.synced.b.title;
  for (const k of ["b", "c"]) port.send({ type: "close", tabId: tabOf(ff, w.id, k).id });
  await wait(1000);
  for (const c of ff.recentlyClosed) c.tab.title = "Loading";
  await undoOf(x, w.id);
  await wait(1000);
  assert.equal(ff.synced.b.title, was);
  x.kill();
});

test("a tab brought back is not sent elsewhere by a rule", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "b.example", space: C2 }];
  const { w } = twoWindows(ff, ["a", "b", "c"]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  for (const k of ["b", "c"]) port.send({ type: "close", tabId: tabOf(ff, w.id, k).id });
  await wait(1000);
  await undoOf(x, w.id);
  await wait(2500);
  assert.equal(tabOf(ff, w.id, "b").cookieStoreId, C1);
  assert.equal(ff.list(w.id).filter(t => t.cookieStoreId === C2).length, 0);
  x.kill();
});

test("the same address closed in another container does not come back as this tab", async () => {
  const ff = new FakeFirefox();
  const { w } = twoWindows(ff, ["a", "b", "c"]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  for (const k of ["b", "c"]) port.send({ type: "close", tabId: tabOf(ff, w.id, k).id });
  await wait(1000);
  // What Recently Closed has for this address is another space's tab, closed since.
  ff.recentlyClosed.find(c => c.tab.url === addr("b")).tab.was.cookieStoreId = C2;
  await undoOf(x, w.id);
  await wait(1000);
  assert.equal(tabOf(ff, w.id, "b").cookieStoreId, C1);
  assert.ok(tabOf(ff, w.id, "b").url.startsWith(GHOST("ghost", "b")));
  assert.equal(ff.list(w.id).filter(t => t.cookieStoreId === C2).length, 0, "the wrong one is closed again");
  x.kill();
});

test("a pull request tab brought back is no longer dismissed", async () => {
  const ff = new FakeFirefox();
  const pr = addr("pr");
  ff.store.liveFolders = { prs: { groupKey: "F", dismissed: [] } };
  ff.store.syncedTabs = { F: folder("PRs", 1, { live: "prs" }), pr: entry(pr, { liveUrl: pr, liveFolder: "prs", parentKey: "F" }) };
  const { w } = twoWindows(ff, ["a", "b", "pr"]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  for (const k of ["b", "pr"]) port.send({ type: "close", tabId: tabOf(ff, w.id, k).id });
  await wait(1000);
  assert.deepEqual((await x.js("liveFolderState").get()).prs.dismissed, [pr]);
  await undoOf(x, w.id);
  await wait(500);
  assert.deepEqual((await x.js("liveFolderState").get()).prs.dismissed, []);
  assert.equal(ff.synced.pr.parentKey, "F");
  x.kill();
});

test("the line goes by itself, and at the next say", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: addr("a"), active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  x.js("say")(w.id, "First");
  x.js("say")(w.id, "Second");
  assert.equal(noteIn(x, w.id).text, "Second");
  assert.equal(noteIn(x, w.id).undo, false, "at most one action, only if asked for");
  await wait(11000);
  assert.equal(noteIn(x, w.id), null);
  assert.equal(port.views.at(-1).note, null, "the sidebar is told");
  assert.equal(x.js("quietNotes").size, 0);
  x.kill();
});

test("a closed window's line is forgotten", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: addr("a"), active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  x.js("say")(w.id, "Something");
  x.b.windows.onRemoved.fire(w.id);
  assert.equal(x.js("quietNotes").size, 0);
  x.kill();
});

test("Clear leaves the selected tab, folders and essentials, in every window", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: addr("e"), cookieStoreId: C1, title: "E", icon: "x" }];
  ff.store.syncedTabs = { F: folder("Work", 1), kept: entry(addr("kept"), { parentKey: "F", saved: { url: addr("kept"), title: "K" } }), far: entry(addr("far"), { cookieStoreId: C2 }) };
  const { w, other } = twoWindows(ff, ["a", "b", "c", "kept"], { active: "b" });
  const far = ff.addTab(w.id, { url: addr("far"), cookieStoreId: C2 }, { syncKey: "far", syncRole: "live" });
  const blank = ff.addTab(w.id, { url: "about:newtab", cookieStoreId: C1 });
  const settings = ff.addTab(w.id, { url: "about:preferences" });
  ff.addTab(w.id, { url: addr("e"), pinned: true, cookieStoreId: C1 }, { essentialKey: "e" });
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  const keysHere = ff.list(w.id).length;
  port.send({ type: "clearSpace", space: C1 });
  await wait(1000);
  assert.deepEqual(Object.keys(ff.synced).sort(), ["F", "b", "far", "kept"]);
  assert.ok(!tabOf(ff, w.id, "a"), "an ordinary tab goes");
  assert.ok(!tabOf(ff, other.id, "a"), "in every window");
  assert.ok(tabOf(ff, w.id, "b").active, "the tab you are on stays");
  assert.ok(tabOf(ff, w.id, "kept"), "a tab in a folder stays");
  assert.ok(ff.tabs.has(far.id), "another space's tab stays");
  assert.ok(!ff.tabs.has(blank.id), "a new tab page has nothing to lose");
  assert.ok(ff.tabs.has(settings.id), "a page with no way back stays");
  assert.ok(ff.list(w.id).some(t => t.pinned), "an essential stays");
  assert.ok(ff.list(w.id).length < keysHere);
  assert.deepEqual([...new Set(said(port))], ["2 tabs closed"]);
  x.kill();
});

test("Clear keeps a tab selected in another window, so nothing jumps there", async () => {
  const ff = new FakeFirefox();
  const { w, other } = twoWindows(ff, ["a", "b", "c"], { active: "a" });
  assert.ok(tabOf(ff, other.id, "c").active);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  port.send({ type: "clearSpace", space: C1 });
  await wait(1000);
  assert.deepEqual(keysOf(ff, w.id), ["a", "c"]);
  assert.deepEqual([...new Set(said(port))], ["1 tab closed"]);
  x.kill();
});

test("a page that refuses to unload stays, and the line says how many stayed", async () => {
  const ff = new FakeFirefox();
  const { w } = twoWindows(ff, ["a", "b", "c", "d"]);
  ff.refuseDiscard = new Set([tabOf(ff, w.id, "b").id]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  port.send({ type: "clearSpace", space: C1 });
  await wait(1000);
  assert.deepEqual(keysOf(ff, w.id), ["a", "b", "d"]);
  assert.ok(ff.synced.b, "kept, without asking");
  assert.deepEqual([...new Set(said(port))], ["1 tab closed, 1 stayed"]);
  await undoOf(x, w.id);
  await wait(500);
  assert.deepEqual(keysOf(ff, w.id), ["a", "b", "c", "d"], "and undo puts back only what went");
  x.kill();
});

test("a Clear that closes nothing only says what stayed, or nothing", async () => {
  const ff = new FakeFirefox();
  const { w } = twoWindows(ff, ["a", "b", "c"]);
  ff.refuseDiscard = new Set([tabOf(ff, w.id, "b").id]);
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  port.send({ type: "clearSpace", space: C1 });
  await wait(1000);
  assert.deepEqual([...new Set(said(port))], ["1 tab with unsaved input stayed"]);
  assert.equal(noteIn(x, w.id).undo, false);
  port.views.length = 0;
  x.js("dropNote")(w.id);
  await wait(200);
  port.send({ type: "clearSpace", space: C2 });
  await wait(1000);
  assert.deepEqual(said(port), []);
  x.kill();
});

test("a deleted folder's tabs count as new, and undo gives back its name, place and tabs", async () => {
  const ff = new FakeFirefox();
  const saved = { url: addr("a"), title: "A" };
  ff.store.syncedTabs = {
    F: folder("First", 1), G: folder("Second", 2, { collapsed: true }), H: folder("Third", 3),
    a: entry(addr("a"), { parentKey: "G", saved, added: 5 }),
    b: entry(addr("b"), { parentKey: "G", saved: { url: addr("b") }, added: 6 }),
  };
  const { w, other } = twoWindows(ff, ["a", "b", "c"], { active: "c" });
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  const t0 = Date.now();
  port.send({ type: "deleteFolder", key: "G" });
  await wait(1000);
  assert.ok(!ff.synced.G);
  for (const k of ["a", "b"]) {
    assert.equal(ff.synced[k].parentKey, null);
    assert.equal(ff.synced[k].saved, undefined, "no longer saved");
    assert.ok(ff.synced[k].added >= t0, "so archiving does not take it at its next look");
  }
  // The tabs are still there, where they were.
  assert.deepEqual(keysOf(ff, w.id), ["a", "b", "c"]);
  assert.deepEqual([...new Set(said(port))], ["Folder deleted"]);

  await undoOf(x, w.id);
  await wait(500);
  assert.deepEqual({ name: ff.synced.G.name, rank: ff.synced.G.rank, collapsed: ff.synced.G.collapsed }, { name: "Second", rank: 2, collapsed: true });
  assert.deepEqual([...x.js("foldersOf")(ff.synced, C1)].map(f => f.name), ["First", "Second", "Third"]);
  assert.equal(ff.synced.a.parentKey, "G");
  assert.deepEqual(ff.synced.a.saved, saved);
  assert.equal(ff.synced.a.added, 5);
  assert.deepEqual(keysOf(ff, other.id), ["a", "b", "c"]);
  x.kill();
});

test("undo of a deleted live folder brings its tabs back too", async () => {
  const ff = new FakeFirefox();
  const pr = addr("pr");
  ff.store.syncedTabs = { F: folder("PRs", 1, { live: "prs" }), pr: entry(pr, { liveUrl: pr, liveFolder: "prs", parentKey: "F" }) };
  const { w, other } = twoWindows(ff, ["a", "pr"], { active: "a" });
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  port.send({ type: "deleteFolder", key: "F" });
  await wait(1000);
  assert.ok(!ff.synced.pr, "the search decides what is in it");
  assert.deepEqual(keysOf(ff, other.id), ["a"]);
  await undoOf(x, w.id);
  await wait(500);
  assert.equal(ff.synced.pr.parentKey, "F");
  assert.deepEqual(keysOf(ff, w.id), ["a", "pr"]);
  assert.deepEqual(keysOf(ff, other.id), ["a", "pr"]);
  x.kill();
});

test("a folder gone in the meantime leaves its tab an ordinary tab", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: folder("Work", 1), s: entry(addr("s"), { parentKey: "F", saved: { url: addr("s") } }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: addr("a"), active: true, cookieStoreId: C1 });
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "s"), discarded: true, cookieStoreId: C1 }, { syncKey: "s", syncRole: "ghost" });
  const x = await alone(ff);
  const port = sidebar(x, w.id);
  port.send({ type: "close", tabId: ghost.id });
  await wait(1000);
  const { undo } = x.js("quietNotes").get(w.id);
  await x.js("deleteFolder")("F");
  await x.js("serial")(undo);
  await wait(500);
  assert.equal(ff.synced.s.parentKey, null);
  assert.equal(ff.synced.s.saved, undefined);
  x.kill();
});

test("with the setting off, a close only closes and nothing is said or remembered", async () => {
  const ff = new FakeFirefox();
  const { w } = twoWindows(ff, ["a", "b", "c"]);
  const x = await alone(ff, { on: false });
  assert.equal(x.js("tidierAlone"), false);
  const port = sidebar(x, w.id);
  for (const k of ["b", "c"]) port.send({ type: "close", tabId: tabOf(ff, w.id, k).id });
  await wait(1000);
  x.js("say")(w.id, "Nothing to see");
  await realSleep(1);
  assert.equal(x.js("closeGroups").size, 0);
  assert.equal(x.js("quietNotes").size, 0);
  assert.deepEqual(said(port), []);
  assert.equal(ff.list(w.id).filter(t => t.id && ff.values.get(t.id)?.syncKey === "b").length, 0, "closed as before");
  // And the actions behind the setting do nothing.
  const left = ff.list(w.id).length;
  port.send({ type: "clearSpace", space: C1 });
  await wait(500);
  assert.equal(ff.list(w.id).length, left);
  x.kill();
});
