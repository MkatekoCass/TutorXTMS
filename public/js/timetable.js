// Mirrors DAY_NAMES in server/dayNames.js — index 0 = Sunday.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const HOUR_START = 7; // 07:00
const HOUR_END = 19; // 19:00
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = ((HOUR_END - HOUR_START) * 60) / SLOT_MINUTES;

const gridEl = document.getElementById("timetableGrid");
const unscheduledEl = document.getElementById("timetableUnscheduled");
const sessionDetailModal = document.getElementById("sessionDetailModal");
const sessionDetailHeading = document.getElementById("sessionDetailHeading");
const sessionDetailClash = document.getElementById("sessionDetailClash");
const sessionDetailList = document.getElementById("sessionDetailList");
const sessionDetailEditBtn = document.getElementById("sessionDetailEditBtn");
const sessionDetailCloseBtn = document.getElementById("sessionDetailCloseBtn");
const sessionDetailDismissBtn = document.getElementById(
  "sessionDetailDismissBtn",
);

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function timesOverlap(startA, endA, startB, endB) {
  return (
    timeToMinutes(startA) < timeToMinutes(endB) &&
    timeToMinutes(startB) < timeToMinutes(endA)
  );
}

function mapCourseRow(row) {
  return {
    id: row.id,
    code: row.course_code,
    name: row.course_name,
    department: row.department,
    tutorsNeeded: row.tutors_needed,
    tutorsAssigned: row.no_of_tutors_assigned,
    minMark: row.min_mark,
    hoursPerWeek: row.hours_per_week,
    budget: row.budget,
    level: row.course_level,
    dayOfTut: row.Day_of_tut,
    startTime: row.tutor_start_time,
    endTime: row.tutor_end_time,
    venues: row.venues,
    dayOfLab: row.Day_of_lab,
    labStartTime: row.lab_start_time,
    labEndTime: row.lab_end_time,
    labVenues: row.lab_venues,
  };
}

// Flattens each course's Tutorial and Lab sessions into a list of placeable
// sessions.
function getAllSessions(courses) {
  const sessions = [];
  courses.forEach((c) => {
    if (c.dayOfTut && c.startTime && c.endTime) {
      sessions.push({
        courseId: c.id,
        courseCode: c.code,
        course: c,
        type: "Tutorial",
        day: c.dayOfTut,
        start: c.startTime.slice(0, 5),
        end: c.endTime.slice(0, 5),
        venue: c.venues || "",
      });
    }
    if (c.dayOfLab && c.labStartTime && c.labEndTime) {
      sessions.push({
        courseId: c.id,
        courseCode: c.code,
        course: c,
        type: "Lab",
        day: c.dayOfLab,
        start: c.labStartTime.slice(0, 5),
        end: c.labEndTime.slice(0, 5),
        venue: c.labVenues || "",
      });
    }
  });
  return sessions;
}

// A fixed palette of readable bg/text/border triples, cycled by course id so
// every block for the same course (Tutorial and Lab alike) always renders in
// the same colour. Deliberately excludes red — that stays reserved for the
// clash indicator so a real double-booking still stands out from the normal
// per-course colouring.
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
  return COURSE_COLORS[courseId % COURSE_COLORS.length];
}

// A venue field can list several rooms for one session (e.g. multiple
// tutorial groups) as "MSL004,005,006" — a shorthand where bare numbers
// inherit the last letter prefix (so "005" means "MSL005"). Split that into
// individual, fully-qualified room names rather than comparing the whole
// field as one string.
function parseVenues(venueStr) {
  const tokens = (venueStr || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  let prefix = "";
  return tokens.map((token) => {
    const match = token.match(/^([A-Za-z]+)(\d.*)$/);
    if (match) {
      prefix = match[1];
      return token;
    }
    return prefix && /^\d/.test(token) ? prefix + token : token;
  });
}

// Rooms shared between two venue fields, preserving venueA's original casing.
function sharedVenues(venueA, venueB) {
  const setB = new Set(parseVenues(venueB).map((v) => v.toLowerCase()));
  return parseVenues(venueA).filter((v) => setB.has(v.toLowerCase()));
}

// At least one room in common, overlapping time, on the same day — a real
// double-booking.
function findClashPartners(session, allSessions) {
  if (!session.venue) return [];
  return allSessions.filter(
    (other) =>
      other !== session &&
      other.day.trim().toLowerCase() === session.day.trim().toLowerCase() &&
      sharedVenues(session.venue, other.venue).length > 0 &&
      timesOverlap(session.start, session.end, other.start, other.end),
  );
}

function renderGrid(sessions) {
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateRows = `auto repeat(${TOTAL_SLOTS}, 28px)`;

  const corner = document.createElement("div");
  corner.className = "timetable-grid-header";
  gridEl.appendChild(corner);

  DAY_NAMES.forEach((day) => {
    const header = document.createElement("div");
    header.className = "timetable-grid-header";
    header.textContent = day.slice(0, 3);
    gridEl.appendChild(header);
  });

  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const minutesFromStart = slot * SLOT_MINUTES;
    const hour = HOUR_START + Math.floor(minutesFromStart / 60);
    const isHourMark = minutesFromStart % 60 === 0;

    const label = document.createElement("div");
    label.className = "timetable-time-label";
    label.style.gridRow = String(slot + 2);
    label.style.gridColumn = "1";
    label.textContent = isHourMark ? `${String(hour).padStart(2, "0")}:00` : "";
    gridEl.appendChild(label);

    for (let day = 0; day < DAY_NAMES.length; day++) {
      const cellBg = document.createElement("div");
      cellBg.className = "timetable-cell-bg";
      cellBg.style.gridRow = String(slot + 2);
      cellBg.style.gridColumn = String(day + 2);
      gridEl.appendChild(cellBg);
    }
  }

  const unplaced = [];
  const totalMinutes = (HOUR_END - HOUR_START) * 60;

  // Group sessions by day so overlapping ones on the same day can be laid
  // out side-by-side instead of stacking on top of each other.
  const byDay = DAY_NAMES.map(() => []);
  sessions.forEach((session) => {
    const dayIndex = DAY_NAMES.findIndex(
      (d) => d.toLowerCase() === session.day.trim().toLowerCase(),
    );
    const startMin = timeToMinutes(session.start);
    const endMin = timeToMinutes(session.end);
    if (
      dayIndex === -1 ||
      endMin <= HOUR_START * 60 ||
      startMin >= HOUR_END * 60
    ) {
      unplaced.push(session);
      return;
    }
    byDay[dayIndex].push(session);
  });

  byDay.forEach((daySessions, dayIndex) => {
    if (daySessions.length === 0) return;

    const overlay = document.createElement("div");
    overlay.className = "timetable-day-overlay";
    overlay.style.gridRow = `2 / span ${TOTAL_SLOTS}`;
    overlay.style.gridColumn = String(dayIndex + 2);
    gridEl.appendChild(overlay);

    const sorted = [...daySessions].sort(
      (a, b) => timeToMinutes(a.start) - timeToMinutes(b.start),
    );

    // Group into clusters of transitively-overlapping sessions first, so a
    // session gets squeezed into narrow side-by-side lanes only when it
    // genuinely overlaps something — not just because something else
    // overlaps elsewhere that same day. Sessions are sorted by start time,
    // so a session joins the running cluster whenever it starts before the
    // cluster's current latest end (even if it doesn't directly overlap the
    // very first session in the cluster — that's what makes it transitive).
    const clusters = [];
    sorted.forEach((session) => {
      const startMin = timeToMinutes(session.start);
      const endMin = timeToMinutes(session.end);
      const cluster = clusters.find((c) => c.end > startMin);
      if (cluster) {
        cluster.sessions.push(session);
        cluster.end = Math.max(cluster.end, endMin);
      } else {
        clusters.push({ sessions: [session], end: endMin });
      }
    });

    clusters.forEach(({ sessions: clusterSessions }) => {
      // Greedy lane assignment within this cluster only (like Google
      // Calendar's day view): sessions each go into the first lane whose
      // previous session has already ended, otherwise a new lane opens.
      const laneEndMinutes = [];
      const laneOfSession = new Map();
      clusterSessions.forEach((session) => {
        const startMin = timeToMinutes(session.start);
        let lane = laneEndMinutes.findIndex((end) => end <= startMin);
        if (lane === -1) {
          lane = laneEndMinutes.length;
          laneEndMinutes.push(timeToMinutes(session.end));
        } else {
          laneEndMinutes[lane] = timeToMinutes(session.end);
        }
        laneOfSession.set(session, lane);
      });
      const laneCount = laneEndMinutes.length;

      clusterSessions.forEach((session) => {
        const startMin = Math.max(
          timeToMinutes(session.start),
          HOUR_START * 60,
        );
        const endMin = Math.min(timeToMinutes(session.end), HOUR_END * 60);
        const lane = laneOfSession.get(session);

        const clashPartners = findClashPartners(session, sessions);
        const block = document.createElement("a");
        block.href = `board.html?course=${session.courseId}`;
        block.className = `timetable-session ${session.type.toLowerCase()}${clashPartners.length ? " clash" : ""}`;
        block.style.top = `${((startMin - HOUR_START * 60) / totalMinutes) * 100}%`;
        block.style.height = `${((endMin - startMin) / totalMinutes) * 100}%`;
        block.style.left = `${(lane / laneCount) * 100}%`;
        block.style.width = `${100 / laneCount}%`;
        if (!clashPartners.length) {
          const palette = courseColor(session.courseId);
          block.style.background = palette.bg;
          block.style.color = palette.text;
          block.style.borderColor = palette.border;
        }
        block.title = clashPartners.length
          ? `Venue clash (${clashPartners.map((p) => sharedVenues(session.venue, p.venue).join("/")).join(", ")}) with ${clashPartners.map((p) => `${p.courseCode} ${p.type}`).join(", ")}`
          : `${session.courseCode} ${session.type}${session.venue ? ` · ${session.venue}` : " · no venue set"}`;
        // Three or more sessions side-by-side leaves each lane too narrow
        // for the time/venue lines, which then clip mid-word — render just
        // the course code there and let the click detail carry the rest.
        if (laneCount >= 3) {
          block.classList.add("is-dense");
          block.innerHTML = `<span class="session-code">${session.courseCode}${clashPartners.length ? " ⚠" : ""}</span>`;
        } else {
          block.innerHTML = `
          <span class="session-code">${session.courseCode}${clashPartners.length ? " ⚠" : ""}</span>
          <span class="session-meta">${session.type} · ${session.start}–${session.end}</span>
          ${session.venue ? `<span class="session-meta">${session.venue}</span>` : ""}
        `;
        }
        // The block stays an <a> to board.html?course=… so middle-click /
        // open-in-new-tab still works; a plain click opens the detail
        // dialog instead of navigating straight away.
        block.addEventListener("click", (e) => {
          e.preventDefault();
          openSessionDetail(session, clashPartners);
        });
        overlay.appendChild(block);
      });
    });
  });

  if (unplaced.length > 0) {
    unscheduledEl.hidden = false;
    unscheduledEl.textContent = `Couldn't place on the grid (unrecognised day or outside 07:00–19:00): ${unplaced
      .map((s) => `${s.courseCode} ${s.type} (${s.day} ${s.start}–${s.end})`)
      .join(", ")}`;
  } else {
    unscheduledEl.hidden = true;
  }
}

// course_level is stored as a rank (see the Add/Edit Course form) —
// translate it back to a label for the detail dialog.
const LEVEL_LABELS = {
  1: "1st year",
  2: "2nd year",
  3: "3rd year",
  4: "Honours",
  5: "Masters",
  6: "PhD",
};

function closeSessionDetail() {
  if (typeof sessionDetailModal.close === "function") {
    sessionDetailModal.close();
  } else {
    sessionDetailModal.removeAttribute("open");
  }
}

function openSessionDetail(session, clashPartners) {
  if (!sessionDetailModal) return;
  const course = session.course || {};
  sessionDetailHeading.textContent = `${session.courseCode} · ${session.type}`;

  if (clashPartners.length) {
    sessionDetailClash.hidden = false;
    sessionDetailClash.textContent = `Venue clash — shares ${clashPartners
      .map((p) => sharedVenues(session.venue, p.venue).join("/"))
      .join(", ")} with ${clashPartners
      .map((p) => `${p.courseCode} ${p.type}`)
      .join(", ")} at an overlapping time.`;
  } else {
    sessionDetailClash.hidden = true;
  }

  const rows = [
    ["Course", course.name || "—"],
    ["Day", session.day],
    ["Time", `${session.start}–${session.end}`],
    ["Venue", session.venue || "No venue set"],
    ["Department", course.department || "—"],
    [
      "Tutors",
      `${course.tutorsAssigned ?? 0} of ${course.tutorsNeeded ?? "—"} assigned`,
    ],
    ["Min mark", course.minMark != null ? `${course.minMark}%` : "—"],
    [
      "Hours / week",
      course.hoursPerWeek != null ? `${course.hoursPerWeek}h` : "—",
    ],
    ["Level", LEVEL_LABELS[course.level] || "—"],
  ];
  if (course.budget != null) {
    rows.push(["Budget", `R${Number(course.budget).toLocaleString("en-US")}`]);
  }
  sessionDetailList.innerHTML = rows
    .map(
      ([label, value]) =>
        `<div class="session-detail__row"><dt>${label}</dt><dd>${value}</dd></div>`,
    )
    .join("");

  // Same deep link the block's href carries: the allocation board selects
  // the course; editing continues from there.
  sessionDetailEditBtn.href = `board.html?course=${session.courseId}`;

  if (typeof sessionDetailModal.showModal === "function") {
    sessionDetailModal.showModal();
  } else {
    sessionDetailModal.setAttribute("open", "");
  }
}

if (sessionDetailModal) {
  sessionDetailCloseBtn.addEventListener("click", closeSessionDetail);
  sessionDetailDismissBtn.addEventListener("click", closeSessionDetail);
}

async function loadAndRender() {
  try {
    const res = await fetch("/api/courses");
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error || "Failed to load courses");
    const courses = rows.map(mapCourseRow);
    renderGrid(getAllSessions(courses));
  } catch (err) {
    unscheduledEl.hidden = false;
    unscheduledEl.textContent = "Couldn't load courses from the database.";
  }
}

loadAndRender();
window.AutoSync?.start(loadAndRender);
