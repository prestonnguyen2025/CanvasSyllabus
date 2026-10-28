// Simple Syllabus pages send their text here when you click "Save to Syllabus Chat".
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "simple-syllabus-capture") return;
  saveCapture(msg).then(sendResponse, (e) => sendResponse({ message: `Couldn't save: ${e.message}` }));
  return true; // respond asynchronously
});

const PENDING_TTL_MS = 30 * 60 * 1000;

async function saveCapture({ title, url, text }) {
  const stored = await chrome.storage.local.get(["courses", "hiddenIds", "pendingSimpleSyllabus"]);
  const { courses = [], hiddenIds = [], pendingSimpleSyllabus } = stored;
  // Courses turned off in Settings never receive captures.
  const candidates = courses.filter((c) => !hiddenIds.includes(c.id));
  const source = { kind: "text", title: `Simple Syllabus: ${title}`, text, url, manual: true, simpleSyllabus: true };

  // Prefer the course whose "Open Simple Syllabus" link was just clicked in the popup.
  let course = null;
  if (pendingSimpleSyllabus && Date.now() - pendingSimpleSyllabus.at < PENDING_TTL_MS) {
    course = candidates.find((c) => c.id === pendingSimpleSyllabus.courseId);
  }
  course ??= matchCourse(candidates, `${title}\n${text}`);

  if (!course) {
    await chrome.storage.local.set({ unassignedCapture: source, lastCaptureAt: Date.now() });
    return { message: "Saved — pick its course in the Syllabus Chat popup" };
  }
  course.sources = [...course.sources.filter((s) => !s.simpleSyllabus), source];
  await chrome.storage.local.set({ courses, pendingSimpleSyllabus: null, lastCaptureAt: Date.now() });
  return { message: `Saved to ${course.code || course.name}` };
}

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Keys that identify a course in syllabus text: subject + number ("C S 314" -> "cs314")
// and any 5-digit unique number in the course name or code.
function courseKeys(course) {
  const keys = [];
  const label = `${course.code || ""} ${course.name}`;
  const m = (course.code || course.name).match(/^([A-Za-z][A-Za-z ]*?)\s*(\d{3}[A-Za-z]?)/);
  if (m) keys.push(squash(m[1] + m[2]));
  for (const u of label.matchAll(/\b\d{5}\b/g)) keys.push(u[0]);
  return keys;
}

// Matches only against the top of the syllabus, where the course is named, so that
// prerequisites mentioned later don't cause a wrong match. Returns a course only if
// exactly one matches.
function matchCourse(courses, text) {
  const header = squash(text.slice(0, 3000));
  const hits = courses.filter((c) => courseKeys(c).some((k) => header.includes(k)));
  return hits.length === 1 ? hits[0] : null;
}
