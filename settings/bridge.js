// Claude and other agents, on the settings page (bridge.js does the rest). What is asked
// of Firefox is asked in the click itself, since it needs one; nothing waits for your
// answer, and an agent that may not read pages can still see tabs and addresses.
const bridgePort = browser.runtime.connect({ name: "agent-settings" });
const bridgeAsk = (what, more) => browser.runtime.sendMessage({ type: "bridge:" + what, ...more });
const askToRead = () => { browser.permissions.request({ origins: ["<all_urls>"] }).catch(err => console.warn("Tidier: asking to read pages", err)); };

const bridgeBox = document.getElementById("claude-section");
const bridgeEl = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

const copySwitch = bridgeEl("input", { type: "checkbox", id: "claude-copy" });
const bridgeSwitch = bridgeEl("input", { type: "checkbox", id: "bridge-on" });
const readingLine = bridgeEl("p", { className: "hint", id: "bridge-reading" });
const allowReading = bridgeEl("button", { id: "bridge-allow-reading", textContent: "Allow reading pages" });
const bridgeDetails = bridgeEl("div", { id: "bridge-details" });
const bridgeStatus = bridgeEl("p", { id: "bridge-status" });
const bridgeHowTo = bridgeEl("pre", { id: "bridge-how" });
const bridgeSpacesBox = bridgeEl("div", { id: "bridge-spaces" });
const bridgeLogBox = bridgeEl("ol", { id: "bridge-log" });

bridgeBox.append(
  bridgeEl("h2", { textContent: "Claude and other agents" }),
  bridgeEl("label", { className: "line" }, copySwitch, "Copy for Claude"),
  bridgeEl("p", { className: "hint", textContent: "A tab's menu and the command bar get Copy page for Claude, as clean text, and Ask Claude about this page. Nothing is sent anywhere: you paste it." }),
  bridgeEl("label", { className: "line" }, bridgeSwitch, "Let agents work in this browser"),
  bridgeEl("p", { className: "hint", textContent: "Agents such as Claude Code get a space of their own, Agent, with its own logins, and see and touch only that. What they do shows in the sidebar, with a Stop. Nothing runs while this is off." }),
  readingLine, allowReading, bridgeDetails,
);
bridgeDetails.append(bridgeStatus, bridgeHowTo,
  bridgeEl("h3", { textContent: "Other spaces" }),
  bridgeEl("p", { className: "hint", textContent: "Closed unless you open one here. A space you open is open to any agent you run, with the logins in it." }),
  bridgeSpacesBox,
  bridgeEl("h3", { textContent: "What agents did" }),
  bridgeEl("p", { className: "hint", textContent: "The last few actions, kept only until Firefox closes." }),
  bridgeLogBox);

function bridgeDrawState(state) {
  bridgeBox.hidden = !state.alone;
  copySwitch.checked = state.copy;
  bridgeSwitch.checked = state.bridge;
  bridgeDetails.hidden = !state.bridge;
  readingLine.hidden = allowReading.hidden = state.reading || !(state.copy || state.bridge);
  readingLine.textContent = "Reading pages is not allowed yet, so only titles and addresses can be copied or seen, and no pictures taken.";
  bridgeSpacesBox.replaceChildren(...state.spaces.map(s => {
    const choose = bridgeEl("select", { title: s.name }, ...[["", "Closed"], ["read", "Can read"], ["write", "Can read and act"]]
      .map(([value, textContent]) => bridgeEl("option", { value, textContent, selected: (s.mode ?? "") === value })));
    choose.dataset.space = s.id;
    choose.onchange = () => bridgeAsk("allow", { space: s.id, mode: choose.value || null }).then(bridgeDrawState);
    return bridgeEl("div", { className: "line" }, bridgeEl("span", { textContent: "●", style: `color:${s.color}` }), bridgeEl("span", { className: "bridge-space-name", textContent: s.name }), choose);
  }));
}

// Also what happened elsewhere: a Stop in a sidebar, while this page is open.
function bridgeDrawLive(live) {
  copySwitch.checked = live.copy;
  bridgeSwitch.checked = live.wanted;
  bridgeDetails.hidden = !live.wanted;
  bridgeStatus.textContent = live.ready ? "Ready for an agent." : live.problem ? `Agents cannot connect: ${live.problem}` : "Starting…";
  bridgeHowTo.hidden = !live.ready || !live.how;
  bridgeHowTo.textContent = live.how ?? "";
  const format = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });
  bridgeLogBox.replaceChildren(...[...(live.log ?? [])].reverse().map(entry => bridgeEl("li", { className: entry.refused ? "refused" : "", textContent: `${format.format(entry.when)}  ${entry.text}` })));
}

copySwitch.onchange = () => {
  if (copySwitch.checked) askToRead();
  bridgeAsk("copy", { on: copySwitch.checked }).then(bridgeDrawState);
};
bridgeSwitch.onchange = () => {
  if (bridgeSwitch.checked) askToRead();
  bridgeAsk("on", { on: bridgeSwitch.checked }).then(bridgeDrawState);
};
allowReading.onclick = askToRead;
bridgePort.onMessage.addListener(bridgeDrawLive);
const bridgeRedraw = () => bridgeAsk("get").then(bridgeDrawState);
browser.permissions.onAdded.addListener(bridgeRedraw);
browser.permissions.onRemoved.addListener(bridgeRedraw);
bridgeRedraw();
