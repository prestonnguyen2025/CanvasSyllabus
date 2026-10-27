// "system" follows the computer's light/dark setting; "light" and "dark" override it.
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    localStorage.setItem("theme", theme); // read by static/theme.js on the next load
  } catch {
    // Without the copy the next load may briefly show the system theme.
  }
}
