"""
One-command frontend startup.

Usage:
    python serve.py

Starts a static file server for the frontend, on http://localhost:5500 by
default, and opens it in your default browser. Run this from the
`frontend/` directory.

This frontend expects the backend to be running separately (see
`backend/server.py`) and reachable at the URL configured in
`js/api.js` (API_ORIGIN) -- by default http://localhost:8000.
"""

from __future__ import annotations

import argparse
import http.server
import functools
import webbrowser
from pathlib import Path

FRONTEND_DIR = Path(__file__).resolve().parent


class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    """Parse CLI flags and start the static file server."""
    parser = argparse.ArgumentParser(description="Serve the frontend as static files.")
    parser.add_argument("--port", type=int, default=5500, help="Port to serve on (default: 5500).")
    parser.add_argument(
        "--no-browser", action="store_true", help="Don't automatically open the login page in a browser."
    )
    parser.add_argument(
        "--page", default="login.html", help="Page to open automatically (default: login.html)."
    )
    args = parser.parse_args()

    handler = functools.partial(NoCacheHTTPRequestHandler, directory=str(FRONTEND_DIR))
    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler)

    url = f"http://localhost:{args.port}/{args.page}"
    print(f"\n{'=' * 70}\n>>> Serving frontend from {FRONTEND_DIR}\n>>> {url}\n{'=' * 70}\n")
    print("Make sure the backend is running too (see backend/server.py).")
    print("Press CTRL+C to stop.\n")

    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass  # headless environment or no default browser configured -- not fatal

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[serve.py] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
