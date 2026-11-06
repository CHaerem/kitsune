// One quiet line above the bar, and Clear (quiet.js in the background). Both are added
// here, after each draw, so that the list itself knows nothing about them. All of it is
// in a block: the sidebar's scripts share one scope, and a name defined twice would
// stop the second script.
{
  const box = document.getElementById("note");
  const text = el("span", "text"), act = el("button", "act", "Undo");
  const line = el("div", "line");
  line.append(text, act);
  box.append(line);

  // The text stays while the line fades out; only its being shown changes.
  let shown = null;
  const drawNote = note => {
    shown = note;
    box.classList.toggle("shown", !!note);
    if (!note) return;
    text.textContent = note.text;
    text.title = note.text;
    act.hidden = !note.undo;
  };
  act.onclick = () => {
    if (!shown) return;
    send({ type: "undo", note: shown.id });
    drawNote(null); // the tabs take a moment to come back; the line goes at once
  };

  // Something to clear: a tab in the list that is not the one you are on.
  const clearable = () => !!view?.alone && view.tabs.some(t => !t.active);
  const clear = () => send({ type: "clearSpace", space: view.space });

  // Clear shows only with the pointer near the line between folders and today's tabs.
  // The area it listens on lies over that gap, so nothing is taller for it.
  const drawClear = () => {
    const divider = document.querySelector("#tabs > .divider");
    if (!divider || !view.alone) return;
    if (!divider.firstChild) {
      const reach = el("div", "clear-reach"), button = el("button", "clear", "Clear");
      button.title = "Close today's tabs, except the one you are on";
      button.onclick = clear;
      reach.oncontextmenu = e => openMenu(e, listMenu());
      reach.append(button);
      divider.append(reach);
    }
    divider.firstChild.hidden = !clearable();
  };

  // With no folders there is no line to find it on: the list's own menu has it (menu.js).
  window.clearItems = () => clearable() ? [["Clear tabs", clear]] : [];

  port.onMessage.addListener(next => {
    drawNote(next.note ?? null);
    drawClear();
  });
}
