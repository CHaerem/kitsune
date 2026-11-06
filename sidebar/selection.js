// --- Selecting several tabs (Tidier alone) ------------------------------------------
// ⌘-click (Ctrl-click elsewhere) adds or removes a tab, ⇧-click takes a range, and what
// you then do to one of them goes for all of them. The selection is the sidebar's own.
// Firefox has one too (tabs.highlight), but that selects the first tab, which pulls a
// placeholder's real tab in, and ⌘W then closes all of them.
//
// These listeners run in the capture phase, before what row(), tile(), keys.js and
// drag.js have on the same events, so that those stay as they are for one tab and
// with the setting off. No new background code either: what goes for many is the same
// message once per tab, and the messages already go through one queue.
//
// A function around it, so that its names cannot meet those of the other scripts here:
// they share one scope, and a name declared twice stops the second script.
(() => {
  // ⌘ on a Mac, where Ctrl-click is a right click.
  let mac = false;
  browser.runtime.getPlatformInfo().then(info => { mac = info.os === "mac"; });

  let picked = new Set();
  let kind = null; // "tile" or "tab": an essential and a row have no action in common
  let anchor = null; // where a ⇧-click starts
  let base = new Set(); // what stays besides the range, so that a second ⇧-click can change it
  let shownSpace = null;

  const idOf = e => Number(e.dataset.tab);
  const kindOf = e => (e.classList.contains("tile") ? "tile" : "tab");
  const element = id => kept.get(`${kind}:${id}`);
  const root = document.documentElement;

  // Tabs as they are drawn, which is not the window's order. A row in a closed folder is
  // not drawn, so nothing here can act on a tab you cannot see.
  const shown = k => [...document.querySelectorAll(k === "tile" ? "#essentials .tile" : "#tabs .tab")].filter(e => e.offsetParent !== null);
  const inOrder = () => shown(kind).map(idOf).filter(id => picked.has(id));

  // What the tab menu acts on: the selection if this tab is in it, else this tab.
  window.selectedTabs = id => (picked.has(Number(id)) ? inOrder() : [id]);

  function paint() {
    for (const e of document.querySelectorAll(".picked")) if (!picked.has(idOf(e))) e.classList.remove("picked");
    for (const id of picked) element(id)?.classList.add("picked");
  }

  function clear() {
    picked = new Set();
    base = new Set();
    kind = anchor = null;
    root.classList.remove("carrying");
    paint();
  }

  // A first pick starts over, of its own kind. You are on a tab and pick another: you
  // mean both, so the selected tab is in it, if it is shown and of that kind.
  function startOver(k) {
    clear();
    kind = k;
    const current = shown(k).find(e => e.classList.contains("active"));
    return current ? idOf(current) : null;
  }

  function addOrRemove(item) {
    const id = idOf(item);
    if (kindOf(item) !== kind || !picked.size) {
      const current = startOver(kindOf(item));
      if (current !== null) picked.add(current);
      picked.add(id);
    } else if (!picked.delete(id)) picked.add(id);
    if (!picked.size) { clear(); return; }
    anchor = id;
    base = new Set(picked);
    paint();
  }

  function pickRange(item) {
    const id = idOf(item);
    if (kindOf(item) !== kind || !picked.size) anchor = startOver(kindOf(item)) ?? id;
    const ids = shown(kind).map(idOf), to = ids.indexOf(id);
    let from = ids.indexOf(anchor);
    if (from < 0) { from = to; anchor = id; } // its tab has gone, or its folder was closed
    picked = new Set([...base, ...ids.slice(Math.min(from, to), Math.max(from, to) + 1)]);
    paint();
  }

  // One close per tab, the selected tab last. Closed first, it would make Firefox select
  // another that may be about to close too, and a placeholder that is selected starts
  // pulling its real tab in (pull, tabsync.js), under a new id, while its close is on the way.
  function closePicked() {
    const selected = id => Number(element(id).classList.contains("active"));
    const ids = inOrder().sort((a, b) => selected(a) - selected(b));
    clear();
    for (const tabId of ids) send({ type: "close", tabId });
  }

  // Together already, right in front of `before` (or last there): a shaky drop on their own
  // neighbour. Moving them anyway would shuffle them through each other in every window.
  function alreadyThere(ids, before, folder) {
    let at = before !== null ? element(before)?.previousElementSibling
      : kind === "tile" ? document.getElementById("essentials").lastElementChild
      : (kept.get(`folder:${folder}`)?.lastChild ?? document.getElementById("tabs")).lastElementChild;
    for (const id of [...ids].reverse()) {
      if (at?.dataset.tab !== String(id)) return false;
      at = at.previousElementSibling;
    }
    return true;
  }

  // What drag.js would send for the one row, once per tab in order. With the same place
  // for each, each lands behind the one before it. (Firefox puts an essential it unpins
  // first among the tabs, so those go in reverse.)
  function carry(msg) {
    const ids = inOrder();
    if (msg.pinned === false) ids.reverse();
    // Dropped on one of the tabs that are moving: the place is in front of the next that is not.
    let before = msg.before;
    while (picked.has(before)) {
      const next = nextTab(element(before));
      before = next ? idOf(next) : null;
    }
    if (before !== undefined && alreadyThere(ids, before, msg.folder)) return;
    for (const tabId of ids) send({ ...msg, tabId, before });
  }

  // A plain click clears, except on what you use on the way to acting on a selection:
  // a folder's head (open it to drop into it), a new folder, a row's own buttons, the menu.
  const KEEPS = ".head, #new-folder, .row button, #menu, input";
  // A click taken from the row's own handler: the selected page does not change. The
  // menu closes on a click at the end of its way, which this one does not reach.
  const take = e => { e.stopPropagation(); closeMenu(); };

  addEventListener("click", e => {
    if (!view?.alone) return;
    const item = e.target.closest?.("[data-tab]"), button = e.target.closest?.("button");
    const adding = mac ? e.metaKey : e.ctrlKey;
    if (item && !button && mac && e.ctrlKey) take(e); // a right click on a Mac: only its menu
    else if (item && !button && (adding || e.shiftKey)) {
      take(e);
      if (e.shiftKey) pickRange(item);
      else addOrRemove(item);
    } else if (item && button?.classList.contains("close") && picked.has(idOf(item))) {
      take(e);
      closePicked();
    } else if (!adding && !e.shiftKey && !e.target.closest?.(KEEPS)) clear();
  }, true);

  addEventListener("auxclick", e => {
    const item = e.target.closest?.("[data-tab]");
    if (e.button !== 1 || !view?.alone || !item || !picked.has(idOf(item))) return;
    e.stopPropagation();
    closePicked();
  }, true);

  // Esc goes back one step at a time: the menu (menu.js), then the selection, then the
  // keys' cursor. ⌫ on a picked row closes them all; on any other row it is that row's.
  addEventListener("keydown", e => {
    if (!view?.alone || e.target.closest?.("input") || !document.getElementById("menu").hidden) return;
    if (e.key === "Escape") {
      if (picked.size) clear();
      else if (cursor) moveCursor(null);
      else return;
      e.preventDefault();
    } else if ((e.key === "Backspace" || e.key === "Delete") && picked.size && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (cursor && !picked.has(idOf(cursor))) return;
      if (cursor) {
        const stays = x => !picked.has(idOf(x)), all = reachable(), at = all.indexOf(cursor);
        moveCursor(all.slice(at + 1).find(stays) ?? all.slice(0, at).reverse().find(stays));
      }
      e.stopPropagation();
      e.preventDefault();
      closePicked();
    }
  }, true);

  // While you carry them they fade, so you see that all of them come along. After the
  // event: a drag that is refused has no `dragging`, and Firefox has taken the picture of
  // the row by then, so that does not fade.
  addEventListener("dragstart", () => {
    if (picked.size) setTimeout(() => root.classList.toggle("carrying", picked.has(dragging?.tabId)));
  }, true);
  addEventListener("dragend", () => root.classList.remove("carrying"), true);

  // A row that is not picked moves alone, and the selection stays as it is.
  addEventListener("drop", e => {
    if (!picked.has(dragging?.tabId)) return;
    const drop = dropAt(e);
    marks();
    dragging = null;
    root.classList.remove("carrying");
    e.stopPropagation();
    if (!drop) return;
    e.preventDefault();
    carry(drop.msg);
  }, true);

  // After each view (this listener runs after render): tabs that have gone or are no longer
  // drawn leave the selection. Drawing a row resets its classes, so the marks are put back
  // before anything is painted, the cursor's too (keys.js sets it only when it moves).
  port.onMessage.addListener(() => {
    if (!view.alone || view.space !== shownSpace) {
      shownSpace = view.space;
      if (picked.size) clear();
    }
    if (view.alone && cursor?.isConnected) cursor.classList.add("cursor");
    if (!picked.size) return;
    const here = new Set(shown(kind).map(idOf));
    for (const set of [picked, base]) for (const id of [...set]) if (!here.has(id)) set.delete(id);
    if (picked.size) paint();
    else clear();
  });
})();
