// Pantalla Hoy: vencidas, de hoy y próximos 7 días.
import * as S from '../store.js';
import { esc, icon, todayStr, addDays, parseDate, DOW, MONTHS, plural } from '../util.js';
import { taskRow, sortByDue } from './parts.js';
import { openCard, openNewTask, openNewBoard, openInvitations } from '../sheets.js';

export function renderToday(main) {
  const t = todayStr();
  const week = addDays(t, 7);
  const now = parseDate(t);
  const all = S.datedCards().filter((c) => !c.data.archived);
  const overdue = all.filter((c) => !c.data.done && c.data.due < t).sort(sortByDue);
  const today = all.filter((c) => c.data.due === t).sort((a, b) => (a.data.done - b.data.done) || sortByDue(a, b));
  const next = all.filter((c) => !c.data.done && c.data.due > t && c.data.due <= week).sort(sortByDue);
  const todayOpen = today.filter((c) => !c.data.done).length;
  const hasBoards = S.boards().length > 0;

  main.innerHTML = `
    <header class="page-head">
      <div><div class="eyebrow">${esc(DOW[now.getDay()])} · ${now.getDate()} ${esc(MONTHS[now.getMonth()])}</div><h1>Hoy</h1></div>
    </header>
    ${S.state.invitations ? `<div class="section"><button type="button" class="callout list-row" data-act="invitations">
      ${icon('inbox')}<span class="grow">Tienes ${plural(S.state.invitations, 'invitación', 'invitaciones')} a tableros</span>${icon('right', 's')}</button></div>` : ''}
    <div class="summary-chips chips">
      ${overdue.length ? `<span class="chip danger">${plural(overdue.length, 'vencida', 'vencidas')}</span>` : ''}
      <span class="chip accent">${todayOpen} para hoy</span>
      <span class="chip">${next.length} en 7 días</span>
    </div>
    <div class="section today-wrap">
      ${!hasBoards ? `<div class="empty"><strong>Empieza creando un tablero</strong>Un tablero agrupa tareas de un ámbito: Casa, Trabajo, Homelab…
          <p><button type="button" class="btn primary" data-act="new-board">${icon('plus', 's')} Crear tablero</button></p></div>` : ''}
      ${overdue.length ? `<h2 class="section-title danger">Vencidas</h2>${overdue.map(taskRow).join('')}` : ''}
      <h2 class="section-title accent">Hoy</h2>
      ${today.length ? today.map(taskRow).join('') : `<div class="empty">Nada para hoy.${hasBoards ? ' Pulsa + para añadir una tarea.' : ''}</div>`}
      ${next.length ? `<h2 class="section-title">Próximos 7 días</h2>${next.map(taskRow).join('')}` : ''}
    </div>
    ${hasBoards ? `<button type="button" class="fab" data-act="new-task" aria-label="Nueva tarea">${icon('plus')}</button>` : ''}`;

  main.onclick = (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) { S.toggleDone(tg.dataset.toggle); return; }
    const op = e.target.closest('[data-open]');
    if (op) { openCard(op.dataset.open); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new-task') openNewTask({ due: t });
    if (act === 'new-board') openNewBoard();
    if (act === 'invitations') openInvitations();
  };
}
