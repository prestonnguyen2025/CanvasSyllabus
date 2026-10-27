// Talks to the Canvas REST API using the browser's existing Canvas login.
// Nothing here needs a Canvas API token: requests carry your session cookie.

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES_PER_COURSE = 4;
const SYLLABUS_RE = /syllab/i;

export class CanvasError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function normalizeCanvasUrl(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return new URL(url).origin;
}

export class CanvasClient {
  constructor(baseUrl) {
    this.base = normalizeCanvasUrl(baseUrl);
  }

  async request(pathOrUrl) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.base + pathOrUrl;
    const res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json+canvas-string-ids, application/json" },
    });
    if (!res.ok) throw new CanvasError(`Canvas returned ${res.status} for ${url}`, res.status);
    // Session-authenticated Canvas JSON is prefixed with "while(1);" to block JSON hijacking.
    const text = (await res.text()).replace(/^while\(1\);/, "");
    return { data: JSON.parse(text), next: parseNextLink(res.headers.get("Link")) };
  }

  async get(path) {
    return (await this.request(path)).data;
  }

  async getAll(path) {
    const out = [];
    let next = path;
    while (next) {
      const page = await this.request(next);
      out.push(...page.data);
      next = page.next;
    }
    return out;
  }

  // Only the courses starred in Canvas's course list. If none are starred, Canvas
  // falls back to the courses it shows on the dashboard by default.
  async listCourses() {
    let courses;
    try {
      courses = await this.getAll(
        "/api/v1/users/self/favorites/courses?include[]=syllabus_body&include[]=term&per_page=100"
      );
    } catch (e) {
      if (e.status === 401) {
        throw new CanvasError(`Not logged in to Canvas. Open ${this.base} in a tab, sign in, then sync again.`, 401);
      }
      throw e;
    }
    // Courses you can't access (e.g. concluded with restrictions) come back with only an id.
    courses = courses.filter((c) => c.name && !c.access_restricted_by_date);
    // Fetch the syllabus separately for any course the favorites list returned without one.
    return Promise.all(
      courses.map((c) =>
        "syllabus_body" in c
          ? c
          : this.get(`/api/v1/courses/${c.id}?include[]=syllabus_body&include[]=term`).catch(() => c)
      )
    );
  }

  // Gathers every piece of syllabus material we can find for a course.
  async collectSyllabus(course, onProgress = () => {}) {
    const sources = [];
    const notes = [];
    const fileIds = new Set();

    if (course.syllabus_body) {
      const text = htmlToText(course.syllabus_body);
      if (text.length > 20) sources.push({ kind: "text", title: "Syllabus page", text });
      for (const id of fileIdsInHtml(course.syllabus_body)) fileIds.add(id);
    }

    onProgress(`${course.name}: checking modules`);
    try {
      for (const item of await this.syllabusModuleItems(course.id)) {
        if (item.type === "File" && item.content_id) {
          fileIds.add(String(item.content_id));
        } else if (item.type === "Page" && item.page_url) {
          const page = await this.get(`/api/v1/courses/${course.id}/pages/${encodeURIComponent(item.page_url)}`);
          const text = htmlToText(page.body || "");
          if (text.length > 20) sources.push({ kind: "text", title: `Page: ${page.title}`, text });
          for (const id of fileIdsInHtml(page.body || "")) fileIds.add(id);
        }
      }
    } catch {
      // Modules tab may be hidden for students (Canvas answers 401); that's fine.
    }

    onProgress(`${course.name}: searching files`);
    try {
      const files = await this.getAll(
        `/api/v1/courses/${course.id}/files?search_term=syllabus&per_page=50`
      );
      for (const f of files) fileIds.add(String(f.id));
    } catch {
      // Files tab is often disabled for students.
    }

    for (const id of [...fileIds].slice(0, MAX_FILES_PER_COURSE)) {
      try {
        onProgress(`${course.name}: downloading file ${id}`);
        const source = await this.downloadFile(id);
        if (source) sources.push(source);
      } catch (e) {
        notes.push(`Couldn't read file ${id}: ${e.message}`);
      }
    }

    onProgress(`${course.name}: reading assignments`);
    try {
      const assignments = await this.assignmentSummary(course);
      if (assignments) sources.push(assignments);
    } catch {
      // Assignments tab hidden for students; skip it.
    }

    onProgress(`${course.name}: checking for Simple Syllabus`);
    const simpleSyllabusUrl = await this.findSimpleSyllabus(course);

    return { sources, notes, simpleSyllabusUrl };
  }

  // Simple Syllabus syllabi live outside Canvas, behind an LTI launch, so they can't be
  // downloaded here. We only find the link; the content script reads the page once the
  // student opens it (see static/simplesyllabus.js).
  async findSimpleSyllabus(course) {
    const linked = (course.syllabus_body || "").match(/href="(https:\/\/[^"]*simplesyllabus\.com[^"]*)"/i);
    if (linked) return linked[1].replace(/&amp;/g, "&");
    try {
      const tabs = await this.get(`/api/v1/courses/${course.id}/tabs`);
      const tab = tabs.find((t) => /simple\s*syllabus/i.test(t.label || "") && !t.hidden);
      if (tab) return new URL(tab.html_url, this.base).href;
    } catch {
      // Tabs API unavailable; no Simple Syllabus link then.
    }
    return null;
  }

  // Summarizes the Assignments tab: each assignment group (category) with its weight,
  // drop rules and assignments. Grades and submissions are deliberately left out.
  async assignmentSummary(course) {
    const groups = await this.getAll(
      `/api/v1/courses/${course.id}/assignment_groups?include[]=assignments&per_page=50`
    );
    const total = groups.reduce((n, g) => n + (g.assignments?.length ?? 0), 0);
    if (!total) return null;

    // Structured copy for the full site's Deadlines view; the AI reads the text.
    const items = [];
    const weighted = course.apply_assignment_group_weights;
    const lines = [
      `Assignments listed on Canvas for this course (Assignments tab, synced ${new Date().toDateString()}).`,
      weighted
        ? "Canvas weights the final grade by assignment group, using the percentages below."
        : "Canvas does not weight assignment groups here; the grade is based on total points (the syllabus may say otherwise).",
    ];
    for (const g of [...groups].sort((a, b) => a.position - b.position)) {
      const items = g.assignments ?? [];
      const facts = [`${items.length} assignment${items.length === 1 ? "" : "s"}`];
      if (weighted && g.group_weight != null) facts.unshift(`${g.group_weight}% of final grade`);
      if (g.rules?.drop_lowest) facts.push(`drops lowest ${g.rules.drop_lowest}`);
      if (g.rules?.drop_highest) facts.push(`drops highest ${g.rules.drop_highest}`);
      lines.push("", `## ${g.name} — ${facts.join(", ")}`);
      for (const a of [...items].sort(byDueDate)) {
        const parts = [a.name];
        parts.push(a.due_at ? `due ${formatDate(a.due_at)}` : "no due date");
        if (a.points_possible != null) parts.push(`${a.points_possible} pts`);
        const kind = describeSubmissionTypes(a.submission_types);
        if (kind) parts.push(kind);
        lines.push(`- ${parts.join(" — ")}`);
        items.push({ name: a.name, group: g.name, dueAt: a.due_at, points: a.points_possible, url: a.html_url });
      }
    }
    return { kind: "text", title: `Canvas assignments (${total})`, text: lines.join("\n"), assignments: true, items };
  }

  async syllabusModuleItems(courseId) {
    const modules = await this.getAll(`/api/v1/courses/${courseId}/modules?include[]=items&per_page=50`);
    const items = [];
    for (const m of modules) {
      // Canvas omits inline items for large modules and gives items_url instead.
      const moduleItems = m.items ?? (m.items_url ? await this.getAll(m.items_url) : []);
      const moduleIsSyllabus = SYLLABUS_RE.test(m.name || "");
      for (const item of moduleItems) {
        if (SYLLABUS_RE.test(item.title || "") || (moduleIsSyllabus && item.type === "File")) {
          items.push(item);
        }
      }
    }
    return items;
  }

  async downloadFile(fileId) {
    const meta = await this.get(`/api/v1/files/${fileId}`);
    const type = meta["content-type"] || "";
    const title = `File: ${meta.display_name || meta.filename}`;
    if (meta.size > MAX_FILE_BYTES) throw new Error("file is larger than 20 MB");

    const isPdf = type === "application/pdf" || /\.pdf$/i.test(meta.filename || "");
    const isText = type.startsWith("text/");
    if (!isPdf && !isText) {
      throw new Error(`${meta.display_name} is ${type || "an unsupported type"}; only PDF and text files are read`);
    }

    const res = await fetch(meta.url, { credentials: "include" });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    if (isPdf) return { kind: "pdf", title, data: arrayBufferToBase64(await res.arrayBuffer()) };
    const raw = await res.text();
    return { kind: "text", title, text: type.includes("html") ? htmlToText(raw) : raw };
  }
}

function byDueDate(a, b) {
  if (!a.due_at) return 1;
  if (!b.due_at) return -1;
  return a.due_at.localeCompare(b.due_at);
}

function formatDate(iso) {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const SUBMISSION_KINDS = {
  online_quiz: "quiz",
  discussion_topic: "discussion",
  online_upload: "file upload",
  online_text_entry: "text entry",
  online_url: "website link",
  media_recording: "media recording",
  external_tool: "external tool",
  on_paper: "on paper",
  none: "no submission",
};

function describeSubmissionTypes(types = []) {
  return types.map((t) => SUBMISSION_KINDS[t]).filter(Boolean).join("/");
}

function parseNextLink(header) {
  if (!header) return null;
  const match = header.split(",").find((part) => /rel="next"/.test(part));
  return match ? match.match(/<([^>]+)>/)[1] : null;
}

function fileIdsInHtml(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\/files\/(\d+)/g)) ids.add(m[1]);
  return ids;
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "BR", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6",
  "TABLE", "UL", "OL", "SECTION", "ARTICLE", "HEADER", "FOOTER", "BLOCKQUOTE", "PRE", "HR",
]);

// Converts Canvas rich-content HTML to readable plain text, keeping line and table structure.
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style").forEach((el) => el.remove());
  let out = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === "LI") out += "\n- ";
    else if (BLOCK_TAGS.has(tag)) out += "\n";
    if (tag === "TD" || tag === "TH") out += " | ";
    node.childNodes.forEach(walk);
    if (tag === "A" && node.href && !node.textContent.includes(node.getAttribute("href"))) {
      const href = node.getAttribute("href");
      if (/^https?:/.test(href)) out += ` (${href})`;
    }
    if (BLOCK_TAGS.has(tag)) out += "\n";
  };
  walk(doc.body);
  return out
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
