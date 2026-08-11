#!/usr/bin/env python3
"""Scriptable MCP mock for tools/yaapi-rca-selftest.sh — see issue #245.

Serves just enough of streamable-HTTP MCP to exercise the reproduction harness
deterministically, and records every request with a timestamp so the self-test can
assert on ordering (for example: no cleanup DELETE inside the measured window) and on
stream lifetime (when the GET opened and closed relative to the tool call).

Usage:  yaapi-rca-mock.py <port> <log-path> <behavior>

Behaviors:
  ok            everything succeeds
  badcontent    tools/call returns content: [42] — valid JSON, invalid ContentBlock
  notifyfail    notifications/initialized returns a Django-style HTML 500
  callfail      tools/call returns a Django-style HTML 500
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG_PATH, BEHAVIOR = int(sys.argv[1]), sys.argv[2], sys.argv[3]
START = time.time()
_lock = threading.Lock()

HTML_500 = (
    b"<!DOCTYPE html>\n<html><head><title>Server error (500)</title></head>"
    b"<body><h1>Server Error (500)</h1></body></html>"
)


def log(event, detail=""):
    with _lock:
        with open(LOG_PATH, "a") as handle:
            handle.write(f"{time.time() - START:.3f} {event} {detail}\n".rstrip() + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # keep stderr clean; we keep our own log

    def _send(self, code, body=b"", ctype="application/json", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_DELETE(self):  # noqa: N802
        log("DELETE", self.headers.get("mcp-session-id", ""))
        self._send(200, b"{}")

    def do_GET(self):  # noqa: N802
        # The SDK opens this SSE stream after initialization and aborts it on close().
        # Hold it open so the self-test can measure how long it actually lived.
        sid = self.headers.get("mcp-session-id", "")
        log("GET_OPEN", sid)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for _ in range(300):
                self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
                time.sleep(0.1)
        except Exception:
            pass
        finally:
            log("GET_CLOSE", sid)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        try:
            message = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, b"{}")
            return
        method = message.get("method", "?")
        log("POST", method)

        if method == "initialize":
            body = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "mock", "version": "1.0"},
                    },
                }
            ).encode()
            self._send(200, body, headers={"mcp-session-id": f"mock-{time.time_ns()}"})
            return

        if method == "notifications/initialized":
            if BEHAVIOR == "notifyfail":
                self._send(500, HTML_500, ctype="text/html")
            else:
                self._send(202)
            return

        if method == "tools/call":
            if BEHAVIOR == "callfail":
                self._send(500, HTML_500, ctype="text/html")
                return
            content = [42] if BEHAVIOR == "badcontent" else [{"type": "text", "text": "ok"}]
            body = json.dumps(
                {"jsonrpc": "2.0", "id": message.get("id"), "result": {"content": content}}
            ).encode()
            self._send(200, body)
            return

        self._send(200, json.dumps({"jsonrpc": "2.0", "id": message.get("id"), "result": {}}).encode())


if __name__ == "__main__":
    open(LOG_PATH, "w").close()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"mock listening on {PORT} behavior={BEHAVIOR}", flush=True)
    server.serve_forever()
