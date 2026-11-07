// --- A menu on each space ---------------------------------------------------------
// A right click on a dot, or on the name above the list, opens Tidier's small menu.
// Only with Tidier alone: without it, the daily browser keeps Firefox's menu here.
// A listener of its own that comes first, so the bar's drawing need not know of it.

function spaceMenu(space) {
  return [
    ["Rename", () => openSpaceBox(space)],
    ["Unload this space", () => send({ type: "unloadSpace", space })],
    ...(space === view.space && clearableHere() ? [clearItem()] : []),
    ["Archived tabs", () => openArchived(space)], // archived.js
    ["Settings", () => browser.runtime.openOptionsPage()],
  ];
}

// Clear closes today's tabs but the selected one, so with no other tab it has nothing
// to do, and a menu holds only what can be done: nothing is ever greyed.
const clearableHere = () => view.tabs.some(t => !t.active);
// The space it was offered for, not the one the window is in by the time of the click:
// this closes tabs.
const clearItem = (space = view.space) => ["Clear today's tabs", () => send({ type: "clearSpace", space })];

addEventListener("contextmenu", e => {
  if (e.target.closest?.("#menu")) return e.preventDefault(); // no menu on a menu
  closeMenu(); // no small menu left open beside Firefox's own
  if (!view?.alone) return;
  const dot = e.target.closest?.("#spaces .space");
  if (!dot && e.target.id !== "space-name") return;
  openMenu(e, spaceMenu(dot ? dot.dataset.space : view.space));
  markSpaceDot(dot);
  if (dot) aboveTheBar();
}, true);

// A menu at the pointer would cover the bar and with it the dot it belongs to. Above
// the bar, the dot stays in sight, marked as long as the menu or its box is open.
const spaceMenuBox = document.getElementById("menu");
function aboveTheBar() {
  const bar = document.getElementById("spaces").getBoundingClientRect();
  spaceMenuBox.style.top = Math.max(4, bar.top - spaceMenuBox.offsetHeight - 4) + "px";
}
function markSpaceDot(dot) {
  for (const d of document.querySelectorAll("#spaces .menu-for")) d.classList.remove("menu-for");
  dot?.classList.add("menu-for");
}

// --- Renaming: the name line above the list becomes a box -------------------------
// Beside the line, not in it: each view sets the line's text, which would take the
// box away while you type. Enter or leaving the box saves, Esc does not.
//
// Another space's name is edited here too, in its colour and with its dot marked,
// without going there: Firefox moves the focus to the page when a tab is selected, and
// when this was tried with a switch first, what was typed never reached the box. It
// also loads no page just for a name.
//
// The rest of the line's height goes below the box, so the list stays where it is
// whatever the font: a line's height is the system's, and differs per machine.
let spaceBox = null;

function openSpaceBox(space) {
  const line = document.getElementById("space-name"), s = view.spaces.find(x => x.id === space);
  if (spaceBox || !s) return;
  const input = el("input", "space-box");
  input.value = s.name;
  input.style.setProperty("--accent", s.color);
  input.setAttribute("aria-label", "Name of this space");
  const room = line.getBoundingClientRect().height;
  line.hidden = true;
  line.after(input);
  input.style.marginBottom = Math.max(0, room - input.getBoundingClientRect().height) + "px"; // no name: no line
  markSpaceDot(document.querySelector(`#spaces .space[data-space="${space}"]`));
  input.focus();
  input.select();
  const finish = save => {
    if (spaceBox !== input) return;
    spaceBox = null;
    const name = input.value.trim();
    line.hidden = false;
    input.remove();
    markSpaceDot(null);
    if (!save || !name || name === s.name) return;
    if (space === view.space) line.textContent = name; // at once: the view with it comes a moment later
    send({ type: "renameSpace", space, name });
  };
  spaceBox = input;
  input.onblur = () => finish(true);
  input.onkeydown = e => {
    e.stopPropagation(); // these keys are for the box, not for the list (keys.js)
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
}
