// The Spaces section of the settings page: spaces are made, changed and deleted here, so
// Firefox's own container settings aren't needed (isolation.js does the work).
//
// One line per space, with its icon and name. What is rarely wanted is behind a small
// "More": colour, icon, proxy, user agent, signing out, deleting. The two things that
// cannot be undone ask first, in place: never a dialog.
//
// With Sidebery in use the line is only the name, as it always was.

const isolation = (what, more) => browser.runtime.sendMessage({ type: "isolation:" + what, ...more });
// Must be called right in your click, or Firefox refuses to ask.
const mayAsk = async permissions => { try { return await browser.permissions.request(permissions); } catch (err) { return false; } };
const moreOpen = new Set(); // the spaces showing More
const asking = new Map(); // space -> what it is asking: "signOut" or "delete"
const spaceFacts = new Map(); // space -> a line to show under it, until the next change
let isolated = null;

function spaceIcon(iconUrl, color) {
  const icon = el("span", { className: "space-icon" });
  icon.style.setProperty("--icon", `url("${iconUrl}")`);
  icon.style.setProperty("--color", color);
  return icon;
}

// Redrawn after each thing you do here. Otherwise (a permission given, say) not while you
// are typing in it: that would take the text from under your hands.
async function drawSpaces(force) {
  if (!force && document.activeElement?.closest?.("#spaces")) return;
  if (!state.report.alone) {
    $("spaces").replaceChildren(...state.spaces.map(s => {
      const name = el("input", { type: "text", value: s.name });
      name.onchange = () => ask("space", { id: s.id, changes: { name: name.value } });
      return el("div", { className: "line" }, el("span", { textContent: "●", style: `color:${s.color}` }), name);
    }));
    return;
  }
  isolated = await isolation("get");
  $("new-space").hidden = false;
  $("allow-isolation").hidden = await browser.permissions.contains({ permissions: ["webRequest", "webRequestBlocking"], origins: ["<all_urls>"] });
  $("spaces").replaceChildren(...isolated.spaces.map(spaceCard));
}

function spaceCard(s) {
  const open = moreOpen.has(s.id);
  const name = el("input", { type: "text", value: s.name, ariaLabel: "Name" });
  name.dataset.nameOf = s.id;
  name.onchange = () => ask("space", { id: s.id, changes: { name: name.value.trim() || s.name } });
  const more = el("button", { className: "quiet more", textContent: open ? "Less" : "More", ariaExpanded: String(open) });
  more.onclick = () => { if (!moreOpen.delete(s.id)) moreOpen.add(s.id); asking.delete(s.id); spaceFacts.delete(s.id); drawSpaces(true); };
  const card = el("div", { className: "space-card" }, el("div", { className: "line" }, spaceIcon(s.iconUrl, s.colorCode), name, more));
  card.dataset.space = s.id;
  if (open) card.append(spaceMore(s));
  return card;
}

const spaceField = (label, ...content) => el("div", { className: "field" }, el("span", { className: "label", textContent: label }), el("div", { className: "content" }, ...content));

function spaceMore(s) {
  const choose = changes => async () => { await isolation("edit", { id: s.id, changes }); drawSpaces(true); };
  const colors = isolated.looks.colors.map(c => {
    const b = el("button", { className: "swatch" + (c.color === s.color ? " chosen" : ""), title: c.color, ariaLabel: c.color });
    b.dataset.color = c.color;
    b.style.setProperty("--color", c.colorCode);
    b.onclick = choose({ color: c.color });
    return b;
  });
  const icons = isolated.looks.icons.map(i => {
    const b = el("button", { className: "icon-choice" + (i.icon === s.icon ? " chosen" : ""), title: i.icon, ariaLabel: i.icon }, spaceIcon(i.iconUrl, s.colorCode));
    b.dataset.icon = i.icon;
    b.onclick = choose({ icon: i.icon });
    return b;
  });
  const box = el("div", { className: "space-more" },
    spaceField("Colour", el("div", { className: "choices" }, ...colors)),
    spaceField("Icon", el("div", { className: "choices" }, ...icons)),
    ...networkFields(s),
    spaceField("Logins", ...signOutPart(s)),
  );
  if (isolated.spaces.length > 1) box.append(spaceField("", ...deletePart(s)));
  const fact = spaceFacts.get(s.id);
  if (fact) box.append(el("p", { className: "hint fact", textContent: fact }));
  return box;
}

// A proxy and a user agent: asked for when first used, by the Save button's click.
function networkFields(s) {
  const proxy = s.network.proxy ?? {};
  const type = el("select", { ariaLabel: "Kind of proxy" }, el("option", { value: "", textContent: "No proxy" }),
    ...[["http", "HTTP"], ["https", "HTTPS"], ["socks", "SOCKS 5"], ["socks4", "SOCKS 4"]].map(([value, textContent]) => el("option", { value, textContent, selected: proxy.type === value })));
  const host = el("input", { type: "text", value: proxy.host ?? "", placeholder: "host", ariaLabel: "Proxy host", className: "host" });
  const port = el("input", { type: "number", value: proxy.port ?? "", placeholder: "port", min: 1, max: 65535, ariaLabel: "Proxy port", className: "port" });
  const agent = el("input", { type: "text", value: s.network.userAgent ?? "", placeholder: "Firefox's own", ariaLabel: "User agent" });
  const save = el("button", { textContent: "Save", className: "save", hidden: true });
  const shown = () => { host.hidden = port.hidden = !type.value; };
  shown();
  for (const input of [type, host, port, agent]) input.oninput = () => { shown(); save.hidden = false; };
  save.onclick = async () => {
    const usesProxy = !!type.value, usesAgent = !!agent.value.trim();
    // (A proxy needs both: isolation.js, notPastProxy.)
    const wanted = [...(usesProxy ? ["proxy"] : []), ...(usesProxy || usesAgent ? ["webRequest", "webRequestBlocking"] : [])];
    const asked = { permissions: wanted, origins: ["<all_urls>"] };
    if (wanted.length && !await mayAsk(asked) && !await browser.permissions.contains(asked)) {
      spaceFacts.set(s.id, "Firefox did not give Tidier the permission for this, so nothing changed.");
      return drawSpaces(true);
    }
    const stored = await isolation("network", { id: s.id, proxy: usesProxy ? { type: type.value, host: host.value, port: port.value } : null, userAgent: agent.value });
    spaceFacts.set(s.id, usesProxy && !stored.proxy ? "That proxy is not complete: it needs a host, without http://, and a port. Nothing is in use." : "Saved.");
    drawSpaces(true);
  };
  return [
    spaceField("Proxy", el("div", { className: "line tight" }, type, host, port)),
    spaceField("User agent", el("div", { className: "line tight" }, agent)),
    spaceField("", save),
  ];
}

function questionPart(s, kind, sentence, yes, act) {
  if (asking.get(s.id) !== kind) return null;
  const go = el("button", { className: "danger", textContent: yes });
  const keep = el("button", { textContent: "Keep" });
  keep.onclick = () => { asking.delete(s.id); drawSpaces(true); };
  go.onclick = act;
  return [el("p", { className: "question", textContent: sentence }), el("div", { className: "line tight" }, go, keep)];
}

function signOutPart(s) {
  const question = questionPart(s, "signOut", `Sign out of every site in ${s.name}? Its cookies and what sites keep in it go, for good.`, "Sign out", async () => {
    await mayAsk({ permissions: ["browsingData"] });
    if (!await browser.permissions.contains({ permissions: ["browsingData"] })) spaceFacts.set(s.id, "Firefox did not give Tidier the permission for this, so nothing changed.");
    else {
      await isolation("signOut", { id: s.id });
      spaceFacts.set(s.id, `Signed out of everything in ${s.name}. Pages that are open show it when they next load.`);
    }
    asking.delete(s.id);
    drawSpaces(true);
  });
  if (question) return question;
  const b = el("button", { textContent: "Sign out of everything in this space", className: "sign-out" });
  b.onclick = () => { asking.set(s.id, "signOut"); spaceFacts.delete(s.id); drawSpaces(true); };
  return [b];
}

const spaceCount = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
function whatGoesWithSpace({ essentials, folders, tabs }) {
  const parts = [...(essentials ? [spaceCount(essentials, "essential", "essentials")] : []), ...(folders ? [spaceCount(folders, "folder", "folders")] : []), ...(tabs ? [spaceCount(tabs, "tab", "tabs")] : []), "all its logins"];
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
}

function deletePart(s) {
  const n = s.contents;
  const keeps = n.essentials || n.folders ? " A copy of its essentials and folders is kept first." : "";
  const question = questionPart(s, "delete", `Delete ${s.name}? ${whatGoesWithSpace(n)} go.${keeps}`, `Delete ${s.name}`, async () => {
    const r = await isolation("delete", { id: s.id });
    asking.delete(s.id);
    if (r?.refused) spaceFacts.set(s.id, `${s.name} stays. ${r.refused}`);
    else { moreOpen.delete(s.id); spaceFacts.delete(s.id); }
    await refresh();
    drawSpaces(true);
  });
  if (question) return question;
  const b = el("button", { textContent: "Delete this space", className: "quiet delete" });
  b.onclick = () => { asking.set(s.id, "delete"); spaceFacts.delete(s.id); drawSpaces(true); };
  return [b];
}

addEventListener("DOMContentLoaded", () => {
  // Made at once, with a colour and icon no other space has, and its name ready to change.
  $("new-space").onclick = async () => {
    const id = await isolation("new");
    moreOpen.add(id);
    await drawSpaces(true);
    const name = document.querySelector(`[data-name-of="${id}"]`);
    name?.focus();
    name?.select();
  };
  $("allow-isolation").onclick = () => mayAsk({ permissions: ["webRequest", "webRequestBlocking"], origins: ["<all_urls>"] }).then(() => drawSpaces(true));
});
