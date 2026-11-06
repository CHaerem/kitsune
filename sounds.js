// Where the sound is coming from (Tidier alone). Other spaces' tabs are hidden, and
// the copy of a tab in this window stays silent while its real page plays in another
// window, since a page is loaded only once. So noise could have no visible source.
//
// So each view asks Firefox once what plays and what is muted, across all windows,
// and gives that to what each tab stands for: a row or tile shows the sound of its
// real page, wherever that is. Nothing here runs unless a view is being drawn or a
// sound changes: no timer, no polling, and with nothing playing only the two queries.

// Firefox keeps a muted tab audible while the page still plays (the user just does
// not hear it), so muted decides first.
const ownSound = t => t.mutedInfo?.muted ? "muted" : t.audible ? "playing" : null;

// Which tabs had sound in the last view, to notice when one closes.
let soundTabs = new Set();

// What a tab stands for: an essential's key or the tab record's, the same for all its
// copies (both are random, so they cannot clash). A tab that has neither (just opened,
// or a page Tidier does not keep) stands for itself.
const soundKey = t => (t.pinned ? keyByTab.get(t.id) : syncKeyByTab.get(t.id)) ?? `tab:${t.id}`;

// An essential's key may not be in memory yet for a tab that no view has drawn: an
// essential of another space, or one in another window.
const knowEssentials = tabs => Promise.all(tabs.filter(t => t.pinned).map(t => keyOf(t).catch(() => null)));

// What has sound now, in all windows: key -> { sound, tabId, space }. tabId is always
// a real page. A placeholder is left out, as a mute there says nothing about the page
// and does nothing until the placeholder loads it (Firefox's own tab menu can do that).
// Playing wins over muted: what you can hear is what you are looking for.
async function soundsFor() {
  const [playing, muted] = await Promise.all([browser.tabs.query({ audible: true }), browser.tabs.query({ muted: true })]);
  const tabs = [...muted.filter(t => !isGhostUrl(t.url)), ...playing.filter(t => ownSound(t) === "playing")];
  await knowEssentials(tabs);
  return new Map(tabs.map(t => [soundKey(t), { sound: ownSound(t), tabId: t.id, space: t.cookieStoreId }]));
}

// Adds the truth to what a view shows: item.sound and item.soundTabId on tiles and
// rows, f.sound and f.soundTabId on a closed folder (an open one shows it on its row),
// and s.soundTabId on a space with something playing. soundTabId on a tile, a row or a
// folder is the tab to mute, so never a placeholder. On a space it is the tab to go
// to: this window's copy, as selecting that pulls the page in.
async function addSounds({ essentials, folders, tabs: loose, spaces }, windowTabs) {
  const sounds = await soundsFor();
  soundTabs = new Set([...sounds.values()].map(s => s.tabId));
  const keyOfTab = new Map(), copyHere = new Map();
  if (sounds.size) {
    await knowEssentials(windowTabs);
    for (const t of windowTabs) { keyOfTab.set(t.id, soundKey(t)); copyHere.set(soundKey(t), t.id); }
  }
  for (const item of [...essentials, ...folders.flatMap(f => f.tabs), ...loose]) {
    const found = sounds.get(keyOfTab.get(item.id));
    item.sound = found?.sound ?? null;
    item.soundTabId = found?.tabId ?? null;
  }
  for (const f of folders) {
    const loudest = f.collapsed && (f.tabs.find(t => t.sound === "playing") ?? f.tabs.find(t => t.sound === "muted"));
    if (loudest) { f.sound = loudest.sound; f.soundTabId = loudest.soundTabId; }
  }
  for (const [key, { sound, tabId, space }] of sounds) {
    const s = sound === "playing" && spaces.find(x => x.id === space);
    if (s) s.soundTabId ??= copyHere.get(key) ?? tabId;
  }
}

// To the tab that plays. Its copy here is selected, which also takes you to its space.
// A page Tidier does not keep has no copy here: then to its own window.
async function goToSound(windowId, tabId) {
  const tab = await browser.tabs.update(tabId, { active: true }).catch(() => null);
  if (tab && tab.windowId !== windowId) await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

// A sound shows in every window, so every window's view follows it; a closing tab
// sends no such change, and a tile elsewhere would go on showing its sound.
browser.tabs.onUpdated.addListener(() => { if (tidierAlone) viewAllSoon(); }, { properties: ["audible", "mutedInfo"] });
browser.tabs.onRemoved.addListener(tabId => { if (soundTabs.delete(tabId)) viewAllSoon(); });
