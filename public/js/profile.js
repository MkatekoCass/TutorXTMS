// Shared by two pages: profile.html (tutor) and student-profile.html
// (student volunteer). Each declares which role it's for via data-page-role,
// the same convention calendar.js uses, so a user of the *other* role gets
// sent back to their own dashboard instead of landing on a page built for
// someone else. The form itself is identical on both pages — only the
// surrounding chrome differs.
import { requireRole } from "./storage.js";
import { highlightActiveTab } from "./nav.js";
import { initProfileTimetable } from "./profile-timetable.js";
import { initTranscriptUpload } from "./transcript-upload.js";

// A comma-separated list covers pages shared between roles (the organiser
// profile also serves the super-organiser account, same as board.html).
const pageRole = (document.body.dataset.pageRole || "tutor").split(",");
const currentUser = requireRole(pageRole);
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();

const form = document.getElementById("profile-form");
const firstNameField = document.getElementById("profile-first-name");
const lastNameField = document.getElementById("profile-last-name");
const emailField = document.getElementById("profile-email");
const studentNumberField = document.getElementById("profile-student-number");
const cellPhoneField = document.getElementById("profile-cell-phone");
const saveBtn = document.getElementById("profile-save-btn");
const errorEl = document.getElementById("profile-error");

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// South African cell numbers, in the shapes people actually write them
// (082 123 4567, +27 82 123 4567, 0027 82 123 4567, ...). Mirrors
// isValidSaCellPhone in server/routes/profile.js so the user gets feedback
// without a round-trip — the server still validates everything on save.
function isValidSaCellPhone(value) {
  let cleaned = value.replace(/[\s().-]/g, "");
  if (cleaned.startsWith("0027")) cleaned = `+27${cleaned.slice(4)}`;
  else if (/^27[6-8][0-9]{8}$/.test(cleaned)) cleaned = `+${cleaned}`;
  return /^(?:\+27|0)[6-8][0-9]{8}$/.test(cleaned);
}

// Mirrors the server's student number rule: five to seven digits, numbers
// only.
const STUDENT_NUMBER_RE = /^\d{5,7}$/;

// The stored profile keeps one full-name string; the form edits it as
// first/last. Split at the FIRST space so multi-word surnames ("Mary Jane
// van der Berg") round-trip exactly, and joining drops the empty half for
// single names.
function splitName(name) {
  const trimmed = (name || "").trim();
  const splitAt = trimmed.indexOf(" ");
  if (splitAt === -1) return [trimmed, ""];
  return [trimmed.slice(0, splitAt), trimmed.slice(splitAt + 1)];
}

function joinName(first, last) {
  return [first, last]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

// The banner identity row (avatar initials, display name, student number)
// mirrors the form and refreshes whenever the saved profile changes.
function renderIdentity(name, studentNumber) {
  const displayEl = document.getElementById("profile-display-name");
  if (displayEl) displayEl.textContent = name || "Your name";

  const initialsEl = document.getElementById("profile-avatar-initials");
  if (initialsEl) {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    const initials =
      parts.length === 0
        ? "?"
        : parts.length === 1
          ? parts[0].slice(0, 2)
          : parts[0][0] + parts[parts.length - 1][0];
    initialsEl.textContent = initials.toUpperCase();
  }

  const studentNoEl = document.getElementById("profile-display-student-number");
  if (studentNoEl) studentNoEl.textContent = studentNumber || "";
}

// The save button starts disabled (see the markup) so a submit can't
// overwrite the stored details with an empty form before the fetch below
// has landed; `loaded` guards the same race on the submit handler itself.
let loaded = false;
let profileBaseline = null;

function currentProfileFormValues() {
  return {
    firstName: firstNameField.value,
    lastName: lastNameField.value,
    studentNumber: studentNumberField.value,
    cellPhone: cellPhoneField.value,
  };
}

function hasUnsavedProfileChanges() {
  if (!profileBaseline) return false;
  const values = currentProfileFormValues();
  return Object.keys(profileBaseline).some(
    (key) => values[key] !== profileBaseline[key],
  );
}

async function loadProfile({ quiet = false } = {}) {
  try {
    const res = await fetch(
      `/api/profile/${encodeURIComponent(currentUser.id)}`,
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Couldn't load your details.");

    const [firstName, lastName] = splitName(body.name);
    firstNameField.value = firstName;
    lastNameField.value = lastName;
    emailField.value = body.email || "";
    studentNumberField.value = body.studentNumber || "";
    cellPhoneField.value = body.cellPhone || "";
    profileBaseline = currentProfileFormValues();
    renderIdentity(body.name, body.studentNumber);

    loaded = true;
    saveBtn.disabled = false;
  } catch (err) {
    if (!quiet) {
      showError(
        `${err.message || "Couldn't load your details right now."} — reload the page to try again.`,
      );
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!loaded) return;

  errorEl.hidden = true;

  // Fail fast on an invalid cell number instead of round-tripping to the
  // server just to be told the same thing.
  if (
    cellPhoneField.value.trim() &&
    !isValidSaCellPhone(cellPhoneField.value)
  ) {
    showError(
      "Enter a valid South African cell phone number, e.g. 082 123 4567 or +27 82 123 4567",
    );
    return;
  }

  const studentNumber = studentNumberField.value.trim();
  if (studentNumber && !STUDENT_NUMBER_RE.test(studentNumber)) {
    showError("Student number must be 5–7 digits.");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    const res = await fetch(
      `/api/profile/${encodeURIComponent(currentUser.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: joinName(firstNameField.value, lastNameField.value),
          studentNumber,
          cellPhone: cellPhoneField.value,
        }),
      },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Couldn't save your details.");

    // Refresh the session's copy and the banner identity so the new name
    // shows straight away.
    currentUser.name = body.name;
    sessionStorage.setItem("user", JSON.stringify(currentUser));
    profileBaseline = currentProfileFormValues();
    renderIdentity(body.name, studentNumberField.value);

    showToast("Your details have been saved.");
  } catch (err) {
    showError(err.message || "Couldn't save your details right now.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save profile";
  }
});

loadProfile();
window.AutoSync?.start(() =>
  hasUnsavedProfileChanges() ? undefined : loadProfile({ quiet: true }),
);
initProfileTimetable(currentUser.id);
// The same transcript the application pages upload — organiser-profile.html
// has no #transcript-panel, so this is a no-op there.
initTranscriptUpload(currentUser.id);

// ---------- guided tour (organiser profile only) ----------
// student-profile.html keeps its bounce link to the volunteer tour; this
// page walks its own two steps off the "?" navbar button instead. Onboarding
// is optional-chained because student-profile.html never loads onboarding.js.
if (window.location.pathname.includes("organiser-profile")) {
  const PROFILE_TOUR_STEPS = [
    {
      selector: ".profile-card",
      title: "Your details",
      body: "Your name and contact details on record with CSAM.",
      placement: "bottom",
    },
    {
      selector: "#profile-form",
      title: "Keep them current",
      body: "Update your name and cell number any time. Your email is tied to your login — ask another organiser if it needs changing.",
      placement: "top",
    },
  ];

  const tourLinkEl = document.getElementById("tour-link");
  if (tourLinkEl) {
    tourLinkEl.addEventListener("click", (e) => {
      e.preventDefault();
      window.Onboarding?.start(PROFILE_TOUR_STEPS, {
        tourId: "organiser-profile",
        userId: currentUser?.id || "anon",
        force: true,
      });
    });
  }
}
