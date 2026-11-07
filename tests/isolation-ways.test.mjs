// Ways a request could get across a space's border that don't pass the request guard's
// decision (isolation.js): what Firefox does not show an extension, what it decides before
// an extension has run, and what happens when opening the right tab fails. The real
// background scripts on a fake Firefox. alone_crossing and alone_isolation_start do the
// same on a real one, with a server that records what left the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeFirefox, wait, GHOST } from "./fake_firefox.mjs";

const NONE = "firefox-default", A = "firefox-container-1", B = "firefox-container-2";
const GUARD = ["webRequest", "webRequestBlocking", "<all_urls>"];

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
const HIDDEN = "https://addons.mozilla.org/x";

// --- What Firefox never shows an extension -----------------------------------------------
test("a page Firefox hid from the listener, outside any container, does not stay there: it is moved once it shows", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { active: true });
  ff.navigate(t.id, HIDDEN); // no request came: Firefox hides these from every extension
  await wait(500);
  assert.ok(!ff.tabs.has(t.id), "not left outside a space");
  const [moved] = opened(ff, w.id, HIDDEN);
  assert.equal(moved.cookieStoreId, A);
  assert.equal(moved.active, true);
  // And there it stays: never a loop, though no request is seen for this one either.
  ff.navigate(moved.id, HIDDEN);
  await wait(500);
  assert.equal(opened(ff, w.id, HIDDEN).length, 1);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a first page Firefox hid from the listener still follows a rule, and the empty tab goes", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "addons.mozilla.org", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  ff.navigate(t.id, HIDDEN);
  await wait(500);
  assert.ok(!ff.tabs.has(t.id));
  assert.deepEqual(opened(ff, w.id, HIDDEN).map(n => n.cookieStoreId), [B]);
  x.kill();
});

test("what the listener did see stays where it decided: a rule does not move it afterwards", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = newTab(ff, x, w, { cookieStoreId: A });
  assert.equal((await ff.request({ tabId: t.id, url: "https://short.example/", requestId: "q" })).cancel, undefined);
  assert.equal((await ff.request({ tabId: t.id, url: "https://work.example/landing", requestId: "q" })).cancel, undefined, "a redirect");
  ff.navigate(t.id, "https://work.example/landing");
  await wait(500);
  assert.equal(ff.tabs.get(t.id).cookieStoreId, A);
  assert.equal(opened(ff, w.id, "https://work.example/landing").length, 1);
  x.kill();
});

test("a later page in a tab is left alone even if the listener never saw it: only a first page or no container counts", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "addons.mozilla.org", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = ff.addTab(w.id, { url: "https://page.example/", cookieStoreId: A });
  ff.navigate(t.id, HIDDEN);
  await wait(500);
  assert.ok(ff.tabs.has(t.id));
  assert.equal(opened(ff, w.id, HIDDEN).length, 1);
  x.kill();
});

test("an unloaded tab outside any container showing its address is not a page: it is stopped when it loads", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  const x = await run(ff);
  const t = ff.addTab(w.id, { url: "https://resting.example/", discarded: true });
  x.b.tabs.onUpdated.fire(t.id, { url: t.url }, ff.snap(t));
  // (Firefox says it is neither loading nor unloaded just as it takes on the address.)
  x.b.tabs.onUpdated.fire(t.id, { url: t.url }, { ...ff.snap(t), status: "complete", discarded: false });
  await wait(500);
  assert.ok(ff.tabs.has(t.id));
  assert.equal(opened(ff, w.id, "https://resting.example/").length, 1);
  x.kill();
});

test("with the setting off nothing of this runs", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set(GUARD);
  const { w } = aWindow(ff);
  const x = ff.boot();
  x.b.runtime.onStartup.fire({ reason: "update" });
  await wait(1200);
  for (let i = 0; i < 300 && !x.started(); i++) await wait(1000);
  const t = ff.addTab(w.id, { url: "about:blank" });
  ff.navigate(t.id, HIDDEN);
  await wait(500);
  assert.ok(ff.tabs.has(t.id));
  assert.equal(ff.tabs.get(t.id).cookieStoreId, NONE);
  x.kill();
});

// --- Opening the right tab fails --------------------------------------------------------
test("the rule's space is there but opening fails: the request is not sent from the wrong space, the tab stays, and the line names the address", async () => {
  const ff = new FakeFirefox();
  ff.store.rules = [{ url: "work.example", space: B }];
  const { w } = aWindow(ff);
  const x = await run(ff);
  const said = [];
  x.ctx.say = (id, text) => said.push(text);
  const create = x.b.tabs.create;
  x.b.tabs.create = async () => { throw new Error("no"); };
  const t = newTab(ff, x, w, { cookieStoreId: A, url: "https://old.example/" });
  assert.equal((await ff.request({ tabId: t.id, url: "https://work.example/x" })).cancel, true);
  x.b.tabs.create = create;
  assert.ok(ff.tabs.has(t.id));
  assert.equal(ff.tabs.get(t.id).url, "https://old.example/");
  assert.match(said.join(), /work\.example\/x/);
  // It is not an address that can never load: the next time it opens.
  assert.equal((await ff.request({ tabId: t.id, url: "https://work.example/x" })).cancel, true);
  await wait(300);
  assert.deepEqual(opened(ff, w.id, "https://work.example/x").map(n => n.cookieStoreId), [B]);
  x.kill();
});

// --- What Firefox loads before anything else has run ------------------------------------
test("a pinned page loaded outside any space when Tidier starts is moved too, pinned; an essential becomes one of the space", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://mail.example/", cookieStoreId: NONE, title: "Mail", icon: "x" }];
  const { w } = aWindow(ff);
  const plain = ff.addTab(w.id, { url: "https://pinned.example/", pinned: true });
  const essential = ff.addTab(w.id, { url: "https://mail.example/", pinned: true }, { essentialKey: "e" });
  const x = await run(ff);
  await wait(1500);
  assert.ok(!ff.tabs.has(plain.id), "not left outside a space");
  const [moved] = opened(ff, w.id, "https://pinned.example/");
  assert.equal(moved.cookieStoreId, A);
  assert.equal(moved.pinned, true);
  assert.ok(!ff.tabs.has(essential.id));
  assert.equal(ff.store.essentials[0].cookieStoreId, A);
  assert.deepEqual(ff.list(w.id).filter(t => t.pinned && ff.values.get(t.id)?.essentialKey === "e").map(t => t.cookieStoreId), [A]);
  assert.deepEqual(x.errors, []);
  x.kill();
});

test("a placeholder of an essential outside any container is left until it loads: nothing is opened for it at a start", async () => {
  const ff = new FakeFirefox();
  ff.store.essentials = [{ key: "e", url: "https://mail.example/", cookieStoreId: NONE, title: "Mail", icon: "x" }];
  const { w } = aWindow(ff);
  const copy = ff.addTab(w.id, { url: GHOST("essential", "e"), pinned: true }, { essentialKey: "e" });
  const x = await run(ff);
  await wait(800);
  assert.ok(ff.tabs.has(copy.id));
  assert.equal(ff.store.essentials[0].cookieStoreId, NONE);
  x.kill();
});

test("the space you switch to is the one kept for the next start, or a link that starts Firefox opens in an old one", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  ff.addTab(w.id, { url: "https://there.example/", cookieStoreId: B });
  const x = await run(ff);
  await x.js("switchSpace")(w.id, B);
  await wait(200);
  assert.equal(await x.b.sessions.getWindowValue(w.id, "space"), B);
  await x.js("switchSpace")(w.id, A);
  await wait(200);
  assert.equal(await x.b.sessions.getWindowValue(w.id, "space"), A);
  x.kill();
  const y = await run(ff);
  const blank = ff.addTab(w.id, { url: "about:blank" });
  y.b.tabs.onCreated.fire(ff.snap(blank));
  assert.equal((await ff.request({ tabId: blank.id, url: "https://link.example/" })).cancel, true);
  await wait(300);
  assert.equal(opened(ff, w.id, "https://link.example/")[0].cookieStoreId, A);
  y.kill();
});

test("a window whose space has not been read yet goes by its own, not by another window's", async () => {
  const ff = new FakeFirefox();
  const { w } = aWindow(ff);
  const second = ff.addWindow();
  ff.addTab(second.id, { url: "https://there.example/", cookieStoreId: B, active: true });
  const x = await run(ff);
  await x.b.sessions.setWindowValue(second.id, "space", B);
  x.js("activeSpace").delete(second.id);
  const blank = ff.addTab(second.id, { url: "about:blank" });
  x.b.tabs.onCreated.fire(ff.snap(blank));
  assert.equal((await ff.request({ tabId: blank.id, url: "https://link.example/" })).cancel, true);
  await wait(300);
  assert.equal(opened(ff, second.id, "https://link.example/")[0].cookieStoreId, B);
  x.kill();
});

const PROXY = { type: "http", host: "p.example", port: 3128 };
const pastProxy = (x, details) => x.js("notPastProxy")({ tabId: -1, type: "main_frame", cookieStoreId: A, url: "https://site.example/", ...details });

test("a page going past its space's proxy is stopped before anything is sent, and asked for again: that is how a start goes", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  const { w } = aWindow(ff);
  const x = await run(ff);
  assert.equal(x.b.webRequest.onBeforeSendHeaders.ls.length, 0, "nothing listens unless a space has one set");
  await x.js("setSpaceNetwork")(A, { proxy: PROXY });
  const [listener] = x.b.webRequest.onBeforeSendHeaders.ls;
  assert.equal(listener.f, x.js("notPastProxy"));
  assert.deepEqual([...listener.filter.types], ["main_frame"], "only pages: whatever a page asks for is opened with the proxy in place");
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: A });
  ff.log.length = 0;
  assert.equal(pastProxy(x, { tabId: t.id }).cancel, true);
  await wait(100);
  assert.deepEqual(ff.log.filter(l => l[0] === "update-url"), [["update-url", t.id, "https://site.example/"]]);
  x.kill();
});

test("a page going through its proxy, in another space, or to this machine is not looked at further", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  aWindow(ff);
  const x = await run(ff);
  await x.js("setSpaceNetwork")(A, { proxy: PROXY });
  assert.equal(pastProxy(x, { proxyInfo: { host: "p.example", port: 3128, type: "http" } }), undefined, "through it");
  assert.equal(pastProxy(x, { cookieStoreId: B }), undefined, "another space");
  assert.equal(pastProxy(x, { cookieStoreId: NONE }), undefined);
  for (const url of ["http://localhost:8080/", "http://app.localhost/", "http://127.0.0.1:9/", "http://[::1]:9/"]) {
    assert.equal(pastProxy(x, { url }), undefined, `${url}: Firefox never sends this machine through a proxy`);
  }
  assert.equal(pastProxy(x, { proxyInfo: { host: "other.example", port: 3128, type: "http" } }).cancel, true, "another proxy is not this one");
  x.kill();
});

test("asked for again once: a proxy that keeps being passed is said, and is no loop", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  const { w } = aWindow(ff);
  const x = await run(ff);
  const said = [];
  x.ctx.say = (id, text) => said.push(text);
  await x.js("setSpaceNetwork")(A, { proxy: PROXY });
  const t = ff.addTab(w.id, { url: "about:blank", cookieStoreId: A });
  ff.log.length = 0;
  assert.equal(pastProxy(x, { tabId: t.id }).cancel, true);
  assert.equal(pastProxy(x, { tabId: t.id }).cancel, true);
  await wait(100);
  assert.equal(ff.log.filter(l => l[0] === "update-url").length, 1);
  assert.match(said.join(), /site\.example/);
  x.kill();
});

test("the look at how a page goes is back from the first tick of a start, and goes when the proxy goes", async () => {
  const ff = new FakeFirefox(); ff.granted = new Set([...GUARD, "proxy"]);
  aWindow(ff);
  const x = await run(ff);
  await x.js("setSpaceNetwork")(A, { proxy: PROXY });
  await wait(1000);
  x.kill();
  const y = ff.boot();
  assert.equal(y.b.webRequest.onBeforeSendHeaders.ls.length, 1, "before anything was read");
  await wait(300);
  y.kill();
  const z = await run(ff);
  await z.js("setSpaceNetwork")(A, {});
  assert.equal(z.b.webRequest.onBeforeSendHeaders.ls.length, 0);
  z.kill();
});
