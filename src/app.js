// The full site: a tab-sized page inside the extension (app.html). It shares
// storage, Canvas access and the chat with the popup, and has room for
// views that don't fit there. Add a view by adding a <section id="view-NAME">,
// a nav link to #NAME, and its name to VIEWS.

import { createChat } from "./chat-ui.js";
import { findExams } from "./exams.js";
import { showGradeCalculator, reloadGradeCalculator } from "./grade-calculator.js";
import { courseLabel, hasSyllabus } from "./prompt.js";
import { mountSettings, fillSettings, renderCourseVisibility } from "./settings-ui.js";
import { syncFromCanvas, openSimpleSyllabus, addSyllabusFile } from "./sync.js";
import * as storage from "./storage.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["overview", "calendar", "grades", "chat", "settings"];

const state = await storage.load();
let uploadTargetId = null;

const chat = createChat(state, { onMissingKey: () => (location.hash = "#settings") });
mountSettings(state, {
  onModelChange: () => chat.reset("Switched AI model — started a new chat."),
  onCoursesChange: () => {
    renderAll();
    reloadGradeCalculator();
    chat.reset("Course list changed — started a new chat.");
  },
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- Navigation ----------

let activeView = null;
let viewAnimation = null;
let navigationId = 0;

function activateView(view) {
  for (const v of VIEWS) {
    const page = $(`view-${v}`);
    page.hidden = v !== view;
    page.inert = v !== view;
  }
  activeView = view;
  if (view === "chat") $("question").focus({ preventScroll: true });
  if (view === "grades") showGradeCalculator(state);
}

async function showView() {
  const name = location.hash.slice(1);
  const view = VIEWS.includes(name) ? name : "overview";
  const mine = ++navigationId;
  const previous = activeView ? $(`view-${activeView}`) : null;
  // Read the current frame before canceling, so rapid navigation can interrupt
  // an incoming page smoothly instead of restarting at full opacity.
  const from = previous ? getComputedStyle(previous) : null;
  const opacity = from?.opacity ?? "1";
  const transform = from?.transform ?? "none";
  viewAnimation?.cancel();
  viewAnimation = null;

  for (const a of document.querySelectorAll(".nav a")) {
    const selected = a.hash === `#${view}`;
    a.classList.toggle("active", selected);
    if (selected) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }

  if (!previous || activeView === view || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    activateView(view);
    return;
  }

  previous.inert = true;
  const leaving = previous.animate([
    { opacity, transform },
    { opacity: 0, transform: "translateY(-4px)" },
  ], { duration: 90, easing: "ease-out", fill: "forwards" });
  viewAnimation = leaving;
  try { await leaving.finished; } catch { return; }
  if (mine !== navigationId) return;

  // Keep the existing page elements and scroll positions; only visibility changes.
  activateView(view);
  leaving.cancel();
  const entering = $(`view-${view}`).animate([
    { opacity: 0, transform: "translateY(8px)" },
    { opacity: 1, transform: "none" },
  ], { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  viewAnimation = entering;
  try { await entering.finished; } catch { /* A newer navigation takes over. */ }
  if (mine === navigationId) viewAnimation = null;
}

window.addEventListener("hashchange", showView);

// ---------- Courses ----------

function renderOverview() {
  $("overview-empty").hidden = storage.visibleCourses(state).length > 0;
  $("course-grid").replaceChildren(...storage.visibleCourses(state).map(courseCard));
  $("sync-status").textContent = state.syncedAt
    ? `Last synced ${new Date(state.syncedAt).toLocaleString()}`
    : "Not synced yet";
}

function courseCard(course) {
  const card = el("article", "course-card");
  const head = el("div", "card-head");
  head.append(el("h3", null, course.name));
  const add = el("button", "ghost small", "+");
  add.title = "Add a syllabus file (PDF or text) for this course";
  add.addEventListener("click", () => {
    uploadTargetId = course.id;
    $("file-picker").click();
  });
  head.append(add);
  card.append(head);
  card.append(hasSyllabus(course)
    ? el("p", "status found", "Syllabus found")
    : el("p", "status missing", "No syllabus found — add one with +"));

  const footer = el("footer");
  const label = el("label");
  const box = el("input");
  box.type = "checkbox";
  box.checked = state.selectedIds === null || state.selectedIds.includes(course.id);
  box.addEventListener("change", async () => {
    await storage.setCourseSelected(state, course.id, box.checked);
    renderChatScope();
    chat.reset("Course selection changed — started a new chat.");
  });
  label.append(box, "Include in chat");
  footer.append(label);

  if (course.simpleSyllabusUrl) {
    const open = el("a", "course-link", "Simple Syllabus ↗");
    open.href = course.simpleSyllabusUrl;
    open.addEventListener("click", (e) => {
      e.preventDefault();
      openSimpleSyllabus(course);
    });
    footer.append(open);
  }
  card.append(footer);
  return card;
}

$("sync").addEventListener("click", async () => {
  const button = $("sync");
  button.disabled = true;
  try {
    const courses = await syncFromCanvas(state, (msg) => ($("sync-status").textContent = msg));
    renderAll();
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
  renderOverview();
  chat.reset(`Added ${file.name} to ${course.name} — started a new chat.`);
});

// ---------- Exam calendar ----------

const KIND_LABELS = { midterm: "Midterm", final: "Final", exam: "Exam" };
let shownMonth = null; // first day of the month on screen
let selectedExam = null; // key of the exam last clicked on the calendar

// "2026-11-04" -> local midnight (new Date("2026-11-04") would be UTC).
function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  return new Date(2000, 0, 1, h, m || 0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Exams found in the syllabi plus ones added by hand, for courses that are turned on.
function allExams() {
  const courses = storage.visibleCourses(state);
  const found = courses.flatMap((course) => (state.exams[course.id]?.exams ?? []).map((exam, i) => ({
    ...exam, course, day: parseDay(exam.date), key: `exam-${course.id}-${i}`,
  })));
  const manual = state.manualExams.flatMap((exam) => {
    const course = courses.find((c) => c.id === exam.courseId);
    return course ? [{ ...exam, course, day: parseDay(exam.date), key: `manual-${exam.id}`, manual: true }] : [];
  });
  return [...found, ...manual].sort((a, b) => (a.day ?? Infinity) - (b.day ?? Infinity));
}

$("add-exam-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const exam = {
    id: crypto.randomUUID(),
    courseId: $("ae-course").value,
    name: $("ae-name").value.trim(),
    kind: $("ae-kind").value,
    date: $("ae-date").value,
    startTime: $("ae-start").value,
    endTime: $("ae-end").value,
    place: $("ae-place").value.trim(),
    materials: $("ae-materials").value.trim(),
  };
  if (!exam.courseId || !exam.name || !parseDay(exam.date)) return;
  state.manualExams = [...state.manualExams, exam];
  await storage.save({ manualExams: state.manualExams });
  // Jump to the new exam's month and highlight it.
  const day = parseDay(exam.date);
  shownMonth = new Date(day.getFullYear(), day.getMonth(), 1);
  selectedExam = `manual-${exam.id}`;
  event.target.reset();
  $("ae-course").value = exam.courseId; // keep the course for adding the next one
  renderCalendar();
});

async function removeManualExam(id) {
  state.manualExams = state.manualExams.filter((e) => e.id !== id);
  await storage.save({ manualExams: state.manualExams });
  renderCalendar();
}

$("find-exams").addEventListener("click", async () => {
  if (!state.apiKey) {
    location.hash = "#settings";
    return;
  }
  const button = $("find-exams");
  button.disabled = true;
  try {
    state.exams = await findExams({
      apiKey: state.apiKey,
      courses: storage.visibleCourses(state),
      model: state.claudeModel,
      onProgress: (msg) => ($("exam-status").textContent = msg),
    });
    await storage.save({ exams: state.exams });
    shownMonth = null;
    renderCalendar();
  } finally {
    button.disabled = false;
  }
});

$("month-prev").addEventListener("click", () => moveMonth(-1));
$("month-next").addEventListener("click", () => moveMonth(1));

function moveMonth(delta) {
  shownMonth = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + delta, 1);
  renderCalendar();
}

function fillAddExamCourses() {
  const select = $("ae-course");
  const previous = select.value;
  const courses = storage.visibleCourses(state);
  select.replaceChildren(...courses.map((c) => new Option(courseLabel(c), c.id)));
  if (courses.some((c) => c.id === previous)) select.value = previous;
}

function renderCalendar() {
  fillAddExamCourses();
  const exams = allExams();
  const scanned = Object.keys(state.exams).length > 0;
  const errors = storage.visibleCourses(state).filter((c) => state.exams[c.id]?.error);

  $("find-exams").textContent = scanned ? "Re-scan syllabi" : "Find exams in syllabi";
  const times = Object.values(state.exams).map((r) => r.at);
  $("exam-status").textContent = [
    scanned ? `Scanned ${new Date(Math.max(...times)).toLocaleDateString()}` : "",
    errors.length ? `Couldn't read: ${errors.map(courseLabel).join(", ")}` : "",
  ].filter(Boolean).join(" · ");

  const empty = $("calendar-empty");
  empty.hidden = exams.length > 0;
  $("calendar-body").hidden = exams.length === 0;
  empty.textContent = !storage.visibleCourses(state).length
    ? "Sync your courses first."
    : !scanned
      ? "Click “Find exams in syllabi” to have Claude list each course's midterms and finals. It takes about a minute and costs a few cents. Or add an exam yourself above."
      : "No exams were found in your syllabi. You can add them yourself above.";
  if (!exams.length) return;

  if (!shownMonth) {
    const today = new Date().setHours(0, 0, 0, 0);
    const next = exams.find((e) => e.day && e.day >= today) ?? exams.find((e) => e.day);
    const base = next?.day ?? new Date();
    shownMonth = new Date(base.getFullYear(), base.getMonth(), 1);
  }
  renderMonth(exams);
  renderExamList(exams);
}

function renderMonth(exams) {
  $("month-title").textContent = shownMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const grid = $("month-grid");
  grid.replaceChildren(
    ...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => el("div", "weekday", d))
  );
  const year = shownMonth.getFullYear();
  const month = shownMonth.getMonth();
  const todayKey = new Date().toDateString();
  for (let i = 0; i < shownMonth.getDay(); i++) grid.append(el("div", "cell blank"));
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const cell = el("div", "cell");
    if (date.toDateString() === todayKey) cell.classList.add("today");
    cell.append(el("span", "date-num", String(d)));
    for (const exam of exams.filter((e) => e.day?.getTime() === date.getTime())) {
      const chip = el("button", `chip ${exam.kind}`, `${exam.course.code || exam.course.name} · ${exam.name}`);
      chip.title = `${exam.name} — ${exam.course.name}`;
      chip.dataset.exam = exam.key;
      if (exam.key === selectedExam) chip.classList.add("selected");
      chip.addEventListener("click", () => selectExam(exam.key));
      cell.append(chip);
    }
    grid.append(cell);
  }
  const trailing = (7 - ((shownMonth.getDay() + daysInMonth) % 7)) % 7;
  for (let i = 0; i < trailing; i++) grid.append(el("div", "cell blank"));
}

// Highlights an exam's calendar label and details card (until another is
// clicked) and scrolls the card into view.
function selectExam(key) {
  selectedExam = key;
  for (const node of document.querySelectorAll("#month-grid .chip, #exam-list .exam-card")) {
    node.classList.toggle("selected", (node.dataset.exam ?? node.id) === key);
  }
  const card = $(key);
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("flash");
  void card.offsetWidth; // restart the pulse animation
  card.classList.add("flash");
}

function renderExamList(exams) {
  const today = new Date().setHours(0, 0, 0, 0);
  $("exam-list").replaceChildren(
    ...exams.map((exam) => {
      const card = el("article", `exam-card ${exam.kind}`);
      card.id = exam.key;
      if (exam.key === selectedExam) card.classList.add("selected");
      if (exam.day && exam.day < today) card.classList.add("past");

      const head = el("div", "exam-head");
      const title = el("div");
      title.append(el("h4", null, exam.name), el("div", "sub", courseLabel(exam.course)));
      head.append(title, el("span", `badge ${exam.kind}`, KIND_LABELS[exam.kind] ?? "Exam"));
      card.append(head);

      card.append(el("p", "exam-date", exam.day
        ? exam.day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
        : "Date not announced yet"));

      const time = exam.startTime
        ? [exam.startTime, exam.endTime].filter(Boolean).map(formatTime).join(" – ")
        : "";
      const facts = el("dl");
      for (const [label, value] of [["Time", time], ["Place", exam.place], ["Materials covered", exam.materials]]) {
        facts.append(el("dt", null, label), el("dd", value ? null : "unknown", value || (exam.manual ? "Not entered" : "Not listed in the syllabus")));
      }
      card.append(facts);
      if (exam.manual) {
        const actions = el("div", "exam-actions", "Added by you");
        const remove = el("button", "ghost small", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => removeManualExam(exam.id));
        actions.append(remove);
        card.append(actions);
      }
      return card;
    })
  );
}

// ---------- Chat ----------

function renderChatScope() {
  const total = storage.visibleCourses(state).length;
  $("chat-scope").textContent = total
    ? `Answering from ${storage.selectedCourses(state).length} of ${total} courses — change this on the Courses page.`
    : "";
}

// ---------- Live updates from the popup and background ----------

storage.onExternalChange(async (changes) => {
  Object.assign(state, await storage.load());
  fillSettings(state);
  renderAll();
  if (changes.hiddenIds || changes.canvasUrl) reloadGradeCalculator();
  if (changes.courses || changes.selectedIds || changes.hiddenIds || changes.claudeModel) {
    chat.reset("Your courses or settings changed in the popup — started a new chat.");
  }
});

function renderAll() {
  renderOverview();
  renderCalendar();
  renderChatScope();
  renderCourseVisibility(state);
}

if (!state.apiKey && !location.hash) location.hash = "#settings";
renderAll();
showView();
