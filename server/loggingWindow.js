// A session can only be logged while it's happening: from its scheduled
// start until GRACE_MINUTES after its scheduled end. Enforced server-side
// here and mirrored client-side in public/js/sessionTiming.js so the Log
// Hours pages can show the same rule — the server always re-checks.

const GRACE_MINUTES = 10;

// Session dates and times are stored as South African wall-clock values.
// The server's own clock can't be trusted for that — Cloudflare Workers run
// in UTC — so "now" is always read in this zone explicitly.
const SESSION_TIME_ZONE = "Africa/Johannesburg";

const sessionClockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: SESSION_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function sliceTime(value) {
  return value == null ? "" : String(value).slice(0, 5);
}

function minutesOf(value) {
  const [hours, minutes] = sliceTime(value).split(":").map(Number);
  return hours * 60 + minutes;
}

// The session-zone calendar date ("YYYY-MM-DD") and minutes since midnight
// for an instant, whatever time zone the server itself runs in.
function sessionClock(now = new Date()) {
  const parts = {};
  for (const { type, value } of sessionClockFormat.formatToParts(now)) {
    parts[type] = value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// True only while "now" (South African time) sits inside the session's
// window on the session's own date — never before its start, and never
// later than the grace period after its end.
function isWithinLoggingWindow(date, startTime, endTime, now = new Date()) {
  const clock = sessionClock(now);
  if (String(date) !== clock.date) return false;
  return (
    clock.minutes >= minutesOf(startTime) &&
    clock.minutes <= minutesOf(endTime) + GRACE_MINUTES
  );
}

module.exports = {
  GRACE_MINUTES,
  SESSION_TIME_ZONE,
  sessionClock,
  isWithinLoggingWindow,
};
