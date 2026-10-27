import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGrade, currentValue } from "../src/grade-math.js";
import { applySyllabus, canvasWeightsUsable, syllabusInUse } from "../src/grade-syllabus.js";
import { syllabusFingerprint } from "../src/grade-weights.js";

const item = (id, name, score, total = 10) => ({
  id, name, kind: "canvas", counts: true, pointsPossible: total, status: score == null ? "ungraded" : "graded", realScore: score,
});
const rules = (dropLowest = 0) => ({ dropLowest, dropHighest: 0, neverDrop: new Set() });
const component = (name, weight, group, extra = {}) => ({
  name, weight, weightStated: true, group, dropLowest: 0, dropHighest: 0, date: "", ...extra,
});

function canvasCourse(weights = [25, 25, 25]) {
  return {
    id: "1",
    weighted: true,
    groups: [
      { id: "g1", name: "Homework", weight: weights[0], rules: rules(), items: [item("h1", "HW 1", 10), item("h2", "HW 2", 8)] },
      { id: "g2", name: "Quizzes", weight: weights[1], rules: rules(2), items: [item("q1", "Quiz 1", 5), item("q2", "Quiz 2", 9)] },
      { id: "g3", name: "Exams", weight: weights[2], rules: rules(), items: [item("e1", "Midterm 1", 80, 100)] },
    ],
  };
}

const syllabus = {
  found: true,
  components: [
    component("Homework", 20, "Homework"),
    component("Quizzes", 20, "Quizzes", { dropLowest: 1 }),
    component("Midterm 1", 20, "Exams"),
    component("Final Exam", 40, "", { date: "2026-12-12" }),
  ],
};

test("Canvas weights count only when they're real", () => {
  assert.equal(canvasWeightsUsable(canvasCourse([25, 25, 25])), false); // all alike
  assert.equal(canvasWeightsUsable(canvasCourse([20, 30, 50])), true);
  assert.equal(canvasWeightsUsable({ ...canvasCourse([20, 30, 50]), weighted: false }), false);
});

test("without a syllabus reading, Canvas's model is used as is", () => {
  const base = canvasCourse();
  const out = applySyllabus(base, null);
  assert.equal(out.model, base);
  assert.equal(out.table.source, "canvas");
  assert.deepEqual(out.notices, []);
});

test("syllabus weights and drop rules replace Canvas's", () => {
  const { model, table } = applySyllabus(canvasCourse(), syllabus);
  assert.equal(table.source, "syllabus");
  assert.deepEqual(model.groups.map((g) => g.weight), [20, 20, 20, 40]);
  assert.equal(model.groups[1].rules.dropLowest, 1); // syllabus's 1 over Canvas's 2
  assert.equal(table.total, 100);
});

test("Canvas's drop rule stays when the syllabus says nothing about drops", () => {
  const silent = { found: true, components: [component("Quizzes", 100, "Quizzes")] };
  assert.equal(applySyllabus(canvasCourse(), silent).model.groups[1].rules.dropLowest, 2);
});

test("syllabus items missing from Canvas become cards, with the instruction kept apart from the fact", () => {
  const { model, notices } = applySyllabus(canvasCourse(), syllabus);
  const card = model.groups.at(-1);
  assert.equal(card.syllabusOnly, true);
  assert.equal(card.items[0].kind, "syllabus");
  assert.equal(card.items[0].syllabusDate, "2026-12-12");
  const missing = notices.find((n) => n.text.startsWith("In the syllabus but not in Canvas yet"));
  assert.equal(missing.kind, "conflict");
  assert.ok(!missing.text.includes("enter a score"));
  assert.ok(missing.hint.includes("enter a score"));
});

test("a card disappears once Canvas posts the assignment", () => {
  const base = canvasCourse();
  base.groups[2].items.push(item("e2", "Final", null, 100));
  const { model } = applySyllabus(base, syllabus);
  assert.equal(model.groups.length, 3);
  assert.equal(model.groups[2].weight, 60); // Midterm 1 + Final Exam
});

test("a component with no stated weight isn't counted", () => {
  const unweighted = { found: true, components: [component("Homework", 100, "Homework"), component("Participation", 0, "", { weightStated: false })] };
  const { model, notices } = applySyllabus(canvasCourse(), unweighted);
  assert.equal(model.groups.at(-1).items[0].counts, false);
  assert.ok(notices.some((n) => n.text.includes("Participation") && n.text.includes("no weight")));
});

test("weight conflicts are flagged only when Canvas has real weights", () => {
  const conflict = (base) => applySyllabus(base, syllabus).notices.find((n) => n.text.startsWith("Canvas and the syllabus disagree"));
  assert.equal(conflict(canvasCourse([25, 25, 25])), undefined);
  assert.ok(conflict(canvasCourse([30, 30, 40])).text.includes("Homework (Canvas 30%, syllabus 20%)"));
});

test("weights that don't total 100 are noted", () => {
  const short = { found: true, components: [component("Homework", 40, "Homework"), component("Quizzes", 50, "Quizzes")] };
  assert.ok(applySyllabus(canvasCourse(), short).notices.some((n) => n.text.includes("add up to 90%")));
});

test("the applied model grades like the calculator", () => {
  const { model } = applySyllabus(canvasCourse(), syllabus);
  // Homework 90% x 20, Quizzes 9/10 x 20 (Quiz 1 dropped), Midterm 80% x 20, out of 60.
  assert.equal(computeGrade(model, currentValue).percent, 86.67);
});

test("the student's weight choice picks the syllabus or Canvas", () => {
  assert.equal(syllabusInUse(syllabus, {}), syllabus);
  assert.equal(syllabusInUse(syllabus, { weightSource: "canvas" }), null);
  assert.equal(syllabusInUse({ found: false, components: [] }, {}), null);
  assert.equal(syllabusInUse(undefined, {}), null);
});

test("the syllabus fingerprint changes with any edit, even one of the same length", async () => {
  const course = (text) => ({ sources: [{ kind: "text", title: "Syllabus page", text }, { kind: "text", title: "Canvas assignments", text: "x", assignments: true }] });
  const a = await syllabusFingerprint(course("Homework 20%"));
  assert.equal(a, await syllabusFingerprint(course("Homework 20%")));
  assert.notEqual(a, await syllabusFingerprint(course("Homework 30%")));
  // The Canvas assignment summary doesn't count.
  const withoutSummary = await syllabusFingerprint({ sources: [{ kind: "text", title: "Syllabus page", text: "Homework 20%" }] });
  assert.equal(a, withoutSummary);
});
