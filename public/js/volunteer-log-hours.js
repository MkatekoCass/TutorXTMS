// Volunteer "Log attendance": only the sessions you've been assigned to
// cover — a tutor can't attend, so you take their tutorial or lab. Pick one
// of those sessions and log it while it's running, up to 10 minutes after
// it ends (the same window the server enforces). Submissions land in the
// same hour_entries store the tutor Log Hours page uses, tagged "Peer
// support" so the completed sessions page reads them back by month.

import { addEntry, findDuplicateEntry, requireRole } from "./storage.js";
import { highlightActiveTab } from "./nav.js";
import {
  windowStatus,
  windowNote,
  windowBlockMessage,
} from "./sessionTiming.js";

const currentUser = requireRole("volunteer");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

const CHIP_ACCENTS = [
  "chip-icon--blue",
  "chip-icon--violet",
  "chip-icon--teal",
  "chip-icon--amber",
];

const MODULE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5.5 6.7 12 10.4l6.5-3.7L12 3Z"/><path d="m7.5 9 4.5 2.6L16.5 9v5L12 16.6 7.5 14V9Z"/><path d="M18.5 7v5"/></svg>`;
const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

const courseChipsEl = document.getElementById("courseChips");
const sessionStepEl = document.getElementById("sessionStep");
const sessionChipsEl = document.getElementById("sessionChips");
const attendanceCardEl = document.getElementById("attendanceCard");
const scheduledLabelEl = document.getElementById("scheduledLabel");
const scheduledWhenEl = document.getElementById("scheduledWhen");
const scheduledVenueEl = document.getElementById("scheduledVenue");
const form = document.getElementById("attendance-form");
const startTimeField = document.getElementById("startTime");
const endTimeField = document.getElementById("endTime");
const notesField = document.getElementById("notes");
const formError = document.getElementById("form-error");
const durationValueEl = document.getElementById("duration-value");
const submitBtn = document.getElementById("submit-btn");

// Sessions this volunteer is covering, soonest first; filled by the init
// IIFE once /api/session-excusals answers. Course chips are drawn from the
// courses those sessions belong to.
let mySessions = [];
let selectedCourse = null;
let selectedSession = null;

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "YYYY-MM-DD" strings (session dates) parse as local dates so the weekday
// shown never shifts by a timezone.
function parseDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function sliceTime(time) {
  return (time || "").slice(0, 5);
}

// One session_excusals row (a session I'm covering) as the picker shows it:
// the covered slot's times and venue come from the course's timetable.
function sessionFromExcusal(row) {
  const course = { id: row.course_id, ...(row.courses || {}) };
  const isLab = row.session_type === "lab";
  return {
    course,
    date: parseDateStr(row.session_date),
    type: isLab ? "Lab" : "Tutorial",
    start: isLab ? course.lab_start_time : course.tutor_start_time,
    end: isLab ? course.lab_end_time : course.tutor_end_time,
    venue: (isLab ? course.lab_venues : course.venues) || "",
    tutorName: row.tutors?.name || "",
  };
}

// ---------- logged duration (sidebar) ----------

// Rounded to a whole hour, same convention as the tutor Log Hours page —
// minutes don't count either way, so a session is always credited as a
// whole number of hours, never a decimal.
function computeHours() {
  const start = startTimeField.value;
  const end = endTimeField.value;
  if (!start || !end) return null;
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const diffMinutes = endH * 60 + endM - (startH * 60 + startM);
  if (diffMinutes <= 0) return null;
  return Math.round(diffMinutes / 60);
}

function updateDuration() {
  const hours = computeHours();
  if (hours === null) {
    durationValueEl.textContent = "—";
  } else if (hours === 0) {
    durationValueEl.textContent = "Rounds to 0h";
  } else {
    durationValueEl.textContent = `${hours}h`;
  }
}

startTimeField.addEventListener("input", updateDuration);
endTimeField.addEventListener("input", updateDuration);

// ---------- chips ----------

function renderCourseChips(courses) {
  courseChipsEl.innerHTML = "";

  if (courses.length === 0) {
    courseChipsEl.innerHTML = `<p class="empty-state">You aren't covering any sessions right now — when a tutor can't attend and you're assigned to take over, the session shows up here.</p>`;
    return;
  }

  courses.forEach((course, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "course-chip";
    chip.dataset.courseId = course.id;
    chip.innerHTML = `
      <span class="chip-icon ${CHIP_ACCENTS[index % CHIP_ACCENTS.length]}">${MODULE_ICON}</span>
      <span class="course-chip__text">
        <span class="course-chip__code"></span>
        <span class="course-chip__name"></span>
      </span>
    `;
    chip.querySelector(".course-chip__code").textContent = course.course_code;
    chip.querySelector(".course-chip__name").textContent = course.course_name;
    chip.addEventListener("click", () => selectCourse(course, chip));
    courseChipsEl.appendChild(chip);
  });
}

function selectCourse(course, chip) {
  selectedCourse = course;
  courseChipsEl.querySelectorAll(".course-chip").forEach((el) => {
    el.classList.toggle("is-selected", el === chip);
  });
  renderSessionChips(course);
}

function renderSessionChips(course) {
  selectedSession = null;
  attendanceCardEl.hidden = true;
  sessionStepEl.hidden = false;

  const sessions = mySessions.filter(
    (session) => String(session.course.id) === String(course.id),
  );

  if (sessions.length === 0) {
    sessionChipsEl.innerHTML = `<p class="empty-state">Nothing to cover for this module right now — check back once a session is assigned to you.</p>`;
    return;
  }

  sessionChipsEl.innerHTML = "";
  sessions.forEach((session) => {
    const dateStr = toDateStr(session.date);
    const status = windowStatus(dateStr, session.start, session.end);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `session-chip ${status === "open" ? "is-open" : "is-locked"}`;
    chip.innerHTML = `
      <span class="session-chip__date">${CALENDAR_ICON}<span class="session-chip__day"></span></span>
      <span class="session-chip__time"></span>
      <span class="session-chip__note"></span>
    `;
    chip.querySelector(".session-chip__day").textContent =
      `${formatDate(session.date)} · ${session.type}`;
    chip.querySelector(".session-chip__time").textContent =
      `${sliceTime(session.start)}–${sliceTime(session.end)}${session.venue ? ` · ${session.venue}` : ""}`;
    chip.querySelector(".session-chip__note").textContent = windowNote(
      dateStr,
      session.start,
      session.end,
    );
    chip.addEventListener("click", () => selectSession(session, chip));
    sessionChipsEl.appendChild(chip);
  });
}

function selectSession(session, chip) {
  selectedSession = session;
  sessionChipsEl.querySelectorAll(".session-chip").forEach((el) => {
    el.classList.toggle("is-selected", el === chip);
  });

  scheduledLabelEl.textContent = session.tutorName
    ? `Covering for ${session.tutorName}`
    : "Covering for the tutor";
  scheduledWhenEl.textContent = `${formatDate(session.date)} · ${sliceTime(session.start)}–${sliceTime(session.end)}`;
  scheduledVenueEl.textContent = session.venue || "TBC";

  startTimeField.value = sliceTime(session.start);
  endTimeField.value = sliceTime(session.end);
  notesField.value = "";
  updateDuration();

  // Flag a session that can't be logged yet (or any more) as soon as it's
  // picked, so filling the form never ends in a surprise refusal.
  const dateStr = toDateStr(session.date);
  if (windowStatus(dateStr, session.start, session.end) === "open") {
    formError.hidden = true;
  } else {
    formError.textContent = windowBlockMessage(
      dateStr,
      session.start,
      session.end,
    );
    formError.hidden = false;
  }

  attendanceCardEl.hidden = false;
  attendanceCardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- submit ----------

function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedCourse || !selectedSession) return;

  // The session must be happening right now — its own day, from its start
  // until 10 minutes after it ends. The server re-checks this; doing it
  // here too means the volunteer sees why without a round-trip.
  const dateStr = toDateStr(selectedSession.date);
  if (
    windowStatus(dateStr, selectedSession.start, selectedSession.end) !== "open"
  ) {
    formError.textContent = windowBlockMessage(
      dateStr,
      selectedSession.start,
      selectedSession.end,
    );
    formError.hidden = false;
    return;
  }

  const hours = computeHours();
  if (hours === null) {
    formError.textContent = "The ending time must be after the starting time.";
    formError.hidden = false;
    return;
  }
  if (hours === 0) {
    formError.textContent =
      "That's under 30 minutes — double-check the times before submitting.";
    formError.hidden = false;
    return;
  }

  const payload = {
    date: dateStr,
    hours,
    startTime: startTimeField.value,
    endTime: endTimeField.value,
    taskType: "Peer support",
    courseId: selectedCourse.id,
    notes: notesField.value.trim(),
  };

  const duplicate = await findDuplicateEntry(payload);
  if (duplicate) {
    formError.textContent =
      "This overlaps an entry you've already logged for this day.";
    formError.hidden = false;
    return;
  }

  formError.hidden = true;
  submitBtn.disabled = true;
  try {
    await addEntry(payload);
    notesField.value = "";
    showToast("Attendance submitted — it's under Completed sessions.");
  } catch (err) {
    formError.textContent =
      err.message || "Couldn't submit your attendance — try again.";
    formError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- init: load the sessions this volunteer is covering ----------

(async () => {
  let rows = null;
  try {
    const res = await fetch(
      `/api/session-excusals?coverUserId=${encodeURIComponent(currentUser.id)}`,
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    rows = body;
  } catch {
    rows = null;
  }

  if (!rows) {
    courseChipsEl.innerHTML = `<p class="empty-state">Couldn't load your covers right now — try again later.</p>`;
    return;
  }

  // Only covers that can still be logged — a session whose window already
  // closed stays in the completed sessions list instead of the picker.
  mySessions = rows
    .map(sessionFromExcusal)
    .filter(
      (session) =>
        session.start &&
        session.end &&
        windowStatus(toDateStr(session.date), session.start, session.end) !==
          "expired",
    )
    .sort(
      (a, b) =>
        a.date - b.date || sliceTime(a.start).localeCompare(sliceTime(b.start)),
    );

  // One chip per course among those sessions, in the order they appear.
  const byCourse = new Map();
  mySessions.forEach((session) => {
    if (!byCourse.has(session.course.id)) {
      byCourse.set(session.course.id, session.course);
    }
  });
  renderCourseChips([...byCourse.values()]);
})();
window.AutoSync?.start(async () => {
  if (selectedCourse || selectedSession) return;
  const res = await fetch(
    `/api/session-excusals?coverUserId=${encodeURIComponent(currentUser.id)}`,
  );
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Couldn't load your covers.");
  mySessions = body
    .map(sessionFromExcusal)
    .filter(
      (session) =>
        session.start &&
        session.end &&
        windowStatus(toDateStr(session.date), session.start, session.end) !==
          "expired",
    )
    .sort(
      (a, b) =>
        a.date - b.date || sliceTime(a.start).localeCompare(sliceTime(b.start)),
    );
  const byCourse = new Map();
  mySessions.forEach((session) => {
    if (!byCourse.has(session.course.id)) {
      byCourse.set(session.course.id, session.course);
    }
  });
  renderCourseChips([...byCourse.values()]);
});
