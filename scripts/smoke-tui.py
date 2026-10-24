"""Offline POSIX PTY smoke and optional asciicast: python3 scripts/smoke-tui.py [demo.cast]."""

import codecs
import errno
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
PROMPT = "检查中文输入与边框"
ANSWER = "Offline reply: 中文正常，no external API calls."
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\))")


class Provider(http.server.BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("content-length", "0"))
        if self.path != "/v1/responses" or self.headers.get("authorization") != "Bearer offline-smoke-key" or not 0 < size < 1_000_000:
            self.send_error(400)
            return
        request = json.loads(self.rfile.read(size))
        self.requests.append(request)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("x-codex-primary-used-percent", "75")
        self.send_header("x-codex-primary-reset-at", str(int(time.time()) + 3600))
        self.send_header("x-codex-primary-window-minutes", "300")
        self.end_headers()
        item = {"type": "message", "id": "msg_smoke", "status": "in_progress", "role": "assistant", "content": []}
        response = {"id": "resp_smoke", "object": "response", "status": "in_progress", "output": []}
        part = {"type": "output_text", "text": "", "annotations": []}

        def emit(kind, **fields):
            event = json.dumps({"type": kind, **fields}, ensure_ascii=False)
            self.wfile.write(f"event: {kind}\ndata: {event}\n\n".encode())
            self.wfile.flush()

        emit("response.created", response=response)
        emit("response.output_item.added", output_index=0, item=item)
        emit("response.content_part.added", output_index=0, content_index=0, part=part)
        for offset in range(0, len(ANSWER), 4):
            emit("response.output_text.delta", output_index=0, content_index=0, delta=ANSWER[offset:offset + 4])
            time.sleep(0.04)
        part = {**part, "text": ANSWER}
        item = {**item, "status": "completed", "content": [part]}
        emit("response.output_text.done", output_index=0, content_index=0, text=ANSWER)
        emit("response.output_item.done", output_index=0, item=item)
        emit("response.completed", response={
            **response, "status": "completed", "output": [item],
            "usage": {"input_tokens": 20_000, "output_tokens": 24, "total_tokens": 20_024,
                      "input_tokens_details": {"cached_tokens": 18_000}},
        })


def run(mode, ascii_mode, port, recording=None):
    pacman = "C" if ascii_mode else "󰮯"
    prompt = ">" if ascii_mode else "❯"
    with tempfile.TemporaryDirectory(prefix="pi-context-bar-tui-") as directory:
        agent = Path(directory)
        (agent / "settings.json").write_text(json.dumps({"quietStartup": True, "theme": "dark"}))
        (agent / "pi-context-bar.json").write_text(json.dumps({"asciiFallback": ascii_mode}))
        (agent / "models.json").write_text(json.dumps({"providers": {"smoke": {
            "api": "openai-responses", "baseUrl": f"http://127.0.0.1:{port}/v1",
            "apiKey": "offline-smoke-key",
            "models": [{"id": "offline-model", "contextWindow": 200_000, "maxTokens": 1024,
                        "cost": {"input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1}}],
        }}}))
        fixture = agent / "status.ts"
        fixture.write_text(
            'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n'
            'export default function(pi: ExtensionAPI) {\n'
            '  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("smoke", "offline ready"));\n'
            '}\n'
        )
        env = {**os.environ, "PI_CODING_AGENT_DIR": directory, "PI_OFFLINE": "1",
               "TERM": "xterm-256color", "COLORTERM": "truecolor"}
        # Do not inherit a parent Pi process's terminal write-log or debug destinations.
        for key in ("PI_TUI_WRITE_LOG", "PI_TUI_DEBUG"):
            env.pop(key, None)
        command = [shutil.which("node"), str(CLI), "--offline", "--no-session", "--no-extensions",
                   "--no-tools", "--no-skills", "--no-prompt-templates", "--no-themes",
                   "--no-context-files", "--no-approve", "--provider", "smoke", "--model", "offline-model",
                   "--tui-mode", mode, "-e", str(ROOT / "index.ts"), "-e", str(fixture)]
        started = time.monotonic()
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(directory)
            os.execvpe(command[0], command, env)
        chunks = []
        decoder = codecs.getincrementaldecoder("utf-8")()
        transcript = bytearray()
        debug = agent / "pi-debug.log"
        columns = 100
        finished = False

        def resize(width, wait=True):
            nonlocal columns
            columns = width
            offset = len(transcript)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, width, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            if wait:
                wait_for(lambda: any(len(line) == width for line in re.findall(
                    rf"── [^\r\n]{{{width - 6}}}───", ANSI.sub("", transcript[offset:].decode(errors="replace")))),
                    f"resize to {width} columns")

        def wait_for(check, label, timeout=15):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if check():
                    return
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            time.sleep(0.05)
                            continue
                        raise
                    if not data:
                        time.sleep(0.05)
                        continue
                    transcript.extend(data)
                    chunks.append([round(time.monotonic() - started, 4), "o", decoder.decode(data)])
                    if len(transcript) > 4_000_000:
                        raise AssertionError("unbounded TUI output")
            raise AssertionError(f"{mode}/{ascii_mode}: timed out waiting for {label}\n{transcript[-3000:].decode(errors='replace')}")

        def send(text):
            os.write(master, text.encode())

        def capture():
            debug.unlink(missing_ok=True)
            send("\x1b[100;6u")  # Pi's global Ctrl+Shift+D; preserves drafts and autocomplete.
            wait_for(lambda: debug.exists() and "=== Agent messages" in debug.read_text(errors="replace"),
                     "complete native render snapshot")
            pairs = [(int(width), ANSI.sub("", json.loads(line)))
                     for width, line in re.findall(r"^\[\d+\] \(w=(\d+)\) (.*)$", debug.read_text(), re.M)]
            assert pairs and all(width <= columns for width, _ in pairs), pairs
            lines = [line for _, line in pairs]
            top = next(i for i, line in enumerate(lines) if pacman in line and "─" not in line)
            bottom = next(i for i in range(top + 1, len(lines)) if lines[i].startswith("──"))
            assert all(width == columns for width, _ in pairs[top:bottom + 1])
            assert lines[top + 1].startswith(f"{prompt} "), lines[top + 1]
            assert all(line.startswith("  ") for line in lines[top + 2:bottom])
            assert all(line.endswith(" ") for line in lines[top + 1:bottom])
            assert not re.search(r"[┌┐└┘│╭╮╰╯]", "\n".join(lines[top:bottom + 1])), "unexpected side or corner"
            assert "─" not in lines[top], "unexpected lane rule caps"
            assert lines[bottom].endswith("─")
            assert not any(line.strip() for line in lines[bottom + 1:]), "unexpected footer rows"
            return lines, top, bottom

        try:
            resize(100, wait=False)
            wait_for(lambda: all(marker in ANSI.sub("", transcript.decode(errors="replace"))
                                 for marker in ("offline-model", f" {pacman} ")),
                     "editor chrome")
            send(PROMPT)
            lines, top, bottom = capture()
            assert lines[top + 1].startswith(f"{prompt} {PROMPT}"), lines[top + 1]
            assert pacman in lines[top], lines[top]
            send("\r")
            wait_for(lambda: all(marker in ANSI.sub("", transcript.decode(errors="replace"))
                                 for marker in ("t/s", "75%", "90%")),
                     "completed usage and passive quota")
            lines, top, bottom = capture()
            assert ANSWER in debug.read_text(), "Pi must retain the streamed answer"
            assert "75%" in lines[bottom] and "90%" in lines[bottom], lines[bottom]

            if recording is not None:
                # Record only fixed-width output; resize coverage below is tested, not misplayed at 100 columns.
                recording.extend(chunks)
            resize(36)
            offset = len(transcript)
            send("/con")
            wait_for(lambda: "context-bar" in ANSI.sub("", transcript[offset:].decode(errors="replace")),
                     "slash-command autocomplete")
            lines, top, bottom = capture()
            assert any("context-bar" in line for line in lines[:top]), lines
            assert "/con" in "\n".join(lines[top:bottom + 1])
            send("\x1b")
            time.sleep(0.1)
            send("\x15")
            resize(100)
            send("/context-bar ascii-fallback toggle\r")
            wait_for(lambda: f"ASCII glyphs {'off' if ascii_mode else 'on'}".encode() in transcript, "runtime glyph toggle")
            send("/context-bar status\r")
            wait_for(lambda: b"smoke: offline ready" in transcript, "other extension status inspection")
            assert b"Error loading extension" not in transcript
            assert b"unrecognized Pi editor layout" not in transcript
            # Fullscreen can emit earlier cleanup markers; keep draining until this quit finishes.
            offset = len(transcript)
            send("/quit\r")
            wait_for(lambda: b"\x1b[?2004l" in transcript[offset:], "terminal cleanup")
            status = 0

            def exited():
                nonlocal status
                child, status = os.waitpid(pid, os.WNOHANG)
                return child == pid

            # Drain final fullscreen output so a full PTY cannot block the child's exit.
            wait_for(exited, "process exit")
            finished = True
            assert os.waitstatus_to_exitcode(status) == 0, status
        finally:
            if not finished:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
            os.close(master)
        print(f"PTY smoke passed: {mode}, {'ASCII' if ascii_mode else 'Nerd Font'}")


def main():
    if len(sys.argv) > 2:
        raise SystemExit(__doc__)
    recording = []
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for mode in ("regular", "fullscreen"):
                for ascii_mode in (False, True):
                    run(mode, ascii_mode, server.server_port, recording if mode == "regular" and not ascii_mode else None)
        finally:
            server.shutdown()
            thread.join()
    assert len(Provider.requests) == 4
    assert all(PROMPT in json.dumps(request, ensure_ascii=False) for request in Provider.requests)
    if len(sys.argv) == 2:
        destination = Path(sys.argv[1])
        destination.parent.mkdir(parents=True, exist_ok=True)
        header = {"version": 2, "width": 100, "height": 30,
                  "title": "pi-context-bar: real PTY, offline fixture with simulated usage",
                  "env": {"TERM": "xterm-256color"}}
        destination.write_text("\n".join(json.dumps(event, ensure_ascii=False) for event in [header, *recording]) + "\n")
        print(f"Recorded offline demo: {destination}")


if __name__ == "__main__":
    main()
