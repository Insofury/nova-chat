// Runs before first paint so the saved theme is applied without a flash.
(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem("novachat:prefs") || "{}");
    if (prefs.theme === "light" || prefs.theme === "dark") {
      document.documentElement.setAttribute("data-theme", prefs.theme);
    }
  } catch (e) {
    /* storage unavailable - fall back to the system theme */
  }
})();
