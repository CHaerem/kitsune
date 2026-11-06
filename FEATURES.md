# Features to aim for

What Zen, Arc and Sidebery do that is worth having in Tidier, and where
Tidier stands with each. The goal (README): Firefox and Tidier only, with as
much as possible in Tidier itself.

From: **Z** Zen, **A** Arc, **S** Sidebery.
Status: **Done**; **Partly**; **Planned** (on the way off Sidebery, see the
README); **Later** (wanted, after that); **Decide** (open question); **No**
(not wanted, with the reason).

Today "Done" often means done with Sidebery's help; the notes say so where
it matters for moving off it.

## Sidebar and tab list

| Feature | From | Status | Notes |
|---|---|---|---|
| Vertical tab list in a sidebar | Z A S | Partly | Sidebery today; Tidier's own sidebar shows it, not your default yet |
| Unloaded tabs shown dimmed | Z A S | Done | in Tidier's sidebar |
| Close button, middle click to close | Z A S | Done | in Tidier's sidebar |
| New tab button at the top of the list | A Z | Planned | |
| Drag tabs to reorder, into and out of folders | Z A S | Planned | |
| Select several tabs (⇧/⌘ click) and act on them | Z A S | Later | |
| Context menu on tabs, folders and spaces | Z A S | Planned | |
| Keyboard navigation in the sidebar | S | Later | |
| Search/filter the tabs | S A | Later | see the command bar |
| Sound indicator and mute on a tab | Z A S | Planned | |
| Tab preview on hover | S | Decide | |
| Resizable sidebar width | Z A S | Done | Firefox's own sidebar handle (userChrome.css) |
| Compact mode: sidebar hidden, shown at the edge | Z A | Done | userChrome.css, ⌘S |
| Tabs nested under tabs (tree) | S | No | you only use folders; a tree is where most of Sidebery's bugs came from |

## Spaces

| Feature | From | Status | Notes |
|---|---|---|---|
| Spaces, one per container (own logins) | Z A S | Partly | Sidebery's panels today; Tidier's own in progress |
| Space bar at the bottom with icons | Z A S | Partly | Tidier's sidebar shows coloured dots; icons and names to come |
| Only the active space's tabs shown (⌃Tab too) | Z A S | Planned | Firefox's tabs.hide |
| Switch with ⌃1/2/3 | Z A S | Partly | Sidebery's shortcuts today; to be Tidier's own |
| Switch by swiping sideways on the trackpad | Z A | Decide | tried with Sidebery and left out: vertical swipes switched space by mistake |
| Colour per space, for the whole window | Z A | Done | userChrome.css and tidier.css |
| Name, icon and colour of a space editable in Tidier | Z A | Later | today: Firefox's container settings |
| New tabs and links from other apps open in the active space | A S | Planned | Sidebery today |
| Rules: an address always opens in a given space ("Air Traffic Control") | A S | Planned | Sidebery's container rules today |
| Open a link in another space (context menu) | A | Later | |

## Essentials and kept tabs

| Feature | From | Status | Notes |
|---|---|---|---|
| Essentials as tiles at the top, per space | Z A | Partly | per space in Tidier's sidebar; Sidebery shows them by space today |
| Essentials in every window | Z | Done | |
| An essential keeps its address; closing it unloads it | Z A | Done | |
| Short names for essentials | | Done | set in storage; editing in Tidier later |
| Only one loaded copy of an essential (no double sounds) | | Done | |
| Kept tabs (Arc's pinned section, Zen's pinned tabs): ⌘W unloads, back to the saved address | Z A | Done | tabs in folders ("saved tabs") |
| A divider between kept tabs and today's tabs | A Z | Done | in Tidier's sidebar |
| Clear today's tabs in one go | A | Later | |

## Folders

| Feature | From | Status | Notes |
|---|---|---|---|
| Folders, collapsible | Z A S | Partly | Sidebery's folder pages today; Tidier's own data planned |
| Folders first in each space | Z A | Done | Tidier keeps the order (folders.js, goes away with Sidebery) |
| Create, rename and delete folders | Z A S | Planned | |
| Folders inside folders | A | Decide | you have none today |
| Live folders (GitHub pull requests) | A | Done | |
| Folder state (open/closed) kept per space and window | Z A S | Planned | |

## Tabs that tidy themselves

| Feature | From | Status | Notes |
|---|---|---|---|
| Every tab in every window, loaded only once | Z | Done | |
| Archive tabs unused for 12 hours | A | Done | |
| Find archived tabs again | A | Later | Firefox's Recently Closed today |
| Unload tabs unused for a while (keep them, free memory) | Z S | Decide | Firefox unloads on low memory already |
| Nothing works when nothing happens (no idle work) | | Done | checked by the smoke test |

## Windows and links

| Feature | From | Status | Notes |
|---|---|---|---|
| A new window gets every essential and tab | Z | Done | |
| Closing a window hands its tabs over | Z | Done | |
| A small window for links from other apps ("Little Arc") | A | Later | |
| Link preview in a floating window ("Glance", "Peek") | Z A | Later | |
| Split view | Z A | Decide | Firefox is getting its own; use that if it is good enough |

## Command bar and shortcuts

| Feature | From | Status | Notes |
|---|---|---|---|
| ⌘⇧C copies the address | Z A | Done | |
| A command bar: search tabs, essentials, history and commands | A Z | Later | |
| All shortcuts set in one place, in Tidier | | Planned | today: Sidebery, about:keyboard and Tidier |

## Look

| Feature | From | Status | Notes |
|---|---|---|---|
| Window and sidebar as one surface, the page as a rounded card | Z A | Done | userChrome.css |
| Toolbar (back, forward, address) at the top of the sidebar | Z A | Done | userChrome.css |
| Light and dark | Z A S | Done | |
| Works at all sidebar widths (220–480 px) | | Done | checked by the smoke test |

## Not wanted

| Feature | From | Why |
|---|---|---|
| Bookmarks and history panels in the sidebar | S | Firefox's own are enough |
| Snapshots of all tabs | S | Tidier keeps its own record; Firefox's session restore does the rest |
| Per-site styles and scripts ("Boosts", "Mods") | A Z | not what Tidier is for |
| Notes, easels, built-in AI | A | not what Tidier is for |
