// ⌥-click on a link: read it in a small window (littlewindow.js). Only in pages while
// Tidier has the access to all websites, which is optional. Firefox itself does nothing
// with ⌥-click, unless browser.altClickSave is set, and then this comes first.
//
// A page can send itself clicks, so only one that really is yours counts: otherwise
// a page could open windows as it likes.
addEventListener("click", e => {
  if (!e.isTrusted || !e.altKey || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const link = e.target.closest?.("a[href]");
  if (!link || !/^https?:/.test(link.href)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  browser.runtime.sendMessage({ type: "little:peek", url: link.href });
}, true);
