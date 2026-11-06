// --- A menu on each space ---------------------------------------------------------
// A right click on a dot, or on the name above the list, opens Tidier's small menu.
// Only with Tidier alone: without it, the daily browser keeps Firefox's menu here.
// A listener of its own that comes first, so the bar's drawing need not know of it.

function spaceMenu(space) {
  return [
    ["Rename", () => openSpaceBox(space)],
    ["Unload this space", () => send({ type: "unloadSpace", space })],
    ...(space === view.space && clearableHere() ? [clearItem()] : []),
    ["Settings", () => browser.runtime.openOptionsPage()],
  ];
}

// Clear closes today's tabs but the selected one, so with no other tab it has nothing
// to do, and a menu holds only what can be done: nothing is ever greyed.
const clearableHere = () => view.tabs.some(t => !t.active);
const clearItem = () => ["Clear today's tabs", () => send({ type: "clearSpace", space: view.space })];

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
new MutationObserver(() => { if (spaceMenuBox.hidden && !spaceBox) markSpaceDot(null); }).observe(spaceMenuBox, { attributes: true, attributeFilter: ["hidden"] });

// --- Renaming: the name line above the list becomes a box -------------------------
// Beside the line, not in it: each view sets the line's text, which would take the
// box away while you type. Enter or leaving the box saves, Esc does not.
//
// Another space's name is edited here too, in its colour and with its dot marked,
// without going there: Firefox gives the focus to the page when a tab is selected, and
// a sidebar cannot take it back by script (window.focus needs a click), so after a
// switch your typing would land in the page. It also loads no page just for a name.
let spaceBox = null;

function openSpaceBox(space) {
  const line = document.getElementById("space-name"), s = view.spaces.find(x => x.id === space);
  if (spaceBox || !s) return;
  const input = el("input", "space-box");
  input.value = s.name;
  input.style.setProperty("--accent", s.color);
  input.setAttribute("aria-label", "Name of this space");
  line.hidden = true;
  line.after(input);
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
