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
  let rank = 0;
  for (const e of Object.values(all)) {
    if (!e.group || e.own) continue;
    Object.assign(e, { own: true, name: groupName(e.url), oldUrl: e.url, rank: ++rank });
  }
  saveSynced(all);
  await flushWrites();
  await browser.storage.local.set({ tidierAlone: true });
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
  await browser.storage.local.set({ tidierAlone: false, placeholdersNeedPages: true });
  browser.runtime.reload();
}

// Placeholders made with Tidier alone have no page (placeholderWithoutPage), but Sidebery
// draws the tab itself. Once, after moving back and with Tidier started again, those
// without an icon load their page, which sets title and icon and unloads itself.
async function pagesAfterMovingBack() {
  if (tidierAlone || !(await browser.storage.local.get("placeholdersNeedPages")).placeholdersNeedPages) return;
  for (const t of await browser.tabs.query({ discarded: true })) {
    if (isGhostUrl(t.url) && !t.favIconUrl) await browser.tabs.update(t.id, { url: t.url }).catch(() => {});
  }
  await browser.storage.local.remove("placeholdersNeedPages");
}

// The rules and order of spaces from Sidebery's export: the only place they can be read.
async function importSidebery(backup) {
  const rules = [];
  for (const c of Object.values(backup?.containers || {})) {
    if (!c.reopenRulesActive) continue;
    for (const r of c.reopenRules || []) if (r.active && r.url) rules.push({ url: r.url, space: c.id });
  }
  const have = await rulesList.get();
  const added = rules.filter(r => !have.some(x => x.url === r.url && x.space === r.space));
  rulesList.set([...have, ...added]);
  const panels = backup?.sidebar?.panels || {};
  const order = (backup?.sidebar?.nav || []).map(id => panels[id]?.newTabCtx).filter(c => c && c !== "none");
  if (order.length) await browser.storage.local.set({ spaceOrder: order });
  return { rules: added.length, order: order.length };
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
