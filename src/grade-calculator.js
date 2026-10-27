// The Grade Calculator tab of the full site (app.html#grades). Loads the student's
// grades from Canvas with their logged-in session, then lets them try what-if scores.
// Nothing is sent anywhere but the student's own Canvas site; what-if scores
// are saved in chrome.storage on this computer.

import { shortCourseName } from "./autocomplete.js";
import { CanvasClient } from "./canvas.js";
import { listGradeCourses, loadCourseGrades } from "./grade-data.js";
import { computeGrade, letterFor, round2, scoreNeeded, targetsFor } from "./grade-math.js";
import { findGradingWeights } from "./grade-weights.js";
import * as storage from "./storage.js";

const $ = (id) => document.getElementById(id);
const TOLERANCE = 0.1; // percentage points of difference from Canvas before warning

let state = null; // the site's saved settings, passed in by showGradeCalculator
let client = null;

let courses = [];
let model = null; // the loaded course (see grade-data.js)
let plan = null; // { overrides: { itemId: points }, hypotheticals: [{ id, name, groupId, pointsPossible }] }
const rows = new Map(); // item id -> { row, pct, slider, number, clear }

const STATUS_LABELS = {
  graded: "From Canvas",
  pending: "Waiting for review",
  hidden: "Grade not posted yet",
  submitted: "Submitted, not graded",
  missing: "Missing, not counted",
  ungraded: "Not graded yet",
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

async function loadCourse(courseId) {
  const name = shortCourseName(courses.find((c) => String(c.id) === courseId)?.name ?? "course");
  showStatus("loading", `Loading grades for ${name}…`);
  state.gradeCourseId = courseId;
  storage.save({ gradeCourseId: courseId });
  try {
    model = await loadCourseGrades(client, courseId);
  } catch (e) {
    showError(e, () => loadCourse(courseId));
    return;
  }
  const saved = state.gradeWhatIfs[courseId];
  plan = { overrides: { ...saved?.overrides }, hypotheticals: [...(saved?.hypotheticals ?? [])], weightSource: saved?.weightSource ?? "canvas" };
  // Forget what-ifs for groups that no longer exist.
  plan.hypotheticals = plan.hypotheticals.filter((h) => model.groups.some((g) => g.id === h.groupId));
  // Canvas's weights are unusable when they're missing or every group has the same weight;
  // then use the syllabus's weights if they've been read.
  if (!saved?.weightSource && !canvasWeightsUsable(model) && state.gradeSyllabusWeights[courseId]?.byName) {
    plan.weightSource = "syllabus";
  }

  if (!model.groups.length) {
    showStatus("empty", "No assignments yet", `${name} doesn't have any assignments in Canvas yet.`);
    return;
  }
  $("gc-status").hidden = true;
  $("gc-calc").hidden = false;
  $("gc-mini-results").hidden = false;
  renderCourseNotes();
  renderAll();
}

$("gc-course-select").addEventListener("change", (e) => loadCourse(e.target.value));
$("gc-refresh").addEventListener("click", () => (model ? loadCourse(model.id) : start()));

$("gc-weight-source").addEventListener("change", (e) => {
  plan.weightSource = e.target.value;
  savePlan();
  renderAll();
});

$("gc-read-weights").addEventListener("click", async () => {
  const button = $("gc-read-weights");
  const status = $("gc-weights-status");
  if (!state.apiKey) {
    status.textContent = "Add your Anthropic API key in Settings first.";
    return;
  }
  button.disabled = true;
  status.textContent = "Reading the syllabus…";
  const result = await findGradingWeights({
    apiKey: state.apiKey,
    course: state.courses.find((c) => String(c.id) === model.id),
    canvasGroups: model.groups.map((g) => g.name),
    model: state.claudeModel,
  });
  button.disabled = false;
  if (result.error) {
    status.textContent = result.error;
    return;
  }
  state.gradeSyllabusWeights = { ...state.gradeSyllabusWeights, [model.id]: result };
  storage.save({ gradeSyllabusWeights: state.gradeSyllabusWeights });
  plan.weightSource = result.found ? "syllabus" : "canvas";
  savePlan();
  renderAll();
});

// ---------- The model with hypothetical assignments added ----------

// True when Canvas's group weights can be used as they are: weighted, and not every group
// at the same weight (a course that sets them all alike hasn't really weighted anything).
function canvasWeightsUsable(m) {
  const weights = m.groups.map((g) => g.weight);
  if (!m.weighted || !weights.some((w) => w > 0)) return false;
  return weights.length === 1 || new Set(weights).size > 1;
}

// The syllabus's weights by Canvas group name, when they're in use.
function syllabusWeights() {
  if (plan.weightSource !== "syllabus") return null;
  return state.gradeSyllabusWeights[model.id]?.byName ?? null;
}

function fullModel() {
  const byName = syllabusWeights();
  return {
    ...model,
    weighted: byName ? true : model.weighted,
    groups: model.groups.map((g) => ({
      ...g,
      weight: byName ? (byName[g.name] ?? 0) : g.weight,
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
  saveTimer = setTimeout(() => {
    state.gradeWhatIfs = { ...state.gradeWhatIfs, [model.id]: plan };
    storage.save({ gradeWhatIfs: state.gradeWhatIfs });
  }, 300);
}

// ---------- Rendering ----------

function renderCourseNotes() {
  const notes = [];
  if (model.hideTotals) {
    notes.push("Your instructor hides the course total in Canvas, so this calculation can't be checked against Canvas.");
  }
  if (model.groups.some((g) => g.items.some((i) => i.status === "hidden"))) {
    notes.push("Some grades aren't posted yet. They're treated as ungraded until your instructor posts them.");
  }
  $("gc-course-notes").replaceChildren(...notes.map((n) => el("p", "notice-banner", n)));
}

function renderAll() {
  const m = fullModel();
  rows.clear();
  $("gc-groups").replaceChildren(...m.groups.map((g) => renderGroup(g, m.weighted)));
  $("gc-add-group").replaceChildren(...model.groups.map((g) => new Option(g.name, g.id)));
  $("gc-add-form").hidden = !model.groups.length;
  fillNeedSelect(m);
  renderWeightControls();
  refresh();
}

function renderWeightControls() {
  const syllabus = state.gradeSyllabusWeights[model.id];
  $("gc-weight-source").value = plan.weightSource;
  $("gc-weight-source").querySelector('option[value="syllabus"]').disabled = !syllabus?.byName;
  const notes = [];
  if (!syllabus) {
    if (!canvasWeightsUsable(model)) notes.push("Canvas doesn't weight these groups. Read the syllabus to use its weights.");
  } else if (!syllabus.found) {
    notes.push("The syllabus doesn't list grade weights.");
  } else if (syllabus.unmatched.length) {
    const names = syllabus.unmatched.map((u) => `${u.name} (${round2(u.weight)}%)`).join(", ");
    notes.push(`Not matched to a Canvas group, so not counted: ${names}.`);
  }
  $("gc-weights-status").textContent = notes.join(" ");
}

function renderGroup(group, weighted) {
  const card = el("section", "card group");
  const head = el("div", "group-head");
  const title = el("div");
  title.append(el("h2", null, group.name));
  const facts = [];
  if (weighted) facts.push(`${round2(group.weight)}% of grade`);
  if (group.rules.dropLowest) facts.push(`drops lowest ${group.rules.dropLowest}`);
  if (group.rules.dropHighest) facts.push(`drops highest ${group.rules.dropHighest}`);
  if (facts.length) title.append(el("div", "group-facts", facts.join(" · ")));
  const summary = el("div", "group-summary");
  summary.id = `group-sum-${group.id}`;
  head.append(title, summary);
  card.append(head);

  if (!group.items.length) card.append(el("p", "hint empty-group", "No assignments in this group yet."));
  for (const item of group.items) card.append(renderRow(item));
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
  const label = item.kind === "hypothetical" ? "Hypothetical" : editing && isGraded(item) ? "What-if (edited)" : STATUS_LABELS[item.status];
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
    score.append(el("span", "hint", `${fmtPts(item.pointsPossible)} pts`));
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
  const current = computeGrade(m, currentValue);
  const projected = computeGrade(m, projectedValue);
  const currentLetter = letterFor(current.percent, model.scheme);
  const projectedLetter = letterFor(projected.percent, model.scheme);

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

  renderCanvasCheck(current.percent);
  $("gc-grading-mode").textContent = [
    m.weighted ? (syllabusWeights() ? "Weighted by the syllabus." : "Weighted by assignment group.") : "Based on total points.",
    model.schemeSource === "course" ? "Letters use this course's grading scheme." : "Letters use a standard scale (A = 94%+), since the course's scheme isn't visible.",
  ].join(" ");

  for (const g of projected.groups) {
    const now = current.groups.find((c) => c.id === g.id);
    const pct = (x) => (x.possible > 0 ? `${round2((x.score / x.possible) * 100)}%` : "—");
    const node = $(`group-sum-${g.id}`);
    if (node) node.textContent = `Now ${pct(now)} · Projected ${pct(g)}`;
  }

  for (const [id, parts] of rows) {
    const value = projectedValue(parts.item);
    const pts = parts.item.pointsPossible;
    parts.pct.textContent = parts.item.counts && value != null && pts > 0 ? `${round2((value / pts) * 100)}%` : "";
    parts.row.classList.toggle("dropped", projected.dropped.has(id));
    if (parts.clear) parts.clear.disabled = value == null;
    if (parts.item.kind === "canvas" && !isGraded(parts.item) && parts.item.counts) {
      parts.pill.className = `pill ${value == null ? "open" : "whatif"}`;
    }
  }

  renderNeed(m);
}

function renderCanvasCheck(currentPercent) {
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
      check.textContent = `⚠ Canvas shows ${fmtPct(model.canvasScore)}, ${round2(diff)} points different. Canvas may be counting something this page can't see, such as grading periods or grades not yet posted.`;
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
  const item = m.groups.flatMap((g) => g.items).find((i) => i.id === $("gc-need-item").value);
  if (!item) {
    out.replaceChildren(el("p", "hint", "Everything is graded. Add a hypothetical assignment (like your final) to see what you'd need on it."));
    return;
  }
  const list = el("ul", "need-list");
  for (const target of targetsFor(model.scheme)) {
    const result = scoreNeeded(m, projectedValue, item, target.min);
    const li = el("li");
    li.append(el("span", "need-letter", `${target.name} (${target.min}%+)`));
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

// ---------- Set all / clear / add ----------

$("gc-set-all").addEventListener("click", () => {
  const pct = Number($("gc-set-all-pct").value);
  if (!Number.isFinite(pct) || pct < 0) return;
  for (const item of fullModel().groups.flatMap((g) => g.items.filter(isOpen))) {
    plan.overrides[item.id] = round2((item.pointsPossible * pct) / 100);
  }
  savePlan();
  renderAll();
});

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
