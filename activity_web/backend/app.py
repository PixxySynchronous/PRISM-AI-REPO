from __future__ import annotations

import traceback
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

from .attendance_service import get_attendance_service, migrate_legacy_flat_store, CLASSROOMS, CLASSROOM_LABELS
from .pipeline_loader import get_pipeline
from .engagement_loader import get_engagement_pipeline
from .cognitive_loader import get_cognitive_pipeline
from .combined_loader import get_combined_pipeline
from .classroom_loader import get_classroom_pipeline
from .config import (
    BACKEND_DIR,
    RUNTIME_DIR,
    UPLOAD_DIR,
    OUTPUT_DIR,
    ATTENDANCE_DIR,
    ALLOWED_EXTENSIONS,
    ALLOWED_IMAGE_EXTENSIONS,
    TUNNEL_URL_PATH,
)
from .startup import check_ffmpeg_available
from .transcode import transcode_clips_async

app = Flask(
    __name__,
    template_folder=str(BACKEND_DIR / "templates"),
    static_folder=str(BACKEND_DIR / "static"),
)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024

try:
    migrate_legacy_flat_store()
except Exception:
    pass


def ensure_runtime_dirs() -> None:
    # Create the configured runtime directories
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (ATTENDANCE_DIR / "uploads").mkdir(parents=True, exist_ok=True)
    (ATTENDANCE_DIR / "marked").mkdir(parents=True, exist_ok=True)
    # Check for ffmpeg which ensures clips are encoded as H.264 for browser playback
    try:
        has_ff = check_ffmpeg_available()
        # If ffmpeg is present, start a background transcode pass for any existing clips
        if has_ff:
            try:
                transcode_clips_async(OUTPUT_DIR)
            except Exception:
                pass
    except Exception:
        pass


def allowed_video(filename: str) -> bool:
    return Path(filename.lower()).suffix in ALLOWED_EXTENSIONS


def allowed_media(filename: str) -> bool:
    return Path(filename.lower()).suffix in ALLOWED_EXTENSIONS | ALLOWED_IMAGE_EXTENSIONS


def artifact_url(job_id: str, kind: str) -> str:
    return f"/api/jobs/{job_id}/download/{kind}"


def clip_url(job_id: str, relative_path: str) -> str:
    return f"/api/jobs/{job_id}/clips/{relative_path}"


def attendance_artifact_url(filename: str) -> str:
    return f"/api/attendance/artifacts/{filename}"


def _require_classroom(classroom_id: str | None):
    """Validate a classroom id against the fixed whitelist. Returns None on
    success, or a (response, status) tuple to return immediately on failure."""
    if classroom_id not in CLASSROOMS:
        return jsonify({"ok": False, "error": "Select a valid classroom."}), 400
    return None


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/enroll")
def enroll_page():
    return render_template("enroll.html")


@app.get("/api/attendance/classrooms")
def attendance_classrooms():
    return jsonify({
        "ok": True,
        "classrooms": [{"id": c, "label": CLASSROOM_LABELS[c]} for c in CLASSROOMS],
    })


def _read_tunnel_url() -> str | None:
    """The public tunnel URL, written by start_enrollment_session.py once
    cloudflared reports it's connected. None if no session is running."""
    try:
        url = TUNNEL_URL_PATH.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    return url or None


def _public_base_url() -> str | None:
    """Where students should be sent to self-enroll. Prefers the cloudflared
    tunnel (for a locally-run server that isn't otherwise internet-reachable),
    but falls back to the incoming request's own host — a hosted deployment
    (e.g. a Hugging Face Space) is already on a public URL, so no tunnel is
    needed there at all. localhost/127.0.0.1 is never used as a fallback: a
    student's phone can't reach that regardless of what the teacher's own
    browser shows."""
    tunnel_url = _read_tunnel_url()
    if tunnel_url:
        return tunnel_url
    host = request.host.split(":")[0].lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0"}:
        return None
    # Hosted platforms (e.g. a Hugging Face Space) sit behind a reverse proxy
    # that terminates HTTPS — Flask sees the forwarded plain-HTTP request
    # unless told otherwise. Camera access requires a secure context, so the
    # scheme has to reflect what the student's browser actually used.
    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    return f"{scheme}://{request.host}"


@app.get("/api/enroll-url")
def enroll_url():
    classroom_id = request.args.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error
    base_url = _public_base_url()
    if not base_url:
        return jsonify({
            "ok": False,
            "error": "No enrollment session is running. Start it with start_enrollment_session.py on the teacher's laptop.",
        }), 404
    return jsonify({"ok": True, "url": f"{base_url}/enroll?classroom={classroom_id}"})


@app.get("/api/enroll-qr")
def enroll_qr():
    classroom_id = request.args.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error
    base_url = _public_base_url()
    if not base_url:
        return jsonify({"ok": False, "error": "No enrollment session is running."}), 404

    import io
    import qrcode

    target = f"{base_url}/enroll?classroom={classroom_id}"
    img = qrcode.make(target, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.get("/api/attendance/roster")
def attendance_roster():
    classroom_id = request.args.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error
    try:
        service = get_attendance_service(classroom_id)
        return jsonify({"ok": True, "students": service.list_students(), "attendance": service.list_attendance(limit=20)})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.delete("/api/attendance/students/<student_id>")
def attendance_delete_student(student_id: str):
    classroom_id = request.args.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error
    service = get_attendance_service(classroom_id)
    try:
        result = service.delete_student(student_id)
    except KeyError:
        return jsonify({"ok": False, "error": "Student not found."}), 404
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, **result})


@app.post("/api/attendance/suspicious/resolve")
def attendance_resolve_suspicious():
    data = request.get_json(silent=True) or {}
    classroom_id = data.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error

    review_id = str(data.get("review_id", "")).strip()
    confirmed = bool(data.get("confirmed"))
    if not review_id:
        return jsonify({"ok": False, "error": "Missing review_id."}), 400

    service = get_attendance_service(classroom_id)
    try:
        result = service.resolve_suspicious_review(review_id, confirmed)
    except KeyError:
        return jsonify({"ok": False, "error": "That review no longer exists (already resolved?)."}), 404
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, **result})


@app.post("/api/attendance/unknown/assign")
def attendance_assign_unknown():
    data = request.get_json(silent=True) or {}
    classroom_id = data.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error

    review_id = str(data.get("review_id", "")).strip()
    student_id = str(data.get("student_id", "")).strip()
    if not review_id or not student_id:
        return jsonify({"ok": False, "error": "Missing review_id or student_id."}), 400

    service = get_attendance_service(classroom_id)
    try:
        result = service.assign_unknown_face(review_id, student_id)
    except KeyError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, **result})


@app.post("/api/attendance/enroll")
def attendance_enroll():
    classroom_id = request.form.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error

    uploaded_files = request.files.getlist("media")
    student_name = request.form.get("student_name", "").strip()

    if not student_name:
        return jsonify({"ok": False, "error": "Enter a student name."}), 400
    if not uploaded_files:
        return jsonify({"ok": False, "error": "Upload at least one photo or video."}), 400

    service = get_attendance_service(classroom_id)
    saved_paths: list[Path] = []
    for uploaded_file in uploaded_files:
        if not uploaded_file or not uploaded_file.filename:
            continue
        if not allowed_media(uploaded_file.filename):
            return jsonify({"ok": False, "error": "Use image or video files for enrollment."}), 400
        media_name = secure_filename(uploaded_file.filename)
        media_path = ATTENDANCE_DIR / "uploads" / f"{uuid.uuid4().hex[:12]}_{media_name}"
        media_path.parent.mkdir(parents=True, exist_ok=True)
        uploaded_file.save(media_path)
        saved_paths.append(media_path)

    if not saved_paths:
        return jsonify({"ok": False, "error": "No valid media files were uploaded."}), 400

    try:
        result = service.enroll_student(student_name=student_name, media_paths=saved_paths)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, **result, "students": service.list_students()})


@app.post("/api/attendance/enroll-folder")
def attendance_enroll_folder():
    """Enroll a student from a local folder of videos/images (no upload needed)."""
    data = request.get_json(silent=True) or {}
    classroom_id = data.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error

    student_name = data.get("student_name", "").strip()
    folder_path  = data.get("folder_path", "").strip()

    if not student_name:
        return jsonify({"ok": False, "error": "Enter a student name."}), 400
    if not folder_path:
        return jsonify({"ok": False, "error": "Enter a folder path."}), 400

    folder = Path(folder_path).expanduser()
    if not folder.exists() or not folder.is_dir():
        return jsonify({"ok": False, "error": f"Folder not found: {folder_path}"}), 400

    media_paths = sorted([
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in ALLOWED_EXTENSIONS | ALLOWED_IMAGE_EXTENSIONS
    ])
    if not media_paths:
        return jsonify({"ok": False, "error": "No video or image files found in that folder."}), 400

    service = get_attendance_service(classroom_id)
    try:
        result = service.enroll_student(student_name=student_name, media_paths=media_paths)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, **result,
                    "students": service.list_students(),
                    "files_used": len(media_paths)})


@app.post("/api/attendance/mark")
def attendance_mark():
    classroom_id = request.form.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error

    # "photos" (plural) lets a teacher mark attendance from several photos of
    # the same classroom in one go — someone missed or turned away in one
    # shot may be clearly caught in another, so a student only needs to be
    # confidently matched in ANY one of them to count as present.
    uploaded_files = request.files.getlist("photos")
    if not uploaded_files or not uploaded_files[0].filename:
        return jsonify({"ok": False, "error": "Upload at least one classroom photo first."}), 400

    for f in uploaded_files:
        if not allowed_media(f.filename):
            return jsonify({"ok": False, "error": f"'{f.filename}' isn't a supported image/video file."}), 400

    service = get_attendance_service(classroom_id)
    photo_paths: list[Path] = []
    upload_dir = ATTENDANCE_DIR / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    for f in uploaded_files:
        photo_name = secure_filename(f.filename)
        photo_path = upload_dir / f"{uuid.uuid4().hex[:12]}_{photo_name}"
        f.save(photo_path)
        photo_paths.append(photo_path)

    try:
        result = service.mark_attendance_multi(photo_paths)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, **result})


@app.post("/api/attendance/demo")
def attendance_demo():
    classroom_id = request.form.get("classroom") or request.args.get("classroom", "")
    if (error := _require_classroom(classroom_id)) is not None:
        return error

    import shutil
    demo_src = Path(__file__).parent / "static" / "demo_classroom.jpg"
    if not demo_src.exists():
        return jsonify({"ok": False, "error": "Demo image not found."}), 404

    service = get_attendance_service(classroom_id)
    photo_path = ATTENDANCE_DIR / "uploads" / "demo_classroom.jpg"
    photo_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(demo_src, photo_path)

    try:
        result = service.mark_attendance(photo_path)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500

    result["marked_url"] = attendance_artifact_url(Path(result["marked_url"]).name)
    result["clean_url"] = attendance_artifact_url(Path(result["clean_url"]).name)
    return jsonify({"ok": True, **result})


@app.post("/api/process")
def process_video():
    ensure_runtime_dirs()

    uploaded_file = request.files.get("video")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify({"ok": False, "error": "Upload a video file first."}), 400

    if not allowed_video(uploaded_file.filename):
        return jsonify({"ok": False, "error": "Use an .mp4, .mov, .avi, .mkv, or .webm file."}), 400

    job_id = uuid.uuid4().hex[:12]
    filename = secure_filename(uploaded_file.filename)
    input_path = UPLOAD_DIR / f"{job_id}_{filename}"
    output_path = OUTPUT_DIR / job_id

    uploaded_file.save(input_path)

    try:
        pipeline = get_pipeline()
        result = pipeline.process_video(video_path=input_path, output_dir=output_path, annotate=True)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500

    summary = result["summary"]
    job_output = OUTPUT_DIR / job_id
    clip_entries = []
    for clip in summary.get("clips", []):
        clip_path_value = clip.get("clip_path")
        clip_relative_path = None
        if clip_path_value:
            try:
                clip_relative_path = str(Path(clip_path_value).resolve().relative_to(job_output.resolve()))
            except Exception:
                clip_relative_path = None
        clip_entries.append(
            {
                **clip,
                "clip_relative_path": clip_relative_path,
                "clip_url": clip_url(job_id, clip_relative_path) if clip_relative_path else None,
            }
        )
    response = {
        "ok": True,
        "job_id": job_id,
        "summary": summary,
        "paths": {
            "summary_json": result["summary_path"],
            "csv": result["csv_path"],
            "clip_dir": result["clip_dir"],
            "annotated_video": result["annotated_video"],
        },
        "download_urls": {
            "summary_json": artifact_url(job_id, "summary"),
            "csv": artifact_url(job_id, "csv"),
            "annotated_video": artifact_url(job_id, "annotated"),
        },
        "clips": clip_entries,
    }
    return jsonify(response)


@app.post("/api/engagement/process")
def process_engagement():
    ensure_runtime_dirs()

    uploaded_file = request.files.get("video")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify({"ok": False, "error": "Upload a video file first."}), 400

    if not allowed_video(uploaded_file.filename):
        return jsonify({"ok": False, "error": "Use an .mp4, .mov, .avi, .mkv, or .webm file."}), 400

    job_id   = uuid.uuid4().hex[:12]
    filename = secure_filename(uploaded_file.filename)
    input_path  = UPLOAD_DIR / f"{job_id}_{filename}"
    output_path = OUTPUT_DIR / f"eng_{job_id}"

    uploaded_file.save(input_path)

    try:
        pipeline = get_engagement_pipeline()
        result   = pipeline.process(video_path=input_path, output_dir=output_path)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500

    # attach clip URLs to each student entry
    students = result["students"]
    for s in students:
        s["clip_urls"] = [
            f"/api/engagement/jobs/{job_id}/clips/{fname}"
            for fname in (s.get("clips") or [])
        ]

    return jsonify({
        "ok":       True,
        "job_id":   job_id,
        "summary":  result["summary"],
        "students": students,
        "timeline": result["timeline"],
        "download_urls": {
            "summary_json": f"/api/engagement/jobs/{job_id}/summary",
            "csv":          f"/api/engagement/jobs/{job_id}/csv",
        },
    })


@app.get("/api/engagement/jobs/<job_id>/clips/<filename>")
def serve_engagement_clip(job_id: str, filename: str):
    clips_dir = (OUTPUT_DIR / f"eng_{job_id}" / "clips").resolve()
    clip_path = (clips_dir / secure_filename(filename)).resolve()
    try:
        clip_path.relative_to(clips_dir)
    except Exception:
        return jsonify({"ok": False, "error": "Not found"}), 404
    if not clip_path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(clip_path, mimetype="video/mp4")


@app.get("/api/engagement/jobs/<job_id>/summary")
def download_engagement_summary(job_id: str):
    path = OUTPUT_DIR / f"eng_{job_id}" / "engagement_summary.json"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="engagement_summary.json")


@app.get("/api/engagement/jobs/<job_id>/csv")
def download_engagement_csv(job_id: str):
    path = OUTPUT_DIR / f"eng_{job_id}" / "engagement_students.csv"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="engagement_students.csv")


@app.get("/api/jobs/<job_id>/download/<kind>")
def download_artifact(job_id: str, kind: str):
    job_output = OUTPUT_DIR / job_id
    summary_path = next(job_output.glob("*_summary.json"), None)
    csv_path = next(job_output.glob("*_per_student_predictions.csv"), None)
    annotated_path = next(job_output.glob("*_sampled_annotated.mp4"), None)

    if kind == "summary" and summary_path is not None and summary_path.exists():
        return send_file(summary_path, as_attachment=True, download_name=summary_path.name)
    if kind == "csv" and csv_path is not None and csv_path.exists():
        return send_file(csv_path, as_attachment=True, download_name=csv_path.name)
    if kind == "annotated" and annotated_path is not None and annotated_path.exists():
        return send_file(annotated_path, as_attachment=True, download_name=annotated_path.name)

    return jsonify({"ok": False, "error": "Artifact not found."}), 404


@app.get("/api/jobs/<job_id>/clips/<path:relative_path>")
def serve_clip(job_id: str, relative_path: str):
    job_output = OUTPUT_DIR / job_id
    clip_path = (job_output / relative_path).resolve()
    try:
        clip_path.relative_to(job_output.resolve())
    except Exception:
        return jsonify({"ok": False, "error": "Clip not found."}), 404

    if not clip_path.exists() or not clip_path.is_file():
        return jsonify({"ok": False, "error": "Clip not found."}), 404

    return send_file(clip_path, as_attachment=False, download_name=clip_path.name)


@app.get("/api/attendance/artifacts/<path:filename>")
def serve_attendance_artifact(filename: str):
    artifact_path = (ATTENDANCE_DIR / "marked" / filename).resolve()
    marked_dir = (ATTENDANCE_DIR / "marked").resolve()
    try:
        artifact_path.relative_to(marked_dir)
    except Exception:
        return jsonify({"ok": False, "error": "Artifact not found."}), 404

    if not artifact_path.exists() or not artifact_path.is_file():
        return jsonify({"ok": False, "error": "Artifact not found."}), 404

    suffix = artifact_path.suffix.lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(suffix.lstrip("."), "image/jpeg")
    return send_file(artifact_path, mimetype=mime)


@app.post("/api/combined/process")
def process_combined():
    ensure_runtime_dirs()

    uploaded_file = request.files.get("video")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify({"ok": False, "error": "Upload a video file first."}), 400

    if not allowed_video(uploaded_file.filename):
        return jsonify({"ok": False, "error": "Use an .mp4, .mov, .avi, .mkv, or .webm file."}), 400

    job_id   = uuid.uuid4().hex[:12]
    filename = secure_filename(uploaded_file.filename)
    input_path  = UPLOAD_DIR / f"{job_id}_{filename}"
    output_path = OUTPUT_DIR / f"comb_{job_id}"

    uploaded_file.save(input_path)

    try:
        pipeline = get_combined_pipeline()
        result   = pipeline.process(video_path=input_path, output_dir=output_path)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500

    students = result["students"]
    for s in students:
        clip_fname = s.get("clip")
        s["clip_url"] = f"/api/combined/jobs/{job_id}/clips/{clip_fname}" if clip_fname else None

    return jsonify({
        "ok":       True,
        "job_id":   job_id,
        "summary":  result["summary"],
        "students": students,
        "download_urls": {
            "summary_json": f"/api/combined/jobs/{job_id}/summary",
            "csv":          f"/api/combined/jobs/{job_id}/csv",
        },
    })


@app.get("/api/combined/jobs/<job_id>/clips/<filename>")
def serve_combined_clip(job_id: str, filename: str):
    clips_dir = (OUTPUT_DIR / f"comb_{job_id}" / "clips").resolve()
    clip_path = (clips_dir / secure_filename(filename)).resolve()
    try:
        clip_path.relative_to(clips_dir)
    except Exception:
        return jsonify({"ok": False, "error": "Not found"}), 404
    if not clip_path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(clip_path, mimetype="video/mp4")


@app.get("/api/combined/jobs/<job_id>/summary")
def download_combined_summary(job_id: str):
    path = OUTPUT_DIR / f"comb_{job_id}" / "combined_summary.json"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="combined_summary.json")


@app.get("/api/combined/jobs/<job_id>/csv")
def download_combined_csv(job_id: str):
    path = OUTPUT_DIR / f"comb_{job_id}" / "combined_students.csv"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="combined_students.csv")


@app.post("/api/cognitive/process")
def process_cognitive():
    ensure_runtime_dirs()

    uploaded_file = request.files.get("video")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify({"ok": False, "error": "Upload a video file first."}), 400

    if not allowed_video(uploaded_file.filename):
        return jsonify({"ok": False, "error": "Use an .mp4, .mov, .avi, .mkv, or .webm file."}), 400

    job_id   = uuid.uuid4().hex[:12]
    filename = secure_filename(uploaded_file.filename)
    input_path  = UPLOAD_DIR / f"{job_id}_{filename}"
    output_path = OUTPUT_DIR / f"cog_{job_id}"

    uploaded_file.save(input_path)

    try:
        pipeline = get_cognitive_pipeline()
        result   = pipeline.process(video_path=input_path, output_dir=output_path)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500

    students = result["students"]
    for s in students:
        clip_fname = s.get("clip")
        s["clip_url"] = f"/api/cognitive/jobs/{job_id}/clips/{clip_fname}" if clip_fname else None

    return jsonify({
        "ok":       True,
        "job_id":   job_id,
        "summary":  result["summary"],
        "students": students,
        "download_urls": {
            "summary_json": f"/api/cognitive/jobs/{job_id}/summary",
            "csv":          f"/api/cognitive/jobs/{job_id}/csv",
        },
    })


@app.get("/api/cognitive/jobs/<job_id>/clips/<filename>")
def serve_cognitive_clip(job_id: str, filename: str):
    clips_dir = (OUTPUT_DIR / f"cog_{job_id}" / "clips").resolve()
    clip_path = (clips_dir / secure_filename(filename)).resolve()
    try:
        clip_path.relative_to(clips_dir)
    except Exception:
        return jsonify({"ok": False, "error": "Not found"}), 404
    if not clip_path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(clip_path, mimetype="video/mp4")


@app.get("/api/cognitive/jobs/<job_id>/summary")
def download_cognitive_summary(job_id: str):
    path = OUTPUT_DIR / f"cog_{job_id}" / "cognitive_summary.json"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="cognitive_summary.json")


@app.get("/api/cognitive/jobs/<job_id>/csv")
def download_cognitive_csv(job_id: str):
    path = OUTPUT_DIR / f"cog_{job_id}" / "cognitive_students.csv"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="cognitive_students.csv")


@app.post("/api/classroom/process")
def process_classroom():
    ensure_runtime_dirs()

    uploaded_file = request.files.get("video")
    if uploaded_file is None or not uploaded_file.filename:
        return jsonify({"ok": False, "error": "Upload a video file first."}), 400

    if not allowed_video(uploaded_file.filename):
        return jsonify({"ok": False, "error": "Use an .mp4, .mov, .avi, .mkv, or .webm file."}), 400

    job_id   = uuid.uuid4().hex[:12]
    filename = secure_filename(uploaded_file.filename)
    input_path  = UPLOAD_DIR / f"{job_id}_{filename}"
    output_path = OUTPUT_DIR / f"cls_{job_id}"

    uploaded_file.save(input_path)

    try:
        pipeline = get_classroom_pipeline()
        result   = pipeline.process(video_path=input_path, output_dir=output_path)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500

    summary = result["summary"]
    # attach clip URLs to each window record in each student's timeline
    for student in summary.get("students", []):
        for window in student.get("timeline", []):
            clip_rel = window.get("clip")
            window["clip_url"] = (
                f"/api/classroom/jobs/{job_id}/clips/{clip_rel}" if clip_rel else None
            )

    return jsonify({
        "ok":      True,
        "job_id":  job_id,
        "summary": summary,
        "download_urls": {
            "summary_json": f"/api/classroom/jobs/{job_id}/summary",
            "csv":          f"/api/classroom/jobs/{job_id}/csv",
        },
    })


@app.get("/api/classroom/jobs/<job_id>/clips/<path:rel_path>")
def serve_classroom_clip(job_id: str, rel_path: str):
    clips_dir = (OUTPUT_DIR / f"cls_{job_id}" / "clips").resolve()
    clip_path = (clips_dir / rel_path).resolve()
    try:
        clip_path.relative_to(clips_dir)
    except Exception:
        return jsonify({"ok": False, "error": "Not found"}), 404
    if not clip_path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(clip_path, mimetype="video/mp4")


@app.get("/api/classroom/jobs/<job_id>/summary")
def download_classroom_summary(job_id: str):
    path = OUTPUT_DIR / f"cls_{job_id}" / "classroom_summary.json"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="classroom_summary.json")


@app.get("/api/classroom/jobs/<job_id>/csv")
def download_classroom_csv(job_id: str):
    path = OUTPUT_DIR / f"cls_{job_id}" / "classroom_timeline.csv"
    if not path.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_file(path, as_attachment=True, download_name="classroom_timeline.csv")


@app.errorhandler(Exception)
def handle_unhandled_exception(exc):
    return jsonify({"ok": False, "error": str(exc)}), 500


if __name__ == "__main__":
    # threaded=True so a burst of concurrent enrollment uploads (e.g. a
    # class scanning the QR code at once) get processed in parallel rather
    # than queued one-at-a-time. debug=False because this is the entrypoint
    # used when exposing the server via a public tunnel for QR enrollment —
    # Werkzeug's interactive debugger is a real RCE risk on anything
    # internet-reachable.
    app.run(host="0.0.0.0", port=8080, debug=False, use_reloader=False, threaded=True)
