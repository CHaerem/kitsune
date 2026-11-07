// The settings page: everything goes through the background (moveover.js).
const ask = (what, more) => browser.runtime.sendMessage({ type: "settings:" + what, ...more });
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

let state = null;

async function refresh() {
  state = await ask("get");
  $("notices").replaceChildren(...state.notices.map(text => el("p", { className: "notice", textContent: text })));
  const r = state.report;
  $("alone-state").textContent = r.alone ? "Tidier is on its own here: no Sidebery needed." : "This browser uses Sidebery for its tab list, spaces and folders.";
  $("allow-hiding").hidden = !r.alone || state.hiding;
  $("move").hidden = r.alone;
  $("move-back").hidden = !(r.alone && r.canMoveBack);
  $("report").replaceChildren(
    el("li", { textContent: `${r.essentials} essentials and ${r.tabs} tabs stay as they are.` }),
    el("li", { textContent: `${r.folders.length} folders become Tidier's own: ` + r.folders.map(f => `${f.name} (${f.tabs})`).join(", ") }),
    el("li", { textContent: `${r.rules} rules. Sidebery's own rules, and which folders are closed, can only be read from its export: import it below first, with a snapshot in it.` }),
  );
  drawSpaces();
  if (document.activeElement?.closest?.("#rules") == null) drawRules();
  if (document.activeElement !== $("archive-hours")) $("archive-hours").value = state.archiveHours;
  $("copy-state").textContent = state.lastCopy ? `Last copy: ${new Date(state.lastCopy).toLocaleString()}.` : "No copy made yet.";
  $("version").textContent = "Version " + state.version;
}

function drawSpaces() {
  $("spaces").replaceChildren(...state.spaces.map(s => {
    const name = el("input", { type: "text", value: s.name });
    name.onchange = () => ask("space", { id: s.id, changes: { name: name.value } });
    return el("div", { className: "line" }, el("span", { textContent: "●", style: `color:${s.color}` }), name);
  }));
}

function drawRules() {
  const save = () => ask("rules", { rules: [...$("rules").children].map(l => ({ url: l.querySelector("input").value.trim(), space: l.querySelector("select").value })) });
  $("rules").replaceChildren(...state.rules.map(rule => ruleLine(rule, save)));
}
function ruleLine(rule, save) {
  const text = el("input", { type: "text", value: rule.url, placeholder: "address, or /regular expression/" });
  const space = el("select", {}, ...state.spaces.map(s => el("option", { value: s.id, textContent: s.name, selected: s.id === rule.space })));
  // A rule whose space is gone: with no option of its own it would show the first space,
  // and saving any rule would quietly send its addresses there, with other logins.
  if (rule.space && !state.spaces.some(s => s.id === rule.space)) space.prepend(el("option", { value: rule.space, textContent: "A space that is gone", selected: true }));
  const remove = el("button", { textContent: "×", title: "Remove" });
  const line = el("div", { className: "line" }, text, space, remove);
  text.onchange = space.onchange = save;
  remove.onclick = () => { line.remove(); save(); };
  return line;
}
$("add-rule").onclick = () => {
  const save = () => ask("rules", { rules: [...$("rules").children].map(l => ({ url: l.querySelector("input").value.trim(), space: l.querySelector("select").value })) });
  $("rules").append(ruleLine({ url: "", space: state.spaces[0]?.id }, save));
};

$("archive-hours").onchange = e => ask("archiveHours", { hours: e.target.value });
$("allow-hiding").onclick = () => browser.permissions.request({ permissions: ["tabHide"] }).then(refresh);
$("move-over").onclick = async () => {
  // Asked here: the permission needs your click. Without it, tabs are simply not hidden yet.
  browser.sidebarAction.open(); // also needs your click: Firefox brings it back after Tidier starts again
  await browser.permissions.request({ permissions: ["tabHide"] }).catch(() => {});
  await ask("moveOver");
};
$("do-move-back").onclick = () => ask("moveBack");
// A file you chose, or null if it is no JSON at all. Emptied after reading, or choosing
// the same file again (after making a new export, say) would do nothing.
const readFile = async input => {
  try { return JSON.parse(await input.files[0].text()); } catch (err) { return null; } finally { input.value = ""; }
};
const counted = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const andList = parts => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
const sideberyResult = r => {
  const parts = [r.rules && counted(r.rules, "rule"), r.order && `the order of ${counted(r.order, "space")}`, r.folds && counted(r.folds, "closed folder")].filter(Boolean);
  return [
    parts.length ? `Imported ${andList(parts)}.` : "Nothing new to import.",
    r.newSpaces.length && `${r.newSpaces.length === 1 ? "A new space" : "New spaces"}: ${r.newSpaces.join(", ")}.`,
    r.panelsLeftOut && `Left out the rules of ${counted(r.panelsLeftOut, "panel")} with no container.`,
    r.folds === null && "There is no snapshot in this export, so folders start open. To keep which are closed: Create snapshot in Sidebery's settings, and export again.",
  ].filter(Boolean).join(" ");
};
// A background error says so here too, rather than leaving the page as it was.
const orSay = (line, job) => job().catch(err => { line.textContent = `That did not work: ${err.message}`; });
$("sidebery-file").onchange = e => orSay($("sidebery-result"), async () => {
  const r = await ask("importSidebery", { backup: await readFile(e.target) });
  $("sidebery-result").textContent = r ? sideberyResult(r) : "This is not Sidebery's export.";
  if (r) refresh();
});
$("copy-now").onclick = async () => {
  const r = await ask("copyNow");
  $("copy-state").textContent = r?.saved ? `Saved as ${r.saved}.` : `No copy was made: ${r?.error}`;
};
$("copy-save").onclick = async () => {
  const copy = await ask("copyFile");
  const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(copy)], { type: "application/json" })), download: `tidier-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
};
let incoming = null;
const mergeLine = ([id, n]) => {
  const comes = [counted(n.essentials, "essential"), counted(n.folders, "folder"), counted(n.savedTabs, "saved tab"), counted(n.rules, "rule")].filter(part => !part.startsWith("0 "));
  const text = [...comes, ...(n.isNew ? ["a new space"] : [])].join(", ") || "nothing new";
  return el("label", { className: "line" },
    el("input", { type: "checkbox", checked: true, value: id }),
    el("span", { textContent: "●", style: `color:${n.color}` }),
    `${n.name}: ${text}`);
};
$("copy-file").onchange = e => orSay($("merge-result"), async () => {
  $("merge-result").textContent = "";
  $("merge").hidden = true;
  incoming = await readFile(e.target);
  const summary = await ask("copySummary", { copy: incoming });
  if (!summary) { $("merge-result").textContent = "This is not a Tidier copy."; return; }
  const lines = Object.entries(summary);
  if (!lines.some(([, n]) => n.essentials || n.folders || n.savedTabs || n.rules || n.isNew)) { $("merge-result").textContent = "Nothing new: all of it is here already."; return; }
  $("merge-spaces").replaceChildren(...lines.map(mergeLine));
  $("merge").hidden = false;
});
$("merge-go").onclick = () => orSay($("merge-result"), async () => {
  const spaces = [...$("merge-spaces").querySelectorAll("input:checked")].map(i => i.value);
  $("merge").hidden = true; // at once: a second click would find all of it here, and say only that
  const r = await ask("merge", { copy: incoming, spaces });
  const took = andList([
    r.essentials && counted(r.essentials, "essential"), r.folders && counted(r.folders, "folder"),
    r.tabs && counted(r.tabs, "saved tab"), r.rules && counted(r.rules, "rule"), r.spaces && counted(r.spaces, "new space"),
  ].filter(Boolean));
  $("merge-result").textContent = took ? `Took in ${took}. Nothing here was removed.` : "Nothing taken in.";
  refresh();
});

browser.permissions.onAdded.addListener(refresh);
refresh();
