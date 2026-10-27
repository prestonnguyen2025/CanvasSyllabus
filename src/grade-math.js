// Grade math for the Grade Calculator. It follows Canvas's own calculator
// (canvas-lms ui/shared/grading: AssignmentGroupGradeCalculator and
// CourseGradeCalculator) so results line up with the grade Canvas shows:
// - Only assignments with a score count; excused, "doesn't count toward final
//   grade" and ungraded-type assignments never do.
// - Drop rules pick the drops that leave the best group percentage (drop lowest)
//   and then the worst (drop highest), never touching "never drop" assignments.
// - Weighted courses use groups that have points; if their weights add up to
//   less than 100 the result is scaled up to 100. Totals round to 2 decimals.
//
// A model is { weighted, groups: [{ id, weight, rules, items: [{ id, counts,
// pointsPossible }] }] }; valueOf(item) gives the points to use, or null to skip it.

// Canvas's default letter scale, used when the course's own scheme can't be read.
export const DEFAULT_SCHEME = [
  ["A", 94], ["A-", 90], ["B+", 87], ["B", 84], ["B-", 80], ["C+", 77],
  ["C", 74], ["C-", 70], ["D+", 67], ["D", 64], ["D-", 61], ["F", 0],
].map(([name, min]) => ({ name, min }));

const sum = (values) => values.reduce((a, b) => a + b, 0);
export const round2 = (x) => Math.round(x * 100) / 100;

// scheme: [{ name, min }] with min as a percent, highest first.
export function letterFor(percent, scheme) {
  if (percent == null) return null;
  return scheme.find((e) => percent >= e.min)?.name ?? scheme.at(-1)?.name ?? null;
}

// The lowest percent that earns each of A, B and C ("A" itself, else the lowest
// grade starting with that letter).
export function targetsFor(scheme) {
  return ["A", "B", "C"].flatMap((letter) => {
    const exact = scheme.find((e) => e.name.toUpperCase() === letter);
    const family = scheme.filter((e) => e.name.toUpperCase().startsWith(letter));
    const entry = exact ?? family.at(-1);
    return entry ? [{ name: letter, min: entry.min }] : [];
  });
}

export function computeGrade(model, valueOf) {
  const groups = model.groups.map((g) => groupGrade(g, valueOf));
  let exact = null; // unrounded, for "what do I need" so it never counts on rounding up
  if (model.weighted) {
    const relevant = groups.filter((g) => g.possible > 0);
    const fullWeight = sum(relevant.map((g) => g.weight));
    if (fullWeight > 0) {
      let total = sum(relevant.map((g) => (g.score / g.possible) * g.weight));
      if (fullWeight < 100) total = (total / fullWeight) * 100;
      exact = total;
    }
  } else {
    const possible = sum(groups.map((g) => g.possible));
    if (possible > 0) exact = (sum(groups.map((g) => g.score)) / possible) * 100;
  }
  const dropped = new Set(groups.flatMap((g) => [...g.dropped]));
  return { percent: exact == null ? null : round2(exact), exact, groups, dropped };
}

function groupGrade(group, valueOf) {
  const scored = group.items
    .filter((item) => item.counts)
    .map((item) => ({ item, score: valueOf(item), total: item.pointsPossible || 0 }))
    .filter((s) => s.score != null);
  const kept = new Set(dropAssignments(scored, group.rules));
  const keptList = scored.filter((s) => kept.has(s));
  return {
    id: group.id,
    weight: group.weight || 0,
    score: sum(keptList.map((s) => s.score)),
    possible: sum(keptList.map((s) => s.total)),
    dropped: new Set(scored.filter((s) => !kept.has(s)).map((s) => s.item.id)),
  };
}

// Returns the submissions that stay after the group's drop rules.
export function dropAssignments(subs, rules) {
  let dropLowest = rules?.dropLowest || 0;
  let dropHighest = rules?.dropHighest || 0;
  if (!dropLowest && !dropHighest) return subs;
  const never = rules.neverDrop ?? new Set();
  const cannotDrop = subs.filter((s) => never.has(s.item.id));
  const droppable = subs.filter((s) => !never.has(s.item.id));
  if (!droppable.length) return cannotDrop;

  dropLowest = Math.min(dropLowest, droppable.length - 1);
  if (dropLowest + dropHighest >= droppable.length) dropHighest = 0;
  const keepHighest = droppable.length - dropLowest;
  const keepLowest = keepHighest - dropHighest;

  const kept = droppable.some((s) => s.total > 0)
    ? keepByRatio(keepByRatio(droppable, keepHighest, cannotDrop, true), keepLowest, cannotDrop, false)
    : [...droppable].sort((a, b) => a.score - b.score).slice(-keepHighest).slice(0, keepLowest);
  return [...kept, ...cannotDrop];
}

// Keeps the `keep` submissions that, together with the undroppable ones, give
// the group its best (or, for drop-highest, its worst) percentage. Like Canvas,
// it binary-searches the group percentage q: at the right q, the items with the
// largest (smallest) score - q * total, plus the undroppable ones, sum to zero.
function keepByRatio(subs, keep, cannotDrop, best) {
  keep = Math.max(1, keep);
  if (subs.length <= keep) return subs;
  const value = (s, q) => s.score - q * s.total;
  const pick = (q) =>
    [...subs].sort((a, b) => (best ? value(b, q) - value(a, q) : value(a, q) - value(b, q))).slice(0, keep);
  const f = (q) => sum(cannotDrop.map((s) => value(s, q))) + sum(pick(q).map((s) => value(s, q)));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60 && f(hi) > 0; i++) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return pick((lo + hi) / 2);
}

// The fewest points on `item` that bring the course grade to targetPercent,
// holding every other assignment at valueOf. Searches up to 3x the item's points.
export function scoreNeeded(model, valueOf, item, targetPercent) {
  const EPS = 1e-9; // floating-point slack, so 88 isn't reported as 88.01
  const gradeWith = (x) => (computeGrade(model, (i) => (i.id === item.id ? x : valueOf(i))).exact ?? 0) + EPS;
  const max = Math.max(item.pointsPossible || 0, 1) * 3;
  if (gradeWith(0) >= targetPercent) return { status: "secured" };
  if (gradeWith(max) < targetPercent) return { status: "unreachable" };
  let lo = 0;
  let hi = max;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (gradeWith(mid) >= targetPercent) hi = mid;
    else lo = mid;
  }
  return { status: "needed", points: Math.ceil(hi * 100 - 1e-6) / 100 };
}
