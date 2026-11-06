// --- Archived tabs ------------------------------------------------------------------
// What archiving and you closed, per space (archivelist.js), in a view that slides over
// the list: one row per tab, with its age. A click opens the tab again in its own space,
// the × forgets it, and Esc or the row at the top goes back. So does a click anywhere
// outside it, and that click still does what it does (a dot switches space, say).
//
// The view is drawn over the list, not instead of it: the list keeps its rows and its
// scroll, and takes no part in this. The rows here have no data-tab, so what works on
// tabs (keys.js, drag.js, the selection) does not see them.

const archivedBox = el("section");
archivedBox.id = "archived";
archivedBox.setAttribute("aria-label", "Archived tabs");
const archivedBack = el("button", "row back");
archivedBack.append(el("span", "chevron", "‹"), el("span", "title"));
archivedBack.title = "Back to the tabs (Esc)";
const archivedRows = el("div", "rows");
archivedBox.append(archivedBack, archivedRows);
document.body.append(archivedBox);

let archivedSpace = null; // the space whose list is open, or null
const archivedEmpty = el("div", "empty", "Nothing here. Tabs you close, and tabs left unused, stay here for 30 days.");

// Age in words, as of when it is drawn: it is not worth a timer that ticks.
function archivedAge(when) {
  const minutes = Math.floor((Date.now() - when) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + " min";
  if (minutes < 1440) return Math.floor(minutes / 60) + " h";
  return Math.floor(minutes / 1440) + " d";
}

function reopenRow(item) {
  closeArchived();
  browser.windows.getCurrent()
    .then(w => browser.runtime.sendMessage({ type: "reopenArchived", item: { space: item.space, url: item.url }, windowId: w.id }))
    .catch(() => {}); // refused: it stays in the list, and the background has logged it
}

function forgetRow(item, row) {
  if (archivedCursor === row) moveArchivedCursor(row.nextElementSibling || row.previousElementSibling);
  row.remove();
  browser.runtime.sendMessage({ type: "forgetArchived", item: { space: item.space, url: item.url } }).then(refreshArchived, () => {});
}

// Rows are kept, as in the list, and redrawn only if they changed: a view can arrive
// at any moment, and replacing a row would lose a click that is under way.
const archivedKept = new Map(); // "space address" -> its row
function archivedRow(item) {
  const id = item.space + " " + item.url;
  let row = archivedKept.get(id);
  if (!row) {
    row = el("div", "row");
    row.onclick = () => reopenRow(item);
    row.onauxclick = e => { if (e.button === 1) forgetRow(item, row); };
    archivedKept.set(id, row);
  }
  const age = archivedAge(item.when), state = JSON.stringify([item.title, item.icon, age]);
  if (row.dataset.state !== state) {
    row.dataset.state = state;
    row.title = `${item.title}\n${item.url}\n${item.why === "archived" ? "Archived" : "Closed"} ${new Date(item.when).toLocaleString()}`;
    const forget = el("button", "close", "×");
    forget.title = "Forget";
    forget.onclick = e => { e.stopPropagation(); forgetRow(item, row); };
    // Up to 200 pictures from as many sites: only those that come into sight are fetched.
    const picture = icon(item);
    if (picture.tagName === "IMG") picture.loading = "lazy";
    row.replaceChildren(picture, el("span", "title", item.title), el("span", "age", age), forget);
  }
  return row;
}

function drawArchived(items) {
  const space = view.spaces.find(s => s.id === archivedSpace);
  archivedBack.lastChild.textContent = archivedSpace === view.space ? "Archived tabs" : `Archived tabs in ${space?.name ?? ""}`;
  // Letters in place of icons have the colour of the space the rows are from.
  archivedBox.style.setProperty("--accent", space?.color || "");
  const rows = items.map(archivedRow), shown = new Set(rows);
  place(archivedRows, rows.length ? rows : [archivedEmpty]);
  for (const [id, row] of archivedKept) if (!shown.has(row)) archivedKept.delete(id);
  if (archivedCursor && !shown.has(archivedCursor)) moveArchivedCursor(null);
}

// Answers may cross when views come quickly: only the last one counts.
let archivedAsked = 0;
async function refreshArchived() {
  if (!archivedSpace) return;
  const asked = ++archivedAsked;
  const items = await browser.runtime.sendMessage({ type: "archivedTabs", space: archivedSpace }).catch(() => null);
  if (items && asked === archivedAsked && archivedSpace) drawArchived(items);
}
port.onMessage.addListener(refreshArchived); // something closed or came back while it is open

// Over the actions and the list, whatever their size (a window resized, essentials added):
// the essentials, the space's name and the bar stay in sight. A plain box in the page's
// flow could not lie over the list without moving the list's own elements.
const archivedFit = new ResizeObserver(fitArchived);
function fitArchived() {
  const list = document.getElementById("tabs").getBoundingClientRect();
  const top = document.getElementById("actions")?.getBoundingClientRect().top ?? list.top;
  archivedBox.style.top = top + "px";
  archivedBox.style.height = list.bottom - top + "px";
}

// `space`: whose list, without going there: a look at another space's tabs should not
// select and load one of them. Opening one of its rows then takes you there.
async function openArchived(space = view?.space) {
  if (!view?.alone || !space) return;
  closeMenu();
  archivedSpace = space;
  fitArchived();
  archivedFit.observe(document.getElementById("tabs"));
  await refreshArchived(); // drawn first, so it does not slide in with an old list
  if (archivedSpace === space) archivedBox.classList.add("open");
}

function closeArchived() {
  if (!archivedSpace) return;
  archivedSpace = null;
  archivedFit.disconnect();
  moveArchivedCursor(null);
  archivedBox.classList.remove("open");
}

archivedBack.onclick = closeArchived;
archivedBox.oncontextmenu = e => e.preventDefault(); // Firefox's menu for a page has nothing to offer here
addEventListener("click", e => {
  if (archivedSpace && !archivedBox.contains(e.target) && !e.target.closest?.("#menu")) closeArchived();
}, true);

// The list's keys work here too, and must not reach the list under it (keys.js): ↑ and ↓
// move, Enter opens, ⌫ forgets, and Esc or ← goes back.
let archivedCursor = null;
function moveArchivedCursor(to) {
  archivedCursor?.classList.remove("cursor");
  archivedCursor = to || null;
  archivedCursor?.classList.add("cursor");
  archivedCursor?.scrollIntoView({ block: "nearest" });
}
addEventListener("keydown", e => {
  if (!archivedSpace || e.target.closest?.("input") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!document.getElementById("menu").hidden) return; // Esc closes the menu first
  const rows = [...archivedRows.children].filter(r => r !== archivedEmpty), at = rows.indexOf(archivedCursor);
  switch (e.key) {
    case "ArrowDown": moveArchivedCursor(rows[Math.min(at + 1, rows.length - 1)]); break;
    case "ArrowUp": moveArchivedCursor(rows[Math.max(at - 1, 0)]); break;
    case "Enter": archivedCursor?.click(); break;
    case "Backspace": case "Delete":
      if (archivedCursor) archivedCursor.querySelector(".close").click();
      break;
    case "Escape": case "ArrowLeft": closeArchived(); break;
    case "ArrowRight": break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
}, true);
