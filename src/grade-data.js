import { CanvasError } from "./canvas.js";
import { DEFAULT_SCHEME } from "./grade-math.js";

// Reads a student's grades from Canvas (with their logged-in session) and turns
// them into the model grade-math.js works on.

// Courses the student is actively enrolled in as a student.
export async function listGradeCourses(client) {
  try {
    const courses = await client.getAll(
      "/api/v1/courses?enrollment_state=active&enrollment_type=student&include[]=term&per_page=100"
    );
    return courses.filter((c) => c.name && !c.access_restricted_by_date);
  } catch (e) {
    if (e.status === 401) throw new CanvasError("not-logged-in", 401);
    throw e;
  }
}

export async function loadCourseGrades(client, courseId) {
  const course = await client.get(`/api/v1/courses/${courseId}?include[]=total_scores`);
  let groups;
  try {
    groups = await client.getAll(
      `/api/v1/courses/${courseId}/assignment_groups?include[]=assignments&include[]=submission&per_page=50`
    );
  } catch (e) {
    if ([401, 403, 404].includes(e.status)) throw new CanvasError("grades-hidden", e.status);
    throw e;
  }
  const enrollment = (course.enrollments ?? []).find((e) => /student/i.test(e.type || e.role || ""));
  const scheme = await loadScheme(client, course);
  return {
    id: String(course.id),
    name: course.name,
    code: course.course_code,
    url: `${client.base}/courses/${course.id}/grades`,
    weighted: Boolean(course.apply_assignment_group_weights),
    hideTotals: Boolean(course.hide_final_grades),
    canvasScore: enrollment?.computed_current_score ?? null,
    canvasGrade: enrollment?.computed_current_grade ?? null,
    scheme: scheme ?? DEFAULT_SCHEME,
    schemeSource: scheme ? "course" : "default",
    groups: [...groups]
      .sort((a, b) => a.position - b.position)
      .map((g) => ({
        id: String(g.id),
        name: g.name,
        weight: g.group_weight ?? 0,
        rules: {
          dropLowest: g.rules?.drop_lowest || 0,
          dropHighest: g.rules?.drop_highest || 0,
          neverDrop: new Set((g.rules?.never_drop ?? []).map(String)),
        },
        items: (g.assignments ?? []).map(toItem).sort(byDueDate),
      })),
  };
}

// The course's letter scale, if Canvas lets the student read it.
async function loadScheme(client, course) {
  const id = course.grading_standard_id;
  if (!id) return null;
  let standard = null;
  try {
    standard = await client.get(`/api/v1/courses/${course.id}/grading_standards/${id}`);
  } catch {
    try {
      const all = await client.getAll(`/api/v1/courses/${course.id}/grading_standards?per_page=50`);
      standard = all.find((s) => String(s.id) === String(id)) ?? null;
    } catch {
      return null; // students often can't read grading standards
    }
  }
  const entries = standard?.grading_scheme;
  if (!entries?.length) return null;
  return entries
    .map((e) => ({ name: e.name, min: Math.round(e.value * 10000) / 100 }))
    .sort((a, b) => b.min - a.min);
}

// status: graded | pending (needs review) | hidden (graded, not posted yet) |
// submitted | missing | ungraded — or, for items that never count: excused |
// omitted | not-graded. Only a score Canvas has recorded is real; a missing
// assignment counts as 0 only once Canvas gives it a 0.
function toItem(a) {
  const sub = a.submission ?? {};
  const types = a.submission_types ?? [];
  let status;
  if (a.omit_from_final_grade) status = "omitted";
  else if (a.grading_type === "not_graded" || (types.length === 1 && types[0] === "not_graded")) status = "not-graded";
  else if (sub.excused) status = "excused";
  else if (sub.workflow_state === "pending_review") status = "pending";
  else if (sub.score != null) status = "graded";
  else if (sub.workflow_state === "graded") status = "hidden";
  else if (sub.workflow_state === "submitted") status = "submitted";
  else if (sub.missing) status = "missing";
  else status = "ungraded";
  return {
    id: String(a.id),
    kind: "canvas",
    name: a.name,
    url: a.html_url,
    dueAt: a.due_at,
    pointsPossible: a.points_possible ?? 0,
    status,
    counts: !["omitted", "not-graded", "excused"].includes(status),
    realScore: status === "graded" ? sub.score : null,
  };
}

function byDueDate(a, b) {
  if (!a.dueAt) return b.dueAt ? 1 : 0;
  if (!b.dueAt) return -1;
  return a.dueAt.localeCompare(b.dueAt);
}
