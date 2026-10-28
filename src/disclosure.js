// Animate measured heights so arbitrary content can expand without max-height
// guesses. Reversing a toggle starts at the current frame, without a jump.
const running = new WeakMap();
const TIMING = { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

export function setDisclosureExpanded(body, expanded, control) {
  const previous = running.get(body);
  const height = body.hidden ? 0 : body.getBoundingClientRect().height;
  const opacity = body.hidden ? 0 : Number(getComputedStyle(body).opacity);
  const overflow = previous?.overflow ?? body.style.overflow;
  previous?.animation.cancel();
  running.delete(body);

  if (!expanded && body.contains(document.activeElement)) control?.focus({ preventScroll: true });
  body.hidden = false;
  body.inert = !expanded;
  body.setAttribute("aria-hidden", String(!expanded));

  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !body.isConnected) {
    body.hidden = !expanded;
    body.style.overflow = overflow;
    return Promise.resolve();
  }

  const endHeight = expanded ? body.getBoundingClientRect().height : 0;
  body.style.overflow = "hidden";
  const animation = body.animate([
    { height: `${height}px`, opacity },
    { height: `${endHeight}px`, opacity: expanded ? 1 : 0 },
  ], TIMING);
  const state = { animation, overflow };
  running.set(body, state);
  return animation.finished.then(() => {
    if (running.get(body) !== state) return;
    body.hidden = !expanded;
    body.style.overflow = overflow;
    running.delete(body);
  }, () => {}); // A rapid reverse cancels the previous animation intentionally.
}

export function animateDetails(details, body) {
  const summary = details.querySelector("summary");
  let expanded = details.open;
  let generation = 0;
  body.hidden = !expanded;
  body.inert = !expanded;
  details.classList.toggle("is-collapsed", !expanded);
  summary.setAttribute("aria-expanded", String(expanded));
  summary.setAttribute("aria-controls", body.id);

  summary.addEventListener("click", (event) => {
    event.preventDefault();
    const mine = ++generation;
    expanded = !expanded;
    if (expanded) details.open = true;
    summary.setAttribute("aria-expanded", String(expanded));
    details.classList.toggle("is-collapsed", !expanded);
    setDisclosureExpanded(body, expanded, summary).then(() => {
      // Native details must stay open until its closing animation completes.
      if (mine === generation) details.open = expanded;
    });
  });
}
