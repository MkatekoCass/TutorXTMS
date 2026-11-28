import { highlightActiveTab } from "./nav.js";
import {
  getCurrentUser,
  getEntries,
  getEntriesForMonth,
  getProfile,
  saveProfile,
  todayStr,
  getMonthStart,
  getMonthTotal,
  requireRole,
} from "./storage.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";

// This page (timesheets.html) is tutor-only — a payroll claim for hours
// tutored. Without this, any signed-in user could land here directly.
const currentUser = requireRole("tutor");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

const YEAR_OF_STUDY_LABELS = {
  third_year: "3rd Year",
  honours: "Honours",
  masters: "Masters",
  phd: "PhD",
};

const CLAIM_MIN_ROWS = 15;

// The claim PDF is rendered by this page's own browser (the server can't —
// it deploys to Cloudflare Workers, where there's no browser engine), so
// these two libraries are pulled in on demand the first time a tutor
// submits. Pinned exactly, like the timetable page's pdf.js.
const HTML2CANVAS_URL =
  "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
const JSPDF_URL =
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

const profileForm = document.getElementById("profile-form");
const fullNameField = document.getElementById("fullName");
const studentNumberField = document.getElementById("studentNumber");
const emailField = document.getElementById("email");
const cellPhoneField = document.getElementById("cellPhone");
const yearOfStudyField = document.getElementById("yearOfStudy");
const payrollNumberField = document.getElementById("payrollNumber");

// The Profile page (profile.html) is the source of truth for the claim
// form's identity fields. When it has a value for one of them, that value
// wins over any locally saved copy and the field locks here — the only way
// to change it is on the Profile page. Year of study is locked the same
// way, but from the tutor's academic_level, which sets their pay rate and
// only an organiser can change. Payroll number exists only on this page
// and stays editable.
let accountProfile = null;

const PROFILE_SYNCED_FIELDS = [
  ["name", fullNameField],
  ["studentNumber", studentNumberField],
  ["email", emailField],
  ["cellPhone", cellPhoneField],
];

// The details the claim renders from: the locally saved profile, with any
// Profile-page values layered over it.
function profileDetails() {
  const local = getProfile() || {};
  const account = accountProfile || {};
  return {
    ...local,
    fullName: account.name || local.fullName || "",
    studentNumber: account.studentNumber || local.studentNumber || "",
    email: account.email || local.email || "",
    cellPhone: account.cellPhone || local.cellPhone || "",
    yearOfStudy: lockedYearOfStudy() || local.yearOfStudy || "",
  };
}

// The year of study on record, when it's one the form can show.
function lockedYearOfStudy() {
  const level = accountProfile?.yearOfStudy;
  return Object.hasOwn(YEAR_OF_STUDY_LABELS, level ?? "") ? level : "";
}

async function loadAccountProfile() {
  try {
    const res = await fetch(
      `/api/profile/${encodeURIComponent(currentUser.id)}`,
    );
    if (!res.ok) return; // no profile on record — local-only details stand
    accountProfile = await res.json();
  } catch {
    // Offline or erroring API — the locally saved details still work.
  }
}

// Locks each synced field the Profile page has a value for, and surfaces
// the hint explaining where to change them.
function applyProfileLocks() {
  let locked = 0;
  for (const [key, field] of PROFILE_SYNCED_FIELDS) {
    const value = accountProfile?.[key];
    if (typeof value === "string" && value.trim() !== "") {
      field.readOnly = true;
      field.title = "From your Profile page — change it there.";
      locked += 1;
    } else {
      field.readOnly = false;
      field.removeAttribute("title");
    }
  }
  document.getElementById("details-sync-hint").hidden = locked === 0;

  // A <select> has no readOnly, so it's disabled instead — its value still
  // reads normally when the form is saved.
  const yearLocked = lockedYearOfStudy() !== "";
  yearOfStudyField.disabled = yearLocked;
  if (yearLocked) {
    yearOfStudyField.title =
      "Set from your tutor record — ask an organiser to change it.";
  } else {
    yearOfStudyField.removeAttribute("title");
  }
  document.getElementById("year-of-study-hint").hidden = !yearLocked;
}

const rangeFromField = document.getElementById("rangeFrom");
const rangeToField = document.getElementById("rangeTo");
const printBtn = document.getElementById("printBtn");
const submitMonthField = document.getElementById("submitMonth");
const submitTimesheetBtn = document.getElementById("submitTimesheetBtn");
// The button's resting label — swapped for the resubmit wording while a
// rejected month is picked (a submission against it is a resubmission).
const SUBMIT_BUTTON_LABEL = submitTimesheetBtn.textContent.trim();
const submitMonthHint = document.getElementById("submitMonthHint");
const timesheetHint = document.getElementById("timesheet-hint");
const claimWrapper = document.getElementById("claimWrapper");
const submissionsListEl = document.getElementById("submissionsList");
const submissionsEmptyEl = document.getElementById("submissionsEmpty");

// Impossible typed dates must block the submit — the mask surfaces the
// field's own message; test DOMs that never load date-mask.js pass through.
const ensureDateFieldValid = window.ensureDateFieldValid ?? (() => true);

const disputeModal = document.getElementById("disputeModal");
const disputeForm = document.getElementById("disputeForm");
const disputeFormError = document.getElementById("disputeFormError");
const disputeModalContext = document.getElementById("disputeModalContext");
const disputeMessageInput = document.getElementById("disputeMessageInput");
const disputeSubmitBtn = document.getElementById("disputeSubmitBtn");

// This tutor's most recent dispute per submitted month, keyed by weekStart
// (the stored period key, "YYYY-MM-01") — only need the latest one to know
// whether "Dispute" or a status badge shows.
let latestDisputeByWeek = new Map();
let pendingDispute = null; // { weekStart } for whichever row opened the modal

// This tutor's submissions by period key ("YYYY-MM-01"), refreshed by
// loadSubmissions — the submit tool reads it to tell a month that's already
// been through review from one still open.
let submissionsByMonth = new Map();

let toastTimer = null;
function showToast(message, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.remove("toast--success", "toast--danger");
  el.classList.add(`toast--${type}`, "show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function toDisplayDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// "September 2026" — the calendar month one submission covers.
function formatMonthLabel(monthStart) {
  const date = new Date(`${monthStart}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function formatDuration(hours) {
  const n = Number(hours);
  return `${n}${n === 1 ? "hr" : "hrs"}`;
}

function loadProfileIntoForm() {
  const profile = profileDetails();
  fullNameField.value = profile.fullName || "";
  studentNumberField.value = profile.studentNumber || "";
  emailField.value = profile.email || "";
  cellPhoneField.value = profile.cellPhone || "";
  yearOfStudyField.value = profile.yearOfStudy || "third_year";
  payrollNumberField.value = profile.payrollNumber || "";
}

function safeRenderClaim() {
  renderClaim().catch((err) => console.error("Failed to render claim:", err));
}

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveProfile({
    fullName: fullNameField.value.trim(),
    studentNumber: studentNumberField.value.trim(),
    email: emailField.value.trim(),
    cellPhone: cellPhoneField.value.trim(),
    yearOfStudy: yearOfStudyField.value,
    payrollNumber: payrollNumberField.value.trim(),
  });
  safeRenderClaim();
  showToast("Profile details saved.");
});

function defaultRange() {
  const today = todayStr();
  const [y, m] = today.split("-");
  return { from: `${y}-${m}-01`, to: today };
}

// The claim form's identity block needs these three — without them there's
// nothing valid to print or submit.
function hasClaimIdentity(profile) {
  return !!(
    profile &&
    profile.fullName &&
    profile.studentNumber &&
    profile.email
  );
}

// Fills a claim root's identity block. The live preview and the off-screen
// PDF capture both go through here — every id is looked up within `root`,
// so the capture's clone fills itself and never touches the preview.
function fillClaimIdentity(root, profile, year) {
  root.querySelector("#cYear").textContent = year;
  root.querySelector("#cFullName").textContent = profile.fullName;
  root.querySelector("#cStudentNo").textContent = profile.studentNumber;
  root.querySelector("#cPayrollNo").textContent = profile.payrollNumber || "";
  root.querySelector("#cEmail").textContent = profile.email;
  root.querySelector("#cYearOfStudy").textContent =
    YEAR_OF_STUDY_LABELS[profile.yearOfStudy] || "";
  // The paper form lists all four options and the tutor strikes through
  // theirs — mirror that by marking the matching box.
  root.querySelectorAll(".claim-year-option").forEach((cell) => {
    cell.classList.toggle(
      "is-selected",
      cell.dataset.year === profile.yearOfStudy,
    );
  });
  root.querySelector("#cCellPhone").textContent = profile.cellPhone || "";
}

// Rebuilds a claim root's task table from `entries` — padded to the printed
// form's 15 rows — then dates and totals it. Shared by the live preview (the
// picked range) and the PDF capture (the month being submitted).
function fillClaimRows(root, entries, signDate) {
  const rowsEl = root.querySelector("#claimRows");
  rowsEl.innerHTML = "";
  let totalHours = 0;

  for (const entry of entries) {
    totalHours += Number(entry.hours);

    const tr = document.createElement("tr");
    // The database stores HH:MM:SS; the paper form shows HH:MM.
    const times =
      entry.startTime && entry.endTime
        ? `${entry.startTime.slice(0, 5)}-${entry.endTime.slice(0, 5)}`
        : "";
    const description = [entry.taskType, entry.subject]
      .filter(Boolean)
      .join(" – ");

    [
      toDisplayDate(entry.date),
      times,
      formatDuration(entry.hours),
      description,
      entry.supervisorName || "",
      "",
    ].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });

    rowsEl.appendChild(tr);
  }

  // The printed Wits form always has room for 15 tasks; blank rows keep the
  // same shape when fewer were logged.
  for (let i = entries.length; i < CLAIM_MIN_ROWS; i++) {
    const tr = document.createElement("tr");
    tr.className = "claim-blank-row";
    for (let col = 0; col < 6; col++) {
      tr.appendChild(document.createElement("td"));
    }
    rowsEl.appendChild(tr);
  }

  root.querySelector("#cSignDate").textContent = toDisplayDate(signDate);
  root.querySelector("#cTotalHours").textContent = totalHours;
}

async function renderClaim() {
  const profile = profileDetails();
  const hasProfile = hasClaimIdentity(profile);

  timesheetHint.hidden = hasProfile;
  claimWrapper.hidden = !hasProfile;
  if (!hasProfile) return;

  const from = rangeFromField.value;
  const to = rangeToField.value;
  const allEntries = await getEntries();
  const entries = allEntries.filter(
    (e) => (!from || e.date >= from) && (!to || e.date <= to),
  );

  const root = document.getElementById("claimForm");
  fillClaimIdentity(root, profile, new Date().getFullYear());
  fillClaimRows(root, entries, to || todayStr());
  // Total Amount (and the Head of School signature and date) are left blank
  // for payroll to complete on the printed claim — tutors no longer enter a
  // rate here.
}

// The last day of the month `monthStart` ("YYYY-MM-01") falls in — day 0 of
// the next month.
function monthEnd(monthStart) {
  const [y, m] = monthStart.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthStart.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

// html2canvas + jsPDF, fetched from the CDN on first use and cached — later
// submissions reuse the same scripts. Resolves straight away when the
// globals are already present (a repeat call, or a stubbed test window).
let pdfLibsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          "Couldn't load the PDF tooling — check your connection and try again.",
        ),
      );
    document.head.appendChild(script);
  });
}

function loadPdfLibs() {
  if (window.html2canvas && window.jspdf?.jsPDF) return Promise.resolve();
  if (!pdfLibsPromise) {
    pdfLibsPromise = Promise.all([
      loadScript(HTML2CANVAS_URL),
      loadScript(JSPDF_URL),
    ])
      .then(() => {
        if (!window.html2canvas || !window.jspdf?.jsPDF) {
          throw new Error("The PDF tooling didn't initialise — try again.");
        }
      })
      .catch((err) => {
        // A failed CDN fetch shouldn't be cached — the next attempt retries.
        pdfLibsPromise = null;
        throw err;
      });
  }
  return pdfLibsPromise;
}

// Renders the month's claim form to a PDF an organiser can open: a fresh
// copy of the form — identity block, that month's rows, total and signature
// — filled off-screen and captured, so the file always matches the month
// being submitted even when the preview is showing a different range.
async function buildClaimPdf(monthStart) {
  const profile = profileDetails();
  if (!hasClaimIdentity(profile)) {
    throw new Error("Complete your details before submitting.");
  }

  const end = monthEnd(monthStart);
  const entries = await getEntriesForMonth(monthStart);

  await loadPdfLibs();

  const source = document.getElementById("claimForm");
  const clone = source.cloneNode(true);
  const container = document.createElement("div");
  // Off-screen but attached: html2canvas can only paint a laid-out element.
  container.style.cssText =
    "position:fixed; left:-10000px; top:0; background:#ffffff; pointer-events:none;";
  // jsdom reports no layout, so fall back to the form's natural page width.
  container.style.width = source.offsetWidth
    ? `${source.offsetWidth}px`
    : "820px";
  container.appendChild(clone);
  document.body.appendChild(container);

  try {
    fillClaimIdentity(clone, profile, Number(monthStart.slice(0, 4)));
    // A fully elapsed month is signed off on its last day; the current
    // month, submitted before it ends, is signed today.
    const today = todayStr();
    fillClaimRows(clone, entries, end < today ? end : today);

    const canvas = await window.html2canvas(clone, {
      scale: 2,
      backgroundColor: "#ffffff",
      logging: false,
    });

    // One page exactly as tall as the form — no clipping, no blank tails.
    const pdf = new window.jspdf.jsPDF({
      unit: "px",
      format: [canvas.width, canvas.height],
      hotfixes: ["px_scaling"],
    });
    pdf.addImage(canvas, "PNG", 0, 0, canvas.width, canvas.height);
    return await pdf.output("blob");
  } finally {
    container.remove();
  }
}

// Uploads the freshly rendered PDF — done before the submission POST so a
// month is never filed without the document organisers review. The server
// 409s while a month is locked (pending or approved).
async function uploadTimesheetPdf(userId, monthStart, blob) {
  const res = await fetch(
    `/api/timesheets/${encodeURIComponent(userId)}/${monthStart}/pdf`,
    {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: blob,
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || "Couldn't upload the timesheet PDF.");
  }
}

async function loadDisputes(userId) {
  try {
    const res = await fetch(
      `/api/timesheet-disputes?raisedBy=${encodeURIComponent(userId)}`,
    );
    const disputes = await res.json();
    if (!res.ok) throw new Error(disputes.error);

    // The API orders newest-first, so the first one seen per month is the latest.
    latestDisputeByWeek = new Map();
    disputes.forEach((d) => {
      if (!latestDisputeByWeek.has(d.timesheet_week_start)) {
        latestDisputeByWeek.set(d.timesheet_week_start, d);
      }
    });
  } catch {
    latestDisputeByWeek = new Map();
  }
}

function renderDisputeCell(sub) {
  if (sub.status === "pending") return "";

  const dispute = latestDisputeByWeek.get(sub.week_start);
  if (dispute && !dispute.resolved) {
    return `<span class="status-pill disputed">Disputed</span>`;
  }

  const label = dispute ? "Dispute again" : "Dispute";
  return `<button type="button" class="btn-link" data-action="dispute" data-week="${sub.week_start}">${label}</button>`;
}

async function loadSubmissions() {
  const user = getCurrentUser();
  if (!user) return;

  let rows = [];
  try {
    const res = await fetch(
      `/api/timesheets?tutorId=${encodeURIComponent(user.id)}`,
    );
    rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load timesheets");
  } catch {
    return;
  }

  await loadDisputes(user.id);

  submissionsByMonth = new Map(rows.map((sub) => [sub.week_start, sub]));

  submissionsListEl.innerHTML = "";
  submissionsEmptyEl.hidden = rows.length > 0;

  rows.forEach((sub) => {
    const status = (sub.status || "pending").toLowerCase();
    const dispute = latestDisputeByWeek.get(sub.week_start);
    const disputed = dispute && !dispute.resolved;
    const note = disputed
      ? "Disputed — please review and resubmit."
      : sub.reviewer_note || "";

    // A rejected month's action cell offers the remedy first — fix the
    // hours and resubmit — with the dispute link beside it unchanged.
    const actions =
      status === "rejected"
        ? `<button type="button" class="btn-link" data-action="resubmit" data-week="${sub.week_start}">Resubmit</button>`
        : "";

    const row = document.createElement("div");
    row.className = "ts-row";
    row.dataset.weekStart = sub.week_start;
    row.innerHTML = `
      <div>
        <p class="ts-row__week">${formatMonthLabel(sub.week_start)}</p>
        ${note ? `<p class="ts-row__dispute">${note}</p>` : ""}
      </div>
      <span class="status-pill ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      <div class="ts-row__right">
        <p class="ts-row__hours">${Number(sub.total_hours)}h</p>
        <p class="ts-row__date">${sub.submitted_at.slice(0, 10)}</p>
      </div>
      <div class="ts-row__action">${actions}${renderDisputeCell(sub)}</div>
    `;
    submissionsListEl.appendChild(row);
  });

  // The submit tool reads the submissions map, so refresh its hint for
  // whichever month is currently picked.
  await updateSubmitMonthHint();
}

async function updateSubmitMonthHint() {
  const monthValue = submitMonthField.value; // "YYYY-MM"
  if (!monthValue) {
    submitMonthHint.textContent = "";
    return;
  }
  const monthStart = getMonthStart(monthValue);
  const total = await getMonthTotal(monthStart);

  // A month that's been through review says so here — and a rejected one is
  // the call to fix the hours and submit again.
  const status = (
    submissionsByMonth.get(monthStart)?.status || ""
  ).toLowerCase();
  const suffix = {
    rejected:
      " — rejected; fix your logged hours, then submit again to resubmit.",
    pending: " — already awaiting review.",
    approved: " — already approved.",
  }[status];

  submitMonthHint.textContent = suffix
    ? `${total} hrs logged for ${formatMonthLabel(monthStart)}${suffix}`
    : `${total} hrs logged for ${formatMonthLabel(monthStart)}.`;

  submitTimesheetBtn.textContent =
    status === "rejected" ? "Resubmit for approval" : SUBMIT_BUTTON_LABEL;
}

submitMonthField.addEventListener("change", updateSubmitMonthHint);

submitTimesheetBtn.addEventListener("click", async () => {
  const user = getCurrentUser();
  if (!user) {
    showToast("You need to be signed in to submit a timesheet.", "danger");
    return;
  }
  if (!ensureDateFieldValid(submitMonthField)) return;
  if (!submitMonthField.value) {
    showToast("Pick a month to submit.", "danger");
    return;
  }

  const monthStart = getMonthStart(submitMonthField.value);
  // A submission against a month that was rejected is a resubmission — the
  // server rebuilds the snapshot and reopens it for review.
  const resubmitting =
    (submissionsByMonth.get(monthStart)?.status || "").toLowerCase() ===
    "rejected";

  submitTimesheetBtn.disabled = true;
  submitTimesheetBtn.textContent = "Preparing PDF…";
  try {
    // The claim PDF goes up first — a month filed without its document
    // would leave organisers reviewing something the tutor never sent.
    // Either step failing aborts the whole submission, retryably.
    const blob = await buildClaimPdf(monthStart);
    await uploadTimesheetPdf(user.id, monthStart, blob);

    const res = await fetch("/api/timesheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tutorId: user.id,
        // The picker gives "YYYY-MM"; the server wants a date in the month.
        weekStart: monthStart,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't submit that timesheet.", "danger");
      return;
    }
    showToast(
      resubmitting
        ? "Timesheet resubmitted for approval."
        : "Timesheet submitted for approval.",
    );
    await loadSubmissions();
  } catch (err) {
    showToast(
      err instanceof TypeError
        ? "Network error — couldn't reach the server."
        : err.message || "Couldn't submit that timesheet.",
      "danger",
    );
  } finally {
    submitTimesheetBtn.disabled = false;
    // Recomputes the resting label (undoing "Preparing PDF…") from the
    // month's current status — which a successful submit has just refreshed.
    updateSubmitMonthHint();
  }
});

function openDisputeModal(weekStart) {
  pendingDispute = { weekStart };
  disputeForm.reset();
  disputeFormError.hidden = true;
  disputeModalContext.textContent = `Raising a dispute about ${formatMonthLabel(weekStart)}.`;
  disputeModal.showModal();
  disputeMessageInput.focus();
}

function closeDisputeModal() {
  disputeModal.close();
  pendingDispute = null;
}

document
  .getElementById("disputeModalCloseBtn")
  .addEventListener("click", closeDisputeModal);
document
  .getElementById("disputeCancelBtn")
  .addEventListener("click", closeDisputeModal);
disputeModal.addEventListener("click", (e) => {
  if (e.target === disputeModal) closeDisputeModal();
});

submissionsListEl.addEventListener("click", (e) => {
  const disputeBtn = e.target.closest('[data-action="dispute"]');
  if (disputeBtn) {
    openDisputeModal(disputeBtn.dataset.week);
    return;
  }

  // Resubmit points the submit tool at the rejected month — the tutor fixes
  // the hours in the log, then submits again from there.
  const resubmitBtn = e.target.closest('[data-action="resubmit"]');
  if (resubmitBtn) {
    submitMonthField.value = resubmitBtn.dataset.week.slice(0, 7);
    updateSubmitMonthHint();
    submitMonthField.focus({ preventScroll: true });
    submitMonthField.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

disputeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  disputeFormError.hidden = true;
  if (!pendingDispute) return;

  const user = getCurrentUser();
  const message = disputeMessageInput.value.trim();

  disputeSubmitBtn.disabled = true;
  try {
    const res = await fetch("/api/timesheet-disputes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timesheetUserId: user.id,
        timesheetWeekStart: pendingDispute.weekStart,
        raisedBy: user.id,
        message,
      }),
    });
    const body = await res.json();

    if (!res.ok) {
      disputeFormError.textContent =
        body.error || "Couldn't submit that dispute.";
      disputeFormError.hidden = false;
      return;
    }

    closeDisputeModal();
    showToast("Dispute submitted.");
    await loadSubmissions();
  } catch {
    disputeFormError.textContent = "Network error — couldn't reach the server.";
    disputeFormError.hidden = false;
  } finally {
    disputeSubmitBtn.disabled = false;
  }
});

printBtn.addEventListener("click", () => window.print());
rangeFromField.addEventListener("change", safeRenderClaim);
rangeToField.addEventListener("change", safeRenderClaim);

// The head's "New timesheet" button points at the submit tool below.
document.getElementById("new-timesheet-btn").addEventListener("click", () => {
  submitMonthField.focus({ preventScroll: true });
  submitMonthField.scrollIntoView({ behavior: "smooth", block: "center" });
});

const { from, to } = defaultRange();
rangeFromField.value = from;
rangeToField.value = to;

// Pre-select the current calendar month.
submitMonthField.value = todayStr().slice(0, 7);
updateSubmitMonthHint();

(async () => {
  // Profile-page values land before the first render so the claim never
  // briefly shows stale locally saved identity fields.
  await loadAccountProfile();
  loadProfileIntoForm();
  applyProfileLocks();
  safeRenderClaim();

  await loadSubmissions();
  window.AutoSync?.start(loadSubmissions);

  // Arriving from a "timesheet reviewed" or "timesheet due" notification —
  // scroll to and flash the month it was about.
  const highlightWeek = consumeQueryParam("highlightWeek");
  if (highlightWeek) {
    scrollAndHighlight(
      submissionsListEl.querySelector(
        `[data-week-start="${CSS.escape(highlightWeek)}"]`,
      ),
    );
  }
})();
