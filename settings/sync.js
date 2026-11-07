// The settings page's part for sync across machines and spaces hidden on this one
// (sync.js, hiddenspaces.js in the background). Uses $ and el from settings.js.

const syncKB = bytes => Math.ceil(bytes / 1024);
const syncCount = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SYNC_KIND_NAMES = { essentials: ["essential", "essentials"], folders: ["folder", "folders"], saved: ["saved tab", "saved tabs"] };

function drawSyncState(r) {
  $("sync-section").hidden = !r.alone;
  $("sync-on").checked = r.on;
  const state = $("sync-state"), left = $("sync-left");
  state.hidden = !r.on;
  state.className = r.problem ? "notice" : "hint";
  state.textContent = r.problem ? `Stopped: ${r.problem}` : `${syncKB(r.bytes)} KB of the ${syncKB(r.limit)} KB Firefox Sync allows is used.`;
  // What does not fit is said plainly: it is here, and not on your other machines.
  left.hidden = !r.left.length;
  if (r.left.length) {
    const counts = Object.entries(SYNC_KIND_NAMES).map(([kind, [one, many]]) => [r.left.filter(l => l.kind === kind).length, one, many])
      .filter(([n]) => n).map(([n, one, many]) => syncCount(n, one, many));
    const names = r.left.slice(0, 5).map(l => l.title).join(", ");
    left.className = "notice";
    left.textContent = `${counts.join(" and ")} did not fit, and stay on this machine only: ${names}${r.left.length > 5 ? ", …" : ""}`;
  }
}

function drawSpacesHere(r) {
  const box = $("spaces-here");
  box.hidden = !r.alone || r.spaces.length < 2;
  const showing = r.spaces.filter(s => !s.hidden).length;
  const ticks = r.spaces.map(s => {
    if (s.declared) return el("span", { className: "line", title: "Hidden on this machine by its setup", textContent: `${s.name}: hidden by this machine's setup` });
    const last = !s.hidden && showing < 2; // a window needs a space to show
    const tick = el("input", { type: "checkbox", checked: !s.hidden, disabled: last, title: last ? "A window needs a space to show" : "" });
    tick.onchange = async () => drawSync(await browser.runtime.sendMessage({ type: "sync:hide", space: s.id, hidden: !tick.checked }));
    return el("label", { className: "line" }, tick, el("span", { textContent: "●", style: `color:${s.color}` }), s.name);
  });
  box.replaceChildren(
    el("h3", { textContent: "Shown on this machine" }),
    el("div", { className: "ticks" }, ...ticks),
    el("p", { className: "hint", textContent: "A space that is not ticked gets no tabs here and is not on the bar. Nothing in it is deleted, and your other machines keep it." }),
  );
}

function drawSync(r) {
  if (!r) return;
  drawSyncState(r);
  drawSpacesHere(r);
}
const refreshSync = async () => drawSync(await browser.runtime.sendMessage({ type: "sync:get" }));

$("sync-on").onchange = async e => {
  const state = $("sync-state");
  if (e.target.checked) { state.hidden = false; state.className = "hint"; state.textContent = "Putting together what is here and what your other machines have…"; }
  drawSync(await browser.runtime.sendMessage({ type: "sync:turn", on: e.target.checked }));
};

// What changes while the page is open, by a round in the background or on another machine.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" || "syncState" in changes || "hiddenSpaces" in changes) refreshSync();
  // A page left open must not save an old list of rules over one that came from another machine.
  if ("rules" in changes) refresh();
});
browser.contextualIdentities.onUpdated.addListener(() => { refreshSync(); refresh(); });
refreshSync();
