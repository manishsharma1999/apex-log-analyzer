// Light/dark toggle — presentation only, independent of app.js.
// Externalized from app.html so the page can ship a strict CSP (no inline
// scripts). Loaded at end of <body>, after the toggle button exists.
(function () {
  var btn = document.getElementById("themeToggle");
  if (!btn) return;
  function sync() {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    btn.textContent = light ? "☀️" : "🌙";
    btn.title = light ? "Switch to dark theme" : "Switch to light theme";
  }
  btn.addEventListener("click", function () {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    if (light) {
      document.documentElement.removeAttribute("data-theme");
      try { localStorage.setItem("ala-theme", "dark"); } catch (e) {}
    } else {
      document.documentElement.setAttribute("data-theme", "light");
      try { localStorage.setItem("ala-theme", "light"); } catch (e) {}
    }
    sync();
  });
  sync();
})();
