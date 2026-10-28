import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { computeGrade, letterFor, meetsCutoff, scoreNeeded, targetsFor } from "../src/grade-math.js";
import { formatCutoff, normalizeScheme, resolveGradeScale } from "../src/grade-scale.js";
import { loadCourseGrades } from "../src/grade-data.js";
import { readSyllabusGrading, syllabusFingerprint, SYLLABUS_GRADING_VERSION } from "../src/grade-weights.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const scale = normalizeScheme([
  { name: "A+", min: 93, inclusive: false },
  { name: "A", min: 90, inclusive: true },
  { name: "B", min: 80, inclusive: true },
  { name: "F", min: 0, inclusive: true },
]);
const final = { id: "final", counts: true, pointsPossible: 100 };
const single = { weighted: false, groups: [{ id: "all", rules: {}, items: [final] }] };

test("above 93 accepts 93.01 and excludes exactly 93 without assuming 94", () => {
  assert.equal(letterFor(93, scale), "A");
  assert.equal(letterFor(93.0001, scale), "A+");
  assert.equal(letterFor(93.01, scale), "A+");
  assert.equal(formatCutoff(scale[0]), ">93%");
  assert.equal(formatCutoff(scale[1]), "≥90%");
  assert.equal(meetsCutoff(93, { min: 93 }), true);
  assert.equal(meetsCutoff(93, { min: 93, inclusive: false }), false);
});

test("letters use unrounded totals even when the displayed percentage rounds up", () => {
  const grade = computeGrade(single, () => 92.9999);
  assert.equal(grade.percent, 93);
  assert.equal(letterFor(grade.exact, [{ name: "A", min: 93 }, { name: "B", min: 80 }]), "B");
  const justAbove = computeGrade(single, () => 93.0001);
  assert.equal(justAbove.percent, 93);
  assert.equal(letterFor(justAbove.exact, scale), "A+");
});

test("minimum scores distinguish strict and inclusive boundaries to a hundredth point", () => {
  assert.deepEqual(scoreNeeded(single, () => null, final, scale[0]), { status: "needed", points: 93.01 });
  assert.deepEqual(scoreNeeded(single, () => null, final, 93), { status: "needed", points: 93 });
  assert.equal(scoreNeeded(single, () => null, final, { min: 93.0001 }).points, 93.01);
});

test("weighted targets return the smallest accepted score, including strict boundaries", () => {
  const known = { id: "known", counts: true, pointsPossible: 100 };
  const model = { weighted: true, groups: [
    { id: "work", weight: 80, rules: {}, items: [known] },
    { id: "exam", weight: 20, rules: {}, items: [final] },
  ] };
  const value = (item) => item === known ? 94 : null;
  assert.equal(scoreNeeded(model, value, final, { min: 93 }).points, 89);
  const result = scoreNeeded(model, value, final, scale[0]);
  assert.equal(result.points, 89.01);
  assert(meetsCutoff(computeGrade(model, (item) => item === final ? result.points : value(item)).exact, scale[0]));
  assert(!meetsCutoff(computeGrade(model, (item) => item === final ? result.points - 0.01 : value(item)).exact, scale[0]));
});

test("boundary noise does not award an exclusive grade or add a cent to inclusive targets", () => {
  assert.equal(meetsCutoff(93.00000000000001, scale[0]), false);
  assert.equal(meetsCutoff(92.99999999999999, { min: 93 }), true);
  assert.equal(scoreNeeded(single, () => null, final, 88).points, 88);
});

test("targets preserve A+, A-, and pass/fail labels without relabeling a grade as A", () => {
  assert.deepEqual(targetsFor(scale).map((entry) => entry.name), ["A+", "A", "B"]);
  assert.deepEqual(targetsFor([{ name: "A+", min: 93 }, { name: "A-", min: 87 }, { name: "F", min: 0 }]).map((entry) => entry.name), ["A+", "A-"]);
  assert.deepEqual(targetsFor([{ name: "Pass", min: 70 }, { name: "Fail", min: 0 }]).map((entry) => entry.name), ["Pass"]);
});

test("unknown and incomplete scales do not invent a letter grade", () => {
  assert.equal(letterFor(94, []), null);
  assert.equal(letterFor(70, [{ name: "A", min: 90 }]), null);
  const result = resolveGradeScale({ scheme: [] }, null, null);
  assert.equal(result.schemeSource, "unknown");
  assert.deepEqual(result.scheme, []);
  assert.equal(computeGrade(single, () => 93.01).percent, 93.01);
});

test("syllabus letters work without syllabus weights, and custom scales are separate per course", () => {
  const base = { scheme: [{ name: "A", min: 94 }, { name: "F", min: 0 }] };
  const syllabus = { found: false, components: [], letterGrades: scale };
  const detected = resolveGradeScale(base, syllabus, null);
  assert.equal(detected.schemeSource, "syllabus");
  assert.equal(letterFor(93.01, detected.scheme), "A+");
  assert.equal(detected.notices.length, 1);
  const override = [{ name: "A", min: 85.5 }, { name: "F", min: 0 }];
  assert.equal(resolveGradeScale(base, syllabus, override).schemeSource, "custom");
  assert.equal(letterFor(86, resolveGradeScale(base, syllabus, override).scheme), "A");
  assert.equal(letterFor(86, resolveGradeScale(base, syllabus, null).scheme), "B");
});

test("scale validation rejects ambiguous entries instead of accepting partial malformed scales", () => {
  for (const entries of [
    [{ name: "A", min: "93" }], [{ name: "A", min: NaN }],
    [{ name: "A", min: 93 }, { name: "a", min: 80 }],
    [{ name: "A", min: 93 }, { name: "B", min: 93 }],
    [{ name: "A", min: -1 }], [{ name: "A", min: 101 }],
    [{ name: "A", min: 93, inclusive: "false" }],
  ]) assert.deepEqual(normalizeScheme(entries), []);
  assert.equal(normalizeScheme([{ name: "A−", min: 89.125 }])[0].name, "A-");
});

function mockClient({ standard, hidden = false, account = false } = {}) {
  const paths = [];
  return {
    base: "https://test.instructure.com", paths,
    async get(path) {
      paths.push(path);
      if (path.includes("grading_standards")) {
        if (hidden || (account && !path.includes("/accounts/"))) throw new Error("Forbidden");
        return standard;
      }
      return { id: 1, name: "Biology", grading_standard_id: 7, account_id: 20 };
    },
    async getAll(path) {
      paths.push(path);
      if (hidden && path.includes("grading_standards")) throw new Error("Forbidden");
      return [];
    },
  };
}

test("Canvas decimal cutoffs retain precision and account-owned scales can be read", async () => {
  const client = mockClient({ account: true, standard: { grading_scheme: [
    { name: "A+", value: 0.930001 }, { name: "A", value: 0.9 }, { name: "F", value: 0 },
  ] } });
  const course = await loadCourseGrades(client, "1");
  assert.equal(course.scheme[0].min, 93.0001);
  assert.equal(course.schemeSource, "course");
  assert(client.paths.includes("/api/v1/accounts/20/grading_standards/7"));
});

test("inaccessible Canvas schemes stay unknown instead of using 94 percent", async () => {
  const course = await loadCourseGrades(mockClient({ hidden: true }), "1");
  assert.deepEqual(course.scheme, []);
  assert.equal(course.schemeSource, "unknown");
});

test("syllabus cache detects text changes of the same length", () => {
  const course = (text) => ({ sources: [{ title: "Syllabus", kind: "text", text }] });
  assert.notEqual(syllabusFingerprint(course("A > 93")), syllabusFingerprint(course("A > 94")));
});

test("syllabus extraction returns letter cutoffs independently of weights and versions the cache", async () => {
  const result = { found: false, components: [], letterGrades: scale.map((entry) => ({ ...entry, evidence: `${entry.name} ${formatCutoff(entry)}` })) };
  let request;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    const events = [
      ["message_start", { type: "message_start", message: { id: "test", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(result) } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const extracted = await readSyllabusGrading({
    apiKey: "test-key", course: { name: "Biology", sources: [{ title: "Syllabus", kind: "text", text: "A+ above 93%. Graded by total points." }] }, canvasGroups: [],
  });
  assert.equal(extracted.found, false);
  assert.equal(extracted.letterGrades[0].min, 93);
  assert.equal(extracted.letterGrades[0].inclusive, false);
  assert.equal(extracted.version, SYLLABUS_GRADING_VERSION);
  assert(request.output_config.format.schema.required.includes("letterGrades"));
});
