# Kitsune

In Japanese folklore a *kitsune* is a fox spirit that can take another shape.
This Firefox extension lets Firefox take the shape of Zen and Arc: it adds the
features Firefox and Sidebery cannot do themselves, for a Firefox + Sidebery
setup with one Sidebery panel ("space") per container. Each one is a small
*bodge*: not the proper way to do it, but it does what you need with what you
have.

The rule: only what Firefox and Sidebery cannot do. Anything a setting,
`about:keyboard` or Sidebery can do is set up there instead (in the dotfiles).

1. **Essentials in every window.** Pinned tabs are mirrored as unloaded copies
   in every window, in the same container (and therefore the same Sidebery
   space). Pinning or unpinning in one window does the same in the others.
   Closing an essential brings it back unloaded, like Zen. A new one goes
   after the others of its space (Sidebery shows them by space, and would
   sort them so when Firefox starts). Moving one keeps
   the new order, in every window and in new windows. Dragging one to another
   window takes it there (in its place, not twice) and leaves a copy behind. An essential's
   title and icon follow its page, but only from the essential's own site,
   so a redirect to a sign-in page does not rename it. Like every other tab,
   an essential is loaded in one window only (two loaded Slacks would play
   every notification sound twice): selecting its copy in the window you are
   using moves the loaded tab there and leaves an unloaded copy behind, and a
   copy that loads its page anyway (as after a restart) makes the others
   unloaded copies again (`essentials.js`, "One loaded copy").
2. **Tabs in every window.** Every other tab is *live* in one window and an
   unloaded *ghost* in the others (same URL, title, container and place in the
   Sidebery tree). Selecting a ghost moves the live tab into your window and
   leaves a ghost behind, so each page is only ever loaded once. Opening a tab
   adds it everywhere; closing it closes it everywhere; moving it into or out
   of a folder does the same in the other windows; closing a window hands its
   tabs over to another window.
3. **Folders first** (`folders.js`): in each space, Sidebery's folders, with
   the tabs in them, come before the ordinary tabs, like the pinned part of a
   space in Zen and Arc. Sidebery has no setting for it, and reordering with
   CSS would only change the picture, so Kitsune keeps the real tab order:
   when a space does not start with its folders, the ordinary tabs above them
   are moved below them, one at a time (moving a folder would make Sidebery
   put the tabs it passes into it).
4. **Live folders** (`livefolders.js`): Sidebery folders filled from a GitHub
   pull request search, such as open pull requests in your company's
   organisation or your own repositories where you are author, assignee or
   asked for review. Refreshed every 15 minutes and at startup: new pull
   requests get an unloaded tab, merged or closed ones are removed (the one
   you are looking at once you leave it), and a
   renamed one's unloaded tabs take the new title. A pull request tab you
   close stays closed until it leaves the search.
5. **⌘⇧C copies the address** of the current tab, as in Arc and Zen
   (`shortcuts.js`). Firefox gives ⌘⇧C to the developer tools' element
   picker, which wins over extensions; free it in `about:keyboard` (the
   dotfiles do this in `customKeys.json`).
6. **Archiving**, as in Arc (`archive.js`): a tab not selected in any window
   for 12 hours is closed everywhere, and stays under History → Recently
   Closed Tabs (⌘⇧T). Essentials, folders and the tabs in them, selected tabs
   and tabs playing sound are kept. The time never counts from before
   archiving was first turned on. Change it with `archiveAfterHours` in the
   extension storage (0 = off).
7. **Saved tabs**, like Arc's pinned section and Zen's pinned tabs (in
   `tabsync.js`, the rules in `closeAction` in `common.js`): a tab in a
   folder is *saved*. Closing it while it is loaded (⌘W, or Sidebery's ×)
   unloads it instead, in its place, in every window, and it goes back to the
   address it had when it came into the folder (browsing in it does not change
   that; its title and icon follow the page while it is on that address).
   ⌘⇧T reopens it in its placeholder's place. To remove a saved tab for good,
   close it while it is unloaded (the × on its placeholder, or a middle click),
   or drag it out of the folder, which makes it an ordinary tab again. Every
   other tab is temporary: closing it closes it everywhere, and archiving
   closes it when unused. A live folder's pull requests are not saved (the
   search decides what is in them), and the tabs of a folder you close with
   it in one window stay in the other windows.

Shortcuts, compact mode, sign-in and spaces are set up natively (Firefox
settings, `about:keyboard`, Sidebery), in the dotfiles. Switching to a tab in
another window needs no command either: every tab is in every window.

Sidebery folders (group pages) are copied per window, with the ghosts nested
under the copy. Closing a folder copy only affects its own window.

## Live folders and the native host

The pull request search runs in `native/github-prs.py`, a Firefox native
messaging host that calls the `gh` CLI with your existing login. No GitHub
token is stored in the browser. The folders are set up in a local file, not in
this repository: `~/.config/kitsune/live-folders.json` (see
`native/live-folders.example.json`), one entry per folder with its name, its
container (so its space) and a GitHub search (`org:…`, `user:…`, `repo:…`).
The extension only learns each folder's id, name and container, and the host
only runs those searches; anything else is refused.

Install the host once (and again if this folder moves); it also creates the
config file from the example if there is none:

```bash
native/install.sh
```

It writes `~/Library/Application Support/Mozilla/NativeMessagingHosts/kitsune_github.json`,
which only allows this extension to start the host. The `native/` folder is not
part of the signed extension.

## Placeholders (ghost.html)

Firefox cannot give an unloaded tab a title or icon. Ghosts and essential
copies are therefore created as a tiny local page (`ghost.html`) that sets the
real page's title and icon and then asks to be unloaded; an unloaded tab keeps
both, so placeholders cost no memory once settled. It is unloaded when Firefox
reports the icon as shown, not after a fixed pause. The icon is the one saved
for the page, else the site's `/favicon.ico` if that loads. When shown, an essential
copy goes straight to the real page; a ghost has the live tab pulled in, and
only loads the real page itself if no live tab exists. When a live tab's title
or icon changes, its ghosts reload the placeholder to show it.

Tabs that were never loaded have no title or icon to copy. For the initial
migration from Zen these were filled in from Zen's session data. An essential
that still has no icon takes the icon of the first tab on its site that you
open, and its copies are redrawn. This matters for sites behind a sign-in,
whose `/favicon.ico` leads to the sign-in page. Firefox's own icon cache
(`page-icon:`) cannot be loaded from an extension's process.

## Short names for essentials

An essential can have a `name` (e.g. "Jira") in the extension storage
(`essentials` list). Unloaded copies show it instead of the page title. There
is no UI for it; set it with a script while the extension is disabled (the
extension keeps the list in memory and would overwrite the change).

## Tabs in the wrong space

Each space belongs to one container (its own logins), so a tab should always
be in its container's space. Sidebery keeps the space ("panel") of every tab
itself, does not apply its container rules to pinned tabs, and is not
predictable about the space of a tab another extension moves to a border
between spaces. No other extension can change Sidebery's choice. If tabs show
up in the wrong space:

```bash
tools/fix_spaces.py          # fix (restarts Firefox)
tools/fix_spaces.py --check  # only report
```

It sets each tab's space from its container (the container each space opens
new tabs in). The smoke test checks this for every tab in every window, also
after an essential is closed or pinned and after a tab is pulled in.

Links opened from outside Firefox (Slack, Mail, …) open in the active space's
container; Sidebery does that (its setting "reopen externally opened tabs").
It cannot for addons.mozilla.org, which Firefox shields from extensions.

Sidebery's container rules ("reopen tabs with this URL in this container")
match a rule's text anywhere in every address a tab loads, including sign-in
redirects. `youtube.com` also matches `accounts.youtube.com`, which every
Google sign-in passes through, so a Google sign-in in another space is moved
to that container: the essential is closed (and comes back unloaded) and the
sign-in fails there. `teams.microsoft.com` likewise matches a Microsoft
sign-in that returns to Teams. Anchor such rules to the start of the address,
as a regular expression: `/^https:\/\/(www\.|m\.)?youtube\.com\//`.

## Sidebery's look and settings come from dotfiles

Sidebery's CSS (`sidebery.css`) and the settings that matter for Kitsune
(`sidebery-settings.json`) are in dotfiles, which hands them to Sidebery as
*managed storage*: a file in `~/Library/Application Support/Mozilla/ManagedStorage/`
that Firefox gives the extension. Sidebery reads it every time it starts, and
its values win over Sidebery's own, so nothing is pasted into Sidebery and a
change in Sidebery's settings page lasts only until the next start. The test
Firefox gets the same file built from the same dotfiles files (pointed at its
profile, since Firefox only looks in your own `~/Library`); the fixture's
settings are older values on purpose, so the tests show that dotfiles wins.
Spaces and container rules are not settings and stay in Sidebery's storage.

## Scrolling in the sidebar (Sidebery settings)

Scrolling only scrolls the tabs; spaces are switched with the buttons at the
bottom or ⌃1/2/3. Switching spaces by scrolling sideways was tried and left
out: a trackpad's vertical swipe also moves a little sideways, and the wheel
threshold that keeps such a swipe from switching space also makes Sidebery
block small vertical scroll events.

| Sidebery setting | Value | Why |
|---|---|---|
| Use horizontal scroll to (`hScrollAction`) | do nothing | |
| Set threshold for switching between panels and tabs by scrolling (`wheelThreshold`) | off | with it on, Sidebery blocks vertical scroll events below the vertical threshold |
| Switch panels using vertical scroll over navigation bar (`navSwitchPanelsWheel`) | off | scrolling near the bottom would switch space |

These are set in dotfiles' `sidebery-settings.json` (see above).

## Known limitations

- An essential remembers the URL the tab had when it was pinned. Pin a page
  when it shows the app itself, not while it is redirecting to a sign-in or
  product page.
- An essential whose site you have not opened since it became one, and whose
  `/favicon.ico` does not load, shows the default icon until you do.
- Folders, including new live folders, start expanded in a new window (Sidebery does not let other
  extensions fold them).
- Sidebery requires each panel's tabs to be one contiguous run in panel order;
  after filling a window the extension copies the tab order from the window
  with the most synced tabs, with each space's tabs together (that window can
  have them mixed: Sidebery shows a tab added at the end of a window in its
  space without moving it there). That sort waits ~1.5 s for Sidebery to finish
  placing the new tabs; sorting sooner puts tabs in the wrong panel.
- A tab in a folder that you pull into another window (by selecting its ghost)
  takes its ghost's place there, but outside the folder; the
  ghost it leaves behind stays in the folder. Sidebery decides a moved-in tab's
  place in its tree itself, from the tab that opened it, and Firefox does not
  report an opener in another window, so no extension can put it in the folder.
- Moving a tab into or out of a folder is copied to the other windows, but
  not moving it elsewhere: Sidebery gives a tab another extension moves the
  space of the tab it lands next to, so moving ghosts around could change
  their space. Where the tab is live or selected, in a window you are not
  using, it stays where it was there. A new window takes the order of the window with the
  most tabs.
- Sidebery gives the first pinned tab of a new window to the active panel, so a
  throwaway pinned tab holds that spot while the essentials are created.
- A tab that exists before a new window's sidebar has started gets the last
  active space, whatever its container, and a pinned tab keeps its space. So a
  new window's essentials are created unpinned, and pinned only once Sidebery's
  sidebar there has started: their placeholders are loaded again every 0.5 s,
  so Sidebery moves them to their spaces once it runs, until Sidebery shows
  that it has (it hides the tabs of the other spaces, or sets which tab to
  select after closing the current one; at most 4 s; `PROBE_MS` and
  `SIDEBAR_WAIT_MS` in `common.js`). Just
  before pinning, each loads its placeholder once more and gets 0.6 s for
  Sidebery's container rule. The smoke test opens three windows to check. Up
  to Sidebery 5.6.1 a failure of that check is reported as `KNOWN` and does
  not block a release (`KNOWN_SIDEBERY_BUGS` in `tests/smoke.py`). The fix is
  [mbnuqw/sidebery#2497](https://github.com/mbnuqw/sidebery/pull/2497); with a
  newer Sidebery the check is strict again.

## Performance (Firefox 159, Sidebery 5.6, 33 essentials + 53 tabs)

- New window: essentials after ~1.6 s, all tabs after ~1.6 s, sorted after
  ~3 s (measured before essentials waited for Sidebery's sidebar; pinning
  now comes ~0.7 s later). Placeholders load briefly and unload themselves;
  only folder copies stay loaded.
- Selecting a ghost: the live tab is in place after ~50 ms.

Timing constants live in `common.js`; re-measure if Sidebery or Firefox
changes how new tabs are handled.

## Permissions

`tabs`, `sessions`, `storage`, `cookies` (to open tabs in a container),
`nativeMessaging` (the pull request search), `alarms` (its refresh) and
`clipboardWrite` (⌘⇧C). `alarms` also runs the archiving check. No host
permissions, no network access from the extension, no data collection.

## Files

- `common.js` – shared queue and helpers. Every change runs through one queue
  so events cannot race into duplicate tabs.
- `essentials.js` – essentials (pinned tabs) in every window.
- `tabsync.js` – live/ghost tab sync. Roles and keys are stored per tab with
  `sessions.setTabValue`, so they survive a restart. Tree structure is read
  from `openerTabId`, which Sidebery keeps equal to the parent in its tree.
- `folders.js` – folders first in each space (see above).
- `livefolders.js` – live folders of GitHub pull requests (see above).
- `ghost.html` / `ghost.js` – placeholder page for ghosts, essential copies and never-loaded live tabs.
- `archive.js` – archiving of unused tabs.
- `shortcuts.js` – ⌘⇧C, copy the address.
- `tools/fix_spaces.py` – put tabs back in their own Sidebery space (in your
  own Firefox, which it restarts).
- `tests/` – the smoke test, the test Firefox and its fixtures.
- `.github/workflows/smoke.yml`, `tools/setup-ci-keys.sh` – the smoke test on GitHub.
- `.github/workflows/release.yml`, `tools/release.py`, `tools/setup-amo-key.sh` –
  signing and releases (see below).

## Releases and updates

Every push to `main` that changes the extension ends up in your Firefox on
its own:

1. The smoke test runs on GitHub (`.github/workflows/smoke.yml`). A failed
   first attempt is run once more, because of the known pin race.
2. When it passes, `.github/workflows/release.yml` runs `tools/release.py`:
   - it builds the `.xpi` with version `major.minor.<number of commits>`, e.g.
     1.6.7, so nobody has to bump it;
   - addons.mozilla.org signs it as *unlisted* (not in its catalogue), because
     Firefox only installs signed extensions;
   - it puts the `.xpi` and `updates.json` on a GitHub Release.
3. Firefox reads `updates.json` through `update_url` in `manifest.json` and
   installs the new version by itself. It checks once a day; *Check for
   updates* in `about:addons` checks at once.

Nothing is released when only the README, tests or tools changed. Change
`major.minor` in `manifest.json` for a bigger change. `tools/release.py
--dry-run DIR` builds the `.xpi` and `updates.json` locally without signing.

Set up once:

- The AMO API key: create it at
  <https://addons.mozilla.org/developers/addon/api/key/> and run
  `tools/setup-amo-key.sh`, which stores it as the secrets `AMO_JWT_ISSUER`
  and `AMO_JWT_SECRET`. Only the release workflow, which runs code from `main`,
  can read them.
- Firefox: install the first release by hand (open the `.xpi` from the newest
  [release](https://github.com/CHaerem/kitsune/releases)). Versions before
  1.6 have no `update_url`, so they cannot find updates.

## Testing

From fastest to most complete:

```bash
node --test                          # unit tests, under a second
tests/smoke.py --only trees,folders  # some smoke test groups, about a minute
tests/smoke.py                       # the whole smoke test, about three minutes
tests/smoke.py --installed           # the signed version installed in your Firefox
tests/smoke.py --xpi FILE            # a given signed .xpi
tests/smoke.py --serial              # in one test Firefox, as on GitHub (about nine minutes)
```

The unit tests (`tests/unit.test.mjs`) cover the logic that needs no Firefox:
the order a window's tabs are put in, and moving tabs without breaking
Sidebery's tree, against a small model of how Sidebery rebuilds its tree after
a move. Change that logic test-first there.

The group names for `--only` are the check functions in `tests/smoke.py`
(`new_window`, `essentials`, `folders`, `trees`, …); a group that needs the
second window gets it first. Without `--only`, the groups run in three test
Firefoxes at once (`SHARDS`).

The smoke test runs in an invisible test Firefox with a throwaway profile
(`tests/testfirefox.py`), so it never touches your own Firefox: no restart, no
window, no clipboard, its own Marionette port (one per test Firefox). The
profile is deleted afterwards. It is built the same way every time, from:

- dotfiles (`~/src/private/dotfiles/home/firefox`, or `KITSUNE_DOTFILES`):
  `user.js`, `userChrome.css`, `customKeys.json` and Sidebery's CSS, so it
  tests the setup as dotfiles says it is;
- `tests/fixtures`: Sidebery's spaces and settings, and the containers, made
  from your own setup without any addresses by `tests/fixtures/from_backup.py`
  (run it again when you change spaces or containers);
- Sidebery as you have it installed (or, if your Firefox has none, the newest
  from addons.mozilla.org, kept for a day in `~/Library/Caches/kitsune`),
  with its permissions and ⌃1/⌃2/⌃3;
- Kitsune (this folder, or a signed `.xpi`);
- test tabs in each space: essentials, a folder with tabs, ordinary tabs.
- a stand-in for the live folders' native host (`tests/fake_github_host.py`),
  which answers from a file the test writes, so live folders are tested
  everywhere without your `gh` login or GitHub.

The list of what it checks is at the top of `tests/smoke.py`. Each group of
checks runs on its own; a check that crashes counts as failed. Run it after
changing the extension or dotfiles' Firefox files, and after Firefox or
Sidebery updates (timing in `common.js` depends on how Sidebery handles new
tabs).

A headless Firefox has no real window focus, and the macOS hand-over of links
from other apps cannot be emulated in it; the test checks the part that keeps
logins apart (a tab without a container lands in the active space's
container).

### On GitHub

`.github/workflows/smoke.yml` runs the same smoke test on GitHub, in a
headless Firefox on a macOS runner with the newest Sidebery, both in the newest
Firefox and in Firefox Developer Edition (the Beta, about four weeks ahead, so a
Firefox change that would break the setup shows up before it reaches you).
Developer Edition allows unsigned add-ons, so there Kitsune is installed for
real and the test also quits and restarts Firefox to check the restored
session; on your Mac that part runs with `--installed` or `--xpi`. It
runs on pushes and pull requests here and every Monday, so a Firefox or
Sidebery update that breaks something shows up without any change here; after
changing the Firefox files in dotfiles, start it by hand (Actions → Smoke test
→ Run workflow). GitHub e-mails you when a run fails.

The Firefox files come from your private dotfiles, read with a read-only
deploy key (deploy keys do not expire). Set it up once, in your own terminal:

```bash
tools/setup-ci-keys.sh
```

During development you can also load it by hand: `about:debugging` → This
Firefox → Load Temporary Add-on → `manifest.json`.
