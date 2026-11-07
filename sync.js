// The same essentials, folders, saved tabs, rules and spaces on every machine, through
// Firefox Sync (browser.storage.sync). Only with Tidier alone, and only when turned on in
// the settings page. Ordinary tabs are temporary and stay on each machine; what is open or
// loaded, and which spaces are hidden here, are this machine's own.
//
// What is shared, and how two versions become one, is in syncmerge.js. This file reads
// what is here and applies the result:
//
//   a change here or from another machine -> a round some seconds later, in the queue:
//     1. what is in storage.sync, and what changed here since the last round (stamped)
//     2. mergeSynced of the two
//     3. what differs is applied here, by the same paths as taking in a copy
//     4. what differs is written; with nothing different, nothing is written
//
// Rounds cannot answer each other: a round writes only what differs from storage.sync, an
// item it has written itself is recognised, and the items are a pure function of the merged
// document, so that two machines holding the same write the same. With nothing happening
// there is no timer at all. The state (syncState) is written only once a round has been
// applied: one cut short is simply done again, and all of it is idempotent.
//
// Firefox Sync must be signed in, with Add-ons turned on in its settings (MDN), which also
// syncs which add-ons are installed. The Firefox setting services.sync.engine.extension-storage.force
// syncs only this data. It brings changes every ten minutes or so. Without it, nothing goes
// anywhere and nothing is wrong.

const SYNC_DELAY_MS = 5000;
const SYNC_COPY_WAIT_MS = 10000; // for the helper that writes a copy to a file; the queue waits meanwhile
const SYNC_BIG_REMOVAL = 5; // removed from elsewhere in one go: a copy is taken first
const SYNC_WATCHED = ["essentials", "syncedTabs", "rules", "spaceOrder"]; // what a round reads from storage.local
let syncIsOn = false;
let syncMemory = null;
let syncTimer = null;
let syncProblem = null;
const syncWrote = new Map(); // key -> the item as this machine last wrote it, to tell it from another machine's
let syncStateWritten = null; // the state as last written: most rounds change nothing, and then write nothing

// Soon, batched: the first change starts the wait and later ones are taken along, so
// that a stream of changes cannot put a round off for ever.
function syncSoon() {
  if (!syncIsOn || !tidierAlone || !started || syncTimer !== null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    serial(syncRound).catch(() => {}); // logged by serial()
  }, SYNC_DELAY_MS);
}

// What a round looks at in the record. A title or an icon is not shared, and a page whose
// title ticks writes the record every half minute: that must not start a round each time.
const SYNC_SHARED_PART = {
  essentials: list => (list || []).map(e => [e.key, e.url, e.name, e.cookieStoreId]),
  syncedTabs: all => Object.entries(all || {}).filter(([, e]) => e.group || e.saved).map(([key, e]) => [key, e.name, e.rank, e.parentKey, e.saved?.url, e.cookieStoreId, e.live]),
};
const syncSharedChanged = (key, change) => !SYNC_SHARED_PART[key] || JSON.stringify(SYNC_SHARED_PART[key](change.oldValue)) !== JSON.stringify(SYNC_SHARED_PART[key](change.newValue));

function syncOnStorage(changes, area) {
  if (area === "local" && SYNC_WATCHED.some(k => k in changes && syncSharedChanged(k, changes[k]))) syncSoon();
  if (area === "sync" && Object.entries(changes).some(([k, c]) => syncWrote.get(k) !== JSON.stringify(c.newValue))) syncSoon();
}
// Firefox hands a listener every write to storage, all of the tab record, old and new: only
// while this is on. The daily browser, which gets every commit, must not pay for it.
function syncListen() {
  if (!syncIsOn) browser.storage.onChanged.removeListener(syncOnStorage);
  else if (!browser.storage.onChanged.hasListener(syncOnStorage)) browser.storage.onChanged.addListener(syncOnStorage);
}
// A tab moved within a folder changes no record: its order is the window's (syncSnapshot).
browser.tabs.onMoved.addListener(syncSoon);
// A window after none, or a space shown again: filled by the record, and a round puts its order right.
browser.windows.onCreated.addListener(syncSoon);
for (const event of ["onCreated", "onUpdated", "onRemoved"]) browser.contextualIdentities[event].addListener(syncSoon);

async function syncStateNow() {
  if (!syncMemory) syncMemory = (await browser.storage.local.get("syncState")).syncState ?? {};
  syncMemory.doc ??= emptySyncDoc();
  syncMemory.seen ??= null;
  syncMemory.map ??= {}; // sid -> this profile's container
  syncMemory.away ??= {}; // sid -> 1: spaces whose container you removed here
  syncMemory.clock ??= 0;
  return syncMemory;
}

// --- Which container is which space on this machine ----------------------------------
// By name, the first time a space is seen, each container used once: two spaces with one
// name stay two, and their logins apart: the rule a copy is taken in by (mapSpaces,
// copies.js). None to match is no map at all there, an empty one here.
const syncMapByName = (theirs, local) => mapSpaces({ spaces: theirs }, local) ?? {};

async function syncMatchSpaces(st, remote) {
  // (Asked directly: an answer of none because Firefox refused must not look like every
  // space removed. A refusal stops the round, which changes nothing.)
  const containers = (await browser.contextualIdentities.query({})).map(c => ({ id: c.cookieStoreId, name: c.name }));
  const exists = new Set(containers.map(c => c.id));
  const dropped = new Set();
  // A container you removed here: the space stays for the other machines (their logins are
  // in it), and stays away from this one until a container with its name is made here.
  for (const [sid, id] of Object.entries(st.map)) {
    if (!exists.has(id)) { delete st.map[sid]; st.away[sid] = 1; dropped.add(sid); }
  }
  const mapped = new Set(Object.values(st.map));
  const known = { ...st.doc.spaces, ...remote.spaces };
  const theirs = Object.keys(known).filter(sid => !st.map[sid] && known[sid].name).map(sid => ({ id: sid, name: known[sid].name }));
  const free = containers.filter(c => !mapped.has(c.id));
  const byName = syncMapByName(theirs, free);
  for (const sid of Object.keys(byName ?? {})) {
    if (byName[sid]) { st.map[sid] = byName[sid]; mapped.add(byName[sid]); delete st.away[sid]; }
  }
  for (const c of free) {
    if (!mapped.has(c.id)) st.map[syncSpaceId(c.name, sid => st.map[sid] || known[sid])] = c.id;
  }
  return dropped;
}

// --- What is here --------------------------------------------------------------------
// (Not through the middle of a character: half of one would show, see syncText.)
const syncClip = title => (typeof title === "string" ? title.slice(0, SYNC_TITLE_CHARS).replace(/[\ud800-\udbff]$/, "") : undefined);
const syncDefined = item => Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && v !== null));

async function syncSnapshot(st) {
  const here = emptySyncDoc();
  const containers = await browser.contextualIdentities.query({});
  const sidOf = new Map(Object.entries(st.map).map(([sid, id]) => [id, sid]));
  sidOf.set(NO_CONTAINER, SYNC_NO_SPACE);
  // Nothing an agent did may reach a machine that has not turned it on (bridge.js): not the
  // Agent space with what is in it, nor a For you folder elsewhere.
  if (agentSpaceId) sidOf.delete(agentSpaceId);
  for (const c of containers) {
    const sid = sidOf.get(c.cookieStoreId);
    if (sid) here.spaces[sid] = syncDefined({ name: c.name, color: c.color, icon: c.icon });
  }
  const list = await getList();
  const inSpace = new Map();
  const note = (scope, id) => { if (!inSpace.has(scope)) inSpace.set(scope, []); inSpace.get(scope).push(syncShort(id)); };
  for (const e of list) {
    const space = sidOf.get(e.cookieStoreId);
    if (!space || !isWeb(e.url)) continue;
    here.essentials[e.key] = syncDefined({ url: e.url, title: syncClip(e.title), name: e.name, space });
    note("e:" + space, e.key);
  }
  const all = await getSynced();
  const isShared = key => isOwnFolder(all[key]) && !all[key].live;
  const folders = Object.entries(all).filter(([key]) => isShared(key)).sort((a, b) => (a[1].rank ?? 0) - (b[1].rank ?? 0));
  for (const [key, e] of folders) {
    const space = sidOf.get(e.cookieStoreId);
    if (!space || e.forYou) continue;
    here.folders[key] = { name: e.name, space };
    note("f:" + space, key);
  }
  for (const [key, e] of Object.entries(all)) {
    if (e.group || e.liveFolder || !isWeb(e.saved?.url)) continue;
    const space = sidOf.get(e.cookieStoreId), folder = folderKeyOf(all, key);
    if (!space || !here.folders[folder]) continue;
    here.saved[key] = syncDefined({ url: e.saved.url, title: syncClip(e.saved.title ?? e.title), name: e.name, folder, space });
  }
  for (const r of await rulesList.get()) {
    const space = sidOf.get(r.space), id = "r:" + r.url;
    if (!space || here.rules[id]) continue;
    here.rules[id] = { space };
    note("rules", id);
  }
  // The order of the spaces, once there is one (spaceList otherwise goes by the essentials,
  // which is no order you chose, and no reason to change another machine's).
  const stored = (await browser.storage.local.get("spaceOrder")).spaceOrder;
  if (Array.isArray(stored)) {
    const rank = new Map(stored.map((id, i) => [id, i]));
    const inOrder = [...containers].sort((a, b) => (rank.get(a.cookieStoreId) ?? Infinity) - (rank.get(b.cookieStoreId) ?? Infinity));
    for (const c of inOrder) if (sidOf.has(c.cookieStoreId)) note("spaces", sidOf.get(c.cookieStoreId));
  }
  // A folder's order is the window's: only from a window that has all of its tabs, so
  // that a window still being filled, or a hidden space, says nothing about their order.
  const tabs = await browser.tabs.query({});
  const ref = referenceWindow(tabs, undefined);
  const reps = new Map(tabs.filter(t => t.windowId === ref).map(t => [syncKeyByTab.get(t.id), t.index]));
  const inFolder = new Map();
  for (const [key, s] of Object.entries(here.saved)) {
    if (!inFolder.has(s.folder)) inFolder.set(s.folder, []);
    inFolder.get(s.folder).push(key);
  }
  for (const [folder, keys] of inFolder) {
    if (keys.every(k => reps.has(k))) here.order["s:" + folder] = keys.sort((a, b) => reps.get(a) - reps.get(b)).map(syncShort);
  }
  for (const [scope, order] of inSpace) here.order[scope] = order;
  return here;
}

// --- Applying what came --------------------------------------------------------------
// A thing's last key: one that became another may have become another again.
function syncLastKey(map, key) {
  for (let k = key, n = 0; n < 20; n++) {
    const to = syncOwn(map, k)?.to;
    if (!to) return k;
    k = to;
  }
  return key;
}

// A removed essential's copies go, as when you unpin elsewhere; one that is open stays
// yours, as an ordinary tab. Nothing that is open is closed by another machine.
async function syncRetireEssential(entry) {
  const copies = await copiesOf(entry.key);
  // (Normally one is loaded, but Firefox can restore a page in several windows at once.)
  const loaded = copies.filter(isLoadedCopy);
  const open = loaded.length ? loaded : copies.filter(t => t.active).slice(0, 1);
  copies.forEach(t => busy.add(t.id));
  const closing = copies.filter(t => !open.includes(t)).map(t => t.id);
  if (closing.length) await browser.tabs.remove(closing).catch(noteError);
  await forgetClosedPlaceholders("essential", [entry.key]);
  for (const t of open) {
    keyByTab.delete(t.id);
    await browser.sessions.removeTabValue(t.id, TAB_KEY).catch(() => {});
    await browser.tabs.update(t.id, { pinned: false, ...(isGhostUrl(t.url) ? { url: entry.url } : {}) }).catch(() => {});
    setTimeout(() => busy.delete(t.id), SETTLE_MS);
    registerSoon(t.id); // an ordinary tab now, in every window
  }
}

// The same essential under the key both machines chose: it keeps its tabs, loaded or not.
async function syncRekeyEssential(oldKey, newKey) {
  for (const t of await copiesOf(oldKey)) {
    await tagTab(t.id, newKey);
    if (isGhostUrl(t.url) && !t.active) await browser.tabs.update(t.id, { url: ghostUrl("essential", newKey) }).catch(() => {});
  }
}

async function syncApplyEssentials(doc, here, idOf) {
  const before = await getList();
  let list = [...before], changed = false;
  const retired = [], rekeyed = [];
  for (const [key, item] of Object.entries(doc.essentials)) {
    const entry = list.find(e => e.key === key), isHere = syncOwn(here.essentials, key);
    if (item.gone) {
      if (!entry || !isHere) continue;
      const to = syncLastKey(doc.essentials, key);
      if (to !== key && !doc.essentials[to]?.gone && idOf(doc.essentials[to]?.space)) rekeyed.push([key, to]);
      else retired.push(entry);
      list = list.filter(e => e !== entry);
      changed = true;
      continue;
    }
    const space = idOf(item.space);
    if (!space) continue;
    if (!entry) {
      list.push({ key, url: item.url, cookieStoreId: space, title: item.title, ...(item.name ? { name: item.name } : {}) });
      changed = true;
    } else if (!isHere || syncSig("essentials", item) !== syncSig("essentials", isHere)) {
      // A tab cannot change container: in another space it is a new tab there.
      if (entry.cookieStoreId !== space) retired.push({ ...entry });
      list = list.map(e => (e === entry ? { ...e, url: item.url, cookieStoreId: space, ...(item.name ? { name: item.name } : {}) } : e));
      if (!item.name) delete list.find(e => e.key === key).name;
      changed = true;
    }
  }
  // The icon stays with what is the same essential: icons are not shared, and one that came
  // from a page behind a sign-in cannot be found again until that page has been opened.
  for (const [oldKey, newKey] of rekeyed) {
    const now = list.find(e => e.key === newKey);
    if (now && !now.icon) now.icon = before.find(e => e.key === oldKey)?.icon;
  }
  if (changed) setList(list);
  for (const [oldKey, newKey] of rekeyed) await syncRekeyEssential(oldKey, newKey);
  for (const entry of retired) await syncRetireEssential(entry);
  if (rekeyed.length) await forgetClosedPlaceholders("essential", rekeyed.map(([k]) => k));
  // A new short name reaches the placeholders when they are drawn again.
  for (const [key, item] of Object.entries(doc.essentials)) {
    const isHere = syncOwn(here.essentials, key);
    if (item.gone || !isHere || item.name === isHere.name) continue;
    for (const t of await copiesOf(key)) if (isGhostUrl(t.url) && !t.active) await browser.tabs.update(t.id, { url: ghostUrl("essential", key) }).catch(() => {});
  }
  return changed;
}

// Whether a saved tab is open here: it then stays, whatever another machine did to it.
function syncIsOpen(reps) {
  return reps.some(t => t.active || (!t.discarded && !isGhostUrl(t.url)));
}

// The same folder or saved tab under the key both machines chose: it keeps its tabs.
async function syncRekeyRecord(all, oldKey, newKey, tabs) {
  if (!all[newKey]) all[newKey] = all[oldKey];
  for (const e of Object.values(all)) if (e.parentKey === oldKey) e.parentKey = newKey;
  delete all[oldKey];
  for (const t of repsOf(oldKey, tabs)) {
    const role = syncRoleByTab.get(t.id);
    await setRole(t.id, newKey, role);
    if (isGhostUrl(t.url) && !t.active) await browser.tabs.update(t.id, { url: ghostUrl("ghost", newKey) }).catch(() => {});
  }
}

async function syncApplyRecord(doc, here, idOf) {
  const all = await getSynced();
  const tabs = await browser.tabs.query({});
  let changed = false;
  for (const kind of ["folders", "saved"]) {
    for (const [key, item] of Object.entries(doc[kind])) {
      if (!item.gone || !all[key] || !syncOwn(here[kind], key)) continue;
      const to = syncLastKey(doc[kind], key);
      if (to !== key && !doc[kind][to]?.gone) { await syncRekeyRecord(all, key, to, tabs); changed = true; }
    }
  }
  for (const [key, item] of Object.entries(doc.folders)) {
    const space = idOf(item.space), e = all[key];
    if (item.gone || !space) continue;
    if (!e) {
      const others = foldersOf(all, space);
      all[key] = { group: true, own: true, name: item.name, cookieStoreId: space, parentKey: null, rank: (others.at(-1)?.rank ?? 0) + 1, added: Date.now() };
      changed = true;
    } else if (isOwnFolder(e) && !e.live && (e.name !== item.name || e.cookieStoreId !== space)) {
      Object.assign(e, { name: item.name, cookieStoreId: space });
      changed = true;
    }
  }
  for (const [key, item] of Object.entries(doc.saved)) {
    const space = idOf(item.space), e = all[key], isHere = syncOwn(here.saved, key);
    if (item.gone || !space || !isOwnFolder(all[item.folder])) continue; // its folder may not be here yet: a later round
    if (!e) {
      all[key] = { url: item.url, title: item.title, cookieStoreId: space, parentKey: item.folder, group: false, added: Date.now(),
        saved: { url: item.url, title: item.title }, ...(item.name ? { name: item.name } : {}) };
      changed = true;
    } else if (!isHere || syncSig("saved", item) !== syncSig("saved", isHere)) {
      const reps = repsOf(key, tabs);
      // The address a saved tab goes back to; a page you have open stays on what it shows.
      e.saved = { ...(e.saved?.url === item.url ? e.saved : {}), url: item.url, title: item.title ?? e.saved?.title };
      if (!syncIsOpen(reps)) Object.assign(e, { url: item.url, title: item.title ?? e.title });
      e.parentKey = item.folder;
      if (item.name) e.name = item.name; else delete e.name;
      for (const t of reps) if (isGhostUrl(t.url) && !t.active) await browser.tabs.update(t.id, { url: ghostUrl("ghost", key) }).catch(() => {});
      changed = true;
    }
  }
  if (changed) { noteSaved(all); saveSynced(all); }
  // A saved tab removed elsewhere: its placeholders go, and if it is open here it stays
  // yours, as an ordinary tab. A folder removed elsewhere keeps its tabs as ordinary ones,
  // as when you delete one here.
  for (const [key, item] of Object.entries(doc.saved)) {
    if (!item.gone || !syncOwn(here.saved, key) || !all[key]) continue;
    // (Looked at now: you may have opened one while the others were being handled.)
    if (syncIsOpen(repsOf(key, await browser.tabs.query({})))) { all[key].parentKey = null; noteSaved(all, [key]); saveSynced(all); }
    else await closeEverywhere(key, { dismiss: false });
    changed = true;
  }
  for (const [key, item] of Object.entries(doc.folders)) {
    if (!item.gone || !syncOwn(here.folders, key) || !all[key]) continue;
    await deleteFolder(key);
    changed = true;
  }
  return changed;
}

async function syncApplyRules(doc, idOf, st) {
  const rules = await rulesList.get();
  const wanted = syncRanked(Object.keys(doc.rules).filter(id => !doc.rules[id].gone && idOf(doc.rules[id].space)), doc.order.rules?.list)
    .map(id => ({ url: id.slice(2), space: idOf(doc.rules[id].space) }));
  // A rule whose space this machine does not know is left as it was.
  const known = new Set([...Object.values(st.map), NO_CONTAINER]);
  const next = [...wanted, ...rules.filter(r => !known.has(r.space))];
  if (JSON.stringify(next) === JSON.stringify(rules)) return false;
  rulesList.set(next);
  return true;
}

// Put tabs in this order in a window, moving as few as can be: each must come before the
// next, and where they are among other tabs does not matter (the sidebar draws by folder).
async function syncPutInOrder(windowId, ids) {
  let tabs = await browser.tabs.query({ windowId }), moved = false;
  for (let i = ids.length - 2; i >= 0; i--) {
    const a = tabs.find(t => t.id === ids[i]), b = tabs.find(t => t.id === ids[i + 1]);
    if (!a || !b || a.index < b.index) continue;
    await moveInWindow(tabs, a.id, b.id);
    tabs = await browser.tabs.query({ windowId });
    moved = true;
  }
  return moved;
}

const syncRanked = (ids, list) => {
  const rank = new Map((list ?? []).map((short, i) => [short, i]));
  return ids.map((id, i) => [id, i]).sort((a, b) => (rank.get(syncShort(a[0])) ?? Infinity) - (rank.get(syncShort(b[0])) ?? Infinity) || a[1] - b[1]).map(([id]) => id);
};

// The order of things, for each scope that differs from what is here. What this cannot
// bring about is no change you made: the next round reads what is here as it is then.
async function syncApplyOrders(doc, here, idOf) {
  let changed = false;
  const differs = scope => doc.order[scope] && JSON.stringify(doc.order[scope].list) !== JSON.stringify(here.order[scope]);
  // Essentials: each space's in the list's order; the spaces stay as the list has them.
  const list = await getList();
  let next = list;
  for (const scope of Object.keys(doc.order).filter(s => s.startsWith("e:") && differs(s))) {
    const space = idOf(scope.slice(2));
    if (!space) continue;
    const mine = next.filter(e => e.cookieStoreId === space);
    const sorted = syncRanked(mine.map(e => e.key), doc.order[scope].list).map(k => mine.find(e => e.key === k));
    let at = 0;
    next = next.map(e => (e.cookieStoreId === space ? sorted[at++] : e));
  }
  if (next.some((e, i) => e !== list[i])) {
    setList(next);
    for (const w of await normalWindows()) await sortEssentials(w.id, await getList());
    changed = true;
  }
  // Folders: their rank in the record.
  const all = await getSynced();
  for (const scope of Object.keys(doc.order).filter(s => s.startsWith("f:") && differs(s))) {
    const space = idOf(scope.slice(2));
    if (!space) continue;
    const mine = foldersOf(all, space).filter(f => !f.live).map(f => f.key);
    const sorted = syncRanked(mine, doc.order[scope].list);
    if (sorted.every((k, i) => k === mine[i])) continue;
    sorted.forEach((k, i) => { all[k].rank = i + 1; });
    saveSynced(all);
    changed = true;
  }
  // Saved tabs: the window's order, in every window.
  for (const scope of Object.keys(doc.order).filter(s => s.startsWith("s:") && here.order[s] && differs(s))) {
    const folder = scope.slice(2);
    const keys = Object.entries(here.saved).filter(([, s]) => s.folder === folder).map(([k]) => k);
    const sorted = syncRanked(keys, doc.order[scope].list);
    for (const w of await normalWindows()) {
      const reps = repMap(await browser.tabs.query({ windowId: w.id }));
      if (await syncPutInOrder(w.id, sorted.map(k => reps.get(k)).filter(id => id !== undefined))) changed = true;
    }
  }
  // Spaces: the bar's order.
  if (differs("spaces")) {
    const inOrder = syncRanked(Object.keys(here.spaces), doc.order.spaces.list).map(idOf).filter(Boolean);
    const stored = (await browser.storage.local.get("spaceOrder")).spaceOrder;
    if (JSON.stringify(stored) !== JSON.stringify(inOrder)) {
      await browser.storage.local.set({ spaceOrder: inOrder });
      viewAllSoon();
      changed = true;
    }
  }
  return changed;
}

// Spaces here. One that is new is made, with its name, colour and icon (a colour this
// Firefox does not know must not stop the rest). One that cannot be made stays out, with
// everything in it, until a later round.
async function syncApplySpaces(doc, here, st) {
  let changed = false;
  for (const [sid, s] of Object.entries(doc.spaces)) {
    if (st.away[sid]) continue;
    const id = st.map[sid];
    if (!id) {
      const create = props => browser.contextualIdentities.create({ name: s.name, ...props });
      const c = await create({ color: s.color || "blue", icon: s.icon || "circle" }).catch(() => create({ color: "blue", icon: "circle" })).catch(noteError);
      if (c) { st.map[sid] = c.cookieStoreId; changed = true; }
      continue;
    }
    const h = syncOwn(here.spaces, sid);
    if (!h) continue;
    const changes = { name: s.name, ...(s.color ? { color: s.color } : {}), ...(s.icon ? { icon: s.icon } : {}) };
    if (Object.keys(changes).every(k => h[k] === changes[k])) continue;
    // Firefox tells of every update, which starts a round: what it refuses is not asked for
    // again in a way that succeeds without changing anything, or the rounds would never end.
    const nameOnly = () => (h.name === s.name ? null : browser.contextualIdentities.update(id, { name: s.name }));
    await browser.contextualIdentities.update(id, changes).catch(nameOnly).catch(noteError);
    changed = true;
  }
  if (changed) await rereadHiddenSpaces(); // a space that came just now, or was renamed, may be declared hidden here
  return changed;
}

async function syncApply(doc, here, st) {
  const idOf = sid => (sid === SYNC_NO_SPACE ? NO_CONTAINER : st.map[sid]);
  const removing = ["essentials", "folders", "saved"].reduce((n, kind) => n + Object.entries(doc[kind]).filter(([id, item]) => item.gone && syncOwn(here[kind], id)).length, 0);
  if (removing >= SYNC_BIG_REMOVAL) await syncKeepCopy();
  const spaces = await syncApplySpaces(doc, here, st);
  const essentials = await syncApplyEssentials(doc, here, idOf);
  const record = await syncApplyRecord(doc, here, idOf);
  const rules = await syncApplyRules(doc, idOf, st);
  // As when a copy is taken in: every window gets what it is missing. It never closes a tab
  // you have open, and a hidden space gets nothing.
  if (essentials || record) await reconcileAll();
  const now = spaces || essentials || record || rules ? await syncSnapshot(st) : here;
  const order = await syncApplyOrders(doc, now, idOf);
  if (spaces || essentials || record || rules || order) viewAllSoon();
  return order ? syncSnapshot(st) : now;
}

// --- A round --------------------------------------------------------------------------
async function syncKeepCopy() {
  const res = await Promise.race([makeCopy().catch(() => null), sleep(SYNC_COPY_WAIT_MS).then(() => null)]); // a helper that hangs must not hold every tab up
  if (!res?.saved) await browser.storage.local.set({ copyBeforeSync: await theCopy() }); // no helper here: at least inside Firefox's storage
}

async function syncWrite(doc, items) {
  const wanted = syncItems(doc).items;
  const changed = {};
  for (const [key, value] of Object.entries(wanted)) if (JSON.stringify(items[key]) !== JSON.stringify(value)) changed[key] = value;
  // Removed first: what is written next must fit next to what is still there.
  const stale = Object.keys(items).filter(key => key.startsWith(SYNC_PREFIX) && !(key in wanted));
  stale.forEach(key => syncWrote.set(key, undefined));
  if (stale.length) await browser.storage.sync.remove(stale);
  for (const [key, value] of Object.entries(changed)) syncWrote.set(key, JSON.stringify(value));
  if (Object.keys(changed).length) await browser.storage.sync.set(changed);
}

async function syncRound() {
  if (!syncIsOn || !tidierAlone) return;
  try {
    const st = await syncStateNow();
    const items = await browser.storage.sync.get(null);
    const remote = docFromItems(items);
    st.clock = Math.max(st.clock, syncHighest(remote));
    const stamp = () => (st.clock = Math.max(Date.now(), st.clock + 1));
    if (!st.seen) await syncKeepCopy(); // the first merge: there is a way back from it
    const dropped = await syncMatchSpaces(st, remote);
    const here = await syncSnapshot(st);
    // A space whose container went this very round (even if one of its name is here again) says
    // nothing about what is in it: essentials.js has dropped its essentials, and you deleted nothing.
    const isHere = sid => sid === SYNC_NO_SPACE || (!!st.map[sid] && !dropped.has(sid));
    const merged = mergeSynced(noteLocalChanges(st.doc, here, st.seen, stamp, isHere), remote);
    st.clock = Math.max(st.clock, syncHighest(merged));
    st.seen = syncSeen(await syncApply(merged, here, st));
    st.doc = merged;
    // What was applied first, and only then that it was seen: the record is written a moment
    // after a change, and a state that is ahead of it (a crash, a quit, an update just now) would
    // at the next start read as you having deleted all that just came, on every machine.
    await flushWrites();
    const text = JSON.stringify(st);
    if (text !== syncStateWritten) { await browser.storage.local.set({ syncState: st }); syncStateWritten = text; }
    await syncWrite(merged, items);
    syncProblem = null;
    setNotice("sync", null);
  } catch (err) {
    syncProblem = String(err?.message ?? err);
    setNotice("sync", `Sync across machines has stopped: ${syncProblem}`);
    noteError(err); // and the next change tries again; no timer waits for it
  }
}

// Turning it on is a merge, never an overwrite: what is here and what the other machines have
// both stay. What was deleted while it was off comes back rather than being deleted everywhere,
// since "deleted" can only be known from what was seen a moment before.
async function syncTurn(on) {
  if (!tidierAlone) return;
  clearTimeout(syncTimer);
  syncTimer = null;
  syncIsOn = !!on;
  syncListen();
  if (!syncIsOn) { syncProblem = null; setNotice("sync", null); } // what is off has no problem to show
  await browser.storage.local.set({ syncOn: syncIsOn });
  const st = await syncStateNow();
  st.doc = emptySyncDoc();
  st.seen = null;
  await browser.storage.local.set({ syncState: st });
  syncStateWritten = null;
  if (syncIsOn) await syncRound();
}

// When Tidier starts. Without Tidier alone, what is kept is forgotten (moving back to Sidebery
// changes the record), so the next time is a first merge again; a browser that never
// had this on only looks.
async function startSync() {
  const stored = await browser.storage.local.get(["syncOn", "syncState"]);
  if (!tidierAlone) {
    if (stored.syncState) await browser.storage.local.remove("syncState");
    return;
  }
  syncIsOn = !!stored.syncOn;
  syncListen();
  syncSoon(); // what changed while Tidier was not running, and what came meanwhile
}

// --- The settings page (settings/sync.js) ---------------------------------------------
async function syncReport() {
  const spaces = await containerSpaces();
  const report = {
    alone: tidierAlone, on: syncIsOn, problem: syncProblem, limit: SYNC_QUOTA.total, bytes: 0, left: [],
    spaces: spaces.map(s => ({ id: s.id, name: s.name, color: s.color, hidden: isHiddenSpace(s.id), declared: hiddenSpacesDeclared.has(s.id) })),
  };
  if (syncIsOn) {
    const layout = syncItems((await syncStateNow()).doc);
    report.bytes = await browser.storage.sync.getBytesInUse(null).catch(() => layout.bytes);
    report.left = layout.left;
  }
  return report;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!String(msg?.type).startsWith("sync:") || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return serial(async () => {
    if (msg.type === "sync:turn") await syncTurn(msg.on);
    else if (msg.type === "sync:hide") { await setSpaceHidden(msg.space, msg.hidden); syncSoon(); }
    return syncReport();
  });
});
