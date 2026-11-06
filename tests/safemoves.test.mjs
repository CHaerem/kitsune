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
