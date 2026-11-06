// What an agent is doing, in the sidebar (bridge.js). Nothing shows unless one is at
// work: while it is, a quiet ring on its space's dot and one line above the bar, with its
// last action and a Stop that cuts the bridge at once. A still mark on the space's dot
// while a tab it left you waits in For you, and the note it left on that tab's row.
//
// This has a port of its own, so an agent's actions never make the whole view be drawn
// again; and it reacts to the view after render, since a row drawn again loses what was
// added to it.

const agentPort = browser.runtime.connect({ name: "agent" });
let agentState = { copy: false, active: false, line: null, space: null, forYou: {} };
let agentWindowId = null;
browser.windows.getCurrent().then(w => { agentWindowId = w.id; });

const agentLineBox = document.createElement("div");
agentLineBox.id = "agent-line";
agentLineBox.hidden = true;
const agentLineText = document.createElement("span");
agentLineText.className = "agent-action";
const agentStop = document.createElement("button");
agentStop.className = "agent-stop";
agentStop.textContent = "Stop";
agentStop.title = "Cut the bridge at once. It stays off until you turn it on in the settings.";
agentStop.onclick = () => agentPort.postMessage({ type: "stop" });
agentStop.onkeydown = e => e.stopPropagation(); // Enter is for this button here, not for the list (keys.js)
agentLineBox.append(agentLineText, agentStop);
document.getElementById("spaces").before(agentLineBox);

function drawAgent() {
  agentLineBox.hidden = !agentState.active;
  agentLineText.textContent = agentState.line ? `Agent: ${agentState.line}` : "";
  agentLineText.title = agentLineText.textContent;
  for (const dot of document.querySelectorAll("#spaces .space")) {
    dot.classList.toggle("agent-active", agentState.active && dot.dataset.space === agentState.space);
    dot.classList.toggle("agent-left", Object.hasOwn(agentState.forYou, dot.dataset.space));
  }
}

// A row drawn again has lost its note. Only rows with a note are looked up: a view can
// have a thousand tabs, and almost never a note.
let agentNoted = new Set();
function drawAgentNotes(next) {
  const noted = new Set();
  for (const f of next?.folders ?? []) {
    for (const t of f.tabs) {
      if (!t.note) continue;
      noted.add(t.id);
      const row = document.querySelector(`#tabs [data-tab="${t.id}"]`);
      if (!row || row.querySelector(".agent-note")) continue;
      const note = document.createElement("span");
      note.className = "agent-note";
      note.textContent = t.note;
      row.querySelector(".title")?.after(note);
      row.title = `${t.note}\n${t.title}`;
    }
  }
  for (const id of agentNoted) if (!noted.has(id)) document.querySelector(`#tabs [data-tab="${id}"] .agent-note`)?.remove();
  agentNoted = noted;
}

agentPort.onMessage.addListener(state => { agentState = state; drawAgent(); });
port.onMessage.addListener(next => { drawAgent(); drawAgentNotes(next); });

// In the tab menu and on a space's menu, where those are here. On DOMContentLoaded, so
// the order of the scripts in sidebar.html does not matter. Only once you have turned it on.
document.addEventListener("DOMContentLoaded", () => {
  if (typeof TAB_MENU === "undefined") return;
  const after = TAB_MENU.findIndex(item => item.id === "copy") + 1;
  TAB_MENU.splice(after || TAB_MENU.length, 0,
    { id: "claude-copy", group: 2, many: true, label: n => (n > 1 ? `Copy ${n} tabs for Claude` : "Copy page for Claude"),
      when: tabs => agentState.copy && tabs.every(t => !!t.address),
      run: tabs => agentPort.postMessage({ type: "copyForClaude", tabIds: tabs.map(t => t.id), windowId: agentWindowId }) },
    { id: "claude-ask", group: 2, label: () => "Ask Claude about this page",
      when: tabs => agentState.copy && !!tabs[0].address,
      run: tabs => agentPort.postMessage({ type: "askClaude", tabId: tabs[0].id, windowId: agentWindowId }) });
});
