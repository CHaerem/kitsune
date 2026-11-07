// The marks of news.js: one class on what is drawn, and the dot itself is in sidebar.css.
// This listener runs after render (sidebar.js), in the same turn, so a row that was just
// drawn anew, which resets its classes, has its mark back before it is painted.
port.onMessage.addListener(next => {
  const mark = (id, on) => kept.get(id)?.classList.toggle("news", !!on);
  for (const item of next.essentials) mark("tile:" + item.id, item.news);
  for (const item of [...next.tabs, ...next.folders.flatMap(f => f.tabs)]) mark("tab:" + item.id, item.news);
  for (const f of next.folders) mark("folder:" + f.key, f.news);
  for (const s of next.spaces) mark("space:" + s.id, s.news);
});
