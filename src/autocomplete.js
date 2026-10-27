// Suggests course names while typing in the chat box, so "macro" + Tab becomes
// "Principles of Macroeconomics". Matches the start of any word in the course
// name ("data str", "macro") or the course code ("cs314", "eco 3").

const MAX_WORDS = 4; // longest typed phrase that is matched against names
const MAX_SUGGESTIONS = 5;
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Best matches first: name starts with the query, then a code match, then a later word.
export function matchCourses(courses, query) {
  const q = query.toLowerCase();
  const sq = squash(q);
  if (sq.length < 2) return [];
  const scored = [];
  for (const course of courses) {
    const name = course.name.toLowerCase();
    if (name === q) continue; // already typed out in full
    const code = squash(course.code || "");
    let score = 0;
    if (q.length >= 3 && name.startsWith(q)) score = 3;
    else if (code && code.startsWith(sq) && (/\d/.test(sq) || sq.length >= 3)) score = 2;
    else if (q.length >= 3 && name.includes(` ${q}`)) score = 1;
    if (score) scored.push({ course, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.course);
}

// Finds the phrase being typed just before the caret (up to MAX_WORDS words,
// longest first) that matches a course.
export function findQuery(before, courses) {
  if (!before || /\s$/.test(before)) return null;
  // A name typed out in full needs no help (and its last word shouldn't re-match).
  const lower = before.toLowerCase();
  if (courses.some((c) => lower.endsWith(c.name.toLowerCase()))) return null;
  const starts = [...before.matchAll(/\S+/g)].map((m) => m.index);
  for (let k = Math.min(MAX_WORDS, starts.length); k >= 1; k--) {
    let start = starts[starts.length - k];
    start += before.slice(start).match(/^[^a-z0-9]*/i)[0].length; // skip "(" or quotes
    const matches = matchCourses(courses, before.slice(start));
    if (matches.length) return { start, matches };
  }
  return null;
}

export function attachCourseAutocomplete(textarea, getCourses) {
  const list = document.createElement("ul");
  list.className = "course-suggest";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  textarea.parentElement.append(list);
  let open = null; // { start, end, matches, active, navigated }

  function close() {
    open = null;
    list.hidden = true;
  }

  function update() {
    const end = textarea.selectionEnd;
    const found = textarea.selectionStart === end && findQuery(textarea.value.slice(0, end), getCourses());
    if (!found) return close();
    open = { ...found, end, active: 0, navigated: false };
    render();
  }

  function render() {
    const hint = document.createElement("li");
    hint.className = "suggest-hint";
    hint.textContent = "Tab to fill in · ↑↓ to choose · Esc to dismiss";
    list.replaceChildren(
      hint,
      ...open.matches.map((course, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === open.active));
        if (i === open.active) li.classList.add("active");
        const name = document.createElement("span");
        name.textContent = course.name;
        const code = document.createElement("span");
        code.className = "code";
        code.textContent = course.code || "";
        li.append(name, code);
        // mousedown, not click: keeps focus in the textarea.
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(course);
        });
        return li;
      })
    );
    list.hidden = false;
  }

  function pick(course) {
    const { start, end } = open;
    const spacer = textarea.value.slice(end).startsWith(" ") ? "" : " ";
    textarea.setRangeText(course.name + spacer, start, end, "end");
    close();
    textarea.focus();
  }

  textarea.addEventListener("input", update);
  textarea.addEventListener("blur", close);
  // Registered before the chat's own Enter-to-send handler, so it can claim keys first.
  textarea.addEventListener("keydown", (e) => {
    if (!open) return;
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) {
      e.preventDefault();
      open.active = (open.active + step + open.matches.length) % open.matches.length;
      open.navigated = true;
      render();
    } else if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && open.navigated)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(open.matches[open.active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  return { close };
}
