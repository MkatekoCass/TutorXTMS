// Super-organiser approvals queue — two queues, one table:
//   * sign-up requests (kind 'signup', the default) — filed when someone
//     registers as an organiser; approving one grants access to their
//     chosen course and unblocks their sign-in (the gate lives in
//     routes/auth.js and google-callback.html).
//   * additional access (kind 'access') — filed from the board by an
//     existing organiser who selected a course they aren't approved for;
//     approving adds that course to their scope, picked up next sign-in.
// Page access is guarded by the inline requireRole("super_organiser") module
// script in organiser-requests.html.

const requestListEl = document.getElementById("requestList");
const requestsEmptyEl = document.getElementById("requestsEmpty");
const statusFilterEl = document.getElementById("statusFilter");
const statusChipsEl = document.getElementById("statusChips");

const accessRequestListEl = document.getElementById("accessRequestList");
const accessRequestsEmptyEl = document.getElementById("accessRequestsEmpty");
const accessStatusFilterEl = document.getElementById("accessStatusFilter");
const accessStatusChipsEl = document.getElementById("accessStatusChips");

const currentUser = JSON.parse(sessionStorage.getItem("user") || "null");

let allRequests = [];
let allAccessRequests = [];

// ---------------- helpers ----------------

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Timestamps arrive as a date ("2026-09-28") or an ISO string — show the day
// only, in the same dd/mm/yyyy form the rest of the organiser pages use.
function toDisplayDate(value) {
  if (!value) return "";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

// "COS132 — Imperative Programming", falling back to the id if the course
// row couldn't be stitched on (a request outlives its course row if the
// course was deleted after the organiser applied).
function courseLabel(row) {
  const course = row.course;
  if (!course) return `Course #${row.course_id}`;
  return `${course.course_code} — ${course.course_name}`;
}

function courseCode(row) {
  return row.course?.course_code || "their course";
}

function makeActionBtn(label, variant, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-small" + (variant ? ` ${variant}` : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------------- rendering ----------------

function renderRequest(row, listEl) {
  const name = row.user?.name || "Unknown user";
  const status = (row.status || "pending").toLowerCase();
  // There's no .status-pill.denied style — "denied" reuses the rejected
  // look from timesheet review so the two queues stay visually consistent.
  const pillClass = status === "denied" ? "rejected" : status;

  const li = document.createElement("li");
  li.dataset.requestId = row.id;
  const rowEl = document.createElement("div");
  rowEl.className = "review-row";
  rowEl.innerHTML = `
    <span class="avatar">${initials(name)}</span>
    <span class="name-block">
      <span class="name">${name}</span>
      <span class="role">${row.user?.email || ""}</span>
    </span>
    <span class="stamp-row">
      <span class="stamp">${courseLabel(row)}</span>
      <span class="stamp">Requested ${toDisplayDate(row.created_at)}</span>
      ${
        status !== "pending"
          ? `<span class="stamp">Reviewed ${toDisplayDate(row.reviewed_at)}</span>`
          : ""
      }
    </span>
    <span class="status-pill ${pillClass}">${status}</span>
    <span class="applicant-actions"></span>
  `;

  const actionsEl = rowEl.querySelector(".applicant-actions");
  if (status === "pending") {
    actionsEl.appendChild(
      makeActionBtn("Approve", "approve", () =>
        reviewRequest(row, "approve", name),
      ),
    );
    actionsEl.appendChild(
      makeActionBtn("Deny", "reject", () => reviewRequest(row, "deny", name)),
    );
  }

  li.appendChild(rowEl);
  listEl.appendChild(li);
}

function renderQueue(rows, filterEl, listEl, emptyEl) {
  listEl.innerHTML = "";
  const status = filterEl.value;
  const visible = rows.filter(
    (row) => !status || (row.status || "pending").toLowerCase() === status,
  );
  emptyEl.hidden = visible.length > 0;
  visible.forEach((row) => renderRequest(row, listEl));
}

function renderFiltered() {
  renderQueue(allRequests, statusFilterEl, requestListEl, requestsEmptyEl);
  renderQueue(
    allAccessRequests,
    accessStatusFilterEl,
    accessRequestListEl,
    accessRequestsEmptyEl,
  );
}

// ---------------- data loading ----------------

async function loadRequests({ quiet = false } = {}) {
  try {
    const reviewerId = currentUser?.id || "";
    const res = await fetch(
      `/api/organiser-requests?reviewerId=${encodeURIComponent(reviewerId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load requests");
    // The list is fetched whole and filtered client-side so the chip counts
    // always reflect every status, not just the visible filter. Rows
    // predate the kind column come back without one — those are sign-ups.
    allRequests = [];
    allAccessRequests = [];
    (rows || []).forEach((row) => {
      (row.kind === "access" ? allAccessRequests : allRequests).push(row);
    });
    updateChipCounts(statusChipsEl, allRequests);
    updateChipCounts(accessStatusChipsEl, allAccessRequests);
    renderFiltered();
  } catch (err) {
    if (!quiet) showToast("Couldn't load organiser requests.");
  }
}

async function reviewRequest(row, action, name) {
  try {
    const res = await fetch(`/api/organiser-requests/${row.id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewerId: currentUser?.id }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't update that request.");
      return;
    }
    const access = row.kind === "access";
    showToast(
      action === "approve"
        ? access
          ? `${name} now has access to ${courseCode(row)} — they'll see it on their next sign-in`
          : `${name} now has access to ${courseCode(row)}`
        : access
          ? `${name}'s additional-access request was denied`
          : `${name}'s organiser request was denied`,
    );
    await loadRequests();
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  }
}

// ---------------- summary + filter chips ----------------

function syncStatusChips(chipsEl, filterEl) {
  if (!chipsEl) return;
  chipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.status === filterEl.value);
  });
}

function updateChipCounts(chipsEl, rows) {
  if (!chipsEl) return;
  const counts = { pending: 0, approved: 0, denied: 0 };
  rows.forEach((row) => {
    const status = (row.status || "pending").toLowerCase();
    if (counts[status] != null) counts[status] += 1;
  });
  const labels = {
    pending: "Pending",
    approved: "Approved",
    denied: "Denied",
    "": "All",
  };
  const total = counts.pending + counts.approved + counts.denied;
  chipsEl.querySelectorAll(".filter-chip").forEach((chip) => {
    const status = chip.dataset.status;
    const count = status === "" ? total : counts[status] || 0;
    chip.textContent = `${labels[status]} (${count})`;
  });
}

// One wiring per queue — chips, hidden select and rendered list stay in
// sync within a queue, and the two queues filter independently.
[
  [statusChipsEl, statusFilterEl],
  [accessStatusChipsEl, accessStatusFilterEl],
].forEach(([chipsEl, filterEl]) => {
  chipsEl?.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip");
    if (!chip) return;
    filterEl.value = chip.dataset.status;
    syncStatusChips(chipsEl, filterEl);
    renderFiltered();
  });

  filterEl?.addEventListener("change", () => {
    syncStatusChips(chipsEl, filterEl);
    renderFiltered();
  });
});

// ---------------- toast ----------------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

syncStatusChips(statusChipsEl, statusFilterEl);
syncStatusChips(accessStatusChipsEl, accessStatusFilterEl);
loadRequests();
window.AutoSync?.start(() => loadRequests({ quiet: true }));

// ---------- guided tour ----------
// The "?" navbar button walks the two request lists. Same sessionStorage
// "user" key as the board tour, so progress is keyed per user here too.
function getSessionUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

const REQUESTS_TOUR_STEPS = [
  {
    selector: "#statusChips",
    title: "Filter sign-ups",
    body: "Pending, approved and denied organiser sign-ups — pick a chip to narrow the list.",
    placement: "bottom",
  },
  {
    selector: "#requestList",
    title: "Decide each sign-up",
    body: "Approve or deny from the row. Approving grants access to that organiser's chosen course only.",
    placement: "top",
  },
  {
    selector: "#accessStatusChips",
    title: "Additional access",
    body: "Organisers who already run courses can ask for more — those requests land in the second list.",
    placement: "top",
  },
];

const tourLinkEl = document.getElementById("tour-link");
if (tourLinkEl) {
  tourLinkEl.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(REQUESTS_TOUR_STEPS, {
      tourId: "organiser-requests",
      userId: getSessionUserId(),
      force: true,
    });
  });
}
