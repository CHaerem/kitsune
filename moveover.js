// Moving a browser from Sidebery to Tidier alone (PLAN.md, part D). Never by an
// update, only by your click on the settings page, and in this order:
//
//   1. A report of what will happen, and a copy of everything (copies.js).
//   2. You disable Sidebery yourself: an extension cannot, and with Sidebery still
//      running, closing a folded folder's page would close the tabs in it.
//   3. moveOver: Sidebery's folder pages become Tidier's folders in the record, which
//      is written before anything else happens, and Tidier starts again alone. Only
//      then are the folder pages closed (closeOldFolderPages). A crash at any point
//      leaves either the old record, or the new one and pages that close at the next start.
//   4. Sidebery stays installed for a few weeks. moveBack undoes it all.

async function moveReport() {
  const all = await getSynced();
  const entries = Object.entries(all);
  return {
    alone: tidierAlone,
    canMoveBack: entries.some(([, e]) => e.oldUrl),
    essentials: (await getList()).length,
    tabs: entries.filter(([, e]) => !e.group).length,
    folders: entries.filter(([, e]) => e.group).map(([key, e]) => ({
      name: e.own ? e.name : groupName(e.url), space: e.cookieStoreId, tabs: entries.filter(([k]) => folderKeyOf(all, k) === key).length,
    })),
    rules: (await rulesList.get()).length,
  };
}

async function moveOver() {
  if (tidierAlone) return;
  const copy = await makeCopy();
  if (!copy?.saved) await browser.storage.local.set({ copyBeforeMove: await theCopy() }); // no helper here: at least inside Firefox's storage
  const all = await getSynced();
  const closed = new Set(listIn((await browser.storage.local.get("importedFolds")).importedFolds)); // importSidebery
  let rank = 0;
  for (const e of Object.values(all)) {
    if (!e.group || e.own) continue;
    Object.assign(e, { own: true, name: groupName(e.url), oldUrl: e.url, rank: ++rank });
    if (closed.has(foldKey(e.cookieStoreId, e.url))) e.collapsed = true;
  }
  saveSynced(all);
  await flushWrites();
  await browser.storage.local.set({ tidierAlone: true, importedFolds: [] });
  browser.runtime.reload();
}

// Tidier alone: the pages of folders that are now Tidier's own, and any Sidebery folder
// page left, are closed once, with nothing else happening to their tabs.
async function closeOldFolderPages() {
  await readAlone();
  if (!tidierAlone) return;
  await loadRoles();
  const pages = (await browser.tabs.query({})).filter(t => isSideberyGroup(t.url));
  if (!pages.length) return;
  pages.forEach(t => { syncBusy.add(t.id); forget(t.id); });
  await browser.tabs.remove(pages.map(t => t.id)).catch(noteError);
}

// Back to Sidebery: you enable it first, since its folder pages are its own. Each
// window gets its folder pages back, and Tidier starts again without the setting.
async function moveBack() {
  if (!tidierAlone) return;
  const all = await getSynced();
  const wins = await normalWindows();
  for (const [key, e] of Object.entries(all)) {
    if (!isOwnFolder(e)) continue;
    if (!e.oldUrl) { // made since the move: Sidebery has no page for it, so its tabs become ordinary tabs
      for (const x of Object.values(all)) if (x.parentKey === key) x.parentKey = null;
      delete all[key];
      continue;
    }
    Object.assign(e, { url: e.oldUrl });
    delete e.own; delete e.name; delete e.oldUrl; delete e.rank; delete e.collapsed;
    for (const w of wins) await createRep(w.id, key, e).catch(noteError);
  }
  noteSaved(all);
  saveSynced(all);
  await flushWrites();
  await browser.tabs.show((await browser.tabs.query({ hidden: true })).map(t => t.id)).catch(() => {});
  await resetSpaceKeys(); // Sidebery's again
  await browser.storage.local.set({ tidierAlone: false });
  browser.runtime.reload();
}

// --- Sidebery's export -----------------------------------------------------------
// Its rules, order of spaces and closed folders are stored where only Sidebery can read
// them, so its export is the only place they can be read from. It may come from another
// machine, so its containers are matched by name here too, as with a copy (copies.js).
const isSideberyExport = x => !!x && typeof x === "object" && !x.tidier && !!(x.ver || x.sidebar?.panels || x.containers);
const SIDEBERY_EXCLUDE_RULE = 2; // reopenRules' type: "reopen in no container", the opposite of a rule here
const panelContainer = p => p?.newTabCtx && p.newTabCtx !== "none" && p.newTabCtx !== NO_CONTAINER ? p.newTabCtx : null;

// A snapshot keeps only what changed: a tab that did not is -1, to be looked up at the
// same place (window, panel, tab) in the snapshots before it. null if it cannot be.
function snapshotTabs(snapshots, n) {
  const windows = snapshots[n]?.tabs, tabs = [];
  if (!Array.isArray(windows)) return null;
  for (const [w, panels] of windows.entries()) for (const [p, panel] of listIn(panels).entries()) for (const [t, tab] of listIn(panel).entries()) {
    let found = tab;
    for (let older = n - 1; found === -1 && older >= 0; older--) found = snapshots[older]?.tabs?.[w]?.[p]?.[t] ?? -1;
    if (!found || found === -1) return null;
    tabs.push(found);
  }
  return tabs;
}

// An address without what differs per install or per load: Sidebery's own extension
// address, and the channel suffix it adds to a page it has open (groupBaseUrl). The
// same name in two spaces gives one address, so the space is part of the key.
const foldKey = (space, url) => `${space}|${(url || "").split("/sidebery/")[1]?.replace(/~!.*!~$/, "")}`;

// Which folders the newest readable snapshot has closed, as foldKeys; null if the export
// has no snapshot. Each window has its own page of a folder and may show it otherwise.
// A folder here is the same in every window and a closed one rests, so it comes over
// closed only if it was closed in all of them. `here` gives a container's id on this machine.
function closedFolders(backup, here) {
  const snapshots = listIn(backup?.snapshots);
  let tabs = null;
  for (let n = snapshots.length - 1; n >= 0 && !tabs; n--) tabs = snapshotTabs(snapshots, n);
  if (!tabs) return null;
  const pages = new Map();
  for (const t of tabs) {
    const space = here(t.containerId ?? NO_CONTAINER);
    if (!isSideberyGroup(t.url) || !space) continue;
    const key = foldKey(space, t.url);
    pages.set(key, (pages.get(key) ?? true) && !!t.folded);
  }
  return [...pages].filter(([, closed]) => closed).map(([key]) => key);
}

// Null for a file that is not Sidebery's export. Folds are applied at once if this
// browser has moved over, else kept in storage until moveOver applies them: until then
// the folders are Sidebery's, and Tidier's mark on them would mean nothing.
async function importSidebery(backup) {
  if (!isSideberyExport(backup)) return null;
  const containers = Object.values(backup.containers || {});
  const panels = backup.sidebar?.panels || {};
  const local = await containerSpaces();
  const named = containers.filter(c => c?.name).map(c => ({ id: c.id, name: c.name, color: c.color, icon: c.icon }));
  const map = mapSpaces({ spaces: named }, local);
  // (With no names, as with a copy that has none, an id counts as it is if it exists here.)
  const here = id => id === NO_CONTAINER ? id : map ? map[id] : local.some(s => s.id === id) ? id : undefined;

  const found = [];
  for (const c of containers) {
    if (!c?.reopenRulesActive) continue;
    for (const r of listIn(c.reopenRules)) if (r.active && r.url && r.type !== SIDEBERY_EXCLUDE_RULE) found.push({ url: r.url, space: c.id });
  }
  // A panel's rules move a tab to it. Here the panel is its container's space, so a rule
  // with an address opens it there; one with only a container needs nothing, since the
  // container already decides the space. A panel with no container is no space here.
  let panelsLeftOut = 0;
  for (const p of Object.values(panels)) {
    const urls = listIn(p?.moveRules).filter(r => r.active && r.url).map(r => r.url);
    if (!urls.length) continue;
    const space = panelContainer(p);
    if (space && here(space) !== undefined) found.push(...urls.map(url => ({ url, space })));
    else panelsLeftOut++;
  }
  const order = listIn(backup.sidebar?.nav).map(id => panelContainer(panels[id])).filter(id => id && here(id) !== undefined);
  const needed = new Set([...found.map(r => r.space), ...order]);
  const newSpaces = map ? await makeMissingSpaces(named, map, id => needed.has(id)) : [];

  const have = await rulesList.get();
  const added = [];
  for (const { url, space } of found) {
    const rule = { url, space: here(space) };
    if (rule.space && ![...have, ...added].some(x => x.url === url && x.space === rule.space)) added.push(rule);
  }
  if (added.length) rulesList.set([...have, ...added]);
  const localOrder = order.map(here).filter(Boolean);
  if (localOrder.length) await browser.storage.local.set({ spaceOrder: localOrder });

  const closed = closedFolders(backup, here);
  let folds = null;
  if (closed) {
    const all = await getSynced(), keys = new Set(closed);
    const matched = Object.keys(all).filter(k => all[k].group && keys.has(foldKey(all[k].cookieStoreId, all[k].oldUrl ?? all[k].url)));
    if (tidierAlone) for (const k of matched) await foldFolder(k, true); // ownfolders.js
    else await browser.storage.local.set({ importedFolds: closed });
    folds = matched.length;
  }
  return { rules: added.length, order: localOrder.length, panelsLeftOut, newSpaces, folds };
}

// --- The settings page -------------------------------------------------------------
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg?.type?.startsWith("settings:") || sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return serial(() => settingsAction(msg));
});

async function settingsAction(msg) {
  switch (msg.type.slice("settings:".length)) {
    case "get": {
      const stored = await browser.storage.local.get(["archiveAfterHours", "lastCopy"]);
      return {
        report: await moveReport(), rules: await rulesList.get(), spaces: await containerSpaces(), archiveHours: stored.archiveAfterHours ?? ARCHIVE_DEFAULT_HOURS,
        lastCopy: stored.lastCopy ?? null, version: browser.runtime.getManifest().version, hiding: !!browser.tabs.hide, notices: [...notices.values()],
      };
    }
    case "archiveHours": await browser.storage.local.set({ archiveAfterHours: Number(msg.hours) }); return true;
    case "rules": rulesList.set(msg.rules.filter(r => r.url && r.space).map(r => ({ url: r.url, space: r.space }))); viewAllSoon(); return true;
    case "space": await browser.contextualIdentities.update(msg.id, msg.changes).catch(noteError); return true;
    case "moveOver": await moveOver(); return true;
    case "moveBack": await moveBack(); return true;
    case "importSidebery": return importSidebery(msg.backup);
    case "copyNow": return makeCopy();
    case "copyFile": return theCopy();
    case "copySummary": return copySummary(msg.copy);
    case "merge": return mergeCopy(msg.copy, msg.spaces);
  }
}
