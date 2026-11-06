// Unit tests for the logic that needs no Firefox: tree order and moving tabs
// without breaking Sidebery's tree. Runs in well under a second:
//
//     node --test        (in this repo; it finds the *.test.mjs files)
//
// common.js is loaded as the extension loads it (a plain script), with a fake
// `browser` whose tabs follow a model of Sidebery's tree rule (sidebery()
// below), so a move that would break the tree in Firefox breaks it here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const NONE = "firefox-default";

// --- A model of Sidebery 5.6 ----------------------------------------------
// After every tab move it did not make itself, Sidebery recalculates its tree
// (updateTabsTree in src/services/tabs.fg.ts): a parent must be above its tab
// and in the same space, and a tab whose parent is further up with other tabs
// in between takes all those tabs (same space) into the parent. A moved tab
// takes the space of the tab it lands next to when it leaves its own.
function sidebery(strip) {
  const tabs = strip.map((t, index) => ({ ...t, index }));
  const byId = new Map(tabs.map(t => [t.id, t]));
  const updateTree = () => {
    for (const [i, t] of tabs.entries()) {
      const p = byId.get(t.parent), prev = tabs[i - 1];
      if (!p || p.index >= t.index || p.space !== t.space) { t.parent = undefined; t.lvl = 0; continue; }
      t.lvl = p.lvl + 1;
      if (prev && prev.id !== p.id && prev.lvl < t.lvl) {
        for (let j = i - 1; j >= 0 && tabs[j].id !== p.id && tabs[j].space === t.space; j--) {
          tabs[j].parent = p.id;
          tabs[j].lvl = t.lvl;
        }
      }
    }
  };
  updateTree();
  return {
    tabs,
    move(id, index) {
      const t = byId.get(id), from = t.index;
      tabs.splice(from, 1);
      tabs.splice(index, 0, t);
      tabs.forEach((x, i) => { x.index = i; });
      const near = tabs[index + 1] || tabs[index - 1];
      if (near && (t.cookieStoreId === NONE || near.space !== t.space) && (tabs[index - 1]?.space === near.space)) t.space = near.space;
      updateTree();
    },
    tree: () => Object.fromEntries(tabs.map(t => [t.id, t.parent ?? null])),
    order: () => tabs.map(t => t.id),
  };
}

// --- common.js with a fake browser on top of the model ---------------------
function loadCommon(model) {
  const browser = {
    windows: { WINDOW_ID_NONE: -1, getLastFocused: async () => ({ focused: false }), onFocusChanged: { addListener() {} } },
    tabs: {
      // Sidebery keeps openerTabId equal to the parent (and clears it at the top).
      query: async () => model.tabs.map(t => ({ id: t.id, index: t.index, pinned: false, windowId: 1,
        cookieStoreId: t.cookieStoreId, url: t.url, openerTabId: t.parent })),
      move: async (id, { index }) => model.move(id, index),
      onMoved: { addListener() {} }, onRemoved: { addListener() {} },
    },
    sessions: { onChanged: { addListener() {} } },
    alarms: { onAlarm: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { getURL: p => "moz-extension://kitsune/" + p },
  };
  const context = vm.createContext({ browser, console, setTimeout, clearTimeout, URL });
  vm.runInContext(readFileSync(new URL("../common.js", import.meta.url), "utf8"), context);
  return context;
}

// A space: a folder with tabs, an empty folder, ordinary tabs.
const tab = (id, space, { parent, folder = false, cookieStoreId = space } = {}) =>
  ({ id, space, cookieStoreId, parent, url: folder ? "moz-extension://sb/sidebery/group.html#" + id : "https://example.org/" + id });
// Arrays made inside common.js belong to its own context; copy them for assert.
const plain = x => JSON.parse(JSON.stringify(x));
const items = strip => strip.map(t => ({ id: t.id, parent: t.parent, space: t.cookieStoreId, folder: t.url.includes("group.html") }));

test("tree order: each tab right after its folder, each space one run, folders first", () => {
  const { treeOrder } = loadCommon(sidebery([]));
  // As in a damaged window: B's tab b1 sits in space A, an ordinary tab is above A's folder.
  const strip = [
    tab("a-plain", "A"), tab("A1", "A", { folder: true }), tab("a1", "A", { parent: "A1" }),
    tab("b1", "B", { parent: "B1" }), tab("a2", "A", { parent: "A1" }),
    tab("B1", "B", { folder: true }), tab("b2", "B", { parent: "B1" }), tab("b-plain", "B"),
  ];
  assert.deepEqual(plain(treeOrder(items(strip))), ["A1", "a1", "a2", "a-plain", "B1", "b1", "b2", "b-plain"]);
});

test("tree order: a tab without a container belongs to the space it sits in", () => {
  const { treeOrder } = loadCommon(sidebery([]));
  const strip = [
    tab("A1", "A", { folder: true }), tab("a1", "A", { parent: "A1" }), tab("x", "A", { parent: "A1", cookieStoreId: NONE }),
    tab("a-plain", "A"), tab("y", "A", { cookieStoreId: NONE }), tab("B1", "B", { folder: true }), tab("b-plain", "B"),
  ];
  assert.deepEqual(plain(treeOrder(items(strip))), ["A1", "a1", "x", "a-plain", "y", "B1", "b-plain"]);
});

test("tree order: parents that point at each other are not lost", () => {
  const { treeOrder } = loadCommon(sidebery([]));
  const order = plain(treeOrder([{ id: "p", parent: "q", space: "A" }, { id: "q", parent: "p", space: "A" }, { id: "r", space: "A" }]));
  assert.deepEqual([...order].sort(), ["p", "q", "r"]);
});

test("the Sidebery model: moving a folder away from its tabs makes it take in the tabs between", () => {
  // The bug placeInOrder avoids: Kitsune used to move a whole folder with one
  // tabs.move call, which Firefox carries out one tab at a time.
  const model = sidebery([
    tab("a-plain", "A"), tab("A1", "A", { folder: true }), tab("a1", "A", { parent: "A1" }), tab("a2", "A", { parent: "A1" }),
  ]);
  model.move("A1", 0);
  assert.deepEqual(model.tree(), { A1: null, "a-plain": "A1", a1: "A1", a2: "A1" });
});

test("folders first without breaking the tree: ordinary tabs move below the folder", async () => {
  const strip = [
    tab("a-plain", "A"), tab("A1", "A", { folder: true }), tab("a1", "A", { parent: "A1" }), tab("a2", "A", { parent: "A1" }),
    tab("Empty", "A", { folder: true }), tab("B1", "B", { folder: true }), tab("b1", "B", { parent: "B1" }), tab("b-plain", "B"),
  ];
  const model = sidebery(strip), common = loadCommon(model), before = model.tree();
  await common.placeInOrder(1, common.treeOrder(items(model.tabs)), () => {});
  assert.deepEqual(model.tree(), before);
  assert.deepEqual(model.order(), ["A1", "a1", "a2", "Empty", "a-plain", "B1", "b1", "b-plain"]);
});

test("sorting a window never moves a tab with tabs in it", async () => {
  // Out of order on purpose, with the tree intact: B's folder above A's.
  const model = sidebery([
    tab("B1", "B", { folder: true }), tab("b1", "B", { parent: "B1" }), tab("A1", "A", { folder: true }), tab("a1", "A", { parent: "A1" }),
  ]);
  const common = loadCommon(model), before = model.tree(), moved = [];
  await common.placeInOrder(1, ["A1", "a1", "B1", "b1"], id => moved.push(id));
  assert.ok(!moved.includes("A1") && !moved.includes("B1"), `moved ${moved}`);
  assert.deepEqual(model.tree(), before);
});

test("a folder's tab that ended up below another folder is moved back to its folder", async () => {
  const model = sidebery([
    tab("A1", "A", { folder: true }), tab("a1", "A", { parent: "A1" }), tab("B1", "B", { folder: true }), tab("b1", "B", { parent: "B1" }),
    tab("a2", "A", { parent: "A1" }),
  ]);
  const common = loadCommon(model), before = model.tree();
  await common.placeInOrder(1, ["A1", "a1", "a2", "B1", "b1"], () => {});
  assert.deepEqual(model.order(), ["A1", "a1", "a2", "B1", "b1"]);
  assert.deepEqual(model.tree(), before);
});

// --- The background scripts share one scope --------------------------------
test("no two background scripts define the same top-level name", () => {
  // They are plain scripts (manifest.json, background.scripts): a function
  // defined again in a later script silently replaces the earlier one.
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const seen = new Map(), twice = [];
  for (const file of manifest.background.scripts) {
    const src = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    for (const [, name] of src.matchAll(/^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(name)) twice.push(`${name} (${seen.get(name)}, ${file})`);
      else seen.set(name, file);
    }
  }
  assert.deepEqual(twice, []);
});

// --- Saved tabs -----------------------------------------------------------
test("closing a tab: saved tabs are unloaded, unloaded ones and ordinary tabs closed", () => {
  const { closeAction } = loadCommon(sidebery([]));
  const close = o => closeAction({ role: "live", inFolder: true, liveFolder: false, unloaded: false, folderHere: true, ...o });
  assert.equal(close({}), "unload");                           // ⌘W on a loaded tab in a folder
  assert.equal(close({ unloaded: true }), "close");            // × on its placeholder: removed for good
  assert.equal(close({ role: "ghost", unloaded: true }), "close");
  assert.equal(close({ inFolder: false }), "close");           // an ordinary tab, or one dragged out of its folder
  assert.equal(close({ liveFolder: true }), "close");          // a pull request: the search decides
  assert.equal(close({ folderHere: false }), "leave");         // closed with its folder: only that window
  assert.equal(close({ liveFolder: true, folderHere: false }), "leave");
  assert.equal(close({ role: "copy" }), "copy");               // a folder copy: only its own window
});

test("a tab gets its saved address when it comes into a folder, and loses it when it leaves", () => {
  const { noteSaved, storedInFolder } = loadCommon(sidebery([]));
  const all = {
    F: { group: true, url: "moz-extension://sb/sidebery/group.html#F" },
    a: { parentKey: "F", url: "https://example.org/board", title: "Board" },
    b: { parentKey: "a", url: "https://example.org/b", title: "B" },      // below a tab in the folder
    p: { parentKey: "F", url: "https://github.com/x/pull/1", liveFolder: "prs" },
    o: { parentKey: null, url: "https://example.org/o", title: "O" },
  };
  noteSaved(all);
  assert.deepEqual(plain(all.a.saved), { url: "https://example.org/board", title: "Board" });
  assert.ok(all.b.saved && !all.p.saved && !all.o.saved && !all.F.saved);
  all.a.url = "https://example.org/issue-1";                         // browsing on keeps the saved address
  noteSaved(all);
  assert.equal(all.a.saved.url, "https://example.org/board");
  all.a.parentKey = null;                                            // dragged out
  noteSaved(all);
  assert.ok(!all.a.saved && !all.b.saved && !storedInFolder(all, "b"));
});
