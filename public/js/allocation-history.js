// Plain classic script (no imports), same as board.js — the page itself
// carries the same requireRole module guard the other organiser pages use,
// so this script stays a simple classic script like its siblings.
function getSessionUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

const draftsListEl = document.getElementById("draftsList");
const historyListEl = document.getElementById("historyList");

function formatTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// draft/published/reverted don't have their own status-pill colours, so
// these borrow the closest existing meaning (approved = green, rejected =
// red) rather than adding a whole new colour variant for three statuses.
function draftPillClass(status) {
  if (status === "published") return "approved";
  if (status === "reverted") return "rejected";
  return "pending";
}

function actionPillClass(action) {
  if (["approved", "claimed", "published"].includes(action)) return "approved";
  if (["rejected", "withdrawn", "restored"].includes(action)) return "rejected";
  return "pending";
}

async function renderDrafts() {
  draftsListEl.innerHTML = "";

  let drafts;
  try {
    const res = await fetch("/api/allocation-drafts");
    if (!res.ok) throw new Error("Failed to load allocation runs");
    drafts = await res.json();
  } catch (err) {
    draftsListEl.innerHTML = `<p class="empty-state">Couldn't load past allocation runs right now.</p>`;
    return;
  }

  if (drafts.length === 0) {
    draftsListEl.innerHTML = `<p class="empty-state">No auto allocation has been run yet.</p>`;
    return;
  }

  drafts.forEach((draft) => {
    const article = document.createElement("article");
    article.className = "review-row";
    article.innerHTML = `
      <span class="name-block">
        <span class="name">${draft.name}</span>
        <span class="role">
          ${draft.assignmentCount} assignment${draft.assignmentCount === 1 ? "" : "s"}
          &bull; created ${formatTimestamp(draft.created_at)}
          ${draft.published_at ? `&bull; published ${formatTimestamp(draft.published_at)}` : ""}
        </span>
      </span>
      <span class="status-pill ${draftPillClass(draft.status)}">${draft.status}</span>
      <span class="applicant-actions"></span>
    `;
    const actionsEl = article.querySelector(".applicant-actions");

    if (draft.status === "draft") {
      const compareBtn = document.createElement("button");
      compareBtn.type = "button";
      compareBtn.className = "btn-secondary";
      compareBtn.textContent = "Compare & publish";
      compareBtn.addEventListener("click", () => openCompareModal(draft));
      actionsEl.appendChild(compareBtn);
    }

    if (draft.status === "published") {
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "btn-secondary";
      restoreBtn.textContent = "Restore";
      restoreBtn.addEventListener("click", () =>
        restoreDraft(draft, restoreBtn),
      );
      actionsEl.appendChild(restoreBtn);
    }

    draftsListEl.appendChild(article);
  });
}

async function restoreDraft(draft, button) {
  const confirmed = window.confirm(
    `Restore "${draft.name}"? Every application it approved goes back to its previous status, and those course slots open up again.`,
  );
  if (!confirmed) return;

  button.disabled = true;
  try {
    const res = await fetch(`/api/allocation-drafts/${draft.id}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organiserId: getSessionUserId() }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't restore that run.");
      button.disabled = false;
      return;
    }
    const failed = body.results.filter((r) => !r.success);
    const succeeded = body.results.length - failed.length;
    showToast(
      failed.length === 0
        ? `Restored ${succeeded} application${succeeded === 1 ? "" : "s"}.`
        : `Restored ${succeeded}, left ${failed.length} alone — they'd already been changed since.`,
    );
    await Promise.all([renderDrafts(), renderHistory()]);
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    button.disabled = false;
  }
}

// ---------- compare & publish an unpublished run ----------
//
// A draft can sit unpublished for days while the organiser thinks, or while
// other approvals land. This re-opens it against the live system: the
// compare endpoint dry-runs the publish checks and reports, per proposed
// assignment, whether it would still land today and why not otherwise.
// Publish then applies only the still-checked rows — same shape as the
// board's auto-allocate modal.

const compareModal = document.getElementById("compareModal");
const compareList = document.getElementById("compareList");
const compareEmpty = document.getElementById("compareEmpty");
const compareHint = document.getElementById("compareHint");
const comparePublishBtn = document.getElementById("comparePublishBtn");

let comparingDraft = null;

function closeCompareModal() {
  compareModal.close();
}

// The hours projection is only meaningful against a cap — tutors without
// one just get their pick explanation.
function hoursNote(assignment) {
  if (assignment.cap == null || assignment.projectedHours == null) return "";
  return ` — would take them to ${assignment.projectedHours}/${assignment.cap} hrs/week`;
}

async function openCompareModal(draft) {
  comparingDraft = draft;
  compareList.innerHTML = "";
  compareEmpty.hidden = true;
  compareHint.textContent = "Comparing with the current allocation…";
  comparePublishBtn.hidden = false;
  comparePublishBtn.disabled = true;
  compareModal.showModal();

  let body;
  try {
    const res = await fetch(`/api/allocation-drafts/${draft.id}/compare`);
    body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to compare");
  } catch (err) {
    compareHint.textContent = "Couldn't compare that run — try again.";
    comparePublishBtn.hidden = true;
    return;
  }

  const assignments = body.assignments || [];
  if (assignments.length === 0) {
    compareHint.textContent = "";
    compareEmpty.hidden = false;
    comparePublishBtn.hidden = true;
    return;
  }

  const { willApply, cannotApply } = body.summary;
  const total = assignments.length;

  if (willApply === 0) {
    compareHint.textContent =
      "None of these would still land today — nothing to publish.";
    comparePublishBtn.hidden = true;
  } else {
    compareHint.textContent =
      willApply === total
        ? `All ${total} assignment${total === 1 ? "" : "s"} would still land today — uncheck anything you'd rather decide yourself.`
        : `${willApply} of ${total} assignment${total === 1 ? "" : "s"} would still land today; ${cannotApply} ${cannotApply === 1 ? "has" : "have"} been overtaken by events since this run was proposed.`;
    comparePublishBtn.disabled = false;
  }

  assignments.forEach((assignment) => {
    const li = document.createElement("li");
    const tutorName = assignment.tutor?.name || "Unknown";
    const courseLabel =
      assignment.course?.course_code || `course ${assignment.course_id}`;

    if (assignment.willApply) {
      const row = document.createElement("label");
      row.className = "tutor-row";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <input type="checkbox" class="compare-check" data-id="${assignment.id}" checked>
        <span class="name-block">
          <span class="name">${tutorName} &mdash; ${courseLabel}</span>
          <span class="role">${assignment.explanation || ""}${hoursNote(assignment)}</span>
        </span>
      `;
      li.appendChild(row);
    } else {
      const row = document.createElement("div");
      row.className = "tutor-row blocked";
      row.style.cursor = "default";
      row.innerHTML = `
        <span class="name-block">
          <span class="name">${tutorName} &mdash; ${courseLabel}</span>
          <span class="role">${assignment.reason}${assignment.currentStatus ? ` (now ${assignment.currentStatus})` : ""}</span>
        </span>
      `;
      li.appendChild(row);
    }

    compareList.appendChild(li);
  });
}

document
  .getElementById("compareCloseBtn")
  .addEventListener("click", closeCompareModal);
document
  .getElementById("compareCancelBtn")
  .addEventListener("click", closeCompareModal);
compareModal.addEventListener("click", (e) => {
  if (e.target === compareModal) closeCompareModal();
});

comparePublishBtn.addEventListener("click", async () => {
  if (!comparingDraft) {
    closeCompareModal();
    return;
  }

  const allChecks = Array.from(compareList.querySelectorAll(".compare-check"));
  const excludeAssignmentIds = allChecks
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.id);

  if (excludeAssignmentIds.length === allChecks.length) {
    closeCompareModal();
    return;
  }

  comparePublishBtn.disabled = true;
  comparePublishBtn.textContent = "Publishing…";

  try {
    const res = await fetch(
      `/api/allocation-drafts/${comparingDraft.id}/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organiserId: getSessionUserId(),
          excludeAssignmentIds,
        }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't publish that run.");
      return;
    }
    const failed = body.results.filter((r) => !r.success);
    const succeeded = body.results.length - failed.length;
    showToast(
      failed.length === 0
        ? `${succeeded} assignment${succeeded === 1 ? "" : "s"} published.`
        : `${succeeded} published, ${failed.length} couldn't be — something changed since you compared. See the change history below for details.`,
    );
    closeCompareModal();
    await Promise.all([renderDrafts(), renderHistory()]);
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
  } finally {
    comparePublishBtn.disabled = false;
    comparePublishBtn.textContent = "Publish selected";
  }
});

async function renderHistory() {
  historyListEl.innerHTML = "";

  let entries;
  try {
    const res = await fetch("/api/audit-log?limit=200");
    if (!res.ok) throw new Error("Failed to load change history");
    entries = await res.json();
  } catch (err) {
    historyListEl.innerHTML = `<p class="empty-state">Couldn't load change history right now.</p>`;
    return;
  }

  if (entries.length === 0) {
    historyListEl.innerHTML = `<p class="empty-state">No changes recorded yet.</p>`;
    return;
  }

  entries.forEach((entry) => {
    const actor = entry.users?.name || entry.actor_id || "System";
    const article = document.createElement("article");
    article.className = "review-row";
    article.innerHTML = `
      <span class="name-block">
        <span class="name">${entry.entity_type} ${entry.entity_id}</span>
        <span class="role">
          ${actor} &bull; ${formatTimestamp(entry.created_at)}
        </span>
      </span>
      <span class="status-pill ${actionPillClass(entry.action)}">${entry.action}</span>
    `;
    historyListEl.appendChild(article);
  });
}

Promise.all([renderDrafts(), renderHistory()]);
window.AutoSync?.start(() => Promise.all([renderDrafts(), renderHistory()]));

// ---------- guided tour ----------
// The "?" navbar button walks the two history lists. getSessionUserId is
// the shared helper at the top of this file, so tour progress is keyed per
// user like the board tour.
const HISTORY_TOUR_STEPS = [
  {
    selector: "#draftsList",
    title: "Past allocation runs",
    body: "Every whole-school auto-allocation run. Compare an unpublished run against today's state before publishing it; restoring a published run reverts its approvals and frees the slots again.",
    placement: "top",
  },
  {
    selector: "#historyList",
    title: "Full change history",
    body: "Every approve, reject, claim and withdraw across tutor applications and volunteer sessions, newest first.",
    placement: "top",
  },
];

const tourLinkEl = document.getElementById("tour-link");
if (tourLinkEl) {
  tourLinkEl.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(HISTORY_TOUR_STEPS, {
      tourId: "organiser-history",
      userId: getSessionUserId(),
      force: true,
    });
  });
}
