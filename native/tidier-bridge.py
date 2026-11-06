#!/usr/bin/python3 -I
"""The bridge between Firefox and agents: a native messaging host for Tidier.

    agent <-stdio/MCP-> tidier-mcp.py <-Unix socket-> this <-native messaging-> bridge.js

Tidier starts this with connectNative only while the bridge is on, and it lives
exactly as long as that port: when Firefox closes the port (Stop, turning it off,
Firefox quitting or crashing) its stdin ends, and the socket and the process go at
once. So with the bridge off there is no process and no socket.

This part only carries messages. It decides nothing and does nothing on behalf of
a message: what an agent may see and touch is decided in the extension (bridge.js),
and no message can make this open a file or run anything. Web pages cannot reach it
at all: they cannot call connectNative, and the extension's content script is never
told about this port.

The socket is the only way in, never TCP. It is $XDG_CONFIG_HOME/tidier/bridge.sock
(default ~/.config/tidier/), mode 0600, so only you can connect, and each connection's
user is checked as well.
"""
import errno
import json
import os
import signal
import socket
import stat
import struct
import sys
import threading

HOME = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "tidier")
SOCKET_NAME = "bridge.sock"
# Firefox refuses a message over 1 MB from a native host, and closes the port for it;
# what an agent asks for is small (what comes back the other way may be up to 4 GB,
# and is capped in bridge.js).
MAX_REQUEST = 256 * 1024
MAX_CONNECTIONS = 8
MAX_WAITING = 16  # calls under way per connection
SEND_TIMEOUT_S = 10  # an agent that stops reading must not hold up the others (set with SO_SNDTIMEO, not settimeout, which reading in another thread would see)


class Refused(Exception):
    """Something is wrong with where the socket should be: say so, and do not touch it."""


def open_home():
    """The folder of the socket, as an open descriptor, after making sure it is ours.

    Worked on through the descriptor from here on, so nothing can swap the folder in
    between, and a long path is no problem either (a socket's path may have about 100
    characters).
    """
    os.makedirs(os.path.dirname(HOME), exist_ok=True)
    try:
        os.mkdir(HOME, 0o700)
    except FileExistsError:
        pass
    try:
        fd = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as err:
        raise Refused(f"{HOME} is not a plain folder: {err.strerror}") from err
    info = os.fstat(fd)
    if info.st_uid != os.getuid():
        os.close(fd)
        raise Refused(f"{HOME} belongs to someone else")
    if info.st_mode & 0o022:  # others must not be able to put anything in it
        os.fchmod(fd, stat.S_IMODE(info.st_mode) & ~0o022)
    return fd


def listen():
    """Make the socket, or raise Refused. The working directory becomes its folder."""
    fd = open_home()
    os.fchdir(fd)
    os.close(fd)
    try:
        found = os.lstat(SOCKET_NAME)
    except FileNotFoundError:
        found = None
    if found:
        if not stat.S_ISSOCK(found.st_mode) or found.st_uid != os.getuid():
            raise Refused(f"something else is at {os.path.join(HOME, SOCKET_NAME)}; it was left alone")
        with socket.socket(socket.AF_UNIX) as probe:
            try:
                probe.connect(SOCKET_NAME)
            except OSError as err:
                if err.errno != errno.ECONNREFUSED:
                    raise Refused(f"{os.path.join(HOME, SOCKET_NAME)}: {err.strerror}") from err
            else:
                raise Refused("another Firefox has the bridge open")
        os.unlink(SOCKET_NAME)  # what a crash left behind
    server = socket.socket(socket.AF_UNIX)
    old = os.umask(0o177)  # 0600 from its first moment, not a chmod afterwards
    try:
        server.bind(SOCKET_NAME)
    finally:
        os.umask(old)
    made = os.lstat(SOCKET_NAME)
    if stat.S_IMODE(made.st_mode) != 0o600 or made.st_uid != os.getuid():
        os.unlink(SOCKET_NAME)
        raise Refused("the socket did not get mode 0600")
    server.listen(MAX_CONNECTIONS)
    return server, made.st_ino


def peer_uid(conn):
    """Who is at the other end. Firefox's manifest and the mode keep others out already."""
    if hasattr(socket, "SO_PEERCRED"):  # Linux
        return struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[1]
    # macOS: LOCAL_PEERCRED (SOL_LOCAL is 0) gives a struct xucred: version, uid, ...
    return struct.unpack("2I", conn.getsockopt(0, getattr(socket, "LOCAL_PEERCRED", 1), 76)[:8])[1]


# --- To and from Firefox -------------------------------------------------------------
stdout_lock = threading.Lock()


def to_firefox(message):
    data = json.dumps(message).encode()
    with stdout_lock:
        sys.stdout.buffer.write(struct.pack("@I", len(data)) + data)
        sys.stdout.buffer.flush()


def from_firefox():
    """One message, or None when the port is closed."""
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return None
    (length,) = struct.unpack("@I", head)
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    return json.loads(body)


# --- The agents' connections ---------------------------------------------------------
waiting = {}  # the id given to Firefox -> (connection, the id the agent gave)
waiting_lock = threading.Lock()
connections = threading.BoundedSemaphore(MAX_CONNECTIONS)
next_id = 0


def answer(conn, message):
    try:
        conn.sendall(json.dumps(message).encode() + b"\n")
    except OSError:
        try:
            conn.shutdown(socket.SHUT_RDWR)  # ends the reading in serve_connection, which tidies up
        except OSError:
            pass


def handle_line(conn, serial, line):
    global next_id
    try:
        message = json.loads(line)
        client_id = message["id"]
        tool, args = message["tool"], message.get("args", {})
        if not isinstance(tool, str) or not isinstance(args, dict) or not isinstance(client_id, (int, str)):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        answer(conn, {"id": None, "ok": False, "error": "Not a request."})
        return
    with waiting_lock:
        if sum(1 for c, _ in waiting.values() if c is conn) >= MAX_WAITING:
            busy = True
        else:
            busy = False
            next_id += 1
            wrapped = f"{serial}:{next_id}"
            waiting[wrapped] = (conn, client_id)
    if busy:
        answer(conn, {"id": client_id, "ok": False, "error": "Too many calls at once."})
        return
    to_firefox({"type": "call", "id": wrapped, "tool": tool, "args": args})


def serve_connection(conn, serial):
    buffer = b""
    try:
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDTIMEO, struct.pack("@ll", SEND_TIMEOUT_S, 0))
        while True:
            data = conn.recv(65536)
            if not data:
                return
            buffer += data
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if line.strip():
                    if len(line) > MAX_REQUEST:
                        answer(conn, {"id": None, "ok": False, "error": "That request is too big."})
                        return
                    handle_line(conn, serial, line)
            if len(buffer) > MAX_REQUEST:
                answer(conn, {"id": None, "ok": False, "error": "That request is too big."})
                return
    except OSError:
        return
    finally:
        with waiting_lock:
            for wrapped in [w for w, (c, _) in waiting.items() if c is conn]:
                del waiting[wrapped]
        conn.close()
        connections.release()


def accept_connections(server):
    serial = 0
    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            return
        try:
            if peer_uid(conn) != os.getuid():
                conn.close()
                continue
        except OSError:
            conn.close()
            continue
        if not connections.acquire(blocking=False):
            answer(conn, {"id": None, "ok": False, "error": "Too many agents at once."})
            conn.close()
            continue
        serial += 1
        threading.Thread(target=serve_connection, args=(conn, serial), daemon=True).start()


def main():
    try:
        server, inode = listen()
    except (Refused, OSError) as err:
        to_firefox({"type": "error", "message": str(err)})
        return

    def clean_up(*_):
        # Only our own: a socket another Firefox has made since is left alone.
        try:
            if os.lstat(SOCKET_NAME).st_ino == inode:
                os.unlink(SOCKET_NAME)
        except OSError:
            pass
        os._exit(0)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, clean_up)
    threading.Thread(target=accept_connections, args=(server,), daemon=True).start()
    to_firefox({"type": "ready", "server": os.path.join(os.path.dirname(os.path.realpath(__file__)), "tidier-mcp.py")})
    try:
        while True:
            message = from_firefox()
            if message is None:
                break
            with waiting_lock:
                found = waiting.pop(message.get("id"), None)
            if found:
                conn, client_id = found
                answer(conn, {**message, "id": client_id})
    finally:
        clean_up()


if __name__ == "__main__":
    main()
