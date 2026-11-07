// Live folders: Sidebery folders filled from a GitHub pull request search,
// like Zen's live folders.
//
// The search runs in a native messaging host (native/github-prs.py) with your
// existing gh login, so no GitHub token reaches the browser. The folders
// (name, container, search) are set up in the host's config file, not here;
// the extension only gets each folder's id, name and container.
//
// Every few minutes (and at startup) each folder is brought in line with the
// search: new pull requests get a tab (an unloaded placeholder that opens the
// pull request when you select it), merged or closed ones are removed (the
// one you are looking at only once you have left it). Tab sync shows the
// folder and its tabs in every window. A tab you close stays closed until the
// pull request leaves the search.

const NATIVE_HOST = "tidier_github";
const GITHUB_ICON = "https://github.githubassets.com/favicons/favicon.svg";
const LIVE_REFRESH_MINUTES = 15;

const liveFolderState = storedValue("liveFolders", () => ({})); // { [id]: { groupKey, dismissed: [url] } }

async function folderState(id) {
  const all = await liveFolderState.get();
  if (!all[id]) all[id] = { groupKey: null, dismissed: [] };
  return all[id];
}
const saveFolderState = async () => liveFolderState.set(await liveFolderState.get());

const groupName = url => decodeURIComponent((url.split("#")[1] || "").replace(/~!.*!~$/, "").replace(/(?::id:|%3Aid%3A).*$/, "")); // (":id:" from older Sidebery)

// Sidebery's group page URL, taken from an existing folder: Sidebery's own
// extension URL is not otherwise visible to other extensions.
async function sideberyGroupBase() {
  const tab = (await browser.tabs.query({})).find(t => isSideberyGroup(t.url));
  return tab ? tab.url.split("#")[0] : null;
}

// New live tabs are created in the window with the most synced tabs.
async function homeWindowId() {
  return referenceWindow(await browser.tabs.query({}), undefined);
}

// The folder's group page: an existing one with this name in this space, or a
// new one.
async function ensureFolderGroup(folder, state) {
  const all = await getSynced();
  if (state.groupKey && all[state.groupKey]) return state.groupKey;
  const existing = Object.entries(all).find(([, e]) =>
    e.group && e.cookieStoreId === folder.cookieStoreId && (e.own ? e.name : groupName(e.url)) === folder.name);
  if (existing) { state.groupKey = existing[0]; await saveFolderState(); return state.groupKey; }
  if (tidierAlone) {
    state.groupKey = await createFolder(folder.name, folder.cookieStoreId, { live: folder.id }); // ownfolders.js
    await saveFolderState();
    return state.groupKey;
  }

  const [base, windowId] = await Promise.all([sideberyGroupBase(), homeWindowId()]);
  if (!base || windowId === undefined) return null;
  const tab = await browser.tabs.create({ windowId, url: `${base}#${encodeURIComponent(folder.name)}`,
    cookieStoreId: folder.cookieStoreId, active: false });
  for (let i = 0; i < 20 && !isSideberyGroup((await browser.tabs.get(tab.id)).url); i++) await sleep(100);
  await register(tab.id);
  state.groupKey = syncKeyByTab.get(tab.id) || null;
  await saveFolderState();
  return state.groupKey;
}

const liveTitle = item => `${item.repo}#${item.number} ${item.title}`;

// A tab for one pull request: live in the home window, ghosts elsewhere.
async function createLiveItem(folder, groupKey, item) {
  const all = await getSynced();
  const key = crypto.randomUUID();
  const entry = {
    url: item.url, liveUrl: item.url, title: liveTitle(item), icon: GITHUB_ICON,
    cookieStoreId: folder.cookieStoreId, parentKey: groupKey, group: false, liveFolder: folder.id,
  };
  all[key] = entry;
  saveSynced(all);
  const tabs = tidierAlone ? [] : await browser.tabs.query({}); // a folder of Tidier's own has no tab to look for
  const home = await homeWindowId();
  for (const w of await normalWindows()) {
    const parentId = repMap(tabs.filter(t => t.windowId === w.id)).get(groupKey);
    if (w.id !== home) { await createRep(w.id, key, entry, parentId); continue; }
    const props = { windowId: w.id, url: ghostUrl("lazy", key), cookieStoreId: entry.cookieStoreId, active: false };
    if (parentId !== undefined) props.openerTabId = parentId;
    if (placeholderWithoutPage(entry)) Object.assign(props, { discarded: true, title: entry.title });
    const tab = await browser.tabs.create(props);
    syncBusy.add(tab.id);
    await setRole(tab.id, key, "live");
    setTimeout(() => syncBusy.delete(tab.id), SETTLE_MS);
  }
}

// The search, outside the queue: it can take up to the host's 30 s timeout,
// and tab sync (selecting a ghost, closing a tab) must not wait for it.
function searchLiveFolder(folder) {
  return browser.runtime.sendNativeMessage(NATIVE_HOST, { folder: folder.id }).catch(err => ({ error: String(err) }));
}

async function refreshLiveFolder(folder, res) {
  if (!res || res.error || !Array.isArray(res.items)) {
    console.warn("Tidier: live folder", folder.id, res?.error);
    // A live folder that has stopped keeps its tabs, so it looks as if nothing has happened.
    setNotice("live", `Live folder "${folder.name}" is not updating: ${res?.error || "no answer"}`);
    return;
  }
  // The host's file still names a space that was removed, with its folder and tabs
  // (safemoves.js): made again, they would be entries shown nowhere, refused at every start.
  if (tidierAlone && await spaceGone(folder.cookieStoreId)) {
    setNotice("live", `Live folder "${folder.name}" is set up for a space that is gone`);
    return;
  }
  const state = await folderState(folder.id);
  const groupKey = await ensureFolderGroup(folder, state);
  if (!groupKey) return;

  const wanted = new Map(res.items.map(i => [i.url, i]));
  state.dismissed = state.dismissed.filter(u => wanted.has(u)); // closed PRs may come back if reopened
  await saveFolderState();

  const all = await getSynced();
  const have = new Map();
  for (const [k, e] of Object.entries(all)) if (e.liveFolder === folder.id) have.set(e.liveUrl, k);
  // A pull request you are looking at is removed at a later refresh, once its
  // tab is no longer the selected tab in any window (merged while you read it).
  const tabs = await browser.tabs.query({});
  for (const [url, k] of have) {
    if (!wanted.has(url) && !repsOf(k, tabs).some(t => t.active) && await closesQuietly(k)) await closeEverywhere(k, { dismiss: false });
  }
  for (const item of res.items) {
    if (have.has(item.url)) await renameLiveItem(have.get(item.url), item);
    else if (!state.dismissed.includes(item.url)) await createLiveItem(folder, groupKey, item);
  }
}

// A pull request renamed on GitHub: its tabs take the new title while none of
// them has been opened. (An opened one shows GitHub's own title, which tab
// sync keeps.)
async function renameLiveItem(key, item) {
  const all = await getSynced();
  const entry = all[key], title = liveTitle(item);
  if (!entry || entry.title === title) return;
  const reps = await repsNow(key);
  if (!reps.length || !reps.every(t => isGhostUrl(t.url))) return;
  entry.title = title;
  saveSynced(all);
  for (const t of reps) {
    const kind = syncRoleByTab.get(t.id) === "live" ? "lazy" : "ghost";
    await browser.tabs.update(t.id, { url: ghostUrl(kind, key) }).catch(() => {});
  }
}

// Called by tab sync when you close a tab: a live folder tab stays closed
// until its pull request leaves the search.
async function noteLiveFolderDismissed(entry) {
  if (!entry?.liveFolder) return;
  const state = await folderState(entry.liveFolder);
  if (!state.dismissed.includes(entry.liveUrl)) state.dismissed.push(entry.liveUrl);
  await saveFolderState();
}

// The folders from the host's config; none if the host is not installed, which is
// only a problem if there have been live folders here.
async function liveFolders() {
  const res = await browser.runtime.sendNativeMessage(NATIVE_HOST, { list: true }).catch(() => null);
  if (!res && Object.keys(await liveFolderState.get()).length) setNotice("live", "Live folders are not updating: their helper does not answer (native/install.sh)");
  return Array.isArray(res?.folders) ? res.folders.map(f => ({ id: f.id, name: f.name, cookieStoreId: f.container })) : [];
}

async function refreshAllLiveFolders() {
  const folders = await liveFolders();
  if (folders.length) setNotice("live", null);
  for (const f of folders) {
    if (isHiddenSpace(f.cookieStoreId)) continue; // a hidden space gets no tabs; the search is done again when it shows
    const res = await searchLiveFolder(f);
    await serial(() => refreshLiveFolder(f, res)).catch(() => {}); // logged by serial()
  }
}

browser.alarms.create("liveFolders", { periodInMinutes: LIVE_REFRESH_MINUTES });
browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === "liveFolders" && started) refreshAllLiveFolders(); });

// From the extension's own pages only (the smoke test refreshes with this).
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "refreshLiveFolders" || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return refreshAllLiveFolders().then(() => true);
});

// First refresh once tab sync has started.
(async () => {
  for (let i = 0; i < 120 && !started; i++) await sleep(1000);
  if (started) refreshAllLiveFolders();
})();
