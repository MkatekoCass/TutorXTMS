/* ============================================================
   Student Dashboard
   Two ways to volunteer, both living in the course_volunteers table:
   - Modules You Can Tutor: a mark-based application for a whole course
     (has a mark, no session_date). Being approved for one means taking on
     that course's own recurring weekly Tutorial/Lab slot (Day_of_tut etc.
     sit directly on the course row — there's no separate "sessions" table
     for this, same as how a regularly-assigned tutor's schedule works).
   - Open Sessions You Can Cover: an organiser-posted, dated overflow gap
     a student claims (has a session_date, no mark) — a one-off date, not
     a recurring commitment. A claim starts 'open', moves to 'pending' on
     claim, then approved/rejected exactly like a course application.
   My Applications shows both kinds together. Upcoming Sessions surfaces
   both: approved future-dated claims, and the next occurrence of every
   approved whole-course application's recurring slot — plus the covers a
   volunteer picks up from another tutor's excusal, with the usual "can't
   make it" swap controls.
   ============================================================ */

import { getEntries, requireRole } from "./storage.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";

// This page (StudentView.html) is student-only — symmetric with the guard
// on the tutor pages, so a tutor can't wander in here either. (storage.js
// normalises the legacy "student" role to "volunteer".)
const currentUser = requireRole("volunteer");
if (!currentUser) {
  throw new Error("Not authorized");
}

const welcomeHeadingEl = document.getElementById("welcome-heading");
const hoursVolunteeredEl = document.getElementById("stat-hours-volunteered");
const courseListEl = document.getElementById("courseList");
const openSessionsListEl = document.getElementById("openSessionsList");
const pendingListEl = document.getElementById("pendingList");
const upcomingSessionsListEl = document.getElementById("upcomingSessionsList");

welcomeHeadingEl.textContent = `Welcome, ${currentUser.name}!`;

// Guarded write for the stat cards — a missing card is skipped rather than
// breaking the renderer that would have updated it.
function setStat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatSessionDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function formatSessionTime(t) {
  return t ? t.slice(0, 5) : "";
}

function sessionDetailLine(app) {
  const date = formatSessionDate(app.session_date);
  const time = `${formatSessionTime(app.start_time)}–${formatSessionTime(app.end_time)}`;
  const venue = app.venue ? ` • ${app.venue}` : "";
  return `${date}, ${time}${venue}`;
}

// ---------- icons (inline SVG, matching the Figma cards) ----------

const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

// Mirrors DAY_NAMES in server/dayNames.js and dashboard.js's own copy —
// index 0 = Sunday, matching Date#getDay() — so a course's weekly
// Day_of_tut/Day_of_lab can be projected onto the next real calendar date.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function nextOccurrenceIso(dayName) {
  const targetIdx = DAY_NAMES.indexOf(dayName);
  if (targetIdx === -1) return null;
  const d = new Date();
  d.setDate(d.getDate() + ((targetIdx - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// A course's own recurring Tutorial/Lab slot — shown on the course card
// before volunteering (so a student knows the time commitment up front)
// and used to build a recurring entry in Upcoming Sessions once approved.
// The key ("tutorial"/"lab") lines it up with an excusal's session_type.
function courseSchedule(course) {
  const sessions = [];
  if (course.Day_of_tut && course.tutor_start_time && course.tutor_end_time) {
    sessions.push({
      key: "tutorial",
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
      venue: course.venues,
    });
  }
  if (course.Day_of_lab && course.lab_start_time && course.lab_end_time) {
    sessions.push({
      key: "lab",
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
      venue: course.lab_venues,
    });
  }
  return sessions;
}

function courseScheduleSummary(course) {
  return courseSchedule(course)
    .map((s) => {
      const venueNote = s.venue ? ` (${s.venue})` : "";
      return `${s.type} ${s.day} ${formatSessionTime(s.start)}–${formatSessionTime(s.end)}${venueNote}`;
    })
    .join(" • ");
}

async function renderHoursVolunteered() {
  const entries = await getEntries();
  const hours = entries.reduce((sum, entry) => sum + Number(entry.hours), 0);
  hoursVolunteeredEl.textContent = Math.round(hours);
}

// ---------- hours this month ----------

async function renderHoursMonth() {
  const el = document.getElementById("stat-hours-month");
  if (!el) return;
  try {
    const entries = await getEntries();
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const hours = entries
      .filter((entry) => (entry.date || "").startsWith(monthPrefix))
      .reduce((sum, entry) => sum + Number(entry.hours), 0);
    el.textContent = `${Math.round(hours)}h`;
  } catch {
    el.textContent = "0h";
  }
}

async function renderCourses(applications) {
  courseListEl.innerHTML = "";

  let courses;
  try {
    const res = await fetch("/api/courses");
    if (!res.ok) throw new Error("Failed to load courses");
    courses = await res.json();
  } catch (err) {
    courseListEl.innerHTML = `<p class="empty-state">Couldn't load courses right now.</p>`;
    return;
  }

  // Only show courses that still need tutors - hide ones already fully staffed.
  const openCourses = courses.filter(
    (course) => (course.no_of_tutors_assigned || 0) < course.tutors_needed,
  );

  setStat("stat-open-sessions", String(openCourses.length));

  if (openCourses.length === 0) {
    courseListEl.innerHTML = `<p class="empty-state">No courses need tutors right now — check back soon.</p>`;
    return;
  }

  // A course the student already has an application or claimed session
  // against (any status) shows that status instead of a Volunteer button —
  // otherwise it looks like they can apply again, and clicking Volunteer
  // just fails with "you've already volunteered for this course".
  const applicationByCourseId = new Map(
    (applications || []).map((app) => [app.course_id, app]),
  );

  openCourses.forEach((course) => {
    const article = document.createElement("article");
    article.className = "session-card";
    article.dataset.courseId = String(course.id);

    const scheduleSummary = courseScheduleSummary(course);
    const scheduleHtml = scheduleSummary
      ? `<p class="session-note">${scheduleSummary}</p>`
      : "";

    const existingApp = applicationByCourseId.get(course.id);
    if (existingApp) {
      const status = existingApp.status || "pending";
      const reasonHtml =
        status === "rejected" && existingApp.rejection_reason
          ? `<p class="session-note">Reason: ${existingApp.rejection_reason}</p>`
          : "";
      article.innerHTML = `
        <div class="session-card__body">
          <h3>${course.course_code}</h3>
          <p class="session-meta">${course.course_name}</p>
          <p class="session-note">${course.department}</p>
          ${scheduleHtml}
          <span class="status-pill ${status}">${status[0].toUpperCase()}${status.slice(1)}</span>
          ${reasonHtml}
        </div>
      `;

      // A rejected row also gets a recovery path here — the unique
      // (user, course) constraint blocks a fresh application while the old
      // one still exists. A locked rejection blocks that path: the organiser
      // made it final, so the card says so instead of offering a remove
      // button that would only ever fail.
      if (status === "rejected") {
        if (existingApp.locked) {
          const lockNote = document.createElement("p");
          lockNote.className = "session-note";
          lockNote.textContent = "Reapplication locked by an organiser.";
          article.appendChild(lockNote);
        } else {
          const reapplyBtn = document.createElement("button");
          reapplyBtn.type = "button";
          reapplyBtn.className = "btn-link";
          reapplyBtn.textContent = "Remove & volunteer again";
          reapplyBtn.addEventListener("click", () =>
            removeVolunteerApplication(course.id),
          );
          article.appendChild(reapplyBtn);
        }
      }

      courseListEl.appendChild(article);
      return;
    }

    const minMarkNote = Number.isInteger(course.min_mark)
      ? ` • Min mark ${course.min_mark}`
      : "";
    article.innerHTML = `
      <div class="session-card__body">
        <h3>${course.course_code}</h3>
        <p class="session-meta">${course.course_name}</p>
        <p class="session-note">${course.department}${minMarkNote}</p>
        ${scheduleHtml}
      </div>
      <button type="button" class="volunteer-btn btn btn-primary">Volunteer</button>
      <div class="mark-form" hidden>
        <div class="form-field">
          <label>Your mark for this module</label>
          <input type="number" class="mark-input" min="0" max="100" placeholder="0-100" />
        </div>
        <div class="form-actions">
          <button type="button" class="submit-mark-btn btn btn-primary">Submit</button>
          <button type="button" class="cancel-mark-btn btn-secondary">Cancel</button>
        </div>
      </div>
    `;

    const volunteerBtn = article.querySelector(".volunteer-btn");
    const markForm = article.querySelector(".mark-form");
    const markInput = article.querySelector(".mark-input");
    const submitMarkBtn = article.querySelector(".submit-mark-btn");
    const cancelMarkBtn = article.querySelector(".cancel-mark-btn");

    volunteerBtn.addEventListener("click", () => {
      volunteerBtn.hidden = true;
      markForm.hidden = false;
      markInput.value = "";
      markInput.focus();
    });

    cancelMarkBtn.addEventListener("click", () => {
      markForm.hidden = true;
      volunteerBtn.hidden = false;
    });

    markInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submitMarkBtn.click();
    });

    submitMarkBtn.addEventListener("click", async () => {
      const mark = Number(markInput.value);
      if (!Number.isInteger(mark) || mark < 0 || mark > 100) {
        showToast("Enter a valid mark between 0 and 100");
        return;
      }
      if (Number.isInteger(course.min_mark) && mark < course.min_mark) {
        showToast(
          `You need at least ${course.min_mark} for ${course.course_code} to volunteer`,
        );
        return;
      }

      submitMarkBtn.disabled = true;
      try {
        const res = await fetch("/api/course-volunteers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: currentUser.id,
            courseId: course.id,
            mark,
          }),
        });
        const data = await res.json();

        if (!res.ok) {
          showToast(data.error || "Could not submit your application");
          submitMarkBtn.disabled = false;
          return;
        }

        showToast(
          `Applied for ${course.course_code} — waiting for organiser approval`,
        );
        await refreshVolunteerState();
      } catch (err) {
        showToast("Something went wrong, try again");
        submitMarkBtn.disabled = false;
      }
    });

    courseListEl.appendChild(article);
  });

  enableCardKeyboardNav(courseListEl);
}

async function renderOpenSessions() {
  openSessionsListEl.innerHTML = "";

  let sessions;
  try {
    const res = await fetch(
      `/api/course-volunteers?status=open&excludeRejectedFor=${encodeURIComponent(currentUser.id)}`,
    );
    if (!res.ok) throw new Error("Failed to load open sessions");
    sessions = await res.json();
  } catch (err) {
    openSessionsListEl.innerHTML = `<p class="empty-state">Couldn't load open sessions right now.</p>`;
    return;
  }

  if (sessions.length === 0) {
    openSessionsListEl.innerHTML = `<p class="empty-state">No open sessions right now — check back soon.</p>`;
    return;
  }

  sessions.forEach((session) => {
    const article = document.createElement("article");
    article.className = "session-card";
    const reasonHtml = session.reason
      ? `<p class="session-note">${session.reason}</p>`
      : "";
    article.innerHTML = `
      <div class="session-card__body">
        <h3>${session.courses.course_code}</h3>
        <p class="session-meta">${session.courses.course_name}</p>
        <p class="session-note">${sessionDetailLine(session)}</p>
        ${reasonHtml}
      </div>
    `;

    const claimBtn = document.createElement("button");
    claimBtn.type = "button";
    claimBtn.className = "btn btn-primary";
    claimBtn.textContent = "Claim";
    claimBtn.addEventListener("click", () => claimSession(session, claimBtn));
    article.appendChild(claimBtn);

    openSessionsListEl.appendChild(article);
  });

  enableCardKeyboardNav(openSessionsListEl);
}

async function claimSession(session, button) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/course-volunteers/${session.id}/claim`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: currentUser.id }),
    });
    const body = await res.json();

    if (!res.ok) {
      showToast(body.error || "Couldn't claim that session.");
      // Someone else may have just taken it — refresh so the list matches reality.
      renderOpenSessions();
      button.disabled = false;
      return;
    }

    showToast(
      `Claimed the ${session.courses.course_code} session on ${formatSessionDate(session.session_date)} — waiting for organiser approval`,
    );
    renderOpenSessions();
    await refreshVolunteerState();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    button.disabled = false;
  }
}

// ---------- session covers (excusal swaps) ----------

function daysBetweenTodayAnd(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00`);
  return Math.round((target - today) / 86400000);
}

function describeDaysAway(daysAway) {
  if (daysAway === 0) return "today";
  if (daysAway === 1) return "tomorrow";
  return `in ${daysAway} days`;
}

function formatCoverDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Sessions this student has been assigned to cover for an excused tutor.
// Turns an excusal row into an upcoming-sessions entry — either a session
// this student is covering (kind "cover") or one another volunteer has
// asked them to take over (kind "swap_request"). Null once it's over.
function toCoverEntry(excusal, kind) {
  const course = excusal.courses;
  const session = course
    ? courseSchedule(course).find((s) => s.key === excusal.session_type)
    : null;
  const daysAway = daysBetweenTodayAnd(excusal.session_date);
  if (!course || daysAway < 0) return null;
  if (
    daysAway === 0 &&
    session &&
    session.end.slice(0, 5) <= new Date().toTimeString().slice(0, 5)
  ) {
    return null; // already happened today
  }
  return {
    kind,
    excusalId: excusal.id,
    courseId: excusal.course_id,
    courseCode: course.course_code,
    courseName: course.course_name,
    tutorName: excusal.tutors?.name || "a tutor",
    coverName: excusal.cover?.name || "Another volunteer",
    swapToName: excusal.swap_to_user_id
      ? excusal.swap_to?.name || "another volunteer"
      : null,
    date: excusal.session_date,
    startTime: session?.start || "00:00",
    daysAway,
    label: [
      session?.type,
      formatCoverDate(excusal.session_date),
      session
        ? `${formatSessionTime(session.start)}–${formatSessionTime(session.end)}`
        : null,
      session?.venue,
    ]
      .filter(Boolean)
      .join(" • "),
  };
}

async function fetchExcusalsWhere(param, kind) {
  const res = await fetch(
    `/api/session-excusals?${param}=${encodeURIComponent(currentUser.id)}`,
  );
  const rows = await res.json();
  if (!res.ok) throw new Error(rows.error || "Failed to load covers");
  return rows.map((excusal) => toCoverEntry(excusal, kind)).filter(Boolean);
}

async function fetchCoverEntries() {
  const results = await Promise.allSettled([
    fetchExcusalsWhere("swapToUserId", "swap_request"),
    fetchExcusalsWhere("coverUserId", "cover"),
  ]);
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

function badge(text) {
  const el = document.createElement("p");
  el.className = "session-cover-badge";
  el.textContent = text;
  return el;
}

function actionButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

// POSTs to one of an excusal's cover/swap actions, toasting the outcome and
// refreshing the lists on success. Returns whether it worked.
async function coverAction(excusalId, action, body, successMessage) {
  try {
    const res = await fetch(
      `/api/session-excusals/${encodeURIComponent(excusalId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: currentUser.id, ...body }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || "Something went wrong — try again.");
      return false;
    }
    showToast(successMessage);
    refreshVolunteerState();
    return true;
  } catch {
    showToast("Network error — couldn't reach the server.");
    return false;
  }
}

// "Can't make it" opens a picker: ask a specific volunteer to take over
// (they have to accept), or let the system hand it to whoever's free.
const AUTO_PICK = "__auto__";

function buildCantMakeIt(cover) {
  const wrap = document.createElement("div");
  wrap.className = "swap-controls";

  const openBtn = actionButton("Can't make it", "btn-cancel", () => {
    openBtn.hidden = true;
    panel.hidden = false;
    loadSwapCandidates(cover, select, sendBtn);
  });

  const panel = document.createElement("div");
  panel.className = "swap-panel";
  panel.hidden = true;

  const label = document.createElement("label");
  label.className = "swap-label";
  label.textContent = "Who should take it over?";
  const select = document.createElement("select");
  select.className = "swap-select";
  label.appendChild(select);

  const sendBtn = actionButton("Send request", "btn-primary", async (btn) => {
    if (!select.value) {
      showToast("Choose who should take it over first.");
      return;
    }
    btn.disabled = true;
    const ok =
      select.value === AUTO_PICK
        ? await coverAction(
            cover.excusalId,
            "decline-cover",
            {},
            "It's been handed to another available volunteer.",
          )
        : await coverAction(
            cover.excusalId,
            "swap-request",
            { toUserId: select.value },
            `Request sent to ${select.selectedOptions[0].textContent} — you're still covering it until they accept.`,
          );
    if (!ok) btn.disabled = false;
  });

  const cancelBtn = actionButton("Cancel", "btn-secondary", () => {
    panel.hidden = true;
    openBtn.hidden = false;
  });

  const buttons = document.createElement("div");
  buttons.className = "swap-buttons";
  buttons.append(sendBtn, cancelBtn);
  panel.append(label, buttons);
  wrap.append(openBtn, panel);
  return wrap;
}

async function loadSwapCandidates(cover, select, sendBtn) {
  select.innerHTML = "<option>Loading volunteers…</option>";
  select.disabled = true;
  sendBtn.disabled = true;

  let candidates = [];
  try {
    const res = await fetch(
      `/api/session-excusals/${encodeURIComponent(cover.excusalId)}/swap-candidates?userId=${encodeURIComponent(currentUser.id)}`,
    );
    candidates = await res.json();
    if (!res.ok) throw new Error(candidates.error);
  } catch (err) {
    showToast(err.message || "Couldn't load the other volunteers.");
    candidates = [];
  }

  select.innerHTML = "";
  const placeholder = new Option(
    candidates.length
      ? "Choose a volunteer…"
      : "No other volunteer is free then",
    "",
  );
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  candidates.forEach((c) => select.appendChild(new Option(c.name, c.user_id)));
  select.appendChild(
    new Option("Anyone free — let the system choose", AUTO_PICK),
  );
  select.disabled = false;
  sendBtn.disabled = false;
}

// Waiting on the volunteer who was asked — the requester can withdraw.
function buildPendingSwap(cover) {
  const wrap = document.createElement("div");
  wrap.className = "swap-controls";
  const note = document.createElement("p");
  note.className = "swap-pending";
  note.textContent = `Waiting for ${cover.swapToName} to accept your swap request — you're still covering it until they do.`;
  wrap.append(
    note,
    actionButton("Withdraw request", "btn-secondary", async (btn) => {
      btn.disabled = true;
      const ok = await coverAction(
        cover.excusalId,
        "swap-withdraw",
        {},
        "Swap request withdrawn — you're still covering it.",
      );
      if (!ok) btn.disabled = false;
    }),
  );
  return wrap;
}

// Another volunteer asked this student to take their session over.
function buildSwapAnswer(request) {
  const wrap = document.createElement("div");
  wrap.className = "swap-buttons";
  const respond = (accept) => async (btn) => {
    wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const ok = await coverAction(
      request.excusalId,
      "swap-respond",
      { accept },
      accept
        ? `You're now covering ${request.courseCode} (${request.label}).`
        : `Declined — ${request.coverName} is still covering it.`,
    );
    if (!ok)
      wrap.querySelectorAll("button").forEach((b) => (b.disabled = false));
  };
  wrap.append(
    actionButton("Accept", "btn-primary", respond(true)),
    actionButton("Decline", "btn-secondary", respond(false)),
  );
  return wrap;
}

// ---------- applications + upcoming (shared by every refresh) ----------

async function fetchApplications() {
  const res = await fetch(
    `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
  );
  if (!res.ok) throw new Error("Failed to load applications");
  return res.json();
}

// Shared by every action that changes what the student has applied/claimed
// (submitting a mark, claiming a session, withdrawing, cover/swap actions) —
// the stat cards, courseList, pendingList and upcomingSessionsList all key
// off the same applications fetch, so they're always kept in sync with each
// other rather than one being patched ad hoc while the others go stale.
async function refreshVolunteerState() {
  let applications = null;
  try {
    applications = await fetchApplications();
  } catch (err) {
    // Individual render functions show their own error copy when passed null.
  }

  setStat(
    "stat-pending-claims",
    String(
      (applications || []).filter((app) => app.status === "pending").length,
    ),
  );

  // Covers picked up from another tutor's excusal aren't rows in
  // course_volunteers, so they're fetched separately and merged into
  // Upcoming Sessions alongside the claimed ones.
  const coverEntries = await fetchCoverEntries();

  await Promise.all([
    renderCourses(applications),
    renderApplications(applications),
    renderUpcomingSessions(applications, coverEntries),
  ]);
}

function renderApplications(applications) {
  pendingListEl.innerHTML = "";

  if (!applications) {
    pendingListEl.innerHTML = `<p class="empty-state">Couldn't load your applications right now.</p>`;
    return;
  }

  if (applications.length === 0) {
    pendingListEl.innerHTML = `<p class="empty-state">You haven't volunteered for anything yet.</p>`;
    return;
  }

  applications.forEach((app) => {
    const status = app.status || "pending";
    const article = document.createElement("article");
    article.className = "session-card";
    article.dataset.applicationId = app.id;

    const reasonHtml =
      status === "rejected" && app.rejection_reason
        ? `<p class="session-note">Reason: ${app.rejection_reason}</p>`
        : status === "approved" && app.approval_reason
          ? `<p class="session-note">Note: ${app.approval_reason}</p>`
          : "";

    // A row is either a whole-course application (has a mark) or a claimed
    // overflow session (has a session_date instead) — never both.
    const detailLine = app.session_date
      ? sessionDetailLine(app)
      : `Mark submitted: ${app.mark}`;

    article.innerHTML = `
      <div class="session-card__body">
        <h3>${app.courses.course_code}</h3>
        <p class="session-meta">${app.courses.course_name} • ${detailLine}</p>
        ${reasonHtml}
        <span class="status-pill ${status}">${status[0].toUpperCase()}${status.slice(1)}</span>
      </div>
    `;

    // A pending or rejected row also gets a button — otherwise it's a dead
    // end: the student can never clear it to try again, since the same
    // (student, course) pair can't have a second row while this one exists.
    // A locked rejection is the exception: the organiser has made it final,
    // so the server refuses the DELETE and the card says so instead of
    // offering a Remove button that would only ever fail.
    if (status === "pending") {
      const withdrawBtn = document.createElement("button");
      withdrawBtn.type = "button";
      withdrawBtn.className = "btn btn-secondary";
      withdrawBtn.textContent = "Withdraw";
      withdrawBtn.addEventListener("click", () =>
        withdrawApplication(app, withdrawBtn),
      );
      article.appendChild(withdrawBtn);
    } else if (status === "rejected") {
      if (app.locked) {
        const lockNote = document.createElement("p");
        lockNote.className = "session-note";
        lockNote.textContent =
          "An organiser has locked this rejection — you can't remove it or volunteer for this course again.";
        article.appendChild(lockNote);
      } else {
        const withdrawBtn = document.createElement("button");
        withdrawBtn.type = "button";
        withdrawBtn.className = "btn btn-secondary";
        withdrawBtn.textContent = "Remove";
        withdrawBtn.addEventListener("click", () =>
          withdrawApplication(app, withdrawBtn),
        );
        article.appendChild(withdrawBtn);
      }
    }

    pendingListEl.appendChild(article);
  });

  enableCardKeyboardNav(pendingListEl);
}

// Only an approved, claimed session (session_date set) belongs in "Upcoming
// Sessions" — a plain course application has no date to show yet, and a
// rejected or still-pending claim isn't a real commitment. Past-dated ones
// are excluded too, and a same-day one drops off the moment its end time
// passes (the rule toCoverEntry() applies to covers) — those live on My
// Sessions. A whole-course approval has
// no session_date of its own — it's a standing recurring commitment, not a
// one-off — so its "next occurrence" is derived from the course's own
// Day_of_tut/Day_of_lab here rather than read off the row. One entry per
// weekly Tutorial/Lab slot, showing the soonest date it'll next happen.
function recurringSessionEntries(applications) {
  const entries = [];
  applications
    .filter(
      (app) => app.status === "approved" && !app.session_date && app.courses,
    )
    .forEach((app) => {
      courseSchedule(app.courses).forEach((s) => {
        const nextDate = nextOccurrenceIso(s.day);
        if (!nextDate) return;
        const venueNote = s.venue ? ` • ${s.venue}` : "";
        entries.push({
          courseId: app.course_id,
          courseCode: app.courses.course_code,
          date: nextDate,
          startTime: s.start,
          label: `${s.type}: ${formatSessionDate(nextDate)}, ${formatSessionTime(s.start)}–${formatSessionTime(s.end)}${venueNote} (repeats weekly)`,
        });
      });
    });
  return entries;
}

// A cover picked up from another tutor's excusal (or a swap request sent to
// this student) — richer than a plain claimed session: it carries who it's
// for, the "can't make it" swap controls and a "how soon" status pill.
function renderCoverCard(article, entry) {
  if (entry.kind === "cover") {
    article.dataset.coverId = entry.excusalId;
  } else {
    article.dataset.swapId = entry.excusalId;
  }

  const body = document.createElement("div");
  body.className = "session-card__body";

  body.appendChild(
    badge(
      entry.kind === "cover"
        ? `Covering for ${entry.tutorName}`
        : `${entry.coverName} asked you to take this over (covering for ${entry.tutorName})`,
    ),
  );

  body.insertAdjacentHTML(
    "beforeend",
    `<p class="session-code"></p>
     <h3 class="session-title"></h3>
     <p class="session-meta"><span>${CALENDAR_ICON}<span class="session-when"></span></span></p>`,
  );
  body.querySelector(".session-code").textContent = entry.courseCode;
  body.querySelector(".session-title").textContent = entry.courseName;
  body.querySelector(".session-when").textContent = entry.label;

  if (entry.kind === "cover") {
    body.appendChild(
      entry.swapToName ? buildPendingSwap(entry) : buildCantMakeIt(entry),
    );
  } else {
    body.appendChild(buildSwapAnswer(entry));
  }

  const pill = document.createElement("span");
  pill.className = "status-pill";
  pill.textContent = describeDaysAway(entry.daysAway);

  article.append(body, pill);
  return article;
}

function renderUpcomingSessions(applications, coverEntries = []) {
  if (!applications) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">Couldn't load your sessions right now.</p>`;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const nowTime = new Date().toTimeString().slice(0, 5);
  const claimedSessions = applications
    .filter(
      (app) =>
        app.status === "approved" &&
        app.session_date &&
        // Same-day claims only count while the session hasn't finished,
        // so nothing that's already happened lingers under "Upcoming".
        (app.session_date > today ||
          (app.session_date === today &&
            (!app.end_time || app.end_time.slice(0, 5) > nowTime))),
    )
    .map((app) => ({
      courseId: app.course_id,
      courseCode: app.courses.course_code,
      date: app.session_date,
      startTime: app.start_time,
      label: sessionDetailLine(app),
    }));

  const upcoming = [
    ...claimedSessions,
    ...recurringSessionEntries(applications),
    ...coverEntries,
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.startTime || "").localeCompare(b.startTime || ""),
  );

  setStat("stat-upcoming-sessions", String(upcoming.length));

  if (upcoming.length === 0) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">No upcoming sessions</p>`;
    return;
  }

  upcomingSessionsListEl.innerHTML = "";
  upcoming.forEach((entry) => {
    const article = document.createElement("article");
    article.className = "session-card";
    article.dataset.courseId = String(entry.courseId);

    if (entry.kind) {
      renderCoverCard(article, entry);
    } else {
      const body = document.createElement("div");
      body.className = "session-card__body";
      body.insertAdjacentHTML(
        "beforeend",
        `<h3></h3><p class="session-note"></p>`,
      );
      body.querySelector("h3").textContent = entry.courseCode;
      body.querySelector(".session-note").textContent = entry.label;
      article.appendChild(body);
    }

    upcomingSessionsListEl.appendChild(article);
  });

  enableCardKeyboardNav(upcomingSessionsListEl);
}

async function withdrawApplication(app, button) {
  button.disabled = true;
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}&courseId=${encodeURIComponent(app.course_id)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't withdraw that application.");
      button.disabled = false;
      return;
    }

    // A claimed session's row survives the DELETE (the server reopens it
    // for someone else instead) — a plain course application's doesn't.
    showToast(
      app.session_date
        ? `Released the ${app.courses.course_code} session on ${formatSessionDate(app.session_date)} back to the pool`
        : app.status === "rejected"
          ? `Removed your application for ${app.courses.course_code} — you can apply again`
          : `Withdrew your application for ${app.courses.course_code}`,
    );

    // A full re-render (not a one-off DOM patch) so the course card, the
    // applications list and upcoming sessions all agree on the new state.
    await refreshVolunteerState();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    button.disabled = false;
  }
}

// Lets a rejected student dismiss the application themselves so the unique
// (user, course) constraint stops blocking them from volunteering again,
// rather than waiting on an organiser to reset it. Used by the "Remove &
// volunteer again" link on a rejected course card.
async function removeVolunteerApplication(courseId) {
  if (
    !confirm(
      "Remove this application? You'll be able to volunteer for this course again.",
    )
  )
    return;
  try {
    const res = await fetch(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}&courseId=${encodeURIComponent(courseId)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || "Couldn't remove that application.");
      return;
    }
    showToast("Application removed.");
    await refreshVolunteerState();
  } catch {
    showToast("Network error — couldn't reach the server.");
  }
}

// ---------- keyboard navigation ----------
// Same roving-tabindex pattern as board.js's course list, generalised to
// this page's four independent card lists: Up/Down/Home/End move focus
// between the <article> cards in whichever list already has focus, instead
// of scrolling the page. Each list is scoped to its own container (rather
// than one page-wide listener like board.js) since there's no single
// "active" list here for a key press to default to before the student has
// tabbed into one.
function isTypingInField() {
  const active = document.activeElement;
  return !!(
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  );
}

function enableCardKeyboardNav(container) {
  const cards = () =>
    Array.from(container.children).filter((el) => el.tagName === "ARTICLE");

  cards().forEach((el, i) => {
    el.tabIndex = i === 0 ? 0 : -1;
  });

  // The container itself persists across re-renders (only its <article>
  // children get thrown away and rebuilt), so this only needs binding once.
  if (container.dataset.keyboardNavBound) return;
  container.dataset.keyboardNavBound = "true";

  container.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (isTypingInField()) return;

    const els = cards();
    if (els.length === 0) return;

    const currentIndex = els.indexOf(document.activeElement);
    let targetIndex;
    switch (event.key) {
      case "ArrowDown":
        targetIndex =
          currentIndex < 0 ? 0 : Math.min(currentIndex + 1, els.length - 1);
        break;
      case "ArrowUp":
        targetIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
        break;
      case "Home":
        targetIndex = 0;
        break;
      case "End":
        targetIndex = els.length - 1;
        break;
    }

    event.preventDefault();
    els.forEach((el, i) => {
      el.tabIndex = i === targetIndex ? 0 : -1;
    });
    els[targetIndex].focus();
  });
}

// ---------- toast ----------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- guided tour ----------

const VOLUNTEER_TOUR_STEPS = [
  {
    selector: ".stat-grid",
    title: "Your dashboard",
    body: "See open opportunities, pending claims, completed hours, and upcoming sessions at a glance.",
    placement: "bottom",
  },
  {
    selector: "#courseList",
    title: "Modules you can tutor",
    body: 'Courses currently looking for volunteers show up here. Click "Volunteer" on one, enter the mark you got in that module, and submit — an organiser will review it.',
    placement: "top",
  },
  {
    selector: "section[aria-labelledby='open-sessions-heading']",
    title: "Open sessions you can cover",
    body: "Specific, dated gaps an organiser has flagged — a one-off session with nobody to run it. Claim one and an organiser will confirm it.",
    placement: "top",
  },
  {
    selector: "section[aria-labelledby='pending-heading']",
    title: "My applications",
    body: "Every module and claimed session you've volunteered for, with its outcome — including a reason if one was rejected. You can withdraw a pending one any time.",
    placement: "top",
  },
  {
    selector: "section[aria-labelledby='sessions-heading']",
    title: "Upcoming sessions",
    body: "Approved claims, your recurring weekly slots and any cover you've picked up show up here — closest first.",
    placement: "top",
  },
  {
    selector: "a[href='my-sessions.html']",
    title: "My Sessions",
    body: "A full view of your tutoring sessions, past and upcoming.",
    placement: "bottom",
  },
  {
    selector: "a[href='volunteer-log-hours.html']",
    title: "Log Hours",
    body: "After a session, log the hours you spent tutoring here.",
    placement: "bottom",
  },
  {
    selector: "a[href='student-calendar.html']",
    title: "Calendar",
    body: "See your sessions laid out by date.",
    placement: "bottom",
  },
];

const tourLink = document.getElementById("tour-link");
if (tourLink) {
  tourLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(VOLUNTEER_TOUR_STEPS, {
      tourId: "volunteer-dashboard",
      userId: currentUser.id,
      force: true,
    });
  });
}

// ---------- init ----------

(async () => {
  // allSettled, not all: one widget's fetch failing (e.g. hours volunteered)
  // shouldn't stop the others from rendering — including the highlights
  // below, which need the lists above to have rendered first.
  await Promise.allSettled([
    renderHoursVolunteered(),
    renderHoursMonth(),
    renderOpenSessions(),
    refreshVolunteerState(),
  ]);

  window.AutoSync?.start(async () => {
    await Promise.allSettled([
      renderHoursVolunteered(),
      renderHoursMonth(),
      renderOpenSessions(),
      refreshVolunteerState(),
    ]);
  });

  // Arriving from a "session changed" notification — scroll to and flash
  // the session card it was about, now that the list containing it has
  // rendered.
  const highlightCourseId = consumeQueryParam("highlightCourse");
  if (highlightCourseId) {
    scrollAndHighlight(
      upcomingSessionsListEl.querySelector(
        `[data-course-id="${CSS.escape(highlightCourseId)}"]`,
      ),
    );
  }

  // Arriving from a "you're covering a session" notification — flash that
  // cover (it may be gone if it was cancelled or handed on; that's fine).
  const highlightCoverId = consumeQueryParam("highlightCover");
  if (highlightCoverId) {
    scrollAndHighlight(
      upcomingSessionsListEl.querySelector(
        `[data-cover-id="${CSS.escape(highlightCoverId)}"]`,
      ),
    );
  }

  // Arriving from a "someone asked you to take over a session" notification.
  const highlightSwapId = consumeQueryParam("highlightSwap");
  if (highlightSwapId) {
    scrollAndHighlight(
      upcomingSessionsListEl.querySelector(
        `[data-swap-id="${CSS.escape(highlightSwapId)}"]`,
      ),
    );
  }

  // Arriving from a "volunteer application status changed" notification.
  const highlightApplicationId = consumeQueryParam("highlightApplication");
  if (highlightApplicationId) {
    scrollAndHighlight(
      pendingListEl.querySelector(
        `[data-application-id="${CSS.escape(highlightApplicationId)}"]`,
      ),
    );
  }

  // "Take the tour" on the other student pages links here with ?tour=1 —
  // arriving with it means that click explicitly asked for the walkthrough,
  // so replay it even if the once-per-user auto-show was already consumed.
  window.Onboarding?.start(VOLUNTEER_TOUR_STEPS, {
    tourId: "volunteer-dashboard",
    userId: currentUser.id,
    force: Boolean(consumeQueryParam("tour")),
  });
})();
