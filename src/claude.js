import Anthropic from "@anthropic-ai/sdk";
import { systemPromptForToday, courseLabel, courseContext, attachmentSummary } from "./prompt.js";

// effort: how hard the model thinks. Syllabus lookups are chat-style, so the faster
// models run at low effort. fallback: re-run refused requests on another model
// server-side (not offered for Haiku).
export const CLAUDE_MODELS = {
  "claude-haiku-5-5": { label: "Haiku 5.5 — fastest, cheapest", effort: "low", fallback: false },
  "claude-sonnet-5-5": { label: "Sonnet 5.5 — balanced", effort: "low", fallback: true },
  "claude-opus-5-5": { label: "Opus 5.5 — smartest, slowest", effort: "medium", fallback: true },
};
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
const MAX_REQUEST_BYTES = 30 * 1024 * 1024; // API limit is 32 MB per request

// A conversation's system prompt and syllabus documents are frozen when it starts,
// so the request prefix stays identical turn to turn (prompt caching, and replayed
// thinking blocks are only valid against unchanged history).
export function newClaudeConversation(courses, model = DEFAULT_CLAUDE_MODEL) {
  return {
    model: CLAUDE_MODELS[model] ? model : DEFAULT_CLAUDE_MODEL,
    system: systemPromptForToday(),
    context: buildContextBlocks(courses),
    turns: [],
  };
}

export function buildContextBlocks(courses) {
  const blocks = [];
  for (const course of courses) {
    for (const src of course.sources) {
      const source =
        src.kind === "pdf"
          ? { type: "base64", media_type: "application/pdf", data: src.data }
          : { type: "text", media_type: "text/plain", data: src.text };
      blocks.push({ type: "document", source, title: `${courseLabel(course)} — ${src.title}`, context: courseContext(course) });
    }
  }
  blocks.push({ type: "text", text: attachmentSummary(courses) });
  return blocks;
}

export function estimateBytes(blocks) {
  return new Blob([JSON.stringify(blocks)]).size;
}

// Conversation shape: { system, context: ContentBlock[], turns: MessageParam[] }.
// Assistant turns hold the API's content blocks exactly as returned.
export async function askClaude({ apiKey, conversation, question, onText, signal }) {
  if (estimateBytes(conversation.context) > MAX_REQUEST_BYTES) {
    throw new Error("The selected syllabi are too large to send in one request (over 30 MB). Deselect some courses and start a new chat.");
  }

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const turns = [...conversation.turns, { role: "user", content: [{ type: "text", text: question }] }];
  // The syllabi ride along at the front of the first user turn.
  const [first, ...rest] = turns;
  const messages = [{ role: "user", content: [...conversation.context, ...first.content] }, ...rest];

  const { effort, fallback } = CLAUDE_MODELS[conversation.model];
  const stream = client.beta.messages.stream(
    {
      model: conversation.model,
      max_tokens: 16000,
      ...(fallback && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      output_config: { effort },
      cache_control: { type: "ephemeral" },
      system: conversation.system,
      messages,
    },
    { signal }
  );

  let streamed = "";
  stream.on("text", (delta) => {
    streamed += delta;
    onText(streamed);
  });

  try {
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new Error("Claude declined to answer that question. Try rephrasing it.");
    }
    const answer = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (message.stop_reason === "max_tokens") onText(answer + "\n\n_(Answer was cut off.)_");
    else onText(answer);
    conversation.turns = [...turns, { role: "assistant", content: message.content }];
    return answer;
  } catch (e) {
    throw friendlyError(e);
  }
}

export function friendlyError(e) {
  if (e instanceof Anthropic.APIUserAbortError) return new Error("Stopped.");
  if (e instanceof Anthropic.AuthenticationError) return new Error("Your Anthropic API key was rejected. Check it in Settings.");
  if (e instanceof Anthropic.PermissionDeniedError) return new Error("Your API key doesn't have access to this model.");
  if (e instanceof Anthropic.RateLimitError) return new Error("Rate limited by the Anthropic API. Wait a moment and try again.");
  if (e instanceof Anthropic.BadRequestError) return new Error(`The request was rejected: ${e.message}`);
  if (e instanceof Anthropic.InternalServerError) return new Error("The Anthropic API had a server error. Try again.");
  if (e instanceof Anthropic.APIConnectionError) return new Error("Couldn't reach the Anthropic API. Check your connection.");
  return e;
}
