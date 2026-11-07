// What must not happen to a tab when its request is stopped (isolation.js): it does not
// get lost, doubled or stuck, and nothing a rule can say holds up a navigation. The real
// background scripts on a fake Firefox; alone_isolation has the same on a real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, realSleep, GHOST } from "./fake_firefox.mjs";

const NONE = "firefox-default", A = "firefox-container-1", B = "firefox-container-2", C = "firefox-container-3";
const GUARD = ["webRequest", "webRequestBlocking", "<all_urls>"];
const DEAD = "firefox-container-9";

async function run(ff) {
  ff.managed = { tidierAlone: true };
  ff.granted ??= new Set(GUARD);
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}
function aWindow(ff) {
  const w = ff.addWindow({ focused: true });
  const home = ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: A, title: "Home" });
  return { w, home };
}
const newTab = (ff, x, w, props = {}) => {
  const t = ff.addTab(w.id, { url: "about:blank", ...props });
  x.b.tabs.onCreated.fire(ff.snap(t));
  return t;
};
const opened = (ff, windowId, url) => ff.list(windowId).filter(t => t.url === url);
const WORK = "https://work.example/x";

// --- A tab that holds something stays ------------------------------------------------
test("an address typed in a saved tab that a rule sends elsewhere: the saved tab stays as it was", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Folder", cookieStoreId: A, parentKey: null, rank: 1 },
    s: { url: "https://saved.example/", title: "Saved", cookieStoreId: A, parentKey: "F", group: false, added: 1, saved: { url: "https://saved.example/", title: "Saved" } },
  };
  const { w } = aWindow(ff);
  const other = ff.addWindow();
  const t = ff.addTab(w.id, { url: "https://saved.example/", cookieStoreId: A }, { syncKey: "s", syncRole: "live" });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "s"), cookieStoreId: A }, { syncKey: "s", syncRole: "ghost" });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true, "stopped: it goes out in the rule's space");
  await wait(800);
  assert.equal(opened(ff, w.id, WORK)[0].cookieStoreId, B);
  assert.ok(ff.tabs.has(t.id), "the saved tab is not closed");
  assert.ok(ff.tabs.has(ghost.id), "nor its placeholder in the other window");
  assert.equal(ff.synced.s.parentKey, "F", "and it is still in its folder");
  assert.equal(ff.synced.s.saved.url, "https://saved.example/");
  x.kill();
});

test("an address typed in a tab showing a page: that page stays, also an ordinary one", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  ff.store.syncedTabs = { k: { url: "https://page.example/", title: "Page", cookieStoreId: A, parentKey: null, group: false, added: 1 } };
  const { w } = aWindow(ff);
  const t = ff.addTab(w.id, { url: "https://page.example/", cookieStoreId: A, active: true }, { syncKey: "k", syncRole: "live" });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true);
  await wait(800);
  assert.ok(ff.tabs.has(t.id), "its page and history are not lost for an address that belongs elsewhere");
  assert.ok(ff.synced.k);
  const [n] = opened(ff, w.id, WORK);
  assert.equal(n.cookieStoreId, B);
  assert.equal(n.active, true, "you go where you asked to go");
  x.kill();
});

test("an address typed in a selected placeholder: the placeholder stays, and so does what it stands for", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  ff.store.syncedTabs = { s: { url: "https://saved.example/", title: "Saved", cookieStoreId: A, parentKey: null, group: false, added: 1, saved: { url: "https://saved.example/" } } };
  const { w } = aWindow(ff);
  const t = ff.addTab(w.id, { url: GHOST("ghost", "s"), cookieStoreId: A, active: true }, { syncKey: "s", syncRole: "live" });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true);
  await wait(800);
  assert.ok(ff.synced.s, "what it stands for stays in the record");
  assert.ok(ff.tabs.has(t.id));
  x.kill();
});

test("a placeholder loading its own page: no rule takes it, whatever its address", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  ff.store.syncedTabs = { s: { url: WORK, title: "Saved", cookieStoreId: A, parentKey: null, group: false, added: 1, saved: { url: WORK } } };
  const { w } = aWindow(ff);
  const t = ff.addTab(w.id, { url: GHOST("ghost", "s"), cookieStoreId: A, active: true }, { syncKey: "s", syncRole: "live" });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: t.id, url: WORK, originUrl: GHOST("ghost", "s") })).cancel, undefined);
  x.kill();
});

test("a blank tab still goes: only what holds nothing is closed", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A, url: "about:newtab" });
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true);
  await wait(300);
  assert.ok(!ff.tabs.has(t.id));
  assert.equal(opened(ff, w.id, WORK).length, 1);
  x.kill();
});

test("a saved tab outside any container stays what it is: its record, folder and place in every window go with it", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Folder", cookieStoreId: B, parentKey: null, rank: 1 },
    s: { url: "https://saved.example/", title: "Saved", cookieStoreId: NONE, parentKey: "F", group: false, added: 1, saved: { url: "https://saved.example/", title: "Saved" } },
    b: { url: "https://b.example/", title: "B", cookieStoreId: B, parentKey: null, group: false, added: 2 },
  };
  const { w } = aWindow(ff);
  const other = ff.addWindow();
  const t = ff.addTab(w.id, { url: GHOST("ghost", "s"), active: true }, { syncKey: "s", syncRole: "live" });
  ff.wins.get(w.id).order.reverse(); // the tab first, and the home tab after it
  ff.tabs.get(ff.wins.get(w.id).order[1]).active = false;
  ff.addTab(w.id, { url: GHOST("ghost", "b"), cookieStoreId: B }, { syncKey: "b", syncRole: "ghost" });
  ff.addTab(other.id, { url: "https://other.example/", cookieStoreId: A, active: true });
  const ghostFirst = ff.addTab(other.id, { url: GHOST("ghost", "s") }, { syncKey: "s", syncRole: "ghost" });
  ff.addTab(other.id, { url: "https://b.example/", cookieStoreId: B }, { syncKey: "b", syncRole: "live" });
  const placeThere = ff.index(ghostFirst);
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: t.id, url: "https://saved.example/", originUrl: GHOST("ghost", "s") })).cancel, true);
  await wait(1000);
  const entry = ff.synced.s;
  assert.ok(entry, "the record is kept");
  assert.equal(entry.cookieStoreId, B, "it goes to its folder's space, not the active one");
  assert.equal(entry.parentKey, "F");
  assert.equal(entry.saved.url, "https://saved.example/");
  const [n] = opened(ff, w.id, "https://saved.example/");
  assert.equal(n.cookieStoreId, B);
  assert.equal(n.active, true, "selected if the old one was");
  assert.equal(ff.values.get(n.id).syncKey, "s", "it is the same tab");
  assert.equal(ff.values.get(n.id).syncRole, "live");
  assert.ok(!ff.tabs.has(t.id));
  const reps = ff.list(other.id).filter(c => ff.values.get(c.id)?.syncKey === "s");
  assert.equal(reps.length, 1, "one placeholder in the other window");
  assert.equal(reps[0].cookieStoreId, B, "in the same container");
  assert.equal(reps[0].index, placeThere, "in the same place");
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("an ordinary known tab outside any container keeps its key too, and the other windows follow", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { k: { url: "https://old.example/", title: "Old", cookieStoreId: NONE, parentKey: null, group: false, added: 1 } };
  const { w } = aWindow(ff);
  const other = ff.addWindow();
  const t = ff.addTab(w.id, { url: "https://old.example/", discarded: true }, { syncKey: "k", syncRole: "live" });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "k") }, { syncKey: "k", syncRole: "ghost" });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: t.id, url: "https://old.example/" })).cancel, true);
  await wait(800);
  assert.ok(!ff.tabs.has(t.id));
  assert.ok(!ff.tabs.has(ghost.id));
  assert.equal(ff.synced.k?.cookieStoreId, A);
  assert.equal(ff.list(other.id).filter(c => ff.values.get(c.id)?.syncKey === "k")[0].cookieStoreId, A);
  x.kill();
});

test("a known tab waiting in a busy queue to be replaced asks again: nothing more is opened", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { k: { url: "https://old.example/", title: "Old", cookieStoreId: NONE, parentKey: null, group: false, added: 1 } };
  const { w } = aWindow(ff);
  const t = ff.addTab(w.id, { url: GHOST("ghost", "k"), active: true }, { syncKey: "k", syncRole: "live" });
  const x = await run(ff);
  let free;
  x.js("serial")(() => new Promise(resolve => { free = resolve; }));
  const origin = GHOST("ghost", "k");
  assert.equal((await ff.request({ tabId: t.id, url: "https://old.example/", originUrl: origin })).cancel, true);
  assert.equal((await ff.request({ tabId: t.id, url: "https://old.example/", originUrl: origin })).cancel, true);
  assert.equal(opened(ff, w.id, "https://old.example/").length, 1, "opening it twice would give you two of it");
  free();
  await wait(500);
  assert.ok(!ff.tabs.has(t.id));
  assert.equal(x.js("leaving.size"), 0);
  x.kill();
});

// --- Two windows, and the same thing twice -----------------------------------------------
test("a known tab outside any container, loading in two windows at once: one tab in the end, and one placeholder", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { k: { url: "https://old.example/", title: "Old", cookieStoreId: NONE, parentKey: null, group: false, added: 1, saved: { url: "https://old.example/" } } };
  const { w } = aWindow(ff);
  const other = ff.addWindow();
  ff.addTab(other.id, { url: "https://there.example/", cookieStoreId: A });
  const one = ff.addTab(w.id, { url: GHOST("ghost", "k"), active: true }, { syncKey: "k", syncRole: "live" });
  const two = ff.addTab(other.id, { url: GHOST("ghost", "k"), active: true }, { syncKey: "k", syncRole: "live" });
  const x = await run(ff);
  const origin = GHOST("ghost", "k");
  const answers = await Promise.all([ff.request({ tabId: one.id, url: "https://old.example/", originUrl: origin }), ff.request({ tabId: two.id, url: "https://old.example/", originUrl: origin })]);
  assert.ok(answers.every(a => a.cancel));
  await wait(1200);
  assert.equal(ff.synced.k.cookieStoreId, A);
  const reps = [...ff.wins.keys()].map(id => ff.list(id).filter(t => ff.values.get(t.id)?.syncKey === "k"));
  assert.deepEqual(reps.map(r => r.length), [1, 1], "once in each window");
  assert.ok(reps.flat().every(t => t.cookieStoreId === A));
  assert.equal(reps.flat().filter(t => !t.url.includes("ghost.html")).length, 1, "and loaded in one");
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("two rules matching one address: the first decides everywhere, also when the page is already in its space", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }, { url: "/work/", space: C }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  let lookups = 0;
  const get = x.b.tabs.get;
  x.b.tabs.get = async id => { lookups++; return get(id); };
  const inB = ff.addTab(w.id, { url: "about:blank", cookieStoreId: B });
  assert.equal((await ff.request({ tabId: inB.id, url: WORK })).cancel, undefined);
  assert.equal(lookups, 0, "where the first rule says: nothing to look up");
  const inC = newTab(ff, x, w, { cookieStoreId: C });
  assert.equal((await ff.request({ tabId: inC.id, url: WORK })).cancel, true);
  await wait(300);
  assert.equal(opened(ff, w.id, WORK).at(-1).cookieStoreId, B);
  x.kill();
});

test("two moved tabs with the same address: neither is sent back", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  x.b.tabs.create = (create => async p => {
    const t = ff.addTab(p.windowId, { url: "about:blank", cookieStoreId: p.cookieStoreId });
    x.b.tabs.onCreated.fire(ff.snap(t));
    return ff.snap(t);
  })(x.b.tabs.create);
  const one = await x.ctx.openUnruled({ windowId: w.id, cookieStoreId: C, url: WORK });
  const two = await x.ctx.openUnruled({ windowId: w.id, cookieStoreId: C, url: WORK });
  assert.equal((await ff.request({ tabId: one.id, url: WORK })).cancel, undefined);
  assert.equal((await ff.request({ tabId: two.id, url: WORK })).cancel, undefined, "each mark is for one tab, and there are two");
  const three = newTab(ff, x, ff.wins.get(w.id), { cookieStoreId: C });
  assert.equal((await ff.request({ tabId: three.id, url: WORK })).cancel, true, "a third, which you did not move, follows the rule");
  x.kill();
});

test("back to where a tab was allowed to be does not move it: a sign-in it passed through, a page moved by hand", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "login.work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  const signIn = "https://login.work.example/";
  await ff.request({ tabId: t.id, url: "https://app.example/", requestId: "q" });
  assert.equal((await ff.request({ tabId: t.id, url: signIn, requestId: "q" })).cancel, undefined, "a redirect");
  await ff.request({ tabId: t.id, url: "https://app.example/home", requestId: "q" });
  ff.navigate(t.id, "https://app.example/home");
  // Back: Firefox asks again, with no page asking, as for an address you type.
  assert.equal((await ff.request({ tabId: t.id, url: signIn })).cancel, undefined, "back through the sign-in stays");
  await wait(300);
  assert.equal(opened(ff, w.id, signIn).length, 0, "and opens nothing");

  x.b.tabs.create = (create => async p => {
    const n = ff.addTab(p.windowId, { url: "about:blank", cookieStoreId: p.cookieStoreId });
    x.b.tabs.onCreated.fire(ff.snap(n));
    return ff.snap(n);
  })(x.b.tabs.create);
  const moved = await x.ctx.openUnruled({ windowId: w.id, cookieStoreId: C, url: signIn });
  assert.equal((await ff.request({ tabId: moved.id, url: signIn })).cancel, undefined);
  ff.navigate(moved.id, "https://app.example/");
  assert.equal((await ff.request({ tabId: moved.id, url: signIn })).cancel, undefined, "back to the page you moved here");
  x.kill();
});

test("what is remembered of a tab goes with it, and stays small", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  await ff.request({ tabId: t.id, url: "https://short.example/", requestId: "q" });
  for (let i = 0; i < 200; i++) await ff.request({ tabId: t.id, url: `https://work.example/${i}`, requestId: "q" });
  assert.ok(x.js(`settled.get(${t.id}).size`) <= 20, "a long chain of redirects does not grow it for ever");
  await x.b.tabs.remove(t.id);
  assert.equal(x.js("settled.size"), 0);
  x.kill();
});

test("a second request of a tab while the first is being decided opens nothing more", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  const answers = await Promise.all([ff.request({ tabId: t.id, url: WORK }), ff.request({ tabId: t.id, url: WORK })]);
  await wait(300);
  assert.equal(opened(ff, w.id, WORK).length, 1, "Enter pressed twice");
  assert.ok(answers.some(a => a.cancel));
  x.kill();
});

test("an essential outside any container, loading in two windows at once, moves once and each window keeps its selection", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://mail.example/", cookieStoreId: NONE, title: "Mail", icon: "x" }, { key: "f", url: "https://f.example/", cookieStoreId: A, title: "F", icon: "x" }];
  const { w, home } = aWindow(ff);
  const other = ff.addWindow();
  const one = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, active: true }, { essentialKey: "e" });
  home.active = false;
  ff.addTab(w.id, { url: GHOST("essential", "f"), pinned: true, cookieStoreId: A }, { essentialKey: "f" });
  ff.addTab(other.id, { url: "https://there.example/", cookieStoreId: B });
  const two = ff.addTab(other.id, { url: GHOST("essential", "e"), pinned: true, active: true }, { essentialKey: "e" });
  ff.addTab(other.id, { url: GHOST("essential", "f"), pinned: true, cookieStoreId: A }, { essentialKey: "f" });
  const x = await run(ff);
  const before = ff.log.length;
  const answers = await Promise.all([ff.request({ tabId: one.id, url: "https://mail.example/" }), ff.request({ tabId: two.id, url: "https://mail.example/" })]);
  assert.ok(answers.every(a => a.cancel));
  await wait(1200);
  const list = ff.store.essentials ?? [];
  assert.equal(list.find(e => e.key === "e").cookieStoreId, A, "to the first's space");
  assert.equal(list.length, 2, "and the other essential is not lost");
  for (const id of [w.id, other.id]) {
    const copies = ff.list(id).filter(t => ff.values.get(t.id)?.essentialKey === "e");
    assert.deepEqual(copies.map(t => t.cookieStoreId), [A], "one copy in each window");
    assert.equal(copies[0].active, true, "selected where the old one was");
  }
  assert.ok(ff.log.slice(before).filter(l => l[0] === "create").length <= 2, "only one round of new copies");
  assert.deepEqual(x.errors, []);
  x.kill();
});

// --- A rule pointing at nothing ---------------------------------------------------------
test("a rule pointing at a removed space counts for nothing: the link opens in the active space, and nothing is lost", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: DEAD }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w);
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true);
  await wait(300);
  assert.equal(opened(ff, w.id, WORK)[0]?.cookieStoreId, A, "opened all the same");
  const inSpace = newTab(ff, x, w, { cookieStoreId: B });
  let tried = 0;
  x.b.tabs.create = (create => async p => { tried++; return create(p); })(x.b.tabs.create);
  assert.equal((await ff.request({ tabId: inSpace.id, url: "https://work.example/y" })).cancel, undefined);
  assert.equal(tried, 0, "and it is not even tried");
  assert.ok(ff.tabs.has(inSpace.id));
  x.kill();
});

test("a rule pointing at a removed space, without the permission: the page is not closed", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set();
  ff.store.rules = [{ url: "work.example", space: DEAD }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  ff.navigate(t.id, WORK);
  await wait(500);
  assert.ok(ff.tabs.has(t.id), "it would otherwise be gone, and opened nowhere");
  assert.equal(opened(ff, w.id, WORK).length, 1);
  x.kill();
});

test("a rule whose space is removed while Tidier runs, by Firefox's own settings, stops counting at once", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  ff.containers.delete(B);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: B, name: "B" } });
  const t = newTab(ff, x, w);
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true);
  await wait(300);
  assert.equal(opened(ff, w.id, WORK)[0]?.cookieStoreId, A);
  x.kill();
});

test("the space you are in removed by Firefox's own settings: a link still opens, in a space that exists", async () => {
  const ff = new FakeFirefox();
  const { w, home } = aWindow(ff);
  const x = await run(ff);
  home.active = false;
  const blank = ff.addTab(w.id, { url: "about:blank", active: true });
  ff.containers.delete(A);
  x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: A, name: "A" } });
  await wait(500);
  const t = newTab(ff, x, w);
  assert.equal((await ff.request({ tabId: t.id, url: "https://link.example/" })).cancel, true);
  await wait(300);
  const [n] = opened(ff, w.id, "https://link.example/");
  assert.ok(n, "it opens");
  assert.ok(ff.containers.has(n.cookieStoreId) && n.cookieStoreId !== NONE, n.cookieStoreId);
  assert.ok(blank);
  x.kill();
});

test("containers turned off: no rule, no space, and every page simply loads", async () => {
  const ff = new FakeFirefox({ containers: ["firefox-default"] });
  ff.containersOff = true;
  ff.store.rules = [{ url: "work.example", space: B }];
  const w = ff.addWindow({ focused: true });
  const x = await run(ff);
  const t = newTab(ff, x, w);
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, undefined, "with nowhere to go, it loads");
  assert.ok(ff.tabs.has(t.id));
  x.kill();
});

test("the space you switched to is still the one after a restart, and a link opens with its logins", async () => {
  const ff = new FakeFirefox();
  const { w, home } = aWindow(ff);
  const inB = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: B });
  const x = await run(ff);
  ff.select(inB.id); // a tab of another space: that takes you there
  await wait(300);
  await x.js("switchSpace")(w.id, A); // and ⌃1 back
  x.kill();
  assert.equal(ff.tabs.get(home.id).active, true);
  const y = await run(ff);
  const t = newTab(ff, y, w);
  assert.equal((await ff.request({ tabId: t.id, url: "https://link.example/" })).cancel, true);
  await wait(300);
  assert.equal(opened(ff, w.id, "https://link.example/")[0].cookieStoreId, A);
  y.kill();
});

// --- Opening fails, or takes too long ----------------------------------------------------
test("opening fails for a link with no container: the tab is kept and the line names the address, so it isn't lost", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  const x = await run(ff);
  const said = [];
  x.ctx.say = (windowId, text) => said.push(text);
  x.b.tabs.create = async () => { throw new Error("no"); };
  const t = newTab(ff, x, w);
  assert.equal((await ff.request({ tabId: t.id, url: "https://link.example/page" })).cancel, true);
  assert.ok(ff.tabs.has(t.id));
  assert.ok(said.some(s => s.includes("https://link.example/page")), said.join());
  x.kill();
});

test("a tab that takes too long to open and comes after all: never two of it", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  x.ctx.say = () => {};
  const create = x.b.tabs.create;
  let release;
  x.b.tabs.create = p => new Promise(resolve => { release = () => resolve(create(p)); });
  // In a space: not sent from here, even so. The late tab is the page, and the empty one goes.
  const inSpace = newTab(ff, x, w, { cookieStoreId: A });
  assert.equal((await ff.request({ tabId: inSpace.id, url: WORK })).cancel, true);
  x.b.tabs.create = create;
  release();
  await wait(300);
  assert.equal(opened(ff, w.id, WORK).length, 1);
  assert.equal(opened(ff, w.id, WORK)[0].cookieStoreId, B);
  assert.ok(!ff.tabs.has(inSpace.id), "the empty one goes");

  // A tab showing a page keeps it, whenever the new one comes.
  x.b.tabs.create = p => new Promise(resolve => { release = () => resolve(create(p)); });
  const showing = newTab(ff, x, w, { cookieStoreId: A, url: "https://old.example/" });
  assert.equal((await ff.request({ tabId: showing.id, url: "https://work.example/two" })).cancel, true);
  x.b.tabs.create = create;
  release();
  await wait(300);
  assert.equal(opened(ff, w.id, "https://work.example/two").length, 1);
  assert.ok(ff.tabs.has(showing.id));

  // Outside any container: the request was stopped, so the late tab is the one to keep.
  x.b.tabs.create = p => new Promise(resolve => { release = () => resolve(create(p)); });
  const none = newTab(ff, x, w);
  assert.equal((await ff.request({ tabId: none.id, url: "https://link.example/" })).cancel, true);
  x.b.tabs.create = create;
  release();
  await wait(300);
  assert.equal(opened(ff, w.id, "https://link.example/").length, 1);
  assert.ok(!ff.tabs.has(none.id), "the empty one goes");
  x.kill();
});

test("nothing can hold a navigation for ever: a request is let through after a limit, and such a page is moved after all", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  const x = await run(ff);
  // Firefox's tabs API does not answer, which nobody can rule out while it starts.
  const get = x.b.tabs.get;
  let hung = false;
  x.b.tabs.get = id => { if (hung) return get(id); hung = true; return new Promise(() => {}); };
  const t = newTab(ff, x, w);
  const answer = await Promise.race([ff.request({ tabId: t.id, url: "https://link.example/" }), realSleep(5000).then(() => "held")]);
  assert.notEqual(answer, "held", "the page would never have loaded, in any tab");
  assert.equal(answer.cancel, undefined);
  ff.navigate(t.id, "https://link.example/");
  await wait(600);
  assert.equal(opened(ff, w.id, "https://link.example/")[0]?.cookieStoreId, A, "it does not stay outside the spaces");
  x.kill();
});

test("an error while deciding lets the request go, and is noted", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [null, 7, { url: 7, space: B }, { space: B }, { url: "work.example", space: B }];
  const { w, home } = aWindow(ff);
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: home.id, url: "https://plain.example/" })).cancel, undefined, "a rule that makes no sense counts for nothing");
  const t = newTab(ff, x, w, { cookieStoreId: A });
  assert.equal((await ff.request({ tabId: t.id, url: WORK })).cancel, true, "and the good one still does");
  x.kill();
});

// --- A loop -----------------------------------------------------------------------------
test("two rules and redirects between their addresses: nothing moves, and nothing opens more than once", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "one.example", space: B }, { url: "two.example", space: C }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  const first = await ff.request({ tabId: t.id, url: "https://one.example/", requestId: "a" });
  assert.equal(first.cancel, true);
  await wait(300);
  const [n] = opened(ff, w.id, "https://one.example/");
  assert.equal(n.cookieStoreId, B);
  const tabs = ff.list(w.id).length;
  assert.equal((await ff.request({ tabId: n.id, url: "https://one.example/", requestId: "b" })).cancel, undefined);
  // The server answers each with a redirect to the other, until Firefox gives up.
  for (let i = 0; i < 20; i++) assert.equal((await ff.request({ tabId: n.id, url: i % 2 ? "https://one.example/" : "https://two.example/", requestId: "b" })).cancel, undefined);
  await wait(300);
  assert.equal(ff.list(w.id).length, tabs);
  x.kill();
});

test("two pages sending each other on with no page's name on it (a sandboxed frame does that): it stops, and no storm of tabs", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "one.example", space: B }, { url: "two.example", space: C }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  x.ctx.say = () => {};
  const before = ff.list(w.id).length;
  let t = ff.addTab(w.id, { url: "https://start.example/", cookieStoreId: A });
  const asks = ["https://one.example/", "https://two.example/"];
  let moves = 0;
  for (let i = 0; i < 12; i++) {
    const url = asks[i % 2];
    const answer = await ff.request({ tabId: t.id, url });
    if (!answer.cancel) { ff.navigate(t.id, url); continue; }
    moves++;
    await wait(100);
    const n = opened(ff, w.id, url).at(-1);
    ff.navigate(n.id, url);
    t = ff.tabs.get(n.id);
  }
  assert.ok(moves <= 3, `moved ${moves} times`);
  assert.ok(ff.list(w.id).length <= before + 1 + 3, `${ff.list(w.id).length} tabs`);
  x.kill();
});

// --- Rules: what a rule can do to every navigation ---------------------------------------
test("a catastrophic regular expression holds nothing up", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "/(a+)+$/", space: B }, { url: "/(a|a)*x/", space: B }, { url: "/(.*)*(.*)*(.*)*z/", space: B }, { url: "/a.*.*.*.*.*.*.*.*.*.*.*.*q/", space: B }, { url: "/((a*)*)*b$/", space: B }];
  const { home } = aWindow(ff);
  const x = await run(ff);
  const evil = `https://evil.invalid/${"a".repeat(5000)}!`;
  const t0 = performance.now();
  const answer = await ff.request({ tabId: home.id, url: evil });
  const ms = performance.now() - t0;
  assert.equal(answer.cancel, undefined);
  assert.ok(ms < 500, `took ${Math.round(ms)} ms`);
  x.kill();
});

test("a rule that makes no sense matches nothing and costs nothing", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "/(/", space: B }, { url: "/[/", space: B }, { url: "/a/zz/", space: B }, { url: "/a/xyz", space: B }];
  const { w, home } = aWindow(ff);
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: home.id, url: "https://a.example/" })).cancel, undefined);
  assert.equal(x.js("ruleMatches")("/(/", "https://a.example/("), false);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("what it costs: a navigation in the right container with many rules takes a few microseconds, and looks nothing up", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = Array.from({ length: 50 }, (_, i) => i % 2 ? { url: `/^https:\\/\\/(www\\.)?site${i}\\.example\\//`, space: B } : { url: `site${i}.example`, space: C });
  const { w, home } = aWindow(ff);
  const x = await run(ff);
  let lookups = 0;
  for (const api of ["tabs", "windows"]) { const get = x.b[api].get; x.b[api].get = async id => { lookups++; return get(id); }; }
  const n = 2000, url = "https://plain.example/a/long/enough/path?with=some&query=too";
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await ff.request({ tabId: home.id, url });
  const each = (performance.now() - t0) / n;
  assert.equal(lookups, 0);
  assert.ok(each < 3, `${each.toFixed(3)} ms each`); // very generous: this is a machine with a lot else to do
  x.kill();
});
