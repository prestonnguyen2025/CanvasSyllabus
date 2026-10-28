import { createChat } from "./chat-ui.js";
import { animateDetails } from "./disclosure.js";
import { hasSyllabus } from "./prompt.js";
import { mountSettings, fillSettings, renderCourseVisibility } from "./settings-ui.js";
import { syncFromCanvas, openSimpleSyllabus, addSyllabusFile } from "./sync.js";
import * as storage from "./storage.js";

const $ = (id) => document.getElementById(id);

const state = await storage.load();
let uploadTargetId = null;

const chat = createChat(state, {
  onMissingKey: () => {
    $("settings").hidden = false;
    $("api-key").focus();
  },
});

// ---------- Settings ----------

mountSettings(state, {
  onModelChange: () => chat.reset("Switched AI model — started a new chat."),
  onCoursesChange: () => {
    renderCourses();
    chat.reset("Course list changed — started a new chat.");
  },
});
if (!state.apiKey) $("settings").hidden = false;
// The course list starts collapsed, except before the first sync so the Sync button is visible.
if (!state.courses.length) $("courses-panel").open = true;
animateDetails($("courses-panel"), $("courses-body"));

$("toggle-settings").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
});

// Opens a full-page tool in a tab, then closes the toolbar popup.
async function openPage(page) {
  await chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  window.close();
}
$("open-site").addEventListener("click", () => openPage("app.html"));
$("open-grades").addEventListener("click", () => openPage("app.html#grades"));

// ---------- Courses ----------

function renderCourses() {
  const list = $("course-list");
  list.replaceChildren();
  for (const course of storage.visibleCourses(state)) {
    const li = document.createElement("li");

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.selectedIds === null || state.selectedIds.includes(course.id);
    box.addEventListener("change", () => toggleCourse(course.id, box.checked));

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "course-name";
    name.textContent = course.name;
    const sources = document.createElement("div");
    sources.className = "course-sources";
    const hasSimpleSyllabusCopy = course.sources.some((s) => s.simpleSyllabus);
    if (hasSyllabus(course)) {
      sources.textContent = "Syllabus found";
    } else {
      sources.classList.add("none");
      sources.textContent = "No syllabus found — add one with +";
    }
    if (course.notes?.length) sources.title = course.notes.join("\n");
    info.append(name, sources);

    if (course.simpleSyllabusUrl) {
      const open = document.createElement("a");
      open.href = course.simpleSyllabusUrl;
      open.className = "course-link";
      open.textContent = hasSimpleSyllabusCopy ? "Re-open Simple Syllabus ↗" : "Open Simple Syllabus ↗";
      open.addEventListener("click", (e) => {
        e.preventDefault();
        openSimpleSyllabus(course);
      });
      info.append(open);
    }

    const add = document.createElement("button");
    add.className = "ghost small";
    add.textContent = "+";
    add.title = "Add a syllabus file (PDF or text) for this course";
    add.addEventListener("click", () => {
      uploadTargetId = course.id;
      $("file-picker").click();
    });

    li.append(box, info, add);
    list.append(li);
  }
  const total = storage.visibleCourses(state).length;
  $("courses-summary").textContent = total
    ? `Courses (${storage.selectedCourses(state).length} of ${total} in chat)`
    : "Courses";
  $("sync-status").textContent = state.syncedAt
    ? `Last synced ${new Date(state.syncedAt).toLocaleString()}`
    : "Not synced yet";
  renderUnassignedCapture();
  renderCourseVisibility(state);
}

// A Simple Syllabus page was saved but we couldn't tell which course it's for.
function renderUnassignedCapture() {
  const banner = $("capture-banner");
  const capture = state.unassignedCapture;
  banner.hidden = !capture;
  if (!capture) return;
  $("capture-title").textContent = capture.title;
  const select = $("capture-course");
  select.replaceChildren(
    ...storage.visibleCourses(state).map((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      return opt;
    })
  );
}

$("capture-attach").addEventListener("click", async () => {
  const course = state.courses.find((c) => c.id === $("capture-course").value);
  if (!course || !state.unassignedCapture) return;
  course.sources = [...course.sources.filter((s) => !s.simpleSyllabus), state.unassignedCapture];
  state.unassignedCapture = null;
  await storage.save({ courses: state.courses, unassignedCapture: null });
  renderCourses();
  chat.reset(`Added the Simple Syllabus page to ${course.name} — started a new chat.`);
});

$("capture-discard").addEventListener("click", async () => {
  state.unassignedCapture = null;
  await storage.save({ unassignedCapture: null });
  renderCourses();
});

// The background worker saves Simple Syllabus captures, and the full site can
// sync or change settings; pick those changes up live.
storage.onExternalChange(async (changes) => {
  Object.assign(state, await storage.load());
  fillSettings(state);
  renderCourses();
  if (changes.lastCaptureAt && !state.unassignedCapture) {
    chat.reset("Added a Simple Syllabus page — started a new chat.");
  } else if (changes.courses || changes.selectedIds || changes.hiddenIds || changes.claudeModel) {
    chat.reset("Your courses or settings changed in the full site — started a new chat.");
  }
});

async function toggleCourse(id, checked) {
  await storage.setCourseSelected(state, id, checked);
  renderCourses();
  chat.reset("Course selection changed — started a new chat.");
}

$("sync").addEventListener("click", async () => {
  const button = $("sync");
  button.disabled = true;
  try {
    const courses = await syncFromCanvas(state, (msg) => ($("sync-status").textContent = msg));
    renderCourses();
    chat.reset(`Synced ${courses.length} courses.`);
  } catch (e) {
    $("sync-status").textContent = e.message;
  } finally {
    button.disabled = false;
  }
});

$("file-picker").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  const course = state.courses.find((c) => c.id === uploadTargetId);
  if (!file || !course) return;
  await addSyllabusFile(state, course, file);
  renderCourses();
  chat.reset(`Added ${file.name} to ${course.name} — started a new chat.`);
});

renderCourses();
