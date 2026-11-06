# The plan

Everything that has to be done, in order, with what "done" means. The goal and
the background are in the README, and the features to aim for in FEATURES.md.
Tick things off here as they land, so the next person can see where things are.

**In short:** Tidier takes over from Sidebery step by step, while the daily
Firefox keeps working as it does today. A second Mac runs Tidier alone first.
The daily browser moves over when Tidier alone is good enough, and only then is
Sidebery removed and sync added.

Rules for all of it:

- **Every commit on main reaches the daily browser**, so everything for Tidier
  alone sits behind a setting that is off by default. With it off, nothing changes.
- **Every step has a check**, in the test Firefox with Sidebery or without it.
- **Nothing that exists only for Sidebery gets better from here.** It is kept
  working until it can be removed.
- **Nothing can lose tabs without a way back.** Moving the daily browser is
  explicit, can be resumed, and can be undone.

## A. A safe core (needed with or without Sidebery)

- [x] Documents stay out of the signed extension; changing them is no release.
- [x] A green run on main can always release; a run started by hand cannot leave
      a commit behind. The second try of a smoke test is in the job, with a warning.
- [x] A passing fault at addons.mozilla.org does not lose a release; what to do
      with a bad release is written down.
- [x] A start with no windows keeps the tab record; a saved tab's last copy comes back.
- [x] An error during a start does not leave Tidier off; an essential in a removed
      container does not stop it.
- [x] A tab whose real page was in a closed window is not archived without a trace.
- [x] ⌘⇧T on an essential does not double it, and doubles cannot lose another.
- [x] Placeholders do not stay loaded when a new window gets many tabs, and the
      test no longer calls that a Sidebery bug.
- [x] A check of an update over a running session: same tabs, essentials and
      folders before and after.
- [x] Tests see errors inside Tidier, show why Firefox did not start, and the
      restart checks cannot quietly disappear from a green run.
- [x] A second ghost selected within 0.7 s of a pull opens; a tab closed within
      0.6 s of a pull closes everywhere.
- [x] A title or icon change writes the tab record only when something changed.
- [x] A page with unsaved input is not closed by archiving or a live folder.
- [x] Tidier keeps a copy of its own data: essentials, folders and saved tabs, as a
      dated file through the native host, taken in again from Tidier itself.
- [x] A live folder that has stopped (no host, no `gh` login) shows it.
- [x] README's permissions, files and claims match what is there.

## B. Tidier alone (behind the setting)

A first version of all of it works in the test Firefox, without Sidebery.

- [x] **The setting and the test Firefox.** `tidierAlone`, from the extension's storage or
      declared in managed storage for a machine. A test Firefox without Sidebery, run in
      every smoke test. With the setting on, what exists only for Sidebery does not run.
- [x] **The sidebar as the sidebar.** A key and a button for it, back after an update.
      Checks of what it shows and does, and of its idle cost. It draws only what
      changed, so clicks and drags are not lost.
- [x] **Spaces.** Other spaces' tabs hidden, also from ⌃Tab (`tabHide`, optional, so
      updates never wait for a click). Switching with the bar and ⌃1/2/3, also to an
      empty space. New tabs and links from other apps in the active space. Closing the
      last tab of a space stays in the space.
- [x] **Folders as Tidier's data.** Create, rename, delete, fold. A folder has no tab
      of its own, and no tab event can delete it. Saved tabs, archiving and live
      folders work on these folders.
- [x] **Using it.** Drag tabs, into and out of folders, between essentials and tabs and to
      other spaces; the order follows in every window. A new tab button. Firefox's tab
      menu with Tidier's items, and a menu on folders. Sound indicator and mute. Keys.
- [x] **Rules.** An address always opens in a given space, edited in Tidier.
- [x] **Settings in Tidier.** A page for the rules, spaces' names, archiving, copies and
      moving over.
- [ ] **What Sidebery does well**, in Tidier's own simple way: a short menu of Tidier's own on
      every tab, selecting several tabs, one quiet line with undo, Clear, a list that shows where
      you are, one place for new tabs, closed folders that rest, sound and news marks, honest
      dragging, safe moves. Sidebery has hundreds of options; each became one fixed
      behaviour or nothing.
- [ ] **The command bar**, as in Arc: one key, one field, everything from it. Shortcuts as in Arc.
- [ ] **Finding archived tabs**, a small window for links from other apps, and link preview.
- [ ] **A refined design**: judged from screenshots, in light and dark, at every width.
- [ ] **Very robust and efficient**: random use checked against what must always hold, a long
      run in a real Firefox, and measured with up to 1000 tabs.

## C. Trying it on the second Mac

- [ ] It gets Firefox as default, and the Firefox files from dotfiles, declared in its
      own configuration. Its commits are signed: an unsigned commit in dotfiles
      stops the Firefox updates on the daily Mac.
- [ ] Tidier alone from a clean Firefox, from what is written down, with no Sidebery.
- [ ] Used for real for a while; what is missing goes in here and in FEATURES.md.

## D. Moving the daily browser

- [ ] A copy taken first, by hand, of the whole Firefox profile and Sidebery's export.
- [x] Rules and order of spaces imported from Sidebery's export, which is the only
      place they can be read from.
- [x] One explicit click, never an update: a report of what will happen, then the
      record is written, and only then are folder pages closed. It can be undone.
      Checked with a real Sidebery in the test Firefox, there and back.
- [ ] Sidebery disabled but installed for a few weeks.

## E. Without Sidebery, everywhere

- [ ] Sidebery and all that exists because of it removed: folders first, its tree
      rules, waiting for its sidebar, `tests/fixtures/sidebery.json`, `tools/fix_spaces.py`,
      and its files in dotfiles (in that order, or releases stop).
- [ ] Essentials, folders and spaces on every machine by Firefox Sync, within its limits.
- [ ] Spaces hidden per machine. Hidden only: the data is on every machine.
- [ ] Every Mac set up the same way.

## Stretch goal: made for working with Claude and other agents

Off by default. Copying a page or tabs as clean text for Claude. An MCP server so Claude
Code can work in the browser, local only. Agents get a space of their own with its own
logins, see and touch only that, unless you allow more. What they do shows, and one
click stops it.

## F. After that

What FEATURES.md has as Later, starting with what is missed most in use.

## Choices made

Changed by saying so. All of them can be reversed.

- A tab that is only a placeholder is not archived until you have selected it.
- Closing the last window and quitting brings your tabs back unloaded.
- A failed smoke test gets one more try, marked with a warning. To be looked at
  again once it is known how often the first try fails.
- A failure in Developer Edition only stops releases until restart is also
  tested in release Firefox; then it only warns.
- Archiving counts clock time: a night away closes yesterday's ordinary tabs.
- `tabHide` is optional, asked for when Tidier alone is turned on, so that no update
  ever waits for a click. Firefox shows hidden tabs again at each update, so
  Tidier hides them again when it starts.
- Essentials stay pinned tabs, so other spaces' essentials stay in ⌃Tab; Firefox
  cannot hide a pinned tab.
- A link opened from a tab in a folder is an ordinary tab, as in Arc (Tidier alone).
- A link's first request may go out without a container before it is opened in its
  space. It carries no login, and needs no access to all websites, so README's "no
  host permissions" stays.
