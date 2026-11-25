const {
  GRACE_MINUTES,
  sessionClock,
  isWithinLoggingWindow,
} = require("./loggingWindow");

// South African wall-clock time on 2026-09-24 as a real instant (SAST is
// UTC+2 with no daylight saving), so the tests mean the same thing whatever
// time zone the machine running them is in.
const at = (hours, minutes) =>
  new Date(Date.UTC(2026, 8, 24, hours - 2, minutes));

// The window rule is the feature here, so the clock is pinned with fixed
// Date values instead of the real one. 2026-09-24 is just some Thursday —
// only the hour/minute parts matter for the rule.
describe("isWithinLoggingWindow", () => {
  const DATE = "2026-09-24";

  test("the grace period is ten minutes after the session ends", () => {
    expect(GRACE_MINUTES).toBe(10);
  });

  test("allows logging exactly at the session's start", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(14, 0))).toBe(true);
  });

  test("allows logging while the session is running", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(14, 15))).toBe(
      true,
    );
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(16, 59))).toBe(
      true,
    );
  });

  test("allows logging exactly at the end plus the grace period", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(17, 10))).toBe(
      true,
    );
  });

  test("rejects a minute after the grace period", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(17, 11))).toBe(
      false,
    );
  });

  test("rejects any time before the session starts", () => {
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", at(13, 59))).toBe(
      false,
    );
  });

  test("rejects the right clock time on any other day", () => {
    expect(
      isWithinLoggingWindow("2026-09-23", "14:00", "17:00", at(14, 30)),
    ).toBe(false);
    expect(
      isWithinLoggingWindow("2026-09-25", "14:00", "17:00", at(14, 30)),
    ).toBe(false);
  });

  test("handles times stored as HH:MM:SS", () => {
    expect(isWithinLoggingWindow(DATE, "14:00:00", "17:00:00", at(17, 5))).toBe(
      true,
    );
    expect(
      isWithinLoggingWindow(DATE, "14:00:00", "17:00:00", at(17, 11)),
    ).toBe(false);
  });

  // Production runs on Cloudflare Workers, whose clock is UTC — two hours
  // behind the South African times sessions are stored in.
  test("opens at the South African start time, not the UTC one", () => {
    const sastTwoPm = new Date("2026-09-24T12:00:00Z");
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", sastTwoPm)).toBe(true);
  });

  test("closes at the South African end time, not the UTC one", () => {
    const sastSevenPm = new Date("2026-09-24T17:00:00Z");
    expect(isWithinLoggingWindow(DATE, "14:00", "17:00", sastSevenPm)).toBe(
      false,
    );
  });

  test("uses the South African date just after midnight", () => {
    // 00:30 SAST on the 25th is still 22:30 on the 24th in UTC.
    const justAfterMidnight = new Date("2026-09-24T22:30:00Z");
    expect(
      isWithinLoggingWindow("2026-09-25", "00:00", "01:00", justAfterMidnight),
    ).toBe(true);
    expect(
      isWithinLoggingWindow(DATE, "00:00", "01:00", justAfterMidnight),
    ).toBe(false);
  });
});

describe("sessionClock", () => {
  test("reads the date and time in South African time", () => {
    expect(sessionClock(new Date("2026-09-24T22:30:00Z"))).toEqual({
      date: "2026-09-25",
      minutes: 30,
    });
    expect(sessionClock(at(14, 5))).toEqual({
      date: "2026-09-24",
      minutes: 14 * 60 + 5,
    });
  });
});
