// --- Dragging -------------------------------------------------------------------
// A tab can go before or after another tab, into a folder, to a place among the
// essentials (pinned) or to a space on the bar. An essential can go among the
// essentials, or to the list (unpinned). A folder can go among the folders.
//
// A mark means that a drop there does something. Right next to what you are dragging
// nothing would move, so there is no mark, and a drop there sends nothing.
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
addEventListener("dragend", () => { dragging = null; settle(); });
// Past the sidebar's edge a drop does nothing here, and no more dragover comes to take
// the mark away. (A leave with no next element is the leaving of the page itself.)
addEventListener("dragleave", e => { if (!e.relatedTarget) settle(); });
const settle = () => { marks(); scrollList(0); };

const MARKS = ["drop-before", "drop-after", "drop-left", "drop-right", "drop-into"];
const MARKED = MARKS.map(c => "." + c).join();
// Called for every dragover, many times a second, so what is right already stays untouched.
function marks(target, cls) {
  for (const e of document.querySelectorAll(MARKED)) if (e !== target || !e.classList.contains(cls)) e.classList.remove(...MARKS);
  if (target && !target.classList.contains(cls)) target.classList.add(cls);
}

// What is being dragged, as drawn now.
const draggedNow = () => kept.get(dragging.kind === "folder" ? "folder:" + dragging.key : (dragging.kind === "essential" ? "tile:" : "tab:") + dragging.tabId);

// A tab event can take it away during the drag (the tab closed, or went to another window
// or space). Its dragend then goes to the removed element and never reaches us. That
// ends the drag here, or a tab coming back later would be moved by the next drag from a
// page that happens to be dropped on the sidebar.
port.onMessage.addListener(() => {
  if (!dragging || draggedNow()) return;
  dragging = null;
  settle();
});

// --- The list scrolls at its edges ------------------------------------------------
// Firefox has a scroll of its own during a drag (ScrollContainerFrame::DragScroll), but it
// cannot be relied on here: its zone is 20 device pixels, so 10 points on a Retina screen,
// right above the space bar; it takes a fixed step per dragover; and in the test Firefox
// it took one step and no more, however long a drag was held there. So this does it: it
// goes on while the pointer rests there, faster the closer to the edge, and exists only
// during a drag. It ends by itself at the list's end, so nothing can keep it going.
const EDGE_ZONE = 40, EDGE_SPEED = 900; // how near the edge in pixels, and pixels a second at the edge
let scrolling = null; // { speed, frame, last, carry }

function edgeSpeed(e) {
  const list = document.getElementById("tabs");
  // An essential has no place in the list to be scrolled to: anywhere there unpins it.
  if (!dragging || dragging.kind === "essential" || !list.contains(e.target)) return 0;
  const box = list.getBoundingClientRect();
  const fromTop = e.clientY - box.top, fromBottom = box.bottom - e.clientY, near = Math.min(fromTop, fromBottom);
  if (near >= EDGE_ZONE) return 0;
  const closeness = 1 - Math.max(near, 0) / EDGE_ZONE;
  return (fromTop < fromBottom ? -1 : 1) * EDGE_SPEED * (.1 + .9 * closeness * closeness);
}

function scrollList(speed) {
  if (!speed) {
    if (scrolling) cancelAnimationFrame(scrolling.frame);
    scrolling = null;
  } else if (scrolling) {
    scrolling.speed = speed;
  } else {
    scrolling = { speed, last: performance.now(), carry: 0, frame: requestAnimationFrame(scrollStep) };
  }
}

function scrollStep(now) {
  const list = document.getElementById("tabs"), was = list.scrollTop;
  // By the time passed, as a sidebar has no fixed frame rate, and in whole pixels, as a
  // small fraction added to scrollTop would be rounded away and never add up.
  scrolling.carry += scrolling.speed * Math.max(now - scrolling.last, 0) / 1000;
  scrolling.last = now;
  const step = Math.trunc(scrolling.carry);
  scrolling.carry -= step;
  list.scrollTop = was + step;
  if (step && list.scrollTop === was) scrolling = null; // the end of the list
  else scrolling.frame = requestAnimationFrame(scrollStep);
}

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
  let t = over?.closest("[data-tab], [data-folder-head], #essentials, #space-name, #tabs, .space");
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
  // A new tab page or the like: no space can open it and no essential or folder can keep
  // it (moveToSpace, onPinned and moveTab go by the address), so it only has a place among
  // the ordinary tabs. Such a tab is never in a folder, so this looks at the loose ones.
  if (dragging.kind === "tab" && view.tabs.some(i => i.id === dragging.tabId && !i.page) && (!t.closest("#tabs") || t.dataset.folderHead || t.dataset.folder)) return null;
  // With no essentials the grid takes no room, and the space's name is where it would be.
  if (t.id === "space-name") {
    if (dragging.kind !== "tab" || document.querySelector("#essentials .tile")) return null;
    return { target: t, cls: "drop-into", msg: { type: "pin", tabId: dragging.tabId, pinned: true, before: null } };
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
  scrollList(edgeSpeed(e));
  if (drop) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
});
addEventListener("drop", e => {
  const drop = dropAt(e);
  settle();
  dragging = null;
  if (drop) { e.preventDefault(); send(drop.msg); }
});
