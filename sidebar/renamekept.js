// --- Naming what you keep ------------------------------------------------------
// renameKept(tabId) opens a box for the name of an essential or a saved tab. It is
// reached from the tab menu's Rename only, not from a double click, so that no box
// ever appears by accident on something you meant to open. Enter, or leaving the box,
// saves; Esc cancels; an empty box gives the page's title back (tabnames.js).
//
// A saved tab's row holds the box, as a folder's head does. A tile has no text to
// replace, so the line with the space's name makes way for it. That line is rewritten
// by every view, so the box stands beside it and never in it.

let naming = null; // the open box: { target, input, finish }

function renameKept(id) {
  if (!view?.alone) return;
  naming?.finish(true);
  const tile = kept.get("tile:" + id), row = kept.get("tab:" + id), target = tile || row;
  // In a folder is what saved means; a live folder's tabs belong to its search.
  if (!target || (row && (!row.dataset.folder || row.closest(".live")))) return;
  const item = [...view.essentials, ...view.tabs, ...view.folders.flatMap(f => f.tabs)].find(i => i.id === id);
  if (!item) return;

  const input = el("input", "rename");
  input.value = item.title;
  input.setAttribute("aria-label", "Name");
  const before = input.value.trim(); // what an unchanged box holds: Enter on it names nothing
  const title = row?.querySelector(".title"), line = document.getElementById("space-name");
  target.classList.add("renaming"); // keep() leaves it undrawn meanwhile
  if (tile) {
    input.id = "name-box";
    line.hidden = true;
    line.after(input);
  } else {
    row.draggable = false; // or a drag inside the box would pick up the row
    title.replaceWith(input);
  }

  const finish = save => {
    if (naming?.input !== input) return;
    naming = null;
    const text = input.value.trim();
    target.classList.remove("renaming");
    if (tile) {
      input.remove();
      line.hidden = false;
    } else {
      row.draggable = true;
      input.replaceWith(el("span", "title", save && text ? text : item.title));
    }
    delete target.dataset.state; // whatever a view brought meanwhile is drawn with the next one
    if (save && text !== before) send({ type: "renameTab", tabId: id, name: text });
    // Nothing changes, so no view would come by itself. Asked for rather than drawn here,
    // since other parts of the sidebar redraw their marks when a view arrives.
    else browser.windows.getCurrent().then(w => send({ type: "hello", windowId: w.id }));
  };
  naming = { target, input, finish };

  input.onblur = () => finish(true);
  // The box is inside a row that answers these: a middle click pasting here would close the tab.
  for (const event of ["click", "auxclick", "dblclick", "contextmenu"]) input.addEventListener(event, e => e.stopPropagation());
  input.onkeydown = e => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.focus();
  input.select();
}

// After each view (this listener runs after render). What was being named can be gone:
// its tab closed, its space left with a key, its folder folded from another window. What
// you typed is saved, as when you leave the box any other way. A row that only had to
// move loses the focus without any event, or you would be typing into nothing.
port.onMessage.addListener(() => {
  if (!naming) return;
  if (!naming.target.isConnected || !naming.input.offsetParent) naming.finish(true);
  else if (document.activeElement !== naming.input) naming.input.focus();
});
