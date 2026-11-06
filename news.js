// News (Tidier alone): a still dot when a page you are not looking at has something
// new. Across spaces this is how you see that chat or mail moved without going there.
//
// Firefox only tells that a tab's title changed, and titles change for many reasons,
// so there is one built-in rule and nothing to set: a loaded tab you have not selected
// gets a mark when its title says something new (isNews) after NEWS_QUIET_MS of quiet.
// A page that has just loaded or that you have just left is still setting its title
// (an app starting, an unread count catching up), and that is not news.
//
// A mark belongs to the tab record or the essential, not to the Firefox tab: the other
// windows show the same tab as a placeholder, and selecting that one is seeing the news
// too. It lives in memory only (a restart clears it) and goes when you select the tab,
// in any window, or when the page itself is gone. Nothing here runs by itself: the five
// seconds are compared when a title changes, so there is no timer, and with nothing
// happening there is no work.

const NEWS_QUIET_MS = 5000;
const newsMarks = new Map(); // key of the record or essential -> { tabId, space } of the page with news
const newsSeen = new Map();  // tabId of a loaded page -> { title, quietFrom }

// Whether going from one title to another says something new.
//
// Digits alone say nothing: that is a clock, a timer or a percentage, which would
// otherwise mark a tab all day. The exception is a number in brackets, the way pages
// write an unread count ("(3) Inbox", and Gmail's "Inbox (3) - ..."): that going up is
// news, going down is you having read it elsewhere. Any other change of words is news,
// unless the new title is only what is left of the old one ("* general" to "general",
// the same mark going away because you read it on your phone).
const NEWS_COUNT = /[(\[](\d+)\+?[)\]]/;
function isNews(before, after) {
  if (!before || !after || before === after) return false;
  const count = title => Number(NEWS_COUNT.exec(title)?.[1] ?? 0);
  const words = title => title.replace(NEWS_COUNT, "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  const was = words(before), now = words(after);
  return was === now ? count(after) > count(before) : !was.includes(now);
}

const newsKey = tabId => syncKeyByTab.get(tabId) ?? keyByTab.get(tabId);
const hasNews = tabId => newsMarks.has(newsKey(tabId));
const spaceHasNews = space => [...newsMarks.values()].some(mark => mark.space === space);

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
  if (!change.title) return;
  const news = isNews(seen.title, tab.title);
  seen.title = tab.title;
  if (!news) return; // says nothing, so it does not end the quiet either: a timer that ends in "Done" counts
  const quiet = now - seen.quietFrom >= NEWS_QUIET_MS;
  seen.quietFrom = now;
  // A page playing sound already shows it is alive, and its title is mostly the next
  // song. It may not be Tidier's tab at all yet (just opened): no key, nothing to mark.
  const key = newsKey(tabId);
  if (!quiet || tab.active || tab.audible || tab.status !== "complete" || key === undefined || newsMarks.has(key)) return;
  newsMarks.set(key, { tabId, space: tab.cookieStoreId });
  viewAllSoon(); // every window: the others show this tab as a placeholder, with the same mark
}, { properties: ["title", "status", "pinned"] });

browser.tabs.onActivated.addListener(({ tabId, previousTabId }) => {
  const left = newsSeen.get(previousTabId);
  if (left) left.quietFrom = Date.now(); // pages often set their title when you leave them
  if (newsMarks.delete(newsKey(tabId))) viewAllSoon();
});

// The page is gone: closed by you (a tab in a folder then stays as a placeholder, with
// nothing new on it), moved to another space, or its window closed.
browser.tabs.onRemoved.addListener(tabId => {
  newsSeen.delete(tabId);
  dropNews(tabId);
});
