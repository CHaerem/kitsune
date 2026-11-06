// --- Dragging -------------------------------------------------------------------
// A tab can go before or after another tab, into a folder, to the essentials (pinned)
// or to a space on the bar. An essential can go among the essentials, or to the list
// (unpinned). A folder can go among the folders.
let dragging = null;
function startDrag(e, what) {
  if (!view?.alone) { e.preventDefault(); return; }
  dragging = what;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", ""); // Firefox starts no drag without data
  e.stopPropagation();
}
addEventListener("dragend", () => { dragging = null; marks(); });

function marks(target, cls) {
  for (const e of document.querySelectorAll(".drop-before, .drop-after, .drop-into")) e.classList.remove("drop-before", "drop-after", "drop-into");
  if (target) target.classList.add(cls);
}

// What dropping here would do: { target, cls, msg }, or null.
function dropAt(e) {
  const t = e.target.closest?.("[data-tab], [data-folder-head], #essentials, #tabs, .space");
  if (!t || !dragging) return null;
  const after = el => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  if (dragging.kind === "folder") {
    const box = t.closest(".folder");
    if (!box || box.dataset.key === dragging.key) return null;
    const beyond = after(box.firstChild) ? box.nextElementSibling?.dataset.key ?? null : box.dataset.key;
    return { target: box, cls: beyond === box.dataset.key ? "drop-before" : "drop-after", msg: { type: "moveFolder", key: dragging.key, before: beyond } };
  }
  if (t.classList.contains("space")) {
    if (dragging.kind !== "tab" || t.dataset.space === view.space) return null;
    return { target: t, cls: "drop-into", msg: { type: "moveToSpace", tabId: dragging.tabId, space: t.dataset.space } };
  }
  const inEssentials = t.id === "essentials" || t.classList.contains("tile");
  if (dragging.kind === "essential") {
    if (!inEssentials) return { target: document.getElementById("tabs"), cls: "drop-into", msg: { type: "pin", tabId: dragging.tabId, pinned: false } };
    if (t.id === "essentials" || Number(t.dataset.tab) === dragging.tabId) return null;
    return { target: t, cls: "drop-before", msg: { type: "moveEssential", tabId: dragging.tabId, before: Number(t.dataset.tab) } };
  }
  if (inEssentials) return { target: document.getElementById("essentials"), cls: "drop-into", msg: { type: "pin", tabId: dragging.tabId, pinned: true } };
  if (t.dataset.folderHead) {
    const live = t.parentElement.classList.contains("live");
    return live ? null : { target: t, cls: "drop-into", msg: { type: "moveTab", tabId: dragging.tabId, folder: t.dataset.folderHead, before: null } };
  }
  if (t.id === "tabs") return { target: t, cls: "drop-into", msg: { type: "moveTab", tabId: dragging.tabId, folder: null, before: null } };
  if (Number(t.dataset.tab) === dragging.tabId) return null;
  if (t.closest(".live")) return null;
  const below = after(t), beyond = below ? nextTab(t) : t;
  return { target: t, cls: below ? "drop-after" : "drop-before", msg: { type: "moveTab", tabId: dragging.tabId, folder: t.dataset.folder || null, before: beyond ? Number(beyond.dataset.tab) : null } };
}
function nextTab(t) {
  for (let n = t.nextElementSibling; n; n = n.nextElementSibling) if (n.dataset.tab) return n;
  return null;
}
addEventListener("dragover", e => {
  const drop = dropAt(e);
  marks(drop?.target, drop?.cls);
  if (drop) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
});
addEventListener("drop", e => {
  const drop = dropAt(e);
  marks();
  dragging = null;
  if (drop) { e.preventDefault(); send(drop.msg); }
});
