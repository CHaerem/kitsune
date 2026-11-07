// A fake Firefox for Tidier's real background scripts, for what can be tested
// without one (tests/background.test.mjs): how the scripts answer a start, an
// update or a refused call. Its behaviour comes from reading Firefox's source:
// an unknown tab or window is refused, and a removed container with "No cookie
// store exists". Whether Firefox really behaves so is for the smoke test.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const REPO = new URL("../", import.meta.url);
export const SCALE = 100; // timers run this much faster
export const realSleep = ms => new Promise(r => setTimeout(r, ms));
export const wait = ms => realSleep(ms / SCALE); // wait in the scripts' time

const ev = () => {
  const ls = [];
  return { ls, addListener(f, filter) { ls.push({ f, filter }); }, removeListener(f) { const i = ls.findIndex(l => l.f === f); if (i >= 0) ls.splice(i, 1); }, hasListener(f) { return ls.some(l => l.f === f); },
    fire(...a) { for (const { f } of [...ls]) { try { const r = f(...a); if (r?.catch) r.catch(() => {}); } catch { /* as in Firefox: a listener's error stays with it */ } } } };
};

export class FakeFirefox {
  constructor({ containers = ["firefox-default", "firefox-container-1", "firefox-container-2", "firefox-container-3"] } = {}) {
    this.containers = new Set(containers);
    this.wins = new Map(); this.tabs = new Map(); this.values = new Map(); this.store = {};
    this.nextTab = 100; this.nextWin = 1; this.ext = null;
    this.hooks = {}; this.log = [];
  }
  addWindow({ focused = false, type = "normal" } = {}) {
    const id = this.nextWin++;
    const w = { id, type, incognito: false, focused, order: [] };
    this.wins.set(id, w);
    if (focused) this.focused = id;
    return w;
  }
  addTab(windowId, props = {}, values = null) {
    const id = this.nextTab++;
    const t = { id, windowId, url: "about:blank", title: "", pinned: false, active: false, discarded: false, hidden: false, incognito: false, status: "complete", cookieStoreId: "firefox-default", lastAccessed: Date.now(), ...props };
    this.tabs.set(id, t);
    const w = this.wins.get(windowId);
    if (props.index !== undefined) w.order.splice(props.index, 0, id); else w.order.push(id);
    if (values) this.values.set(id, { ...values });
    return t;
  }
  index(t) { return this.wins.get(t.windowId).order.indexOf(t.id); }
  snap(t) { const c = { ...t, index: this.index(t) }; if (c.openerTabId === undefined) delete c.openerTabId; return c; }
  list(windowId) { return this.wins.get(windowId).order.map(id => this.snap(this.tabs.get(id))); }
  urls(windowId) { return this.list(windowId).map(t => t.url.replace("moz-extension://tidier/", "")); }
  ids() { return [...this.tabs.keys()]; }
  get synced() { return this.store.syncedTabs; }
  rm(id, { closing = false } = {}) {
    const t = this.tabs.get(id); if (!t) return;
    const w = this.wins.get(t.windowId);
    w.order.splice(w.order.indexOf(id), 1);
    this.tabs.delete(id); this.values.delete(id);
    this.ext?.b.tabs.onRemoved.fire(id, { windowId: t.windowId, isWindowClosing: closing });
    if (t.active && !closing && w.order.length) { const n = this.tabs.get(w.order[0]); n.active = true; this.ext?.b.tabs.onActivated.fire({ tabId: n.id, windowId: n.windowId, previousTabId: id }); }
  }
  // Selecting a tab the way the tab strip does: events only, no extension call.
  select(id) {
    const t = this.tabs.get(id); const w = this.wins.get(t.windowId);
    const previousTabId = w.order.find(x => this.tabs.get(x).active);
    for (const x of w.order) this.tabs.get(x).active = false;
    t.active = true; t.discarded = false; t.hidden = false; // Firefox shows a hidden tab you select
    this.ext?.b.tabs.onActivated.fire({ tabId: id, windowId: t.windowId, previousTabId });
  }
  // A page load the page itself asked for (location.replace) or that the user made.
  navigate(id, url, title = url) {
    const t = this.tabs.get(id);
    Object.assign(t, { url, title, discarded: false, status: "complete" });
    const s = this.snap(t);
    const on = this.ext?.b.tabs.onUpdated;
    on?.fire(id, { status: "loading", url }, { ...s, status: "loading" });
    on?.fire(id, { url }, { ...s, status: "loading" }); // as Firefox: the address changes while it loads
    on?.fire(id, { title }, s);
    on?.fire(id, { status: "complete" }, s);
  }
  // Start the real scripts: a new background page.
  boot() {
    if (this.ext) this.ext.kill();
    const ff = this, b = {}, timers = new Set();
    let dead = false;
    const T = { setTimeout: (f, ms = 0, ...a) => { const h = setTimeout(() => { timers.delete(h); if (!dead) f(...a); }, ms / SCALE); timers.add(h); return h; }, clearTimeout: h => { timers.delete(h); clearTimeout(h); } };
    const reject = m => Promise.reject(new Error(m));
    const need = id => ff.tabs.get(id) || (() => { throw new Error(`Invalid tab ID: ${id}`); })();
    b.tabs = {
      TAB_ID_NONE: -1,
      onCreated: ev(), onUpdated: ev(), onRemoved: ev(), onMoved: ev(), onActivated: ev(), onAttached: ev(), onDetached: ev(),
      query: async (q = {}) => { if (ff.hooks.query) await ff.hooks.query(q); let out = [...ff.wins.values()].flatMap(w => ff.list(w.id));
        for (const k of ["windowId", "pinned", "active", "discarded", "hidden", "cookieStoreId", "audible"]) if (q[k] !== undefined) out = out.filter(t => t[k] === q[k]);
        if (q.muted !== undefined) out = out.filter(t => !!t.mutedInfo?.muted === q.muted);
        if (q.currentWindow) out = out.filter(t => t.windowId === ff.focused);
        return out; },
      get: async id => ff.snap(need(id)),
      create: async p => {
        if (!ff.wins.has(p.windowId)) throw new Error(`Invalid window ID: ${p.windowId}`);
        if (p.cookieStoreId && !ff.containers.has(p.cookieStoreId)) throw new Error(`No cookie store exists with ID ${p.cookieStoreId}`);
        const t = ff.addTab(p.windowId, { url: p.url, pinned: !!p.pinned, active: !!p.active, cookieStoreId: p.cookieStoreId || "firefox-default", openerTabId: p.openerTabId, index: p.index, title: p.title ?? p.url, discarded: !!p.discarded });
        ff.log.push(["create", t.id, p.windowId, p.url]);
        // ff.blankFirst: as Firefox really does, a tab with an address is announced on
        // about:blank and its address follows, either before the answer to this call
        // ("early") or after it (true). Most tests need neither.
        if (ff.blankFirst && p.url) {
          t.url = "about:blank"; b.tabs.onCreated.fire(ff.snap(t));
          if (ff.blankFirst === "early") ff.navigate(t.id, p.url); else T.setTimeout(() => ff.navigate(t.id, p.url), 10);
          return { ...ff.snap(t), url: "about:blank" };
        }
        const s = ff.snap(t); b.tabs.onCreated.fire(s);
        if (p.active) ff.select(t.id); // the tab selected until now is not any more
        return s;
      },
      update: async (id, p) => {
        const t = need(id);
        if (p.active) ff.select(id);
        if (p.pinned !== undefined && p.pinned !== t.pinned) { t.pinned = p.pinned; b.tabs.onUpdated.fire(id, { pinned: p.pinned }, ff.snap(t)); }
        if (p.openerTabId !== undefined) t.openerTabId = p.openerTabId;
        if (p.muted !== undefined) { t.mutedInfo = { muted: p.muted }; b.tabs.onUpdated.fire(id, { mutedInfo: t.mutedInfo }, ff.snap(t)); }
        if (p.successorTabId !== undefined) t.successorTabId = p.successorTabId;
        if (p.url) { ff.log.push(["update-url", id, p.url]); ff.navigate(id, p.url); }
        return ff.snap(t);
      },
      move: async (id, { windowId, index }) => {
        if (index === -1) index = ff.wins.get(windowId ?? need(id).windowId).order.length - ((windowId ?? need(id).windowId) === need(id).windowId ? 1 : 0);
        const t = need(id); const from = ff.wins.get(t.windowId);
        const to = windowId ?? t.windowId;
        const fromIndex = from.order.indexOf(id);
        from.order.splice(fromIndex, 1);
        if (to !== t.windowId) {
          const old = t.windowId; b.tabs.onDetached.fire(id, { oldWindowId: old, oldPosition: fromIndex });
          t.windowId = to; ff.wins.get(to).order.splice(index, 0, id);
          b.tabs.onAttached.fire(id, { newWindowId: to, newPosition: index });
        } else {
          from.order.splice(index, 0, id);
          b.tabs.onMoved.fire(id, { windowId: to, fromIndex, toIndex: index });
        }
        ff.log.push(["move", id, to, index]);
        return ff.snap(t);
      },
      remove: async ids => { ids = Array.isArray(ids) ? ids : [ids]; ids.forEach(need); for (const id of ids) { ff.log.push(["remove", id, ff.tabs.get(id).url]); ff.rm(id); } },
      show: async ids => { ff.log.push(["show", ids]); for (const id of [ids].flat()) need(id).hidden = false; },
      hide: async ids => { ff.log.push(["hide", ids]); for (const id of [ids].flat()) { const t = need(id); if (!t.pinned && !t.active) t.hidden = true; } },
      discard: async id => { const t = need(id); ff.log.push(["discard", id]); if (!t.active && !ff.refuseDiscard?.has(id)) t.discarded = true; }, // Firefox refuses the selected tab, and a page with unsaved input
      reload: async id => { need(id); ff.log.push(["reload", id]); },
      // As SessionStore does: created blank, then the original's values, then its page.
      duplicate: async (id, { active, index } = {}) => {
        const o = need(id), t = ff.addTab(o.windowId, { url: "about:blank", cookieStoreId: o.cookieStoreId, active: false, index });
        ff.log.push(["duplicate", id, t.id]);
        b.tabs.onCreated.fire(ff.snap(t));
        if (active !== false) ff.select(t.id); // Firefox selects a copy unless told not to
        if (ff.values.has(id)) ff.values.set(t.id, { ...ff.values.get(id) });
        setTimeout(() => { if (ff.tabs.has(t.id)) ff.navigate(t.id, o.url, o.title); });
        return { ...ff.snap(t), url: o.url };
      },
      warmup: async id => { need(id); ff.log.push(["warmup", id]); },
    };
    b.windows = {
      WINDOW_ID_NONE: -1, onCreated: ev(), onRemoved: ev(), onFocusChanged: ev(),
      getAll: async ({ populate } = {}) => [...ff.wins.values()].map(w => ({ id: w.id, type: w.type, incognito: w.incognito, focused: ff.focused === w.id, ...(populate ? { tabs: ff.list(w.id) } : {}) })),
      get: async id => { const w = ff.wins.get(id); if (!w) throw new Error(`Invalid window ID: ${id}`); return { id, type: w.type, incognito: w.incognito, focused: ff.focused === id }; },
      getLastFocused: async () => { const w = ff.wins.get(ff.focused); return w ? { id: w.id, focused: true } : { id: -1, focused: false }; },
      update: async (id, p) => { if (!ff.wins.has(id)) throw new Error(`Invalid window ID: ${id}`); if (p.focused) ff.focused = id; return { id }; },
    };
    b.sessions = {
      onChanged: ev(),
      getTabValue: async (id, k) => { if (ff.hooks.getTabValue) await ff.hooks.getTabValue(id, k); need(id); return ff.values.get(id)?.[k]; },
      setTabValue: async (id, k, v) => { need(id); const o = ff.values.get(id) || {}; o[k] = v; ff.values.set(id, o); },
      removeTabValue: async (id, k) => { need(id); const o = ff.values.get(id); if (o) delete o[k]; },
      getWindowValue: async (id, k) => ff.windowValues?.[`${id} ${k}`], setWindowValue: async (id, k, v) => { (ff.windowValues ??= {})[`${id} ${k}`] = v; },
      getRecentlyClosed: async () => ff.recentlyClosed || [],
      forgetClosedTab: async (windowId, sessionId) => { ff.recentlyClosed = (ff.recentlyClosed || []).filter(c => c.tab?.sessionId !== sessionId); },
    };
    b.storage = { managed: { get: async () => ff.managed || {} }, local: {
      get: async k => { const ks = typeof k === "string" ? [k] : k; const o = {}; for (const x of ks) if (x in ff.store) o[x] = JSON.parse(JSON.stringify(ff.store[x])); return o; },
      set: async o => { ff.storeWrites = (ff.storeWrites || 0) + 1; Object.assign(ff.store, JSON.parse(JSON.stringify(o))); },
    } };
    b.alarms = { create() {}, onAlarm: ev() };
    b.runtime = { id: "tidier", getPlatformInfo: async () => ({ os: "mac" }), getManifest: () => ({ version: "1.6" }), getURL: p => "moz-extension://tidier/" + p, onMessage: ev(), onStartup: ev(), onInstalled: ev(), onConnect: ev(),
      sendNativeMessage: () => reject("no host") };
    const identity = c => ({ cookieStoreId: c, name: c, colorCode: "#000", color: "blue", icon: "circle", ...ff.identities?.[c] }); // ff.identities: names and looks other than the id
    b.contextualIdentities = { query: async () => [...ff.containers].filter(c => c !== "firefox-default").map(identity), onCreated: ev(), onUpdated: ev(), onRemoved: ev(),
      get: async id => { if (id === "firefox-default" || !ff.containers.has(id)) throw new Error(`Invalid contextual identity: ${id}`); return identity(id); },
      create: async ({ name, color, icon }) => {
        if (ff.badColors?.includes(color)) throw new Error(`Invalid color name ${color}`);
        const id = `firefox-container-${1 + Math.max(0, ...[...ff.containers].map(c => Number(c.split("-").pop()) || 0))}`;
        ff.containers.add(id);
        (ff.identities ||= {})[id] = { name, color, icon };
        b.contextualIdentities.onCreated.fire({ contextualIdentity: identity(id) });
        return identity(id);
      } };
    b.commands = { onCommand: ev(), getAll: async () => ff.commands || [], update: async c => { (ff.commandsSet ||= {})[c.name] = c.shortcut; }, reset: async () => {} };
    b.menus = { onShown: ev(), onHidden: ev(), onClicked: ev(), removeAll: async () => {}, create() {}, remove: async () => {}, refresh() {} };
    b.browserAction = { onClicked: ev(), setBadgeText: async o => { ff.badge = o.text; }, setTitle: async () => {} };
    b.permissions = { onAdded: ev(), onRemoved: ev(), contains: async () => false };
    b.sidebarAction = { toggle: async () => {} };
    addIsolationApis(ff, b);
    const errors = [];
    const quiet = { ...console, error: (...a) => { errors.push(a.map(x => x?.message ?? String(x)).join(" ")); }, warn() {} };
    const ctx = vm.createContext({ browser: b, console: quiet, ...T, URL, URLSearchParams, crypto: globalThis.crypto, performance, navigator: {}, localStorage: ff.pageStorage });
    const files = JSON.parse(readFileSync(new URL("manifest.json", REPO), "utf8")).background.scripts;
    for (const f of files) {
      const src = readFileSync(new URL(f, REPO), "utf8");
      vm.runInContext(src, ctx, { filename: f });
    }
    const ext = {
      b, ctx, errors,
      js: code => vm.runInContext(code, ctx),
      kill() { dead = true; timers.forEach(clearTimeout); },
      started: () => vm.runInContext("started", ctx),
      send(msg, sender) { for (const { f } of b.runtime.onMessage.ls) { const r = f(msg, { id: "tidier", url: "moz-extension://tidier/ghost.html", ...sender }); if (r !== undefined) return r; } },
    };
    this.ext = ext;
    return ext;
  }
}
export const GHOST = (k, key) => `moz-extension://tidier/ghost.html?kind=${k}&key=${encodeURIComponent(key)}`;

// What isolation.js uses, for tests/isolation.test.mjs. As in Firefox, an API behind an
// optional permission is not there at all until the permission is: ff.granted, or
// ff.grant() while running. The page's localStorage survives a boot, as it does.
function addIsolationApis(ff, b) {
  ff.granted ??= new Set();
  ff.cookies ??= []; // [{ storeId, domain, name, value, path, ... }]
  const store = (ff.pageStorageData ??= {});
  ff.pageStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const apis = () => {
    if (ff.granted.has("webRequest")) b.webRequest ??= { onBeforeRequest: ev(), onBeforeSendHeaders: ev() };
    if (ff.granted.has("proxy")) b.proxy ??= { onRequest: ev() };
    if (ff.granted.has("browsingData")) b.browsingData ??= { remove: async (o, kinds) => { ff.log.push(["browsingData", o, kinds]); ff.cookies = ff.cookies.filter(c => c.storeId !== o.cookieStoreId); } };
  };
  apis();
  ff.grant = (...names) => { names.forEach(n => ff.granted.add(n)); apis(); b.permissions.onAdded.fire({ permissions: names, origins: [] }); };
  b.permissions.contains = async ({ permissions = [], origins = [] }) => [...permissions, ...origins].every(p => ff.granted.has(p));
  b.contentScripts ??= { register: async () => ({ unregister: async () => {} }) }; // what else access to all websites starts (littlewindow.js)
  // Answers a top-level request as Firefox would ask it: undefined if nothing listens.
  ff.request = async ({ tabId, url, requestId = "r" + (ff.nextRequest = (ff.nextRequest || 0) + 1), originUrl, type = "main_frame", method = "GET" }) => {
    const t = ff.tabs.get(tabId);
    const listener = b.webRequest?.onBeforeRequest.ls[0];
    if (!listener || !listener.filter.types.includes(type)) return undefined;
    ff.requests = (ff.requests || 0) + 1;
    return listener.f({ tabId, url, requestId, originUrl, type, method, incognito: !!t?.incognito, cookieStoreId: t?.cookieStoreId });
  };
  b.cookies = {
    getAll: async ({ storeId, url, domain }) => ff.cookies.filter(c => c.storeId === storeId && (
      domain ? (c.domain.replace(/^\./, "") === domain || c.domain.endsWith("." + domain))
        : url ? (new URL(url).hostname === c.domain.replace(/^\./, "") || new URL(url).hostname.endsWith("." + c.domain.replace(/^\./, ""))) : true)),
    remove: async ({ storeId, name, url }) => { ff.cookies = ff.cookies.filter(c => !(c.storeId === storeId && c.name === name && url.includes(c.domain.replace(/^\./, "")))); },
    set: async ({ storeId, name, value, url, domain }) => { ff.cookies.push({ storeId, name, value, domain: domain ?? new URL(url).hostname, path: "/", secure: url.startsWith("https"), hostOnly: !domain, firstPartyDomain: "" }); },
  };
  ff.identities ??= {}; // container -> { name, color, icon }
  const identity = id => ({ cookieStoreId: id, name: id, color: "blue", colorCode: "#000", icon: "circle", iconUrl: "x.svg", ...ff.identities[id] });
  const ci = b.contextualIdentities;
  ci.query = async () => { if (ff.containersOff) throw new Error("Contextual identities are currently disabled"); return [...ff.containers].filter(c => c !== "firefox-default").map(identity); };
  ci.create = async ({ name, color, icon }) => {
    if (ff.badColors?.includes(color)) throw new Error(`Invalid color name ${color}`);
    ff.containerCount = Math.max(ff.containerCount || 0, ...[...ff.containers].map(c => Number(c.split("-").pop()) || 0)) + 1;
    const id = `firefox-container-${ff.containerCount}`;
    ff.containers.add(id);
    ff.identities[id] = { name, color, icon };
    ci.onCreated.fire({ contextualIdentity: identity(id) });
    return identity(id);
  };
  ci.update = async (id, changes) => { Object.assign((ff.identities[id] ??= {}), changes); ci.onUpdated.fire({ contextualIdentity: identity(id) }); return identity(id); };
  ci.remove = async id => { const old = identity(id); ff.containers.delete(id); ci.onRemoved.fire({ contextualIdentity: old }); return old; };
}
