import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGrade, currentValue, dropAssignments, letterFor, scoreNeeded, targetsFor, whatIfValue, withHypotheticals,
  DEFAULT_SCHEME,
} from "../src/grade-math.js";

const item = (id, score, total = 10, extra = {}) => ({
  id, name: id, kind: "canvas", counts: true, pointsPossible: total,
  status: score == null ? "ungraded" : "graded", realScore: score, ...extra,
});
const rules = (dropLowest = 0, dropHighest = 0, neverDrop = []) => ({ dropLowest, dropHighest, neverDrop: new Set(neverDrop) });
const group = (id, weight, items, r = rules()) => ({ id, name: id, weight, rules: r, items });

test("unweighted courses use total points", () => {
  const model = { weighted: false, groups: [group("hw", 0, [item("a", 8), item("b", 6)]), group("ex", 0, [item("c", 90, 100)])] };
  assert.equal(computeGrade(model, currentValue).percent, 86.67); // 104 / 120
});

test("weighted courses scale up when a group has nothing graded yet", () => {
  const model = { weighted: true, groups: [group("hw", 40, [item("a", 9)]), group("ex", 60, [item("c", null, 100)])] };
  assert.equal(computeGrade(model, currentValue).percent, 90); // only Homework counts so far
});

test("ungraded, excused and not-counted work is left out", () => {
  const model = {
    weighted: false,
    groups: [group("hw", 0, [item("a", 10), item("b", null), item("c", 0, 10, { counts: false, status: "excused" })])],
  };
  assert.equal(computeGrade(model, currentValue).percent, 100);
});

test("drops wait until every assignment in the group has a score", () => {
  const model = { weighted: false, groups: [group("q", 0, [item("a", 5), item("b", 9), item("c", null)], rules(1))] };
  const held = computeGrade(model, currentValue);
  assert.equal(held.percent, 70);
  assert.deepEqual([...held.held], ["q"]);
  assert.equal(held.dropped.size, 0);

  const graded = computeGrade(model, (i) => (i.id === "c" ? 7 : currentValue(i)));
  assert.deepEqual([...graded.dropped], ["a"]);
  assert.equal(graded.percent, 80); // (9 + 7) / 20
});

test("applyDrops drops from the scores so far, like Canvas", () => {
  const model = { weighted: false, groups: [group("q", 0, [item("a", 5), item("b", 9), item("c", null)], rules(1))] };
  const r = computeGrade(model, currentValue, { applyDrops: true });
  assert.equal(r.percent, 90);
  assert.equal(r.held.size, 0);
  assert.deepEqual([...r.dropped], ["a"]);
});

test("drop lowest keeps the best group percentage and never drops protected work", () => {
  const subs = [
    { item: { id: "a" }, score: 5, total: 10 },
    { item: { id: "b" }, score: 40, total: 100 },
    { item: { id: "c" }, score: 9, total: 10 },
  ];
  // Dropping the 40/100 leaves 14/20 = 70%; dropping the 5/10 leaves 49/110 = 45%.
  assert.deepEqual(dropAssignments(subs, rules(1)).map((s) => s.item.id).sort(), ["a", "c"]);
  assert.deepEqual(dropAssignments(subs, rules(1, 0, ["b"])).map((s) => s.item.id).sort(), ["b", "c"]);
});

test("scoreNeeded finds the lowest score for a target", () => {
  const model = { weighted: true, groups: [group("hw", 50, [item("a", 8)]), group("final", 50, [item("f", null, 100)])] };
  const final = model.groups[1].items[0];
  assert.deepEqual(scoreNeeded(model, currentValue, final, 90), { status: "needed", points: 100 });
  assert.deepEqual(scoreNeeded(model, currentValue, final, 70), { status: "needed", points: 60 });
  assert.equal(scoreNeeded(model, currentValue, final, 99).status, "needed"); // more than full credit is still reported
  assert.equal(scoreNeeded(model, currentValue, final, 40).status, "secured");
});

test("what-if scores and hypothetical assignments", () => {
  const model = { weighted: false, groups: [group("hw", 0, [item("a", 6), item("b", null)])] };
  const full = withHypotheticals(model, [{ id: "h", name: "Extra", groupId: "hw", pointsPossible: 10 }]);
  assert.equal(full.groups[0].items.length, 3);
  assert.equal(full.groups[0].items[2].kind, "hypothetical");
  const overrides = { a: 10, b: 8, h: 9 };
  assert.equal(computeGrade(full, (i) => whatIfValue(overrides, i)).percent, 90); // 27 / 30
  assert.equal(computeGrade(full, currentValue).percent, 60);
});

test("letters and targets from a scheme", () => {
  assert.equal(letterFor(93.99, DEFAULT_SCHEME), "A-");
  assert.equal(letterFor(94, DEFAULT_SCHEME), "A");
  assert.equal(letterFor(null, DEFAULT_SCHEME), null);
  assert.deepEqual(targetsFor(DEFAULT_SCHEME), [{ name: "A", min: 94 }, { name: "B", min: 84 }, { name: "C", min: 74 }]);
});
