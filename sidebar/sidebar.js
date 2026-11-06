// Draws the view the background sends (sidebar-view.js) and sends back what
// you do. Text is only ever set with textContent, so a page title cannot add
// anything to the sidebar.

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

// Folds are kept per folder for this sidebar (until folders are Tidier's own data).
const collapsed = new Set();

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function icon(item) {
  if (item.icon && /^(https?:|data:|moz-extension:)/.test(item.icon)) {
    const img = el("img");
    img.src = item.icon;
    img.alt = "";
    img.onerror = () => img.replaceWith(el("span", "letter", (item.title || "?").trim()[0] || "?"));
    return img;
  }
  return el("span", "letter", (item.title || "?").trim()[0] || "?");
}

function tile(item) {
  const t = el("div", "tile" + (item.active ? " active" : "") + (item.loaded ? "" : " unloaded"));
  t.title = item.title;
  t.append(icon(item));
  t.onclick = () => port.postMessage({ type: "select", tabId: item.id });
  return t;
}

function row(item) {
  const r = el("div", "row" + (item.active ? " active" : "") + (item.loaded ? "" : " unloaded"));
  r.title = item.title;
  const close = el("button", "close", "×");
  close.title = "Close";
  close.onclick = e => { e.stopPropagation(); port.postMessage({ type: "close", tabId: item.id }); };
  r.append(icon(item), el("span", "title", item.title), close);
  r.onclick = () => port.postMessage({ type: "select", tabId: item.id });
  r.onauxclick = e => { if (e.button === 1) port.postMessage({ type: "close", tabId: item.id }); };
  return r;
}

function folder(f) {
  const box = el("div", "folder" + (collapsed.has(f.key) ? " collapsed" : ""));
  const head = el("div", "row");
  head.append(el("span", "chevron", "▾"), el("span", "title", f.name));
  head.onclick = () => {
    if (collapsed.has(f.key)) collapsed.delete(f.key); else collapsed.add(f.key);
    box.classList.toggle("collapsed");
  };
  const children = el("div", "children");
  children.append(...f.tabs.map(row));
  box.append(head, children);
  return box;
}

function render(view) {
  const space = view.spaces.find(s => s.id === view.space);
  document.documentElement.style.setProperty("--accent", space?.color || "#7a7a80");
  document.documentElement.dataset.space = view.space || "";

  document.getElementById("essentials").replaceChildren(...view.essentials.map(tile));

  const list = [...view.folders.map(folder)];
  if (view.folders.length && view.tabs.length) list.push(el("div", "divider"));
  list.push(...view.tabs.map(row));
  document.getElementById("tabs").replaceChildren(...list);

  document.getElementById("spaces").replaceChildren(...view.spaces.map(s => {
    const b = el("button", "space" + (s.id === view.space ? " active" : ""));
    b.title = s.name;
    b.style.setProperty("--color", s.color);
    b.append(el("span", "dot"));
    b.onclick = () => port.postMessage({ type: "space", space: s.id });
    return b;
  }));
}
