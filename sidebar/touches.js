// Small touches nobody has to know about: a sign that a tab is taking its time, and a
// tab made ready while the pointer is on it. In a block, so these names stay out of the
// scope the sidebar's scripts share.
{
  // --- A tab that is loading ----------------------------------------------------------
  // Only after half a second, so a fast load shows nothing at all. The class goes on the
  // icon from here and not in row() or tile(): those draw the whole row again when their
  // state changes, which would replace the icon as a load starts and ends. (A title that
  // arrives during the load still does, so a new icon gets the class back below.)
  const SLOW_LOAD_MS = 500, BRIGHTEN_MS = 300;
  const loadTimers = new Map(); // tabId -> timer, while it may still turn out fast
  const slowSince = new Map(); // tabId -> when its icon started breathing

  const iconOf = id => (kept.get("tab:" + id) ?? kept.get("tile:" + id))?.querySelector("img, .letter");

  const markSlow = id => {
    const icon = iconOf(id);
    if (!icon || icon.classList.contains("slow-load")) return;
    icon.classList.add("slow-load");
    // A new icon goes on from where the old one was, instead of jumping back to bright.
    for (const animation of icon.getAnimations()) animation.startTime = slowSince.get(id);
  };

  // Back to bright, softly. Not with a CSS transition on the icon: when an animation ends,
  // Firefox runs that from bright down to the last breathing value, and then jumps (seen in 158).
  const unmarkSlow = id => {
    const icon = iconOf(id);
    if (!icon?.classList.contains("slow-load")) return; // out of sight, or drawn anew at this moment
    const from = getComputedStyle(icon).opacity;
    icon.classList.remove("slow-load");
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) icon.animate({ opacity: [from, 1] }, BRIGHTEN_MS);
  };

  // Runs after render(), which listens first, so the icons here are the ones just drawn.
  port.onMessage.addListener(({ loading: list }) => {
    const loading = new Set(list);
    for (const [id, timer] of loadTimers) {
      if (!loading.has(id)) { clearTimeout(timer); loadTimers.delete(id); }
    }
    for (const id of slowSince.keys()) {
      if (!loading.has(id)) { slowSince.delete(id); unmarkSlow(id); }
    }
    for (const id of loading) {
      if (slowSince.has(id)) markSlow(id);
      else if (!loadTimers.has(id)) {
        loadTimers.set(id, setTimeout(() => {
          loadTimers.delete(id);
          slowSince.set(id, document.timeline.currentTime);
          markSlow(id);
        }, SLOW_LOAD_MS));
      }
    }
  });

  // --- Warming up a tab ---------------------------------------------------------------
  // Firefox gets a tab ready to show when the pointer is on it in its own tab bar, which
  // is hidden here, so the sidebar asks for the same. Only a tab loaded in this window can
  // be: a placeholder's page is elsewhere, or nowhere. Once for each time the pointer comes
  // to a tab, however many parts of the row it crosses.
  let underPointer = null;
  addEventListener("mouseover", e => {
    const tab = e.target.closest?.("[data-tab]") ?? null;
    if (tab === underPointer) return;
    underPointer = tab;
    if (tab && view?.alone && !tab.matches(".active, .unloaded")) send({ type: "warmup", tabId: Number(tab.dataset.tab) });
  }, true);
  addEventListener("mouseout", e => { if (!e.relatedTarget) underPointer = null; }, true);
}
