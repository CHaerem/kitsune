// What Tidier can do from a key, in one table, shared with the command bar: each
// command has a name (the one in manifest.json), a label (the manifest's description,
// which Firefox's own page shows too; a unit test keeps the two the same), the key
// Tidier gives it (keys-commands.js) and an action that takes the window. The keys are
// changed on the settings page.
//
// Arc's keys, where Firefox lets an extension have them. "Ctrl" means ⌘ on a Mac, as
// Firefox writes it, and "MacCtrl" means ⌃. The keys are not in the manifest, since it
// reaches machines still on Sidebery, whose keys they would take.
//
// - ⌘⌥ and an arrow, Arc's next and previous tab and space, cannot be had: Firefox's
//   tab box takes them first (ShortcutUtils.getSystemActionForEvent), and about:keyboard
//   has no say over it. So ⌃⌘ and an arrow, one finger along.
// - ⌘1 to ⌘9, ⌘D and ⌘⇧C work once Firefox's own keys are cleared in about:keyboard
//   (customKeys.json in the dotfiles). Firefox's key on a letter comes first, and an
//   extension's never acts. On a digit both act when the keyboard is in a page: an
//   extension's key acts on keydown, but the page's process has by then also been sent the
//   keypress, and Firefox's key acts when that comes back.
// - Copying the address is the one command that works without Tidier alone too.

async function copyUrl(windowId) {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (tab && isWeb(tab.url)) await navigator.clipboard.writeText(tab.url);
}

// Through the queue: selecting a placeholder pulls its real tab in, which changes the
// tabs, so a key held down must see the outcome of the press before it.
const inQueue = fn => windowId => serial(() => fn(windowId));

// A key held down repeats, and Firefox does not tell a command so. Going through tabs may
// go on; what makes something may not, or a long press of ⌥⌘N is a row of folders, and one
// of ⌘D pins and unpins the tab, opening and closing its copies in every window. No
// key-up reaches an extension, so a press counts only after a pause since the last one.
// A Mac starts repeating within a second unless set otherwise, and each repeat counts
// as the last press, so a key held for as long as you like is one press.
const KEY_PAUSE_MS = 1000;
function oncePerPress(fn) {
  let last = -Infinity;
  return windowId => {
    const now = performance.now(), repeat = now - last < KEY_PAUSE_MS;
    last = now;
    return repeat ? Promise.resolve() : serial(() => fn(windowId));
  };
}

const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];

const COMMANDS = [
  { name: "next-tab", label: "Next tab", key: "Ctrl+MacCtrl+Down", action: inQueue(w => stepTab(w, 1)) },
  { name: "previous-tab", label: "Previous tab", key: "Ctrl+MacCtrl+Up", action: inQueue(w => stepTab(w, -1)) },
  { name: "next-space", label: "Next space", key: "Ctrl+MacCtrl+Right", action: inQueue(w => stepSpace(w, 1)) },
  { name: "previous-space", label: "Previous space", key: "Ctrl+MacCtrl+Left", action: inQueue(w => stepSpace(w, -1)) },
  { name: "toggle-essential", label: "Make this tab an essential, or not", key: "Ctrl+D", action: oncePerPress(toggleEssential) },
  { name: "new-folder", label: "New folder", key: "Ctrl+Alt+N", action: oncePerPress(newFolderHere) },
  // Without a sidebar a window has no list of tabs at all: a key to bring it back. ⌘S, Arc's, is compact mode in the dotfiles.
  { name: "_execute_sidebar_action", label: "Show or hide Tidier's sidebar", key: "MacCtrl+Shift+S", action: () => browser.sidebarAction.toggle() },
  { name: "copy-url", label: "Copy the address of the current tab", key: "Ctrl+Shift+C", action: copyUrl, always: true },
  ...ORDINAL.slice(0, 5).map((nth, i) => ({ name: `space-${i + 1}`, label: `Go to the ${nth} space`, key: `MacCtrl+${i + 1}`, action: inQueue(w => switchToNth(w, i)) })),
  ...ORDINAL.map((nth, i) => ({ name: `tab-${i + 1}`, label: `Go to the ${nth} tab of this space`, key: `Ctrl+${i + 1}`, action: inQueue(w => nthTab(w, i + 1)) })),
];

// _execute_sidebar_action never comes here: Firefox carries that one out itself.
browser.commands.onCommand.addListener(async (name, tab) => {
  const command = COMMANDS.find(c => c.name === name);
  if (!command || !(tidierAlone || command.always)) return;
  const windowId = tab?.windowId ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.windowId;
  const win = windowId !== undefined && await browser.windows.get(windowId).catch(() => null);
  // The keys work in any window of Firefox's, but a small window has no list and no spaces,
  // and a private window's tabs are none of Tidier's: as an essential, one would be in every window.
  if (win && ((win.type === "normal" && !win.incognito) || command.always)) await command.action(windowId).catch(err => console.error("Tidier:", name, err));
});
