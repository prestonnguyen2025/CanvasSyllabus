// Check the cooldown on opening; it keeps running even while the popup is closed.
// localStorage makes this decision synchronous, so skipped openings show the UI
// immediately without flashing an intro or waiting for chat/storage initialization.
const INTRO_CLIPS = [
  { src: "media/popup-intro.mp4", durationMs: 1300 },
  { src: "media/popup-intro-trail.mp4", durationMs: 2000 },
];
const INTRO_COOLDOWN_MS = 10 * 60 * 1000;
const LAST_PLAYED_KEY = "popupIntroLastPlayedAt";

function introIsDue() {
  try {
    const lastPlayed = Number(localStorage.getItem(LAST_PLAYED_KEY));
    const now = Date.now();
    return !Number.isFinite(lastPlayed) || lastPlayed <= 0 ||
      lastPlayed > now || now - lastPlayed >= INTRO_COOLDOWN_MS;
  } catch {
    // If the cooldown cannot be checked, open the interface directly.
    return false;
  }
}

if (introIsDue()) playIntro();

function playIntro() {
  // Uniform selection: each listed clip has the same chance on every opening.
  const clip = INTRO_CLIPS[Math.floor(Math.random() * INTRO_CLIPS.length)];
  const intro = document.getElementById("popup-intro");
  const video = document.getElementById("popup-intro-video");
  const ui = document.getElementById("popup-interface");
  let finished = false;
  let playbackTimer;
  let cleanupTimer;

  function cleanUpIntro() {
    clearTimeout(cleanupTimer);
    intro.hidden = true;
    video.pause();
  }

  function revealInterface() {
    if (finished) return;
    finished = true;
    clearTimeout(startupTimer);
    clearTimeout(playbackTimer);
    ui.inert = false;
    ui.removeAttribute("aria-hidden");
    document.body.classList.remove("intro-playing");
    intro.setAttribute("aria-hidden", "true");
    intro.classList.add("is-leaving");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cleanUpIntro();
    } else {
      intro.addEventListener("transitionend", cleanUpIntro, { once: true });
      cleanupTimer = setTimeout(cleanUpIntro, 400);
    }
  }

  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  ui.inert = true;
  ui.setAttribute("aria-hidden", "true");
  intro.hidden = false;
  document.body.classList.add("intro-playing");

  // A missing file, rejected autoplay, or a stalled decoder must never block chat.
  const startupTimer = setTimeout(revealInterface, 3000);
  video.addEventListener("error", revealInterface, { once: true });
  video.addEventListener("ended", revealInterface, { once: true });
  video.addEventListener("playing", () => {
    if (finished) {
      video.pause();
      return;
    }
    // Start the cooldown only once playback actually begins. Reopening during
    // the cooldown does not move the timestamp or restart the ten-minute wait.
    try {
      localStorage.setItem(LAST_PLAYED_KEY, String(Date.now()));
    } catch {
      // Storage may be unavailable; the popup itself remains usable.
    }
    clearTimeout(startupTimer);
    intro.classList.add("is-playing");
    playbackTimer = setTimeout(revealInterface, clip.durationMs);
  }, { once: true });
  video.src = clip.src;
  video.play().catch(revealInterface);

  window.addEventListener("pagehide", () => {
    clearTimeout(startupTimer);
    clearTimeout(playbackTimer);
    clearTimeout(cleanupTimer);
    video.pause();
  }, { once: true });
}
