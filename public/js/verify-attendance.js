// The organiser side of attendance verification, laid out like the tutor's
// log-hours page: pick one of your modules, preview that module's upcoming
// tutorial and lab sessions, then work through the sessions that already
// ran. Each logged session groups the tutors and volunteers who logged it
// (see server/routes/attendanceVerification.js); an organiser for the entry's
// course confirms they actually attended ("verified") or disputes the entry
// with a note ("flagged"). The logger sees the state on their own pages and
// is notified when it changes.

// ---------- element handles ----------

const courseChipsEl = document.getElementById("courseChips");
const upcomingStepEl = document.getElementById("upcomingStep");
const sessionChipsEl = document.getElementById("sessionChips");
const sessionListEl = document.getElementById("sessionList");
const sessionsEmptyEl = document.getElementById("sessionsEmpty");
const statusFilterEl = document.getElementById("statusFilter");
const statusChipsEl = document.getElementById("statusChips");
const reviewPendingBtn = document.getElementById("reviewPendingBtn");
const showFlaggedBtn = document.getElementById("showFlaggedBtn");
const verifyPendingMetaEl = document.getElementById("verifyPendingMeta");
const verifyDecidedMetaEl = document.getElementById("verifyDecidedMeta");
const verifyFlaggedMetaEl = document.getElementById("verifyFlaggedMeta");
const verifyVerifiedMetaEl = document.getElementById("verifyVerifiedMeta");

const currentUser = (() => {
  try {
    return JSON.parse(sessionStorage.getItem("user") || "null");
  } catch {
    return null;
  }
})();

// A notification deep-link (?highlightEntry=<id>) may point at an already
// decided entry, so the filter opens to "All" and the entry's module gets
// picked when the queue loads below.
const highlightEntryId = new URLSearchParams(window.location.search).get(
  "highlightEntry",
);
if (highlightEntryId) statusFilterEl.value = "";

// The organiser's own module scope, stored at sign-in — the same contract
// board.js uses. A missing list (the super-organiser) means every module.
function sessionCourseScope() {
  try {
    const user = JSON.parse(sessionStorage.getItem("user") || "null");
    return user && Array.isArray(user.courseIds)
      ? new Set(user.courseIds.map(Number))
      : null;
  } catch {
    return null;
  }
}

// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday, matching
// JS Date.getDay().
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const CHIP_ACCENTS = [
  "chip-icon--blue",
  "chip-icon--violet",
  "chip-icon--teal",
  "chip-icon--amber",
];

const MODULE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5.5 6.7 12 10.4l6.5-3.7L12 3Z"/><path d="m7.5 9 4.5 2.6L16.5 9v5L12 16.6 7.5 14V9Z"/><path d="M18.5 7v5"/></svg>`;
const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

// The API's statuses against the shared pill classes: "verified" is the good
// state (green, like an approved timesheet), "flagged" the bad one (red,
// like a rejected one). The pill text stays the verification word, though.
const PILLS = {
  pending: { className: "pending", label: "Pending" },
  verified: { className: "approved", label: "Verified" },
  flagged: { className: "rejected", label: "Flagged" },
};

// ---------- state ----------

let courseList = []; // [{ id, key, code, name, slots, synthetic }]
let allEntries = []; // the whole reviewable queue, every status
let selectedCourse = null;
let courseKeyByCode = new Map(); // CODE → key, for unlinked legacy entries

// ---------- small helpers ----------

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function sliceTime(value) {
  return value == null ? "" : String(value).slice(0, 5);
}

function timeRange(entry) {
  return `${sliceTime(entry.start_time)}–${sliceTime(entry.end_time)}`;
}

// "Mon 6 Oct" — short and unambiguous for a session header.
function formatShortDay(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function formatDate(date) {
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function toDisplayDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function roleLabel(user) {
  const role = user?.role || "";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function makeActionBtn(label, variant, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------- upcoming sessions ----------

// A course's two weekly slots, the same fields the log-hours picker uses.
function slotDefinitions(course) {
  return [
    {
      type: "Tutorial",
      day: course.Day_of_tut,
      start: course.tutor_start_time,
      end: course.tutor_end_time,
      venue: course.venues,
    },
    {
      type: "Lab",
      day: course.Day_of_lab,
      start: course.lab_start_time,
      end: course.lab_end_time,
      venue: course.lab_venues,
    },
  ].filter((s) => s.day && s.start && s.end);
}

// The same grace window hourEntries enforces: a session can be logged from
// its start until 10 minutes after it ends. "open" means hours for it can
// land in the queue below at any moment; "past" means its window has closed.
const GRACE_MINUTES = 10;

function occurrenceState(date, start, end, now = new Date()) {
  const [sh, sm] = String(start).slice(0, 5).split(":").map(Number);
  const [eh, em] = String(end).slice(0, 5).split(":").map(Number);
  const startsAt = new Date(date);
  startsAt.setHours(sh, sm, 0, 0);
  const endsAt = new Date(date);
  endsAt.setHours(eh, em + GRACE_MINUTES, 0, 0);
  if (now < startsAt) return "upcoming";
  return now <= endsAt ? "open" : "past";
}

// The next few occurrences of a course's weekly Tutorial/Lab, soonest first.
function upcomingOccurrences(slots, count = 4) {
  if (!slots) return [];
  const now = new Date();
  const occurrences = [];

  slotDefinitions(slots).forEach((definition) => {
    const targetIdx = DAY_NAMES.indexOf(definition.day);
    if (targetIdx === -1) return;
    for (let week = 0; week < count; week += 1) {
      const days = ((targetIdx - now.getDay() + 7) % 7) + week * 7;
      const date = new Date(now);
      date.setDate(date.getDate() + days);
      const state = occurrenceState(
        date,
        definition.start,
        definition.end,
        now,
      );
      // A session whose logging window already closed belongs to the past
      // list below (once someone logs it), not to "upcoming".
      if (state === "past") continue;
      occurrences.push({ ...definition, date, state });
    }
  });

  return occurrences.sort((a, b) => a.date - b.date).slice(0, count);
}

function renderUpcoming() {
  upcomingStepEl.hidden = !selectedCourse;
  sessionChipsEl.innerHTML = "";
  if (!selectedCourse) return;

  const occurrences = upcomingOccurrences(selectedCourse.slots);
  if (occurrences.length === 0) {
    sessionChipsEl.innerHTML = `<p class="empty-state">No scheduled sessions for this module yet — check back once the timetable is set.</p>`;
    return;
  }

  occurrences.forEach((session) => {
    // Read-only chips — a preview of what's coming, not a picker, so a div
    // with the static variant rather than a button (see app.css).
    const chip = document.createElement("div");
    chip.className = `session-chip session-chip--static${session.state === "open" ? " is-open" : ""}`;
    chip.innerHTML = `
      <span class="session-chip__date">${CALENDAR_ICON}<span class="session-chip__day"></span></span>
      <span class="session-chip__time"></span>
      <span class="session-chip__note"></span>
    `;
    chip.querySelector(".session-chip__day").textContent =
      `${formatDate(session.date)} · ${session.type}`;
    chip.querySelector(".session-chip__time").textContent =
      `${sliceTime(session.start)}–${sliceTime(session.end)}${session.venue ? ` · ${session.venue}` : ""}`;
    chip.querySelector(".session-chip__note").textContent =
      session.state === "open"
        ? "Happening now — hours can be logged"
        : "Verification opens once this session has run";
    sessionChipsEl.appendChild(chip);
  });
}

// ---------- course list ----------

function keyForCourseId(id) {
  return `c:${id}`;
}

// The chips come from the organiser's scoped module list, plus any course
// that only shows up through the queue (a course outside the sign-in scope
// the server still lets this organiser review) so no logged session is
// left unreachable.
function buildCourseList(courseRows, entries) {
  const scope = sessionCourseScope();
  const list = [];
  const byKey = new Map();
  const add = (item) => {
    if (byKey.has(item.key)) return;
    byKey.set(item.key, item);
    list.push(item);
  };

  (courseRows || [])
    .filter((course) => !scope || scope.has(Number(course.id)))
    .sort((a, b) => String(a.course_code).localeCompare(String(b.course_code)))
    .forEach((course) =>
      add({
        id: course.id,
        key: keyForCourseId(course.id),
        code: course.course_code || "—",
        name: course.course_name || "",
        slots: course,
        synthetic: false,
      }),
    );

  courseKeyByCode = new Map(
    list
      .filter((course) => !course.synthetic)
      .map((course) => [course.code.toUpperCase(), course.key]),
  );

  entries.forEach((entry) => {
    const key = courseKeyForEntry(entry);
    if (byKey.has(key)) return;
    if (key.startsWith("c:")) {
      add({
        id: entry.course_id,
        key,
        code: entry.course?.course_code || entry.subject || "—",
        name: entry.course?.course_name || "",
        slots: entry.course || null,
        synthetic: true,
      });
    } else {
      add({
        id: null,
        key,
        code: entry.subject || "Unlinked",
        name: "Logged hours with no module link",
        slots: null,
        synthetic: true,
      });
    }
  });

  return list;
}

// Which chip an entry belongs under: its course when it has one; otherwise
// its legacy subject text, matched back to a real module by code so old
// unlinked entries still file under the module they name.
function courseKeyForEntry(entry) {
  if (entry.course_id != null) return keyForCourseId(entry.course_id);
  const subject = String(entry.subject || "")
    .trim()
    .toUpperCase();
  return courseKeyByCode.get(subject) || `s:${subject || "unlinked"}`;
}

function entriesForCourse(course) {
  return allEntries.filter((entry) => courseKeyForEntry(entry) === course.key);
}

function countsFor(course) {
  const counts = { pending: 0, verified: 0, flagged: 0 };
  entriesForCourse(course).forEach((entry) => {
    const status = (entry.verification_status || "pending").toLowerCase();
    if (counts[status] != null) counts[status] += 1;
  });
  return counts;
}

// ---------- course chips ----------

function renderCourseChips() {
  courseChipsEl.innerHTML = "";

  if (courseList.length === 0) {
    courseChipsEl.innerHTML = `<p class="empty-state">You don't organise any modules yet — sessions to verify will appear here once you do.</p>`;
    return;
  }

  courseList.forEach((course, index) => {
    const pending = countsFor(course).pending;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "course-chip";
    chip.dataset.courseKey = course.key;
    chip.innerHTML = `
      <span class="chip-icon ${CHIP_ACCENTS[index % CHIP_ACCENTS.length]}">${MODULE_ICON}</span>
      <span class="course-chip__text">
        <span class="course-chip__code"></span>
        <span class="course-chip__name"></span>
      </span>
      <span class="course-chip__badge" hidden></span>
    `;
    chip.querySelector(".course-chip__code").textContent = course.code;
    chip.querySelector(".course-chip__name").textContent = course.name;
    if (pending > 0) {
      const badge = chip.querySelector(".course-chip__badge");
      badge.hidden = false;
      badge.textContent = pending;
      badge.title = `${pending} logged session${pending === 1 ? "" : "s"} awaiting verification`;
    }
    chip.addEventListener("click", () => selectCourse(course));
    courseChipsEl.appendChild(chip);
  });

  syncCourseChips();
}

function syncCourseChips() {
  courseChipsEl.querySelectorAll(".course-chip").forEach((chip) => {
    chip.classList.toggle(
      "is-selected",
      Boolean(selectedCourse) && chip.dataset.courseKey === selectedCourse.key,
    );
  });
}

function selectCourse(course) {
  selectedCourse = course;
  syncCourseChips();
  renderUpcoming();
  renderPast();
  updateStatusChips();
}

// ---------- past sessions (grouped by the session that was logged) ----------

// Same session = same date and time range. The server blocks one person
// logging overlapping entries, but several people can log the same session —
// those belong under one header.
function sessionKeyOf(entry) {
  return `${entry.date}|${entry.start_time}|${entry.end_time}`;
}

// Pending rows first (they're the ones needing a call), then flagged, then
// verified — a group someone still has to work through reads top-down.
const ROW_ORDER = { pending: 0, flagged: 1, verified: 2 };

function renderPast() {
  sessionListEl.innerHTML = "";

  const entries = selectedCourse ? entriesForCourse(selectedCourse) : [];
  const status = statusFilterEl.value;
  const visible = status
    ? entries.filter(
        (entry) => (entry.verification_status || "pending") === status,
      )
    : entries;

  sessionsEmptyEl.hidden = visible.length > 0;
  if (visible.length === 0) {
    sessionsEmptyEl.textContent = !selectedCourse
      ? "Pick one of your modules above to see its logged sessions."
      : entries.length === 0
        ? "No logged sessions for this module yet — they'll appear here as tutors and volunteers log their hours."
        : "No logged sessions to show for this filter.";
    return;
  }

  const groups = new Map();
  visible.forEach((entry) => {
    const key = sessionKeyOf(entry);
    if (!groups.has(key)) {
      groups.set(key, {
        date: entry.date,
        start_time: entry.start_time,
        end_time: entry.end_time,
        session_type: null,
        venue: null,
        entries: [],
      });
    }
    const group = groups.get(key);
    group.session_type = group.session_type || entry.session_type;
    group.venue = group.venue || entry.venue;
    group.entries.push(entry);
  });

  [...groups.values()]
    .sort((a, b) =>
      `${b.date}${b.start_time}`.localeCompare(`${a.date}${a.start_time}`),
    )
    .forEach(renderGroup);
}

function renderGroup(group) {
  const li = document.createElement("li");
  li.className = "session-group";

  const head = document.createElement("div");
  head.className = "session-group__head";
  const headBits = [
    `<span class="session-group__when">${formatShortDay(group.date)} · ${sliceTime(group.start_time)}–${sliceTime(group.end_time)}</span>`,
  ];
  if (group.session_type) {
    headBits.push(`<span class="stamp">${group.session_type}</span>`);
  }
  if (group.venue) {
    headBits.push(`<span class="stamp">${group.venue}</span>`);
  }
  headBits.push(
    `<span class="session-group__count">${group.entries.length} logged</span>`,
  );
  head.innerHTML = headBits.join("");

  const list = document.createElement("ul");
  list.className = "session-group__list";
  group.entries
    .sort((a, b) => {
      const rank =
        ROW_ORDER[a.verification_status || "pending"] -
        ROW_ORDER[b.verification_status || "pending"];
      if (rank !== 0) return rank;
      return String(a.user?.name || "").localeCompare(
        String(b.user?.name || ""),
      );
    })
    .forEach((entry) => list.appendChild(renderRow(entry)));

  li.append(head, list);
  sessionListEl.appendChild(li);
}

function renderRow(entry) {
  const user = entry.user;
  const name = user?.name || "Unknown";
  const status = entry.verification_status || "pending";
  const pill = PILLS[status] || PILLS.pending;

  const li = document.createElement("li");
  li.dataset.entryId = String(entry.id);
  const row = document.createElement("div");
  row.className = "review-row";
  row.innerHTML = `
    <span class="avatar">${initials(name)}</span>
    <span class="name-block">
      <span class="name">${name}</span>
      <span class="role">${roleLabel(user)} · ${user?.email || ""}</span>
    </span>
    <span class="review-row__hours">${Number(entry.hours)} hrs</span>
    <span class="status-pill ${pill.className}">${pill.label}</span>
    <span class="applicant-actions"></span>
  `;

  const actionsEl = row.querySelector(".applicant-actions");
  actionsEl.appendChild(
    makeActionBtn("Details", "btn-small-neutral", () =>
      toggleDetail(li, entry),
    ),
  );

  // Verifying is a one-click call — no note to think about (unlike
  // flagging, which still demands a reason through the modal below).
  const verifyBtn = () =>
    makeActionBtn("Verify", "approve", () =>
      setStatus(entry, "verified", name),
    );
  const flagBtn = () =>
    makeActionBtn("Flag", "reject", () =>
      openReasonModal({
        title: "Flag session",
        fieldLabel: "Reason for flagging",
        placeholder: "e.g. the tutor didn't attend this tutorial",
        required: true,
        confirmLabel: "Flag",
        onConfirm: (note) => setStatus(entry, "flagged", name, note),
      }),
    );

  if (status === "pending") {
    actionsEl.appendChild(verifyBtn());
    actionsEl.appendChild(flagBtn());
  } else {
    actionsEl.appendChild(
      makeActionBtn("Reconsider", "", () => setStatus(entry, "pending", name)),
    );
    // The other call stays available so a change of mind is two clicks.
    actionsEl.appendChild(status === "verified" ? flagBtn() : verifyBtn());
  }

  li.appendChild(row);
  if (status !== "pending" && entry.verification_note) {
    const noteEl = document.createElement("p");
    noteEl.className = "review-note";
    noteEl.textContent = `Note: ${entry.verification_note}`;
    li.appendChild(noteEl);
  }
  return li;
}

function toggleDetail(li, entry) {
  const existing = li.querySelector(".submission-detail");
  if (existing) {
    existing.remove();
    return;
  }

  const detail = document.createElement("div");
  detail.className = "submission-detail";
  detail.innerHTML = `
    <table class="tutors-table">
      <thead>
        <tr><th>Date</th><th>Time</th><th>Hours</th><th>Session</th><th>Venue</th><th>Task</th><th>Notes</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${toDisplayDate(entry.date)}</td>
          <td>${timeRange(entry)}</td>
          <td>${Number(entry.hours)}</td>
          <td>${entry.session_type || "—"}</td>
          <td>${entry.venue || "—"}</td>
          <td>${entry.task_type || "—"}</td>
          <td>${entry.notes || "—"}</td>
        </tr>
      </tbody>
    </table>
  `;
  li.appendChild(detail);
}

// ---------- decisions ----------

async function loadQueue() {
  const scope = currentUser?.id
    ? `organiserId=${encodeURIComponent(currentUser.id)}`
    : "";
  const res = await fetch(`/api/attendance-verification?${scope}`);
  const rows = await res.json();
  if (!res.ok) {
    throw new Error(rows.error || "Failed to load logged sessions");
  }
  allEntries = rows;
}

async function setStatus(entry, status, name, note) {
  try {
    const res = await fetch(`/api/attendance-verification/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note, reviewerId: currentUser?.id }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that session.");
      return false;
    }
    try {
      await loadQueue();
    } catch {
      // Keep the stale list on screen rather than blanking it — the next
      // filter click or page load catches up.
    }
    renderCourseChips();
    renderSummary();
    renderUpcoming();
    renderPast();
    updateStatusChips();
    const messages = {
      verified: `${name}'s session verified`,
      flagged: `${name}'s session flagged`,
      pending: `${name}'s session moved back for verification`,
    };
    showToast(messages[status] || "Session updated.");
    return true;
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    return false;
  }
}

// A notification deep-link lands here via ?highlightEntry=<id>; the row it
// points at lives under its module's chip, so the startup code below picks
// that module (and opens the filter to All) before this runs.
function applyHighlight() {
  if (!highlightEntryId) return;
  const row = [...sessionListEl.querySelectorAll("li[data-entry-id]")].find(
    (li) => li.dataset.entryId === highlightEntryId,
  );
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("highlight-flash");
  setTimeout(() => row.classList.remove("highlight-flash"), 2500);
}

// ---------- reason modal (verify-with-note / flag-with-reason) ----------

const reasonModal = document.getElementById("reasonModal");
const reasonForm = document.getElementById("reasonForm");
const reasonFormError = document.getElementById("reasonFormError");
const reasonModalHeading = document.getElementById("reasonModalHeading");
const reasonFieldLabel = document.getElementById("reasonFieldLabel");
const reasonInput = document.getElementById("reasonInput");
const reasonSubmitBtn = document.getElementById("reasonSubmitBtn");

let pendingReason = null; // { required, confirmLabel, onConfirm }

function openReasonModal({
  title,
  fieldLabel,
  placeholder,
  required,
  confirmLabel,
  onConfirm,
}) {
  pendingReason = { required, confirmLabel, onConfirm };
  reasonForm.reset();
  reasonFormError.hidden = true;
  reasonModalHeading.textContent = title;
  reasonFieldLabel.textContent = fieldLabel;
  reasonInput.placeholder = placeholder || "";
  reasonSubmitBtn.textContent = confirmLabel;
  reasonModal.showModal();
  reasonInput.focus();
}

function closeReasonModal() {
  reasonModal.close();
  pendingReason = null;
}

document
  .getElementById("reasonModalCloseBtn")
  .addEventListener("click", closeReasonModal);
document
  .getElementById("reasonCancelBtn")
  .addEventListener("click", closeReasonModal);
reasonModal.addEventListener("click", (e) => {
  if (e.target === reasonModal) closeReasonModal();
});

reasonForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  reasonFormError.hidden = true;
  if (!pendingReason) return;

  const note = reasonInput.value.trim();
  if (pendingReason.required && !note) {
    reasonFormError.textContent = "A reason is required.";
    reasonFormError.hidden = false;
    return;
  }

  reasonSubmitBtn.disabled = true;
  const ok = await pendingReason.onConfirm(note);
  reasonSubmitBtn.disabled = false;

  if (ok) closeReasonModal();
});

// ---------- summary (cards + filter chips) ----------

// The two cards up top count every module the organiser reviews; the status
// chips in the past-sessions panel count the picked module only.
function renderSummary() {
  const counts = { pending: 0, verified: 0, flagged: 0 };
  allEntries.forEach((row) => {
    const status = (row.verification_status || "pending").toLowerCase();
    if (counts[status] != null) counts[status] += 1;
  });
  verifyPendingMetaEl.textContent = `${counts.pending} pending`;
  verifyDecidedMetaEl.textContent = `${counts.verified + counts.flagged} decided`;
  verifyFlaggedMetaEl.textContent = `${counts.flagged} flagged`;
  verifyVerifiedMetaEl.textContent = `${counts.verified} verified`;
  showFlaggedBtn.disabled = counts.flagged === 0;
}

function updateStatusChips() {
  const counts = selectedCourse
    ? countsFor(selectedCourse)
    : { pending: 0, verified: 0, flagged: 0 };
  const labels = {
    pending: "Pending",
    verified: "Verified",
    flagged: "Flagged",
    "": "All",
  };
  const total = counts.pending + counts.verified + counts.flagged;
  statusChipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    const status = chip.dataset.status;
    const count = status === "" ? total : counts[status] || 0;
    chip.textContent = `${labels[status]} (${count})`;
    chip.classList.toggle("is-active", status === statusFilterEl.value);
  });
}

statusChipsEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  statusFilterEl.value = chip.dataset.status;
  renderPast();
  updateStatusChips();
});

// The summary cards' shortcuts set the filter and, when the picked module
// has none of that status, hop to the first module that does — then drop
// the organiser next to the rows to act on.
function focusStatus(status) {
  if (!selectedCourse || countsFor(selectedCourse)[status] === 0) {
    const withSome = courseList.find((course) => countsFor(course)[status] > 0);
    if (withSome) selectCourse(withSome);
  }
  statusFilterEl.value = status;
  renderPast();
  updateStatusChips();
  document
    .getElementById("sessionsHeading")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

reviewPendingBtn.addEventListener("click", () => focusStatus("pending"));
showFlaggedBtn.addEventListener("click", () => focusStatus("flagged"));

// ---------- toast ----------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- init ----------

(async () => {
  let courseRows = [];
  try {
    const res = await fetch("/api/courses");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    courseRows = Array.isArray(body) ? body : [];
  } catch {
    // The chips fall back to whatever courses the queue itself mentions.
    courseRows = [];
  }

  try {
    await loadQueue();
  } catch {
    showToast("Couldn't load logged sessions.");
  }

  courseList = buildCourseList(courseRows, allEntries);
  renderCourseChips();
  renderSummary();

  // Land where the attention is: the deep-linked entry's module, else the
  // first module with something pending, else the first chip.
  const highlightEntry = highlightEntryId
    ? allEntries.find((entry) => String(entry.id) === highlightEntryId)
    : null;
  const initial =
    (highlightEntry &&
      courseList.find(
        (course) => course.key === courseKeyForEntry(highlightEntry),
      )) ||
    courseList.find((course) => countsFor(course).pending > 0) ||
    courseList[0] ||
    null;
  if (initial) selectCourse(initial);
  if (highlightEntry) applyHighlight();
})();

window.AutoSync?.start(async () => {
  await loadQueue();
  renderCourseChips();
  renderSummary();
  renderUpcoming();
  renderPast();
  updateStatusChips();
});

// ---------- guided tour ----------
// The "?" navbar button walks the verification flow. Same sessionStorage
// "user" key as the board tour, so progress is keyed per user here too.
// Steps whose targets only appear after a module is picked are skipped
// automatically while they're hidden.
function getSessionUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

const VERIFY_TOUR_STEPS = [
  {
    selector: ".verify-grid",
    title: "At a glance",
    body: "How many logged sessions await verification, and any flagged ones that need a second look.",
    placement: "bottom",
  },
  {
    selector: "#courseChips",
    title: "1. Pick a module",
    body: "Choose one of your modules to see its tutorial and lab sessions.",
    placement: "bottom",
  },
  {
    selector: "#sessionList",
    title: "3. Verify logged hours",
    body: "For sessions that already ran, confirm the hours tutors and volunteers logged — or flag anything that looks off.",
    placement: "top",
  },
];

const tourLinkEl = document.getElementById("tour-link");
if (tourLinkEl) {
  tourLinkEl.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(VERIFY_TOUR_STEPS, {
      tourId: "organiser-verify",
      userId: getSessionUserId(),
      force: true,
    });
  });
}
