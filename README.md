# Canvas Syllabus Chat

A Chrome extension that collects the syllabi of your favorited (starred) Canvas courses and lets you ask an AI questions about them from a side panel. It uses Anthropic's Claude.

## Setup

1. Build: `npm install && npm run build` (outputs `dist/`).
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `dist/` folder.
3. Pin the extension and click its icon to open the side panel.
4. In Settings, confirm your Canvas URL (defaults to `https://utexas.instructure.com`) and paste an Anthropic API key from console.anthropic.com (add a few dollars of credit).
5. Make sure you're logged in to Canvas in a tab, then click **Sync syllabi from Canvas**.

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

1. After a sync, courses with a Simple Syllabus link show **Open Simple Syllabus ↗** in the side panel.
2. Click it. The syllabus opens in a new tab through Canvas, so your normal login applies.
3. Click the orange **Save to Syllabus Chat** button in the bottom-right corner of the syllabus page.

The text is saved to that course and kept across re-syncs. If you open Simple Syllabus some other way, the extension guesses the course from the course number at the top of the syllabus, and asks you in the side panel if it can't tell. The button only reads the page when you click it.

PDF and text files are read (PDFs go to Claude as native documents, so tables and scans work). Word docs aren't read. If a course shows "No syllabus found", use the **+** button to add the file yourself; hand-added files survive re-syncs.

## Chat

- Untick courses to leave them out of the chat. Changing the selection starts a new chat, because the syllabi are attached once at the start of each conversation.
- **Model:** choose under Settings → Claude model. Haiku 5.5 (default) is the fastest and costs a few cents per chat; Sonnet 5.5 and Opus 5.5 handle trickier questions but are slower and pricier. Prompt caching means follow-up questions don't re-bill the full syllabi at full price. For Sonnet and Opus, server-side refusal fallback (`fallbacks: "default"`) is enabled; remove it in `CLAUDE_MODELS` in `src/claude.js` if you don't want it.

## Full site

Click **⤢** in the side panel header to open the full site in a tab. It's a page inside the extension (`app.html`), so it uses your Canvas login and the same saved courses as the side panel, and the two stay in sync. It has:

- **Courses** — every synced course, whether a syllabus was found (add one with **+**), and whether it's included in the chat.
- **Exam calendar** — midterms, finals and other exams on a month calendar, each with its time, place and the material it covers. Click **Find exams in syllabi** to have Claude read each course's syllabus and Canvas assignments (one request per course, a few cents with Haiku). Re-scan after syncing or adding a syllabus.
- **Grade Calculator** — your Canvas grades with what-if scores (see below).
- **Chat** — the same chat as the side panel, with more room.
- **Settings** — the same settings as the side panel, plus **Appearance** (match your computer, light, or dark; applies to the side panel too) and **Courses to show**: untick a course to hide it everywhere (side panel, site, chat, exam calendar). Hidden courses are skipped when syncing and finding exams, and their exams are removed. To bring one back, tick it and sync again.

To add a view, add a `<section id="view-NAME">` and a nav link to `#NAME` in `static/app.html`, then add `NAME` to `VIEWS` in `src/app.js`.

## Grade Calculator

It's the **Grade Calculator** tab of the website: open it from the website's nav, or click **Grade Calculator ↗** in the side panel to jump straight to it. It reads your grades straight from Canvas using your logged-in session — no token needed — and lets you try what-if scores:

- Pick any course you're actively enrolled in (courses turned off in Settings are left out).
- Graded assignments come in locked (🔒 From Canvas). Click **What-if** to try a different score; **Reset** restores the real one.
- Ungraded assignments get a slider and a number box; hypothetical ones (like a final not yet in Canvas) can be added per group.
- The results panel shows your current grade (graded work only), the projected grade from your what-ifs, the letter, and the change. **Set all remaining** fills every open assignment; **What do I need?** shows the score needed on one assignment for an A, B or C.
- The math follows Canvas's own calculator: weighted groups (rescaled when some groups have no grades yet) or total points, drop lowest/highest (choosing the drops that help most, like Canvas does), never-drop, excused and "doesn't count" assignments. Missing work counts as 0 only once Canvas has recorded a 0. Grades your instructor hasn't posted are treated as ungraded.
- Your calculated current grade is compared with the total Canvas reports, with a warning if they differ by more than 0.1 points.
- Letters use the course's grading scheme when Canvas shares it with students, otherwise Canvas's standard scale.

What-if scores are saved per course in this browser only. The page talks only to your Canvas site.

Known limits: courses with grading periods may total differently than shown (the mismatch warning flags it); if your instructor hides course totals there's nothing to check against; a course that hides assignments from students can't be calculated.

## Privacy

Syllabi and API keys are stored in `chrome.storage.local` on your machine. Canvas requests use your existing browser login. Syllabi and questions go only to `api.anthropic.com`.

## Development

`npm run watch` rebuilds on change; then hit the reload button on `chrome://extensions`.

| File | Purpose |
|---|---|
| `src/canvas.js` | Canvas API client and syllabus discovery |
| `src/claude.js` | Claude request building and streaming |
| `src/prompt.js` | System prompt and course labels |
| `src/sidepanel.js` | Side panel UI |
| `src/app.js` | Full site (`app.html`) UI and views |
| `src/grade-calculator.js` | Grade Calculator tab of the site |
| `src/grade-data.js` | Loads grades from Canvas for the calculator |
| `src/grade-math.js` | Canvas-compatible grade math (weights, drops, letters, needed score) |
| `src/exams.js` | Exam extraction for the calendar (structured JSON output) |
| `src/chat-ui.js` | Chat box shared by both pages |
| `src/settings-ui.js` | Settings form shared by both pages |
| `src/sync.js` | Canvas sync, shared by both pages |
| `src/storage.js` | Saved data and cross-page change events |
| `src/markdown.js` | Safe Markdown rendering for answers |
| `static/` | Manifest, HTML, CSS, icons, background worker |
