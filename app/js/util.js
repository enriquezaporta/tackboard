// Utilidades comunes.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapa texto para meterlo en HTML. TODO dato del usuario pasa por aquí. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Identificador aleatorio de 22 caracteres (128 bits). */
export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const shortId = () => uid().slice(0, 10);

export const COLORS = ['#0E6B62', '#2457A6', '#9A6200', '#B4400B', '#6B3FA0', '#A12C5B', '#3D6B1F', '#4A5752'];
export const COLOR_NAMES = ['Verde azulado', 'Azul', 'Ámbar', 'Teja', 'Morado', 'Frambuesa', 'Verde', 'Pizarra'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const safeColor = (c) => (COLOR_RE.test(c || '') ? c : COLORS[0]);

/** Aplica colores con CSSOM (la CSP no permite atributos style en el HTML). */
export function paint(root) {
  for (const el of root.querySelectorAll('[data-c]')) el.style.setProperty('--c', safeColor(el.dataset.c));
  for (const el of root.querySelectorAll('[data-p]')) el.style.setProperty('--p', `${Math.max(0, Math.min(100, +el.dataset.p || 0))}%`);
}

// ---------- Fechas (siempre en hora local, formato YYYY-MM-DD) ----------
const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => dateStr(new Date());
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}
export const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const DOW_SHORT = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const MONTHS_SHORT = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Momento de vencimiento en milisegundos (para ordenar y, más adelante, para los avisos). */
/** Referencia para los avisos: la hora de vencimiento o, en tareas de todo el día, las 9:00 de ese día. */
export function alertBase(due, time) {
  if (!due) return null;
  const d = parseDate(due);
  if (time) {
    const [h, m] = time.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  } else d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** Recordatorios posibles, en el orden en que se muestran. */
export const REMINDERS = [['2d', '2 días antes'], ['1d', '1 día antes'], ['3h', '3 h antes'], ['1h', '1 h antes'], ['15m', '15 min antes'], ['due', 'Al vencer']];

export function dueAt(due, time) {
  if (!due) return null;
  const d = parseDate(due);
  if (time) {
    const [h, m] = time.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  } else d.setHours(23, 59, 0, 0);
  return d.getTime();
}

/** Texto corto para una fecha de vencimiento, relativo a hoy. */
export function dueLabel(due, time) {
  if (!due) return '';
  const t = todayStr();
  const diff = Math.round((parseDate(due) - parseDate(t)) / 86400000);
  let day;
  if (diff === 0) day = 'Hoy';
  else if (diff === 1) day = 'Mañana';
  else if (diff === -1) day = 'Ayer';
  else if (diff > 1 && diff < 7) day = cap(DOW[parseDate(due).getDay()]);
  else {
    const d = parseDate(due);
    day = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()].toLowerCase()}`;
    if (d.getFullYear() !== new Date().getFullYear()) day += ` ${d.getFullYear()}`;
  }
  return time ? `${day} ${time}` : day;
}

export function isOverdue(card) {
  if (!card.due || card.done) return false;
  return (card.dueAt ?? dueAt(card.due, card.dueTime)) < Date.now();
}

// ---------- Avisos breves ----------
let toastTimer;
export function toast(msg, action) {
  const el = document.getElementById('toast');
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.append(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.classList.remove('show'); action.run(); });
    el.append(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 3000);
}

// ---------- Iconos (trazos propios, sin dependencias) ----------
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  repeat: '<path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  filter: '<path d="M4 5h16l-6 8v5l-4 2v-7z"/>',
  pin: '<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
};
export const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
