// ── Tab switching ─────────────────────────────────────────────────────────────
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const tabPanels  = Array.from(document.querySelectorAll(".tab-panel"));

function activateTab(tabId) {
  tabButtons.forEach((btn) => {
    const active = btn.dataset.tabTarget === tabId;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  tabPanels.forEach((panel) => panel.classList.toggle("hidden", panel.id !== tabId));
  // Refresh the roster in case a student was just enrolled from the other tab.
  if (tabId === "attendance-tab") refreshAttendanceSummary();
}
tabButtons.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tabTarget)));

// ── Classroom tab (ClassroomPipeline → /api/classroom/process) ───────────────
const classroomForm      = document.getElementById("classroom-form");
const classroomFileInput = document.getElementById("classroom-video-input");
const classroomFileLabel = document.getElementById("classroom-file-label");
const classroomStatus    = document.getElementById("classroom-status");
const classroomResults   = document.getElementById("classroom-results");
const classroomMetrics   = document.getElementById("classroom-metrics");
const classroomSummaryLink = document.getElementById("classroom-summary-link");
const classroomCsvLink   = document.getElementById("classroom-csv-link");
const classroomClassBar  = document.getElementById("classroom-class-bar");
const classroomStudents  = document.getElementById("classroom-students");

function selectedFileText(files, fallback) {
  if (!files || !files.length) return fallback;
  return files.length === 1 ? files[0].name : `${files[0].name} + ${files.length - 1} more`;
}

classroomFileInput.addEventListener("change", () => {
  classroomFileLabel.textContent = selectedFileText(classroomFileInput.files, "Choose a classroom video (up to 60 min)");
});

const ACTION_COLORS = {
  "Attentive": "#22c55e", "Writing": "#3b82f6", "Talking": "#f59e0b",
  "On Phone":  "#ef4444", "Sleeping": "#8b5cf6", "Distracted": "#f97316",
};
function actionColor(a) { return ACTION_COLORS[a] || "#94a3b8"; }

classroomForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!classroomFileInput.files.length) {
    classroomStatus.textContent = "Choose a video file first.";
    classroomStatus.classList.add("error");
    return;
  }
  const btn = classroomForm.querySelector("button[type='submit']");
  const payload = new FormData();
  payload.append("video", classroomFileInput.files[0]);

  classroomResults.classList.add("hidden");
  classroomStatus.classList.remove("error");
  classroomStatus.textContent = "Analysing classroom — this can take several minutes for long videos...";
  btn.disabled = true;

  try {
    const resp = await fetch("/api/classroom/process", { method: "POST", body: payload });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "Unknown error");

    const s = data.summary;
    classroomStatus.textContent =
      `Done — ${s.student_count} students across ${s.total_windows} windows (${s.duration_seconds}s).`;

    classroomMetrics.innerHTML = [
      ["Students", s.student_count], ["Windows", s.total_windows],
      ["Attentive", `${s.class_attentive_pct}%`], ["Duration", `${Math.round(s.duration_seconds / 60)}m`],
    ].map(([l, v]) => `<div class="metric"><span class="label">${l}</span><span class="value">${v ?? "-"}</span></div>`).join("");

    classroomSummaryLink.href = data.download_urls.summary_json;
    classroomCsvLink.href     = data.download_urls.csv;

    const actionTotals = {}; let totalObs = 0;
    for (const student of (s.students || []))
      for (const win of (student.timeline || []))
        { actionTotals[win.action] = (actionTotals[win.action] || 0) + 1; totalObs++; }

    const barSegs = Object.entries(actionTotals).sort((a, b) => b[1] - a[1])
      .map(([action, count]) => {
        const pct = totalObs ? (count / totalObs * 100).toFixed(1) : 0;
        return `<div class="cls-bar-seg" style="flex:${count};background:${actionColor(action)}" title="${action}: ${pct}%"><span>${action} ${pct}%</span></div>`;
      }).join("");
    classroomClassBar.innerHTML = `<p class="cls-bar-label">Class-wide action distribution</p><div class="cls-bar">${barSegs}</div>`;

    renderClassroomStudents(s.students || []);
    classroomResults.classList.remove("hidden");
  } catch (err) {
    classroomStatus.textContent = `Error: ${err.message}`;
    classroomStatus.classList.add("error");
  } finally { btn.disabled = false; }
});

function renderClassroomStudents(students) {
  if (!students.length) { classroomStudents.innerHTML = "<p class='empty-state'>No students detected.</p>"; return; }
  classroomStudents.innerHTML = students.map((student) => {
    const breakdownBars = Object.entries(student.action_breakdown || {}).sort((a, b) => b[1] - a[1])
      .map(([action, pct]) => `<div class="cls-mini-seg" style="flex:${pct};background:${actionColor(action)}" title="${action}: ${pct}%"></div>`).join("");

    const timelineHtml = (student.timeline || []).map((win) => {
      const mm = Math.floor(win.window_start_seconds / 60).toString().padStart(2, "0");
      const ss = Math.floor(win.window_start_seconds % 60).toString().padStart(2, "0");
      return `<div class="cls-win" style="border-color:${actionColor(win.action)}">
        <div class="cls-win-header" style="background:${actionColor(win.action)}22">
          <span class="cls-win-time">${mm}:${ss}</span>
          <span class="cls-win-action" style="color:${actionColor(win.action)}">${win.action}</span>
          <span class="cls-win-meta">${win.emotion || ""} · ${(win.concentration_pct || 0).toFixed(0)}% conc</span>
        </div>
        ${win.clip_url
          ? `<video class="cls-win-clip" src="${win.clip_url}" controls preload="none" muted playsinline></video>`
          : `<div class="cls-win-no-clip">no clip</div>`}
      </div>`;
    }).join("");

    const attColor = student.attentive_pct >= 70 ? "#22c55e" : student.attentive_pct >= 40 ? "#f59e0b" : "#ef4444";
    const idLabel = student.recognized_name
      ? `<span class="cls-student-name">${student.recognized_name}</span><span class="cls-student-id cls-student-id-secondary">${student.student_label}</span>`
      : `<span class="cls-student-id">${student.student_label}</span>`;
    return `<details class="cls-student-card" open>
      <summary class="cls-student-summary">
        ${idLabel}
        <span class="cls-student-dominant">${student.dominant_action}</span>
        <span class="cls-student-attn" style="color:${attColor}">${student.attentive_pct}% attentive</span>
        <span class="cls-student-windows">${student.windows_seen} windows</span>
        <div class="cls-mini-bar">${breakdownBars}</div>
      </summary>
      <div class="cls-timeline">${timelineHtml}</div>
    </details>`;
  }).join("");
}

// ── Attendance tab: classroom picker ─────────────────────────────────────────
const classroomSelect        = document.getElementById("classroom-select");
const rosterClassroomLabel   = document.getElementById("roster-classroom-label");
let currentClassroomId = null;

function updateRosterClassroomLabel() {
  const label = classroomSelect.options[classroomSelect.selectedIndex]?.textContent || "";
  rosterClassroomLabel.textContent = label;
}

async function loadClassrooms() {
  try {
    const response = await fetch("/api/attendance/classrooms");
    const data = await response.json();
    if (!data.ok || !data.classrooms.length) throw new Error(data.error || "No classrooms available.");
    classroomSelect.innerHTML = data.classrooms.map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
    const saved = localStorage.getItem("prism_classroom");
    currentClassroomId = (saved && data.classrooms.some((c) => c.id === saved)) ? saved : data.classrooms[0].id;
    classroomSelect.value = currentClassroomId;
    updateRosterClassroomLabel();
    await refreshAttendanceSummary();
  } catch (err) {
    console.error("Failed to load classrooms:", err);
  }
}

classroomSelect.addEventListener("change", async () => {
  currentClassroomId = classroomSelect.value;
  localStorage.setItem("prism_classroom", currentClassroomId);
  updateRosterClassroomLabel();
  markResult.classList.add("hidden");
  await refreshAttendanceSummary();
  if (!enrollQrPanel.classList.contains("hidden")) await loadEnrollQr();
});

// ── Attendance tab: enrollment QR (students join via cloudflared tunnel) ────
const enrollQrToggle = document.getElementById("enroll-qr-toggle");
const enrollQrPanel  = document.getElementById("enroll-qr-panel");
const enrollQrBody   = document.getElementById("enroll-qr-body");

async function loadEnrollQr() {
  enrollQrBody.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const response = await fetch(`/api/enroll-url?classroom=${encodeURIComponent(currentClassroomId)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "No enrollment session running.");
    enrollQrBody.innerHTML = `
      <img class="enroll-qr-image" src="/api/enroll-qr?classroom=${encodeURIComponent(currentClassroomId)}&t=${Date.now()}" alt="Enrollment QR code" />
      <p class="enroll-qr-link">${data.url}</p>
      <p class="muted">Students scan this to enroll themselves into ${classroomSelect.options[classroomSelect.selectedIndex]?.textContent || "this classroom"} — no Wi-Fi match needed, works over their own mobile data.</p>`;
  } catch (err) {
    enrollQrBody.innerHTML = `<p class="muted">${err.message} Start it with <code>python start_enrollment_session.py</code> on this laptop, then reopen this panel.</p>`;
  }
}

enrollQrToggle.addEventListener("click", async () => {
  const opening = enrollQrPanel.classList.contains("hidden");
  enrollQrPanel.classList.toggle("hidden", !opening);
  enrollQrToggle.textContent = opening ? "Hide enrollment QR" : "Show enrollment QR";
  if (opening) await loadEnrollQr();
});

// ── Enroll Student tab: its own independent classroom picker ────────────────
const enrollClassroomSelect = document.getElementById("enroll-classroom-select");
let currentEnrollClassroomId = null;

async function loadEnrollClassrooms() {
  try {
    const response = await fetch("/api/attendance/classrooms");
    const data = await response.json();
    if (!data.ok || !data.classrooms.length) throw new Error(data.error || "No classrooms available.");
    enrollClassroomSelect.innerHTML = data.classrooms.map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
    const saved = localStorage.getItem("prism_classroom");
    currentEnrollClassroomId = (saved && data.classrooms.some((c) => c.id === saved)) ? saved : data.classrooms[0].id;
    enrollClassroomSelect.value = currentEnrollClassroomId;
  } catch (err) {
    console.error("Failed to load classrooms:", err);
  }
}

enrollClassroomSelect.addEventListener("change", () => {
  currentEnrollClassroomId = enrollClassroomSelect.value;
  localStorage.setItem("prism_classroom", currentEnrollClassroomId);
});

// ── Enroll Student tab ────────────────────────────────────────────────────────
const enrollForm        = document.getElementById("enroll-form");
const studentNameInput  = document.getElementById("student-name-input");
const enrollMediaInput  = document.getElementById("enroll-media-input");
const enrollMediaLabel  = document.getElementById("enroll-media-label");
const enrollStatus      = document.getElementById("enroll-status");
const enrollResult      = document.getElementById("enroll-result");

const markForm          = document.getElementById("mark-form");
const classroomPhotoInput = document.getElementById("classroom-photo-input");
const classroomPhotoLabel = document.getElementById("classroom-photo-label");
const markStatus        = document.getElementById("mark-status");
const markResult        = document.getElementById("mark-result");
const markedPhotoGallery = document.getElementById("marked-photo-gallery");
const presentList       = document.getElementById("present-list");
const suspiciousList    = document.getElementById("suspicious-list");
const absentList        = document.getElementById("absent-list");
const rosterList        = document.getElementById("roster-list");

enrollMediaInput.addEventListener("change", () => {
  enrollMediaLabel.textContent = selectedFileText(enrollMediaInput.files, "Choose photos or videos for enrollment");
});
classroomPhotoInput.addEventListener("change", () => {
  classroomPhotoLabel.textContent = selectedFileText(classroomPhotoInput.files, "Choose a classroom photo");
});

// Enrollment tab toggle
let enrollTab = "files";
let enrollCameraRecorder = null;
function switchEnrollTab(tab) {
  const previousTab = enrollTab;
  enrollTab = tab;
  document.getElementById("enroll-tab-files").style.display  = tab === "files"  ? "" : "none";
  document.getElementById("enroll-tab-folder").style.display = tab === "folder" ? "" : "none";
  document.getElementById("enroll-tab-camera").style.display = tab === "camera" ? "" : "none";
  document.getElementById("tab-files").classList.toggle("tab-active",  tab === "files");
  document.getElementById("tab-folder").classList.toggle("tab-active", tab === "folder");
  document.getElementById("tab-camera").classList.toggle("tab-active", tab === "camera");

  if (tab === "camera" && !enrollCameraRecorder) {
    enrollCameraRecorder = CameraRecorder.create(document.getElementById("enroll-camera-recorder"));
  }
  if (previousTab === "camera" && tab !== "camera" && enrollCameraRecorder) {
    enrollCameraRecorder.stopStream();
  }
}

enrollForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const studentName = studentNameInput.value.trim();
  if (!studentName) { enrollStatus.textContent = "Enter a student name."; enrollStatus.classList.add("error"); return; }

  const btn = enrollForm.querySelector("button[type='submit']");
  enrollStatus.classList.remove("error");
  enrollStatus.textContent = "Extracting embeddings and saving the student...";
  btn.disabled = true;

  try {
    let response, data;
    if (enrollTab === "folder") {
      const folderPath = document.getElementById("enroll-folder-input").value.trim();
      if (!folderPath) { enrollStatus.textContent = "Enter a folder path."; enrollStatus.classList.add("error"); btn.disabled = false; return; }
      response = await fetch("/api/attendance/enroll-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classroom: currentEnrollClassroomId, student_name: studentName, folder_path: folderPath }),
      });
      data = await response.json();
      if (data.ok) enrollStatus.textContent = `Enrolled ${data.student.name} from ${data.files_used} file(s).`;
    } else if (enrollTab === "camera") {
      const blob = enrollCameraRecorder && enrollCameraRecorder.getBlob();
      if (!blob) { enrollStatus.textContent = "Record a video first."; enrollStatus.classList.add("error"); btn.disabled = false; return; }
      const payload = new FormData();
      payload.append("classroom", currentEnrollClassroomId);
      payload.append("student_name", studentName);
      payload.append("media", blob, "recording.webm");
      response = await fetch("/api/attendance/enroll", { method: "POST", body: payload });
      data = await response.json();
      if (data.ok) { enrollStatus.textContent = `Enrolled ${data.student.name} successfully.`; enrollCameraRecorder.reset(); }
    } else {
      if (!enrollMediaInput.files.length) { enrollStatus.textContent = "Upload at least one photo or video."; enrollStatus.classList.add("error"); btn.disabled = false; return; }
      const payload = new FormData();
      payload.append("classroom", currentEnrollClassroomId);
      payload.append("student_name", studentName);
      Array.from(enrollMediaInput.files).forEach((f) => payload.append("media", f));
      response = await fetch("/api/attendance/enroll", { method: "POST", body: payload });
      data = await response.json();
      if (data.ok) enrollStatus.textContent = `Enrolled ${data.student.name} successfully.`;
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Enrollment failed.");
    renderEnrollmentResult(data.student, data.media_samples || []);
    if (currentEnrollClassroomId === currentClassroomId) await refreshAttendanceSummary();
  } catch (err) {
    enrollStatus.textContent = err.message;
    enrollStatus.classList.add("error");
  } finally { btn.disabled = false; }
});

markForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!classroomPhotoInput.files.length) { markStatus.textContent = "Upload at least one classroom photo first."; markStatus.classList.add("error"); return; }
  const btn = markForm.querySelector("button[type='submit']");
  const payload = new FormData();
  payload.append("classroom", currentClassroomId);
  Array.from(classroomPhotoInput.files).forEach((f) => payload.append("photos", f));
  markStatus.classList.remove("error");
  markStatus.textContent = classroomPhotoInput.files.length > 1
    ? `Detecting faces across ${classroomPhotoInput.files.length} photos and marking attendance...`
    : "Detecting faces and marking attendance...";
  btn.disabled = true;
  try {
    const response = await fetch("/api/attendance/mark", { method: "POST", body: payload });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Attendance marking failed.");
    renderMarkedPhotos(data.photos || []);
    renderAttendanceBuckets(data.present || [], data.suspicious || [], data.absent || [], data.unknown_faces || 0, data.unknown_faces_detail || []);
    renderRoster(data.roster || []);
    markStatus.textContent = `${data.present.length} present, ${data.suspicious.length} suspicious, ${data.absent.length} absent.`;
    markResult.classList.remove("hidden");
  } catch (err) {
    markStatus.textContent = err.message;
    markStatus.classList.add("error");
  } finally { btn.disabled = false; }
});

document.getElementById("demo-preview-btn").addEventListener("click", () => {
  markStatus.classList.remove("error");
  markStatus.textContent = "Demo classroom photo — original, no annotations.";
  markedPhotoGallery.innerHTML = `<img class="marked-photo-preview" src="/static/demo_classroom.jpg" alt="Demo classroom photo" />`;
  markResult.classList.remove("hidden");
  presentList.innerHTML = "";
  suspiciousList.innerHTML = "";
  absentList.innerHTML = "";
  hideUnknownFacesUI();
});

document.getElementById("demo-btn").addEventListener("click", async () => {
  const btn = document.getElementById("demo-btn");
  btn.disabled = true;
  markStatus.classList.remove("error");

  // Step 1 — show original unannotated image immediately
  markResult.classList.remove("hidden");
  markedPhotoGallery.innerHTML = `<img class="marked-photo-preview" src="/static/demo_classroom.jpg" alt="Demo classroom photo" />`;
  markStatus.textContent = "Here's the demo classroom photo. Running attendance pipeline...";

  // Step 2 — run the pipeline
  try {
    const response = await fetch(`/api/attendance/demo?classroom=${encodeURIComponent(currentClassroomId)}`, { method: "POST" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Demo failed.");
    renderMarkedPhotos([{ marked_url: data.marked_url, clean_url: data.clean_url }]);
    renderAttendanceBuckets(data.present || [], data.suspicious || [], data.absent || [], data.unknown_faces || 0, data.unknown_faces_detail || []);
    renderRoster(data.roster || []);
    markStatus.textContent = `Demo complete — ${data.present.length} present, ${data.suspicious.length} suspicious, ${data.absent.length} absent.`;
  } catch (err) {
    markStatus.textContent = err.message;
    markStatus.classList.add("error");
  } finally { btn.disabled = false; }
});

async function refreshAttendanceSummary() {
  if (!currentClassroomId) return;
  try {
    const response = await fetch(`/api/attendance/roster?classroom=${encodeURIComponent(currentClassroomId)}`);
    const data = await response.json();
    if (response.ok && data.ok) renderRoster(data.students || []);
  } catch (e) { console.error(e); }
}

function renderEnrollmentResult(student, mediaSamples) {
  if (!student) { enrollResult.classList.add("hidden"); return; }
  enrollResult.classList.remove("hidden");
  enrollResult.innerHTML = `
    <div class="result-summary">${student.name} enrolled — ${student.observations ?? 0} embeddings</div>
    <div class="result-detail">${mediaSamples.map((s) => `${s.file_name} (${s.frame_samples} frames)`).join(", ")}</div>`;
}

function renderMarkedPhotos(photos) {
  if (!photos || !photos.length) { markResult.classList.add("hidden"); return; }
  markResult.classList.remove("hidden");
  markedPhotoGallery.innerHTML = photos
    .map((p, i) => `<img class="marked-photo-preview" data-photo-index="${i}" src="${p.marked_url}" alt="Marked classroom photo ${i + 1}" />`)
    .join("");
  currentCleanPhotoUrls = photos.map((p) => p.clean_url);
  cleanPhotoImageCache = {};
}

const unknownFacesToggle = document.getElementById("unknown-faces-toggle");
const unknownFacesGrid   = document.getElementById("unknown-faces-grid");
let currentUnknownFaces  = [];
let unknownFacesExpanded = false;

let currentPresentFaces = [];

function renderAttendanceBuckets(present, suspicious, absent, unknownFaces, unknownFacesDetail) {
  currentPresentFaces = present.map((e) => ({ bbox: e.bbox, photoIndex: e.photo_index ?? 0 }));
  presentList.innerHTML = `<h3>Present (${present.length})</h3>
    ${present.length
      ? present.map((e, i) => `
        <div class="result-item present-item">
          <div class="present-item-row">
            <strong>${e.student.name}</strong>
            <span>Confidence ${formatNumber(e.confidence)}</span>
            <button type="button" class="show-face-btn" data-face-index="${i}">Show face</button>
          </div>
          <div class="face-reveal hidden" data-face-slot="${i}"></div>
        </div>`).join("")
      : '<div class="result-item muted">No students confidently recognized.</div>'}`;

  suspiciousList.innerHTML = `<h3>Suspicious (${suspicious.length})</h3>
    ${suspicious.length
      ? suspicious.map((e) => `
        <div class="result-item suspicious-item" data-review-id="${e.review_id}" data-bbox='${JSON.stringify(e.bbox)}' data-photo-index="${e.photo_index ?? 0}">
          <div class="present-item-row">
            <strong>${e.student.name}</strong>
            <span>Confidence ${formatNumber(e.confidence)} — please verify</span>
            <button type="button" class="show-face-btn">Show face</button>
          </div>
          <div class="face-reveal hidden"></div>
          <div class="suspicious-actions">
            <button type="button" class="suspicious-btn suspicious-confirm-btn" data-review-id="${e.review_id}">Yes, it's them</button>
            <button type="button" class="suspicious-btn suspicious-reject-btn" data-review-id="${e.review_id}">Not them</button>
          </div>
        </div>`).join("")
      : '<div class="result-item muted">None.</div>'}`;

  absentList.innerHTML = `<h3>Absent (${absent.length})</h3>
    ${absent.length
      ? absent.map((s) => `<div class="result-item absent-item"><strong>${s.name}</strong></div>`).join("")
      : '<div class="result-item muted">Everyone enrolled was seen.</div>'}`;

  currentUnknownFaces = unknownFacesDetail || [];
  unknownFacesExpanded = false;
  unknownFacesGrid.classList.add("hidden");
  unknownFacesGrid.innerHTML = "";

  if (currentUnknownFaces.length) {
    unknownFacesToggle.classList.remove("hidden");
    unknownFacesToggle.textContent = `Show unknown faces (${currentUnknownFaces.length})`;
  } else {
    unknownFacesToggle.classList.add("hidden");
  }
}

function addToAbsentList(name) {
  if ([...absentList.querySelectorAll(".absent-item strong")].some((el) => el.textContent === name)) return;
  const muted = absentList.querySelector(".muted");
  if (muted) muted.remove();
  absentList.insertAdjacentHTML("beforeend", `<div class="result-item absent-item"><strong>${name}</strong></div>`);
  const h3 = absentList.querySelector("h3");
  if (h3) h3.textContent = `Absent (${absentList.querySelectorAll(".absent-item").length})`;
}

function removeFromAbsentList(name) {
  const match = [...absentList.querySelectorAll(".absent-item")].find((el) => el.querySelector("strong")?.textContent === name);
  if (match) match.remove();
  const count = absentList.querySelectorAll(".absent-item").length;
  const h3 = absentList.querySelector("h3");
  if (h3) h3.textContent = `Absent (${count})`;
  if (count === 0 && !absentList.querySelector(".muted")) {
    absentList.insertAdjacentHTML("beforeend", '<div class="result-item muted">Everyone enrolled was seen.</div>');
  }
}

function addPresentEntry(student, confidence, bbox, photoIndex) {
  const muted = presentList.querySelector(".muted");
  if (muted) muted.remove();
  const index = currentPresentFaces.length;
  currentPresentFaces.push({ bbox, photoIndex: photoIndex ?? 0 });
  presentList.insertAdjacentHTML("beforeend", `
    <div class="result-item present-item">
      <div class="present-item-row">
        <strong>${student.name}</strong>
        <span>Confidence ${formatNumber(confidence)}</span>
        <button type="button" class="show-face-btn" data-face-index="${index}">Show face</button>
      </div>
      <div class="face-reveal hidden" data-face-slot="${index}"></div>
    </div>`);
  const h3 = presentList.querySelector("h3");
  if (h3) h3.textContent = `Present (${presentList.querySelectorAll(".present-item").length})`;
}

function addSuspiciousEntry(newSuspicious) {
  const muted = suspiciousList.querySelector(".muted");
  if (muted) muted.remove();
  suspiciousList.insertAdjacentHTML("beforeend", `
    <div class="result-item suspicious-item" data-review-id="${newSuspicious.review_id}" data-bbox='${JSON.stringify(newSuspicious.bbox)}' data-photo-index="${newSuspicious.photo_index ?? 0}">
      <div class="present-item-row">
        <strong>${newSuspicious.student.name}</strong>
        <span>Confidence ${formatNumber(newSuspicious.confidence)} — please verify</span>
        <button type="button" class="show-face-btn">Show face</button>
      </div>
      <div class="face-reveal hidden"></div>
      <div class="suspicious-actions">
        <button type="button" class="suspicious-btn suspicious-confirm-btn" data-review-id="${newSuspicious.review_id}">Yes, it's them</button>
        <button type="button" class="suspicious-btn suspicious-reject-btn" data-review-id="${newSuspicious.review_id}">Not them</button>
      </div>
    </div>`);
  const h3 = suspiciousList.querySelector("h3");
  if (h3) h3.textContent = `Suspicious (${suspiciousList.querySelectorAll(".suspicious-item").length})`;
}

async function addUnknownEntry(newUnknown) {
  currentUnknownFaces.push({
    bbox: newUnknown.bbox,
    similarity: newUnknown.similarity,
    photo_index: newUnknown.photo_index,
    review_id: newUnknown.review_id,
  });
  unknownFacesToggle.classList.remove("hidden");
  unknownFacesToggle.textContent = unknownFacesExpanded
    ? `Hide unknown faces (${currentUnknownFaces.length})`
    : `Show unknown faces (${currentUnknownFaces.length})`;
  if (unknownFacesExpanded) await renderUnknownFacesGrid();
}

// Confirming reinforces the model: the embedding that triggered the suspicious
// match gets added to that student's gallery (same as an automatic high-
// confidence match would). Rejecting doesn't just discard the face — it gets
// re-matched against the roster excluding the rejected student, and lands in
// Present/Suspicious/Unknown depending on what that re-match finds, while the
// wrongly-suggested student drops to Absent (unless seen elsewhere).
suspiciousList.addEventListener("click", async (event) => {
  const showBtn = event.target.closest(".show-face-btn");
  if (showBtn) {
    const item = showBtn.closest(".suspicious-item");
    const bbox = JSON.parse(item.dataset.bbox);
    const photoIndex = Number(item.dataset.photoIndex || 0);
    const slot = item.querySelector(".face-reveal");
    if (!slot.querySelector("img")) {
      try {
        const dataUrl = cropFaceThumbnail(imageAsCanvas(await getCleanPhotoImage(photoIndex)), bbox);
        slot.innerHTML = `<img src="${dataUrl}" alt="Face of suspicious match" />`;
      } catch (err) {
        slot.innerHTML = `<span class="muted">${err.message}</span>`;
        slot.classList.remove("hidden");
        showBtn.textContent = "Hide face";
        return;
      }
    }
    const wasVisible = !slot.classList.contains("hidden");
    slot.classList.toggle("hidden", wasVisible);
    showBtn.textContent = wasVisible ? "Show face" : "Hide face";
    return;
  }

  const confirmBtn = event.target.closest(".suspicious-confirm-btn");
  const rejectBtn  = event.target.closest(".suspicious-reject-btn");
  const btn = confirmBtn || rejectBtn;
  if (!btn) return;

  const confirmed = !!confirmBtn;
  const item = btn.closest(".suspicious-item");
  const reviewId = btn.dataset.reviewId;
  const name = item.querySelector("strong")?.textContent || "this student";
  item.querySelectorAll("button").forEach((b) => (b.disabled = true));

  try {
    const response = await fetch("/api/attendance/suspicious/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classroom: currentClassroomId, review_id: reviewId, confirmed }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Failed to resolve.");

    item.classList.remove("suspicious-item");
    item.classList.add(confirmed ? "present-item" : "absent-item");

    if (confirmed) {
      item.innerHTML = `<strong>${name}</strong><span>Confirmed — added to their gallery.</span>`;
      await refreshAttendanceSummary();
      return;
    }

    item.innerHTML = `<strong>${name}</strong><span>Not them — re-checked against the rest of the roster.</span>`;

    const stillPresent = [...presentList.querySelectorAll(".present-item strong")].some((el) => el.textContent === name);
    if (!stillPresent) addToAbsentList(name);

    if (data.outcome === "present" && data.new_match) {
      addPresentEntry(data.new_match.student, data.new_match.confidence, data.new_match.bbox, data.new_match.photo_index);
      removeFromAbsentList(data.new_match.student.name);
    } else if (data.outcome === "suspicious" && data.new_suspicious) {
      addSuspiciousEntry(data.new_suspicious);
    } else if (data.outcome === "unknown" && data.new_unknown) {
      await addUnknownEntry(data.new_unknown);
    }

    await refreshAttendanceSummary();
  } catch (err) {
    alert(err.message);
    item.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
});

function hideUnknownFacesUI() {
  currentUnknownFaces = [];
  unknownFacesExpanded = false;
  unknownFacesToggle.classList.add("hidden");
  unknownFacesGrid.classList.add("hidden");
  unknownFacesGrid.innerHTML = "";
}

function cropFaceThumbnail(sourceCanvas, bbox, pad = 26, outSize = 220) {
  const [x1, y1, x2, y2] = bbox;
  const px1 = Math.max(0, x1 - pad);
  const py1 = Math.max(0, y1 - pad);
  const px2 = Math.min(sourceCanvas.width, x2 + pad);
  const py2 = Math.min(sourceCanvas.height, y2 + pad);
  const pw = Math.max(1, px2 - px1);
  const ph = Math.max(1, py2 - py1);

  const out = document.createElement("canvas");
  const scale = Math.max(outSize / pw, outSize / ph);
  out.width = Math.round(pw * scale);
  out.height = Math.round(ph * scale);
  const octx = out.getContext("2d");
  octx.imageSmoothingQuality = "high";
  octx.drawImage(sourceCanvas, px1, py1, pw, ph, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.88);
}

function imageAsCanvas(imgEl) {
  const source = document.createElement("canvas");
  source.width = imgEl.naturalWidth;
  source.height = imgEl.naturalHeight;
  source.getContext("2d").drawImage(imgEl, 0, 0);
  return source;
}

// Face crops (Present "Show face", unknown-faces grid) are cropped from the
// pre-annotation photo, not the boxed/labelled preview — otherwise the
// revealed face would have a bounding-box border and confidence text drawn
// across it. With multiple photos per mark, each face crop has to come from
// the specific photo it was detected in — indexed by photo_index. Cached
// per index so repeated crops don't re-fetch/re-decode.
let currentCleanPhotoUrls = []; // clean_url per photo, indexed by photo_index
let cleanPhotoImageCache = {};  // { [photoIndex]: { url, img } }

function getCleanPhotoImage(photoIndex = 0) {
  return new Promise((resolve, reject) => {
    const url = currentCleanPhotoUrls[photoIndex];
    if (!url) { reject(new Error("No photo loaded yet.")); return; }
    const cached = cleanPhotoImageCache[photoIndex];
    if (cached && cached.url === url) {
      resolve(cached.img);
      return;
    }
    const img = new Image();
    img.onload = () => {
      cleanPhotoImageCache[photoIndex] = { url, img };
      resolve(img);
    };
    img.onerror = () => reject(new Error("Could not load photo for cropping."));
    img.src = url;
  });
}

async function cropUnknownFaceThumbnails(faces, pad = 26, outSize = 220) {
  const results = [];
  for (const { bbox, similarity, photo_index, review_id } of faces) {
    const source = imageAsCanvas(await getCleanPhotoImage(photo_index ?? 0));
    results.push({ dataUrl: cropFaceThumbnail(source, bbox, pad, outSize), similarity, reviewId: review_id });
  }
  return results;
}

// Present faces stay hidden by default (privacy) — a "Show face" button
// crops the face on demand from the already-rendered marked photo, the
// same technique used for the unknown-faces grid.
presentList.addEventListener("click", async (event) => {
  const btn = event.target.closest(".show-face-btn");
  if (!btn) return;
  const index = Number(btn.dataset.faceIndex);
  const face = currentPresentFaces[index];
  const slot = presentList.querySelector(`.face-reveal[data-face-slot="${index}"]`);
  if (!face || !slot) return;

  if (!slot.querySelector("img")) {
    try {
      const dataUrl = cropFaceThumbnail(imageAsCanvas(await getCleanPhotoImage(face.photoIndex)), face.bbox);
      slot.innerHTML = `<img src="${dataUrl}" alt="Face of recognized student" />`;
    } catch (err) {
      slot.innerHTML = `<span class="muted">${err.message}</span>`;
      slot.classList.remove("hidden");
      btn.textContent = "Hide face";
      return;
    }
  }
  const wasVisible = !slot.classList.contains("hidden");
  slot.classList.toggle("hidden", wasVisible);
  btn.textContent = wasVisible ? "Show face" : "Hide face";
});

async function renderUnknownFacesGrid() {
  const thumbs = await cropUnknownFaceThumbnails(currentUnknownFaces);
  unknownFacesGrid.innerHTML = thumbs
    .map(
      (t) => `
        <figure class="unknown-face-card" data-review-id="${t.reviewId ?? ""}">
          <img src="${t.dataUrl}" alt="Unrecognized face, similarity ${formatNumber(t.similarity)}" />
          <figcaption>Unknown &middot; ${formatNumber(t.similarity)}</figcaption>
          ${t.reviewId ? `
            <select class="assign-face-select">
              <option value="">Assign to...</option>
              ${currentRoster.map((s) => `<option value="${s.student_id}">${s.name}</option>`).join("")}
            </select>` : ""}
        </figure>`
    )
    .join("");
}

// A teacher identifying an unrecognized face as a specific enrolled student —
// reinforces that student's gallery with this embedding and marks them
// present, the same idea as confirming a suspicious match but for a face
// that had no name candidate at all.
unknownFacesGrid.addEventListener("change", async (event) => {
  const select = event.target.closest(".assign-face-select");
  if (!select) return;
  const studentId = select.value;
  if (!studentId) return;
  const card = select.closest(".unknown-face-card");
  const reviewId = card.dataset.reviewId;
  const studentName = select.options[select.selectedIndex].textContent;
  select.disabled = true;

  try {
    const response = await fetch("/api/attendance/unknown/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classroom: currentClassroomId, review_id: reviewId, student_id: studentId }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Failed to assign.");
    card.querySelector("figcaption").textContent = `Assigned to ${studentName}`;
    select.remove();
    await refreshAttendanceSummary();
  } catch (err) {
    alert(err.message);
    select.disabled = false;
  }
});

unknownFacesToggle.addEventListener("click", async () => {
  unknownFacesExpanded = !unknownFacesExpanded;
  if (unknownFacesExpanded) {
    unknownFacesGrid.classList.remove("hidden");
    unknownFacesToggle.textContent = `Hide unknown faces (${currentUnknownFaces.length})`;
    try {
      await renderUnknownFacesGrid();
    } catch (err) {
      unknownFacesGrid.innerHTML = `<div class="result-item muted">${err.message}</div>`;
    }
  } else {
    unknownFacesGrid.classList.add("hidden");
    unknownFacesToggle.textContent = `Show unknown faces (${currentUnknownFaces.length})`;
  }
});

let currentRoster = [];

function renderRoster(students) {
  currentRoster = students || [];
  if (!students.length) { rosterList.innerHTML = '<div class="result-item muted">No students enrolled yet.</div>'; return; }
  rosterList.innerHTML = students.map((s) => `
    <div class="roster-item" data-student-id="${s.student_id}">
      <div class="roster-item-main">
        <strong>${s.name}</strong>
        <span>${s.observations ?? 0} embeddings · ${s.updated_at ?? "-"}</span>
      </div>
      <button class="delete-student-button" type="button" data-student-id="${s.student_id}">Delete</button>
    </div>`).join("");
}

rosterList.addEventListener("click", async (event) => {
  const btn = event.target.closest(".delete-student-button");
  if (!btn) return;
  const studentId = btn.dataset.studentId;
  const name = btn.closest(".roster-item")?.querySelector("strong")?.textContent || "this student";
  if (!confirm(`Delete ${name}? This removes the student and their attendance records.`)) return;
  btn.disabled = true; btn.textContent = "Deleting...";
  try {
    const response = await fetch(`/api/attendance/students/${encodeURIComponent(studentId)}?classroom=${encodeURIComponent(currentClassroomId)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Delete failed.");
    renderRoster(data.students || []);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = "Delete"; }
});

// ── Lightbox ──────────────────────────────────────────────────────────────────
const lightbox      = document.getElementById("photo-lightbox");
const lightboxImg   = document.getElementById("lightbox-img");
const lightboxClose = document.getElementById("lightbox-close");
markedPhotoGallery.addEventListener("click", (event) => {
  const img = event.target.closest(".marked-photo-preview");
  if (!img) return;
  lightboxImg.src = img.src;
  lightbox.classList.remove("hidden");
});
lightboxClose.addEventListener("click", () => lightbox.classList.add("hidden"));
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) lightbox.classList.add("hidden"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") lightbox.classList.add("hidden"); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatWindow(s) { const n = Number(s); return isNaN(n) ? "-" : `${n.toFixed(2)}s`; }
function formatNumber(v) { if (v == null || isNaN(Number(v))) return "-"; return Number(v).toFixed(4); }

loadClassrooms();
loadEnrollClassrooms();
