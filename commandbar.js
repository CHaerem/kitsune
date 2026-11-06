// The command bar, like Arc's: one key, one field, and everything is reached from it.
// Tabs of all spaces, essentials, folders, what was closed, history and bookmarks if
// you allow it, and commands. Only with Tidier alone.
//
// An extension cannot draw over a page, so the bar is a small popup window of its own
// (windows.create type popup), centred over the window you are in. Tab sync and
// essentials only look at normal windows, so they leave it alone. A toolbar button's
// popup would have no frame at all, but opens hanging from the button, and with
// Tidier's button in the Extensions menu and the toolbar in the sidebar (or hidden, in
// compact mode) that is not where you are looking.
//
// This part gathers what can be found when the key is pressed, without waiting for the
// queue, since the bar must open at once also when Tidier is busy, and carries out what
// you choose. The bar's page (commandbar/) ranks by itself on every key press. Nothing
// here runs unless you press the key: while the bar is open it works on what it was
// given, and it is short-lived enough that nothing has to keep that up to date.

const BAR_PAGE = "commandbar/commandbar.html";
// A field and eight rows, under a title bar on a Mac and with userChrome.css's margins. It
// never changes, so nothing jumps while you type.
const BAR_WIDTH = 640, BAR_HEIGHT = 432;
const BAR_OPEN_LIMIT_MS = 10000; // a window that never came must not take the key for good
// ⌘⇧K on a Mac (Firefox reads Ctrl as ⌘ there). The plain ⌘K and ⌘T would be nicer, but
// Firefox keeps those for itself; ⌘T goes to the bar as soon as Firefox lets go of it
// (customKeys.json in the dotfiles), through a second command that does nothing until then.
const BAR_KEY = "Ctrl+Shift+K", BAR_KEY_FREED = "Ctrl+T";
const BAR_ASK_SIDEBAR_MS = 100; // a sidebar answers at once; none must not hold up the bar
const CLOSED_LOOKED_AT = 25; // Firefox's list of closed tabs holds about this many anyway
const BAR_ASKED = "commandBarAsked"; // storage: history and bookmarks have been asked for, so the row does not come back

let commandBar = null; // the open bar: { id, from, pressedAt, snapshot (a promise), ctx, closeOnOpen }

const barUses = storedValue("commandUses", () => ({})); // command name -> how often: "the most used"

// The window to open from: the one you are in. A sign-in popup or another bar is not a
// window to open tabs in, so then any normal window.
async function barSourceWindow(tab) {
  const id = tab?.windowId ?? focusedWindowId;
  const win = await browser.windows.get(id).catch(() => null);
  return win?.type === "normal" && !win.incognito ? win : (await normalWindows())[0] ?? null;
}

// The key: opens the bar, or closes the one that is open.
async function toggleCommandBar(tab) {
  if (commandBar?.id === null && Date.now() - commandBar.pressedAt > BAR_OPEN_LIMIT_MS) commandBar = null;
  if (commandBar?.id === null) { commandBar.closeOnOpen = !commandBar.closeOnOpen; return; } // what the presses add up to is settled once it is there
  if (commandBar) return barClose(commandBar, true);
  const bar = commandBar = { id: null, from: null, pressedAt: Date.now(), snapshot: null, ctx: null, closeOnOpen: false };
  try {
    const from = await barSourceWindow(tab);
    if (!from) { commandBar = null; return; }
    bar.from = from.id;
    bar.snapshot = barSnapshot(bar).catch(err => { noteError(err); return null; }); // ready by the time the page asks
    const win = await browser.windows.create({ type: "popup", url: BAR_PAGE, allowScriptsToClose: true, width: BAR_WIDTH, height: BAR_HEIGHT, ...barPlaceOver(from) });
    bar.id = win.id;
    if (bar.closeOnOpen) await barClose(bar, true);
  } catch (err) {
    if (commandBar === bar) commandBar = null;
    noteError(err);
  }
}

// In the middle of the window, a bit above the middle, where you look. A window with no
// position to tell (a minimised one) leaves it to Firefox, which centres it on the screen.
function barPlaceOver(win) {
  if (![win.left, win.top, win.width, win.height].every(Number.isFinite)) return {};
  return { left: Math.round(win.left + (win.width - BAR_WIDTH) / 2), top: Math.round(win.top + Math.max(48, (win.height - BAR_HEIGHT) / 4)) };
}

async function barClose(bar, refocus) {
  if (commandBar === bar) commandBar = null;
  await browser.windows.remove(bar.id).catch(() => {});
  // Not after losing the focus: you clicked somewhere else, and that is where you want to be.
  if (refocus) await browser.windows.update(bar.from, { focused: true }).catch(() => {});
}

browser.windows.onRemoved.addListener(id => { if (commandBar?.id === id) commandBar = null; });
browser.commands.onCommand.addListener((name, tab) => {
  if ((name === "command-bar" || name === "command-bar-t") && tidierAlone && started) toggleCommandBar(tab).catch(noteError);
});

// --- What the bar works on ---------------------------------------------------------
// The selection lives only in the sidebar, which answers for its own window
// (sidebar/commandbar-link.js). No sidebar, or nothing selected: this tab.
async function barPickedTabs(windowId, tab, tabs) {
  if (!tab) return [];
  const answer = await Promise.race([
    browser.runtime.sendMessage({ type: "commandBarSelection", windowId, tabId: tab.id }).catch(() => null),
    sleep(BAR_ASK_SIDEBAR_MS).then(() => null),
  ]);
  const picked = (Array.isArray(answer) ? answer : []).map(id => tabs.find(t => t.id === id)).filter(Boolean);
  return picked.length ? picked : [tab];
}

// A row is not its tab: a placeholder's own address, title and last use say nothing.
function barAddressOf(tab, all, list) {
  if (isWeb(tab.url)) return tab.url;
  return all[syncKeyByTab.get(tab.id)]?.url ?? list.find(e => e.key === keyByTab.get(tab.id))?.url ?? null;
}

async function barContext(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  const list = await getList();
  const used = new Set([...list.map(e => e.cookieStoreId), ...tabs.map(t => t.cookieStoreId)]);
  const spaces = await spaceList(used);
  const space = await spaceOf(windowId, tabs, spaces);
  const all = await getSynced();
  const tab = tabs.find(t => t.active) ?? null;
  const picked = await barPickedTabs(windowId, tab, tabs);
  const closed = (await browser.sessions.getRecentlyClosed({ maxResults: CLOSED_LOOKED_AT }).catch(() => []))
    .filter(c => c.tab && isWeb(c.tab.url));
  return {
    windowId, spaces, space, tab, picked, closed, all,
    addresses: picked.map(t => barAddressOf(t, all, list)).filter(Boolean),
    key: tab ? syncKeyByTab.get(tab.id) : undefined,
  };
}

// A number in a label, when there are several: "Close 3 tabs".
const barCount = (ctx, one, many) => ctx.picked.length > 1 ? many.replace("#", ctx.picked.length) : one;
const barOnlyThisTab = ctx => ctx.picked.length === 1 && !!ctx.tab;
const barMovable = ctx => ctx.picked.length > 0 && ctx.picked.every(t => !t.pinned);

// --- The commands ------------------------------------------------------------------
// One table: a name (the same as the shortcut's in manifest.json, if it has one, so the
// row can show its key), a label, when it applies, and what it does. What it needs from
// you the bar asks in its own field, a text (`ask`) or one of a list (`list`), so no
// other window or menu is involved. The commands of shortcuts.js come along at the end.
// A command that does not apply is left out; nothing is ever greyed.
//
// `run` is carried out in the queue, and everything goes through what the sidebar uses,
// so other windows follow.
const BAR_COMMANDS = [
  { name: "new-tab", label: "New tab", run: ctx => barOpenTab(ctx) },
  { name: "new-folder", label: "New folder", ask: () => ({ placeholder: "Name of the new folder" }),
    run: (ctx, name) => createFolder(name || "New folder", ctx.space) },
  { name: "reopen-closed", label: "Reopen closed tab", when: ctx => ctx.closed.length > 0,
    run: ctx => browser.sessions.restore(ctx.closed[0].tab.sessionId) },
  { name: "go-to-space", each: ctx => ctx.spaces.filter(s => s.id !== ctx.space).map(s => ({ label: `Go to ${s.name}`, value: s.id, space: s.id })),
    run: (ctx, space) => switchSpace(ctx.windowId, space) },
  { name: "clear-today", label: "Clear today's tabs", when: () => typeof clearSpace === "function", run: ctx => clearSpace(ctx.windowId, ctx.space) },
  { name: "copy-url", label: ctx => barCount(ctx, "Copy address", "Copy # addresses"), when: ctx => ctx.addresses.length > 0,
    run: ctx => navigator.clipboard.writeText(ctx.addresses.join("\n")) },
  { name: "rename-tab", label: "Rename this tab", when: ctx => barOnlyThisTab(ctx) && typeof renameTab === "function" && barIsKept(ctx),
    ask: ctx => ({ placeholder: "A name, or nothing for the page's title", value: ctx.tab.title }),
    run: (ctx, name) => renameTab(ctx.tab.id, name) },
  { name: "rename-folder", label: "Rename this folder", when: ctx => barOnlyThisTab(ctx) && !!barOwnFolderOf(ctx),
    ask: ctx => ({ placeholder: "Name of the folder", value: barOwnFolderOf(ctx).name }),
    run: (ctx, name) => renameFolder(barFolderKey(ctx), name) },
  { name: "unload", label: ctx => barCount(ctx, "Unload this tab", "Unload # tabs"), when: ctx => ctx.picked.some(t => !t.discarded && !isGhostUrl(t.url)), run: barUnload },
  { name: "toggle-essential", label: ctx => ctx.tab.pinned ? "Remove from essentials" : "Make this tab an essential",
    when: ctx => barOnlyThisTab(ctx) && (ctx.tab.pinned || isWeb(ctx.tab.url)),
    run: ctx => sidebarAction(ctx.windowId, { type: "pin", tabId: ctx.tab.id, pinned: !ctx.tab.pinned }) },
  { name: "move-to-folder", label: ctx => barCount(ctx, "Move to folder", "Move # tabs to folder"), when: ctx => barMovable(ctx) && ctx.picked.every(t => syncKeyByTab.has(t.id) || isWeb(t.url)),
    list: ctx => [{ label: "No folder", value: "" }, ...foldersOf(ctx.all, ctx.picked[0].cookieStoreId).filter(f => !f.live).map(f => ({ label: f.name, value: f.key }))],
    placeholder: "Which folder?",
    run: async (ctx, folder) => {
      for (const t of ctx.picked) {
        await register(t.id); // a tab opened a moment ago may have no record yet, and a move would only change its place
        await sidebarAction(ctx.windowId, { type: "moveTab", tabId: t.id, folder: folder || null });
      }
    } },
  { name: "move-to-space", label: ctx => barCount(ctx, "Move to space", "Move # tabs to space"), when: barMovable,
    list: ctx => ctx.spaces.filter(s => !ctx.picked.every(t => t.cookieStoreId === s.id)).map(s => ({ label: s.name, value: s.id, space: s.id })),
    placeholder: "Which space?",
    run: async (ctx, space) => { for (const t of ctx.picked) await sidebarAction(ctx.windowId, { type: "moveToSpace", tabId: t.id, space }); } },
  { name: "close-tab", label: ctx => barCount(ctx, "Close this tab", "Close # tabs"), when: ctx => ctx.picked.length > 0,
    run: async ctx => { for (const t of ctx.picked) await (globalThis.closeFromSidebar?.(ctx.windowId, t.id) ?? browser.tabs.remove(t.id).catch(() => {})); } },
  { name: "settings", label: "Settings", run: () => browser.runtime.openOptionsPage() },
];

const barFolderKey = ctx => folderKeyOf(ctx.all, ctx.key);
const barOwnFolderOf = ctx => { const f = ctx.all[barFolderKey(ctx)]; return isOwnFolder(f) && !f.live ? f : null; };
const barIsKept = ctx => ctx.tab.pinned || !!ctx.all[ctx.key]?.saved;

// The tab's real page, also of a placeholder, is what can be unloaded (the tab menu's own
// way when it is there, tabactions.js). The tab you are on must first make way: Firefox
// will not unload a selected tab.
async function barUnload(ctx) {
  if (typeof tabAction === "function") return tabAction(ctx.windowId, { action: "unload", tabIds: ctx.picked.map(t => t.id) });
  for (const t of ctx.picked) {
    const key = syncKeyByTab.get(t.id);
    const real = await browser.tabs.get((key && liveTabId(key)) ?? t.id).catch(() => null);
    if (!real || real.discarded || isGhostUrl(real.url)) continue;
    if (real.active) {
      const next = await lastUsedIn(real.windowId, real.cookieStoreId, real.id);
      if (!next) continue;
      await browser.tabs.update(next.id, { active: true }).catch(() => {});
    }
    await browser.tabs.discard(real.id).catch(() => {});
    if (!(await browser.tabs.get(real.id).catch(() => null))?.discarded) globalThis.say?.(ctx.windowId, "That page holds unsaved input and stayed loaded");
  }
}

// What shortcuts.js can do and this table does not have. A numbered key has no use here,
// and Firefox only carries out the sidebar's own command itself, on a key press.
const barSharedCommands = () => (typeof COMMANDS === "undefined" ? [] : COMMANDS)
  .filter(c => !/^(space|tab)-\d$/.test(c.name) && c.name !== "_execute_sidebar_action" && !BAR_COMMANDS.some(b => b.name === c.name));

// The rows for the commands that apply, most used first.
function barCommandRows(ctx, uses, shortcuts) {
  const rows = [];
  const row = (command, shown) => rows.push({
    kind: "command", id: `command:${command.name}:${shown.value ?? ""}`, name: command.name, title: shown.label, value: shown.value, space: shown.space, here: true,
    shortcut: shortcuts.get(command.name) || null, placeholder: command.placeholder,
    ask: command.ask?.(ctx), list: command.list?.(ctx).map(c => ({ kind: "choice", id: `choice:${c.value}`, title: c.label, value: c.value, space: c.space, here: true })),
  });
  for (const command of BAR_COMMANDS) {
    if (command.when && !command.when(ctx)) continue;
    if (command.each) for (const shown of command.each(ctx)) row(command, shown);
    else row(command, { label: typeof command.label === "function" ? command.label(ctx) : command.label });
  }
  for (const command of barSharedCommands()) row(command, { label: command.label });
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => (uses[b.name] ?? 0) - (uses[a.name] ?? 0) || i - j).map(([r]) => r);
}

// --- What can be found -------------------------------------------------------------
// Every tab of every space, from the record: a placeholder's own address, title and last
// use are the placeholder's. Only the tab's real, live copy says when it was last used.
async function barTabItems(ctx) {
  const all = ctx.all;
  const list = await getList();
  const normal = new Set((await normalWindows()).map(w => w.id));
  const tabs = (await browser.tabs.query({})).filter(t => normal.has(t.windowId));
  const here = s => s === ctx.space || s === NO_CONTAINER; // as the sidebar shows them
  const repsByKey = new Map();
  for (const t of tabs) {
    const key = syncKeyByTab.get(t.id);
    if (key) (repsByKey.get(key) ?? repsByKey.set(key, []).get(key)).push(t);
  }
  const items = [];
  for (const [key, entry] of Object.entries(all)) {
    if (isOwnFolder(entry)) {
      items.push({ kind: "folder", id: `folder:${key}`, key, title: entry.name, space: entry.cookieStoreId, here: here(entry.cookieStoreId) });
      continue;
    }
    const reps = repsByKey.get(key);
    if (entry.group || !reps) continue; // Sidebery's folder pages, or a tab no window has any more
    const live = reps.find(t => syncRoleByTab.get(t.id) === "live");
    const used = live && !isGhostUrl(live.url) ? live.lastAccessed : 0;
    items.push({
      kind: "tab", id: `tab:${key}`, key, title: entry.name || entry.title || entry.url, url: entry.url, icon: entry.icon || null,
      space: entry.cookieStoreId, here: here(entry.cookieStoreId), lastUsed: Math.max(used || 0, entry.added || 0), current: reps.some(t => t.id === ctx.tab?.id),
    });
  }
  const pinned = tabs.filter(t => t.pinned);
  const keys = await Promise.all(pinned.map(keyOf));
  for (const e of list) {
    const copies = pinned.filter((t, i) => keys[i] === e.key);
    if (!copies.length) continue;
    items.push({
      kind: "essential", id: `essential:${e.key}`, key: e.key, title: e.name || e.title || e.url, url: e.url, icon: e.icon || null,
      space: e.cookieStoreId, here: here(e.cookieStoreId), lastUsed: Math.max(0, ...copies.filter(t => isWeb(t.url)).map(t => t.lastAccessed || 0)),
      current: copies.some(t => t.id === ctx.tab?.id),
    });
  }
  // Pages that are in no record (settings, about: pages), but not an empty new tab.
  for (const t of tabs) {
    if (t.pinned || syncKeyByTab.has(t.id) || isGhostUrl(t.url) || NEW_TAB_PAGES.has(t.url)) continue;
    const space = t.cookieStoreId === NO_CONTAINER ? null : t.cookieStoreId;
    items.push({
      kind: "tab", id: `page:${t.id}`, tabId: t.id, title: t.title || t.url, url: t.url, icon: t.favIconUrl || null,
      space, here: !space || here(space), lastUsed: t.lastAccessed || 0, current: t.id === ctx.tab?.id,
    });
  }
  return items;
}

function barClosedItems(ctx) {
  // Firefox's list has the container only sometimes, so no dot without it.
  return ctx.closed.map(({ tab, lastModified }) => ({
    kind: "closed", id: `closed:${tab.sessionId}`, sessionId: tab.sessionId, title: tab.title || tab.url, url: tab.url, icon: tab.favIconUrl || null,
    space: tab.cookieStoreId && tab.cookieStoreId !== NO_CONTAINER ? tab.cookieStoreId : null, lastUsed: lastModified,
  }));
}

// From Tidier's own list of what archiving closed, when it has one (archivelist.js).
async function barArchivedItems() {
  const archived = (await globalThis.archivedTabs?.()) ?? [];
  return archived.map((a, i) => ({
    kind: "archived", id: `archived:${i}:${a.url}`, title: a.title || a.url, url: a.url, icon: a.icon || null, space: a.space ?? a.cookieStoreId ?? null, lastUsed: a.when, archived: a,
  }));
}

// All the bar's page needs, once.
async function barSnapshot(bar) {
  const ctx = bar.ctx = await barContext(bar.from);
  const [tabs, archived, uses, stored, commands, { os }] = await Promise.all([
    barTabItems(ctx), barArchivedItems(), barUses.get(), browser.storage.local.get(BAR_ASKED),
    browser.commands.getAll(), browser.runtime.getPlatformInfo(),
  ]);
  const shortcuts = new Map(commands.map(c => [c.name, c.shortcut]));
  const space = ctx.spaces.find(s => s.id === ctx.space);
  return {
    pressedAt: bar.pressedAt, space: ctx.space, color: space?.color ?? null, mac: os === "mac", asked: !!stored[BAR_ASKED],
    spaces: ctx.spaces.map(s => ({ id: s.id, name: s.name, color: s.color })),
    items: [...tabs, ...barClosedItems(ctx), ...archived, ...barCommandRows(ctx, uses, shortcuts)],
  };
}

// --- Carrying out what you chose -----------------------------------------------------
// In the active space, in the place new tabs go.
async function barNewTabProps(ctx, url) {
  const index = await globalThis.topOfToday?.(ctx.windowId, ctx.space);
  return {
    windowId: ctx.windowId, active: true,
    ...(ctx.space && ctx.space !== NO_CONTAINER ? { cookieStoreId: ctx.space } : {}),
    ...(url ? { url } : {}), ...(index === undefined ? {} : { index }),
  };
}
async function barOpenTab(ctx, url) {
  return browser.tabs.create(await barNewTabProps(ctx, url));
}

// A search you asked for here stays here, also where a rule knows the search engine's
// address. Firefox's default engine, whichever that is: only Firefox itself can read
// that, and the tab must exist first, as search.search cannot pick a container.
async function barSearch(ctx, query) {
  if (!browser.search) return; // the bar's page asks for the permission first
  const props = await barNewTabProps(ctx, "about:blank");
  const tab = await (globalThis.openUnruled?.(props) ?? browser.tabs.create(props));
  await browser.search.search({ query, tabId: tab.id });
}

// Selecting this window's copy of the tab does the rest, as a click in the sidebar does:
// the selected tab decides the space (spaces.js), and a placeholder pulls in its real
// tab (tabsync.js). A page in no record can be in another window only.
async function barGoToTab(ctx, row) {
  const here = await browser.tabs.query({ windowId: ctx.windowId });
  let target;
  if (row.kind === "essential") {
    const pinned = here.filter(t => t.pinned);
    const keys = await Promise.all(pinned.map(keyOf));
    target = pinned[keys.indexOf(row.key)];
  } else if (row.key) {
    // (A window still being filled may not have its copy yet.)
    target = here.find(t => syncKeyByTab.get(t.id) === row.key) ?? await browser.tabs.get(liveTabId(row.key)).catch(() => null);
  } else {
    target = await browser.tabs.get(row.tabId).catch(() => null);
  }
  if (!target) return row.url ? barOpenTab(ctx, row.url) : undefined; // it has gone since the bar opened
  if (target.windowId !== ctx.windowId) await browser.windows.update(target.windowId, { focused: true });
  return browser.tabs.update(target.id, { active: true });
}

async function barGoToFolder(ctx, key) {
  const entry = (await getSynced())[key];
  if (!isOwnFolder(entry)) return;
  if (entry.collapsed) await foldFolder(key, false); // you asked for it, so this one opens
  if (entry.cookieStoreId !== ctx.space) await switchSpace(ctx.windowId, entry.cookieStoreId);
  viewSoon(ctx.windowId);
}

async function barReopenClosed(ctx, row) {
  await browser.sessions.restore(row.sessionId).catch(err => (row.url ? barOpenTab(ctx, row.url) : Promise.reject(err)));
}

async function barReopenArchived(ctx, row) {
  if (globalThis.reopenArchived) return globalThis.reopenArchived(row.archived);
  return barOpenTab(row.space ? { ...ctx, space: row.space } : ctx, row.url);
}

async function barRunCommand(ctx, row, value) {
  const shared = barSharedCommands().find(c => c.name === row.name);
  const command = BAR_COMMANDS.find(c => c.name === row.name);
  if (shared) await shared.action(ctx.windowId); // goes through the queue by itself where it must
  else if (command) await serial(() => command.run(ctx, value ?? row.value));
  else return;
  const uses = await barUses.get();
  barUses.set({ ...uses, [row.name]: (uses[row.name] ?? 0) + 1 });
}

async function barCarryOut(ctx, { row, inNewTab, value }) {
  if (row.kind === "command") return barRunCommand(ctx, row, value);
  if (row.kind === "search") return barSearch(ctx, row.query);
  if (row.kind === "folder") return serial(() => barGoToFolder(ctx, row.key));
  if (row.kind === "closed") return barReopenClosed(ctx, row);
  if (row.kind === "archived") return barReopenArchived(ctx, row);
  if (row.kind === "tab" || row.kind === "essential") return inNewTab && row.url ? barOpenTab(ctx, row.url) : barGoToTab(ctx, row);
  if (row.url) return barOpenTab(ctx, row.url); // an address, a bookmark, something from history
}

// --- The bar's page ------------------------------------------------------------------
browser.runtime.onConnect.addListener(port => {
  if (port.name !== "commandbar" || port.sender?.id !== browser.runtime.id) return;
  const windowId = port.sender.tab?.windowId;
  const bar = commandBar;
  // A bar Firefox brought back with the session, or the page opened by hand. The window
  // is only removed if it is the bar's own: the page could be a tab in a normal window.
  if (!bar || (bar.id !== null && bar.id !== windowId)) {
    browser.windows.get(windowId).then(win => (win.type === "popup" ? browser.windows.remove(windowId) : browser.tabs.remove(port.sender.tab.id))).catch(() => {});
    return;
  }
  bar.id = windowId; // the page can be here before windows.create has answered
  bar.snapshot.then(snapshot => port.postMessage(snapshot ?? { pressedAt: bar.pressedAt, items: [], spaces: [] }));
  port.onMessage.addListener(async msg => {
    if (msg.type === "close") await barClose(bar, msg.refocus);
    else if (msg.type === "asked") await browser.storage.local.set({ [BAR_ASKED]: true });
    else if (msg.type === "choose" && !bar.chosen) { // Enter pressed twice is one choice
      bar.chosen = true;
      await barClose(bar, true); // first: only the window you are in may pull a tab in, and Firefox opens what follows in the top window
      if (bar.ctx) await barCarryOut(bar.ctx, msg).catch(noteError);
    }
  });
  port.onDisconnect.addListener(() => { // also when the page crashed: no window stays behind
    if (commandBar === bar) barClose(bar, false);
  });
});

// A key that works today, given only with Tidier alone (spaces.js): the manifest reaches
// machines still on Sidebery, and with the setting off the command has no key. A key
// you have changed yourself stays.
async function giveCommandBarKey(commands) {
  for (const [name, shortcut] of [["command-bar", BAR_KEY], ["command-bar-t", BAR_KEY_FREED]]) {
    if (commands.some(c => c.name === name && !c.shortcut)) await browser.commands.update({ name, shortcut }).catch(noteError);
  }
}
