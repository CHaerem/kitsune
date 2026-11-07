// What the commands of shortcuts.js do with Tidier alone, and how they get their keys.
//
// Firefox's own next tab and ⌘1 count the window's tabs: other spaces' pinned tabs, and
// tabs in the order they were opened. Here the list is what the sidebar draws, in the
// order it draws it. Selecting a row is what a click on it does: selecting a placeholder
// pulls its real tab in (tabsync.js).

// The tabs as drawn: the space's essentials, each folder's tabs, today's tabs. A closed
// folder draws only the selected tab, if it holds it.
function tabsAsDrawn(view) {
  return [...view.essentials, ...view.folders.flatMap(f => f.collapsed ? f.tabs.filter(t => t.active) : f.tabs), ...view.tabs];
}

// The item `by` steps from the selected one, round the ends as Firefox's own keys go.
function stepFrom(items, isSelected, by) {
  if (!items.length) return null;
  const at = items.findIndex(isSelected);
  if (at < 0) return by > 0 ? items[0] : items.at(-1);
  return items[(at + by + items.length) % items.length];
}

async function selectRow(item) {
  if (item && !item.active) await browser.tabs.update(item.id, { active: true }).catch(() => {});
}
async function stepTab(windowId, by) {
  await selectRow(stepFrom(tabsAsDrawn(await viewFor(windowId)), t => t.active, by));
}
async function nthTab(windowId, n) {
  await selectRow(tabsAsDrawn(await viewFor(windowId))[n - 1]);
}
async function stepSpace(windowId, by) {
  const { spaces, space } = await viewFor(windowId);
  const next = stepFrom(spaces, s => s.id === space, by);
  if (next && next.id !== space) await switchSpace(windowId, next.id);
}

// As dragging to the essentials does. A page without an address on the web cannot be
// an essential (onPinned in essentials.js), and would stay pinned as nothing at all.
async function toggleEssential(windowId) {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (tab && (tab.pinned || isWeb(tab.url))) await browser.tabs.update(tab.id, { pinned: !tab.pinned }).catch(noteError);
}

// The view that draws the new folder also names it, so that the sidebar can start
// renaming it once it is there, if it has the keyboard (sidebar/keyrename.js).
async function newFolderHere(windowId) {
  const { space } = await viewFor(windowId);
  if (!space) return; // no containers at all: no space for it to be in
  const key = await createFolder("New folder", space);
  const view = await viewFor(windowId);
  for (const port of sidebarPorts.get(windowId) || []) port.postMessage({ ...view, renameFolder: key });
}

// --- Giving the keys ---------------------------------------------------------------
// Each key is given once, at the first start with Tidier alone that knows the command,
// and only if that command has none. What you do with it after that is yours: a key you
// changed stays, and so does one you removed (Firefox then says it has none, which is
// why "has none" alone is not enough, and the names given are kept).
const KEYS_GIVEN = "keysGiven";

// ⌃ exists only on a Mac; elsewhere those keys are Ctrl, and ⌘⌃ becomes Ctrl and Alt.
const keyForSystem = (key, os) => os === "mac" ? key : key.replace("Ctrl+MacCtrl", "Ctrl+Alt").replace("MacCtrl", "Ctrl");

// Two ways of writing one key compare equal: on a Mac Firefox reads Ctrl as Command,
// and the order of the modifiers means nothing.
function keyId(shortcut, os) {
  if (!shortcut) return "";
  const parts = shortcut.split("+"), key = parts.pop();
  return [...parts.map(m => os === "mac" && m === "Ctrl" ? "Command" : m).sort(), key].join("+");
}

// `commands` is Firefox's list ({ name, shortcut }), `given` the names given before.
// A key some other command already has is left out rather than doubled.
function keysToGive(table, commands, given, os) {
  const taken = new Set(commands.map(c => keyId(c.shortcut, os)).filter(Boolean));
  const give = [];
  for (const { name, key } of table) {
    const command = commands.find(c => c.name === name);
    if (!key || !command || command.shortcut || given.includes(name)) continue;
    const shortcut = keyForSystem(key, os);
    if (taken.has(keyId(shortcut, os))) continue;
    taken.add(keyId(shortcut, os));
    give.push({ name, shortcut });
  }
  return give;
}

async function giveKeys() {
  const { os } = await browser.runtime.getPlatformInfo();
  const commands = await browser.commands.getAll();
  const given = (await browser.storage.local.get(KEYS_GIVEN))[KEYS_GIVEN] ?? [];
  const named = COMMANDS.filter(c => c.key && commands.some(x => x.name === c.name)).map(c => c.name);
  if (named.every(name => given.includes(name))) return; // the usual start: nothing to change
  const failed = new Set();
  for (const update of keysToGive(COMMANDS, commands, given, os)) {
    await browser.commands.update(update).catch(err => { failed.add(update.name); noteError(err); });
  }
  // Only what failed is tried again at the next start: for the others, no key is now your choice.
  await browser.storage.local.set({ [KEYS_GIVEN]: named.filter(name => !failed.has(name)) });
}

// The key each command starts with, as a machine with no keys at all would get them.
const firstKeys = os => new Map(keysToGive(COMMANDS, COMMANDS.map(({ name }) => ({ name, shortcut: "" })), [], os).map(g => [g.name, g.shortcut]));

// Back to Sidebery: the keys are the manifest's again, and a move over later gives them anew.
// Not the key to copy an address, which is the one command Sidebery's browser has too.
async function takeKeysBack() {
  for (const { name, key, always } of COMMANDS) if (key && !always) await browser.commands.reset(name).catch(() => {});
  await browser.storage.local.set({ [KEYS_GIVEN]: [] });
}

// Tidier alone can also end without moving back: declared in managed storage, then no
// longer. With the setting off the commands do nothing, so ⌘1 would be a key that does
// nothing. Only a read at each start, unless keys were given.
async function takeKeysBackIfGiven() {
  if ((await browser.storage.local.get(KEYS_GIVEN))[KEYS_GIVEN]?.length) await takeKeysBack();
}

// --- The settings page ------------------------------------------------------------
const KEY_SYMBOLS = { Command: "⌘", MacCtrl: "⌃", Alt: "⌥", Shift: "⇧", Up: "↑", Down: "↓", Left: "←", Right: "→", Comma: ",", Period: ".", Space: "Space", PageUp: "Page Up", PageDown: "Page Down" };
// As a Mac's menus write a key: ⌃⌥⇧⌘ in that order, then the key. Elsewhere as Firefox writes it.
function prettyKey(shortcut, os) {
  if (!shortcut) return "";
  if (os !== "mac") return shortcut;
  const parts = shortcut.split("+"), key = parts.pop();
  const mods = parts.map(m => m === "Ctrl" ? "Command" : m);
  return ["MacCtrl", "Alt", "Shift", "Command"].filter(m => mods.includes(m)).map(m => KEY_SYMBOLS[m]).join("") + (KEY_SYMBOLS[key] ?? key);
}

// Keys only Firefox can have on a Mac: its tab box handles them before any <key>, and
// about:keyboard has no say over them (ShortcutUtils.getSystemActionForEvent).
const FIREFOX_ONLY = new Set(["Alt+Command+Up", "Alt+Command+Down", "Alt+Command+Left", "Alt+Command+Right", "MacCtrl+PageUp", "MacCtrl+PageDown", "MacCtrl+Shift+PageUp", "MacCtrl+Shift+PageDown"]);
// Firefox's own keys on a Mac, for the note when you choose one. Those it never lets a
// page see (⌘T, ⌘W, ⌘N, ⌘Q, ⌘⇧W, ⌘⇧P) cannot be chosen here at all.
const FIREFOX_KEYS = {
  "Command+L": "the address bar", "Command+K": "search", "Alt+Command+F": "search", "Command+J": "downloads", "Command+Shift+A": "add-ons", "Command+O": "opening a file",
  "Command+P": "printing", "MacCtrl+M": "muting a tab", "Command+Z": "undo", "Command+Shift+Z": "redo", "Command+X": "cut", "Command+C": "copy", "Command+V": "paste", "Command+A": "select all",
  "Command+Left": "back", "Command+Right": "forward", "Command+Y": "history", "Command+MacCtrl+F": "full screen", "Command+Shift+F": "full screen", "Command+R": "reload", "Command+Shift+R": "reload",
  "Command+U": "the page's source", "Command+I": "page info", "Command+F": "find", "Command+G": "find again", "Command+Shift+G": "find again", "Command+E": "find the selection",
  "Command+D": "bookmarking a page", "Command+Shift+D": "bookmarking all tabs", "Command+Shift+O": "bookmarks", "Command+S": "saving a page", "Command+Shift+S": "screenshots", "Command+Period": "stop",
  "Command+1": "going to a tab", "Command+2": "going to a tab", "Command+3": "going to a tab", "Command+4": "going to a tab", "Command+5": "going to a tab",
  "Command+6": "going to a tab", "Command+7": "going to a tab", "Command+8": "going to a tab", "Command+9": "going to a tab", "Command+0": "zoom", "Command+Comma": "settings", "Command+Shift+T": "reopening a tab", "Command+Shift+N": "reopening a window", "Command+Shift+X": "text direction", "Command+M": "minimizing the window",
  "Command+H": "hiding Firefox", "Alt+Command+H": "hiding other apps", "MacCtrl+X": "the chat sidebar", "MacCtrl+U": "the open tabs sidebar", "MacCtrl+Z": "the sidebar",
  "Command+B": "bookmarks", "Command+Shift+B": "the bookmarks toolbar", "Command+Shift+H": "history", "Command+Shift+Delete": "clearing history", "Alt+Home": "the home page", "Alt+Command+R": "reader view", "Alt+Command+U": "the page's source",
  "Alt+Command+C": "the developer tools", "Alt+Command+E": "the developer tools", "Alt+Command+I": "the developer tools", "Alt+Command+K": "the developer tools", "Alt+Command+M": "the developer tools", "Alt+Command+W": "the developer tools", "Alt+Command+Z": "the developer tools", "Command+Shift+J": "the developer tools",
  "F3": "find again", "Shift+F3": "find again", "F5": "reload", "F11": "full screen", "F12": "the developer tools", "Shift+F5": "the developer tools", "Shift+F7": "the developer tools", "Shift+F9": "the developer tools", "Shift+F12": "the developer tools",
};

// What the settings page lists: every command with a key to give, and that key now.
async function commandKeys() {
  if (!tidierAlone) return null;
  const { os } = await browser.runtime.getPlatformInfo();
  const have = await browser.commands.getAll(), first = firstKeys(os);
  return COMMANDS.filter(c => c.key).map(({ name, label }) => {
    const shortcut = have.find(x => x.name === name)?.shortcut ?? "";
    return { name, label, pretty: prettyKey(shortcut, os), changed: keyId(shortcut, os) !== keyId(first.get(name), os) };
  });
}

// A key you chose. Refused if it could not work or another command has it, and said if
// Firefox uses it too (shortcuts.js says what that does). { refused } or { note }.
async function setCommandKey(name, shortcut) {
  const { os } = await browser.runtime.getPlatformInfo();
  const id = keyId(shortcut, os), pretty = prettyKey(shortcut, os);
  if (shortcut) {
    if (os === "mac" && FIREFOX_ONLY.has(id)) return { refused: `Firefox keeps ${pretty} for itself.` };
    const other = (await browser.commands.getAll()).find(c => c.name !== name && keyId(c.shortcut, os) === id);
    if (other) return { refused: `${pretty} is already “${COMMANDS.find(c => c.name === other.name)?.label ?? other.name}”.` };
  }
  try { await browser.commands.update({ name, shortcut }); } catch (err) { return { refused: `${pretty} cannot be used for a shortcut.` }; }
  const use = os === "mac" && FIREFOX_KEYS[id];
  if (!use) return {};
  return { note: /\+[A-Z]$/.test(id)
    ? `Firefox uses ${pretty} for ${use}, and comes first until you clear it in about:keyboard.`
    : `Firefox uses ${pretty} for ${use} too, and both happen until you clear it in about:keyboard.` };
}

// Every key as it was given. All together, so that keys you swapped cannot be in each
// other's way, as they would be one by one through setCommandKey.
async function keysBackToFirst() {
  const first = firstKeys((await browser.runtime.getPlatformInfo()).os);
  for (const { name, key } of COMMANDS) if (key) await browser.commands.update({ name, shortcut: first.get(name) ?? "" }).catch(noteError);
}
