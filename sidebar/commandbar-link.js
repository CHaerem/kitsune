// The selection lives only in the sidebar, and the command bar's commands act on it, so
// the bar asks when it opens (barPickedTabs in commandbar.js). In a block of its own:
// the sidebar's scripts share one scope.
{
  let thisWindow = null;
  browser.windows.getCurrent().then(w => { thisWindow = w.id; });
  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type !== "commandBarSelection" || msg.windowId !== thisWindow) return;
    // The selection also when the tab you are on is not in it: you can be on an essential and
    // select rows, or take your tab out with a second ⌘-click. selectedTabs(id) only gives the
    // selection for a tab in it, so it is asked for one that is.
    const inIt = document.querySelector(".picked[data-tab]");
    return Promise.resolve(window.selectedTabs(inIt ? Number(inIt.dataset.tab) : msg.tabId));
  });
}
