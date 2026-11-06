// Shared helpers for essentials.js and tabsync.js.

// All changes run one after another, so two events never race each other
// into duplicate tabs. Both features share this one queue.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(err => console.error("Kitsune:", err));
  return run;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isWeb = url => /^https?:/i.test(url || "");
// Same host, ignoring a leading "www.".
const sameSite = (a, b) => {
  try { const h = u => new URL(u).hostname.replace(/^www\./, ""); return h(a) === h(b); } catch (e) { return false; }
};
// Sidebery folders are "group" pages served by Sidebery itself.
const isSideberyGroup = url => /^moz-extension:\/\/[^/]+\/sidebery\/group\.html/.test(url || "");

// Placeholder page for ghosts and essential copies (see ghost.js).
const ghostUrl = (kind, key) => browser.runtime.getURL(`ghost.html?kind=${kind}&key=${encodeURIComponent(key)}`);
const isGhostUrl = url => (url || "").startsWith(browser.runtime.getURL("ghost.html"));

async function normalWindows() {
  return (await browser.windows.getAll({ windowTypes: ["normal"] })).filter(w => !w.incognito);
}

// Timing for filling a new window, measured with Sidebery 5.6 on Firefox 159:
// - the window is filled shortly after it opens (tabs appear within ~0.7 s);
// - tabs can be created back to back;
// - Sidebery needs ~1.5 s to finish placing them before the window is given
//   the reference window's tab order (see sortLikeReference). Sorting sooner
//   puts tabs in the wrong panel.
// - Essentials added to an existing window are created unpinned and pinned
//   PIN_SETTLE_MS later (see createEssentials): Sidebery puts a new tab in its
//   container's panel, and a pinned tab keeps its panel; pinned too soon,
//   Sidebery gives it the active panel instead. Seen on a slower machine
//   (GitHub's), not on a fast Mac.
const NEW_WINDOW_DELAY_MS = 200;
const CREATE_GAP_MS = 0;
const SORT_SETTLE_MS = 1500;
const PIN_SETTLE_MS = 800;
// In a new window, essentials are created only after Sidebery's sidebar there
// has started (see fillWindow): it waits at most SIDEBAR_WAIT_MS for that
// (see sidebarStarted). Each copy then loads its placeholder once more and
// gets RULE_SETTLE_MS for Sidebery to move it to its own space before it is
// pinned (see pinEssentialCopies).
const SIDEBAR_WAIT_MS = 4000;
const RULE_SETTLE_MS = 600;

// The focused window, tracked here so tab events need no round trip to ask.
// Registered before the other scripts' listeners, so it is current when they run.
let focusedWindowId = browser.windows.WINDOW_ID_NONE;
browser.windows.getLastFocused().then(w => { if (w.focused) focusedWindowId = w.id; }).catch(() => {});
browser.windows.onFocusChanged.addListener(id => { focusedWindowId = id; });

// A value saved to storage.local a moment after the last change, so bursts of
// changes become one write. Reads come from memory.
function storedValue(storageKey, empty) {
  let value = null, timer = null;
  return {
    async get() {
      if (value === null) value = (await browser.storage.local.get(storageKey))[storageKey] ?? empty();
      return value;
    },
    set(next) {
      value = next;
      clearTimeout(timer);
      timer = setTimeout(() => browser.storage.local.set({ [storageKey]: value }), 300);
    },
  };
}
