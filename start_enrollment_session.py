"""One-command launcher for a QR-based self-enrollment session.

Starts the Flask app (threaded, bound to 0.0.0.0 so it can also be reached
directly over LAN) and a cloudflared quick tunnel (so it's also reachable
over the *public* internet — students on mobile data don't need to be on
the teacher's Wi-Fi). Once the tunnel is up, its URL is written to
activity_web/runtime/tunnel_url.txt, which the running Flask app reads to
build the QR code shown on the Attendance tab ("Show enrollment QR").

Usage:
    python start_enrollment_session.py [--classroom cse8]

Ctrl+C stops both processes and clears the tunnel URL.
"""
from __future__ import annotations

import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO_ROOT))

from activity_web.backend.config import RUNTIME_DIR, TUNNEL_URL_PATH  # noqa: E402

TUNNEL_URL_RE = re.compile(r"https://[a-zA-Z0-9\-]+\.trycloudflare\.com")
FLASK_PORT = 8080


def check_cloudflared() -> None:
    if shutil.which("cloudflared") is None:
        print(
            "cloudflared isn't installed. On macOS: brew install cloudflared\n"
            "(see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ "
            "for other platforms)"
        )
        sys.exit(1)


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def stream_output(pipe, prefix: str, on_line=None) -> None:
    for line in iter(pipe.readline, ""):
        if not line:
            break
        print(f"[{prefix}] {line.rstrip()}")
        if on_line:
            on_line(line)


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    check_cloudflared()
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    if port_in_use(FLASK_PORT):
        print(
            f"Port {FLASK_PORT} is already in use — an enrollment session is probably already\n"
            f"running (maybe in another terminal, or left over from earlier). Either use that\n"
            f"one, or stop it first:\n"
            f"    lsof -ti:{FLASK_PORT} | xargs kill; pkill -f 'cloudflared tunnel'\n"
            f"then re-run this script. (Starting a second instance on top of a live one leaves\n"
            f"a stale tunnel URL behind, which is exactly what caused the Cloudflare 1033 error.)"
        )
        sys.exit(1)

    # Only cleared past this point — starting a second instance while one is
    # already live must NOT touch a working session's tunnel_url.txt.
    TUNNEL_URL_PATH.unlink(missing_ok=True)

    flask_proc: subprocess.Popen | None = None
    tunnel_proc: subprocess.Popen | None = None

    def cleanup() -> None:
        TUNNEL_URL_PATH.unlink(missing_ok=True)
        for proc in (tunnel_proc, flask_proc):
            if proc is not None and proc.poll() is None:
                proc.terminate()
        for proc in (tunnel_proc, flask_proc):
            if proc is None:
                continue
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    try:
        print(f"Starting the local server on http://0.0.0.0:{FLASK_PORT} ...")
        flask_proc = subprocess.Popen(
            [sys.executable, "-m", "activity_web.backend.app"],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=stream_output, args=(flask_proc.stdout, "server"), daemon=True).start()

        print("Starting the cloudflared tunnel ...")
        tunnel_proc = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", f"http://localhost:{FLASK_PORT}"],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        found_url: dict[str, str | None] = {"url": None}

        def watch_for_url(line: str) -> None:
            # Free quick tunnels have no uptime guarantee — if the connection
            # drops and cloudflared reconnects, it can get reassigned a new
            # hostname while this process keeps running. Always take the
            # latest one (not just the first) so the QR panel self-heals
            # instead of quietly serving a dead link.
            match = TUNNEL_URL_RE.search(line)
            if match and match.group(0) != found_url["url"]:
                found_url["url"] = match.group(0)
                TUNNEL_URL_PATH.write_text(found_url["url"], encoding="utf-8")
                print(f"[tunnel] URL is now: {found_url['url']}")

        threading.Thread(
            target=stream_output, args=(tunnel_proc.stdout, "tunnel", watch_for_url), daemon=True
        ).start()

        print("Waiting for the tunnel URL ...")
        waited = 0.0
        while not found_url["url"] and waited < 30:
            time.sleep(0.5)
            waited += 0.5
            if flask_proc.poll() is not None:
                print("The local server exited unexpectedly — check the [server] log above.")
                return
            if tunnel_proc.poll() is not None:
                print("cloudflared exited unexpectedly — check the [tunnel] log above.")
                return

        if not found_url["url"]:
            print("Timed out waiting for the tunnel URL. Check the [tunnel] log above for errors.")
            return

        print("\n" + "=" * 60)
        print("Enrollment session is live.")
        print(f"  Public URL:  {found_url['url']}")
        print(f"  Dashboard:   http://localhost:{FLASK_PORT}/")
        print("Open the dashboard, pick a classroom on the Attendance tab, and")
        print("click 'Show enrollment QR' to display the QR code for students.")
        print("=" * 60 + "\n")
        print("Press Ctrl+C to stop the session.")

        while True:
            time.sleep(1)
            if flask_proc.poll() is not None or tunnel_proc.poll() is not None:
                print("A subprocess exited — stopping the session.")
                break
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        cleanup()


if __name__ == "__main__":
    main()
