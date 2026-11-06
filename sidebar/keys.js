// --- Keys ---------------------------------------------------------------------------
// ↑ and ↓ move through what the sidebar shows, Enter selects it (or folds a folder),
// ⌫ closes a tab, ← and → fold and unfold a folder. Only while the sidebar has the focus.
let cursor = null;
const reachable = () => [...document.querySelectorAll(".tile, #tabs .head, #tabs .tab")].filter(e => e.offsetParent !== null);
function moveCursor(to) {
  cursor?.classList.remove("cursor");
  cursor = to || null;
  cursor?.classList.add("cursor");
  cursor?.scrollIntoView({ block: "nearest" });
}
addEventListener("keydown", e => {
  if (e.target.closest?.("input, #menu") || e.metaKey || e.ctrlKey || e.altKey) return;
  const all = reachable(), at = all.indexOf(cursor);
  const tab = cursor?.dataset.tab && Number(cursor.dataset.tab);
  const fold = closed => { if (cursor?.dataset.folderHead && cursor.parentElement.classList.contains("collapsed") !== closed) cursor.click(); };
  switch (e.key) {
    case "ArrowDown": moveCursor(all[Math.min(at + 1, all.length - 1)]); break;
    case "ArrowUp": moveCursor(all[Math.max(at - 1, 0)]); break;
    case "ArrowLeft": fold(true); break;
    case "ArrowRight": fold(false); break;
    case "Enter": cursor?.click(); break;
    case "Backspace": case "Delete":
      if (!tab) return;
      moveCursor(all[at + 1] || all[at - 1]);
      send({ type: "close", tabId: tab });
      break;
    default: return;
  }
  e.preventDefault();
});
