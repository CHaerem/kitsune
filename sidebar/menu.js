// --- A small menu, for what is not a tab -----------------------------------------
function folderMenu(key, live) {
  return live ? [["Delete folder", () => send({ type: "deleteFolder", key })]] : [
    ["Rename", () => rename(key)],
    ["Delete folder (its tabs stay)", () => send({ type: "deleteFolder", key })],
  ];
}
const listMenu = () => [
  ["New folder", () => { renameNext = true; send({ type: "newFolder", space: view.space }); }],
  ["Archived tabs", () => openArchived()], // archived.js
];

function openMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  browser.menus.overrideContext({ showDefaults: false });
  const menu = document.getElementById("menu");
  menu.replaceChildren(...items.map(([label, act]) => {
    const b = el("button", "item", label);
    b.onclick = () => { closeMenu(); act(); };
    return b;
  }));
  menu.hidden = false;
  menu.style.left = Math.min(e.clientX, innerWidth - menu.offsetWidth - 4) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - menu.offsetHeight - 4) + "px";
}
const closeMenu = () => { document.getElementById("menu").hidden = true; };
addEventListener("click", closeMenu);
addEventListener("blur", closeMenu);
addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
