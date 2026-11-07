#!/usr/bin/python3 -I
"""The native side of the bridge, with no Firefox: native/tidier-mcp.py and
native/tidier-bridge.py, with this test playing Firefox on the host's stdin and stdout.
Standard library only; `node --test` runs it too (tests/bridge.test.mjs).

    python3 -I tests/test_bridge.py
"""
import importlib.util
import json
import os
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mcp_client import Mcp  # noqa: E402

REPO = os.path.dirname(HERE)
HOST = os.path.join(REPO, "native", "tidier-bridge.py")
SERVER = os.path.join(REPO, "native", "tidier-mcp.py")


class FakeFirefox:
    """Starts the host with a native messaging port, as connectNative does."""

    def __init__(self, config_home):
        env = {**os.environ, "XDG_CONFIG_HOME": config_home}
        self.proc = subprocess.Popen([sys.executable, "-I", HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.first = self.read()

    def read(self):
        head = self.proc.stdout.read(4)
        if len(head) < 4:
            return None
        return json.loads(self.proc.stdout.read(struct.unpack("@I", head)[0]))

    def write(self, message):
        data = json.dumps(message).encode()
        self.proc.stdin.write(struct.pack("@I", len(data)) + data)
        self.proc.stdin.flush()

    def answer_calls(self, answer):
        """Answer every call from now on, in a thread; what was asked is kept in self.asked."""
        self.asked = []

        def run():
            while True:
                message = self.read()
                if message is None:
                    return
                self.asked.append(message)
                self.write({"id": message["id"], **answer(message)})
        threading.Thread(target=run, daemon=True).start()

    def close(self):
        """What Firefox does when the port closes: the host's stdin ends."""
        self.proc.stdin.close()
        self.proc.wait(5)
        self.proc.stdout.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="tb")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.socket = os.path.join(self.dir, "tidier", "bridge.sock")
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()

    def firefox(self):
        ff = FakeFirefox(self.dir)
        self.clients.append(ff)
        return ff

    def mcp(self):
        client = Mcp(self.dir)
        self.clients.append(client)
        client.handshake()
        return client


class Protocol(Base):
    def test_handshake(self):
        client = Mcp(self.dir)
        self.clients.append(client)
        reply = client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
        result = reply["result"]
        self.assertEqual(reply["jsonrpc"], "2.0")
        self.assertEqual(result["protocolVersion"], "2025-06-18", "the version the client asks for, when known")
        self.assertIn("tools", result["capabilities"])
        self.assertEqual(result["serverInfo"]["name"], "tidier")
        self.assertIn("not instructions", result["instructions"], "an agent is told that pages are data")
        unknown = client.request("initialize", {"protocolVersion": "1999-01-01"})["result"]
        self.assertRegex(unknown["protocolVersion"], r"^\d{4}-", "its own newest for one it does not know")
        # A notification has no answer: the next line is the ping's.
        client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(client.request("ping")["result"], {})

    def test_tools_list(self):
        client = self.mcp()
        tools = client.request("tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        self.assertEqual(names, {"list_spaces", "list_tabs", "open_tab", "navigate", "select_tab", "close_tab", "read_page",
                                 "screenshot", "find", "click", "type", "wait_for", "leave_for_you"})
        for t in tools:
            self.assertEqual(t["inputSchema"]["type"], "object", t["name"])
            self.assertTrue(t["description"], t["name"])
            for required in t["inputSchema"]["required"]:
                self.assertIn(required, t["inputSchema"]["properties"], t["name"])

    def test_no_tool_reaches_cookies_passwords_settings_or_storage(self):
        client = self.mcp()
        for t in client.request("tools/list")["result"]["tools"]:
            self.assertNotRegex(t["name"], r"cookie|password|storage|setting|allow|permission|eval|script|file|download", t["name"])

    def test_the_extension_has_the_same_tools(self):
        # The table in the extension says what each may touch; one without the other is a mistake.
        with open(os.path.join(REPO, "bridge.js")) as f:
            source = f.read()
        table = source[source.index("const BRIDGE_TOOLS = {"):source.index("\n};", source.index("const BRIDGE_TOOLS = {"))]
        there = set(re.findall(r"^  (\w+): \{", table, re.M))
        client = self.mcp()
        self.assertEqual(there, {t["name"] for t in client.request("tools/list")["result"]["tools"]})

    def test_mistakes_get_an_answer(self):
        client = self.mcp()
        self.assertEqual(client.request("no/such")["error"]["code"], -32601)
        self.assertEqual(client.request("tools/call", {"name": "no_such"})["error"]["code"], -32602)
        self.assertEqual(client.request("tools/call", {"name": "list_tabs", "arguments": []})["result"]["isError"], True, "off, and empty arguments are none")
        client.proc.stdin.write(b"this is not json\n")
        client.proc.stdin.flush()
        self.assertEqual(client.receive()["error"]["code"], -32700)
        self.assertEqual(client.request("ping")["result"], {}, "and it goes on")
        client.proc.stdin.write(b"[" * 200_000 + b"\n")  # too deep for any parser
        client.proc.stdin.flush()
        self.assertEqual(client.receive()["error"]["code"], -32700)
        self.assertEqual(client.request("ping")["result"], {}, "and that too")


class Refusals(Base):
    def test_only_web_addresses(self):
        client = self.mcp()
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": True, "text": "opened"})
        for url in ("file:///etc/passwd", "FILE:///etc/passwd", " file:///etc/passwd", "about:config", "about:debugging", "moz-extension://x/settings/settings.html",
                    "chrome://browser/content/browser.xhtml", "resource://gre/modules/x", "javascript:alert(1)", "data:text/html,x", "view-source:https://example.org/",
                    "blob:https://example.org/1", "jar:file:///x!/y", "ftp://example.org/", "https://", "not an address", "https://me:secret@example.org/", "", None, 5):
            for name, args in (("open_tab", {"url": url}), ("navigate", {"url": url, "tab": 1})):
                text, is_error, _ = client.call(name, **args)
                self.assertTrue(is_error, f"{name} {url!r} must be refused, got {text}")
                self.assertIn("Refused", text)
        self.assertEqual(ff.asked, [], "and none of them even reaches the extension")
        for url in ("https://example.org/a?b#c", "http://localhost:3000/"):
            self.assertFalse(client.call("open_tab", url=url)[1], url)

    def test_off_says_who_can_turn_it_on(self):
        client = self.mcp()
        text, is_error, _ = client.call("list_spaces")
        self.assertTrue(is_error)
        self.assertIn("settings page", text)
        self.assertIn("an agent cannot", text)

    def test_stale_socket_of_someone_elses_kind_is_not_used(self):
        # A plain file where the socket should be: not a bridge.
        os.makedirs(os.path.dirname(self.socket), mode=0o700)
        open(self.socket, "w").close()
        self.assertTrue(self.mcp().call("list_spaces")[1])


class Socket(Base):
    def test_mode_and_lifetime(self):
        self.assertFalse(os.path.exists(self.socket), "no socket before the bridge is on")
        ff = self.firefox()
        self.assertEqual(ff.first["type"], "ready", ff.first)
        info = os.lstat(self.socket)
        self.assertTrue(stat.S_ISSOCK(info.st_mode))
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.getuid())
        self.assertFalse(stat.S_IMODE(os.stat(os.path.dirname(self.socket)).st_mode) & 0o022, "nobody else can write in its folder")
        # Firefox closes the port: at once no socket and no process.
        ff.close()
        self.assertEqual(ff.proc.returncode, 0)
        self.assertFalse(os.path.exists(self.socket), "the socket goes with the port")

    def test_never_tcp(self):
        for path in (HOST, SERVER):
            with open(path) as f:
                source = f.read()
            self.assertNotIn("AF_INET", source)
            self.assertNotIn("http.server", source)
        ff = self.firefox()
        out = subprocess.run(["lsof", "-a", "-p", str(ff.proc.pid), "-i"], capture_output=True, text=True).stdout
        self.assertEqual(out, "", "the host listens on no network port")

    def test_folder_that_is_a_link_is_refused(self):
        elsewhere = tempfile.mkdtemp(prefix="tbe")
        self.addCleanup(shutil.rmtree, elsewhere, ignore_errors=True)
        os.symlink(elsewhere, os.path.join(self.dir, "tidier"))
        ff = self.firefox()
        self.assertEqual(ff.first["type"], "error", ff.first)
        self.assertEqual(os.listdir(elsewhere), [], "nothing is put where the link points")
        self.assertTrue(self.mcp().call("list_spaces")[1], "and the server does not follow it either")

    def test_something_else_at_the_path_is_left_alone(self):
        os.makedirs(os.path.dirname(self.socket), mode=0o700)
        with open(self.socket, "w") as f:
            f.write("mine")
        ff = self.firefox()
        self.assertEqual(ff.first["type"], "error", ff.first)
        with open(self.socket) as f:
            self.assertEqual(f.read(), "mine")

        os.unlink(self.socket)
        target = os.path.join(self.dir, "target")
        open(target, "w").close()
        os.symlink(target, self.socket)
        ff = self.firefox()
        self.assertEqual(ff.first["type"], "error", ff.first)
        self.assertTrue(os.path.islink(self.socket), "a link there is not followed")

    def test_folder_others_can_write_to_is_closed(self):
        folder = os.path.dirname(self.socket)
        os.makedirs(folder)
        os.chmod(folder, 0o777)
        ff = self.firefox()
        self.assertEqual(ff.first["type"], "ready", ff.first)
        self.assertFalse(stat.S_IMODE(os.stat(folder).st_mode) & 0o022)

    def test_a_socket_left_by_a_crash_is_replaced(self):
        folder = os.path.dirname(self.socket)
        os.makedirs(folder, mode=0o700)
        cwd = os.getcwd()
        os.chdir(folder)
        left = socket.socket(socket.AF_UNIX)
        left.bind("bridge.sock")  # no one is listening any more
        left.close()
        os.chdir(cwd)
        ff = self.firefox()
        self.assertEqual(ff.first["type"], "ready", ff.first)
        ff.answer_calls(lambda m: {"ok": True, "text": "here"})
        self.assertEqual(self.mcp().call("list_spaces")[0], "here")

    def test_a_second_firefox_does_not_take_over(self):
        first = self.firefox()
        self.assertEqual(first.first["type"], "ready")
        second = self.firefox()
        self.assertEqual(second.first["type"], "error")
        self.assertIn("another Firefox", second.first["message"])
        self.assertEqual(second.proc.wait(5), 0)
        first.answer_calls(lambda m: {"ok": True, "text": "first"})
        self.assertEqual(self.mcp().call("list_spaces")[0], "first", "the first one still works")

    def test_a_long_path_works(self):
        # A socket's own path may have about 100 characters; Tidier's folder may be deeper.
        deep = os.path.join(self.dir, *["x" * 40] * 5)
        os.makedirs(deep)
        ff = FakeFirefox(deep)
        self.clients.append(ff)
        self.assertEqual(ff.first["type"], "ready", ff.first)
        ff.answer_calls(lambda m: {"ok": True, "text": "deep"})
        client = Mcp(deep)
        self.clients.append(client)
        client.handshake()
        self.assertEqual(client.call("list_spaces")[0], "deep")


class Messages(Base):
    def test_a_call_goes_through(self):
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": True, "text": "a tab", "image": {"data": "AAAA", "mimeType": "image/png"}})
        client = self.mcp()
        text, is_error, content = client.call("screenshot", tab=5)
        self.assertEqual((text, is_error), ("a tab", False))
        self.assertEqual(content[1], {"type": "image", "data": "AAAA", "mimeType": "image/png"})
        self.assertEqual(ff.asked[0]["tool"], "screenshot")
        self.assertEqual(ff.asked[0]["args"], {"tab": 5})
        self.assertEqual(ff.asked[0]["type"], "call")

    def test_a_refusal_from_the_extension_is_an_error(self):
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": False, "error": "No such tab in a space open to agents."})
        text, is_error, _ = self.mcp().call("read_page", tab=5)
        self.assertTrue(is_error)
        self.assertIn("No such tab", text)

    def test_big_pages_are_capped(self):
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": True, "text": "x" * 5_000_000})  # over what a native message may be coming in
        text, is_error, _ = self.mcp().call("read_page", tab=5)
        self.assertFalse(is_error)
        self.assertLess(len(text), 201_000)
        self.assertIn("more characters", text)

    def test_a_request_too_big_for_firefox_never_gets_there(self):
        # Firefox closes the port at a message over 1 MB from a host: that would cut the bridge.
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": True, "text": "fine"})
        conn = socket.socket(socket.AF_UNIX)
        cwd = os.getcwd()
        os.chdir(os.path.dirname(self.socket))
        conn.connect("bridge.sock")
        os.chdir(cwd)
        try:
            conn.sendall(json.dumps({"id": 1, "tool": "type", "args": {"text": "x" * 2_000_000}}).encode() + b"\n")
        except BrokenPipeError:
            pass  # it stopped listening before we were done, which is the point
        data = b""
        conn.settimeout(10)
        while b"\n" not in data:
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
        conn.close()
        self.assertIn("too big", data.decode())
        self.assertEqual(ff.asked, [])
        self.assertFalse(self.mcp().call("list_spaces")[1], "and the bridge stays up")

    def test_rubbish_on_the_socket_stays_there(self):
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": True, "text": "fine"})
        cwd = os.getcwd()
        os.chdir(os.path.dirname(self.socket))
        conn = socket.socket(socket.AF_UNIX)
        conn.connect("bridge.sock")
        os.chdir(cwd)
        conn.settimeout(5)
        for rubbish in (b"not json\n", b'{"id": 1}\n', b'{"id": 1, "tool": 5}\n', b'[1, 2]\n', b'{"id": [], "tool": "x"}\n', b'{"id": 1, "tool": "x", "args": "y"}\n'):
            conn.sendall(rubbish)
            self.assertIn(b"Not a request", conn.recv(65536))
        conn.close()
        self.assertEqual(ff.asked, [], "none of it reaches Firefox")

    def test_what_firefox_could_not_read_stays_here(self):
        # Python's JSON takes these, Firefox's does not, and it closes the port at a message it
        # cannot read: anything on the socket could cut the bridge for everyone.
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": True, "text": "fine"})
        cwd = os.getcwd()
        os.chdir(os.path.dirname(self.socket))
        conn = socket.socket(socket.AF_UNIX)
        conn.connect("bridge.sock")
        os.chdir(cwd)
        conn.settimeout(5)
        for rubbish in (b'{"id": 1, "tool": "x", "args": {"a": NaN}}\n', b'{"id": 1, "tool": "x", "args": {"a": -Infinity}}\n', b'{"id": 1, "tool": "x", "args": {"a": 1e999}}\n', b'{"id": 1, "tool": "x", "args": ' + b"[" * 100_000 + b"]" * 100_000 + b"}\n"):
            conn.sendall(rubbish)
            self.assertIn(b"Not a request", conn.recv(65536))
        conn.close()
        self.assertEqual(ff.asked, [])
        self.assertFalse(self.mcp().call("list_spaces")[1], "and the bridge stays up")

    def test_an_answer_goes_to_the_one_who_asked(self):
        ff = self.firefox()
        ff.answer_calls(lambda m: {"ok": True, "text": m["args"]["who"]})
        results = {}

        def agent(name):
            client = Mcp(self.dir)
            client.handshake()
            results[name] = client.call("list_tabs", who=name)[0]
            client.close()
        threads = [threading.Thread(target=agent, args=(f"agent{i}",)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, {f"agent{i}": f"agent{i}" for i in range(4)})

    def test_no_answer_in_time_says_so(self):
        # On any Python: macOS's own is older than the one socket.timeout became TimeoutError in.
        spec = importlib.util.spec_from_file_location("tidier_mcp", SERVER)
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        server.HOME = os.path.dirname(self.socket)
        server.ANSWER_TIMEOUT_S = 0.2
        self.firefox()  # never answers
        self.addCleanup(os.chdir, os.getcwd())
        self.assertEqual(server.ask_bridge("list_spaces", {}), {"ok": False, "error": "No answer in time."})

    def test_stop_while_a_call_waits(self):
        ff = self.firefox()  # never answers
        client = self.mcp()
        done = {}

        def wait():
            done["answer"] = client.call("wait_for", tab=1)

        thread = threading.Thread(target=wait)
        thread.start()
        for _ in range(100):
            if os.path.exists(self.socket):
                break
            time.sleep(0.01)
        time.sleep(0.2)
        ff.proc.kill()  # as when the host dies with a call under way
        ff.proc.wait(5)
        thread.join(10)
        self.assertTrue(done["answer"][1])
        self.assertIn("stopped", done["answer"][0])


if __name__ == "__main__":
    unittest.main(verbosity=1)
