// The menu on a tab: which items it offers (sidebar/tabmenu.js, a table with no Firefox in
// it), and what they do on Tidier's real background scripts (tabactions.js, on a fake
// Firefox). Above all, that a row is not its tab: a placeholder's actions reach the real
// tab, wherever it is, and a copy never takes over the original's record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const FOLDER = { group: true, own: true, name: "Work", cookieStoreId: C1, parentKey: null, rank: 1 };

async function alone(ff) {
  ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  x.said = [];
  x.ctx.say = (windowId, text, options) => x.said.push({ text, ...options });
  return x;
}
const act = async (x, windowId, action, tabIds, more = {}) => {
  await x.js("serial")(() => x.js("tabAction")(windowId, { action, tabIds, ...more }));
  await wait(500); // the record's write, a moment after the last change
};

// --- Which items it offers ----------------------------------------------------------
function menu({ folders = [], spaces = [{ id: C1, name: "One" }, { id: C2, name: "Two", color: "#123" }], renameKept } = {}) {
  const sent = [], copied = [];
  const clipboard = { writeText: async text => { copied.push(text); } };
  const ctx = vm.createContext({ view: { folders, spaces, space: C1 }, send: m => sent.push(m), window: renameKept ? { renameKept } : {}, renameNext: false, document: {}, browser: {}, navigator: { clipboard }, console });
  vm.runInContext(readFileSync(new URL("../sidebar/tabmenu.js", import.meta.url), "utf8"), ctx);
  const items = vm.runInContext("tabMenuItems", ctx);
  // Arrays from another context compare as different: these are made here.
  return { sent, copied, ctx, items, labels: tabs => Array.from(items(tabs), i => (i ? i[0] : "|")) };
}
const row = (more = {}) => ({ id: 1, tile: false, kept: false, loaded: true, muted: false, address: "https://a.example/", folder: null, liveFolder: false, space: C1, ruled: false, ...more });
const tile = (more = {}) => row({ tile: true, kept: true, ...more });

test("a loaded row offers everything, in order, in groups", () => {
  assert.deepEqual(menu().labels([row()]), ["Reload", "Mute", "Unload", "|", "Duplicate", "Copy address", "|", "Make essential", "Move to folder", "Move to space", "Always open this site here", "|", "Close"]);
});

test("a row whose page is not loaded anywhere has nothing to reload, mute or unload", () => {
  assert.deepEqual(menu().labels([row({ loaded: false })]), ["Duplicate", "Copy address", "|", "Make essential", "Move to folder", "Move to space", "Always open this site here", "|", "Close"]);
});

test("a muted page offers Unmute, and a new tab only Close", () => {
  assert.ok(menu().labels([row({ muted: true })]).includes("Unmute"));
  assert.ok(!menu().labels([row({ muted: true })]).includes("Mute"));
  assert.deepEqual(menu().labels([row({ loaded: false, address: null })]), ["Close"]);
});

test("a page of Firefox's own can be reloaded and closed, not unloaded or moved", () => {
  assert.deepEqual(menu().labels([row({ address: null })]), ["Reload", "Mute", "|", "Close"]);
});

test("a tile has no folder, space or rule, and can be taken out of the essentials", () => {
  assert.deepEqual(menu().labels([tile()]), ["Reload", "Mute", "Unload", "|", "Duplicate", "Copy address", "|", "Remove from essentials", "|", "Close"]);
  // Closing a tile that is not loaded would only draw the same placeholder again.
  assert.deepEqual(menu().labels([tile({ loaded: false })]), ["Duplicate", "Copy address", "|", "Remove from essentials"]);
});

test("Rename is only on essentials and saved tabs, and only once it can be done", () => {
  const renameKept = () => {};
  assert.ok(!menu().labels([tile()]).includes("Rename"), "nothing is offered that does nothing");
  assert.ok(menu({ renameKept }).labels([tile()]).includes("Rename"));
  assert.ok(menu({ renameKept }).labels([row({ kept: true, folder: "F" })]).includes("Rename"));
  assert.ok(!menu({ renameKept }).labels([row()]).includes("Rename"));
  assert.deepEqual(menu({ renameKept }).labels([row({ kept: true, folder: "F" })]).slice(5, 9), ["Copy address", "|", "Rename", "|"]);
});

test("with several tabs, labels count them, and what takes one tab is left out", () => {
  const renameKept = () => {};
  assert.deepEqual(menu({ renameKept }).labels([row({ id: 1 }), row({ id: 2, kept: true, folder: "F" }), row({ id: 3 })]),
    ["Reload 3 tabs", "Mute 3 tabs", "Unload 3 tabs", "|", "Copy 3 addresses", "|", "Make 3 tabs essential", "Move 3 tabs to folder", "Move 3 tabs to space", "|", "Close 3 tabs"]);
  assert.deepEqual(menu({ renameKept }).labels([tile({ id: 1 }), tile({ id: 2 })]),
    ["Reload 2 tabs", "Mute 2 tabs", "Unload 2 tabs", "|", "Copy 2 addresses", "|", "Remove 2 from essentials", "|", "Close 2 tabs"]);
});

test("an item acts on the whole list or is left out, never greyed", () => {
  const { labels } = menu();
  const mixed = labels([row({ id: 1 }), row({ id: 2, loaded: false })]);
  assert.ok(!mixed.some(l => /Reload|Mute|Unload/.test(l)), "one of them is not loaded");
  assert.ok(labels([row({ id: 1 }), row({ id: 2, muted: true })]).includes("Mute 2 tabs"), "mutes the one that is not");
  assert.ok(labels([row({ id: 1, muted: true }), row({ id: 2, muted: true })]).includes("Unmute 2 tabs"));
  assert.ok(!labels([row({ id: 1 }), row({ id: 2, address: null })]).includes("Copy 2 addresses"));
  assert.ok(!labels([row({ id: 1 }), tile({ id: 2 })]).some(l => /essential|folder|space/.test(l)), "a mix of rows and tiles");
});

test("a live folder's tab stays where the search put it, and a rule already there is not offered", () => {
  const live = menu().labels([row({ liveFolder: true, folder: "F" })]);
  assert.ok(!live.includes("Move to folder") && !live.includes("Move to space"));
  assert.ok(!menu().labels([row({ ruled: true })]).includes("Always open this site here"));
  assert.ok(!menu().labels([row({ space: "firefox-default" })]).includes("Always open this site here"));
});

test("the lists in place: other folders and spaces, and New folder last", () => {
  const folders = [{ key: "F", name: "Work" }, { key: "G", name: "Home" }, { key: "L", name: "Pull requests", live: "prs" }];
  const m = menu({ folders });
  const sub = (tabs, label) => Array.from(m.items(tabs).find(i => i?.[0] === label)[1], i => i[0]);
  assert.deepEqual(sub([row()], "Move to folder"), ["Work", "Home", "New folder"], "no live folder, and no folder for a tab in none");
  assert.deepEqual(sub([row({ folder: "F" })], "Move to folder"), ["No folder", "Home", "New folder"], "not where it already is");
  assert.deepEqual(sub([row({ id: 1, folder: "F" }), row({ id: 2 })], "Move 2 tabs to folder"), ["No folder", "Work", "Home", "New folder"]);
  assert.deepEqual(sub([row()], "Move to space"), ["Two"]);
  const only = menu({ spaces: [{ id: C1, name: "One" }] });
  assert.ok(!only.labels([row()]).includes("Move to space"), "nowhere to go");
});

test("another file can add an item to the table, in its group", () => {
  const m = menu();
  vm.runInContext(`TAB_MENU.push({ id: "extra", group: 2, label: () => "Copy for later", when: () => true, run() {} })`, m.ctx);
  const labels = m.labels([row()]);
  assert.deepEqual(labels.slice(labels.indexOf("Duplicate"), labels.indexOf("Make essential")), ["Duplicate", "Copy address", "Copy for later", "|"]);
});

test("Copy takes one address per line, on the click", () => {
  const m = menu();
  m.items([row()]).find(i => i?.[0] === "Copy address")[1]();
  m.items([row({ id: 1, address: "https://a.example/x" }), row({ id: 2, address: "https://b.example/y" })]).find(i => i?.[0] === "Copy 2 addresses")[1]();
  assert.deepEqual(m.copied, ["https://a.example/", "https://a.example/x\nhttps://b.example/y"]);
  assert.deepEqual(m.sent, [], "nothing to ask the background");
});

test("items send one list, and Close one message per tab", () => {
  const m = menu({ folders: [{ key: "F", name: "Work" }] });
  const tabs = [row({ id: 7 }), row({ id: 8 })];
  m.items(tabs).find(i => i?.[0] === "Reload 2 tabs")[1]();
  m.items(tabs).find(i => i?.[0] === "Close 2 tabs")[1]();
  m.items(tabs).find(i => i?.[0] === "Move 2 tabs to folder")[1].find(i => i[0] === "Work")[1]();
  m.items(tabs).find(i => i?.[0] === "Move 2 tabs to space")[1][0][1]();
  m.items(tabs).find(i => i?.[0] === "Move 2 tabs to folder")[1].at(-1)[1]();
  assert.equal(vm.runInContext("renameNext", m.ctx), true, "the new folder's name is then taken up for renaming");
  assert.deepEqual(JSON.parse(JSON.stringify(m.sent)), [
    { type: "tabAction", action: "reload", tabIds: [7, 8] },
    { type: "close", tabId: 7 }, { type: "close", tabId: 8 },
    { type: "tabAction", action: "folder", tabIds: [7, 8], folder: "F" },
    { type: "tabAction", action: "space", tabIds: [7, 8], space: C2 },
    { type: "tabAction", action: "newFolder", tabIds: [7, 8], space: C1 },
  ]);
});

// --- Good names and anchored rules -----------------------------------------------------
test("a new folder's name: the site, what the titles share, the shared site, the first title", () => {
  const ff = new FakeFirefox(), x = ff.boot(), name = x.js("folderNameFor");
  const t = (title, address) => ({ title, address });
  x.kill();
  assert.equal(name([t("Pull request #1", "https://github.com/a/b/pull/1")]), "Github");
  assert.equal(name([t("Home", "https://www.bbc.co.uk/news")]), "Bbc");
  assert.equal(name([t("Local", "http://127.0.0.1:8000/")]), "127.0.0.1");
  assert.equal(name([t("Sprint board - Jira", "https://a.example/1"), t("Backlog - Jira", "https://b.example/2")]), "Jira", "what the titles share");
  assert.equal(name([t("Å Blåbærsyltetøy i dag", "https://a.example/"), t("Blåbærsyltetøy", "https://b.example/")]), "Blåbærsyltetøy", "not only a to z");
  assert.equal(name([t("One", "https://news.example/1"), t("Two", "https://news.example/2")]), "News", "the shared site");
  assert.equal(name([t("Jira is short", "https://a.example/"), t("A Jira board", "https://www.a.example/")]), "Jira");
  assert.equal(name([t("A cat", "https://a.example/"), t("A dog", "https://b.example/")]), "A cat", "nothing shared: the first title");
  assert.equal(name([t("", "about:blank")]), "New folder");
  assert.equal(name([t("x".repeat(90), "about:blank")]).length, 40);
  // A page decides its title: a word shared by two tabs can be any length.
  const word = "W" + "x".repeat(5000);
  assert.equal(name([t(word, "https://a.example/"), t(word, "https://b.example/")]).length, 40);
  // A host with nothing in it is no reason to lose the folder.
  assert.equal(name([t("Odd", "http://..a/")]), "..a");
});

test("a site's rule is anchored, so a sign-in passing through does not match it", () => {
  const ff = new FakeFirefox(), x = ff.boot(), text = x.js("siteRuleText"), matches = x.js("ruleMatches");
  x.kill();
  const rule = text("https://www.github.com/a/b?c=d");
  assert.equal(rule, "/^https?:\\/\\/(www\\.)?github\\.com\\//");
  for (const url of ["https://github.com/", "https://www.github.com/x", "http://github.com/y?z=1"]) assert.ok(matches(rule, url), url);
  for (const url of ["https://accounts.github.com/", "https://sign-in.example/?back=https://github.com/x", "https://github.com.evil.example/", "https://githubXcom/"]) assert.ok(!matches(rule, url), url);
  assert.ok(matches(text("https://a-b.example:8443/x"), "https://a-b.example:8443/y"), "a port is part of the site");
  assert.ok(!matches(text("https://a-b.example:8443/x"), "https://a-b.example/y"));
});

// --- The tab behind a row ---------------------------------------------------------------
// Two windows: the page live in `there`, its placeholder in `here`.
async function twoWindows(ff, key = "a", more = {}) {
  ff.store.syncedTabs = { [key]: entry("https://a.example/page", { title: "Page", ...more }) };
  const here = ff.addWindow({ focused: true }), there = ff.addWindow();
  ff.addTab(here.id, { url: "https://other.example/", active: true, cookieStoreId: C1 });
  ff.addTab(there.id, { url: "https://other.example/2", active: true, cookieStoreId: C1 });
  const ghost = ff.addTab(here.id, { url: GHOST("ghost", key), title: "ghost", cookieStoreId: C1 }, { syncKey: key, syncRole: "ghost" });
  const live = ff.addTab(there.id, { url: "https://a.example/page", title: "Page", cookieStoreId: C1 }, { syncKey: key, syncRole: "live" });
  return { here, there, ghost, live, x: await alone(ff) };
}

test("realOf: a placeholder of a page live in another window", async () => {
  const ff = new FakeFirefox();
  const { x, ghost, live } = await twoWindows(ff);
  const r = await x.js("realOf")(ghost.id);
  assert.equal(r.tab.id, live.id);
  assert.equal(r.address, "https://a.example/page");
  assert.equal(r.title, "Page");
  assert.equal(r.key, "a");
  assert.equal(r.space, C1);
  assert.equal(r.loaded, true);
  x.kill();
});

test("realOf: a placeholder with nothing loaded anywhere reads from the record", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/saved", { title: "Saved page" }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://other.example/", active: true, cookieStoreId: C1 });
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "a"), title: "Saved page", cookieStoreId: C1, discarded: true }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  const r = await x.js("realOf")(ghost.id);
  assert.equal(r.tab.id, ghost.id);
  assert.equal(r.address, "https://a.example/saved", "never ghost.html");
  assert.equal(r.loaded, false);
  x.kill();
});

test("realOf: an essential's copy, with the loaded copy elsewhere and with none loaded", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "Essential", name: "Short" }];
  const here = ff.addWindow({ focused: true }), there = ff.addWindow();
  ff.addTab(here.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  ff.addTab(there.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const copy = ff.addTab(here.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  const loaded = ff.addTab(there.id, { url: "https://e.example/inbox", pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  const x = await alone(ff);
  let r = await x.js("realOf")(copy.id);
  assert.equal(r.tab.id, loaded.id);
  assert.equal(r.address, "https://e.example/inbox", "where the page is now");
  assert.equal(r.title, "Short");
  assert.equal(r.loaded, true);
  loaded.discarded = true;
  r = await x.js("realOf")(copy.id);
  assert.equal(r.tab.id, copy.id, "none loaded: this copy");
  assert.equal(r.address, "https://e.example/", "the essential's own address");
  assert.equal(r.loaded, false);
  x.kill();
});

test("realOf: a tile with its own page acts on it, also while another copy is loaded", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E" }];
  const there = ff.addWindow(), here = ff.addWindow({ focused: true });
  ff.addTab(here.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  ff.addTab(there.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  // In the window asked first, so that "the first loaded copy" would be the other one.
  const other = ff.addTab(there.id, { url: "https://e.example/there", pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  const copy = ff.addTab(here.id, { url: "https://e.example/here", pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  const x = await alone(ff);
  // (Tidier's own start leaves one of them loaded; here both are, as for a moment they can be.)
  Object.assign(ff.tabs.get(copy.id), { url: "https://e.example/here", discarded: false });
  Object.assign(ff.tabs.get(other.id), { url: "https://e.example/there", discarded: false });
  assert.equal((await x.js("realOf")(copy.id)).tab.id, copy.id);
  assert.equal((await x.js("realOf")(other.id)).tab.id, other.id);
  x.kill();
});

test("realOf: a new tab is no page, and a closed tab is nothing", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const t = ff.addTab(w.id, { url: "about:newtab", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  const r = await x.js("realOf")(t.id);
  assert.equal(r.address, null);
  assert.equal(r.loaded, false);
  assert.equal(await x.js("realOf")(9999), null);
  x.kill();
});

test("realOf: a tab closed while its values are read is no error", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const copy = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  const x = await alone(ff);
  x.js("keyByTab").delete(copy.id);
  ff.hooks.getTabValue = async () => { throw new Error("Invalid tab ID"); };
  const r = await x.js("realOf")(copy.id);
  assert.equal(r.tab.id, copy.id);
  assert.equal(r.loaded, false);
  delete ff.hooks.getTabValue;
  x.kill();
});

test("what the menu is told is about the real tab", async () => {
  const ff = new FakeFirefox();
  const { x, ghost, live } = await twoWindows(ff);
  live.mutedInfo = { muted: true };
  const [facts] = await x.send({ type: "tabMenu", tabIds: [ghost.id] });
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), { id: ghost.id, tile: false, kept: false, loaded: true, muted: true, address: "https://a.example/page", folder: null, liveFolder: false, space: C1, ruled: false });
  assert.equal((await x.send({ type: "tabMenu", tabIds: [ghost.id, 9999] })).length, 1, "a tab closed meanwhile is left out");
  x.kill();
});

test("what the menu is told about a tile and a saved tab", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E" }];
  ff.store.syncedTabs = { F: FOLDER, a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "A" } }), b: entry("https://b.example/") };
  const w = ff.addWindow({ focused: true });
  const tile = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  const saved = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const plain = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const x = await alone(ff);
  const facts = async id => (await x.send({ type: "tabMenu", tabIds: [id] }))[0];
  assert.deepEqual([(await facts(tile.id)).kept, (await facts(tile.id)).tile, (await facts(tile.id)).folder], [true, true, null], "a tile can be renamed, and is in no folder");
  assert.deepEqual([(await facts(saved.id)).kept, (await facts(saved.id)).folder], [true, "F"], "a saved tab can be renamed, and its folder is known");
  assert.deepEqual([(await facts(plain.id)).kept, (await facts(plain.id)).folder], [false, null]);
  x.kill();
});

// --- What the items do --------------------------------------------------------------------
test("Reload and Mute reach the real tab in the other window", async () => {
  const ff = new FakeFirefox();
  const { x, here, ghost, live } = await twoWindows(ff);
  await act(x, here.id, "reload", [ghost.id]);
  assert.deepEqual(ff.log.filter(l => l[0] === "reload"), [["reload", live.id]]);
  await act(x, here.id, "mute", [ghost.id]);
  assert.equal(ff.tabs.get(live.id).mutedInfo.muted, true);
  assert.equal(ff.tabs.get(ghost.id).mutedInfo, undefined);
  await act(x, here.id, "unmute", [ghost.id]);
  assert.equal(ff.tabs.get(live.id).mutedInfo.muted, false);
  x.kill();
});

test("Unload leaves a tab not selected in its place, without moving the selection", async () => {
  const ff = new FakeFirefox();
  const { x, here, ghost, live } = await twoWindows(ff);
  await act(x, here.id, "unload", [ghost.id]);
  assert.equal(ff.tabs.get(live.id).discarded, true);
  assert.equal(ff.tabs.get(live.id).url, "https://a.example/page");
  assert.ok(ff.synced.a, "still in the record");
  assert.ok(ff.tabs.has(ghost.id));
  x.kill();
});

// The selected page, one loaded page used earlier, and a placeholder used later (its own last use says nothing).
async function selectedPage(ff, url = "https://a.example/") {
  ff.store.syncedTabs = { a: entry(url), b: entry("https://b.example/"), c: entry("https://c.example/") };
  const w = ff.addWindow({ focused: true });
  const b = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1, lastAccessed: 1000 }, { syncKey: "b", syncRole: "live" });
  const c = ff.addTab(w.id, { url: GHOST("ghost", "c"), cookieStoreId: C1, lastAccessed: 9000 }, { syncKey: "c", syncRole: "live" });
  const a = ff.addTab(w.id, { url, active: true, cookieStoreId: C1, lastAccessed: 5000 }, { syncKey: "a", syncRole: "live" });
  return { w, a, b, c, x: await alone(ff) };
}

test("Unload on the selected tab goes to a loaded tab of the space first", async () => {
  const ff = new FakeFirefox();
  const { x, w, a, b } = await selectedPage(ff);
  await act(x, w.id, "unload", [a.id]);
  assert.equal(ff.tabs.get(a.id).discarded, true);
  assert.equal(ff.tabs.get(b.id).active, true);
  assert.deepEqual(x.said, []);
  x.kill();
});

test("a selected page that refuses to unload stays, selected, and it says so", async () => {
  const ff = new FakeFirefox();
  const { x, w, a } = await selectedPage(ff);
  ff.refuseDiscard = new Set([a.id]);
  await act(x, w.id, "unload", [a.id]);
  assert.equal(ff.tabs.get(a.id).discarded, false);
  assert.equal(ff.tabs.get(a.id).active, true);
  assert.deepEqual(x.said.map(s => s.text), ["This page holds unsaved input and stayed loaded"]);
  x.kill();
});

test("unloading several never selects one about to go, and the last of a space leaves a new tab", async () => {
  const ff = new FakeFirefox();
  const { x, w, a, b } = await selectedPage(ff);
  await act(x, w.id, "unload", [a.id, b.id]);
  assert.equal(ff.tabs.get(a.id).discarded, true);
  assert.equal(ff.tabs.get(b.id).discarded, true);
  assert.equal(ff.list(w.id).find(t => t.active).url, GHOST("ghost", "c"), "only the placeholder is left");
  x.kill();

  const ff2 = new FakeFirefox();
  ff2.store.syncedTabs = { a: entry("https://a.example/") };
  const w2 = ff2.addWindow({ focused: true });
  const only = ff2.addTab(w2.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x2 = await alone(ff2);
  await act(x2, w2.id, "unload", [only.id]);
  assert.equal(ff2.tabs.get(only.id).discarded, true);
  const selected = ff2.list(w2.id).find(t => t.active);
  assert.ok(selected.id !== only.id && selected.cookieStoreId === C1);
  x2.kill();
});

test("unloading several, the page that refuses takes the selection, rather than a new tab", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/") };
  const w = ff.addWindow({ focused: true });
  const a = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const b = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  const x = await alone(ff);
  ff.refuseDiscard = new Set([b.id]);
  await act(x, w.id, "unload", [a.id, b.id]);
  assert.equal(ff.tabs.get(a.id).discarded, true);
  assert.equal(ff.tabs.get(b.id).discarded, false);
  assert.equal(ff.list(w.id).find(t => t.active).id, b.id);
  assert.equal(ff.list(w.id).length, 2, "no new tab");
  assert.deepEqual(x.said.map(s => s.text), ["This page holds unsaved input and stayed loaded"]);
  x.kill();
});

test("Duplicate of a loaded saved tab is an ordinary tab, and takes over nothing", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: FOLDER, a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "A" } }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const a = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(w.id, { url: "about:blank", cookieStoreId: C1 }); // so that "next to it" is not simply the end
  const x = await alone(ff);
  await act(x, w.id, "duplicate", [a.id]);
  const copyId = ff.log.find(l => l[0] === "duplicate")[2];
  assert.equal(ff.tabs.get(copyId).active, false, "you stay where you are");
  assert.equal(ff.index(ff.tabs.get(copyId)), ff.index(ff.tabs.get(a.id)) + 1, "next to it");
  assert.equal(ff.values.get(copyId)?.syncKey, undefined, "SessionStore's copy of Tidier's values is gone");
  ff.rm(a.id); // closed before the copy is registered: a loaded saved tab unloads
  await wait(2500);
  const keys = Object.keys(ff.synced).filter(k => !ff.synced[k].group);
  assert.equal(keys.length, 2, "the saved tab, and the copy as a tab of its own");
  const copyKey = ff.values.get(copyId).syncKey;
  assert.ok(copyKey && copyKey !== "a");
  assert.equal(ff.synced[copyKey].parentKey, null);
  assert.equal(ff.synced[copyKey].saved, undefined);
  assert.ok(ff.synced.a.saved, "the saved tab keeps its record");
  x.kill();
});

test("Duplicate of a placeholder opens the record's address in the same container", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/page", { cookieStoreId: C2 }) };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "a"), cookieStoreId: C2 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  await act(x, w.id, "duplicate", [ghost.id]);
  assert.ok(!ff.log.some(l => l[0] === "duplicate"), "a placeholder has no page to duplicate");
  const copy = ff.list(w.id).find(t => t.url === "https://a.example/page");
  assert.equal(copy.cookieStoreId, C2);
  assert.equal(copy.active, false);
  assert.ok(!copy.pinned);
  // Through the way that rules leave alone, once that is there.
  const opened = [];
  x.ctx.openUnruled = props => { opened.push(props.url); return Promise.resolve({ id: 1 }); };
  await act(x, w.id, "duplicate", [ghost.id]);
  assert.deepEqual(opened, ["https://a.example/page"]);
  x.kill();
});

test("Duplicate of a placeholder of a page in another window opens here, next to the row", async () => {
  const ff = new FakeFirefox();
  const { x, here, there, ghost, live } = await twoWindows(ff);
  ff.addTab(here.id, { url: "about:blank", cookieStoreId: C1 }); // after the placeholder
  const before = ff.list(there.id).length;
  await act(x, here.id, "duplicate", [ghost.id]);
  assert.ok(!ff.log.some(l => l[0] === "duplicate"), "Firefox would put it in the other window");
  assert.equal(ff.list(there.id).length, before, "nothing there yet");
  const copy = ff.list(here.id).find(t => t.url === ff.tabs.get(live.id).url);
  assert.ok(copy, "it is here");
  assert.equal(copy.index, ff.index(ff.tabs.get(ghost.id)) + 1, "next to the row you clicked");
  assert.equal(copy.cookieStoreId, C1);
  assert.equal(copy.active, false);
  x.kill();
});

test("Duplicate of an essential is an ordinary tab, loaded or not", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E" }];
  const w = ff.addWindow({ focused: true });
  const copy = ff.addTab(w.id, { url: "https://e.example/inbox", pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  await act(x, w.id, "duplicate", [copy.id]);
  const copyId = ff.log.find(l => l[0] === "duplicate")[2];
  assert.equal(ff.values.get(copyId)?.essentialKey, undefined);
  assert.equal(ff.tabs.get(copyId).pinned, false);
  await wait(2500);
  assert.equal(ff.store.essentials?.length ?? 1, 1);
  assert.equal(Object.values(ff.synced).filter(e => e.url === "https://e.example/inbox").length, 1, "a tab of its own");
  x.kill();
});

test("a copy closed before it starts is no reason to stop the queue", async () => {
  const ff = new FakeFirefox();
  const { x, here, live } = await twoWindows(ff);
  x.b.tabs.duplicate = () => new Promise(() => {}); // as Firefox does then: no answer, ever
  await act(x, here.id, "duplicate", [live.id]);
  assert.equal(await x.js("serial")(() => "free"), "free");
  x.kill();
});

test("a rule does not send a copy away", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  ff.store.rules = [{ url: "a.example", space: C2 }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const a = ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  await act(x, w.id, "duplicate", [a.id]);
  await wait(300);
  const copyId = ff.log.find(l => l[0] === "duplicate")[2];
  assert.ok(ff.tabs.has(copyId));
  assert.equal(ff.tabs.get(copyId).cookieStoreId, C1);
  assert.ok(!ff.list(w.id).some(t => t.cookieStoreId === C2));
  x.kill();
});

test("Make essential pins the real tab, and Remove the loaded copy", async () => {
  const ff = new FakeFirefox();
  const { x, here, there, ghost, live } = await twoWindows(ff);
  await act(x, here.id, "essential", [ghost.id]);
  await wait(800);
  assert.equal(ff.tabs.get(live.id).pinned, true, "the loaded page stays loaded");
  assert.equal(ff.store.essentials.length, 1);
  assert.equal(ff.store.essentials[0].url, "https://a.example/page");
  assert.equal(ff.synced.a, undefined, "an essential has left the tab record");
  const tileHere = ff.list(here.id).find(t => t.pinned);
  assert.ok(tileHere && tileHere.id !== live.id, "a copy here");
  await act(x, here.id, "removeEssential", [tileHere.id]);
  assert.equal(ff.tabs.get(live.id).pinned, false, "the page there stays, as an ordinary tab");
  await wait(2500);
  assert.equal(ff.store.essentials.length, 0);
  assert.ok(ff.list(there.id).some(t => t.url === "https://a.example/page"));
  x.kill();
});

test("a tab moved a moment ago can be made essential: tab sync must not miss it", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const here = ff.addWindow({ focused: true }), there = ff.addWindow();
  const a = ff.addTab(here.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  ff.addTab(here.id, { url: "about:blank", cookieStoreId: C1 }); // so that going last is a move
  ff.addTab(there.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  ff.addTab(there.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await alone(ff);
  // In one go, within the moment a moved tab stays marked as being moved.
  await x.js("serial")(async () => {
    await x.js("tabAction")(here.id, { action: "folder", tabIds: [a.id], folder: null });
    assert.ok(x.js("syncBusy").has(a.id), "marked, or this does not test it");
    await x.js("tabAction")(here.id, { action: "essential", tabIds: [a.id] });
  });
  await wait(2000);
  assert.equal(ff.synced.a, undefined, "it has left the tab record");
  assert.equal(ff.store.essentials.length, 1);
  assert.ok(!ff.list(there.id).some(t => t.url === GHOST("ghost", "a")), "and its placeholder there");
  x.kill();
});

test("a tile made a moment ago can be taken out again: the essentials must not miss it", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "E" }];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const tile = ff.addTab(w.id, { url: "https://e.example/", pinned: true, cookieStoreId: C1, index: 0 }, { essentialKey: "e" });
  const x = await alone(ff);
  x.js("busy").add(tile.id); // as for a copy just created, or a placeholder just pinned
  await act(x, w.id, "removeEssential", [tile.id]);
  await wait(2500);
  assert.deepEqual(ff.store.essentials, [], "out of the list");
  assert.ok(ff.tabs.has(tile.id) && !ff.tabs.get(tile.id).pinned, "and an ordinary tab");
  x.kill();
});

test("a folder deleted while the menu was open: the tab stays where it is, and stays saved", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: FOLDER, a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "A" } }) };
  const w = ff.addWindow({ focused: true });
  const a = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  await act(x, w.id, "folder", [a.id], { folder: "deleted-in-the-other-window" });
  assert.equal(ff.synced.a.parentKey, "F");
  assert.ok(ff.synced.a.saved);
  x.kill();
});

test("Move to folder and New folder take every tab, and the name comes from them", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/1", { title: "Board - Jira" }), b: entry("https://b.example/2", { title: "Backlog - Jira" }) };
  const w = ff.addWindow({ focused: true }), v = ff.addWindow();
  const a = ff.addTab(w.id, { url: "https://a.example/1", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  // A placeholder here, with the page in the other window.
  const b = ff.addTab(w.id, { url: GHOST("ghost", "b"), cookieStoreId: C1 }, { syncKey: "b", syncRole: "ghost" });
  ff.addTab(v.id, { url: "https://b.example/2", active: true, cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  ff.addTab(v.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const x = await alone(ff);
  await act(x, w.id, "newFolder", [a.id, b.id], { space: C1 });
  const [key] = Object.keys(ff.synced).filter(k => ff.synced[k].own);
  assert.equal(ff.synced[key].name, "Jira");
  assert.equal(ff.synced[key].cookieStoreId, C1);
  assert.equal(ff.synced.a.parentKey, key);
  assert.equal(ff.synced.b.parentKey, key);
  assert.ok(ff.synced.a.saved && ff.synced.b.saved, "in a folder, a tab is saved");
  await act(x, w.id, "folder", [a.id], { folder: null });
  assert.equal(ff.synced.a.parentKey, null);
  assert.equal(ff.synced.a.saved, undefined);
  x.kill();
});

test("a tab opened a moment ago can go into a folder at once", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  const key = await x.js("createFolder")("Work", C1);
  const t = ff.addTab(w.id, { url: "https://new.example/", cookieStoreId: C1 });
  x.b.tabs.onCreated.fire(ff.snap(t));
  await act(x, w.id, "folder", [t.id], { folder: key });
  const k = Object.keys(ff.synced).find(k => ff.synced[k].url === "https://new.example/");
  assert.equal(ff.synced[k].parentKey, key);
  x.kill();
});

test("Move to space moves the placeholder's page, and you stay", async () => {
  const ff = new FakeFirefox();
  const { x, here, ghost, live } = await twoWindows(ff);
  const selected = ff.list(here.id).find(t => t.active).id;
  await act(x, here.id, "space", [ghost.id], { space: C2 });
  await wait(500);
  assert.ok(!ff.tabs.has(live.id) && !ff.tabs.has(ghost.id));
  assert.ok([...ff.tabs.values()].some(t => t.url === "https://a.example/page" && t.cookieStoreId === C2));
  assert.equal(ff.list(here.id).find(t => t.active).id, selected);
  x.kill();
});

test("Always open this site here adds an anchored rule that comes first, says so, and can be undone", async () => {
  const ff = new FakeFirefox();
  const old = [{ url: "a.example", space: C2 }, { url: "other.example", space: C2 }];
  ff.store.rules = old;
  const { x, here, ghost } = await twoWindows(ff);
  await act(x, here.id, "rule", [ghost.id]);
  const rules = await x.js("rulesList").get();
  assert.deepEqual(JSON.parse(JSON.stringify(rules)), [{ url: "/^https?:\\/\\/(www\\.)?a\\.example\\//", space: C1 }, ...old]);
  assert.equal(x.said[0].text, "a.example now always opens in firefox-container-1");
  const [facts] = await x.send({ type: "tabMenu", tabIds: [ghost.id] });
  assert.equal(facts.ruled, true, "the menu no longer offers it");
  x.said[0].undo();
  assert.deepEqual(JSON.parse(JSON.stringify(await x.js("rulesList").get())), old);
  x.kill();
});

test("Close acts on the page: a saved tab loaded elsewhere is unloaded, not removed", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { F: FOLDER, a: entry("https://a.example/", { parentKey: "F", saved: { url: "https://a.example/", title: "A" } }) };
  const here = ff.addWindow({ focused: true }), there = ff.addWindow();
  ff.addTab(here.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  ff.addTab(there.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const ghost = ff.addTab(here.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  const live = ff.addTab(there.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = await alone(ff);
  assert.equal(await x.js("closeTargetOf")(ghost.id), live.id);
  // The sidebar's own message, as × and the menu send it.
  const port = { name: "sidebar", sender: { id: "tidier" }, onMessage: { ls: [], addListener(f) { this.ls.push(f); } }, onDisconnect: { addListener() {} }, postMessage() {} };
  x.b.runtime.onConnect.fire(port);
  await port.onMessage.ls[0]({ type: "hello", windowId: here.id });
  await port.onMessage.ls[0]({ type: "close", tabId: ghost.id });
  await wait(1500);
  assert.ok(ff.synced.a, "still saved");
  assert.ok(!ff.tabs.has(live.id), "the page is gone");
  assert.ok(ff.tabs.has(ghost.id), "its placeholder stays");
  // Now nothing is loaded: closing it removes it for good, as README says.
  assert.equal(await x.js("closeTargetOf")(ghost.id), ghost.id);
  x.kill();
});

test("with the setting off, the sidebar's messages for the menu do nothing", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const w = ff.addWindow({ focused: true });
  const a = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  const port = { name: "sidebar", sender: { id: "tidier" }, onMessage: { ls: [], addListener(f) { this.ls.push(f); } }, onDisconnect: { addListener() {} }, postMessage() {} };
  x.b.runtime.onConnect.fire(port);
  await port.onMessage.ls[0]({ type: "hello", windowId: w.id });
  ff.log.length = 0;
  for (const action of ["reload", "duplicate", "essential", "unload"]) await port.onMessage.ls[0]({ type: "tabAction", action, tabIds: [a.id] });
  await wait(500);
  assert.deepEqual(ff.log, []);
  assert.equal(ff.tabs.get(a.id).pinned, false);
  x.kill();
});

test("with the setting off, a close is of the tab itself", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = { a: entry("https://a.example/") };
  const here = ff.addWindow({ focused: true }), there = ff.addWindow();
  ff.addTab(here.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  ff.addTab(there.id, { url: "about:blank", active: true, cookieStoreId: C1 });
  const ghost = ff.addTab(here.id, { url: GHOST("ghost", "a"), cookieStoreId: C1 }, { syncKey: "a", syncRole: "ghost" });
  ff.addTab(there.id, { url: "https://a.example/", cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  assert.equal(x.js("tidierAlone"), false);
  assert.equal(await x.js("closeTargetOf")(ghost.id), ghost.id);
  x.kill();
});

test("nothing is left of Firefox's own menu items", () => {
  for (const file of ["ownfolders.js", "spaces.js", "tabactions.js"]) {
    const src = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.ok(!/browser\.menus\.|startMenus/.test(src), file);
  }
});
