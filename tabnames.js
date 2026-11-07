// A name of your own for what you keep: an essential or a saved tab. These stay for
// months, while their pages give them whatever title suits the page ("Inbox (3)",
// "Sign in"). Ordinary tabs get no name: they live hours.
//
// The name sits next to the page's title, never in it. Everything that follows a page
// writes `title` and `icon` (updateFromCopy, tab sync's onUpdated) and unloadSaved
// copies `saved` over the entry, and none of those knows `name`, so nothing but this
// can change it. Clearing it therefore gives the page's title back as it is by then.
//
// A name lives as long as what it names: an essential's goes with its list entry, a
// saved tab's with `saved` when it leaves its folder (noteSaved, common.js), and being
// made an essential takes it along (onPinned, essentials.js). It travels with copies
// (copies.js) because it is simply part of the entry.

const NAME_MAX = 200; // a paste by mistake should not stay in storage, and in every placeholder's title, for good

// Sets or, when empty, removes the name. Returns whether anything changed.
function setName(entry, name) {
  if ((entry.name || "") === name) return false;
  if (name) entry.name = name;
  else delete entry.name;
  return true;
}

// Firefox shows a placeholder's own title in its own places (⌃Tab, the list of all
// tabs): loaded once more it asks for the title again (ghostInfo prefers the name) and
// unloads itself. A selected one is busy opening its page, which shows its own title.
async function redrawPlaceholders(tabs) {
  for (const t of tabs) {
    if (!t.active && isGhostUrl(t.url)) await browser.tabs.update(t.id, { url: t.url }).catch(() => {});
  }
}

// From the sidebar, for the tab shown there. The tab is only how it was pointed at:
// the name belongs to the essential or the saved tab, in every window. An essential is
// what is pinned: Firefox gives a duplicate its tab's values, so a key alone would name
// the essential for its unpinned duplicate, and keep treating that tab as a copy of it.
async function renameTab(tabId, name) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const text = (name || "").trim().slice(0, NAME_MAX);
  if (tab.pinned) {
    const essentialKey = await keyOf(tab).catch(() => undefined);
    const list = await getList();
    const essential = essentialKey && list.find(e => e.key === essentialKey);
    if (!essential || !setName(essential, text)) return;
    setList([...list]);
    viewAllSoon(); // the list, unlike the record, tells no sidebar by itself
    await redrawPlaceholders(await copiesOf(essentialKey));
    return;
  }
  const key = syncKeyByTab.get(tabId), all = await getSynced();
  if (!all[key]?.saved || !setName(all[key], text)) return;
  saveSynced(all);
  await redrawPlaceholders(await repsNow(key));
}
