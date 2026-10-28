import Anthropic from "@anthropic-ai/sdk";
import { buildContextBlocks, friendlyError, CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "./claude.js";
import { normalizeScheme } from "./grade-scale.js";

export const SYLLABUS_GRADING_VERSION = 2;

// Reads how a course's syllabus grades the course: each component's share of the
// final grade, its drop rules, and its date. The Grade Calculator runs this on its
// own the first time a course is opened and reuses the saved result (see
// grade-syllabus.js for how it's combined with Canvas's groups).

const SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    letterGrades: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          min: { type: "number" },
          inclusive: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["name", "min", "inclusive", "evidence"],
        additionalProperties: false,
      },
    },
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          weight: { type: "number" },
          weightStated: { type: "boolean" },
          group: { type: "string" },
          dropLowest: { type: "integer" },
          dropHighest: { type: "integer" },
          date: { type: "string" },
        },
        required: ["name", "weight", "weightStated", "group", "dropLowest", "dropHighest", "date"],
        additionalProperties: false,
      },
    },
  },
  required: ["found", "components", "letterGrades"],
  additionalProperties: false,
};

const INSTRUCTIONS = `List every component of the final grade as the syllabus describes it: a category (Homework, Quizzes, Labs) or a single graded item (Midterm 1, Final Exam).

For each component give:
- name: as the syllabus calls it.
- weight: its percent of the FINAL grade, as a plain number (20 for 20%). If the syllabus gives a total for a category and then splits it ("Exams 60%: two midterms at 20% each and a final at 20%"), list the items separately with their own percents instead of the category.
- weightStated: false if the syllabus mentions the component but gives no percent for it (then weight is 0), otherwise true.
- group: the exact name of the Canvas assignment group that holds this component's assignments, chosen from the Canvas groups listed below. Use "" if Canvas has no assignment for the component yet (for example a final exam that isn't posted). If its assignments are spread over several groups, name the group that holds most of them.
- dropLowest, dropHighest: how many lowest or highest scores the syllabus drops from this component (0 if it says nothing).
- date: YYYY-MM-DD if the syllabus gives a date for this single item (work out the year from the course term and today's date), otherwise "".

Set found to false, with an empty components list, if the syllabus gives no grade breakdown or says the grade is based on total points.

Independently, read the course's LETTER-GRADE CUTOFFS into letterGrades, even if found is false. Use exactly this course's letter labels, including A+, A, A-, etc., and preserve every decimal. Each entry must have:
- name: the exact grade label.
- min: the literal lower percentage boundary, without rounding or shifting it.
- inclusive: true for "at least", ">=", "≥", "93 and above", or a range starting at 93; false for "above", "over", "greater than", or ">".
- evidence: the short exact syllabus excerpt that establishes this grade and boundary.
For example, "A+ above 93%" means {"name":"A+","min":93,"inclusive":false,"evidence":"A+ above 93%"}. It DOES NOT mean 94, and 93.01 qualifies. "A: 93–100" means min 93, inclusive true. "A-: 90–92.99" means min 90, inclusive true.
Never substitute a standard 94/90/87 scale. Do not mistake assignment weights, GPA values (4.0), or other courses' rules for letter cutoffs. Only convert points to percentages if the final total points are explicitly known. If there are no stated percentage cutoffs or the scale is curved/discretionary, return an empty letterGrades array. Do not invent missing rows or a rounding policy. Use only what the documents say; never guess.`;

// Changes when the course's syllabus text or files change (the Canvas assignment
// summary is left out, since it changes with every sync).
export function syllabusSources(course) {
  return (course?.sources ?? []).filter((s) => !s.assignments);
}

export function syllabusFingerprint(course) {
  return syllabusSources(course)
    .map((s) => {
      const text = s.kind === "pdf" ? s.data : s.text;
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
      return `${s.title}:${text.length}:${hash >>> 0}`;
    })
    .join("|");
}

// canvasGroups: [{ name, assignments: [name] }]. Never throws: returns { error } instead.
export async function readSyllabusGrading({ apiKey, course, canvasGroups, model = DEFAULT_CLAUDE_MODEL }) {
  const sources = syllabusSources(course);
  if (!sources.length) return { error: "no-syllabus" };
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const documents = buildContextBlocks([{ ...course, sources }]).filter((b) => b.type === "document");
    const groupLines = canvasGroups.map(
      (g) => `- "${g.name}": ${g.assignments.slice(0, 60).join("; ") || "(no assignments yet)"}`
    );
    const message = await client.messages
      .stream({
        model: CLAUDE_MODELS[model] ? model : DEFAULT_CLAUDE_MODEL,
        max_tokens: 6000,
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: `You read course syllabi to find how the final grade is calculated. Today is ${new Date().toDateString()}.`,
        messages: [
          {
            role: "user",
            content: [
              ...documents,
              {
                type: "text",
                text: `Course: ${course.name}${course.term ? `, ${course.term}` : ""}\n\nCanvas assignment groups and their assignments:\n${groupLines.join("\n")}\n\n${INSTRUCTIONS}`,
              },
            ],
          },
        ],
      })
      .finalMessage();
    if (message.stop_reason === "refusal") throw new Error("Claude declined to read this syllabus.");
    if (message.stop_reason === "max_tokens") throw new Error("The grading breakdown was cut off.");
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const result = JSON.parse(text);
    return {
      found: result.found && result.components.length > 0,
      components: result.components,
      letterGrades: normalizeScheme(result.letterGrades),
      version: SYLLABUS_GRADING_VERSION,
      fingerprint: syllabusFingerprint(course),
      at: Date.now(),
    };
  } catch (e) {
    return { error: friendlyError(e).message };
  }
}
