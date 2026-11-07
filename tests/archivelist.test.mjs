// Tidier's own list of archived and closed tabs (archivelist.js), on the fake Firefox:
// what lands in it and in which space, its limits, and coming back from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, realSleep, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const LATER = () => Date.now() + 13 * 3600e3;

async function run(ff) {
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// One window, on a tab of no space, with the given tabs live in it: [key, address, the
// record's fields, the tab's own fields].
async function session(tabs, { alone = true, more } = {}) {
  const ff = new FakeFirefox();
  if (alone) ff.managed = { tidierAlone: true };
  ff.store.archiveSince = 1;
  ff.store.syncedTabs = Object.fromEntries(tabs.map(([key, url, props]) => [key, entry(url, props)]));
  more?.(ff);
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const ids = {};
  for (const [key, url, props, tab] of tabs) {
    ids[key] = ff.addTab(w.id, { url, title: props?.title ?? url, favIconUrl: props?.icon, discarded: true, cookieStoreId: props?.cookieStoreId ?? C1, lastAccessed: 1, ...tab }, { syncKey: key, syncRole: "live" }).id;
  }
  return { ff, w, ids, x: await run(ff) };
}
const placeholder = key => ({ url: GHOST("ghost", key) });

const listed = (x, space) => x.send({ type: "archivedTabs", space }).then(rows => JSON.parse(JSON.stringify(rows)));
const archive = (x, keys, now = LATER()) => x.send({ type: "archiveNow", now, keys, explain: true });

test("an archived tab lands in its space's list, and another space does not show it", async () => {
  const { x, ff } = await session([["a", "https://a.example/", { title: "Page A", icon: "https://a.example/i.png" }], ["b", "https://b.example/", { cookieStoreId: C2 }]]);
  await archive(x, ["a", "b"]);
  const [row, ...rest] = await listed(x, C1);
  assert.equal(rest.length, 0);
  assert.equal(row.url, "https://a.example/");
  assert.equal(row.title, "Page A");
  assert.equal(row.icon, "https://a.example/i.png");
  assert.equal(row.why, "archived");
  assert.ok(Date.now() - row.when < 60000, "the real time, not the pretended one");
  assert.deepEqual((await listed(x, C2)).map(r => r.url), ["https://b.example/"]);
  assert.deepEqual((await listed(x)).map(r => r.space).sort(), [C1, C2], "every space's, for the command bar");
  await wait(1000);
  assert.equal(ff.store.archivedTabs[C1][0].url, "https://a.example/", "written to storage");
  x.kill();
});

test("a tab you close lands in the list; a saved tab that only unloads and a pull request do not", async () => {
  const { x, ff, ids } = await session([
    ["plain", "https://plain.example/"],
    ["saved", "https://saved.example/", { parentKey: "F", saved: { url: "https://saved.example/", title: "Saved" } }, { discarded: false }],
    ["pr", "https://pr.example/", { parentKey: "F", liveFolder: "lf" }],
  ], { more: f => { f.store.syncedTabs.F = { group: true, own: true, name: "Folder", cookieStoreId: C1, parentKey: null, rank: 1, added: 1 }; } });
  ff.rm(ids.plain);
  ff.rm(ids.saved);
  ff.rm(ids.pr);
  await wait(1000);
  assert.deepEqual((await listed(x, C1)).map(r => [r.url, r.why]), [["https://plain.example/", "closed"]]);
  assert.ok(ff.synced.saved, "the saved tab is still there");
  x.kill();
});

test("a saved tab removed for good, and a placeholder you close, land with the real address", async () => {
  const { x, ff, ids } = await session([
    ["saved", "https://saved.example/", { title: "Saved", parentKey: "F", saved: { url: "https://saved.example/", title: "Saved" } }],
    ["held", "https://held.example/", { title: "Held" }, placeholder("held")],
  ], { more: f => { f.store.syncedTabs.F = { group: true, own: true, name: "Folder", cookieStoreId: C1, parentKey: null, rank: 1, added: 1 }; } });
  ff.rm(ids.saved);
  await wait(500);
  ff.rm(ids.held);
  await wait(1000);
  assert.deepEqual((await listed(x, C1)).map(r => [r.url, r.title]), [["https://held.example/", "Held"], ["https://saved.example/", "Saved"]]);
  x.kill();
});

test("moving a tab to another space does not list it", async () => {
  const { x, ids } = await session([["a", "https://a.example/"]]);
  await x.js("(id, s) => serial(() => moveToSpace(id, s))")(ids.a, C2);
  await wait(1000);
  assert.deepEqual(await listed(x), []);
  x.kill();
});

test("at most 200 per space, newest first, and the same address only once", async () => {
  const now = Date.now();
  const { x } = await session([["a", "https://a.example/"], ["b", "https://b.example/"]], { more: f => {
    f.store.archivedTabs = { [C1]: Array.from({ length: 200 }, (_, i) => ({ url: `https://old.example/${i}`, title: "o", icon: null, when: now - 1000 * (i + 1), why: "closed" })) };
  } });
  await archive(x, ["a"]);
  let rows = await listed(x, C1);
  assert.equal(rows.length, 200);
  assert.equal(rows[0].url, "https://a.example/");
  assert.equal(rows.at(-1).url, "https://old.example/198", "the oldest went");
  // The same address again: one row, at the top.
  await x.js("e => serial(() => noteArchived(e, 'closed'))")(entry("https://old.example/5"));
  rows = await listed(x, C1);
  assert.equal(rows.filter(r => r.url === "https://old.example/5").length, 1);
  assert.equal(rows[0].url, "https://old.example/5");
  assert.equal(rows.length, 200);
  x.kill();
});

test("entries older than 30 days are not shown, and go at the next close, in every space", async () => {
  const old = Date.now() - 31 * 24 * 3600e3, recent = Date.now() - 29 * 24 * 3600e3;
  const row = (url, when) => ({ url, title: url, icon: null, when, why: "archived" });
  const { x, ff } = await session([["a", "https://a.example/"]], { more: f => {
    f.store.archivedTabs = { [C1]: [row("https://recent.example/", recent), row("https://old.example/", old)], [C2]: [row("https://old2.example/", old)] };
  } });
  assert.deepEqual((await listed(x, C1)).map(r => r.url), ["https://recent.example/"]);
  assert.deepEqual(await listed(x, C2), []);
  assert.equal(ff.store.archivedTabs[C2].length, 1, "looking writes nothing");
  await archive(x, ["a"]);
  await wait(1000);
  assert.deepEqual(ff.store.archivedTabs[C1].map(r => r.url), ["https://a.example/", "https://recent.example/"]);
  assert.equal(ff.store.archivedTabs[C2], undefined);
  x.kill();
});

test("only web pages come in the list, and a space's and a tab without a container's rows are in one order", async () => {
  const { x, w } = await session([]);
  await x.js("e => serial(() => noteArchived(e, 'closed'))")(entry("about:preferences"));
  await x.js("e => serial(() => noteArchived(e, 'closed'))")(entry("moz-extension://tidier/sidebar/sidebar.html"));
  assert.deepEqual(await listed(x), []);
  const note = (url, cookieStoreId) => x.js("e => serial(() => noteArchived(e, 'closed'))")(entry(url, { cookieStoreId }));
  // (Real time between them: the list goes by the clock, and the fake's wait does not move it.)
  await note("https://first.example/", C1);
  await realSleep(5);
  await note("https://second.example/", "firefox-default");
  await realSleep(5);
  await note("https://third.example/", C1);
  assert.deepEqual((await listed(x, C1)).map(r => r.url), ["https://third.example/", "https://second.example/", "https://first.example/"]);
  assert.ok(w);
  x.kill();
});

test("a big icon stays out of the list", async () => {
  const big = "data:image/png;base64," + "x".repeat(5000);
  const { x } = await session([["a", "https://a.example/", { icon: big }]]);
  await archive(x, ["a"]);
  assert.equal((await listed(x, C1))[0].icon, null);
  x.kill();
});

test("reopening opens it in its container, selected, in every window, and removes it", async () => {
  const { x, ff, w } = await session([["a", "https://a.example/", { title: "Page A", icon: "https://a.example/i.png" }]], { more: f => {
    // A rule for this address: coming back to its own space, it must not be sent away.
    f.store.rules = [{ url: "a.example", space: C2 }];
  } });
  const other = ff.addWindow();
  await archive(x, ["a"]);
  assert.equal(await x.send({ type: "reopenArchived", item: { space: C1, url: "https://a.example/" }, windowId: w.id }), true);
  await wait(3000);
  const here = ff.list(w.id).find(t => t.url === "https://a.example/");
  assert.equal(here.cookieStoreId, C1);
  assert.equal(here.title, "Page A");
  assert.equal(here.active, true);
  assert.equal(here.discarded, false, "selecting it loads it");
  assert.deepEqual(await listed(x, C1), []);
  const record = Object.entries(ff.synced).find(([, e]) => e.url === "https://a.example/");
  assert.equal(record[1].title, "Page A");
  assert.equal(record[1].icon, "https://a.example/i.png");
  assert.equal(record[1].cookieStoreId, C1);
  const there = ff.list(other.id).filter(t => t.url === GHOST("ghost", record[0]));
  assert.equal(there.length, 1, "a placeholder in the other window");
  assert.equal(there[0].cookieStoreId, C1);
  assert.equal(ff.list(w.id).filter(t => t.url === "https://a.example/").length, 1, "once");
  x.kill();
});

test("reopening uses the place new tabs go, and the way past the rules", async () => {
  const { x, ff, w } = await session([["a", "https://a.example/"], ["b", "https://b.example/"]]);
  await archive(x, ["a"]);
  x.js("globalThis.topOfToday = async () => 1; globalThis.pastRules = []; globalThis.openUnruled = p => { pastRules.push(p.url); return browser.tabs.create(p); };");
  await x.send({ type: "reopenArchived", item: { space: C1, url: "https://a.example/" }, windowId: w.id });
  await wait(500);
  assert.equal(ff.list(w.id).findIndex(t => t.url === "https://a.example/"), 1);
  assert.deepEqual([...x.js("pastRules")], ["https://a.example/"]);
  x.kill();
});

test("a tab Firefox refuses to open stays in the list, and the line says so", async () => {
  const { x, ff, w } = await session([["a", "https://a.example/"]]);
  await archive(x, ["a"]);
  x.js("globalThis.said = []; globalThis.say = (win, text) => said.push(text);");
  ff.containers.delete(C1);
  await assert.rejects(x.send({ type: "reopenArchived", item: { space: C1, url: "https://a.example/" }, windowId: w.id }));
  assert.deepEqual((await listed(x, C1)).map(r => r.url), ["https://a.example/"]);
  assert.equal(x.js("said").length, 1);
  x.kill();
});

test("what is no longer in the list does not open, and × forgets", async () => {
  const { x, ff, w } = await session([["a", "https://a.example/"]]);
  await archive(x, ["a"]);
  await x.send({ type: "forgetArchived", item: { space: C1, url: "https://a.example/" } });
  assert.deepEqual(await listed(x, C1), []);
  const before = ff.list(w.id).length;
  assert.equal(await x.send({ type: "reopenArchived", item: { space: C1, url: "https://a.example/" }, windowId: w.id }), false);
  assert.equal(ff.list(w.id).length, before);
  x.kill();
});

test("a tab opened again by other means (⌘⇧T) leaves the list", async () => {
  const { x, ff, w } = await session([["a", "https://a.example/"]]);
  await archive(x, ["a"]);
  const t = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(t));
  await wait(2500);
  assert.deepEqual(await listed(x, C1), []);
  x.kill();
});

test("a removed container takes its list along", async () => {
  const { x } = await session([["a", "https://a.example/"], ["b", "https://b.example/", { cookieStoreId: C2 }]]);
  await archive(x, ["a", "b"]);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: C1 } });
  await wait(500);
  assert.deepEqual(await listed(x, C1), []);
  assert.equal((await listed(x, C2)).length, 1);
  x.kill();
});

test("every space's list leaves out a container that is gone, whatever left its rows behind", async () => {
  const { x, ff } = await session([["a", "https://a.example/"], ["b", "https://b.example/", { cookieStoreId: C2 }], ["c", "https://c.example/", { cookieStoreId: "firefox-default" }]]);
  await archive(x, ["a", "b", "c"]);
  ff.containers.delete(C1); // no event: removed while Tidier was not running, say
  assert.deepEqual((await listed(x)).map(r => r.space).sort(), ["firefox-default", C2].sort());
  x.kill();
});

test("a tab without a container shows in whichever space you are in, and comes back there", async () => {
  const { x, ff, w } = await session([["a", "https://a.example/", { cookieStoreId: "firefox-default" }]]);
  await archive(x, ["a"]);
  assert.deepEqual((await listed(x, C2)).map(r => r.space), ["firefox-default"]);
  x.js("(win, s) => activeSpace.set(win, s)")(w.id, C2);
  assert.equal(await x.send({ type: "reopenArchived", item: { space: "firefox-default", url: "https://a.example/" }, windowId: w.id }), true);
  assert.equal(ff.list(w.id).find(t => t.url === "https://a.example/").cookieStoreId, C2);
  assert.deepEqual(await listed(x, C1), [], "it left the list, though it opened in another space than it was listed under");
  x.kill();
});

// --- A tab that is only a placeholder --------------------------------------------------
test("a placeholder-only tab is archived with its real address, once it has been one for a while", async () => {
  const { x, ff } = await session([["held", "https://held.example/", { title: "Held" }, placeholder("held")]]);
  const now = Date.now();
  // Its time starts when it is first seen as a placeholder: the old date on it says nothing.
  let r = await archive(x, ["held"], now);
  assert.match(r.kept.held, /^used/);
  r = await archive(x, ["held"], now + 11 * 3600e3);
  assert.match(r.kept.held, /^used/);
  r = await archive(x, ["held"], now + 13 * 3600e3);
  assert.deepEqual([...r.archived], ["https://held.example/"]);
  assert.deepEqual((await listed(x, C1)).map(row => [row.url, row.title]), [["https://held.example/", "Held"]]);
  await wait(1000);
  assert.ok(!ff.synced.held);
  assert.equal(ff.list(ff.wins.keys().next().value).filter(t => t.url.includes("ghost.html")).length, 0);
  x.kill();
});

test("a placeholder that was selected ages by its own use again", async () => {
  const { x, ff, ids } = await session([["held", "https://held.example/", { placeholderSince: 5 }, { lastAccessed: Date.now() }]]);
  const r = await archive(x, ["held"], Date.now() + 3600e3);
  assert.match(r.kept.held, /^used/);
  assert.equal((await x.js("getSynced()")).held.placeholderSince, undefined);
  assert.ok(ff.tabs.has(ids.held));
  x.kill();
});

test("a placeholder you selected starts its time anew when it is one again, also if no check saw it in use", async () => {
  const { x, ff, ids, w } = await session([["held", "https://held.example/", {}, placeholder("held")]]);
  const page = ff.list(w.id).find(t => t.url === "about:home").id, now = Date.now();
  await archive(x, ["held"], now);
  assert.ok((await x.js("getSynced()")).held.placeholderSince, "its time has started");
  ff.select(ids.held); // the only way it becomes a page again; a check would stop at "selected"
  ff.select(page);
  await wait(100);
  assert.equal((await x.js("getSynced()")).held.placeholderSince, undefined);
  // Still a placeholder here (its window closed, handed over): 13 hours after that first time it stays.
  const r = await archive(x, ["held"], now + 13 * 3600e3);
  assert.match(r.kept.held, /^used 0 min/);
  x.kill();
});

test("a placeholder stays when the list cannot take it: it has no other way back", async () => {
  const { x, ff, ids } = await session([["held", "https://held.example/", {}, placeholder("held")], ["real", "https://real.example/"]]);
  const now = Date.now();
  await archive(x, ["held"], now); // its time starts
  const get = x.b.storage.local.get;
  x.b.storage.local.get = async k => { if ([k].flat().includes("archivedTabs")) throw new Error("no storage"); return get(k); };
  const r = await archive(x, ["held", "real"], now + 13 * 3600e3);
  assert.equal(r.kept.held, "no list");
  assert.ok(ff.tabs.has(ids.held));
  assert.ok((await x.js("getSynced()")).held);
  assert.deepEqual([...r.archived], ["https://real.example/"], "a real page has Recently Closed as well");
  assert.ok(!ff.tabs.has(ids.real));
  x.kill();
});

test("a tab that went while Tidier was not running lands in the list, and only with the setting on", async () => {
  for (const alone of [true, false]) {
    const { x, ff } = await session([["here", "https://here.example/"]], { alone, more: f => {
      f.store.syncedTabs.gone = entry("https://gone.example/", { title: "Gone" });
    } });
    assert.ok(!(await x.js("getSynced()")).gone, "the record goes either way");
    assert.deepEqual((await listed(x, C1)).map(r => [r.url, r.title, r.why]), alone ? [["https://gone.example/", "Gone", "closed"]] : []);
    if (!alone) assert.equal(ff.store.archivedTabs, undefined);
    x.kill();
  }
});

test("a list holding something it should not does not stop a close, in any window", async () => {
  const { x, ff, ids } = await session([["a", "https://a.example/"]], { more: f => { f.store.archivedTabs = { [C2]: "not rows" }; } });
  const other = ff.addWindow();
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "a"), discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  x.js("(id) => { syncKeyByTab.set(id, 'a'); syncRoleByTab.set(id, 'ghost'); }")(ghost.id);
  ff.rm(ids.a);
  await wait(1000);
  assert.ok(!ff.tabs.has(ghost.id), "closed everywhere");
  assert.ok(!(await x.js("getSynced()")).a);
  x.kill();
});

test("with the setting off, a placeholder is kept, and nothing is listed or written", async () => {
  const { x, ff, w, ids } = await session([
    ["held", "https://held.example/", {}, placeholder("held")],
    ["real", "https://real.example/"],
    ["closing", "https://closing.example/", {}, { lastAccessed: Date.now() }],
  ], { alone: false });
  const r = await archive(x, ["held", "real"]);
  assert.equal(r.kept.held, "placeholder");
  assert.equal((await x.js("getSynced()")).held.placeholderSince, undefined);
  assert.deepEqual([...r.archived], ["https://real.example/"]);
  ff.rm(ids.closing);
  await wait(1000);
  assert.deepEqual(await listed(x), []);
  assert.equal(await x.send({ type: "reopenArchived", item: { space: C1, url: "https://real.example/" }, windowId: w.id }), false);
  assert.equal(ff.store.archivedTabs, undefined);
  x.kill();
});

test("with nothing happening the list writes nothing", async () => {
  const { x, ff } = await session([["a", "https://a.example/"]]);
  await archive(x, ["a"]);
  await wait(1000);
  const writes = ff.storeWrites;
  await listed(x, C1);
  await wait(1000);
  assert.equal(ff.storeWrites, writes);
  x.kill();
});

test("the list comes back after a restart", async () => {
  const { x, ff } = await session([["a", "https://a.example/", { title: "Page A" }]]);
  await archive(x, ["a"]);
  await wait(1000);
  x.kill();
  const y = await run(ff);
  assert.deepEqual((await listed(y, C1)).map(r => [r.url, r.title]), [["https://a.example/", "Page A"]]);
  y.kill();
});

test("with no window asked for, it opens in the window you used last", async () => {
  const { x, ff, w } = await session([["a", "https://a.example/"]]);
  const other = ff.addWindow();
  await archive(x, ["a"]);
  ff.focused = other.id;
  assert.equal(await x.js("item => reopenArchived(item)")({ space: C1, url: "https://a.example/" }), true);
  assert.ok(ff.list(other.id).some(t => t.url === "https://a.example/"));
  assert.ok(!ff.list(w.id).some(t => t.url === "https://a.example/"));
  x.kill();
});

test("a list that cannot be read does not stop a close", async () => {
  const { x, ff, ids, w } = await session([["a", "https://a.example/"]]);
  const other = ff.addWindow();
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "a"), discarded: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  x.js("(id) => { syncKeyByTab.set(id, 'a'); syncRoleByTab.set(id, 'ghost'); }")(ghost.id);
  const get = x.b.storage.local.get;
  x.b.storage.local.get = async k => { if ([k].flat().includes("archivedTabs")) throw new Error("no storage"); return get(k); };
  ff.rm(ids.a);
  await wait(1000);
  assert.ok(!ff.tabs.has(ghost.id), "closed everywhere");
  assert.ok(x.errors.some(e => e.includes("no storage")));
  x.b.storage.local.get = get; // it tries again next time
  assert.deepEqual(await listed(x, C1), []);
  assert.ok(w);
  x.kill();
});

test("a space you switch to is kept with the window, also after one opened from the list", async () => {
  const { x, w } = await session([["a", "https://a.example/", { cookieStoreId: C2 }]]);
  const kept = {};
  x.b.sessions.setWindowValue = async (id, name, value) => { kept[name] = value; };
  await archive(x, ["a"]);
  await wait(1000); // closing a tab: for a moment after it, Firefox's next selection does not take you away (closedIn, spaces.js)
  await x.send({ type: "reopenArchived", item: { space: C2, url: "https://a.example/" }, windowId: w.id });
  await x.js("serial(() => {})");
  assert.equal(kept.space, C2, "the selected tab takes you to its space");
  await x.js("(win, s) => serial(() => switchSpace(win, s))")(w.id, C1);
  assert.equal(kept.space, C1, "an older space would come back after a restart");
  x.kill();
});

test("Clear's tabs can be found in the list, and Undo takes them out again", async () => {
  const { x, w } = await session([["a", "https://a.example/"], ["b", "https://b.example/"]]);
  await x.js("clearSpace")(w.id, C1);
  await wait(300);
  assert.deepEqual((await listed(x, C1)).map(r => r.url).sort(), ["https://a.example/", "https://b.example/"]);
  await x.js("serial")(x.js("quietNotes").get(w.id).undo);
  await wait(300);
  assert.deepEqual(await listed(x, C1), [], "they are open again");
  x.kill();
});
