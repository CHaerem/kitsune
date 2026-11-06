// What isolation shows in the sidebar (Tidier alone), all of it only when it applies
// (isolation.js in the background does the work):
//
// - One line asking for the permission to stop a page before it loads in the wrong
//   space, until it is given or you say no. Without it, everything else works as before.
// - "Move to space" in a folder's menu, and in the tab menu's table, "Open a copy in
//   space", "Clear this site's cookies in this space" and "New space".
// - While a tab is being dragged, a place on the bar to drop it for a new space.
//
// Nothing here is drawn into the rows or the bar themselves, whose draws reset them.

const DECLINED = "isolationDeclined"; // localStorage: per browser, and you can still give it on the settings page
const ISOLATION_ASK = { permissions: ["webRequest", "webRequestBlocking"], origins: ["<all_urls>"] };
let hostAllowed = false;
const isolationTell = (type, more) => browser.runtime.sendMessage({ type: "isolation:" + type, ...more }).catch(err => console.error("Tidier: isolation", err));
const thisWindow = browser.windows.getCurrent().then(w => w.id);

// --- The line asking for the permission ------------------------------------------------
const askLine = el("div", "notice ask-line");
askLine.hidden = true;
const askButton = el("button", "", "Let Tidier stop pages loading in the wrong space");
askButton.title = "Firefox will ask to let Tidier see where pages go, on all websites. Nothing leaves your machine.";
const askNo = el("button", "ask-no", "×");
askNo.title = "Not now (it can be given on the settings page)";
askLine.append(askButton, askNo);
document.getElementById("hiding").after(askLine);
// Asking needs your click, so it is here and not in the background.
askButton.onclick = () => browser.permissions.request(ISOLATION_ASK).then(readPermissions);
askNo.onclick = () => {
  try { localStorage.setItem(DECLINED, "1"); } catch (err) { /* then it asks again next time */ }
  askLine.hidden = true;
};

// Each view only looks at this: permissions change rarely, and views come all the time.
let isolationGiven = true;
async function readPermissions() {
  hostAllowed = await browser.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
  isolationGiven = await browser.permissions.contains(ISOLATION_ASK).catch(() => false);
  drawAskLine();
}
function drawAskLine() {
  let declined = false;
  try { declined = !!localStorage.getItem(DECLINED); } catch (err) { /* asks then */ }
  // One thing to click at a time: the line about hiding tabs comes first.
  askLine.hidden = isolationGiven || declined || !view?.alone || !!view?.needsHiding;
}
port.onMessage.addListener(drawAskLine);
browser.permissions.onAdded.addListener(readPermissions);
browser.permissions.onRemoved.addListener(readPermissions);
readPermissions();

// A lasting notice about a space that came back goes when you have seen it.
document.getElementById("problem").addEventListener("click", () => isolationTell("seen"));

// --- Menus ------------------------------------------------------------------------------
// A list in place where the menu can do that (tabmenu.js, with drawMenu), else one line
// for each space: a narrow sidebar has no room for a menu beside a menu.
const inPlace = (label, items) => typeof drawMenu === "function" ? [[label, items]] : items.map(([name, act]) => [`${label}: ${name}`, act]);
const spacesOtherThan = id => (view?.spaces ?? []).filter(s => s.id !== id);

const plainFolderMenu = folderMenu;
window.folderMenu = (key, live) => {
  const items = plainFolderMenu(key, live);
  if (!view?.alone) return items;
  const others = spacesOtherThan(view.space).map(s => [s.name, async () => isolationTell("moveFolder", { key, space: s.id, windowId: await thisWindow }), { color: s.color }]);
  return others.length ? [...items, ...inPlace("Move to space", others)] : items;
};

// The tab menu's table (tabmenu.js), where it is there, with each item put by the one it
// belongs after: the table draws a line between groups. It is one list for one tab or
// many: what can't take many has no `many`, and is left out then.
function addToTabMenu() {
  if (typeof TAB_MENU === "undefined") return;
  const after = (id, item) => {
    const at = TAB_MENU.findIndex(i => i.id === id);
    TAB_MENU.splice(at < 0 ? TAB_MENU.length : at + 1, 0, item);
  };
  after("copy", { id: "clearCookies", group: 2, label: () => "Clear this site's cookies in this space",
    when: tabs => hostAllowed && !!tabs[0].address && tabs[0].space !== "firefox-default",
    run: async tabs => isolationTell("clearCookies", { tabId: tabs[0].id, windowId: await thisWindow }) });
  after("space", { id: "copyToSpace", group: 4, many: true, label: n => (n > 1 ? `Open copies of ${n} tabs in space` : "Open a copy in space"),
    when: tabs => tabs.every(t => !!t.address) && spacesOtherThan(tabs[0].space).length > 0,
    choices: tabs => spacesOtherThan(tabs[0].space).map(s => [s.name, async () => isolationTell("copy", { tabIds: tabs.map(t => t.id), space: s.id, windowId: await thisWindow }), { color: s.color }]) });
  const move = TAB_MENU.find(i => i.id === "space");
  if (move) {
    const { choices } = move;
    move.choices = tabs => [...choices(tabs), ["New space", async () => isolationTell("newSpaceWith", { tabIds: tabs.map(t => t.id), windowId: await thisWindow })]];
  }
}

// The space's menu (spacemenu.js), where it is there: New space, and then its name is
// ready to change on the line above the list. Editing the rest and deleting are on the
// settings page, which that menu leads to.
let namingNewSpace = null;
function addToSpaceMenu() {
  if (typeof spaceMenu !== "function") return;
  const plainSpaceMenu = spaceMenu;
  window.spaceMenu = space => {
    const items = plainSpaceMenu(space);
    const settings = items.findIndex(i => i?.[0] === "Settings");
    items.splice(settings < 0 ? items.length : settings, 0, ["New space", async () => { namingNewSpace = await isolationTell("new"); nameNewSpace(); }]);
    return items;
  };
}
function nameNewSpace() {
  if (namingNewSpace && view?.spaces.some(s => s.id === namingNewSpace) && typeof openSpaceBox === "function") {
    openSpaceBox(namingNewSpace);
    namingNewSpace = null;
  }
}
port.onMessage.addListener(nameNewSpace); // its dot comes with the next view
addEventListener("DOMContentLoaded", () => { addToTabMenu(); addToSpaceMenu(); });

// --- A new space by dropping tabs on the bar --------------------------------------------
// The place exists only during a tab's drag, and it is not one of the bar's dots, which
// are for the spaces there are. Dropping is handled here, before drag.js sees the event.
const dropForSpace = el("button", "new-space", "+");
dropForSpace.title = "A new space with this tab";
dropForSpace.hidden = true;
document.getElementById("spaces").after(dropForSpace);
let draggedTabs = null;
addEventListener("dragstart", e => {
  const id = Number(e.target.closest?.(".row.tab")?.dataset.tab);
  if (!view?.alone || !id) return;
  draggedTabs = window.selectedTabs?.(id) ?? [id];
  dropForSpace.hidden = false;
}, true);
addEventListener("dragend", () => { draggedTabs = null; dropForSpace.hidden = true; dropForSpace.classList.remove("drop-into"); }, true);
dropForSpace.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; dropForSpace.classList.add("drop-into"); });
dropForSpace.addEventListener("dragleave", () => dropForSpace.classList.remove("drop-into"));
dropForSpace.addEventListener("drop", async e => {
  e.preventDefault();
  e.stopPropagation();
  const tabIds = draggedTabs;
  dropForSpace.classList.remove("drop-into");
  if (tabIds) isolationTell("newSpaceWith", { tabIds, windowId: await thisWindow });
});
