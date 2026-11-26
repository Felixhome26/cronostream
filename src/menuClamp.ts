// Keeps every `.context-menu` inside the viewport: menus are positioned at the
// click point, so near the bottom/right edge (or when their content grows after
// mount, like the reveal entries) they would otherwise run off-screen.
const MARGIN = 8;

function clamp(el: HTMLElement) {
  if (el.dataset.clampX === undefined) {
    el.dataset.clampX = String(parseFloat(el.style.left) || 0);
    el.dataset.clampY = String(parseFloat(el.style.top) || 0);
  }
  const x = Number(el.dataset.clampX);
  const y = Number(el.dataset.clampY);
  const maxH = window.innerHeight - 2 * MARGIN;
  el.style.maxHeight = `${maxH}px`;
  el.style.overflowY = "auto";
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(MARGIN, Math.min(x, window.innerWidth - r.width - MARGIN))}px`;
  el.style.top = `${Math.max(MARGIN, Math.min(y, window.innerHeight - r.height - MARGIN))}px`;
}

export function installMenuClamp() {
  const sizeObserver = new ResizeObserver((entries) => {
    for (const e of entries) clamp(e.target as HTMLElement);
  });
  const attach = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    const menus = node.matches(".context-menu") ? [node] : Array.from(node.querySelectorAll<HTMLElement>(".context-menu"));
    for (const m of menus) {
      sizeObserver.observe(m);
      clamp(m);
    }
  };
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach(attach);
  }).observe(document.body, { childList: true, subtree: true });
}
