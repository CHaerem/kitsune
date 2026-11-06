// --- A small menu, drawn by Tidier ---------------------------------------------------
function folderMenu(key, live) {
  return live ? [["Delete folder", () => send({ type: "deleteFolder", key })]] : [
    ["Rename", () => rename(key)],
    ["Delete folder (its tabs stay)", () => send({ type: "deleteFolder", key })],
  ];
}
const listMenu = () => [["New folder", () => { renameNext = true; send({ type: "newFolder", space: view.space }); }]];

// Items: [label, what it does, { color }], or null for a line. Instead of what it does an
// item can have a list of items, which replaces the menu's contents in place, with a row
// back: a narrow sidebar has no room for a menu beside a menu.
function openMenu(e, items) {
  holdMenu(e);
  showMenu(items, e.clientX, e.clientY);
}

// Firefox's own menu must not open: this has to happen in the right click itself.
function holdMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  browser.menus.overrideContext({ showDefaults: false });
}

let menuAt = { x: 0, y: 0 };
function showMenu(items, x, y) {
  menuAt = { x, y };
  closeMenu();
  drawMenu(items);
}

function drawMenu(items, back = null, byKey = false) {
  const menu = document.getElementById("menu");
  const rows = items.map(item => {
    if (!item) return el("div", "line");
    const [label, act, { color } = {}] = item;
    const b = el("button", "item");
    b.append(el("span", "label", label));
    if (color) {
      const dot = el("span", "dot");
      dot.style.setProperty("--color", color);
      b.prepend(dot);
    }
    if (Array.isArray(act)) {
      b.classList.add("more");
      // Stays open: the click must not reach the listener below that closes the menu.
      b.onclick = ev => { ev.stopPropagation(); drawMenu(act, { label, items }, !ev.detail); };
    } else {
      b.onclick = () => { closeMenu(); act(); };
    }
    return b;
  });
  if (back) {
    const b = el("button", "item back");
    b.append(el("span", "label", back.label));
    b.onclick = ev => { ev.stopPropagation(); drawMenu(back.items, null, !ev.detail); };
    rows.unshift(b, el("div", "line"));
  }
  menu.replaceChildren(...rows);
  menu.hidden = false;
  // Measured from the corner: where it stood last would limit how wide it can be.
  menu.style.left = menu.style.top = "0";
  menu.style.left = Math.max(4, Math.min(menuAt.x, innerWidth - menu.offsetWidth - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(menuAt.y, innerHeight - menu.offsetHeight - 4)) + "px";
  menu.scrollTop = 0;
  // In the menu, so the arrow keys are for it (keys.js leaves them alone there).
  (byKey ? menu.querySelector(".item:not(.back)") : menu).focus({ preventScroll: true });
}

const closeMenu = () => {
  document.getElementById("menu").hidden = true;
  for (const e of document.querySelectorAll(".menu-for")) e.classList.remove("menu-for");
};
addEventListener("click", closeMenu);
addEventListener("blur", closeMenu);
addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });

// ↑ and ↓ move through it, → opens a list, ← goes back, Enter is the button's own.
{
  const menu = document.getElementById("menu");
  menu.tabIndex = -1;
  menu.oncontextmenu = e => e.preventDefault();
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll(".item")], at = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") items[(at + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(at < 1 ? items.length : at) - 1]?.focus();
    else if (e.key === "ArrowRight") { if (items[at]?.classList.contains("more")) items[at].click(); }
    else if (e.key === "ArrowLeft") menu.querySelector(".back")?.click();
    else return;
    e.preventDefault();
  });
}
