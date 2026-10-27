// Suggests course names while typing in the chat box, so "orga" + Tab becomes
// "ORGANIC CHEMISTRY I". Matches the start of any word in the course name
// ("data str", "macro") or the course code ("cs314", "eco 3").
//
// A filled-in name is a "chip": it is drawn in a box and one Backspace deletes
// all of it. Textareas can't style part of their text, so the boxes are drawn
// on a backdrop layer that mirrors the text exactly, behind a transparent textarea.

const MAX_WORDS = 4; // longest typed phrase that is matched against names
const MAX_SUGGESTIONS = 5;
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// "Fa26 - ORGANIC CHEMISTRY I (53875, 53880)" -> "ORGANIC CHEMISTRY I"
export function shortCourseName(name) {
  const short = name
    .replace(/^\s*(fa|fall|sp|spr|spring|su|sum|summer|wi|win|winter)\s*'?\d{2}(\d{2})?\s*[-–—:|]\s*/i, "")
    .replace(/\s*\([^)]*\d{5}[^)]*\)\s*$/, "")
    .trim();
  return short || name.trim();
}

// Best matches first: name starts with the query, then a code match, then a later word.
export function matchCourses(courses, query) {
  const q = query.toLowerCase();
  const sq = squash(q);
  if (sq.length < 2) return [];
  const scored = [];
  for (const course of courses) {
    const name = shortCourseName(course.name).toLowerCase();
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
// longest first, never reaching back before minStart) that matches a course.
export function findQuery(before, courses, minStart = 0) {
  if (!before || /\s$/.test(before)) return null;
  // A name typed out in full needs no help (and its last word shouldn't re-match).
  const lower = before.toLowerCase();
  if (courses.some((c) => lower.endsWith(shortCourseName(c.name).toLowerCase()))) return null;
  const starts = [...before.matchAll(/\S+/g)].map((m) => m.index).filter((i) => i >= minStart);
  for (let k = Math.min(MAX_WORDS, starts.length); k >= 1; k--) {
    let start = starts[starts.length - k];
    start += before.slice(start).match(/^[^a-z0-9]*/i)[0].length; // skip "(" or quotes
    const matches = matchCourses(courses, before.slice(start));
    if (matches.length) return { start, matches };
  }
  return null;
}

// Moves chips to follow an edit from oldValue to newValue (caret now at `caret`).
// Chips the edit touched become plain text.
export function shiftChips(chips, oldValue, newValue, caret) {
  const delta = newValue.length - oldValue.length;
  let a = 0;
  const maxA = Math.min(oldValue.length, newValue.length, caret - Math.max(delta, 0));
  while (a < maxA && oldValue[a] === newValue[a]) a++;
  let b = 0;
  const maxB = Math.min(oldValue.length - a, newValue.length - a, newValue.length - caret);
  while (b < maxB && oldValue[oldValue.length - 1 - b] === newValue[newValue.length - 1 - b]) b++;
  const oldEnd = oldValue.length - b; // the edit replaced oldValue[a, oldEnd)
  return chips.flatMap((chip) => {
    if (chip.end <= a) return [chip];
    if (chip.start >= oldEnd) return [{ start: chip.start + delta, end: chip.end + delta }];
    return [];
  });
}

export function attachCourseAutocomplete(textarea, getCourses) {
  // Wrap the textarea so the backdrop can sit exactly behind it.
  const field = document.createElement("div");
  field.className = "composer-field";
  textarea.before(field);
  const backdrop = document.createElement("div");
  backdrop.className = "composer-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  field.append(backdrop, textarea);
  const css = getComputedStyle(textarea);
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingLeft", "paddingBottom", "borderWidth", "borderRadius"]) {
    backdrop.style[prop] = css[prop];
  }

  const list = document.createElement("ul");
  list.className = "course-suggest";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  field.parentElement.append(list);

  let chips = []; // { start, end } ranges of filled-in names, in order
  let lastValue = textarea.value;
  let open = null; // { start, end, matches, active, navigated }

  // ----- Backdrop with chip boxes -----

  function paint() {
    const text = textarea.value;
    const parts = [];
    let at = 0;
    for (const chip of chips) {
      parts.push(document.createTextNode(text.slice(at, chip.start)));
      const mark = document.createElement("mark");
      mark.className = "name-chip";
      mark.textContent = text.slice(chip.start, chip.end);
      parts.push(mark);
      at = chip.end;
    }
    // A trailing newline needs a character after it to take up a line.
    parts.push(document.createTextNode(text.slice(at) + (text.endsWith("\n") ? " " : "")));
    backdrop.replaceChildren(...parts);
    // Leave room for the textarea's scrollbar so lines wrap at the same place.
    const scrollbar = textarea.offsetWidth - textarea.clientWidth - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth);
    backdrop.style.paddingRight = `${parseFloat(css.paddingRight) + scrollbar}px`;
    backdrop.scrollTop = textarea.scrollTop;
  }

  // Call after any change to the text, typed or programmatic.
  function sync() {
    chips = shiftChips(chips, lastValue, textarea.value, textarea.selectionEnd);
    lastValue = textarea.value;
    paint();
  }

  function replaceRange(text, start, end) {
    textarea.setRangeText(text, start, end, "end");
    sync();
  }

  // ----- Suggestions -----

  function close() {
    open = null;
    list.hidden = true;
  }

  function update() {
    const end = textarea.selectionEnd;
    const minStart = chips.filter((c) => c.end <= end).at(-1)?.end ?? 0;
    const found = textarea.selectionStart === end && findQuery(textarea.value.slice(0, end), getCourses(), minStart);
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
        name.textContent = shortCourseName(course.name);
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
    const name = shortCourseName(course.name);
    const spacer = textarea.value.slice(end).startsWith(" ") ? "" : " ";
    replaceRange(name + spacer, start, end);
    chips = [...chips, { start, end: start + name.length }].sort((x, y) => x.start - y.start);
    paint();
    close();
    textarea.focus();
  }

  // ----- Events -----

  textarea.addEventListener("input", () => {
    sync();
    update();
  });
  textarea.addEventListener("scroll", () => (backdrop.scrollTop = textarea.scrollTop));
  textarea.addEventListener("blur", close);

  // Registered before the chat's own Enter-to-send handler, so it can claim keys first.
  textarea.addEventListener("keydown", (e) => {
    if (open) {
      const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        open.active = (open.active + step + open.matches.length) % open.matches.length;
        open.navigated = true;
        render();
        return;
      }
      if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && open.navigated)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(open.matches[open.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
    }
    // One Backspace (caret just after or inside a chip) or Delete (just before
    // or inside) removes the whole name.
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd || e.altKey || e.metaKey || e.ctrlKey) return;
    const chip =
      e.key === "Backspace" ? chips.find((c) => c.start < caret && caret <= c.end)
      : e.key === "Delete" ? chips.find((c) => c.start <= caret && caret < c.end)
      : null;
    if (!chip) return;
    e.preventDefault();
    replaceRange("", chip.start, chip.end);
    close();
  });

  return {
    // Call after the chat clears or replaces the text.
    reset() {
      chips = [];
      lastValue = textarea.value;
      paint();
      close();
    },
  };
}
