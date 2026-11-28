/* ============================================================
   My Sessions
   Everything a volunteer is involved in, in one place — the same
   merge the dashboard's "Upcoming Sessions" card renders, whose
   "View all" link lands here, so the two views can't disagree on
   what counts as a session:
   - Claimed overflow sessions (course_volunteers rows with a
     session_date) that have been approved — one-off dates, split
     into Upcoming and Past.
   - Approved whole-course applications (a mark, no session_date) —
     standing weekly commitments whose slot lives on the course row
     (Day_of_tut/Day_of_lab). Each contributes its next occurrence to
     Upcoming, tagged "(repeats weekly)". Past occurrences of a
     recurring slot aren't recorded anywhere (there's no per-week
     attendance history), so Past stays dated sessions only.
   - Covers picked up from a tutor's excusal (session_excusals rows
     with this volunteer as cover_user_id) — the sessions the Log
     Hours page lets them log into Completed sessions. Covers and
     claims alike move to Past the moment their session has finished
     — a same-day one flips as its end time passes, not at midnight —
     so "no past sessions" can't sit next to a Completed sessions
     list that holds the very sessions.
   A plain classic script, not a module — reads the signed-in user
   straight out of sessionStorage, same as board.js does, rather than
   importing storage.js's requireRole().
   ============================================================ */

// Where each role lands (mirrors ROLE_HOME in storage.js and the switch in
// auth.js). Volunteers used to be stored with role "student" — the
// normalisation in requireStudent() below keeps those older accounts
// working after the Volunteer rename.
const ROLE_HOME = {
  volunteer: "StudentView.html",
  tutor: "dashboard.html",
  educator: "educator.html",
  organiser: "board.html",
  super_organiser: "board.html",
};

function requireStudent() {
  let user = null;
  try {
    const raw = sessionStorage.getItem("user");
    user = raw ? JSON.parse(raw) : null;
  } catch {
    user = null;
  }
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  // Same legacy normalisation storage.js's getCurrentUser() applies.
  if (user.role === "student") user.role = "volunteer";
  if (user.role !== "volunteer") {
    window.location.href = ROLE_HOME[user.role] || "login.html";
    return null;
  }
  return user;
}

const currentUser = requireStudent();

// Same "Welcome, {name}!" heading as every other student page, for a
// consistent header no matter which page you're actually on.
if (currentUser) {
  const welcomeHeadingEl = document.getElementById("welcome-heading");
  if (welcomeHeadingEl)
    welcomeHeadingEl.textContent = `Welcome, ${currentUser.name}!`;
}

const upcomingListEl = document.getElementById("upcomingList");
const pastListEl = document.getElementById("pastList");

function formatSessionDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

function formatSessionTime(t) {
  return t ? t.slice(0, 5) : "";
}

// "HH:MM" of the current local time; session end times compare against
// this so a same-day session flips to Past the moment it ends, rather
// than waiting for the date to roll over.
function nowTimeStr() {
  return new Date().toTimeString().slice(0, 5);
}

// A dated entry has ended once its day is in the past, or — for today —
// once its end time has passed (the rule the dashboard's covers use when
// they drop off its Upcoming card). Without an end time a same-day
// session can't be judged, so it stays upcoming until the date changes.
function hasEnded(entry, today) {
  if (entry.session_date < today) return true;
  if (entry.session_date > today) return false;
  return !!entry.end_time && entry.end_time.slice(0, 5) <= nowTimeStr();
}

// Mirrors the copies in studentview.js (and DAY_NAMES in
// server/dayNames.js) — index 0 = Sunday, matching Date#getDay() — so a
// course's weekly Day_of_tut/Day_of_lab can be projected onto the next
// real calendar date.
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

// Same schedule extraction as studentview.js's courseSchedule() — a
// course's own recurring Tutorial/Lab slot, off the course row itself.
function courseSchedule(course) {
  const sessions = [];
  if (course.Day_of_tut && course.tutor_start_time && course.tutor_end_time) {
    sessions.push({
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
      venue: course.venues,
    });
  }
  if (course.Day_of_lab && course.lab_start_time && course.lab_end_time) {
    sessions.push({
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
      venue: course.lab_venues,
    });
  }
  return sessions;
}

// Next occurrence of every approved whole-course application's weekly
// slot(s), shaped like a claimed-session row so sessionCard() can render
// either kind the same way (with `recurring: true` adding the tag).
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
        entries.push({
          courses: app.courses,
          session_date: nextDate,
          start_time: s.start,
          end_time: s.end,
          venue: s.venue,
          type: s.type,
          recurring: true,
        });
      });
    });
  return entries;
}

// A session picked up from a tutor's excusal (a session_excusals row with
// this volunteer as cover_user_id) — the same rows the dashboard's cover
// cards and the Log Hours picker read. Reshaped like the claimed-session
// rows above, plus `coveredFor`, so sessionCard() renders it the same way.
function coverEntryFromExcusal(excusal) {
  const course = excusal.courses;
  if (!course) return null;
  const isLab = excusal.session_type === "lab";
  return {
    courses: course,
    session_date: excusal.session_date,
    start_time: isLab ? course.lab_start_time : course.tutor_start_time,
    end_time: isLab ? course.lab_end_time : course.tutor_end_time,
    venue: (isLab ? course.lab_venues : course.venues) || "",
    type: isLab ? "Lab" : "Tutorial",
    coveredFor: excusal.tutors?.name || "a tutor",
  };
}

// The same session-card structure the dashboards render (see
// studentview.js's renderUpcomingSessions) so a session looks identical
// wherever a volunteer meets it. A cover additionally carries the badge
// the dashboard's cover cards use, naming the tutor it's taken over from.
function sessionCard(app, { past = false } = {}) {
  const time =
    app.start_time && app.end_time
      ? `, ${formatSessionTime(app.start_time)}–${formatSessionTime(app.end_time)}`
      : "";
  const venue = app.venue ? ` • ${app.venue}` : "";
  const typePrefix = app.type ? `${app.type}: ` : "";
  const recurringNote = app.recurring ? " (repeats weekly)" : "";
  const article = document.createElement("article");
  article.className = "session-card";

  const body = document.createElement("div");
  body.className = "session-card__body";

  if (app.coveredFor) {
    const badgeEl = document.createElement("p");
    badgeEl.className = "session-cover-badge";
    badgeEl.textContent = `${past ? "Covered for" : "Covering for"} ${app.coveredFor}`;
    body.appendChild(badgeEl);
  }

  body.insertAdjacentHTML(
    "beforeend",
    `<h3 class="session-code"></h3><p class="session-title"></p><p class="session-note"></p>`,
  );
  body.querySelector("h3").textContent = app.courses.course_code;
  body.querySelector(".session-title").textContent = app.courses.course_name;
  body.querySelector(".session-note").textContent =
    `${typePrefix}${formatSessionDate(app.session_date)}${time}${venue}${recurringNote}`;

  article.appendChild(body);
  return article;
}

// One JSON fetch, so the two data sources below settle independently.
async function fetchJson(url, errorMessage) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(errorMessage);
  return res.json();
}

async function renderSessions() {
  if (!currentUser) return;

  // Two endpoints feed this page — course_volunteers (claims and weekly
  // approvals) and the covers from tutors' excusals — and they settle
  // independently so a covers hiccup can't blank the claimed sessions
  // (the same tolerance the dashboard's cover merge shows).
  const [applicationsResult, coversResult] = await Promise.allSettled([
    fetchJson(
      `/api/course-volunteers?userId=${encodeURIComponent(currentUser.id)}`,
      "Failed to load sessions",
    ),
    fetchJson(
      `/api/session-excusals?coverUserId=${encodeURIComponent(currentUser.id)}`,
      "Failed to load covers",
    ),
  ]);

  // Like the dashboard's upcoming card: without the claims there's nothing
  // trustworthy to show, so the page says so rather than half-rendering.
  if (applicationsResult.status === "rejected") {
    upcomingListEl.innerHTML = `<p class="empty-state">Couldn't load your sessions right now.</p>`;
    pastListEl.innerHTML = "";
    return;
  }

  const applications = applicationsResult.value;
  const covers =
    coversResult.status === "fulfilled"
      ? coversResult.value.map(coverEntryFromExcusal).filter(Boolean)
      : [];

  const today = new Date().toISOString().slice(0, 10);
  // The split is by end time, not just date — see hasEnded().
  const claimedSessions = applications.filter(
    (app) => app.status === "approved" && app.session_date,
  );
  const datedSessions = [...claimedSessions, ...covers];

  const past = datedSessions
    .filter((entry) => hasEnded(entry, today))
    .sort((a, b) => b.session_date.localeCompare(a.session_date));

  const upcoming = [
    ...datedSessions.filter((entry) => !hasEnded(entry, today)),
    ...recurringSessionEntries(applications),
  ].sort(
    (a, b) =>
      a.session_date.localeCompare(b.session_date) ||
      (a.start_time || "").localeCompare(b.start_time || ""),
  );

  upcomingListEl.innerHTML = "";
  if (upcoming.length === 0) {
    upcomingListEl.innerHTML = `<p class="empty-state">No upcoming sessions</p>`;
  } else {
    upcoming.forEach((app) => upcomingListEl.appendChild(sessionCard(app)));
  }

  pastListEl.innerHTML = "";
  if (past.length === 0) {
    pastListEl.innerHTML = `<p class="empty-state">No past sessions</p>`;
  } else {
    past.forEach((app) =>
      pastListEl.appendChild(sessionCard(app, { past: true })),
    );
  }
}

renderSessions();
window.AutoSync?.start(renderSessions);
