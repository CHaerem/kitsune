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
  addWindow({ focused = false, type = "normal", left = 100, top = 50, width = 1200, height = 800 } = {}) {
    const id = this.nextWin++;
    const w = { id, type, incognito: false, focused, order: [], left, top, width, height };
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
    for (const x of w.order) this.tabs.get(x).active = false;
    t.active = true; t.discarded = false;
    this.ext?.b.tabs.onActivated.fire({ tabId: id, windowId: t.windowId });
  }
  // A page load the page itself asked for (location.replace) or that the user made.
  navigate(id, url, title = url) {
    const t = this.tabs.get(id);
    Object.assign(t, { url, title, discarded: false, status: "complete" });
    const s = this.snap(t);
    const on = this.ext?.b.tabs.onUpdated;
    on?.fire(id, { status: "loading", url }, s);
    on?.fire(id, { url }, s);
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
        for (const k of ["windowId", "pinned", "active", "discarded", "hidden", "cookieStoreId"]) if (q[k] !== undefined) out = out.filter(t => t[k] === q[k]);
        if (q.currentWindow) out = out.filter(t => t.windowId === ff.focused);
        return out; },
      get: async id => ff.snap(need(id)),
      create: async p => {
        if (!ff.wins.has(p.windowId)) throw new Error(`Invalid window ID: ${p.windowId}`);
        if (p.cookieStoreId && !ff.containers.has(p.cookieStoreId)) throw new Error(`No cookie store exists with ID ${p.cookieStoreId}`);
        const t = ff.addTab(p.windowId, { url: p.url, pinned: !!p.pinned, active: !!p.active, cookieStoreId: p.cookieStoreId || "firefox-default", openerTabId: p.openerTabId, index: p.index, title: p.url });
        ff.log.push(["create", t.id, p.windowId, p.url]);
        const s = ff.snap(t); b.tabs.onCreated.fire(s);
        return s;
      },
      update: async (id, p) => {
        const t = need(id);
        if (p.active) ff.select(id);
        if (p.pinned !== undefined && p.pinned !== t.pinned) { t.pinned = p.pinned; b.tabs.onUpdated.fire(id, { pinned: p.pinned }, ff.snap(t)); }
        if (p.openerTabId !== undefined) t.openerTabId = p.openerTabId;
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
      discard: async id => { const t = need(id); if (!ff.refuseDiscard?.has(id)) t.discarded = true; },
    };
    b.windows = {
      WINDOW_ID_NONE: -1, onCreated: ev(), onRemoved: ev(), onFocusChanged: ev(),
      getAll: async ({ populate, windowTypes } = {}) => [...ff.wins.values()].filter(w => !windowTypes || windowTypes.includes(w.type)).map(w => ({ id: w.id, type: w.type, incognito: w.incognito, focused: ff.focused === w.id, ...(populate ? { tabs: ff.list(w.id) } : {}) })),
      get: async id => { const w = ff.wins.get(id); if (!w) throw new Error(`Invalid window ID: ${id}`); return { id, type: w.type, incognito: w.incognito, focused: ff.focused === id, left: w.left, top: w.top, width: w.width, height: w.height }; },
      getLastFocused: async () => { const w = ff.wins.get(ff.focused); return w ? { id: w.id, focused: true } : { id: -1, focused: false }; },
      create: async ({ type = "normal", url, left, top, width, height }) => { const w = ff.addWindow({ type, left, top, width, height }); ff.focused = w.id; b.windows.onCreated.fire({ id: w.id, type, incognito: false }); const t = ff.addTab(w.id, { url, active: true }); b.tabs.onCreated.fire(ff.snap(t)); b.windows.onFocusChanged.fire(w.id); return { id: w.id, type, left, top, width, height }; },
      remove: async id => { const w = ff.wins.get(id); if (!w) throw new Error(`Invalid window ID: ${id}`); for (const t of [...w.order]) ff.rm(t, { closing: true }); ff.wins.delete(id); if (ff.focused === id) ff.focused = undefined; b.windows.onRemoved.fire(id); },
      update: async (id, { focused }) => { if (!ff.wins.has(id)) throw new Error(`Invalid window ID: ${id}`); if (focused) { ff.focused = id; b.windows.onFocusChanged.fire(id); } return { id }; },
    };
    b.sessions = {
      onChanged: ev(),
      getTabValue: async (id, k) => { if (ff.hooks.getTabValue) await ff.hooks.getTabValue(id, k); need(id); return ff.values.get(id)?.[k]; },
      setTabValue: async (id, k, v) => { need(id); const o = ff.values.get(id) || {}; o[k] = v; ff.values.set(id, o); },
      removeTabValue: async (id, k) => { need(id); const o = ff.values.get(id); if (o) delete o[k]; },
      getWindowValue: async () => undefined, setWindowValue: async () => {},
      getRecentlyClosed: async () => ff.recentlyClosed || [],
      forgetClosedTab: async (windowId, sessionId) => { ff.recentlyClosed = (ff.recentlyClosed || []).filter(c => c.tab?.sessionId !== sessionId); },
    };
    b.storage = { managed: { get: async () => ff.managed || {} }, local: {
      get: async k => { const ks = typeof k === "string" ? [k] : k; const o = {}; for (const x of ks) if (x in ff.store) o[x] = JSON.parse(JSON.stringify(ff.store[x])); return o; },
      set: async o => { ff.storeWrites = (ff.storeWrites || 0) + 1; Object.assign(ff.store, JSON.parse(JSON.stringify(o))); },
    } };
    b.alarms = { create() {}, onAlarm: ev() };
    b.runtime = { id: "tidier", getPlatformInfo: async () => ({ os: "mac" }), getManifest: () => ({ version: "1.6" }), getURL: p => "moz-extension://tidier/" + p, onMessage: ev(), onStartup: ev(), onInstalled: ev(), onConnect: ev(),
      sendNativeMessage: () => reject("no host"), sendMessage: () => reject("Could not establish connection. Receiving end does not exist."), openOptionsPage: async () => {} };
    b.contextualIdentities = { query: async () => [...ff.containers].filter(c => c !== "firefox-default").map(c => ({ cookieStoreId: c, name: c, colorCode: "#000", icon: "circle" })), onCreated: ev(), onUpdated: ev(), onRemoved: ev() };
    b.commands = { onCommand: ev(), getAll: async () => ff.commands || [], update: async c => { (ff.commandsSet ||= {})[c.name] = c.shortcut; }, reset: async () => {} };
    b.menus = { onShown: ev(), onClicked: ev(), removeAll: async () => {}, create() {}, remove: async () => {}, refresh() {} };
    b.browserAction = { onClicked: ev(), setBadgeText: async o => { ff.badge = o.text; }, setTitle: async () => {} };
    b.permissions = { onAdded: ev(), onRemoved: ev() };
    b.sidebarAction = { toggle: async () => {} };
    const errors = [];
    const quiet = { ...console, error: (...a) => { errors.push(a.map(x => x?.message ?? String(x)).join(" ")); }, warn() {} };
    const ctx = vm.createContext({ browser: b, console: quiet, ...T, URL, URLSearchParams, crypto: globalThis.crypto, performance, navigator: {} });
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
