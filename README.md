---
title: PRISM AI
emoji: 🎓
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 8080
pinned: false
---

# PRISM AI — Classroom Monitoring System

An AI-powered classroom attendance and engagement monitoring system with a browser-based dashboard, designed to run on a teacher's own laptop.

---

## What It Does

| Tab | Function |
|---|---|
| **Attendance** | Mark attendance from one or more classroom photos using face recognition, per classroom (CSE 1–8) |
| **Enroll Student** | Students self-enroll (upload, folder path, or guided camera recording) — includes a QR-code flow so a whole class can enroll from their own phones |
| **Classroom Monitoring** | Upload a classroom video → detect and track every student → classify engagement per window → per-student timeline with clips |
| **How it Works** | In-app explanation of both pipelines, kept in sync with the actual thresholds/behavior below |

---

## Attendance — Face Recognition System

### Detection & recognition model
**InsightFace SCRFD** (1280×1280 detection) for face detection + landmarks, **AdaFace IR-101** (WebFace12M, 512-d L2-normalised embeddings) for recognition. AdaFace replaced the previous glintr100/antelopev2 backbone after an offline evaluation showed cleaner separation between genuine and impostor matches on real classroom photos.

### Per-classroom rosters
Each of the 8 classrooms (`cse1`–`cse8`) has its own independent JSON store — enrolling into one classroom never affects another, and a teacher picks a classroom before enrolling or marking attendance.

### How enrollment works
1. Provide a face sample — upload photo(s)/video, point at a local folder of clips, or record directly in the browser (see below).
2. Up to **30 frames** are sampled evenly across the clip (sequential decode, never seeking — seeking is unreliable for live-recorded webm from a browser's `MediaRecorder`).
3. **Anchor-based tracking**: the first accepted frame is the identity anchor; later frames are kept only if cosine similarity ≥ **0.35** against it, so a multi-person video can't mix identities.
4. Each accepted frame contributes its full-quality embedding plus **2 degraded copies** (downscaled to 50% / 30% then upscaled back) so the gallery also matches small, distant classroom faces, not just close-up enrollment shots.
5. Embeddings are capped at **128 per student** (oldest evicted first) with a weighted-mean prototype recomputed on every change; outliers more than **0.50** cosine distance from the running centroid are dropped before the prototype is built.

### Guided camera recording
The in-browser recorder walks a student through a ~37-second sequence with **spoken** (not just written) instructions — including holding the phone at arm's length so the whole face fits in the on-screen oval, since a face filling the whole frame is a common cause of the detector missing it entirely. It also requests a real capture resolution (1280×720 ideal) rather than trusting the browser's default, which on some phones can be as low as 480×640.

### Self-enrollment via QR code
A teacher can generate a QR code (Attendance tab → **Show enrollment QR**) that points students straight at their classroom's enroll page — no manual classroom picking, no need to be on the same Wi-Fi. This works by pairing the local server with a `cloudflared` quick tunnel:

```bash
python start_enrollment_session.py
```

This starts the Flask app (threaded, so a burst of students enrolling at once doesn't serialize into a queue) and the tunnel together, and prints the public URL once it's live. Requires `cloudflared` installed once (`brew install cloudflared` on macOS). The tunnel is ephemeral — a fresh random URL every time the script (re)starts, and it self-heals if the tunnel reconnects mid-session with a new hostname.

### How attendance marking works
1. Upload **one or more** classroom photos at once — a student only needs to be clearly caught in *any one* of them to count present, so someone missed or turned away in one shot can still be caught by another.
2. Every detected face across all photos is matched by cosine similarity against every enrolled student's prototype and individual stored embeddings; each student's *best* match across all photos wins.
3. Three-tier result:
   - **< 0.28** similarity → no name candidate at all → **Unknown** (red box).
   - **0.28–0.30** → a real candidate, not confident enough to auto-confirm → **Suspicious** (amber box, for a teacher to review).
   - **≥ 0.30** → **Present** (green box). Confidence ≥ 0.60 also auto-grows that student's gallery.
   - Anyone enrolled but not matched at either tier → **Absent**.
4. Face crops (Present, Suspicious, and Unknown) stay hidden by default and reveal on demand via a **"Show face"** button, cropped from the pre-annotation photo so the reveal isn't obscured by a box/label.

### Reinforcement — teachers correcting the model
- **Confirming** a Suspicious match adds that embedding to the student's gallery and marks them present.
- **Rejecting** a Suspicious match doesn't just discard it — the same face gets re-matched against the roster *excluding* the rejected student, and lands wherever that turns up: a confident hit → straight to Present, a borderline one → a fresh Suspicious entry for the new candidate, nothing left → into the Unknown pool. The wrongly-suggested student drops to Absent unless already seen elsewhere in the same result.
- **Unknown faces** can be directly assigned to any enrolled student via a dropdown on each face card — reinforces that student's gallery and marks them present, since a teacher pointing at a photo and naming someone is direct evidence they were there.

---

## Classroom Monitoring — Pipeline

The **Classroom pipeline** (`CLASSROOM PIPELINE/classroom_pipeline.py`) processes a lecture video in 30-second, 24-frame bursts rather than every frame:

| Step | How |
|---|---|
| **Detection & tracking** | YOLOv8-pose for body/keypoints, InsightFace (SCRFD) for faces + 106-point landmarks, linked into per-student tracks by IoU overlap within a burst |
| **Re-identification** | AdaFace IR-101 embeddings, resolved as a one-to-one assignment per burst (≥ 0.35 similarity) — two different people in the same burst can't collapse into one identity |
| **Roster recognition** | The same embedding is checked read-only against the enrolled Attendance roster (≥ 0.35, with a margin over the runner-up) — a confident match shows the real name instead of an anonymous `student_00N` label |
| **Signal extraction** | 106-point landmarks drive mouth open/closed + head yaw/pitch; YOLO for phone detection; optical flow for motion; DeepFace for dominant emotion |
| **Action classification** | Priority ruleset: On Phone → Sleeping → Writing → Talking → Attentive → otherwise Distracted. "Attentive" is driven by mouth-closed percentage (≥ 80%) — a calibration pass against a labeled reference dataset found eye-openness (EAR) had no measurable correlation with attentiveness, while mouth state separated attentive/non-attentive far more cleanly |
| **Engagement rollup** | Fraction of attentive windows → High (≥ 70%) / Medium (≥ 40%) / Low, plus a short saved clip per window |

**Known limitations**: phone detection is a generic, un-fine-tuned COCO model and currently finds close to none of the real phones in testing — needs replacing, not re-tuning. Attentive/not-attentive classification runs at roughly 67–70% accuracy against a 156-clip labeled reference set — a real improvement over the previous EAR-based approach, but not a solved problem.

---

## Running Locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Download YOLO model weights (Git LFS pointers — run once after cloning)
python download_models.py
```

> `deepface` (emotion detection) pulls in `tensorflow`, which only ships wheels for Python 3.9–3.12 — create the venv with one of those versions, not whatever newest Python happens to be installed. The Docker image (below) already uses `python:3.10-slim`.

**Just the dashboard**, no QR/tunnel:
```bash
OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES python -m activity_web.backend.app
```

**Dashboard + QR self-enrollment** (starts the tunnel too):
```bash
python start_enrollment_session.py
```

Open **http://localhost:8080**

---

## Deployment

See [`deployment/README.md`](deployment/README.md) for full Railway deployment instructions.

> The Hugging Face Space build (this repo's `Dockerfile`) has no persistent storage — enrolled rosters don't survive a rebuild there. For a real classroom, run this locally on the teacher's own machine (see above) so attendance data persists between sessions; the Space is a demo/showcase deployment, not where you'd actually enroll students.

---

## Repository Structure

```
CLASSROOM PIPELINE/                  Main classroom analysis pipeline (mouth/gaze/YOLO/emotion, AdaFace re-ID)
ENGAGEMENT PIPELINE/                 YOLOv8-pose engagement signals
COGNITIVE PIPELINE/                  EAR / gaze / emotion (dlib + DeepFace)
COMBINED PIPELINE/                   Merged engagement + cognitive
activity_web/backend/                Flask web app — app.py, attendance_service.py, templates, static (incl. camera-recorder.js, enroll.js)
utils/                               adaface_backbone.py (recognition), roster_match.py, retinaface_detector.py (SAHI + MTCNN + buffalo_l)
Activity monitoring/models/          Trained model weights
deployment/                          Self-contained Railway deployment build
start_enrollment_session.py          One-command launcher: threaded Flask server + cloudflared tunnel for QR self-enrollment
```
