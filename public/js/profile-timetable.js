// The "My timetable" card on both profile pages (profile.html and
// student-profile.html): the user keeps a copy of their class-timetable PDF
// on file, re-opens it, replaces it, or removes it. Storage only — importing
// the classes into the calendar still happens on the calendar page. The file
// goes to the server as a raw body (not multipart); see
// server/routes/profileTimetable.js.

const MAX_TIMETABLE_BYTES = 5 * 1024 * 1024;

const NOT_UPLOADED_MESSAGE =
  "You haven't uploaded a timetable yet — upload your class timetable PDF to keep it on your profile.";

function megabytesOf(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function describeUpload(updatedAt) {
  const date = updatedAt ? new Date(updatedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return "Timetable on file";
  return `Timetable on file — uploaded ${date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

export async function initProfileTimetable(userId) {
  const panel = document.getElementById("profile-timetable");
  if (!panel || !userId) return;

  const statusEl = document.getElementById("profile-timetable-status");
  const inputEl = document.getElementById("profile-timetable-input");
  const uploadBtn = document.getElementById("profile-timetable-upload-btn");
  const viewBtn = document.getElementById("profile-timetable-view-btn");
  const removeBtn = document.getElementById("profile-timetable-remove-btn");
  const errorEl = document.getElementById("profile-timetable-error");

  const baseUrl = `/api/profile/${encodeURIComponent(userId)}/timetable`;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function renderState(uploaded, updatedAt) {
    errorEl.hidden = true;
    if (uploaded) {
      statusEl.textContent = describeUpload(updatedAt);
      statusEl.classList.add("transcript-status--ok");
      viewBtn.hidden = false;
      removeBtn.hidden = false;
      uploadBtn.textContent = "Replace timetable";
    } else {
      statusEl.textContent = NOT_UPLOADED_MESSAGE;
      statusEl.classList.remove("transcript-status--ok");
      viewBtn.hidden = true;
      removeBtn.hidden = true;
      uploadBtn.textContent = "Upload timetable";
    }
  }

  function setBusy(busy) {
    uploadBtn.disabled = busy;
    viewBtn.disabled = busy;
    removeBtn.disabled = busy;
  }

  async function loadStatus() {
    try {
      const res = await fetch(baseUrl);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        statusEl.textContent =
          body.error || "Couldn't check your timetable right now.";
        return;
      }
      renderState(body.uploaded, body.updatedAt);
    } catch {
      statusEl.textContent =
        "Network error — couldn't check your timetable right now.";
    }
  }

  async function uploadFile(file) {
    const previousStatus = statusEl.textContent;
    errorEl.hidden = true;
    setBusy(true);
    statusEl.textContent = `Uploading ${file.name}…`;

    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        statusEl.textContent = previousStatus;
        showError(body.error || "Couldn't upload that file — try again.");
        return;
      }
      renderState(true, body.updatedAt);
    } catch {
      statusEl.textContent = previousStatus;
      showError("Network error — couldn't reach the server.");
    } finally {
      setBusy(false);
      // Reset so picking the same file again still fires a change event.
      inputEl.value = "";
    }
  }

  uploadBtn.addEventListener("click", () => inputEl.click());

  inputEl.addEventListener("change", () => {
    const file = inputEl.files?.[0];
    if (!file) return;

    // Checked again on the server — this is just faster feedback.
    if (file.type !== "application/pdf") {
      showError("Your timetable must be a PDF.");
      inputEl.value = "";
      return;
    }
    if (file.size > MAX_TIMETABLE_BYTES) {
      showError(
        `That file is too large — timetables can be at most ${megabytesOf(MAX_TIMETABLE_BYTES)}.`,
      );
      inputEl.value = "";
      return;
    }

    uploadFile(file);
  });

  viewBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    try {
      const res = await fetch(`${baseUrl}/signed-url`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(body.error || "Couldn't open your timetable right now.");
        return;
      }
      window.open(body.url, "_blank", "noopener");
    } catch {
      showError("Network error — couldn't reach the server.");
    }
  });

  removeBtn.addEventListener("click", async () => {
    if (!window.confirm("Remove the timetable saved on your profile?")) return;
    errorEl.hidden = true;
    setBusy(true);
    try {
      const res = await fetch(baseUrl, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(body.error || "Couldn't remove your timetable right now.");
        return;
      }
      renderState(false);
    } catch {
      showError("Network error — couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  });

  await loadStatus();
  window.AutoSync?.start(loadStatus);
}
