#!/usr/bin/env python3
"""Serve the repo on 0.0.0.0. "/" is a landing page; the app lives under "/schism/".
Usage: serve.py [port]   (default 8600)"""
import functools, http.server, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFIX = "/schism"
LANDING = b"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Front page</title>
<style>
	body { font: 16px system-ui, sans-serif; margin: 2em; background: #111; color: #eee; }
	a { color: #6cf; }
</style></head>
<body>
<h1>Front page</h1>
<ul>
	<li><a href="/schism/">/schism</a> &mdash; Schism Tracker</li>
</ul>
</body></html>
"""

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(LANDING)))
            self.end_headers()
            self.wfile.write(LANDING)
        elif path == PREFIX:
            self.send_response(301)
            self.send_header("Location", PREFIX + "/")
            self.end_headers()
        elif path.startswith(PREFIX + "/"):
            self.path = self.path[len(PREFIX):]
            super().do_GET()
        else:
            self.send_error(404)

    def do_HEAD(self):
        self.do_GET()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8600
    handler = functools.partial(Handler, directory=ROOT)
    http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()
