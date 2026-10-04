// Búsqueda en todas las tarjetas de todos los tableros. Se hace con los datos del dispositivo, así que es
// instantánea y funciona sin conexión.
import * as S from '../store.js';
import { esc, icon, paint, todayStr, addDays, plural } from '../util.js';
import { taskRow, sortByDue } from './parts.js';
import { openCard } from '../sheets.js';
import { PRIO_NAME } from '../sheets.js';

const f = { q: '', board: '', state: 'open', when: '', prio: '', label: '', who: '', archived: false };
const MAX = 200;

/** Minúsculas y sin tildes, carácter a carácter (para poder resaltar en el texto original). */
const fold = (ch) => ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const norm = (s) => [...(s || '')].map(fold).join('');

function highlight(text, terms) {
  const chars = [...text];
  const folded = chars.map(fold);
  const flat = folded.join('');
  const mark = new Array(chars.length).fill(false);
  // Posición en el texto plegado -> índice de carácter original.
  const owner = [];
  folded.forEach((s, i) => { for (let k = 0; k < s.length; k++) owner.push(i); });
  for (const t of terms) {
    let at = flat.indexOf(t);
    while (at !== -1 && t) {
      for (let k = at; k < at + t.length; k++) mark[owner[k]] = true;
      at = flat.indexOf(t, at + t.length);
    }
  }
  let out = '', open = false;
  chars.forEach((c, i) => {
    if (mark[i] && !open) { out += '<mark>'; open = true; }
    if (!mark[i] && open) { out += '</mark>'; open = false; }
    out += esc(c);
  });
  return open ? `${out}</mark>` : out;
}

/** Fragmento de la descripción o de la checklist donde aparece el término. */
function snippet(c, terms) {
  const d = c.data;
  const sources = [d.description || '', ...(d.checklist || []).map((i) => `☐ ${i.text}`)];
  for (const src of sources) {
    const n = norm(src);
    const hit = terms.find((t) => n.includes(t));
    if (!hit) continue;
    const pos = n.indexOf(hit);
    const chars = [...src];
    const from = Math.max(0, pos - 40);
    const piece = chars.slice(from, from + 140).join('').replace(/\s+/g, ' ');
    return `${from ? '…' : ''}${highlight(piece, terms)}${from + 140 < chars.length ? '…' : ''}`;
  }
  return '';
}

function labelNames() {
  const names = new Map();
  for (const b of S.boards()) for (const l of b.data.labels || []) if (l.name) names.set(norm(l.name), l.name);
  return [...names.values()].sort((a, b) => a.localeCompare(b, 'es'));
}

function results() {
  const terms = norm(f.q).split(/\s+/).filter(Boolean);
  const t = todayStr();
  const week = addDays(t, 7);
  const lab = norm(f.label);
  const list = [];
  // Textos de los comentarios por tarjeta (una sola pasada).
  const talk = new Map();
  if (terms.length) {
    for (const r of S.state.records.values()) {
      if (r.kind === 'comment' && !r.deleted && r.data) talk.set(r.data.cardId, [...(talk.get(r.data.cardId) || []), r.data.text]);
    }
  }
  for (const c of S.cards()) {
    const d = c.data;
    if (!f.archived && d.archived) continue;
    if (f.board && c.boardId !== f.board) continue;
    if (f.state === 'open' && d.done) continue;
    if (f.state === 'done' && !d.done) continue;
    if (f.prio && d.priority !== f.prio) continue;
    if (f.who === 'me' && !(d.assignees || []).includes(S.state.user?.username)) continue;
    if (f.who === 'none' && (d.assignees || []).length) continue;
    if (f.when === 'late' && !(d.due && d.due < t && !d.done)) continue;
    if (f.when === 'today' && d.due !== t) continue;
    if (f.when === 'week' && !(d.due && d.due >= t && d.due <= week)) continue;
    if (f.when === 'none' && d.due) continue;
    const b = S.board(c.boardId);
    const labels = (d.labels || []).map((id) => (b?.data.labels || []).find((l) => l.id === id)?.name || '');
    if (lab && !labels.some((n) => norm(n) === lab)) continue;
    let score = 0;
    if (terms.length) {
      const title = norm(d.title);
      const rest = norm([d.description, ...(d.checklist || []).map((i) => i.text), ...labels, b?.data.name,
        ...(talk.get(c.id) || [])].join(' '));
      if (!terms.every((x) => title.includes(x) || rest.includes(x))) continue;
      score = terms.filter((x) => title.includes(x)).length * 10 + (title.startsWith(terms[0]) ? 5 : 0);
    }
    list.push({ c, score });
  }
  const byDate = (a, b) => (!a.c.data.due - !b.c.data.due) || (a.c.data.due && b.c.data.due ? sortByDue(a.c, b.c) : a.c.data.title.localeCompare(b.c.data.title, 'es'));
  list.sort((a, b) => (b.score - a.score) || byDate(a, b));
  return { list, terms };
}

const anyFilter = () => f.q.trim() || f.board || f.when || f.prio || f.label || f.who || f.state !== 'open' || f.archived;

function resultsHtml() {
  if (!anyFilter()) return '<div class="empty small-empty">Escribe para buscar en el título, la descripción, la checklist y las etiquetas de todas tus tarjetas.</div>';
  const { list, terms } = results();
  if (!list.length) return '<div class="empty small-empty">No hay tarjetas que coincidan.</div>';
  return `<p class="small muted" aria-live="polite">${plural(list.length, 'tarjeta', 'tarjetas')}${list.length > MAX ? ` (se muestran ${MAX})` : ''}</p>
    ${list.slice(0, MAX).map(({ c }) => {
      let row = taskRow(c);
      if (terms.length) {
        // Con función: así los «$&», «$'»… de un título no se interpretan como patrones de replace().
        const title = `<span class="task-title">${highlight(c.data.title, terms)}</span>`;
        row = row.replace(`<span class="task-title">${esc(c.data.title)}</span>`, () => title);
        const sn = snippet(c, terms);
        if (sn) row = row.replace('<span class="meta">', () => `<span class="snippet">${sn}</span><span class="meta">`);
      }
      if (c.data.archived) row = row.replace('<span class="meta">', () => '<span class="meta"><span class="tag">Archivada</span>');
      return row;
    }).join('')}`;
}

export function renderSearch(main) {
  const hadFocus = document.activeElement?.id === 'q';
  const boards = S.boards();
  const labels = labelNames();
  const sel = (id, label, cur, opts) => `<label class="sr" for="${id}">${label}</label><select id="${id}" class="select sm" data-f="${id.slice(2)}">
    ${opts.map(([v, n]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  main.innerHTML = `<div class="page">
    <header class="page-head"><h1>Buscar</h1></header>
    <div class="section search-page">
      <div class="search-box">${icon('search')}
        <label class="sr" for="q">Buscar tarjetas</label>
        <input id="q" class="input" type="search" placeholder="Buscar en todas las tarjetas" autocomplete="off" enterkeyhint="search" value="${esc(f.q)}"></div>
      <div class="search-filters">
        <span class="seg" role="group" aria-label="Estado">${[['open', 'Pendientes'], ['all', 'Todas'], ['done', 'Hechas']].map(([k, n]) =>
          `<button type="button" data-state="${k}" aria-pressed="${f.state === k}">${n}</button>`).join('')}</span>
        ${sel('f-board', 'Tablero', f.board, [['', 'Todos los tableros'], ...boards.map((b) => [b.id, b.data.name])])}
        ${sel('f-when', 'Fecha', f.when, [['', 'Cualquier fecha'], ['late', 'Vencidas'], ['today', 'Hoy'], ['week', 'Próximos 7 días'], ['none', 'Sin fecha']])}
        ${sel('f-prio', 'Prioridad', f.prio, [['', 'Cualquier prioridad'], ['high', PRIO_NAME.high], ['medium', PRIO_NAME.medium], ['low', PRIO_NAME.low]])}
        ${sel('f-who', 'Responsable', f.who, [['', 'Cualquier responsable'], ['me', 'Asignadas a mí'], ['none', 'Sin asignar']])}
        ${labels.length ? sel('f-label', 'Etiqueta', f.label, [['', 'Cualquier etiqueta'], ...labels.map((n) => [n, n])]) : ''}
        <label class="check-inline"><input type="checkbox" id="f-arch" ${f.archived ? 'checked' : ''}> Incluir archivadas</label>
        ${anyFilter() ? '<button type="button" class="btn sm ghost" data-clear>Limpiar</button>' : ''}
      </div>
      <div id="search-results" class="search-results">${resultsHtml()}</div>
    </div></div>`;
  paint(main);

  const q = main.querySelector('#q');
  const box = main.querySelector('#search-results');
  const update = () => { box.innerHTML = resultsHtml(); paint(box); };
  if (hadFocus || !f.q) {
    q.focus({ preventScroll: true });
    q.setSelectionRange(q.value.length, q.value.length);
  }
  q.addEventListener('input', () => {
    const had = !!anyFilter();
    f.q = q.value;
    update();
    if (had !== !!anyFilter()) main.querySelector('[data-clear]')?.toggleAttribute('hidden', !anyFilter());
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') q.blur(); });
  main.querySelectorAll('[data-f]').forEach((s) => s.addEventListener('change', () => { f[s.dataset.f] = s.value; renderSearch(main); }));
  main.querySelectorAll('[data-state]').forEach((b) => b.addEventListener('click', () => { f.state = b.dataset.state; renderSearch(main); }));
  main.querySelector('#f-arch').addEventListener('change', (e) => { f.archived = e.target.checked; renderSearch(main); });
  main.querySelector('[data-clear]')?.addEventListener('click', () => {
    Object.assign(f, { q: '', board: '', state: 'open', when: '', prio: '', label: '', who: '', archived: false });
    renderSearch(main);
  });
  main.onclick = (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) { S.toggleDone(tg.dataset.toggle); return; }
    const op = e.target.closest('[data-open]');
    if (op) openCard(op.dataset.open);
  };
}
