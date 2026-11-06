# Minimal Marionette client (Firefox's built-in remote control). The tests use
# it with their own headless Firefox (testfirefox.py). The helpers below
# restart *your* Firefox with remote control; only tools/fix_spaces.py uses
# them, since it has to change your own Sidebery.
import json
import os
import socket
import subprocess
import time

# Which Firefox: TIDIER_FIREFOX (the program, or a .app), default the one in /Applications.
FIREFOX = os.environ.get("TIDIER_FIREFOX", "/Applications/Firefox.app")
if FIREFOX.endswith(".app"):
    FIREFOX = os.path.join(FIREFOX, "Contents", "MacOS", "firefox")
elif os.path.isdir(FIREFOX):
    FIREFOX = os.path.join(FIREFOX, "firefox")


class Marionette:
    def __init__(self, port=2828, wait=90, alive=None):
        deadline = time.time() + wait
        while True:
            if alive and not alive():
                raise ConnectionError("Firefox has quit")
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=180)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(1)
        self.buf, self.msgid = b"", 0
        self._recv()  # hello
        self.cmd("WebDriver:NewSession", {"capabilities": {}})
        self.cmd("WebDriver:SetTimeouts", {"script": 170000})
        self.chrome()

    def _read(self):
        # An empty read means Firefox has gone away; waiting on would spin for ever.
        data = self.sock.recv(65536)
        if not data:
            raise ConnectionError("Firefox closed the connection")
        return data

    def _recv(self):
        while b":" not in self.buf:
            self.buf += self._read()
        n, rest = self.buf.split(b":", 1)
        n = int(n)
        while len(rest) < n:
            rest += self._read()
        self.buf = rest[n:]
        return json.loads(rest[:n])

    def cmd(self, name, params=None):
        self.msgid += 1
        msg = json.dumps([0, self.msgid, name, params or {}]).encode()
        self.sock.sendall(str(len(msg)).encode() + b":" + msg)
        reply = self._recv()
        if reply[2]:
            raise RuntimeError(f"{name}: {reply[2].get('error')}: {reply[2].get('message')}")
        value = reply[3]
        return value.get("value", value) if isinstance(value, dict) else value

    def chrome(self):
        """Run scripts in the browser UI (privileged), in the first window."""
        self.cmd("Marionette:SetContext", {"value": "chrome"})
        handles = self.cmd("WebDriver:GetWindowHandles")
        self.cmd("WebDriver:SwitchToWindow", {"handle": handles[0], "focus": False})

    def js(self, body, *args):
        """Run an async function body in the current context; `args` is available."""
        return self.cmd("WebDriver:ExecuteScript", {
            "script": f"return (async (args) => {{ {body} }})(arguments);", "args": list(args)})

    def quit(self):
        try:
            self.cmd("Marionette:Quit", {"flags": ["eAttemptQuit"]})
        except Exception:
            pass


def firefox_running():
    return subprocess.run(["pgrep", "-x", "firefox"], capture_output=True).returncode == 0


def wait_until_closed(timeout=60):
    for _ in range(timeout):
        if not firefox_running():
            return
        time.sleep(1)
    raise RuntimeError("Firefox did not quit")


def start_with_marionette():
    """Quit Firefox (keeping the session) and start it with Marionette enabled."""
    if firefox_running():
        subprocess.run(["osascript", "-e", 'quit app "Firefox"'], capture_output=True)
        wait_until_closed()
    # System access lets Marionette script the browser UI, not only web pages.
    subprocess.Popen([FIREFOX, "--marionette"], env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"},
                     start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    m = Marionette()
    time.sleep(5)  # let the session restore and Sidebery start
    return m


def restart_normally(m):
    """Quit the remote-controlled Firefox and start it the normal way."""
    m.quit()
    wait_until_closed()
    subprocess.run(["open", "-a", "Firefox"], check=True)
