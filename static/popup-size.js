// Start with explicit CSS dimensions so Chrome can measure the popup. After
// native sizing, fit the root to the available viewport without outer scrollbars.
function fitPopupViewport() {
  // Chrome begins popup measurement at 25 × 25. Never lock in that placeholder.
  if (window.innerWidth <= 25 || window.innerHeight <= 25) return;
  const root = document.documentElement;
  root.style.width = `${Math.min(520, window.innerWidth)}px`;
  root.style.height = `${Math.min(520, window.innerHeight)}px`;
}

window.addEventListener("resize", fitPopupViewport);
window.addEventListener("load", () => requestAnimationFrame(fitPopupViewport));
