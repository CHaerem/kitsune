// What the machines share through Firefox Sync, and how two versions of it become
// one. Nothing here touches Firefox (sync.js does), so all of it can be tested
// without one: this is the part that could lose data, and a mistake here would
// spread to every machine.
//
// A shared document says, with no id that belongs to one profile in it:
//
//   spaces      { [sid]: { name, color, icon, at } }
//   essentials  { [key]: { url, title, name, space, at } }
//   folders     { [key]: { name, space, at } }
//   saved       { [key]: { url, title, name, folder, space, at } }
//   rules       { ["r:" + text]: { space, at } }
//   order       { [scope]: { list, at } }   scopes: spaces, rules, e:<sid>, f:<sid>, s:<folder>
//
// `space` is a sid, not a container id: Firefox numbers containers per profile, so
// "firefox-container-2" can be your work logins here and your private ones on the next
// machine, and a wrong one mixes logins. A sid is made once from the name a space first
// had, and stays when the space is renamed; sync.js keeps which container is which sid
// on this machine, matched by name the first time it sees one.
//
// `at` is when the thing last changed. Newest wins per thing, so two machines that
// change different things both keep their change. Something deleted stays as a
// tombstone ({ gone: 1, at }) for 30 days, so that a machine which has not heard of the
// deletion cannot bring it back; a machine away for longer does bring it back, which is
// the safe way to be wrong. Absence never deletes anything: Firefox Sync overwrites a
// whole item when two machines write it (a server's change wins, per MDN), and an item
// can come late or be emptied, so only an explicit tombstone removes a thing.
//
// An order is one value per scope, newest wins: order is what you last arranged.

const SYNC_KINDS = ["spaces", "essentials", "folders", "saved", "rules"];
const SYNC_NO_SPACE = "0"; // tabs in no container: "firefox-default" is the same everywhere, so it needs no space
const SYNC_KEEP_GONE_MS = 30 * 24 * 3600e3;
const SYNC_TITLE_CHARS = 60; // a title is a convenience until the page has been opened here
// Firefox's limits (MDN, storage.sync): 102400 bytes in all and 8192 per item, measured as
// the key's length plus the value as JSON, and 512 items. What is written stays a little
// below them, since a refused write would stop everything rather than only what does not fit.
const SYNC_QUOTA = { total: 102400, item: 8192, items: 512 };
const SYNC_ROOM_TOTAL = 96000, SYNC_ROOM_ITEM = 7900;
const SYNC_PREFIX = "1/"; // this form of the items; another form can be read next to it in a later version

const emptySyncDoc = () => ({ spaces: {}, essentials: {}, folders: {}, saved: {}, rules: {}, order: {} });
const copySyncDoc = doc => {
  const out = emptySyncDoc();
  for (const kind of [...SYNC_KINDS, "order"]) Object.assign(out[kind], doc?.[kind]);
  return out;
};
// An own property only: a rule's text or a key read from storage could be "constructor".
const syncOwn = (map, id) => (map && Object.hasOwn(map, id) ? map[id] : undefined);
const syncStamp = item => (Number.isFinite(item?.at) ? item.at : 0);

// What counts as a change of a thing. A title does not: a page whose title ticks would
// otherwise rewrite the sync data all day, and the title comes back from the page anyway.
const SYNC_SIG_FIELDS = {
  spaces: ["name", "color", "icon"], essentials: ["url", "name", "space"], folders: ["name", "space"],
  saved: ["url", "name", "folder", "space"], rules: ["space"],
};
const syncSig = (kind, item) => JSON.stringify(SYNC_SIG_FIELDS[kind].map(f => item[f] ?? null));

// One order of the fields, so that two machines holding the same thing say so.
const syncCanonical = item => JSON.stringify(Object.keys(item).sort().map(k => [k, item[k]]));

// The newer of two versions of a thing. A tie (the same moment on two machines, or
// a thing both had before they first met) must go the same way on both: a deletion,
// else by what they hold.
function newerVersion(a, b) {
  if (!a || !b) return a || b;
  const x = syncStamp(a), y = syncStamp(b);
  if (x !== y) return x > y ? a : b;
  if (!a.gone !== !b.gone) return a.gone ? a : b;
  return syncCanonical(a) >= syncCanonical(b) ? a : b;
}

function syncTombstone(kind, item, at, to) {
  const t = { gone: 1, at };
  if (kind !== "rules" && item?.space !== undefined) t.space = item.space;
  if (kind === "folders") t.name = item?.name; // so that it can come back, see folderKeepsNewTabs
  if (to) t.to = to; // became that one: its tabs are taken over rather than closed
  return t;
}

// The same thing added on both machines before they met: the same site as an essential,
// a folder of that name. It stays one, the smallest key, so that both choose the same. Only
// between the machines: two on one machine you made yourself ("New folder" twice).
function sameOnBoth(doc, local, remote, kind, identity) {
  const groups = new Map();
  for (const [id, item] of Object.entries(doc[kind])) {
    if (item.gone) continue;
    const here = syncOwn(local[kind], id) !== undefined, there = syncOwn(remote[kind], id) !== undefined;
    if (here === there) continue;
    const name = identity(item);
    if (!groups.has(name)) groups.set(name, { here: [], there: [] });
    groups.get(name)[here ? "here" : "there"].push(id);
  }
  for (const { here, there } of groups.values()) {
    if (!here.length || !there.length) continue;
    const [keep, ...others] = [...here, ...there].sort();
    for (const other of others) {
      const a = doc[kind][keep], b = doc[kind][other];
      const at = Math.max(syncStamp(a), syncStamp(b));
      doc[kind][keep] = { ...a, at, ...(a.name === undefined && b.name !== undefined ? { name: b.name } : {}) };
      doc[kind][other] = syncTombstone(kind, b, at, keep);
    }
  }
}

// A folder that became another (sameOnBoth): its tabs are in that one now.
function followMovedFolders(doc) {
  const home = key => {
    for (let k = key, n = 0; n < 20; n++) {
      const to = syncOwn(doc.folders, k)?.to;
      if (!to) return k;
      k = to;
    }
    return key;
  };
  for (const [id, s] of Object.entries(doc.saved)) {
    if (s.gone) continue;
    const f = home(s.folder);
    if (f !== s.folder) doc.saved[id] = { ...s, folder: f };
  }
}

// A folder deleted while a tab went into it on another machine comes back, with the
// tab: the change wins, as for anything else, and nothing is lost. A tab older than the
// deletion goes with the folder.
function folderKeepsNewTabs(doc) {
  const living = () => Object.entries(doc.saved).filter(([, s]) => !s.gone);
  for (const [, s] of living()) {
    const f = syncOwn(doc.folders, s.folder);
    if (f?.gone && syncStamp(s) > syncStamp(f)) {
      doc.folders[s.folder] = { name: f.name ?? "Folder", space: f.space ?? s.space, at: syncStamp(s) };
    }
  }
  for (const [id, s] of living()) {
    const f = syncOwn(doc.folders, s.folder);
    if (f?.gone) doc.saved[id] = syncTombstone("saved", s, syncStamp(f));
  }
}

// Two versions of everything become one. Whatever order machines meet in, they end
// up with the same (tests/sync.test.mjs, with two machines editing at random).
function mergeSynced(local, remote, now = Date.now()) {
  const doc = emptySyncDoc();
  for (const kind of [...SYNC_KINDS, "order"]) {
    for (const id of new Set([...Object.keys(local?.[kind] || {}), ...Object.keys(remote?.[kind] || {})])) {
      doc[kind][id] = newerVersion(syncOwn(local?.[kind], id), syncOwn(remote?.[kind], id));
    }
  }
  sameOnBoth(doc, local, remote, "folders", f => `${f.space}\n${f.name}`);
  followMovedFolders(doc);
  sameOnBoth(doc, local, remote, "essentials", e => `${e.space}\n${e.url}`);
  sameOnBoth(doc, local, remote, "saved", s => `${s.folder}\n${s.url}`);
  folderKeepsNewTabs(doc);
  for (const kind of SYNC_KINDS) {
    for (const [id, item] of Object.entries(doc[kind])) {
      // (A stamp of 1 comes from a first merge and says nothing about when; it is kept.)
      if (item.gone && syncStamp(item) > 1 && now - syncStamp(item) > SYNC_KEEP_GONE_MS) delete doc[kind][id];
    }
  }
  // A folder's order goes with it.
  for (const scope of Object.keys(doc.order)) {
    if (!scope.startsWith("s:")) continue;
    const f = syncOwn(doc.folders, scope.slice(2));
    if (!f || f.gone) delete doc.order[scope];
  }
  return doc;
}

// The newest moment a document knows of. A change made after seeing it gets a later
// stamp, whatever this machine's clock says, so a clock that is behind cannot make
// your newest change lose to the one you saw before it.
function syncHighest(doc) {
  let high = 0;
  for (const kind of [...SYNC_KINDS, "order"]) {
    for (const item of Object.values(doc?.[kind] || {})) high = Math.max(high, syncStamp(item));
  }
  return high;
}

// A short name for a thing in an order list, which would otherwise take a tenth of
// the room. Two in one list having the same one would at worst swap two places.
function syncShort(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// A new space's sid: from its name, so that two machines turned on at the same time,
// before they have seen each other, give the space of that name the same one.
function syncSpaceId(name, taken = () => false) {
  let sid = "s" + syncShort(name);
  while (taken(sid) || sid === SYNC_NO_SPACE) sid += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return sid;
}

// What changed on this machine since the last round, stamped: `here` is the things
// as they are now (no stamps), `seen` what they were when last looked at (syncSeen), and
// `isHere(sid)` whether this machine has that space. With nothing seen (the first merge),
// everything here is as old as can be: what the other machines have decided wins, and
// anything they do not know of is simply added. That is what makes turning sync on a
// merge and not an overwrite, in both directions.
//
// Something in a space this machine does not have is not "deleted here". Nor is a whole
// kind that is suddenly empty, which is not you deleting them one by one: if it
// was you, what you removed comes back, which is better than losing it on every machine.
const SYNC_SUSPECT_COUNT = 5;
function noteLocalChanges(doc, here, seen, stamp, isHere = () => true) {
  const out = copySyncDoc(doc);
  for (const kind of SYNC_KINDS) {
    for (const [id, item] of Object.entries(here[kind])) {
      const sig = syncSig(kind, item), old = syncOwn(out[kind], id);
      if (!seen) { if (!old) out[kind][id] = { ...item, at: 1 }; continue; }
      if (syncOwn(seen[kind], id) === sig) continue; // not changed here: a difference is what applying has yet to do
      if (old && !old.gone && syncSig(kind, old) === sig) continue; // it already says that
      out[kind][id] = { ...item, at: stamp() };
    }
    if (!seen || kind === "spaces") continue; // a space is never deleted on other machines: their logins are in it
    const before = Object.keys(seen[kind] || {});
    if (before.length >= SYNC_SUSPECT_COUNT && !Object.keys(here[kind]).length) continue;
    for (const id of before) {
      if (syncOwn(here[kind], id) !== undefined) continue;
      const old = syncOwn(out[kind], id);
      if (old && !old.gone && isHere(old.space)) out[kind][id] = syncTombstone(kind, old, stamp());
    }
  }
  for (const [scope, list] of Object.entries(here.order)) {
    const sig = JSON.stringify(list), old = syncOwn(out.order, scope);
    if (!seen) { if (!old) out.order[scope] = { list, at: 1 }; continue; }
    if (syncOwn(seen.order, scope) === sig || (old && JSON.stringify(old.list) === sig)) continue;
    out.order[scope] = { list, at: stamp() };
  }
  return out;
}

// What is here, as remembered for the next round.
function syncSeen(here) {
  const seen = { order: {} };
  for (const kind of SYNC_KINDS) {
    seen[kind] = {};
    for (const [id, item] of Object.entries(here[kind])) seen[kind][id] = syncSig(kind, item);
  }
  for (const [scope, list] of Object.entries(here.order)) seen.order[scope] = JSON.stringify(list);
  return seen;
}

// --- The items in storage.sync ------------------------------------------------------
// One array of rows per item, an item per space (and more if a space does not fit in
// one), since a space with 100 essentials is more than one item may hold. Rows and not
// objects: the names of the fields would take a fifth of the room. Icons are left out:
// they are the biggest part of a thing, and come back from the pages. The items are a pure
// function of the document, so two machines holding the same write the same.
const SYNC_ROWS = {
  spaces: ["s", ["name", "color", "icon"]], essentials: ["e", ["url", "title", "name"]], folders: ["f", ["name"]],
  saved: ["t", ["url", "title", "folder", "name"]], rules: ["r", ["space"]],
};
const SYNC_KIND_OF = Object.fromEntries(Object.entries(SYNC_ROWS).map(([kind, [letter]]) => [letter, kind]));

function trimRow(row) {
  while (row.at(-1) === undefined || row.at(-1) === null) row.pop();
  return row;
}
function syncRow(kind, id, item) {
  const [letter, fields] = SYNC_ROWS[kind];
  if (item.gone) return trimRow([letter.toUpperCase(), id, syncStamp(item), item.to ?? null, kind === "folders" ? item.name : null]);
  return trimRow([letter, id, syncStamp(item), ...fields.map(f => item[f] ?? null)]);
}

function utf8Size(text) {
  let n = 0;
  for (const ch of text) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}

function syncItems(doc) {
  const rows = [];
  // What comes first when not everything fits: what the rest needs, then what you see
  // first. Within a kind the oldest first, so that what already is on the other machines
  // stays, and it is the newest thing that does not fit, which you can see and act on.
  const add = (rank, group, row, left) => rows.push({ rank, group, at: row[2], text: JSON.stringify(row), left });
  const whatLeft = (kind, id, item) => (item.gone ? null : { kind, id, title: item.name ?? item.title ?? item.url ?? id });
  for (const kind of ["spaces", "rules"]) for (const [id, item] of Object.entries(doc[kind])) add(0, "m", syncRow(kind, id, item));
  for (const kind of ["essentials", "folders", "saved"]) {
    const rank = { essentials: 1, folders: 2, saved: 4 }[kind];
    for (const [id, item] of Object.entries(doc[kind])) add(item.gone ? 3 : rank, item.space ?? SYNC_NO_SPACE, syncRow(kind, id, item), whatLeft(kind, id, item));
  }
  for (const [scope, { list, at }] of Object.entries(doc.order)) {
    const group = scope.startsWith("s:") ? syncOwn(doc.folders, scope.slice(2))?.space ?? "m" : /^[ef]:/.test(scope) ? scope.slice(2) : "m";
    add(3, group, ["o", scope, syncStamp({ at }), list]);
  }
  rows.sort((a, b) => a.rank - b.rank || a.at - b.at || (a.text < b.text ? -1 : 1));

  const kept = new Map(), left = [];
  let used = 0;
  for (const r of rows) {
    r.size = utf8Size(r.text) + 1;
    if (r.size > SYNC_ROOM_ITEM || used + r.size > SYNC_ROOM_TOTAL) { if (r.left) left.push(r.left); continue; }
    used += r.size;
    if (!kept.has(r.group)) kept.set(r.group, []);
    kept.get(r.group).push(r);
  }
  const items = {};
  let bytes = 0;
  for (const group of [...kept.keys()].sort()) {
    const groupRows = kept.get(group).sort((a, b) => (a.text < b.text ? -1 : 1));
    let chunk = [], size = 0, n = 0;
    const close = () => {
      const key = `${SYNC_PREFIX}${group}.${n++}`;
      items[key] = chunk.map(r => JSON.parse(r.text));
      bytes += utf8Size(key) + utf8Size(JSON.stringify(items[key]));
      chunk = []; size = 0;
    };
    for (const r of groupRows) {
      if (size + r.size > SYNC_ROOM_ITEM) close();
      chunk.push(r);
      size += r.size;
    }
    if (chunk.length) close();
  }
  return { items, bytes, left };
}

// Back from rows: what cannot be read is left out, and what is left out is not deleted.
function addSyncRow(doc, group, row) {
  if (!Array.isArray(row) || typeof row[1] !== "string" || row[1] === "__proto__" || !Number.isFinite(row[2])) return;
  const [letter, id, at] = row;
  if (letter === "o") {
    if (Array.isArray(row[3])) doc.order[id] = newerVersion(syncOwn(doc.order, id), { list: row[3], at });
    return;
  }
  const kind = SYNC_KIND_OF[String(letter).toLowerCase()];
  if (!kind) return;
  let item;
  if (letter === letter.toUpperCase()) {
    item = { gone: 1, at };
    if (kind !== "rules" && kind !== "spaces") item.space = group;
    if (typeof row[3] === "string") item.to = row[3];
    if (kind === "folders" && typeof row[4] === "string") item.name = row[4];
  } else {
    item = { at };
    SYNC_ROWS[kind][1].forEach((f, i) => { if (row[3 + i] !== undefined && row[3 + i] !== null) item[f] = row[3 + i]; });
    if (kind !== "spaces" && kind !== "rules") item.space = group;
    const web = /^https?:/i.test(item.url || "");
    const whole = { spaces: typeof item.name === "string", rules: typeof item.space === "string", folders: typeof item.name === "string",
      essentials: web, saved: web && typeof item.folder === "string" }[kind];
    if (!whole) return;
  }
  doc[kind][id] = newerVersion(syncOwn(doc[kind], id), item);
}

function docFromItems(items) {
  const doc = emptySyncDoc();
  for (const [key, rows] of Object.entries(items || {})) {
    if (!key.startsWith(SYNC_PREFIX) || !Array.isArray(rows)) continue;
    const group = key.slice(SYNC_PREFIX.length).replace(/\.\d+$/, "");
    for (const row of rows) addSyncRow(doc, group, row);
  }
  return doc;
}
