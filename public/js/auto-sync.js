// Lightweight cross-user refresh coordinator. Pages register the data reload
// that updates their own view; the coordinator only runs it while the tab is
// visible and the user isn't typing into a field or working in a dialog.
(function installAutoSync(window, document) {
  if (window.AutoSync) return;

  const DEFAULT_INTERVAL_MS = 15000;
  let focusedEditor = false;
  let recentlyInteractedAt = 0;

  document.addEventListener("focusin", (event) => {
    const target = event.target;
    focusedEditor = Boolean(
      target?.matches?.("input, textarea, select, [contenteditable='true']"),
    );
  });

  document.addEventListener("focusout", () => {
    // Wait until focus has actually moved before allowing a refresh.
    window.setTimeout(() => {
      focusedEditor = Boolean(
        document.activeElement?.matches?.(
          "input, textarea, select, [contenteditable='true']",
        ),
      );
    }, 0);
  });

  ["pointerdown", "keydown", "input", "change"].forEach((type) => {
    document.addEventListener(
      type,
      (event) => {
        recentlyInteractedAt = Date.now();
      },
      true,
    );
  });

  function isSafeToRefresh() {
    return (
      !document.hidden &&
      !focusedEditor &&
      Date.now() - recentlyInteractedAt > 1200 &&
      !document.querySelector(
        "dialog[open], [role='dialog']:not([hidden]), [aria-modal='true']:not([hidden]), .modal.is-open, .modal.open",
      )
    );
  }

  window.AutoSync = {
    start(refresh, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
      if (typeof refresh !== "function") return () => {};
      let inFlight = false;

      const run = async () => {
        if (inFlight || !isSafeToRefresh()) return;
        inFlight = true;
        try {
          await refresh();
        } catch {
          // Keep the current view if the network is temporarily unavailable.
        } finally {
          inFlight = false;
        }
      };

      const timer = window.setInterval(run, intervalMs);
      const onVisibility = () => {
        if (!document.hidden) run();
      };
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pageshow", onVisibility);

      return () => {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pageshow", onVisibility);
      };
    },
  };
})(window, document);
