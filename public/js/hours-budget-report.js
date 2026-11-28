const fromDateEl = document.getElementById("fromDate");
const toDateEl = document.getElementById("toDate");
const applyFilterBtn = document.getElementById("applyFilterBtn");
const clearFilterBtn = document.getElementById("clearFilterBtn");
const reportSectionsEl = document.getElementById("reportSections");
const emptyCopyEl = document.getElementById("emptyCopy");
const unlinkedWarningEl = document.getElementById("unlinkedWarning");
const budgetBarsEl = document.getElementById("budgetBars");
const budgetBarsEmptyEl = document.getElementById("budgetBarsEmpty");
const statTotalHoursEl = document.getElementById("statTotalHours");
const statTotalCostEl = document.getElementById("statTotalCost");
const statBudgetUsedEl = document.getElementById("statBudgetUsed");
const statOverBudgetEl = document.getElementById("statOverBudget");

// Impossible typed dates must block the action — the mask surfaces the
// field's own message; harnesses that don't load date-mask.js pass through.
const ensureDateFieldValid = window.ensureDateFieldValid ?? (() => true);

function formatMoney(value) {
  if (value == null) return "—";
  return `R${Number(value).toFixed(2)}`;
}

function formatHours(value) {
  return `${Number(value).toFixed(1)} hrs`;
}

// Tile-friendly money: rounded, thousands-separated, no cents.
function formatMoneyCompact(value) {
  if (value == null) return "—";
  return `R${Math.round(Number(value)).toLocaleString("en-ZA")}`;
}

async function loadReport({ quiet = false } = {}) {
  if (!quiet) {
    reportSectionsEl.innerHTML = `<p class="hint">Loading…</p>`;
    emptyCopyEl.hidden = true;
    unlinkedWarningEl.hidden = true;
  }

  const params = new URLSearchParams();
  if (fromDateEl.value) params.set("from", fromDateEl.value);
  if (toDateEl.value) params.set("to", toDateEl.value);

  let body;
  try {
    const res = await fetch(`/api/hour-entries/report?${params.toString()}`);
    body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to load report");
  } catch (err) {
    if (!quiet) {
      reportSectionsEl.innerHTML = "";
      renderSummary(null);
      renderAllocationBars([]);
      showToast(err.message || "Couldn't load the report right now.");
    }
    return;
  }

  const { rows, unlinkedHours, unlinkedEntryCount } = body;

  if (unlinkedEntryCount > 0) {
    unlinkedWarningEl.hidden = false;
    unlinkedWarningEl.textContent = `${formatHours(unlinkedHours)} across ${unlinkedEntryCount} ${unlinkedEntryCount === 1 ? "entry" : "entries"} logged as Tutoring aren't linked to a course, and are excluded from the totals below.`;
  }

  renderReport(rows);
}

function renderReport(rows) {
  reportSectionsEl.innerHTML = "";

  if (rows.length === 0) {
    emptyCopyEl.hidden = false;
    renderSummary(null);
    renderAllocationBars([]);
    return;
  }
  emptyCopyEl.hidden = true;

  const byCourse = new Map();
  for (const row of rows) {
    if (!byCourse.has(row.courseId)) {
      byCourse.set(row.courseId, {
        courseCode: row.courseCode,
        courseName: row.courseName,
        budget: row.budget,
        tutorRows: [],
      });
    }
    byCourse.get(row.courseId).tutorRows.push(row);
  }

  const courses = [...byCourse.values()].sort((a, b) =>
    a.courseCode.localeCompare(b.courseCode),
  );

  // Page-level totals for the stat tiles + allocation panel.
  let totalHours = 0;
  let totalCost = 0;
  let totalBudget = 0;
  let hasBudget = false;
  let overBudgetCount = 0;
  const allocationRows = [];

  courses.forEach((course, index) => {
    const courseHours = course.tutorRows.reduce((sum, r) => sum + r.hours, 0);
    const courseCost = course.tutorRows.reduce(
      (sum, r) => sum + (r.cost ?? 0),
      0,
    );
    const hasUnknownRate = course.tutorRows.some((r) => r.cost == null);
    const remaining = course.budget != null ? course.budget - courseCost : null;
    const overBudget = remaining != null && remaining < 0;

    totalHours += courseHours;
    totalCost += courseCost;
    if (course.budget != null) {
      hasBudget = true;
      totalBudget += course.budget;
    }
    if (overBudget) overBudgetCount += 1;

    allocationRows.push({
      code: course.courseCode,
      cost: courseCost,
      budget: course.budget,
      over: overBudget,
    });

    // Cost breakdown: one collapsible card per course, opened on the first.
    const details = document.createElement("details");
    details.className = "report-course";
    if (index === 0) details.open = true;

    const summary = document.createElement("summary");
    summary.innerHTML = `
      <span>${course.courseCode} — ${course.courseName}</span>
      <span class="report-course__hint">${formatHours(courseHours)} · ${formatMoneyCompact(courseCost)}${
        course.budget != null ? ` of ${formatMoneyCompact(course.budget)}` : ""
      }</span>
    `;
    details.appendChild(summary);

    if (hasUnknownRate) {
      const warn = document.createElement("p");
      warn.className = "field-warning";
      warn.textContent =
        "Some tutors on this course have no hourly rate set, so their cost is excluded.";
      details.appendChild(warn);
    }

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "data-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Tutor</th>
          <th>Hours logged</th>
          <th>Hourly rate</th>
          <th>Cost</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement("tbody");
    course.tutorRows
      .sort((a, b) => b.hours - a.hours)
      .forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="cell-strong">${row.tutorName || "Unknown tutor"}</td>
          <td>${formatHours(row.hours)}</td>
          <td>${row.hourlyRate != null ? formatMoney(row.hourlyRate) : "—"}</td>
          <td>${formatMoney(row.cost)}</td>
        `;
        tbody.appendChild(tr);
      });
    table.appendChild(tbody);
    wrap.appendChild(table);
    details.appendChild(wrap);

    reportSectionsEl.appendChild(details);
  });

  renderSummary({
    hours: totalHours,
    cost: totalCost,
    budget: hasBudget ? totalBudget : null,
    over: overBudgetCount,
  });
  renderAllocationBars(allocationRows);
}

function renderSummary(totals) {
  if (!statTotalHoursEl) return;
  if (!totals) {
    statTotalHoursEl.textContent = "0h";
    statTotalCostEl.textContent = "R0";
    statBudgetUsedEl.textContent = "—";
    statOverBudgetEl.textContent = "0";
    return;
  }
  statTotalHoursEl.textContent = `${totals.hours.toFixed(1)}h`;
  statTotalCostEl.textContent = formatMoneyCompact(totals.cost);
  statBudgetUsedEl.textContent = totals.budget
    ? `${Math.round((totals.cost / totals.budget) * 100)}%`
    : "—";
  statOverBudgetEl.textContent = String(totals.over);
}

function renderAllocationBars(rows) {
  if (!budgetBarsEl) return;
  budgetBarsEl.innerHTML = "";
  budgetBarsEmptyEl.hidden = rows.length > 0;
  if (rows.length === 0) return;

  // Courses with a budget fill proportionally to it; budget-less courses
  // fall back to a shared scale of the largest cost so the bars still
  // compare.
  const maxCost = Math.max(...rows.map((r) => r.cost), 1);
  rows.forEach((row) => {
    const pct =
      row.budget != null && row.budget > 0
        ? Math.min(100, (row.cost / row.budget) * 100)
        : Math.min(100, (row.cost / maxCost) * 100);
    const el = document.createElement("div");
    el.className = "budget-row";
    el.innerHTML = `
      <span class="budget-row__code">${row.code}</span>
      <span class="budget-row__track">
        <span class="budget-row__fill${row.over ? " budget-row__fill--over" : ""}" style="width: ${pct}%"></span>
      </span>
      <span class="budget-row__value${row.over ? " budget-row__value--over" : ""}">${formatMoneyCompact(row.cost)}${row.budget != null ? ` / ${formatMoneyCompact(row.budget)}` : ""}</span>
    `;
    budgetBarsEl.appendChild(el);
  });
}

applyFilterBtn.addEventListener("click", () => {
  if (!ensureDateFieldValid(fromDateEl)) return;
  if (!ensureDateFieldValid(toDateEl)) return;
  loadReport();
});
clearFilterBtn.addEventListener("click", () => {
  fromDateEl.value = "";
  toDateEl.value = "";
  loadReport();
});

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

loadReport();
window.AutoSync?.start(() => loadReport({ quiet: true }));

// ---------- guided tour ----------
// The "?" navbar button walks the report's main regions. Same sessionStorage
// "user" key as the board tour, so progress is keyed per user here too.
function getSessionUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

const BUDGET_TOUR_STEPS = [
  {
    selector: ".org-stats",
    title: "Report totals",
    body: "Hours logged, total cost, budget used and how many courses are over budget — all for the date range you've selected.",
    placement: "bottom",
  },
  {
    selector: ".org-toolbar",
    title: "Pick a date range",
    body: "Set a from/to range and apply it, or leave both blank to include every logged hour on record.",
    placement: "bottom",
  },
  {
    selector: "#budgetBars",
    title: "Budget allocation",
    body: "Each course's budget against what logged hours have already committed.",
    placement: "top",
  },
  {
    selector: "#reportSections",
    title: "Cost breakdown",
    body: "Per-course sections list the logged hours and costs behind the totals above.",
    placement: "top",
  },
];

const tourLinkEl = document.getElementById("tour-link");
if (tourLinkEl) {
  tourLinkEl.addEventListener("click", (e) => {
    e.preventDefault();
    window.Onboarding?.start(BUDGET_TOUR_STEPS, {
      tourId: "organiser-budget",
      userId: getSessionUserId(),
      force: true,
    });
  });
}
