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
//   has no say over it. So ⌘⌃ and an arrow, one finger along.
// - ⌘1 to ⌘9 can be had: an extension's key on a digit acts on keydown, Firefox's own on
//   keypress, which never comes then.
// - ⌘D cannot be had until it is cleared in about:keyboard: an extension's key on a letter
//   acts on keypress too, and Firefox's keys come first (customKeys.json in the dotfiles).
//   So does ⌘⇧C (copy-url), which is the one key that works without Tidier alone too.

async function copyUrl(windowId) {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (tab && isWeb(tab.url)) await navigator.clipboard.writeText(tab.url);
}

// Through the queue: selecting a placeholder pulls its real tab in, which changes the
// tabs, so a key held down must see the outcome of the press before it.
const inQueue = fn => windowId => serial(() => fn(windowId));
const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];

const COMMANDS = [
  { name: "next-tab", label: "Next tab", key: "Ctrl+MacCtrl+Down", action: inQueue(w => stepTab(w, 1)) },
  { name: "previous-tab", label: "Previous tab", key: "Ctrl+MacCtrl+Up", action: inQueue(w => stepTab(w, -1)) },
  { name: "next-space", label: "Next space", key: "Ctrl+MacCtrl+Right", action: inQueue(w => stepSpace(w, 1)) },
  { name: "previous-space", label: "Previous space", key: "Ctrl+MacCtrl+Left", action: inQueue(w => stepSpace(w, -1)) },
  { name: "toggle-essential", label: "Make this tab an essential, or not", key: "Ctrl+D", action: inQueue(toggleEssential) },
  { name: "new-folder", label: "New folder", key: "Ctrl+Alt+N", action: inQueue(newFolderHere) },
  { name: "_execute_sidebar_action", label: "Show or hide Tidier's sidebar", key: "MacCtrl+Shift+S", action: () => browser.sidebarAction.toggle() },
  { name: "copy-url", label: "Copy the address of the current tab", key: "Ctrl+Shift+C", action: copyUrl, always: true },
  ...ORDINAL.slice(0, 5).map((nth, i) => ({ name: `space-${i + 1}`, label: `Go to the ${nth} space`, key: `MacCtrl+${i + 1}`, action: inQueue(() => switchToNth(i)) })),
  ...ORDINAL.map((nth, i) => ({ name: `tab-${i + 1}`, label: `Go to the ${nth} tab of this space`, key: `Ctrl+${i + 1}`, action: inQueue(w => nthTab(w, i + 1)) })),
];

// _execute_sidebar_action never comes here: Firefox carries that one out itself.
browser.commands.onCommand.addListener(async (name, tab) => {
  const command = COMMANDS.find(c => c.name === name);
  if (!command || !(tidierAlone || command.always)) return;
  const windowId = tab?.windowId ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.windowId;
  if (windowId !== undefined) await command.action(windowId).catch(err => console.error("Tidier:", name, err));
});
