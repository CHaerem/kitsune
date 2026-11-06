// Draws the view the background sends (sidebar-view.js) and sends back what
// you do. Text is only ever set with textContent, so a page title cannot add
// anything to the sidebar.
//
// A tab event can arrive at any moment, so rows are kept and only what changed is
// redrawn (see row, place): replacing them all would lose a click or a drag that
// is under way.

const port = browser.runtime.connect({ name: "sidebar" });
browser.windows.getCurrent().then(w => port.postMessage({ type: "hello", windowId: w.id }));
port.onMessage.addListener(render);

// Your own look, from managed storage (dotfiles' tidier.css, given to Firefox
// as a file in ~/Library/Application Support/Mozilla/ManagedStorage): the
// sidebar cannot be transparent, so the window's tint per space (userChrome.css)
// is repeated there, keyed on html[data-space].
browser.storage.managed.get("sidebarCSS").then(({ sidebarCSS }) => {
  if (!sidebarCSS) return;
  const style = document.createElement("style");
  style.textContent = sidebarCSS;
  document.head.append(style);
}, () => {});

let view = null;
const send = msg => port.postMessage(msg);
// Folds with Sidebery's folder pages are kept for this sidebar only; Tidier's own
// folders keep theirs in the record.
const collapsed = new Set();

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// Put `nodes` in `parent` in this order, touching only what is out of place.
function place(parent, nodes) {
  let at = parent.firstChild;
  for (const n of nodes) {
    if (n === at) at = at.nextSibling;
    else parent.insertBefore(n, at);
  }
  while (at) { const next = at.nextSibling; at.remove(); at = next; }
}

// The kept element for `id`, its content drawn again only if `state` changed.
const kept = new Map();
let drawn = new Set();
function keep(id, make, state, draw) {
  drawn.add(id);
  let e = kept.get(id);
  if (!e) { e = make(); kept.set(id, e); }
  const text = JSON.stringify(state);
  if (e.dataset.state !== text && !e.classList.contains("renaming")) {
    e.dataset.state = text;
    draw(e);
  }
  return e;
}

// A row that is drawn again gets a new image. One that has loaded comes straight from
// Firefox's cache, so it does not blink. One not seen yet is asked for only once its row
// comes near the view: with many tabs most rows are not. One that failed is not asked
// for again for a while (it may have been the network): a site without an icon would
// otherwise be asked at every redraw.
const ICON_RETRY_MS = 5 * 60000;
const iconsLoaded = new Set(), iconsFailed = new Map(); // URL -> when it failed
function icon(item) {
  const failed = iconsFailed.get(item.icon);
  if (item.icon && /^(https?:|data:|moz-extension:)/.test(item.icon) && !(Date.now() - failed < ICON_RETRY_MS)) {
    const img = el("img");
    if (!iconsLoaded.has(item.icon)) img.loading = "lazy";
    img.src = item.icon;
    img.alt = "";
    img.onload = () => { iconsLoaded.add(item.icon); iconsFailed.delete(item.icon); };
    img.onerror = () => { iconsFailed.set(item.icon, Date.now()); img.replaceWith(el("span", "letter", (item.title || "?").trim()[0] || "?")); };
    return img;
  }
  return el("span", "letter", (item.title || "?").trim()[0] || "?");
}

// --- Essentials ----------------------------------------------------------------
function tile(item) {
  return keep("tile:" + item.id, () => {
    const t = el("div");
    t.dataset.tab = item.id;
    t.draggable = !!view?.alone;
    t.onclick = () => send({ type: "select", tabId: item.id });
    t.onauxclick = e => { if (e.button === 1) send({ type: "close", tabId: item.id }); };
    t.oncontextmenu = () => browser.menus.overrideContext({ context: "tab", tabId: item.id });
    t.ondragstart = e => startDrag(e, { kind: "essential", tabId: item.id });
    return t;
  }, item, t => {
    t.className = "tile" + (item.active ? " active" : "") + (item.loaded ? "" : " unloaded");
    t.title = item.title;
    t.replaceChildren(icon(item));
  });
}

// --- Tabs ----------------------------------------------------------------------
function row(item, folderKey) {
  const r = keep("tab:" + item.id, () => {
    const e = el("div");
    e.dataset.tab = item.id;
    e.draggable = !!view?.alone;
    e.onclick = () => send({ type: "select", tabId: item.id });
    e.onauxclick = ev => { if (ev.button === 1) send({ type: "close", tabId: item.id }); };
    e.oncontextmenu = () => browser.menus.overrideContext({ context: "tab", tabId: item.id });
    e.ondragstart = ev => startDrag(ev, { kind: "tab", tabId: item.id });
    return e;
  }, item, e => {
    e.className = "row tab" + (item.active ? " active" : "") + (item.loaded ? "" : " unloaded");
    e.title = item.title;
    const parts = [icon(item), el("span", "title", item.title)];
    if (item.audible || item.muted) {
      const sound = el("button", "sound", item.muted ? "🔇" : "🔊");
      sound.title = item.muted ? "Unmute" : "Mute";
      sound.onclick = ev => { ev.stopPropagation(); send({ type: "mute", tabId: item.id, muted: !item.muted }); };
      parts.push(sound);
    }
    const close = el("button", "close", "×");
    close.title = "Close";
    close.onclick = ev => { ev.stopPropagation(); send({ type: "close", tabId: item.id }); };
    parts.push(close);
    e.replaceChildren(...parts);
  });
  r.dataset.folder = folderKey ?? "";
  return r;
}

// --- Folders -------------------------------------------------------------------
function folder(f) {
  const closed = view.alone ? f.collapsed : collapsed.has(f.key);
  const box = keep("folder:" + f.key, () => {
    const b = el("div", "folder");
    const head = el("div", "row head");
    head.dataset.folderHead = f.key;
    head.onclick = () => {
      if (b.classList.contains("renaming")) return;
      if (view.alone) send({ type: "foldFolder", key: f.key, collapsed: !b.classList.contains("collapsed") });
      else {
        if (collapsed.has(f.key)) collapsed.delete(f.key); else collapsed.add(f.key);
        b.classList.toggle("collapsed");
      }
    };
    head.ondblclick = () => { if (view.alone && !f.live) rename(f.key); };
    head.oncontextmenu = e => { if (view.alone) openMenu(e, folderMenu(f.key, f.live)); };
    head.draggable = !!view?.alone;
    head.ondragstart = e => startDrag(e, { kind: "folder", key: f.key });
    b.append(head, el("div", "children"));
    return b;
  }, { name: f.name, closed, live: f.live, n: f.tabs.length }, b => {
    b.classList.toggle("collapsed", closed);
    b.classList.toggle("live", !!f.live);
    b.dataset.key = f.key;
    b.firstChild.title = f.name;
    b.firstChild.replaceChildren(el("span", "chevron", "▾"), el("span", "title", f.name), el("span", "count", closed && f.tabs.length ? String(f.tabs.length) : ""));
  });
  place(box.lastChild, f.tabs.map(t => row(t, f.key)));
  return box;
}

function rename(key) {
  const box = kept.get("folder:" + key);
  if (!box || box.classList.contains("renaming")) return;
  const head = box.firstChild, title = head.querySelector(".title");
  const input = el("input", "rename");
  input.value = title.textContent;
  box.classList.add("renaming");
  head.draggable = false;
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    box.classList.remove("renaming");
    head.draggable = true;
    input.replaceWith(el("span", "title", save ? input.value.trim() || title.textContent : title.textContent));
    if (save && input.value.trim()) send({ type: "renameFolder", key, name: input.value.trim() });
    delete box.dataset.state; // drawn anew with the next view
  };
  input.onblur = () => finish(true);
  input.onclick = e => e.stopPropagation();
  input.onkeydown = e => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
}

// --- Everything -------------------------------------------------------------------
let renameNext = false;
let folderKeys = new Set();
function render(next) {
  view = next;
  drawn = new Set();
  const space = view.spaces.find(s => s.id === view.space);
  document.documentElement.style.setProperty("--accent", space?.color || "#7a7a80");
  document.documentElement.dataset.space = view.space || "";
  document.documentElement.classList.toggle("alone", !!view.alone);

  document.getElementById("hiding").hidden = !view.needsHiding;
  const problem = document.getElementById("problem");
  problem.hidden = !view.problem;
  problem.textContent = view.problem || "";

  place(document.getElementById("essentials"), view.essentials.map(tile));
  document.getElementById("space-name").textContent = view.alone ? space?.name || "" : "";

  const list = view.folders.map(folder);
  if (view.folders.length && view.tabs.length) list.push(keep("divider", () => el("div", "divider"), 0, () => {}));
  list.push(...view.tabs.map(t => row(t, null)));
  place(document.getElementById("tabs"), list);

  place(document.getElementById("spaces"), view.spaces.map(s => keep("space:" + s.id, () => {
    const b = el("button", "space");
    b.dataset.space = s.id;
    b.onclick = () => send({ type: "space", space: s.id });
    b.append(el("span", "dot"));
    return b;
  }, { s, active: s.id === view.space }, b => {
    b.classList.toggle("active", s.id === view.space);
    b.title = s.name;
    b.style.setProperty("--color", s.color);
  })));

  for (const id of kept.keys()) if (!drawn.has(id)) kept.delete(id);
  const keys = new Set(view.folders.map(f => f.key));
  if (renameNext) for (const k of keys) if (!folderKeys.has(k)) { renameNext = false; rename(k); }
  folderKeys = keys;
}

document.getElementById("new-tab").onclick = () => send({ type: "newTab", space: view?.space });
document.getElementById("new-folder").onclick = () => { renameNext = true; send({ type: "newFolder", space: view?.space }); };
document.getElementById("tabs").oncontextmenu = e => {
  if (view?.alone && e.target.id === "tabs") openMenu(e, listMenu());
};
// Asking needs your click, so it is here and not in the background.
document.getElementById("allow-hiding").onclick = () => browser.permissions.request({ permissions: ["tabHide"] });
