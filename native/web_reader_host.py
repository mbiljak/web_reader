#!/usr/bin/env python3
"""Native messaging host: bridges the Web Reader extension to the macOS `say` command.

Protocol (Firefox native messaging): each message is a 4-byte native-endian
length prefix followed by UTF-8 JSON.

Messages in:  {"type":"speak","id":N,"text":...,"voice":...,"rate":wpm}
              {"type":"stop"} / {"type":"pause"} / {"type":"resume"}
              {"type":"voices"}
Messages out: {"type":"end","id":N}
              {"type":"voices","voices":[{"name":...,"lang":...}]}
              {"type":"error","message":...}
"""
import sys
import os
import re
import json
import struct
import signal
import threading
import subprocess

_send_lock = threading.Lock()
_state_lock = threading.Lock()
_proc = None          # current `say` subprocess
_current_id = None    # id of the sentence currently being spoken


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("@I", raw_len)[0]
    data = sys.stdin.buffer.read(msg_len)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    with _send_lock:
        sys.stdout.buffer.write(struct.pack("@I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def kill_current():
    global _proc, _current_id
    with _state_lock:
        p = _proc
        _proc = None
        _current_id = None
    if p and p.poll() is None:
        try:
            p.kill()
        except Exception:
            pass


def handle_speak(msg):
    global _proc, _current_id
    kill_current()

    text = msg.get("text", "")
    voice = msg.get("voice") or None
    rate = msg.get("rate")
    msg_id = msg.get("id")

    args = ["say"]
    if voice:
        args += ["-v", voice]
    if rate:
        try:
            args += ["-r", str(int(rate))]
        except (ValueError, TypeError):
            pass

    try:
        # say reads from stdin when no text operand is supplied
        p = subprocess.Popen(args, stdin=subprocess.PIPE)
    except Exception as e:
        send_message({"type": "error", "message": "Failed to launch say: %s" % e})
        return

    with _state_lock:
        _proc = p
        _current_id = msg_id

    try:
        p.stdin.write(text.encode("utf-8"))
        p.stdin.close()
    except Exception:
        pass

    def waiter(proc, mid):
        proc.wait()
        with _state_lock:
            still_current = (_current_id == mid and _proc is proc)
        if still_current:
            send_message({"type": "end", "id": mid})

    threading.Thread(target=waiter, args=(p, msg_id), daemon=True).start()


def handle_pause():
    with _state_lock:
        p = _proc
    if p and p.poll() is None:
        try:
            p.send_signal(signal.SIGSTOP)
        except Exception:
            pass


def handle_resume():
    with _state_lock:
        p = _proc
    if p and p.poll() is None:
        try:
            p.send_signal(signal.SIGCONT)
        except Exception:
            pass


def handle_voices():
    try:
        out = subprocess.check_output(["say", "-v", "?"]).decode("utf-8", "replace")
    except Exception as e:
        send_message({"type": "error", "message": "Could not list voices: %s" % e})
        send_message({"type": "voices", "voices": []})
        return

    voices = []
    pattern = re.compile(r"^(.+?)\s{2,}([a-z]{2}[-_][A-Z]{2})\b")
    for line in out.splitlines():
        m = pattern.match(line)
        if m:
            voices.append({"name": m.group(1).strip(), "lang": m.group(2)})
    send_message({"type": "voices", "voices": voices})


def main():
    while True:
        try:
            msg = read_message()
        except Exception:
            break
        if msg is None:
            break

        mtype = msg.get("type")
        if mtype == "speak":
            handle_speak(msg)
        elif mtype == "stop":
            kill_current()
        elif mtype == "pause":
            handle_pause()
        elif mtype == "resume":
            handle_resume()
        elif mtype == "voices":
            handle_voices()

    kill_current()


if __name__ == "__main__":
    main()
