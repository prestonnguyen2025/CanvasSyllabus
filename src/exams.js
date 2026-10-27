import Anthropic from "@anthropic-ai/sdk";
import { buildContextBlocks, friendlyError, requestJson, DEFAULT_CLAUDE_MODEL } from "./claude.js";
import { courseLabel } from "./prompt.js";

// Reads each course's syllabus and Canvas assignments and pulls out its exams
// (midterms, finals and other exams) with time, place and covered material.
// One request per course, answered as JSON matching EXAM_SCHEMA.

const EXAM_SCHEMA = {
  type: "object",
  properties: {
    exams: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["midterm", "final", "exam"] },
          date: { type: "string" },
          startTime: { type: "string" },
          endTime: { type: "string" },
          place: { type: "string" },
          materials: { type: "string" },
        },
        required: ["name", "kind", "date", "startTime", "endTime", "place", "materials"],
        additionalProperties: false,
      },
    },
  },
  required: ["exams"],
  additionalProperties: false,
};

const INSTRUCTIONS = `List every exam for this course: midterms, finals, and other exams or tests. Leave out quizzes, homework, labs, projects, papers and presentations.

For each exam give:
- name: as the course calls it, e.g. "Midterm 1" or "Final Exam".
- kind: "midterm", "final", or "exam" for any other exam.
- date: YYYY-MM-DD. Work out the year from the course term and today's date. Empty string if no date is given.
- startTime, endTime: 24-hour HH:MM. If only the class meeting time applies (the exam is "in class"), use the class meeting time. Empty string if not stated.
- place: room and building, "In class" if it's held in the usual classroom without a room given, "Online" for online exams. Empty string if not stated.
- materials: what the exam covers (chapters, units, topics, lectures, whether it's cumulative). Short, one or two sentences. Empty string if not stated.

Use only what the documents say; never guess. If the syllabus and the Canvas assignments list disagree on a date, prefer the Canvas assignments list (it is kept more up to date).`;

export async function findExams({ apiKey, courses, model = DEFAULT_CLAUDE_MODEL, onProgress = () => {} }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const results = {};
  let done = 0;
  onProgress(`Reading ${courses.length} syllabi…`);
  await Promise.all(
    courses.map(async (course) => {
      try {
        results[course.id] = { exams: await examsForCourse(client, course, model), at: Date.now() };
      } catch (e) {
        results[course.id] = { exams: [], error: friendlyError(e).message, at: Date.now() };
      }
      onProgress(`Read ${++done} of ${courses.length} syllabi…`);
    })
  );
  return results;
}

async function examsForCourse(client, course, model) {
  if (!course.sources.length) return [];
  // buildContextBlocks ends with a multi-course attachment summary; one course needs none.
  const documents = buildContextBlocks([course]).filter((b) => b.type === "document");
  const answer = await requestJson(client, {
    model,
    schema: EXAM_SCHEMA,
    maxTokens: 8000,
    cutOffMessage: "The exam list was cut off.",
    system: `You extract exam schedules from course syllabi. Today is ${new Date().toDateString()}.`,
    content: [
      ...documents,
      { type: "text", text: `Course: ${courseLabel(course)}${course.term ? `, ${course.term}` : ""}\n\n${INSTRUCTIONS}` },
    ],
  });
  return answer.exams;
}
