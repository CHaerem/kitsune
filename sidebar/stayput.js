// A list that shows where you are, and stays as you left it (Tidier alone).
//
// Each space keeps how far down its list you were, while this sidebar is open. And the
// list moves by itself for one thing only: the selected tab became another one, which is
// wholly out of view. Then it moves by the least distance, and leaves you alone from
// there. A clicked row is in view, so the list does not move under the pointer; a tab
// opened in the background is not selected, so it does not move the list at all. (One
// exception: leaving a selected tab in a closed folder takes its row out of the list, so
// rows below it in view come up by one row. With that row above the view nothing shows,
// since Firefox keeps what you see in place.)
//
// In a block, so that no name here can clash with another sidebar script: a clash in a
// plain script stops that whole script.
{
  const list = document.getElementById("tabs");
  const positions = new Map(); // space -> scrollTop
  let shown, selected;

  // The scroll events a redraw causes need no care: this listener and render run in
  // one go when a view arrives, and scroll events come later, so an event always reads
  // the position of the space on screen, never another space's.
  list.addEventListener("scroll", () => { if (shown) positions.set(shown, list.scrollTop); }, { passive: true });

  const outOfView = row => {
    const r = row.getBoundingClientRect(), box = list.getBoundingClientRect();
    return r.bottom <= box.top || r.top >= box.bottom;
  };

  port.onMessage.addListener(next => {
    if (!next.alone) return;
    cursor?.classList.add("cursor"); // a row drawn again has lost its mark, and you your place
    if (next.space !== shown) {
      shown = next.space;
      list.scrollTop = positions.get(shown) ?? 0;
    }
    // Restored first, so a row in view at the place you left is not moved to. An
    // essential's tile is always in view, so only rows count. A row in a closed folder
    // is drawn while selected (sidebar.css), so it can be measured here.
    const row = list.querySelector(".tab.active"), id = row?.dataset.tab;
    if (id !== selected) {
      selected = id;
      if (row && outOfView(row)) row.scrollIntoView({ block: "nearest" });
    }
  });

  // You went back to the page: the cursor's mark is no longer true, and the next key
  // starts at the tab you are on then, not where you once left the cursor.
  addEventListener("blur", () => { if (view?.alone) moveCursor(null); });
}
