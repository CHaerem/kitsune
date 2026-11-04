// Keyboard shortcuts from Arc and Zen that Firefox does not have. Change the
// keys in about:addons → ⚙ → Manage Extension Shortcuts.
//
// ⌘⇧C (copy-url): copy the address of the current tab. Firefox gives ⌘⇧C to
// the developer tools' element picker, which wins over extensions; the
// dotfiles free it (customKeys.json).

async function copyUrl() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab && isWeb(tab.url)) await navigator.clipboard.writeText(tab.url);
}

browser.commands.onCommand.addListener(name => {
  if (name === "copy-url") copyUrl().catch(e => console.error("copy-url:", e));
});
