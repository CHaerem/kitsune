// What runs in a page for Copy for Claude and for an agent (bridge.js), one call at a
// time through tabs.executeScript, never by itself: there is no content script in the
// manifest, and this neither listens for nor sends any message.
//
// It runs in Firefox's isolated world: the page cannot see these names, and what a page
// redefines (document.querySelector, say) does not reach here. What it reads is still
// the page's own, so bridge.js marks it as untrusted.
//
// Never read: the contents of form fields, cookies or storage. There is no code here that
// touches them; of a password field it only looks whether it is empty (pagePasswordFilled).

// Brought in again before each call, into the same page: hence `var`, and what a page was
// told before (refs) must still be there.
var bridgeRefs = bridgeRefs || { next: 1, elements: new Map() };

function bridgePage(call) {
  try {
    if (!/^https?:$/.test(location.protocol)) return { error: "This is not a web page." };
    switch (call.op) {
      case "read": return pageRead(call);
      case "find": return pageFind(call);
      case "click": return pageClick(call);
      case "type": return pageType(call);
      case "wait": return pageWait(call);
    }
    return { error: "No such thing to do." };
  } catch (err) {
    return { error: err.name === "SyntaxError" ? "That selector is not valid." : err.refused ? err.message : "It did not work on this page." };
  }
}

var pageRefusal = text => Object.assign(new Error(text), { refused: true });

// --- What a person can see ---------------------------------------------------------------
// Text hidden from people is a classic way of talking to a reader like an agent. This
// cannot catch all of it (white on white), which is why everything is marked untrusted
// anyway, but it does keep out what no person would have read.
function pageHidden(el) {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
  const style = getComputedStyle(el);
  if (style.display === "contents") return false;
  if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
  if (parseFloat(style.fontSize) < 3) return true;
  const box = el.getBoundingClientRect();
  if (box.width <= 1 && box.height <= 1 && el.childElementCount === 0) return true;
  return box.right + scrollX < 0 || box.bottom + scrollY < 0;
}

// --- Clean Markdown ------------------------------------------------------------------------
var PAGE_LEFT_OUT = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|FRAME|OBJECT|EMBED|VIDEO|AUDIO|INPUT|SELECT|OPTION|TEXTAREA|BUTTON|HEAD|LINK|META|MAP|AREA)$/;
var PAGE_AROUND = /^(NAV|ASIDE|FOOTER)$/; // around what the page is about
var PAGE_AROUND_ROLES = /^(navigation|complementary|contentinfo|banner|search)$/;
var PAGE_BLOCK = /^(ADDRESS|ARTICLE|BODY|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FORM|HEADER|HGROUP|LI|MAIN|MENU|P|SECTION|SUMMARY)$/;
var PAGE_MOST = 500000; // characters walked at most: the rest of a very long page is not read

function pageMarkdown(root) {
  const st = { left: PAGE_MOST };
  return md(root, st).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  function kids(node) { return [...node.childNodes].map(n => md(n, st)).join(""); }
  function wrap(mark, text) { const t = text.trim(); return t ? `${mark}${t}${mark}` : ""; }
  function md(node) {
    if (st.left <= 0) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.data.replace(/\s+/g, " ");
      st.left -= text.length;
      return text;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toUpperCase();
    if (PAGE_LEFT_OUT.test(tag) || PAGE_AROUND.test(tag) || PAGE_AROUND_ROLES.test(node.getAttribute("role") ?? "") || pageHidden(node)) return "";
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) { const t = kids(node).replace(/\s+/g, " ").trim(); return t ? `\n\n${"#".repeat(+heading[1])} ${t}\n\n` : ""; }
    switch (tag) {
      case "BR": return "\n";
      case "HR": return "\n\n---\n\n";
      case "A": {
        const text = kids(node).replace(/\s+/g, " ").trim();
        return text && /^(https?:|mailto:)/.test(node.href) ? `[${text.replace(/([[\]])/g, "\\$1")}](${node.href})` : text;
      }
      case "STRONG": case "B": return wrap("**", kids(node));
      case "EM": case "I": return wrap("*", kids(node));
      case "CODE": case "KBD": case "SAMP": return wrap("`", node.textContent.replace(/\s+/g, " "));
      case "PRE": { st.left -= node.textContent.length; return `\n\n\`\`\`\n${node.textContent.replace(/\n$/, "")}\n\`\`\`\n\n`; }
      case "IMG": { const alt = (node.alt ?? "").replace(/\s+/g, " ").trim(); return alt ? `![${alt}]` : ""; } // what it shows, not where it is
      case "UL": case "OL": {
        let n = Number(node.getAttribute("start")) || 1;
        const items = [...node.children].filter(li => li.tagName.toUpperCase() === "LI" && !pageHidden(li)).map(li => {
          const mark = tag === "OL" ? `${n++}. ` : "- ";
          return mark + kids(li).trim().replace(/\n+/g, "\n").replace(/\n/g, "\n" + " ".repeat(mark.length));
        }).filter(item => item.trim().length > 2);
        return items.length ? `\n\n${items.join("\n")}\n\n` : "";
      }
      case "BLOCKQUOTE": return `\n\n${kids(node).trim().replace(/\n{2,}/g, "\n").replace(/^/gm, "> ")}\n\n`;
      case "TABLE": {
        const rows = [...node.querySelectorAll("tr")].filter(r => r.closest("table") === node).map(r =>
          "| " + [...r.cells].map(c => kids(c).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()).join(" | ") + " |");
        if (rows.length) rows.splice(1, 0, "|" + " --- |".repeat(rows[0].split(" | ").length));
        return `\n\n${rows.join("\n")}\n\n`;
      }
    }
    return PAGE_BLOCK.test(tag) ? `\n\n${kids(node)}\n\n` : kids(node);
  }
}

// What the page is about: its main part if it says so, else its one article, else all of it.
function pageMain() {
  const articles = document.querySelectorAll("article");
  const main = document.querySelector("main, [role=main]") ?? (articles.length === 1 ? articles[0] : null);
  return main && main.textContent.trim().length > 100 ? main : document.body;
}

function pageRead({ offset, max }) {
  const text = document.body ? pageMarkdown(pageMain()) : "";
  const end = offset + max;
  return { title: document.title, url: location.href, total: text.length, text: text.slice(offset, end), next: end < text.length ? end : null };
}

// --- Elements --------------------------------------------------------------------------------
var PAGE_CLICKABLE = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [onclick], [contenteditable=true], [contenteditable='']";

function pageRemember(el) {
  for (const [ref, known] of bridgeRefs.elements) if (known === el) return ref;
  const ref = bridgeRefs.next++;
  bridgeRefs.elements.set(ref, el);
  if (bridgeRefs.elements.size > 500) bridgeRefs.elements.delete(bridgeRefs.elements.keys().next().value); // the oldest
  return ref;
}

var pageSpaced = text => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

// What an agent is told of an element. Never `value`: what is in a field stays there
// (except a button's own label, which is what its value is).
function pageDescribe(el) {
  const out = { ref: pageRemember(el), tag: el.tagName.toLowerCase() };
  const add = (name, text) => { const t = pageSpaced(text); if (t) out[name] = t; };
  const button = el.tagName.toUpperCase() === "INPUT" && /^(submit|button|reset)$/i.test(el.type);
  add("text", button ? el.value : el.innerText);
  add("label", el.getAttribute("aria-label"));
  add("role", el.getAttribute("role"));
  add("type", el.getAttribute("type"));
  add("name", el.getAttribute("name"));
  add("placeholder", el.getAttribute("placeholder"));
  if (el.href && /^https?:/.test(el.href)) out.href = el.href.slice(0, 500);
  if (el.checked) out.checked = true;
  if (el.disabled) out.disabled = true;
  return out;
}

function pageMatches({ selector, text }) {
  if (selector) return [...document.querySelectorAll(selector)];
  if (!text) return [...document.querySelectorAll(PAGE_CLICKABLE)];
  // What can be clicked and shows the text, then the elements right around it, however
  // long the page. (Never a field's value: a button's label is the one exception.)
  const needle = text.toLowerCase();
  const has = value => (value ?? "").toLowerCase().includes(needle);
  const button = el => el.tagName.toUpperCase() === "INPUT" && /^(submit|button|reset)$/i.test(el.type);
  const out = new Set();
  for (const el of document.querySelectorAll(PAGE_CLICKABLE)) {
    if (has(el.textContent) || has(el.getAttribute("aria-label")) || has(el.getAttribute("placeholder")) || (button(el) && has(el.value))) out.add(el);
  }
  if (!document.body) return [...out];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const around = node.parentElement;
    if (has(node.data) && !PAGE_LEFT_OUT.test(around.tagName.toUpperCase())) out.add(around.closest(PAGE_CLICKABLE) ?? around);
  }
  return [...out];
}

var pageVisible = el => !pageHidden(el) && !el.closest("[hidden], [aria-hidden=true]");

function pageFind({ selector, text, limit }) {
  const most = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 40;
  const visible = pageMatches({ selector, text }).filter(pageVisible);
  return { found: visible.length, elements: visible.slice(0, most).map(pageDescribe) };
}

function pageTarget({ ref, selector, text }) {
  let el = null;
  if (Number.isInteger(ref)) {
    el = bridgeRefs.elements.get(ref) ?? null;
    if (!el?.isConnected) throw pageRefusal("That ref is gone: the page has changed. Use find again.");
  } else if (selector || text) {
    el = pageMatches({ selector, text }).find(pageVisible) ?? null;
  } else {
    throw pageRefusal("Name the element: by ref, selector or text.");
  }
  if (!el) throw pageRefusal("No such element is visible on the page.");
  return el;
}

// Firefox fills in saved passwords in any container, so without this an agent could sign
// in to your own account from its own space, never knowing the password, with one click
// on Sign in (and a page could ask it to). An extension cannot turn that filling off.
function pagePasswordFilled() {
  return [...document.querySelectorAll("input[type=password]")].some(field => field.value !== "");
}
var PAGE_PASSWORD_FILLED = "A password is filled in on this page, so clicking and sending here is left to the person.";

function pageClick(call) {
  const el = pageTarget(call);
  if (el.disabled) throw pageRefusal("That element is disabled.");
  if (pagePasswordFilled()) throw pageRefusal(PAGE_PASSWORD_FILLED);
  // A script's click cannot open a new tab: Firefox would only show that it blocked a popup.
  if (el.tagName.toUpperCase() === "A" && el.target && el.target !== "_self" && /^https?:/.test(el.href)) {
    return { clicked: false, opensNewTab: el.href.slice(0, 500), hint: "This link opens a new tab, which a script's click cannot do. Use open_tab with its address." };
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { clicked: true, element: pageDescribe(el) };
}

// A password is left to the person, and a card's number too. An agent has no business
// holding them, and a page must not be able to ask it for them.
function pageSecret(el) {
  const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  return el.type === "password" || /password|cc-number|cc-csc|cc-exp|one-time-code/.test(auto);
}

function pageType(call) {
  const el = pageTarget({ ref: call.ref, selector: call.selector });
  const tag = el.tagName.toUpperCase();
  if (el.disabled || el.readOnly) throw pageRefusal("That field cannot be changed.");
  if (pageSecret(el)) throw pageRefusal("A password or card field is left to the person.");
  el.scrollIntoView({ block: "center", inline: "center" });
  if (tag === "SELECT") {
    const choice = [...el.options].find(o => o.text.trim() === call.value.trim() || o.value === call.value);
    if (!choice) throw pageRefusal("That list has no such choice.");
    el.value = choice.value;
  } else if (tag === "TEXTAREA" || (tag === "INPUT" && !/^(checkbox|radio|file|hidden|image|submit|button|reset|range|color)$/i.test(el.type))) {
    el.focus();
    el.value = call.value;
  } else if (el.isContentEditable) {
    el.focus();
    document.execCommand("selectAll");
    if (!document.execCommand("insertText", false, call.value)) el.textContent = call.value;
  } else {
    throw pageRefusal("That is not a field that can be typed in.");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (call.submit) {
    if (!el.form) throw pageRefusal("It was typed, but that field has no form to send.");
    if (pagePasswordFilled()) throw pageRefusal(PAGE_PASSWORD_FILLED);
    el.form.requestSubmit();
  }
  return { typed: true, element: pageDescribe(el) };
}

// Until it shows or the time is up. By the page's own changes, not by looking again and again.
function pageWait({ selector, text, ms }) {
  const needle = text?.toLowerCase();
  const there = () => (selector ? [...document.querySelectorAll(selector)].some(pageVisible) : (document.body?.innerText ?? "").toLowerCase().includes(needle));
  if (there()) return { found: true };
  return new Promise(resolve => {
    let soon = null;
    const finish = found => { clearTimeout(soon); clearTimeout(limit); watcher.disconnect(); resolve({ found }); };
    const watcher = new MutationObserver(() => {
      if (soon) return;
      soon = setTimeout(() => { soon = null; if (there()) finish(true); }, 150); // a busy page is looked at a few times a second, no more
    });
    const limit = setTimeout(() => finish(false), Math.max(0, ms));
    watcher.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}
