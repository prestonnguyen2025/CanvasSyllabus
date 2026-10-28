// Grade math for the Grade Calculator. It follows Canvas's own calculator
// (canvas-lms ui/shared/grading: AssignmentGroupGradeCalculator and
// CourseGradeCalculator) so results line up with the grade Canvas shows:
// - Only assignments with a score count; excused, "doesn't count toward final
//   grade" and ungraded-type assignments never do.
// - Drop rules pick the drops that leave the best group percentage (drop lowest)
//   and then the worst (drop highest), never touching "never drop" assignments.
//   Unlike Canvas, a group's drops wait until every assignment in it has a score,
//   since an ungraded one could still turn out to be the lowest.
// - Weighted courses use groups that have points; if their weights add up to
//   less than 100 the result is scaled up to 100. Totals round to 2 decimals.
//
// A model is { weighted, groups: [{ id, weight, rules, items: [{ id, counts,
// pointsPossible }] }] }; valueOf(item) gives the points to use, or null to skip it.

const sum = (values) => values.reduce((a, b) => a + b, 0);
export const round2 = (x) => Math.round(x * 100) / 100;

// Ignore floating-point noise at a boundary, without rounding grades to the
// displayed two decimals. >93 and >=93 are different course requirements.
export function meetsCutoff(percent, cutoff) {
  if (percent == null || !Number.isFinite(percent)) return false;
  const difference = percent - cutoff.min;
  return cutoff.inclusive === false ? difference > 1e-10 : difference >= -1e-10;
}

// scheme: [{ name, min, inclusive? }], highest first. An incomplete/unknown
// scale cannot assign a letter below its lowest stated boundary.
export function letterFor(percent, scheme) {
  if (percent == null) return null;
  return scheme.find((e) => meetsCutoff(percent, e))?.name ?? null;
}

// Preserve the actual course labels, including A+, A-, and pass/fail scales.
export function targetsFor(scheme) {
  return scheme.filter((e) => e.min > 0 || e.inclusive === false);
}

// options.applyDrops: drop scores now, from the assignments scored so far, like Canvas does,
// instead of waiting until every assignment in the group has a score.
export function computeGrade(model, valueOf, options = {}) {
  const groups = model.groups.map((g) => groupGrade(g, valueOf, options));
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
  const held = new Set(groups.filter((g) => g.holding).map((g) => g.id)); // groups whose drops are waiting
  return { percent: exact == null ? null : round2(exact), exact, groups, dropped, held };
}

function groupGrade(group, valueOf, options) {
  const counting = group.items.filter((item) => item.counts);
  const scored = counting
    .map((item) => ({ item, score: valueOf(item), total: item.pointsPossible || 0 }))
    .filter((s) => s.score != null);
  const hasDrops = Boolean(group.rules?.dropLowest || group.rules?.dropHighest);
  const holding = hasDrops && !options.applyDrops && scored.length < counting.length;
  const kept = new Set(holding ? scored : dropAssignments(scored, group.rules));
  const keptList = scored.filter((s) => kept.has(s));
  return {
    id: group.id,
    holding,
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
export function scoreNeeded(model, valueOf, item, targetPercent, options = {}) {
  const cutoff = typeof targetPercent === "number" ? { min: targetPercent } : targetPercent;
  const passes = (cents) => meetsCutoff(
    computeGrade(model, (i) => (i.id === item.id ? cents / 100 : valueOf(i)), options).exact,
    cutoff
  );
  // Search the hundredth-point scores the calculator actually accepts. Rounding
  // a continuous answer at >93 back down to 93 would fail the strict cutoff.
  const max = Math.floor(Math.max(item.pointsPossible || 0, 1) * 300);
  if (passes(0)) return { status: "secured" };
  if (!passes(max)) return { status: "unreachable" };
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { status: "needed", points: hi / 100 };
}
