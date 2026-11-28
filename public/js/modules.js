import { highlightActiveTab } from "./nav.js";
import { requireRole } from "./storage.js";
import { consumeQueryParam, scrollAndHighlight } from "./highlightTarget.js";
import { initTranscriptUpload } from "./transcript-upload.js";

// This page (modules.html) is tutor-only — applying to tutor a module isn't
// a concept that applies to other roles.
const currentUser = requireRole("tutor");
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

// ---------- apply to tutor a module ----------

const applyBtn = document.getElementById("apply-to-tutor-btn");
const applyModal = document.getElementById("apply-modal");
const applyForm = document.getElementById("apply-form");
const applyError = document.getElementById("apply-form-error");
const applySubmitBtn = document.getElementById("apply-submit-btn");
const courseSelect = document.getElementById("apply-course-select");
const courseMeta = document.getElementById("apply-course-meta");
const yearSelect = document.getElementById("apply-year-select");
const markInput = document.getElementById("apply-mark-input");
const availabilitySelect = document.getElementById("apply-availability-select");
const availabilityLabel = document.getElementById("apply-availability-label");
const moduleGridEl = document.getElementById("module-grid");
const applicationsPanelEl = document.getElementById("applications-panel");
const applicationsCountEl = document.getElementById("applications-count");
const applicationsItemsEl = document.getElementById("applications-items");
const toastEl = document.getElementById("toast");

let COURSES = [];
let myApplications = [];
let myAcademicLevel = null;

// course_level is stored as a numeric rank (see server/routes/tutorApplications.js's
// LEVEL_RANK) — shown back to the tutor as the label they'd recognise from their own
// year-of-study dropdown, and compared against their academic level to badge each card.
const COURSE_LEVEL_LABEL = {
  3: "3rd year",
  4: "Honours",
  5: "Masters",
  6: "PhD",
};
const LEVEL_RANK = {
  third_year: 3,
  honours: 4,
  masters: 5,
  phd: 6,
};

// The prototype's module cards cycle through four accent colours.
const CARD_ACCENTS = ["blue", "violet", "amber", "rose"];

const MODULE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8.5 9.5h7M8.5 13h7M8.5 16.5h4" /></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>`;

function showToast(message, type = "success") {
  toastEl.textContent = message;
  toastEl.classList.remove("toast--success", "toast--danger");
  toastEl.classList.add(`toast--${type}`, "show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

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

function formatSession(course) {
  if (!course.Day_of_tut || !course.tutor_start_time || !course.tutor_end_time)
    return null;
  return `${course.Day_of_tut} · ${course.tutor_start_time.slice(0, 5)}–${course.tutor_end_time.slice(0, 5)}`;
}

async function fetchCourses() {
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load modules");
    COURSES = rows;
  } catch {
    showToast("Couldn't load modules from the database.", "danger");
    COURSES = [];
  }
  renderModuleCards();
}

async function fetchMyAcademicLevel(tutorId) {
  try {
    const res = await fetch(`/api/tutors/${encodeURIComponent(tutorId)}`);
    const row = await res.json();
    if (!res.ok) throw new Error(row.error || "Failed to load tutor record");
    myAcademicLevel = row.academic_level || null;
  } catch {
    myAcademicLevel = null;
  }
  renderModuleCards();
}

async function fetchMyApplications(tutorId) {
  try {
    const res = await fetch(
      `/api/tutor-applications?tutorId=${encodeURIComponent(tutorId)}`,
    );
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load applications");
    myApplications = rows;
  } catch {
    myApplications = [];
  }
  renderApplicationsList();
  updateApplicationsCount();
  renderModuleCards();
}

// The prototype badges each card with how well the module matches the tutor's
// record: a level above the module's requirement reads "Strong match", an exact
// match reads "Eligible", and anything below is flagged as needing a higher year.
function matchBadge(course) {
  const myRank = LEVEL_RANK[myAcademicLevel];
  if (!myRank || !course.course_level) return "";

  if (myRank > course.course_level) {
    return '<span class="badge badge--eligible">Strong match</span>';
  }
  if (myRank === course.course_level) {
    return '<span class="badge badge--applied">Eligible</span>';
  }
  const levelLabel = COURSE_LEVEL_LABEL[course.course_level];
  return `<span class="badge badge--mismatch">Needs ${levelLabel || "a higher level"}</span>`;
}

function applicationFor(courseId) {
  return myApplications.find(
    (app) => String(app.course_id ?? app.courses?.id) === String(courseId),
  );
}

function metaLines(course) {
  const lines = [];

  const levelLabel = COURSE_LEVEL_LABEL[course.course_level];
  lines.push(
    levelLabel ? `${levelLabel} level or higher` : "Open to all years",
  );

  const perWeek = course.hours_per_week
    ? `Up to ${course.hours_per_week}h per week`
    : null;
  const minMark =
    course.min_mark != null ? `Minimum ${course.min_mark}%` : null;
  const requirements = [perWeek, minMark].filter(Boolean).join(" · ");
  if (requirements) lines.push(requirements);

  const session = formatSession(course);
  lines.push(
    session ? `Tutorial · ${session}` : "Tutorial day/time not set yet",
  );

  if (course.venues) lines.push(course.venues);

  return lines;
}

// The card's bottom control reflects the application state: not applied yet gets
// the solid "Apply for module" action, everything else a soft non-interactive chip.
function cardControl(course, app) {
  const status = app ? (app.status || "pending").toLowerCase() : null;

  if (status === "pending" || status === "approved" || status === "rejected") {
    const soft = document.createElement("span");
    soft.className = "btn-soft";
    soft.textContent =
      status === "pending"
        ? "Application submitted"
        : status === "approved"
          ? "You tutor this module"
          : "Application not approved";
    return soft;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary";
  btn.dataset.applyCourse = course.id;
  btn.textContent = "Apply for module";
  return btn;
}

function renderModuleCards() {
  if (!moduleGridEl) return;
  moduleGridEl.innerHTML = "";

  if (COURSES.length === 0) {
    moduleGridEl.innerHTML =
      '<p class="empty-state module-grid__empty">No modules are open for applications right now — check back soon.</p>';
    return;
  }

  COURSES.forEach((course, index) => {
    const app = applicationFor(course.id);

    const card = document.createElement("article");
    card.className = `module-card module-card--${CARD_ACCENTS[index % CARD_ACCENTS.length]}`;

    const top = document.createElement("div");
    top.className = "module-card__top";
    top.innerHTML = `<span class="module-card__icon">${MODULE_ICON}</span>${matchBadge(course)}`;

    const heading = document.createElement("div");
    heading.className = "module-card__heading";
    const code = document.createElement("span");
    code.className = "module-card__code";
    code.textContent = course.course_code || "Module";
    const name = document.createElement("span");
    name.className = "module-card__name";
    name.textContent = course.course_name || "";
    heading.append(code, name);

    const meta = document.createElement("div");
    meta.className = "module-card__meta";
    metaLines(course).forEach((line) => {
      const lineEl = document.createElement("span");
      lineEl.textContent = line;
      meta.appendChild(lineEl);
    });

    card.append(top, heading, meta, cardControl(course, app));
    moduleGridEl.appendChild(card);
  });
}

function updateApplicationsCount() {
  if (!applicationsCountEl) return;
  const count = myApplications.length;
  applicationsCountEl.hidden = count === 0;
  if (count === 0) {
    applicationsCountEl.innerHTML = "";
    return;
  }
  applicationsCountEl.innerHTML = `${CHECK_ICON}<span></span>`;
  applicationsCountEl.querySelector("span").textContent =
    `${count} application${count === 1 ? "" : "s"} submitted`;
}

function renderApplicationsList() {
  if (myApplications.length === 0) {
    applicationsPanelEl.hidden = true;
    return;
  }
  applicationsPanelEl.hidden = false;
  applicationsItemsEl.innerHTML = "";

  myApplications.forEach((app) => {
    const li = document.createElement("li");
    li.className = "application-row";
    li.dataset.applicationId = app.id;
    const course = app.courses;
    const status = (app.status || "pending").toLowerCase();
    const label = course
      ? `${course.course_code} — ${course.course_name}`
      : "Module application";
    li.innerHTML = `
      <span>${label}</span>
      <span class="status-pill ${status}">${status}</span>
      ${
        status === "rejected" && app.rejection_reason
          ? `<p class="hint">Reason: ${app.rejection_reason}</p>`
          : ""
      }
      ${
        status === "approved" && app.approval_reason
          ? `<p class="hint">Note: ${app.approval_reason}</p>`
          : ""
      }
    `;

    if (status === "rejected") {
      // A locked rejection can't be cleared — the server refuses the
      // DELETE, so the module stays applied-for instead of offering a
      // remove button that would only ever fail.
      if (app.locked) {
        const lockNote = document.createElement("p");
        lockNote.className = "hint";
        lockNote.textContent =
          "An organiser has locked this rejection — it can't be removed and this module can't be re-applied for.";
        li.appendChild(lockNote);
        applicationsItemsEl.appendChild(li);
        return;
      }

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn-link";
      removeBtn.textContent = "Remove & apply again";
      removeBtn.addEventListener("click", async () => {
        const confirmed = await showConfirm(
          `Remove this application for ${label}? You'll be able to apply again.`,
          "Remove application",
        );
        if (!confirmed) return;

        removeBtn.disabled = true;
        try {
          const res = await fetch(`/api/tutor-applications/${app.id}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast(
              body.error || "Couldn't remove that application.",
              "danger",
            );
            removeBtn.disabled = false;
            return;
          }
          showToast("Application removed.");
          await fetchMyApplications(currentUser.id);
        } catch {
          showToast("Network error — couldn't reach the server.", "danger");
          removeBtn.disabled = false;
        }
      });
      li.appendChild(removeBtn);
      applicationsItemsEl.appendChild(li);
      return;
    }

    if (status !== "pending") {
      applicationsItemsEl.appendChild(li);
      return;
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      if (
        !(await showConfirm(
          `Cancel your application for ${label}?`,
          "Cancel application",
        ))
      )
        return;

      cancelBtn.disabled = true;
      try {
        const res = await fetch(`/api/tutor-applications/${app.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showToast(
            body.error || "Couldn't cancel that application.",
            "danger",
          );
          cancelBtn.disabled = false;
          return;
        }
        showToast("Application cancelled.", "danger");
        await fetchMyApplications(currentUser.id);
      } catch {
        showToast("Network error — couldn't reach the server.", "danger");
        cancelBtn.disabled = false;
      }
    });

    li.appendChild(cancelBtn);
    applicationsItemsEl.appendChild(li);
  });
}

function populateCourseSelect() {
  const appliedCourseIds = new Set(myApplications.map((a) => a.course_id));

  courseSelect.innerHTML =
    '<option value="" disabled selected>Choose a module&hellip;</option>';
  COURSES.forEach((course) => {
    const option = document.createElement("option");
    option.value = course.id;
    option.textContent = `${course.course_code} — ${course.course_name}`;
    if (appliedCourseIds.has(course.id)) {
      option.textContent += " (already applied)";
      option.disabled = true;
    }
    courseSelect.appendChild(option);
  });
}

function updateCourseMeta() {
  const course = COURSES.find((c) => String(c.id) === courseSelect.value);
  if (!course) {
    courseMeta.hidden = true;
    availabilityLabel.textContent = "Are you free at the tutorial time?";
    return;
  }

  const session = formatSession(course);
  const levelLabel = COURSE_LEVEL_LABEL[course.course_level];
  const requirements = [
    `a mark of ${course.min_mark}+`,
    levelLabel ? `${levelLabel} level or higher` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  courseMeta.hidden = false;
  courseMeta.textContent = session
    ? `Requires ${requirements} · tutorial is ${session}`
    : `Requires ${requirements} · tutorial day/time not yet set`;

  availabilityLabel.textContent = session
    ? `Are you free on ${session}?`
    : "Are you free at the tutorial time?";
}

// Opened from the page-head button (no preselect) or a module card's "Apply for
// module" button, which preselects that card's module in the dropdown.
function openApplyModal(preselectCourseId) {
  applyForm.reset();
  applyError.hidden = true;
  populateCourseSelect();
  updateCourseMeta();
  if (myAcademicLevel) yearSelect.value = myAcademicLevel;
  if (preselectCourseId) {
    courseSelect.value = String(preselectCourseId);
    updateCourseMeta();
  }
  applyModal.showModal();
}

function closeApplyModal() {
  applyModal.close();
}

applyBtn?.addEventListener("click", () => openApplyModal());
document
  .getElementById("apply-modal-close-btn")
  ?.addEventListener("click", closeApplyModal);
document
  .getElementById("apply-cancel-btn")
  ?.addEventListener("click", closeApplyModal);
applyModal?.addEventListener("click", (e) => {
  if (e.target === applyModal) closeApplyModal();
});
courseSelect?.addEventListener("change", updateCourseMeta);
moduleGridEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-apply-course]");
  if (btn) openApplyModal(btn.dataset.applyCourse);
});

applyForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  applyError.hidden = true;

  const payload = {
    tutorId: currentUser.id,
    courseId: Number(courseSelect.value),
    academicLevel: yearSelect.value,
    mark: Number(markInput.value),
    availability: availabilitySelect.value === "true",
  };

  applySubmitBtn.disabled = true;
  applySubmitBtn.textContent = "Submitting…";

  try {
    const res = await fetch("/api/tutor-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    if (!res.ok) {
      applyError.textContent =
        body.error || "Couldn't submit that application.";
      applyError.hidden = false;
      return;
    }

    closeApplyModal();
    showToast("Application submitted!");
    myAcademicLevel = payload.academicLevel;
    await fetchMyApplications(currentUser.id);
  } catch {
    applyError.textContent = "Network error — couldn't reach the server.";
    applyError.hidden = false;
  } finally {
    applySubmitBtn.disabled = false;
    applySubmitBtn.textContent = "Submit application";
  }
});

(async function init() {
  await fetchCourses();
  await fetchMyAcademicLevel(currentUser.id);
  await fetchMyApplications(currentUser.id);
  // An application isn't accepted until a transcript is on file — this
  // panel is where it's uploaded (see transcript-upload.js).
  await initTranscriptUpload(currentUser.id);

  window.AutoSync?.start(async () => {
    await Promise.allSettled([
      fetchCourses(),
      fetchMyApplications(currentUser.id),
    ]);
  });

  // Arriving from an "application status changed" notification — scroll to
  // and flash the application it was about.
  const highlightApplicationId = consumeQueryParam("highlightApplication");
  if (highlightApplicationId) {
    scrollAndHighlight(
      applicationsItemsEl.querySelector(
        `[data-application-id="${CSS.escape(highlightApplicationId)}"]`,
      ),
    );
  }
})();
