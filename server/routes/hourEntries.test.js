const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const hourEntriesRouter = require("./hourEntries");
const { sessionClock } = require("../loggingWindow");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/hour-entries", hourEntriesRouter);
  return app;
}

// ---------- clock helpers (South African time, mirroring the route) ----------

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function toDateStr(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

function weekdayOf(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T00:00:00`).getDay()];
}

function clockTime(minutes) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mins = String(minutes % 60).padStart(2, "0");
  return `${hours}:${mins}`;
}

// The next occurrence of a weekday strictly after today, so tests that need
// "some other day" get a real future date without freezing the clock.
function nextWeekdayDate(dayName) {
  for (let i = 1; i <= 7; i += 1) {
    const date = addDays(TODAY, i);
    if (weekdayOf(date) === dayName) return date;
  }
  return addDays(TODAY, 7);
}

// The route reads "now" in South African time, so the fixtures must too —
// otherwise they drift two hours on a UTC machine like CI.
const { date: TODAY, minutes: NOW_MINUTES } = sessionClock();
// A lab window that always contains "now" (30 minutes either side, clamped
// to the day so the strings stay valid times) — lets the live-window rule
// be exercised against the real clock without freezing time.
const LAB_START = clockTime(Math.max(0, NOW_MINUTES - 30));
const LAB_END = clockTime(Math.min(NOW_MINUTES + 30, 23 * 60 + 59));

beforeEach(() => {
  tables = {
    hour_entries: [],
    tutors: [],
    academic_level_rates: [],
    session_excusals: [],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("POST /api/hour-entries", () => {
  beforeEach(() => {
    // Whatever the role, an entry now has to belong to a scheduled session
    // the user may log: the simplest fixture is a volunteer covering
    // today's tutorial while its logging window is open.
    tables.courses = [
      {
        id: 5,
        course_code: "COMS1018",
        Day_of_tut: weekdayOf(TODAY),
        tutor_start_time: "00:00:00",
        tutor_end_time: "23:59:00",
      },
    ];
    tables.session_excusals = [
      {
        id: "x1",
        cover_user_id: "t1",
        course_id: 5,
        session_date: TODAY,
        session_type: "tutorial",
      },
    ];
  });

  test("links the entry to the course and labels it with the course code", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      courseId: 5,
      subject: "something else",
    });

    expect(res.status).toBe(201);
    expect(res.body.course_id).toBe(5);
    expect(res.body.subject).toBe("COMS1018");
  });

  test("rejects an entry with no courseId", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: TODAY,
      hours: 2,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("courseId is required");
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects an entry for a course that doesn't exist", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: TODAY,
      hours: 2,
      courseId: 999,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown course");
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects an impossible date like 2026-13-99 before it reaches the database", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: "2026-13-99",
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      courseId: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "date must be a valid calendar date (YYYY-MM-DD)",
    );
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects an entry with no date", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      hours: 2,
      courseId: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("date is required (YYYY-MM-DD)");
    expect(tables.hour_entries).toHaveLength(0);
  });
});

describe("PUT /api/hour-entries/:id", () => {
  beforeEach(() => {
    tables.courses = [
      {
        id: 5,
        course_code: "COMS1018",
        Day_of_tut: weekdayOf(TODAY),
        tutor_start_time: "00:00:00",
        tutor_end_time: "23:59:00",
      },
      {
        id: 6,
        course_code: "MATH1036",
        Day_of_tut: weekdayOf(TODAY),
        tutor_start_time: "09:00:00",
        tutor_end_time: "10:00:00",
      },
    ];
    tables.hour_entries = [
      {
        id: "e1",
        user_id: "t1",
        date: TODAY,
        hours: 2,
        start_time: "00:00:00",
        end_time: "23:59:00",
        course_id: 5,
        subject: "COMS1018",
        task_type: "Peer support",
        notes: "",
      },
    ];
  });

  test("a notes-only edit stays possible for users with no session role", async () => {
    const res = await request(buildApp()).put("/api/hour-entries/e1").send({
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      courseId: 5,
      notes: "fixed a typo",
    });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("fixed a typo");
  });

  test("rejects moving an entry onto a course the user isn't covering", async () => {
    const res = await request(buildApp()).put("/api/hour-entries/e1").send({
      date: TODAY,
      hours: 1,
      startTime: "09:00",
      endTime: "10:00",
      courseId: 6,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/covering/);
    expect(tables.hour_entries[0].course_id).toBe(5);
  });

  test("won't unlink an entry from its course", async () => {
    const res = await request(buildApp()).put("/api/hour-entries/e1").send({
      date: TODAY,
      hours: 2,
      courseId: null,
    });

    expect(res.status).toBe(400);
    expect(tables.hour_entries[0].course_id).toBe(5);
  });

  test("rejects an impossible date on an edit", async () => {
    // 29 February exists in 2028 but not 2027 — the same leap-year rule
    // the frontend mask enforces.
    const res = await request(buildApp()).put("/api/hour-entries/e1").send({
      date: "2027-02-29",
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      courseId: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "date must be a valid calendar date (YYYY-MM-DD)",
    );
    expect(tables.hour_entries[0].date).toBe(TODAY);
  });
});

describe("GET /api/hour-entries/report", () => {
  beforeEach(() => {
    tables.tutors = [
      { id: "t1", name: "Alice", academic_level: "honours" },
      { id: "t2", name: "Bob", academic_level: "masters" },
    ];
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
      { academic_level: "masters", hourly_rate: 200 },
    ];
  });

  test("groups Tutoring hours by tutor and course, computing cost from the hourly rate", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
      {
        user_id: "t1",
        course_id: 1,
        hours: 3,
        date: "2026-09-02",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      tutorId: "t1",
      tutorName: "Alice",
      hourlyRate: 150,
      courseCode: "COMS2000",
      hours: 5,
      cost: 750,
    });
  });

  test("keeps different tutors on the same course as separate rows", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
      {
        user_id: "t2",
        course_id: 1,
        hours: 4,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
  });

  test("excludes non-Tutoring task types", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Marking",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
  });

  test("filters by date range when from/to are given", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-08-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
      {
        user_id: "t1",
        course_id: 1,
        hours: 3,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get(
      "/api/hour-entries/report?from=2026-09-01&to=2026-09-30",
    );

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].hours).toBe(3);
  });

  test("rejects impossible or malformed from/to filters with a 400", async () => {
    const badFrom = await request(buildApp()).get(
      "/api/hour-entries/report?from=2026-13-99&to=2026-09-30",
    );
    expect(badFrom.status).toBe(400);
    expect(badFrom.body.error).toBe(
      "from must be a valid calendar date (YYYY-MM-DD)",
    );

    const badTo = await request(buildApp()).get(
      "/api/hour-entries/report?from=2026-09-01&to=2026-02-30",
    );
    expect(badTo.status).toBe(400);
    expect(badTo.body.error).toBe(
      "to must be a valid calendar date (YYYY-MM-DD)",
    );

    // A display-format date isn't the API's YYYY-MM-DD either.
    const malformed = await request(buildApp()).get(
      "/api/hour-entries/report?from=15/01/2026",
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe(
      "from must be a valid calendar date (YYYY-MM-DD)",
    );
  });

  test("accepts a real leap day but rejects it in a common year", async () => {
    const leap = await request(buildApp()).get(
      "/api/hour-entries/report?from=2028-02-29&to=2028-02-29",
    );
    expect(leap.status).toBe(200);

    const common = await request(buildApp()).get(
      "/api/hour-entries/report?from=2027-02-29",
    );
    expect(common.status).toBe(400);
    expect(common.body.error).toBe(
      "from must be a valid calendar date (YYYY-MM-DD)",
    );
  });

  test("reports unlinked hours (no course_id) separately instead of dropping them", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: null,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: null,
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.unlinkedHours).toBe(2);
    expect(res.body.unlinkedEntryCount).toBe(1);
  });

  test("leaves cost null when the tutor has no academic_level set", async () => {
    tables.tutors = [{ id: "t1", name: "Alice" }];
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows[0].hourlyRate).toBeNull();
    expect(res.body.rows[0].cost).toBeNull();
  });
});

describe("tutor session logging rules", () => {
  beforeEach(() => {
    tables.tutors = [{ id: "t1", name: "Oupa" }];
    tables.tutor_subject_preference = [
      { tutor_id: "t1", course_id: 5, status: "approved" },
    ];
    tables.courses = [
      {
        id: 5,
        course_code: "COMS1018A",
        // Both slots sit on today's weekday: the tutorial spans the whole
        // day and the lab hugs "now", so the live-window rule is satisfied
        // for whichever slot a test posts.
        Day_of_tut: weekdayOf(TODAY),
        tutor_start_time: "00:00:00",
        tutor_end_time: "23:59:00",
        Day_of_lab: weekdayOf(TODAY),
        lab_start_time: `${LAB_START}:00`,
        lab_end_time: `${LAB_END}:00`,
      },
      { id: 6, course_code: "MATH1036" },
    ];
  });

  test("accepts a tutor's entry for today's tutorial slot", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      taskType: "Tutoring",
      courseId: 5,
    });

    expect(res.status).toBe(201);
    expect(res.body.course_id).toBe(5);
    expect(tables.hour_entries).toHaveLength(1);
  });

  test("accepts today's lab slot", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: TODAY,
      hours: 1,
      startTime: LAB_START,
      endTime: LAB_END,
      courseId: 5,
    });

    expect(res.status).toBe(201);
    expect(tables.hour_entries).toHaveLength(1);
  });

  test("rejects times that don't match any scheduled slot", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: TODAY,
      hours: 1,
      startTime: "00:01",
      endTime: "00:02",
      courseId: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheduled tutorial or lab/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects a date that isn't the slot's weekday", async () => {
    // A weekday two days out never carries a slot on this course.
    const otherDay = weekdayOf(addDays(TODAY, 2));
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: nextWeekdayDate(otherDay),
        hours: 2,
        startTime: "00:00",
        endTime: "23:59",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheduled tutorial or lab/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects a future date even with the right slot times — logging only opens while the session runs", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: addDays(TODAY, 7),
        hours: 2,
        startTime: "00:00",
        endTime: "23:59",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/while it's happening/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects the right slot times once the session (plus grace) is over", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: addDays(TODAY, -7),
        hours: 2,
        startTime: "00:00",
        endTime: "23:59",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/while it's happening/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects a course the tutor isn't approved for", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: TODAY,
      hours: 1,
      startTime: "09:00",
      endTime: "10:00",
      courseId: 6,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/approved/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("lets a tutor edit notes without touching the session", async () => {
    const legacyDate = addDays(TODAY, -7);
    tables.hour_entries = [
      {
        id: "e9",
        user_id: "t1",
        date: legacyDate,
        hours: 2,
        course_id: 5,
        start_time: "08:00:00",
        end_time: "10:00:00",
        task_type: "Marking",
        notes: "",
      },
    ];

    const res = await request(buildApp()).put("/api/hour-entries/e9").send({
      date: legacyDate,
      hours: 2,
      startTime: "08:00",
      endTime: "10:00",
      taskType: "Marking",
      notes: "fixed a typo",
      courseId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("fixed a typo");
  });

  test("rejects moving an entry's time away from a scheduled slot", async () => {
    tables.hour_entries = [
      {
        id: "e10",
        user_id: "t1",
        date: TODAY,
        hours: 2,
        course_id: 5,
        start_time: "00:00:00",
        end_time: "23:59:00",
      },
    ];

    const res = await request(buildApp()).put("/api/hour-entries/e10").send({
      date: TODAY,
      hours: 1,
      startTime: "00:01",
      endTime: "00:02",
      courseId: 5,
    });

    expect(res.status).toBe(400);
    expect(tables.hour_entries[0].start_time).toBe("00:00:00");
  });

  test("allows re-pointing an entry onto a real slot, even in a past week", async () => {
    tables.hour_entries = [
      {
        id: "e11",
        user_id: "t1",
        date: TODAY,
        hours: 2,
        course_id: 5,
        start_time: "00:00:00",
        end_time: "23:59:00",
      },
    ];

    const res = await request(buildApp())
      .put("/api/hour-entries/e11")
      .send({
        date: addDays(TODAY, -7),
        hours: 2,
        startTime: "00:00",
        endTime: "23:59",
        courseId: 5,
      });

    expect(res.status).toBe(200);
    expect(tables.hour_entries[0].date).toBe(addDays(TODAY, -7));
  });

  test("rejects moving a tutor's entry to a course they aren't approved for", async () => {
    tables.hour_entries = [
      {
        id: "e12",
        user_id: "t1",
        date: TODAY,
        hours: 2,
        course_id: 5,
        start_time: "00:00:00",
        end_time: "23:59:00",
      },
    ];

    const res = await request(buildApp()).put("/api/hour-entries/e12").send({
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      courseId: 6,
    });

    expect(res.status).toBe(403);
    expect(tables.hour_entries[0].course_id).toBe(5);
  });
});

describe("volunteer cover logging rules", () => {
  function coverRow(overrides = {}) {
    return {
      id: "c1",
      cover_user_id: "vol1",
      course_id: 5,
      session_date: TODAY,
      session_type: "tutorial",
      ...overrides,
    };
  }

  beforeEach(() => {
    // Nobody here is a tutor — these users are volunteers, so the cover
    // assignments are the only sessions they may log.
    tables.tutors = [];
    tables.courses = [
      {
        id: 5,
        course_code: "COMS2002A",
        Day_of_tut: weekdayOf(TODAY),
        tutor_start_time: "00:00:00",
        tutor_end_time: "23:59:00",
        Day_of_lab: weekdayOf(TODAY),
        lab_start_time: `${LAB_START}:00`,
        lab_end_time: `${LAB_END}:00`,
      },
    ];
  });

  test("accepts a volunteer's entry for a session they're covering", async () => {
    tables.session_excusals = [coverRow()];

    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "vol1",
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      taskType: "Peer support",
      courseId: 5,
    });

    expect(res.status).toBe(201);
    expect(res.body.subject).toBe("COMS2002A");
    expect(res.body.task_type).toBe("Peer support");
  });

  test("rejects free-form logging for a session nobody assigned to them", async () => {
    tables.session_excusals = [];

    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "vol1",
      date: TODAY,
      hours: 1.5,
      startTime: "00:00",
      endTime: "23:59",
      taskType: "Peer support",
      courseId: 5,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/covering/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects a session someone else is covering", async () => {
    tables.session_excusals = [coverRow({ cover_user_id: "vol2" })];

    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "vol1",
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      taskType: "Peer support",
      courseId: 5,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/covering/);
  });

  test("rejects times that don't match the covered session's slot", async () => {
    tables.session_excusals = [coverRow()];

    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "vol1",
      date: TODAY,
      hours: 1,
      startTime: "00:01",
      endTime: "00:02",
      taskType: "Peer support",
      courseId: 5,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheduled tutorial or lab/);
  });

  test("only the covered session type counts", async () => {
    tables.session_excusals = [coverRow({ session_type: "lab" })];

    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "vol1",
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      taskType: "Peer support",
      courseId: 5,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/covering/);
  });

  test("rejects a covered session outside its live logging window", async () => {
    tables.session_excusals = [coverRow({ session_date: addDays(TODAY, -7) })];

    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "vol1",
        date: addDays(TODAY, -7),
        hours: 2,
        startTime: "00:00",
        endTime: "23:59",
        taskType: "Peer support",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/while it's happening/);
  });

  test("lets a volunteer fix notes without touching the session", async () => {
    tables.hour_entries = [
      {
        id: "e20",
        user_id: "vol1",
        date: TODAY,
        hours: 2,
        course_id: 5,
        start_time: "00:00:00",
        end_time: "23:59:00",
        task_type: "Peer support",
        notes: "",
      },
    ];

    const res = await request(buildApp()).put("/api/hour-entries/e20").send({
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      taskType: "Peer support",
      notes: "cover summary",
      courseId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("cover summary");
  });

  test("rejects moving a volunteer's entry onto a session they don't cover", async () => {
    tables.session_excusals = [];
    tables.hour_entries = [
      {
        id: "e21",
        user_id: "vol1",
        date: TODAY,
        hours: 2,
        course_id: 5,
        start_time: "00:00:00",
        end_time: "23:59:00",
        task_type: "Peer support",
      },
    ];

    const res = await request(buildApp())
      .put("/api/hour-entries/e21")
      .send({
        date: addDays(TODAY, -7),
        hours: 2,
        startTime: "00:00",
        endTime: "23:59",
        taskType: "Peer support",
        courseId: 5,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/covering/);
    expect(tables.hour_entries[0].date).toBe(TODAY);
  });
});

describe("attendance verification notifications", () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // A volunteer covering today's tutorial while its window is open — the
  // same shape as the POST fixtures above.
  function seedLoggableSession() {
    tables.courses = [
      {
        id: 5,
        course_code: "COMS1018",
        Day_of_tut: weekdayOf(TODAY),
        tutor_start_time: "00:00:00",
        tutor_end_time: "23:59:00",
      },
    ];
    tables.session_excusals = [
      {
        id: "x1",
        cover_user_id: "vol1",
        course_id: 5,
        session_date: TODAY,
        session_type: "tutorial",
      },
    ];
  }

  // org2 is approved for the course being logged, org9 only for a
  // different one, and org4 has no request rows at all — grandfathered, so
  // it hears about every course.
  function seedOrganisers() {
    tables.users = [
      {
        id: "vol1",
        name: "Naledi Mokoena",
        email: "n@wits.ac.za",
        role: "volunteer",
      },
      {
        id: "admin1",
        name: "Admin",
        email: "a@wits.ac.za",
        role: "super_organiser",
      },
      {
        id: "org2",
        name: "Org Two",
        email: "o2@wits.ac.za",
        role: "organiser",
      },
      {
        id: "org9",
        name: "Org Nine",
        email: "o9@wits.ac.za",
        role: "organiser",
      },
      {
        id: "org4",
        name: "Org Four",
        email: "o4@wits.ac.za",
        role: "organiser",
      },
    ];
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org2",
        course_id: 5,
        status: "approved",
        kind: "signup",
      },
      {
        id: 2,
        user_id: "org9",
        course_id: 9,
        status: "approved",
        kind: "signup",
      },
    ];
    tables.notifications = [];
  }

  test("logging a session notifies that course's organisers only", async () => {
    seedLoggableSession();
    seedOrganisers();

    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "vol1",
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      courseId: 5,
    });
    expect(res.status).toBe(201);

    await flush();
    expect(tables.notifications.map((n) => n.user_id).sort()).toEqual([
      "admin1",
      "org2",
      "org4",
    ]);
    tables.notifications.forEach((n) => {
      expect(n.type).toBe("attendance_logged");
      expect(n.message).toMatch(
        /Naledi Mokoena logged 2h for COMS1018 \(Tutorial\)/,
      );
      expect(n.message).toMatch(/verify their attendance/);
      expect(n.related_id).toBe(String(res.body.id));
    });
  });

  test("a notes-only edit keeps the earlier verification", async () => {
    seedLoggableSession();
    seedOrganisers();
    tables.hour_entries = [
      {
        id: "e30",
        user_id: "vol1",
        date: TODAY,
        hours: 2,
        course_id: 5,
        start_time: "00:00:00",
        end_time: "23:59:00",
        task_type: "Peer support",
        notes: "",
        verification_status: "verified",
        verified_by: "org2",
        verified_at: "2026-10-07T09:00:00.000Z",
      },
    ];

    const res = await request(buildApp()).put("/api/hour-entries/e30").send({
      date: TODAY,
      hours: 2,
      startTime: "00:00",
      endTime: "23:59",
      taskType: "Peer support",
      notes: "fixed a typo",
      courseId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body.verification_status).toBe("verified");
    await flush();
    expect(tables.notifications).toHaveLength(0);
  });

  test("moving a decided entry resets it to pending and re-notifies", async () => {
    seedLoggableSession();
    // A cover for next week's occurrence too, so the move is allowed.
    tables.session_excusals.push({
      id: "x2",
      cover_user_id: "vol1",
      course_id: 5,
      session_date: addDays(TODAY, 7),
      session_type: "tutorial",
    });
    seedOrganisers();
    tables.hour_entries = [
      {
        id: "e31",
        user_id: "vol1",
        date: TODAY,
        hours: 2,
        course_id: 5,
        start_time: "00:00:00",
        end_time: "23:59:00",
        verification_status: "flagged",
        verified_by: "org2",
        verified_at: "2026-10-07T09:00:00.000Z",
        verification_note: "wrong week",
      },
    ];

    const res = await request(buildApp())
      .put("/api/hour-entries/e31")
      .send({
        date: addDays(TODAY, 7),
        hours: 2,
        startTime: "00:00",
        endTime: "23:59",
        taskType: "Peer support",
        courseId: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      verification_status: "pending",
      verified_by: null,
      verified_at: null,
      verification_note: null,
    });

    await flush();
    expect(tables.notifications.map((n) => n.user_id).sort()).toEqual([
      "admin1",
      "org2",
      "org4",
    ]);
    expect(tables.notifications[0].type).toBe("attendance_logged");
  });
});
