// Fills the navbar's user pill (#user-name / #user-role-badge) from whoever
// is signed in. Plain script (like notifications.js and logout.js) so every
// redesigned app page includes it with a simple <script src> tag.
(function initUserBadge() {
  const nameEl = document.getElementById("user-name");
  const roleEl = document.getElementById("user-role-badge");
  if (!nameEl && !roleEl) return;

  let user = null;
  try {
    user = JSON.parse(sessionStorage.getItem("user") || "null");
  } catch {
    user = null;
  }
  if (!user) return;

  if (nameEl) nameEl.textContent = user.name || "Account";

  const role = String(user.role || "").toLowerCase();

  if (roleEl) {
    // Accounts created before the Volunteer rename were stored with role
    // "student" — show them as volunteers here too.
    let label = role === "student" ? "volunteer" : role;
    // The admin role's technical name reads poorly in a badge, and its
    // full title is too wide for the crowded navbar — "Super" keeps it
    // recognisable at a glance.
    if (label === "super_organiser") label = "Super";
    roleEl.textContent = label
      ? label.charAt(0).toUpperCase() + label.slice(1)
      : "Member";
  }

  // Nav links reserved for the super-organiser are rendered hidden and
  // revealed here (e.g. the Organiser Requests tab).
  if (role === "super_organiser") {
    document.querySelectorAll("[data-super-only]").forEach((el) => {
      el.hidden = false;
    });
  }

  window.AutoSync?.start(async () => {
    const response = await fetch(
      `/api/profile/${encodeURIComponent(user.id)}`,
    );
    if (!response.ok) return;
    const profile = await response.json();
    if (!profile.name || profile.name === user.name) return;

    user.name = profile.name;
    sessionStorage.setItem("user", JSON.stringify(user));
    if (nameEl) nameEl.textContent = user.name;
  });
})();
