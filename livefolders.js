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
// pull request when you select it), merged or closed ones are removed. Tab
// sync shows the folder and its tabs in every window. A tab you close stays
// closed until the pull request leaves the search.

const NATIVE_HOST = "kitsune_github";
const GITHUB_ICON = "https://github.githubassets.com/favicons/favicon.svg";
const LIVE_REFRESH_MINUTES = 15;

const liveFolderState = storedValue("liveFolders", () => ({})); // { [id]: { groupKey, dismissed: [url] } }

async function folderState(id) {
  const all = await liveFolderState.get();
  if (!all[id]) all[id] = { groupKey: null, dismissed: [] };
  return all[id];
}
const saveFolderState = async () => liveFolderState.set(await liveFolderState.get());

const groupName = url => decodeURIComponent((url.split("#")[1] || "").replace(/~!.*!~$/, ""));

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
    e.group && e.cookieStoreId === folder.cookieStoreId && groupName(e.url) === folder.name);
  if (existing) { state.groupKey = existing[0]; await saveFolderState(); return state.groupKey; }

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

// A tab for one pull request: live in the home window, ghosts elsewhere.
async function createLiveItem(folder, groupKey, item) {
  const all = await getSynced();
  const key = crypto.randomUUID();
  const entry = {
    url: item.url, liveUrl: item.url, title: `${item.repo}#${item.number} ${item.title}`, icon: GITHUB_ICON,
    cookieStoreId: folder.cookieStoreId, parentKey: groupKey, group: false, liveFolder: folder.id,
  };
  all[key] = entry;
  saveSynced(all);
  const tabs = await browser.tabs.query({});
  const home = await homeWindowId();
  for (const w of await normalWindows()) {
    const parentId = repMap(tabs.filter(t => t.windowId === w.id)).get(groupKey);
    if (w.id !== home) { await createRep(w.id, key, entry, parentId); continue; }
    const props = { windowId: w.id, url: ghostUrl("lazy", key), cookieStoreId: entry.cookieStoreId, active: false };
    if (parentId !== undefined) props.openerTabId = parentId;
    const tab = await browser.tabs.create(props);
    syncBusy.add(tab.id);
    await setRole(tab.id, key, "live");
    setTimeout(() => syncBusy.delete(tab.id), SETTLE_MS);
  }
}

async function refreshLiveFolder(folder) {
  const res = await browser.runtime.sendNativeMessage(NATIVE_HOST, { folder: folder.id })
    .catch(err => ({ error: String(err) }));
  if (!res || res.error) { console.warn("Kitsune: live folder", folder.id, res?.error); return; }
  const state = await folderState(folder.id);
  const groupKey = await ensureFolderGroup(folder, state);
  if (!groupKey) return;

  const wanted = new Map(res.items.map(i => [i.url, i]));
  state.dismissed = state.dismissed.filter(u => wanted.has(u)); // closed PRs may come back if reopened
  await saveFolderState();

  const all = await getSynced();
  const have = new Map();
  for (const [k, e] of Object.entries(all)) if (e.liveFolder === folder.id) have.set(e.liveUrl, k);
  for (const [url, k] of have) if (!wanted.has(url)) await closeEverywhere(k, { dismiss: false });
  for (const item of res.items) {
    if (!have.has(item.url) && !state.dismissed.includes(item.url)) await createLiveItem(folder, groupKey, item);
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

// The folders from the host's config; none if the host is not installed.
async function liveFolders() {
  const res = await browser.runtime.sendNativeMessage(NATIVE_HOST, { list: true }).catch(() => null);
  return Array.isArray(res?.folders) ? res.folders.map(f => ({ id: f.id, name: f.name, cookieStoreId: f.container })) : [];
}

function refreshAllLiveFolders() {
  return serial(async () => { for (const f of await liveFolders()) await refreshLiveFolder(f); });
}

browser.alarms.create("liveFolders", { periodInMinutes: LIVE_REFRESH_MINUTES });
browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === "liveFolders" && started) refreshAllLiveFolders(); });

// First refresh once tab sync has started.
(async () => {
  for (let i = 0; i < 120 && !started; i++) await sleep(1000);
  if (started) refreshAllLiveFolders();
})();
