# Canvas Syllabus Chat

A Chrome extension that collects the syllabi of your favorited (starred) Canvas courses and lets you ask an AI questions about them from a popup. It uses Anthropic's Claude.

## Setup

1. Build: `npm install && npm run build` (outputs `dist/`).
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `dist/` folder.
3. Pin the extension and click its icon to open the popup. It opens below the toolbar icon at 520 × 520 CSS pixels, constrained by Chrome's available space, with a scrolling content area and a fixed header and message box. Chrome closes it when you click outside or toggle the icon. For longer sessions, open the full site with **⤢**; closing the popup ends its in-memory chat and any work running in that popup.
4. In Settings, confirm your Canvas URL (defaults to `https://utexas.instructure.com`) and paste an Anthropic API key from console.anthropic.com (add a few dollars of credit).
5. Make sure you're logged in to Canvas in a tab, then click **Sync syllabi from Canvas**.

The intro plays on the first popup opening, then at most once every 10 minutes in this browser profile. Openings during the cooldown show the interface immediately and do not restart the timer. When an intro is due, the popup randomly chooses one of two muted introductions, each with a 50% chance: `static/media/popup-intro.mp4` (1.3 seconds, text match cut) or `static/media/popup-intro-trail.mp4` (2 seconds, text trail). Both fade in over 240 ms, then crossfade into the interface over 320 ms. Add further options to `INTRO_CLIPS` in `static/popup-intro.js`; each listed clip has equal selection probability. Playback failures automatically reveal the interface. The full site opens directly without the introduction.

## How syllabi are found

Only courses you've starred in Canvas (Courses → All Courses → star icon) are included. If you haven't starred any, Canvas falls back to the courses it shows on your dashboard by default. Re-sync after changing your stars.

For each favorited course the extension looks at:

- the course's **Syllabus** page (`syllabus_body`), plus any Canvas files linked from it
- **module items** whose title contains "syllab" (pages and files), plus files in a module named "Syllabus"
- course **files** matching "syllabus" (often hidden from students; skipped silently)

### Assignments tab

Each sync also reads the course's Assignments tab and attaches a **Canvas assignments** document: every assignment group (Homework, Quizzes, ...) with its grade weight and drop rules, how many assignments it has, and each assignment's due date, points and submission type. The AI uses the syllabus for policies and this list for counts and due dates, and points out when the two disagree. Your grades and submissions are not included. Re-sync to pick up newly posted assignments.

### Simple Syllabus

Some courses keep their syllabus on Simple Syllabus (UT shows it as "UT Simple Syllabus" in the course menu). Those pages sit behind a login handoff from Canvas, so sync can't download them. Instead:

1. After a sync, courses with a Simple Syllabus link show **Open Simple Syllabus ↗** in the popup.
2. Click it. The syllabus opens in a new tab through Canvas, so your normal login applies.
3. Click the orange **Save to Syllabus Chat** button in the bottom-right corner of the syllabus page.

The text is saved to that course and kept across re-syncs. If you open Simple Syllabus some other way, the extension guesses the course from the course number at the top of the syllabus, and asks you in the popup if it can't tell. The button only reads the page when you click it.

PDF and text files are read (PDFs go to Claude as native documents, so tables and scans work). Word docs aren't read. If a course shows "No syllabus found", use the **+** button to add the file yourself; hand-added files survive re-syncs.

## Chat

- Untick courses to leave them out of the chat. Changing the selection starts a new chat, because the syllabi are attached once at the start of each conversation.
- **Model:** choose under Settings → Claude model. Haiku 5.5 (default) is the fastest and costs a few cents per chat; Sonnet 5.5 and Opus 5.5 handle trickier questions but are slower and pricier. Prompt caching means follow-up questions don't re-bill the full syllabi at full price. For Sonnet and Opus, server-side refusal fallback (`fallbacks: "default"`) is enabled; remove it in `CLAUDE_MODELS` in `src/claude.js` if you don't want it.

## Full site

Click **⤢** in the popup header to open the full site in a tab. It's a page inside the extension (`app.html`), so it uses your Canvas login and the same saved courses as the popup, and the two stay in sync.

Switching pages uses a short fade-and-slide transition while the top navigation stays in place. Scroll positions, drafts, and calculator state are preserved. Reduced-motion preferences turn these transitions off.

- **Courses** — every synced course, whether a syllabus was found (add one with **+**), and whether it's included in the chat.
- **Exam calendar** — midterms, finals and other exams on a month calendar, each with its time, place and the material it covers. Click **Find exams in syllabi** to have Claude read each course's syllabus and Canvas assignments (one request per course, a few cents with Haiku). Re-scan after syncing or adding a syllabus. If a syllabus doesn't list an exam, use **Add an exam yourself**; those exams are kept when you re-scan.
- **Grade Calculator** — your Canvas grades with what-if scores (see below).
- **Chat** — the same chat as the popup, with more room.
- **Settings** — the same settings as the popup, plus **Appearance** (match your computer, light, or dark; applies to the popup too) and **Courses to show**: untick a course to hide it everywhere (popup, site, chat, exam calendar). Hidden courses are skipped when syncing and finding exams, and their exams are removed. To bring one back, tick it and sync again.

To add a view, add a `<section id="view-NAME">` and a nav link to `#NAME` in `static/app.html`, then add `NAME` to `VIEWS` in `src/app.js`.

## Grade Calculator

It's the **Grade Calculator** tab of the website: open it from the website's nav, or click **Grade Calculator ↗** in the popup to jump straight to it. It reads your grades straight from Canvas using your logged-in session — no token needed — and lets you try what-if scores:

- Pick any course you're actively enrolled in (courses turned off in Settings are left out).
- On wide screens, the assignments and grade breakdown columns scroll independently, with the course picker kept visible. Each column can also be focused for keyboard scrolling. Narrow screens keep a single stacked scrolling layout.
- Orange notices fade out and collapse smoothly when dismissed with **×** (instant removal with reduced motion). Each dismissed message stays hidden for that course until the browser page reloads, including when you switch courses, change scores, or use the calculator's **Refresh** button.
- Click an assignment group's name or arrow to collapse or expand it. Groups and the popup's Courses section slide and fade smoothly over 220 ms, with rotating arrows; reduced-motion preferences disable the animation. Group summaries stay visible, and assignment-group collapse choices are saved per course across score changes and page reloads.
- Graded assignments come in locked (🔒 From Canvas). Click **What-if** to try a different score; **Reset** restores the real one.
- Ungraded assignments get a slider and a number box; hypothetical ones (like a final not yet in Canvas) can be added per group.
- The results panel shows your current grade (graded work only), the projected grade from your what-ifs, the letter, and the change. **Clear what-ifs** removes every score you've typed in; **What do I need?** shows the score needed on one assignment for each of this course's stated letter grades, including plus/minus grades.
- The math follows Canvas's own calculator: weighted groups (rescaled when some groups have no grades yet) or total points, drop lowest/highest (choosing the drops that help most, like Canvas does), never-drop, excused and "doesn't count" assignments. Missing work counts as 0 only once Canvas has recorded a 0. Grades your instructor hasn't posted are treated as ungraded. One difference: a group's drops wait until every assignment in it has a score, since an ungraded one could still turn out lowest. Courses with drop rules get an **Include drops now** button that applies them to the scores entered so far, like Canvas does.
- Your calculated current grade is compared with the total Canvas reports, with a warning if they differ by more than 0.1 points.
- Letters use this course's syllabus cutoffs when available, then its Canvas grading scheme. No generic scale is substituted when both are unavailable; percentage calculations still work.

### Letter grade cutoffs

The **Letter grade cutoffs** card shows the scale and its source. **Edit cutoffs for this course** lets you enter or correct letter names, decimal percentages, and whether a minimum is inclusive (≥) or exclusive (>). Corrections are saved per course. **Use detected cutoffs** restores the syllabus/Canvas scale without changing your scores or weights.

Above 93 means **>93%**, so 93.01% qualifies while exactly 93% does not; it never implies a minimum of 94%. Inclusive **≥93%** accepts exactly 93%. Letter grades use unrounded totals, even though the percentage display shows two decimals. Required scores are calculated in hundredths of a point and checked against the actual boundary.

Syllabus readings saved before letter-cutoff extraction was added are re-read once when that course opens (an Anthropic key is required). Use **Refresh** after updating a syllabus or to retry an unsuccessful reading. Conflicting syllabus and Canvas scales are flagged for review.

### Weights from the syllabus

The first time you open a course, Claude reads its syllabus (one request, a few cents with Haiku) and the calculator uses what it says: each component's share of the grade, its drop rules, and its date. The result is saved and reused until the synced syllabus changes or you click **Refresh**. The **Grading breakdown** table at the top of the results column lists what's being used.

- A **Syllabus / Canvas** switch on the breakdown card flips between the two sets of weights (and drop rules); the choice is saved per course.
- The syllabus wins over Canvas. Where the two disagree on a group's weight, or the syllabus lists something Canvas doesn't have yet (a final exam, say), a notice says so.
- Graded items the syllabus lists but Canvas doesn't have get their own card, worth the percent the syllabus gives them; type a score as a percent. They're tagged with their date, or "no date". If the syllabus gives no weight, the card says so and isn't counted. When Canvas posts the assignment, the card is replaced by it.
- Without an Anthropic key, or for a course with no synced syllabus text (Simple Syllabus courses), the calculator uses Canvas's weights and says why.

What-if scores are saved per course in this browser only. The page talks to your Canvas site, and sends a course's syllabus to the Anthropic API when it reads it.

Known limits: courses with grading periods may total differently than shown (the mismatch warning flags it); if your instructor hides course totals there's nothing to check against; a course that hides assignments from students can't be calculated.

## Privacy

Syllabi and API keys are stored in `chrome.storage.local` on your machine. Canvas requests use your existing browser login. Syllabi and questions go only to `api.anthropic.com`.

## Development

`npm run watch` rebuilds on change; then hit the reload button on `chrome://extensions`.

`npm test` checks strict/inclusive grade boundaries, unrounded letter assignment, minimum required scores, course-specific scale selection, Canvas precision, and syllabus extraction with a mocked API response.

| File | Purpose |
|---|---|
| `src/canvas.js` | Canvas API client and syllabus discovery |
| `src/claude.js` | Claude request building and streaming |
| `src/prompt.js` | System prompt and course labels |
| `src/sidepanel.js` | Toolbar popup UI |
| `src/disclosure.js` | Reversible expand/collapse animations and reduced-motion handling |
| `src/app.js` | Full site (`app.html`) UI and views |
| `src/grade-calculator.js` | Grade Calculator tab of the site |
| `src/grade-data.js` | Loads grades from Canvas for the calculator |
| `src/grade-math.js` | Canvas-compatible grade math (weights, drops, letters, needed score) |
| `src/grade-scale.js` | Course letter cutoffs, validation, source selection and boundary labels |
| `src/grade-weights.js` | Reads a course's grading breakdown from its syllabus |
| `src/grade-syllabus.js` | Applies the syllabus to the Canvas grades: weights, drops, extra items, conflict notices |
| `src/exams.js` | Exam extraction for the calendar (structured JSON output) |
| `src/chat-ui.js` | Chat box shared by both pages |
| `src/settings-ui.js` | Settings form shared by both pages |
| `src/sync.js` | Canvas sync, shared by both pages |
| `src/storage.js` | Saved data and cross-page change events |
| `src/markdown.js` | Safe Markdown rendering for answers |
| `static/` | Manifest, HTML, CSS, icons, background worker |
