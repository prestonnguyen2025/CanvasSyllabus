// Everything lives in chrome.storage.local on this computer only.

const DEFAULTS = {
  canvasUrl: "https://utexas.instructure.com",
  apiKey: "", // Anthropic key
  claudeModel: "claude-haiku-5-5",
  theme: "system", // "system", "light" or "dark"
  courses: [],
  selectedIds: null, // null = all courses selected
  hiddenIds: [], // courses turned off in Settings: not shown, synced, scanned or chatted about
  syncedAt: null,
  unassignedCapture: null, // a Simple Syllabus page not yet matched to a course
  exams: {}, // course id -> { exams, at, error? } found by the full site's calendar
  manualExams: [], // [{ id, courseId, name, kind, date, ... }] added by hand; kept across re-scans
  gradeCourseId: null, // course last opened in the Grade Calculator
  gradeWhatIfs: {}, // course id -> { overrides, hypotheticals } from the Grade Calculator
  gradeSyllabus: {}, // course id -> { found, components, fingerprint, at } the Grade Calculator read from the syllabus
};

// Settings left over from the removed Gemini provider (including its API key) and
// from the button-based syllabus weights that gradeSyllabus replaced.
const REMOVED_KEYS = ["provider", "geminiKey", "gradeSyllabusWeights"];

// Identifies this page's writes, so the side panel and the full site can tell
// their own changes apart from each other's.
const PAGE_ID = crypto.randomUUID();

export async function load() {
  await chrome.storage.local.remove(REMOVED_KEYS);
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

export async function save(values) {
  await chrome.storage.local.set({ ...values, lastWriter: PAGE_ID });
}

// Calls back when another page (or the background worker) changes saved data.
export function onExternalChange(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || changes.lastWriter?.newValue === PAGE_ID) return;
    callback(changes);
  });
}

export function visibleCourses(state) {
  return state.courses.filter((c) => !state.hiddenIds.includes(c.id));
}

export function selectedCourses(state) {
  return visibleCourses(state).filter((c) => state.selectedIds === null || state.selectedIds.includes(c.id));
}

// Turns a course off (or back on) everywhere. Its exams are dropped; its syllabus
// is skipped from the next sync, so turning it back on needs a sync to reload it.
export async function setCourseHidden(state, id, hidden) {
  const ids = new Set(state.hiddenIds);
  hidden ? ids.add(id) : ids.delete(id);
  state.hiddenIds = [...ids];
  if (hidden) delete state.exams[id];
  await save({ hiddenIds: state.hiddenIds, exams: state.exams });
}

// Ticks or unticks a course for the chat and saves the choice.
export async function setCourseSelected(state, id, selected) {
  const ids = new Set(state.selectedIds ?? state.courses.map((c) => c.id));
  selected ? ids.add(id) : ids.delete(id);
  state.selectedIds = [...ids];
  await save({ selectedIds: state.selectedIds });
}
