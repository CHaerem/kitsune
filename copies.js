// A copy of Tidier's own data: essentials, folders and saved tabs exist nowhere else.
// Once a day, as a dated file through the native host (native/github-prs.py), which
// keeps the last two weeks on this machine; the extension itself cannot write files.
// It holds your addresses, so it stays out of every repository.
//
// A copy is taken back in by merging: nothing here is ever deleted by it, so it can
// also bring one machine's spaces to another (settings page).
//
// Firefox numbers containers per profile, so "firefox-container-2" can be your work
// logins on one machine and your private ones on the next. A copy therefore also says
// what each of its ids is called, and everything is taken in by name (mapSpaces).

const COPY_KEYS = ["essentials", "syncedTabs", "liveFolders", "archiveAfterHours", "rules", "spaceOrder"];
const COPY_EVERY_MS = 24 * 3600e3, COPY_CHECK_MINUTES = 6 * 60;

async function theCopy() {
  await flushWrites();
  const containers = await browser.contextualIdentities.query({}).catch(() => []);
  return {
    tidier: browser.runtime.getManifest().version, when: Date.now(),
    spaces: containers.map(c => ({ id: c.cookieStoreId, name: c.name, colorCode: c.colorCode, color: c.color, icon: c.icon })),
    data: await browser.storage.local.get(COPY_KEYS),
  };
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

// --- Taking a copy in ---------------------------------------------------------------
// A copy is a file: it may be damaged, edited by hand, or not what it says. So nothing in
// it is taken to have the form a copy has. What cannot be used stays out, rather than
// being refused by Firefox at every start, and an id is only ever looked up, never used
// as a way into an object ("constructor" is as good an id as any in a file).
const isTidierCopy = x => typeof x?.tidier === "string" && !!x.data && typeof x.data === "object" && !Array.isArray(x.data);
const listIn = x => Array.isArray(x) ? x : [];
const isText = x => typeof x === "string" && x !== "";
const isColour = x => /^#[0-9a-f]{3,8}$/i.test(x); // the settings page puts it in a style
const namedSpaces = spaces => listIn(spaces).filter(s => isText(s?.id) && isText(s.name));

// A copy's space ids to this machine's, by name: { old id: local id, or null if no
// space here has that name }. Each local space is used once, so two spaces with one
// name stay two, and their logins apart. A copy with no spaces (one made before
// copies said what their ids are called) gives null: its ids are taken as they are.
function mapSpaces(copy, local) {
  if (!Array.isArray(copy?.spaces) || !copy.spaces.length) return null;
  const free = [...local], map = Object.create(null);
  for (const s of namedSpaces(copy.spaces)) {
    const at = free.findIndex(l => l.name === s.name);
    map[s.id] = at < 0 ? null : free.splice(at, 1)[0].id;
  }
  return map;
}

// An id in a file, here: a local id, null for a space still to be made, undefined for
// one that stays out. That is one the copy has no name for (its container was removed
// where the copy was made), since taking its id as it is could put it among the wrong
// logins; or, in a copy with no names at all, an id that does not exist here.
const localSpace = (map, local, id) => id === NO_CONTAINER ? id : map ? map[id] : local.some(s => s.id === id) ? id : undefined;

// Spaces of the copy that are not here yet, made with their name, colour and icon; the
// map then has their ids. Returns their names. A colour or icon this Firefox does not
// know must not stop the rest, and one that cannot be made at all keeps its null, so
// what is in it stays out rather than landing somewhere else.
async function makeMissingSpaces(spaces, map, wanted) {
  const made = [];
  for (const s of spaces) {
    if (map[s.id] !== null || !wanted(s.id)) continue;
    const create = props => browser.contextualIdentities.create({ name: s.name, ...props });
    const c = await create({ color: s.color || "blue", icon: s.icon || "circle" }).catch(() => create({ color: "blue", icon: "circle" })).catch(noteError);
    if (c) { map[s.id] = c.cookieStoreId; made.push(s.name); }
  }
  return made;
}

// A folder's name in a file; null if it has none to make a folder of.
function folderNameIn(e) {
  if (e.own) return typeof e.name === "string" ? e.name : null;
  try { return isText(e.url) ? groupName(e.url) : null; } catch (err) { return null; } // a "%" alone is no address
}

// What of a copy is not here yet, each thing still with the copy's own space id. The
// settings page and taking in both ask this, so what is promised is what comes.
// Rules only from a copy that names its spaces: a rule with a wrong id would send
// every tab it matches to the wrong logins, and older copies' rules were never taken.
// Live folders stay out: the search on this machine decides them, and makes its own.
function whatComes(copy, map, { local, list, all, rules }) {
  const here = id => localSpace(map, local, id);
  const known = id => here(id) !== undefined;
  const keys = new Set(list.map(e => e.key));
  const newEssential = e => {
    if (!isText(e?.key) || !isWeb(e.url) || !known(e.cookieStoreId) || keys.has(e.key)) return false;
    if (list.some(x => x.url === e.url && x.cookieStoreId === here(e.cookieStoreId))) return false;
    keys.add(e.key);
    return true;
  };
  const entries = Object.entries(copy.data.syncedTabs || {}).filter(([key, e]) => e && !all[key] && known(e.cookieStoreId) && !e.liveFolder);
  const seen = new Set();
  // (A rule to no container would loop: the tab is opened again in your space, where it is a first page again.)
  const newRule = r => {
    const id = `${r.space}|${r.url}`;
    if (!r.url || r.space === NO_CONTAINER || !known(r.space) || seen.has(id) || rules.some(x => x.url === r.url && x.space === here(r.space))) return false;
    seen.add(id);
    return true;
  };
  return {
    essentials: listIn(copy.data.essentials).filter(newEssential),
    folders: entries.filter(([, e]) => e.group && !e.live && folderNameIn(e) !== null),
    tabs: entries.filter(([, e]) => !e.group && isWeb(e.saved?.url)),
    rules: map ? listIn(copy.data.rules).map(r => ({ url: isText(r?.url) ? r.url.trim() : "", space: r?.space })).filter(newRule) : [],
  };
}

const whatIsHere = async () => ({ local: await containerSpaces(), list: await getList(), all: await getSynced(), rules: await rulesList.get() });

// One line per space of the copy, for the settings page, before anything is written:
// what it is called here, what would come, and whether it would be a new space. null
// for a file that is not a copy.
async function copySummary(copy) {
  if (!isTidierCopy(copy)) return null;
  const found = await whatIsHere(), { local } = found;
  const map = mapSpaces(copy, local), named = namedSpaces(copy.spaces);
  const coming = whatComes(copy, map, found);
  const spaces = Object.create(null);
  const line = id => {
    if (spaces[id]) return spaces[id];
    const theirs = named.find(s => s.id === id), ours = local.find(s => s.id === localSpace(map, local, id));
    return spaces[id] = {
      name: ours?.name ?? theirs?.name ?? (id === NO_CONTAINER ? "No container" : id), color: ours?.color ?? (isColour(theirs?.colorCode) ? theirs.colorCode : ""),
      isNew: map?.[id] === null, essentials: 0, folders: 0, savedTabs: 0, rules: 0,
    };
  };
  for (const s of named) line(s.id);
  for (const e of coming.essentials) line(e.cookieStoreId).essentials++;
  for (const [, e] of coming.folders) line(e.cookieStoreId).folders++;
  for (const [, e] of coming.tabs) line(e.cookieStoreId).savedTabs++;
  for (const r of coming.rules) line(r.space).rules++;
  return spaces;
}

// Take in the essentials, folders, saved tabs and rules of the given spaces (all, if
// none is given) that are not here yet, making the spaces that are missing. Ordinary
// tabs are not kept: they would have been archived by now anyway. With Tidier alone,
// Sidebery's folder pages become folders.
async function mergeCopy(copy, spaces) {
  if (!isTidierCopy(copy)) return null;
  // Firefox may have restored the settings page before Tidier has read which tab is what:
  // reconcileAll below would take every tab for one it has not seen, and add it again.
  if (!started) throw new Error("Tidier is still starting. Try again in a moment.");
  const wanted = id => !spaces || spaces.includes(id);
  const found = await whatIsHere(), { local, list, all } = found;
  const map = mapSpaces(copy, local);
  const made = map ? await makeMissingSpaces(namedSpaces(copy.spaces), map, wanted) : [];
  const here = id => localSpace(map, local, id);
  const takes = e => wanted(e.cookieStoreId) && here(e.cookieStoreId);
  const coming = whatComes(copy, map, found);

  const newEssentials = coming.essentials.filter(takes).map(e => ({ ...e, cookieStoreId: here(e.cookieStoreId) }));
  if (newEssentials.length) setList([...list, ...newEssentials]);

  const pageBase = tidierAlone ? null : await sideberyGroupBase(); // Sidebery's address differs per machine
  const wins = await normalWindows();
  let folders = 0, tabs = 0;
  for (const [key, theirs] of coming.folders.filter(([, e]) => takes(e))) {
    const e = { ...theirs, cookieStoreId: here(theirs.cookieStoreId) }, name = folderNameIn(theirs);
    if (tidierAlone) {
      // Only moveOver sets oldUrl: it is what going back to Sidebery restores, and Sidebery
      // here has no page for a folder from elsewhere. Its address stays, for folds (foldKey).
      const { oldUrl, ...rest } = e, url = oldUrl ?? e.url;
      all[key] = { ...rest, url: isText(url) ? url : undefined, own: true, name, rank: e.own ? e.rank : folders + 1 };
    } else {
      // A folder needs its page in each window, or reconcileAll would see a folder that was closed.
      const url = pageBase ? `${pageBase}#${encodeURIComponent(name)}` : e.oldUrl ?? e.url;
      if (!isSideberyGroup(url)) continue; // made since a move, and no Sidebery folder here to take the address from
      all[key] = { ...e, url };
      delete all[key].own;
      // (A window closed meanwhile must not stop the rest: it is all in the record by now.)
      for (const w of wins) await createRep(w.id, key, all[key]).catch(noteError);
    }
    folders++;
  }
  for (const [key, e] of coming.tabs.filter(([, e]) => takes(e))) {
    all[key] = { ...e, cookieStoreId: here(e.cookieStoreId), url: e.saved.url, title: e.saved.title ?? e.title, icon: e.saved.icon ?? e.icon };
    tabs++;
  }
  noteSaved(all);
  saveSynced(all);

  const newRules = coming.rules.filter(r => wanted(r.space) && here(r.space)).map(r => ({ url: r.url, space: here(r.space) }));
  if (newRules.length) rulesList.set([...found.rules, ...newRules]);

  // The order of the bar is yours once you have one, so only a machine with none takes it.
  const order = map ? listIn(copy.data.spaceOrder).map(here).filter(Boolean) : [];
  if (order.length && !listIn((await browser.storage.local.get("spaceOrder")).spaceOrder).length) await browser.storage.local.set({ spaceOrder: order });

  await reconcileAll();
  await ensureAllWindows();
  return { essentials: newEssentials.length, folders, tabs, rules: newRules.length, spaces: made.length };
}
