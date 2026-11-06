// The news dot (news.js) on Tidier's real background scripts and a fake Firefox: what
// marks a tab, what does not, and what the sidebar is told. What is drawn is in the
// smoke test's alone_news.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });

async function start(ff) {
  ff.managed ??= { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire();
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  // The five quiet seconds are clock time, which the fake Firefox does not speed up.
  x.js("var clockAhead = 0; { const now = Date.now; Date.now = () => now() + clockAhead; }");
  x.quiet = () => x.js("clockAhead += 6000");
  x.title = (id, title) => {
    const t = ff.tabs.get(id);
    t.title = title;
    x.b.tabs.onUpdated.fire(id, { title }, ff.snap(t));
  };
  x.view = id => x.js(`viewFor(${id})`);
  x.marked = () => [...x.js("[...newsMarks.keys()]")].sort();
  return x;
}

// One window on a selected tab, with a loaded page beside it in the same space.
function oneWindow(ff) {
  ff.store.syncedTabs = { home: entry("https://home.example/"), chat: entry("https://chat.example/", { title: "Chat" }) };
  const w = ff.addWindow({ focused: true });
  const home = ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: C1, title: "Home" }, { syncKey: "home", syncRole: "live" });
  const chat = ff.addTab(w.id, { url: "https://chat.example/", cookieStoreId: C1, title: "Chat" }, { syncKey: "chat", syncRole: "live" });
  return { w, home, chat };
}

test("what counts as news in a title", () => {
  const ff = new FakeFirefox();
  const x = ff.boot();
  const isNews = x.js("isNews");
  // A clock, a timer or a percentage ticking says nothing.
  assert.equal(isNews("12:01:05 World clock", "12:01:06 World clock"), false);
  assert.equal(isNews("9", "10"), false);
  assert.equal(isNews("(00:05) Focus", "(00:04) Focus"), false);
  assert.equal(isNews("45% Uploading", "46% Uploading"), false);
  // A count going up is news, going down is not, wherever a page writes it.
  assert.equal(isNews("(3) Inbox", "(4) Inbox"), true);
  assert.equal(isNews("(4) Inbox", "(3) Inbox"), false);
  assert.equal(isNews("Inbox", "(1) Inbox"), true);
  assert.equal(isNews("(1) Inbox", "Inbox"), false);
  assert.equal(isNews("Inbox (3) - me - Mail", "Inbox (4) - me - Mail"), true);
  assert.equal(isNews("[9] Queue", "[10] Queue"), true);
  assert.equal(isNews("(99+) Inbox", "(99+) Inbox"), false);
  // A clock beside a count: only the count decides.
  assert.equal(isNews("(3) Inbox 12:01", "(3) Inbox 12:02"), false);
  assert.equal(isNews("(3) Inbox 12:01", "(4) Inbox 12:02"), true);
  // A new sender, or any other new words.
  assert.equal(isNews("Anna wrote - Chat", "Bob wrote - Chat"), true);
  assert.equal(isNews("Chat", "Anna wrote - Chat"), true);
  assert.equal(isNews("general - Slack", "* general - Slack"), true);
  // What is left of the old title says nothing new.
  assert.equal(isNews("* general - Slack", "general - Slack"), false);
  // Nothing to compare.
  assert.equal(isNews("Chat", "Chat"), false);
  assert.equal(isNews("", "Chat"), false);
  assert.equal(isNews("Chat", ""), false);
  x.kill();
});

test("a loaded page you are not on gets a mark, and the view carries it; selecting it clears it", async () => {
  const ff = new FakeFirefox();
  const { w, chat, home } = oneWindow(ff);
  const x = await start(ff);
  x.quiet();
  x.title(chat.id, "Anna wrote - Chat");
  assert.deepEqual(x.marked(), ["chat"]);
  const view = await x.view(w.id);
  assert.equal(view.tabs.find(t => t.id === chat.id).news, true);
  assert.equal(view.tabs.find(t => t.id === home.id).news, false);
  ff.select(chat.id);
  assert.deepEqual(x.marked(), []);
  assert.equal((await x.view(w.id)).tabs.find(t => t.id === chat.id).news, false);
  x.kill();
});

test("no mark on the selected tab, and leaving it starts the quiet again", async () => {
  const ff = new FakeFirefox();
  const { home, chat } = oneWindow(ff);
  const x = await start(ff);
  x.quiet();
  x.title(home.id, "Home, with new words");
  assert.deepEqual(x.marked(), [], "you are looking at it");
  x.quiet();
  ff.tabs.get(home.id).active = false;
  ff.tabs.get(chat.id).active = true;
  x.b.tabs.onActivated.fire({ tabId: chat.id, previousTabId: home.id, windowId: chat.windowId });
  x.title(home.id, "Home, as you left it");
  assert.deepEqual(x.marked(), [], "a page sets its title when you leave it");
  x.quiet();
  x.title(home.id, "Home, something happened");
  assert.deepEqual(x.marked(), ["home"]);
  x.kill();
});

test("no mark within five quiet seconds of a load, or of the last change", async () => {
  const ff = new FakeFirefox();
  const { chat } = oneWindow(ff);
  const x = await start(ff);
  x.title(chat.id, "Started up");
  assert.deepEqual(x.marked(), [], "just after Tidier started");
  x.quiet();
  x.b.tabs.onUpdated.fire(chat.id, { status: "loading" }, { ...ff.snap(ff.tabs.get(chat.id)), status: "loading" });
  x.title(chat.id, "Half loaded");
  x.b.tabs.onUpdated.fire(chat.id, { status: "complete" }, ff.snap(ff.tabs.get(chat.id)));
  x.title(chat.id, "App started");
  assert.deepEqual(x.marked(), [], "a page load is no news");
  x.quiet();
  x.b.tabs.onUpdated.fire(chat.id, { status: "loading" }, { ...ff.snap(ff.tabs.get(chat.id)), status: "loading" });
  x.quiet();
  const loading = { ...ff.snap(ff.tabs.get(chat.id)), status: "loading", title: "Slow page" };
  x.b.tabs.onUpdated.fire(chat.id, { title: "Slow page" }, loading);
  assert.deepEqual(x.marked(), [], "still loading, however long it takes");
  x.b.tabs.onUpdated.fire(chat.id, { status: "complete" }, ff.snap(ff.tabs.get(chat.id)));
  x.quiet();
  x.title(chat.id, "One");
  assert.deepEqual(x.marked(), ["chat"], "a word after the quiet counts");
  ff.select(chat.id);
  ff.select(ff.list(chat.windowId)[0].id);
  x.title(chat.id, "Two");
  x.quiet();
  x.title(chat.id, "Three");
  assert.deepEqual(x.marked(), ["chat"]);
  x.kill();
});

test("a restless page has no quiet, and a tick does not end the quiet", async () => {
  const ff = new FakeFirefox();
  const { chat } = oneWindow(ff);
  const x = await start(ff);
  x.title(chat.id, "First news of many");
  x.title(chat.id, "More of it");
  x.title(chat.id, "And more");
  assert.deepEqual(x.marked(), [], "words changing every moment, from the start");
  x.title(chat.id, "00:03 left");
  x.quiet();
  x.title(chat.id, "00:02 left");
  x.title(chat.id, "00:01 left");
  assert.deepEqual(x.marked(), [], "a timer ticking");
  x.title(chat.id, "Time is up");
  assert.deepEqual(x.marked(), ["chat"], "the timer ending, right after a tick");
  x.kill();
});

test("no mark on a placeholder, an unloaded tab, a page playing sound or a tab Tidier does not have", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    home: entry("https://home.example/"),
    ghosted: entry("https://ghost.example/"),
    away: entry("https://away.example/"),
    song: entry("https://song.example/"),
  };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", active: true, cookieStoreId: C1 }, { syncKey: "home", syncRole: "live" });
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "ghosted"), cookieStoreId: C1, title: "Ghost" }, { syncKey: "ghosted", syncRole: "live" });
  const away = ff.addTab(w.id, { url: "https://away.example/", discarded: true, cookieStoreId: C1, title: "Away" }, { syncKey: "away", syncRole: "live" });
  const song = ff.addTab(w.id, { url: "https://song.example/", audible: true, cookieStoreId: C1, title: "First song" }, { syncKey: "song", syncRole: "live" });
  const stranger = ff.addTab(w.id, { url: "about:addons", title: "Add-ons" });
  const x = await start(ff);
  x.quiet();
  x.title(ghost.id, "A title shown again");
  x.title(away.id, "A title while unloaded");
  x.title(song.id, "Next song");
  x.title(stranger.id, "Other add-ons");
  x.title(stranger.id, "Yet other add-ons");
  assert.deepEqual(x.marked(), []);
  x.kill();
});

test("the same tab in another window has the mark, on a closed folder and beside another space's dot, and selecting it there clears it", async () => {
  const ff = new FakeFirefox();
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Kept", cookieStoreId: C2, parentKey: null, rank: 1, collapsed: true, added: 1 },
    home: entry("https://home.example/"),
    chat: entry("https://chat.example/", { title: "Chat", cookieStoreId: C2, parentKey: "F", saved: { url: "https://chat.example/", title: "Chat" } }),
  };
  const a = ff.addWindow({ focused: true });
  ff.addTab(a.id, { url: "https://home.example/", active: true, cookieStoreId: C1 }, { syncKey: "home", syncRole: "live" });
  const chat = ff.addTab(a.id, { url: "https://chat.example/", cookieStoreId: C2, title: "Chat" }, { syncKey: "chat", syncRole: "live" });
  const b = ff.addWindow();
  ff.addTab(b.id, { url: GHOST("ghost", "home"), active: true, cookieStoreId: C1 }, { syncKey: "home", syncRole: "ghost" });
  const ghost = ff.addTab(b.id, { url: GHOST("ghost", "chat"), cookieStoreId: C2, title: "Chat" }, { syncKey: "chat", syncRole: "ghost" });
  const x = await start(ff);
  x.quiet();
  x.title(chat.id, "(1) Chat");
  for (const w of [a, b]) {
    const view = await x.view(w.id);
    assert.equal(view.space, C1);
    assert.deepEqual(view.spaces.filter(s => s.news).map(s => s.id), [C2], "beside the other space's dot");
  }
  // In the space itself, the list shows it, on its row and on its closed folder; the bar does not.
  x.js(`activeSpace.set(${b.id}, "${C2}")`);
  const there = await x.view(b.id);
  assert.equal(there.folders[0].news, true);
  assert.equal(there.folders[0].tabs.find(t => t.id === ghost.id).news, true);
  assert.deepEqual(there.spaces.filter(s => s.news), []);
  ff.select(ghost.id);
  assert.deepEqual(x.marked(), []);
  assert.equal((await x.view(b.id)).folders[0].news, false);
  assert.deepEqual((await x.view(a.id)).spaces.filter(s => s.news), []);
  x.kill();
});

test("an essential is marked by its key, in every window, and selecting a copy clears it", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "mail", url: "https://mail.example/", cookieStoreId: C1, title: "Mail", icon: "x" }];
  const a = ff.addWindow({ focused: true });
  const loaded = ff.addTab(a.id, { url: "https://mail.example/", pinned: true, cookieStoreId: C1, title: "Mail" }, { essentialKey: "mail" });
  ff.addTab(a.id, { url: "https://home.example/", active: true, cookieStoreId: C1 }, { syncKey: "home", syncRole: "live" });
  const b = ff.addWindow();
  const copy = ff.addTab(b.id, { url: GHOST("essential", "mail"), pinned: true, cookieStoreId: C1, title: "Mail" }, { essentialKey: "mail" });
  ff.store.syncedTabs = { home: entry("https://home.example/") };
  const x = await start(ff);
  x.quiet();
  x.title(loaded.id, "(1) Mail");
  assert.deepEqual(x.marked(), ["mail"]);
  assert.equal((await x.view(a.id)).essentials[0].news, true);
  assert.equal((await x.view(b.id)).essentials[0].news, true);
  ff.select(copy.id);
  assert.deepEqual(x.marked(), []);
  x.kill();
});

test("a mark and what is remembered of a page go with the page", async () => {
  const ff = new FakeFirefox();
  const { chat } = oneWindow(ff);
  const x = await start(ff);
  assert.equal(x.js("newsSeen.size"), 2);
  x.quiet();
  x.title(chat.id, "Anna wrote");
  assert.deepEqual(x.marked(), ["chat"]);
  ff.rm(chat.id);
  assert.deepEqual(x.marked(), []);
  assert.equal(x.js("newsSeen.size"), 1);
  x.kill();
});

test("a pinned tab loses the mark of the record it leaves, so no space keeps a dot nothing can clear", async () => {
  const ff = new FakeFirefox();
  const { w, chat } = oneWindow(ff);
  const x = await start(ff);
  x.quiet();
  x.title(chat.id, "Anna wrote");
  const t = ff.tabs.get(chat.id);
  t.pinned = true;
  x.b.tabs.onUpdated.fire(chat.id, { pinned: true }, ff.snap(t));
  assert.deepEqual(x.marked(), []);
  assert.ok(!(await x.view(w.id)).spaces.some(s => s.news));
  x.kill();
});

test("with the setting off nothing is marked or remembered", async () => {
  const ff = new FakeFirefox();
  ff.managed = {};
  const { chat } = oneWindow(ff);
  const x = await start(ff);
  x.quiet();
  x.title(chat.id, "Anna wrote");
  assert.deepEqual(x.marked(), []);
  assert.equal(x.js("newsSeen.size"), 0);
  x.kill();
});

test("a closed page's waiting refresh of its placeholders goes with it, so nothing runs later", async () => {
  const ff = new FakeFirefox();
  const { chat } = oneWindow(ff);
  const x = await start(ff);
  x.title(chat.id, "Anna wrote");
  await wait(100);
  assert.equal(x.js("refreshTimers.size"), 1);
  ff.rm(chat.id);
  await wait(1000); // its record is written a moment later
  assert.ok(!ff.synced.chat, "closed everywhere");
  assert.equal(x.js("refreshTimers.size"), 0);
  x.kill();
});
