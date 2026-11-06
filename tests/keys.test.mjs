// The commands of shortcuts.js and how they get their keys, with Tidier's real
// background scripts on the fake Firefox. Real key presses are in the smoke test
// (alone_shortcuts); here is which tab is next, which is what can go wrong quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeFirefox, wait } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2";
const entry = (url, more = {}) => ({ url, title: url, cookieStoreId: C1, parentKey: null, group: false, added: 1, ...more });
const folder = (name, rank, more = {}) => ({ group: true, own: true, name, cookieStoreId: C1, parentKey: null, rank, added: 1, ...more });

async function alone(ff) {
  ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire({});
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(500);
  return x;
}

// A window whose order has nothing to do with what is drawn: other spaces' essentials
// first, other spaces' tabs between, folder tabs after today's tabs, and a closed folder.
async function aWindow() {
  const ff = new FakeFirefox();
  ff.store.essentials = [
    { key: "other", url: "https://other.example/", cookieStoreId: C2, title: "Other" },
    { key: "e1", url: "https://e1.example/", cookieStoreId: C1, title: "E1" },
    { key: "e2", url: "https://e2.example/", cookieStoreId: C1, title: "E2" },
  ];
  ff.store.syncedTabs = {
    Open: folder("Open", 1), Closed: folder("Closed", 2, { collapsed: true }),
    t1: entry("https://t1.example/"), t2: entry("https://t2.example/"), x: entry("https://x.example/", { cookieStoreId: C2 }),
    o1: entry("https://o1.example/", { parentKey: "Open", saved: { url: "https://o1.example/", title: "o1" } }),
    o2: entry("https://o2.example/", { parentKey: "Open", saved: { url: "https://o2.example/", title: "o2" } }),
    c1: entry("https://c1.example/", { parentKey: "Closed", saved: { url: "https://c1.example/", title: "c1" } }),
    c2: entry("https://c2.example/", { parentKey: "Closed", saved: { url: "https://c2.example/", title: "c2" } }),
  };
  const w = ff.addWindow({ focused: true });
  const tab = {};
  const add = (name, props, values) => { tab[name] = ff.addTab(w.id, { url: `https://${name}.example/`, cookieStoreId: C1, title: name, ...props }, values); };
  add("other", { pinned: true, cookieStoreId: C2 }, { essentialKey: "other" });
  add("e2", { pinned: true }, { essentialKey: "e2" });
  add("e1", { pinned: true }, { essentialKey: "e1" });
  add("t1", { active: true }, { syncKey: "t1", syncRole: "live" });
  add("x", { cookieStoreId: C2 }, { syncKey: "x", syncRole: "live" });
  add("o2", {}, { syncKey: "o2", syncRole: "live" });
  add("c1", {}, { syncKey: "c1", syncRole: "live" });
  add("t2", {}, { syncKey: "t2", syncRole: "live" });
  add("o1", {}, { syncKey: "o1", syncRole: "live" });
  add("c2", {}, { syncKey: "c2", syncRole: "live" });
  const x = await alone(ff);
  const selected = () => ff.list(w.id).find(t => t.active).title;
  const press = async name => { x.b.commands.onCommand.fire(name, ff.snap([...ff.tabs.values()].find(t => t.active && t.windowId === w.id))); await wait(300); };
  // shortcuts.js tells a second press from a repeat by the clock, which the fake does not speed up.
  let now = performance.now();
  x.ctx.performance = { now: () => now };
  const keyPause = () => { now += 1100; };
  return { ff, w, x, tab, selected, press, keyPause };
}

test("next and previous tab go as drawn: essentials of this space, folders, today's tabs, round the ends", async () => {
  const { x, selected, press, tab, ff } = await aWindow();
  ff.select(tab.e1.id);
  await wait(100);
  const walked = [];
  for (let i = 0; i < 6; i++) { await press("next-tab"); walked.push(selected()); }
  // No "other" (another space's essential), no "x" (another space's tab), no c1 or c2 (a closed folder).
  assert.deepEqual(walked, ["e2", "o2", "o1", "t1", "t2", "e1"]);
  await press("previous-tab");
  assert.equal(selected(), "t2");
  await press("previous-tab");
  assert.equal(selected(), "t1");
  x.kill();
});

test("from the selected tab in a closed folder, the next tab is the one drawn after that folder", async () => {
  const { x, selected, press, tab, ff } = await aWindow();
  ff.select(tab.c2.id);
  await wait(100);
  await press("next-tab");
  assert.equal(selected(), "t1");
  ff.select(tab.c2.id);
  await wait(100);
  await press("previous-tab");
  assert.equal(selected(), "o1");
  x.kill();
});

test("the n-th tab counts this space's essentials first, as drawn, and past the end does nothing", async () => {
  const { x, selected, press } = await aWindow();
  await press("tab-1");
  assert.equal(selected(), "e1", "not the window's first tab, another space's essential");
  await press("tab-2");
  assert.equal(selected(), "e2");
  await press("tab-3");
  assert.equal(selected(), "o2");
  await press("tab-6");
  assert.equal(selected(), "t2");
  await press("tab-7");
  assert.equal(selected(), "t2");
  x.kill();
});

test("next and previous space go along the bar and round the ends, and back to the tab used last", async () => {
  const { x, ff, w, selected, press, tab } = await aWindow();
  const spaces = (await x.js("viewFor")(w.id)).spaces.map(s => s.id);
  assert.equal(spaces[0], C2, "the order of the bar is the essentials' here");
  tab.x.lastAccessed = Date.now() + 1000;
  await press("previous-space"); // from the second, C1, to the first
  assert.equal(x.js("activeSpace").get(w.id), C2);
  assert.equal(selected(), "x", "the tab used last there");
  await press("previous-space"); // round the end
  assert.equal(x.js("activeSpace").get(w.id), spaces.at(-1));
  await press("next-space");
  assert.equal(x.js("activeSpace").get(w.id), C2);
  await press("next-space");
  assert.equal(x.js("activeSpace").get(w.id), C1);
  assert.equal(ff.tabs.size > 0, true);
  x.kill();
});

test("the essential key pins a page and unpins it, and leaves a page without an address alone", async () => {
  const { x, ff, w, selected, press, tab, keyPause } = await aWindow();
  await press("toggle-essential");
  assert.equal(ff.tabs.get(tab.t1.id).pinned, true);
  await wait(500);
  assert.ok(ff.store.essentials.some(e => e.url === "https://t1.example/"), "it is an essential");
  keyPause();
  await press("toggle-essential");
  assert.equal(ff.tabs.get(tab.t1.id).pinned, false);
  const blank = ff.addTab(w.id, { url: "about:newtab", cookieStoreId: C1, title: "new" });
  ff.select(blank.id);
  await wait(100);
  keyPause();
  await press("toggle-essential");
  assert.equal(ff.tabs.get(blank.id).pinned, false);
  assert.equal(selected(), "new");
  x.kill();
});

test("the folder key makes a folder in the space you are in, and its view asks for its name", async () => {
  const { x, ff, w, press } = await aWindow();
  const seen = [];
  const port = { name: "sidebar", sender: { id: "tidier" }, postMessage: m => seen.push(m), onMessage: { addListener(f) { port.send = f; } }, onDisconnect: { addListener() {} } };
  for (const { f } of x.b.runtime.onConnect.ls) f(port);
  await port.send({ type: "hello", windowId: w.id });
  await press("new-folder");
  await wait(1000);
  const key = seen.find(m => m.renameFolder)?.renameFolder;
  assert.ok(key, "a view says which");
  assert.equal(ff.synced[key].name, "New folder");
  assert.equal(ff.synced[key].cookieStoreId, C1);
  assert.ok(seen.find(m => m.renameFolder).folders.some(f => f.key === key), "drawn in that same view");
  x.kill();
});

test("a key held down makes one folder and pins once, and the next press counts again", async () => {
  const { x, ff, w, tab, keyPause } = await aWindow();
  // Firefox fires the command once for each repeat of the key, and says nothing of it.
  const fire = name => x.b.commands.onCommand.fire(name, ff.snap([...ff.tabs.values()].find(t => t.active && t.windowId === w.id)));
  const hold = async name => { for (let i = 0; i < 4; i++) { fire(name); await wait(40); } await wait(400); };
  const newFolders = () => Object.values(ff.synced).filter(e => e.group && e.name === "New folder").length;
  await hold("new-folder");
  assert.equal(newFolders(), 1);
  keyPause();
  await hold("new-folder");
  assert.equal(newFolders(), 2);
  await hold("toggle-essential");
  assert.equal(ff.tabs.get(tab.t1.id).pinned, true, "an even number of repeats, and it is pinned");
  keyPause();
  await hold("toggle-essential");
  assert.equal(ff.tabs.get(tab.t1.id).pinned, false);
  x.kill();
});

test("held down, the key for the next tab goes on, one row for each repeat", async () => {
  const { x, ff, w, tab, selected } = await aWindow();
  ff.select(tab.e1.id);
  await wait(100);
  const on = () => ff.snap([...ff.tabs.values()].find(t => t.active && t.windowId === w.id));
  // All at once, from the same tab: each has to wait for the one before it to know where it goes.
  for (let i = 0; i < 3; i++) x.b.commands.onCommand.fire("next-tab", on());
  await wait(500);
  assert.equal(selected(), "o1");
  x.kill();
});

test("in a small window the keys do nothing, and copying the address still does", async () => {
  const { x, ff, w, selected, tab, press } = await aWindow();
  const small = ff.addWindow({ type: "popup" });
  const page = ff.addTab(small.id, { url: "https://small.example/", active: true });
  const copied = [];
  x.ctx.navigator.clipboard = { writeText: async t => { copied.push(t); } };
  const before = ff.ids().length;
  for (const name of ["next-tab", "next-space", "toggle-essential", "new-folder", "copy-url"]) x.b.commands.onCommand.fire(name, ff.snap(page));
  await wait(500);
  assert.equal(ff.tabs.get(page.id).pinned, false);
  assert.equal(ff.ids().length, before, "nothing opened");
  assert.equal(selected(), "t1");
  assert.equal(x.js("activeSpace").get(w.id), C1);
  assert.ok(!Object.values(ff.synced).some(e => e.group && e.name === "New folder"));
  assert.deepEqual(copied, ["https://small.example/"]);
  assert.ok(tab);
  await press("next-tab");
  assert.equal(selected(), "t2", "the normal window's keys still work");
  x.kill();
});

test("a private window's tab cannot be made an essential by a key", async () => {
  const { x, ff, press, selected } = await aWindow();
  const hidden = ff.addWindow();
  hidden.incognito = true;
  const page = ff.addTab(hidden.id, { url: "https://private.example/", active: true });
  for (const name of ["toggle-essential", "new-folder", "next-tab"]) x.b.commands.onCommand.fire(name, ff.snap(page));
  await wait(400);
  assert.equal(ff.tabs.get(page.id).pinned, false);
  assert.ok(!Object.values(ff.synced).some(e => e.group && e.name === "New folder"));
  await press("next-tab");
  assert.equal(selected(), "t2", "the normal window's keys still work");
  x.kill();
});

test("with the setting off, the new keys do nothing, and copying the address still does", async () => {
  const ff = new FakeFirefox();
  const w = ff.addWindow({ focused: true });
  const a = ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 }, { syncKey: "a", syncRole: "live" });
  const b = ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: C1 }, { syncKey: "b", syncRole: "live" });
  ff.store.syncedTabs = { a: entry("https://a.example/"), b: entry("https://b.example/") };
  const x = ff.boot();
  x.b.runtime.onStartup.fire({});
  await wait(1500);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  const copied = [];
  x.ctx.navigator.clipboard = { writeText: async t => { copied.push(t); } };
  for (const name of ["next-tab", "tab-2", "next-space", "toggle-essential", "new-folder"]) x.b.commands.onCommand.fire(name, ff.snap(a));
  await wait(300);
  assert.equal(ff.tabs.get(a.id).active, true);
  assert.equal(ff.tabs.get(b.id).active, false);
  assert.equal(ff.tabs.get(a.id).pinned, false);
  assert.ok(!Object.values(ff.synced).some(e => e.group));
  assert.equal(ff.commandsSet, undefined, "and no key is given");
  x.b.commands.onCommand.fire("copy-url", ff.snap(a));
  await wait(100);
  assert.deepEqual(copied, ["https://a.example/"]);
  x.kill();
});

// --- The keys -----------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const commandsOf = (over = {}) => Object.entries(manifest.commands).map(([name, c]) => ({ name, description: c.description, shortcut: over[name] ?? c.suggested_key?.default ?? "" }));

test("the table and the manifest agree, and no new command has a suggested key", async () => {
  const { x } = await aWindow();
  const table = x.js("COMMANDS");
  for (const c of table) if (c.key) assert.equal(c.label, manifest.commands[c.name]?.description, c.name);
  for (const name of Object.keys(manifest.commands)) assert.ok(table.some(c => c.name === name), name);
  for (const [name, c] of Object.entries(manifest.commands)) if (name !== "copy-url") assert.equal(c.suggested_key, undefined, name);
  x.kill();
});

test("every key is given at the first start, with no key given twice", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  assert.equal(ff.commandsSet["tab-1"], "Ctrl+1");
  assert.equal(ff.commandsSet["space-1"], "MacCtrl+1");
  assert.equal(ff.commandsSet["next-tab"], "Ctrl+MacCtrl+Down");
  assert.equal(ff.commandsSet["_execute_sidebar_action"], "MacCtrl+Shift+S");
  assert.equal(ff.commandsSet["copy-url"], undefined, "the manifest's");
  const keys = Object.values(ff.commandsSet);
  assert.equal(new Set(keys).size, keys.length);
  x.kill();
});

test("a key you changed or removed stays after a start, and a new command still gets its key", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  let x = await alone(ff);
  x.kill();
  // Yours from here on: next-tab changed, tab-1 removed.
  ff.commands = commandsOf({ ...ff.commandsSet, "next-tab": "Alt+Shift+J", "tab-1": "" });
  ff.commandsSet = {};
  x = await alone(ff);
  assert.deepEqual(ff.commandsSet, {}, "nothing touched");
  x.kill();
  // An update brings a command this machine has not had a key for.
  ff.store.keysGiven = ff.store.keysGiven.filter(name => name !== "new-folder");
  ff.commands = ff.commands.map(c => c.name === "new-folder" ? { ...c, shortcut: "" } : c);
  x = await alone(ff);
  assert.deepEqual(ff.commandsSet, { "new-folder": "Ctrl+Alt+N" });
  x.kill();
});

test("a machine already on Tidier alone keeps its keys, and a key someone else has is not doubled", async () => {
  const { x } = await aWindow();
  const keysToGive = x.js("keysToGive"), table = x.js("COMMANDS");
  const give = keysToGive(table, commandsOf({ "space-1": "Alt+Shift+1", "new-folder": "Ctrl+1" }), [], "mac").map(g => g.name);
  assert.ok(!give.includes("space-1"), "it has one");
  assert.ok(!give.includes("tab-1"), "⌘1 is someone else's");
  assert.ok(give.includes("tab-2"));
  // Elsewhere ⌃ is Ctrl: the spaces come first in nothing but the table's order, and nothing is doubled.
  const other = keysToGive(table, commandsOf(), [], "linux");
  assert.equal(new Set(other.map(g => g.shortcut)).size, other.length);
  assert.ok(other.every(g => !g.shortcut.includes("MacCtrl")));
  assert.equal(other.find(g => g.name === "next-tab").shortcut, "Ctrl+Alt+Down");
  x.kill();
});

test("going back to Sidebery takes every key back, and moving over again gives them anew", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  const reset = [];
  x.b.commands.reset = async name => { reset.push(name); };
  await x.js("takeKeysBack")();
  assert.ok(reset.includes("tab-1") && reset.includes("space-1") && reset.includes("_execute_sidebar_action"));
  assert.ok(!reset.includes("copy-url"), "that one is the browser's with Sidebery too, and yours if you changed it");
  assert.deepEqual(ff.store.keysGiven, []);
  x.kill();
  ff.commands = commandsOf();
  ff.commandsSet = {};
  const again = await alone(ff);
  assert.equal(ff.commandsSet["tab-1"], "Ctrl+1");
  assert.equal(ff.commandsSet["next-tab"], "Ctrl+MacCtrl+Down");
  again.kill();
});

test("keys left behind when Tidier alone ended without moving back are taken back, once", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  const offStart = async () => {
    const x = ff.boot(), reset = [];
    x.b.commands.reset = async name => { reset.push(name); };
    x.b.runtime.onStartup.fire({});
    await wait(1500);
    for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
    await wait(100);
    x.kill();
    return reset;
  };
  assert.deepEqual(await offStart(), [], "a browser that never gave them has nothing to take back");
  ff.store.keysGiven = ["tab-1", "next-tab"];
  const reset = await offStart();
  assert.ok(reset.includes("tab-1") && reset.includes("next-tab") && reset.includes("toggle-essential"));
  assert.ok(!reset.includes("copy-url"));
  assert.deepEqual(ff.store.keysGiven, []);
  assert.deepEqual(await offStart(), [], "and nothing at the next start");
});

test("a key that could not be given is tried again at the next start, and only that one", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  ff.managed = { tidierAlone: true };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  const x = ff.boot();
  const update = x.b.commands.update;
  x.b.commands.update = async c => { if (c.name === "tab-1") throw new Error("no"); return update(c); };
  x.b.runtime.onStartup.fire({});
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(500);
  x.kill();
  assert.ok(!ff.store.keysGiven.includes("tab-1"));
  assert.ok(ff.store.keysGiven.includes("next-tab"));
  // Since then you removed another key: it stays removed.
  ff.commands = commandsOf({ ...ff.commandsSet, "next-tab": "", "tab-1": "" });
  ff.commandsSet = {};
  const y = await alone(ff);
  assert.deepEqual(ff.commandsSet, { "tab-1": "Ctrl+1" });
  y.kill();
});

test("back to the usual keys doubles none where ⌃ and ⌘ are the same key, and then nothing counts as changed", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  x.b.runtime.getPlatformInfo = async () => ({ os: "linux" });
  ff.commandsSet = {};
  await x.js("keysBackToFirst")();
  const keys = Object.values(ff.commandsSet).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(ff.commandsSet["space-1"], "Ctrl+1");
  assert.equal(ff.commandsSet["tab-1"], "", "the space has that key, as it would have at a first start");
  ff.commands = commandsOf(ff.commandsSet);
  assert.ok((await x.js("commandKeys")()).every(c => !c.changed));
  x.kill();
});

test("choosing a key: another command's is refused, Firefox's tab keys are refused, Firefox's others are said", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  ff.commands = commandsOf(ff.commandsSet);
  const set = x.js("setCommandKey");
  ff.commandsSet = {};
  assert.match((await set("next-tab", "Command+1")).refused, /⌘1 is already “Go to the first tab of this space”/);
  assert.match((await set("next-tab", "Alt+Command+Down")).refused, /Firefox keeps ⌥⌘↓/);
  assert.deepEqual(ff.commandsSet, {}, "neither was set");
  assert.match((await set("next-tab", "Command+L")).note, /comes first until you clear it/);
  assert.equal(ff.commandsSet["next-tab"], "Command+L");
  assert.match((await set("next-tab", "Command+Left")).note, /both happen until you clear it/);
  assert.deepEqual({ ...(await set("next-tab", "Alt+Shift+J")) }, {});
  assert.deepEqual({ ...(await set("next-tab", "")) }, {}, "removed");
  assert.equal(ff.commandsSet["next-tab"], "");
  await x.js("keysBackToFirst")();
  assert.equal(ff.commandsSet["next-tab"], "Ctrl+MacCtrl+Down");
  assert.equal(ff.commandsSet["tab-1"], "Ctrl+1");
  x.b.commands.update = async () => { throw new Error("no"); };
  assert.match((await set("next-tab", "Command+Alt+Shift+J")).refused, /cannot be used/);
  x.kill();
});

test("the settings page's list says what each key is now and whether it was changed", async () => {
  const ff = new FakeFirefox();
  ff.commands = commandsOf();
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://a.example/", active: true, cookieStoreId: C1 });
  const x = await alone(ff);
  ff.commands = commandsOf({ ...ff.commandsSet, "next-tab": "Alt+Shift+J", "tab-1": "" });
  const list = await x.js("commandKeys")();
  const of = name => list.find(c => c.name === name);
  assert.equal(of("previous-tab").pretty, "⌃⌘↑");
  assert.equal(of("previous-tab").changed, false);
  assert.equal(of("tab-2").pretty, "⌘2");
  assert.equal(of("next-tab").pretty, "⌥⇧J");
  assert.equal(of("next-tab").changed, true);
  assert.equal(of("tab-1").pretty, "");
  assert.equal(of("tab-1").changed, true);
  assert.equal(of("copy-url").pretty, "⇧⌘C");
  x.kill();
});

// The settings page's own part, on its real file, with what it needs from the page faked.
function settingsKeys(alone) {
  const called = [], parts = {};
  const ctx = vm.createContext({
    ask: async what => { called.push(what); return alone ? [] : null; },
    $: id => (parts[id] ??= { hidden: true, replaceChildren() {} }), el: () => ({}), browser: { runtime: { getPlatformInfo: async () => ({ os: "mac" }) }, commands: {} }, document: { querySelector() {} },
  });
  vm.runInContext(readFileSync(new URL("../settings/keys.js", import.meta.url), "utf8"), ctx);
  return { ctx, called, parts };
}

test("a key pressed on the settings page reads as Firefox writes it", () => {
  const { shortcutOf } = settingsKeys(false).ctx;
  const press = o => ({ which: 0, code: "", key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  const digit = press({ which: 49, code: "Digit1", key: "1", metaKey: true });
  assert.equal(shortcutOf(digit, true), "Command+1");
  // ⌥ makes N into a dead key on a Mac; the key's code still says N.
  assert.equal(shortcutOf(press({ which: 229, code: "KeyN", key: "Dead", metaKey: true, altKey: true }), true), "Alt+Command+N");
  assert.equal(shortcutOf(press({ which: 40, code: "ArrowDown", key: "ArrowDown", metaKey: true, ctrlKey: true }), true), "MacCtrl+Command+Down");
  assert.equal(shortcutOf(press({ which: 188, code: "Comma", key: ",", ctrlKey: true, shiftKey: true }), true), "MacCtrl+Shift+Comma");
  assert.equal(shortcutOf(press({ which: 75, code: "KeyK", key: "k", ctrlKey: true }), false), "Ctrl+K", "⌘ exists only on a Mac");
  assert.equal(shortcutOf(press({ which: 116, code: "F5", key: "F5" }), true), "F5", "a function key needs no modifier");
  assert.equal(shortcutOf(press({ which: 74, code: "KeyJ", key: "j" }), true), "", "a letter does");
  assert.equal(shortcutOf(press({ which: 74, code: "KeyJ", key: "J", shiftKey: true }), true), "", "and shift is not enough");
  assert.equal(shortcutOf(press({ which: 18, code: "AltLeft", key: "Alt", altKey: true }), true), "", "only modifiers so far");
});

test("without Tidier alone the settings page has no Keys section", async () => {
  const off = settingsKeys(false);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(off.parts["keys-section"].hidden, true);
  assert.deepEqual(off.called, ["keys"], "and asks for nothing more");
  const on = settingsKeys(true);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(on.parts["keys-section"].hidden, false);
});

test("Firefox's lists are written the way keys are compared", async () => {
  const { x } = await aWindow();
  const keyId = x.js("keyId");
  for (const k of Object.keys(x.js("FIREFOX_KEYS"))) assert.equal(keyId(k, "mac"), k);
  for (const k of x.js("FIREFOX_ONLY")) assert.equal(keyId(k, "mac"), k);
  x.kill();
});
