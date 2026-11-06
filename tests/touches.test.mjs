// The small touches: what a tooltip says, which icon a tab shows, and how the sidebar's
// touches.js treats a load and a pointer. On the real background scripts (fake_firefox.mjs),
// and touches.js with just enough of a page around it to control time and the pointer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const C1 = "firefox-container-1";

// Tidier started on one window with the given tabs: [props, values] each.
async function started(tabs, { alone = true, store = {} } = {}) {
  const ff = new FakeFirefox();
  if (alone) ff.managed = { tidierAlone: true };
  Object.assign(ff.store, store);
  const w = ff.addWindow({ focused: true });
  const made = tabs.map(([props, values]) => ff.addTab(w.id, { cookieStoreId: C1, ...props }, values));
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return { ff, x, w, made };
}
// Out of the scripts' own realm, where arrays are not this one's arrays.
const viewOf = async (x, w) => JSON.parse(JSON.stringify(await x.ctx.viewFor(w.id)));
const flat = view => [...view.essentials, ...view.folders.flatMap(f => f.tabs), ...view.tabs];

// A sidebar connected to the background.
function sidebar(x, windowId) {
  const on = { message: [], disconnect: [] }, sent = [];
  const port = { name: "sidebar", sender: { id: "tidier" }, postMessage: v => sent.push(v),
    onMessage: { addListener: f => on.message.push(f) }, onDisconnect: { addListener: f => on.disconnect.push(f) } };
  for (const { f } of x.b.runtime.onConnect.ls) f(port);
  const send = msg => Promise.all(on.message.map(f => f(msg)));
  return { sent, send, ready: send({ type: "hello", windowId }) };
}

// --- What a tooltip says -----------------------------------------------------------------
test("a tooltip is the title, then the address without its query part", async () => {
  const { x } = await started([[{ url: "https://site.example/", active: true }]]);
  const tip = (t, entry) => x.ctx.tabTip({ title: "", ...t }, entry);
  assert.equal(tip({ url: "https://a.example/board?token=secret&x=1", title: "Board" }), "Board\nhttps://a.example/board");
  assert.equal(tip({ url: "https://a.example/mail#inbox", title: "Mail" }), "Mail\nhttps://a.example/mail#inbox", "only the query part goes");
  assert.equal(tip({ url: "https://a.example/a?b#c", title: "A" }), "A\nhttps://a.example/a#c");
  assert.equal(tip({ url: "https://a.example/#/route?b", title: "A" }), "A\nhttps://a.example/#/route");
  x.kill();
});

test("a placeholder's tooltip reads the record: its own address is ghost.html", async () => {
  const { x } = await started([[{ url: "https://site.example/", active: true }]]);
  const ghost = { url: GHOST("ghost", "k"), title: GHOST("ghost", "k") };
  assert.equal(x.ctx.tabTip(ghost, { url: "https://a.example/board?x=1", title: "Board" }), "Board\nhttps://a.example/board");
  assert.equal(x.ctx.tabTip(ghost, undefined), "", "with nothing known it says nothing, and the sidebar shows the title");
  x.kill();
});

test("a loaded page's own address counts, an essential's name comes first, and an address is said once", async () => {
  const { x } = await started([[{ url: "https://site.example/", active: true }]]);
  assert.equal(x.ctx.tabTip({ url: "https://a.example/new", title: "New" }, { url: "https://a.example/old", title: "New" }), "New\nhttps://a.example/new");
  assert.equal(x.ctx.tabTip({ url: GHOST("essential", "k"), title: "Long page title" }, { url: "https://a.example/", title: "Long page title", name: "Mail" }), "Mail\nhttps://a.example/");
  assert.equal(x.ctx.tabTip({ url: "https://a.example/x?y", title: "https://a.example/x?y" }), "https://a.example/x", "a tab with no title of its own");
  x.kill();
});

test("a huge address is cut, since every view would carry it", async () => {
  const { x } = await started([[{ url: "https://site.example/", active: true }]]);
  const tip = x.ctx.tabTip({ url: "data:text/html," + "x".repeat(1000000), title: "Big" });
  assert.ok(tip.length < 400 && tip.startsWith("Big\ndata:text/html,xx") && tip.endsWith("…"), tip.slice(0, 40));
  x.kill();
});

test("rows and tiles carry the tooltip; with the setting off they do not", async () => {
  const store = { syncedTabs: { a: { url: "https://a.example/p?x", title: "Row", cookieStoreId: C1, parentKey: null, group: false, added: 1 } } };
  const tabs = [[{ url: GHOST("ghost", "a"), title: "Row", discarded: true }, { syncKey: "a", syncRole: "ghost" }], [{ url: "https://site.example/", active: true }]];
  let { x, w } = await started(tabs, { store });
  const row = flat(await viewOf(x, w)).find(i => i.title === "Row");
  assert.equal(row.tip, "Row\nhttps://a.example/p");
  x.kill();
  ({ x, w } = await started(tabs, { store, alone: false }));
  for (const item of flat(await viewOf(x, w))) assert.equal(item.tip, undefined);
  x.kill();
});

// --- Which icon --------------------------------------------------------------------------
test("a tab's own icon first, then the record's, then none for the letter; also on an essential", async () => {
  const icon = u => "https://" + u + ".example/favicon.ico";
  const list = [{ key: "e", url: "https://e.example/", cookieStoreId: C1, title: "Essential", icon: icon("essential") }];
  const record = {
    own: { url: "https://own.example/", title: "Own", icon: icon("record"), cookieStoreId: C1, parentKey: null, group: false, added: 1 },
    kept: { url: "https://kept.example/", title: "Kept", icon: icon("record"), cookieStoreId: C1, parentKey: null, group: false, added: 1 },
    none: { url: "https://none.example/", title: "None", cookieStoreId: C1, parentKey: null, group: false, added: 1 },
  };
  const tabs = [
    [{ url: GHOST("essential", "e"), title: "Essential", pinned: true, discarded: true }, { essentialKey: "e" }],
    [{ url: "https://own.example/", title: "Own", favIconUrl: icon("own"), active: true }, { syncKey: "own", syncRole: "live" }],
    [{ url: "https://kept.example/", title: "Kept" }, { syncKey: "kept", syncRole: "live" }],
    [{ url: "https://none.example/", title: "None" }, { syncKey: "none", syncRole: "live" }],
  ];
  let { x, w } = await started(tabs, { store: { essentials: list, syncedTabs: record } });
  const view = await viewOf(x, w);
  const named = Object.fromEntries(flat(view).map(i => [i.title, i.icon]));
  assert.deepEqual(named, { Essential: icon("essential"), Own: icon("own"), Kept: icon("record"), None: null });
  x.kill();
  ({ x, w } = await started(tabs, { store: { essentials: list, syncedTabs: record }, alone: false }));
  const off = Object.fromEntries(flat(await viewOf(x, w)).map(i => [i.title, i.icon]));
  assert.equal(off.Kept, null, "with the setting off, nothing changes");
  x.kill();
});

// Firefox drops a tab's icon when a new page comes in, and a page may have none at all.
test("a page with no icon keeps the record's on the same site, and has none of another site's", async () => {
  const icon = "https://a.example/favicon.ico";
  const store = () => ({ syncedTabs: { k: { url: "https://a.example/", title: "A", icon, cookieStoreId: C1, parentKey: null, group: false, added: 1 } } });
  const tabs = [[{ url: "https://a.example/", title: "A", favIconUrl: icon, active: true }, { syncKey: "k", syncRole: "live" }]];
  const iconNow = async (x, w) => flat(await viewOf(x, w))[0].icon;
  const go = async (ff, t, url, title) => { delete t.favIconUrl; ff.navigate(t.id, url, title); await wait(1000); };

  let { ff, x, w, made } = await started(tabs, { store: store() });
  await go(ff, made[0], "https://www.a.example/page", "Same site");
  assert.equal(await iconNow(x, w), icon, "the same site, as far as a person can tell");
  // As Firefox does it: the new page's first title comes while the tab still has the old icon.
  Object.assign(made[0], { url: "https://b.example/", title: "b.example/", status: "loading" });
  x.b.tabs.onUpdated.fire(made[0].id, { title: made[0].title }, ff.snap(made[0]));
  await wait(500);
  assert.equal((await x.js("getSynced()")).k.icon, undefined, "not taken for the new page's");
  await go(ff, made[0], "https://b.example/", "Another site");
  assert.equal(await iconNow(x, w), null, "the old site's icon says something untrue");
  assert.equal((await x.js("getSynced()")).k.icon, undefined, "its placeholders read the record");
  made[0].favIconUrl = "https://b.example/favicon.ico";
  x.b.tabs.onUpdated.fire(made[0].id, { favIconUrl: made[0].favIconUrl }, ff.snap(made[0]));
  await wait(1000);
  assert.equal(await iconNow(x, w), made[0].favIconUrl);
  assert.equal((await x.js("getSynced()")).k.icon, made[0].favIconUrl);
  x.kill();

  // With the setting off the record is left as it always was.
  ({ ff, x, w, made } = await started(tabs, { store: store(), alone: false }));
  await go(ff, made[0], "https://b.example/", "Another site");
  assert.equal((await x.js("getSynced()")).k.icon, icon);
  x.kill();
});

test("a placeholder comes to hear of it, also when only the icon has changed", async () => {
  const icon = "https://a.example/favicon.ico";
  const store = { syncedTabs: { k: { url: "https://a.example/", title: "Same title", icon, cookieStoreId: C1, parentKey: null, group: false, added: 1 } } };
  const { ff, x, made } = await started([[{ url: "https://a.example/", title: "Same title", favIconUrl: icon, active: true }, { syncKey: "k", syncRole: "live" }]], { store });
  delete made[0].favIconUrl;
  ff.navigate(made[0].id, "https://b.example/", "Same title");
  await wait(500);
  assert.equal(x.js("refreshTimers.has('k')"), true);
  x.kill();
});

// --- Loading -----------------------------------------------------------------------------
test("a placeholder never counts as loading, nor does a discarded tab", async () => {
  const { x } = await started([[{ url: "https://site.example/", active: true }]]);
  const is = x.js("tabIsLoading");
  assert.equal(is({ status: "loading", url: "https://a.example/" }), true);
  assert.equal(is({ status: "complete", url: "https://a.example/" }), false);
  assert.equal(is({ status: "loading", url: GHOST("ghost", "k") }), false);
  assert.equal(is({ status: "loading", url: "https://a.example/", discarded: true }), false);
  x.kill();
});

test("a load is told apart from the rows, so that it never redraws one", async () => {
  const tabs = [
    [{ url: "https://site.example/", active: true }],
    [{ url: "https://slow.example/", status: "loading", title: "Slow" }],
    [{ url: GHOST("ghost", "k"), status: "loading", title: "Placeholder" }],
  ];
  let { x, w, made } = await started(tabs);
  const before = await viewOf(x, w);
  assert.deepEqual(before.loading, [made[1].id]);
  const state = i => JSON.stringify(i);
  const row = flat(before).find(i => i.id === made[1].id);
  made[1].status = "complete";
  const after = await viewOf(x, w);
  assert.deepEqual(after.loading, []);
  assert.equal(state(flat(after).find(i => i.id === made[1].id)), state(row), "the row's state is the same");
  x.kill();
  ({ x, w } = await started(tabs, { alone: false }));
  assert.deepEqual((await viewOf(x, w)).loading, [], "with the setting off, nothing");
  x.kill();
});

// --- Warming up, in the background --------------------------------------------------------
test("a warm-up reaches Firefox, without the queue or a new view, and a refusal is ignored", async () => {
  const { ff, x, w, made } = await started([[{ url: "https://site.example/", active: true }], [{ url: "https://a.example/" }]]);
  const bar = sidebar(x, w.id);
  await bar.ready;
  await wait(500);
  const jobs = x.js("work.jobs"), views = x.js("work.views");
  await bar.send({ type: "warmup", tabId: made[1].id });
  await bar.send({ type: "warmup", tabId: 99999 }); // gone in the meantime
  await wait(500);
  assert.deepEqual(ff.log.filter(l => l[0] === "warmup"), [["warmup", made[1].id]]);
  assert.equal(x.js("work.jobs"), jobs);
  assert.equal(x.js("work.views"), views);
  assert.equal(x.js("problems.length"), 0);
  x.kill();
});

test("with the setting off, a warm-up does nothing", async () => {
  const { ff, x, w, made } = await started([[{ url: "https://site.example/", active: true }], [{ url: "https://a.example/" }]], { alone: false });
  const bar = sidebar(x, w.id);
  await bar.ready;
  await bar.send({ type: "warmup", tabId: made[1].id });
  assert.equal(ff.log.filter(l => l[0] === "warmup").length, 0);
  x.kill();
});

// --- touches.js ---------------------------------------------------------------------------
// A pretend page: timers run when told, and each icon says what was done to it.
function page({ alone = true, reduced = false } = {}) {
  const classes = () => { const s = new Set(); return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) }; };
  const newIcon = () => ({ classList: classes(), animation: { startTime: null }, faded: [], opacity: "0.6",
    getAnimations() { return this.classList.contains("slow-load") ? [this.animation] : []; }, animate(k, ms) { this.faded.push([k.opacity, ms]); } });
  const kept = new Map();
  const add = (id, kind = "tab") => {
    const icon = newIcon();
    kept.set(kind + ":" + id, { querySelector: () => kept.get(kind + ":" + id).icon, icon });
    return icon;
  };
  let now = 0, listen = null, id = 0;
  const timers = new Map(), on = {}, sent = [];
  const ctx = vm.createContext({
    kept, send: m => sent.push(m), view: { alone },
    port: { onMessage: { addListener: f => { listen = f; } } },
    document: { timeline: { get currentTime() { return now; } } },
    setTimeout: (f, ms) => { timers.set(++id, { f, at: now + ms }); return id; },
    clearTimeout: h => timers.delete(h),
    getComputedStyle: icon => ({ opacity: icon.opacity }),
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (type, f) => { on[type] = f; },
  });
  vm.runInContext(readFileSync(new URL("../sidebar/touches.js", import.meta.url), "utf8"), ctx);
  return {
    add, sent, on, timers,
    view: loading => listen({ loading }),
    pass: ms => { now += ms; for (const [h, t] of [...timers]) if (t.at <= now) { timers.delete(h); t.f(); } },
    now: () => now,
    tab: (tabId, cls = "") => {
      const el = { dataset: { tab: String(tabId) }, matches: s => s.split(", ").some(c => cls.split(" ").includes(c.slice(1))) };
      el.closest = () => el;
      return el;
    },
  };
}

test("a fast load shows nothing, and its timer is gone with it", () => {
  const p = page(), icon = p.add(1);
  p.view([1]);
  p.pass(499);
  p.view([]);
  p.pass(1000);
  assert.equal(icon.classList.contains("slow-load"), false);
  assert.equal(p.timers.size, 0, "no timer left");
});

test("a slow load shows after half a second, goes softly, and leaves no timer", () => {
  const p = page(), icon = p.add(1);
  p.view([1]);
  p.pass(499);
  assert.equal(icon.classList.contains("slow-load"), false);
  p.pass(1);
  assert.equal(icon.classList.contains("slow-load"), true);
  p.view([1]); // any other view while it goes on changes nothing
  assert.equal(p.timers.size, 0);
  p.view([]);
  assert.equal(icon.classList.contains("slow-load"), false);
  assert.equal(JSON.stringify(icon.faded), '[[["0.6",1],300]]');
  assert.equal(p.timers.size, 0);
});

test("an icon drawn anew during a load goes on from where the old one was", () => {
  const p = page(), first = p.add(1);
  p.pass(1000);
  p.view([1]);
  p.pass(500);
  assert.equal(first.animation.startTime, 1500);
  p.pass(700);
  const second = p.add(1); // a title arrived: the row was drawn again
  p.view([1]);
  assert.equal(second.classList.contains("slow-load"), true, "without another half second");
  assert.equal(second.animation.startTime, 1500);
});

test("a tab out of sight gets its sign when it comes back, and one that finished meanwhile none", () => {
  const p = page();
  p.view([1, 2]); // both in another space: nothing drawn
  p.pass(500);
  const one = p.add(1), two = p.add(2);
  p.view([1]);
  assert.equal(one.classList.contains("slow-load"), true);
  assert.equal(two.classList.contains("slow-load"), false);
});

test("a second load waits its own half second, and nothing is kept of the first", () => {
  const p = page(), icon = p.add(1);
  p.view([1]);
  p.pass(500);
  p.pass(1000);
  p.view([]);
  p.view([1]);
  assert.equal(icon.classList.contains("slow-load"), false, "a fast second load shows nothing either");
  p.pass(500);
  assert.equal(icon.classList.contains("slow-load"), true);
  assert.equal(icon.animation.startTime, 2000, "from its own start, not settled at once");
});

test("an icon drawn anew just as the load ends brightens too, instead of jumping", () => {
  const p = page(), first = p.add(1);
  p.view([1]);
  p.pass(500);
  const second = p.add(1); // the page's last title came with the end of the load
  p.view([]);
  assert.equal(second.classList.contains("slow-load"), false);
  assert.equal(second.faded.length, 1);
  assert.ok(second.faded[0][0][0] < 1 && second.faded[0][0][1] === 1, JSON.stringify(second.faded));
  assert.equal(first.faded.length, 0);
});

test("a tile shows the sign too", () => {
  const p = page(), icon = p.add(5, "tile");
  p.view([5]);
  p.pass(500);
  assert.equal(icon.classList.contains("slow-load"), true);
});

// Also what a page asks for by itself: with the setting off this sidebar is as it was.
test("what stands still for less motion does so only with Tidier alone", () => {
  const css = readFileSync(new URL("../sidebar/sidebar.css", import.meta.url), "utf8");
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([^}]*\})/)[1];
  const selector = block.slice(0, block.indexOf("{")).trim();
  for (const one of selector.split(",")) assert.match(one.trim(), /^\.alone\b/, one);
});

test("with less motion asked for, the sign goes without a fade", () => {
  const p = page({ reduced: true }), icon = p.add(1);
  p.view([1]);
  p.pass(500);
  const drawnAnew = p.add(2);
  p.view([2]);
  p.pass(500);
  p.add(2);
  p.view([]);
  assert.equal(icon.classList.contains("slow-load"), false);
  assert.equal(icon.faded.length, 0);
  assert.equal(drawnAnew.faded.length, 0);
});

test("a warm-up once for each time the pointer comes to a tab, only a loaded one that is not showing", () => {
  const p = page(), over = target => p.on.mouseover({ target }), warm = () => p.sent.map(m => m.tabId);
  const loaded = p.tab(1), other = p.tab(2), placeholder = p.tab(3, "row tab unloaded"), showing = p.tab(4, "row tab active");
  const gap = { closest: () => null };
  over(loaded);
  over(loaded); // another part of the same row
  assert.deepEqual(warm(), [1]);
  over(placeholder);
  over(showing);
  assert.deepEqual(warm(), [1]);
  over(other);
  over(loaded);
  assert.deepEqual(warm(), [1, 2, 1]);
  over(gap);
  over(loaded);
  assert.deepEqual(warm(), [1, 2, 1, 1]);
  p.on.mouseout({ relatedTarget: null }); // left the sidebar
  over(loaded);
  assert.deepEqual(warm(), [1, 2, 1, 1, 1]);
  p.on.mouseout({ relatedTarget: {} });   // only moved within it
  over(loaded);
  assert.equal(warm().length, 5);
  assert.ok(p.sent.every(m => m.type === "warmup"));
});

test("with the setting off, the pointer warms nothing", () => {
  const p = page({ alone: false });
  p.on.mouseover({ target: p.tab(1) });
  assert.deepEqual(p.sent, []);
});
