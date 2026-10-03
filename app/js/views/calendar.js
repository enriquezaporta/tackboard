// Calendario: mes, semana y lista. Las tarjetas se pueden arrastrar a otro día para cambiar su fecha.
import * as S from '../store.js';
import { esc, icon, todayStr, addDays, parseDate, dateStr, DOW, MONTHS, cap, isOverdue, toast, dueLabel } from '../util.js';
import { miniRow, sortByDue } from './parts.js';
import { enableDrag } from '../drag.js';
import { openCard, openNewTask } from '../sheets.js';

const view = { mode: 'month', selected: null, month: null, filter: null };

function mondayOf(s) {
  const d = parseDate(s);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return dateStr(d);
}

export function renderCalendar(main, routeBoard = null) {
  const t = todayStr();
  if (!view.selected) view.selected = t;
  if (!view.month) view.month = t.slice(0, 7);
  const boardId = routeBoard && S.board(routeBoard) ? routeBoard : null;
  const filterBoard = boardId || (view.filter && S.board(view.filter) ? view.filter : null);
  const cards = S.datedCards(filterBoard);
  const byDay = new Map();
  for (const c of cards) {
    if (!byDay.has(c.data.due)) byDay.set(c.data.due, []);
    byDay.get(c.data.due).push(c);
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.data.done - b.data.done) || sortByDue(a, b));
  const b = boardId ? S.board(boardId) : null;
  const [y, m] = view.month.split('-').map(Number);

  const header = boardId
    ? `<header class="board-head"><div class="top"><a class="board-switch" href="#/tablero/${esc(boardId)}"><span class="sq" data-c="${esc(b.data.color)}"></span><h1>${esc(b.data.name)}</h1></a></div>
        <div class="toolbar"><span class="seg"><a href="#/tablero/${esc(boardId)}">Tablero</a><a href="#/calendario/${esc(boardId)}" aria-current="page">Calendario</a></span></div></header>`
    : `<header class="page-head"><h1>Calendario</h1></header>
       ${S.boards().length > 1 ? `<div class="cal-filter"><button type="button" class="chip" data-filter="" aria-pressed="${!filterBoard}">Todos</button>
         ${S.boards().map((bb) => `<button type="button" class="chip" data-filter="${esc(bb.id)}" aria-pressed="${filterBoard === bb.id}">
           <span class="dot" data-c="${esc(bb.data.color)}"></span>${esc(bb.data.name)}</button>`).join('')}</div>` : ''}`;

  const modeBar = `<div class="section row">
      <span class="seg grow" role="group" aria-label="Vista">${[['month', 'Mes'], ['week', 'Semana'], ['list', 'Lista']].map(([k, n]) =>
        `<button type="button" data-mode="${k}" aria-pressed="${view.mode === k}">${n}</button>`).join('')}</span>
      ${view.mode !== 'list' ? `<button type="button" class="icon-btn" data-nav="-1" aria-label="${view.mode === 'month' ? 'Mes' : 'Semana'} anterior">${icon('left', 's')}</button>
      <button type="button" class="btn sm" data-nav="0">Hoy</button>
      <button type="button" class="icon-btn" data-nav="1" aria-label="${view.mode === 'month' ? 'Mes' : 'Semana'} siguiente">${icon('right', 's')}</button>` : ''}
    </div>`;

  let body = '';
  if (view.mode === 'month') {
    const first = `${view.month}-01`;
    const start = mondayOf(first);
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    const cells = days.map((d) => {
      const list = byDay.get(d) || [];
      const out = d.slice(0, 7) !== view.month;
      return `<div class="day ${out ? 'out' : ''} ${d === t ? 'today' : ''} ${d === view.selected ? 'sel' : ''}" data-drop-day="${d}" data-select="${d}">
        <button type="button" class="n" data-select="${d}" aria-pressed="${d === view.selected}" aria-label="${esc(cap(DOW[parseDate(d).getDay()]))} ${parseDate(d).getDate()}${list.length ? `, ${list.length} tareas` : ''}">${parseDate(d).getDate()}</button>
        <span class="dots">${list.slice(0, 4).map((c) => `<span class="dot" data-c="${esc(S.board(c.boardId)?.data.color)}"></span>`).join('')}</span>
        <span class="chipsx">${list.slice(0, 3).map((c) => miniRow(c, true)).join('')}${list.length > 3 ? `<span class="more">+${list.length - 3} más</span>` : ''}</span>
      </div>`;
    }).join('');
    body = `<div class="cal"><div class="cal-dows"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
      <div class="cal-grid">${cells}</div></div>`;
  } else if (view.mode === 'week') {
    const start = mondayOf(view.selected);
    body = Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => {
      const list = byDay.get(d) || [];
      const dd = parseDate(d);
      return `<div class="week-day ${d === t ? 'today' : ''}" data-drop-day="${d}">
        <h3><span>${esc(cap(DOW[dd.getDay()]))} ${dd.getDate()} ${esc(MONTHS[dd.getMonth()])}</span><span>${list.length || ''}</span></h3>
        ${list.map((c) => miniRow(c, true)).join('')}</div>`;
    }).join('');
  } else {
    const overdue = cards.filter((c) => !c.data.done && !c.data.archived && isOverdue(c.data)).sort(sortByDue);
    const days = [...byDay.keys()].filter((d) => d >= t).sort().slice(0, 60);
    body = (overdue.length ? `<div class="week-day"><h3 class="error-text"><span>Vencidas</span><span>${overdue.length}</span></h3>
        ${overdue.map((c) => miniRowWithDate(c)).join('')}</div>` : '')
      + (days.length ? days.map((d) => {
        const dd = parseDate(d);
        return `<div class="week-day ${d === t ? 'today' : ''}" data-drop-day="${d}"><h3><span>${esc(cap(dueLabel(d)))} · ${dd.getDate()} ${esc(MONTHS[dd.getMonth()])}</span></h3>
          ${byDay.get(d).map((c) => miniRow(c, true)).join('')}</div>`;
      }).join('') : '<div class="empty">No hay tareas con fecha a partir de hoy.</div>');
  }

  const sel = parseDate(view.selected);
  const selList = byDay.get(view.selected) || [];
  const side = view.mode === 'month' ? `<div class="day-panel">
      <h2 class="section-title">${esc(cap(DOW[sel.getDay()]))} ${sel.getDate()} · ${selList.length} ${selList.length === 1 ? 'tarea' : 'tareas'}</h2>
      ${selList.map((c) => miniRow(c, true)).join('')}
      ${S.boards().some((bb) => S.can(bb.id, 'write')) ? `<div class="sep"></div><button type="button" class="btn block" data-new="${view.selected}">${icon('plus', 's')} Añadir tarea este día</button>` : ''}
      <p class="hint">Mantén pulsada una tarea y arrástrala a otro día para cambiar su fecha.</p></div>` : '';

  main.innerHTML = `${header}
    ${view.mode === 'month' ? `<div class="section"><h2 class="cal-title">${esc(cap(MONTHS[m - 1]))} <span class="muted">${y}</span></h2></div>` : ''}
    ${modeBar}
    <div class="cal-wrap"><div class="cal-side" id="cal-root"><div>${body}</div>${side}</div></div>
    ${view.mode !== 'month' && S.boards().some((bb) => S.can(bb.id, 'write')) ? `<button type="button" class="fab" data-new="${view.selected}" aria-label="Nueva tarea">${icon('plus')}</button>` : ''}`;

  main.onclick = (e) => {
    const op = e.target.closest('[data-open]');
    if (op) return openCard(op.dataset.open);
    const nw = e.target.closest('[data-new]');
    if (nw) return openNewTask({ due: nw.dataset.new, boardId: filterBoard });
    const se = e.target.closest('[data-select]');
    if (se) { view.selected = se.dataset.select; if (se.dataset.select.slice(0, 7) !== view.month) view.month = se.dataset.select.slice(0, 7); return renderCalendar(main, routeBoard); }
    const md = e.target.closest('[data-mode]');
    if (md) { view.mode = md.dataset.mode; return renderCalendar(main, routeBoard); }
    const fl = e.target.closest('[data-filter]');
    if (fl) { view.filter = fl.dataset.filter || null; return renderCalendar(main, routeBoard); }
    const nv = e.target.closest('[data-nav]');
    if (nv) {
      const dir = Number(nv.dataset.nav);
      if (dir === 0) { view.selected = t; view.month = t.slice(0, 7); }
      else if (view.mode === 'month') {
        const d = new Date(y, m - 1 + dir, 1);
        view.month = dateStr(d).slice(0, 7);
        view.selected = `${view.month}-01`;
      } else view.selected = addDays(view.selected, 7 * dir);
      return renderCalendar(main, routeBoard);
    }
  };

  enableDrag(main.querySelector('#cal-root'), {
    onDrop: ({ id, day }) => {
      if (!day) return;
      const c = S.record(id);
      if (!c || c.data.due === day) return;
      const from = c.data.due;
      S.setDue(id, day).then(() => toast(`Movida al ${parseDate(day).getDate()} de ${MONTHS[parseDate(day).getMonth()]}`, { label: 'Deshacer', run: () => S.setDue(id, from) }));
    },
  });
}

function miniRowWithDate(c) {
  return miniRow(c, false).replace(/<span class="when[^"]*">[^<]*<\/span>/, `<span class="when">${esc(dueLabel(c.data.due))}</span>`);
}
