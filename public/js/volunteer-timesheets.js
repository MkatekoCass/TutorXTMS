// Volunteer completed sessions: hour entries grouped by month + module, the
// way the Figma prototype lays them out — "COMS1018 / August 2025 / Peer
// support sessions / 4h / status".
//
// The status pill is the organiser's attendance-verification call on the
// sessions behind the row (see server/routes/attendanceVerification.js): a
// group is only "Verified" when every session in it was confirmed; any
// flagged session flags the row, and any still-undecided one keeps it
// pending — the state that most needs the volunteer's attention. The pill
// styling matches the prototype's "Submitted" pill.

import { getEntries, getMonthStart, requireRole } from "./storage.js";
import { highlightActiveTab } from "./nav.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";

const currentUser = requireRole("volunteer");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

const listEl = document.getElementById("timesheetList");

const VERIFICATION_PILLS = {
  pending: { className: "pending", label: "Pending" },
  verified: { className: "approved", label: "Verified" },
  flagged: { className: "rejected", label: "Flagged" },
};

// Flagged beats pending beats verified — a group's pill is whichever state
// in it still needs attention, so "Verified" really means everything in the
// row was confirmed.
function groupVerificationStatus(statuses) {
  if (statuses.has("flagged")) return "flagged";
  if (statuses.has("pending")) return "pending";
  return "verified";
}

// Always a whole number — new entries are already logged in whole hours,
// but this rounds defensively so any older fractional entry still displays
// as one too.
function formatHours(hours) {
  return `${Math.round(hours)}h`;
}

// "August 2025" — the calendar month a group of entries rolls up to.
function formatMonthLabel(monthStart) {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function renderRows(entries) {
  listEl.innerHTML = "";

  if (entries.length === 0) {
    listEl.innerHTML = `<p class="empty-state" style="margin: 18px 0">No completed sessions yet — sessions you log will show up here.</p>`;
    return;
  }

  // One row per (month, module): the sum of that month's entries for a course.
  const groups = new Map();
  entries.forEach((entry) => {
    const monthStart = getMonthStart(entry.date);
    const key = `${monthStart}::${entry.subject || "—"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        monthStart,
        subject: entry.subject || "—",
        taskType: entry.taskType || "Tutoring",
        hours: 0,
        statuses: new Set(),
      });
    }
    const group = groups.get(key);
    group.hours += Number(entry.hours);
    group.statuses.add(entry.verificationStatus || "pending");
  });

  const rows = [...groups.values()].sort(
    (a, b) =>
      a.monthStart.localeCompare(b.monthStart) ||
      a.subject.localeCompare(b.subject),
  );

  rows.forEach((row) => {
    const pill = VERIFICATION_PILLS[groupVerificationStatus(row.statuses)];
    const article = document.createElement("article");
    article.className = "timesheet-row";
    // Keyed for the notification deep-link below: an entry id resolves to
    // the (month, module) row it was grouped into.
    article.dataset.key = `${row.monthStart}::${row.subject}`;
    article.innerHTML = `
      <div>
        <p class="timesheet-course"></p>
        <p class="timesheet-week"></p>
      </div>
      <p class="timesheet-desc"></p>
      <p class="timesheet-hours"></p>
      <span class="status-pill ${pill.className}"></span>
    `;
    article.querySelector(".timesheet-course").textContent = row.subject;
    article.querySelector(".timesheet-week").textContent = formatMonthLabel(
      row.monthStart,
    );
    article.querySelector(".timesheet-desc").textContent = row.taskType;
    article.querySelector(".timesheet-hours").textContent = formatHours(
      row.hours,
    );
    article.querySelector(".status-pill").textContent = pill.label;
    listEl.appendChild(article);
  });
}

// A notification click ("your session was verified/flagged") lands here with
// ?highlightEntry=<id>; the entry itself isn't a row, so map it to the
// (month, module) group it belongs to and flash that row — the shared
// notification-deep-link behaviour, see highlightTarget.js.
function focusHighlightedEntry(entries) {
  const highlightId = consumeQueryParam("highlightEntry");
  if (!highlightId) return;
  const entry = entries.find((item) => String(item.id) === highlightId);
  if (!entry) return;
  const key = `${getMonthStart(entry.date)}::${entry.subject || "—"}`;
  scrollAndHighlight(listEl.querySelector(`article[data-key="${key}"]`));
}

(async () => {
  try {
    const entries = await getEntries();
    renderRows(entries);
    focusHighlightedEntry(entries);
  } catch {
    listEl.innerHTML = `<p class="empty-state" style="margin: 18px 0">Couldn't load your hours right now — try again later.</p>`;
  }
})();
window.AutoSync?.start(async () => {
  const entries = await getEntries();
  renderRows(entries);
});
