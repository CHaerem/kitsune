// Moves that cannot lose anything (safemoves.js), on the fake Firefox, and the sidebar
// that comes back (sidebar/reconnect.js) on a stand-in for its page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const A = "firefox-container-1", B = "firefox-container-2", GONE = "firefox-container-9";
const SITE = "https://work.example/page";

async function alone(ff) {
  ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  // Stands in for the quiet line (quiet.js).
  x.js("globalThis.said = []; globalThis.say = (windowId, text) => { said.push(text); };");
  return x;
}
const said = x => [...x.js("said")];
const move = async (x, tabId, space) => { await x.js("serial")(() => x.js("moveToSpace")(tabId, space)); await wait(700); };

// A window on space A: a tab to go back to, and the tab that will be moved.
function aWindow(ff, { selected = false, url = SITE } = {}) {
  const w = ff.addWindow({ focused: true });
  const other = ff.addTab(w.id, { url: "https://home.example/", active: !selected, cookieStoreId: A, lastAccessed: 1000 }, { syncKey: "home", syncRole: "live" });
  const tab = ff.addTab(w.id, { url, active: selected, cookieStoreId: A, lastAccessed: 500 }, { syncKey: "moved", syncRole: "live" });
  ff.store.syncedTabs = {
    home: { url: "https://home.example/", title: "Home", cookieStoreId: A, parentKey: null, group: false, added: 1 },
    moved: { url, title: "Moved", cookieStoreId: A, parentKey: null, group: false, added: 1 },
  };
  return { w, other, tab };
}

// The sidebar's side of the connection, as sidebar.js has it.
function aPort(x, windowId) {
  const ls = { message: [], disconnect: [] }, views = [];
  const port = { name: "sidebar", sender: { id: "tidier" }, postMessage: v => views.push(v),
    onMessage: { addListener: f => ls.message.push(f) }, onDisconnect: { addListener: f => ls.disconnect.push(f) } };
  x.b.runtime.onConnect.fire(port);
  const send = msg => ls.message.forEach(f => f(msg));
  send({ type: "hello", windowId });
  return { views, send };
}
const realWait = ms => new Promise(r => setTimeout(r, ms));
const until = async test => { for (let i = 0; i < 500 && !test(); i++) await realWait(2); assert.ok(test()); };

// --- A move by hand is not undone by a rule ---------------------------------------
for (const blankFirst of [true, "early"]) {
  test(`a tab moved by hand stays, with a rule for its site in the space it left (address ${blankFirst === "early" ? "before" : "after"} the answer)`, async () => {
    const ff = new FakeFirefox();
    ff.store.rules = [{ url: "work.example", space: A }];
    const { w, tab } = aWindow(ff);
    const x = await alone(ff);
    ff.blankFirst = blankFirst;
    await move(x, tab.id, B);
    assert.ok(!ff.tabs.has(tab.id), "the old tab is closed");
    const there = ff.list(w.id).filter(t => t.url === SITE);
    assert.deepEqual(there.map(t => t.cookieStoreId), [B], "there once, in the space you chose");
    assert.equal(x.js("unruled.size"), 0, "nothing is kept for it");
    // The same tab going through the address again later is no new tab either.
    ff.navigate(there[0].id, SITE + "?again");
    await wait(300);
    assert.equal(ff.tabs.get(there[0].id).cookieStoreId, B);
    x.kill();
  });
}

test("openUnruled called outside the queue: a byRule that starts first waits for the answer", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: A }];
  const { w } = aWindow(ff);
  const x = await alone(ff);
  ff.blankFirst = "early";
  const made = await x.js("openUnruled")({ windowId: w.id, cookieStoreId: B, url: SITE + "?new" });
  await wait(300);
  assert.equal(ff.tabs.get(made.id).cookieStoreId, B);
  x.kill();
});

test("a placeholder that loads itself later is not sent away by a rule", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: A }];
  const { w } = aWindow(ff);
  ff.store.syncedTabs.there = { url: SITE, title: "There", cookieStoreId: B, parentKey: null, group: false, added: 1 };
  const x = await alone(ff);
  // As it is in Firefox: announced on about:blank, its page loaded when it is selected.
  const ghost = ff.addTab(w.id, { url: "about:blank", cookieStoreId: B });
  x.b.tabs.onCreated.fire(ff.snap(ghost));
  await x.js("setRole")(ghost.id, "there", "ghost");
  ff.navigate(ghost.id, GHOST("ghost", "there"));
  await wait(100);
  ff.navigate(ghost.id, SITE);
  await wait(500);
  assert.ok(ff.tabs.has(ghost.id));
  assert.equal(ff.tabs.get(ghost.id).cookieStoreId, B);
  x.kill();
});

test("a tab brought back with its Tidier values is not sent away by a rule", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: A }];
  const { w } = aWindow(ff);
  const x = await alone(ff);
  const back = ff.addTab(w.id, { url: "about:blank", cookieStoreId: B }, { syncKey: "closed-earlier", syncRole: "live" });
  x.b.tabs.onCreated.fire(ff.snap(back));
  ff.navigate(back.id, SITE);
  await wait(500);
  assert.ok(ff.tabs.has(back.id));
  assert.equal(ff.tabs.get(back.id).cookieStoreId, B);
  x.kill();
});

test("a new tab still goes by the rule", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: A }];
  const { w } = aWindow(ff);
  const x = await alone(ff);
  ff.blankFirst = true;
  const made = await x.b.tabs.create({ windowId: w.id, cookieStoreId: B, url: SITE + "?new" });
  await wait(500);
  assert.ok(!ff.tabs.has(made.id), "reopened");
  assert.deepEqual(ff.list(w.id).filter(t => t.url === SITE + "?new").map(t => t.cookieStoreId), [A]);
  x.kill();
});

// --- A move that keeps the page ---------------------------------------------------
test("a selected tab can move: you go to the tab used last in its space, and stay in that space", async () => {
  const ff = new FakeFirefox();
  const { w, other, tab } = aWindow(ff, { selected: true });
  const x = await alone(ff);
  await move(x, tab.id, B);
  assert.ok(!ff.tabs.has(tab.id));
  assert.deepEqual(ff.list(w.id).filter(t => t.url === SITE).map(t => t.cookieStoreId), [B]);
  assert.equal(ff.tabs.get(other.id).active, true);
  assert.equal(x.js("activeSpace").get(w.id), A);
  assert.deepEqual(said(x), []);
  x.kill();
});

test("the last tab of a space can move: you stay in that space, on a new tab", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const tab = ff.addTab(w.id, { url: SITE, active: true, cookieStoreId: A }, { syncKey: "moved", syncRole: "live" });
  ff.store.syncedTabs = { moved: { url: SITE, title: "Moved", cookieStoreId: A, parentKey: null, group: false, added: 1 } };
  const x = await alone(ff);
  await move(x, tab.id, B);
  assert.ok(!ff.tabs.has(tab.id));
  const on = ff.list(w.id).find(t => t.active);
  assert.equal(on.cookieStoreId, A);
  assert.equal(x.js("activeSpace").get(w.id), A);
  x.kill();
});

test("a page that may hold unsaved input stays, and the line says so", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = aWindow(ff);
  ff.refuseDiscard = new Set([tab.id]);
  const x = await alone(ff);
  await move(x, tab.id, B);
  assert.ok(ff.tabs.has(tab.id));
  assert.equal(ff.tabs.get(tab.id).discarded, false);
  assert.deepEqual(ff.list(w.id).filter(t => t.url === SITE).map(t => t.cookieStoreId), [A], "not opened there as well");
  assert.deepEqual(Object.keys(ff.synced).sort(), ["home", "moved"]);
  assert.deepEqual(said(x), ["One tab holds unsaved input and stayed here"]);
  x.kill();
});

test("a selected page that may hold unsaved input stays selected", async () => {
  const ff = new FakeFirefox();
  const { w, other, tab } = aWindow(ff, { selected: true });
  ff.refuseDiscard = new Set([tab.id]);
  const x = await alone(ff);
  await move(x, tab.id, B);
  assert.equal(ff.tabs.get(tab.id).active, true, "back on it");
  assert.equal(ff.tabs.get(other.id).active, false);
  assert.equal(ff.list(w.id).length, 2);
  assert.deepEqual(said(x), ["One tab holds unsaved input and stayed here"]);
  x.kill();
});

test("the last tab of a space, with unsaved input, stays selected, and the new tab goes again", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const tab = ff.addTab(w.id, { url: SITE, active: true, cookieStoreId: A }, { syncKey: "moved", syncRole: "live" });
  ff.store.syncedTabs = { moved: { url: SITE, title: "Moved", cookieStoreId: A, parentKey: null, group: false, added: 1 } };
  ff.refuseDiscard = new Set([tab.id]);
  const x = await alone(ff);
  await move(x, tab.id, B);
  assert.equal(ff.tabs.get(tab.id).active, true);
  assert.deepEqual(ff.list(w.id).map(t => t.id), [tab.id]);
  x.kill();
});

test("a row can be a placeholder: what counts is the real page, loaded in another window", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = aWindow(ff);
  const second = ff.addWindow();
  const ghost = ff.addTab(second.id, { url: GHOST("ghost", "moved"), cookieStoreId: A, discarded: true }, { syncKey: "moved", syncRole: "ghost" });
  ff.addTab(second.id, { url: GHOST("ghost", "home"), cookieStoreId: A, discarded: true }, { syncKey: "home", syncRole: "ghost" });
  ff.refuseDiscard = new Set([tab.id]);
  const x = await alone(ff);
  await move(x, ghost.id, B);
  assert.ok(ff.tabs.has(tab.id) && ff.tabs.has(ghost.id), "both stay");
  assert.deepEqual(said(x), ["One tab holds unsaved input and stayed here"]);
  ff.refuseDiscard.clear();
  await move(x, ghost.id, B);
  assert.ok(!ff.tabs.has(tab.id) && !ff.tabs.has(ghost.id), "closed in every window");
  assert.deepEqual([...ff.tabs.values()].filter(t => t.url === SITE).map(t => [t.windowId, t.cookieStoreId]), [[second.id, B]]);
  assert.equal(ff.tabs.get(ff.list(w.id)[0].id).url, "https://home.example/");
  x.kill();
});

test("several tabs that stay say so in one line", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = aWindow(ff);
  const more = ff.addTab(w.id, { url: "https://more.example/", cookieStoreId: A }, { syncKey: "more", syncRole: "live" });
  ff.store.syncedTabs.more = { url: "https://more.example/", title: "More", cookieStoreId: A, parentKey: null, group: false, added: 1 };
  ff.refuseDiscard = new Set([tab.id, more.id]);
  const x = await alone(ff);
  await x.js("serial")(() => x.js("moveToSpace")(tab.id, B));
  await x.js("serial")(() => x.js("moveToSpace")(more.id, B));
  assert.deepEqual(said(x).at(-1), "2 tabs hold unsaved input and stayed here");
  await wait(2500);
  await x.js("serial")(() => x.js("moveToSpace")(tab.id, B));
  assert.deepEqual(said(x).at(-1), "One tab holds unsaved input and stayed here", "a later move counts anew");
  x.kill();
});

test("a tab that cannot be opened there stays, with its record", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = aWindow(ff);
  const x = await alone(ff);
  const errors = x.js("work.errors");
  await move(x, tab.id, GONE);
  assert.ok(ff.tabs.has(tab.id), "the original is kept");
  assert.deepEqual(Object.keys(ff.synced).sort(), ["home", "moved"]);
  assert.equal(ff.list(w.id).length, 2);
  assert.equal(said(x).length, 1);
  assert.equal(x.js("work.errors"), errors);
  x.kill();
});

test("a tab in a folder leaves the folder behind, and a pull request stays gone from its folder", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = aWindow(ff);
  ff.store.syncedTabs.F = { group: true, own: true, name: "Folder", cookieStoreId: A, parentKey: null, rank: 1, added: 1 };
  Object.assign(ff.store.syncedTabs.moved, { parentKey: "F", saved: { url: SITE, title: "Moved" } });
  const pr = ff.addTab(w.id, { url: "https://github.example/pr/1", cookieStoreId: A }, { syncKey: "pr", syncRole: "live" });
  ff.store.syncedTabs.pr = { url: "https://github.example/pr/1", title: "PR", cookieStoreId: A, parentKey: "F", group: false, added: 1, liveFolder: "prs", liveUrl: "https://github.example/pr/1" };
  const x = await alone(ff);
  await move(x, tab.id, B);
  await move(x, pr.id, B);
  await x.js("flushWrites")();
  assert.ok(ff.synced.F, "the folder stays");
  assert.ok(!ff.synced.moved && !ff.synced.pr);
  assert.deepEqual(ff.list(w.id).filter(t => t.url === SITE).map(t => t.cookieStoreId), [B]);
  assert.deepEqual(ff.store.liveFolders.prs.dismissed, ["https://github.example/pr/1"], "remembered, or the next search brings it back");
  x.kill();
});

// --- A rule that cannot open its space --------------------------------------------
test("a rule whose space is gone keeps the tab and says which rule, until the rules change", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: GONE }];
  const { w } = aWindow(ff);
  const x = await alone(ff);
  const errors = x.js("work.errors");
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: B });
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.navigate(t.id, SITE + "?link");
  await wait(500);
  assert.ok(ff.tabs.has(t.id), "the link is not lost");
  assert.equal(ff.tabs.get(t.id).url, SITE + "?link");
  assert.match((await x.js("viewFor")(w.id)).problem, /work\.example/);
  assert.equal(x.js("work.errors"), errors, "not an error inside Tidier");
  await x.send({ type: "settings:rules", rules: [] });
  assert.equal((await x.js("viewFor")(w.id)).problem, null);
  x.kill();
});

test("a link without a container and a rule whose space is gone lands in the active space", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: GONE }];
  const { w } = aWindow(ff);
  const x = await alone(ff);
  ff.blankFirst = true;
  const t = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.navigate(t.id, SITE + "?link");
  await wait(500);
  assert.ok(!ff.tabs.has(t.id));
  assert.deepEqual(ff.list(w.id).filter(y => y.url === SITE + "?link").map(y => y.cookieStoreId), [A]);
  x.kill();
});

// --- A container removed ----------------------------------------------------------
function withSpace(ff) {
  const { w, tab } = aWindow(ff);
  const saved = ff.addTab(w.id, { url: "https://saved.example/", cookieStoreId: B }, { syncKey: "saved", syncRole: "live" });
  const plain = ff.addTab(w.id, { url: "https://plain.example/", cookieStoreId: B }, { syncKey: "plain", syncRole: "live" });
  Object.assign(ff.store.syncedTabs, {
    F: { group: true, own: true, name: "There", cookieStoreId: B, parentKey: null, rank: 1, added: 1 },
    K: { group: true, own: true, name: "Here", cookieStoreId: A, parentKey: null, rank: 1, added: 1 },
    saved: { url: "https://saved.example/", title: "Saved", cookieStoreId: B, parentKey: "F", group: false, added: 1, saved: { url: "https://saved.example/", title: "Saved" } },
    plain: { url: "https://plain.example/", title: "Plain", cookieStoreId: B, parentKey: null, group: false, added: 1 },
  });
  ff.store.rules = [{ url: "gone.example", space: B }, { url: "work.example", space: A }];
  return { w, tab, saved, plain };
}

test("a removed container takes its rules, folders and saved tabs along, and nothing else", async () => {
  const ff = new FakeFirefox();
  const { saved, plain, tab } = withSpace(ff);
  const x = await alone(ff);
  ff.containers.delete(B);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await x.js("serial")(() => {});
  await wait(500);
  await x.js("flushWrites")();
  assert.deepEqual(Object.keys(ff.synced).sort(), ["K", "home", "moved"]);
  assert.deepEqual(ff.store.rules, [{ url: "work.example", space: A }]);
  assert.ok(!ff.tabs.has(saved.id) && !ff.tabs.has(plain.id));
  assert.ok(ff.tabs.has(tab.id));
  assert.deepEqual(x.js("problems").length, 0);
  x.kill();
});

test("tabs Firefox closes with their container are no errors, in either order", async () => {
  const ff = new FakeFirefox();
  const { saved, plain } = withSpace(ff);
  const x = await alone(ff);
  await wait(100);
  ff.containers.delete(B);
  ff.rm(saved.id); ff.rm(plain.id); // the tabs first, as Firefox's own settings do it
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await x.js("serial")(() => {});
  await wait(500);
  await x.js("flushWrites")();
  assert.deepEqual(Object.keys(ff.synced).sort(), ["K", "home", "moved"]);
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

test("with the setting off, a removed container changes no rule or record", async () => {
  const ff = new FakeFirefox();
  const { w } = withSpace(ff);
  const rules = ff.store.rules;
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await wait(500);
  await x.js("flushWrites")();
  assert.deepEqual(ff.store.rules, rules);
  assert.ok(ff.synced.F && ff.synced.saved);
  assert.equal(ff.list(w.id).length, 4);
  x.kill();
});

// --- Found by trying to break it ---------------------------------------------------
test("opening tabs keeps nothing of them: every move would otherwise add to what stays in memory", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  const x = await alone(ff);
  await x.js("openUnruled")({ windowId: w.id, cookieStoreId: B, url: SITE + "?one" });
  await x.js("openUnruled")({ windowId: w.id, cookieStoreId: B, url: SITE + "?two" });
  assert.equal(await x.js("openings"), undefined);
  x.kill();
});

test("the selected tab, moved to a space that is gone, stays selected and loaded, and nothing is added", async () => {
  const ff = new FakeFirefox();
  const { w, other, tab } = aWindow(ff, { selected: true });
  const x = await alone(ff);
  await move(x, tab.id, GONE);
  assert.equal(ff.tabs.get(tab.id).active, true, "you stay on it");
  assert.equal(ff.tabs.get(tab.id).discarded, false);
  assert.equal(ff.tabs.get(other.id).active, false);
  assert.equal(ff.list(w.id).length, 2);
  assert.equal(said(x).length, 1);
  x.kill();
});

test("a tab that is not selected, moved to a space that is gone, stays loaded", async () => {
  const ff = new FakeFirefox();
  const { tab } = aWindow(ff);
  const x = await alone(ff);
  await move(x, tab.id, GONE);
  assert.equal(ff.tabs.get(tab.id).discarded, false);
  x.kill();
});

test("a new tab refused for any other reason: the original stays, with its record", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = aWindow(ff);
  const x = await alone(ff);
  x.b.tabs.create = async () => { throw new Error("the window was closing"); };
  await move(x, tab.id, B);
  assert.ok(ff.tabs.has(tab.id));
  assert.deepEqual(Object.keys(ff.synced).sort(), ["home", "moved"]);
  assert.equal(ff.list(w.id).length, 2);
  assert.equal(said(x).length, 1);
  x.kill();
});

// A page still loading: Firefox reports the new address, and the record follows when the
// page has finished. (A page that changes its own address finishes at once: Firefox
// reports its new address and "complete" together, so the record has that one.)
function stillLoading(ff, id, url) {
  const t = ff.tabs.get(id);
  Object.assign(t, { url, status: "loading" });
  ff.ext.b.tabs.onUpdated.fire(id, { status: "loading", url }, ff.snap(t));
}

test("a move of a page still loading takes its new address, not the older one in the record", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = aWindow(ff);
  const x = await alone(ff);
  stillLoading(ff, tab.id, SITE + "/deeper");
  await move(x, tab.id, B);
  assert.deepEqual(ff.list(w.id).filter(t => t.cookieStoreId === B).map(t => t.url), [SITE + "/deeper"]);
  x.kill();
});

test("moved from its placeholder, a page still loading in the other window takes its new address", async () => {
  const ff = new FakeFirefox();
  const { tab } = aWindow(ff);
  const second = ff.addWindow();
  const ghost = ff.addTab(second.id, { url: GHOST("ghost", "moved"), cookieStoreId: A, discarded: true }, { syncKey: "moved", syncRole: "ghost" });
  ff.addTab(second.id, { url: GHOST("ghost", "home"), cookieStoreId: A, discarded: true }, { syncKey: "home", syncRole: "ghost" });
  const x = await alone(ff);
  stillLoading(ff, tab.id, SITE + "/deeper");
  await move(x, ghost.id, B);
  assert.deepEqual(ff.list(second.id).filter(t => t.cookieStoreId === B).map(t => t.url), [SITE + "/deeper"]);
  x.kill();
});

test("a tab that is only a placeholder everywhere moves by the record's address", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A }, { syncKey: "home", syncRole: "live" });
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "moved"), cookieStoreId: A, discarded: true }, { syncKey: "moved", syncRole: "ghost" });
  ff.store.syncedTabs = {
    home: { url: "https://home.example/", title: "Home", cookieStoreId: A, parentKey: null, group: false, added: 1 },
    moved: { url: SITE, title: "Moved", cookieStoreId: A, parentKey: null, group: false, added: 1 },
  };
  const x = await alone(ff);
  await move(x, ghost.id, B);
  assert.deepEqual(ff.list(w.id).filter(t => t.cookieStoreId === B).map(t => t.url), [SITE]);
  x.kill();
});

test("a rule that could not open a space that exists says nothing about it being gone", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: A }];
  const { w } = aWindow(ff);
  const x = await alone(ff);
  const create = x.b.tabs.create;
  x.b.tabs.create = async p => { if (p.url === SITE + "?link") throw new Error("the window was closing"); return create(p); };
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: B });
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.navigate(t.id, SITE + "?link");
  await wait(500);
  assert.ok(ff.tabs.has(t.id), "the link is not lost");
  assert.equal((await x.js("viewFor")(w.id)).problem, null, "no lasting notice of something untrue");
  assert.ok([...x.js("problems")].some(p => /closing/.test(p)), "and the error is seen");
  x.kill();
});

test("a saved tab's placeholder refused for another reason is still an error", async () => {
  const ff = new FakeFirefox();
  aWindow(ff);
  ff.store.syncedTabs.F = { group: true, own: true, name: "Folder", cookieStoreId: A, parentKey: null, rank: 1, added: 1 };
  Object.assign(ff.store.syncedTabs.moved, { parentKey: "F", saved: { url: SITE, title: "Moved" } });
  const x = await alone(ff);
  const second = ff.addWindow(); // no copy of it there yet, so one is made
  x.b.tabs.create = async () => { throw new Error("the window was closing"); };
  await x.js("serial")(() => x.js("unloadSaved")("moved", second.id, null)).catch(() => {});
  await x.js("serial")(() => {});
  assert.ok([...x.js("problems")].some(p => /closing/.test(p)));
  x.kill();
});

// A window in the space that goes: B is shown, A's tabs are hidden.
function inRemovedSpace(ff) {
  const w = ff.addWindow({ focused: true });
  const a = ff.addTab(w.id, { url: "https://home.example/", cookieStoreId: A, lastAccessed: 1000, hidden: true }, { syncKey: "home", syncRole: "live" });
  const b = ff.addTab(w.id, { url: "https://there.example/", active: true, cookieStoreId: B, lastAccessed: 2000 }, { syncKey: "there", syncRole: "live" });
  const b2 = ff.addTab(w.id, { url: "https://there.example/2", cookieStoreId: B, lastAccessed: 500 }, { syncKey: "there2", syncRole: "live" });
  ff.store.syncedTabs = {
    home: { url: "https://home.example/", title: "Home", cookieStoreId: A, parentKey: null, group: false, added: 1 },
    there: { url: "https://there.example/", title: "There", cookieStoreId: B, parentKey: null, group: false, added: 1 },
    there2: { url: "https://there.example/2", title: "There 2", cookieStoreId: B, parentKey: null, group: false, added: 1 },
  };
  return { w, a, b, b2 };
}
const settled = async x => { await x.js("serial")(() => {}); await wait(500); await x.js("serial")(() => {}); await wait(500); await x.js("flushWrites")(); };

for (const order of ["only the container", "its tabs first, as Firefox's settings do it"]) {
  test(`the space you are in is removed (${order}): you are in another space, with its tabs shown`, async () => {
    const ff = new FakeFirefox();
    const { w, a, b, b2 } = inRemovedSpace(ff);
    const x = await alone(ff);
    assert.equal(x.js("activeSpace").get(w.id), B);
    if (order !== "only the container") {
      ff.containers.delete(B);
      ff.rm(b.id); ff.rm(b2.id);
      await wait(50);
    } else ff.containers.delete(B);
    x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
    await settled(x);
    assert.deepEqual(Object.keys(ff.synced), ["home"]);
    assert.ok(![...ff.tabs.values()].some(t => t.cookieStoreId === B), "no tab left in it");
    assert.notEqual(x.js("activeSpace").get(w.id), B, "the window is not left in a space that is gone");
    assert.equal(ff.tabs.get(a.id).hidden, false, "the tabs of the space you are in are shown");
    assert.equal(ff.tabs.get(a.id).active, true, "and you are on one");
    assert.deepEqual([...x.js("problems")], []);
    x.kill();
  });
}

test("the space you are in is removed: you land on the tab you used last in the next one", async () => {
  const ff = new FakeFirefox();
  const { w, a } = inRemovedSpace(ff);
  const used = ff.addTab(w.id, { url: "https://used.example/", cookieStoreId: A, lastAccessed: 5000, hidden: true }, { syncKey: "used", syncRole: "live" });
  ff.store.syncedTabs.used = { url: "https://used.example/", title: "Used", cookieStoreId: A, parentKey: null, group: false, added: 1 };
  const x = await alone(ff);
  ff.containers.delete(B);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await settled(x);
  assert.equal(ff.tabs.get(used.id).active, true);
  assert.equal(ff.tabs.get(a.id).active, false);
  x.kill();
});

test("the space you are in is removed from Firefox's settings page: you stay on that page, and the window leaves the space", async () => {
  const ff = new FakeFirefox();
  const { w, a, b, b2 } = inRemovedSpace(ff);
  ff.tabs.get(b.id).active = false;
  const settings = ff.addTab(w.id, { url: "about:preferences#containers", active: true });
  const x = await alone(ff);
  x.js("activeSpace").set(w.id, B);
  ff.containers.delete(B);
  ff.rm(b.id); ff.rm(b2.id); // Firefox's settings close its tabs first, and no selection changes
  await wait(50);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await settled(x);
  assert.equal(ff.tabs.get(settings.id).active, true, "still on the settings page");
  assert.equal(x.js("activeSpace").get(w.id), A);
  assert.equal(ff.tabs.get(a.id).hidden, false, "the tabs of the space it is in now are shown");
  const link = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(link));
  ff.navigate(link.id, SITE + "?link");
  await settled(x);
  assert.deepEqual(ff.list(w.id).filter(y => y.url === SITE + "?link").map(y => y.cookieStoreId), [A], "a link lands in a space that exists");
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

test("a view drawn before the queue gets to a removed space: the window's new space still has its tabs shown", async () => {
  const ff = new FakeFirefox();
  const { w, a, b, b2 } = inRemovedSpace(ff);
  ff.tabs.get(b.id).active = false;
  const settings = ff.addTab(w.id, { url: "about:preferences#containers", active: true });
  const x = await alone(ff);
  x.js("activeSpace").set(w.id, B);
  aPort(x, w.id);
  await realWait(5);
  ff.tabs.get(a.id).hidden = true;
  // The queue is busy (Tidier's own stay-in-the-space, say), and the view is not in it.
  let free;
  x.js("serial")(() => new Promise(r => { free = r; }));
  ff.containers.delete(B);
  ff.rm(b.id); ff.rm(b2.id);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await until(() => x.js("activeSpace").get(w.id) === A); // the view has decided
  free();
  await settled(x);
  assert.equal(ff.tabs.get(a.id).hidden, false);
  assert.equal(ff.tabs.get(settings.id).active, true);
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

test("a new link without a container, after the space you were in is removed, lands in a space that exists", async () => {
  const ff = new FakeFirefox();
  const { w, b, b2 } = inRemovedSpace(ff);
  const x = await alone(ff);
  ff.containers.delete(B);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await settled(x);
  const t = ff.addTab(w.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(t));
  ff.navigate(t.id, SITE + "?link");
  await settled(x);
  assert.ok(!ff.tabs.has(t.id));
  assert.deepEqual(ff.list(w.id).filter(y => y.url === SITE + "?link").map(y => y.cookieStoreId), [A]);
  assert.deepEqual([...x.js("problems")], []);
  assert.ok(!ff.tabs.has(b.id) && !ff.tabs.has(b2.id));
  x.kill();
});

test("a tab of the removed container that is not in the record goes too", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = withSpace(ff);
  const blank = ff.addTab(w.id, { url: "about:newtab", cookieStoreId: B });
  const x = await alone(ff);
  ff.containers.delete(B);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await settled(x);
  assert.ok(!ff.tabs.has(blank.id));
  assert.ok(ff.tabs.has(tab.id));
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

test("an essential of the removed container goes too, and does not come back", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = withSpace(ff);
  ff.store.essentials = [{ key: "ess", url: "https://ess.example/", cookieStoreId: B, title: "Ess" }];
  const copy = ff.addTab(w.id, { url: "https://ess.example/", pinned: true, cookieStoreId: B }, { essentialKey: "ess" });
  const x = await alone(ff);
  const pinnedThere = () => [...ff.tabs.values()].filter(t => t.pinned && t.cookieStoreId === B);
  assert.equal(pinnedThere().length, 1);
  ff.containers.delete(B);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await settled(x);
  await wait(2000);
  assert.ok(!ff.tabs.has(copy.id));
  assert.deepEqual(pinnedThere(), []);
  assert.deepEqual(ff.store.essentials, []);
  assert.ok(ff.tabs.has(tab.id));
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

test("the last space removed: nothing to go to, and no error", async () => {
  const ff = new FakeFirefox({ containers: ["firefox-default", A] });
  const w = ff.addWindow({ focused: true });
  const keep = ff.addTab(w.id, { url: "about:blank", active: true });
  const t = ff.addTab(w.id, { url: SITE, cookieStoreId: A }, { syncKey: "k", syncRole: "live" });
  ff.store.syncedTabs = { k: { url: SITE, title: "T", cookieStoreId: A, parentKey: null, group: false, added: 1 } };
  const x = await alone(ff);
  x.js("activeSpace").set(w.id, A);
  ff.containers.delete(A);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: A } });
  await settled(x);
  assert.ok(!ff.tabs.has(t.id));
  assert.ok(ff.tabs.has(keep.id));
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

test("a live folder set up for a removed space does not come back in the record, and says so", async () => {
  const ff = new FakeFirefox();
  const { w } = withSpace(ff);
  const x = await alone(ff);
  ff.containers.delete(B);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B } });
  await settled(x);
  const folder = { id: "prs", name: "Pull requests", cookieStoreId: B };
  await x.js("serial")(() => x.js("refreshLiveFolder")(folder, { items: [{ url: "https://github.example/pr/1", repo: "r", number: 1, title: "T" }] }));
  await settled(x);
  assert.ok(!Object.values(ff.synced).some(e => e.cookieStoreId === B), "nothing in the record for a space that is gone");
  assert.match((await x.js("viewFor")(w.id)).problem, /Pull requests/);
  assert.deepEqual([...x.js("problems")], []);
  x.kill();
});

// --- A sidebar open while Tidier starts -------------------------------------------
// Boots the real scripts with Tidier's start held back, as in the seconds after Firefox starts.
function bootHeld(ff) {
  ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.js("startRequested = true");
  return x;
}
const letStart = async x => { x.js("startRequested = false; requestStart(0)"); await until(() => x.started()); };

function withFolder(ff) {
  const made = aWindow(ff);
  ff.store.syncedTabs.F = { group: true, own: true, name: "Folder", cookieStoreId: A, parentKey: null, rank: 1, added: 1 };
  Object.assign(ff.store.syncedTabs.moved, { parentKey: "F", saved: { url: SITE, title: "Moved" } });
  return made;
}

test("the first view, before Tidier has started, is the one that stays: the setting known, tabs in their folders", async () => {
  const ff = new FakeFirefox();
  const { w, tab, other } = withFolder(ff);
  ff.containers.add("firefox-container-3");
  const x = bootHeld(ff);
  const { views } = aPort(x, w.id);
  await until(() => views.length);
  assert.equal(x.started(), false);
  const plain = v => JSON.parse(JSON.stringify(v)); // (from the scripts' own realm)
  const first = plain(views[0]);
  assert.equal(first.alone, true, "or its rows cannot be dragged");
  assert.deepEqual(first.folders.map(f => [f.name, f.tabs.map(t => t.id)]), [["Folder", [tab.id]]]);
  assert.deepEqual(first.tabs.map(t => t.id), [other.id]);
  assert.equal(first.spaces.length, 3, "empty spaces too, or they would appear later");
  await letStart(x);
  await x.js("serial")(() => {});
  const later = plain(await x.js("viewFor")(w.id));
  assert.deepEqual(later.folders, first.folders);
  assert.deepEqual(later.tabs, first.tabs);
  assert.deepEqual(later.spaces, first.spaces);
  x.kill();
});

test("what the first view reads stays with it: Tidier does not act on roles before it starts", async () => {
  const ff = new FakeFirefox();
  const { w } = withFolder(ff);
  const x = bootHeld(ff);
  const { views } = aPort(x, w.id);
  await until(() => views.length);
  assert.equal(x.js("syncKeyByTab.size"), 0);
  x.kill();
});

test("a move made before Tidier has started waits for it, and then moves the tab with its record", async () => {
  const ff = new FakeFirefox();
  const { w, tab } = withFolder(ff);
  const second = ff.addWindow();
  const ghost = ff.addTab(second.id, { url: GHOST("ghost", "moved"), cookieStoreId: A, discarded: true }, { syncKey: "moved", syncRole: "ghost" });
  ff.addTab(second.id, { url: GHOST("ghost", "home"), cookieStoreId: A, discarded: true }, { syncKey: "home", syncRole: "ghost" });
  const x = bootHeld(ff);
  const { views, send } = aPort(x, w.id);
  await until(() => views.length);
  send({ type: "moveToSpace", tabId: tab.id, space: B });
  await realWait(30);
  assert.ok(ff.tabs.has(tab.id), "nothing yet");
  assert.ok(!ff.list(w.id).some(t => t.cookieStoreId === B));
  await letStart(x);
  await until(() => !ff.tabs.has(tab.id));
  assert.ok(!ff.tabs.has(ghost.id), "in every window");
  await x.js("serial")(() => {});
  await x.js("flushWrites")();
  assert.ok(!ff.synced.moved);
  assert.deepEqual(ff.list(w.id).filter(t => t.url === SITE).map(t => t.cookieStoreId), [B]);
  x.kill();
});

test("a session restored while Tidier starts does not take you off the tab it selected", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const blank = ff.addTab(w.id, { url: "about:blank", active: true });
  const there = ff.addTab(w.id, { url: "https://there.example/", cookieStoreId: B, lastAccessed: 2000 }, { syncKey: "there", syncRole: "live" });
  const here = ff.addTab(w.id, { url: "https://home.example/", cookieStoreId: A, lastAccessed: 1000 }, { syncKey: "home", syncRole: "live" });
  ff.store.syncedTabs = {
    there: { url: "https://there.example/", title: "There", cookieStoreId: B, parentKey: null, group: false, added: 1 },
    home: { url: "https://home.example/", title: "Home", cookieStoreId: A, parentKey: null, group: false, added: 1 },
  };
  const x = bootHeld(ff);
  const { views } = aPort(x, w.id);
  await until(() => views.length);
  x.js("activeSpace").set(w.id, A); // what a first view with no window value may have decided
  ff.rm(blank.id); // Firefox replaces the window's first tab with what it restores: the first in order, here
  await realWait(10);
  await x.js("serial")(() => {});
  assert.equal(ff.tabs.get(there.id).active, true);
  assert.equal(ff.tabs.get(here.id).active, false);
  x.kill();
});

// --- The sidebar comes back -------------------------------------------------------
// reconnect.js on a stand-in for the sidebar page: what is under test is when it
// reloads, and how often. The smoke test does it for real (alone_safe_moves).
function aSidebar(session = new Map(), { noStorage = false } = {}) {
  const timers = new Map(), ls = { disconnect: [], message: [] };
  let next = 1;
  const page = {
    reloads: 0, session,
    location: { reload() { page.reloads++; } },
    setTimeout(f, ms) { timers.set(next, { f, ms }); return next++; },
    clearTimeout(id) { timers.delete(id); },
    sessionStorage: noStorage ? null : { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) },
    port: { onDisconnect: { addListener: f => ls.disconnect.push(f) }, onMessage: { addListener: f => ls.message.push(f) } },
  };
  const ctx = vm.createContext(page);
  if (noStorage) Object.defineProperty(ctx, "sessionStorage", { get() { throw new Error("denied"); } });
  vm.runInContext(readFileSync(new URL("../sidebar/reconnect.js", import.meta.url), "utf8"), ctx);
  return {
    page, timers: () => [...timers.values()],
    tick() { const all = [...timers.entries()]; timers.clear(); for (const [, t] of all) t.f(); return all.map(([, t]) => t.ms); },
    disconnect: () => ls.disconnect.forEach(f => f()),
    view: () => ls.message.forEach(f => f({})),
  };
}

test("a sidebar whose view arrives stays as it is, with no timer left behind", () => {
  const s = aSidebar();
  assert.equal(s.timers().length, 1);
  s.view();
  assert.equal(s.timers().length, 0, "nothing runs with nothing happening");
  assert.equal(s.page.reloads, 0);
});

test("a sidebar with no view reloads, ever more slowly, and stops after a few tries", () => {
  const session = new Map();
  const reloadWaits = [], viewWaits = [];
  let tries = 0;
  for (; tries < 10; tries++) {
    const s = aSidebar(session);
    viewWaits.push(s.timers()[0].ms);
    s.tick(); // no view in time
    if (!s.timers().length) break;
    reloadWaits.push(s.timers()[0].ms);
    s.tick();
    assert.equal(s.page.reloads, 1);
  }
  assert.ok(tries >= 2 && tries <= 5, `a few tries, not ${tries}`);
  assert.deepEqual(reloadWaits, [...reloadWaits].sort((a, b) => a - b), "growing");
  assert.ok(reloadWaits.at(-1) > reloadWaits[0]);
  assert.equal(viewWaits[0], 2000);
  assert.ok(viewWaits.at(-1) > viewWaits[0], "a busy machine gets more time");
});

test("a sidebar whose connection drops reloads once, and a view starts the count over", () => {
  const session = new Map();
  const s = aSidebar(session);
  s.view();
  s.disconnect();
  s.disconnect(); // twice must not count twice
  assert.equal(s.timers().length, 1);
  assert.deepEqual([...session.values()], ["1"]);
  s.tick();
  assert.equal(s.page.reloads, 1);
  const again = aSidebar(session);
  again.view();
  assert.equal(session.size, 0, "it worked: a later drop gets every try again");
});

test("a late view cancels a reload that was waiting", () => {
  const s = aSidebar();
  s.tick(); // no view in time: a reload is waiting
  assert.equal(s.timers().length, 1);
  s.view();
  assert.equal(s.timers().length, 0);
  assert.equal(s.page.reloads, 0);
});

test("without sessionStorage the page does not reload at all: it could not stop", () => {
  const s = aSidebar(new Map(), { noStorage: true });
  s.tick();
  s.disconnect();
  assert.equal(s.timers().length, 0);
  assert.equal(s.page.reloads, 0);
});
