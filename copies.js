// A copy of Tidier's own data: essentials, folders and saved tabs exist nowhere else.
// Once a day, as a dated file through the native host (native/github-prs.py), which
// keeps the last two weeks on this machine; the extension itself cannot write files.
// It holds your addresses, so it stays out of every repository.
//
// A copy is taken back in by merging: nothing here is ever deleted by it, so it can
// also bring one machine's spaces to another (settings page).

const COPY_KEYS = ["essentials", "syncedTabs", "liveFolders", "archiveAfterHours", "rules"];
const COPY_EVERY_MS = 24 * 3600e3, COPY_CHECK_MINUTES = 6 * 60;

async function theCopy() {
  await flushWrites();
  return { tidier: browser.runtime.getManifest().version, when: Date.now(), data: await browser.storage.local.get(COPY_KEYS) };
}

async function makeCopy() {
  const res = await browser.runtime.sendNativeMessage(NATIVE_HOST, { backup: await theCopy() }).catch(err => ({ error: String(err) }));
  if (res?.saved) {
    await browser.storage.local.set({ lastCopy: Date.now() });
    setNotice("copy", null);
  } else {
    setNotice("copy", `No copy of your essentials and folders is being kept: ${res?.error || "no answer"} (native/install.sh)`);
  }
  return res;
}

async function copyIfDue() {
  const { lastCopy } = await browser.storage.local.get("lastCopy");
  if (!lastCopy || Date.now() - lastCopy >= COPY_EVERY_MS) await makeCopy();
}
browser.alarms.create("copy", { periodInMinutes: COPY_CHECK_MINUTES });
browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === "copy" && started) copyIfDue(); });
// Soon after a start too, since Firefox may not run for long at a time.
const COPY_AFTER_START_MS = 2 * 60000;
setTimeout(() => { if (started) copyIfDue(); }, COPY_AFTER_START_MS);

// What a copy holds, per space, for choosing what to take in.
function copySummary(copy) {
  const spaces = {};
  const of = id => (spaces[id] ??= { essentials: 0, folders: 0, savedTabs: 0 });
  for (const e of copy?.data?.essentials || []) of(e.cookieStoreId).essentials++;
  for (const e of Object.values(copy?.data?.syncedTabs || {})) {
    if (e.group) of(e.cookieStoreId).folders++;
    else if (e.saved) of(e.cookieStoreId).savedTabs++;
  }
  return spaces;
}

// Take in the essentials, folders and saved tabs of the given spaces (all, if none is
// given) that are not here yet. Ordinary tabs are not kept: they would have been
// archived by now anyway. With Tidier alone, Sidebery's folder pages become folders.
async function mergeCopy(copy, spaces) {
  const wanted = id => !spaces || spaces.includes(id);
  const list = await getList();
  const haveEssential = new Set(list.map(e => e.key));
  const sameEssential = e => list.some(x => x.url === e.url && x.cookieStoreId === e.cookieStoreId);
  const newEssentials = (copy.data.essentials || []).filter(e => wanted(e.cookieStoreId) && !haveEssential.has(e.key) && !sameEssential(e));
  if (newEssentials.length) setList([...list, ...newEssentials]);

  const all = await getSynced();
  const incoming = copy.data.syncedTabs || {};
  const pageBase = tidierAlone ? null : await sideberyGroupBase(); // Sidebery's address differs per machine
  const wins = await normalWindows();
  let folders = 0, tabs = 0;
  for (const [key, e] of Object.entries(incoming)) {
    if (all[key] || !wanted(e.cookieStoreId) || !e.group || e.liveFolder) continue;
    if (tidierAlone) {
      all[key] = e.own ? e : { ...e, own: true, name: groupName(e.url), oldUrl: e.url, rank: folders + 1 };
    } else {
      // A folder needs its page in each window, or reconcileAll would see a folder that was closed.
      const name = e.own ? e.name : groupName(e.url);
      all[key] = { ...e, url: pageBase ? `${pageBase}#${encodeURIComponent(name)}` : e.oldUrl ?? e.url };
      delete all[key].own;
      for (const w of wins) await createRep(w.id, key, all[key]);
    }
    folders++;
  }
  for (const [key, e] of Object.entries(incoming)) {
    if (all[key] || !wanted(e.cookieStoreId) || e.group || e.liveFolder || !e.saved) continue;
    all[key] = { ...e, url: e.saved.url, title: e.saved.title ?? e.title, icon: e.saved.icon ?? e.icon };
    tabs++;
  }
  noteSaved(all);
  saveSynced(all);
  await reconcileAll();
  await ensureAllWindows();
  return { essentials: newEssentials.length, folders, tabs };
}
