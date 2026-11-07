"""A small MCP client for the tests: starts native/tidier-mcp.py the way an agent does,
and talks to it over its stdin and stdout, one JSON message per line."""
import json
import os
import select
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "native", "tidier-mcp.py")


class Mcp:
    def __init__(self, config_home):
        env = {**os.environ, "XDG_CONFIG_HOME": config_home}
        self.proc = subprocess.Popen([sys.executable, "-I", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.next_id = 0

    def request(self, method, params=None, timeout=70):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        return self.receive(timeout)

    def send(self, message):
        self.proc.stdin.write(json.dumps(message).encode() + b"\n")
        self.proc.stdin.flush()

    def receive(self, timeout=70):
        ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
        if not ready:
            raise TimeoutError("the MCP server gave no answer")
        return json.loads(self.proc.stdout.readline())

    def handshake(self):
        reply = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return reply["result"]

    def call(self, name, **args):
        """A tool call: (text of the answer, whether it is an error, the whole content)."""
        result = self.request("tools/call", {"name": name, "arguments": args})["result"]
        text = "\n".join(c["text"] for c in result["content"] if c["type"] == "text")
        return text, bool(result.get("isError")), result["content"]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(5)
        self.proc.stdout.close()
