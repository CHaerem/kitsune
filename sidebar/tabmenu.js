// The menu on a tab or a tile (Tidier alone). Firefox's own tab menu cannot serve here:
// since Firefox 158 it hides all its items once a page names a tab with overrideContext,
// so a row offered only what Tidier added, and that misfired on tiles.
//
// One table says everything: what an item is called, when it applies, whether it can take
// several tabs, and what it does. One list for one tab or many: an item acts on the whole
// list or is left out, and nothing is ever greyed. The tabs in the list are what the
// background knows of each when the menu opens (tabMenuFacts, tabactions.js), not what the
// row shows: a row can be a placeholder of a page loaded in another window.

const tabsWord = (n, one, many) => (n > 1 ? many.replace("#", n) : one);
const eachTab = test => tabs => tabs.every(test);
const tabAct = (action, tabs, more = {}) => send({ type: "tabAction", action, tabIds: tabs.map(t => t.id), ...more });
const movable = t => !t.tile && !t.liveFolder && !!t.address; // the search decides what is in a live folder

// A tab's folders to choose from: leaving out where all of them already are.
const folderChoices = tabs => [
  ...(tabs.some(t => t.folder) ? [["No folder", () => tabAct("folder", tabs, { folder: null })]] : []),
  ...view.folders.filter(f => !f.live && tabs.some(t => t.folder !== f.key)).map(f => [f.name, () => tabAct("folder", tabs, { folder: f.key })]),
  ["New folder", () => { renameNext = true; tabAct("newFolder", tabs, { space: view.space }); }],
];
const otherSpaces = tabs => view.spaces.filter(s => s.id !== tabs[0].space);
const spaceChoices = tabs => otherSpaces(tabs).map(s => [s.name, () => tabAct("space", tabs, { space: s.id }), { color: s.color }]);

// In the order shown; a line between groups. Rows and tiles differ only by their rules.
// `many`: it can take several tabs. `choices`: it opens a list of its own, in place.
const TAB_MENU = [
  { id: "reload", group: 1, many: true, label: n => tabsWord(n, "Reload", "Reload # tabs"),
    when: eachTab(t => t.loaded), run: tabs => tabAct("reload", tabs) },
  { id: "mute", group: 1, many: true, label: n => tabsWord(n, "Mute", "Mute # tabs"),
    when: tabs => tabs.every(t => t.loaded) && tabs.some(t => !t.muted), run: tabs => tabAct("mute", tabs) },
  { id: "unmute", group: 1, many: true, label: n => tabsWord(n, "Unmute", "Unmute # tabs"),
    when: eachTab(t => t.loaded && t.muted), run: tabs => tabAct("unmute", tabs) },
  // Firefox cannot unload its own pages (about:), and would refuse without a word.
  { id: "unload", group: 1, many: true, label: n => tabsWord(n, "Unload", "Unload # tabs"),
    when: eachTab(t => t.loaded && !!t.address), run: tabs => tabAct("unload", tabs) },

  { id: "duplicate", group: 2, label: () => "Duplicate",
    when: eachTab(t => !!t.address), run: tabs => tabAct("duplicate", tabs) },
  // Here, on the click: the addresses are at hand, and a copy need not wait for the queue.
  { id: "copy", group: 2, many: true, label: n => tabsWord(n, "Copy address", "Copy # addresses"),
    when: eachTab(t => !!t.address), run: tabs => navigator.clipboard.writeText(tabs.map(t => t.address).join("\n")).catch(err => console.error("Tidier: copy", err)) },

  { id: "rename", group: 3, label: () => "Rename",
    when: tabs => tabs[0].kept && typeof window.renameKept === "function", run: tabs => window.renameKept(tabs[0].id) },

  { id: "essential", group: 4, many: true, label: n => tabsWord(n, "Make essential", "Make # tabs essential"),
    when: eachTab(t => !t.tile && !!t.address), run: tabs => tabAct("essential", tabs) },
  { id: "removeEssential", group: 4, many: true, label: n => tabsWord(n, "Remove from essentials", "Remove # from essentials"),
    when: eachTab(t => t.tile), run: tabs => tabAct("removeEssential", tabs) },
  { id: "folder", group: 4, many: true, label: n => tabsWord(n, "Move to folder", "Move # tabs to folder"),
    when: eachTab(movable), choices: folderChoices },
  { id: "space", group: 4, many: true, label: n => tabsWord(n, "Move to space", "Move # tabs to space"),
    when: tabs => tabs.every(movable) && otherSpaces(tabs).length > 0, choices: spaceChoices },
  // A tab outside any container has no "here". Left out when the rule is there already.
  { id: "rule", group: 4, label: () => "Always open this site here",
    when: eachTab(t => !t.tile && !!t.address && !t.ruled && t.space !== "firefox-default"), run: tabs => tabAct("rule", tabs) },

  // Closing a tile that is not loaded would only draw the same placeholder again.
  { id: "close", group: 5, many: true, label: n => tabsWord(n, "Close", "Close # tabs"),
    when: eachTab(t => !t.tile || t.loaded), run: tabs => tabs.forEach(t => send({ type: "close", tabId: t.id })) },
];

// The menu for these tabs, as openMenu takes it (null: a line).
function tabMenuItems(tabs) {
  const n = tabs.length, items = [];
  let group = null;
  for (const item of TAB_MENU) {
    if ((n > 1 && !item.many) || !item.when(tabs)) continue;
    if (group !== null && item.group !== group) items.push(null);
    group = item.group;
    items.push([item.label(n), item.choices ? item.choices(tabs) : () => item.run(tabs)]);
  }
  return items;
}

// A right click on a row or a tile. Firefox's own menu is held back in the click itself;
// the list then comes from the background, a few milliseconds later.
let tabMenuAsked = 0;
function openTabMenu(e, id) {
  holdMenu(e);
  const ids = window.selectedTabs?.(id) ?? [id];
  const asked = ++tabMenuAsked, { clientX: x, clientY: y } = e;
  browser.runtime.sendMessage({ type: "tabMenu", tabIds: ids }).then(tabs => {
    if (asked !== tabMenuAsked || !tabs?.length) return; // a newer click, or the tab is gone
    showMenu(tabMenuItems(tabs), x, y);
    // Which tabs it is about, while the pointer is away from them: a tile has no text.
    for (const t of tabs) document.querySelector(`[data-tab="${t.id}"]`)?.classList.add("menu-for");
  }, err => console.error("Tidier: tab menu", err));
}
