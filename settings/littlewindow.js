// The on-off for small windows (littlewindow.js). Only with Tidier alone: without it,
// Sidebery decides where a link from another app goes.
(async () => {
  const box = document.getElementById("little-section"), on = document.getElementById("little-window");
  const set = state => { box.hidden = !state.alone; on.checked = state.on; };
  set(await browser.runtime.sendMessage({ type: "little:get" }));
  on.onchange = async () => set(await browser.runtime.sendMessage({ type: "little:set", on: on.checked }));
})();
