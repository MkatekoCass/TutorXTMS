import { highlightActiveTab, renderWelcomeHeading } from "./nav.js";
import {
  requireRole,
  getEntriesForDate,
  loadSchedule,
  getScheduleForDate,
  addScheduleClasses,
  getCancelledOccurrencesForDate,
  cancelScheduleOccurrence,
  modifyScheduleOccurrence,
  clearScheduleException,
  updateScheduleClass,
  deleteScheduleClass,
  todayStr,
  clearSchedule,
} from "./storage.js";

// This script is shared by two pages: calendar.html (tutor) and
// student-calendar.html (student volunteer) — each declares which role it's
// for via data-page-role, so a user of the *other* role gets sent back to
// their own dashboard instead of landing on a page built for someone else.
const pageRole = document.body.dataset.pageRole || "tutor";
const currentUser = requireRole(pageRole);
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();
renderWelcomeHeading(currentUser.name);

// Tutorial/lab session pills come from this user's own approved course
// assignments — a tutor's via tutor_subject_preference, a student
// volunteer's via a whole-course course_volunteers approval (a claimed
// one-off overflow session isn't included here — it's a single date, not
// a recurring slot, and already has its own place on the student
// dashboard's Upcoming Sessions). Adding/editing/cancelling a class on the
// calendar is a plain scheduling tool either role can use.
const isTutor = currentUser.role === "tutor";
const canManageSchedule = true;

// Impossible typed dates must block the action — the mask surfaces the
// field's own message; test DOMs that never load date-mask.js pass through,
// same as the enhanceDateInputs guard in the occurrence editor below.
const ensureDateFieldValid = window.ensureDateFieldValid ?? (() => true);

// ---------- tutorial/lab sessions from the modules this tutor tutors ----------

// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday, matching Date#getDay().
const DAY_NAME_TO_INDEX = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

// Same light palette used on the tutor dashboard's "Upcoming sessions" list,
// so a course renders in the same colour everywhere it shows up.
const COURSE_COLORS = [
  { bg: "#e6eeef", text: "#26424b", border: "#26424b" }, // navy
  { bg: "#e3eee6", text: "#2f6b4f", border: "#b9d2c1" }, // green
  { bg: "#f5ead5", text: "#a66a17", border: "#e3cb9a" }, // amber
  { bg: "#ece6f5", text: "#5b3a91", border: "#c9b8e0" }, // purple
  { bg: "#dff0ef", text: "#1f7a72", border: "#a9d9d4" }, // teal
  { bg: "#f6e3ea", text: "#a13d67", border: "#e3b9cc" }, // rose
  { bg: "#e1ecf7", text: "#2560a3", border: "#b7d3ee" }, // blue
  { bg: "#eef0d8", text: "#6b7a1f", border: "#d6dba0" }, // olive
  { bg: "#f3e2d8", text: "#a85332", border: "#e6c2ac" }, // terracotta
];

function courseColor(courseId) {
  return COURSE_COLORS[Number(courseId) % COURSE_COLORS.length];
}

// Weekly-recurring Tutorial/Lab sessions for every module this user is
// approved for — flattened from courses (day/start/end/venue set straight
// on the course row, no separate "sessions" table). Courses carry no
// semester start/end date, so these repeat on every matching weekday shown
// on the calendar, same as the organiser's timetable grid does. Shared by
// both the tutor path (tutor_subject_preference) and the student volunteer
// path (a whole-course course_volunteers approval) below — same shape
// either way, just a different source table.
let courseSessions = [];

// The tutor's own session excusals, keyed so render() can look up whether a
// given course session on a given date is excused:
// "<courseId>|<date>|<tutorial|lab>". Excusals recorded before session_type
// existed have none, and are keyed "<courseId>|<date>|*" (any session that day).
let excusalsByKey = new Map();

function excusalKey(courseId, dateStr, sessionType) {
  return `${courseId}|${dateStr}|${sessionType || "*"}`;
}

function findExcusal(session, dateStr) {
  return (
    excusalsByKey.get(
      excusalKey(session.courseId, dateStr, session.type.toLowerCase()),
    ) || excusalsByKey.get(excusalKey(session.courseId, dateStr, null))
  );
}

async function fetchExcusals() {
  try {
    const res = await fetch(
      `/api/session-excusals?tutorId=${encodeURIComponent(currentUser.id)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load excusals");
    excusalsByKey = new Map(
      rows.map((e) => [
        excusalKey(e.course_id, e.session_date, e.session_type),
        e,
      ]),
    );
  } catch {
    excusalsByKey = new Map();
  }
}

// For a student volunteer: the tutors' sessions they've been assigned to
// cover, keyed by date, so render() can drop a "Cover" pill onto that day.
let coversByDate = new Map();

async function fetchCovers() {
  try {
    const res = await fetch(
      `/api/session-excusals?coverUserId=${encodeURIComponent(currentUser.id)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load covers");
    coversByDate = new Map();
    for (const excusal of rows) {
      const course = excusal.courses || {};
      const isLab = excusal.session_type === "lab";
      const start = isLab ? course.lab_start_time : course.tutor_start_time;
      const end = isLab ? course.lab_end_time : course.tutor_end_time;
      const cover = {
        courseId: excusal.course_id,
        courseCode: course.course_code || "Session",
        type: isLab ? "Lab" : "Tutorial",
        start: start ? start.slice(0, 5) : "",
        end: end ? end.slice(0, 5) : "",
        venue: (isLab ? course.lab_venues : course.venues) || "",
        tutorName: excusal.tutors?.name || "a tutor",
      };
      const list = coversByDate.get(excusal.session_date) || [];
      list.push(cover);
      coversByDate.set(excusal.session_date, list);
    }
  } catch {
    coversByDate = new Map();
  }
}

function sessionsFromCourse(course, courseId) {
  const sessions = [];
  if (!course) return sessions;

  if (
    course.Day_of_tut &&
    course.tutor_start_time &&
    course.tutor_end_time &&
    DAY_NAME_TO_INDEX[course.Day_of_tut] !== undefined
  ) {
    sessions.push({
      courseId,
      courseCode: course.course_code,
      type: "Tutorial",
      dayIndex: DAY_NAME_TO_INDEX[course.Day_of_tut],
      start: course.tutor_start_time.slice(0, 5),
      end: course.tutor_end_time.slice(0, 5),
      venue: course.venues || "",
    });
  }

  if (
    course.Day_of_lab &&
    course.lab_start_time &&
    course.lab_end_time &&
    DAY_NAME_TO_INDEX[course.Day_of_lab] !== undefined
  ) {
    sessions.push({
      courseId,
      courseCode: course.course_code,
      type: "Lab",
      dayIndex: DAY_NAME_TO_INDEX[course.Day_of_lab],
      start: course.lab_start_time.slice(0, 5),
      end: course.lab_end_time.slice(0, 5),
      venue: course.lab_venues || "",
    });
  }

  return sessions;
}

async function fetchTutorCourseSessions() {
  const res = await fetch(
    `/api/tutor-applications?tutorId=${encodeURIComponent(currentUser.id)}`,
  );
  const rows = await res.json();
  if (!res.ok) throw new Error(rows.error || "Failed to load course sessions");

  return rows
    .filter((app) => (app.status || "").toLowerCase() === "approved")
    .flatMap((app) => sessionsFromCourse(app.courses, app.course_id));
}

// A claimed overflow session (has its own session_date) is deliberately
// excluded here — it's a single date, not a recurring slot, and already
// shown on the student dashboard's own Upcoming Sessions.
async function fetchVolunteerCourseSessions() {
  const res = await fetch(
    `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
  );
  const rows = await res.json();
  if (!res.ok) throw new Error(rows.error || "Failed to load course sessions");

  return rows
    .filter((app) => app.status === "approved" && !app.session_date)
    .flatMap((app) => sessionsFromCourse(app.courses, app.course_id));
}

async function fetchCourseSessions() {
  if (!isTutor) {
    await fetchCovers();
  } else {
    await fetchExcusals();
  }
  try {
    courseSessions = isTutor
      ? await fetchTutorCourseSessions()
      : await fetchVolunteerCourseSessions();
  } catch {
    courseSessions = [];
  }
  renderCourseColorKey();
}

// One chip per course actually appearing on the calendar (tutorial/lab
// pills use a different colour per course, cycling through COURSE_COLORS —
// this just explains which is which), rather than every course the tutor
// could possibly be assigned regardless of whether it shows up here.
const courseColorKeyEl = document.getElementById("course-color-key");

function renderCourseColorKey() {
  if (!courseColorKeyEl) return;

  const courses = new Map();
  for (const s of courseSessions) {
    if (!courses.has(s.courseId)) courses.set(s.courseId, s.courseCode);
  }

  courseColorKeyEl.innerHTML = "";
  if (courses.size === 0) {
    courseColorKeyEl.hidden = true;
    return;
  }

  for (const [courseId, courseCode] of courses) {
    const palette = courseColor(courseId);
    const chip = document.createElement("span");
    chip.className = "course-color-chip";
    chip.style.background = palette.bg;
    chip.style.borderColor = palette.border;
    chip.style.color = palette.text;
    chip.textContent = courseCode;
    courseColorKeyEl.appendChild(chip);
  }

  if (excusalsByKey.size > 0) {
    const excusedChip = document.createElement("span");
    excusedChip.className = "course-color-chip";
    excusedChip.innerHTML =
      '<span class="calendar-excused-tag">Excused</span><span class="calendar-excused-label">struck through</span> = you&rsquo;ve excused yourself';
    courseColorKeyEl.appendChild(excusedChip);
  }
  courseColorKeyEl.hidden = false;
}

const monthLabelEl = document.getElementById("calendar-month-label");
const gridEl = document.getElementById("calendar-grid");
const prevMonthBtn = document.getElementById("prev-month-btn");
const nextMonthBtn = document.getElementById("next-month-btn");
const clearClassesBtn = document.getElementById("clear-classes-btn");

const addClassBtn = document.getElementById("add-class-btn");
const addClassCard = document.getElementById("add-class-card");
const addClassForm = document.getElementById("add-class-form");
const addClassDateInput = document.getElementById("add-class-date");
const addClassSubjectInput = document.getElementById("add-class-subject");
const addClassStartInput = document.getElementById("add-class-start");
const addClassEndInput = document.getElementById("add-class-end");
const addClassVenueInput = document.getElementById("add-class-venue");
const addClassRepeatInput = document.getElementById("add-class-repeat");
const addClassRepeatUntilField = document.getElementById(
  "add-class-repeat-until-field",
);
const addClassRepeatUntilInput = document.getElementById(
  "add-class-repeat-until",
);
const cancelAddClassBtn = document.getElementById("cancel-add-class-btn");

// ---------- toast ----------

let toastTimer = null;
function showToast(message, type = "success") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("toast--success", "toast--danger");
  el.classList.add(`toast--${type}`, "show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- confirm dialog ----------

// Replaces the browser's native confirm() with an in-app dialog matching the
// rest of the UI, since the native one can't be styled at all. Resolves true
// on "Confirm", false on "Cancel" or Escape/backdrop dismissal.
const confirmModal = document.getElementById("confirm-modal");
const confirmModalMessage = document.getElementById("confirm-modal-message");
const confirmModalConfirmBtn = document.getElementById(
  "confirm-modal-confirm-btn",
);
const confirmModalCancelBtn = document.getElementById(
  "confirm-modal-cancel-btn",
);

function showConfirm(message, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    confirmModalMessage.textContent = message;
    confirmModalConfirmBtn.textContent = confirmLabel;
    confirmModal.showModal();

    function settle(result) {
      confirmModal.close();
      confirmModalConfirmBtn.removeEventListener("click", onConfirm);
      confirmModalCancelBtn.removeEventListener("click", onCancel);
      confirmModal.removeEventListener("cancel", onCancel);
      resolve(result);
    }
    function onConfirm() {
      settle(true);
    }
    function onCancel() {
      settle(false);
    }

    confirmModalConfirmBtn.addEventListener("click", onConfirm);
    confirmModalCancelBtn.addEventListener("click", onCancel);
    confirmModal.addEventListener("cancel", onCancel); // Escape key
  });
}

// Every class change is saved to the server before the calendar shows it.
// Runs `save`, then re-renders with a success toast — or, if the save
// failed, leaves the calendar as it was and says why. Resolves to whether
// it worked.
async function saveScheduleChange(save, successMessage, toastType) {
  try {
    await save();
  } catch (err) {
    showToast(err.message || "Couldn't save that change.", "danger");
    return false;
  }
  render();
  showToast(successMessage, toastType);
  return true;
}

function openAddClassForm(dateStr, startTime) {
  addClassDateInput.value = dateStr || todayStr();
  addClassStartInput.value = startTime || "";
  addClassEndInput.value = startTime ? oneHourLater(startTime) : "";
  syncRepeatFields();
  addClassCard.hidden = false;
  addClassCard.scrollIntoView({ behavior: "smooth", block: "center" });
  addClassSubjectInput.focus();
}

// "14:30" -> "15:30" (capped at 23:00), so a slot clicked on the day view
// pre-fills a sensible end time in the add-class form.
function oneHourLater(timeStr) {
  return minutesToTimeStr(Math.min(timeToMinutes(timeStr) + 60, 23 * 60));
}

function closeAddClassForm() {
  addClassCard.hidden = true;
  addClassForm.reset();
  syncRepeatFields();
}

// "Repeat weekly" reveals the until-date and makes it required, with the
// class's own date as its earliest allowed value, so the browser's form
// validation rejects an empty or backwards range before submit runs.
function syncRepeatFields() {
  const repeating = addClassRepeatInput.checked;
  addClassRepeatUntilField.hidden = !repeating;
  addClassRepeatUntilInput.required = repeating;
  addClassRepeatUntilInput.min = addClassDateInput.value || "";
}

if (canManageSchedule) {
  addClassBtn.addEventListener("click", () => openAddClassForm(todayStr()));
  cancelAddClassBtn.addEventListener("click", closeAddClassForm);
  addClassRepeatInput.addEventListener("change", syncRepeatFields);
  addClassDateInput.addEventListener("change", syncRepeatFields);

  addClassForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const date = addClassDateInput.value;
    const [y, m, d] = date.split("-").map(Number);
    const dayOfWeek = new Date(y, m - 1, d).getDay();
    const repeating = addClassRepeatInput.checked;
    // Same weekly-series shape the timetable import saves: one class on
    // dayOfWeek, every week from firstDate through endDate.
    const endDate = repeating ? addClassRepeatUntilInput.value : date;

    const newClass = {
      title: addClassSubjectInput.value.trim(),
      dayOfWeek,
      firstDate: date,
      endDate,
      startTime: addClassStartInput.value,
      endTime: addClassEndInput.value,
      venue: addClassVenueInput.value.trim(),
    };

    // The form stays open (with what was typed) if the save fails.
    const saved = await saveScheduleChange(
      () => addScheduleClasses([newClass]),
      repeating ? "Weekly class added." : "Class added.",
    );
    if (!saved) return;
    closeAddClassForm();
    viewYear = y;
    viewMonth = m - 1;
    render();
  });
}

const today = new Date();
let viewYear = today.getFullYear();
let viewMonth = today.getMonth(); // 0-11

function toDateStr(year, month, day) {
  const y = year;
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// render() awaits a real fetch per day cell (getEntriesForDate), and it's
// called twice in quick succession at load (once directly, once after
// fetchCourseSessions resolves) plus again from prev/next/import handlers.
// Without this guard, an older in-flight call resumes after a newer one has
// already finished and keeps appending its own cells on top — doubling the
// whole grid. Each call claims a token; any call that finds itself stale
// after an await bails out instead of touching the DOM.
let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const monthStart = new Date(viewYear, viewMonth, 1);
  monthLabelEl.textContent = monthStart.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstWeekday = monthStart.getDay(); // 0 = Sunday
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const current = todayStr();

  gridEl.innerHTML = "";

  for (let i = 0; i < totalCells; i++) {
    const dayOffset = i - firstWeekday + 1;
    const cell = document.createElement("div");
    cell.className = "calendar-day";

    let cellYear = viewYear;
    let cellMonth = viewMonth;
    let cellDay = dayOffset;

    if (dayOffset < 1) {
      cellMonth = viewMonth - 1;
      cellYear = cellMonth < 0 ? viewYear - 1 : viewYear;
      cellMonth = (cellMonth + 12) % 12;
      cellDay = daysInPrevMonth + dayOffset;
      cell.classList.add("other-month");
    } else if (dayOffset > daysInMonth) {
      cellDay = dayOffset - daysInMonth;
      cellMonth = viewMonth + 1;
      cellYear = cellMonth > 11 ? viewYear + 1 : viewYear;
      cellMonth = cellMonth % 12;
      cell.classList.add("other-month");
    }

    const cellDateStr = toDateStr(cellYear, cellMonth, cellDay);
    if (cellDateStr === current) cell.classList.add("today");

    if (canManageSchedule) {
      cell.classList.add("calendar-day-clickable");
      cell.title = "Click to open this day in detail";
      cell.addEventListener("click", (e) => {
        // Pills inside the cell (sessions, classes, logged hours) handle
        // their own clicks — those shouldn't also open the day view.
        if (
          e.target.closest(
            ".calendar-course-pill, .calendar-class-pill, .calendar-session-pill",
          )
        )
          return;
        openDayView(cellDateStr);
      });
    }

    const dayNumber = document.createElement("span");
    dayNumber.className = "calendar-day-number";
    dayNumber.textContent = cellDay;
    cell.appendChild(dayNumber);

    if (isTutor) {
      const cellWeekday = new Date(cellYear, cellMonth, cellDay).getDay();
      for (const s of courseSessions) {
        if (s.dayIndex !== cellWeekday) continue;
        const palette = courseColor(s.courseId);
        const excusal = findExcusal(s, cellDateStr);
        const pill = document.createElement("div");
        pill.className = "calendar-course-pill";
        pill.style.background = palette.bg;
        pill.style.borderColor = palette.border;
        pill.style.color = palette.text;
        const label = `${s.start} ${s.courseCode} · ${s.type === "Lab" ? "Lab" : "Tut"}`;
        const details = `${s.courseCode} ${s.type} · ${s.start}–${s.end}${s.venue ? ` · ${s.venue}` : ""}`;
        if (excusal) {
          pill.classList.add("calendar-course-pill--excused");
          const tag = document.createElement("span");
          tag.className = "calendar-excused-tag";
          tag.textContent = "Excused";
          const text = document.createElement("span");
          text.className = "calendar-excused-label";
          text.textContent = label;
          pill.append(tag, text);
          const coverText = excusal.cover?.name
            ? ` · ${excusal.cover.name} is covering`
            : " · no volunteer cover yet";
          pill.title = `You're excused from this session — ${details}${coverText}${excusal.reason ? ` · Reason: ${excusal.reason}` : ""}`;
        } else {
          pill.textContent = label;
          pill.title = details;
        }
        cell.appendChild(pill);
      }
    } else {
      for (const c of coversByDate.get(cellDateStr) || []) {
        const palette = courseColor(c.courseId);
        const pill = document.createElement("div");
        pill.className = "calendar-course-pill calendar-course-pill--cover";
        pill.style.background = palette.bg;
        pill.style.borderColor = palette.border;
        pill.style.color = palette.text;
        const tag = document.createElement("span");
        tag.className = "calendar-cover-tag";
        tag.textContent = "Cover";
        pill.append(
          tag,
          `${c.start} ${c.courseCode} · ${c.type === "Lab" ? "Lab" : "Tut"}`,
        );
        pill.title = `You're covering ${c.courseCode} ${c.type} for ${c.tutorName} · ${c.start}–${c.end}${c.venue ? ` · ${c.venue}` : ""}`;
        cell.appendChild(pill);
      }
    }

    const classes = getScheduleForDate(cellDateStr);
    for (const cls of classes) {
      const pill = document.createElement("div");
      pill.className = "calendar-class-pill";
      // Day cells are narrow, so show just the course code — full title is in the tooltip.
      const courseCode = (cls.title.match(/^[A-Z]{2,6}\s?\d{3,4}[A-Z]?/) || [
        cls.title,
      ])[0];
      const modifiedMark = cls.isModifiedOccurrence ? " \u270E" : "";
      pill.textContent = `${cls.startTime} ${courseCode}${modifiedMark}`;
      pill.title = cls.isModifiedOccurrence
        ? `${cls.title} · ${cls.startTime}-${cls.endTime} · ${cls.venue} · edited for this day`
        : `${cls.title} · ${cls.startTime}-${cls.endTime} · ${cls.venue}`;
      if (canManageSchedule) {
        pill.classList.add("calendar-class-pill--editable");
        pill.addEventListener("click", () =>
          openOccurrenceModal(cls, cellDateStr, false),
        );
      }
      cell.appendChild(pill);
    }

    if (canManageSchedule) {
      const cancelled = getCancelledOccurrencesForDate(cellDateStr);
      for (const cls of cancelled) {
        const pill = document.createElement("div");
        pill.className = "calendar-class-pill calendar-class-pill--cancelled";
        const courseCode = (cls.title.match(/^[A-Z]{2,6}\s?\d{3,4}[A-Z]?/) || [
          cls.title,
        ])[0];
        pill.textContent = `\u2715 ${courseCode}`;
        pill.title = `${cls.title} cancelled for this day · click to restore`;
        pill.addEventListener("click", () =>
          openOccurrenceModal(cls, cellDateStr, true),
        );
        cell.appendChild(pill);
      }
    }

    const entries = await getEntriesForDate(cellDateStr);
    if (token !== renderToken) return; // superseded by a newer render() call

    for (const entry of entries) {
      const pill = document.createElement("div");
      pill.className = "calendar-session-pill";
      const label = [`${entry.hours}h`, entry.subject]
        .filter(Boolean)
        .join(" · ");
      pill.textContent = label;
      cell.appendChild(pill);
    }

    gridEl.appendChild(cell);
  }
}

prevMonthBtn.addEventListener("click", () => {
  viewMonth -= 1;
  if (viewMonth < 0) {
    viewMonth = 11;
    viewYear -= 1;
  }
  render();
});

nextMonthBtn.addEventListener("click", () => {
  viewMonth += 1;
  if (viewMonth > 11) {
    viewMonth = 0;
    viewYear += 1;
  }
  render();
});

// Popup for managing a class — edit this occurrence, the recurring series,
// cancel/restore, or delete entirely.
const DAY_INDEX_TO_NAME = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// "2026-01-15" → 4 (Thursday), matching Date#getDay(); null when there's no
// usable date.
function weekdayFromDateStr(dateStr) {
  const [y, m, d] = (dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getDay();
}

// A class repeats weekly when its range spans more than its first day — the
// shape both the add-class form and the timetable import save series in.
function isRepeatingClass(cls) {
  return Boolean(cls.firstDate && cls.endDate && cls.endDate > cls.firstDate);
}

function openOccurrenceModal(cls, dateStr, isCancelled) {
  const overlay = document.createElement("div");
  overlay.className = "occurrence-modal-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "1000",
    overflowY: "auto",
    padding: "24px 0",
  });

  const box = document.createElement("div");
  box.className = "card occurrence-modal";
  Object.assign(box.style, {
    maxWidth: "440px",
    width: "92%",
    maxHeight: "90vh",
    overflowY: "auto",
  });

  function closeModal() {
    overlay.remove();
  }

  // ---- Header ----
  const heading = document.createElement("h2");
  heading.textContent = isCancelled ? "Cancelled class" : "Edit class";
  box.appendChild(heading);

  const dateLine = document.createElement("p");
  dateLine.className = "card-hint";
  dateLine.textContent = new Date(dateStr + "T00:00:00").toLocaleDateString(
    undefined,
    { weekday: "long", month: "long", day: "numeric" },
  );
  box.appendChild(dateLine);

  if (isCancelled) {
    // ---- Cancelled state: restore or close ----
    const note = document.createElement("p");
    note.textContent = "This class is cancelled on this day.";
    box.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "form-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "btn-primary";
    restoreBtn.textContent = "Restore this class";
    restoreBtn.addEventListener("click", () => {
      closeModal();
      saveScheduleChange(
        () => clearScheduleException(cls.id, dateStr),
        "Class restored.",
      );
    });
    actions.appendChild(restoreBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-secondary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeModal);
    actions.appendChild(closeBtn);

    box.appendChild(actions);
  } else {
    // ---- Editable form (review-table style) ----
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["Field", "Value"].forEach((t) => {
      const th = document.createElement("th");
      th.textContent = t;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    // Subject row
    const subjectRow = document.createElement("tr");
    const subjectLabel = document.createElement("td");
    subjectLabel.textContent = "Subject";
    const subjectCell = document.createElement("td");
    const subjectInput = document.createElement("input");
    subjectInput.type = "text";
    subjectInput.value = cls.title || "";
    subjectInput.style.width = "100%";
    subjectCell.appendChild(subjectInput);
    subjectRow.append(subjectLabel, subjectCell);
    tbody.appendChild(subjectRow);

    // Day row (read-only for context)
    const dayRow = document.createElement("tr");
    const dayLabel = document.createElement("td");
    dayLabel.textContent = "Day";
    const dayCell = document.createElement("td");
    dayCell.textContent = DAY_INDEX_TO_NAME[cls.dayOfWeek] || "";
    dayRow.append(dayLabel, dayCell);
    tbody.appendChild(dayRow);

    // Start time row
    const startRow = document.createElement("tr");
    const startLabel = document.createElement("td");
    startLabel.textContent = "Start time";
    const startCell = document.createElement("td");
    const startInput = document.createElement("input");
    startInput.type = "time";
    startInput.value = cls.startTime || "";
    startCell.appendChild(startInput);
    startRow.append(startLabel, startCell);
    tbody.appendChild(startRow);

    // End time row
    const endRow = document.createElement("tr");
    const endLabel = document.createElement("td");
    endLabel.textContent = "End time";
    const endCell = document.createElement("td");
    const endInput = document.createElement("input");
    endInput.type = "time";
    endInput.value = cls.endTime || "";
    endCell.appendChild(endInput);
    endRow.append(endLabel, endCell);
    tbody.appendChild(endRow);

    // Venue row
    const venueRow = document.createElement("tr");
    const venueLabel = document.createElement("td");
    venueLabel.textContent = "Venue";
    const venueCell = document.createElement("td");
    const venueInput = document.createElement("input");
    venueInput.type = "text";
    venueInput.value = cls.venue || "";
    venueInput.style.width = "100%";
    venueCell.appendChild(venueInput);
    venueRow.append(venueLabel, venueCell);
    tbody.appendChild(venueRow);

    table.appendChild(tbody);
    box.appendChild(table);

    // ---- Per-occurrence actions ----
    const occurrenceSection = document.createElement("div");
    occurrenceSection.style.marginTop = "12px";

    const occHint = document.createElement("p");
    occHint.className = "card-hint";
    occHint.textContent =
      "Changes below apply only to this one day — every other week keeps the usual details.";
    occurrenceSection.appendChild(occHint);

    const occActions = document.createElement("div");
    occActions.className = "form-actions";

    const saveOccBtn = document.createElement("button");
    saveOccBtn.type = "button";
    saveOccBtn.className = "btn-primary";
    saveOccBtn.textContent = "Save for this day only";
    saveOccBtn.addEventListener("click", () => {
      const overrides = {
        title: subjectInput.value.trim() || cls.title,
        startTime: startInput.value || cls.startTime,
        endTime: endInput.value || cls.endTime,
        venue: venueInput.value,
      };
      closeModal();
      saveScheduleChange(
        () => modifyScheduleOccurrence(cls.id, dateStr, overrides),
        "Saved for this day.",
      );
    });
    occActions.appendChild(saveOccBtn);

    const cancelOccBtn = document.createElement("button");
    cancelOccBtn.type = "button";
    cancelOccBtn.className = "btn-danger";
    cancelOccBtn.textContent = "Cancel class for this day";
    cancelOccBtn.addEventListener("click", () => {
      closeModal();
      saveScheduleChange(
        () => cancelScheduleOccurrence(cls.id, dateStr),
        "Class cancelled for this day.",
        "danger",
      );
    });
    occActions.appendChild(cancelOccBtn);

    if (cls.isModifiedOccurrence) {
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.className = "btn-secondary";
      revertBtn.textContent = "Revert to default";
      revertBtn.addEventListener("click", () => {
        closeModal();
        saveScheduleChange(
          () => clearScheduleException(cls.id, dateStr),
          "Reverted to the recurring default.",
        );
      });
      occActions.appendChild(revertBtn);
    }

    occurrenceSection.appendChild(occActions);
    box.appendChild(occurrenceSection);

    // ---- Recurring series actions ----
    const seriesSection = document.createElement("div");
    seriesSection.style.marginTop = "16px";
    seriesSection.style.borderTop = "1px solid #e0e0e0";
    seriesSection.style.paddingTop = "12px";

    const wasRepeating = isRepeatingClass(cls);

    const seriesHint = document.createElement("p");
    seriesHint.className = "card-hint";
    seriesHint.textContent =
      "Changes below update the class itself — tick Repeat weekly to run it every week from a start date through an end date, and the details above apply to every week in that range.";
    seriesSection.appendChild(seriesHint);

    // Unlike the add-class form (which creates a one-off or a weekly series
    // outright), this can also turn an already-saved class into a weekly
    // series — or extend, shorten or stop an existing one.
    const repeatLabel = document.createElement("label");
    repeatLabel.className = "field-checkbox";
    repeatLabel.htmlFor = "occurrence-repeat";
    const repeatInput = document.createElement("input");
    repeatInput.type = "checkbox";
    repeatInput.id = "occurrence-repeat";
    repeatInput.checked = wasRepeating;
    repeatLabel.append(repeatInput, "Repeat weekly");
    seriesSection.appendChild(repeatLabel);

    const repeatRange = document.createElement("div");
    repeatRange.className = "form-grid";
    repeatRange.id = "occurrence-repeat-range";

    const repeatFromField = document.createElement("div");
    repeatFromField.className = "form-field";
    const repeatFromLabel = document.createElement("label");
    repeatFromLabel.htmlFor = "occurrence-repeat-from";
    repeatFromLabel.textContent = "Repeat from";
    const repeatFromInput = document.createElement("input");
    repeatFromInput.type = "date";
    repeatFromInput.id = "occurrence-repeat-from";
    repeatFromInput.value = cls.firstDate || dateStr;
    repeatFromField.append(repeatFromLabel, repeatFromInput);

    const repeatUntilField = document.createElement("div");
    repeatUntilField.className = "form-field";
    const repeatUntilLabel = document.createElement("label");
    repeatUntilLabel.htmlFor = "occurrence-repeat-until";
    repeatUntilLabel.textContent = "Repeat until";
    const repeatUntilInput = document.createElement("input");
    repeatUntilInput.type = "date";
    repeatUntilInput.id = "occurrence-repeat-until";
    repeatUntilInput.value = wasRepeating ? cls.endDate : "";
    repeatUntilField.append(repeatUntilLabel, repeatUntilInput);

    repeatRange.append(repeatFromField, repeatUntilField);
    seriesSection.appendChild(repeatRange);

    // Only shown when the user unticks an existing repeat — saving then ends
    // the series at the day that was opened.
    const repeatNote = document.createElement("p");
    repeatNote.className = "card-hint";
    repeatNote.id = "occurrence-repeat-note";
    repeatNote.hidden = true;
    repeatNote.textContent = `Saving now stops the repeat after ${new Date(
      dateStr + "T00:00:00",
    ).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
    })} — earlier weeks stay as they are.`;
    seriesSection.appendChild(repeatNote);

    // The weekly series follows its start date: changing that date moves the
    // class to that weekday (the same rule the add form uses), so the
    // read-only Day row above shows what saving will do.
    function syncSeriesRepeatFields() {
      const repeating = repeatInput.checked;
      repeatRange.hidden = !repeating;
      repeatNote.hidden = repeating || !wasRepeating;
      repeatUntilInput.min = repeatFromInput.value || "";
      const weekday = weekdayFromDateStr(repeatFromInput.value);
      dayCell.textContent =
        (repeating && weekday !== null
          ? DAY_INDEX_TO_NAME[weekday]
          : DAY_INDEX_TO_NAME[cls.dayOfWeek]) || "";
    }
    repeatInput.addEventListener("change", syncSeriesRepeatFields);
    repeatFromInput.addEventListener("change", syncSeriesRepeatFields);
    syncSeriesRepeatFields();

    const seriesActions = document.createElement("div");
    seriesActions.className = "form-actions";

    const saveSeriesBtn = document.createElement("button");
    saveSeriesBtn.type = "button";
    saveSeriesBtn.className = "btn-primary";
    saveSeriesBtn.textContent = "Update all future classes";
    saveSeriesBtn.addEventListener("click", () => {
      const changes = {
        title: subjectInput.value.trim() || cls.title,
        startTime: startInput.value || cls.startTime,
        endTime: endInput.value || cls.endTime,
        venue: venueInput.value,
      };
      let successMessage = wasRepeating
        ? "Recurring class updated."
        : "Class updated.";

      if (repeatInput.checked) {
        const fromDate = repeatFromInput.value;
        const untilDate = repeatUntilInput.value;
        if (!ensureDateFieldValid(repeatFromInput)) return;
        const dayOfWeek = weekdayFromDateStr(fromDate);
        if (dayOfWeek === null) {
          showToast("Pick the date the weekly repeat starts.", "danger");
          return;
        }
        if (!ensureDateFieldValid(repeatUntilInput)) return;
        if (!untilDate) {
          showToast("Pick the date the weekly repeat ends.", "danger");
          return;
        }
        if (untilDate < fromDate) {
          showToast("The repeat can't end before it starts.", "danger");
          return;
        }
        changes.firstDate = fromDate;
        changes.endDate = untilDate;
        // The repeat follows its start date — its weekday becomes the
        // class's day, exactly like the add form derives it from the date.
        changes.dayOfWeek = dayOfWeek;
        successMessage = wasRepeating
          ? "Recurring class updated."
          : "Class now repeats weekly.";
      } else if (wasRepeating) {
        // Unticking stops the series after the day being edited; earlier
        // weeks stay on the calendar.
        changes.endDate = dateStr;
        successMessage = "Weekly repeat stopped.";
      }

      closeModal();
      saveScheduleChange(
        () => updateScheduleClass(cls.id, changes),
        successMessage,
      );
    });
    seriesActions.appendChild(saveSeriesBtn);

    const deleteSeriesBtn = document.createElement("button");
    deleteSeriesBtn.type = "button";
    deleteSeriesBtn.className = "btn-danger";
    deleteSeriesBtn.textContent = "Delete all future classes";
    deleteSeriesBtn.addEventListener("click", async () => {
      if (
        await showConfirm(
          "Remove this recurring class and all its future occurrences?",
          "Delete",
        )
      ) {
        closeModal();
        saveScheduleChange(
          () => deleteScheduleClass(cls.id),
          "Recurring class deleted.",
          "danger",
        );
      }
    });
    seriesActions.appendChild(deleteSeriesBtn);

    seriesSection.appendChild(seriesActions);
    box.appendChild(seriesSection);

    // ---- Close ----
    const closeRow = document.createElement("div");
    closeRow.className = "form-actions";
    closeRow.style.marginTop = "12px";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-secondary";
    closeBtn.textContent = "Close without saving";
    closeBtn.addEventListener("click", closeModal);
    closeRow.appendChild(closeBtn);
    box.appendChild(closeRow);
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", onKey);
    }
  });

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // The start/end time fields above are rebuilt every time this editor
  // opens, so they get masked now that they're in the document (the guard
  // keeps unit-test DOMs, which never load date-mask.js, working).
  if (typeof window.enhanceDateInputs === "function") {
    window.enhanceDateInputs(box);
  }
}

// ---------- day view ----------

// Clicking a day cell opens this instead of jumping straight to the add-class
// form: a scrollable hour grid with time stamps and lines, the day's sessions
// and classes as blocks sized to their real times (overlapping ones sit side
// by side), and empty slots that hand off to the add-class form pre-filled
// with that day and time.
const DAY_VIEW_OPEN_HOUR = 6;
const DAY_VIEW_CLOSE_HOUR = 22;
const DAY_VIEW_HOUR_HEIGHT = 52; // px per hour row

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToTimeStr(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Everything happening on one day, gathered from the same sources the month
// cells draw from (course sessions/covers, added classes, cancellations).
function dayViewEventsForDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const events = [];

  if (isTutor) {
    for (const s of courseSessions) {
      if (s.dayIndex !== weekday) continue;
      events.push({
        kind: "course",
        courseId: s.courseId,
        start: s.start,
        end: s.end,
        label: `${s.courseCode} · ${s.type}`,
        meta: s.venue || "",
        excusal: findExcusal(s, dateStr),
      });
    }
  } else {
    for (const c of coversByDate.get(dateStr) || []) {
      events.push({
        kind: "cover",
        start: c.start,
        end: c.end,
        label: `${c.courseCode} · ${c.type}`,
        meta: c.venue || "",
        coverTutor: c.tutorName,
      });
    }
  }

  for (const cls of getScheduleForDate(dateStr)) {
    events.push({
      kind: "class",
      start: cls.startTime,
      end: cls.endTime,
      label: cls.title,
      meta: cls.venue || "",
      cls,
      modified: !!cls.isModifiedOccurrence,
    });
  }

  for (const cls of getCancelledOccurrencesForDate(dateStr)) {
    events.push({
      kind: "cancelled",
      start: cls.startTime,
      end: cls.endTime,
      label: cls.title,
      cls,
    });
  }

  return events;
}

// Splits events into those with usable start/end times (placed on the grid)
// and those without (listed as chips under it). Overlapping blocks get their
// own column so they sit side by side instead of covering each other.
function placeDayEvents(events) {
  const placed = [];
  const untimed = [];

  for (const ev of events) {
    const startMin = timeToMinutes(ev.start);
    const endMin = timeToMinutes(ev.end);
    if (startMin === null || endMin === null || endMin <= startMin) {
      untimed.push(ev);
      continue;
    }
    placed.push({ ...ev, startMin, endMin });
  }

  placed.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const columnEnds = [];
  for (const ev of placed) {
    let col = columnEnds.findIndex((end) => end <= ev.startMin);
    if (col === -1) {
      columnEnds.push(ev.endMin);
      col = columnEnds.length - 1;
    } else {
      columnEnds[col] = ev.endMin;
    }
    ev.col = col;
  }

  const columnCount = Math.max(1, columnEnds.length);
  for (const ev of placed) {
    ev.leftPct = (ev.col / columnCount) * 100;
    ev.widthPct = 100 / columnCount;
  }

  return { placed, untimed };
}

function buildDayEventBlock(ev, dateStr, openHour, closeDayView) {
  const block = document.createElement("div");
  block.className = "day-view-event";

  const top = ((ev.startMin - openHour * 60) / 60) * DAY_VIEW_HOUR_HEIGHT;
  const height = Math.max(
    28,
    ((ev.endMin - ev.startMin) / 60) * DAY_VIEW_HOUR_HEIGHT - 4,
  );
  block.style.top = `${top + 2}px`;
  block.style.height = `${height}px`;
  block.style.left = `calc(${ev.leftPct}% + 3px)`;
  block.style.width = `calc(${ev.widthPct}% - 6px)`;

  const range = `${ev.start}–${ev.end}`;
  const timeLine = document.createElement("span");
  timeLine.className = "day-view-event-time";
  timeLine.textContent = range;

  const labelLine = document.createElement("span");
  labelLine.className = "day-view-event-label";

  if (ev.kind === "course") {
    const palette = courseColor(ev.courseId);
    block.style.background = palette.bg;
    block.style.borderColor = palette.border;
    block.style.color = palette.text;
    if (ev.excusal) {
      block.classList.add("day-view-event--excused");
      const tag = document.createElement("span");
      tag.className = "calendar-excused-tag";
      tag.textContent = "Excused";
      const text = document.createElement("span");
      text.className = "calendar-excused-label";
      text.textContent = ev.label;
      labelLine.append(tag, text);
      const coverText = ev.excusal.cover?.name
        ? `${ev.excusal.cover.name} is covering`
        : "no volunteer cover yet";
      block.title = `You're excused from this session — ${ev.label} · ${range}${ev.meta ? ` · ${ev.meta}` : ""} · ${coverText}`;
    } else {
      labelLine.textContent = ev.label;
      block.title = `${ev.label} · ${range}${ev.meta ? ` · ${ev.meta}` : ""}`;
    }
  } else if (ev.kind === "cover") {
    block.classList.add("day-view-event--cover");
    const tag = document.createElement("span");
    tag.className = "calendar-cover-tag";
    tag.textContent = "Cover";
    labelLine.append(tag, ev.label);
    block.title = `You're covering ${ev.label} for ${ev.coverTutor} · ${range}${ev.meta ? ` · ${ev.meta}` : ""}`;
  } else if (ev.kind === "class") {
    block.classList.add("day-view-event--class", "day-view-event--editable");
    labelLine.textContent = ev.modified ? `${ev.label} \u270E` : ev.label;
    block.title = ev.modified
      ? `${ev.label} · ${range}${ev.meta ? ` · ${ev.meta}` : ""} · edited for this day`
      : `${ev.label} · ${range}${ev.meta ? ` · ${ev.meta}` : ""}`;
    block.addEventListener("click", () => {
      closeDayView();
      openOccurrenceModal(ev.cls, dateStr, false);
    });
  } else if (ev.kind === "cancelled") {
    block.classList.add(
      "day-view-event--cancelled",
      "day-view-event--editable",
    );
    labelLine.textContent = `\u2715 ${ev.label}`;
    block.title = `${ev.label} cancelled for this day · click to restore`;
    block.addEventListener("click", () => {
      closeDayView();
      openOccurrenceModal(ev.cls, dateStr, true);
    });
  } else {
    block.classList.add("day-view-event--hours");
    labelLine.textContent = ev.label;
    block.title = `${ev.label} · ${range}`;
  }

  block.append(timeLine, labelLine);
  return block;
}

async function openDayView(dateStr) {
  if (document.querySelector(".day-view-overlay")) return;

  let entries = [];
  try {
    entries = await getEntriesForDate(dateStr);
  } catch {
    entries = [];
  }

  const events = dayViewEventsForDate(dateStr);
  for (const entry of entries) {
    events.push({
      kind: "hours",
      start: entry.startTime,
      end: entry.endTime,
      label: `${entry.hours}h${entry.subject ? ` · ${entry.subject}` : ""}`,
      meta: entry.notes || "",
    });
  }

  const { placed, untimed } = placeDayEvents(events);

  // The grid always covers the normal day and stretches further if something
  // on this date starts earlier or ends later.
  let openHour = DAY_VIEW_OPEN_HOUR;
  let closeHour = DAY_VIEW_CLOSE_HOUR;
  for (const ev of placed) {
    openHour = Math.min(openHour, Math.floor(ev.startMin / 60));
    closeHour = Math.max(closeHour, Math.ceil(ev.endMin / 60));
  }

  const overlay = document.createElement("div");
  overlay.className = "day-view-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "1000",
    padding: "24px 0",
  });
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "day-view-heading");

  const box = document.createElement("div");
  box.className = "day-view";
  Object.assign(box.style, {
    maxWidth: "560px",
    width: "94%",
    maxHeight: "88vh",
  });

  function closeDayView() {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }
  function onKey(e) {
    if (e.key === "Escape") closeDayView();
  }

  const head = document.createElement("header");
  head.className = "day-view-head";

  const title = document.createElement("h2");
  title.id = "day-view-heading";
  title.textContent = new Date(dateStr + "T00:00:00").toLocaleDateString(
    undefined,
    { weekday: "long", month: "long", day: "numeric" },
  );
  head.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "day-view-close";
  closeBtn.setAttribute("aria-label", "Close day view");
  closeBtn.textContent = "\u00D7";
  closeBtn.addEventListener("click", closeDayView);
  head.appendChild(closeBtn);

  box.appendChild(head);

  if (canManageSchedule) {
    const hint = document.createElement("p");
    hint.className = "card-hint day-view-hint";
    hint.textContent = "Click an empty time slot to add a class on this day.";
    box.appendChild(hint);
  }

  if (placed.length === 0 && untimed.length === 0) {
    const empty = document.createElement("p");
    empty.className = "day-view-empty";
    empty.textContent = "Nothing scheduled on this day yet.";
    box.appendChild(empty);
  }

  const scroll = document.createElement("div");
  scroll.className = "day-view-scroll";

  const grid = document.createElement("div");
  grid.className = "day-view-grid";
  grid.style.height = `${(closeHour - openHour) * DAY_VIEW_HOUR_HEIGHT}px`;

  for (let h = openHour; h <= closeHour; h++) {
    const line = document.createElement("div");
    line.className = "day-view-hour";
    line.style.top = `${(h - openHour) * DAY_VIEW_HOUR_HEIGHT}px`;

    const label = document.createElement("span");
    label.className = "day-view-time";
    label.textContent = `${String(h).padStart(2, "0")}:00`;
    line.appendChild(label);
    grid.appendChild(line);

    if (h < closeHour) {
      const half = document.createElement("div");
      half.className = "day-view-hour day-view-hour--half";
      half.style.top = `${(h - openHour) * DAY_VIEW_HOUR_HEIGHT + DAY_VIEW_HOUR_HEIGHT / 2}px`;
      grid.appendChild(half);
    }
  }

  const lane = document.createElement("div");
  lane.className = "day-view-lane";
  for (const ev of placed) {
    lane.appendChild(buildDayEventBlock(ev, dateStr, openHour, closeDayView));
  }
  grid.appendChild(lane);

  if (canManageSchedule) {
    // Clicking an empty slot (anything that isn't an event block) closes the
    // day view and opens the add-class form pre-filled with this day and the
    // clicked, half-hour-snapped time.
    lane.addEventListener("click", (e) => {
      if (e.target.closest(".day-view-event")) return;
      const rect = lane.getBoundingClientRect();
      const offsetMin = ((e.clientY - rect.top) / DAY_VIEW_HOUR_HEIGHT) * 60;
      const snapped = Math.floor(Math.max(0, offsetMin) / 30) * 30;
      const clamped = Math.min(snapped, (closeHour - openHour) * 60 - 30);
      closeDayView();
      openAddClassForm(dateStr, minutesToTimeStr(openHour * 60 + clamped));
    });
  }

  scroll.appendChild(grid);

  if (untimed.length > 0) {
    const extra = document.createElement("div");
    extra.className = "day-view-extra";
    for (const ev of untimed) {
      const chip = document.createElement("span");
      chip.className = "day-view-extra-chip";
      chip.textContent = `${ev.label}${ev.meta ? ` · ${ev.meta}` : ""}`;
      extra.appendChild(chip);
    }
    scroll.appendChild(extra);
  }

  box.appendChild(scroll);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDayView();
  });
  document.addEventListener("keydown", onKey);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  closeBtn.focus();
}

clearClassesBtn.addEventListener("click", async () => {
  if (
    !(await showConfirm(
      "Remove all imported class times from the calendar?",
      "Clear",
    ))
  )
    return;
  saveScheduleChange(clearSchedule, "All class times cleared.", "danger");
});

window.renderCalendar = render;

window.jumpToCalendarDate = (dateStr) => {
  const [y, m] = dateStr.split("-").map(Number);
  viewYear = y;
  viewMonth = m - 1;
  render();
};

// Classes come from the server (see loadSchedule in storage.js); the grid
// draws straight away and fills in once they and the course sessions land.
async function loadClasses() {
  try {
    await loadSchedule();
  } catch (err) {
    showToast(err.message || "Couldn't load your classes.", "danger");
  }
}

render();
Promise.all([loadClasses(), fetchCourseSessions()]).then(render);
window.AutoSync?.start(async () => {
  await Promise.all([loadClasses(), fetchCourseSessions()]);
  render();
});
