// Placeholder page for ghosts and essential copies.
//
// Firefox cannot give an unloaded tab a title or icon, so a placeholder is
// briefly loaded as this tiny local page, which sets the real page's title
// and icon, and is then unloaded again (an unloaded tab keeps both).
//
// When the placeholder is shown:
// - a live tab that has never been loaded ("lazy", e.g. a live folder's pull
//   request): it goes straight to the real page;
// - ghost or essential copy: the background script moves the loaded tab into
//   this window; only if there is none does the placeholder load the page itself.

const params = new URLSearchParams(location.search);
const kind = params.get("kind"); // "ghost" | "essential" | "lazy"
const key = params.get("key");

function shown(info) {
  if (kind === "lazy") { location.replace(info.url); return; }
  // An essential opens its page itself only if no other window has it loaded
  // (essentialShown, essentials.js); a ghost only if there is no live tab.
  const type = kind === "essential" ? "essentialShown" : "ghostShown";
  browser.runtime.sendMessage({ type }).then(r => { if (r?.load) location.replace(info.url); });
}

// The first icon that loads: the one saved for the page, else the site's
// /favicon.ico. (Firefox's own icon cache, page-icon:, cannot be loaded from
// an extension's process.)
async function findIcon(info) {
  const candidates = [info.icon, new URL("/favicon.ico", info.url).href];
  for (const src of candidates.filter(Boolean)) {
    const loads = await new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
    if (loads) return src;
  }
  return null;
}

browser.runtime.sendMessage({ type: "ghostInfo", kind, key }).then(async info => {
  if (!info) { browser.runtime.sendMessage({ type: "ghostOrphan", kind, key }); return; }
  document.title = info.title || info.url;
  // Selected and left again without opening its page, it unloads too (a placeholder
  // selected in a window you are not using, say); it would otherwise stay loaded.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") shown(info); else settle(info);
  });
  if (document.visibilityState === "visible") shown(info); else settle(info);
});

async function settle(info) {
  const icon = await findIcon(info);
  if (icon && !document.querySelector("link[rel=icon]")) {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = icon;
    document.head.append(link);
  }
  // Unloaded by the background script once Firefox shows the icon.
  browser.runtime.sendMessage({ type: "ghostReady", icon: !!icon });
}
