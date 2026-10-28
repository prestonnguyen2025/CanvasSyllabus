// The Grade Calculator tab of the full site (app.html#grades). Loads the student's
// grades from Canvas with their logged-in session, then lets them try what-if scores.
// Grades come from the student's Canvas site; Anthropic reads the syllabus's
// grading rules. What-if scores are saved in chrome.storage on this computer.

import { shortCourseName } from "./autocomplete.js";
import { setDisclosureExpanded } from "./disclosure.js";
import { CanvasClient } from "./canvas.js";
import { listGradeCourses, loadCourseGrades } from "./grade-data.js";
import { computeGrade, letterFor, round2, scoreNeeded, targetsFor } from "./grade-math.js";
import { formatCutoff, normalizeScheme, resolveGradeScale } from "./grade-scale.js";
import { applySyllabus, dropText, formatDay } from "./grade-syllabus.js";
import { readSyllabusGrading, syllabusFingerprint, syllabusSources, SYLLABUS_GRADING_VERSION } from "./grade-weights.js";
import * as storage from "./storage.js";

const $ = (id) => document.getElementById(id);
const TOLERANCE = 0.1; // percentage points of difference from Canvas before warning

let state = null; // the site's saved settings, passed in by showGradeCalculator
let client = null;

let courses = [];
let model = null; // the loaded course, with the syllabus applied (see grade-data.js, grade-syllabus.js)
let view = null; // { table, notices } about where the weights came from (see grade-syllabus.js)
let baseModel = null; // the course as Canvas has it, before the syllabus is applied
let syllabusData = null; // what was read from the syllabus, or null when there's nothing usable
let loadNotes = []; // notices from loading that don't depend on which weights are shown
let plan = null; // { overrides: { itemId: points }, hypotheticals: [{ id, name, groupId, pointsPossible }], applyDrops }
const rows = new Map(); // item id -> { row, pct, slider, number, clear }
// Kept only in this page's memory: dismissed notices return on a page reload,
// but not on recalculation, course changes, or the calculator's Refresh button.
const dismissedNotices = new Set();

const STATUS_LABELS = {
  graded: "From Canvas",
  pending: "Waiting for review",
  hidden: "Grade not posted yet",
  submitted: "Submitted, not graded",
  missing: "Missing, not counted",
  ungraded: "Not graded yet",
  syllabus: "From syllabus",
  "no-weight": "In syllabus, no weight listed",
  excused: "Excused",
  omitted: "Doesn't count toward grade",
  "not-graded": "Not graded",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const fmtPct = (p) => (p == null ? "—" : `${p.toFixed(2)}%`);
const fmtPts = (x) => String(round2(x));

// ---------- Loading, errors and empty states ----------

function showStatus(kind, title, detail = "", actions = []) {
  const box = $("gc-status");
  box.className = `gc-status ${kind}`;
  box.hidden = false;
  const content = [el("h2", null, title)];
  if (detail) content.push(el("p", null, detail));
  if (kind === "loading") content.unshift(el("div", "spinner"));
  if (actions.length) {
    const row = el("div", "row");
    row.append(...actions);
    content.push(row);
  }
  box.replaceChildren(...content);
  $("gc-calc").hidden = true;
  $("gc-mini-results").hidden = true;
}

function button(text, onClick, className = "") {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function canvasLink(text) {
  const a = el("a", "button-link", text);
  a.href = state.canvasUrl;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function showError(e, retry) {
  const again = button("Try again", retry);
  if (e.message === "not-logged-in") {
    showStatus("error", "You're not signed in to Canvas",
      `Sign in at ${new URL(state.canvasUrl).host} in another tab, then try again.`, [canvasLink("Open Canvas ↗"), again]);
  } else if (e.message === "grades-hidden") {
    showStatus("error", "This course hides its grades",
      "Canvas isn't showing students the assignments or grades for this course. Pick another course.", [again]);
  } else if (e instanceof TypeError) {
    showStatus("error", "Couldn't reach Canvas", "Check your internet connection, then try again.", [again]);
  } else {
    showStatus("error", "Something went wrong", e.message, [again]);
  }
}

// Schools on their own domain need the user to grant access (needs a click).
async function hasCanvasAccess() {
  if (new URL(state.canvasUrl).hostname.endsWith(".instructure.com")) return true;
  return chrome.permissions.contains({ origins: [`${state.canvasUrl}/*`] });
}

async function start() {
  client = new CanvasClient(state.canvasUrl);
  if (!(await hasCanvasAccess())) {
    const allow = button(`Allow access to ${new URL(state.canvasUrl).host}`, async () => {
      if (await chrome.permissions.request({ origins: [`${state.canvasUrl}/*`] })) start();
    });
    showStatus("error", "Canvas access needed", "The extension needs permission to read your Canvas site.", [allow]);
    return;
  }
  showStatus("loading", "Loading your courses…");
  try {
    courses = (await listGradeCourses(client)).filter((c) => !state.hiddenIds.includes(String(c.id)));
  } catch (e) {
    showError(e, start);
    return;
  }
  if (!courses.length) {
    showStatus("empty", "No active courses",
      "Canvas doesn't list any courses you're currently enrolled in as a student (courses turned off in Settings are left out).");
    return;
  }
  const select = $("gc-course-select");
  select.replaceChildren(...courses.map((c) => new Option(shortCourseName(c.name), String(c.id))));
  select.disabled = false;
  const wanted = state.gradeCourseId;
  select.value = courses.some((c) => String(c.id) === wanted) ? wanted : String(courses[0].id);
  loadCourse(select.value);
}

// The course's grading as its syllabus describes it. It's read once and saved, then read
// again only when the synced syllabus changes or the student clicks Refresh.
// Returns { syllabus, problem }; problem says why the syllabus wasn't (fully) used.
async function loadSyllabus(base, name, force) {
  const course = state.courses.find((c) => String(c.id) === base.id);
  const saved = state.gradeSyllabus[base.id] ?? null;
  if (!syllabusSources(course).length) {
    return saved
      ? { syllabus: saved, problem: null }
      : { syllabus: null, problem: "This course has no synced syllabus text, so Canvas's weights are used. Sync your courses or add a syllabus file on the Courses page." };
  }
  if (saved && !force && saved.version === SYLLABUS_GRADING_VERSION && saved.fingerprint === syllabusFingerprint(course)) return { syllabus: saved, problem: null };
  if (!state.apiKey) {
    return {
      syllabus: saved,
      problem: saved ? null : "Add your Anthropic API key in Settings to read weights and letter cutoffs from the syllabus. Canvas's grading information is used when available.",
    };
  }
  showStatus("loading", `Reading the syllabus for ${name}…`, "This takes a few seconds, and only the first time.");
  const result = await readSyllabusGrading({
    apiKey: state.apiKey,
    course,
    canvasGroups: base.groups.map((g) => ({ name: g.name, assignments: g.items.map((i) => i.name) })),
    model: state.claudeModel,
  });
  if (result.error) {
    return { syllabus: saved, problem: `Couldn't read the syllabus (${result.error}), so ${saved ? "the last reading" : "Canvas's weights"} is used. Refresh to try again.` };
  }
  state.gradeSyllabus = { ...state.gradeSyllabus, [base.id]: result };
  storage.save({ gradeSyllabus: state.gradeSyllabus });
  return { syllabus: result, problem: null };
}

let loadId = 0; // which course load is current, so a slow one can't overwrite a newer one

async function loadCourse(courseId, { force = false } = {}) {
  const mine = ++loadId;
  const name = shortCourseName(courses.find((c) => String(c.id) === courseId)?.name ?? "course");
  showStatus("loading", `Loading grades for ${name}…`);
  state.gradeCourseId = courseId;
  storage.save({ gradeCourseId: courseId });
  let base;
  try {
    base = await loadCourseGrades(client, courseId);
  } catch (e) {
    if (mine === loadId) showError(e, () => loadCourse(courseId));
    return;
  }
  if (mine !== loadId) return;
  const { syllabus, problem } = await loadSyllabus(base, name, force);
  if (mine !== loadId) return;

  baseModel = base;
  syllabusData = syllabus;
  loadNotes = [];
  if (syllabus && !syllabus.found) {
    loadNotes.push({ kind: "info", text: "The syllabus doesn't list a grading breakdown, so Canvas's weights are used." });
  }
  if (problem) loadNotes.unshift({ kind: "info", text: problem });

  const saved = state.gradeWhatIfs[courseId];
  plan = {
    overrides: { ...saved?.overrides },
    hypotheticals: [...(saved?.hypotheticals ?? [])],
    applyDrops: Boolean(saved?.applyDrops),
    weightSource: saved?.weightSource ?? "syllabus",
    letterScheme: saved?.letterScheme ?? null,
    collapsedGroupIds: [...(saved?.collapsedGroupIds ?? [])],
  };
  // Forget what-ifs for groups that no longer exist.
  plan.hypotheticals = plan.hypotheticals.filter((h) => base.groups.some((g) => g.id === h.groupId));
  applyWeights();

  if (!model.groups.length) {
    showStatus("empty", "No assignments yet", `${name} doesn't have any assignments in Canvas yet.`);
    return;
  }
  $("gc-status").hidden = true;
  $("gc-calc").hidden = false;
  $("gc-mini-results").hidden = false;
  renderCourseNotes();
  renderWeightsTable();
  renderLetterScale();
  renderAll();
}

// Builds the model from Canvas's weights or the syllabus's, whichever the student has picked.
function applyWeights() {
  const applied = applySyllabus(baseModel, syllabusData && plan.weightSource !== "canvas" ? syllabusData : null);
  const letters = resolveGradeScale(baseModel, syllabusData, plan.letterScheme);
  model = { ...applied.model, scheme: letters.scheme, schemeSource: letters.schemeSource };
  view = { table: applied.table, notices: [...loadNotes, ...applied.notices, ...letters.notices] };
}

$("gc-weights-switch").addEventListener("click", (e) => {
  const source = e.target.closest("button")?.dataset.source;
  if (!source || source === plan.weightSource) return;
  plan.weightSource = source;
  savePlan();
  applyWeights();
  renderCourseNotes();
  renderWeightsTable();
  renderAll();
});

$("gc-course-select").addEventListener("change", (e) => loadCourse(e.target.value));
$("gc-drops-toggle").addEventListener("click", () => {
  plan.applyDrops = !plan.applyDrops;
  savePlan();
  refresh();
});

// Refresh reloads from Canvas and reads the syllabus again.
$("gc-refresh").addEventListener("click", () => (model ? loadCourse(model.id, { force: true }) : start()));

// ---------- The model with hypothetical assignments added ----------

function fullModel() {
  return {
    ...model,
    groups: model.groups.map((g) => ({
      ...g,
      items: [
        ...g.items,
        ...plan.hypotheticals
          .filter((h) => h.groupId === g.id)
          .map((h) => ({ ...h, kind: "hypothetical", counts: true, status: "hypothetical" })),
      ],
    })),
  };
}

const isGraded = (item) => item.kind === "canvas" && item.status === "graded";
const currentValue = (item) => (isGraded(item) ? item.realScore : null);
function projectedValue(item) {
  if (item.id in plan.overrides) return plan.overrides[item.id];
  return isGraded(item) ? item.realScore : null;
}
// Assignments a student can still affect: ungraded Canvas ones and hypotheticals.
const isOpen = (item) => item.counts && !isGraded(item);

let saveTimer = 0;
function savePlan() {
  clearTimeout(saveTimer);
  const courseId = model.id;
  const coursePlan = plan;
  saveTimer = setTimeout(() => {
    state.gradeWhatIfs = { ...state.gradeWhatIfs, [courseId]: coursePlan };
    storage.save({ gradeWhatIfs: state.gradeWhatIfs });
  }, 300);
}

// ---------- Rendering ----------

function renderCourseNotes() {
  const notes = [...view.notices];
  if (model.hideTotals) {
    notes.push({ kind: "info", text: "Your instructor hides the course total in Canvas, so this calculation can't be checked against Canvas." });
  }
  if (model.groups.some((g) => g.items.some((i) => i.status === "hidden"))) {
    notes.push({ kind: "info", text: "Some grades aren't posted yet. They're treated as ungraded until your instructor posts them." });
  }
  $("gc-course-notes").replaceChildren(
    ...notes.flatMap((n) => {
      const key = JSON.stringify([model.id, n.text]);
      if (dismissedNotices.has(key)) return [];
      const banner = el("div", n.kind === "conflict" ? "notice-banner conflict" : "notice-banner");
      const dismiss = button("×", () => {
        dismissedNotices.add(key);
        dismiss.disabled = true;
        banner.inert = true;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
          banner.remove();
          return;
        }
        const style = getComputedStyle(banner);
        banner.style.overflow = "hidden";
        const animation = banner.animate([
          {
            opacity: 1, height: `${banner.getBoundingClientRect().height}px`,
            paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
            marginBottom: style.marginBottom, transform: "none",
          },
          {
            opacity: 0, height: "0px", paddingTop: "0px", paddingBottom: "0px",
            marginBottom: "0px", transform: "translateY(-4px)",
          },
        ], { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
        animation.finished.then(() => banner.remove(), () => banner.remove());
      }, "notice-dismiss");
      dismiss.setAttribute("aria-label", "Dismiss notice until page reload");
      dismiss.title = "Dismiss until page reload";
      banner.append(el("span", "notice-text", n.text), dismiss);
      return [banner];
    })
  );
}

// The small table in the results column: each group's weight and drop rule, and where they came from.
function renderWeightsTable() {
  const { table } = view;
  $("gc-weights-source").textContent = table.source === "syllabus" ? "From syllabus" : "From Canvas";
  // The switch only makes sense when the syllabus gave something to switch to.
  const useSyllabus = table.source === "syllabus";
  $("gc-weights-switch").hidden = !syllabusData?.found;
  for (const b of $("gc-weights-switch").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.source === (useSyllabus ? "syllabus" : "canvas")));
  }
  const body = $("gc-weights-body");
  body.replaceChildren(
    ...table.rows.map((row) => {
      const tr = el("tr");
      const name = el("td", "w-name", row.name);
      if (row.detail) name.append(el("div", "w-detail", row.detail));
      tr.append(name, el("td", "w-pct", row.weight == null ? "—" : `${round2(row.weight)}%`));
      return tr;
    })
  );
  $("gc-weights-total").textContent = table.total == null ? "By total points" : `${table.total}%`;
}

function addScaleRow(entry = {}) {
  const row = el("div", "scale-row");
  const name = el("input");
  name.className = "scale-name";
  name.value = entry.name ?? "";
  name.placeholder = "A+";
  name.required = true;
  name.setAttribute("aria-label", "Grade label");
  const rule = el("select", "scale-rule");
  rule.append(new Option("≥", "inclusive"), new Option(">", "exclusive"));
  rule.value = entry.inclusive === false ? "exclusive" : "inclusive";
  rule.setAttribute("aria-label", "Minimum includes or excludes the boundary");
  const min = el("input", "scale-min");
  min.type = "number";
  min.min = "0";
  min.max = "100";
  min.step = "any";
  min.required = true;
  min.placeholder = "93";
  min.value = entry.min ?? "";
  min.setAttribute("aria-label", "Minimum percentage");
  const remove = button("×", () => row.remove(), "ghost small");
  remove.setAttribute("aria-label", "Remove cutoff");
  row.append(name, rule, min, remove);
  $("gc-scale-rows").append(row);
}

function renderLetterScale() {
  $("gc-scale-source").textContent = {
    syllabus: "From this course's syllabus",
    course: "From this course's Canvas grading scheme",
    custom: "Your saved cutoffs for this course",
    unknown: "No course-specific scale found. Enter the syllabus cutoffs to calculate letters and targets.",
  }[model.schemeSource];
  $("gc-scale-body").replaceChildren(...model.scheme.map((entry) => {
    const row = el("tr");
    const name = el("td", "w-name", entry.name);
    if (entry.evidence) name.title = entry.evidence;
    row.append(name, el("td", "w-pct", formatCutoff(entry)));
    return row;
  }));
  $("gc-scale-rows").replaceChildren();
  if (model.scheme.length) model.scheme.forEach(addScaleRow);
  else addScaleRow();
  $("gc-scale-reset").disabled = !plan.letterScheme;
  $("gc-scale-error").textContent = "";
}

$("gc-scale-add").addEventListener("click", () => addScaleRow());
$("gc-scale-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const entries = [...$("gc-scale-rows").children].map((row) => ({
    name: row.querySelector(".scale-name").value,
    min: row.querySelector(".scale-min").value === "" ? NaN : Number(row.querySelector(".scale-min").value),
    inclusive: row.querySelector(".scale-rule").value === "inclusive",
  }));
  const scheme = normalizeScheme(entries);
  if (!scheme.length) {
    $("gc-scale-error").textContent = "Enter unique grade labels and cutoffs from 0 to 100. Two rows cannot have the same boundary and rule.";
    return;
  }
  plan.letterScheme = scheme;
  savePlan();
  applyWeights();
  renderCourseNotes();
  renderLetterScale();
  $("gc-scale-editor").open = false;
  refresh();
});

$("gc-scale-reset").addEventListener("click", () => {
  plan.letterScheme = null;
  savePlan();
  applyWeights();
  renderCourseNotes();
  renderLetterScale();
  refresh();
});

function renderAll() {
  const m = fullModel();
  rows.clear();
  $("gc-groups").replaceChildren(...m.groups.map((g) => renderGroup(g, m.weighted)));
  // Hypotheticals go in Canvas's groups; a syllabus-only card is a single item.
  const addable = model.groups.filter((g) => !g.syllabusOnly);
  $("gc-add-group").replaceChildren(...addable.map((g) => new Option(g.name, g.id)));
  $("gc-add-form").hidden = !addable.length;
  fillNeedSelect(m);
  refresh();
}

function renderGroup(group, weighted) {
  const card = el("section", "card group");
  const body = el("div", "group-body");
  body.id = `group-body-${group.id}`;
  body.hidden = plan.collapsedGroupIds.includes(group.id);
  body.inert = body.hidden;
  card.classList.toggle("collapsed", body.hidden);
  const head = el("div", "group-head");
  const title = el("div");
  const heading = el("h2");
  const toggle = button("", () => {
    const expanded = plan.collapsedGroupIds.includes(group.id);
    const collapsed = new Set(plan.collapsedGroupIds);
    if (expanded) collapsed.delete(group.id);
    else collapsed.add(group.id);
    plan.collapsedGroupIds = [...collapsed];
    toggle.setAttribute("aria-expanded", String(expanded));
    card.classList.toggle("collapsed", !expanded);
    setDisclosureExpanded(body, expanded, toggle);
    savePlan();
  }, "group-toggle");
  const arrow = el("span", "group-arrow", "▾");
  arrow.setAttribute("aria-hidden", "true");
  toggle.append(arrow, el("span", null, group.name));
  toggle.setAttribute("aria-expanded", String(!body.hidden));
  toggle.setAttribute("aria-controls", body.id);
  heading.append(toggle);
  title.append(heading);
  const facts = [];
  if (weighted) facts.push(`${round2(group.weight)}% of grade`);
  if (dropText(group.rules)) facts.push(dropText(group.rules));
  if (facts.length) title.append(el("div", "group-facts", facts.join(" · ")));
  const hold = el("div", "group-facts hold");
  hold.id = `group-hold-${group.id}`;
  hold.hidden = true; // refresh() shows it while the group's drops are waiting
  title.append(hold);
  const summary = el("div", "group-summary");
  summary.id = `group-sum-${group.id}`;
  head.append(title, summary);
  card.append(head);

  if (!group.items.length) body.append(el("p", "hint empty-group", "No assignments in this group yet."));
  for (const item of group.items) body.append(renderRow(item));
  card.append(body);
  return card;
}

function renderRow(item) {
  const editing = item.id in plan.overrides;
  const kindClass = item.kind === "hypothetical" ? "hypo" : !item.counts ? "inactive" : isGraded(item) && !editing ? "real" : "whatif";
  const row = el("div", `a-row ${kindClass}`);
  const parts = { row, item };

  const info = el("div", "a-info");
  const name = item.url ? el("a", "a-name", item.name) : el("span", "a-name", item.name);
  if (item.url) {
    name.href = item.url;
    name.target = "_blank";
    name.rel = "noopener";
  }
  const meta = el("div", "a-meta");
  const label = item.kind === "hypothetical" ? "Hypothetical"
    : item.kind === "syllabus" ? `${STATUS_LABELS[item.status]}${item.status === "syllabus" ? ` · ${item.syllabusDate ? formatDay(item.syllabusDate) : "no date"}` : ""}`
    : editing && isGraded(item) ? "What-if (edited)" : STATUS_LABELS[item.status];
  // Ungraded assignments only turn orange (what-if) once they have a score.
  const pill = el("span", `pill ${kindClass === "whatif" && !editing ? "open" : kindClass}`, isGraded(item) && !editing ? `🔒 ${label}` : label);
  parts.pill = pill;
  meta.append(pill);
  if (item.dueAt) {
    meta.append(el("span", null, `Due ${new Date(item.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`));
  }
  meta.append(el("span", "pill drop-tag", "Dropped"));
  info.append(name, meta);

  const score = el("div", "a-score");
  if (!item.counts) {
    score.append(el("span", "hint", item.kind === "syllabus" ? "Not counted" : `${fmtPts(item.pointsPossible)} pts`));
  } else if (isGraded(item) && !editing) {
    score.append(el("span", "locked", `${fmtPts(item.realScore)} / ${fmtPts(item.pointsPossible)}`));
    score.append(button("What-if", () => {
      plan.overrides[item.id] = item.realScore;
      savePlan();
      renderAll();
    }, "ghost small"));
  } else {
    score.append(...scoreControls(item, parts));
  }

  parts.pct = el("div", "a-pct");
  row.append(info, score, parts.pct);
  rows.set(item.id, parts);
  return row;
}

function scoreControls(item, parts) {
  const value = projectedValue(item);
  const max = item.pointsPossible || 0;
  const controls = [];

  if (max > 0) {
    const slider = el("input", "slider");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(max);
    slider.step = String(max / 200);
    slider.value = String(Math.min(value ?? 0, max));
    slider.setAttribute("aria-label", `Score for ${item.name}`);
    slider.classList.toggle("unset", value == null);
    slider.addEventListener("input", () => setScore(item, Number(slider.value), "slider"));
    parts.slider = slider;
    controls.push(slider);
  }

  const number = el("input", "score-input");
  number.type = "number";
  number.min = "0";
  number.step = "any";
  number.inputMode = "decimal";
  number.placeholder = "—";
  number.value = value == null ? "" : fmtPts(value);
  number.setAttribute("aria-label", `Points for ${item.name}`);
  number.addEventListener("input", () => setScore(item, number.value === "" ? null : Number(number.value), "number"));
  parts.number = number;
  const of = el("span", "of", `/ ${fmtPts(max)}`);
  const wrap = el("span", "number-wrap");
  wrap.append(number, of);
  controls.push(wrap);

  if (isGraded(item)) {
    controls.push(button(`Reset to ${fmtPts(item.realScore)}`, () => {
      delete plan.overrides[item.id];
      savePlan();
      renderAll();
    }, "ghost small"));
  } else if (item.kind === "hypothetical") {
    controls.push(button("Remove", () => {
      plan.hypotheticals = plan.hypotheticals.filter((h) => h.id !== item.id);
      delete plan.overrides[item.id];
      savePlan();
      renderAll();
    }, "ghost small"));
  } else {
    parts.clear = button("Clear", () => setScore(item, null, "clear"), "ghost small");
    controls.push(parts.clear);
  }
  return controls;
}

function setScore(item, value, from) {
  if (value != null && (!Number.isFinite(value) || value < 0)) return;
  const parts = rows.get(item.id);
  if (value == null) {
    // A Canvas grade being edited can't be blank; Reset restores it instead.
    if (isGraded(item)) return;
    delete plan.overrides[item.id];
  } else {
    plan.overrides[item.id] = round2(value);
  }
  if (parts.slider && from !== "slider") parts.slider.value = String(Math.min(value ?? 0, item.pointsPossible));
  parts.slider?.classList.toggle("unset", value == null);
  if (from !== "number") parts.number.value = value == null ? "" : fmtPts(value);
  savePlan();
  refresh();
}

// Updates every number on the page after a score changes, without rebuilding
// the rows (so a slider being dragged keeps working).
function refresh() {
  const m = fullModel();
  const options = { applyDrops: plan.applyDrops };
  const current = computeGrade(m, currentValue, options);
  const projected = computeGrade(m, projectedValue, options);
  const currentLetter = letterFor(current.exact, model.scheme);
  const projectedLetter = letterFor(projected.exact, model.scheme);

  $("gc-current-pct").textContent = fmtPct(current.percent);
  $("gc-current-letter").textContent = currentLetter ?? "";
  $("gc-projected-pct").textContent = fmtPct(projected.percent);
  $("gc-projected-letter").textContent = projectedLetter ?? "";
  $("gc-mini-current").textContent = `${fmtPct(current.percent)} ${currentLetter ?? ""}`;
  $("gc-mini-projected").textContent = `${fmtPct(projected.percent)} ${projectedLetter ?? ""}`;

  const delta = $("gc-projected-delta");
  if (current.percent != null && projected.percent != null) {
    const d = round2(projected.percent - current.percent);
    delta.textContent = d === 0 ? "No change from current" : `${d > 0 ? "▲ +" : "▼ "}${d.toFixed(2)} from current`;
    delta.className = `delta ${d > 0 ? "up" : d < 0 ? "down" : ""}`;
  } else {
    delta.textContent = current.percent == null ? "Nothing graded yet" : "";
    delta.className = "delta";
  }

  renderCanvasCheck(current.percent, current.held.size > 0);

  // Only courses with drop rules get the button.
  const hasDrops = m.groups.some((g) => g.rules.dropLowest || g.rules.dropHighest);
  $("gc-drops-box").hidden = !hasDrops;
  $("gc-drops-toggle").setAttribute("aria-pressed", String(plan.applyDrops));
  $("gc-drops-toggle").textContent = plan.applyDrops ? "Drops included now ✓" : "Include drops now";
  $("gc-drops-hint").textContent = plan.applyDrops
    ? "Dropping the lowest scores entered so far, like Canvas. A later low score can change which are dropped."
    : "Drops currently wait until every assignment in a group has a score.";
  $("gc-grading-mode").textContent = [
    m.weighted ? (view.table.source === "syllabus" ? "Weighted by the syllabus." : "Weighted by assignment group.") : "Based on total points.",
    {
      syllabus: "Letter cutoffs come from this course's syllabus.",
      course: "Letter cutoffs come from this course's Canvas grading scheme.",
      custom: "Letters use the cutoffs you saved for this course.",
      unknown: "Letter cutoffs are unknown. Refresh to read the syllabus or enter this course's cutoffs below.",
    }[model.schemeSource],
  ].join(" ");

  for (const g of projected.groups) {
    const now = current.groups.find((c) => c.id === g.id);
    const pct = (x) => (x.possible > 0 ? `${round2((x.score / x.possible) * 100)}%` : "—");
    const node = $(`group-sum-${g.id}`);
    if (node) node.textContent = `Now ${pct(now)} · Projected ${pct(g)}`;

    // A group's drops wait until every assignment in it has a score.
    const hold = $(`group-hold-${g.id}`);
    if (hold) {
      const rules = m.groups.find((x) => x.id === g.id).rules;
      const what = [rules.dropLowest && `lowest ${rules.dropLowest}`, rules.dropHighest && `highest ${rules.dropHighest}`].filter(Boolean).join(" and ");
      hold.hidden = !projected.held.has(g.id);
      hold.textContent = `Dropping the ${what} waits until every assignment here has a score, since an ungraded one could still be lower.`;
    }
  }

  for (const [id, parts] of rows) {
    const value = projectedValue(parts.item);
    const pts = parts.item.pointsPossible;
    parts.pct.textContent = parts.item.counts && value != null && pts > 0 ? `${round2((value / pts) * 100)}%` : "";
    parts.row.classList.toggle("dropped", projected.dropped.has(id));
    if (parts.clear) parts.clear.disabled = value == null;
    if (parts.item.kind !== "hypothetical" && !isGraded(parts.item) && parts.item.counts) {
      parts.pill.className = `pill ${value == null ? "open" : "whatif"}`;
    }
  }

  renderNeed(m);
}

function renderCanvasCheck(currentPercent, dropsHeld) {
  const check = $("gc-canvas-check");
  if (model.hideTotals) {
    check.className = "check muted";
    check.textContent = "Canvas hides this course's total, so there's nothing to compare against.";
  } else if (model.canvasScore == null) {
    check.className = "check muted";
    check.textContent = "Canvas hasn't reported a course total yet.";
  } else if (currentPercent == null) {
    check.className = "check muted";
    check.textContent = `Canvas reports ${fmtPct(model.canvasScore)}.`;
  } else {
    const diff = Math.abs(currentPercent - model.canvasScore);
    if (diff <= TOLERANCE) {
      check.className = "check ok";
      check.textContent = `✓ Matches Canvas (${fmtPct(model.canvasScore)})`;
    } else {
      check.className = "check warn";
      // Differences this page causes on purpose, before blaming something it can't see.
      const reasons = [];
      if (view.notices.some((n) => n.kind === "conflict")) reasons.push("this page follows the syllabus where it differs from Canvas");
      if (dropsHeld) reasons.push("it waits to drop scores until every assignment in a group is graded, which Canvas doesn't");
      check.textContent = `⚠ Canvas shows ${fmtPct(model.canvasScore)}, ${round2(diff)} points different. ${
        reasons.length
          ? `Expected: ${reasons.join(", and ")}. Anything left over may be something this page can't see, such as grading periods or grades not yet posted.`
          : "Canvas may be counting something this page can't see, such as grading periods or grades not yet posted."
      }`;
    }
  }
}

// ---------- What do I need? ----------

function fillNeedSelect(m) {
  const select = $("gc-need-item");
  const previous = select.value;
  const open = m.groups.flatMap((g) => g.items.filter(isOpen));
  select.replaceChildren(...open.map((i) => new Option(`${i.name} (${fmtPts(i.pointsPossible)} pts)`, i.id)));
  const keep = open.find((i) => i.id === previous) ?? open.find((i) => /final/i.test(i.name)) ?? open[0];
  if (keep) select.value = keep.id;
  select.disabled = !open.length;
}

$("gc-need-item").addEventListener("change", () => renderNeed(fullModel()));

function renderNeed(m) {
  const out = $("gc-need-results");
  if (!model.scheme.length) {
    out.replaceChildren(el("p", "hint", "A course-specific letter scale is needed. Refresh to read the syllabus, or enter this course's letter cutoffs below."));
    return;
  }
  const item = m.groups.flatMap((g) => g.items).find((i) => i.id === $("gc-need-item").value);
  if (!item) {
    out.replaceChildren(el("p", "hint", "Everything is graded. Add a hypothetical assignment (like your final) to see what you'd need on it."));
    return;
  }
  const list = el("ul", "need-list");
  for (const target of targetsFor(model.scheme)) {
    const result = scoreNeeded(m, projectedValue, item, target, { applyDrops: plan.applyDrops });
    const li = el("li");
    li.append(el("span", "need-letter", `${target.name} (${formatCutoff(target)})`));
    let text;
    let cls = "";
    if (result.status === "secured") {
      text = "Already secured, even with a 0";
      cls = "ok";
    } else if (result.status === "unreachable") {
      text = "Not reachable on this alone";
      cls = "bad";
    } else {
      const pct = item.pointsPossible > 0 ? round2((result.points / item.pointsPossible) * 100) : null;
      text = `${fmtPts(result.points)} / ${fmtPts(item.pointsPossible)}${pct != null ? ` (${pct}%)` : ""}`;
      if (pct != null && pct > 100) {
        text += ", more than full credit";
        cls = "bad";
      }
    }
    li.append(el("span", `need-value ${cls}`, text));
    list.append(li);
  }
  out.replaceChildren(list);
}

// ---------- Clear / add ----------

$("gc-clear-whatifs").addEventListener("click", () => {
  plan.overrides = {};
  savePlan();
  renderAll();
});

$("gc-add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const points = Number($("gc-add-points").value);
  const name = $("gc-add-name").value.trim();
  if (!name || !(points > 0)) return;
  plan.hypotheticals.push({ id: `hypo-${Date.now()}`, name, groupId: $("gc-add-group").value, pointsPossible: points });
  savePlan();
  renderAll();
});

let started = false;

// Starts the calculator the first time its tab is shown, since it loads from Canvas.
export function showGradeCalculator(appState) {
  state = appState;
  if (started) return;
  started = true;
  start();
}

// Reloads the course list, e.g. after courses are turned on or off in Settings.
export function reloadGradeCalculator() {
  if (started) start();
}
