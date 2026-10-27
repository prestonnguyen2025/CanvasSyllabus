import { CanvasClient, arrayBufferToBase64 } from "./canvas.js";
import * as storage from "./storage.js";

// Schools on a custom domain (e.g. canvas.school.edu) need an extra permission grant.
// Call this before any other await in a click handler: Chrome only shows the
// permission prompt in response to a user gesture.
export async function ensureHostPermission(origin) {
  if (new URL(origin).hostname.endsWith(".instructure.com")) return true;
  const origins = [`${origin}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

// Re-reads every favorited course from Canvas and saves the result into state.
// Files the user added by hand are kept.
export async function syncFromCanvas(state, onStatus) {
  if (!(await ensureHostPermission(state.canvasUrl))) throw new Error("Permission to access Canvas was denied.");
  const client = new CanvasClient(state.canvasUrl);
  onStatus("Loading courses…");
  const raw = await client.listCourses();
  const previous = new Map(state.courses.map((c) => [c.id, c]));
  const courses = [];
  for (const [i, c] of raw.entries()) {
    const hidden = state.hiddenIds.includes(String(c.id));
    onStatus(`(${i + 1}/${raw.length}) ${c.name}`);
    // Hidden courses are listed (so Settings can turn them back on) but not read.
    const { sources, notes, simpleSyllabusUrl } = hidden
      ? { sources: [], notes: [], simpleSyllabusUrl: null }
      : await client.collectSyllabus(c, (msg) => onStatus(`(${i + 1}/${raw.length}) ${msg}`));
    const manual = previous.get(String(c.id))?.sources.filter((s) => s.manual) ?? [];
    courses.push({
      id: String(c.id),
      name: c.name,
      code: c.course_code,
      term: c.term?.name && c.term.name !== "Default Term" ? c.term.name : "",
      sources: [...sources, ...manual],
      notes,
      simpleSyllabusUrl,
    });
  }
  state.courses = courses;
  state.syncedAt = Date.now();
  if (state.selectedIds) state.selectedIds = state.selectedIds.filter((id) => courses.some((c) => c.id === id));
  await storage.save({ courses, syncedAt: state.syncedAt, selectedIds: state.selectedIds });
  return courses;
}

// Lets the background match the next Simple Syllabus capture to this course.
export async function openSimpleSyllabus(course) {
  await storage.save({ pendingSimpleSyllabus: { courseId: course.id, at: Date.now() } });
  chrome.tabs.create({ url: course.simpleSyllabusUrl });
}

// Adds a PDF or text file the user picked as a syllabus source for a course.
export async function addSyllabusFile(state, course, file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  course.sources.push(
    isPdf
      ? { kind: "pdf", title: `File: ${file.name}`, data: arrayBufferToBase64(await file.arrayBuffer()), manual: true }
      : { kind: "text", title: `File: ${file.name}`, text: await file.text(), manual: true }
  );
  await storage.save({ courses: state.courses });
}

