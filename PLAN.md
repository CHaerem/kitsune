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
- [ ] A check of an update over a running session: same tabs, essentials and
      folders before and after.
- [ ] Tests see errors inside Tidier, show why Firefox did not start, and the
      restart checks cannot quietly disappear from a green run.
- [ ] A second ghost selected within 0.7 s of a pull opens; a tab closed within
      0.6 s of a pull closes everywhere.
- [ ] A title or icon change writes the tab record only when something changed.
- [ ] A page with unsaved input is not closed by archiving or a live folder.
- [ ] Tidier keeps a copy of its own data: essentials, folders and saved tabs, as a
      dated file through the native host, restored from Tidier itself.
- [ ] A live folder that has stopped (no host, no `gh` login) shows it.
- [ ] README's permissions, files and claims match what is there.

## B. Tidier alone (behind the setting)

1. **The setting and the test Firefox.** `tidierAlone`, from the extension's storage or
   declared in managed storage for a machine. A test Firefox without Sidebery, with
   folders and essentials as Tidier's own data, run in every smoke test. With the
   setting on, the waits and moves that exist only for Sidebery do not run.
2. **The sidebar as the sidebar.** A key and a toolbar button for it, back after
   every update. Checks of what it shows and does, and of its idle cost. It draws
   only what changed, so clicks and drags are not lost.
3. **Spaces.** Other spaces' tabs hidden, also from ⌃Tab (`tabHide`, optional, so
   updates never wait for a click). Switching with the bar and ⌃1/2/3, also to an
   empty space. New tabs and links from other apps in the active space. Closing the
   last tab of a space stays in the space. Space names and order in the sidebar.
4. **Folders as Tidier's data.** Create, rename, delete, fold. A folder has no tab
   of its own, and no tab event can delete it. Saved tabs, archiving and live
   folders work on these folders.
5. **Using it.** Drag tabs, into and out of folders, between essentials and
   tabs and to other spaces; the order follows in every window. A new tab button.
   The context menu on tabs, folders and spaces. Sound indicator and mute. Keys.
6. **Rules.** An address always opens in a given space, as Sidebery's container
   rules do, edited in Tidier.
7. **Settings in Tidier.** A page for all of the above, and the shortcuts in one
   place.

## C. Trying it on the second Mac

- [ ] It gets Firefox as default, and the Firefox files from dotfiles, declared in its
      own configuration. Its commits are signed: an unsigned commit in dotfiles
      stops the Firefox updates on the daily Mac.
- [ ] Tidier alone from a clean Firefox, from what is written down, with no Sidebery.
- [ ] Used for real for a while; what is missing goes in here and in FEATURES.md.

## D. Moving the daily browser

- [ ] A copy taken first, by hand, of the whole Firefox profile and Sidebery's export.
- [ ] Rules, order of spaces and folds imported from Sidebery's export, which is the
      only place they can be read from.
- [ ] One explicit click, never an update: a report of what will happen, then the
      record is written, and only then are folder pages closed. It can be resumed
      after a crash, and undone.
- [ ] Sidebery disabled but installed for a few weeks.

## E. Without Sidebery, everywhere

- [ ] Sidebery and all that exists because of it removed: folders first, its tree
      rules, waiting for its sidebar, `tests/fixtures/sidebery.json`, `tools/fix_spaces.py`,
      and its files in dotfiles (in that order, or releases stop).
- [ ] Essentials, folders and spaces on every machine by Firefox Sync, within its limits.
- [ ] Spaces hidden per machine. Hidden only: the data is on every machine.
- [ ] Every Mac set up the same way.

## F. After that

What FEATURES.md has as Later or Decide, starting with what is missed most in use:
finding archived tabs again, the command bar, a small window for links from other apps,
link preview, split view.

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
