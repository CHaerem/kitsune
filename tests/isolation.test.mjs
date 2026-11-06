// Isolation (isolation.js): nothing goes out in the wrong container. The real background
// scripts on a fake Firefox, for what must hold whatever Firefox does. Whether Firefox
// really keeps logins apart is what the smoke test's alone_isolation shows, with a server
// that records every request and its cookies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const NONE = "firefox-default", A = "firefox-container-1", B = "firefox-container-2", C = "firefox-container-3";
const GUARD = ["webRequest", "webRequestBlocking", "<all_urls>"];

async function run(ff, { alone = true } = {}) {
  if (alone) ff.managed = { tidierAlone: true };
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  await wait(1000);
  return x;
}

// A window in space A with one tab in it, and a tab of the given kind.
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

// --- The decision --------------------------------------------------------------------
function decide(x) {
  const f = x.js("whereItBelongs");
  return ({ here = A, url = "https://work.example/x", tabUrl = "https://old.example/", ...rest }) =>
    f({ url, tab: { cookieStoreId: here, url: tabUrl, incognito: !!rest.incognito }, rules: [{ url: "work.example", space: B }], activeSpace: C, ...rest });
}
const flags = [true, false];

test("whereItBelongs: a page outside any container goes to the active space, always", async () => {
  const x = (new FakeFirefox()).boot(); const at = decide(x);
  for (const originUrl of [undefined, "https://page.example/"]) for (const redirect of flags) for (const exempt of flags) for (const popup of flags) {
    assert.equal(at({ here: NONE, url: "https://plain.example/", originUrl, redirect, exempt, popup, firstPage: false }), C);
    assert.equal(at({ here: NONE, url: "https://plain.example/", originUrl, redirect, exempt, popup, firstPage: true }), C);
  }
  assert.equal(at({ here: NONE, url: "https://plain.example/", firstPage: true, activeSpace: undefined }), null, "with no space to go to it stays");
  x.kill();
});

test("whereItBelongs: a rule counts on a first page and when you choose an address, in or out of a container", async () => {
  const x = (new FakeFirefox()).boot(); const at = decide(x);
  assert.equal(at({ firstPage: true }), B, "first page, even from a link");
  assert.equal(at({ firstPage: true, originUrl: "https://page.example/" }), B);
  assert.equal(at({ firstPage: false }), B, "typed, a bookmark, another app: no origin");
  assert.equal(at({ here: NONE, firstPage: true }), B, "a rule wins over the active space");
  assert.equal(at({ here: NONE, firstPage: false }), B);
  x.kill();
});

test("whereItBelongs: what does not count: a link in a page, a redirect, a reload, a hand move, a popup", async () => {
  const x = (new FakeFirefox()).boot(); const at = decide(x);
  assert.equal(at({ firstPage: false, originUrl: "https://page.example/" }), null, "a link followed inside a page");
  assert.equal(at({ firstPage: false, originUrl: "moz-extension://other/page.html" }), null, "an extension sending the tab there");
  assert.equal(at({ firstPage: false, redirect: true }), null, "a sign-in passing through");
  assert.equal(at({ firstPage: true, redirect: true }), null, "a redirect on a first page too");
  assert.equal(at({ firstPage: false, tabUrl: "https://work.example/x" }), null, "a reload, or Firefox restoring the tab");
  assert.equal(at({ firstPage: true, exempt: true }), null, "moved or opened by hand");
  assert.equal(at({ firstPage: true, popup: true }), null, "a sign-in window");
  assert.equal(at({ firstPage: true, url: "https://other.example/" }), null, "no rule matches");
  x.kill();
});

test("whereItBelongs: never a page that cannot have a container, and private windows are left alone", async () => {
  const x = (new FakeFirefox()).boot(); const at = decide(x);
  for (const url of ["about:blank", "about:newtab", "moz-extension://x/y.html", "file:///a", "data:text/plain,x", "view-source:https://a.example/"]) {
    assert.equal(at({ here: NONE, url, firstPage: true }), null, url);
  }
  assert.equal(at({ here: "firefox-private", firstPage: true, incognito: true }), null);
  assert.equal(at({ here: "firefox-private", url: "https://plain.example/", firstPage: true, incognito: true }), null);
  x.kill();
});

test("whereItBelongs: never a loop: where it sends a page, that page stays, whatever else is true", async () => {
  const x = (new FakeFirefox()).boot();
  const f = x.js("whereItBelongs");
  // (A rule cannot send a page out of the spaces, and one that doesn't parse matches nothing.)
  const rules = [{ url: "work.example", space: B }, { url: "/work/", space: C }, { url: "bad", space: NONE }, { url: "/(/", space: B }];
  for (const url of ["https://work.example/x", "https://plain.example/", "https://bad.example/"]) for (const here of [NONE, A, B, C]) for (const originUrl of [undefined, "https://p.example/"]) {
    for (const firstPage of flags) for (const redirect of flags) for (const exempt of flags) for (const popup of flags) {
      const to = f({ url, tab: { cookieStoreId: here, url: "about:blank" }, originUrl, firstPage, redirect, exempt, popup, rules, activeSpace: A });
      assert.notEqual(to, here, "it is never sent where it already is");
      assert.notEqual(to, NONE, "nothing is ever sent out of the spaces");
      if (!to) continue;
      for (const f2 of flags) for (const o2 of [undefined, "moz-extension://t/"]) assert.equal(f({ url, tab: { cookieStoreId: to, url: "about:blank" }, originUrl: o2, firstPage: f2, rules, activeSpace: A }), null, `${url}: from ${here} to ${to} and on`);
    }
  }
  x.kill();
});

// --- The request ---------------------------------------------------------------------
test("a request outside any container is stopped and opened in the active space, in its place and selection", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  const { w, home } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { active: true });
  home.active = false;
  const answer = await ff.request({ tabId: t.id, url: "https://link.example/" });
  assert.deepEqual({ ...answer }, { cancel: true });
  await wait(300);
  const [n] = opened(ff, w.id, "https://link.example/");
  assert.equal(n.cookieStoreId, A);
  assert.equal(n.active, true, "selected if the old tab was");
  assert.ok(!ff.tabs.has(t.id), "the old tab is closed");
  // And then it simply goes: never a loop.
  assert.deepEqual({ ...await ff.request({ tabId: n.id, url: "https://link.example/" }) }, {});
  x.kill();
});

test("opening fails: a page with no container stays unloaded and the tab is kept, and one in a space loads where it is", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.rules = [{ url: "work.example", space: "firefox-container-9" }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const create = x.b.tabs.create;
  x.b.tabs.create = async () => { throw new Error("no"); };
  const t = newTab(ff, x, w);
  assert.equal((await ff.request({ tabId: t.id, url: "https://link.example/" })).cancel, true);
  assert.ok(ff.tabs.has(t.id), "kept");
  x.b.tabs.create = create;
  const inSpace = newTab(ff, x, w, { cookieStoreId: B });
  const answer = await ff.request({ tabId: inSpace.id, url: "https://work.example/" });
  assert.equal(answer.cancel, undefined, "the rule's container is gone, so it loads here");
  assert.ok(ff.tabs.has(inSpace.id));
  x.kill();
});

test("a rule: the first request goes to its space, and a redirect of a request under way does not count", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  assert.equal((await ff.request({ tabId: t.id, url: "https://short.example/", requestId: "q" })).cancel, undefined);
  assert.equal((await ff.request({ tabId: t.id, url: "https://work.example/landing", requestId: "q" })).cancel, undefined, "the same request: a redirect");
  assert.equal(ff.tabs.has(t.id), true);
  // The old path must not undo that once the address shows.
  ff.navigate(t.id, "https://work.example/landing");
  await wait(300);
  assert.equal(ff.tabs.get(t.id).cookieStoreId, A);
  assert.equal(opened(ff, w.id, "https://work.example/landing").length, 1);

  const fresh = newTab(ff, x, w, { cookieStoreId: A });
  assert.equal((await ff.request({ tabId: fresh.id, url: "https://work.example/two", originUrl: "https://page.example/" })).cancel, true, "a first page, also from a link");
  await wait(300);
  assert.equal(opened(ff, w.id, "https://work.example/two")[0].cookieStoreId, B);
  // In its place: right after where the old one was.
  x.kill();
});

test("a form sent to a new tab stays where it is: it cannot be sent again from another", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  assert.equal((await ff.request({ tabId: t.id, url: "https://work.example/form", method: "POST" })).cancel, undefined);
  assert.equal(ff.tabs.has(t.id), true);
  x.kill();
});

test("a tab opened by hand is exempt from the rules for the address it was opened with, even if its request comes first", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  // The request reaches the listener before tabs.create has answered.
  const create = x.b.tabs.create;
  let answer;
  x.b.tabs.create = async p => {
    const t = ff.addTab(p.windowId, { url: "about:blank", cookieStoreId: p.cookieStoreId });
    x.b.tabs.onCreated.fire(ff.snap(t));
    answer = await ff.request({ tabId: t.id, url: p.url });
    return ff.snap(t);
  };
  const made = await x.ctx.openUnruled({ windowId: w.id, cookieStoreId: C, url: "https://work.example/moved#part" });
  assert.equal(answer.cancel, undefined);
  x.b.tabs.create = create;
  assert.equal(ff.tabs.get(made.id).cookieStoreId, C);
  // Only once: a new tab there with that address follows the rule again.
  const next = newTab(ff, x, w, { cookieStoreId: C });
  assert.equal((await ff.request({ tabId: next.id, url: "https://work.example/moved" })).cancel, true);
  x.kill();
});

test("a known tab outside any container comes back in the space, and is still the same tab in every window", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.syncedTabs = { k: { url: "https://old.example/", title: "Old", cookieStoreId: NONE, parentKey: null, group: false, added: 1 } };
  const { w } = aWindow(ff);
  const other = ff.addWindow();
  const t = ff.addTab(w.id, { url: "https://old.example/", discarded: true }, { syncKey: "k", syncRole: "live" });
  const ghost = ff.addTab(other.id, { url: GHOST("ghost", "k") }, { syncKey: "k", syncRole: "ghost" });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: t.id, url: "https://old.example/" })).cancel, true, "Firefox restoring it");
  await wait(500);
  assert.ok(!ff.tabs.has(t.id));
  assert.ok(!ff.tabs.has(ghost.id));
  assert.equal(ff.synced.k.cookieStoreId, A);
  assert.equal(opened(ff, w.id, "https://old.example/")[0].cookieStoreId, A);
  x.kill();
});

test("an essential outside any container becomes an essential of the space you are in, in every window", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.essentials = [{ key: "e", url: "https://mail.example/", cookieStoreId: NONE, title: "Mail", icon: "x" }];
  const { w } = aWindow(ff);
  const other = ff.addWindow();
  const copy = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true }, { essentialKey: "e" });
  ff.addTab(other.id, { url: GHOST("essential", "e"), pinned: true }, { essentialKey: "e" });
  const x = await run(ff);
  assert.equal((await ff.request({ tabId: copy.id, url: "https://mail.example/" })).cancel, true);
  await wait(800);
  assert.equal(ff.store.essentials[0].cookieStoreId, A);
  for (const id of [w.id, other.id]) {
    const pinned = ff.list(id).filter(t => t.pinned);
    assert.deepEqual(pinned.map(t => t.cookieStoreId), [A], "one copy in each window, in the space");
  }
  x.kill();
});

test("in a container and no rule: nothing is even looked up", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w, home } = aWindow(ff);
  const x = await run(ff);
  let lookups = 0;
  const get = x.b.tabs.get;
  x.b.tabs.get = async id => { lookups++; return get(id); };
  assert.equal((await ff.request({ tabId: home.id, url: "https://plain.example/" })).cancel, undefined);
  assert.equal((await ff.request({ tabId: -1, url: "https://work.example/" })).cancel, undefined, "not a tab");
  assert.equal(lookups, 0);
  x.kill();
});

test("a private window is left alone", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { incognito: true, cookieStoreId: "firefox-private" });
  assert.equal((await ff.request({ tabId: t.id, url: "https://secret.example/" })).cancel, undefined);
  assert.ok(ff.tabs.has(t.id));
  x.kill();
});

test("a popup outside any container goes to a normal window, and a rule leaves a popup in a space alone", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const popup = ff.addWindow({ type: "popup" });
  const x = await run(ff);
  const inside = ff.addTab(popup.id, { url: "about:blank", cookieStoreId: A });
  assert.equal((await ff.request({ tabId: inside.id, url: "https://work.example/sign-in" })).cancel, undefined);
  const none = ff.addTab(popup.id, { url: "about:blank" });
  assert.equal((await ff.request({ tabId: none.id, url: "https://plain.example/" })).cancel, true);
  await wait(300);
  assert.equal(opened(ff, w.id, "https://plain.example/")[0].cookieStoreId, A);
  x.kill();
});

test("without the permission no listener is added and the old path runs; given later, the new one takes over", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  assert.equal(x.b.webRequest, undefined);
  assert.equal(x.js("requestsGuarded()"), false);
  // A first page that matches a rule: reopened after it has loaded, as always.
  const t = newTab(ff, x, w, { cookieStoreId: A });
  ff.navigate(t.id, "https://work.example/a");
  await wait(500);
  assert.equal(opened(ff, w.id, "https://work.example/a")[0].cookieStoreId, B);
  assert.ok(!ff.tabs.has(t.id));

  ff.grant(...GUARD);
  await wait(300);
  assert.equal(x.js("requestsGuarded()"), true);
  assert.equal(x.b.webRequest.onBeforeRequest.ls.length, 1);
  assert.deepEqual([...x.b.webRequest.onBeforeRequest.ls[0].filter.types], ["main_frame"], "no work for sub-resources and frames");
  x.kill();
});

test("with the setting off no listener is added, even with the permission", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  ff.store.spaceNetwork = { [A]: { proxy: { type: "http", host: "p.example", port: 3128 }, userAgent: "X" } };
  aWindow(ff);
  const x = await run(ff, { alone: false });
  assert.equal(x.js("tidierAlone"), false);
  assert.equal(x.b.webRequest.onBeforeRequest.ls.length, 0);
  assert.equal(x.b.webRequest.onBeforeSendHeaders.ls.length, 0);
  assert.equal(x.b.proxy.onRequest.ls.length, 0);
  x.kill();
});

test("the listener is back while the background page loads, for what Firefox holds at a start", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  aWindow(ff);
  const x = await run(ff);
  x.kill();
  assert.ok(ff.pageStorageData.isolationAtStart, "what was true is kept where it can be read at once");
  const y = ff.boot(); // nothing has been awaited yet: this is the page's first tick
  assert.equal(y.b.webRequest.onBeforeRequest.ls.length, 1);
  await wait(300);
  y.kill();
  // Tidier alone turned off meanwhile: gone as soon as that is read.
  ff.managed = {};
  const z = ff.boot();
  assert.equal(z.b.webRequest.onBeforeRequest.ls.length, 1);
  await wait(300);
  assert.equal(z.b.webRequest.onBeforeRequest.ls.length, 0);
  assert.ok(!ff.pageStorageData.isolationAtStart);
  z.kill();
});

test("a request made before Tidier has read the window's space still goes to the right one", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD); ff.managed = { tidierAlone: true };
  ff.pageStorageData = { isolationAtStart: JSON.stringify({ guard: true, network: {} }) };
  const { w } = aWindow(ff);
  const t = ff.addTab(w.id, { url: "about:blank" });
  const x = ff.boot();
  assert.equal((await ff.request({ tabId: t.id, url: "https://first.example/" })).cancel, true);
  await wait(200);
  assert.equal(opened(ff, w.id, "https://first.example/")[0].cookieStoreId, A);
  x.kill();
});

test("a page already loaded outside any space when Tidier starts is moved, with or without the permission", async () => {
  for (const granted of [GUARD, []]) {
    const ff = new FakeFirefox(); ff.granted = new Set(granted);
    const { w } = aWindow(ff);
    const loaded = ff.addTab(w.id, { url: "https://early.example/" });
    const resting = ff.addTab(w.id, { url: "https://resting.example/", discarded: true });
    const blank = ff.addTab(w.id, { url: "about:newtab" });
    const x = await run(ff);
    await wait(500);
    assert.ok(!ff.tabs.has(loaded.id), "moved");
    assert.equal(opened(ff, w.id, "https://early.example/")[0].cookieStoreId, A);
    assert.ok(ff.tabs.has(resting.id), "an unloaded one is stopped when it loads");
    assert.ok(ff.tabs.has(blank.id), "a new tab page is no web page");
    x.kill();
  }
});

test("moving over: the listener is there as the page loads again, so Firefox remembers it", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  aWindow(ff);
  const x = await run(ff, { alone: false });
  assert.ok(!ff.pageStorageData.isolationAtStart);
  x.b.runtime.reload = () => {};
  await x.js("moveOver")();
  assert.equal(JSON.parse(ff.pageStorageData.isolationAtStart).guard, true);
  x.kill();
  const y = ff.boot();
  assert.equal(y.b.webRequest.onBeforeRequest.ls.length, 1, "on the page's first tick");
  await wait(300);
  assert.equal(y.b.webRequest.onBeforeRequest.ls.length, 1, "and it stays, since the setting is on now");
  y.kill();
});

// --- A space's network ---------------------------------------------------------------
test("a proxy has to be complete, and a user agent is only changed for its space", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  aWindow(ff);
  const x = await run(ff);
  const clean = x.js("cleanProxy");
  assert.equal(clean({ type: "ftp", host: "a", port: 1 }), null);
  assert.equal(clean({ type: "http", host: "", port: 1 }), null);
  assert.equal(clean({ type: "http", host: "http://a", port: 1 }), null);
  assert.equal(clean({ type: "http", host: "a", port: 0 }), null);
  assert.equal(clean({ type: "http", host: "a", port: 70000 }), null);
  assert.equal(clean({}), null);
  assert.equal(clean(null), null, "no proxy, as the settings page says it");
  assert.deepEqual({ ...clean({ type: "socks", host: " a.example ", port: "1080" }) }, { type: "socks", host: "a.example", port: 1080 });

  // Nothing runs unless a space has one set.
  assert.equal(x.b.proxy.onRequest.ls.length, 0);
  assert.equal(x.b.webRequest.onBeforeSendHeaders.ls.length, 0);
  await x.js("setSpaceNetwork")(A, { proxy: { type: "socks", host: "p.example", port: 1080 }, userAgent: "Agent X" });
  assert.equal(x.b.proxy.onRequest.ls.length, 1);
  assert.equal(x.b.webRequest.onBeforeSendHeaders.ls.length, 1);
  const proxy = x.b.proxy.onRequest.ls[0].f;
  assert.deepEqual({ ...proxy({ cookieStoreId: A }) }, { type: "socks", host: "p.example", port: 1080, proxyDNS: true }, "names are looked up by the proxy too");
  assert.equal(proxy({ cookieStoreId: B }), undefined);
  const agent = x.b.webRequest.onBeforeSendHeaders.ls[0].f;
  const headers = () => [{ name: "User-Agent", value: "Firefox" }, { name: "Cookie", value: "x" }];
  assert.equal(agent({ cookieStoreId: A, requestHeaders: headers() }).requestHeaders[0].value, "Agent X");
  assert.equal(agent({ cookieStoreId: B, requestHeaders: headers() }), undefined, "other spaces are untouched");
  // Unset: gone again.
  await x.js("setSpaceNetwork")(A, {});
  assert.equal(x.b.proxy.onRequest.ls.length, 0);
  assert.equal(x.b.webRequest.onBeforeSendHeaders.ls.length, 0);
  x.kill();
});

test("a proxy set is in use from the first tick of the next start, and one without its permission is said", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  aWindow(ff);
  const x = await run(ff);
  await x.js("setSpaceNetwork")(A, { proxy: { type: "http", host: "p.example", port: 3128 } });
  await wait(1000);
  x.kill();
  const y = ff.boot();
  assert.equal(y.b.proxy.onRequest.ls.length, 1, "before anything was read");
  await wait(300);
  y.kill();
  ff.granted.delete("proxy");
  const z = await run(ff);
  assert.match(z.js("[...notices.values()].join()"), /no longer has the permission/);
  z.kill();
  ff.granted = new Set(["proxy"]); // the proxy, but no access to any site: it would see no request
  const v = await run(ff);
  assert.match(v.js("[...notices.values()].join()"), /no longer has the permission/);
  v.kill();
});

test("in a space with a proxy, the sidebar fetches no icon from the site: it would go past the proxy", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  const { w } = aWindow(ff);
  ff.addTab(w.id, { url: "https://a.example/", cookieStoreId: A, favIconUrl: "https://a.example/favicon.ico" });
  ff.addTab(w.id, { url: "https://b.example/", cookieStoreId: A, favIconUrl: "data:image/png;base64,AAAA" });
  ff.addTab(w.id, { url: "https://c.example/", cookieStoreId: B, favIconUrl: "https://c.example/favicon.ico" });
  const x = await run(ff);
  const icons = async space => { x.js("activeSpace").set(w.id, space); return (await x.js("viewFor")(w.id)).tabs.map(t => t.icon).filter(Boolean); };
  assert.deepEqual([...await icons(A)], ["https://a.example/favicon.ico", "data:image/png;base64,AAAA"]);
  await x.js("setSpaceNetwork")(A, { proxy: { type: "http", host: "p.example", port: 3128 } });
  assert.deepEqual([...await icons(A)], ["data:image/png;base64,AAAA"]);
  assert.deepEqual([...await icons(B)], ["https://c.example/favicon.ico"], "other spaces as before");
  x.kill();
});

// --- Signing out -----------------------------------------------------------------------
test("clearing a site's cookies takes its other addresses in this space, and only this space's, and can be undone", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  const { w, home } = aWindow(ff);
  const c = (storeId, domain, name) => ({ storeId, domain, name, value: "v", path: "/", secure: true, httpOnly: true, sameSite: "lax", hostOnly: !domain.startsWith("."), session: false, expirationDate: 2e9, firstPartyDomain: "", partitionKey: null });
  ff.cookies = [c(A, ".home.example", "login"), c(A, "mail.home.example", "m"), c(B, ".home.example", "other-space"), c(A, ".else.example", "else")];
  const x = await run(ff);
  const r = await x.js("clearSiteCookies")(home.id);
  assert.equal(r.cleared, 2);
  assert.deepEqual(ff.cookies.map(k => k.name).sort(), ["else", "other-space"]);
  await r.undo();
  assert.deepEqual(ff.cookies.map(k => k.name).sort(), ["else", "login", "m", "other-space"]);
  x.kill();
});

test("a placeholder's cookies are those of its real address, and the widest domain is the one Firefox set", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.syncedTabs = { k: { url: "https://app.site.example/", title: "App", cookieStoreId: A, parentKey: null, group: false, added: 1 } };
  const { w } = aWindow(ff);
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "k"), cookieStoreId: A }, { syncKey: "k", syncRole: "ghost" });
  ff.cookies = [{ storeId: A, domain: ".site.example", name: "a", value: "1", path: "/", firstPartyDomain: "" }, { storeId: A, domain: "other.example", name: "b", value: "1", path: "/", firstPartyDomain: "" }];
  const x = await run(ff);
  assert.equal((await x.js("clearSiteCookies")(ghost.id)).cleared, 1);
  assert.deepEqual(ff.cookies.map(k => k.name), ["b"]);
  assert.equal(x.js("widestDomain")("a.b.c.example", ["b.c.example", ".c.example", "x.example"]), "c.example");
  assert.equal(x.js("widestDomain")("a.example", []), "a.example");
  x.kill();
});

test("signing out of a space removes that space's data only", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "browsingData"]);
  aWindow(ff);
  ff.cookies = [{ storeId: A, domain: "a.example", name: "a" }, { storeId: B, domain: "a.example", name: "b" }];
  const x = await run(ff);
  await x.js("signOutSpace")(A);
  assert.deepEqual(ff.cookies.map(c => c.name), ["b"]);
  x.kill();
});

// --- New, edited, deleted ---------------------------------------------------------------
test("a new space takes a colour and icon no space has", async () => {
  const ff = new FakeFirefox();
  aWindow(ff);
  const x = await run(ff);
  const next = x.js("nextLook");
  const look = next([{ color: "blue", icon: "circle" }, { color: "red", icon: "cart" }], ["blue", "red", "green"], ["circle", "cart", "tree"]);
  assert.deepEqual({ ...look }, { color: "green", icon: "tree" });
  const all = next([{ color: "blue", icon: "circle" }], ["blue"], ["circle"]);
  assert.deepEqual({ ...all }, { color: "blue", icon: "circle" }, "all taken: one anyway");
  x.kill();
});

test("deleting a space: copy first, then all it holds goes, you are taken out, and nothing comes back", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: B, title: "E", icon: "x" }, { key: "keep", url: "https://k.example/", cookieStoreId: A, title: "K", icon: "x" }];
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Work", cookieStoreId: B, parentKey: null, rank: 1 },
    s: { url: "https://s.example/", title: "S", cookieStoreId: B, parentKey: "F", group: false, added: 1, saved: { url: "https://s.example/", title: "S" } },
    o: { url: "https://o.example/", title: "O", cookieStoreId: A, parentKey: null, group: false, added: 1 },
  };
  ff.store.rules = [{ url: "b.example", space: B }, { url: "a.example", space: A }];
  ff.store.spaceOrder = [B, A];
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://o.example/", cookieStoreId: A }, { syncKey: "o", syncRole: "live" });
  ff.addTab(w.id, { url: GHOST("essential", "keep"), cookieStoreId: A, pinned: true }, { essentialKey: "keep" });
  ff.addTab(w.id, { url: GHOST("essential", "e"), cookieStoreId: B, pinned: true }, { essentialKey: "e" });
  const s = ff.addTab(w.id, { url: "https://s.example/", cookieStoreId: B, active: true }, { syncKey: "s", syncRole: "live" });
  const x = await run(ff);
  const r = await x.js("deleteSpace")(B);
  assert.equal(r.deleted, true);
  await wait(1000);
  assert.ok(!ff.containers.has(B));
  assert.ok(ff.store.copyBeforeDelete?.data, "the copy is kept in Firefox's storage when there is no helper");
  assert.ok(ff.store.copyBeforeDelete.data.essentials.some(e => e.key === "e"), "and has what went");
  assert.deepEqual(ff.store.essentials.map(e => e.key), ["keep"]);
  assert.deepEqual(Object.keys(ff.synced), ["o"]);
  assert.deepEqual(ff.store.rules.map(t => t.space), [A]);
  assert.deepEqual(ff.store.spaceOrder, [A]);
  assert.ok(!ff.tabs.has(s.id));
  assert.ok(ff.list(w.id).every(t => t.cookieStoreId !== B), "no tab of it is left, or came back");
  assert.equal(ff.list(w.id).find(t => t.active).cookieStoreId, A, "you are in a space that exists");
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("the only space cannot be deleted, and a page with unsaved input keeps its space", async () => {
  const ff = new FakeFirefox({ containers: ["firefox-default", A] });
  const { w } = aWindow(ff);
  const x = await run(ff);
  assert.ok((await x.js("deleteSpace")(A)).refused);
  assert.ok(ff.containers.has(A));
  x.kill();

  const gf = new FakeFirefox();
  const { w: w2 } = aWindow(gf);
  const page = gf.addTab(w2.id, { url: "https://form.example/", cookieStoreId: B });
  gf.refuseDiscard = new Set([page.id]);
  const y = await run(gf);
  const r = await y.js("deleteSpace")(B);
  assert.match(r.refused, /unsaved input/);
  assert.ok(gf.containers.has(B));
  assert.ok(gf.tabs.has(page.id));
  y.kill();
});

test("what a space holds is counted for the question", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: B, title: "E", icon: "x" }];
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Work", cookieStoreId: B, parentKey: null, rank: 1 },
    s: { url: "https://s.example/", title: "S", cookieStoreId: B, parentKey: "F", group: false, added: 1 },
    o: { url: "https://o.example/", title: "O", cookieStoreId: A, parentKey: null, group: false, added: 1 },
  };
  aWindow(ff);
  const x = await run(ff);
  assert.deepEqual({ ...await x.js("spaceContents")(B) }, { essentials: 1, folders: 1, tabs: 1 });
  x.kill();
});

// --- A vanished container comes back ----------------------------------------------------
test("a container that vanished comes back with its name and look, and what points at it follows", async () => {
  const ff = new FakeFirefox();
  const GONE = "firefox-container-7";
  ff.store.spaceMemory = { [GONE]: { name: "Clients", color: "red", icon: "tree" } };
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: GONE, title: "E", icon: "x" }];
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Work", cookieStoreId: GONE, parentKey: null, rank: 1 },
    s: { url: "https://s.example/", title: "S", cookieStoreId: GONE, parentKey: "F", group: false, added: 1, saved: { url: "https://s.example/", title: "S" } },
  };
  ff.store.rules = [{ url: "c.example", space: GONE }];
  ff.store.spaceOrder = [GONE, A];
  ff.store.spaceNetwork = { [GONE]: { userAgent: "X" } };
  const { w } = aWindow(ff);
  const x = await run(ff);
  const id = ff.store.essentials[0].cookieStoreId;
  assert.notEqual(id, GONE);
  assert.ok(ff.containers.has(id));
  assert.deepEqual(ff.identities[id], { name: "Clients", color: "red", icon: "tree" });
  assert.equal(ff.synced.F.cookieStoreId, id);
  assert.equal(ff.synced.s.cookieStoreId, id);
  assert.equal(ff.store.rules[0].space, id);
  assert.equal(ff.store.spaceOrder[0], id);
  assert.equal(ff.store.spaceNetwork[id].userAgent, "X");
  assert.equal(ff.store.spaceMemory[id].name, "Clients");
  assert.match(x.js("[...notices.values()].join()"), /Clients had gone from Firefox/);
  // The essential and saved tab are opened in the new container, with no error.
  assert.ok(ff.list(w.id).some(t => t.pinned && t.cookieStoreId === id));
  assert.ok(ff.list(w.id).some(t => t.url === GHOST("ghost", "s") && t.cookieStoreId === id));
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a space coming back never gets another vanished space's number, and an unknown number is cleared", async () => {
  // Firefox numbers containers anew when its file is lost, and cookies stay under their numbers.
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  const [P, Q] = ["firefox-container-5", "firefox-container-6"];
  ff.store.spaceMemory = { [P]: { name: "Pink", color: "pink", icon: "tree" }, [Q]: { name: "Red", color: "red", icon: "cart" } };
  ff.store.essentials = [
    { key: "q", url: "https://q.example/", cookieStoreId: Q, title: "Q", icon: "x" },
    { key: "p", url: "https://p.example/", cookieStoreId: P, title: "P", icon: "x" },
  ];
  ff.cookies = [
    { storeId: "firefox-container-4", domain: "old.example", name: "someone-elses", path: "/", firstPartyDomain: "" },
    { storeId: P, domain: "p.example", name: "pink-login", path: "/", firstPartyDomain: "" },
    { storeId: Q, domain: "q.example", name: "red-login", path: "/", firstPartyDomain: "" },
  ];
  aWindow(ff);
  const x = await run(ff);
  const of = key => ff.store.essentials.find(e => e.key === key).cookieStoreId;
  assert.equal(ff.identities[of("p")].name, "Pink");
  assert.equal(ff.identities[of("q")].name, "Red");
  assert.equal(of("q"), Q, "its own number again, once Pink's has been passed over");
  assert.notEqual(of("p"), Q, "never the other's");
  assert.ok(!ff.cookies.some(c => c.name === "someone-elses"), "what a number held before is not taken for this space's");
  assert.ok(ff.cookies.some(c => c.storeId === Q && c.name === "red-login"), "its own number keeps its login");
  assert.ok(!ff.cookies.some(c => c.storeId === of("p") && c.name === "red-login"));
  x.kill();
});

test("a tab still open in the vanished container is opened again in the new one, as what it was", async () => {
  const ff = new FakeFirefox();
  const GONE = "firefox-container-7";
  ff.store.spaceMemory = { [GONE]: { name: "Clients", color: "red", icon: "tree" } };
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Work", cookieStoreId: GONE, parentKey: null, rank: 1 },
    s: { url: "https://s.example/", title: "S", cookieStoreId: GONE, parentKey: "F", group: false, added: 1, saved: { url: "https://s.example/", title: "S" } },
  };
  const { w } = aWindow(ff);
  const old = ff.addTab(w.id, { url: "https://s.example/", cookieStoreId: GONE }, { syncKey: "s", syncRole: "live" });
  const x = await run(ff);
  const id = ff.synced.F.cookieStoreId;
  assert.ok(!ff.tabs.has(old.id));
  assert.deepEqual(ff.list(w.id).filter(t => t.url === "https://s.example/").map(t => t.cookieStoreId), [id]);
  assert.equal(ff.list(w.id).filter(t => t.url === GHOST("ghost", "s")).length, 0, "not doubled");
  assert.ok(ff.synced.s, "still the same saved tab");
  x.kill();
});

test("one you removed while Tidier ran stays removed, with no container made for it at the next start", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: B, title: "E", icon: "x" }];
  ff.store.syncedTabs = { F: { group: true, own: true, name: "Work", cookieStoreId: B, parentKey: null, rank: 1 } };
  ff.store.rules = [{ url: "b.example", space: B }];
  aWindow(ff);
  const x = await run(ff);
  await wait(300);
  assert.ok(ff.store.spaceMemory?.[B] || x.js("true"));
  await x.b.contextualIdentities.remove(B);
  await wait(1000);
  await x.js("flushWrites")();
  x.kill();
  const before = ff.containers.size;
  const y = await run(ff);
  assert.equal(ff.containers.size, before, "nothing was made");
  assert.ok(!ff.containers.has(B));
  assert.equal(y.js("[...notices.keys()].includes('spaceBack')"), false);
  y.kill();
});

test("an ordinary tab of a remembered space brings it back too, and one nobody remembers doesn't", async () => {
  const ff = new FakeFirefox();
  ff.store.spaceMemory = { "firefox-container-7": { name: "Clients", color: "red", icon: "tree" } };
  ff.store.syncedTabs = {
    known: { url: "https://k.example/", title: "K", cookieStoreId: "firefox-container-7", parentKey: null, group: false, added: 1 },
    stray: { url: "https://s.example/", title: "S", cookieStoreId: "firefox-container-8", parentKey: null, group: false, added: 1 },
  };
  aWindow(ff);
  const x = await run(ff);
  assert.equal(Object.values(ff.identities).filter(l => l.name === "Clients").length, 1);
  assert.equal(Object.keys(ff.identities).length, 1);
  x.kill();
});

test("nothing is made when nothing is gone, when containers are off, for a rule nobody remembers, or with the setting off", async () => {
  for (const [name, set] of Object.entries({
    fine: ff => { ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: A, title: "E", icon: "x" }]; },
    off: ff => { ff.containersOff = true; ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: "firefox-container-7", title: "E", icon: "x" }]; },
    forgottenRule: ff => { ff.store.rules = [{ url: "x", space: "firefox-container-7" }]; },
    settingOff: ff => { ff.settingOff = true; ff.store.essentials = [{ key: "e", url: "https://e.example/", cookieStoreId: "firefox-container-7", title: "E", icon: "x" }]; },
  })) {
    const ff = new FakeFirefox();
    set(ff);
    aWindow(ff);
    const x = await run(ff, { alone: !ff.settingOff });
    assert.ok(![...ff.containers].some(c => Number(c.split("-").pop()) > 7), name);
    assert.equal(ff.containers.has("firefox-container-7"), false, name);
    assert.equal(ff.containers.size, 4, name);
    x.kill();
  }
});

// --- A copy, and a folder moved --------------------------------------------------------
test("a copy opens the real address in the other space, leaves the original, and no rule sends it back", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  ff.store.rules = [{ url: "work.example", space: B }];
  ff.store.syncedTabs = { k: { url: "https://work.example/board", title: "Board", cookieStoreId: B, parentKey: null, group: false, added: 1 } };
  const { w } = aWindow(ff);
  const ghost = ff.addTab(w.id, { url: GHOST("ghost", "k"), cookieStoreId: B }, { syncKey: "k", syncRole: "ghost" });
  const x = await run(ff);
  assert.equal(await x.js("copyToSpace")([ghost.id], C, w.id), 1);
  const [copy] = opened(ff, w.id, "https://work.example/board");
  assert.equal(copy.cookieStoreId, C);
  assert.equal(copy.active, false, "you stay where you are");
  assert.ok(ff.tabs.has(ghost.id));
  assert.equal((await ff.request({ tabId: copy.id, url: "https://work.example/board" })).cancel, undefined);
  assert.equal(await x.js("copyToSpace")([ghost.id], B, w.id), 0, "not to the space it is in");
  x.kill();
});

function aFolder(ff) {
  ff.store.syncedTabs = {
    F: { group: true, own: true, name: "Work", cookieStoreId: A, parentKey: null, rank: 1 },
    G: { group: true, own: true, name: "There", cookieStoreId: B, parentKey: null, rank: 4 },
    s: { url: "https://s.example/", title: "S", cookieStoreId: A, parentKey: "F", group: false, added: 1, saved: { url: "https://s.example/", title: "S" } },
    t: { url: "https://t.example/", title: "T", cookieStoreId: A, parentKey: "F", group: false, added: 1, saved: { url: "https://t.example/", title: "T" } },
    o: { url: "https://o.example/", title: "O", cookieStoreId: A, parentKey: null, group: false, added: 1 },
  };
}

test("a folder moved to another space: its tabs are unloaded placeholders there, nothing loads, and you stay", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  aFolder(ff);
  const w = ff.addWindow({ focused: true }), other = ff.addWindow();
  const o = ff.addTab(w.id, { url: "https://o.example/", cookieStoreId: A }, { syncKey: "o", syncRole: "live" });
  const s = ff.addTab(w.id, { url: "https://s.example/", cookieStoreId: A, active: true }, { syncKey: "s", syncRole: "live" });
  const t = ff.addTab(w.id, { url: GHOST("ghost", "t"), cookieStoreId: A }, { syncKey: "t", syncRole: "live" });
  for (const [k, role] of [["o", "o"], ["s", "s"], ["t", "t"]]) ff.addTab(other.id, { url: GHOST("ghost", k), cookieStoreId: A }, { syncKey: k, syncRole: "ghost" });
  const x = await run(ff);
  ff.log.length = 0;
  const r = await x.js("moveFolderToSpace")("F", B, w.id);
  await wait(500);
  assert.deepEqual({ ...r }, { moved: 2, stayed: 0 });
  assert.equal(ff.synced.F.cookieStoreId, B);
  assert.equal(ff.synced.F.rank, 5, "last of that space's folders");
  assert.equal(ff.synced.s.cookieStoreId, B);
  assert.equal(ff.synced.s.parentKey, "F", "still in the folder");
  assert.ok(ff.synced.s.saved, "still saved");
  assert.equal(ff.synced.o.cookieStoreId, A, "others untouched");
  assert.ok(!ff.tabs.has(s.id));
  assert.ok(!ff.tabs.has(t.id));
  for (const id of [w.id, other.id]) {
    const here = ff.list(id);
    for (const k of ["s", "t"]) assert.deepEqual(here.filter(x2 => x2.url === GHOST("ghost", k)).map(x2 => x2.cookieStoreId), [B], `${k} in window ${id}`);
  }
  assert.ok(!ff.log.some(l => l[0] === "create" && /^https/.test(l[3] || "")), "nothing was loaded");
  assert.equal(ff.tabs.get(o.id).active, true, "you are on a tab that stayed, in the space you were in");
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a tab holding unsaved input stays behind as an ordinary tab, and the rest of the folder goes", async () => {
  const ff = new FakeFirefox();
  aFolder(ff);
  const w = ff.addWindow({ focused: true });
  ff.addTab(w.id, { url: "https://o.example/", cookieStoreId: A, active: true }, { syncKey: "o", syncRole: "live" });
  const s = ff.addTab(w.id, { url: "https://s.example/", cookieStoreId: A }, { syncKey: "s", syncRole: "live" });
  ff.addTab(w.id, { url: "https://t.example/", cookieStoreId: A }, { syncKey: "t", syncRole: "live" });
  ff.refuseDiscard = new Set([s.id]);
  const x = await run(ff);
  const r = await x.js("moveFolderToSpace")("F", B, w.id);
  await wait(300);
  assert.deepEqual({ ...r }, { moved: 1, stayed: 1 });
  assert.ok(ff.tabs.has(s.id));
  assert.equal(ff.synced.s.cookieStoreId, A);
  assert.equal(ff.synced.s.parentKey, null);
  assert.ok(!ff.synced.s.saved, "no longer saved: its folder has gone");
  assert.equal(ff.synced.t.cookieStoreId, B);
  x.kill();
});

// --- Nothing without the setting --------------------------------------------------------
test("the old path still runs without the permission for a link with no container", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w);
  ff.navigate(t.id, "https://link.example/");
  await wait(500);
  assert.equal(opened(ff, w.id, "https://link.example/")[0].cookieStoreId, A);
  x.kill();
});

// --- The command bar's table ------------------------------------------------------------
test("where the command bar is there, its table has clearing cookies and a copy in another space", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  aWindow(ff);
  const x = await run(ff);
  if (x.js("typeof BAR_COMMANDS") !== "undefined") {
    const table = x.js("BAR_COMMANDS");
    const clear = table.find(c => c.name === "clear-site-cookies"), copy = table.find(c => c.name === "copy-to-space");
    assert.ok(clear && copy);
    const tab = { id: 1, cookieStoreId: A };
    assert.equal(clear.when({ picked: [tab], tab }), true);
    assert.equal(clear.when({ picked: [tab, { id: 2, cookieStoreId: A }], tab }), false, "one list: it cannot take many, so it is left out");
    assert.deepEqual([...copy.list({ picked: [tab], spaces: [{ id: A, name: "A" }, { id: B, name: "B" }] })].map(i => i.value), [B]);
  }
  x.kill();
});

// --- The settings page ------------------------------------------------------------------
test("no two scripts of the settings page define the same top-level name", () => {
  // Plain scripts sharing one scope: unlike a background script's function, a const there
  // defined twice stops the second script altogether, and with it the whole page.
  const folder = new URL("../settings/", import.meta.url);
  const scripts = [...readFileSync(new URL("settings.html", folder), "utf8").matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.length > 1);
  const seen = new Map(), twice = [];
  for (const file of scripts) {
    for (const [, name] of readFileSync(new URL(file, folder), "utf8").matchAll(/^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(name)) twice.push(`${name} (${seen.get(name)}, ${file})`);
      else seen.set(name, file);
    }
  }
  assert.deepEqual(twice, []);
});
