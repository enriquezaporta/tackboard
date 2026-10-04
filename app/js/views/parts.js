// Piezas de interfaz compartidas por varias pantallas.
import * as S from '../store.js';
import { esc, icon, dueLabel, isOverdue } from '../util.js';
import { PRIO_NAME } from '../sheets.js';

// "Hoy", "Ayer" y los días de la semana van en minúscula detrás de "Venció".
const lowerDay = (s) => (/^(Hoy|Ayer|Mañana|Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo)/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function labelChips(card, board) {
  const labels = board?.data.labels || [];
  const chips = card.data.labels.map((id) => labels.find((l) => l.id === id)).filter(Boolean)
    .map((l) => `<span class="lbl" data-c="${esc(l.color)}">${esc(l.name || '·')}</span>`);
  if (card.data.priority) chips.unshift(`<span class="lbl prio-${card.data.priority}">${PRIO_NAME[card.data.priority]}</span>`);
  return chips.length ? `<span class="labels">${chips.join('')}</span>` : '';
}

function checkMeta(d) {
  if (!d.checklist.length) return '';
  const n = d.checklist.filter((i) => i.done).length;
  return `<span class="tag">${icon('list', 's')}${n}/${d.checklist.length}</span>`;
}

/** Tarjeta dentro de una columna del tablero. */
export function boardCard(card, board, draggable) {
  const d = card.data;
  const late = isOverdue(d);
  const meta = [
    d.due ? `<span class="${late ? 'late' : 'when'}">${late ? `Venció ${esc(lowerDay(dueLabel(d.due, d.dueTime)))}` : esc(dueLabel(d.due, d.dueTime))}</span>` : '',
    checkMeta(d),
    d.due && !d.done && d.reminders?.length ? `<span class="tag" title="Con aviso">${icon('bell', 's')}</span>` : '',
    d.description ? `<span class="tag" title="Tiene descripción">${icon('text', 's')}</span>` : '',
  ].filter(Boolean).join('');
  return `<button type="button" class="card ${late ? 'overdue' : ''} ${d.done ? 'is-done' : ''}" data-open="${esc(card.id)}"
      ${draggable ? `data-drag="${esc(card.id)}"` : ''}>
    ${labelChips(card, board)}
    <span class="t">${esc(d.title)}</span>
    ${meta ? `<span class="meta">${meta}</span>` : ''}
  </button>`;
}

/** Fila de tarea con casilla para completar (pantalla Hoy). */
export function taskRow(card) {
  const d = card.data;
  const b = S.board(card.boardId);
  const late = isOverdue(d);
  const canWrite = S.can(card.boardId, 'write');
  const shared = (S.state.boardInfo.get(card.boardId)?.members || 1) > 1;
  return `<div class="task ${late ? 'overdue' : ''} ${d.done ? 'done' : ''}">
    <button type="button" class="check" role="checkbox" aria-checked="${d.done}" data-toggle="${esc(card.id)}"
      aria-label="${d.done ? 'Reabrir' : 'Completar'} «${esc(d.title)}»" ${canWrite ? '' : 'disabled'}>${icon('check', 's')}</button>
    <button type="button" class="task-body" data-open="${esc(card.id)}">
      <span class="task-title">${esc(d.title)}</span>
      <span class="meta">
        ${d.due ? `<span class="${late ? 'late' : 'when'}">${esc(dueLabel(d.due, d.dueTime))}</span>` : ''}
        <span class="tag"><span class="dot" data-c="${esc(b?.data.color)}"></span>${esc(b?.data.name || '')}</span>
        ${checkMeta(d)}
        ${shared ? '<span class="tag">Compartido</span>' : ''}
      </span>
      ${d.checklist.length ? `<span class="progress"><i data-p="${Math.round(d.checklist.filter((i) => i.done).length / d.checklist.length * 100)}" data-c="${esc(b?.data.color)}"></i></span>` : ''}
    </button>
  </div>`;
}

/** Fila compacta para el calendario. */
export function miniRow(card, draggable) {
  const d = card.data;
  const b = S.board(card.boardId);
  return `<button type="button" class="mini ${isOverdue(d) ? 'overdue' : ''} ${d.done ? 'is-done' : ''}" data-open="${esc(card.id)}"
      ${draggable && S.can(card.boardId, 'write') ? `data-drag="${esc(card.id)}"` : ''}>
    <span class="when ${d.dueTime ? '' : 'notime'}">${esc(d.dueTime || '—')}</span><span class="dot" data-c="${esc(b?.data.color)}"></span><span class="tt">${esc(d.title)}</span></button>`;
}

export const sortByDue = (a, b) => (a.data.due.localeCompare(b.data.due)) || ((a.data.dueTime || '99').localeCompare(b.data.dueTime || '99')) || a.data.title.localeCompare(b.data.title);

/** Recuento de un tablero: abiertas, vencidas, hechas y total (sin archivadas). */
export function boardStats(boardId, today) {
  const list = S.cards((c) => c.boardId === boardId && !c.data.archived);
  let open = 0, late = 0, done = 0;
  for (const c of list) {
    if (c.data.done) done++;
    else { open++; if (c.data.due && c.data.due < today) late++; }
  }
  return { open, late, done, total: list.length };
}
