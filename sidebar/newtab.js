// A double click on the empty part of the list opens a new tab in the space, in the
// same place as the new tab button (newtabs.js). A middle click there is left out,
// since a trackpad has none.
//
// Both clicks must have been on the empty part. A row can go from under the pointer
// between the two (the × of the last row closes it), and the second click then lands
// on the empty part, where Firefox still reports a double click.
{
  const list = document.getElementById("tabs");
  let firstClickOnEmpty = false;
  list.addEventListener("mousedown", e => { if (e.detail === 1) firstClickOnEmpty = e.target === list; });
  list.addEventListener("dblclick", e => {
    if (view?.alone && firstClickOnEmpty && e.target === list) send({ type: "newTab", space: view.space });
  });
}
