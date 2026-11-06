// Copies and Sidebery's export, on Tidier's real background scripts (fake_firefox.mjs).
// Firefox numbers containers per profile, so what matters here is that things arrive
// in the space with the right name: the wrong id means the wrong logins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeFirefox, wait } from "./fake_firefox.mjs";

const C1 = "firefox-container-1", C2 = "firefox-container-2", C3 = "firefox-container-3";
const plain = x => JSON.parse(JSON.stringify(x));
const fixture = () => JSON.parse(readFileSync(new URL("fixtures/sidebery_export.json", import.meta.url), "utf8"));
const GROUP = "moz-extension://sb/sidebery/group.html#";

// Firefox with these spaces: on this machine "Work" is container 2 and "Home" is 1.
function machine({ alone = true, windows = true } = {}) {
  const ff = new FakeFirefox({ containers: ["firefox-default", C1, C2] });
  ff.identities = { [C1]: { name: "Home", color: "green", icon: "tree" }, [C2]: { name: "Work", color: "orange", icon: "briefcase" } };
  if (alone) ff.managed = { tidierAlone: true };
  if (windows) { const w = ff.addWindow({ focused: true }); ff.addTab(w.id, { url: "about:home", active: true }); }
  return ff;
}

async function run(ff) {
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// A copy from a machine where the ids are the other way round, with a space not here.
function swappedCopy() {
  return {
    tidier: "1.6",
    when: 1,
    spaces: [
      { id: C1, name: "Work", colorCode: "#f90", color: "orange", icon: "briefcase" },
      { id: C2, name: "Home", colorCode: "#0f0", color: "green", icon: "tree" },
      { id: C3, name: "Clients", colorCode: "#00f", color: "purple", icon: "dollar" },
    ],
    data: {
      essentials: [
        { key: "work-mail", url: "https://mail.example.org/", cookieStoreId: C1, title: "Mail" },
        { key: "home-mail", url: "https://home.example.org/", cookieStoreId: C2, title: "Home mail" },
        { key: "client-board", url: "https://board.example.org/", cookieStoreId: C3, title: "Board" },
        { key: "gone", url: "https://gone.example.org/", cookieStoreId: "firefox-container-9", title: "In a removed container" },
      ],
      syncedTabs: {
        F: { group: true, own: true, name: "Projects", cookieStoreId: C1, parentKey: null, rank: 1, added: 1 },
        kept: { url: "https://kept.example.org/deep", title: "Kept", cookieStoreId: C1, parentKey: "F", added: 1, saved: { url: "https://kept.example.org/", title: "Kept" } },
        G: { group: true, url: `${GROUP}Clients`, title: "Clients", cookieStoreId: C3, parentKey: null, added: 1 },
        plain: { url: "https://plain.example.org/", title: "Ordinary, so not kept", cookieStoreId: C1, parentKey: null, added: 1 },
      },
      rules: [{ url: "mail.example.org", space: C1 }, { url: "board.example.org", space: C3 }, { url: "removed.example.org", space: "firefox-container-9" }],
      spaceOrder: [C3, C1, C2],
    },
  };
}

test("mapSpaces matches by name, whatever the ids", async () => {
  const ff = machine();
  const x = ff.boot();
  const local = [{ id: "a", name: "Work" }, { id: "b", name: "Home" }];
  const map = x.js("mapSpaces");
  assert.deepEqual(plain(map({ spaces: [{ id: "b", name: "Work" }, { id: "a", name: "Home" }] }, local)), { b: "a", a: "b" }, "the same names under other ids");
  assert.deepEqual(plain(map({ spaces: [{ id: "a", name: "Work" }, { id: "c", name: "Elsewhere" }] }, local)), { a: "a", c: null }, "a missing name is a space to make");
  assert.equal(map({ data: {} }, local), null, "a copy with no spaces");
  assert.equal(map({ spaces: [] }, local), null);
  const twins = plain(map({ spaces: [{ id: "x", name: "Twin" }, { id: "y", name: "Twin" }] }, [{ id: "t", name: "Twin" }]));
  assert.deepEqual(twins, { x: "t", y: null }, "two spaces with one name are never put together");
  x.kill();
});

test("a copy says what its ids are called, and holds the order of spaces", async () => {
  const ff = machine();
  ff.store.spaceOrder = [C2, C1];
  const x = await run(ff);
  const copy = plain(await x.js("theCopy")());
  assert.deepEqual(copy.spaces.find(s => s.id === C2), { id: C2, name: "Work", colorCode: "#000", color: "orange", icon: "briefcase" });
  assert.deepEqual(copy.data.spaceOrder, [C2, C1]);
  x.kill();
});

test("taking in rewrites everything to the local ids and makes the missing space", async () => {
  const ff = machine();
  const x = await run(ff);
  const r = plain(await x.js("mergeCopy")(swappedCopy()));
  assert.deepEqual(r, { essentials: 3, folders: 2, tabs: 1, rules: 2, spaces: 1 });
  await wait(1000);
  const clients = [...ff.containers].find(c => ff.identities[c]?.name === "Clients");
  assert.ok(clients && ![C1, C2].includes(clients), "the new space has an id of its own");
  assert.deepEqual({ name: "Clients", color: "purple", icon: "dollar" }, ff.identities[clients], "with its name, colour and icon");
  const space = key => ff.store.essentials.find(e => e.key === key)?.cookieStoreId;
  assert.equal(space("work-mail"), C2, "Work is container 2 here");
  assert.equal(space("home-mail"), C1, "Home is container 1 here");
  assert.equal(space("client-board"), clients);
  assert.equal(space("gone"), undefined, "a space the copy has no name for stays out");
  assert.equal(ff.synced.F.cookieStoreId, C2);
  assert.equal(ff.synced.kept.cookieStoreId, C2);
  assert.equal(ff.synced.kept.url, "https://kept.example.org/", "back at its saved address");
  assert.equal(ff.synced.G.cookieStoreId, clients);
  assert.equal(ff.synced.G.own, true, "a Sidebery folder page becomes a folder");
  assert.equal(ff.synced.plain, undefined, "ordinary tabs are not kept");
  assert.deepEqual(ff.store.rules, [{ url: "mail.example.org", space: C2 }, { url: "board.example.org", space: clients }]);
  assert.deepEqual(ff.store.spaceOrder, [clients, C2, C1], "this machine had no order, so it takes the copy's");
  const w = [...ff.wins.keys()][0];
  assert.ok(ff.list(w).some(t => t.pinned && t.cookieStoreId === C2 && t.url.includes("work-mail")), "the essential's tab is in the right container");
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a folder from a copy is no reason to offer going back to a Sidebery this browser may not have", async () => {
  const ff = machine();
  const x = await run(ff);
  const copy = swappedCopy();
  copy.data.syncedTabs.M = { group: true, own: true, name: "Moved there", url: `${GROUP}Moved~!abc!~`, oldUrl: `${GROUP}Moved~!abc!~`, cookieStoreId: C1, parentKey: null, rank: 2, added: 1 };
  await x.js("mergeCopy")(copy);
  await wait(300);
  assert.equal(ff.synced.G.oldUrl, undefined);
  assert.equal(ff.synced.G.url, `${GROUP}Clients`, "the address stays, for folds");
  assert.equal(ff.synced.M.oldUrl, undefined);
  assert.equal(ff.synced.M.url, `${GROUP}Moved~!abc!~`);
  assert.equal(ff.synced.M.name, "Moved there");
  assert.equal(ff.synced.M.rank, 2);
  assert.equal((await x.js("moveReport")()).canMoveBack, false);
  x.kill();
});

test("taking in twice adds nothing, also no second space", async () => {
  const ff = machine();
  const x = await run(ff);
  await x.js("mergeCopy")(swappedCopy());
  await wait(500);
  const containers = ff.containers.size, written = plain({ e: ff.store.essentials, r: ff.store.rules });
  const again = plain(await x.js("mergeCopy")(swappedCopy()));
  assert.deepEqual(again, { essentials: 0, folders: 0, tabs: 0, rules: 0, spaces: 0 });
  await wait(500);
  assert.equal(ff.containers.size, containers);
  assert.deepEqual(plain({ e: ff.store.essentials, r: ff.store.rules }), written);
  const lines = plain(await x.js("copySummary")(swappedCopy()));
  assert.ok(Object.values(lines).every(n => !n.isNew && !n.essentials && !n.folders && !n.savedTabs && !n.rules), "and the page then says nothing would come");
  x.kill();
});

test("the same essential already here under the local id is not doubled", async () => {
  const ff = machine();
  ff.store.essentials = [{ key: "mine", url: "https://mail.example.org/", cookieStoreId: C2, title: "Mail", icon: "x" }];
  ff.store.rules = [{ url: "mail.example.org", space: C2 }];
  const x = await run(ff);
  const r = plain(await x.js("mergeCopy")(swappedCopy(), [C1]));
  assert.deepEqual(r, { essentials: 0, folders: 1, tabs: 1, rules: 0, spaces: 0 });
  x.kill();
});

test("only the spaces you keep ticked come, and no other space is made", async () => {
  const ff = machine();
  const x = await run(ff);
  const r = plain(await x.js("mergeCopy")(swappedCopy(), [C2]));
  assert.deepEqual(r, { essentials: 1, folders: 0, tabs: 0, rules: 0, spaces: 0 });
  await wait(300);
  assert.equal(ff.containers.size, 3, "no Clients");
  assert.deepEqual(ff.store.essentials.map(e => e.key), ["home-mail"]);
  assert.deepEqual(ff.store.spaceOrder, [C2, C1], "the order holds what exists");
  x.kill();
});

test("an order of spaces this machine already has stays", async () => {
  const ff = machine();
  ff.store.spaceOrder = [C1, C2];
  const x = await run(ff);
  await x.js("mergeCopy")(swappedCopy());
  await wait(300);
  assert.deepEqual(ff.store.spaceOrder, [C1, C2]);
  x.kill();
});

test("a space that cannot be made keeps what is in it out, and a strange colour does not stop it", async () => {
  const ff = machine();
  ff.badColors = ["purple"];
  let x = await run(ff);
  let r = plain(await x.js("mergeCopy")(swappedCopy()));
  assert.equal(r.spaces, 1, "made in a colour Firefox knows");
  const clients = [...ff.containers].find(c => ff.identities[c]?.name === "Clients");
  assert.equal(ff.identities[clients].color, "blue");
  x.kill();

  const ff2 = machine();
  const y = await run(ff2);
  y.b.contextualIdentities.create = async () => { throw new Error("no"); };
  r = plain(await y.js("mergeCopy")(swappedCopy()));
  assert.deepEqual(r, { essentials: 2, folders: 1, tabs: 1, rules: 1, spaces: 0 });
  assert.ok(!ff2.store.essentials?.some(e => e.key === "client-board"));
  y.kill();
});

test("a copy with no spaces, an older one, works as before", async () => {
  const ff = machine();
  const x = await run(ff);
  const { spaces, ...older } = swappedCopy();
  older.data.essentials = older.data.essentials.filter(e => e.cookieStoreId !== C3 && e.key !== "gone");
  delete older.data.spaceOrder;
  delete older.data.syncedTabs.G;
  const r = plain(await x.js("mergeCopy")(older));
  assert.deepEqual(r, { essentials: 2, folders: 1, tabs: 1, rules: 0, spaces: 0 }, "rules of an older copy were never taken");
  await wait(300);
  assert.equal(ff.store.essentials.find(e => e.key === "work-mail").cookieStoreId, C1, "its ids are taken as they are");
  assert.equal(ff.containers.size, 3);
  x.kill();
});

test("the settings page gets one line per space, before anything is written", async () => {
  const ff = machine();
  ff.store.essentials = [{ key: "mine", url: "https://mail.example.org/", cookieStoreId: C2, title: "Mail", icon: "x" }];
  const x = await run(ff);
  const before = ff.storeWrites;
  const lines = plain(await x.js("copySummary")(swappedCopy()));
  assert.deepEqual(Object.keys(lines), [C1, C2, C3]);
  assert.deepEqual(lines[C1], { name: "Work", color: "#000", isNew: false, essentials: 0, folders: 1, savedTabs: 1, rules: 1 }, "the essential is here already");
  assert.deepEqual(lines[C2], { name: "Home", color: "#000", isNew: false, essentials: 1, folders: 0, savedTabs: 0, rules: 0 });
  assert.deepEqual(lines[C3], { name: "Clients", color: "#00f", isNew: true, essentials: 1, folders: 1, savedTabs: 0, rules: 1 });
  assert.equal(ff.containers.size, 3, "nothing is made");
  assert.equal(ff.storeWrites, before, "nothing is written");
  x.kill();
});

test("an essential in no container needs no name, and stays in none", async () => {
  const ff = machine();
  const x = await run(ff);
  const copy = swappedCopy();
  copy.data.essentials = [{ key: "bare", url: "https://bare.example.org/", cookieStoreId: "firefox-default", title: "Bare" }];
  const lines = plain(await x.js("copySummary")(copy));
  assert.equal(lines["firefox-default"].name, "No container");
  assert.equal(lines["firefox-default"].essentials, 1);
  await x.js("mergeCopy")(copy, ["firefox-default"]);
  await wait(300);
  assert.equal(ff.store.essentials.find(e => e.key === "bare").cookieStoreId, "firefox-default");
  x.kill();
});

test("a file that is not a copy says so, and neither kind passes for the other", async () => {
  const ff = machine();
  const x = await run(ff);
  const summary = x.js("copySummary"), sidebery = x.js("importSidebery");
  for (const wrong of [null, "text", 3, [], {}, { hello: 1 }, { tidier: "1.6" }, { tidier: "1.6", data: [] }, fixture()]) {
    assert.equal(await summary(wrong), null, JSON.stringify(wrong)?.slice(0, 40));
  }
  for (const wrong of [null, "text", 3, [], {}, { hello: 1 }, swappedCopy()]) {
    assert.equal(await sidebery(wrong), null, JSON.stringify(wrong)?.slice(0, 40));
  }
  assert.ok(await summary(swappedCopy()));
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("Sidebery's export: address rules of panels, and of containers, once each", async () => {
  const ff = machine();
  ff.identities = { [C1]: { name: "Space 1" }, [C2]: { name: "Space 2" } };
  const x = await run(ff);
  const r = plain(await x.js("importSidebery")(fixture()));
  await wait(500);
  assert.deepEqual(ff.store.rules, [
    { url: "reopen.example.org", space: C1 }, // from the container, and the panel's own rule of it adds nothing
    { url: "/^https:\\/\\/moved\\.example\\.org\\//", space: C1 },
    { url: "two.example.org", space: C2 },
  ], "not those switched off, not an exclusion, not one with only a container");
  assert.equal(r.rules, 3);
  assert.equal(r.panelsLeftOut, 1, "the panel with rules and no container is counted; the one with no rules is not");
  assert.deepEqual(r.newSpaces, []);
  assert.deepEqual(ff.store.spaceOrder, [C2, C1]);
  assert.equal(plain(await x.js("importSidebery")(fixture())).rules, 0, "and importing again adds nothing");
  x.kill();
});

test("an export from another machine lands by name, and makes what it needs", async () => {
  const ff = machine();
  const x = await run(ff);
  const backup = fixture();
  backup.containers[C1].name = "Work"; // Work is container 2 here
  backup.containers[C2].name = "Abroad"; // not here
  const r = plain(await x.js("importSidebery")(backup));
  await wait(500);
  const abroad = [...ff.containers].find(c => ff.identities[c]?.name === "Abroad");
  assert.ok(abroad);
  assert.deepEqual(r.newSpaces, ["Abroad"]);
  assert.equal(ff.identities[abroad].color, "orange");
  assert.ok(ff.store.rules.some(x => x.url === "reopen.example.org" && x.space === C2));
  assert.ok(ff.store.rules.some(x => x.url === "two.example.org" && x.space === abroad));
  assert.deepEqual(ff.store.spaceOrder, [abroad, C2]);
  x.kill();
});

test("a rule never points at a container that is not here", async () => {
  const ff = machine();
  ff.identities = { [C1]: { name: "Space 1" }, [C2]: { name: "Space 2" } };
  const x = await run(ff);
  const backup = fixture();
  backup.sidebar.panels.p2.newTabCtx = "firefox-container-8"; // removed where the export was made
  const r = plain(await x.js("importSidebery")(backup));
  await wait(300);
  assert.ok(!ff.store.rules.some(x => x.url === "two.example.org"));
  assert.equal(r.panelsLeftOut, 2);
  assert.deepEqual(ff.store.spaceOrder, [C1]);
  x.kill();
});

// --- Folds ---------------------------------------------------------------------------
test("a snapshot's closed folders are read, with what did not change looked up further back", async () => {
  const ff = machine();
  const x = ff.boot();
  const closed = plain(x.js("closedFolders")(fixture(), id => id));
  assert.deepEqual(closed.sort(), [`${C1}|group.html#Later`, `${C1}|group.html#Reading`]);
  x.kill();
});

test("a snapshot that cannot be read gives way to the one before; none at all is said", async () => {
  const ff = machine();
  const x = ff.boot();
  const closed = x.js("closedFolders");
  const backup = fixture();
  backup.snapshots.push({ id: "broken", time: 3000, tabs: [[[-1, -1, -1, -1, -1, -1, -1]]] }); // more unchanged tabs than ever existed
  assert.equal(plain(closed(backup, id => id)).length, 2);
  assert.equal(closed({}, id => id), null);
  assert.equal(closed({ snapshots: [] }, id => id), null);
  assert.equal(closed({ snapshots: [{ tabs: [[[-1]]] }] }, id => id), null);
  assert.deepEqual(plain(closed(backup, id => id === C1 ? null : id)), [], "not in a space that is not here");
  x.kill();
});

const sideberyFolders = () => ({
  R: { group: true, url: `moz-extension://here/sidebery/group.html#Reading`, title: "Reading", cookieStoreId: C1, parentKey: null, added: 1 },
  O: { group: true, url: `moz-extension://here/sidebery/group.html#Open`, title: "Open", cookieStoreId: C1, parentKey: null, added: 1 },
  L: { group: true, url: `moz-extension://here/sidebery/group.html#Later`, title: "Later", cookieStoreId: C1, parentKey: null, added: 1 },
  R2: { group: true, url: `moz-extension://here/sidebery/group.html#Reading`, title: "Reading", cookieStoreId: C2, parentKey: null, added: 1 },
});

test("folds wait for the move, and the move applies them", async () => {
  const ff = machine({ alone: false, windows: false });
  ff.identities = { [C1]: { name: "Space 1" }, [C2]: { name: "Space 2" } };
  ff.store.syncedTabs = sideberyFolders();
  const w = ff.addWindow({ focused: true });
  for (const [key, e] of Object.entries(ff.store.syncedTabs)) ff.addTab(w.id, { url: e.url, title: e.title, cookieStoreId: e.cookieStoreId }, { syncKey: key, syncRole: "live" });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = await run(ff);
  x.b.runtime.reload = () => {};
  const r = plain(await x.js("importSidebery")(fixture()));
  assert.equal(r.folds, 2, "two of these folders are closed");
  assert.equal(ff.synced.R.collapsed, undefined, "and Sidebery's folders are left alone until the move");
  assert.equal(ff.store.importedFolds.length, 2);
  await x.js("moveOver")();
  const all = ff.store.syncedTabs;
  assert.equal(all.R.collapsed, true);
  assert.equal(all.L.collapsed, true, "with the channel suffix Sidebery adds to its address");
  assert.ok(!all.O.collapsed);
  assert.ok(!all.R2.collapsed, "the same name in another space is another folder");
  assert.deepEqual(ff.store.importedFolds, [], "applied once");
  x.kill();
});

test("folds apply at once if the move has already happened", async () => {
  const ff = machine();
  ff.identities = { [C1]: { name: "Space 1" }, [C2]: { name: "Space 2" } };
  const moved = sideberyFolders();
  for (const e of Object.values(moved)) Object.assign(e, { own: true, name: e.title, oldUrl: e.url, rank: 1 });
  moved.mine = { group: true, own: true, name: "Made since", cookieStoreId: C1, parentKey: null, rank: 2, added: 1 };
  ff.store.syncedTabs = moved;
  const x = await run(ff);
  const r = plain(await x.js("importSidebery")(fixture()));
  await wait(500);
  assert.equal(r.folds, 2);
  assert.equal(ff.synced.R.collapsed, true);
  assert.equal(ff.synced.L.collapsed, true);
  assert.ok(!ff.synced.O.collapsed && !ff.synced.R2.collapsed && !ff.synced.mine.collapsed);
  assert.equal(ff.store.importedFolds, undefined, "nothing left waiting");
  x.kill();
});

test("without a snapshot folders start open, and the result says so", async () => {
  const ff = machine({ alone: false, windows: false });
  ff.identities = { [C1]: { name: "Space 1" }, [C2]: { name: "Space 2" } };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "about:home", active: true });
  const x = await run(ff);
  x.b.runtime.reload = () => {};
  const { snapshots, ...backup } = fixture();
  const r = plain(await x.js("importSidebery")(backup));
  assert.equal(r.folds, null);
  assert.equal(ff.store.importedFolds, undefined);
  x.kill();
});

test("a rule with a slash but no regular expression is text, as in Sidebery", async () => {
  const ff = machine();
  const x = ff.boot();
  const matches = x.js("ruleMatches");
  assert.equal(matches("/docs/print", "https://a.example.org/docs/print/1"), true);
  assert.equal(matches("/^https:\\/\\/a\\./", "https://a.example.org/"), true);
  assert.equal(matches("/^https:\\/\\/b\\./", "https://a.example.org/"), false);
  x.kill();
});
