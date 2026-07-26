from pathlib import Path
import os

# Backend directory (package location)
BACKEND_DIR = Path(__file__).resolve().parent

# Runtime base (can be overridden by env var on server)
RUNTIME_DIR = Path(os.environ.get("ACTIVITY_WEB_RUNTIME_DIR", BACKEND_DIR.parent / "runtime"))

# Specific runtime folders (can be overridden individually via env)
UPLOAD_DIR = Path(os.environ.get("ACTIVITY_WEB_UPLOAD_DIR", RUNTIME_DIR / "uploads"))
OUTPUT_DIR = Path(os.environ.get("ACTIVITY_WEB_OUTPUT_DIR", RUNTIME_DIR / "outputs"))
ATTENDANCE_DIR = Path(os.environ.get("ACTIVITY_WEB_ATTENDANCE_DIR", RUNTIME_DIR / "attendance"))

# Written by start_enrollment_session.py once the cloudflared tunnel is up,
# so the running Flask process (a separate subprocess) can pick up the
# public URL without a restart.
TUNNEL_URL_PATH = RUNTIME_DIR / "tunnel_url.txt"

# Allowed file types
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

# Ensure directories exist when needed by the app
def ensure_dirs():
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ATTENDANCE_DIR.mkdir(parents=True, exist_ok=True)
    (ATTENDANCE_DIR / "uploads").mkdir(parents=True, exist_ok=True)
    (ATTENDANCE_DIR / "marked").mkdir(parents=True, exist_ok=True)
