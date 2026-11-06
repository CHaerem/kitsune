# Features to aim for

What Zen, Arc and Sidebery do that is worth having in Tidier, and where
Tidier stands with each. The goal (README): Firefox and Tidier only, with as
much as possible in Tidier itself.

From: **Z** Zen, **A** Arc, **S** Sidebery.
Status: **Done**; **Partly**; **Planned** (on the way off Sidebery, see the
README); **Later** (wanted, after that); **Decide** (open question); **No**
(not wanted, with the reason).

Today "Done" often means done with Sidebery's help; the notes say so where
it matters for moving off it. "Tidier alone" is Tidier without Sidebery, behind its
setting (README, PLAN.md), which the daily browser does not use yet; "checked" means
there is a test.

## Sidebar and tab list

| Feature | From | Status | Notes |
|---|---|---|---|
| Vertical tab list in a sidebar | Z A S | Done | Tidier alone, checked; Sidebery in the daily browser |
| Unloaded tabs shown dimmed | Z A S | Done | in Tidier's sidebar; seen in the pictures of tools/shoot.py |
| Close button, middle click to close | Z A S | Done | in Tidier's sidebar |
| New tab button at the top of the list | A Z | Done | Tidier alone |
| Drag tabs to reorder, into and out of folders | Z A S | Done | Tidier alone, checked, every window follows; also to the essentials and to a space |
| Select several tabs (⇧/⌘ click) and act on them | Z A S | Planned | move, close, drag, menu; the selection lives in the sidebar only |
| Context menu on tabs, folders and spaces | Z A S | Partly | Tidier alone: Firefox's tab menu with Tidier's items, and folders; not yet spaces |
| Keyboard navigation in the sidebar | S | Done | Tidier alone: ↑↓, Enter, ⌫, ←→ |
| Search/filter the tabs | S A | Planned | in the command bar |
| Sound indicator and mute on a tab | Z A S | Done | Tidier alone |
| Tab preview on hover | S | No | a picture needs access to all websites; the tooltip shows title and address |
| The list shows the selected tab, each space keeps its scroll | S | Planned | also a selected tab in a closed folder |
| A mark when a background page has news | S | Planned | a still dot on the tab, a closed folder and a space |
| A sign that a tab is loading | Z A S | Planned | a soft sign on the icon, after half a second |
| A new tab has one place | A | Planned | the top of today's tabs |
| Resizable sidebar width | Z A S | Done | Firefox's own sidebar handle (userChrome.css) |
| Compact mode: sidebar hidden, shown at the edge | Z A | Done | userChrome.css, ⌘S |
| Tabs nested under tabs (tree) | S | No | you only use folders; a tree is where most of Sidebery's bugs came from |

## Spaces

| Feature | From | Status | Notes |
|---|---|---|---|
| Spaces, one per container (own logins) | Z A S | Done | Tidier alone, checked; Sidebery's panels in the daily browser |
| Space bar at the bottom with icons | Z A S | Partly | Tidier alone shows coloured dots, and the name above the list; icons to come |
| Only the active space's tabs shown (⌃Tab too) | Z A S | Done | Tidier alone, checked. Other spaces' essentials stay in ⌃Tab: Firefox cannot hide a pinned tab |
| Switch with ⌃1/2/3 | Z A S | Done | Tidier alone, checked; Sidebery's shortcuts in the daily browser |
| Switch by swiping sideways on the trackpad | Z A | Later | tried with Sidebery and left out: vertical swipes switched space by mistake; to try again without it |
| Colour per space, for the whole window | Z A | Done | userChrome.css and tidier.css |
| Name, icon and colour of a space editable in Tidier | Z A | Partly | the name, on the settings page; else Firefox's container settings |
| New tabs and links from other apps open in the active space | A S | Done | Tidier alone, checked; Sidebery in the daily browser |
| Rules: an address always opens in a given space ("Air Traffic Control") | A S | Done | Tidier alone, checked, on the settings page, and imported from Sidebery's export; Sidebery's rules in the daily browser |
| Open a link in another space (context menu) | A | Planned | |
| Unload a whole space | S | Planned | the space's menu; essentials, the selected tab and sound stay |
| The same essentials, folders and spaces on every machine, by sync | A | Planned | after Tidier has its own spaces and folders |
| Hide a space on a given machine | | Planned | a workplace's space only on its Mac; hidden, not kept away |

## Essentials and kept tabs

| Feature | From | Status | Notes |
|---|---|---|---|
| Essentials as tiles at the top, per space | Z A | Done | Tidier alone, checked; Sidebery in the daily browser |
| Essentials in every window | Z | Done | |
| An essential keeps its address; closing it unloads it | Z A | Done | |
| Short names for essentials | | Done | set in storage; editing in Tidier later |
| Only one loaded copy of an essential (no double sounds) | | Done | |
| Kept tabs (Arc's pinned section, Zen's pinned tabs): ⌘W unloads, back to the saved address | Z A | Done | tabs in folders ("saved tabs") |
| A divider between kept tabs and today's tabs | A Z | Done | in Tidier's sidebar |
| Clear today's tabs in one go | A | Planned | with one line to undo it, no question |
| Undo after closing several tabs or deleting a folder | S | Planned | one quiet line |

## Folders

| Feature | From | Status | Notes |
|---|---|---|---|
| Folders, collapsible | Z A S | Done | Tidier alone, Tidier's own data, checked; Sidebery's folder pages in the daily browser |
| Folders first in each space | Z A | Done | Tidier keeps the order (folders.js, goes away with Sidebery) |
| Create, rename and delete folders | Z A S | Done | Tidier alone, checked. Deleting one keeps its tabs |
| Folders inside folders | A | Later | none today, and a tree is what is left out |
| A closed folder rests: hidden from ⌃Tab and unloaded | S | Planned | the selected tab, sound and unsaved input stay |
| New folder with a good name, ready to rename | S | Planned | also from a selection |
| Live folders (GitHub pull requests) | A | Done | |
| Folder state (open/closed) kept per space and window | Z A S | Partly | Tidier alone: kept per folder, the same in every window |

## Tabs that tidy themselves

| Feature | From | Status | Notes |
|---|---|---|---|
| Every tab in every window, loaded only once | Z | Done | |
| Archive tabs unused for 12 hours | A | Done | |
| Find archived tabs again | A | Planned | Tidier's own list per space, also in the command bar |
| Unload tabs unused for a while (keep them, free memory) | Z S | Later | Firefox unloads on low memory; closed folders and whole spaces unload in Tidier |
| Nothing works when nothing happens (no idle work) | | Done | checked by the smoke test |

## Windows and links

| Feature | From | Status | Notes |
|---|---|---|---|
| A new window gets every essential and tab | Z | Done | |
| Closing a window hands its tabs over | Z | Done | |
| A small window for links from other apps ("Little Arc") | A | Planned | |
| Link preview in a floating window ("Glance", "Peek") | Z A | Planned | only with the optional access to all websites |
| Split view | Z A | No | Firefox has its own; Tidier stays out of its way, and it is checked with placeholders |

## Command bar and shortcuts

| Feature | From | Status | Notes |
|---|---|---|---|
| ⌘⇧C copies the address | Z A | Done | |
| A command bar: search tabs, essentials, history and commands | A Z | Planned | one key, a floating window, everything from one field |
| Next and previous tab as shown, the n-th tab of this space, next and previous space | A | Planned | Firefox's own keys count other spaces' tabs |
| All shortcuts set in one place, in Tidier | | Partly | Tidier alone: Firefox's own page for extension shortcuts, plus about:keyboard |

## Look

| Feature | From | Status | Notes |
|---|---|---|---|
| Window and sidebar as one surface, the page as a rounded card | Z A | Done | userChrome.css |
| Toolbar (back, forward, address) at the top of the sidebar | Z A | Done | userChrome.css |
| Light and dark | Z A S | Done | |
| Works at all sidebar widths (220–480 px) | | Done | checked by the smoke test |
| One design for everything Tidier draws: the window's tint as the surface, what is on it lifting towards white, the selected thing the only card, the space's colour used sparingly | A | Done | sidebar/tokens.css, linked from each page; tests/look.test.mjs keeps it whole |
| Long titles fade out instead of ending in dots, and the list dissolves where it ends | A | Done | |
| Pictures of every width, scheme and state, to work on the look with | | Done | tools/shoot.py |

## Not wanted

| Feature | From | Why |
|---|---|---|
| Bookmarks and history panels in the sidebar | S | Firefox's own are enough |
| Snapshots of all tabs | S | Tidier keeps its own record; Firefox's session restore does the rest |
| Per-site styles and scripts ("Boosts", "Mods") | A Z | not what Tidier is for |
| Notes, easels, built-in AI | A | not what Tidier is for |

## Working with Claude and other agents (stretch goal)

Off by default, and nothing reaches a machine that has not turned it on.

| Feature | From | Status | Notes |
|---|---|---|---|
| Copy a page or a list of tabs as clean text for Claude; ask Claude about a page | | Planned | |
| An MCP server, so Claude Code can work in the browser | | Planned | local only: a socket only you can reach, and nothing runs while it is off |
| Agents have a space of their own, with its own logins | | Planned | they see and touch only that space, unless you allow another |
| What an agent does is visible, and one click stops it | | Planned | |
