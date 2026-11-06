// A folder made with the key (newFolderHere in keys-commands.js) starts with its name
// ready to type, as one made with the ＋ does, when the keyboard is in the sidebar. With
// the keyboard on the page it cannot: Firefox lets no frame take it from another
// (window.focus() and a field's focus() do nothing across them), and a name field nobody
// can type in would only sit there. The folder is then simply there, to rename with a
// double click. This listener runs after render, so the folder is drawn by now.
port.onMessage.addListener(next => { if (next.renameFolder && document.hasFocus()) rename(next.renameFolder); });
