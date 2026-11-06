// News (Tidier alone): a still dot when a page you are not looking at has something
// new. Across spaces this is how you see that chat or mail moved without going there.
//
// Firefox only tells that a tab's title changed, and titles change for many reasons,
// so there is one built-in rule and nothing to set: a loaded tab you are not looking at
// gets a mark when its title says something new (isNews) after NEWS_QUIET_MS of quiet.
// A page that has just loaded or that you have just left is still setting its title
// (an app starting, an unread count catching up), and that is not news.
//
// Looking at a tab means it is selected in the window you are using. Selected in another
// window is not enough: that window may be behind this one, and every window has a
// selected tab that nobody chose, since Firefox and Tidier pick one there when its tab
// is closed or pulled away (pull, tabsync.js). Taking that as seen would eat a dot and
// leave that tab without one for as long as it stays selected there.
//
// A mark belongs to the tab record or the essential, not to the Firefox tab: the other
// windows show the same tab as a placeholder, and selecting that one is seeing the news
// too. It lives in memory only (a restart clears it) and goes when you see the tab, or
// when the page itself is gone. Nothing here runs by itself: the five seconds are
// compared when a title changes, so there is no timer, and with nothing happening
// there is no work.

const NEWS_QUIET_MS = 5000;
const newsMarks = new Map(); // key of the record or essential -> { tabId, space } of the page with news
const newsSeen = new Map();  // tabId of a loaded page -> { title, quietFrom, soundFrom }

// Whether going from one title to another says something new.
//
// Digits alone say nothing: that is a clock, a timer or a percentage, which would
// otherwise mark a tab all day. The exception is a number in brackets, the way pages
// write an unread count ("(3) Inbox", and Gmail's "Inbox (1,234) - ..."): that going up
// is news, going down is you having read it elsewhere. Any other change of words is news,
// unless the new title is only what is left of the old one ("* general" to "general",
// the same mark going away because you read it on your phone).
const NEWS_COUNT = /[(\[](\d{1,3}(?:[,.\s]\d{3})+|\d+)\+?[)\]]/;
function isNews(before, after) {
  if (!before || !after || before === after) return false;
  const count = title => Number(NEWS_COUNT.exec(title)?.[1].replace(/\D/g, "") ?? 0);
  const words = title => title.replace(NEWS_COUNT, "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  return count(after) > count(before) || !words(before).includes(words(after));
}

const newsKey = tabId => syncKeyByTab.get(tabId) ?? keyByTab.get(tabId);
const hasNews = tabId => newsMarks.has(newsKey(tabId));
const spaceHasNews = space => [...newsMarks.values()].some(mark => mark.space === space);
// The window you are using. With Firefox itself in the background there is none, and
// what is selected stays what you were looking at, so nothing waits for you to come back.
const newsWindowInUse = windowId => windowId === focusedWindowId || focusedWindowId === browser.windows.WINDOW_ID_NONE;

function dropNews(tabId) {
  for (const [key, mark] of newsMarks) {
    if (mark.tabId === tabId) { newsMarks.delete(key); viewAllSoon(); }
  }
}

// The titles as they are when Tidier starts, so that the first change after an update
// counts: a page that stays loaded through an update sends no load to learn its title from.
async function startNews() {
  if (!tidierAlone) return;
  for (const t of await browser.tabs.query({ discarded: false })) {
    if (!isGhostUrl(t.url)) newsSeen.set(t.id, { title: t.title, quietFrom: Date.now() });
  }
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tidierAlone || !started) return;
  if ("pinned" in change) dropNews(tabId); // it changes from record to essential or back, so the mark's key is no longer its own
  if (tab.discarded || isGhostUrl(tab.url)) return; // a placeholder's title is only the page's, shown again
  const seen = newsSeen.get(tabId), now = Date.now();
  if (!seen || "status" in change) { newsSeen.set(tabId, { title: tab.title, quietFrom: now }); return; }
  if (change.audible) seen.soundFrom = now;
  if (!change.title) return;
  const news = isNews(seen.title, tab.title);
  seen.title = tab.title;
  if (!news) return; // says nothing, so it does not end the quiet either: a timer that ends in "Done" counts
  const quiet = now - seen.quietFrom >= NEWS_QUIET_MS;
  seen.quietFrom = now;
  // A page that has been playing sound shows it is alive, and its title is mostly the next
  // song. A sound that has only just begun is something else: a chat page's ding comes
  // with the message, and Firefox reports it as playing for a few seconds.
  const playing = tab.audible && now - (seen.soundFrom ?? 0) >= NEWS_QUIET_MS;
  // By what the tab is now: while it is being pinned or unpinned the map of what it was
  // still has it, and a mark under that key could never be cleared. No key at all: it is
  // not Tidier's tab yet (just opened), or is changing over. Nothing to mark.
  const key = tab.pinned ? keyByTab.get(tabId) : syncKeyByTab.get(tabId);
  if (!quiet || playing || tab.status !== "complete" || (tab.active && newsWindowInUse(tab.windowId)) || key === undefined || newsMarks.has(key)) return;
  newsMarks.set(key, { tabId, space: tab.cookieStoreId });
  viewAllSoon(); // every window: the others show this tab as a placeholder, with the same mark
}, { properties: ["title", "status", "pinned", "audible"] });

browser.tabs.onActivated.addListener(({ tabId, previousTabId, windowId }) => {
  const left = newsSeen.get(previousTabId);
  if (left) left.quietFrom = Date.now(); // pages often set their title when you leave them
  if (newsWindowInUse(windowId) && newsMarks.delete(newsKey(tabId))) viewAllSoon();
});

// Going to a window is seeing the tab selected there, with no tab being selected, so
// tabs.onActivated says nothing. And the selected tab of the window you leave has just
// lost focus, which is another moment a page sets its title.
browser.windows.onFocusChanged.addListener(async windowId => {
  if (!tidierAlone) return;
  for (const t of await browser.tabs.query({ active: true }).catch(() => [])) {
    const seen = newsSeen.get(t.id);
    if (seen) seen.quietFrom = Date.now();
    if (t.windowId === windowId && newsMarks.delete(newsKey(t.id))) viewAllSoon();
  }
});

// The page is gone: closed by you (a tab in a folder then stays as a placeholder, with
// nothing new on it), moved to another space, or its window closed.
browser.tabs.onRemoved.addListener(tabId => {
  newsSeen.delete(tabId);
  dropNews(tabId);
});
