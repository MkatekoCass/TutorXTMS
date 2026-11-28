const API_URL = "";

/*
 * Writes a status message into one of the #*-message elements and
 * toggles the state class that colours it (see auth-global.css).
 * kind: "error" | "success" | undefined for a neutral note.
 */
function setMessage(element, text, kind) {
  element.textContent = text;

  element.classList.toggle("is-error", kind === "error");

  element.classList.toggle("is-success", kind === "success");
}

/* =========================
   STUDENT NUMBER FIELD
   ========================= */

// Five to seven digits, numbers only — the server enforces the same rule.
const STUDENT_NUMBER_RE = /^\d{5,7}$/;

const roleSelect = document.getElementById("role");

const studentNumberGroup = document.getElementById("student-number-group");

const studentNumberInput = document.getElementById("student-number");

// Organiser-only course dropdown (register.html only — null elsewhere).
const courseGroup = document.getElementById("course-group");

const courseSelect = document.getElementById("course");

const googleRegisterButton = document.getElementById("google-register-button");

if (googleRegisterButton) {
  googleRegisterButton.addEventListener("click", async () => {
    try {
      window.location.href = "/api/auth/google";
    } catch (error) {
      console.error("Google registration error:", error);
    }
  });
}

if (roleSelect) {
  roleSelect.addEventListener("change", () => {
    if (roleSelect.value === "volunteer" || roleSelect.value === "tutor") {
      // Show student number field
      studentNumberGroup.style.display = "block";

      // Make student number required
      studentNumberInput.required = true;
    } else {
      // Hide student number field
      studentNumberGroup.style.display = "none";

      // Clear student number
      studentNumberInput.value = "";

      // No longer required
      studentNumberInput.required = false;
    }

    /* -------------------------
           Organiser course choice

           Shown only for organisers — the list is
           fetched from the course register on first
           use, so the other roles never pay for it.
           ------------------------- */

    if (courseGroup && courseSelect) {
      if (roleSelect.value === "organiser") {
        courseGroup.style.display = "block";

        courseSelect.required = true;

        loadCoursesOnce();
      } else {
        courseGroup.style.display = "none";

        courseSelect.required = false;

        courseSelect.value = "";
      }
    }
  });
}

/* =========================
   ORGANISER COURSES
   ========================= */

// Fetched at most once, however often the role is switched back and forth.
// A failed load resets the flag so picking "organiser" again retries.
let coursesRequested = false;

async function loadCoursesOnce({ refresh = false } = {}) {
  if (coursesRequested && !refresh) return;

  coursesRequested = true;

  const selectedCourseId = refresh ? courseSelect?.value : "";

  const message = document.getElementById("register-message");

  try {
    const response = await fetch(`${API_URL}/api/courses`);

    const rows = await response.json();

    if (!response.ok) {
      throw new Error(rows.error || "Failed to load courses");
    }

    if (refresh && courseSelect) {
      courseSelect
        .querySelectorAll('option:not([value=""])')
        .forEach((option) => option.remove());
    }
    rows.forEach((row) => {
      const option = document.createElement("option");

      option.value = row.id;

      option.textContent = `${row.course_code} — ${row.course_name}`;

      courseSelect.appendChild(option);
    });
    if (
      selectedCourseId &&
      rows.some((row) => String(row.id) === selectedCourseId)
    ) {
      courseSelect.value = selectedCourseId;
    }
  } catch (error) {
    console.error("Course load error:", error);

    coursesRequested = false;

    if (message) {
      setMessage(
        message,
        "Couldn't load the course list — please try again.",
        "error",
      );
    }
  }
}

window.AutoSync?.start(() => {
  if (roleSelect?.value === "organiser" && courseSelect) {
    return loadCoursesOnce({ refresh: true });
  }
});

/* =========================
   FORGOT PASSWORD
   ========================= */

// The prototype shows a "Forgot password?" link but the app has no
// self-service reset — point users at their course administrator
// instead (shown in the login card's message area).
const forgotPasswordLink = document.getElementById("forgot-password-link");

if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener("click", (event) => {
    event.preventDefault();

    const message = document.getElementById("login-message");

    if (message) {
      setMessage(
        message,
        "Please contact your course administrator to reset your password.",
        "error",
      );
    }
  });
}

/* =========================
   REGISTER
   ========================= */

const registerForm = document.getElementById("register-form");

if (registerForm) {
  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = document.getElementById("name").value.trim();

    const email = document.getElementById("email").value.trim();

    const password = document.getElementById("password").value;

    const confirmPassword = document.getElementById("confirm-password").value;

    const role = document.getElementById("role").value;

    const studentNumber = document
      .getElementById("student-number")
      .value.trim();

    const courseId = courseSelect ? courseSelect.value : "";

    const message = document.getElementById("register-message");

    /* -------------------------
           Check passwords
           ------------------------- */

    if (password !== confirmPassword) {
      setMessage(message, "Passwords do not match.", "error");

      return;
    }

    /* -------------------------
           Check student number
           ------------------------- */

    if ((role === "volunteer" || role === "tutor") && !studentNumber) {
      setMessage(
        message,
        "Student number is required for volunteers and tutors.",
        "error",
      );

      return;
    }

    if (
      (role === "volunteer" || role === "tutor") &&
      !STUDENT_NUMBER_RE.test(studentNumber)
    ) {
      setMessage(message, "Student number must be 5–7 digits.", "error");

      return;
    }

    /* -------------------------
           Check organiser course
           ------------------------- */

    if (role === "organiser" && !courseId) {
      setMessage(message, "Choose the course you want to organise.", "error");

      return;
    }

    setMessage(message, "Creating your account...");

    try {
      const response = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          name,
          email,
          password,
          role,
          studentNumber,
          courseId: role === "organiser" ? Number(courseId) : undefined,
        }),
      });

      const data = await response.json();

      /* -------------------------
               Handle registration error
               ------------------------- */

      if (!response.ok) {
        setMessage(message, data.error || "Registration failed.", "error");

        return;
      }

      /* -------------------------
               Registration successful

               Organisers can't sign in until the
               super-organiser approves their course
               request, so say so instead of promising
               an immediate login.
               ------------------------- */

      setMessage(
        message,

        role === "organiser"
          ? "Registration successful! Your organiser request is awaiting approval — you can sign in once it's approved."
          : "Registration successful! Redirecting to login...",

        "success",
      );

      setTimeout(() => {
        window.location.href = "login.html";
      }, 1500);
    } catch (error) {
      console.error("Registration error:", error);

      setMessage(message, "Unable to connect to the server.", "error");
    }
  });
}

/* =========================
   LOGIN
   ========================= */

const loginForm = document.getElementById("login-form");

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("email").value.trim();

    const password = document.getElementById("password").value;

    const message = document.getElementById("login-message");

    setMessage(message, "Logging in...");

    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          email,
          password,
        }),
      });

      const data = await response.json();

      /* -------------------------
               Handle login error
               ------------------------- */

      if (!response.ok) {
        setMessage(message, data.error || "Login failed.", "error");

        return;
      }

      /* -------------------------
               Login successful
               ------------------------- */

      setMessage(message, "Login successful!", "success");

      /*
       * Store the Supabase access token
       * temporarily.
       */

      sessionStorage.setItem("access_token", data.session.access_token);

      /*
       * Store the logged-in user's
       * information.
       */

      sessionStorage.setItem("user", JSON.stringify(data.user));

      /* -------------------------
               Redirect based on role
               ------------------------- */

      setTimeout(() => {
        switch (data.user.role) {
          // Legacy accounts created before the Volunteer rename.
          case "student":
          case "volunteer":
            window.location.href = "StudentView.html";
            break;

          case "tutor":
            window.location.href = "dashboard.html";
            break;

          case "educator":
            window.location.href = "educator.html";
            break;

          case "organiser":
          case "super_organiser":
            window.location.href = "board.html";
            break;

          default:
            window.location.href = "index.html";
            break;
        }
      }, 1000);
    } catch (error) {
      console.error("Login error:", error);

      setMessage(message, "Unable to connect to the server.", "error");
    }
  });
}

/* =========================
   GOOGLE SIGN-IN FAILURE
   ========================= */

// google-callback.html sends a failed Google sign-in back here with the
// reason in ?authError=, so show it in the login card and then drop the
// param (replaceState, no reload) — refreshing shouldn't repeat a message
// that belongs to a sign-in attempt that's already over.
const loginMessage = document.getElementById("login-message");

if (loginMessage) {
  const loginParams = new URLSearchParams(window.location.search);

  const authError = loginParams.get("authError");

  if (authError) {
    setMessage(loginMessage, authError, "error");

    loginParams.delete("authError");

    const query = loginParams.toString();

    history.replaceState(
      null,
      "",
      window.location.pathname + (query ? `?${query}` : ""),
    );
  }
}
