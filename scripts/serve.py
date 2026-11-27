#!/usr/bin/env python3
"""Tiny static server for local development.

Usage:  python3 scripts/serve.py [port]      (default: 12000)

Why not `python3 -m http.server`?
  * it may serve .wasm as application/octet-stream, which breaks
    WebAssembly.instantiateStreaming (wllama falls back, but slowly)
  * it caches aggressively, which makes service-worker iterations confusing

Service workers and OPFS require a secure context, so use localhost or the
HTTPS dev host — plain http:// on a LAN IP will not register the worker.
"""

import functools
import http.server
import mimetypes
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/manifest+json", ".webmanifest")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 12000
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=str(ROOT))
    with socketserver.ThreadingTCPServer(("0.0.0.0", port), handler) as httpd:
        print(f"Bubble Plush on http://localhost:{port}/  (root: {ROOT})")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
