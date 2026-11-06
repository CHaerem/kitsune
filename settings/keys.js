// The Keys section of the settings page, with Tidier alone: every command with its key,
// changed by clicking it and pressing the new one. What may be chosen is decided in the
// background (setCommandKey in keys-commands.js). Firefox's own page for this refuses
// every key Firefox uses, ⌘1 and ⌘D among them; commands.update does not.

// The key's name in a shortcut, found much as Firefox's own page finds it: the letter the
// keyboard's layout gives, else the physical key, since ⌥ can make a letter into
// something else on a Mac.
const VALID_KEY = /^([A-Z0-9]|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right|F[1-9]|F1[0-2])$/;
const keyName = e => [String.fromCharCode(e.which), e.code.replace(/^(Digit|Arrow|Numpad|Key)/, ""), e.key.replace(/^(Digit|Arrow|Numpad)/, ""), { ",": "Comma", ".": "Period", " ": "Space" }[e.key]]
  .find(k => VALID_KEY.test(k ?? "")) ?? "";

// A shortcut as Firefox writes it, or "" while only modifiers are down. Shift alone or
// no modifier at all is no shortcut, except on a function key.
function shortcutOf(e, mac) {
  const key = keyName(e);
  if (!key) return "";
  const mods = mac ? [["MacCtrl", e.ctrlKey], ["Alt", e.altKey], ["Command", e.metaKey], ["Shift", e.shiftKey]] : [["Ctrl", e.ctrlKey], ["Alt", e.altKey], ["Shift", e.shiftKey]];
  const down = mods.filter(([, on]) => on).map(([m]) => m);
  if (!/^F\d+$/.test(key) && !down.some(m => m !== "Shift")) return "";
  return [...down, key].join("+");
}

// What to say under a line, until you change that key again. Kept here since a change
// draws the lines anew, by itself (commands.onChanged) and from here.
const keyNotes = new Map(); // command -> text

// Numbered commands share a line: twenty-two lines would be a wall.
const keyGroup = name => name.startsWith("space-") ? "Go to a space" : name.startsWith("tab-") ? "Go to a tab of this space" : null;

async function drawKeys(focus) {
  const commands = await ask("keys");
  const lines = [];
  for (const c of commands) {
    const group = keyGroup(c.name), last = lines.at(-1);
    if (group && last?.label === group) last.commands.push(c);
    else lines.push({ label: group ?? c.label, commands: [c] });
  }
  $("keys").replaceChildren(...lines.map(keyLine));
  $("keys-back").hidden = !commands.some(c => c.changed);
  if (focus) $("keys").querySelector(`[data-command="${focus}"]`)?.focus();
}

async function chooseKey(name, shortcut) {
  const r = await ask("setKey", { name, shortcut });
  keyNotes.set(name, r?.refused ?? r?.note);
  await drawKeys(name);
}

function keyLine({ label, commands }) {
  const said = commands.map(c => keyNotes.get(c.name)).find(Boolean);
  const note = el("p", { className: "key-note", textContent: said ?? "", hidden: !said });
  const line = el("div", { className: "key-line" }, el("span", { className: "key-label", textContent: label }), el("span", { className: "key-group" }, ...commands.map(c => keyButton(c, note))));
  return el("div", {}, line, note);
}

function keyButton(c, note) {
  const shown = c.pretty || "none";
  const key = el("button", { className: c.pretty ? "key" : "key none", textContent: shown, title: c.label });
  key.dataset.command = c.name;
  const stop = () => { key.classList.remove("recording"); key.textContent = shown; };
  key.onclick = () => {
    keyNotes.delete(c.name);
    note.hidden = true;
    key.classList.add("recording");
    key.textContent = "Press a key…";
  };
  key.onblur = stop;
  key.onkeydown = e => {
    if (!key.classList.contains("recording") || e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { stop(); return; }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && (e.key === "Backspace" || e.key === "Delete")) { chooseKey(c.name, ""); return; }
    const shortcut = shortcutOf(e, keysMac);
    if (shortcut) chooseKey(c.name, shortcut);
    else if (keyName(e)) { note.textContent = keysMac ? "A key needs ⌘, ⌃ or ⌥ with it." : "A key needs Ctrl or Alt with it."; note.hidden = false; }
  };
  return key;
}

// A section only for Tidier alone: without it, Sidebery has the keys.
let keysMac = false;
async function startKeys() {
  const [{ os }, { report }] = await Promise.all([browser.runtime.getPlatformInfo(), ask("get")]);
  keysMac = os === "mac";
  $("keys-section").hidden = !report.alone;
  if (!report.alone) return;
  $("keys-back").onclick = async () => { keyNotes.clear(); await ask("keysBack"); await drawKeys(); };
  await drawKeys();
  // Changed on Firefox's own page meanwhile, and by the two functions above.
  browser.commands.onChanged?.addListener(() => { if (!document.querySelector(".key.recording")) drawKeys(); });
}
if (globalThis.document) startKeys();
