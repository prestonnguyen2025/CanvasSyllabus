// Small helpers shared by the pages: building elements and formatting dates.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// "2026-11-04" -> local midnight (new Date("2026-11-04") would be UTC), or null.
export function parseDay(iso) {
  const [y, m, d] = (iso || "").split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

// "2026-11-04" -> "Nov 4" (or with other toLocaleDateString options); unparseable dates come back as is.
export function formatDay(iso, options = { month: "short", day: "numeric" }) {
  const day = parseDay(iso);
  return day ? day.toLocaleDateString("en-US", options) : iso;
}

// "19:30" -> "7:30 PM"
export function formatTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  return new Date(2000, 0, 1, h, m || 0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Like Promise.all(items.map(fn)), but with at most `limit` calls running at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
