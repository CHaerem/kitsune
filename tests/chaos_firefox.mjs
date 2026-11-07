// A more faithful fake Firefox, for the chaos test (chaos.test.mjs): random use of
// Tidier's real background scripts, repeated exactly from a seed.
//
// Two things set it apart from fake_firefox.mjs, on which it is built:
//
// - Time is virtual (Clock). Nothing waits for real, so a long sequence takes
//   milliseconds, and the same seed gives the same run on any machine, however busy.
//   That is what makes a failure replayable and shrinkable.
// - The background page and Firefox talk over a channel, as they really do. A call
//   reaches Firefox some time after it is made and its answer comes back later; what
//   you do meanwhile happens in between. Events and answers arrive in the order
//   Firefox sent them. So a tab can close between the query and the call that uses it.
//
// What each call and event does follows Firefox's source; the file named in a comment
// is where to look (browser/components/extensions/parent/ext-tabs.js, ext-browser.js,
// browser/components/tabbrowser/content/tabbrowser.js, SessionStore.sys.mjs).
import { FakeFirefox } from "./fake_firefox.mjs";

export const REFUSED = "chaos: refused"; // the mark of a refusal injected on purpose
export const isPlaceholder = url => (url || "").startsWith("moz-extension://tidier/ghost.html");
export const isFolderPage = url => /^moz-extension:\/\/[^/]+\/sidebery\/group\.html/.test(url || "");
const isWeb = url => /^https?:/i.test(url || "");

// A small seeded generator: the same seed gives the same numbers everywhere.
export function randoms(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Everything that waits, waits here. Between two timers every promise that can go on
// does (a macrotask drains the microtask queue), and no real time passes.
const drain = () => new Promise(resolve => setImmediate(resolve));
export class Clock {
  constructor() {
    const clock = this, start = Date.UTC(2026, 10, 1);
    this.now = start;
    this.q = []; // sorted by when, then by order of creation
    this.seq = 0;
    this.Date = class extends Date {
      constructor(...a) { if (a.length) super(...a); else super(clock.now); }
      static now() { return clock.now; }
    };
    this.performance = { now: () => clock.now - start };
    this.setTimeout = this.setTimeout.bind(this);
    this.clearTimeout = this.clearTimeout.bind(this);
  }
  setTimeout(f, ms = 0) {
    const h = { at: this.now + Math.max(0, Number(ms) || 0), seq: this.seq++, f, dead: false };
    let lo = 0, hi = this.q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1, m = this.q[mid];
      if (m.at < h.at || (m.at === h.at && m.seq < h.seq)) lo = mid + 1; else hi = mid;
    }
    this.q.splice(lo, 0, h);
    return h;
  }
  clearTimeout(h) { if (h && typeof h === "object") h.dead = true; }
  // The next timer that is still wanted, or null.
  next() {
    while (this.q.length && this.q[0].dead) this.q.shift();
    return this.q[0] ?? null;
  }
  get waiting() { return this.q.filter(h => !h.dead).length; }
  async step() {
    const h = this.next();
    if (!h) return false;
    this.q.shift();
    this.now = Math.max(this.now, h.at);
    h.f();
    await drain();
    return true;
  }
  // Let `ms` of virtual time pass.
  async run(ms) {
    await drain();
    const until = this.now + ms;
    for (let h = this.next(); h && h.at <= until; h = this.next()) await this.step();
    this.now = Math.max(this.now, until);
  }
  // Until nothing is waiting any more. False if it never gets there.
  async idle(limitMs) {
    await drain();
    const until = this.now + limitMs;
    for (let h = this.next(); h; h = this.next()) {
      if (h.at > until) return false;
      await this.step();
    }
    return true;
  }
  // An answer that may need time to pass: run until the promise is settled.
  async settled(promise, limitMs = 600000) {
    let done = false, value, error;
    promise.then(v => { done = true; value = v; }, e => { done = true; error = e; });
    await drain();
    const until = this.now + limitMs;
    while (!done) {
      const h = this.next();
      if (!h || h.at > until) throw new Error("no answer");
      await this.step();
    }
    if (error) throw error;
    return value;
  }
}

const REFUSABLE = /^(tabs\.(create|update|move|remove|discard|show|hide)|sessions\.(setTabValue|removeTabValue|getTabValue)|storage\.local\.set)$/;

export class ChaosFirefox extends FakeFirefox {
  // closeWindowWithLastTab: Firefox's default; the owner's dotfiles turn it off.
  constructor({ seed = 1, closeWindowWithLastTab = true, loadFactor = 1 } = {}) {
    super();
    this.clock = new Clock();
    this.rng = randoms(seed);
    this.loadFactor = loadFactor;
    this.closeWindowWithLastTab = closeWindowWithLastTab;
    this.gen = 0;              // which background page is alive: answers to an older one are dropped
    this.lastAt = { up: 0, down: 0 };
    this.refuseRate = 0;
    this.refusals = 0;
    this.pages = new WeakMap(); // tab record -> what is loading or loaded in it
    this.closedItems = [];     // Recently Closed, newest first
    this.closedSeq = 1;
    this.winValues = new Map();
    this.unhandled = [];       // errors from listeners, and promises nobody handled
    this.views = new Map();    // windowId -> the last view its sidebar got
    this.ports = new Map();    // windowId -> its sidebar's port
    this.uuid = 0;
    this.crypto = { randomUUID: () => `key-${++this.uuid}` };
    this.tracer = null;
    this.b = this.silent();
  }

  trace(...a) { this.tracer?.(`${String(this.clock.now % 10000000).padStart(7)} ${a.join(" ")}`); }

  // --- The channel -------------------------------------------------------------
  latency() {
    const r = this.rng();
    return (r < 0.85 ? 1 + this.rng() : r < 0.98 ? 2 + 8 * this.rng() : 20 + 80 * this.rng()) * this.loadFactor;
  }
  // In order, each direction: what is sent later never arrives first.
  send(dir, fn) {
    const at = Math.max(this.lastAt[dir], this.clock.now + this.latency());
    this.lastAt[dir] = at;
    this.clock.setTimeout(fn, at - this.clock.now);
  }
  // A call from the background page: it runs in Firefox whole, at one moment.
  call(label, args, fn) {
    const gen = this.gen;
    // Where in Tidier the call was made, for a failure to name (only when asked: it takes time).
    const site = process.env.CHAOS_SITES ? new Error().stack.split("\n").find(l => /[( ][a-z-]+\.js:\d+/.test(l))?.replace(/^.*[( ]([a-z-]+\.js:\d+).*$/, "$1") : "";
    return new Promise((resolve, reject) => {
      this.send("up", () => {
        if (gen !== this.gen) return;
        let out, err;
        try {
          if (this.refuseRate && (this.refusePattern ?? REFUSABLE).test(label) && this.rng() < this.refuseRate) { this.refusals++; throw new Error(`${REFUSED} ${label}`); }
          out = fn();
        } catch (e) { err = e; err.message += ` (${label}${site ? ` at ${site}` : ""})`; } // which call, for whoever reads the failure
        this.trace(label, JSON.stringify(args)?.slice(0, 120), err ? `-> ERROR ${err.message}` : "");
        this.send("down", () => { if (gen === this.gen) { if (err) reject(err); else resolve(out); } });
      });
    });
  }
  // An event: sent now, seen later, and only by the page that was alive when it was sent.
  patchEvent(e, name) {
    const ff = this, gen = this.gen;
    e.fire = (...args) => {
      ff.trace("event", name, JSON.stringify(args[0]?.id ?? args[0]), args[1] !== undefined ? JSON.stringify(args[1]).slice(0, 100) : "");
      ff.send("down", () => {
        if (gen !== ff.gen) return;
        for (const { f, filter } of [...e.ls]) {
          let a = args;
          if (name === "onUpdated" && filter?.properties) {
            const change = {};
            for (const p of filter.properties) if (p in args[1]) change[p] = args[1][p];
            if (!Object.keys(change).length) continue;
            a = [args[0], change, args[2]];
          }
          try {
            const r = f(...a);
            r?.catch?.(err => ff.noteUnhandled(err, name));
          } catch (err) { ff.noteUnhandled(err, name); }
        }
      });
    };
  }
  noteUnhandled(err, where) { this.unhandled.push(`${where}: ${err?.message ?? err}`); }

  // --- The API, before the scripts see it ----------------------------------------
  adapt(b) {
    const ff = this;
    this.b = b;
    for (const ns of [b.tabs, b.windows, b.sessions, b.alarms, b.contextualIdentities, b.permissions]) {
      for (const [name, e] of Object.entries(ns)) if (name.startsWith("on") && e?.fire) this.patchEvent(e, name);
    }
    const need = id => this.tabs.get(id) || (() => { throw new Error(`Invalid tab ID: ${id}`); })();
    const needWin = id => this.wins.get(id) || (() => { throw new Error(`Invalid window ID: ${id}`); })();
    const api = (ns, nsName, fns) => {
      for (const [name, fn] of Object.entries(fns)) ns[name] = (...a) => ff.call(`${nsName}.${name}`, a, () => fn(...a));
    };
    api(b.tabs, "tabs", {
      query: (q = {}) => {
        let out = [...this.wins.values()].flatMap(w => this.list(w.id));
        for (const k of ["windowId", "pinned", "active", "discarded", "hidden", "cookieStoreId", "status"]) if (q[k] !== undefined) out = out.filter(t => t[k] === q[k]);
        if (q.currentWindow) out = out.filter(t => t.windowId === this.currentWindow());
        return out;
      },
      get: id => this.snap(need(id)),
      // ext-tabs.js create(): checks, then gBrowser.addTab, and selected unless active is false.
      create: p => {
        const windowId = p.windowId ?? this.currentWindow();
        needWin(windowId);
        if (p.cookieStoreId && !this.containers.has(p.cookieStoreId)) throw new Error(`No cookie store exists with ID ${p.cookieStoreId}`);
        if (p.openerTabId != null && need(p.openerTabId).windowId !== windowId) throw new Error("Opener tab must be in the same window as the tab being created");
        return this.snap(this.openTab(windowId, { url: p.url ?? "about:newtab", active: p.active !== false, pinned: !!p.pinned, cookieStoreId: p.cookieStoreId, index: p.index, openerTabId: p.openerTabId ?? undefined }));
      },
      // ext-tabs.js update(): in this order.
      update: (id, p) => {
        const t = need(id);
        if (p.url != null) this.load(t, p.url);
        if (p.active) this.select(id);
        if (p.muted != null && !!t.mutedInfo?.muted !== p.muted) { t.mutedInfo = { muted: p.muted }; this.updated(t, { mutedInfo: t.mutedInfo }); }
        if (p.pinned === true) this.pinTab(t);
        if (p.pinned === false) this.unpinTab(t);
        if (p.openerTabId != null) {
          if (p.openerTabId > -1 && need(p.openerTabId).windowId !== t.windowId) throw new Error("Opener tab must be in the same window as the tab being updated");
          t.openerTabId = p.openerTabId > -1 ? p.openerTabId : undefined;
        }
        if (p.successorTabId != null) {
          if (p.successorTabId === -1) delete t.successorTabId;
          else {
            const s = this.tabs.get(p.successorTabId);
            if (!s) throw new Error("Invalid successorTabId");
            if (s.windowId !== t.windowId) throw new Error("Successor tab must be in the same window as the tab being updated");
            t.successorTabId = s.id === t.id ? undefined : s.id;
          }
        }
        return this.snap(t);
      },
      move: (ids, p) => { this.moveByCall = true; try { return this.moveTabs([ids].flat(), p); } finally { this.moveByCall = false; } },
      // ext-tabs.js remove(): one tab with removeTab, several with removeTabs per window.
      remove: ids => {
        const list = [ids].flat();
        list.forEach(need);
        const perWindow = new Map();
        for (const id of list) perWindow.set(this.tabs.get(id).windowId, [...(perWindow.get(this.tabs.get(id).windowId) || []), id]);
        for (const [windowId, here] of perWindow) {
          const w = this.wins.get(windowId);
          if (here.length > 1 && w.order.length === here.length && this.closeWindowWithLastTab) { this.closeWindow(windowId); continue; }
          // The selected one last, as removeTabs does, so Firefox does not select several in turn.
          for (const id of [...here].sort((a, c) => this.tabs.get(a).active - this.tabs.get(c).active)) this.closeTab(id);
        }
      },
      show: ids => { for (const id of [ids].flat()) this.showTab(need(id)); },
      hide: ids => { for (const id of [ids].flat()) this.hideTab(need(id)); },
      // tabbrowser's #mayDiscardBrowser: never the selected tab, and a page may refuse.
      discard: ids => {
        for (const id of [ids].flat()) {
          const t = need(id);
          if (t.active || t.discarded || t.unsaved) continue;
          t.discarded = true; t.status = "complete"; t.audible = false;
          this.pages.delete(t);
          this.forced ??= new WeakSet();
          this.forced.add(t);
          this.updated(t, { discarded: true });
        }
      },
    });
    api(b.windows, "windows", {
      getAll: ({ populate, windowTypes } = {}) => [...this.wins.values()].filter(w => !windowTypes || windowTypes.includes(w.type))
        .map(w => ({ id: w.id, type: w.type, incognito: w.incognito, focused: this.focused === w.id, ...(populate ? { tabs: this.list(w.id) } : {}) })),
      get: id => { const w = needWin(id); return { id, type: w.type, incognito: w.incognito, focused: this.focused === id }; },
      getLastFocused: () => { const w = this.wins.get(this.focused) ?? [...this.wins.values()][0]; if (!w) throw new Error("no window"); return { id: w.id, focused: this.focused === w.id }; },
    });
    api(b.sessions, "sessions", {
      getTabValue: (id, k) => { need(id); return this.values.get(id)?.[k]; },
      setTabValue: (id, k, v) => { need(id); const o = this.values.get(id) || {}; o[k] = v; this.values.set(id, o); },
      removeTabValue: (id, k) => { need(id); const o = this.values.get(id); if (o) delete o[k]; },
      getWindowValue: (id, k) => { needWin(id); return this.winValues.get(id)?.[k]; },
      setWindowValue: (id, k, v) => { needWin(id); this.winValues.set(id, { ...this.winValues.get(id), [k]: v }); },
      // A closed tab is listed by the window it was closed in, while that window is open.
      getRecentlyClosed: () => this.closedItems.filter(c => c.kind === "window" || this.wins.has(c.windowId))
        .map(c => (c.kind === "tab" ? { lastModified: c.at, tab: { url: c.state.url, title: c.state.title, windowId: c.windowId, sessionId: c.sessionId } } : { lastModified: c.at, window: { id: -1, sessionId: c.sessionId, tabs: [] } })),
      // ext-sessions.js: an unknown window or closed tab is refused.
      forgetClosedTab: (windowId, sessionId) => {
        needWin(windowId);
        const i = this.closedItems.findIndex(c => c.kind === "tab" && c.sessionId === sessionId);
        if (i < 0) throw new Error(`Could not find closed tab using sessionId ${sessionId}.`);
        this.closedItems.splice(i, 1);
        this.b.sessions.onChanged.fire();
      },
    });
    const local = b.storage.local;
    api(local, "storage.local", { get: local.get, set: local.set });
    const contextual = b.contextualIdentities;
    api(contextual, "contextualIdentities", { query: contextual.query });
    // What this fake has no story for answers at once, as in the plain fake.
    b.alarms.create = () => {};
    b.browserAction.setBadgeText = async () => {};
    b.browserAction.setTitle = async () => {};
  }

  boot() {
    this.gen++;
    this.ports.clear();
    this.views.clear();
    return super.boot();
  }

  // --- Tabs ------------------------------------------------------------------------
  currentWindow() {
    if (this.wins.has(this.focused)) return this.focused;
    return [...this.wins.values()].find(w => w.type === "normal")?.id;
  }
  snap(t) {
    const c = super.snap(t);
    if (t.openerTabId !== undefined && this.tabs.get(t.openerTabId)?.windowId !== t.windowId) delete c.openerTabId; // ext-tabs-base.js openerTabId
    if (t.active && this.focused === t.windowId) c.lastAccessed = this.clock.now; // tab.js lastAccessed
    return c;
  }
  updated(t, change) { this.b.tabs.onUpdated.fire(t.id, change, this.snap(t)); }
  pinnedCount(w) { return w.order.filter(id => this.tabs.get(id).pinned).length; }

  // gBrowser.addTab: an index is kept within the tab's part of the strip.
  openTab(windowId, { url, active = false, pinned = false, cookieStoreId, index, openerTabId, restored = null } = {}) {
    const w = this.wins.get(windowId);
    const n = this.pinnedCount(w);
    let at = index ?? w.order.length;
    at = pinned ? Math.min(at, n) : Math.max(Math.min(at, w.order.length), n);
    const id = this.nextTab++;
    const t = {
      id, windowId, url: url.startsWith("about:") ? url : "about:blank", title: "", pinned, active: false, discarded: false, hidden: false, incognito: false,
      status: "complete", cookieStoreId: cookieStoreId ?? "firefox-default", lastAccessed: this.clock.now, openerTabId, ...(restored?.tab || {}),
    };
    this.tabs.set(id, t);
    w.order.splice(at, 0, id);
    if (restored) this.values.set(id, JSON.parse(JSON.stringify(restored.values ?? {})));
    if (active) { const prev = this.activeOf(w); if (prev) { prev.active = false; prev.lastAccessed = this.clock.now; this.pageHidden(prev); } t.active = true; }
    // ext-browser.js: onCreated waits a tick, so it says active, and comes before onActivated.
    this.b.tabs.onCreated.fire(this.snap(t));
    if (active) this.b.tabs.onActivated.fire({ tabId: id, windowId });
    if (restored) { if (!t.discarded) this.load(t, t.url); }
    else if (!url.startsWith("about:")) { t.status = "loading"; this.load(t, url); }
    return t;
  }
  activeOf(w) { return w.order.map(id => this.tabs.get(id)).find(t => t.active); }

  // gBrowser's selectedTab: selecting shows a hidden tab, and loads an unloaded one.
  select(id) {
    const t = this.tabs.get(id), w = t && this.wins.get(t.windowId);
    if (!t || t.active) return;
    const prev = this.activeOf(w);
    if (prev) { prev.active = false; prev.lastAccessed = this.clock.now; }
    t.active = true;
    t.lastAccessed = this.clock.now;
    if (t.hidden) this.showTab(t);
    this.b.tabs.onActivated.fire({ tabId: id, windowId: t.windowId, previousTabId: prev?.id });
    if (prev) this.pageHidden(prev);
    if (t.discarded) this.load(t, t.url); else this.pageShown(t);
  }
  focusWindow(id) {
    if (this.focused === id) return;
    this.focused = id;
    if (this.rng() < 0.5) this.b.windows.onFocusChanged.fire(-1);
    this.b.windows.onFocusChanged.fire(id);
  }
  showTab(t) { if (t.hidden) { t.hidden = false; this.updated(t, { hidden: false }); } }
  hideTab(t) {
    if (t.hidden || t.pinned || t.active) return;
    t.hidden = true;
    this.wins.get(t.windowId).changedAt = this.clock.now;
    this.replaceInSuccession(t);
    this.updated(t, { hidden: true });
  }
  // tabbrowser's replaceInSuccession: whoever had this tab as successor gets its successor.
  replaceInSuccession(t) {
    for (const x of this.tabs.values()) if (x.successorTabId === t.id) x.successorTabId = t.successorTabId;
    delete t.successorTabId;
  }
  pinTab(t) {
    if (t.pinned) return;
    this.showTab(t);
    const w = this.wins.get(t.windowId), from = w.order.indexOf(t.id), to = this.pinnedCount(w);
    w.order.splice(from, 1); w.order.splice(to, 0, t.id);
    if (from !== to) this.b.tabs.onMoved.fire(t.id, { windowId: t.windowId, fromIndex: from, toIndex: to });
    t.pinned = true;
    this.updated(t, { pinned: true });
  }
  unpinTab(t) {
    if (!t.pinned) return;
    const w = this.wins.get(t.windowId), from = w.order.indexOf(t.id);
    t.pinned = false;
    const to = this.pinnedCount(w);
    w.order.splice(from, 1); w.order.splice(to, 0, t.id);
    if (from !== to) this.b.tabs.onMoved.fire(t.id, { windowId: t.windowId, fromIndex: from, toIndex: to });
    this.updated(t, { pinned: false });
  }

  // ext-tabs.js move(): an index out of the tab's part of the strip is silently ignored,
  // and a tab that moves to another window keeps its ID (adoptTab).
  moveTabs(ids, { windowId, index }) {
    if (windowId !== undefined && !this.wins.has(windowId)) throw new Error(`Invalid window ID: ${windowId}`);
    const moved = [];
    let last = null;
    for (const id of ids) {
      const t = this.tabs.get(id);
      if (!t) throw new Error(`Invalid tab ID: ${id}`);
      const to = this.wins.get(windowId ?? t.windowId), same = to.id === t.windowId;
      if (same && to.order.length === 1) continue;
      const max = to.order.length - (same ? 1 : 0);
      let at = last ?? (index === -1 ? max : Math.min(index, max));
      if (last !== null) at = same && this.index(t) <= last ? last : last + 1;
      const n = this.pinnedCount(to);
      if (t.pinned ? at > n : at < n) continue;
      if (same) {
        const from = to.order.indexOf(id);
        if (from !== at) {
          to.order.splice(from, 1); to.order.splice(at, 0, id);
          this.b.tabs.onMoved.fire(id, { windowId: to.id, fromIndex: from, toIndex: at });
        }
      } else this.adopt(t, to, at);
      last = at;
      moved.push(this.snap(t));
    }
    return moved;
  }
  // tabbrowser's adoptTab: the tab goes, also if it leaves the window with no tab to show,
  // which then closes whatever closeWindowWithLastTab says (swapBrowsersAndCloseOther).
  adopt(t, to, at) {
    const from = this.wins.get(t.windowId);
    const fromIndex = from.order.indexOf(t.id);
    const last = !from.order.some(x => x !== t.id && !this.tabs.get(x).hidden);
    const blurTo = t.active && !last ? this.findTabToBlurTo(t, from) : null;
    this.replaceInSuccession(t);
    for (const x of this.tabs.values()) if (x.openerTabId === t.id) delete x.openerTabId;
    delete t.openerTabId;
    from.order.splice(fromIndex, 1);
    t.windowId = to.id;
    t.active = false;
    to.order.splice(at, 0, t.id);
    this.pageHidden(t);
    // An unloaded tab loses its values (seen in Firefox, see onAttached in tabsync.js),
    // arrives without its title, and a pinned one arrives unpinned for a moment.
    const unloaded = t.discarded;
    if (unloaded) { if (this.rng() < 0.5) this.values.delete(t.id); t.title = t.url; }
    if (unloaded && t.pinned) {
      t.pinned = false;
      this.updated(t, { pinned: false });
      this.clock.setTimeout(() => { if (this.tabs.get(t.id) === t && !t.pinned) { t.pinned = true; this.updated(t, { pinned: true }); } }, 100 * this.rng());
    }
    this.b.tabs.onDetached.fire(t.id, { oldWindowId: from.id, oldPosition: fromIndex });
    this.b.tabs.onAttached.fire(t.id, { newWindowId: to.id, newPosition: at });
    if (blurTo) this.select(blurTo.id);
    if (last) {
      // (Not if the other tabs just went: a look at them and the move cannot be one step.)
      if (this.moveByCall && this.clock.now - (from.changedAt ?? 0) > 1000) this.noteUnhandled(new Error(`Tidier moved the last tab out of window ${from.id}, which closed it`), "a window closed by itself");
      this.closeWindow(from.id);
    }
  }

  // tabbrowser's _findTabToBlurTo: the successor, else the next tab it can show, passing
  // over tabs unloaded on purpose if there are others (the owner is left out here).
  findTabToBlurTo(t, w) {
    if (t.successorTabId !== undefined && this.tabs.has(t.successorTabId)) return this.tabs.get(t.successorTabId);
    let rest = w.order.map(id => this.tabs.get(id)).filter(x => x !== t && !x.hidden);
    const kept = rest.filter(x => !this.forced?.has(x));
    if (kept.length) rest = kept;
    const at = w.order.indexOf(t.id);
    return rest.find(x => w.order.indexOf(x.id) > at) ?? rest.reverse().find(x => w.order.indexOf(x.id) < at) ?? null;
  }

  // tabbrowser's removeTab. The tab with nothing to show after it closes the window, or
  // with the setting off makes way for a new tab. Hidden tabs do not count (#isLastTabInWindow).
  closeTab(id) {
    const t = this.tabs.get(id);
    if (!t) return;
    const w = this.wins.get(t.windowId);
    w.changedAt = this.clock.now;
    const last = !w.order.some(x => x !== id && !this.tabs.get(x).hidden);
    if (last && this.closeWindowWithLastTab) { this.closeWindow(w.id); return; }
    const blurTo = t.active && !last ? this.findTabToBlurTo(t, w) : null;
    if (last) this.openTab(w.id, { url: "about:newtab", index: 0 });
    this.replaceInSuccession(t);
    this.rememberClosed(t);
    w.order.splice(w.order.indexOf(id), 1);
    this.tabs.delete(id);
    this.values.delete(id);
    this.pages.delete(t);
    // ext-browser.js: onActivated waits a tick, so onRemoved comes first.
    this.b.tabs.onRemoved.fire(id, { windowId: t.windowId, isWindowClosing: false });
    if (blurTo) { t.active = false; this.select(blurTo.id); }
    else if (t.active && last) { const fresh = this.tabs.get(w.order[0]); if (fresh) { fresh.active = true; fresh.lastAccessed = this.clock.now; this.b.tabs.onActivated.fire({ tabId: fresh.id, windowId: w.id }); } }
  }
  // SessionStore's #onTabClose: what could be reopened. A blank new tab is not worth
  // keeping, and a loaded tab gets there a moment later (its state is saved first).
  rememberClosed(t) {
    if (t.url.startsWith("about:")) return;
    const item = { kind: "tab", at: this.clock.now, sessionId: String(this.closedSeq++), windowId: t.windowId, state: this.stateOf(t) };
    const add = () => { this.closedItems.unshift(item); this.b.sessions.onChanged.fire(); };
    if (t.discarded) add(); else this.clock.setTimeout(add, 50 * this.rng());
  }
  stateOf(t) {
    return {
      url: t.url, title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned, hidden: t.hidden, cookieStoreId: t.cookieStoreId,
      index: this.index(t), active: t.active, lastAccessed: t.lastAccessed, values: JSON.parse(JSON.stringify(this.values.get(t.id) ?? {})),
    };
  }

  // ext-browser.js _handleWindowClose: every tab reports the window closing, then the window.
  closeWindow(id) {
    const w = this.wins.get(id);
    if (!w) return;
    this.closeSidebarOf(id);
    const states = w.order.map(x => this.stateOf(this.tabs.get(x)));
    if (w.type === "normal" && states.some(s => !s.url.startsWith("about:"))) {
      this.closedItems.unshift({ kind: "window", at: this.clock.now, sessionId: String(this.closedSeq++), states, winValues: this.winValues.get(id) });
    }
    for (const x of [...w.order]) {
      const t = this.tabs.get(x);
      this.tabs.delete(x); this.values.delete(x); this.pages.delete(t);
      this.b.tabs.onRemoved.fire(x, { windowId: id, isWindowClosing: true });
    }
    this.wins.delete(id);
    this.winValues.delete(id);
    this.b.windows.onRemoved.fire(id);
    this.b.sessions.onChanged.fire();
    if (this.focused === id) {
      this.focused = undefined;
      this.b.windows.onFocusChanged.fire(-1);
      const next = [...this.wins.values()].find(w => w.type === "normal");
      if (next) { this.focused = next.id; this.b.windows.onFocusChanged.fire(next.id); }
    }
  }

  // A window you open. Its first tab may be announced before the window or after it.
  openWindow({ url = "about:home", type = "normal" } = {}) {
    const w = this.addWindow({ type });
    const first = this.rng() < 0.5;
    if (first) this.b.windows.onCreated.fire({ id: w.id, type, incognito: false });
    const t = this.openTab(w.id, { url, active: true });
    if (!first) this.b.windows.onCreated.fire({ id: w.id, type, incognito: false });
    this.focusWindow(w.id);
    return { window: w, tab: t };
  }

  // ⌘⇧T: the newest thing in Recently Closed (SessionStore's undoCloseById). The values are
  // set just after onCreated is sent, before the background page can ask for them.
  reopenLast() {
    const item = this.closedItems.find(c => c.kind === "window" || this.wins.has(c.windowId));
    if (!item) return null;
    this.closedItems.splice(this.closedItems.indexOf(item), 1);
    this.b.sessions.onChanged.fire();
    if (item.kind === "window") return this.restoreWindow(item);
    const s = item.state, w = this.wins.get(item.windowId);
    return this.openTab(w.id, {
      url: s.url, active: true, pinned: s.pinned, cookieStoreId: s.cookieStoreId, index: s.index,
      restored: { tab: { url: s.url, title: s.title, favIconUrl: s.favIconUrl, lastAccessed: s.lastAccessed }, values: s.values },
    });
  }
  // A closed window comes back with new IDs and its tabs' values. Only the selected tab
  // and pinned ones load (browser.sessionstore.restore_on_demand and its pinned part).
  restoreWindow(item) {
    const w = this.addWindow();
    if (item.winValues) this.winValues.set(w.id, item.winValues);
    this.b.windows.onCreated.fire({ id: w.id, type: "normal", incognito: false });
    const made = item.states.map(s => {
      const load = s.active || s.pinned;
      return [s, this.openTab(w.id, {
        url: s.url, active: false, pinned: s.pinned, cookieStoreId: s.cookieStoreId,
        restored: { tab: { url: s.url, title: s.title, favIconUrl: s.favIconUrl, lastAccessed: s.lastAccessed, hidden: s.hidden && !s.active, discarded: !load }, values: s.values },
      })];
    });
    const chosen = made.find(([s]) => s.active)?.[1];
    if (chosen) { chosen.active = true; this.b.tabs.onActivated.fire({ tabId: chosen.id, windowId: w.id }); this.pageShown(chosen); }
    this.focusWindow(w.id);
    return w;
  }

  // --- Pages -----------------------------------------------------------------------
  // A page loads. The address changes a moment after the load starts; title, icon and
  // the end of the load follow. A newer load, unloading or closing cancels it.
  load(t, url) {
    const token = {};
    this.pages.set(t, { token, url, info: null });
    const wasUnloaded = t.discarded;
    t.discarded = false;
    this.forced?.delete(t);
    t.status = "loading";
    if (wasUnloaded) this.updated(t, { discarded: false });
    const alive = () => this.tabs.get(t.id) === t && this.pages.get(t)?.token === token;
    this.clock.setTimeout(() => {
      if (!alive()) return;
      t.url = url;
      this.updated(t, { status: "loading", url });
      if (isPlaceholder(url)) { this.runPlaceholder(t, url, alive); return; }
      this.clock.setTimeout(() => {
        if (!alive()) return;
        if (isWeb(url) || isFolderPage(url)) { t.title = `Page ${url.replace(/^.*\/\//, "")}`; this.updated(t, { title: t.title }); }
        this.clock.setTimeout(() => {
          if (!alive()) return;
          if (isWeb(url) && this.rng() < 0.7) { t.favIconUrl = `${new URL(url).origin}/favicon.ico`; this.updated(t, { favIconUrl: t.favIconUrl }); }
          t.status = "complete";
          this.updated(t, { status: "complete" });
        }, (2 + 40 * this.rng()) * this.loadFactor);
      }, (2 + 40 * this.rng()) * this.loadFactor);
    }, (1 + 5 * this.rng()) * this.loadFactor);
  }

  // A message from a page to the background page, and its answer.
  fromPage(t, msg) {
    const gen = this.gen;
    return new Promise(resolve => {
      this.send("up", () => this.send("down", async () => {
        if (gen !== this.gen || !this.ext) return;
        const answer = await this.ext.send(msg, { tab: this.tabs.has(t.id) ? this.snap(t) : { ...t }, url: t.url });
        this.send("up", () => this.send("down", () => { if (gen === this.gen) resolve(answer); }));
      }));
    });
  }
  // ghost.js, as a page in a tab.
  async runPlaceholder(t, url, alive) {
    const params = new URLSearchParams(url.split("?")[1]);
    const kind = params.get("kind"), key = params.get("key");
    const page = this.pages.get(t);
    Object.assign(page, { kind, key, alive });
    const info = await this.fromPage(t, { type: "ghostInfo", kind, key });
    if (!alive()) return;
    if (!info) { this.fromPage(t, { type: "ghostOrphan", kind, key }); return; }
    page.info = info;
    t.title = info.title || info.url;
    this.updated(t, { title: t.title });
    this.clock.setTimeout(() => { if (alive()) { t.status = "complete"; this.updated(t, { status: "complete" }); } }, (1 + 30 * this.rng()) * this.loadFactor);
    if (t.active) this.shown(t, page); else this.settlePage(t, page);
  }
  async shown(t, page) {
    if (page.kind === "lazy") { this.load(t, page.info.url); return; }
    const type = page.kind === "essential" ? "essentialShown" : "ghostShown";
    const r = await this.fromPage(t, { type });
    if (r?.load && page.alive()) this.load(t, page.info.url);
  }
  // Without a page being shown, it finds its icon and asks to be unloaded.
  async settlePage(t, page) {
    const hasIcon = this.rng() < 0.9;
    await new Promise(resolve => this.clock.setTimeout(resolve, 5 * this.rng() * this.loadFactor));
    if (!page.alive()) return;
    if (hasIcon && !t.favIconUrl && this.rng() < 0.98) {
      this.clock.setTimeout(() => {
        if (!page.alive()) return;
        t.favIconUrl = page.info.icon ?? "https://icons.example/favicon.ico";
        this.updated(t, { favIconUrl: t.favIconUrl });
      }, (1 + 20 * this.rng()) * this.loadFactor);
    }
    this.fromPage(t, { type: "ghostReady", icon: hasIcon });
  }
  pageShown(t) { const page = this.pages.get(t); if (page?.info && isPlaceholder(t.url)) this.shown(t, page); }
  pageHidden(t) { const page = this.pages.get(t); if (page?.info && isPlaceholder(t.url)) this.settlePage(t, page); }

  // --- Tidier's sidebar, as far as the background page can see ----------------------
  connectSidebar(windowId) {
    if (this.ports.has(windowId) || !this.wins.has(windowId)) return;
    const mk = () => { const ls = []; return { ls, addListener: f => ls.push(f), fire: (...a) => ls.forEach(f => f(...a)) }; };
    const port = { name: "sidebar", sender: { id: "tidier" }, onMessage: mk(), onDisconnect: mk(), postMessage: view => { if (this.ports.get(windowId) === port) this.views.set(windowId, JSON.parse(JSON.stringify(view))); } };
    this.ports.set(windowId, port);
    this.send("down", () => { if (this.ports.get(windowId) !== port) return; this.ext.b.runtime.onConnect.fire(port); this.sidebarSays(windowId, { type: "hello", windowId }); });
  }
  sidebarSays(windowId, msg) {
    const port = this.ports.get(windowId);
    if (!port) return;
    this.trace("sidebar", windowId, JSON.stringify(msg));
    this.send("down", () => {
      if (this.ports.get(windowId) !== port) return;
      for (const f of port.onMessage.ls) {
        try { const r = f(msg); r?.catch?.(err => this.noteUnhandled(err, `sidebar ${msg.type}`)); } catch (err) { this.noteUnhandled(err, `sidebar ${msg.type}`); }
      }
    });
  }
  closeSidebarOf(windowId) {
    const port = this.ports.get(windowId);
    if (!port) return;
    this.ports.delete(windowId);
    this.views.delete(windowId);
    this.send("down", () => port.onDisconnect.ls.forEach(f => f()));
  }

  // --- Big events --------------------------------------------------------------------
  // An update over a running session: the old background page stops without a word, so
  // what it had not written yet is lost; Firefox closes the extension's loaded pages
  // (ext-browser.js "page-shutdown") and shows the tabs it hid (ext-tabs.js showHiddenTabs).
  update() {
    this.ext?.kill();
    this.ext = null;
    this.gen++;
    this.b = this.silent();
    for (const t of [...this.tabs.values()]) if (isPlaceholder(t.url) && !t.discarded) this.closeTab(t.id);
    for (const t of this.tabs.values()) t.hidden = false;
    const x = this.boot();
    x.b.runtime.onInstalled.fire({ reason: "update" });
    return x;
  }

  // Firefox quits and starts again: memory is gone, the session and the storage stay. New
  // IDs for everything. Only the selected and the pinned tabs load. With `session` false
  // the windows are not restored either (a Mac with no window at quit, or a setting).
  restart({ session = true } = {}) {
    this.ext?.kill();
    this.ext = null;
    this.gen++;
    this.b = this.silent();
    for (const w of [...this.wins.values()]) if (w.type !== "normal") this.closeWindow(w.id);
    const oldWins = [...this.wins.values()], oldTabs = this.tabs, oldValues = this.values, oldWinValues = this.winValues;
    this.wins = new Map(); this.tabs = new Map(); this.values = new Map(); this.winValues = new Map();
    this.pages = new WeakMap();
    const focused = this.focused;
    this.focused = undefined;
    const reload = [];
    const windowIds = new Map();
    if (session) {
      for (const w of oldWins) {
        const nw = this.addWindow();
        windowIds.set(w.id, nw.id);
        if (oldWinValues.has(w.id)) this.winValues.set(nw.id, oldWinValues.get(w.id));
        if (focused === w.id) this.focused = nw.id;
        for (const id of w.order) {
          const t = oldTabs.get(id), load = t.active || t.pinned;
          const { id: _id, openerTabId: _opener, successorTabId: _successor, ...kept } = t;
          const fresh = this.addTab(nw.id, { ...kept, windowId: nw.id, discarded: !load, status: "complete", audible: false }, oldValues.get(id));
          if (load) reload.push(fresh);
        }
      }
    }
    if (!this.wins.size) { const w = this.addWindow(); this.addTab(w.id, { url: "about:home", active: true, lastAccessed: this.clock.now }); this.focused = w.id; }
    if (!this.wins.has(this.focused)) this.focused = this.wins.keys().next().value;
    this.closedItems = this.closedItems.flatMap(c => {
      if (c.kind === "window") return [c];
      return windowIds.has(c.windowId) ? [{ ...c, windowId: windowIds.get(c.windowId) }] : [];
    });
    const x = this.boot();
    x.b.runtime.onStartup.fire();
    for (const t of reload) this.load(t, t.url);
    return x;
  }
  // Between two background pages nobody listens.
  silent() {
    const off = { fire() {} };
    return { tabs: new Proxy({}, { get: () => off }), windows: new Proxy({}, { get: () => off }), sessions: new Proxy({}, { get: () => off }) };
  }
}
