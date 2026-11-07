// The command bar's page: a field and the rows for what is typed. What can be found comes
// once from the background (commandbar.js) when the page connects; ranking happens here
// (rank.js), so typing needs no round trip. History and bookmarks are asked on each change
// of the text, only if you allowed them, and only because you typed.
//
// Text is only ever set with textContent, so a page title cannot add anything to the bar.

const field = document.getElementById("field"), list = document.getElementById("rows");
const PLACEHOLDER = "Search, or type an address";
const HISTORY_RESULTS = 25, HISTORY_WAIT_MS = 40; // a few keys in a row are one lookup
field.placeholder = PLACEHOLDER;
field.focus(); // typing works from here on, also before anything has come back

let data = null; // what the background sent
let found = []; // from history and bookmarks, for the text as it is
let rows = [], selected = 0;
let step = null; // a command asking something: { row, kind: "ask" | "list", text (what was typed before) }
let asking = false; // a permission prompt is open, and must not close the bar
let enterWaiting = null; // Enter before anything has come back
let historyTimer = null, historySeq = 0;

const port = browser.runtime.connect({ name: "commandbar" });
const send = msg => port.postMessage(msg);
port.onDisconnect.addListener(() => window.close());
port.onMessage.addListener(snapshot => {
  data = snapshot;
  if (data.color) document.documentElement.style.setProperty("--accent", data.color);
  if (data.space) document.documentElement.dataset.space = data.space;
  update();
  // For the smoke test, which prints it: from the key to the bar in use.
  document.documentElement.dataset.readyMs = Date.now() - data.pressedAt;
  if (enterWaiting !== null) { const inNewTab = enterWaiting; enterWaiting = null; choose(rows[selected], inNewTab); }
});

// Your own look (dotfiles' tidier.css), as in the sidebar: the tint of the active space.
browser.storage.managed.get("sidebarCSS").then(({ sidebarCSS }) => {
  if (!sidebarCSS) return;
  const style = document.createElement("style");
  style.textContent = sidebarCSS;
  document.head.append(style);
}, () => {});

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// --- Rows ---------------------------------------------------------------------------
// The one row asking for history and bookmarks: quiet, last, and gone once you answered.
function askRow() {
  if (!data || data.asked || (browser.history && browser.bookmarks)) return [];
  return [{ kind: "ask", id: "ask", title: "Also search history and bookmarks", quiet: true }];
}

function rowsNow() {
  const text = field.value;
  if (step?.kind === "ask") return [];
  if (step?.kind === "list") {
    const choices = step.row.list;
    return text.trim() ? rankResults(text, choices) : choices;
  }
  if (!data) return addressFrom(text) ? resultsFor(text, []) : [];
  return resultsFor(text, [...data.items, ...found], { tail: text.trim() ? askRow() : [] });
}

function second(row) {
  if (row.kind === "command") return prettyKey(row.shortcut, data?.mac);
  if (row.kind === "folder") return "Folder";
  if (row.kind === "closed") return `${siteOf(row.url)} · closed`;
  if (row.kind === "archived") return `${siteOf(row.url)} · ${row.why === "closed" ? "closed" : "archived"}`;
  if (row.kind === "address" || row.kind === "search" || row.kind === "ask" || !row.url) return "";
  return siteOf(row.url);
}

function picture(row) {
  const glyphs = { command: "›", choice: "›", folder: "▾", search: "⌕", address: "→", ask: "＋" };
  if (glyphs[row.kind]) return el("span", "glyph", glyphs[row.kind]);
  const letter = () => el("span", "letter", (row.title || "?").trim()[0] || "?");
  if (!row.icon || !/^(https?:|data:|moz-extension:)/.test(row.icon)) return letter();
  const img = el("img");
  img.src = row.icon;
  img.alt = "";
  img.onerror = () => img.replaceWith(letter());
  return img;
}

function draw() {
  field.removeAttribute("aria-activedescendant");
  list.replaceChildren(...rows.map((row, i) => {
    const e = el("div", "row" + (row.quiet ? " quiet" : "") + (i === selected ? " selected" : ""));
    e.id = "row-" + i;
    e.dataset.i = i;
    e.dataset.kind = row.kind;
    e.setAttribute("role", "option");
    if (row.url) e.dataset.url = row.url;
    const dot = el("span", "dot");
    const color = data?.spaces.find(s => s.id === row.space)?.color;
    if (color) { dot.style.setProperty("--color", color); dot.title = data.spaces.find(s => s.id === row.space).name; }
    e.append(dot, picture(row), el("span", "title", row.title));
    const text = second(row);
    if (text) e.append(el("span", "site", text));
    return e;
  }));
  if (rows.length) field.setAttribute("aria-activedescendant", "row-" + selected);
}

function select(i) {
  if (i === selected || !rows[i]) return;
  list.children[selected]?.classList.remove("selected");
  selected = i;
  list.children[i].classList.add("selected");
  list.children[i].scrollIntoView({ block: "nearest" });
  field.setAttribute("aria-activedescendant", "row-" + i);
}

// Rows anew for the text as it is. The row you moved to stays selected if it is still there,
// when something arrives from history a moment later.
function update({ keepSelected = false } = {}) {
  const was = keepSelected ? rows[selected]?.id : null;
  rows = rowsNow();
  const at = was ? rows.findIndex(r => r.id === was) : 0;
  selected = Math.max(at, 0);
  draw();
}

// --- History and bookmarks ----------------------------------------------------------
function lookUpMore() {
  clearTimeout(historyTimer);
  const text = field.value.trim();
  const seq = ++historySeq;
  // What is found stays until the next answer: ranking drops what no longer matches, and
  // the rows do not flicker on every key.
  if (!text || step || !(browser.history || browser.bookmarks)) { found = []; return; }
  historyTimer = setTimeout(async () => {
    const [history, bookmarks] = await Promise.all([
      browser.history?.search({ text, maxResults: HISTORY_RESULTS, startTime: 0 }).catch(() => []) ?? [],
      browser.bookmarks?.search(text).catch(() => []) ?? [],
    ]);
    if (seq !== historySeq) return;
    found = [
      ...history.filter(h => h.url && /^https?:/.test(h.url)).map(h => ({ kind: "history", id: `history:${h.id}`, title: h.title || h.url, url: h.url, lastUsed: h.lastVisitTime })),
      ...bookmarks.filter(b => b.url && /^https?:/.test(b.url)).map(b => ({ kind: "bookmark", id: `bookmark:${b.id}`, title: b.title || b.url, url: b.url, lastUsed: b.dateAdded })),
    ];
    update({ keepSelected: true });
  }, HISTORY_WAIT_MS);
}

async function askForMore() {
  asking = true;
  const allowed = await browser.permissions.request({ permissions: ["history", "bookmarks"] }).catch(() => false);
  asking = false;
  field.focus();
  send({ type: "asked" });
  data.asked = true;
  lookUpMore();
  update({ keepSelected: allowed });
}

// --- Choosing -----------------------------------------------------------------------
const closeBar = refocus => send({ type: "close", refocus });

function startStep(row, kind) {
  step = { row, kind, text: field.value };
  field.value = kind === "ask" ? row.ask.value ?? "" : "";
  field.placeholder = kind === "ask" ? row.ask.placeholder : row.placeholder ?? row.title;
  field.select();
  lookUpMore();
  update();
}

function endStep() {
  field.value = step.text;
  field.placeholder = PLACEHOLDER;
  step = null;
  lookUpMore();
  update();
}

// Only what the background needs to know which row this was.
const chosen = (row, more) => send({
  type: "choose", ...more,
  row: { kind: row.kind, key: row.key, tabId: row.tabId, url: row.url, sessionId: row.sessionId, query: row.query, name: row.name, value: row.value, space: row.space, archived: row.archived },
});

async function searchFor(row) {
  // A permission without a prompt, but asked for here, in the key press: the manifest gets
  // no new required permission, since that reaches machines before anyone looks.
  if (!browser.search) {
    asking = true;
    const allowed = await browser.permissions.request({ permissions: ["search"] }).catch(() => false);
    asking = false;
    if (!allowed) return;
  }
  chosen(row);
}

function choose(row, inNewTab) {
  if (step?.kind === "ask") return chosen(step.row, { value: field.value.trim() });
  if (step?.kind === "list") return row && chosen(step.row, { value: row.value });
  if (!data) { enterWaiting = inNewTab; return; } // a moment: the rows are on their way
  // ⌘↵ with nothing typed is the shortest way to an empty new tab.
  if (inNewTab && !field.value.trim()) {
    const newTab = data.items.find(i => i.name === "new-tab");
    if (newTab) return chosen(newTab);
  }
  if (!row) return;
  if (row.kind === "ask") return askForMore();
  if (row.kind === "search") return searchFor(row);
  if (row.kind === "command" && row.ask) return startStep(row, "ask");
  if (row.kind === "command" && row.list) return startStep(row, "list");
  chosen(row, { inNewTab });
}

// --- Keys and pointer ----------------------------------------------------------------
field.addEventListener("input", () => { lookUpMore(); update(); });

addEventListener("keydown", e => {
  if (e.isComposing) return; // a key that belongs to composing a letter
  const n = rows.length;
  switch (e.key) {
    case "ArrowDown": if (n) select((selected + 1) % n); break;
    case "ArrowUp": if (n) select((selected - 1 + n) % n); break;
    case "Enter": if (!e.repeat) choose(rows[selected], e.metaKey || e.ctrlKey); break; // held down, it would answer the question it has just brought up
    case "Escape": if (step) endStep(); else closeBar(true); break;
    case "Tab":
      if (rows[selected] && !step) { field.value = completionFor(rows[selected], field.value); lookUpMore(); update(); }
      break;
    default: return;
  }
  e.preventDefault();
}, true);

// A pointer that lies still must not take the selection from the keys: only a move counts.
list.addEventListener("mousemove", e => {
  const row = e.target.closest?.(".row");
  if (row) select(Number(row.dataset.i));
});
list.addEventListener("mousedown", e => e.preventDefault()); // the field keeps the focus
list.addEventListener("click", e => {
  const row = e.target.closest?.(".row");
  if (row) choose(rows[Number(row.dataset.i)], e.metaKey || e.ctrlKey);
});

// Losing the focus closes it, like Arc's. What counts is the window: inside it the focus can
// hop away from the page and back (Firefox settles the new window), and then you can simply
// go on typing, unless it is Firefox's own prompt that has it. A moment later, for a window
// that is still getting the focus.
//
// With the prompt open the page has already lost the focus, so going to another window brings
// it no blur, and the bar would stay behind that window with its prompt, until the key closed
// it instead of opening it. So then the window's own event counts too, and only then: a new
// window's focus can pass through "none" on its way here, which must not close the bar.
function focusWent() {
  setTimeout(async () => {
    if (document.hasFocus()) return;
    const win = await browser.windows.getCurrent();
    if (!win.focused) closeBar(false);
    else if (!asking) { window.focus(); field.focus(); }
  }, 50);
}
addEventListener("blur", e => { if (e.target === window) focusWent(); });
browser.windows.onFocusChanged.addListener(() => { if (asking) focusWent(); });
