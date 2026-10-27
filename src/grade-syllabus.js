import { round2 } from "./grade-math.js";
import { formatDay } from "./util.js";

// Combines a course's Canvas grades (grade-data.js) with what its syllabus says about
// grading (grade-weights.js). The syllabus wins: its weights replace Canvas's, its drop
// rules replace Canvas's where it states one, and graded items it lists that Canvas
// doesn't have yet become placeholder cards worth the weight the syllabus gives them.
// Where the two disagree, the result carries notices so the page can say so.

const TOLERANCE = 0.5; // percentage points of difference before weights count as different

// True when Canvas's group weights are real: the course is weighted and the groups
// don't all share one weight (a course that sets them all alike hasn't weighted anything).
export function canvasWeightsUsable(model) {
  const weights = model.groups.map((g) => g.weight);
  if (!model.weighted || !weights.some((w) => w > 0)) return false;
  return weights.length === 1 || new Set(weights).size > 1;
}

// The syllabus reading to apply, given the student's saved choice (plan.weightSource),
// or null to use Canvas's weights.
export function syllabusInUse(syllabus, plan) {
  return syllabus?.found && plan?.weightSource !== "canvas" ? syllabus : null;
}

export function dropText(rules) {
  const parts = [];
  if (rules.dropLowest) parts.push(`drops lowest ${rules.dropLowest}`);
  if (rules.dropHighest) parts.push(`drops highest ${rules.dropHighest}`);
  return parts.join(" · ");
}

// "Final Exam" and "Final" are the same assignment; "Final Project" is not.
const norm = (s) => s.toLowerCase().replace(/\b(exam|test)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// The Canvas group a syllabus component belongs to: the one Claude named, or else the one
// holding an assignment with the same name (Canvas may have posted it since the syllabus was read).
function findCanvasGroup(model, component) {
  const named = model.groups.find((g) => g.name === component.group);
  if (named) return named;
  const wanted = norm(component.name);
  if (!wanted) return null;
  return model.groups.find((g) => g.items.some((i) => norm(i.name) === wanted)) ?? null;
}

function canvasTable(model) {
  return {
    source: "canvas",
    rows: model.groups.map((g) => ({
      name: g.name,
      weight: model.weighted ? g.weight : null,
      detail: dropText(g.rules),
    })),
    total: model.weighted ? round2(model.groups.reduce((n, g) => n + g.weight, 0)) : null,
  };
}

// base: the model from loadCourseGrades. syllabus: the saved result of readSyllabusGrading,
// or null. Returns { model, table, notices: [{ kind: "conflict" | "info", text, hint? }] },
// where text is the plain fact and hint is what to do about it on the calculator page.
export function applySyllabus(base, syllabus) {
  if (!syllabus?.found) return { model: base, table: canvasTable(base), notices: [] };

  const weights = new Map(); // Canvas group id -> weight from the syllabus
  const drops = new Map(); // Canvas group id -> { dropLowest, dropHighest } from the syllabus
  const missing = []; // components with no Canvas assignment yet
  syllabus.components.forEach((c, i) => {
    const group = findCanvasGroup(base, c);
    if (!group) {
      missing.push({ c, i });
      return;
    }
    weights.set(group.id, (weights.get(group.id) ?? 0) + (c.weightStated ? c.weight : 0));
    if (c.dropLowest || c.dropHighest) {
      const d = drops.get(group.id) ?? { dropLowest: 0, dropHighest: 0 };
      drops.set(group.id, {
        dropLowest: Math.max(d.dropLowest, c.dropLowest),
        dropHighest: Math.max(d.dropHighest, c.dropHighest),
      });
    }
  });

  const canvasGroups = base.groups.map((g) => {
    const d = drops.get(g.id);
    return {
      ...g,
      weight: weights.get(g.id) ?? 0,
      rules: d
        ? { ...g.rules, dropLowest: d.dropLowest || g.rules.dropLowest, dropHighest: d.dropHighest || g.rules.dropHighest }
        : g.rules,
    };
  });

  // One card per syllabus item Canvas doesn't have: a single 100-point item, so a score
  // typed in is a percent. With no stated weight it can't count.
  const placeholders = missing.map(({ c, i }) => ({
    id: `syllabus-${i}`,
    name: c.name,
    weight: c.weightStated ? c.weight : 0,
    syllabusOnly: true,
    rules: { dropLowest: 0, dropHighest: 0, neverDrop: new Set() },
    items: [{
      id: `syllabus-${i}-item`,
      kind: "syllabus",
      name: c.name,
      url: null,
      dueAt: null,
      syllabusDate: c.date || "",
      pointsPossible: 100,
      status: c.weightStated ? "syllabus" : "no-weight",
      counts: c.weightStated,
      realScore: null,
    }],
  }));

  const groups = [...canvasGroups, ...placeholders];
  const notices = [];

  if (canvasWeightsUsable(base)) {
    const differing = base.groups
      .map((g) => ({ name: g.name, canvas: g.weight, syllabus: weights.get(g.id) ?? 0 }))
      .filter((g) => Math.abs(g.canvas - g.syllabus) > TOLERANCE);
    if (differing.length) {
      notices.push({
        kind: "conflict",
        text: `Canvas and the syllabus disagree on some weights. Using the syllabus: ${differing
          .map((g) => `${g.name} (Canvas ${round2(g.canvas)}%, syllabus ${round2(g.syllabus)}%)`)
          .join("; ")}.`,
      });
    }
  }

  const counted = placeholders.filter((p) => p.items[0].counts);
  if (counted.length) {
    notices.push({
      kind: "conflict",
      text: `In the syllabus but not in Canvas yet: ${counted
        .map((p) => `${p.name} (${round2(p.weight)}%, ${p.items[0].syllabusDate ? formatDay(p.items[0].syllabusDate) : "no date given"})`)
        .join("; ")}.`,
      hint: "Added below; enter a score as a percent.",
    });
  }
  const unweighted = placeholders.filter((p) => !p.items[0].counts);
  if (unweighted.length) {
    notices.push({
      kind: "info",
      text: `The syllabus mentions ${unweighted.map((p) => p.name).join(", ")} but gives no weight, so ${unweighted.length === 1 ? "it isn't" : "they aren't"} counted.`,
    });
  }
  const unlisted = base.groups.filter((g) => g.items.length && !weights.has(g.id));
  if (unlisted.length) {
    notices.push({
      kind: "info",
      text: `Not in the syllabus's grading breakdown, so counted as 0%: ${unlisted.map((g) => g.name).join(", ")}.`,
    });
  }

  const total = round2(groups.reduce((n, g) => n + g.weight, 0));
  if (Math.abs(total - 100) > TOLERANCE) {
    notices.push({
      kind: "info",
      text: `The syllabus weights add up to ${total}%. ${total < 100 ? "Like Canvas, the grade is scaled up to 100%." : "They're used as written."}`,
    });
  }

  return {
    model: { ...base, weighted: true, groups },
    table: {
      source: "syllabus",
      rows: groups.map((g) => ({
        name: g.name,
        weight: g.weight,
        detail: [dropText(g.rules), g.syllabusOnly ? "not in Canvas yet" : ""].filter(Boolean).join(" · "),
      })),
      total,
    },
    notices,
  };
}
