// One quiet row for each small window that is open (littlewindow.js in the background),
// above the bar. A window extensions open has no toolbar to put "Keep" in, and this
// sidebar is right next to it. It is there only while the window is, and it takes its
// height from the list's free room below the last row, so no row moves.

const littleBox = el("div");
littleBox.id = "little";
document.getElementById("spaces").before(littleBox);
let littleDrawn = "";

function littleRow(item) {
  const row = el("div", "row little");
  row.title = item.title;
  row.onclick = () => send({ type: "little:show", tabId: item.id });
  const keepIt = el("button", "keep", "Keep");
  if (item.space) {
    keepIt.append(el("span", "where", ` in ${item.space}`)); // not in a narrow sidebar (sidebar.css)
    keepIt.title = `Keep in ${item.space}`;
  }
  keepIt.onclick = e => { e.stopPropagation(); send({ type: "little:keep", tabId: item.id }); };
  const close = el("button", "close", "×");
  close.title = "Close";
  close.onclick = e => { e.stopPropagation(); send({ type: "close", tabId: item.id }); };
  row.append(icon(item), el("span", "title", item.title), keepIt, close);
  return row;
}

// Runs after render, on every view: rows drawn anew only if something in them changed.
port.onMessage.addListener(next => {
  const text = JSON.stringify(next.little ?? []);
  if (text === littleDrawn) return;
  littleDrawn = text;
  littleBox.replaceChildren(...(next.little ?? []).map(littleRow));
});
