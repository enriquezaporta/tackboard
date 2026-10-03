// Arrastrar y soltar con eventos de puntero: ratón, dedo y lápiz.
//  - Ratón: empieza al mover más de 6 px con el botón pulsado.
//  - Táctil: pulsación larga (350 ms) sin moverse; si el dedo se mueve antes, es un desplazamiento normal.
// Destinos: [data-drop-col] (lista de tarjetas de una columna) y [data-drop-day] (día del calendario).

const LONG_PRESS = 350;
const MOUSE_SLOP = 6;
const TOUCH_SLOP = 10;
const EDGE = 56;

let active = null;   // arrastre en curso
let pending = null;  // pulsación que aún puede convertirse en arrastre
let suppressClick = false;

/**
 * Activa el arrastre dentro de `root`.
 * @param {HTMLElement} root
 * @param {{onDrop: (info) => void, canDrag?: (el) => boolean}} opts
 */
export function enableDrag(root, opts) {
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = e.target.closest('[data-drag]');
    if (!el || !root.contains(el) || e.target.closest('input,textarea,select,[data-nodrag]')) return;
    if (opts.canDrag && !opts.canDrag(el)) return;
    pending = { el, opts, x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, timer: null };
    if (e.pointerType !== 'mouse') {
      pending.timer = setTimeout(() => { if (pending) start(pending.x, pending.y); }, LONG_PRESS);
    }
  });
}

document.addEventListener('pointermove', (e) => {
  if (pending && e.pointerId === pending.id && !active) {
    const dx = e.clientX - pending.x, dy = e.clientY - pending.y;
    const dist = Math.hypot(dx, dy);
    if (pending.type === 'mouse') {
      if (dist > MOUSE_SLOP) start(e.clientX, e.clientY);
    } else if (dist > TOUCH_SLOP) {
      clearTimeout(pending.timer);
      pending = null; // era un desplazamiento
    } else {
      pending.x = e.clientX; pending.y = e.clientY;
    }
  }
  if (active && e.pointerId === active.id) {
    e.preventDefault();
    move(e.clientX, e.clientY);
  }
}, { passive: false });

// Mientras se arrastra con el dedo, la página no debe desplazarse.
document.addEventListener('touchmove', (e) => { if (active) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (active || pending?.type === 'touch') e.preventDefault(); });

function finish(e, cancelled) {
  if (pending) { clearTimeout(pending.timer); pending = null; }
  if (!active || (e && e.pointerId !== active.id)) return;
  const a = active;
  active = null;
  cancelAnimationFrame(a.raf);
  a.ghost.remove();
  a.marker?.remove();
  a.dayEl?.classList.remove('drop-day');
  a.el.classList.remove('dragging-src');
  document.body.classList.remove('is-dragging');
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 50);
  if (!cancelled && a.target) a.opts.onDrop({ id: a.el.dataset.drag, ...a.target });
}
document.addEventListener('pointerup', (e) => finish(e, false));
document.addEventListener('pointercancel', (e) => finish(e, true));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) finish(null, true); });
// Tras soltar, el navegador lanza un clic sobre la tarjeta: se ignora.
document.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

function start(x, y) {
  const p = pending;
  pending = null;
  if (!p) return;
  clearTimeout(p.timer);
  const rect = p.el.getBoundingClientRect();
  const ghost = p.el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.removeAttribute('id');
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);
  p.el.classList.add('dragging-src');
  document.body.classList.add('is-dragging');
  if (navigator.vibrate && p.type !== 'mouse') { try { navigator.vibrate(15); } catch { /* sin vibración */ } }
  active = { ...p, ghost, offX: x - rect.left, offY: y - rect.top, x, y, target: null, marker: null, dayEl: null, raf: 0,
    scroller: p.el.closest('.columns') };
  move(x, y);
  autoScroll();
}

function move(x, y) {
  const a = active;
  a.x = x; a.y = y;
  a.ghost.style.transform = `translate(${x - a.offX}px, ${y - a.offY}px) rotate(2deg)`;
  const under = document.elementFromPoint(Math.min(Math.max(x, 1), innerWidth - 2), Math.min(Math.max(y, 1), innerHeight - 2));
  const col = under?.closest('[data-drop-col]');
  const day = under?.closest('[data-drop-day]');
  if (a.dayEl && a.dayEl !== day) { a.dayEl.classList.remove('drop-day'); a.dayEl = null; }
  if (col) {
    const items = [...col.querySelectorAll(':scope > [data-drag]')].filter((n) => n !== a.el);
    let index = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    if (!a.marker) { a.marker = document.createElement('div'); a.marker.className = 'drop-marker'; }
    const ref = items[index] || null;
    if (ref) col.insertBefore(a.marker, ref);
    else col.append(a.marker);
    a.target = { columnId: col.dataset.dropCol, index };
  } else {
    a.marker?.remove();
    if (day) {
      day.classList.add('drop-day');
      a.dayEl = day;
      a.target = { day: day.dataset.dropDay };
    } else a.target = null;
  }
}

/** Desplaza el tablero o la página cuando el puntero se acerca a un borde. */
function autoScroll() {
  const a = active;
  if (!a) return;
  const { x, y } = a;
  const under = document.elementFromPoint(Math.min(Math.max(x, 1), innerWidth - 2), Math.min(Math.max(y, 1), innerHeight - 2));
  const scroller = a.scroller;
  if (scroller) {
    const r = scroller.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, innerWidth);
    if (x < left + EDGE) scroller.scrollLeft -= 10;
    else if (x > right - EDGE) scroller.scrollLeft += 10;
  }
  const list = under?.closest('.cards');
  if (list) {
    const r = list.getBoundingClientRect();
    if (y < r.top + 40) list.scrollTop -= 10;
    else if (y > r.bottom - 40) list.scrollTop += 10;
  }
  if (y < 60) window.scrollBy(0, -10);
  else if (y > innerHeight - 90) window.scrollBy(0, 10);
  move(x, y);
  a.raf = requestAnimationFrame(autoScroll);
}

export const isDragging = () => !!active;
