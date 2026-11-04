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
   Closing an essential brings it back unloaded, like Zen. An essential's
   title and icon follow its page, but only from the essential's own site,
   so a redirect to a sign-in page does not rename it.
2. **Tabs in every window.** Every other tab is *live* in one window and an
   unloaded *ghost* in the others (same URL, title, container and place in the
   Sidebery tree). Selecting a ghost moves the live tab into your window and
   leaves a ghost behind, so each page is only ever loaded once. Opening a tab
   adds it everywhere; closing it closes it everywhere; closing a window hands
   its tabs over to another window.
3. **Live folders** (`livefolders.js`): Sidebery folders filled from a GitHub
   pull request search, such as open pull requests in your company's
   organisation or your own repositories where you are author, assignee or
   asked for review. Refreshed every 15 minutes and at startup: new pull
   requests get an unloaded tab, merged or closed ones are removed. A pull
   request tab you close stays closed until it leaves the search.
4. **⌘⇧C copies the address** of the current tab, as in Arc and Zen
   (`shortcuts.js`). Firefox gives ⌘⇧C to the developer tools' element
   picker, which wins over extensions; free it in `about:keyboard` (the
   dotfiles do this in `customKeys.json`).
5. **Archiving**, as in Arc (`archive.js`): a tab not selected in any window
   for 12 hours is closed everywhere, and stays under History → Recently
   Closed Tabs (⌘⇧T). Essentials, folders and the tabs in them, selected tabs
   and tabs playing sound are kept. The time never counts from before
   archiving was first turned on. Change it with `archiveAfterHours` in the
   extension storage (0 = off).

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
both, so placeholders cost no memory once settled. When shown, an essential
copy goes straight to the real page; a ghost has the live tab pulled in, and
only loads the real page itself if no live tab exists. When a live tab's title
or icon changes, its ghosts reload the placeholder to show it.

Tabs that were never loaded have no title or icon to copy. For the initial
migration from Zen these were filled in from Zen's session data.

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

## Known limitations

- An essential remembers the URL the tab had when it was pinned. Pin a page
  when it shows the app itself, not while it is redirecting to a sign-in or
  product page.
- Pages without a favicon (and sites that block `/favicon.ico`) show the
  default icon.
- Folders, including new live folders, start expanded in a new window (Sidebery does not let other
  extensions fold them).
- Sidebery requires each panel's tabs to be one contiguous run in panel order;
  after filling a window the extension copies the tab order from the window
  with the most synced tabs. That sort waits ~1.5 s for Sidebery to finish
  placing the new tabs; sorting sooner puts tabs in the wrong panel.
- Sidebery gives the first pinned tab of a new window to the active panel, so a
  throwaway pinned tab holds that spot while the essentials are created.

## Performance (Firefox 159, Sidebery 5.6, 33 essentials + 53 tabs)

- New window: essentials after ~0.8 s, all tabs after ~1.3 s, sorted after
  ~3 s. Placeholders load briefly and unload themselves; only folder copies
  stay loaded.
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
- `livefolders.js` – live folders of GitHub pull requests (see above).
- `ghost.html` / `ghost.js` – placeholder page for ghosts, essential copies and never-loaded live tabs.
- `archive.js` – archiving of unused tabs.
- `shortcuts.js` – ⌘⇧C, copy the address.
- `tools/fix_spaces.py` – put tabs back in their own Sidebery space (in your
  own Firefox, which it restarts).
- `tests/` – the smoke test, the test Firefox and its fixtures.
- `.github/workflows/smoke.yml`, `tools/setup-ci-keys.sh` – the smoke test on GitHub.

## Build and sign

Firefox release only installs signed extensions. Sign it as *unlisted* (not
published on addons.mozilla.org) with an API key from
<https://addons.mozilla.org/developers/addon/api/key/>:

```bash
./sign.sh
```

The first run asks for the key and stores it in the macOS Keychain (service
`amo-web-ext`). Install the resulting `.xpi` from `../kitsune-dist`
by dragging it into Firefox.
Bump `version` in `manifest.json` before signing a new release.

## Testing

```bash
tests/smoke.py              # this folder, as a temporary add-on
tests/smoke.py --installed  # the signed version installed in your Firefox
tests/smoke.py --xpi FILE   # a given signed .xpi
```

The smoke test runs in an invisible test Firefox with a throwaway profile
(`tests/testfirefox.py`), so it never touches your own Firefox: no restart, no
window, no clipboard, its own Marionette port. It takes about three minutes,
and the profile is deleted afterwards. The profile is built the same way every
time, from:

- dotfiles (`~/src/private/dotfiles/home/firefox`, or `KITSUNE_DOTFILES`):
  `user.js`, `userChrome.css`, `customKeys.json` and Sidebery's CSS, so it
  tests the setup as dotfiles says it is;
- `tests/fixtures`: Sidebery's spaces and settings, and the containers, made
  from your own setup without any addresses by `tests/fixtures/from_backup.py`
  (run it again when you change spaces or containers);
- Sidebery as you have it installed, with its permissions and ⌃1/⌃2/⌃3;
- Kitsune (this folder, or a signed `.xpi`);
- test tabs in each space: essentials, a folder with tabs, ordinary tabs.

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
headless Firefox on a macOS runner with the newest Sidebery and the newest
Firefox, and on the weekly run also Firefox Beta (about four weeks ahead, so a
Firefox change that would break the setup shows up before it reaches you). It
runs on pushes and pull requests here and every Monday, so a Firefox or
Sidebery update that breaks something shows up without any change here; after
changing the Firefox files in dotfiles, start it by hand (Actions → Smoke test
→ Run workflow). GitHub e-mails you when a run fails. The live folder check is
skipped there (no native host).

The Firefox files come from your private dotfiles, read with a read-only
deploy key (deploy keys do not expire). Set it up once, in your own terminal:

```bash
tools/setup-ci-keys.sh
```

During development you can also load it by hand: `about:debugging` → This
Firefox → Load Temporary Add-on → `manifest.json`.
