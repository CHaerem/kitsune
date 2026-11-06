// Small windows on the settings page (littlewindow.js). Only with Tidier alone: without
// it, Sidebery decides where a link from another app goes.
(async () => {
  const box = document.getElementById("little-section"), on = document.getElementById("little-window");
  const state = document.getElementById("peek-state"), allow = document.getElementById("peek-allow");
  const set = s => { box.hidden = !s.alone; on.checked = s.on; };
  const allSites = { origins: ["<all_urls>"] };
  const peek = async () => {
    const given = await browser.permissions.contains(allSites);
    state.textContent = given ? "⌥-click a link to read it in a small window." : "⌥-click on a link can open it in a small window too, with access to all websites.";
    allow.hidden = given;
  };
  // Asked here: the permission needs your click.
  allow.onclick = () => browser.permissions.request(allSites).then(peek);
  on.onchange = async () => set(await browser.runtime.sendMessage({ type: "little:set", on: on.checked }));
  browser.permissions.onRemoved.addListener(peek);
  browser.permissions.onAdded.addListener(peek);
  set(await browser.runtime.sendMessage({ type: "little:get" }));
  await peek();
})();
