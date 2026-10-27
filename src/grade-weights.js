import Anthropic from "@anthropic-ai/sdk";
import { buildContextBlocks, friendlyError, requestJson, DEFAULT_CLAUDE_MODEL } from "./claude.js";

// Reads how a course's syllabus grades the course: each component's share of the
// final grade, its drop rules, and its date. The Grade Calculator runs this on its
// own the first time a course is opened and reuses the saved result (see
// grade-syllabus.js for how it's combined with Canvas's groups).

const SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
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
  required: ["found", "components"],
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

Set found to false, with an empty list, if the syllabus gives no grade breakdown or says the grade is based on total points. Use only what the documents say; never guess.`;

// The course's syllabus material, without the Canvas assignment summary (which
// changes with every sync and is sent separately, fresh from Canvas).
export function syllabusSources(course) {
  return (course?.sources ?? []).filter((s) => !s.assignments);
}

// A SHA-256 hash of the syllabus text and files: changes whenever any of them does.
export async function syllabusFingerprint(course) {
  const content = syllabusSources(course)
    .map((s) => `${s.title}\n${s.kind === "pdf" ? s.data : s.text}`)
    .join("\n\u0000\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    const result = await requestJson(client, {
      model,
      schema: SCHEMA,
      maxTokens: 6000,
      cutOffMessage: "The grading breakdown was cut off.",
      system: `You read course syllabi to find how the final grade is calculated. Today is ${new Date().toDateString()}.`,
      content: [
        ...documents,
        {
          type: "text",
          text: `Course: ${course.name}${course.term ? `, ${course.term}` : ""}\n\nCanvas assignment groups and their assignments:\n${groupLines.join("\n")}\n\n${INSTRUCTIONS}`,
        },
      ],
    });
    return {
      found: result.found && result.components.length > 0,
      components: result.components,
      fingerprint: await syllabusFingerprint(course),
      at: Date.now(),
    };
  } catch (e) {
    return { error: friendlyError(e).message };
  }
}
