// The transcript upload section shared by the tutor application page
// (modules.html) and the volunteer dashboard (StudentView.html). An
// application isn't accepted until a transcript is on file — organisers
// review it from the course boards — so this panel is where an applicant
// uploads or replaces theirs, and where they can re-open what's on record.
// The file goes to the server as a raw body (not multipart); see
// server/routes/transcripts.js.

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

const ALLOWED_TRANSCRIPT_TYPES = ["application/pdf", "image/png", "image/jpeg"];

function megabytesOf(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// One transcript per user, shared by every page that shows this panel (the
// profile pages included), so one uploaded anywhere reads as on file here.
function describeOnFile(updatedAt) {
  const date = updatedAt ? new Date(updatedAt) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "Transcript on file — you're ready to apply.";
  }
  return `Transcript on file (uploaded ${date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}) — you're ready to apply.`;
}

export async function initTranscriptUpload(userId) {
  const panel = document.getElementById("transcript-panel");
  if (!panel || !userId) return;

  const statusEl = document.getElementById("transcript-status");
  const inputEl = document.getElementById("transcript-input");
  const uploadBtn = document.getElementById("transcript-upload-btn");
  const viewBtn = document.getElementById("transcript-view-btn");
  const errorEl = document.getElementById("transcript-error");

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function renderState(uploaded, updatedAt) {
    errorEl.hidden = true;
    if (uploaded) {
      statusEl.textContent = describeOnFile(updatedAt);
      statusEl.classList.add("transcript-status--ok");
      viewBtn.hidden = false;
      uploadBtn.textContent = "Replace transcript";
    } else {
      statusEl.textContent =
        "No transcript uploaded yet — you need one before you can apply.";
      statusEl.classList.remove("transcript-status--ok");
      viewBtn.hidden = true;
      uploadBtn.textContent = "Upload transcript";
    }
  }

  async function loadStatus() {
    try {
      const res = await fetch(`/api/transcripts/${encodeURIComponent(userId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // e.g. the storage bucket isn't created yet — the server's message
        // explains what's wrong, so show that rather than a generic one.
        statusEl.textContent =
          body.error || "Couldn't check your transcript right now.";
        return;
      }
      renderState(body.uploaded, body.updatedAt);
    } catch {
      statusEl.textContent =
        "Network error — couldn't check your transcript right now.";
    }
  }

  async function uploadFile(file) {
    const previousStatus = statusEl.textContent;
    errorEl.hidden = true;
    uploadBtn.disabled = true;
    statusEl.textContent = `Uploading ${file.name}\u2026`;

    try {
      const res = await fetch(
        `/api/transcripts/${encodeURIComponent(userId)}`,
        {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        },
      );
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
      uploadBtn.disabled = false;
      // Reset so picking the same file again still fires a change event.
      inputEl.value = "";
    }
  }

  uploadBtn.addEventListener("click", () => inputEl.click());

  inputEl.addEventListener("change", () => {
    const file = inputEl.files?.[0];
    if (!file) return;

    // Checked again on the server — this is just faster feedback.
    if (!ALLOWED_TRANSCRIPT_TYPES.includes(file.type)) {
      showError("Transcripts must be a PDF, PNG, or JPEG.");
      inputEl.value = "";
      return;
    }
    if (file.size > MAX_TRANSCRIPT_BYTES) {
      showError(
        `That file is too large — transcripts can be at most ${megabytesOf(MAX_TRANSCRIPT_BYTES)}.`,
      );
      inputEl.value = "";
      return;
    }

    uploadFile(file);
  });

  viewBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    try {
      const res = await fetch(
        `/api/transcripts/${encodeURIComponent(userId)}/signed-url`,
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(body.error || "Couldn't open your transcript right now.");
        return;
      }
      window.open(body.url, "_blank", "noopener");
    } catch {
      showError("Network error — couldn't reach the server.");
    }
  });

  await loadStatus();
  window.AutoSync?.start(loadStatus);
}
