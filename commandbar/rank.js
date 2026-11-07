// What the command bar shows for what you type. Pure functions only, loaded by the
// bar's page and by the unit tests: the page ranks on every key press, so a key
// press needs no round trip to the background.
//
// There is no fuzzy matching on purpose. Every letter of a word you type stands next
// to each other in what it finds, so a result never makes you wonder why it is there;
// one or two letters must start a word, or nearly everything would match them.

const BAR_ROWS = 8; // what fits in the window; it never scrolls or changes size
const SHORT_TOKEN = 3; // shorter than this, a word only matches at the start of a word
const GOOD_MATCH = 500; // from here a result is what you meant, not just a match in the middle of a word

// How a word was found, in the title or in the address.
const AT_MIDDLE = 1, AT_WORD = 2, AT_START = 3;
const TITLE_SCORE = [0, 300, 800, 1000];
const ADDRESS_SCORE = [0, 200, 500, 600];
// The gaps above are larger than these together, so a better kind of match always wins
// and these only order results that matched about as well.
const HERE_BONUS = 120, RECENT_BONUS = 60, RECENT_HALF_LIFE_MS = 24 * 3600e3;
// What is not open comes after what is, but can pass a weak match among the open tabs.
const NOT_OPEN = new Set(["history", "bookmark", "archived", "closed"]);
const NOT_OPEN_PENALTY = 150;
const KIND_BONUS = { tab: 30, essential: 30, folder: 25, command: 20, bookmark: 10, history: 5, archived: 5, closed: 5 };

const plain = text => String(text ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
const isWordChar = char => /[\p{L}\p{N}]/u.test(char);
const bareAddress = url => String(url ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\/(www\.)?/i, "");
const siteOf = url => bareAddress(url).split(/[/?#]/)[0];

function matchIn(word, text) {
  let best = 0;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (at === 0) return AT_START;
    if (!isWordChar(text[at - 1])) best = AT_WORD;
    else best ||= AT_MIDDLE;
  }
  return best === AT_MIDDLE && word.length < SHORT_TOKEN ? 0 : best;
}

// How well `item` matches: every word must be found, in its title or its address.
function matchScore(words, phrase, item) {
  const title = plain(item.title), address = plain(bareAddress(item.url));
  let total = 0;
  for (const word of words) {
    const best = Math.max(TITLE_SCORE[matchIn(word, title)], ADDRESS_SCORE[matchIn(word, address)]);
    if (!best) return 0;
    total += best;
  }
  let score = total / words.length;
  if (words.length > 1 && matchIn(phrase, title) >= AT_WORD) score += 100; // the words as you typed them
  if (title === phrase) score += 100;
  return score;
}

// The address without what makes no difference to which page it is, to tell doubles.
function sameAddressKey(url) {
  return plain(bareAddress(url)).replace(/#.*$/, "").replace(/\/$/, "");
}

// Items are { kind, title, url, here (in the active space), lastUsed, current (the tab
// you are on) }. Returns those that match, best first, each with its `match` and `score`.
function rankResults(query, items, now = Date.now()) {
  const phrase = plain(query).trim();
  const words = phrase.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const item of items) {
    const match = matchScore(words, phrase, item);
    if (!match) continue;
    let score = match + (KIND_BONUS[item.kind] ?? 0);
    const open = !NOT_OPEN.has(item.kind);
    // The tab you are on is the one you are least likely to be looking for.
    if (item.here && !item.current) score += HERE_BONUS;
    if (item.lastUsed && !item.current) {
      const age = Math.max(0, now - item.lastUsed);
      score += (open ? RECENT_BONUS : RECENT_BONUS / 2) * 2 ** (-age / RECENT_HALF_LIFE_MS);
    }
    if (!open) score -= NOT_OPEN_PENALTY;
    results.push({ ...item, match, score });
  }
  results.sort((a, b) => b.score - a.score || (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || String(a.title).localeCompare(String(b.title)));
  // An address that is open is not shown again from history, bookmarks or what was closed.
  const seen = new Set(results.filter(r => !NOT_OPEN.has(r.kind) && r.url).map(r => sameAddressKey(r.url)));
  return results.filter(r => {
    if (!NOT_OPEN.has(r.kind) || !r.url) return true;
    const key = sameAddressKey(r.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The address `text` means, or null when it does not look like one. Without a list of
// real domains "node.js" looks like one too, so the search for it is always one row down.
function addressFrom(text) {
  const t = String(text ?? "").trim();
  if (!t || /\s/.test(t)) return null;
  const parsed = url => { try { return /^https?:$/.test(new URL(url).protocol) ? new URL(url).href : null; } catch (e) { return null; } };
  if (/^https?:\/\//i.test(t)) return parsed(t);
  const [, host, port, rest] = /^([^/?#:@]+|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.exec(t) ?? [];
  if (!host) return null; // an email address, about:config, mailto:
  const local = /^localhost$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  const dotted = /^([\p{L}\p{N}-]+\.)+\p{L}{2,}$/u.test(host) || /^([\p{L}\p{N}-]+\.)+xn--[a-z0-9-]+$/i.test(host);
  const named = /^[\p{L}\p{N}-]+$/u.test(host) && !/^\d+$/.test(host) && (port || rest === "/"); // wiki:8080, wiki/
  if (!local && !dotted && !named) return null;
  return parsed(`${local ? "http" : "https"}://${t}`);
}

// With nothing typed: the tabs you used last in this space, and the commands you use most.
function emptyResults(items) {
  const recent = items.filter(i => (i.kind === "tab" || i.kind === "essential") && i.here && !i.current)
    .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  const commands = items.filter(i => i.kind === "command"); // the background gives them most used first
  const room = Math.min(3, commands.length);
  const tabs = recent.slice(0, BAR_ROWS - room);
  return [...tabs, ...commands.slice(0, BAR_ROWS - tabs.length)];
}

// All the rows for what is typed: an address first, unless that very page is the best
// match; a search first when nothing matches well, and always there at the end.
function resultsFor(query, items, { tail = [], now = Date.now() } = {}) {
  const text = String(query ?? "").trim();
  if (!text) return emptyResults(items);
  const ranked = rankResults(text, items, now);
  const url = addressFrom(text);
  const search = { kind: "search", id: "search", title: `Search for “${text}”`, query: text };
  const top = ranked[0];
  const go = url && { kind: "address", id: "address", title: `Go to ${text}`, url };
  if (go && top?.url && sameAddressKey(top.url) === sameAddressKey(url) && !NOT_OPEN.has(top.kind)) {
    return [...ranked.slice(0, BAR_ROWS - 2 - tail.length), go, search, ...tail].slice(0, BAR_ROWS);
  }
  if (go) return [go, ...ranked.slice(0, BAR_ROWS - 2 - tail.length), search, ...tail];
  if (!top || top.match < GOOD_MATCH) return [search, ...ranked.slice(0, BAR_ROWS - 1 - tail.length), ...tail];
  return [...ranked.slice(0, BAR_ROWS - 1 - tail.length), search, ...tail];
}

// What ⇥ puts in the field: the site while you are still typing its name, else the whole
// address without its scheme, or the title of what has no address.
function completionFor(row, text) {
  if (row.kind === "search") return text;
  if (!row.url) return row.title;
  const typed = plain(text).trim(), site = siteOf(row.url);
  return typed && plain(site).startsWith(typed) ? site : bareAddress(row.url);
}

// A key as Firefox writes it ("Ctrl+Shift+C"), as you know it. On a Mac Firefox's Ctrl
// is ⌘ and MacCtrl is ⌃.
function prettyKey(shortcut, mac) {
  if (!shortcut) return "";
  if (!mac) return shortcut.replace("MacCtrl", "Ctrl");
  const glyphs = { Ctrl: "⌘", Command: "⌘", MacCtrl: "⌃", Alt: "⌥", Shift: "⇧" };
  const parts = shortcut.split("+"), key = parts.pop();
  const words = { Up: "↑", Down: "↓", Left: "←", Right: "→", Comma: ",", Period: "." };
  return parts.map(p => glyphs[p] ?? p).join("") + (words[key] ?? key);
}
