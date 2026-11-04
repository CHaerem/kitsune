// Placeholder page for ghosts and essential copies.
//
// Firefox cannot give an unloaded tab a title or icon, so a placeholder is
// briefly loaded as this tiny local page, which sets the real page's title
// and icon, and is then unloaded again (an unloaded tab keeps both).
//
// When the placeholder is shown:
// - essential copy, or a live tab that has never been loaded ("lazy", e.g. a
//   live folder's pull request): it goes straight to the real page;
// - ghost: the background script pulls the live tab into this window; only
//   if there is no live tab anywhere does the ghost load the page itself.

const params = new URLSearchParams(location.search);
const kind = params.get("kind"); // "ghost" | "essential" | "lazy"
const key = params.get("key");

function shown(info) {
  if (kind === "essential" || kind === "lazy") { location.replace(info.url); return; }
  browser.runtime.sendMessage({ type: "ghostShown" }).then(r => { if (r?.load) location.replace(info.url); });
}

browser.runtime.sendMessage({ type: "ghostInfo", kind, key }).then(info => {
  if (!info) return;
  document.title = info.title || info.url;
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.href = info.icon || new URL("/favicon.ico", info.url).href;
  document.head.append(icon);
  if (document.visibilityState === "visible") { shown(info); return; }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") shown(info); });
  // Give Firefox a moment to pick up the icon, then ask to be unloaded.
  setTimeout(() => browser.runtime.sendMessage({ type: "ghostReady" }), 400);
});
