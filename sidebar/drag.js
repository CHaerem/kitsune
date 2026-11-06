// --- Dragging -------------------------------------------------------------------
// A tab can go before or after another tab, into a folder, to a place among the
// essentials (pinned) or to a space on the bar. An essential can go among the
// essentials, or to the list (unpinned). A folder can go among the folders.
//
// A mark means that a drop there does something. Right next to what you are dragging
// nothing would move, so there is no mark, and a drop there sends nothing.
//
// Nothing here scrolls the list: during a drag Firefox itself scrolls whatever
// scrollable element the pointer is within 20 device pixels of the edge of, a step
// for each dragover (ScrollContainerFrame::DragScroll). The smoke test holds it to that.
let dragging = null;

// × and the sound button sit inside a draggable row, and a drag can start from any
// child of it, so a hand that shakes during a click would drag the row and lose the
// click. A dragstart only names the row, so what the mouse went down on is noted here.
let pressed = null;
addEventListener("mousedown", e => { pressed = e.target; }, true);

function startDrag(e, what) {
  const onButton = pressed?.closest?.("button");
  pressed = null;
  if (!view?.alone || onButton) { e.preventDefault(); return; }
  dragging = what;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", ""); // Firefox starts no drag without data
  e.stopPropagation();
}
addEventListener("dragend", () => { dragging = null; marks(); });
// Past the sidebar's edge a drop does nothing here, and no more dragover comes to take
// the mark away. (A leave with no next element is the leaving of the page itself.)
addEventListener("dragleave", e => { if (!e.relatedTarget) marks(); });

const MARKS = ["drop-before", "drop-after", "drop-left", "drop-right", "drop-into"];
const MARKED = MARKS.map(c => "." + c).join();
// Called for every dragover, many times a second, so what is right already stays untouched.
function marks(target, cls) {
  for (const e of document.querySelectorAll(MARKED)) if (e !== target || !e.classList.contains(cls)) e.classList.remove(...MARKS);
  target?.classList.add(cls);
}

// What is being dragged, as drawn now. Undefined if a tab event took it away meanwhile
// (the tab closed): its dragend then goes to the removed element and never reaches
// us, so `dragging` could be left over for a later drag from somewhere else.
const draggedNow = () => kept.get(dragging.kind === "folder" ? "folder:" + dragging.key : (dragging.kind === "essential" ? "tile:" : "tab:") + dragging.tabId);

// The place among the essentials under the pointer. They are a grid, so a tile's left
// or right half decides. The nearest tile counts, so the gaps and the empty end of the
// last line are places too, and the line does not flicker on its way across.
function tilePlace(e) {
  const tiles = [...document.querySelectorAll("#essentials .tile")];
  if (!tiles.length) return null;
  const away = tile => {
    const r = tile.getBoundingClientRect();
    return Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
  };
  const tile = tiles.reduce((a, b) => (away(b) < away(a) ? b : a));
  const r = tile.getBoundingClientRect(), right = e.clientX > r.left + r.width / 2;
  return { tile, cls: right ? "drop-right" : "drop-left", before: right ? tile.nextElementSibling : tile };
}

// What dropping here would do: { target, cls, msg }, or null if it would do nothing.
function dropAt(e) {
  // A drag event can be aimed at the text under the pointer, which has no closest().
  const over = e.target.closest ? e.target : e.target.parentElement;
  let t = over?.closest("[data-tab], [data-folder-head], #essentials, #tabs, .space");
  if (!t || !dragging) return null;
  const own = draggedNow();
  if (!own) return null;
  const after = el => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  if (dragging.kind === "folder") {
    const box = over.closest(".folder");
    if (!box || box === own) return null;
    const next = b => b.nextElementSibling?.dataset.key ?? null;
    const beyond = after(box.firstChild) ? next(box) : box.dataset.key;
    if (beyond === dragging.key || beyond === next(own)) return null;
    return { target: box, cls: beyond === box.dataset.key ? "drop-before" : "drop-after", msg: { type: "moveFolder", key: dragging.key, before: beyond } };
  }
  if (t.classList.contains("space")) {
    if (dragging.kind !== "tab" || t.dataset.space === view.space) return null;
    return { target: t, cls: "drop-into", msg: { type: "moveToSpace", tabId: dragging.tabId, space: t.dataset.space } };
  }
  const inEssentials = t.id === "essentials" || t.classList.contains("tile");
  if (dragging.kind === "essential" && !inEssentials) return { target: document.getElementById("tabs"), cls: "drop-into", msg: { type: "pin", tabId: dragging.tabId, pinned: false } };
  if (inEssentials) {
    const place = tilePlace(e);
    if (!place) return null;
    const before = place.before ? Number(place.before.dataset.tab) : null;
    if (dragging.kind === "tab") return { target: place.tile, cls: place.cls, msg: { type: "pin", tabId: dragging.tabId, pinned: true, before } };
    if (place.before === own || place.before === own.nextElementSibling) return null;
    return { target: place.tile, cls: place.cls, msg: { type: "moveEssential", tabId: dragging.tabId, before } };
  }
  // A tab in a live folder stays there, whatever is dropped (the search decides, see
  // moveTab), and it has no order of its own to change.
  const held = !!own.closest(".live");
  if (t.dataset.folderHead) {
    const box = t.parentElement;
    if (held || box.classList.contains("live")) return null;
    if (own.parentElement === box.lastChild && !nextTab(own)) return null; // last in it already
    return { target: t, cls: "drop-into", msg: { type: "moveTab", tabId: dragging.tabId, folder: t.dataset.folderHead, before: null } };
  }
  if (t.id === "tabs") {
    // A folder's indent is not a place. The gap above the ordinary tabs is the top of
    // them, and the empty end of the list is the end of them: a line where the tab
    // will land, not the whole list outlined in passing.
    if (over.closest(".folder")) return null;
    const loose = t.querySelectorAll(":scope > .tab");
    if (!loose.length) return held ? null : { target: t, cls: "drop-into", msg: { type: "moveTab", tabId: dragging.tabId, folder: null, before: null } };
    t = e.clientY < loose[0].getBoundingClientRect().top ? loose[0] : loose[loose.length - 1];
  }
  if (t === own || held || t.closest(".live")) return null;
  const below = after(t), beyond = below ? nextTab(t) : t;
  if (t.parentElement === own.parentElement && (beyond === own || beyond === nextTab(own))) return null;
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
