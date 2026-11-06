// The same things on every machine, and spaces hidden on one: Tidier's real background
// scripts on fake Firefoxes, with container ids that differ per machine as they do per
// profile, and Firefox Sync between them as MDN describes it (firefoxSyncNow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, firefoxSyncNow, wait, GHOST } from "./fake_firefox.mjs";

const SETTINGS = { url: "moz-extension://tidier/settings/settings.html" };
const c = n => `firefox-container-${n}`;

// A machine whose containers are numbered its own way: { 1: "Work", 2: "Private" }.
function machine(names) {
  const ids = Object.keys(names).map(c);
  const ff = new FakeFirefox({ containers: ["firefox-default", ...ids] });
  ff.identities = Object.fromEntries(Object.entries(names).map(([n, name]) => [c(n), { name, color: "blue", icon: "circle" }]));
  ff.managed = { tidierAlone: true };
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://home.example/", title: "Home", active: true, cookieStoreId: ids[0] });
  return { ff, w };
}

async function boot(ff, event = "onStartup") {
  const x = ff.boot();
  x.b.runtime[event].fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

const turnOn = x => x.send({ type: "sync:turn", on: true }, SETTINGS);
const report = x => x.send({ type: "sync:get" }, SETTINGS);
const hide = (x, space, hidden = true) => x.send({ type: "sync:hide", space, hidden }, SETTINGS);
const ROUND = 8000; // more than sync.js's wait, plus the round itself

// Until Tidier has no round waiting or running: a state, not a time.
async function settled(x) {
  for (let i = 0; i < 400; i++) {
    await wait(100); // events are delivered, and what they start has started
    if (x.js("syncTimer") === null) {
      await x.js("serial")(() => {});
      if (x.js("syncTimer") === null) return;
    }
  }
  throw new Error("a round never ended");
}

// Firefox Sync runs on every machine, a few times over, with Tidier's rounds in between.
async function syncAround(server, machines, times = 3) {
  for (let i = 0; i < times; i++) {
    for (const m of machines) { await settled(m.x); firefoxSyncNow(m.ff, server); await settled(m.x); }
  }
}

async function pin(x, ff, windowId, url, cookieStoreId, title = url) {
  const t = ff.addTab(windowId, { url, title, cookieStoreId });
  await x.b.tabs.update(t.id, { pinned: true });
  await wait(1500);
  return t;
}

const pinned = (ff, w) => ff.list(w.id).filter(t => t.pinned);
const essentialKeys = ff => (ff.store.essentials || []).map(e => e.key);

async function pair(a = { 1: "Work", 2: "Private" }, b = { 5: "Private", 7: "Work" }) {
  const A = machine(a), B = machine(b);
  const server = {};
  A.x = await boot(A.ff);
  B.x = await boot(B.ff);
  return { A, B, server, machines: [A, B], end() { A.x.kill(); B.x.kill(); } };
}

test("with sync not turned on, nothing goes to or comes from storage.sync", async () => {
  const { ff, w } = machine({ 1: "Work" });
  ff.syncArea = { "1/m.0": [["s", "sx", 5, "Other", "blue", "circle"]] };
  const x = await boot(ff);
  await pin(x, ff, w.id, "https://jira.example/", c(1));
  await wait(ROUND * 2);
  assert.equal(ff.syncWrites, undefined);
  assert.ok(![...ff.containers].some(id => ff.identities?.[id]?.name === "Other"));
  x.kill();
});

test("without Tidier alone, turning it on does nothing, and nothing is touched", async () => {
  const { ff } = machine({ 1: "Work" });
  ff.managed = {};
  const x = await boot(ff);
  await turnOn(x);
  await wait(ROUND);
  assert.equal(ff.syncWrites, undefined);
  assert.equal((await report(x)).alone, false);
  x.kill();
});

test("an essential added on one machine appears on the other, in the right container by name", async () => {
  const { A, B, server, machines, end } = await pair();
  await turnOn(A.x);
  await turnOn(B.x);
  await pin(A.x, A.ff, A.w.id, "https://jira.example/", c(1), "Jira"); // Work is container 1 on A, 7 on B
  await syncAround(server, machines);
  const copy = pinned(B.ff, B.w).find(t => t.url.includes("ghost.html"));
  assert.ok(copy, "a copy, unloaded");
  assert.equal(copy.cookieStoreId, c(7), "in the container called Work here");
  const entry = B.ff.store.essentials.find(e => e.url === "https://jira.example/");
  assert.equal(entry.title, "Jira");
  assert.equal(entry.icon, undefined, "icons are not synced");
  assert.equal(entry.key, A.ff.store.essentials[0].key, "the same essential on both");
  assert.deepEqual([...A.x.errors, ...B.x.errors], []);
  end();
});

test("nothing that was not asked for: no write with nothing happening, and no answer to one's own write", async () => {
  const { A, B, server, machines, end } = await pair();
  await turnOn(A.x);
  await turnOn(B.x);
  await pin(A.x, A.ff, A.w.id, "https://jira.example/", c(1));
  await syncAround(server, machines, 4);
  const writes = [A.ff.syncWrites, B.ff.syncWrites, A.ff.storeWrites, B.ff.storeWrites];
  const jobs = [A.x.js("work.jobs"), B.x.js("work.jobs")];
  await wait(ROUND * 4);
  assert.deepEqual([A.ff.syncWrites, B.ff.syncWrites, A.ff.storeWrites, B.ff.storeWrites], writes, "nothing written");
  assert.deepEqual([A.x.js("work.jobs"), B.x.js("work.jobs")], jobs, "and nothing run");
  // A change elsewhere in the record (a tab's address) is looked at once, and writes nothing to sync.
  const before = A.ff.syncWrites;
  const t = A.ff.addTab(A.w.id, { url: "about:blank", cookieStoreId: c(1) });
  A.x.b.tabs.onCreated.fire(A.ff.snap(t));
  A.ff.navigate(t.id, "https://plain.example/");
  await wait(ROUND * 2);
  assert.equal(A.ff.syncWrites, before, "an ordinary tab stays on its machine");
  assert.ok(!JSON.stringify(A.ff.syncArea).includes("plain.example"));
  end();
});

test("an essential deleted on one machine goes on the other, and one open there stays as a tab", async () => {
  const { A, B, server, machines, end } = await pair();
  await turnOn(A.x);
  await turnOn(B.x);
  const j = await pin(A.x, A.ff, A.w.id, "https://jira.example/", c(1));
  const k = await pin(A.x, A.ff, A.w.id, "https://kept.example/", c(1));
  await syncAround(server, machines);
  assert.equal(pinned(B.ff, B.w).length, 2);
  // The second is open on B.
  const open = pinned(B.ff, B.w).find(t => t.url === GHOST("essential", A.ff.store.essentials.find(e => e.url.includes("kept")).key));
  B.ff.navigate(open.id, "https://kept.example/");
  await wait(500);
  await A.x.b.tabs.update(j.id, { pinned: false });
  await A.x.b.tabs.update(k.id, { pinned: false });
  await wait(1500);
  await syncAround(server, machines);
  assert.deepEqual(essentialKeys(B.ff), []);
  assert.equal(pinned(B.ff, B.w).length, 0, "the copies are gone");
  const still = B.ff.tabs.get(open.id);
  assert.ok(still, "a page you have open is not closed by another machine");
  assert.equal(still.pinned, false);
  assert.equal(still.url, "https://kept.example/");
  end();
});

test("the same site as an essential on both machines stays one, and a page open on it stays open", async () => {
  const { A, B, server, machines, end } = await pair();
  await pin(A.x, A.ff, A.w.id, "https://jira.example/", c(1), "Jira A");
  const onB = await pin(B.x, B.ff, B.w.id, "https://jira.example/", c(7), "Jira B");
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, machines, 4);
  assert.equal(A.ff.store.essentials.length, 1);
  assert.equal(B.ff.store.essentials.length, 1);
  assert.equal(A.ff.store.essentials[0].key, B.ff.store.essentials[0].key);
  assert.equal(pinned(B.ff, B.w).length, 1, "one tab, and not a second copy");
  assert.equal(B.ff.tabs.get(onB.id)?.url, "https://jira.example/", "still the same open page");
  assert.equal(pinned(A.ff, A.w).length, 1);
  end();
});

test("folders and saved tabs arrive unloaded; removing them goes across, and an open one stays", async () => {
  const { A, B, server, machines, end } = await pair();
  await turnOn(A.x);
  await turnOn(B.x);
  const t1 = A.ff.addTab(A.w.id, { url: "https://one.example/", title: "One", cookieStoreId: c(2) });
  const t2 = A.ff.addTab(A.w.id, { url: "https://two.example/", title: "Two", cookieStoreId: c(2) });
  for (const t of [t1, t2]) A.x.b.tabs.onCreated.fire(A.ff.snap(t));
  await wait(2500);
  const folder = await A.x.js("createFolder")("Reading", c(2));
  await A.x.js("moveTab")(A.w.id, t1.id, null, folder);
  await A.x.js("moveTab")(A.w.id, t2.id, null, folder);
  await wait(500);
  await syncAround(server, machines);
  const keyOf = url => Object.keys(B.ff.synced).find(k => B.ff.synced[k].saved?.url === url);
  assert.equal(B.ff.synced[folder].name, "Reading");
  assert.equal(B.ff.synced[folder].cookieStoreId, c(5), "in the container called Private here");
  const [k1, k2] = [keyOf("https://one.example/"), keyOf("https://two.example/")];
  assert.ok(k1 && k2);
  assert.equal(B.ff.synced[k1].parentKey, folder);
  assert.ok(B.ff.list(B.w.id).some(t => t.url === GHOST("ghost", k1) && t.cookieStoreId === c(5)), "a placeholder, in its container");
  // One is open on B, then both are removed on A.
  const open = B.ff.list(B.w.id).find(t => t.url === GHOST("ghost", k2));
  B.ff.select(open.id);
  await wait(200);
  await B.x.js("setRole")(open.id, k2, "live");
  B.ff.navigate(open.id, "https://two.example/");
  await wait(500);
  await A.x.js("deleteFolder")(folder);
  await wait(500);
  await syncAround(server, machines, 4);
  assert.equal(B.ff.synced[folder], undefined);
  assert.equal(B.ff.synced[k1], undefined, "the one not open is gone");
  assert.ok(!B.ff.list(B.w.id).some(t => t.url === GHOST("ghost", k1)));
  assert.ok(B.ff.tabs.has(open.id), "the open one is not closed");
  assert.ok(B.ff.synced[k2] && !B.ff.synced[k2].saved && !B.ff.synced[k2].parentKey, "it is an ordinary tab now");
  assert.deepEqual([...A.x.errors, ...B.x.errors], []);
  end();
});

test("a folder made on both machines is one, with the tabs of both", async () => {
  const { A, B, server, machines, end } = await pair();
  const onA = await A.x.js("createFolder")("Reading", c(1));
  const onB = await B.x.js("createFolder")("Reading", c(7));
  await wait(500);
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, machines, 4);
  const folders = ff => Object.entries(ff.synced).filter(([, e]) => e.group).map(([k]) => k);
  assert.equal(folders(A.ff).length, 1);
  assert.deepEqual(folders(A.ff), folders(B.ff));
  assert.ok([onA, onB].includes(folders(A.ff)[0]));
  end();
});

test("a new space comes with its name, colour and icon; a rename follows, and what is in it stays", async () => {
  const A = machine({ 1: "Work", 2: "Client" }), B = machine({ 5: "Work" });
  const server = {};
  A.ff.identities[c(2)] = { name: "Client", color: "red", icon: "briefcase" };
  A.x = await boot(A.ff);
  B.x = await boot(B.ff);
  await turnOn(A.x);
  await turnOn(B.x);
  await pin(A.x, A.ff, A.w.id, "https://client.example/", c(2));
  await syncAround(server, [A, B]);
  const here = () => Object.entries(B.ff.identities).find(([, i]) => i.name === "Client" || i.name === "Customer");
  assert.ok(here(), "the space was made here");
  const [id, identity] = here();
  assert.equal(identity.color, "red");
  assert.equal(identity.icon, "briefcase");
  assert.equal(B.ff.store.essentials[0].cookieStoreId, id);
  await A.x.b.contextualIdentities.update(c(2), { name: "Customer" });
  await wait(100);
  await syncAround(server, [A, B]);
  assert.equal(B.ff.identities[id].name, "Customer", "the same container, under its new name");
  assert.equal(B.ff.store.essentials[0].cookieStoreId, id, "and what is in it stays");
  // A rename here goes the other way too, and the two machines do not change it back.
  await B.x.b.contextualIdentities.update(id, { name: "Renamed on B" });
  await wait(100);
  await syncAround(server, [A, B]);
  assert.equal(A.ff.identities[c(2)].name, "Renamed on B");
  assert.equal(B.ff.identities[id].name, "Renamed on B");
  A.x.kill(); B.x.kill();
});

test("a colour this Firefox does not know does not stop a space from coming", async () => {
  const A = machine({ 1: "Work", 2: "Client" }), B = machine({ 5: "Work" });
  const server = {};
  A.ff.identities[c(2)] = { name: "Client", color: "future", icon: "circle" };
  B.ff.badColors = ["future"];
  A.x = await boot(A.ff);
  B.x = await boot(B.ff);
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, [A, B]);
  assert.ok(Object.values(B.ff.identities).some(i => i.name === "Client"));
  A.x.kill(); B.x.kill();
});

test("rules go across by name, and the order of spaces with them", async () => {
  const { A, B, server, machines, end } = await pair();
  A.ff.store.rules = [{ url: "work.example", space: c(1) }, { url: "/^https:\\/\\/private\\//", space: c(2) }];
  A.ff.store.spaceOrder = [c(2), c(1)];
  A.x.kill();
  A.x = await boot(A.ff);
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, machines);
  assert.deepEqual(B.ff.store.rules, [{ url: "work.example", space: c(7) }, { url: "/^https:\\/\\/private\\//", space: c(5) }]);
  assert.deepEqual(B.ff.store.spaceOrder, [c(5), c(7)]);
  // Deleted on B: gone on A, and it stays gone.
  await B.x.send({ type: "settings:rules", rules: [{ url: "work.example", space: c(7) }] }, SETTINGS);
  await wait(500);
  await syncAround(server, machines);
  assert.deepEqual(A.ff.store.rules, [{ url: "work.example", space: c(1) }]);
  assert.deepEqual(B.ff.store.rules, [{ url: "work.example", space: c(7) }]);
  end();
});

test("what you arranged goes across: essentials, folders, and tabs in a folder", async () => {
  const { A, B, server, machines, end } = await pair();
  await turnOn(A.x);
  await turnOn(B.x);
  for (const name of ["one", "two", "three"]) await pin(A.x, A.ff, A.w.id, `https://${name}.example/`, c(1));
  const f1 = await A.x.js("createFolder")("First", c(1));
  const f2 = await A.x.js("createFolder")("Second", c(1));
  const tabs = [];
  for (const name of ["a", "b", "c"]) {
    const t = A.ff.addTab(A.w.id, { url: `https://${name}.example/`, title: name, cookieStoreId: c(1) });
    A.x.b.tabs.onCreated.fire(A.ff.snap(t));
    tabs.push(t);
  }
  await wait(2500);
  for (const t of tabs) await A.x.js("moveTab")(A.w.id, t.id, null, f1);
  await wait(500);
  await syncAround(server, machines);
  const essentials = ff => ff.store.essentials.filter(e => e.cookieStoreId === (ff === A.ff ? c(1) : c(7))).map(e => e.url);
  assert.deepEqual(essentials(B.ff), essentials(A.ff));
  const savedOrder = (ff, w) => ff.list(w.id).filter(t => ff.synced[ff.values.get(t.id)?.syncKey]?.parentKey === f1).map(t => ff.synced[ff.values.get(t.id).syncKey].saved.url);
  assert.deepEqual(savedOrder(B.ff, B.w), ["https://a.example/", "https://b.example/", "https://c.example/"]);
  // Arranged on A.
  const pins = A.ff.list(A.w.id).filter(t => t.pinned);
  await A.x.js("moveEssential")(A.w.id, pins.at(-1).id, pins[0].id);
  await A.x.js("moveFolder")(f2, f1);
  await A.x.js("moveTab")(A.w.id, tabs[2].id, tabs[0].id);
  await wait(1500);
  await syncAround(server, machines);
  assert.deepEqual(essentials(B.ff), essentials(A.ff), "the essentials");
  assert.deepEqual(B.ff.list(B.w.id).filter(t => t.pinned).map(t => t.url), B.ff.store.essentials.map(e => GHOST("essential", e.key)), "and their tabs too");
  const folders = ff => Object.entries(ff.synced).filter(([, e]) => e.group).sort((x, y) => x[1].rank - y[1].rank).map(([k]) => k);
  assert.deepEqual(folders(B.ff), [f2, f1], "the folders");
  assert.deepEqual(savedOrder(B.ff, B.w), ["https://c.example/", "https://a.example/", "https://b.example/"], "and the tabs in a folder");
  assert.deepEqual([...A.x.errors, ...B.x.errors], []);
  end();
});

test("a change made while Tidier was not running is found when it starts", async () => {
  const { A, B, server, machines, end } = await pair();
  await turnOn(A.x);
  await turnOn(B.x);
  await pin(A.x, A.ff, A.w.id, "https://jira.example/", c(1));
  await syncAround(server, machines);
  A.x.kill();
  A.ff.store.rules = [{ url: "rule.example", space: c(1) }];
  A.x = await boot(A.ff);
  assert.equal(A.x.js("syncIsOn"), true, "it stays on");
  await syncAround(server, machines);
  assert.deepEqual(B.ff.store.rules, [{ url: "rule.example", space: c(7) }]);
  end();
});

test("turning sync on takes a copy first, and merges both ways", async () => {
  const { A, B, server, machines, end } = await pair();
  await pin(A.x, A.ff, A.w.id, "https://a.example/", c(1));
  await pin(B.x, B.ff, B.w.id, "https://b.example/", c(5));
  await wait(500);
  await turnOn(A.x);
  assert.ok(A.ff.store.copyBeforeSync?.data?.essentials?.length, "with no helper here, the copy is kept in Firefox's storage");
  await syncAround(server, machines, 1);
  await turnOn(B.x);
  assert.equal(B.ff.store.copyBeforeSync.data.essentials[0].url, "https://b.example/", "from before anything arrived");
  await syncAround(server, machines, 3);
  const urls = ff => ff.store.essentials.map(e => e.url).sort();
  assert.deepEqual(urls(A.ff), ["https://a.example/", "https://b.example/"]);
  assert.deepEqual(urls(B.ff), ["https://a.example/", "https://b.example/"]);
  end();
});

test("with a helper, the first merge's copy is a file", async () => {
  const { ff, w } = machine({ 1: "Work" });
  const x = await boot(ff);
  const sent = [];
  x.b.runtime.sendNativeMessage = async (host, msg) => { sent.push(msg); return { saved: "file" }; };
  await pin(x, ff, w.id, "https://a.example/", c(1));
  await turnOn(x);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].backup.data.essentials[0].url, "https://a.example/");
  assert.equal(ff.store.copyBeforeSync, undefined);
  x.kill();
});

test("much removed in one go from elsewhere: a copy is taken first", async () => {
  const { A, B, server, machines, end } = await pair();
  const tabs = [];
  for (let i = 0; i < 6; i++) tabs.push(await pin(A.x, A.ff, A.w.id, `https://e${i}.example/`, c(1)));
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, machines);
  assert.equal(B.ff.store.essentials.length, 6);
  delete B.ff.store.copyBeforeSync;
  // Five of the six, so that the kind is not suddenly empty: that alone is not believed.
  for (const t of tabs.slice(0, 5)) await A.x.b.tabs.update(t.id, { pinned: false });
  await wait(1500);
  await syncAround(server, machines);
  assert.equal(B.ff.store.essentials.length, 1);
  assert.equal(B.ff.store.copyBeforeSync?.data?.essentials?.length, 6, "what was there before is kept");
  end();
});

test("a container removed on one machine stays on the others, and stays away here until made again", async () => {
  const { A, B, server, machines, end } = await pair();
  await pin(A.x, A.ff, A.w.id, "https://private.example/", c(2));
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, machines);
  assert.equal(B.ff.store.essentials.length, 1);
  // Removed on B: Firefox closes its tabs, and essentials.js drops its essentials.
  const copies = pinned(B.ff, B.w).map(t => t.id);
  B.ff.containers.delete(c(5));
  delete B.ff.identities[c(5)];
  B.x.b.contextualIdentities.onRemoved.fire({ contextualIdentity: { cookieStoreId: c(5) } });
  copies.forEach(id => B.ff.rm(id));
  await wait(1000);
  await syncAround(server, machines);
  assert.equal(A.ff.store.essentials.length, 1, "the other machine keeps it");
  assert.ok(A.ff.containers.has(c(2)));
  assert.ok(!Object.values(B.ff.identities).some(i => i.name === "Private"), "it is not made again here");
  assert.deepEqual(B.ff.store.essentials, []);
  // A container of that name made here brings it back.
  const made = await B.x.b.contextualIdentities.create({ name: "Private", color: "blue", icon: "circle" });
  await wait(100);
  await syncAround(server, machines);
  assert.equal(B.ff.store.essentials[0]?.cookieStoreId, made.cookieStoreId);
  assert.deepEqual([...A.x.errors, ...B.x.errors], []);
  end();
});

test("when Firefox refuses, it says so, and nothing is lost", async () => {
  const { ff, w } = machine({ 1: "Work" });
  const x = await boot(ff);
  await pin(x, ff, w.id, "https://a.example/", c(1));
  await turnOn(x);
  ff.syncRefused = "storage.sync is not available";
  await pin(x, ff, w.id, "https://b.example/", c(1));
  await settled(x);
  assert.match(x.js("notices").get("sync"), /not available/, "it shows, in the sidebar too");
  assert.match((await report(x)).problem, /not available/);
  assert.equal(ff.store.essentials.length, 2);
  delete ff.syncRefused;
  await pin(x, ff, w.id, "https://c.example/", c(1));
  await settled(x);
  assert.equal((await report(x)).problem, null);
  assert.equal(x.js("notices").has("sync"), false);
  assert.ok(JSON.stringify(ff.syncArea).includes("b.example"), "what could not be written then is written now");
  x.kill();
});

test("the settings page is told how much is used and what does not fit", async () => {
  const { ff, w } = machine({ 1: "Work" });
  const long = "x".repeat(3000);
  ff.store.essentials = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, url: `https://${i}.example/${long}`, cookieStoreId: c(1), title: `Essential ${i}` }));
  const x = await boot(ff);
  await turnOn(x);
  const r = await report(x);
  assert.equal(r.on, true);
  assert.equal(r.limit, 102400);
  assert.ok(r.bytes > 90000 && r.bytes <= 102400, String(r.bytes));
  assert.ok(r.left.length > 0 && r.left.length < 40, String(r.left.length));
  assert.equal(r.left[0].kind, "essentials");
  assert.equal(x.errors.length, 0, x.errors.join());
  x.kill();
  void w;
});

test("turned off, it stops, and turned on again it merges again instead of spreading what happened meanwhile", async () => {
  const { A, B, server, machines, end } = await pair();
  const one = await pin(A.x, A.ff, A.w.id, "https://one.example/", c(1));
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, machines);
  await A.x.send({ type: "sync:turn", on: false }, SETTINGS);
  const writes = A.ff.syncWrites;
  await A.x.b.tabs.update(one.id, { pinned: false });
  await wait(1500);
  await syncAround(server, machines);
  assert.equal(A.ff.syncWrites, writes, "nothing written while off");
  assert.equal(B.ff.store.essentials.length, 1, "and nothing spread");
  await turnOn(A.x);
  await syncAround(server, machines);
  assert.equal(B.ff.store.essentials.length, 1);
  assert.equal(A.ff.store.essentials.length, 1, "what was removed while off comes back: it was not known to be deleted");
  end();
});

test("moving back to Sidebery forgets what was seen, so moving over again deletes nothing", async () => {
  const { ff, w } = machine({ 1: "Work" });
  let x = await boot(ff);
  await pin(x, ff, w.id, "https://one.example/", c(1));
  await turnOn(x);
  await wait(500);
  assert.ok(ff.store.syncState.seen);
  x.kill();
  ff.managed = {};
  x = await boot(ff);
  assert.equal(ff.store.syncState, undefined);
  x.kill();
  void w;
});

// --- Two machines used at random, with the real scripts ------------------------------
function seeded(seed) { return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

// What a machine holds, in the words all machines share.
function holds(m) {
  const name = id => m.ff.identities[id]?.name ?? id;
  const all = m.ff.synced || {}, list = m.ff.store.essentials || [];
  const folders = Object.entries(all).filter(([, e]) => e.group && e.own);
  return {
    essentials: list.map(e => `${name(e.cookieStoreId)} ${e.url} ${e.name ?? ""}`).sort(),
    folders: folders.map(([k, e]) => `${k} ${name(e.cookieStoreId)} ${e.name}`).sort(),
    saved: Object.entries(all).filter(([, e]) => e.saved).map(([k, e]) => `${k} ${name(e.cookieStoreId)} ${e.parentKey} ${e.saved.url}`).sort(),
    rules: (m.ff.store.rules || []).map(r => `${r.url} ${name(r.space)}`).sort(),
    spaces: [...m.ff.containers].filter(id => id !== "firefox-default").map(name).sort(),
  };
}

async function act(m, r, n, urls) {
  const { ff, x, w } = m;
  const pick = list => list[Math.floor(r() * list.length)];
  const spaces = [...ff.containers].filter(id => id !== "firefox-default");
  const space = pick(spaces);
  const all = ff.synced || {};
  const folders = Object.keys(all).filter(k => all[k].group && all[k].own);
  const saved = Object.keys(all).filter(k => all[k].saved);
  const copies = ff.list(w.id).filter(t => t.pinned);
  const what = Math.floor(r() * 11);
  if (what === 0) { // A site, sometimes one the other machine has too.
    const url = urls[Math.floor(r() * urls.length)];
    if (!(ff.store.essentials || []).some(e => e.url === url && e.cookieStoreId === space)) await pin(x, ff, w.id, url, space, url);
  } else if (what === 1 && copies.length) {
    const t = pick(copies);
    if (!t.active) ff.rm(t.id); // closing one only unloads it: it comes back
  } else if (what === 2 && copies.length) {
    await x.b.tabs.update(pick(copies).id, { pinned: false });
  } else if (what === 3) {
    await x.js("createFolder")(`Folder ${n}`, space);
  } else if (what === 4 && folders.length) {
    await x.js("renameFolder")(pick(folders), `Renamed ${n}`);
  } else if (what === 5 && folders.length) {
    await x.js("deleteFolder")(pick(folders));
  } else if (what === 6 && folders.length) {
    const f = pick(folders), t = ff.addTab(w.id, { url: `https://t${n}.example/`, title: `T${n}`, cookieStoreId: all[f].cookieStoreId });
    x.b.tabs.onCreated.fire(ff.snap(t));
    await wait(2200);
    await x.js("moveTab")(w.id, t.id, null, f);
  } else if (what === 7 && saved.length) {
    await x.js("closeEverywhere")(pick(saved), { dismiss: false });
  } else if (what === 8 && saved.length && folders.length) {
    const k = pick(saved), f = pick(folders.filter(y => all[y].cookieStoreId === all[k].cookieStoreId));
    const tab = ff.list(w.id).find(t => ff.values.get(t.id)?.syncKey === k);
    if (f && tab) await x.js("moveTab")(w.id, tab.id, null, f);
  } else if (what === 9) {
    await x.b.contextualIdentities.update(space, { name: `Space ${n}` });
  } else {
    const rules = ff.store.rules || [];
    const next = r() < 0.5 && rules.length ? rules.slice(1) : [...rules, { url: `rule${n}`, space }];
    await x.send({ type: "settings:rules", rules: next }, SETTINGS);
  }
  await wait(100);
}

test("two machines used at random, with the real scripts, end up holding the same", async () => {
  // TIDIER_SEEDS=40 to look harder.
  const seeds = process.env.TIDIER_SEEDS ? Array.from({ length: Number(process.env.TIDIER_SEEDS) }, (_, i) => i + 100) : [11, 23, 37];
  for (const seed of seeds) {
    const r = seeded(seed), server = {};
    const A = machine({ 1: "Work", 2: "Private" }), B = machine({ 5: "Private", 7: "Work" });
    A.x = await boot(A.ff);
    B.x = await boot(B.ff);
    const urls = ["https://same-a.example/", "https://same-b.example/", "https://same-c.example/"];
    for (let i = 0; i < 6; i++) { await act(A, r, `a${i}`, urls); await act(B, r, `b${i}`, urls); } // things of their own first
    await turnOn(A.x);
    await turnOn(B.x);
    for (let i = 0; i < 40; i++) {
      const m = r() < 0.5 ? A : B;
      if (r() < 0.7) await act(m, r, `${seed}x${i}`, [...urls, `https://own${i}.example/`]);
      else { await settled(m.x); firefoxSyncNow(m.ff, server); }
      if (r() < 0.3) await settled(m.x);
    }
    await syncAround(server, [A, B], 5);
    for (const m of [A, B]) { await wait(3000); await m.x.js("flushWrites")(); await settled(m.x); }
    await syncAround(server, [A, B], 2);
    assert.deepEqual(holds(A), holds(B), `seed ${seed}`);
    for (const m of [A, B]) {
      const keys = (m.ff.store.essentials || []).map(e => e.key).sort();
      const tabs = m.ff.list(m.w.id).filter(t => t.pinned).map(t => m.ff.values.get(t.id)?.essentialKey).sort();
      assert.deepEqual(tabs, keys, `seed ${seed}: every essential has one tab`);
      for (const [key, e] of Object.entries(m.ff.synced || {})) {
        if (!e.saved) continue;
        assert.equal(m.ff.list(m.w.id).filter(t => m.ff.values.get(t.id)?.syncKey === key).length, 1, `seed ${seed}: a saved tab has one tab`);
      }
      assert.deepEqual(m.x.errors.filter(err => !/no host/.test(err)), [], `seed ${seed}`);
    }
    // With nothing happening, nothing more is written or run.
    const writes = [A.ff.syncWrites, B.ff.syncWrites];
    await wait(ROUND * 2);
    assert.deepEqual([A.ff.syncWrites, B.ff.syncWrites], writes, `seed ${seed}`);
    A.x.kill(); B.x.kill();
  }
});

// --- Hiding a space ------------------------------------------------------------------
async function withTabs() {
  const { ff, w } = machine({ 1: "Work", 2: "Client", 3: "Private" });
  ff.store.essentials = [
    { key: "work", url: "https://work.example/", cookieStoreId: c(1), title: "W", icon: "x" },
    { key: "client", url: "https://client.example/", cookieStoreId: c(2), title: "C", icon: "x" },
  ];
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Client folder", cookieStoreId: c(2), parentKey: null, rank: 1 },
    saved: { url: "https://saved.example/", title: "Saved", cookieStoreId: c(2), parentKey: "F", group: false, added: 1, saved: { url: "https://saved.example/", title: "Saved" } },
    plain: { url: "https://plain.example/", title: "Plain", cookieStoreId: c(2), parentKey: null, group: false, added: 1 },
  };
  ff.addTab(w.id, { url: "https://plain.example/", title: "Plain", cookieStoreId: c(2) }, { syncKey: "plain", syncRole: "live" });
  ff.addTab(w.id, { url: "https://saved.example/", title: "Saved", cookieStoreId: c(2) }, { syncKey: "saved", syncRole: "live" });
  const x = await boot(ff);
  return { ff, w, x };
}
const inSpace = (ff, w, space) => ff.list(w.id).filter(t => t.cookieStoreId === space);
const bar = async (x, windowId) => (await x.js("viewFor")(windowId)).spaces.map(s => s.name);

test("a hidden space gets no tabs here and is not on the bar, and nothing is deleted", async () => {
  const { ff, w, x } = await withTabs();
  assert.equal(inSpace(ff, w, c(2)).length, 3, "an essential and two tabs before");
  await hide(x, c(2));
  await wait(500);
  assert.deepEqual(inSpace(ff, w, c(2)), [], "no tab of it in the window");
  assert.deepEqual(await bar(x, w.id), ["Work", "Private"]);
  assert.ok(ff.synced.F && ff.synced.saved && ff.synced.plain, "the record keeps all of it");
  assert.ok(ff.store.essentials.some(e => e.key === "client"));
  assert.deepEqual(ff.store.hiddenSpaces, [c(2)]);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a new window gets nothing of a hidden space, and another start closes nothing else", async () => {
  const { ff, w, x } = await withTabs();
  await hide(x, c(2));
  await wait(500);
  const other = ff.addWindow();
  x.b.windows.onCreated.fire({ id: other.id, type: "normal", incognito: false });
  await wait(2000);
  assert.deepEqual(inSpace(ff, other, c(2)), []);
  assert.ok(ff.list(other.id).some(t => t.pinned && t.cookieStoreId === c(1)), "the rest does come");
  // A restart: the session brings a placeholder back, and it goes again; the record stays.
  x.kill();
  ff.addTab(w.id, { url: GHOST("essential", "client"), pinned: true, discarded: true, cookieStoreId: c(2) }, { essentialKey: "client" });
  const y = await boot(ff);
  await wait(500);
  assert.deepEqual(inSpace(ff, w, c(2)), []);
  assert.ok(ff.synced.saved && ff.synced.plain && ff.store.essentials.some(e => e.key === "client"));
  assert.deepEqual(await bar(y, w.id), ["Work", "Private"]);
  y.kill();
});

test("showing it again fills the windows, ordinary tabs too", async () => {
  const { ff, w, x } = await withTabs();
  await hide(x, c(2));
  await wait(500);
  await hide(x, c(2), false);
  await wait(500);
  assert.deepEqual(await bar(x, w.id), ["Work", "Client", "Private"]);
  const back = inSpace(ff, w, c(2));
  assert.ok(back.some(t => t.pinned && t.url === GHOST("essential", "client")), "the essential");
  assert.ok(back.some(t => t.url === GHOST("ghost", "saved")), "the saved tab");
  assert.ok(back.some(t => t.url === GHOST("ghost", "plain")), "the ordinary tab");
  assert.ok(ff.synced.plain && ff.synced.saved);
  // One tab of each is the live one, so that everything after this finds what it expects.
  for (const key of ["saved", "plain"]) assert.equal(back.filter(t => ff.values.get(t.id)?.syncKey === key && ff.values.get(t.id)?.syncRole === "live").length, 1, key);
  // And it is hidden as a space you are not in, not shown over the one you are in.
  assert.ok(back.filter(t => !t.pinned).every(t => t.hidden));
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("⌃1/2/3 and the bar skip a hidden space, and a window in it moves to another", async () => {
  const { ff, w, x } = await withTabs();
  await x.js("switchSpace")(w.id, c(2));
  await wait(200);
  await hide(x, c(2));
  await wait(500);
  assert.equal(x.js(`activeSpace.get(${w.id})`), c(1));
  await x.js("switchToNth")(1);
  await wait(200);
  assert.equal(x.js(`activeSpace.get(${w.id})`), c(3), "the second on the bar is Private, not Client");
  x.kill();
});

test("a window on a tab with no container keeps it when its space is hidden", async () => {
  const { ff, w, x } = await withTabs();
  await x.js("switchSpace")(w.id, c(2));
  const settings = ff.addTab(w.id, { url: "moz-extension://tidier/settings/settings.html", title: "Settings" });
  ff.select(settings.id);
  await wait(300);
  await hide(x, c(2));
  await wait(500);
  assert.equal(ff.tabs.get(settings.id).active, true, "you stay on the page you are on");
  assert.equal(x.js(`activeSpace.get(${w.id})`), c(1));
  x.kill();
});

test("the last space that shows cannot be hidden", async () => {
  const { ff, w } = machine({ 1: "Only" });
  const x = await boot(ff);
  await hide(x, c(1));
  await wait(300);
  assert.deepEqual(await bar(x, w.id), ["Only"]);
  assert.ok(inSpace(ff, w, c(1)).length, "its tabs stay");
  x.kill();
});

test("a page with unsaved input stays open when its space is hidden, and can still be reached", async () => {
  const { ff, w, x } = await withTabs();
  const page = ff.list(w.id).find(t => t.url === "https://saved.example/");
  ff.refuseDiscard = new Set([page.id]);
  const said = [];
  x.js("globalThis").say = (windowId, text) => said.push(text);
  await hide(x, c(2));
  await wait(500);
  assert.ok(ff.tabs.has(page.id), "not closed");
  assert.equal(said.length, 1);
  assert.match(said[0], /unsaved input/);
  const view = await x.js("viewFor")(w.id);
  assert.ok(view.tabs.some(t => t.id === page.id), "shown in the space you are in");
  assert.equal(ff.tabs.get(page.id).hidden, false);
  // Selecting it does not take you to the hidden space.
  ff.select(page.id);
  await wait(300);
  assert.equal(x.js(`activeSpace.get(${w.id})`), c(1));
  // Closed, it is hidden like the rest: the record stays, and no placeholder comes back.
  ff.select(ff.list(w.id).find(t => t.cookieStoreId === c(1) && !t.pinned).id);
  await wait(200);
  ff.rm(page.id);
  await wait(1000);
  assert.ok(ff.synced.saved, "a saved tab stays in the record");
  assert.deepEqual(inSpace(ff, w, c(2)).filter(t => t.url.includes("ghost.html")), []);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a rule that points at a hidden space opens the tab where you are, and says so", async () => {
  const { ff, w, x } = await withTabs();
  await x.send({ type: "settings:rules", rules: [{ url: "client.example", space: c(2) }] }, SETTINGS);
  await hide(x, c(2));
  await wait(500);
  const said = [];
  x.js("globalThis").say = (windowId, text) => said.push(text);
  const t = ff.addTab(w.id, { url: "about:blank", active: false });
  x.b.tabs.onCreated.fire(ff.snap(t));
  await wait(100);
  ff.navigate(t.id, "https://client.example/page");
  await wait(1000);
  assert.deepEqual(inSpace(ff, w, c(2)), [], "no tab lands in it");
  assert.ok(ff.list(w.id).some(y => y.url === "https://client.example/page" && y.cookieStoreId === c(1)), "it opens in the space you are in");
  assert.equal(said.length, 1);
  assert.match(said[0], /Client is hidden/);
  x.kill();
});

test("a tab you open in a hidden container yourself is shown, and stays out of tab sync", async () => {
  const { ff, w, x } = await withTabs();
  await hide(x, c(2));
  await wait(500);
  const t = ff.addTab(w.id, { url: "https://mine.example/", cookieStoreId: c(2) });
  x.b.tabs.onCreated.fire(ff.snap(t));
  await wait(2000);
  assert.ok(ff.tabs.has(t.id));
  assert.ok(!Object.values(ff.synced).some(e => e.url === "https://mine.example/"));
  assert.ok((await x.js("viewFor")(w.id)).tabs.some(y => y.id === t.id));
  x.kill();
});

test("a live folder of a hidden space is left alone until it shows", async () => {
  const { ff, w, x } = await withTabs();
  await hide(x, c(2));
  await wait(500);
  let asked = 0;
  x.b.runtime.sendNativeMessage = async (host, msg) => {
    if (msg.list) return { folders: [{ id: "prs", name: "Pull requests", container: c(2) }] };
    asked++;
    return { items: [{ url: "https://pr.example/1", repo: "r", number: 1, title: "One" }] };
  };
  await x.js("refreshAllLiveFolders")();
  await wait(300);
  assert.equal(asked, 0);
  assert.deepEqual(inSpace(ff, w, c(2)), []);
  await hide(x, c(2), false);
  await x.js("refreshAllLiveFolders")();
  await wait(300);
  assert.equal(asked, 1);
  assert.ok(Object.values(ff.synced).some(e => e.liveUrl === "https://pr.example/1"));
  x.kill();
});

test("a space can be declared hidden for a machine, by name", async () => {
  const { ff, w } = machine({ 1: "Work", 2: "Client" });
  ff.managed.hiddenSpaces = ["Client"];
  ff.store.essentials = [{ key: "client", url: "https://client.example/", cookieStoreId: c(2), title: "C", icon: "x" }];
  const x = await boot(ff);
  assert.deepEqual(inSpace(ff, w, c(2)), []);
  const r = await report(x);
  const client = r.spaces.find(s => s.name === "Client");
  assert.equal(client.hidden, true);
  assert.equal(client.declared, true);
  // The settings page cannot undo it: it says so instead of offering it.
  await hide(x, c(2), false);
  assert.deepEqual(await bar(x, w.id), ["Work"]);
  // A rename does not show it on the wrong machine.
  await x.b.contextualIdentities.update(c(2), { name: "Customer" });
  await wait(300);
  assert.deepEqual(await bar(x, w.id), ["Work"]);
  x.kill();
});

test("a space declared hidden that comes by sync gets no tab, and is there when shown", async () => {
  const A = machine({ 1: "Work", 2: "Workplace" }), B = machine({ 1: "Work" });
  const server = {};
  B.ff.managed.hiddenSpaces = ["Workplace"];
  A.x = await boot(A.ff);
  B.x = await boot(B.ff);
  await pin(A.x, A.ff, A.w.id, "https://workplace.example/", c(2));
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, [A, B]);
  const id = Object.keys(B.ff.identities).find(k => B.ff.identities[k].name === "Workplace");
  assert.ok(id, "its container is here, with no tab in it");
  assert.equal(B.ff.store.essentials[0].cookieStoreId, id, "and its essential in the record");
  assert.deepEqual(inSpace(B.ff, B.w, id), []);
  assert.deepEqual(await bar(B.x, B.w.id), ["Work"]);
  A.x.kill(); B.x.kill();
});

test("a hidden space survives a merge, keeps syncing, and is never said to be hidden elsewhere", async () => {
  const { A, B, server, machines, end } = await pair({ 1: "Work", 2: "Private" }, { 5: "Private", 7: "Work" });
  await pin(A.x, A.ff, A.w.id, "https://private.example/", c(2));
  await turnOn(A.x);
  await turnOn(B.x);
  await syncAround(server, machines);
  await hide(B.x, c(5));
  await wait(500);
  assert.deepEqual(inSpace(B.ff, B.w, c(5)), []);
  // More comes while it is hidden: into the record, not into a window.
  await pin(A.x, A.ff, A.w.id, "https://private2.example/", c(2));
  await syncAround(server, machines);
  assert.equal(B.ff.store.essentials.length, 2);
  assert.deepEqual(inSpace(B.ff, B.w, c(5)), []);
  assert.equal(A.ff.store.essentials.length, 2, "hiding deleted nothing anywhere");
  assert.ok(!JSON.stringify(A.ff.syncArea).includes(c(5)), "no container id of this machine goes into the shared data");
  assert.deepEqual((await bar(A.x, A.w.id)).sort(), ["Private", "Work"], "the other machine still shows it");
  // Shown again here: everything is there.
  await hide(B.x, c(5), false);
  await wait(500);
  assert.equal(inSpace(B.ff, B.w, c(5)).filter(t => t.pinned).length, 2);
  assert.deepEqual([...A.x.errors, ...B.x.errors], []);
  end();
});

test("with no container ids in the shared data, logins cannot mix across machines", async () => {
  const { A, B, server, machines, end } = await pair();
  await pin(A.x, A.ff, A.w.id, "https://a.example/", c(1));
  A.ff.store.rules = [{ url: "x", space: c(1) }];
  await turnOn(A.x);
  await syncAround(server, machines, 1);
  assert.ok(!JSON.stringify(A.ff.syncArea).includes("firefox-container"));
  end();
});
