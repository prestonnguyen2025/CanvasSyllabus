import { attachCourseAutocomplete } from "./autocomplete.js";
import { newClaudeConversation, askClaude } from "./claude.js";
import { renderMarkdown } from "./markdown.js";
import { selectedCourses, visibleCourses } from "./storage.js";

// The chat box, shared by the side panel and the full site. Both pages use the
// element ids chat, composer, question, send and new-chat.

const $ = (id) => document.getElementById(id);

const SUGGESTIONS = [
  "When are all of my exams?",
  "What's the late work policy in each class?",
  "How is my grade calculated in each course?",
  "When and where are my professors' office hours?",
];

export function createChat(state, { onMissingKey }) {
  let conversation = null;
  let abortController = null;

  function addMessage(role, content = "") {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.textContent = content;
    $("chat").append(div);
    div.scrollIntoView({ block: "end" });
    return div;
  }

  function showSuggestions() {
    const wrap = document.createElement("div");
    wrap.className = "suggestions";
    const label = document.createElement("p");
    label.textContent = visibleCourses(state).length
      ? "Try asking:"
      : "Sync your syllabi from Canvas, then ask things like:";
    wrap.append(label);
    for (const text of SUGGESTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.addEventListener("click", () => {
        $("question").value = text;
        $("composer").requestSubmit();
      });
      wrap.append(b);
    }
    $("chat").append(wrap);
  }

  function reset(notice) {
    abortController?.abort();
    abortController = null;
    $("send").textContent = "Send";
    const hadTurns = conversation?.turns.length;
    conversation = null;
    $("chat").replaceChildren();
    if (notice && hadTurns) addMessage("notice", notice);
    showSuggestions();
  }

  $("new-chat").addEventListener("click", () => reset());

  const autocomplete = attachCourseAutocomplete($("question"), () => visibleCourses(state));

  $("question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (abortController) {
      abortController.abort();
      return;
    }
    const question = $("question").value.trim();
    if (!question) return;
    if (!state.apiKey) {
      onMissingKey();
      return;
    }
    if (!selectedCourses(state).length) {
      addMessage("assistant error", "No courses selected. Sync from Canvas and tick at least one course.");
      return;
    }

    $("chat").querySelector(".suggestions")?.remove();
    $("question").value = "";
    autocomplete.reset();
    addMessage("user", question);
    const reply = addMessage("assistant");
    reply.innerHTML = '<span class="thinking">Reading your syllabi…</span>';

    conversation ??= newClaudeConversation(selectedCourses(state), state.claudeModel);
    const controller = (abortController = new AbortController());
    $("send").textContent = "Stop";

    let frame = 0;
    try {
      await askClaude({
        apiKey: state.apiKey,
        conversation,
        question,
        signal: controller.signal,
        onText: (text) => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            reply.innerHTML = renderMarkdown(text);
            reply.scrollIntoView({ block: "end" });
          });
        },
      });
    } catch (err) {
      cancelAnimationFrame(frame);
      reply.classList.add("error");
      reply.textContent = err.message;
    } finally {
      if (abortController === controller) {
        abortController = null;
        $("send").textContent = "Send";
      }
    }
  });

  showSuggestions();
  return { reset };
}
