// Lista de tableros y vista Kanban de un tablero.
import * as S from '../store.js';
import { esc, icon, plural, COLORS, toast, todayStr, paint } from '../util.js';
import { boardCard, boardStats } from './parts.js';
import { enableDrag } from '../drag.js';
import { openCard, openNewBoard, openBoardMenu, openShare, openInvitations, openColumns } from '../sheets.js';

// ---------- Lista de tableros ----------
export function renderBoards(main) {
  const list = S.boards();
  const t = todayStr();
  main.innerHTML = `<div class="page">
    <header class="page-head"><h1>Tableros</h1>
      <span class="head-actions"><a class="icon-btn" href="#/buscar" aria-label="Buscar">${icon('search')}</a>
      <button type="button" class="btn primary sm" data-act="new">${icon('plus', 's')} Nuevo tablero</button></span></header>
    <div class="section">
      ${S.state.invitations ? `<button type="button" class="callout list-row" data-act="inv">${icon('inbox')}
        <span class="grow">Tienes ${plural(S.state.invitations, 'invitación', 'invitaciones')}</span>${icon('right', 's')}</button><div class="sep"></div>` : ''}
      ${list.length ? `<div class="board-grid">${list.map((b) => {
        const st = boardStats(b.id, t);
        const info = S.state.boardInfo.get(b.id);
        const role = S.roleOf(b.id);
        const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
        return `<a class="board-tile" href="#/tablero/${esc(b.id)}" data-c="${esc(b.data.color)}">
          <span class="tile-top"><span class="sq" data-c="${esc(b.data.color)}"></span><strong class="tile-name">${esc(b.data.name)}</strong>
            ${info && info.members > 1 ? `<span class="tile-shared" title="Compartido">${icon('users', 's')}${info.members}</span>` : ''}</span>
          <span class="tile-stats">
            <span><b>${st.open}</b> abiertas</span>
            ${st.late ? `<span class="error-text"><b>${st.late}</b> vencidas</span>` : ''}
            <span><b>${st.done}</b> hechas</span>
          </span>
          <span class="progress" aria-label="${pct}% completado"><i data-p="${pct}" data-c="${esc(b.data.color)}"></i></span>
          <span class="tile-foot">${role === 'owner' ? (info && info.members > 1 ? `Compartido con ${info.members - 1}` : 'Solo tú')
            : `${S.ROLE_NAME[role]} · de @${esc(info?.owner || '?')}`}</span>
        </a>`;
      }).join('')}
        <button type="button" class="board-tile add" data-act="new">${icon('plus')}<span>Nuevo tablero</span></button></div>`
        : `<div class="empty-card"><strong>Aún no tienes tableros</strong><span>Crea uno para cada ámbito: Casa, Trabajo, Homelab…</span>
            <button type="button" class="btn primary" data-act="new">${icon('plus', 's')} Crear tablero</button></div>`}
    </div></div>`;
  main.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') openNewBoard();
    if (act === 'inv') openInvitations();
  };
}

// ---------- Tablero ----------
const filters = { text: '', label: null, showSearch: false };
let currentBoard = null;

export function renderBoard(main, boardId) {
  const b = S.board(boardId);
  if (!b) {
    main.innerHTML = `<header class="page-head"><h1>Tablero</h1></header>
      <div class="empty"><strong>Este tablero no existe o ya no tienes acceso.</strong><p><a class="btn" href="#/tableros">Ver tableros</a></p></div>`;
    return;
  }
  if (currentBoard !== boardId) { filters.text = ''; filters.label = null; filters.showSearch = false; currentBoard = boardId; }
  if (S.state.settings.lastBoard !== boardId) S.saveSettings({ lastBoard: boardId });

  const canWrite = S.can(boardId, 'write');
  const canAdmin = S.can(boardId, 'admin');
  const role = S.roleOf(boardId);
  const info = S.state.boardInfo.get(boardId) || { members: 1 };
  const cols = S.columns(boardId);
  const labels = b.data.labels;
  const q = filters.text.trim().toLowerCase();
  const match = (c) => (!q || c.data.title.toLowerCase().includes(q) || c.data.description.toLowerCase().includes(q))
    && (!filters.label || c.data.labels.includes(filters.label));
  const filtering = !!(q || filters.label);

  // Conserva el desplazamiento horizontal y vertical al volver a pintar.
  const prevScroll = main.querySelector('.columns')?.scrollLeft || 0;
  const prevLists = new Map([...main.querySelectorAll('[data-drop-col]')].map((n) => [n.dataset.dropCol, n.scrollTop]));
  const searchFocused = document.activeElement?.id === 'b-search';
  const caret = searchFocused ? document.activeElement.selectionStart : 0;

  main.innerHTML = `
    <header class="board-head">
      <div class="top">
        <button type="button" class="board-switch" data-act="menu" aria-label="Opciones del tablero ${esc(b.data.name)}">
          <span class="sq" data-c="${esc(b.data.color)}"></span><h1>${esc(b.data.name)}</h1>${icon('down', 's')}</button>
        <button type="button" class="members-btn" data-act="share" aria-label="Miembros y permisos">
          <span class="avatar" data-c="${esc(b.data.color)}">${info.members}</span>
          ${canAdmin ? '<span class="avatar add">+</span>' : ''}</button>
      </div>
      <div class="toolbar">
        <span class="seg"><a href="#/tablero/${esc(boardId)}" aria-current="page">Tablero</a><a href="#/calendario/${esc(boardId)}">Calendario</a></span>
        <button type="button" class="btn sm" data-act="search" aria-pressed="${filters.showSearch}">${icon('search', 's')} Filtrar</button>
        ${role !== 'owner' ? `<span class="role-note">Permiso: ${S.ROLE_NAME[role]}</span>` : ''}
      </div>
      ${filters.showSearch || filtering ? `<div class="row">
        <label class="sr" for="b-search">Buscar en el tablero</label>
        <input id="b-search" class="input grow" type="search" placeholder="Buscar tarjetas…" value="${esc(filters.text)}" autocomplete="off"></div>
        ${labels.length ? `<div class="chips">${labels.map((l) => `<button type="button" class="chip" data-flabel="${esc(l.id)}" aria-pressed="${filters.label === l.id}">
          <span class="dot" data-c="${esc(l.color)}"></span>${esc(l.name || '·')}</button>`).join('')}</div>` : ''}` : ''}
    </header>
    <div class="columns" id="columns">
      ${cols.map((col) => {
        const all = S.columnCards(col.id);
        const shown = all.filter(match);
        const wip = col.data.wip;
        const over = wip && all.length > wip;
        return `<section class="column ${over ? 'over' : ''}" aria-label="${esc(col.data.name)}">
          <div class="column-head">
            <span class="name">${esc(col.data.name)} <span class="count">· ${filtering ? `${shown.length}/` : ''}${all.length}</span></span>
            ${wip ? `<span class="wip ${over ? 'over' : ''}" title="Límite de trabajo en curso">${all.length}/${wip}</span>` : ''}
          </div>
          <div class="cards" data-drop-col="${esc(col.id)}">${shown.map((c) => boardCard(c, b, canWrite && !filtering)).join('')}</div>
          ${canWrite ? `<div data-add-slot="${esc(col.id)}"><button type="button" class="add-card" data-add="${esc(col.id)}">+ Añadir tarjeta</button></div>` : ''}
        </section>`;
      }).join('')}
      ${canAdmin ? `<button type="button" class="add-col" data-act="menu-cols">+ Columna</button>` : ''}
    </div>
    ${canWrite ? `<p class="drag-hint">${filtering ? 'Quita el filtro para poder mover tarjetas.' : 'Mantén pulsada una tarjeta para moverla. También puedes cambiar su columna desde la propia tarjeta.'}</p>` : ''}`;

  paint(main);
  const colsEl = main.querySelector('#columns');
  colsEl.scrollLeft = prevScroll;
  for (const n of main.querySelectorAll('[data-drop-col]')) n.scrollTop = prevLists.get(n.dataset.dropCol) || 0;
  if (searchFocused) { const s = main.querySelector('#b-search'); s?.focus(); s?.setSelectionRange(caret, caret); }

  main.querySelector('#b-search')?.addEventListener('input', (e) => { filters.text = e.target.value; renderBoard(main, boardId); });

  main.onclick = (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return showQuickAdd(main, boardId, add.dataset.add);
    const op = e.target.closest('[data-open]');
    if (op) return openCard(op.dataset.open);
    const fl = e.target.closest('[data-flabel]');
    if (fl) { filters.label = filters.label === fl.dataset.flabel ? null : fl.dataset.flabel; return renderBoard(main, boardId); }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'menu') openBoardMenu(boardId);
    if (act === 'share') openShare(boardId);
    if (act === 'menu-cols') openColumns(boardId);
    if (act === 'search') {
      filters.showSearch = !filters.showSearch;
      if (!filters.showSearch) { filters.text = ''; filters.label = null; }
      renderBoard(main, boardId);
      main.querySelector('#b-search')?.focus();
    }
  };

  if (canWrite && !colsEl.dataset.dragBound) {
    colsEl.dataset.dragBound = '1';
    enableDrag(colsEl, {
      onDrop: ({ id, columnId, index }) => {
        if (!columnId) return;
        const col = S.record(columnId);
        const before = S.record(id)?.data.columnId;
        S.moveCard(id, columnId, index).then(() => {
          if (col?.data.wip && before !== columnId && S.columnCards(columnId).length > col.data.wip) {
            toast(`«${col.data.name}» supera su límite de ${col.data.wip}`);
          }
        });
      },
    });
  }
}

function showQuickAdd(main, boardId, columnId) {
  const slot = main.querySelector(`[data-add-slot="${CSS.escape(columnId)}"]`);
  if (!slot) return;
  slot.innerHTML = `<form class="quick-add" data-qa>
    <label class="sr" for="qa-${esc(columnId)}">Título de la tarjeta</label>
    <textarea id="qa-${esc(columnId)}" class="textarea" maxlength="200" placeholder="Título de la tarjeta" required></textarea>
    <div class="row"><button type="submit" class="btn primary grow">Añadir</button><button type="button" class="btn" data-cancel>Cancelar</button></div></form>`;
  const form = slot.querySelector('form');
  const ta = form.querySelector('textarea');
  ta.focus();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); S.emit(); }
  });
  form.querySelector('[data-cancel]').addEventListener('click', (e) => { e.stopPropagation(); ta.blur(); S.emit(); });
  form.addEventListener('click', (e) => e.stopPropagation());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = ta.value.replace(/\s+/g, ' ').trim();
    if (!title) return;
    ta.value = '';
    await S.createCard(boardId, columnId, { title });
    // Al quitar el foco la vista se vuelve a pintar; después se reabre el formulario para seguir añadiendo.
    ta.blur();
    setTimeout(() => {
      showQuickAdd(main, boardId, columnId);
      const list = main.querySelector(`[data-drop-col="${CSS.escape(columnId)}"]`);
      if (list) list.scrollTop = list.scrollHeight;
    }, 40);
  });
}

export const BOARD_COLORS = COLORS;
