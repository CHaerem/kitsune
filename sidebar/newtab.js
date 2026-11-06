// A double click on the empty part of the list opens a new tab in the space, in the
// same place as the new tab button (newtabs.js). A middle click there is left out,
// since a trackpad has none.
//
// Both clicks must have been on the empty part. What was under the pointer can go
// between the two (the × of the last row closes it), and the second click then lands
// on the empty part, where Firefox still reports a double click. So the first click
// is seen at the window, first, wherever it lands: a tile, or a row that keeps its
// events to itself, must not leave the answer from a click long ago.
{
  const list = document.getElementById("tabs");
  let firstClickOnEmpty = false;
  addEventListener("mousedown", e => { if (e.detail === 1) firstClickOnEmpty = e.target === list; }, true);
  list.addEventListener("dblclick", e => {
    if (view?.alone && firstClickOnEmpty && e.target === list) send({ type: "newTab", space: view.space });
  });
}
