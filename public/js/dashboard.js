/* ============================================================
   Tutor dashboard (dashboard.html)

   Stat cards (courses assigned / hours this week / timesheets
   due), upcoming sessions with per-session "Excuse me", the
   excusals list, and the at-a-glance side panels (notifications,
   my courses, weekly capacity). Every renderer guards on its
   container existing so a missing one degrades quietly.
   ============================================================ */

import { highlightActiveTab } from "./nav.js";
import {
  getMonthStart,
  getWeekStart,
  getWeekTotal,
  getEntries,
  todayStr,
  toDateStr,
  requireRole,
} from "./storage.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";

// This page (dashboard.html) is tutor-only. Without this, any signed-in
// user (e.g. a student volunteer who wandered in via a stale nav link) could
// land here and see a tutor's dashboard instead of being sent back to theirs.
const currentUser = requireRole("tutor");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

// ---------- icons (inline SVG, matching the Figma cards) ----------

const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const CLOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const PIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;

// ---------- shared helpers ----------

// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday, matching
// JS Date.getDay(), so a course's weekly Day_of_tut can be projected onto
// the next real calendar date.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// A light pastel palette, cycled by course id, so each course's row in
// "My courses" gets a consistent colour instead of one flat grey list.
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

// Local YYYY-MM-DD for a date `days` from today.
function dateInDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

// "10" for whole hours, "7.5" for the fractional ones legacy entries carry.
function formatHours(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// "Mon 18 Aug" for a YYYY-MM-DD date string.
function formatSessionDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// ---------- element handles ----------

const coursesAssignedEl = document.getElementById("stat-courses-assigned");
const hoursWorkedEl = document.getElementById("stat-hours-worked");
const hoursSublabelEl = document.getElementById("stat-hours-sublabel");
const timesheetsDueEl = document.getElementById("stat-timesheets-due");
const timesheetsSublabelEl = document.getElementById(
  "stat-timesheets-sublabel",
);

const capacityValueEl = document.getElementById("capacity-value");
const capacityMaxEl = document.getElementById("capacity-max");
const capacityBarFillEl = document.getElementById("capacity-bar-fill");
const capacityCaptionEl = document.getElementById("capacity-caption");

const upcomingListEl = document.getElementById("upcoming-sessions-list");
const upcomingItemsEl = document.getElementById("upcoming-sessions-items");
const upcomingEmptyEl = document.getElementById("upcoming-sessions-empty");

const coursesListEl = document.getElementById("dashCoursesList");
const coursesEmptyEl = document.getElementById("dashCoursesEmpty");

const excusalsListEl = document.getElementById("excusals-list");
const excusalsItemsEl = document.getElementById("excusals-items");
const toastEl = document.getElementById("toast");

const excuseModal = document.getElementById("excuse-modal");
const excuseForm = document.getElementById("excuse-form");
const excuseError = document.getElementById("excuse-form-error");
const excuseSubmitBtn = document.getElementById("excuse-submit-btn");
const excuseCourseSelect = document.getElementById("excuse-course-select");
const excuseSessionSelect = document.getElementById("excuse-session-select");
const excuseDateInput = document.getElementById("excuse-date-input");
const excuseReasonInput = document.getElementById("excuse-reason-input");

// Populated by fetchUpcomingSessions() — reused here so the excuse-yourself
// modal's course dropdown doesn't need its own extra fetch.
let myApplications = [];
let myExcusals = [];
// The tutor's weekly hour cap (from their profile), or null when unset.
let weeklyCap = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// A course can run a Tutorial, a Lab, or both — each is its own weekly
// session. Returns whichever of the two are fully scheduled.
function courseSessions(course) {
  return [
    {
      key: "tutorial",
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
    },
    {
      key: "lab",
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
    },
  ].filter((s) => s.day && s.start && s.end);
}

function formatSession(session) {
  return `${session.type} · ${session.day} · ${session.start.slice(0, 5)}–${session.end.slice(0, 5)}`;
}

// Days from today until the next occurrence of a weekly session
// (0 = today, 1 = tomorrow, ... 6 = a week from today at the latest).
// A session that has already ended today counts as next week's.
function daysUntil(dayName, endTime) {
  const targetIdx = DAY_NAMES.indexOf(dayName);
  if (targetIdx === -1) return null;
  const now = new Date();
  const days = (targetIdx - now.getDay() + 7) % 7;
  const nowHHMM = now.toTimeString().slice(0, 5);
  return days === 0 && endTime.slice(0, 5) <= nowHHMM ? 7 : days;
}

function approvedApps() {
  return myApplications.filter(
    (a) => (a.status || "").toLowerCase() === "approved",
  );
}

// ---------- stat cards + weekly capacity panel ----------

async function fetchWeeklyCap(tutorId) {
  try {
    const res = await fetch(`/api/tutors/${encodeURIComponent(tutorId)}`);
    const body = await res.json();
    if (!res.ok) return null;
    return body.weekly_hour_cap != null ? Number(body.weekly_hour_cap) : null;
  } catch {
    return null;
  }
}

// Fallback when GET /api/tutors/:id didn't answer: the applications join
// carries tutors.weekly_hour_cap too.
function capFromApplications() {
  for (const app of myApplications) {
    if (app.tutors?.weekly_hour_cap != null) {
      return Number(app.tutors.weekly_hour_cap);
    }
  }
  return null;
}

function setCapacityBar(pct, over) {
  capacityBarFillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  capacityBarFillEl.classList.toggle("capacity-bar__fill--over", over);
}

async function renderStats() {
  coursesAssignedEl.textContent = String(approvedApps().length);

  const worked = await getWeekTotal(getWeekStart(todayStr()));
  if (weeklyCap == null) weeklyCap = capFromApplications();

  const used = formatHours(worked);

  if (weeklyCap == null) {
    hoursWorkedEl.textContent = used;
    hoursSublabelEl.classList.remove("stat-sublabel--danger");
    hoursSublabelEl.textContent = "No weekly cap set";
    capacityValueEl.textContent = `${used}h used`;
    capacityMaxEl.textContent = "";
    setCapacityBar(0, false);
    capacityCaptionEl.textContent = "No weekly cap set — ask your organiser.";
    return;
  }

  hoursWorkedEl.innerHTML = `${used}<span class="stat-value__frac">/${formatHours(weeklyCap)}h</span>`;

  const remaining = weeklyCap - worked;
  if (remaining > 0) {
    hoursSublabelEl.classList.remove("stat-sublabel--danger");
    hoursSublabelEl.textContent = `${formatHours(remaining)}h remaining`;
  } else if (remaining === 0) {
    hoursSublabelEl.classList.remove("stat-sublabel--danger");
    hoursSublabelEl.textContent = "Weekly cap reached";
  } else {
    hoursSublabelEl.classList.add("stat-sublabel--danger");
    hoursSublabelEl.textContent = `${formatHours(-remaining)}h over your weekly cap`;
  }

  capacityValueEl.textContent = `${used}h used`;
  capacityMaxEl.textContent = `of ${formatHours(weeklyCap)}h max`;
  setCapacityBar(weeklyCap > 0 ? (worked / weeklyCap) * 100 : 0, remaining < 0);
  capacityCaptionEl.textContent =
    remaining > 0
      ? `${formatHours(remaining)}h remaining this week`
      : remaining === 0
        ? "Full weekly cap used."
        : "You're over your weekly cap.";
}

// Months with logged hours (before the current one) that were never submitted
// as a timesheet — the same condition the server's due-reminder checks.
async function renderTimesheetsDue() {
  try {
    const [entries, res] = await Promise.all([
      getEntries(),
      fetch(`/api/timesheets?tutorId=${encodeURIComponent(currentUser.id)}`),
    ]);
    if (!res.ok) throw new Error("Failed to load timesheets");
    const rows = await res.json();

    // Normalised to month starts so both monthly keys and any legacy
    // weekly submissions count as "that month has been submitted".
    const submitted = new Set(rows.map((r) => getMonthStart(r.week_start)));
    const currentMonthStart = getMonthStart(todayStr());
    const months = new Set(
      entries
        .map((e) => getMonthStart(e.date))
        .filter((m) => m < currentMonthStart),
    );

    let due = 0;
    months.forEach((month) => {
      if (!submitted.has(month)) due += 1;
    });

    timesheetsDueEl.textContent = String(due);
    timesheetsSublabelEl.textContent =
      due === 0 ? "All caught up" : "Awaiting submission";
  } catch {
    timesheetsDueEl.textContent = "—";
    timesheetsSublabelEl.textContent = "Couldn't load timesheets";
  }
}

// ---------- my courses panel ----------

function renderMyCourses() {
  if (!coursesListEl) return;
  const approved = approvedApps().filter((a) => a.courses);

  coursesListEl.innerHTML = "";
  coursesEmptyEl.hidden = approved.length > 0;

  approved.forEach((app) => {
    const course = app.courses;
    const sessions = courseSessions(course);

    const row = document.createElement("div");
    row.className = "dash-course";
    row.dataset.courseId = app.course_id;

    const dot = document.createElement("span");
    dot.className = "course-dot";
    dot.style.background = courseColor(app.course_id).text;

    const body = document.createElement("div");
    const code = document.createElement("p");
    code.className = "dash-course__code";
    code.textContent = course.course_code;
    const times = document.createElement("p");
    times.className = "dash-course__times";
    times.textContent =
      sessions.length > 0
        ? sessions
            .map(
              (s) =>
                `${s.type} · ${s.day.slice(0, 3)} ${s.start.slice(0, 5)}–${s.end.slice(0, 5)}`,
            )
            .join(" · ")
        : "Schedule to be announced";

    body.append(code, times);
    row.append(dot, body);
    coursesListEl.appendChild(row);
  });
}

// ---------- upcoming sessions ----------

// The most recent sessions list, so it can be re-rendered once this tutor's
// excusals (fetched in parallel) arrive and mark which ones they're excused from.
let lastUpcomingSessions = [];

// This tutor's excusal (if any) for one occurrence of a session.
function excusalFor(courseId, sessionKey, dateStr) {
  return myExcusals.find(
    (e) =>
      String(e.course_id) === String(courseId) &&
      e.session_date === dateStr &&
      (!e.session_type || e.session_type === sessionKey),
  );
}

async function fetchUpcomingSessions(tutorId) {
  let sessions = [];
  try {
    const res = await fetch(
      `/api/tutor-applications?tutorId=${encodeURIComponent(tutorId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load sessions");
    myApplications = rows;

    sessions = rows
      .filter((app) => (app.status || "").toLowerCase() === "approved")
      .flatMap((app) => {
        const course = app.courses;
        if (!course) return [];
        return courseSessions(course)
          .map((s) => ({
            courseId: app.course_id,
            courseCode: course.course_code,
            courseName: course.course_name,
            sessionKey: s.key,
            type: s.type,
            venue: s.key === "lab" ? course.lab_venues : course.venues,
            startTime: s.start,
            endTime: s.end,
            daysAway: daysUntil(s.day, s.end),
          }))
          .filter((s) => s.daysAway !== null)
          .map((s) => ({ ...s, dateStr: dateInDays(s.daysAway) }));
      })
      .sort(
        (a, b) =>
          a.daysAway - b.daysAway || a.startTime.localeCompare(b.startTime),
      );
  } catch {
    sessions = [];
    myApplications = [];
  }
  lastUpcomingSessions = sessions;
  renderUpcomingSessions(sessions);
}

function renderUpcomingSessions(sessions = lastUpcomingSessions) {
  if (!upcomingListEl) return;
  if (sessions.length === 0) {
    upcomingListEl.hidden = true;
    upcomingEmptyEl.hidden = false;
    return;
  }

  upcomingEmptyEl.hidden = true;
  upcomingListEl.hidden = false;
  upcomingItemsEl.innerHTML = "";

  sessions.forEach((s) => {
    const card = document.createElement("article");
    card.className = "session-card";
    card.dataset.courseId = s.courseId;
    card.innerHTML = `
      <div class="session-card__body">
        <p class="session-code"></p>
        <p class="session-title"></p>
        <div class="session-meta">
          <span>${CALENDAR_ICON}<span class="session-meta__date"></span></span>
          <span>${CLOCK_ICON}${s.startTime.slice(0, 5)}–${s.endTime.slice(0, 5)}</span>
          <span class="session-meta__venue" hidden>${PIN_ICON}<span class="session-meta__venue-text"></span></span>
        </div>
        <p class="session-note"></p>
      </div>
    `;

    card.querySelector(".session-code").textContent = s.courseCode;
    card.querySelector(".session-title").textContent = s.courseName;
    card.querySelector(".session-meta__date").textContent = formatSessionDate(
      s.dateStr,
    );
    if (s.venue) {
      const venue = card.querySelector(".session-meta__venue");
      venue.hidden = false;
      venue.querySelector(".session-meta__venue-text").textContent = s.venue;
    }
    card.querySelector(".session-note").textContent = `${s.type} session`;

    // Excused from this occurrence: say so, and who's covering it — and
    // offer no "Excuse me" button, since it's already done.
    const excusal = excusalFor(s.courseId, s.sessionKey, s.dateStr);
    if (excusal) {
      const note = document.createElement("p");
      note.className = "excused-note";
      note.textContent = excusal.cover?.name
        ? `You're excused · ${excusal.cover.name} is covering`
        : "You're excused · finding a volunteer to cover";
      card.querySelector(".session-card__body").appendChild(note);

      const pill = document.createElement("span");
      pill.className = "status-pill";
      pill.textContent = "Excused";
      card.appendChild(pill);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-secondary";
      btn.textContent = "Excuse me";
      btn.addEventListener("click", () =>
        openExcuseModal({
          courseId: s.courseId,
          sessionKey: s.sessionKey,
          dateStr: s.dateStr,
        }),
      );
      card.appendChild(btn);
    }

    upcomingItemsEl.appendChild(card);
  });
}

// ---------- excuse yourself from a session ----------

function renderExcusalsList() {
  const today = todayStr();
  const upcoming = myExcusals
    .filter((e) => e.session_date >= today)
    .sort((a, b) => a.session_date.localeCompare(b.session_date));

  if (upcoming.length === 0) {
    excusalsListEl.hidden = true;
    return;
  }
  excusalsListEl.hidden = false;
  excusalsItemsEl.innerHTML = "";

  upcoming.forEach((excusal) => {
    const course = excusal.courses;
    const session = course ? excusedSession(course, excusal) : null;
    const li = document.createElement("li");
    li.className = "application-row";
    li.innerHTML = `
      <span><strong></strong><br /><span class="excusal-detail"></span></span>
      <button type="button" class="btn-link" data-action="cancel-excusal">Cancel</button>
    `;
    li.querySelector("strong").textContent = [
      course?.course_code,
      session?.type,
    ]
      .filter(Boolean)
      .join(" · ");
    li.dataset.excusalId = excusal.id;
    const coverNote = document.createElement("span");
    coverNote.className = excusal.cover?.name
      ? "excusal-cover excusal-cover--found"
      : "excusal-cover excusal-cover--pending";
    coverNote.textContent = excusal.cover?.name
      ? `Covered by ${excusal.cover.name}`
      : "Finding a volunteer to cover…";
    li.querySelector(".excusal-detail").after(
      document.createElement("br"),
      coverNote,
    );
    li.querySelector(".excusal-detail").textContent = [
      formatExcuseDate(excusal.session_date),
      session
        ? `${session.start.slice(0, 5)}–${session.end.slice(0, 5)}`
        : null,
      excusal.reason ? `(${excusal.reason})` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    li.querySelector('[data-action="cancel-excusal"]').addEventListener(
      "click",
      () => cancelExcusal(excusal.id),
    );
    excusalsItemsEl.appendChild(li);
  });
}

async function fetchMyExcusals(tutorId) {
  try {
    const res = await fetch(
      `/api/session-excusals?tutorId=${encodeURIComponent(tutorId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load excusals");
    myExcusals = rows;
  } catch {
    myExcusals = [];
  }
  renderExcusalsList();
  renderUpcomingSessions();
}

async function cancelExcusal(id) {
  try {
    const res = await fetch(`/api/session-excusals/${id}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't cancel that excusal.");
      return;
    }
    showToast("Excusal cancelled.");
    await fetchMyExcusals(currentUser.id);
  } catch {
    showToast("Network error — couldn't reach the server.");
  }
}

// Which of a course's sessions an excusal is for — its stored session_type,
// or for an older excusal without one, whichever session meets that weekday.
function excusedSession(course, excusal) {
  const sessions = courseSessions(course);
  if (excusal.session_type) {
    return sessions.find((s) => s.key === excusal.session_type) || null;
  }
  const weekday =
    DAY_NAMES[new Date(`${excusal.session_date}T00:00:00`).getDay()];
  return sessions.find((s) => s.day === weekday) || null;
}

function formatExcuseDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// The next few dates a weekly session meets on, soonest first — today is
// included only if the session hasn't finished yet.
const EXCUSE_WEEKS_AHEAD = 10;

function upcomingSessionDates(session) {
  const first = daysUntil(session.day, session.end);
  if (first === null) return [];
  return Array.from({ length: EXCUSE_WEEKS_AHEAD }, (_, week) => {
    const date = new Date();
    date.setDate(date.getDate() + first + week * 7);
    return toDateStr(date);
  });
}

function selectedExcuseCourse() {
  return myApplications.find(
    (a) => String(a.course_id) === excuseCourseSelect.value,
  )?.courses;
}

function populateExcuseSessionSelect() {
  const course = selectedExcuseCourse();
  const sessions = course ? courseSessions(course) : [];

  excuseSessionSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = !course
    ? "Choose a course first…"
    : sessions.length === 0
      ? "This course has no scheduled sessions"
      : "Choose a session…";
  excuseSessionSelect.appendChild(placeholder);

  sessions.forEach((s) => {
    const option = document.createElement("option");
    option.value = s.key;
    option.textContent = formatSession(s);
    excuseSessionSelect.appendChild(option);
  });

  // Nothing to choose between when the course only runs one session.
  if (sessions.length === 1) excuseSessionSelect.value = sessions[0].key;
  populateExcuseDateSelect();
}

function populateExcuseDateSelect() {
  const course = selectedExcuseCourse();
  const session = course
    ? courseSessions(course).find((s) => s.key === excuseSessionSelect.value)
    : null;
  const alreadyExcused = new Set(
    myExcusals
      .filter(
        (e) =>
          String(e.course_id) === excuseCourseSelect.value &&
          course &&
          excusedSession(course, e)?.key === session?.key,
      )
      .map((e) => e.session_date),
  );

  excuseDateInput.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = session
    ? "Choose a date…"
    : "Choose a session first…";
  excuseDateInput.appendChild(placeholder);

  if (!session) return;
  upcomingSessionDates(session).forEach((dateStr) => {
    const option = document.createElement("option");
    option.value = dateStr;
    option.textContent = formatExcuseDate(dateStr);
    if (alreadyExcused.has(dateStr)) {
      option.textContent += " (already excused)";
      option.disabled = true;
    }
    excuseDateInput.appendChild(option);
  });
}

excuseCourseSelect?.addEventListener("change", populateExcuseSessionSelect);
excuseSessionSelect?.addEventListener("change", populateExcuseDateSelect);

function populateExcuseCourseSelect() {
  const approved = approvedApps().filter((a) => a.courses);

  excuseCourseSelect.innerHTML =
    '<option value="" disabled selected>Choose a course&hellip;</option>';
  approved.forEach((a) => {
    const option = document.createElement("option");
    option.value = a.course_id;
    option.textContent = `${a.courses.course_code} — ${a.courses.course_name}`;
    excuseCourseSelect.appendChild(option);
  });

  if (approved.length === 1) {
    excuseCourseSelect.value = String(approved[0].course_id);
  }

  return approved;
}

// Opens the excusal dialog, optionally pre-filled from a session card's
// "Excuse me" button (course, session type, and that occurrence's date).
function openExcuseModal(prefill = {}) {
  excuseForm.reset();
  excuseError.hidden = true;

  const approved = populateExcuseCourseSelect();
  if (approved.length === 0) {
    showToast("You need an approved course assignment first.");
    return;
  }

  if (prefill.courseId != null) {
    const wanted = String(prefill.courseId);
    const option = Array.from(excuseCourseSelect.options).find(
      (o) => o.value === wanted,
    );
    if (option) excuseCourseSelect.value = wanted;
  }

  populateExcuseSessionSelect();

  if (prefill.sessionKey && excuseSessionSelect.value !== prefill.sessionKey) {
    const option = Array.from(excuseSessionSelect.options).find(
      (o) => o.value === prefill.sessionKey,
    );
    if (option) {
      excuseSessionSelect.value = prefill.sessionKey;
      populateExcuseDateSelect();
    }
  }

  if (prefill.dateStr) {
    const option = Array.from(excuseDateInput.options).find(
      (o) => o.value === prefill.dateStr && !o.disabled,
    );
    if (option) excuseDateInput.value = prefill.dateStr;
  }

  excuseModal.showModal();
}

function closeExcuseModal() {
  excuseModal.close();
}

document
  .getElementById("excuse-modal-close-btn")
  ?.addEventListener("click", closeExcuseModal);
document
  .getElementById("excuse-cancel-btn")
  ?.addEventListener("click", closeExcuseModal);
excuseModal?.addEventListener("click", (e) => {
  if (e.target === excuseModal) closeExcuseModal();
});

excuseForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  excuseError.hidden = true;

  const payload = {
    tutorId: currentUser.id,
    courseId: Number(excuseCourseSelect.value),
    sessionType: excuseSessionSelect.value,
    sessionDate: excuseDateInput.value,
    reason: excuseReasonInput.value.trim(),
  };

  excuseSubmitBtn.disabled = true;
  excuseSubmitBtn.textContent = "Submitting…";

  try {
    const res = await fetch("/api/session-excusals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (!res.ok) {
      excuseError.textContent = body.error || "Couldn't submit that excusal.";
      excuseError.hidden = false;
      return;
    }

    closeExcuseModal();
    showToast("You're excused from that session.");
    await fetchMyExcusals(currentUser.id);
  } catch {
    excuseError.textContent = "Network error — couldn't reach the server.";
    excuseError.hidden = false;
  } finally {
    excuseSubmitBtn.disabled = false;
    excuseSubmitBtn.textContent = "Excuse me from this session";
  }
});

// ---------- guided tour ----------

const TUTOR_TOUR_STEPS = [
  {
    selector: ".stat-grid",
    title: "Your week at a glance",
    body: "Courses assigned, hours logged this week against your weekly cap, and timesheets still waiting on submission.",
    placement: "bottom",
  },
  {
    selector: "section:has(#upcoming-heading)",
    title: "Upcoming sessions",
    body: "Your tutorials and labs, soonest first. Log hours from here, or excuse yourself from a session you can't make.",
    placement: "bottom",
  },
  {
    selector: ".dash-panel--notif",
    title: "Notifications",
    body: "Cover updates, timesheet statuses, and session changes land here.",
    placement: "left",
  },
  {
    selector: ".dash-panel--capacity",
    title: "Weekly capacity",
    body: "How much of your weekly hour cap you've used — the bar turns red once you go over.",
    placement: "left",
  },
  {
    selector: ".tab-nav",
    title: "Get around",
    body: "These tabs are always here at the top, wherever you are in the app.",
    placement: "bottom",
  },
];

const tourLink = document.getElementById("tour-link");
if (tourLink) {
  tourLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(TUTOR_TOUR_STEPS, {
      tourId: "tutor-dashboard",
      userId: currentUser.id,
      force: true,
    });
  });
}

// ---------- init ----------

(async function init() {
  // Independent endpoints — no need to wait for one before starting the
  // other. allSettled so a failure in one never blocks the rest, including
  // the highlight logic below, which needs the lists above to have rendered.
  await Promise.allSettled([
    fetchUpcomingSessions(currentUser.id),
    fetchMyExcusals(currentUser.id),
    fetchWeeklyCap(currentUser.id).then((cap) => {
      weeklyCap = cap;
    }),
  ]);

  await Promise.allSettled([renderStats(), renderTimesheetsDue()]);
  renderMyCourses();

  // No scheduled job in this app — the "you haven't submitted last
  // month's timesheet" reminder is instead checked (idempotently, server
  // decides if a new one is actually due) each time the dashboard loads.
  // Fire-and-forget: the bell's own polling picks up any new notification.
  fetch(
    `/api/timesheets/due-reminder?tutorId=${encodeURIComponent(currentUser.id)}`,
  ).catch(() => {});

  // Arriving from a "session changed" notification — scroll to and flash
  // the course it was about, now that the lists containing it have rendered.
  const highlightCourseId = consumeQueryParam("highlightCourse");
  if (highlightCourseId) {
    const target =
      upcomingItemsEl.querySelector(
        `[data-course-id="${CSS.escape(highlightCourseId)}"]`,
      ) ||
      coursesListEl?.querySelector(
        `[data-course-id="${CSS.escape(highlightCourseId)}"]`,
      );
    scrollAndHighlight(target);
  }

  // Arriving from a "cover found / no cover" notification — flash that excusal.
  const highlightExcusalId = consumeQueryParam("highlightExcusal");
  if (highlightExcusalId) {
    scrollAndHighlight(
      excusalsItemsEl.querySelector(
        `[data-excusal-id="${CSS.escape(highlightExcusalId)}"]`,
      ),
    );
  }

  // ?tour=1 is set by the "Take a Tour" links on the other tutor pages,
  // which bounce visitors here because the tour points at the dashboard.
  const wantsTour = consumeQueryParam("tour") === "1";

  window.Onboarding?.start(TUTOR_TOUR_STEPS, {
    tourId: "tutor-dashboard",
    userId: currentUser.id,
    force: wantsTour,
  });

  window.AutoSync?.start(async () => {
    await Promise.allSettled([
      fetchUpcomingSessions(currentUser.id),
      fetchMyExcusals(currentUser.id),
      fetchWeeklyCap(currentUser.id).then((cap) => {
        weeklyCap = cap;
      }),
    ]);
    await Promise.allSettled([renderStats(), renderTimesheetsDue()]);
    renderMyCourses();
    renderExcusalsList();
    renderUpcomingSessions();
  });
})();
