// Course-specific percentage boundaries. Missing scales stay unknown: there is
// no universal A/A+ cutoff, and a weight table is not a letter-grade scale.
export function normalizeScheme(entries) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const names = new Set();
  const boundaries = new Set();
  const normalized = [];
  for (const entry of entries) {
    const name = typeof entry?.name === "string" ? entry.name.trim().replace(/−/g, "-") : "";
    const min = entry?.min;
    if (!name || names.has(name.toUpperCase()) || typeof min !== "number" || !Number.isFinite(min) || min < 0 || min > 100) return [];
    if (entry.inclusive != null && typeof entry.inclusive !== "boolean") return [];
    const boundary = `${min}:${entry.inclusive !== false}`;
    if (boundaries.has(boundary)) return [];
    names.add(name.toUpperCase());
    boundaries.add(boundary);
    normalized.push({ name, min, inclusive: entry.inclusive !== false, ...(entry.evidence && { evidence: entry.evidence }) });
  }
  return normalized.sort((a, b) => b.min - a.min || Number(a.inclusive) - Number(b.inclusive));
}

export function formatCutoff(entry) {
  return `${entry.inclusive === false ? ">" : "≥"}${Number(entry.min.toPrecision(12))}%`;
}

export function resolveGradeScale(base, syllabus, custom) {
  const canvas = normalizeScheme(base.scheme);
  const fromSyllabus = normalizeScheme(syllabus?.letterGrades);
  const edited = normalizeScheme(custom);
  const scheme = edited.length ? edited : fromSyllabus.length ? fromSyllabus : canvas;
  const schemeSource = edited.length ? "custom" : fromSyllabus.length ? "syllabus" : canvas.length ? "course" : "unknown";
  const notices = [];
  const signature = (scale) => JSON.stringify(scale.map(({ name, min, inclusive }) => [name, min, inclusive]));
  if (!edited.length && canvas.length && fromSyllabus.length && signature(canvas) !== signature(fromSyllabus)) {
    notices.push({ kind: "conflict", text: "The syllabus and Canvas list different letter-grade cutoffs. Using the syllabus. Review the Letter grade cutoffs card to check or correct them for this course." });
  }
  return { scheme, schemeSource, notices };
}
