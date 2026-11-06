#!/usr/bin/python3
"""Pictures of what Tidier draws, for working on its look.

    nice -n 19 taskpolicy -b tools/shoot.py FOLDER                     # everything, two minutes (one without taskpolicy)
    nice -n 19 taskpolicy -b tools/shoot.py FOLDER --only hover,menu   # only names with these words in them

It starts the test Firefox with Tidier alone (tests/testfirefox.py: headless, a
throwaway profile, never your own Firefox) from the folder this file is in, so a
worktree shoots its own code. It fills it with made-up tabs, none of them yours,
and writes PNGs at twice the size, as on a Retina screen:

    sidebar-SPACE-WIDTH-SCHEME   the sidebar per space, at 220, 300 and 480 px, light and dark
    window-SPACE-SCHEME          the whole window around it, with userChrome.css
    hover-*, menu-*, state-*     one thing at a time, at 300 px, light and dark
    settings-SCHEME              the settings page

Runs at the same time are fine: each takes the first free port from 5100 up. To add
a picture, add a step to STEPS at the end.

The sidebar in the pictures is the real one in the real window, not its page in a
tab. A page in a tab would list itself as a tab of the space, take the selection
away from the tab that has it, and never show an empty list; and a sidebar follows
the window's light or dark, not the setting for web pages. Firefox can draw any
part of its own window (WebDriver:TakeScreenshot in the chrome context), and a mouse
moved there reaches the page in the sidebar as a real one, so :hover and the right
clicks are real. What cannot be had for real is marked "by hand" below.

The tabs are real too: pages from the test Firefox's little server (PAGES), each
with its title and an icon as a data: URL, so what the sidebar shows comes through
Tidier itself. A feature that adds to the view shows up here by itself.
"""
import argparse
import base64
import fcntl
import html
import json
import os
import socket
import sys
import tempfile
import time
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests"))
import testfirefox  # noqa: E402
from testfirefox import TestFirefox  # noqa: E402

WIDTHS = (220, 300, 480)
WIDTH = 300  # of the pictures of one thing at a time
WINDOW = (1400, 900)  # the sidebar is this high, less the toolbar above it
SCHEMES = ("light", "dark")
FIRST_PORT = 5100


# --- Icons: drawn here, the kinds a browser meets -----------------------------------
def svg(body, bg=None):
    tile = f'<rect width="32" height="32" rx="7" fill="{bg}"/>' if bg else ""
    return "data:image/svg+xml," + urllib.parse.quote(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">{tile}{body}</svg>')


def line(path, color="#fff"):
    return f'<g fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">{path}</g>'


ICONS = {
    # Coloured tiles, as most apps have.
    "mail": svg(line('<rect x="7" y="10" width="18" height="13" rx="2"/><path d="M8 12l8 6 8-6"/>'), "#e5484d"),
    "calendar": svg(line('<rect x="8" y="9" width="16" height="15" rx="2"/><path d="M8 14h16M12 7v4M20 7v4"/>'), "#3e63dd"),
    "chat": svg(line('<path d="M7 9h18v11H14l-5 4v-4H7z"/>'), "#30a46c"),
    "music": svg(line('<path d="M13 22V10l11-2v12"/><circle cx="10.5" cy="22" r="2.5"/><circle cx="21.5" cy="20" r="2.5"/>'), "#d6409f"),
    "photos": svg('<circle cx="12" cy="12" r="5" fill="#ffc53d"/><circle cx="20" cy="12" r="5" fill="#46a758" opacity=".85"/><circle cx="12" cy="20" r="5" fill="#e5484d" opacity=".85"/><circle cx="20" cy="20" r="5" fill="#3e63dd" opacity=".85"/>', "#fff"),
    "map": svg(line('<path d="M16 7a6.5 6.5 0 0 1 6.5 6.5C22.5 18 16 25 16 25s-6.5-7-6.5-11.5A6.5 6.5 0 0 1 16 7z"/><circle cx="16" cy="13.5" r="2"/>'), "#12a594"),
    "notes": svg(line('<path d="M10 7h12v18H10zM13 12h6M13 16h6M13 20h4"/>', "#5b4a00"), "#ffd60a"),
    "bank": svg(line('<path d="M7 13l9-6 9 6M9 13v8M16 13v8M23 13v8M7 24h18"/>'), "#0d74ce"),
    "code": svg(line('<path d="M12 10l-6 6 6 6M20 10l6 6-6 6"/>'), "#24292f"),
    "board": svg('<rect x="7" y="8" width="5" height="16" rx="1.5" fill="#fff"/><rect x="13.5" y="8" width="5" height="10" rx="1.5" fill="#fff"/><rect x="20" y="8" width="5" height="13" rx="1.5" fill="#fff"/>', "#0052cc"),
    "chart": svg('<rect x="8" y="17" width="4" height="7" rx="1" fill="#fff"/><rect x="14" y="12" width="4" height="12" rx="1" fill="#fff"/><rect x="20" y="8" width="4" height="16" rx="1" fill="#fff"/>', "#7c66dc"),
    "video": svg('<rect x="6" y="10" width="14" height="12" rx="2.5" fill="#fff"/><path d="M21 15l5-3.5v9L21 17z" fill="#fff"/>', "#2d8cff"),
    "docs": svg(line('<path d="M10 7h8l5 5v13H10zM18 7v5h5M13 17h7M13 21h7"/>'), "#4285f4"),
    "terminal": svg(line('<path d="M9 11l5 5-5 5M16 22h7"/>', "#7ee787"), "#0d1117"),
    "design": svg('<circle cx="12" cy="11" r="4" fill="#f24e1e"/><circle cx="20" cy="11" r="4" fill="#ff7262"/><circle cx="12" cy="21" r="4" fill="#0acf83"/><circle cx="20" cy="16" r="4" fill="#1abcfe"/>', "#1e1e1e"),
    "people": svg(line('<circle cx="16" cy="12" r="4.5"/><path d="M8 25c0-5 3.5-7 8-7s8 2 8 7"/>'), "#e93d82"),
    # Without a tile, as many sites have: these meet the sidebar's own colour.
    "star": svg('<path d="M16 5l3.4 7.2 7.8 1-5.7 5.4 1.5 7.8-7-3.8-7 3.8 1.5-7.8L4.8 13.2l7.8-1z" fill="#f5a623"/>'),
    "book": svg(line('<path d="M16 9c-3-2-7-2-10-1v16c3-1 7-1 10 1 3-2 7-2 10-1V8c-3-1-7-1-10 1zM16 9v16"/>', "#b5651d")),
    "globe": svg(line('<circle cx="16" cy="16" r="10"/><path d="M6 16h20M16 6c-6 6-6 14 0 20M16 6c6 6 6 14 0 20"/>', "#2b7fff")),
    # All black, and all white: the two that vanish in one of the schemes.
    "black": svg('<circle cx="16" cy="16" r="11" fill="#000"/><path d="M12 22V10l8 12V10" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/>'),
    "white": svg('<path d="M23 20a10 10 0 0 1-11-14 11 11 0 1 0 14 14 10 10 0 0 1-3 0z" fill="#fff"/>'),
}


# --- What is in the test Firefox ----------------------------------------------------
pages = 0


def T(title, icon=None, off=False, on=False, sound=None):
    """A tab: `off` unloaded, `on` the selected tab of its space, `sound` "playing" or "muted"."""
    global pages
    pages += 1
    path = f"/shoot/{pages}"
    link = f'<link rel="icon" href="{ICONS[icon]}">' if icon else ""
    testfirefox.PAGES[path] = (f'<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>{html.escape(title)}</title>{link}'
                               f'<body style="font: 15px system-ui; margin: 14vh auto; max-width: 520px; color: GrayText">{html.escape(title)}</body>')
    return {"title": title, "path": path, "icon": bool(icon), "off": off, "on": on, "sound": sound}


LONG_TITLE = "Why a long title should fade out quietly: a very long article, with a subtitle as well, that goes on well past the width of even the widest sidebar there is"

SPACES = [
    {"ctx": 1, "slug": "personal", "name": "Personal",  # a little of everything; the selected tab is in a folder, with a long title
     "essentials": [T("Mail", "mail"), T("Calendar", "calendar"), T("Messages", "chat", off=True), T("Music", "music", sound="playing"),
                    T("Photos", "photos", off=True), T("Notes", "notes", off=True), T("Maps", "map", off=True)],
     "folders": [
         {"name": "Home", "tabs": [T("Moving checklist", "notes"), T("Sofa, three seats, oak legs", "star", off=True), T("Electricity prices this week", "chart", off=True)]},
         {"name": "Reading", "tabs": [T(LONG_TITLE, "book", on=True), T("The calm web: an essay", "black", off=True)]},
         {"name": "Trip to Lofoten", "closed": True, "tabs": [T("Ferry timetable", "globe", off=True), T("Sommerferie på Sørlandet: reiseplan", "map", off=True), T("Cabins by the sea", "star", off=True)]},
     ],
     "tabs": [T("Weather for Oslo", "white"), T("Cinnamon buns: a recipe", "star", off=True), T("Podcast: slow radio", "music", sound="muted"), T("Morning radio", "music", sound="playing"),
              T("A page with no icon at all"), T("Another with no icon, unloaded", off=True), T("Accounts and savings", "bank", off=True)]},
    {"ctx": 2, "slug": "work", "name": "Work",  # many essentials, a long list that scrolls, and the selected tab is an essential
     "essentials": [T("Mail", "mail"), T("Calendar", "calendar"), T("Chat", "chat", on=True), T("Board", "board"), T("Docs", "docs", off=True), T("Code", "code", off=True),
                    T("Calls", "video", off=True), T("Design", "design", off=True), T("Numbers", "chart", off=True), T("People", "people", off=True), T("Terminal", "terminal", off=True), T("Wiki", "book", off=True)],
     "folders": [
         {"name": "Sprint 46", "tabs": [T("Sign-in is slow in the morning", "code"), T("Board: sprint 46", "board"), T("Release notes draft", "docs", off=True), T("Support queue", "people", off=True)]},
         {"name": "New joiners", "closed": True, "tabs": [T("Welcome pack", "docs", off=True), T("Laptop setup", "terminal", off=True), T("Who is who", "people", off=True), T("Holiday policy", "docs", off=True), T("Expenses", "chart", off=True)]},
     ],
     "live": {"name": "Pull requests", "items": [("app", 4821, "Fix the flaky sign-in test by waiting for the redirect to finish"), ("app", 4817, "Smaller images on the start page"), ("docs", 233, "Explain the new release flow")]},
     "tabs": [T("Roadmap for next year", "docs"), T("Design review notes", "design"), T("Incident 2291: what happened and what we changed afterwards", "code"), T("Budget 2027", "chart", off=True),
              T("Interview plan", "people", off=True), T("Team photo", "photos", off=True), T("Office map, third floor", "map", off=True), T("Style guide", "book"), T("API reference: sessions", "code", off=True),
              T("Staging", "globe"), T("Logs from last night", "terminal", off=True), T("Customer call, Tuesday", "video", off=True), T("Retro notes", "notes", off=True), T("Who owns what", "board", off=True),
              T("Quarterly numbers", "chart", off=True), T("Pricing page, new draft", "docs", off=True), T("Search: how to rotate keys", "globe", off=True), T("Security checklist", "black", off=True),
              T("Meeting room booking", "calendar", off=True), T("Translations, Norwegian", "docs", off=True), T("Old wiki page, no icon", off=True), T("Status page", "star"), T("Travel request", "people", off=True),
              T("Monitoring: the last 24 hours", "chart", off=True), T("Onboarding feedback", "notes", off=True), T("Printer setup", "globe", off=True)]},
    {"ctx": 3, "slug": "studio", "name": "Studio",  # few of everything, and a selected ordinary tab
     "essentials": [T("Design", "design"), T("Notes", "notes", off=True), T("Music", "music", off=True)],
     "folders": [{"name": "Ideas", "closed": True, "tabs": [T("Colour palettes", "star", off=True), T("Sketches", "design", off=True)]}],
     "tabs": [T("Type specimen", "book"), T("Grid systems", "design", on=True), T("Sidebars I like", "globe", off=True)]},
]
EMPTY = {"ctx": 4, "slug": "travel", "name": "Travel"}  # nothing in it, until the pictures of empty spaces

testfirefox.SEED_TABS_ALONE = "return 1;"  # no test tabs: the ones above


# --- Scripts in the chrome and in the sidebar's page ---------------------------------
CHROME = """
  const {setTimeout: sT} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const wait = ms => new Promise(r => sT(r, ms));
  const w = Services.wm.getMostRecentWindow("navigator:browser"), gB = w.gBrowser;
  const byUrl = url => gB.tabs.find(t => t.linkedBrowser.currentURI.spec === url);
"""

# The page in the sidebar has no window handle for Marionette, but a frame script can
# run in it (Firefox loads its own into every sidebar, webext-panels.js).
IN_SIDEBAR = CHROME + """
  const [prelude, body, bodyArgs] = args;
  const panel = () => w.document.getElementById("sidebar").contentDocument?.getElementById("webext-panels-browser");
  for (let i = 0; i < 200 && !panel()?.currentURI?.spec.endsWith("/sidebar/sidebar.html"); i++) await wait(50);
  const inner = panel();
  if (!inner) return {error: "no sidebar"};
  const mm = inner.messageManager, reply = "tidier-shoot:" + Math.random();
  const answer = new Promise(res => { const listener = {receiveMessage(msg) { mm.removeMessageListener(reply, listener); res(msg.data); }}; mm.addMessageListener(reply, listener); });
  const script = `(async args => { ${prelude} ${body} })(${JSON.stringify(bodyArgs)}).then(
    value => sendAsyncMessage(${JSON.stringify(reply)}, {value: value ?? null}), err => sendAsyncMessage(${JSON.stringify(reply)}, {error: String(err)}))`;
  mm.loadFrameScript("data:application/javascript;charset=utf-8," + encodeURIComponent(script), false);
  return answer;
"""

PAGE = """
  const page = content.wrappedJSObject, doc = page.document;
  const sleep = ms => new Promise(r => content.setTimeout(r, ms));
  const frame = () => Promise.race([new Promise(r => content.requestAnimationFrame(r)), sleep(200)]);  // a timer in a sidebar takes a few times longer than asked
  const clone = o => page.JSON.parse(JSON.stringify(o));
  const until = async (test, what, ms = 15000) => { for (const t0 = Date.now(); !test(); await sleep(50)) if (Date.now() - t0 > ms) throw new Error("waited in vain for " + what); };
  // Talking to Tidier the way the sidebar does (sidebar-view.js), with the view it sends.
  const connect = async () => {
    const port = page.browser.runtime.connect(clone({name: "sidebar"}));
    let view = null;
    port.onMessage.addListener(Components.utils.exportFunction(v => { view = JSON.parse(JSON.stringify(v)); }, content));
    port.postMessage(clone({type: "hello", windowId: (await page.browser.windows.getCurrent()).id}));
    await until(() => view, "the sidebar's view");
    return {send: msg => port.postMessage(clone(msg)), view: () => view, close: () => port.disconnect()};
  };
"""


def in_sidebar(m, body, *args):
    """Run `body`, the body of an async function, in the sidebar's page."""
    reply = m.js(IN_SIDEBAR, PAGE, body, list(args))
    if "error" in reply:
        raise RuntimeError(f"In the sidebar: {reply['error']}")
    return reply["value"]


# --- Filling it -------------------------------------------------------------------------
def all_tabs(space):
    return [*space["essentials"], *(t for f in space["folders"] for t in f["tabs"]), *space["tabs"]]


def on_tab(space):
    return next(t for t in all_tabs(space) if t["on"])


def select(m, tab, ctx):
    """Select a tab; the space follows it. Waits until the sidebar shows that space."""
    m.js(CHROME + "gB.selectedTab = byUrl(args[0]); return 1;", m.pages + tab["path"])
    in_sidebar(m, """await until(() => doc.documentElement.dataset.space === args[0], "the space " + args[0]);""", f"firefox-container-{ctx}")


def fill(m):
    # Names that read like a real setup; the colours stay, and tidier.css goes by the container.
    in_sidebar(m, """for (const [ctx, name] of args[0]) await page.browser.contextualIdentities.update("firefox-container-" + ctx, clone({name}));""",
               [[s["ctx"], s["name"]] for s in [*SPACES, EMPTY]])
    # All the pages, in the order they are shown, each in its space.
    tabs = [{"url": m.pages + t["path"], "title": t["title"], "icon": t["icon"], "ctx": s["ctx"]} for s in SPACES for t in all_tabs(s)]
    left = m.js(CHROME + """const [tabs] = args;
      for (const t of tabs) { gB.addTrustedTab(t.url, {userContextId: t.ctx, inBackground: true}); await wait(15); }
      const unready = () => tabs.filter(t => { const tab = byUrl(t.url); return !tab || tab.label !== t.title || (t.icon && !tab.image); }).map(t => t.title);
      for (let i = 0; i < 400 && unready().length; i++) await wait(50);
      return unready();""", tabs)
    if left:
        print(f"(not ready in time: {left})", flush=True)
    # Essentials, one at a time so they keep their order, and the tab Firefox started with gone.
    m.js(CHROME + """for (const url of args[0]) { gB.pinTab(byUrl(url)); await wait(60); }
      gB.selectedTab = byUrl(args[1]); await wait(300);
      for (const t of [...gB.tabs]) if (!t.userContextId) gB.removeTab(t);
      await wait(300); return 1;""", [m.pages + t["path"] for s in SPACES for t in s["essentials"]], m.pages + on_tab(SPACES[0])["path"])
    for space in SPACES:
        select(m, on_tab(space), space["ctx"])
        make_folders(m, space)
    # What takes the tab to be loaded first: unloaded tabs, and marks for sound. (Nothing
    # plays: Firefox is told the tab is playing, as the page itself would have it told.)
    m.js(CHROME + """const [off, playing, muted] = args;
      for (const url of off) gB.discardBrowser(byUrl(url));
      for (const url of playing) { const t = byUrl(url); t.setAttribute("soundplaying", "true"); gB._tabAttrModified(t, ["soundplaying"]); }
      for (const url of muted) byUrl(url).toggleMuteAudio();
      await wait(500); return 1;""",
         *[[m.pages + t["path"] for s in SPACES for t in all_tabs(s) if test(t)]
           for test in (lambda t: t["off"], lambda t: t["sound"] == "playing", lambda t: t["sound"] == "muted")])


def make_folders(m, space):
    in_sidebar(m, """const [folders, ctx, base] = args;
      const port = await connect(), cookieStoreId = "firefox-container-" + ctx;
      const tabs = await page.browser.tabs.query(clone({}));
      const idOf = path => { const t = [...tabs].find(t => t.url === base + path); if (!t) throw new Error("no tab " + path); return t.id; };
      const folder = name => port.view().folders.find(f => f.name === name);
      for (const f of folders) {
        port.send({type: "newFolder", space: cookieStoreId, name: f.name});
        await until(() => folder(f.name), "the folder " + f.name);
        const key = folder(f.name).key;
        // A tab Tidier has not got to yet does not move, so this is tried until it has.
        const inside = () => folder(f.name).tabs.length === f.tabs.length;
        for (let i = 0; i < 40 && !inside(); i++) {
          const moved = new Set(folder(f.name).tabs.map(t => t.id));
          for (const t of f.tabs) if (!moved.has(idOf(t.path))) port.send({type: "moveTab", tabId: idOf(t.path), folder: key, before: null});
          await sleep(250);
        }
        if (!inside()) throw new Error("the tabs of " + f.name + " did not go in");
        if (f.closed) port.send({type: "foldFolder", key, collapsed: true});
      }
      await sleep(100);
      port.close();""", space["folders"], space["ctx"], m.pages)
    if space.get("live"):
        make_live_folder(m, space)


def make_live_folder(m, space):
    """A live folder, through the stand-in for the search (fake_github_host.py), so its
    tabs are the real placeholders Tidier makes for a pull request. Their icon is GitHub's own."""
    live = space["live"]
    json.dump({"folders": [{"id": "shoot", "name": live["name"], "container": f"firefox-container-{space['ctx']}"}],
               "items": {"shoot": [{"url": f"https://example.org/?pr={number}", "title": title, "number": number, "repo": repo} for repo, number, title in live["items"]]}},
              open(m.fake_prs, "w"))
    in_sidebar(m, """const [name, count] = args, port = await connect();
      await page.browser.runtime.sendMessage(clone({type: "refreshLiveFolders"}));
      await until(() => port.view().folders.find(f => f.name === name)?.tabs.length === count, "the live folder");
      await sleep(1000);  // the placeholders ask to be unloaded
      port.close();""", live["name"], len(live["items"]))


# --- Pictures ---------------------------------------------------------------------------
# Firefox draws its whole window at once, but then leaves out what is see-through in the
# sidebar's page (the dimmed icons of unloaded tabs), unless the part drawn starts where
# the sidebar does. So the sidebar is drawn on its own as well, and put on top.
WHOLE_WINDOW = CHROME + """
  const scale = w.devicePixelRatio, drawn = w.browsingContext.currentWindowGlobal;
  const draw = rect => drawn.drawSnapshot(rect, scale, "rgb(255,255,255)");
  const box = w.document.getElementById("sidebar").getBoundingClientRect();
  const all = await draw(new w.DOMRect(0, 0, w.innerWidth, w.innerHeight)), sidebar = await draw(new w.DOMRect(box.x, box.y, box.width, box.height));
  const canvas = w.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = all.width;
  canvas.height = all.height;
  const context = canvas.getContext("2d");
  context.drawImage(all, 0, 0);
  context.drawImage(sidebar, box.x * scale, box.y * scale);
  return canvas.toDataURL("image/png").split(",")[1];
"""


# The window has its own transitions (userChrome.css), and it shows at the sidebar's
# corners, where Firefox rounds the sidebar off. These too are taken to their end.
WINDOW_AT_REST = CHROME + """
  for (const doc of [w.document, w.document.getElementById("sidebar").contentDocument]) {
    for (const a of doc.getAnimations()) { try { a.finish(); } catch (e) {} }
  }
  return 1;
"""


# Firefox says that an add-on hides tabs, in a note that hangs from the toolbar over the
# top of the sidebar, and comes back as tabs are hidden. A picture cannot show the note,
# only the button it lights up; and it takes the mouse from what is under it.
CLOSE_FIREFOX_MENUS = CHROME + """
  const open = [...w.document.querySelectorAll("panel, menupopup")].filter(p => p.state !== "closed");
  for (const p of open) p.hidePopup();
  if (open.length) await wait(100);
  return 1;
"""


class Camera:
    def __init__(self, m, out, only):
        self.m, self.out, self.only = m, out, only
        self.current = None
        self.count = 0

    def wanted(self, name):
        """Is this picture, or (without a scheme in `name`) either of its two, asked for?"""
        names = [name] if name.endswith(SCHEMES) else [f"{name}-{scheme}" for scheme in SCHEMES]
        return not self.only or any(word in n for word in self.only for n in names)

    def scheme(self, name):
        """The window, and with it the sidebar, follows the system's light or dark; web pages
        and the settings page their own setting. Both, so they agree. The window and the
        page hear of it a moment later, and nothing in the page changes but the colours."""
        if name == self.current:
            return
        dark = name == "dark"
        self.m.js(CHROME + """const [dark] = args;
          Services.prefs.setIntPref("ui.systemUsesDarkTheme", dark ? 1 : 0);
          Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", dark ? 0 : 1);
          for (let i = 0; i < 100 && w.matchMedia("(prefers-color-scheme: dark)").matches !== dark; i++) await wait(20);
          return 1;""", dark)
        in_sidebar(self.m, """await until(() => content.matchMedia("(prefers-color-scheme: dark)").matches === args[0], "the colour scheme");""", dark)
        self.current = name

    def width(self, px):
        self.m.js(CHROME + """w.document.getElementById("sidebar-box").style.width = args[0] + "px"; return 1;""", px)
        in_sidebar(self.m, """await until(() => content.innerWidth === args[0], "the sidebar to be " + args[0] + " wide");""", px)

    def settle(self):
        """Until the page has stopped changing: transitions taken to their end (their last
        step is what is being looked at, not the wait), every icon ready to draw, nothing
        different for a few looks in a row. Not for ever: something may never stop moving."""
        in_sidebar(self.m, """let last = doc.documentElement.outerHTML, same = 0;
          for (let i = 0; i < 60 && same < 2; i++) {
            await frame();
            for (const a of doc.getAnimations()) { try { a.finish(); } catch (e) {} }
            const now = doc.documentElement.outerHTML;
            same = now === last && [...doc.images].every(img => img.complete) ? same + 1 : 0;
            last = now;
          }
          for (const img of doc.images) await img.decode().catch(() => {});""")

    def write(self, name, png):
        with open(os.path.join(self.out, name + ".png"), "wb") as f:
            f.write(base64.b64decode(png))
        self.count += 1

    def shoot(self, name, whole_window=False):
        """A picture of the sidebar (or the whole window) in both schemes, the one it is in now first."""
        for scheme in sorted(SCHEMES, key=lambda s: s != self.current):
            full = f"{name}-{scheme}"
            if not self.wanted(full):
                continue
            self.scheme(scheme)
            self.settle()
            if whole_window:
                self.m.js(CLOSE_FIREFOX_MENUS)
            self.m.js(WINDOW_AT_REST)
            if whole_window:
                self.write(full, self.m.js(WHOLE_WINDOW))
            else:
                found = self.m.cmd("WebDriver:FindElement", {"using": "css selector", "value": "#sidebar"})
                self.write(full, self.m.cmd("WebDriver:TakeScreenshot", {"id": next(iter(found.values())), "full": False, "scroll": False}))

    def sidebar_box(self):
        return self.m.js(CHROME + """return w.document.getElementById("sidebar").getBoundingClientRect().toJSON();""")

    def mouse(self, x, y, *then):
        self.m.js(CLOSE_FIREFOX_MENUS)
        self.m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(x), "y": int(y), "duration": 0, "origin": "viewport"}, *then]}]})

    def mouse_away(self):
        self.mouse(WINDOW[0] * 2 / 3, WINDOW[1] / 2)  # over the page

    def point_at(self, selector):
        """The mouse on the first element this finds in the sidebar; where it is, or None."""
        at = in_sidebar(self.m, """const e = doc.querySelector(args[0]); if (!e) return null;
          const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];""", selector)
        if not at:
            print(f"(nothing in the sidebar is {selector}: no picture of it)", flush=True)
            return None
        box = self.sidebar_box()
        x, y = box["x"] + at[0], box["y"] + at[1]
        # Twice at most: what only shows when its row is under the mouse, like a close
        # button, cannot be under the mouse until the second move.
        for nudge in (0, 1):
            self.mouse(x + nudge, y)
            if in_sidebar(self.m, """for (let i = 0; i < 15; i++) { if (doc.querySelector(args[0]).matches(":hover")) return true; await sleep(40); } return false;""", selector):
                return x, y
        print(f"(the mouse does not reach {selector}: its picture shows it without)", flush=True)
        return x, y

    def right_click(self, x, y):
        """A right click there; whether it opened Tidier's own small menu."""
        self.mouse(x, y, {"type": "pointerDown", "button": 2}, {"type": "pointerUp", "button": 2})
        self.m.cmd("WebDriver:ReleaseActions")
        return in_sidebar(self.m, """for (let i = 0; i < 25; i++) { const menu = doc.getElementById("menu"); if (menu && !menu.hidden) return true; await sleep(40); } return false;""")

    def close_menus(self):
        """Tidier's own, and any of Firefox's, such as its tab menu."""
        in_sidebar(self.m, """doc.body.click();""")
        self.m.js(CLOSE_FIREFOX_MENUS)


def check_shown(m, space):
    """That the pictures show what is in the space, and no leftover. A note, not a failure:
    the sidebar's parts may change while this file does not."""
    shown = in_sidebar(m, """const n = selector => doc.querySelectorAll(selector).length, notice = id => { const e = doc.getElementById(id); return e && !e.hidden ? e.textContent.trim() : ""; };
      return {essentials: n("#essentials .tile"), folders: n("#tabs .folder"), notices: notice("problem") + notice("hiding")};""")
    folders = len(space["folders"]) + (1 if space.get("live") else 0)
    if shown["essentials"] != len(space["essentials"]) or shown["folders"] != folders or shown["notices"]:
        print(f"(in {space['slug']}: {shown}, with {len(space['essentials'])} essentials and {folders} folders put in)", flush=True)


def by_hand(m, selector, cls):
    """The class on what would have it during a drag or with the keys: a real drag needs a
    drag session, which a headless Firefox does not start, and keys the sidebar in focus."""
    in_sidebar(m, """const e = doc.querySelector(args[0]); if (e) e.classList.toggle(args[1]);""", selector, cls)


def fold(m, closed):
    in_sidebar(m, """const port = await connect(), [closed] = args;
      for (const f of port.view().folders) if (f.name in closed) port.send({type: "foldFolder", key: f.key, collapsed: closed[f.name]});
      await until(() => port.view().folders.every(f => !(f.name in closed) || f.collapsed === closed[f.name]), "folders to fold");
      port.close();""", closed)


PERSONAL, WORK, STUDIO = SPACES
ROW = "#tabs .row.tab:not(.active):not(.unloaded)"
FOLDER_HEAD = "#tabs .folder .head"


def space_by_space(cam):
    for space in SPACES:
        select(cam.m, on_tab(space), space["ctx"])
        check_shown(cam.m, space)
        for px in WIDTHS:
            cam.width(px)
            cam.shoot(f"sidebar-{space['slug']}-{px}")
        cam.width(WIDTH)
        cam.shoot(f"window-{space['slug']}", whole_window=True)


def hover(cam):
    select(cam.m, on_tab(PERSONAL), PERSONAL["ctx"])
    for name, selector in (("row", ROW), ("row-unloaded", "#tabs .row.tab.unloaded"), ("row-selected", "#tabs .row.tab.active"), ("close", ROW + " .close"),
                           ("folder", FOLDER_HEAD), ("tile", "#essentials .tile:not(.active)"), ("new-tab", "#new-tab"), ("new-folder", "#new-folder"), ("space", "#spaces .space:not(.active)")):
        if cam.wanted(f"hover-{name}") and cam.point_at(selector):
            cam.shoot(f"hover-{name}")
    cam.mouse_away()


def menus(cam):
    select(cam.m, on_tab(PERSONAL), PERSONAL["ctx"])
    # A tab's menu may be Firefox's own, which is no part of the window a picture can show.
    for name, selector in (("menu-folder", FOLDER_HEAD), ("menu-tab", ROW)):
        at = cam.wanted(name) and cam.point_at(selector)
        if at and cam.right_click(*at):
            cam.shoot(name)
        cam.close_menus()
        cam.mouse_away()
    select(cam.m, on_tab(STUDIO), STUDIO["ctx"])
    if cam.wanted("menu-list"):  # on the empty part of the list
        box = cam.sidebar_box()
        if cam.right_click(box["x"] + WIDTH / 2, box["y"] + box["height"] * 2 / 3):
            cam.shoot("menu-list")
        cam.close_menus()
        cam.mouse_away()


def folders_closed(cam):
    """Every folder closed, with the selected tab in one of them."""
    select(cam.m, on_tab(PERSONAL), PERSONAL["ctx"])
    fold(cam.m, {f["name"]: True for f in PERSONAL["folders"]})
    cam.shoot("state-folders-closed")
    fold(cam.m, {f["name"]: bool(f.get("closed")) for f in PERSONAL["folders"]})


def folder_rename(cam):
    m = cam.m
    select(m, on_tab(PERSONAL), PERSONAL["ctx"])
    in_sidebar(m, """doc.querySelector(args[0]).dispatchEvent(new page.MouseEvent("dblclick", clone({bubbles: true})));""", FOLDER_HEAD)  # without the two clicks before it, which fold
    cam.shoot("state-folder-rename")
    in_sidebar(m, """doc.querySelector("#tabs input").dispatchEvent(new page.KeyboardEvent("keydown", clone({key: "Escape", bubbles: true})));""")


def marks(cam):
    select(cam.m, on_tab(PERSONAL), PERSONAL["ctx"])
    for name, selector, cls in (("drop-between", ROW, "drop-after"), ("drop-into-folder", FOLDER_HEAD, "drop-into"), ("drop-on-essentials", "#essentials", "drop-into"), ("keyboard-cursor", ROW, "cursor")):
        by_hand(cam.m, selector, cls)
        cam.shoot(f"state-{name}")
        by_hand(cam.m, selector, cls)


def notices(cam):
    """By hand, with made-up words: the real ones take a fault."""
    select(cam.m, on_tab(PERSONAL), PERSONAL["ctx"])
    in_sidebar(cam.m, """doc.getElementById("hiding").hidden = false;
      doc.getElementById("problem").hidden = false; doc.getElementById("problem").textContent = 'Live folder "Pull requests" is not updating: no answer';""")
    cam.shoot("state-notices")
    in_sidebar(cam.m, """doc.getElementById("hiding").hidden = true; doc.getElementById("problem").hidden = true;""")


def scrolled(cam):
    select(cam.m, on_tab(WORK), WORK["ctx"])
    # With the scrollbar, as while you scroll: here it stays, unlike everywhere else (main).
    cam.m.js("""Services.prefs.setIntPref("ui.scrollbarFadeBeginDelay", 60000); return 1;""")
    in_sidebar(cam.m, """doc.getElementById("tabs").scrollTop = 420;""")
    cam.shoot("state-scrolled")
    cam.m.js("""Services.prefs.setIntPref("ui.scrollbarFadeBeginDelay", 0); return 1;""")
    in_sidebar(cam.m, """doc.getElementById("tabs").scrollTop = 0;""")


def empty_spaces(cam):
    """A space is without tabs for a moment only: going there opens a new tab, as does closing
    its last one. So this is what an empty space looks like in use."""
    m, ctx = cam.m, EMPTY["ctx"]
    in_sidebar(m, """doc.querySelector(`#spaces .space[data-space="${args[0]}"]`).click();
      await until(() => doc.documentElement.dataset.space === args[0] && doc.querySelector("#tabs .tab"), "the empty space");""", f"firefox-container-{ctx}")
    cam.shoot("state-empty-space")
    # No essentials: tabs, loaded and unloaded.
    urls = [m.pages + t["path"] for t in (T("Timetables", "globe"), T("Hotels near the station", "star"))]
    m.js(CHROME + """const [urls, ctx] = args;
      for (const url of urls) gB.addTrustedTab(url, {userContextId: ctx, inBackground: true});
      for (let i = 0; i < 100 && urls.some(u => !byUrl(u)?.image); i++) await wait(50);
      gB.discardBrowser(byUrl(urls[1])); await wait(300); return 1;""", urls, ctx)
    cam.shoot("state-no-essentials")
    # No tabs: only essentials, the selected one among them.
    m.js(CHROME + """const [urls, ctx] = args;
      gB.selectedTab = byUrl(urls[0]); await wait(200);
      for (const url of urls) { gB.pinTab(byUrl(url)); await wait(100); }
      for (const t of [...gB.tabs]) if (t.userContextId === ctx && !t.pinned) gB.removeTab(t);
      await wait(500); return 1;""", urls, ctx)
    cam.shoot("state-no-tabs")


def settings(cam):
    """The settings page, in a tab as it always is, with something in its lists."""
    m = cam.m
    if not cam.wanted("settings"):
        return
    in_sidebar(m, """await page.browser.runtime.sendMessage(clone({type: "settings:rules", rules: [{url: "calendar.example.org", space: "firefox-container-2"}, {url: "/^https:\\\\/\\\\/shop\\\\./", space: "firefox-container-1"}]}));""")
    m.js(CHROME + """const uuid = JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))[args[0]];
      gB.selectedTab = gB.addTrustedTab("moz-extension://" + uuid + "/settings/settings.html", {}); await wait(800); return 1;""", testfirefox.EXT_ID)
    for scheme in SCHEMES:
        if cam.wanted(f"settings-{scheme}"):
            cam.scheme(scheme)
            time.sleep(0.4)
            m.cmd("Marionette:SetContext", {"value": "content"})
            for handle in m.cmd("WebDriver:GetWindowHandles"):
                m.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": False})
                if "/settings/settings.html" in m.cmd("WebDriver:GetCurrentURL"):
                    break
            cam.write(f"settings-{scheme}", m.cmd("WebDriver:TakeScreenshot", {"full": True}))
            m.chrome()


STEPS = (space_by_space, hover, menus, folders_closed, folder_rename, marks, notices, scrolled, empty_spaces, settings)


def take_pictures(cam):
    # What says it is remote controlled would otherwise be in every picture of the window.
    cam.m.js(CHROME + """w.document.documentElement.removeAttribute("remotecontrol"); return 1;""")
    for step in STEPS:
        # The sidebar's parts are being worked on, which is why it is being looked at:
        # one that has changed costs its pictures, not the others'.
        try:
            step(cam)
        except RuntimeError as err:
            print(f"(no pictures from {step.__name__}: {err})", flush=True)
            cam.m.chrome()


# --- Starting ---------------------------------------------------------------------------
def take_port(first=FIRST_PORT):
    """The first free port from `first` up, kept for this run with a lock: two runs
    starting at the same moment would otherwise both find the same port free."""
    for port in range(first, first + 50):
        lock = open(os.path.join(tempfile.gettempdir(), f"tidier-shoot-{port}.lock"), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock.close()
            continue
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)):
                return port, lock
        lock.close()
    raise SystemExit(f"No free port from {first} up")


def main():
    parser = argparse.ArgumentParser(description="Pictures of what Tidier draws.")
    parser.add_argument("folder", help="where the PNGs go")
    parser.add_argument("--port", type=int, help=f"the test Firefox's Marionette port (default: the first free from {FIRST_PORT} up)")
    parser.add_argument("--scale", default="2", help="device pixels per CSS pixel (default: 2)")
    parser.add_argument("--only", default="", help="only pictures with one of these words in the name, with commas: hover,settings,dark")
    args = parser.parse_args()
    os.makedirs(args.folder, exist_ok=True)
    only = [word for word in args.only.split(",") if word]
    port, lock = (args.port, None) if args.port else take_port()

    start = time.time()
    testfirefox.TEST_PREFS.update({
        "layout.css.devPixelsPerPx": args.scale,
        # What comes and goes by itself would make two runs differ: a scrollbar that shows
        # for a moment when a list changes size, and the blink of a caret.
        "ui.scrollbarFadeBeginDelay": 0, "ui.scrollbarFadeDuration": 0, "ui.caretBlinkTime": 0,
    })
    with TestFirefox(port=port, alone=True) as m:
        m.cmd("WebDriver:SetWindowRect", {"width": WINDOW[0], "height": WINDOW[1]})
        fill(m)
        filled = time.time()
        cam = Camera(m, args.folder, only)
        take_pictures(cam)
    print(f"{cam.count} pictures in {os.path.abspath(args.folder)} ({filled - start:.0f} s to set up, {time.time() - filled:.0f} s of pictures)")


if __name__ == "__main__":
    main()
