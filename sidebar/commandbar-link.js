// The selection lives only in the sidebar, and the command bar's commands act on it, so
// the bar asks when it opens (barPickedTabs in commandbar.js). In a block of its own:
// the sidebar's scripts share one scope.
{
  let thisWindow = null;
  browser.windows.getCurrent().then(w => { thisWindow = w.id; });
  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type !== "commandBarSelection" || msg.windowId !== thisWindow) return;
    return Promise.resolve(window.selectedTabs?.(msg.tabId) ?? [msg.tabId]);
  });
}
