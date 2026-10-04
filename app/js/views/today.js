// Pantalla Hoy: vencidas, de hoy y próximos 7 días.
import * as S from '../store.js';
import { esc, icon, todayStr, addDays, parseDate, DOW, MONTHS, plural } from '../util.js';
import { taskRow, sortByDue, boardStats } from './parts.js';
import { openCard, openNewTask, openNewBoard, openInvitations } from '../sheets.js';

export function renderToday(main) {
  const t = todayStr();
  const week = addDays(t, 7);
  const now = parseDate(t);
  const me = S.state.user?.username;
  const shared = S.boards().some((b) => (S.state.boardInfo.get(b.id)?.members || 1) > 1);
  const hideOthers = shared && S.state.settings.hideOthers;
  // «Ocultar las de otros»: fuera las tareas asignadas solo a otras personas.
  const mine = (c) => !hideOthers || !(c.data.assignees || []).length || c.data.assignees.includes(me);
  const all = S.datedCards().filter((c) => !c.data.archived && mine(c));
  const overdue = all.filter((c) => !c.data.done && c.data.due < t).sort(sortByDue);
  const today = all.filter((c) => c.data.due === t).sort((a, b) => (a.data.done - b.data.done) || sortByDue(a, b));
  const next = all.filter((c) => !c.data.done && c.data.due > t && c.data.due <= week).sort(sortByDue);
  const todayOpen = today.filter((c) => !c.data.done).length;
  const hasBoards = S.boards().length > 0;

  const boards = S.boards();
  const stats = boards.map((b) => ({ b, ...boardStats(b.id, t) }));

  main.innerHTML = `<div class="page">
    <header class="page-head">
      <div><div class="eyebrow">${esc(DOW[now.getDay()])} · ${now.getDate()} ${esc(MONTHS[now.getMonth()])}</div><h1>Hoy</h1></div>
      <span class="head-actions"><a class="icon-btn" href="#/buscar" aria-label="Buscar">${icon('search')}</a>
      ${hasBoards ? `<button type="button" class="btn primary desk-only" data-act="new-task">${icon('plus', 's')} Nueva tarea</button>` : ''}</span>
    </header>
    ${S.state.invitations ? `<div class="section"><button type="button" class="callout list-row" data-act="invitations">
      ${icon('inbox')}<span class="grow">Tienes ${plural(S.state.invitations, 'invitación', 'invitaciones')} a tableros</span>${icon('right', 's')}</button></div>` : ''}
    ${hasBoards ? `<div class="summary-chips chips">
      ${overdue.length ? `<span class="chip danger">${plural(overdue.length, 'vencida', 'vencidas')}</span>` : ''}
      <span class="chip accent">${todayOpen} para hoy</span>
      <span class="chip">${next.length} en 7 días</span>
      ${shared ? `<button type="button" class="chip" data-act="others" aria-pressed="${!!hideOthers}">Ocultar las de otros</button>` : ''}
    </div>` : ''}
    ${!hasBoards ? `<div class="section"><div class="empty-card"><strong>Empieza creando un tablero</strong>
        <span>Un tablero agrupa las tareas de un ámbito: Casa, Trabajo, Homelab…</span>
        <button type="button" class="btn primary" data-act="new-board">${icon('plus', 's')} Crear tablero</button></div></div>` : `
    <div class="section today-grid">
      <section class="today-col" aria-label="Para hoy">
        ${overdue.length ? `<h2 class="section-title danger">Vencidas</h2>${overdue.map(taskRow).join('')}` : ''}
        <h2 class="section-title accent">Hoy</h2>
        ${today.length ? today.map(taskRow).join('') : '<div class="empty small-empty">Nada para hoy.</div>'}
      </section>
      <section class="today-col" aria-label="Próximos 7 días">
        <h2 class="section-title">Próximos 7 días</h2>
        ${next.length ? next.map(taskRow).join('') : '<div class="empty small-empty">Nada con fecha esta semana.</div>'}
      </section>
      <section class="today-col today-boards" aria-label="Tus tableros">
        <h2 class="section-title">Tus tableros</h2>
        <div class="list">${stats.map(({ b, open, late }) => `<a class="list-row" href="#/tablero/${esc(b.id)}">
          <span class="sq" data-c="${esc(b.data.color)}"></span><span class="grow">${esc(b.data.name)}</span>
          ${late ? `<span class="chip danger">${late}</span>` : ''}<span class="muted small">${plural(open, 'abierta', 'abiertas')}</span></a>`).join('')}</div>
      </section>
    </div>`}
    </div>
    ${hasBoards ? `<button type="button" class="fab mobile-only" data-act="new-task" aria-label="Nueva tarea">${icon('plus')}</button>` : ''}`;

  main.onclick = (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) { S.toggleDone(tg.dataset.toggle); return; }
    const op = e.target.closest('[data-open]');
    if (op) { openCard(op.dataset.open); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new-task') openNewTask({ due: t });
    if (act === 'new-board') openNewBoard();
    if (act === 'invitations') openInvitations();
    if (act === 'others') S.saveSettings({ hideOthers: !S.state.settings.hideOthers });
  };
}
