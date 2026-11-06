// Archive tabs you have not used for a while, like Arc: a tab that has not
// been selected in any window for 12 hours is closed everywhere. Firefox keeps
// it under History → Recently Closed Tabs (⌘⇧T reopens the last one).
//
// Kept: essentials (pinned), Sidebery folders and every tab in them (Arc's
// pinned folders; the pull request folders too), a tab that is selected in
// any window, and tabs playing sound.
//
// The time counts from when the tab was last selected (or opened, if it never
// was), but never from before
// archiving was first turned on, so turning it on does not close old tabs at
// once. Change the time with "archiveAfterHours" in the extension storage
// (0 turns archiving off).

const ARCHIVE_DEFAULT_HOURS = 12;
const ARCHIVE_CHECK_MINUTES = 10;

// A Sidebery folder, or a tab anywhere below one: by the stored parents, and
// by the tree as it is now (Sidebery keeps openerTabId equal to the parent),
// since a tab can be moved into a folder after it was opened.
function inFolder(all, key, live, tabsById) {
  if (all[key]?.group || storedInFolder(all, key)) return true;
  for (let t = live, seen = new Set(); t && !seen.has(t.id); t = tabsById.get(t.openerTabId)) {
    seen.add(t.id);
    if (isSideberyGroup(t.url)) return true;
  }
  return false;
}

// `now` and `onlyKeys` are for the smoke test (pretend it is later, and only
// look at its own tabs); `explain` returns why each tab was kept.
async function archiveIdleTabs({ now = Date.now(), onlyKeys, explain = false } = {}) {
  const stored = await browser.storage.local.get(["archiveAfterHours", "archiveSince"]);
  const hours = stored.archiveAfterHours ?? ARCHIVE_DEFAULT_HOURS;
  if (!hours) return [];
  let since = stored.archiveSince;
  if (!since) {
    since = Date.now();
    await browser.storage.local.set({ archiveSince: since });
  }
  const all = await getSynced();
  const tabs = await browser.tabs.query({});
  const archived = [], kept = {};
  const tabsById = new Map(tabs.map(t => [t.id, t]));
  for (const key of onlyKeys || Object.keys(all)) {
    const why = keepReason(all, key, repsOf(key, tabs), tabsById, now, since, hours);
    if (why) { kept[key] = why; continue; }
    archived.push(all[key].url);
    await closeEverywhere(key, { dismiss: false });
  }
  return explain ? { archived, kept } : archived;
}

function keepReason(all, key, reps, tabsById, now, since, hours) {
  const entry = all[key];
  if (!entry) return "unknown";
  if (!reps.length) return "no tab";
  const live = reps.find(t => syncRoleByTab.get(t.id) === "live");
  if (entry.group || reps.some(t => inFolder(all, key, t, tabsById))) return "folder";
  if (reps.some(t => t.pinned)) return "pinned";
  if (reps.some(t => t.active)) return "selected";
  if (reps.some(t => t.audible)) return "sound";
  if (!live) return "no live tab";
  // A tab opened in the background and never selected has no lastAccessed;
  // then the time counts from when it was opened.
  const lastUsed = Math.max(live.lastAccessed || 0, entry.added || 0, since);
  if (now - lastUsed < hours * 3600e3) return "used " + Math.round((now - lastUsed) / 60000) + " min ago";
  return null;
}

browser.alarms.create("archive", { periodInMinutes: ARCHIVE_CHECK_MINUTES });
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "archive" && started) serial(() => archiveIdleTabs());
});

// From the extension's own pages only (the smoke test uses this).
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "archiveNow" || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return serial(() => archiveIdleTabs({ now: msg.now, onlyKeys: msg.keys, explain: msg.explain }));
});
