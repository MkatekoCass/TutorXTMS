// Supabase-backed data layer for logged tutoring hours. Every read/write
// goes through the functions below and the /api/hour-entries routes
// (server/routes/), scoped to whichever user is signed in (see
// getCurrentUser).

export function getCurrentUser() {
  const raw = sessionStorage.getItem("user");
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    // Accounts created before the Volunteer rename were stored with
    // role "student" — normalise them so every page sees "volunteer".
    if (user && user.role === "student") user.role = "volunteer";
    return user;
  } catch {
    return null;
  }
}

// Where each role lands after login (mirrors the switch in auth.js).
const ROLE_HOME = {
  volunteer: "StudentView.html",
  tutor: "dashboard.html",
  // Legacy accounts created before the Volunteer rename.
  educator: "educator.html",
  organiser: "board.html",
  // The single admin account that reviews organiser requests — it shares
  // the organiser board, with every course visible.
  super_organiser: "board.html",
};

// Guards a role-specific page: sends a signed-out visitor to login, and
// sends a signed-in visitor of the *wrong* role back to their own home page
// instead of letting them view (and act on) a page built for another role.
// allowedRole is one role, or a list of roles for pages shared between
// them (e.g. the board serves both organisers and the super-organiser).
// Call this at the top of a page's script, before anything else runs.
export function requireRole(allowedRole) {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  const allowed = Array.isArray(allowedRole) ? allowedRole : [allowedRole];
  if (!allowed.includes(user.role)) {
    window.location.href = ROLE_HOME[user.role] || "login.html";
    return null;
  }
  return user;
}

function fromApiEntry(row) {
  return {
    id: row.id,
    date: row.date,
    hours: Number(row.hours),
    startTime: row.start_time || "",
    endTime: row.end_time || "",
    taskType: row.task_type || "Tutoring",
    subject: row.subject || "",
    notes: row.notes || "",
    courseId: row.course_id ?? null,
    // Attendance verification by an organiser for the entry's course —
    // 'pending' until decided, then 'verified' or 'flagged' (with a note).
    verificationStatus: row.verification_status || "pending",
    verificationNote: row.verification_note || "",
  };
}

async function readJson(response, failureMessage) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || failureMessage);
  }
  return response.json();
}

// --- Entries -------------------------------------------------------------

let entriesCache = null;
let entriesCacheAt = 0;
const ENTRIES_CACHE_TTL_MS = 10000;

async function fetchEntries() {
  const user = getCurrentUser();
  if (!user) return [];
  const res = await fetch(
    `/api/hour-entries?userId=${encodeURIComponent(user.id)}`,
  );
  const data = await readJson(res, "Failed to load hours");
  return data.map(fromApiEntry);
}

export async function getEntries() {
  if (
    !entriesCache ||
    Date.now() - entriesCacheAt >= ENTRIES_CACHE_TTL_MS
  ) {
    entriesCache = await fetchEntries();
    entriesCacheAt = Date.now();
  }
  return [...entriesCache].sort((a, b) => a.date.localeCompare(b.date));
}

export async function addEntry(entry) {
  const user = getCurrentUser();
  const res = await fetch("/api/hour-entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id, ...entry }),
  });
  const row = await readJson(res, "Failed to add entry");
  entriesCache = null;
  entriesCacheAt = 0;
  return fromApiEntry(row);
}

export async function updateEntry(id, changes) {
  const res = await fetch(`/api/hour-entries/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  const row = await readJson(res, "Failed to update entry");
  entriesCache = null;
  entriesCacheAt = 0;
  return fromApiEntry(row);
}

export async function deleteEntry(id) {
  const res = await fetch(`/api/hour-entries/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete entry");
  }
  entriesCache = null;
  entriesCacheAt = 0;
}

// Flags an entry whose time range overlaps another one's on the same date —
// nobody can be doing two different things (even a different task type or
// course) at the same moment, so this ignores every other field on purpose.
// "HH:MM" strings compare correctly as plain strings since they're
// zero-padded, so no need to parse them into minutes. Two ranges overlap
// when each one starts before the other ends; entries that are merely
// back-to-back (one starts exactly when the other ends) don't count — e.g.
// 10:00-12:00 and 12:00-13:00 coexist fine, but 11:30-13:03 overlaps both
// (ignoring the entry currently being edited, if any).
export async function findDuplicateEntry(
  { date, startTime, endTime },
  excludeId = null,
) {
  if (!startTime || !endTime) return null;
  const entries = await getEntries();
  return (
    entries.find(
      (e) =>
        e.id !== excludeId &&
        e.date === date &&
        e.startTime &&
        e.endTime &&
        startTime < e.endTime &&
        e.startTime < endTime,
    ) || null
  );
}

export async function getEntriesForWeek(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const entries = await getEntries();
  return entries.filter((e) => e.date >= weekStart && e.date <= weekEnd);
}

export async function getWeekTotal(weekStart) {
  const entries = await getEntriesForWeek(weekStart);
  return entries.reduce((sum, e) => sum + Number(e.hours), 0);
}

// A calendar month's entries — the period timesheets are submitted for.
// monthStart is the month's first day ("YYYY-MM-01").
export async function getEntriesForMonth(monthStart) {
  const monthEnd = addDays(addMonths(monthStart, 1), -1);
  const entries = await getEntries();
  return entries.filter((e) => e.date >= monthStart && e.date <= monthEnd);
}

export async function getMonthTotal(monthStart) {
  const entries = await getEntriesForMonth(monthStart);
  return entries.reduce((sum, e) => sum + Number(e.hours), 0);
}

export async function getEntriesForDate(dateStr) {
  const entries = await getEntries();
  return entries.filter((e) => e.date === dateStr);
}

// --- Date helpers (pure, no network) ----------------------------------

// Monday-based week start for a given 'YYYY-MM-DD' date string. Timesheets
// moved to months (getMonthStart below), but this is still used for the
// dashboard's "hours this week" stat against the weekly hours cap.
export function getWeekStart(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return toDateStr(date);
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

// First day of the calendar month a 'YYYY-MM-DD' date falls in — the period
// key timesheets are stored under ("YYYY-MM-01").
export function getMonthStart(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

// Month-start + n months (n may be negative), landing on a month's first day.
export function addMonths(monthStart, months) {
  const [y, m] = monthStart.split("-").map(Number);
  return toDateStr(new Date(y, m - 1 + months, 1));
}

export function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayStr() {
  return toDateStr(new Date());
}

// ---------- tutor profile (used to fill in the printable timesheet) ----------

// Namespaced by user id — a fixed key would leak one signed-in user's data
// to whoever is signed in next on the same browser (localStorage is shared
// across the whole origin, not per-session like sessionStorage).
function profileKey() {
  const user = getCurrentUser();
  return `tutorHours.profile.${user ? user.id : "anon"}`;
}

export function getProfile() {
  const raw = localStorage.getItem(profileKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  localStorage.setItem(profileKey(), JSON.stringify(profile));
}

// ---------- recurring class schedule (added manually or from a timetable PDF) ----------
// Each class recurs weekly on the same weekday from firstDate through endDate,
// separate from logged hours so it never affects hours-worked totals.
//
// The server (tutor_busy_times, via /api/tutors/:id/busy-times) is the only
// copy — nothing is kept in the browser's storage, so a user's classes follow
// them to any browser or device. loadSchedule() fetches them into the
// in-memory cache below, which the synchronous date lookups the calendar
// renders from read; each change is written to the server first and only
// then applied to the cache.

let scheduleCache = [];
// Whose classes are cached, so a different signed-in user never sees them.
let scheduleUserId = null;

function fromApiBusyTime(row) {
  return {
    id: row.id,
    title: row.title || "",
    dayOfWeek: row.day_of_week,
    startTime: (row.start_time || "").slice(0, 5),
    endTime: (row.end_time || "").slice(0, 5),
    firstDate: row.first_date || "",
    endDate: row.end_date || "",
    venue: row.venue || "",
    exceptions: Array.isArray(row.exceptions) ? row.exceptions : [],
  };
}

function busyTimesUrl(suffix = "") {
  const user = getCurrentUser();
  if (!user) throw new Error("Not signed in");
  return `/api/tutors/${encodeURIComponent(user.id)}/busy-times${suffix}`;
}

async function expectOk(response, failureMessage) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || failureMessage);
  }
}

function readSchedule() {
  const user = getCurrentUser();
  return user && user.id === scheduleUserId ? scheduleCache : [];
}

function replaceCachedClass(updated) {
  scheduleCache = scheduleCache.map((c) => (c.id === updated.id ? updated : c));
}

export async function loadSchedule() {
  const user = getCurrentUser();
  if (!user) return [];
  const res = await fetch(busyTimesUrl());
  const rows = await readJson(res, "Failed to load your classes");
  scheduleCache = rows.map(fromApiBusyTime);
  scheduleUserId = user.id;
  return getSchedule();
}

export function getSchedule() {
  return [...readSchedule()];
}

export async function addScheduleClasses(classes) {
  const res = await fetch(busyTimesUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classes }),
  });
  const rows = await readJson(res, "Failed to add class");
  const added = rows.map(fromApiBusyTime);
  scheduleCache = [...readSchedule(), ...added];
  scheduleUserId = getCurrentUser().id;
  return added;
}

async function patchScheduleClass(id, changes) {
  const res = await fetch(busyTimesUrl(`/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  const updated = fromApiBusyTime(
    await readJson(res, "Failed to update class"),
  );
  replaceCachedClass(updated);
  return updated;
}

export async function deleteScheduleClass(id) {
  const res = await fetch(busyTimesUrl(`/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  await expectOk(res, "Failed to delete class");
  scheduleCache = scheduleCache.filter((c) => c.id !== id);
}

// Updates the base fields of a recurring class (title, dayOfWeek, startTime,
// endTime, venue, firstDate, endDate). Affects every future occurrence that
// hasn't been individually overridden.
export function updateScheduleClass(id, changes) {
  return patchScheduleClass(id, changes);
}

export async function clearSchedule() {
  const res = await fetch(busyTimesUrl(), { method: "DELETE" });
  await expectOk(res, "Failed to clear classes");
  scheduleCache = [];
}

// ---------- exceptions to the recurring schedule ----------
// A single occurrence of a recurring class can be cancelled (e.g. a public
// holiday) or modified (e.g. moved to a different time/venue for one week)
// without touching the recurrence rule itself. Each class carries its own
// list ({ date, type, overrides }), at most one per date, saved with it on
// the server.

export function getScheduleExceptions() {
  return readSchedule().flatMap((c) =>
    c.exceptions.map((e) => ({ classId: c.id, ...e })),
  );
}

function findException(cls, dateStr) {
  return cls.exceptions.find((e) => e.date === dateStr);
}

// Swaps this class's exception for dateStr (if any) for `exception`, or just
// drops it when `exception` is null, and saves the new list.
function setException(classId, dateStr, exception) {
  const cls = readSchedule().find((c) => c.id === classId);
  if (!cls) return Promise.reject(new Error("Class not found"));
  const exceptions = cls.exceptions.filter((e) => e.date !== dateStr);
  if (exception) exceptions.push({ date: dateStr, ...exception });
  return patchScheduleClass(classId, { exceptions });
}

// Cancels a single occurrence of a recurring class on the given date.
export function cancelScheduleOccurrence(classId, dateStr) {
  return setException(classId, dateStr, { type: "cancelled" });
}

// Overrides one or more fields (startTime, endTime, venue, title) for a
// single occurrence, leaving every other occurrence untouched.
export function modifyScheduleOccurrence(classId, dateStr, overrides) {
  return setException(classId, dateStr, { type: "modified", overrides });
}

// Removes any exception for this occurrence, reverting it back to the
// normal recurring class.
export function clearScheduleException(classId, dateStr) {
  return setException(classId, dateStr, null);
}

// getScheduleForDate hides cancelled occurrences entirely, so the calendar
// UI needs a separate lookup to show *something* clickable in their place
// (otherwise a cancelled class silently vanishes with no way to undo it).
export function getCancelledOccurrencesForDate(dateStr) {
  return classesOnDate(dateStr).filter(
    (c) => findException(c, dateStr)?.type === "cancelled",
  );
}

function classesOnDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  return readSchedule().filter(
    (c) =>
      c.dayOfWeek === weekday && dateStr >= c.firstDate && dateStr <= c.endDate,
  );
}

export function getScheduleForDate(dateStr) {
  return classesOnDate(dateStr)
    .map((c) => {
      const exception = findException(c, dateStr);
      if (!exception) return c;
      if (exception.type === "cancelled") return null;
      if (exception.type === "modified") {
        return { ...c, ...exception.overrides, isModifiedOccurrence: true };
      }
      return c;
    })
    .filter(Boolean);
}
