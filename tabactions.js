// What the menu on a tab does (sidebar/tabmenu.js, only with Tidier alone).
//
// A row or a tile is not its tab. A row can be a placeholder, with the real page in
// another window, unloaded, or nowhere yet; a tile is one window's copy of an essential,
// with the loaded copy perhaps elsewhere. A placeholder's own address is ghost.html, and
// its own sound and last use say nothing. So everything here starts from realOf, and
// acts on the real tab, in whichever window that is.

// The tab behind a row or a tile.
//   own      the tab the row stands for in this window
//   tab      the real tab: the live one, or an essential's loaded copy; else `own`
//   key, entry   its record (the tab record, or the list of essentials), if it has one
//   address  the page's web address (null for a page that has none, like a new tab)
//   title    what the page is called
//   loaded   whether the page is really loaded, in some window
//   space    its container
async function realOf(tabId) {
  const own = await browser.tabs.get(tabId).catch(() => null);
  if (!own) return null;
  let key, entry = null, tab = own;
  if (own.pinned) {
    // (Firefox refuses to read the values of a tab closed a moment ago.)
    key = await keyOf(own).catch(() => undefined);
    entry = (await getList()).find(e => e.key === key) ?? null;
    // Its own page if it has one: for a moment two copies can be loaded (oneLoaded), and
    // an action on this tile must not land on the other.
    if (entry && !isLoadedCopy(own)) tab = (await copiesOf(key).catch(() => [])).find(isLoadedCopy) ?? own;
  } else {
    key = syncKeyByTab.get(tabId);
    entry = key ? (await getSynced())[key] ?? null : null;
    const liveId = entry ? liveTabId(key) : undefined;
    if (liveId !== undefined) tab = await browser.tabs.get(liveId).catch(() => null) ?? own;
  }
  return {
    own, tab, key, entry,
    address: [tab.url, entry?.url, own.url].find(isWeb) ?? null,
    title: entry?.name || entry?.title || tab.title || "",
    // A new tab page is no page to reload, mute or unload.
    loaded: isLoadedCopy(tab) && !NEW_TAB_PAGES.has(tab.url),
    space: entry?.cookieStoreId ?? own.cookieStoreId,
  };
}

// What the menu needs to know, asked for when it opens: whether a page is loaded or
// muted can change in a window this sidebar gets no view for, so a view cannot say.
async function tabMenuFacts(tabIds) {
  const all = await getSynced(), rules = await rulesList.get();
  const reals = (await Promise.all(tabIds.map(realOf))).filter(Boolean);
  return reals.map(r => ({
    id: r.own.id,
    tile: r.own.pinned,
    active: r.own.active,
    kept: r.own.pinned || !!r.entry?.saved,
    loaded: r.loaded,
    muted: !!r.tab.mutedInfo?.muted,
    address: r.address,
    folder: r.own.pinned ? null : folderKeyOf(all, r.key),
    liveFolder: !!r.entry?.liveFolder,
    space: r.space,
    ruled: !!r.address && rules.find(rule => ruleMatches(rule.url, r.address))?.space === r.space,
  }));
}
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "tabMenu" || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return tabMenuFacts(msg.tabIds);
});

// Which tab to close for a row. A saved tab closed while it is unloaded is removed for
// good, so closing only its placeholder here, with the page loaded in another window,
// would lose it where closing the page itself only unloads it.
async function closeTargetOf(tabId) {
  if (!tidierAlone) return tabId;
  const real = await realOf(tabId).catch(noteError); // a × must close something, whatever else went wrong
  return real?.loaded ? real.tab.id : tabId;
}

// What the menu asks for: { action, tabIds, ... }, one list for one tab or many.
async function tabAction(windowId, { action, tabIds, ...more }) {
  const reals = (await Promise.all(tabIds.map(realOf))).filter(Boolean);
  if (reals.length) await TAB_ACTIONS[action]?.(windowId, reals, more);
}

const TAB_ACTIONS = {
  reload: async (windowId, reals) => {
    for (const r of reals) if (r.loaded) await browser.tabs.reload(r.tab.id).catch(() => {});
  },
  mute: (windowId, reals) => setRealsMuted(reals, true),
  unmute: (windowId, reals) => setRealsMuted(reals, false),
  unload: unloadReals,
  duplicate: async (windowId, reals) => { for (const r of reals) await duplicateReal(r); },
  // The listeners that make a pinned tab an essential ignore a tab Tidier is busy with, and
  // a tab just moved or made stays marked so for a moment (syncBusy, busy). This change is
  // yours: missed, the tab would be an essential and an ordinary tab at once, for good.
  essential: async (windowId, reals) => {
    // The real tab, so a page loaded in another window stays loaded as the essential.
    for (const r of reals) {
      if (!r.address || r.own.pinned) continue;
      syncBusy.delete(r.tab.id);
      await browser.tabs.update(r.tab.id, { pinned: true }).catch(() => {});
    }
  },
  removeEssential: async (windowId, reals) => {
    for (const r of reals) {
      if (!r.own.pinned) continue;
      busy.delete(r.tab.id);
      await browser.tabs.update(r.tab.id, { pinned: false }).catch(() => {});
    }
  },
  // A folder deleted in another window while this menu was open: a tab whose folder is not
  // there is drawn as an ordinary tab and stops being saved, so nothing moves.
  folder: async (windowId, reals, { folder }) => {
    if (!folder || isOwnFolder((await getSynced())[folder])) await moveRealsTo(windowId, reals, folder ?? null);
  },
  newFolder: async (windowId, reals, { space }) => {
    await moveRealsTo(windowId, reals, await createFolder(folderNameFor(reals), space));
  },
  // In order, so that they arrive in order; the selected tab must then not step onto one
  // still to come (leavesQuietly, safemoves.js). A row can be a placeholder, so both ids count.
  space: async (windowId, reals, { space }) => {
    const leaving = reals.flatMap(r => [r.own.id, r.tab.id]);
    for (const r of reals) await moveToSpace(r.own.id, space, leaving);
  },
  rule: (windowId, reals) => alwaysOpenHere(windowId, reals[0]),
};

async function setRealsMuted(reals, muted) {
  for (const r of reals) if (r.loaded) await browser.tabs.update(r.tab.id, { muted }).catch(() => {});
}

// A tab opened a moment ago has no record yet, and a move would only change its place.
async function moveRealsTo(windowId, reals, folderKey) {
  for (const r of reals) {
    await register(r.own.id);
    await moveTab(windowId, r.own.id, null, folderKey);
  }
}

// Unloading keeps a tab's place, address and title; only its page goes. Firefox refuses
// to unload the selected tab, so the selection goes first to the tab used last in the
// space, and comes back if the page refuses after all (unsaved input): it would otherwise
// be out of sight, still asking for your attention. Those not selected go first, so that
// the selection goes neither onto a tab about to be unloaded nor, with one that refused
// there to take it, to a new tab.
async function unloadReals(windowId, reals) {
  const pages = reals.filter(r => r.loaded).sort((a, b) => a.tab.active - b.tab.active);
  const leaving = new Set(pages.map(r => r.tab.id));
  let refused = 0;
  for (const { tab } of pages) {
    if (tab.active) await stepAwayFrom(tab, leaving);
    await browser.tabs.discard(tab.id).catch(() => {});
    const now = await browser.tabs.get(tab.id).catch(() => null);
    if (!now || now.discarded) continue;
    refused++;
    leaving.delete(tab.id);
    if (tab.active) await browser.tabs.update(tab.id, { active: true }).catch(() => {});
  }
  if (refused) say(windowId, refused > 1 ? `${refused} pages hold unsaved input and stayed loaded` : "This page holds unsaved input and stayed loaded");
}

// Off the selected tab. A placeholder's own last use says nothing, and selecting one
// would load a page just as another is unloaded, so loaded pages come first.
async function stepAwayFrom(tab, leaving) {
  const space = tab.cookieStoreId === NO_CONTAINER ? activeSpace.get(tab.windowId) ?? NO_CONTAINER : tab.cookieStoreId;
  const others = (await browser.tabs.query({ windowId: tab.windowId, cookieStoreId: space })).filter(t => !leaving.has(t.id));
  const next = others.sort((a, b) => isLoadedCopy(b) - isLoadedCopy(a) || (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (next) await browser.tabs.update(next.id, { active: true }).catch(() => {});
  else await browser.tabs.create({ windowId: tab.windowId, cookieStoreId: space, active: true }).catch(noteError);
}

// A copy is always an ordinary tab, next to the original and not selected. A loaded page
// in this window is duplicated with its history. SessionStore copies Tidier's values along,
// and with them the copy would count as the same tab: it would take over a saved tab's
// record once the original is closed, and be an essential's copy after a restart. Nor is
// the copy a tab's first page: a rule must not send it to another space.
//
// A page loaded in another window is opened again here. Firefox duplicates a tab only in
// its own window, so the copy would be over there, and its row here at the end of the list
// instead of next to the one you clicked.
//
// The queue does not wait for this: Firefox answers when the copy starts to restore, and
// never if the copy is closed first, which would stop everything for minutes. The answer
// still comes before the copy's address is reported, and long before it is registered.
async function duplicateReal(r) {
  if (!r.address) return;
  if (r.loaded && r.tab.windowId === r.own.windowId) {
    browser.tabs.duplicate(r.tab.id, { active: false, index: r.tab.index + 1 }).then(copy => {
      firstPage.delete(copy.id);
      return Promise.all([SYNC_KEY, SYNC_ROLE, TAB_KEY].map(name => browser.sessions.removeTabValue(copy.id, name).catch(() => {})));
    }).catch(noteError);
    return;
  }
  const props = { windowId: r.own.windowId, cookieStoreId: r.space, url: r.address, active: false, index: r.own.index + 1 };
  await openUnruled(props);
}

// A rule for this site and this space. It goes first, so that it wins over an older rule
// that also matches, and is anchored to the start of the address: plain text would also
// match a sign-in passing through with this address in it (see "Tabs in the wrong space"
// in the README).
async function alwaysOpenHere(windowId, r) {
  if (!r.address) return;
  const url = siteRuleText(r.address), before = await rulesList.get();
  rulesList.set([{ url, space: r.space }, ...before.filter(rule => rule.url !== url)]);
  const name = (await containerSpaces()).find(s => s.id === r.space)?.name ?? "this space";
  say(windowId, `${new URL(r.address).host.replace(/^www\./, "")} now always opens in ${name}`, { undo: () => rulesList.set(before) });
}

function siteRuleText(address) {
  const host = new URL(address).host.replace(/^www\./, "");
  return `/^https?:\\/\\/(www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\//`;
}

// What people call a site: "github.com" is Github, "bbc.co.uk" Bbc. A name to accept with
// Enter or type over, so a good guess will do; a list of every public suffix would not be
// worth carrying for it. A short label before the last one (co, com, org) is such a suffix.
function siteNameOf(address) {
  let host = "";
  try { host = new URL(address).hostname.replace(/^www\./, ""); } catch (err) { return ""; }
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host; // an IP address has no name
  const labels = host.split(".");
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && labels.at(-1).length <= 3) labels.pop();
  const name = labels.at(-1);
  return name ? name[0].toUpperCase() + name.slice(1) : host;
}

// A name for a new folder from the tabs going into it ({ title, address }), so that
// Enter accepts it. One tab gives its site. Several give what their titles share, a
// capitalised word of four letters or more ("Jira" in "Jira - Board" and "Backlog - Jira"),
// else the site they share, else the first title.
function folderNameFor(tabs) {
  const titles = tabs.map(t => (t.title || "").trim());
  const words = title => title.match(/\p{Lu}\p{L}{3,}/gu) ?? [];
  const shared = tabs.length > 1 && words(titles[0]).find(word => titles.every(title => words(title).includes(word)));
  const sites = tabs.map(t => siteNameOf(t.address));
  const site = sites.every(s => s === sites[0]) && sites[0];
  // Short: a page decides its title, and this goes in the record and on the row.
  return (shared || site || titles.find(Boolean) || "New folder").slice(0, 40);
}
