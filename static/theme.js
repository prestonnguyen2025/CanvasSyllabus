// Applies the light/dark choice from Settings before the page first paints, so
// it never flashes the wrong theme. The setting lives in chrome.storage (which
// can't be read synchronously); src/theme.js keeps this localStorage copy.
try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Storage unavailable; the page follows the system theme until settings load.
}
