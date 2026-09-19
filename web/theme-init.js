// Apply the saved color theme before first paint to avoid a flash.
// Externalized from app.html so the page can ship a strict CSP (no inline
// scripts). Must stay a blocking <script> in <head> so it runs pre-paint.
(function () {
  try {
    var saved = localStorage.getItem("ala-theme");
    var theme = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  } catch (e) {}
})();
