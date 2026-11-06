// How two machines' versions of Tidier's data become one (syncmerge.js), with no Firefox:
// this is where data could be lost on every machine at once, so it is tested the hardest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Run in this realm, so that its objects compare as plain objects.
const src = readFileSync(new URL("../syncmerge.js", import.meta.url), "utf8");
const { mergeSynced, noteLocalChanges, syncSeen, syncItems, docFromItems, emptySyncDoc, syncSpaceId, syncHighest, syncShort, SYNC_QUOTA, SYNC_KEEP_GONE_MS } =
  vm.runInThisContext(`(() => { ${src}; return { mergeSynced, noteLocalChanges, syncSeen, syncItems, docFromItems, emptySyncDoc, syncSpaceId, syncHighest, syncShort, SYNC_QUOTA, SYNC_KEEP_GONE_MS }; })()`);

const NOW = 1800000000000;
const doc = parts => ({ ...emptySyncDoc(), ...parts });
const e = (url, at, more = {}) => ({ url, title: url, space: "s1", at, ...more });
const folder = (name, at, more = {}) => ({ name, space: "s1", at, ...more });
const tab = (url, f, at, more = {}) => ({ url, title: url, folder: f, space: "s1", at, ...more });
const gone = (at, more = {}) => ({ gone: 1, at, ...more });
// Most tests use small stamps; "now" is near them, unless a test is about time.
const merge = (a, b, now = 1000) => mergeSynced(a, b, now);
const ago = days => NOW - days * 24 * 3600e3;

test("newest wins per thing, and changes to different things are both kept", () => {
  const a = doc({ essentials: { x: e("https://x/", 10, { name: "New" }), y: e("https://y/", 5) } });
  const b = doc({ essentials: { x: e("https://x/", 8, { name: "Old" }), y: e("https://y/", 7, { name: "Y" }) } });
  const m = merge(a, b);
  assert.equal(m.essentials.x.name, "New");
  assert.equal(m.essentials.y.name, "Y");
});

test("a change on one side and nothing on the other: the change stays, and absence deletes nothing", () => {
  const m = merge(doc({ essentials: { only: e("https://only/", 1) }, folders: { f: folder("F", 1) }, saved: { s: tab("https://s/", "f", 1) }, rules: { "r:a": { space: "s1", at: 1 } } }), doc({}));
  assert.ok(m.essentials.only && m.folders.f && m.saved.s && m.rules["r:a"]);
  const n = merge(doc({}), m);
  assert.deepEqual(n, m);
});

test("the same moment on two machines goes the same way on both", () => {
  const a = doc({ essentials: { x: e("https://x/", 10, { name: "A" }) } });
  const b = doc({ essentials: { x: e("https://x/", 10, { name: "B" }) } });
  assert.deepEqual(merge(a, b), merge(b, a));
  // A deletion wins a tie.
  const c = doc({ essentials: { x: gone(10, { space: "s1" }) } });
  assert.equal(merge(a, c).essentials.x.gone, 1);
  assert.equal(merge(c, a).essentials.x.gone, 1);
});

test("deleted here and changed there: the later one wins", () => {
  const changedLater = merge(doc({ essentials: { x: gone(10, { space: "s1" }) } }), doc({ essentials: { x: e("https://x/", 20, { name: "Kept" }) } }));
  assert.equal(changedLater.essentials.x.name, "Kept");
  assert.ok(!changedLater.essentials.x.gone);
  const deletedLater = merge(doc({ essentials: { x: gone(20, { space: "s1" }) } }), doc({ essentials: { x: e("https://x/", 10) } }));
  assert.equal(deletedLater.essentials.x.gone, 1);
});

test("the same site added on both machines stays one, on the same key on both", () => {
  const a = doc({ essentials: { zz: e("https://jira/", 5) } });
  const b = doc({ essentials: { aa: e("https://jira/", 9, { name: "Jira" }) } });
  for (const m of [merge(a, b), merge(b, a)]) {
    assert.ok(!m.essentials.aa.gone);
    assert.equal(m.essentials.zz.gone, 1);
    assert.equal(m.essentials.zz.to, "aa", "its tabs are taken over, not closed");
  }
  assert.deepEqual(merge(a, b), merge(b, a));
});

test("the same site added on both keeps the short name either had", () => {
  const m = merge(doc({ essentials: { zz: e("https://jira/", 5, { name: "Jira" }) } }), doc({ essentials: { aa: e("https://jira/", 9) } }));
  assert.equal(m.essentials.aa.name, "Jira");
});

test("two of the same on one machine are left alone: you made them", () => {
  const a = doc({ essentials: { p: e("https://x/", 1), q: e("https://x/", 2) }, folders: { f: folder("New folder", 1), g: folder("New folder", 2) } });
  const m = merge(a, doc({}));
  assert.ok(!m.essentials.p.gone && !m.essentials.q.gone && !m.folders.f.gone && !m.folders.g.gone);
  // Nor once both machines hold them.
  const n = merge(m, m);
  assert.ok(!n.folders.f.gone && !n.folders.g.gone);
});

test("a folder made on both machines stays one, with the tabs of both, and a tab in both once", () => {
  const a = doc({ folders: { zf: folder("Work", 5) }, saved: { s1: tab("https://one/", "zf", 5), s2: tab("https://both/", "zf", 5) } });
  const b = doc({ folders: { af: folder("Work", 6) }, saved: { t1: tab("https://two/", "af", 6), t2: tab("https://both/", "af", 6) } });
  for (const m of [merge(a, b), merge(b, a)]) {
    assert.equal(m.folders.zf.to, "af");
    assert.equal(m.saved.s1.folder, "af");
    assert.equal(m.saved.t1.folder, "af");
    const both = ["s2", "t2"].map(k => m.saved[k]);
    assert.equal(both.filter(s => !s.gone).length, 1);
    assert.equal(both.find(s => s.gone).to, "s2");
  }
});

test("folders of one name in different spaces are different folders", () => {
  const m = merge(doc({ folders: { a: folder("Work", 1) } }), doc({ folders: { b: folder("Work", 1, { space: "s2" }) } }));
  assert.ok(!m.folders.a.gone && !m.folders.b.gone);
});

test("a clock that is behind cannot make a change you made after seeing another lose", () => {
  // Machine B's clock is an hour behind. It sees A's rename, then renames again.
  const fromA = doc({ essentials: { x: e("https://x/", NOW, { name: "From A" }) } });
  let clock = syncHighest(fromA);
  const behind = () => (clock = Math.max(NOW - 3600e3, clock + 1));
  const seenWhenItCame = syncSeen(doc({ essentials: { x: { url: "https://x/", space: "s1", name: "From A" } } }));
  const renamed = doc({ essentials: { x: { url: "https://x/", title: "t", space: "s1", name: "From B" } } });
  const stamped = noteLocalChanges(fromA, renamed, seenWhenItCame, behind);
  assert.ok(stamped.essentials.x.at > NOW, "later than what it saw, whatever its clock says");
  assert.equal(merge(stamped, fromA, NOW).essentials.x.name, "From B");
  assert.equal(merge(fromA, stamped, NOW).essentials.x.name, "From B");
});

test("two changes that did not see each other: the clock decides, the same on both", () => {
  const a = doc({ essentials: { x: e("https://x/", NOW + 3600e3, { name: "Ahead" }) } }); // this clock is an hour ahead
  const b = doc({ essentials: { x: e("https://x/", NOW, { name: "Made later, by the right clock" }) } });
  assert.equal(merge(a, b, NOW).essentials.x.name, "Ahead");
  assert.deepEqual(merge(a, b, NOW), merge(b, a, NOW));
});

test("a tombstone keeps a thing away for 30 days, and then is forgotten", () => {
  const t = doc({ essentials: { x: gone(ago(29), { space: "s1" }) } });
  const old = doc({ essentials: { x: e("https://x/", ago(40)) } });
  assert.equal(merge(t, old, NOW).essentials.x.gone, 1, "not expired: it stays gone");
  const expired = doc({ essentials: { x: gone(ago(31), { space: "s1" }) } });
  assert.equal(merge(expired, doc({}), NOW).essentials.x, undefined, "expired: forgotten");
  assert.equal(merge(expired, old, NOW).essentials.x, undefined, "an old copy goes with it while it is still known");
  // A machine away for longer than that, when no machine knows of the deletion: the thing
  // comes back. Better a thing you deleted long ago than one you did not delete, gone.
  assert.equal(merge(doc({}), old, NOW).essentials.x.url, "https://x/");
  // Exactly at the limit it is still kept.
  const edge = doc({ essentials: { x: gone(NOW - SYNC_KEEP_GONE_MS, { space: "s1" }) } });
  assert.equal(merge(edge, doc({}), NOW).essentials.x.gone, 1);
});

test("the same thing on two machines at their first merge stays one however long ago that is", () => {
  // Things stamped by a first merge have no time, so what they leave must not expire at once.
  const a = doc({ essentials: { z: e("https://same/", 1) } }), b = doc({ essentials: { a: e("https://same/", 1) } });
  const m = merge(a, b, NOW);
  assert.equal(m.essentials.z.to, "a");
});

test("a space renamed keeps its identity: what is in it stays in it", () => {
  const a = doc({ spaces: { s1: { name: "Work", color: "blue", icon: "circle", at: 5 } }, essentials: { x: e("https://x/", 5) } });
  const b = doc({ spaces: { s1: { name: "Job", color: "blue", icon: "circle", at: 9 } } });
  const m = merge(a, b);
  assert.equal(m.spaces.s1.name, "Job");
  assert.equal(m.essentials.x.space, "s1");
});

test("a new space's id comes from its name, so two machines agree before they meet", () => {
  assert.equal(syncSpaceId("Work"), syncSpaceId("Work"));
  assert.notEqual(syncSpaceId("Work"), syncSpaceId("Private"));
  const taken = new Set([syncSpaceId("Work")]);
  assert.notEqual(syncSpaceId("Work", id => taken.has(id)), syncSpaceId("Work"), "a second space of that name stays apart");
});

test("a folder deleted while a tab went into it elsewhere comes back with the tab", () => {
  const a = doc({ folders: { f: gone(10, { name: "Keep", space: "s1" }) } });
  const b = doc({ folders: { f: folder("Keep", 5) }, saved: { s: tab("https://s/", "f", 20), old: tab("https://old/", "f", 5) } });
  for (const m of [merge(a, b), merge(b, a)]) {
    assert.equal(m.folders.f.name, "Keep");
    assert.ok(!m.folders.f.gone);
    assert.ok(!m.saved.s.gone);
    assert.ok(!m.saved.old.gone, "the folder is back, and so is what is in it");
  }
});

test("a deleted folder takes older tabs with it", () => {
  const a = doc({ folders: { f: gone(10, { name: "F", space: "s1" }) } });
  const b = doc({ folders: { f: folder("F", 5) }, saved: { s: tab("https://s/", "f", 5) } });
  const m = merge(a, b);
  assert.equal(m.folders.f.gone, 1);
  assert.equal(m.saved.s.gone, 1);
  assert.equal(merge(m, b).saved.s.gone, 1, "and stays so");
});

test("a tab whose folder has not come yet is kept, and not deleted", () => {
  const m = merge(doc({ saved: { s: tab("https://s/", "later", 5) } }), doc({}));
  assert.ok(m.saved.s && !m.saved.s.gone);
});

test("an order is one thing: the newest wins whole, and a folder's goes with it", () => {
  const a = doc({ order: { "e:s1": { list: ["a", "b"], at: 5 }, "s:f": { list: ["1"], at: 1 } }, folders: { f: gone(9, { name: "F", space: "s1" }) } });
  const b = doc({ order: { "e:s1": { list: ["b", "a"], at: 7 }, "s:g": { list: ["2"], at: 1 } }, folders: { g: folder("G", 9) } });
  const m = merge(a, b);
  assert.deepEqual(m.order["e:s1"].list, ["b", "a"]);
  assert.equal(m.order["s:f"], undefined);
  assert.deepEqual(m.order["s:g"].list, ["2"]);
});

// --- What changed here ---------------------------------------------------------
const stamps = (from = NOW) => { let n = from; return () => ++n; };

test("turning sync on merges: what is here is kept, and what others decided wins", () => {
  const here = doc({
    essentials: { mine: { url: "https://mine/", title: "m", space: "s1" }, shared: { url: "https://shared/", title: "s", space: "s1", name: "Old" }, deletedThere: { url: "https://d/", space: "s1" } },
    order: { "e:s1": ["mine"] },
  });
  const local = noteLocalChanges(emptySyncDoc(), here, null, stamps());
  assert.equal(local.essentials.mine.at, 1);
  const remote = doc({ essentials: { shared: e("https://shared/", ago(1), { name: "New" }), deletedThere: gone(ago(1), { space: "s1" }), theirs: e("https://theirs/", ago(2)) } });
  const m = merge(local, remote, NOW);
  assert.ok(!m.essentials.mine.gone, "what only this machine has is added");
  assert.equal(m.essentials.shared.name, "New", "what the others changed wins");
  assert.equal(m.essentials.deletedThere.gone, 1, "what they deleted goes");
  assert.equal(m.essentials.theirs.url, "https://theirs/");
  assert.equal(merge(local, doc({})).essentials.mine.url, "https://mine/", "with nothing there, nothing is overwritten");
});

test("the first merge deletes nothing of its own", () => {
  const local = noteLocalChanges(doc({ essentials: { was: e("https://was/", 5) } }), doc({}), null, stamps());
  assert.ok(!local.essentials.was.gone);
});

test("a change here is stamped, a title alone is not, and what did not change keeps its stamp", () => {
  const first = doc({ essentials: { x: { url: "https://x/", title: "One", space: "s1" }, y: { url: "https://y/", title: "Y", space: "s1" } } });
  const state = noteLocalChanges(emptySyncDoc(), first, null, stamps());
  const seen = syncSeen(first);
  const ticking = doc({ essentials: { x: { url: "https://x/", title: "1 new message", space: "s1" }, y: first.essentials.y } });
  assert.deepEqual(noteLocalChanges(state, ticking, seen, stamps()), state, "a ticking title changes nothing");
  const named = doc({ essentials: { x: { url: "https://x/", title: "One", space: "s1", name: "X" }, y: first.essentials.y } });
  const after = noteLocalChanges(state, named, seen, stamps());
  assert.ok(after.essentials.x.at > 1);
  assert.equal(after.essentials.y.at, 1);
});

test("something removed here becomes a tombstone; something not applied here yet does not", () => {
  const here = doc({ essentials: { a: { url: "https://a/", space: "s1" }, b: { url: "https://b/", space: "s1" } } });
  const state = noteLocalChanges(emptySyncDoc(), here, null, stamps());
  state.essentials.waiting = e("https://waiting/", 3); // came from elsewhere, and is not here yet
  const seen = syncSeen(here);
  const after = noteLocalChanges(state, doc({ essentials: { a: here.essentials.a } }), seen, stamps());
  assert.equal(after.essentials.b.gone, 1);
  assert.ok(!after.essentials.waiting.gone);
  assert.ok(!after.essentials.a.gone);
});

test("what is in a space this machine does not have is not deleted by leaving it out", () => {
  const here = doc({ essentials: { a: { url: "https://a/", space: "away" } } });
  const state = noteLocalChanges(emptySyncDoc(), here, null, stamps());
  const after = noteLocalChanges(state, doc({}), syncSeen(here), stamps(), sid => sid !== "away");
  assert.ok(!after.essentials.a.gone);
});

test("a space is never deleted on the other machines: their logins are in it", () => {
  const here = doc({ spaces: { s1: { name: "Work", color: "blue", icon: "circle" } } });
  const state = noteLocalChanges(emptySyncDoc(), here, null, stamps());
  const after = noteLocalChanges(state, doc({}), syncSeen(here), stamps());
  assert.ok(!after.spaces.s1.gone);
  assert.equal(after.spaces.s1.name, "Work");
});

test("a whole kind suddenly empty is not you deleting it", () => {
  const essentials = Object.fromEntries(["a", "b", "c", "d", "e"].map(k => [k, { url: `https://${k}/`, space: "s1" }]));
  const here = doc({ essentials });
  const state = noteLocalChanges(emptySyncDoc(), here, null, stamps());
  const after = noteLocalChanges(state, doc({}), syncSeen(here), stamps());
  assert.ok(Object.values(after.essentials).every(x => !x.gone));
  // Fewer than that is what a person does.
  const few = doc({ essentials: { a: essentials.a } });
  const state2 = noteLocalChanges(emptySyncDoc(), few, null, stamps());
  assert.equal(noteLocalChanges(state2, doc({}), syncSeen(few), stamps()).essentials.a.gone, 1);
});

test("an order that did not change here keeps its stamp, one that did gets a new one", () => {
  const here = doc({ order: { "e:s1": ["a", "b"] } });
  const state = noteLocalChanges(emptySyncDoc(), here, null, stamps());
  assert.deepEqual(noteLocalChanges(state, here, syncSeen(here), stamps()), state);
  const moved = noteLocalChanges(state, doc({ order: { "e:s1": ["b", "a"] } }), syncSeen(here), stamps());
  assert.deepEqual(moved.order["e:s1"].list, ["b", "a"]);
  assert.ok(moved.order["e:s1"].at > 1);
});

// --- The items -------------------------------------------------------------------
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const longUrl = n => `https://intranet.example/projects/alpha/boards/${n}/issues?filter=assignee%3Dme&sort=updated&view=compact&extra=${"x".repeat(40)}`;

function bigDoc(essentials = 100, saved = 200, spaces = 3) {
  const d = emptySyncDoc();
  for (let s = 0; s < spaces; s++) d.spaces["s" + s] = { name: "Space " + s, color: "blue", icon: "circle", at: 1 };
  for (let f = 0; f < 10; f++) d.folders[uuid(9000 + f)] = { name: "Folder " + f, space: "s" + (f % spaces), at: 2 };
  for (let n = 0; n < essentials; n++) d.essentials[uuid(n)] = { url: longUrl(n), title: "An essential with a title of some length " + n, space: "s" + (n % spaces), at: 3 + n };
  for (let n = 0; n < saved; n++) {
    const f = n % 10;
    d.saved[uuid(1000 + n)] = { url: longUrl(1000 + n), title: "A saved tab with a title of some length too " + n, folder: uuid(9000 + f), space: "s" + (f % spaces), at: 200 + n };
  }
  for (let s = 0; s < spaces; s++) d.order["e:s" + s] = { list: Object.keys(d.essentials).filter(k => d.essentials[k].space === "s" + s).map(syncShort), at: 5 };
  for (let f = 0; f < 10; f++) d.order["s:" + uuid(9000 + f)] = { list: Object.keys(d.saved).filter(k => d.saved[k].folder === uuid(9000 + f)).map(syncShort), at: 6 };
  return d;
}
const withinFirefox = items => {
  for (const [k, v] of Object.entries(items)) assert.ok(k.length + JSON.stringify(v).length <= SYNC_QUOTA.item, `${k} is too big`);
  assert.ok(Object.keys(items).length <= SYNC_QUOTA.items);
  assert.ok(JSON.stringify(items).length <= SYNC_QUOTA.total, "too much in all");
};

test("100 essentials and 200 saved tabs with long addresses fit within Firefox's limits", () => {
  const { items, left, bytes } = syncItems(bigDoc());
  assert.deepEqual(left, []);
  withinFirefox(items);
  assert.ok(bytes < SYNC_QUOTA.total * 0.95, `${bytes} bytes`);
  assert.ok(Object.keys(items).some(k => k.includes("s0.1")), "a big space takes more than one item");
});

test("what is written reads back as the same thing", () => {
  const d = bigDoc(30, 40);
  d.rules["r:example.org"] = { space: "s1", at: 9 };
  d.rules["r:gone.example"] = gone(10);
  d.essentials.dead = gone(11, { space: "s0", to: uuid(1) });
  d.folders.deadFolder = gone(12, { name: "Old", space: "s1" });
  d.saved.deadTab = gone(13, { space: "s2" });
  assert.deepEqual(docFromItems(syncItems(d).items), d);
});

test("no icon goes into the items", () => {
  const d = doc({ essentials: { x: { url: "https://x/", title: "X", icon: "data:image/png;base64,AAAA", space: "s1", at: 1 } } });
  assert.ok(!JSON.stringify(syncItems(d).items).includes("base64"));
});

test("two machines holding the same write the same, whatever order they learned it in", () => {
  const d = bigDoc(40, 60);
  const shuffled = JSON.parse(JSON.stringify(d));
  for (const kind of ["essentials", "saved"]) shuffled[kind] = Object.fromEntries(Object.entries(d[kind]).reverse());
  assert.deepEqual(syncItems(shuffled).items, syncItems(d).items);
});

test("what does not fit is said, the newest first to go, and the rest is written", () => {
  const d = bigDoc(100, 900);
  const { items, left, bytes } = syncItems(d);
  withinFirefox(items);
  assert.ok(left.length > 0);
  assert.ok(left.every(l => l.kind === "saved"), "essentials come before saved tabs");
  assert.ok(left.some(l => l.id === uuid(1000 + 899)), "the newest does not fit");
  assert.ok(!left.some(l => l.id === uuid(1000)), "the oldest does");
  assert.ok(bytes <= SYNC_QUOTA.total);
  assert.equal(docFromItems(items).essentials[uuid(99)].url, longUrl(99));
});

test("an address too long for any item stays out, and is said", () => {
  const d = doc({ essentials: { fine: e("https://fine/", 1), huge: e("https://huge/" + "x".repeat(9000), 2) } });
  const { items, left } = syncItems(d);
  withinFirefox(items);
  assert.deepEqual(left.map(l => l.id), ["huge"]);
});

test("what is written leaves nothing out of order: tombstones get through before saved tabs", () => {
  const d = bigDoc(0, 900, 1);
  d.essentials.dead = gone(999999, { space: "s0" });
  const decoded = docFromItems(syncItems(d).items);
  assert.equal(decoded.essentials.dead.gone, 1);
});

test("what cannot be read is left out, and takes nothing with it", () => {
  const items = {
    "1/s1.0": [["e", "ok", 5, "https://ok/", "OK"], null, 7, "x", ["e"], ["e", 3, 5], ["e", "noat", "soon", "https://x/"], ["e", "bad", 5, "javascript:alert(1)"], ["e", "__proto__", 5, "https://evil/"],
      ["t", "nofolder", 5, "https://x/", "T"], ["f", "noname", 5], ["q", "unknown", 5], ["o", "order", 5, "notalist"]],
    "1/m.0": "not rows",
    "other": [["e", "other", 5, "https://other/"]],
    "2/s1.0": [["e", "future", 5, "https://future/"]],
  };
  const d = docFromItems(items);
  assert.deepEqual(Object.keys(d.essentials), ["ok"]);
  assert.deepEqual(Object.keys(d.saved), []);
  assert.deepEqual(Object.keys(d.folders), []);
  assert.deepEqual(Object.keys(d.order), []);
  assert.equal(({}).url, undefined, "nothing reached Object's prototype");
  // A thing named as a built-in is an ordinary thing.
  const m = merge(doc({ rules: { constructor: { space: "s1", at: 1 } } }), doc({}));
  assert.equal(m.rules.constructor.space, "s1");
});

test("the same thing in two items, one left from before, is the newest of the two", () => {
  const items = { "1/s1.0": [["e", "x", 5, "https://x/", "Old"]], "1/s1.1": [["e", "x", 9, "https://x/", "New"]] };
  assert.equal(docFromItems(items).essentials.x.title, "New");
});

// --- Laws --------------------------------------------------------------------------
function randomDoc(rand) {
  const d = emptySyncDoc();
  const ids = ["a", "b", "c", "d"];
  for (const id of ids) {
    const r = rand();
    if (r < 0.3) continue;
    const at = 1 + Math.floor(rand() * 6);
    d.essentials[id] = r < 0.5 ? gone(at, { space: "s1" }) : e(`https://${id}/`, at, { name: rand() < 0.5 ? "n" + Math.floor(rand() * 3) : undefined });
    if (d.essentials[id].name === undefined) delete d.essentials[id].name;
  }
  for (const id of ids) {
    const r = rand();
    if (r < 0.5) continue;
    d.order["e:s" + id] = { list: [id, String(Math.floor(rand() * 3))], at: 1 + Math.floor(rand() * 6) };
  }
  return d;
}
function seeded(seed) { return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

test("a merge gives the same whichever side you start from, and again gives the same", () => {
  const rand = seeded(7);
  for (let i = 0; i < 400; i++) {
    const a = randomDoc(rand), b = randomDoc(rand);
    const ab = merge(a, b), ba = merge(b, a);
    assert.deepEqual(ab, ba);
    assert.deepEqual(merge(ab, ab), ab);
    assert.deepEqual(merge(ab, a), ab);
    assert.deepEqual(merge(ab, b), ab);
  }
});

// --- A model of machines using Tidier at random ---------------------------------------
// Three machines with clocks that differ, each with its own view of the data, Firefox
// Sync as MDN describes it (per item, the server's change wins over a change here), and
// the rounds of sync.js. Whatever order things happen in, once Firefox Sync has run a few
// times all must have the same, no write may be left to do, and nothing that nobody
// deleted may be missing.
class Machine {
  constructor(name, skew, rand, world) {
    Object.assign(this, { name, skew, rand, world, here: emptySyncDoc(), doc: emptySyncDoc(), seen: null, clock: 0, area: {}, mirror: {}, writes: 0 });
  }
  round() {
    const remote = docFromItems(this.area);
    const now = this.world.now + this.skew;
    this.clock = Math.max(this.clock, syncHighest(remote));
    const stamp = () => (this.clock = Math.max(now, this.clock + 1));
    const merged = mergeSynced(noteLocalChanges(this.doc, this.here, this.seen, stamp), remote, now);
    this.clock = Math.max(this.clock, syncHighest(merged));
    this.applyMerged(merged);
    this.seen = syncSeen(this.here);
    this.doc = merged;
    const { items } = syncItems(merged);
    for (const k of Object.keys(this.area)) if (!(k in items)) { delete this.area[k]; this.writes++; }
    for (const [k, v] of Object.entries(items)) if (JSON.stringify(this.area[k]) !== JSON.stringify(v)) { this.area[k] = v; this.writes++; }
  }
  applyMerged(d) {
    const stripped = {};
    for (const kind of ["spaces", "essentials", "folders", "saved", "rules"]) {
      stripped[kind] = {};
      for (const [id, item] of Object.entries(d[kind])) {
        if (item.gone) continue;
        if (kind === "saved" && !d.folders[item.folder]) continue; // its folder has not come
        const { at, ...rest } = item;
        stripped[kind][id] = this.here[kind][id]?.title !== undefined && item.title !== undefined && syncSigSame(this.here[kind][id], rest) ? { ...rest, title: this.here[kind][id].title } : rest;
      }
    }
    stripped.order = Object.fromEntries(Object.entries(d.order).map(([scope, { list }]) => [scope, list]));
    this.here = stripped;
  }
  firefoxSync(server) {
    for (const k of new Set([...Object.keys(server), ...Object.keys(this.mirror)])) {
      if (JSON.stringify(server[k]) === JSON.stringify(this.mirror[k])) continue;
      if (server[k] === undefined) delete this.area[k]; else this.area[k] = server[k];
    }
    for (const k of new Set([...Object.keys(server), ...Object.keys(this.area)])) {
      if (this.area[k] === undefined) delete server[k]; else server[k] = this.area[k];
    }
    this.mirror = { ...server };
  }
  // What you do, at random.
  act() {
    const r = this.rand, h = this.here, world = this.world;
    const pick = map => { const keys = Object.keys(map); return keys.length ? keys[Math.floor(r() * keys.length)] : null; };
    const space = pick(h.spaces) ?? "s1";
    const n = world.next++;
    const what = Math.floor(r() * 13);
    if (what === 0) { const k = `e${n}`; h.essentials[k] = { url: `https://e${n}/`, title: "E", space }; world.added.add(`essentials/${k}`); }
    else if (what === 1) { const k = pick(h.essentials); if (k) h.essentials[k] = { ...h.essentials[k], name: `name${n}` }; }
    else if (what === 2) { const k = pick(h.essentials); if (k) { delete h.essentials[k]; world.deleted.add(`essentials/${k}`); } }
    else if (what === 3) { const k = `f${n}`; h.folders[k] = { name: `Folder ${n}`, space }; world.added.add(`folders/${k}`); }
    else if (what === 4) { const k = pick(h.folders); if (k) { h.folders[k] = { ...h.folders[k], name: `Renamed ${n}` }; } }
    else if (what === 5) { const k = pick(h.folders); if (k) { delete h.folders[k]; world.deleted.add(`folders/${k}`); for (const [s, v] of Object.entries(h.saved)) if (v.folder === k) { delete h.saved[s]; world.deleted.add(`saved/${s}`); } } }
    else if (what === 6) { const f = pick(h.folders); if (f) { const k = `t${n}`; h.saved[k] = { url: `https://t${n}/`, title: "T", folder: f, space: h.folders[f].space }; world.added.add(`saved/${k}`); } }
    else if (what === 7) { const k = pick(h.saved); if (k) { delete h.saved[k]; world.deleted.add(`saved/${k}`); } }
    else if (what === 8) { const k = pick(h.saved), f = pick(h.folders); if (k && f) h.saved[k] = { ...h.saved[k], folder: f, space: h.folders[f].space }; }
    else if (what === 9) { const k = pick(h.spaces); if (k) h.spaces[k] = { ...h.spaces[k], name: `Space ${n}` }; }
    else if (what === 10) { const k = `r:rule${n}`; h.rules[k] = { space }; world.added.add(`rules/${k}`); }
    else if (what === 11) { const k = `same${n}`, url = `https://same${n % 4}/`; if (!Object.values(h.essentials).some(x => x.url === url)) h.essentials[k] = { url, title: "S", space: "s1" }; }
    else {
      const keys = Object.keys(h.essentials).filter(k => h.essentials[k].space === space).map(syncShort);
      h.order["e:" + space] = keys.sort(() => r() - 0.5);
    }
    world.now += Math.floor(r() * 5000);
  }
}
const syncSigSame = (a, b) => ["url", "name", "folder", "space"].every(f => (a?.[f] ?? null) === (b?.[f] ?? null));
const living = d => {
  const out = {};
  for (const kind of ["spaces", "essentials", "folders", "saved", "rules"]) out[kind] = Object.keys(d[kind]).filter(id => !d[kind][id].gone).sort();
  return out;
};

test("three machines editing at random end up the same, and lose nothing nobody deleted", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = seeded(seed * 7919);
    const world = { now: NOW, next: 1, added: new Set(), deleted: new Set() };
    const server = {};
    const machines = [new Machine("a", 0, rand, world), new Machine("b", -3600e3, rand, world), new Machine("c", 1800e3, rand, world)];
    // Each starts with the one space they all have, by the sid its name gives.
    for (const m of machines) {
      m.here.spaces.s1 = { name: "Work", color: "blue", icon: "circle" };
      // And things of their own from before they met, some the same.
      for (let i = 0; i < 4; i++) { m.act(); m.act(); }
    }
    for (let step = 0; step < 150; step++) {
      const m = machines[Math.floor(rand() * 3)];
      const r = rand();
      if (r < 0.6) m.act();
      else if (r < 0.85) m.round();
      else m.firefoxSync(server);
    }
    // Things settle: everyone runs and hears from the others.
    for (let i = 0; i < 6; i++) for (const m of machines) { m.round(); m.firefoxSync(server); }
    const [a, b, c] = machines;
    assert.deepEqual(a.doc, b.doc, `seed ${seed}`);
    assert.deepEqual(b.doc, c.doc, `seed ${seed}`);
    assert.deepEqual(a.area, c.area, `seed ${seed}`);
    assert.deepEqual(living(a.here), living(c.here), `seed ${seed}`);
    // With nothing happening, nothing more is written.
    const before = machines.map(m => m.writes);
    for (const m of machines) { m.round(); m.firefoxSync(server); }
    assert.deepEqual(machines.map(m => m.writes), before, `seed ${seed}: a round wrote with nothing happening`);
    // Nothing nobody deleted is missing (a folder comes back for a newer tab, so only the other way round is checked).
    for (const key of world.added) {
      if (world.deleted.has(key)) continue;
      const [kind, id] = key.split("/");
      const item = a.doc[kind][id];
      // A saved tab or folder can only go with a folder someone deleted.
      if (kind === "saved" && a.doc.saved[id]?.gone) continue;
      assert.ok(item && !item.gone, `seed ${seed}: ${key} was lost`);
    }
  }
});

test("each machine's first round is a merge: two machines with their own things get both", () => {
  const world = { now: NOW, next: 1, added: new Set(), deleted: new Set() };
  const rand = seeded(3), server = {};
  const a = new Machine("a", 0, rand, world), b = new Machine("b", 0, rand, world);
  a.here.essentials.fromA = { url: "https://a/", title: "A", space: "s1" };
  a.here.essentials.same1 = { url: "https://same/", title: "Same", space: "s1" };
  b.here.essentials.fromB = { url: "https://b/", title: "B", space: "s1" };
  b.here.essentials.same2 = { url: "https://same/", title: "Same", space: "s1" };
  // B's first write loses to A's on the server (the same item), and is written again.
  for (let i = 0; i < 4; i++) for (const m of [a, b]) { m.round(); m.firefoxSync(server); }
  assert.deepEqual(living(a.doc).essentials, ["fromA", "fromB", "same1"]);
  assert.deepEqual(living(b.doc).essentials, ["fromA", "fromB", "same1"]);
});
