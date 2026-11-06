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
    el("li", { textContent: `${r.rules} rules. Sidebery's own rules can only be read from its export: import it below first.` }),
  );
  drawSpaces();
  if (document.activeElement?.closest?.("#rules") == null) drawRules();
  if (document.activeElement !== $("archive-hours")) $("archive-hours").value = state.archiveHours;
  $("copy-state").textContent = state.lastCopy ? `Last copy: ${new Date(state.lastCopy).toLocaleString()}.` : "No copy made yet.";
  $("version").textContent = "Version " + state.version;
}

function drawRules() {
  const save = () => ask("rules", { rules: [...$("rules").children].map(l => ({ url: l.querySelector("input").value.trim(), space: l.querySelector("select").value })) });
  $("rules").replaceChildren(...state.rules.map(rule => ruleLine(rule, save)));
}
function ruleLine(rule, save) {
  const text = el("input", { type: "text", value: rule.url, placeholder: "address, or /regular expression/" });
  const space = el("select", {}, ...state.spaces.map(s => el("option", { value: s.id, textContent: s.name, selected: s.id === rule.space })));
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
  // Asked here, in one go: the permissions need your click. Without them, tabs are simply
  // not hidden yet, and a page's first request can go out in the wrong container.
  browser.sidebarAction.open(); // also needs your click: Firefox brings it back after Tidier starts again
  await browser.permissions.request({ permissions: ["tabHide", "webRequest", "webRequestBlocking"], origins: ["<all_urls>"] }).catch(() => {});
  await ask("moveOver");
};
$("do-move-back").onclick = () => ask("moveBack");
const readFile = async input => JSON.parse(await input.files[0].text());
$("sidebery-file").onchange = async e => {
  const r = await ask("importSidebery", { backup: await readFile(e.target) });
  $("sidebery-result").textContent = `Imported ${r.rules} rules and the order of ${r.order} spaces.`;
  refresh();
};
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
$("copy-file").onchange = async e => {
  incoming = await readFile(e.target);
  const summary = await ask("copySummary", { copy: incoming });
  const name = id => state.spaces.find(s => s.id === id)?.name || id;
  $("merge-spaces").replaceChildren(...Object.entries(summary).map(([id, n]) => el("label", { className: "line" },
    el("input", { type: "checkbox", checked: true, value: id }),
    `${name(id)}: ${n.essentials} essentials, ${n.folders} folders, ${n.savedTabs} saved tabs`)));
  $("merge").hidden = false;
};
$("merge-go").onclick = async () => {
  const spaces = [...$("merge-spaces").querySelectorAll("input:checked")].map(i => i.value);
  const r = await ask("merge", { copy: incoming, spaces });
  $("merge-result").textContent = `Took in ${r.essentials} essentials, ${r.folders} folders and ${r.tabs} saved tabs. Nothing here was removed.`;
  $("merge").hidden = true;
};

browser.permissions.onAdded.addListener(refresh);
refresh();
