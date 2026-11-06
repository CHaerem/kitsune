# Working on Tidier

Read the README first: **The goal** and **Where it stands** say what Tidier is
for and which step comes next; FEATURES.md lists what to aim for from Zen, Arc
and Sidebery. In short: Firefox and Tidier only, with as much as possible in
Tidier itself, and Sidebery being replaced by Tidier's own sidebar.

## Never touch the user's own Firefox

- Test in the test Firefox only (`tests/testfirefox.py`: headless, throwaway
  profile, its own Marionette port). Never restart, quit or script the
  user's Firefox, and never install anything into its profile.
- The user's profile may be **read** read-only, to measure how something is
  used (e.g. `sessionstore-backups/recovery.jsonlz4`, `extensions.json`).
  Its data is the user's: it can hold internal company hostnames, which must
  never go into this public repository or a commit message.
- The user installs releases themselves (or Firefox does, from `updates.json`).

## The fast loop

```bash
node --test                                   # unit tests, about a second
tests/smoke.py --only essentials,tab_sync     # some groups, about a minute
tests/smoke.py                                # everything, three Firefoxes at once, about four minutes
```

- Run the smoke test under `nice -n 19` (and `taskpolicy -b` on macOS) so the
  user's machine stays responsive.
- `--only` adds the setup groups a group needs (NEEDS in smoke.py).
- A failure that happens "sometimes" is real: rerun the group alone and with
  two runs in parallel (load makes timing bugs show), and compare with the
  last release (`git archive` it into a temporary folder and run the same
  groups there) before deciding whose bug it is.
- A check marked KNOWN is a reported Sidebery bug (KNOWN_SIDEBERY_BUGS).

## Code

- The background scripts are plain scripts sharing one scope
  (manifest.json, background.scripts): a top-level name defined twice
  silently replaces the first. A unit test stops that.
- Comments in English, explaining *why*: what Firefox or Sidebery does that
  makes the code necessary. They are the documentation for the next person.
- Behaviour goes in Tidier, not in Firefox settings, unless an extension
  cannot do it; then it goes in the dotfiles (`~/src/private/dotfiles`,
  `home/firefox/`: user.js, userChrome.css, tidier.css, sidebery.css).
- New behaviour gets a check: a unit test where no Firefox is needed, else a
  smoke check. Memory and idle work are checked too (many_tabs): with nothing
  happening, Tidier must do nothing.
- Never change the add-on's ID in manifest.json: Firefox updates the
  installed add-on by it, and everything Tidier stores belongs to it.

## Commits and releases

- Add named files only (no `git add -A` or `git add .`). No AI attribution
  in commits. Don't override the git author or committer; commits are signed
  (SSH) by the user's own git config.
- Commit and push as separate commands; a push may be refused by the
  permission check, and then the user pushes.
- A push to main runs the smoke test on GitHub (Firefox and Developer
  Edition); when it passes, the Release workflow signs the extension on AMO
  and publishes it with `updates.json`, and Firefox updates itself. A smoke
  test that fails on its first try gets one more in the same job, and a warning.
- The version is `1.6.<number of commits>` (tools/release.py). A commit gets a
  release only if it changes what goes into the extension: not the documents,
  tests, tools, `native/` or `.github/`.
- dotfiles: ask before each commit and push there (its own CLAUDE.md), and a
  change to a `.nix` file takes effect only after the user's switch.

## Talking with the user

- Write to the user in plain words, without internal names; translate technical
  terms only where it helps (keep words like container, sidebar, extension).
- Show what you will post or send before doing it.
