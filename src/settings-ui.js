import { normalizeCanvasUrl } from "./canvas.js";
import { CLAUDE_MODELS } from "./claude.js";
import { ensureHostPermission } from "./sync.js";
import { applyTheme } from "./theme.js";
import * as storage from "./storage.js";

// The settings form, shared by the popup and the full site (same element ids).

const $ = (id) => document.getElementById(id);
let onCoursesChanged = () => {};

export function mountSettings(state, { onModelChange, onCoursesChange }) {
  onCoursesChanged = onCoursesChange;
  $("claude-model").replaceChildren(
    ...Object.entries(CLAUDE_MODELS).map(([id, { label }]) => new Option(label, id))
  );
  fillSettings(state);

  // Applies and saves right away, like the course switches.
  $("theme").addEventListener("change", async () => {
    state.theme = $("theme").value;
    applyTheme(state.theme);
    await storage.save({ theme: state.theme });
  });

  $("save-settings").addEventListener("click", async () => {
    try {
      const canvasUrl = normalizeCanvasUrl($("canvas-url").value || state.canvasUrl);
      if (!(await ensureHostPermission(canvasUrl))) {
        $("settings-status").textContent = "Permission to access that Canvas site was denied.";
        return;
      }
      const modelChanged = state.claudeModel !== $("claude-model").value;
      state.canvasUrl = canvasUrl;
      state.apiKey = $("api-key").value.trim();
      state.claudeModel = $("claude-model").value;
      $("canvas-url").value = canvasUrl;
      await storage.save({ canvasUrl, apiKey: state.apiKey, claudeModel: state.claudeModel });
      if (modelChanged) onModelChange();
      $("settings-status").textContent = "Saved.";
      setTimeout(() => ($("settings-status").textContent = ""), 2000);
    } catch {
      $("settings-status").textContent = "That doesn't look like a valid URL.";
    }
  });
}

export function fillSettings(state) {
  $("canvas-url").value = state.canvasUrl;
  $("api-key").value = state.apiKey;
  $("claude-model").value = state.claudeModel;
  $("theme").value = state.theme;
  applyTheme(state.theme);
  renderCourseVisibility(state);
}

// One switch per synced course; unticking hides the course everywhere.
export function renderCourseVisibility(state) {
  $("course-visibility-empty").hidden = state.courses.length > 0;
  $("course-visibility").replaceChildren(
    ...state.courses.map((course) => {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !state.hiddenIds.includes(course.id);
      box.addEventListener("change", async () => {
        await storage.setCourseHidden(state, course.id, !box.checked);
        onCoursesChanged();
      });
      label.append(box, course.name);
      li.append(label);
      return li;
    })
  );
}
