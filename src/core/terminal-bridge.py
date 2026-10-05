"""Bridge a local POSIX pseudoterminal to a bounded JSON-line protocol."""
import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    shell = os.environ.get("SHELL", "/bin/bash")
    os.environ["TERM"] = "xterm"
    os.environ["HISTFILE"] = "/dev/null"
    os.execv(shell, [shell, "-i"])


def stop(*_):
    groups = {pid}
    try:
        groups.add(os.tcgetpgrp(master))
    except OSError:
        pass
    for group in groups:
        try:
            os.killpg(group, signal.SIGTERM)
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
pending = b""
decoder = codecs.getincrementaldecoder("utf-8")("replace")
while True:
    ready, _, _ = select.select([master, sys.stdin.buffer], [], [])
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        print(json.dumps({"data": decoder.decode(data)}), flush=True)
    if sys.stdin.buffer in ready:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            stop()
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            message = json.loads(line)
            if "data" in message:
                os.write(master, message["data"].encode("utf-8"))
            if "cols" in message:
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", message["rows"], message["cols"], 0, 0))
_, status = os.waitpid(pid, 0)
print(json.dumps({"exitCode": os.waitstatus_to_exitcode(status)}), flush=True)
