// The Export card in the site's Settings. Gathers everything the site knows about the
// chosen courses (grades and what-if scores loaded fresh from Canvas, the grading
// breakdown, exams and syllabus text) into one Markdown document, written to be pasted
// into another AI assistant that reviews how the student is doing and what to do next.

import { CanvasClient } from "./canvas.js";
import { loadCourseGrades, STATUS_LABELS } from "./grade-data.js";
import {
  computeGrade, currentValue, isGraded, letterFor, round2, scoreNeeded, targetsFor, whatIfValue, withHypotheticals,
} from "./grade-math.js";
import { applySyllabus, dropText, syllabusInUse } from "./grade-syllabus.js";
import { courseLabel } from "./prompt.js";
import { formatDay, formatTime, mapLimit } from "./util.js";

const CANVAS_AT_ONCE = 3; // courses loaded from Canvas at the same time
const LONG_DATE = { weekday: "short", month: "short", day: "numeric", year: "numeric" };

export async function buildExport(state, courses, onProgress = () => {}) {
  const client = new CanvasClient(state.canvasUrl);
  let done = 0;
  onProgress(`Loading ${courses.length} course${courses.length === 1 ? "" : "s"} from Canvas…`);
  const parts = await mapLimit(courses, CANVAS_AT_ONCE, async (course) => {
    const text = await courseSection(state, course, client);
    onProgress(`Loaded ${++done} of ${courses.length}…`);
    return text;
  });
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return [
    `# My courses (exported ${today})`,
    "",
    "I'm a student. Below is everything my course helper knows about my classes: my grades from Canvas, how each course is graded, my exams, and the syllabi. Please look at how I'm doing in each course and tell me what I need to do to reach the grades I want, including which upcoming work matters most.",
    "",
    "How to read this:",
    `- Today is ${today}.`,
    "- Scores are points earned / points possible. \"What-if\" scores are my own guesses, not real grades.",
    "- Weights and drop rules come from the syllabus where it gives them, otherwise from Canvas. Each course says which.",
    "- \"Score needed\" assumes the rest of my work stays as listed, with ungraded work left out.",
    "",
    ...parts,
  ].join("\n");
}

async function courseSection(state, course, client) {
  const out = [`## ${courseLabel(course)}${course.term ? `, ${course.term}` : ""}`, ""];
  try {
    const base = await loadCourseGrades(client, course.id);
    const plan = state.gradeWhatIfs[course.id] ?? {};
    out.push(...gradeLines(base, plan, state.gradeSyllabus[course.id]));
  } catch (e) {
    out.push("### Grades", gradeError(e), "");
    out.push(...savedBreakdownLines(state.gradeSyllabus[course.id]));
  }
  out.push(...examLines(state, course), ...syllabusLines(course));
  return out.join("\n");
}

function gradeError(e) {
  if (e.message === "not-logged-in") return "Couldn't load grades: not signed in to Canvas.";
  if (e.message === "grades-hidden") return "This course doesn't show its grades to students.";
  if (e instanceof TypeError) return "Couldn't reach Canvas to load grades.";
  return `Couldn't load grades: ${e.message}`;
}

const fmt = (x) => String(round2(x));
const pct = (score, possible) => (possible > 0 ? `${round2((score / possible) * 100)}%` : "—");

// The same numbers the Grade Calculator shows for this course.
function gradeLines(base, plan, syllabus) {
  const applied = applySyllabus(base, syllabusInUse(syllabus, plan));
  const overrides = plan.overrides ?? {};
  const model = withHypotheticals(applied.model, plan.hypotheticals);
  const projectedValue = (item) => whatIfValue(overrides, item);
  const options = { applyDrops: Boolean(plan.applyDrops) };
  const current = computeGrade(model, currentValue, options);
  const projected = computeGrade(model, projectedValue, options);
  const grade = (r) => (r.percent == null ? "nothing graded yet" : `${r.percent.toFixed(2)}% (${letterFor(r.percent, model.scheme)})`);
  const hasWhatIfs = Object.keys(overrides).length > 0 || (plan.hypotheticals ?? []).length > 0;

  const lines = ["### Grades", `- Current grade, graded work only: ${grade(current)}`];
  if (hasWhatIfs) lines.push(`- Projected with my what-if scores: ${grade(projected)}`);
  if (!model.hideTotals && model.canvasScore != null) lines.push(`- Canvas reports: ${model.canvasScore.toFixed(2)}%`);
  lines.push(
    `- Weights from: ${applied.table.source === "syllabus" ? "the syllabus" : model.weighted ? "Canvas" : "Canvas (total points, not weighted)"}`,
    `- Drops: ${options.applyDrops ? "applied to the scores so far" : "only once every assignment in the group is graded"}`,
    `- Letter scale${model.schemeSource === "course" ? "" : " (standard, the course's own isn't visible)"}: ${model.scheme.map((s) => `${s.name} ${s.min}%`).join(", ")}`,
    "",
    "### Grading breakdown",
    "| Category | Weight | Rules | My score now |",
    "|---|---|---|---|"
  );
  for (const g of model.groups) {
    const now = current.groups.find((x) => x.id === g.id);
    const rules = [dropText(g.rules), g.syllabusOnly ? "in the syllabus, not in Canvas yet" : ""].filter(Boolean).join("; ");
    lines.push(`| ${g.name} | ${model.weighted ? `${round2(g.weight)}%` : "—"} | ${rules || "—"} | ${pct(now.score, now.possible)} |`);
  }
  if (model.weighted) lines.push(`| Total | ${applied.table.total}% | | |`);
  for (const n of applied.notices) lines.push("", `Note: ${n.text}`);
  lines.push("");

  lines.push("### Assignments");
  for (const g of model.groups) {
    lines.push(`#### ${g.name}`);
    if (!g.items.length) lines.push("- No assignments yet.");
    for (const item of g.items) lines.push(`- ${itemLine(item, overrides, projected.dropped)}`);
    lines.push("");
  }

  const needed = neededLines(model, projectedValue, options);
  if (needed.length) lines.push("### Score needed for each letter", ...needed, "");
  return lines;
}

function itemLine(item, overrides, dropped) {
  const points = fmt(item.pointsPossible);
  const parts = [];
  if (isGraded(item)) parts.push(`${fmt(item.realScore)} / ${points} (${pct(item.realScore, item.pointsPossible)})`);
  else parts.push(`${item.kind === "hypothetical" ? "hypothetical, not in Canvas" : STATUS_LABELS[item.status]?.toLowerCase() ?? item.status}, out of ${points}`);
  if (item.id in overrides) parts.push(`my what-if: ${fmt(overrides[item.id])} / ${points}`);
  if (item.dueAt) parts.push(`due ${new Date(item.dueAt).toLocaleDateString("en-US", LONG_DATE)}`);
  else if (item.kind === "syllabus") parts.push(item.syllabusDate ? `on ${formatDay(item.syllabusDate, LONG_DATE)}` : "no date given");
  if (dropped.has(item.id)) parts.push("dropped");
  return `${item.name}: ${parts.join(", ")}`;
}

// For exams and syllabus-only items still to come: what's needed on each for an A, B and C.
function neededLines(model, valueOf, options) {
  const targets = targetsFor(model.scheme);
  const open = model.groups.flatMap((g) => g.items).filter(
    (i) => i.counts && !isGraded(i) && (i.kind === "syllabus" || /final|midterm|exam|test/i.test(i.name))
  );
  return open.map((item) => {
    const results = targets.map((t) => {
      const r = scoreNeeded(model, valueOf, item, t.min, options);
      if (r.status === "secured") return `${t.name}: already secured`;
      if (r.status === "unreachable") return `${t.name}: not reachable on this alone`;
      return `${t.name}: ${fmt(r.points)} / ${fmt(item.pointsPossible)} (${pct(r.points, item.pointsPossible)})`;
    });
    return `- ${item.name}: ${results.join("; ")}`;
  });
}

// When grades can't load, what was read from the syllabus still helps.
function savedBreakdownLines(syllabus) {
  if (!syllabus?.found) return [];
  return [
    "### Grading breakdown (from the syllabus)",
    ...syllabus.components.map((c) =>
      `- ${c.name}: ${c.weightStated ? `${round2(c.weight)}%` : "no weight listed"}${dropText(c) ? `, ${dropText(c)}` : ""}${c.date ? `, on ${formatDay(c.date, LONG_DATE)}` : ""}`
    ),
    "",
  ];
}

function examLines(state, course) {
  const found = state.exams[course.id]?.exams ?? [];
  const manual = state.manualExams.filter((e) => e.courseId === course.id);
  const exams = [...found, ...manual].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  if (!exams.length) return ["### Exams", state.exams[course.id] ? "- None found in the syllabus." : "- Not scanned yet.", ""];
  return [
    "### Exams",
    ...exams.map((e) => {
      const time = e.startTime ? [e.startTime, e.endTime].filter(Boolean).map(formatTime).join("–") : "";
      const parts = [e.date ? formatDay(e.date, LONG_DATE) : "date not announced", time, e.place, e.materials ? `covers: ${e.materials}` : ""];
      return `- ${e.name} (${e.kind}): ${parts.filter(Boolean).join(", ")}`;
    }),
    "",
  ];
}

function syllabusLines(course) {
  const sources = course.sources.filter((s) => !s.assignments);
  if (!sources.length) return ["### Syllabus", "No syllabus was found for this course.", ""];
  return sources.flatMap((s) => [
    `### Syllabus: ${s.title}`,
    s.kind === "pdf" ? "(A PDF file; its text isn't included here.)" : s.text,
    "",
  ]);
}

export function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
