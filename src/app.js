// The full site: a tab-sized page inside the extension (app.html). It shares
// storage, Canvas access and the chat with the side panel, and has room for
// views that don't fit there. Add a view by adding a <section id="view-NAME">,
// a nav link to #NAME, and its name to VIEWS.

import { createChat } from "./chat-ui.js";
import { findExams } from "./exams.js";
import { courseLabel, hasSyllabus } from "./prompt.js";
import { mountSettings, fillSettings, renderCourseVisibility } from "./settings-ui.js";
import { syncFromCanvas, openSimpleSyllabus, addSyllabusFile } from "./sync.js";
import * as storage from "./storage.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["overview", "deadlines", "calendar", "chat", "settings"];
const DAY_MS = 24 * 60 * 60 * 1000;

const state = await storage.load();
let uploadTargetId = null;

const chat = createChat(state, { onMissingKey: () => (location.hash = "#settings") });
mountSettings(state, {
  onModelChange: () => chat.reset("Switched AI model — started a new chat."),
  onCoursesChange: () => {
    renderAll();
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

function showView() {
  const name = location.hash.slice(1);
  const view = VIEWS.includes(name) ? name : "overview";
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll(".nav a")) a.classList.toggle("active", a.hash === `#${view}`);
  if (view === "chat") $("question").focus();
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

// ---------- Deadlines ----------

function upcomingAssignments(days) {
  const start = new Date().setHours(0, 0, 0, 0);
  const end = days ? start + days * DAY_MS : Infinity;
  return storage.visibleCourses(state)
    .flatMap((course) =>
      course.sources.flatMap((s) => s.items ?? []).map((item) => ({ ...item, course }))
    )
    .filter((a) => a.dueAt && Date.parse(a.dueAt) >= start && Date.parse(a.dueAt) < end)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

function dayLabel(date) {
  const diff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function renderDeadlines() {
  const days = Number($("deadline-range").value) || null;
  const items = upcomingAssignments(days);
  const hasData = storage.visibleCourses(state).some((c) => c.sources.some((s) => s.items));

  const empty = $("deadlines-empty");
  empty.hidden = items.length > 0;
  empty.textContent = !storage.visibleCourses(state).length
    ? "Sync your courses first."
    : !hasData
      ? "Sync from Canvas again to load due dates."
      : "Nothing due in this window.";

  const groups = new Map();
  for (const a of items) {
    const key = new Date(a.dueAt).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  $("deadline-list").replaceChildren(
    ...[...groups].map(([key, group]) => {
      const day = el("section", "day");
      day.append(el("h3", null, dayLabel(new Date(key))));
      const list = el("ul");
      for (const a of group) {
        const li = el("li");
        li.append(el("span", "time", new Date(a.dueAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })));
        const info = el("div");
        const link = el("a", null, a.name);
        link.href = a.url;
        link.target = "_blank";
        link.rel = "noopener";
        info.append(link, el("div", "sub", `${courseLabel(a.course)} · ${a.group}`));
        li.append(info, el("span", "points", a.points != null ? `${a.points} pts` : ""));
        list.append(li);
      }
      day.append(list);
      return day;
    })
  );
}

$("deadline-range").addEventListener("change", renderDeadlines);

// ---------- Exam calendar ----------

const KIND_LABELS = { midterm: "Midterm", final: "Final", exam: "Exam" };
let shownMonth = null; // first day of the month on screen

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

function allExams() {
  return storage.visibleCourses(state)
    .flatMap((course) => (state.exams[course.id]?.exams ?? []).map((exam, i) => ({
      ...exam, course, day: parseDay(exam.date), key: `exam-${course.id}-${i}`,
    })))
    .sort((a, b) => (a.day ?? Infinity) - (b.day ?? Infinity));
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

function renderCalendar() {
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
      ? "Click “Find exams in syllabi” to have Claude list each course's midterms and finals. It takes about a minute and costs a few cents."
      : "No exams were found in your syllabi.";
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
      chip.addEventListener("click", () => {
        const card = $(exam.key);
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.remove("flash");
        void card.offsetWidth; // restart the highlight animation
        card.classList.add("flash");
      });
      cell.append(chip);
    }
    grid.append(cell);
  }
  const trailing = (7 - ((shownMonth.getDay() + daysInMonth) % 7)) % 7;
  for (let i = 0; i < trailing; i++) grid.append(el("div", "cell blank"));
}

function renderExamList(exams) {
  const today = new Date().setHours(0, 0, 0, 0);
  $("exam-list").replaceChildren(
    ...exams.map((exam) => {
      const card = el("article", `exam-card ${exam.kind}`);
      card.id = exam.key;
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
        facts.append(el("dt", null, label), el("dd", value ? null : "unknown", value || "Not listed in the syllabus"));
      }
      card.append(facts);
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

// ---------- Live updates from the side panel and background ----------

storage.onExternalChange(async (changes) => {
  Object.assign(state, await storage.load());
  fillSettings(state);
  renderAll();
  if (changes.courses || changes.selectedIds || changes.hiddenIds || changes.claudeModel) {
    chat.reset("Your courses or settings changed in the side panel — started a new chat.");
  }
});

function renderAll() {
  renderOverview();
  renderDeadlines();
  renderCalendar();
  renderChatScope();
  renderCourseVisibility(state);
}

if (!state.apiKey && !location.hash) location.hash = "#settings";
renderAll();
showView();
