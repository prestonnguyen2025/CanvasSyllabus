import Anthropic from "@anthropic-ai/sdk";
import { buildContextBlocks, friendlyError, CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "./claude.js";

// Reads how a course's syllabus weights its grade (e.g. "Exams 60%, Homework 20%")
// and matches those percentages to the course's Canvas assignment groups, so the
// Grade Calculator can use them when Canvas's own weights are missing or all equal.

const WEIGHT_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    weights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group: { type: "string" },
          weight: { type: "number" },
        },
        required: ["group", "weight"],
        additionalProperties: false,
      },
    },
    unmatched: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          weight: { type: "number" },
        },
        required: ["name", "weight"],
        additionalProperties: false,
      },
    },
  },
  required: ["found", "weights", "unmatched"],
  additionalProperties: false,
};

const INSTRUCTIONS = `Find how the syllabus says the final grade is calculated: the percentage of the grade for each category (for example "Exams 60%" or "Homework 20%").

The course's Canvas assignment groups are listed below. For each Canvas group, give the percentage the syllabus assigns to it, using the exact Canvas group name in "group". If a syllabus category covers several Canvas groups, give its percentage to the group that fits best and 0 to the rest. A syllabus category with no matching Canvas group goes in "unmatched" with its percentage.

Set found to false, and leave both lists empty, if the syllabus gives no percentages or says the grade is based on total points.

Percentages are plain numbers (20 for 20%). Use only what the documents say; never guess.`;

export async function findGradingWeights({ apiKey, course, canvasGroups, model = DEFAULT_CLAUDE_MODEL }) {
  if (!course?.sources.length) {
    return { error: "No syllabus is synced for this course. Sync your courses first." };
  }
  try {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const documents = buildContextBlocks([course]).filter((b) => b.type === "document");
    const message = await client.messages
      .stream({
        model: CLAUDE_MODELS[model] ? model : DEFAULT_CLAUDE_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low", format: { type: "json_schema", schema: WEIGHT_SCHEMA } },
        system: "You read course syllabi to find how each grade category is weighted.",
        messages: [
          {
            role: "user",
            content: [
              ...documents,
              {
                type: "text",
                text: `Course: ${course.name}\n\nCanvas assignment groups: ${canvasGroups.map((g) => `"${g}"`).join(", ")}\n\n${INSTRUCTIONS}`,
              },
            ],
          },
        ],
      })
      .finalMessage();
    if (message.stop_reason === "refusal") throw new Error("Claude declined to read this syllabus.");
    if (message.stop_reason === "max_tokens") throw new Error("The weights were cut off.");
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const result = JSON.parse(text);
    const names = new Set(canvasGroups);
    const byName = {};
    for (const { group, weight } of result.weights) {
      if (names.has(group)) byName[group] = weight;
    }
    return { found: result.found, byName, unmatched: result.unmatched, at: Date.now() };
  } catch (e) {
    return { error: friendlyError(e).message };
  }
}
