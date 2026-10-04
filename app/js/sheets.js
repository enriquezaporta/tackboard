// Hojas de detalle: tarjeta, nueva tarea, tablero, columnas, etiquetas, archivadas y compartir.
import * as S from './store.js';
import { get, post, del, errorText } from './api.js';
import { openSheet, confirmDialog, closeSheet } from './ui.js';
import * as T from './templates.js';
import * as F from './files.js';
import { parseQuick, quickChips } from './quickadd.js';
import { esc, icon, uid, shortId, COLORS, COLOR_NAMES, dueAt, todayStr, toast, plural, safeColor, REMINDERS, REPEAT_FREQ, REPEAT_UNIT, DOW_ORDER, DOW_LETTER, nextDue, repeatLabel, dueLabel, personColor, initial, whenText } from './util.js';

const PRIOS = [['', 'Sin prioridad'], ['low', 'Baja'], ['medium', 'Media'], ['high', 'Alta']];
export const PRIO_NAME = { low: 'Baja', medium: 'Media', high: 'Alta' };

/** Muestra u oculta el rótulo de un campo de hora según esté vacío o no. */
function bindTimeField(input) {
  const upd = () => input.parentElement.classList.toggle('is-empty', !input.value);
  input.addEventListener('input', upd);
  input.addEventListener('change', upd);
}

function colorPicker(name, value) {
  return `<div class="color-picks" role="radiogroup" aria-label="Color">${COLORS.map((c, i) =>
    `<button type="button" role="radio" data-c="${c}" data-pick="${name}" data-value="${c}" aria-pressed="${c === value}" aria-checked="${c === value}" aria-label="${COLOR_NAMES[i]}"></button>`).join('')}</div>`;
}
function bindColorPicker(el, name, onPick) {
  el.querySelectorAll(`[data-pick="${name}"]`).forEach((b) => b.addEventListener('click', () => {
    el.querySelectorAll(`[data-pick="${name}"]`).forEach((x) => { x.setAttribute('aria-pressed', 'false'); x.setAttribute('aria-checked', 'false'); });
    b.setAttribute('aria-pressed', 'true'); b.setAttribute('aria-checked', 'true');
    onPick(b.dataset.value);
  }));
}

// ====================================================================================================
// Tarjeta
// ====================================================================================================

export function openCard(cardId) {
  let unsub = null;
  const sheet = openSheet({
    label: 'Tarjeta',
    render(el, api) {
      const card = S.record(cardId);
      if (!card) { el.innerHTML = '<div class="empty"><strong>Esta tarjeta ya no existe.</strong></div>'; return; }
      renderCard(el, card, api);
    },
    onClose() { unsub?.(); },
  });
  let stale = false;
  const refresh = () => {
    if (!document.body.contains(sheet.el)) return;
    const a = document.activeElement;
    if (sheet.el.contains(a) && a.matches('textarea, input:not([type=checkbox])')) { stale = true; return; }
    stale = false;
    sheet.refresh();
  };
  unsub = S.subscribe(refresh);
  // Lo que cambió mientras se escribía se pinta al salir del campo.
  sheet.el.addEventListener('focusout', () => setTimeout(() => { if (stale) refresh(); }, 0));
}

function repeatHtml(d, dis) {
  if (!d.due) return '<span class="muted small">Pon una fecha para poder repetirla.</span>';
  const rp = d.repeat || {};
  const f = rp.freq || '';
  let h = `<select id="c-rep" class="select" aria-label="Repetir" ${dis}>${REPEAT_FREQ.map(([k, n]) =>
    `<option value="${k}" ${k === f ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  if (f && f !== 'weekday') {
    const n = rp.every || 1;
    h += `<label class="rep-every">cada <input id="c-rep-n" class="input" type="number" min="1" max="99" inputmode="numeric" value="${n}" ${dis}>
      ${REPEAT_UNIT[f][n === 1 ? 0 : 1]}</label>`;
  }
  if (f === 'week') {
    const days = (rp.days || []).length ? rp.days : [new Date(`${d.due}T12:00`).getDay()];
    h += `<span class="chips">${DOW_ORDER.map((x) => `<button type="button" class="chip day-chip" data-rep-day="${x}"
      aria-pressed="${days.includes(x)}" aria-label="${['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][x]}" ${dis}>${DOW_LETTER[x]}</button>`).join('')}</span>`;
  }
  if (f) {
    const nx = nextDue(d.due, rp);
    h += `<span class="hint">${esc(repeatLabel(rp))}. Al completarla se crea la siguiente (${esc(dueLabel(nx, d.dueTime).toLowerCase())}).</span>`;
  }
  return h;
}

function bindRepeat(el, cardId, patch, sheet) {
  const cur = () => S.record(cardId)?.data;
  el.querySelector('#c-rep')?.addEventListener('change', (e) => {
    const d = cur();
    const f = e.target.value;
    const rp = f ? { freq: f, every: d.repeat?.freq === f ? d.repeat.every : 1, days: f === 'week' ? [new Date(`${d.due}T12:00`).getDay()] : [], day: +d.due.slice(8, 10) } : null;
    patch({ repeat: rp })?.then(() => sheet.refresh());
  });
  el.querySelector('#c-rep-n')?.addEventListener('change', (e) => {
    const n = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
    patch({ repeat: { ...cur().repeat, every: n } })?.then(() => sheet.refresh());
  });
  el.querySelectorAll('[data-rep-day]').forEach((b) => b.addEventListener('click', () => {
    const rp = cur().repeat;
    const x = +b.dataset.repDay;
    const days = rp.days || [];
    const nd = days.includes(x) ? days.filter((y) => y !== x) : [...days, x];
    if (!nd.length) return toast('Elige al menos un día.');
    patch({ repeat: { ...rp, days: nd.sort() } })?.then(() => sheet.refresh());
  }));
}

function assigneesHtml(card, dis) {
  const ppl = S.people(card.boardId);
  const cur = card.data.assignees || [];
  if (ppl.length < 2 && !cur.length) return '';
  const me = S.state.user?.username;
  return `<div class="prop"><span class="k">Responsables</span><span class="v"><span class="chips">${ppl.map((p) => `
    <button type="button" class="chip person" data-asg="${esc(p.username)}" aria-pressed="${cur.includes(p.username)}" ${dis}>
      <span class="mini-av" data-c="${personColor(p.username)}">${esc(initial(p.name || p.username))}</span>${esc(p.username === me ? 'Yo' : p.name || p.username)}</button>`).join('')}</span></span></div>`;
}

function commentsHtml(card, ro) {
  const list = S.comments(card.id);
  const me = S.state.user?.username;
  const admin = S.can(card.boardId, 'admin');
  return `<div class="row comments-head"><strong class="grow">Comentarios</strong>${list.length ? `<span class="mono small muted">${list.length}</span>` : ''}</div>
    <div class="comments">${list.map((c) => {
      const name = c.data.author ? S.personName(card.boardId, c.data.author) : 'Cuenta eliminada';
      return `<div class="comment">
        <span class="mini-av lg" data-c="${personColor(c.data.author)}">${esc(initial(name))}</span>
        <div class="grow"><div class="comment-meta"><strong>${esc(c.data.author === me ? 'Tú' : name)}</strong>
          <span class="muted small">${c.serverTs ? esc(whenText(c.data.createdAt || c.updatedAt)) : 'sin enviar'}${c.data.editedAt ? ' · editado' : ''}</span>
          ${(c.data.author === me || admin) && !ro ? `<button type="button" class="icon-btn plain sm-btn" data-cdel="${esc(c.id)}" aria-label="Borrar el comentario">${icon('close', 's')}</button>` : ''}</div>
        <div class="comment-text">${esc(c.data.text)}</div></div></div>`;
    }).join('')}</div>
    ${ro ? (list.length ? '' : '<p class="muted small">Sin comentarios.</p>') : `<form id="c-cm" class="comment-form">
      <label class="sr" for="c-cm-text">Escribe un comentario</label>
      <textarea id="c-cm-text" class="textarea" rows="2" maxlength="2000" placeholder="Escribe un comentario…"></textarea>
      <button type="submit" class="btn">Comentar</button></form>`}`;
}

function bindComments(el, card, sheet) {
  el.querySelector('#c-cm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = el.querySelector('#c-cm-text');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    ta.blur();
    await S.addComment(S.record(card.id), text);
    sheet.refresh();
  });
  el.querySelectorAll('[data-cdel]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Borrar comentario', text: 'Se borrará para todos los miembros del tablero.', ok: 'Borrar', danger: true });
    if (ok) await S.remove([b.dataset.cdel]);
    openCard(card.id);
  }));
}

function renderCard(el, card, sheet) {
  const d = card.data;
  const b = S.board(card.boardId);
  const ro = !S.can(card.boardId, 'write');
  const cols = S.columns(card.boardId);
  const labels = b?.data.labels || [];
  const doneCount = d.checklist.filter((i) => i.done).length;
  const dis = ro ? 'disabled' : '';

  el.innerHTML = `
    <div class="row">
      <span class="chip"><span class="sq" data-c="${esc(b?.data.color)}"></span>${esc(b?.data.name || '')}</span>
      ${d.archived ? '<span class="chip">Archivada</span>' : ''}
      ${ro ? '<span class="chip">Solo lectura</span>' : ''}
      <span class="grow"></span>
      <button type="button" class="icon-btn plain" data-close aria-label="Cerrar">${icon('close')}</button>
    </div>
    <label class="sr" for="c-title">Título</label>
    <textarea id="c-title" class="title-input" rows="1" maxlength="200" ${dis}>${esc(d.title)}</textarea>

    <div class="props">
      <div class="prop"><span class="k">Columna</span><span class="v">
        <select id="c-col" class="select" aria-label="Columna" ${dis}>${cols.map((c) =>
          `<option value="${esc(c.id)}" ${c.id === d.columnId ? 'selected' : ''}>${esc(c.data.name)}</option>`).join('')}</select></span></div>
      <div class="prop"><span class="k">Vence</span><span class="v">
        <input id="c-due" class="input" type="date" value="${esc(d.due)}" aria-label="Fecha de vencimiento" ${dis}>
        <span class="time-field${d.dueTime ? '' : ' is-empty'}" ${d.due ? '' : 'hidden'}>
          <input id="c-time" class="input" type="time" value="${esc(d.dueTime)}" aria-label="Hora de vencimiento" ${d.due ? '' : 'disabled'} ${dis}>
          <span class="time-ph" aria-hidden="true">+ Hora</span></span>
        ${d.due && !ro ? `<button type="button" class="btn sm ghost" id="c-nodue">Quitar</button>` : ''}</span></div>
      <div class="prop"><span class="k">Avisos</span><span class="v">
        ${d.due ? `<span class="chips">${REMINDERS.map(([k, n]) => `<button type="button" class="chip" data-rem="${k}"
          aria-pressed="${(d.reminders || []).includes(k)}" ${dis}>${n}</button>`).join('')}</span>
          ${!d.dueTime ? '<span class="hint">Sin hora: se toma como referencia las 9:00 de ese día.</span>' : ''}
          ${S.state.notify.prefs && !S.state.notify.prefs.enabled ? '<span class="hint">Tienes los avisos desactivados en Ajustes.</span>' : ''}`
          : '<span class="muted small">Pon una fecha para poder avisarte.</span>'}</span></div>
      <div class="prop"><span class="k">Repetir</span><span class="v">${repeatHtml(d, dis)}</span></div>
      <div class="prop"><span class="k">Inicio</span><span class="v">
        <input id="c-start" class="input" type="date" value="${esc(d.start)}" aria-label="Fecha de inicio" ${dis}></span></div>
      <div class="prop"><span class="k">Prioridad</span><span class="v">
        <select id="c-prio" class="select" aria-label="Prioridad" ${dis}>${PRIOS.map(([v, n]) =>
          `<option value="${v}" ${v === d.priority ? 'selected' : ''}>${n}</option>`).join('')}</select></span></div>
      <div class="prop"><span class="k">Etiquetas</span><span class="v">
        ${labels.length ? `<span class="chips">${labels.map((l) => `<button type="button" class="chip" data-label="${esc(l.id)}"
          aria-pressed="${d.labels.includes(l.id)}" ${dis}><span class="dot" data-c="${esc(l.color)}"></span>${esc(l.name || 'Sin nombre')}</button>`).join('')}</span>`
          : `<span class="muted small">El tablero no tiene etiquetas.</span>`}
        ${S.can(card.boardId, 'admin') ? `<button type="button" class="btn sm ghost" id="c-edit-labels">Editar</button>` : ''}</span></div>
      ${assigneesHtml(card, dis)}
    </div>

    <div class="field"><label for="c-desc">Descripción</label>
      <textarea id="c-desc" class="textarea" maxlength="10000" placeholder="${ro ? '' : 'Añade más detalles…'}" ${dis}>${esc(d.description)}</textarea></div>

    <div class="row"><strong class="grow">Checklist</strong>${d.checklist.length ? `<span class="mono small muted">${doneCount}/${d.checklist.length}</span>` : ''}</div>
    ${d.checklist.length ? `<div class="progress" role="presentation"><i data-p="${Math.round(doneCount / d.checklist.length * 100)}"></i></div>` : ''}
    <div id="c-check">${d.checklist.map((it) => `
      <div class="checklist-item ${it.done ? 'done' : ''}">
        <input type="checkbox" id="ck-${esc(it.id)}" data-ck="${esc(it.id)}" ${it.done ? 'checked' : ''} ${dis}>
        <label class="txt" for="ck-${esc(it.id)}">${esc(it.text)}</label>
        ${ro ? '' : `<button type="button" class="icon-btn plain" data-ck-del="${esc(it.id)}" aria-label="Quitar «${esc(it.text)}»">${icon('close', 's')}</button>`}
      </div>`).join('')}</div>
    ${ro ? '' : `<form id="c-add-ck" class="row"><label class="sr" for="c-ck-text">Nuevo elemento</label>
      <input id="c-ck-text" class="input grow" maxlength="300" placeholder="Añadir elemento" autocomplete="off">
      <button type="submit" class="btn">Añadir</button></form>`}

    <div class="row att-head"><strong class="grow">Adjuntos</strong>${(d.attachments || []).length ? `<span class="mono small muted">${d.attachments.length}</span>` : ''}</div>
    ${F.attachmentsHtml(card, !ro)}

    ${commentsHtml(card, ro)}

    ${!d.done && !d.archived ? `<button type="button" class="btn block" id="c-pomo">${icon('timer', 's')} Empezar un pomodoro con esta tarea</button>` : ''}
    ${ro ? '' : `<div class="row sheet-actions">
      <button type="button" class="btn grow" id="c-archive">${icon('archive', 's')} ${d.archived ? 'Restaurar' : 'Archivar'}</button>
      <button type="button" class="btn danger grow" id="c-delete">${icon('trash', 's')} Eliminar</button></div>`}
  `;

  const title = el.querySelector('#c-title');
  const autosize = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  autosize();
  F.fillThumbs(el);
  bindComments(el, card, sheet);
  el.querySelectorAll('[data-att-open]').forEach((b) => b.addEventListener('click', () => F.openAttachment(card.id, b.dataset.attOpen)));
  el.querySelector('#att-input')?.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    await F.addFiles(card.id, files);
    if (document.body.contains(sheet.el)) sheet.refresh();
  });
  el.querySelector('#c-pomo')?.addEventListener('click', async () => {
    const m = await import('./views/pomodoro.js');
    try {
      if (await m.startFromCard(card.id)) { closeSheet(); location.hash = '#/pomodoro'; } else openCard(card.id);
    } catch (e) { toast(errorText(e)); }
  });
  if (ro) return;

  const patch = (p) => {
    const cur = S.record(card.id);
    if (!cur) return;
    const data = { ...cur.data, ...p };
    if ('due' in p || 'dueTime' in p) {
      if (!data.due) data.dueTime = '';
      data.dueAt = dueAt(data.due, data.dueTime);
    }
    return S.save('card', cur.id, cur.boardId, data);
  };

  title.addEventListener('input', autosize);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('change', () => {
    const v = title.value.replace(/\s+/g, ' ').trim();
    if (v) patch({ title: v }); else title.value = S.record(card.id)?.data.title || '';
  });
  el.querySelector('#c-col').addEventListener('change', (e) => {
    S.moveCard(card.id, e.target.value, S.columnCards(e.target.value).length);
  });
  el.querySelector('#c-due').addEventListener('change', (e) => {
    el.querySelector('#c-time').disabled = !e.target.value;
    el.querySelector('.time-field').hidden = !e.target.value;
    // Se repinta para mostrar u ocultar la fila de avisos (sin perder el foco).
    const p = { due: e.target.value };
    const rp = S.record(card.id)?.data.repeat;
    if (rp?.freq && e.target.value) p.repeat = { ...rp, day: +e.target.value.slice(8, 10) };
    patch(p)?.then(() => sheet.refresh());
  });
  bindRepeat(el, card.id, patch, sheet);
  bindTimeField(el.querySelector('#c-time'));
  el.querySelector('#c-time').addEventListener('change', (e) => patch({ dueTime: e.target.value })?.then(() => sheet.refresh()));
  el.querySelector('#c-nodue')?.addEventListener('click', () => patch({ due: '', dueTime: '', repeat: null })?.then(() => sheet.refresh()));
  el.querySelector('#c-start').addEventListener('change', (e) => patch({ start: e.target.value }));
  el.querySelector('#c-prio').addEventListener('change', (e) => patch({ priority: e.target.value }));
  el.querySelector('#c-desc').addEventListener('change', (e) => patch({ description: e.target.value }));
  el.querySelectorAll('[data-rem]').forEach((btn) => btn.addEventListener('click', () => {
    const cur = S.record(card.id).data.reminders || [];
    const k = btn.dataset.rem;
    patch({ reminders: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] });
  }));
  el.querySelectorAll('[data-asg]').forEach((btn) => btn.addEventListener('click', () => {
    const cur = S.record(card.id).data.assignees || [];
    const u = btn.dataset.asg;
    patch({ assignees: cur.includes(u) ? cur.filter((x) => x !== u) : [...cur, u] });
  }));
  el.querySelectorAll('[data-label]').forEach((btn) => btn.addEventListener('click', () => {
    const cur = S.record(card.id).data.labels;
    const id = btn.dataset.label;
    patch({ labels: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  }));
  el.querySelector('#c-edit-labels')?.addEventListener('click', () => openLabels(card.boardId, () => openCard(card.id)));
  el.querySelectorAll('[data-ck]').forEach((cb) => cb.addEventListener('change', () => {
    const list = S.record(card.id).data.checklist.map((i) => i.id === cb.dataset.ck ? { ...i, done: cb.checked } : i);
    patch({ checklist: list });
  }));
  el.querySelectorAll('[data-ck-del]').forEach((b2) => b2.addEventListener('click', () => {
    patch({ checklist: S.record(card.id).data.checklist.filter((i) => i.id !== b2.dataset.ckDel) });
  }));
  el.querySelector('#c-add-ck').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = el.querySelector('#c-ck-text');
    const text = inp.value.trim();
    if (!text) return;
    const list = S.record(card.id).data.checklist;
    if (list.length >= 100) return toast('Máximo 100 elementos.');
    inp.value = '';
    await patch({ checklist: [...list, { id: shortId(), text, done: false }] });
    sheet.refresh();
    sheet.el.querySelector('#c-ck-text')?.focus();
  });
  el.querySelector('#c-archive').addEventListener('click', async () => {
    const wasArchived = S.record(card.id).data.archived;
    await patch({ archived: !wasArchived });
    if (!wasArchived) {
      closeSheet();
      toast('Tarjeta archivada', { label: 'Deshacer', run: () => patch({ archived: false }) });
    }
  });
  el.querySelector('#c-delete').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Eliminar tarjeta', text: `Se eliminará «${esc(card.data.title)}» para todos los miembros del tablero.`, ok: 'Eliminar', danger: true });
    if (ok) { await S.remove([card.id]); closeSheet(); toast('Tarjeta eliminada'); }
    else openCard(card.id);
  });
}

// ====================================================================================================
// Nueva tarea (desde Hoy o el calendario)
// ====================================================================================================

export function openNewTask({ due = '', boardId = null } = {}) {
  const writable = S.boards().filter((b) => S.can(b.id, 'write'));
  if (!writable.length) {
    toast('Primero crea un tablero.');
    return openNewBoard();
  }
  let bid = boardId && S.can(boardId, 'write') ? boardId
    : (writable.find((b) => b.id === S.state.settings.lastBoard) || writable[0]).id;
  const s = openSheet({
    title: 'Nueva tarea',
    render(el) {
      const cols = S.columns(bid);
      const firstOpen = cols.find((c) => !c.data.isDone) || cols[0];
      el.innerHTML = `<form id="nt">
        <div class="field"><label for="nt-title">Título</label>
          <input id="nt-title" class="input" maxlength="200" required autocomplete="off" autofocus placeholder="Pagar el IBI viernes 18:00 #casa !alta">
          <div class="qa-preview chips" id="nt-parse" aria-live="polite"></div>
          <span class="hint">Puedes escribir la fecha, la hora, <b>#tablero</b>, <b>!alta</b>, <b>@persona</b> o «cada semana» en el título.</span></div>
        <div class="row">
          <div class="field grow"><label for="nt-board">Tablero</label>
            <select id="nt-board" class="select">${writable.map((b) => `<option value="${esc(b.id)}" ${b.id === bid ? 'selected' : ''}>${esc(b.data.name)}</option>`).join('')}</select></div>
          <div class="field grow"><label for="nt-col">Columna</label>
            <select id="nt-col" class="select">${cols.map((c) => `<option value="${esc(c.id)}" ${c.id === firstOpen?.id ? 'selected' : ''}>${esc(c.data.name)}</option>`).join('')}</select></div>
        </div>
        <div class="row">
          <div class="field grow"><label for="nt-due">Vence</label><input id="nt-due" class="input" type="date" value="${esc(due)}"></div>
          <div class="field grow"><label for="nt-time">Hora (opcional)</label><span class="time-field is-empty">
            <input id="nt-time" class="input" type="time"><span class="time-ph" aria-hidden="true">Sin hora</span></span></div>
        </div>
        <button type="submit" class="btn primary block">Crear tarea</button>
      </form>`;
      el.querySelector('#nt-board').addEventListener('change', (e) => {
        const t = el.querySelector('#nt-title').value;
        const dd = el.querySelector('#nt-due').value;
        bid = e.target.value; s.refresh();
        s.el.querySelector('#nt-title').value = t; s.el.querySelector('#nt-due').value = dd;
      });
      bindTimeField(el.querySelector('#nt-time'));
      const ctx = () => ({ boards: writable.map((b) => ({ id: b.id, name: b.data.name })), people: S.people(bid) });
      el.querySelector('#nt-title').addEventListener('input', (e) => {
        el.querySelector('#nt-parse').innerHTML = quickChips(parseQuick(e.target.value, ctx()));
      });
      el.querySelector('#nt').addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = el.querySelector('#nt-title').value.replace(/\s+/g, ' ').trim();
        let colId = el.querySelector('#nt-col').value;
        if (!text || !colId) return;
        const q = parseQuick(text, ctx());
        // Si se ha escrito #tablero, va a ese tablero (a su primera columna abierta).
        if (q.boardId && q.boardId !== bid) {
          bid = q.boardId;
          const cs = S.columns(bid);
          colId = (cs.find((c) => !c.data.isDone) || cs[0])?.id;
          if (!colId) return;
        }
        // Lo escrito en el título manda sobre los campos (que pueden venir rellenos con el día elegido).
        const d = q.due || el.querySelector('#nt-due').value;
        const t = q.due ? q.dueTime : el.querySelector('#nt-time').value || q.dueTime;
        const ppl = new Set(S.people(bid).map((p) => p.username));
        await S.createCard(bid, colId, { title: q.title, due: d, dueTime: d ? t : '', priority: q.priority,
          assignees: q.assignees.filter((u) => ppl.has(u)), repeat: q.repeat });
        await S.saveSettings({ lastBoard: bid });
        s.close();
        toast('Tarea creada');
      });
    },
  });
}

// ====================================================================================================
// Tableros
// ====================================================================================================

export function openNewBoard(onCreated) {
  let color = COLORS[S.boards().length % COLORS.length];
  let colorTouched = false;
  let name = '';
  let tplId = 'basic';
  const built = T.builtins();
  const all = () => [...built.map((t) => ({ ...t, own: false })), ...T.cachedMine().map((t) => ({ ...t, own: true, desc: `${plural(t.columns.length, 'columna', 'columnas')}${t.cards.length ? ` · ${plural(t.cards.length, 'tarjeta', 'tarjetas')}` : ''}` }))];
  const s = openSheet({
    title: 'Nuevo tablero',
    render(el) {
      const list = all();
      if (!list.find((t) => t.id === tplId)) tplId = 'basic';
      const tplRow = (t) => `<label class="tpl ${t.id === tplId ? 'on' : ''}"><input type="radio" name="tpl" value="${esc(t.id)}" ${t.id === tplId ? 'checked' : ''}>
        <span class="sq" data-c="${esc(t.color)}"></span><span class="grow"><strong>${esc(t.name)}</strong><br><span class="hint">${esc(t.desc || '')}</span>
        <span class="tpl-cols">${t.columns.map((c) => esc(c.name)).join(' → ')}</span></span>
        ${t.own ? `<button type="button" class="icon-btn plain" data-tpl-del="${esc(t.id)}" aria-label="Borrar la plantilla «${esc(t.name)}»">${icon('trash', 's')}</button>` : ''}</label>`;
      const mine = list.filter((t) => t.own);
      el.innerHTML = `<form id="nb">
        <div class="field"><label for="nb-name">Nombre</label><input id="nb-name" class="input" maxlength="80" required autofocus placeholder="Casa, Trabajo, Homelab…" value="${esc(name)}"></div>
        <div class="field"><span class="label">Color</span>${colorPicker('nb', color)}</div>
        <div class="field"><span class="label">Plantilla</span>
          <div class="tpl-list" role="radiogroup" aria-label="Plantilla">${list.filter((t) => !t.own).map(tplRow).join('')}</div>
          ${mine.length ? `<span class="label tpl-sub">Tus plantillas</span><div class="tpl-list">${mine.map(tplRow).join('')}</div>` : ''}
          <p class="hint">Todo se puede cambiar después. Para crear tus plantillas: menú de un tablero → <em>Guardar como plantilla</em>.</p></div>
        <button type="submit" class="btn primary block">Crear tablero</button></form>`;
      bindColorPicker(el, 'nb', (c) => { color = c; colorTouched = true; });
      el.querySelector('#nb-name').addEventListener('input', (e) => { name = e.target.value; });
      el.querySelectorAll('input[name=tpl]').forEach((r) => r.addEventListener('change', () => {
        tplId = r.value;
        const t = all().find((x) => x.id === tplId);
        if (t && !colorTouched) color = safeColor(t.color);
        s.refresh();
      }));
      el.querySelectorAll('[data-tpl-del]').forEach((b) => b.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await T.deleteMine(b.dataset.tplDel); toast('Plantilla borrada'); s.refresh(); } catch (err) { toast(errorText(err)); }
      }));
      el.querySelector('#nb').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nm = el.querySelector('#nb-name').value.trim();
        if (!nm) return;
        const t = all().find((x) => x.id === tplId) || built[0];
        const id = await T.createFromTemplate(t, nm, color);
        await S.saveSettings({ lastBoard: id });
        s.close();
        if (onCreated) onCreated(id); else location.hash = `#/tablero/${id}`;
      });
    },
  });
  T.loadMine().then(() => { if (document.body.contains(s.el)) s.refresh(); });
}

const ACT = {
  created: (t) => `creó ${t}`, moved: (t, d) => `movió ${t}${d ? ` a «${esc(d)}»` : ''}`, done: (t) => `completó ${t}`,
  reopened: (t) => `reabrió ${t}`, archived: (t) => `archivó ${t}`, restored: (t) => `restauró ${t}`, deleted: (t) => `eliminó ${t}`,
  due: (t, d) => (d ? `cambió la fecha de ${t} a ${esc(dueLabel(d.slice(0, 10), d.slice(11)).toLowerCase())}` : `quitó la fecha de ${t}`),
};

export function openActivity(boardId) {
  let items = [];
  let more = false;
  let error = null;
  let loading = true;
  const load = async () => {
    loading = true;
    try {
      const before = items.length ? items[items.length - 1].id : 0;
      const r = await get(`/api/boards/${encodeURIComponent(boardId)}/activity${before ? `?before=${before}` : ''}`);
      items = items.concat(r.items); more = r.more; error = null;
    } catch (e) { error = e; }
    loading = false;
    if (document.body.contains(s.el)) s.refresh();
  };
  const s = openSheet({
    title: 'Actividad',
    render(el) {
      if (error && !items.length) { el.innerHTML = `<div class="empty"><strong>No se puede cargar la actividad</strong>${esc(errorText(error))}</div>`; return; }
      if (loading && !items.length) { el.innerHTML = '<p class="muted">Cargando…</p>'; return; }
      el.innerHTML = `<p class="hint">Lo que se ha hecho en este tablero en los últimos 90 días.</p>
        <div class="activity">${items.map((a) => {
          const who = a.username ? a.name || a.username : 'Una cuenta eliminada';
          const card = a.cardId && S.record(a.cardId);
          const t = card ? `<button type="button" class="link" data-act-card="${esc(a.cardId)}">«${esc(a.title || '')}»</button>` : `«${esc(a.title || '')}»`;
          let what;
          if (a.kind === 'assigned') what = `asignó ${t} a ${esc((a.detail || '').split(', ').map((u) => S.personName(boardId, u)).join(', '))}`;
          else if (a.kind === 'comment') what = `comentó en ${t}: <span class="muted">${esc(a.detail || '')}</span>`;
          else what = (ACT[a.kind] || ((x) => x))(t, a.detail);
          return `<div class="act-row"><span class="mini-av lg" data-c="${personColor(a.username || '?')}">${esc(initial(a.name || a.username || '?'))}</span>
            <div class="grow"><strong>${esc(who)}</strong> ${what}<div class="small muted">${esc(whenText(a.at))}</div></div></div>`;
        }).join('') || (error ? '' : '<p class="muted">Todavía no hay actividad.</p>')}</div>
        ${more ? '<button type="button" class="btn block" data-more>Ver más</button>' : ''}`;
      el.querySelector('[data-more]')?.addEventListener('click', load);
      el.querySelectorAll('[data-act-card]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.actCard)));
    },
  });
  load();
}

function openSaveTemplate(boardId) {
  const b = S.board(boardId);
  const s = openSheet({
    title: 'Guardar como plantilla',
    render(el) {
      el.innerHTML = `<form id="st">
        <div class="field"><label for="st-name">Nombre de la plantilla</label><input id="st-name" class="input" maxlength="60" required value="${esc(b.data.name)}"></div>
        <label class="list-row plain-row"><span class="grow">Incluir las tarjetas pendientes<br><span class="hint">Título, descripción, etiquetas y checklist; sin fechas.</span></span>
          <span class="switch"><input id="st-cards" type="checkbox"><span></span></span></label>
        <p class="hint">Se guardan las columnas, sus límites y las etiquetas. La plantilla es solo tuya y está en todos tus dispositivos.</p>
        <button type="submit" class="btn primary block">Guardar plantilla</button></form>`;
      el.querySelector('#st').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nm = el.querySelector('#st-name').value.trim();
        if (!nm) return;
        try {
          await T.saveMine(T.boardToTemplate(boardId, nm, el.querySelector('#st-cards').checked));
          s.close();
          toast('Plantilla guardada. La verás al crear un tablero.');
        } catch (err) { toast(errorText(err)); }
      });
    },
  });
}

export function openBoardMenu(boardId) {
  const b = S.board(boardId);
  if (!b) return;
  const role = S.roleOf(boardId);
  const admin = S.can(boardId, 'admin');
  const archived = S.cards((c) => c.boardId === boardId && c.data.archived).length;
  openSheet({
    title: esc(b.data.name),
    render(el) {
      el.innerHTML = `<p class="muted small">Tu permiso: <strong>${S.ROLE_NAME[role]}</strong></p>
        <div class="list menu-list">
          ${admin ? `<button type="button" class="list-row" data-go="edit">${icon('pin')}<span class="grow">Nombre y color</span>${icon('right', 's')}</button>
          <button type="button" class="list-row" data-go="cols">${icon('board')}<span class="grow">Columnas y límites</span>${icon('right', 's')}</button>
          <button type="button" class="list-row" data-go="labels">${icon('filter')}<span class="grow">Etiquetas</span>${icon('right', 's')}</button>` : ''}
          <button type="button" class="list-row" data-go="share">${icon('users')}<span class="grow">Miembros y permisos</span>${icon('right', 's')}</button>
          <button type="button" class="list-row" data-go="archived">${icon('archive')}<span class="grow">Tarjetas archivadas</span><span class="muted">${archived}</span></button>
          <button type="button" class="list-row" data-go="activity">${icon('activity')}<span class="grow">Actividad</span>${icon('right', 's')}</button>
          <button type="button" class="list-row" data-go="template">${icon('board')}<span class="grow">Guardar como plantilla</span>${icon('right', 's')}</button>
        </div>
        <div class="section-title danger">Zona delicada</div>
        ${role === 'owner'
          ? `<button type="button" class="btn danger block" data-go="delete">${icon('trash', 's')} Eliminar tablero</button>`
          : `<button type="button" class="btn danger block" data-go="leave">Salir del tablero</button>`}`;
      el.querySelectorAll('[data-go]').forEach((btn) => btn.addEventListener('click', () => {
        const go = btn.dataset.go;
        if (go === 'edit') openBoardEdit(boardId);
        if (go === 'cols') openColumns(boardId);
        if (go === 'labels') openLabels(boardId);
        if (go === 'share') openShare(boardId);
        if (go === 'archived') openArchived(boardId);
        if (go === 'template') openSaveTemplate(boardId);
        if (go === 'activity') openActivity(boardId);
        if (go === 'delete') deleteBoard(boardId);
        if (go === 'leave') leaveBoard(boardId);
      }));
    },
  });
}

function openBoardEdit(boardId) {
  const b = S.board(boardId);
  let color = safeColor(b.data.color);
  const s = openSheet({
    title: 'Nombre y color',
    render(el) {
      el.innerHTML = `<form id="be">
        <div class="field"><label for="be-name">Nombre</label><input id="be-name" class="input" maxlength="80" required value="${esc(b.data.name)}"></div>
        <div class="field"><span class="label">Color</span>${colorPicker('be', color)}</div>
        <button type="submit" class="btn primary block">Guardar</button></form>`;
      bindColorPicker(el, 'be', (c) => { color = c; });
      el.querySelector('#be').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = el.querySelector('#be-name').value.trim();
        if (!name) return;
        const cur = S.board(boardId);
        await S.save('board', boardId, boardId, { ...cur.data, name, color });
        s.close();
      });
    },
  });
}

export function openColumns(boardId) {
  const s = openSheet({
    title: 'Columnas',
    render(el) {
      const cols = S.columns(boardId);
      el.innerHTML = `<p class="hint">El límite de trabajo en curso (WIP) marca la columna en rojo si se supera; no impide mover tarjetas.
        Las tarjetas que entran en una columna «de terminado» cuentan como completadas.</p>
        ${cols.map((c, i) => `<div class="list" data-col="${esc(c.id)}">
          <div class="list-row"><label class="sr" for="cn-${i}">Nombre</label>
            <input id="cn-${i}" class="input grow" maxlength="60" value="${esc(c.data.name)}" data-f="name">
            <button type="button" class="icon-btn plain" data-move="-1" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>${icon('left', 's')}</button>
            <button type="button" class="icon-btn plain" data-move="1" aria-label="Bajar" ${i === cols.length - 1 ? 'disabled' : ''}>${icon('right', 's')}</button></div>
          <div class="list-row"><label for="cw-${i}" class="grow">Límite WIP</label>
            <input id="cw-${i}" class="input num" type="number" min="0" max="999" inputmode="numeric" placeholder="Sin límite" value="${c.data.wip ?? ''}" data-f="wip"></div>
          <div class="list-row"><label for="cd-${i}" class="grow">Columna de terminado</label>
            <span class="switch"><input id="cd-${i}" type="checkbox" data-f="isDone" ${c.data.isDone ? 'checked' : ''}><span></span></span></div>
          <div class="list-row"><span class="grow muted small">${plural(S.columnCards(c.id).length, 'tarjeta', 'tarjetas')}</span>
            <button type="button" class="btn sm danger" data-del>Eliminar</button></div>
        </div><div class="sep"></div>`).join('')}
        <form id="addcol" class="row"><label class="sr" for="ac-name">Nueva columna</label>
          <input id="ac-name" class="input grow" maxlength="60" placeholder="Nueva columna" autocomplete="off">
          <button type="submit" class="btn">Añadir</button></form>`;

      el.querySelectorAll('[data-col]').forEach((box) => {
        const id = box.dataset.col;
        const upd = (p) => { const c = S.record(id); if (c) S.save('column', id, boardId, { ...c.data, ...p }); };
        box.querySelector('[data-f="name"]').addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) upd({ name: v }); });
        box.querySelector('[data-f="wip"]').addEventListener('change', (e) => {
          const n = parseInt(e.target.value, 10);
          upd({ wip: n > 0 && n < 1000 ? n : null });
        });
        box.querySelector('[data-f="isDone"]').addEventListener('change', (e) => upd({ isDone: e.target.checked }));
        box.querySelectorAll('[data-move]').forEach((mb) => mb.addEventListener('click', async () => {
          const list = S.columns(boardId);
          const i = list.findIndex((c) => c.id === id);
          const j = i + Number(mb.dataset.move);
          if (j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          await S.saveMany(list.map((c, k) => ({ kind: 'column', id: c.id, boardId, data: { ...c.data, pos: (k + 1) * 1024 } })));
          s.refresh();
        }));
        box.querySelector('[data-del]').addEventListener('click', async () => {
          const list = S.columns(boardId);
          if (list.length <= 1) return toast('Un tablero necesita al menos una columna.');
          const cardsIn = S.cards((c) => c.data.columnId === id);
          const ok = await confirmDialog({ title: 'Eliminar columna',
            text: cardsIn.length ? `Se eliminarán también sus ${cardsIn.length} tarjetas (incluidas las archivadas).` : 'La columna está vacía.',
            ok: 'Eliminar', danger: true });
          if (ok) await S.remove([...cardsIn.map((c) => c.id), id]);
          openColumns(boardId);
        });
      });
      el.querySelector('#addcol').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = el.querySelector('#ac-name').value.trim();
        if (!name) return;
        const list = S.columns(boardId);
        if (list.length >= 50) return toast('Máximo 50 columnas.');
        // Se añade antes de la primera columna de terminado, si la hay.
        const di = list.findIndex((c) => c.data.isDone);
        const at = di === -1 ? list.length : di;
        await S.save('column', uid(), boardId, { name, pos: S.posAt(list, at), wip: null, isDone: false });
        s.refresh();
        s.el.querySelector('#ac-name')?.focus();
      });
    },
  });
}

export function openLabels(boardId, after) {
  const s = openSheet({
    title: 'Etiquetas',
    onClose: after,
    render(el) {
      const b = S.board(boardId);
      const labels = b.data.labels;
      el.innerHTML = `${labels.length ? '' : '<p class="muted">Aún no hay etiquetas.</p>'}
        ${labels.map((l, i) => `<div class="list-row" data-lb="${esc(l.id)}">
          <span class="dot" data-c="${esc(l.color)}"></span>
          <label class="sr" for="lb-${i}">Nombre</label>
          <input id="lb-${i}" class="input grow" maxlength="40" value="${esc(l.name)}">
          <select class="select" aria-label="Color" data-lc>${COLORS.map((c, k) => `<option value="${c}" ${c === l.color ? 'selected' : ''}>${COLOR_NAMES[k]}</option>`).join('')}</select>
          <button type="button" class="icon-btn plain" data-lbdel aria-label="Eliminar etiqueta">${icon('trash', 's')}</button></div>`).join('')}
        <form id="addlb" class="row"><label class="sr" for="al-name">Nueva etiqueta</label>
          <input id="al-name" class="input grow" maxlength="40" placeholder="Nueva etiqueta" autocomplete="off">
          <button type="submit" class="btn">Añadir</button></form>`;
      const setLabels = (fn) => { const cur = S.board(boardId); return S.save('board', boardId, boardId, { ...cur.data, labels: fn(cur.data.labels) }); };
      el.querySelectorAll('[data-lb]').forEach((row) => {
        const id = row.dataset.lb;
        row.querySelector('input').addEventListener('change', (e) => setLabels((ls) => ls.map((l) => l.id === id ? { ...l, name: e.target.value.trim() } : l)));
        row.querySelector('[data-lc]').addEventListener('change', async (e) => { await setLabels((ls) => ls.map((l) => l.id === id ? { ...l, color: e.target.value } : l)); s.refresh(); });
        row.querySelector('[data-lbdel]').addEventListener('click', async () => {
          await setLabels((ls) => ls.filter((l) => l.id !== id));
          // Se quita también de las tarjetas que la llevaban.
          const affected = S.cards((c) => c.boardId === boardId && c.data.labels.includes(id));
          if (affected.length) await S.saveMany(affected.map((c) => ({ kind: 'card', id: c.id, boardId, data: { ...c.data, labels: c.data.labels.filter((x) => x !== id) } })));
          s.refresh();
        });
      });
      el.querySelector('#addlb').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = el.querySelector('#al-name').value.trim();
        if (!name) return;
        if (S.board(boardId).data.labels.length >= 30) return toast('Máximo 30 etiquetas.');
        await setLabels((ls) => [...ls, { id: shortId(), name, color: COLORS[ls.length % COLORS.length] }]);
        s.refresh();
        s.el.querySelector('#al-name')?.focus();
      });
    },
  });
}

function openArchived(boardId) {
  const s = openSheet({
    title: 'Archivadas',
    render(el) {
      const list = S.cards((c) => c.boardId === boardId && c.data.archived).sort((a, b) => b.updatedAt - a.updatedAt);
      const ro = !S.can(boardId, 'write');
      el.innerHTML = list.length ? `<div class="list">${list.map((c) => `<div class="list-row">
          <button type="button" class="grow btn ghost" data-open="${esc(c.id)}">${esc(c.data.title)}</button>
          ${ro ? '' : `<button type="button" class="btn sm" data-restore="${esc(c.id)}">Restaurar</button>`}</div>`).join('')}</div>`
        : '<div class="empty"><strong>No hay tarjetas archivadas</strong>Desde una tarjeta puedes archivarla para quitarla del tablero sin borrarla.</div>';
      el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
      el.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
        const c = S.record(b.dataset.restore);
        if (c) await S.save('card', c.id, c.boardId, { ...c.data, archived: false });
        s.refresh();
      }));
    },
  });
}

async function deleteBoard(boardId) {
  const b = S.board(boardId);
  const info = S.state.boardInfo.get(boardId);
  const others = info ? info.members - 1 : 0;
  const ok = await confirmDialog({
    title: 'Eliminar tablero',
    text: `Se borrará «${esc(b.data.name)}» con todas sus columnas y tarjetas${others > 0 ? `, también para los otros ${others} miembros` : ''}. No se puede deshacer.`,
    ok: 'Eliminar para siempre', danger: true,
  });
  if (!ok) return;
  await S.remove([boardId]);
  toast('Tablero eliminado');
  location.hash = '#/tableros';
}

async function leaveBoard(boardId) {
  const b = S.board(boardId);
  const ok = await confirmDialog({ title: 'Salir del tablero', text: `Dejarás de ver «${esc(b.data.name)}». Para volver, tendrán que invitarte otra vez.`, ok: 'Salir', danger: true });
  if (!ok) return;
  try {
    await del(`/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(S.state.user.username)}`);
    await S.sync();
    location.hash = '#/tableros';
    toast('Has salido del tablero');
  } catch (e) { toast(errorText(e)); }
}

// ====================================================================================================
// Compartir
// ====================================================================================================

const ROLE_HELP = `<div class="callout perm-list">
  <span><b>Lectura</b> · ve el tablero, las tarjetas y el calendario.</span>
  <span><b>Escritura</b> · además crea, edita, mueve y completa tarjetas.</span>
  <span><b>Todo</b> · además gestiona columnas, etiquetas y miembros.</span>
  <span>Borrar el tablero solo puede el anfitrión.</span></div>`;

export function openShare(boardId) {
  let data = null;
  let error = null;
  const load = async () => {
    // Un tablero recién creado puede no haber llegado aún al servidor: primero se envía.
    if (S.state.pending) await S.sync().catch(() => {});
    try { data = await get(`/api/boards/${encodeURIComponent(boardId)}/members`); error = null; }
    catch (e) { error = e; }
    if (document.body.contains(s.el)) s.refresh();
  };
  const s = openSheet({
    title: `Compartir «${esc(S.board(boardId)?.data.name || '')}»`,
    render(el) {
      if (error) { el.innerHTML = `<div class="empty"><strong>No se pueden cargar los miembros</strong>${esc(errorText(error))}</div>${ROLE_HELP}`; return; }
      if (!data) { el.innerHTML = '<p class="muted">Cargando…</p>'; return; }
      const manager = S.ROLE_RANK[data.myRole] >= S.ROLE_RANK.admin;
      const me = S.state.user.username;
      const roleSelect = (m) => `<select class="select" data-role="${esc(m.username)}" aria-label="Permiso de ${esc(m.username)}">
        ${['read', 'write', 'admin'].map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${S.ROLE_NAME[r]}</option>`).join('')}</select>`;
      el.innerHTML = `
        ${manager ? `<form id="inv"><div class="field"><label for="inv-user">Invitar a un usuario</label>
          <div class="row"><input id="inv-user" class="input grow" placeholder="nombre de usuario" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="30">
          <select id="inv-role" class="select" aria-label="Permiso">${['read', 'write', 'admin'].map((r) => `<option value="${r}" ${r === 'write' ? 'selected' : ''}>${S.ROLE_NAME[r]}</option>`).join('')}</select></div></div>
          <button type="submit" class="btn primary block">Enviar invitación</button>
          <p class="hint">Le aparecerá en la app. Hasta que no la acepte no ve nada del tablero.</p></form>` : ''}
        <div class="section-title">Miembros</div>
        <div class="list">${data.members.map((m) => {
          const editable = manager && m.role !== 'owner' && m.username !== me;
          return `<div class="member">
          <div class="list-row">
            <span class="avatar ${m.status === 'pending' ? 'pending' : ''}" data-c="${COLORS[(m.username.charCodeAt(0) || 0) % COLORS.length]}">${m.status === 'pending' ? '' : esc(m.name.charAt(0) || m.username.charAt(0))}</span>
            <span class="grow"><strong>${esc(m.name)}</strong>${m.username === me ? ' (tú)' : ''}<br>
              <span class="small muted">@${esc(m.username)} · ${m.status === 'pending' ? '<span class="error-text">Invitación pendiente</span>' : m.role === 'owner' ? 'Anfitrión' : S.ROLE_NAME[m.role]}</span></span>
            ${editable ? `<button type="button" class="icon-btn plain" data-remove="${esc(m.username)}" aria-label="${m.status === 'pending' ? 'Anular invitación' : 'Quitar del tablero'} a ${esc(m.username)}">${icon('close', 's')}</button>` : ''}
          </div>
          ${editable && m.status === 'active' ? `<div class="member-role"><span class="small muted">Permiso</span>${roleSelect(m)}</div>` : ''}
        </div>`;
        }).join('')}</div>
        <div class="section-title">Permisos</div>${ROLE_HELP}`;

      el.querySelector('#inv')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = el.querySelector('#inv-user').value.trim().toLowerCase();
        if (!username) return;
        try {
          await post(`/api/boards/${encodeURIComponent(boardId)}/members`, { username, role: el.querySelector('#inv-role').value });
          toast('Invitación enviada');
          load();
        } catch (err) { toast(errorText(err)); }
      });
      el.querySelectorAll('[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
        try {
          await post(`/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(sel.dataset.role)}`, { role: sel.value });
          toast('Permiso cambiado');
        } catch (err) { toast(errorText(err)); }
        load();
      }));
      el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await del(`/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(b.dataset.remove)}`);
          toast('Hecho');
        } catch (err) { toast(errorText(err)); }
        load();
      }));
    },
    onClose() { S.sync(); },
  });
  load();
}

// ====================================================================================================
// Invitaciones recibidas
// ====================================================================================================

export function openInvitations() {
  let list = null;
  let error = null;
  const load = async () => {
    try { list = (await get('/api/invitations')).invitations; error = null; } catch (e) { error = e; }
    if (document.body.contains(s.el)) s.refresh();
  };
  const s = openSheet({
    title: 'Invitaciones',
    render(el) {
      if (error) { el.innerHTML = `<div class="empty"><strong>No se pueden cargar</strong>${esc(errorText(error))}</div>`; return; }
      if (!list) { el.innerHTML = '<p class="muted">Cargando…</p>'; return; }
      if (!list.length) { el.innerHTML = '<div class="empty"><strong>No tienes invitaciones pendientes</strong></div>'; return; }
      el.innerHTML = list.map((i) => `<div class="list" data-inv="${esc(i.boardId)}"><div class="list-row">
          <span class="sq" data-c="${esc(i.color)}"></span>
          <span class="grow"><strong>${esc(i.boardName)}</strong><br><span class="small muted">De ${esc(i.fromName || i.from || 'alguien')} (@${esc(i.from || '?')}) · ${S.ROLE_NAME[i.role] || ''}</span></span></div>
          <div class="list-row"><button type="button" class="btn grow" data-ans="0">Rechazar</button>
          <button type="button" class="btn primary grow" data-ans="1">Aceptar</button></div></div><div class="sep"></div>`).join('');
      el.querySelectorAll('[data-inv]').forEach((box) => box.querySelectorAll('[data-ans]').forEach((b) => b.addEventListener('click', async () => {
        try {
          await post(`/api/invitations/${encodeURIComponent(box.dataset.inv)}`, { accept: b.dataset.ans === '1' });
          if (b.dataset.ans === '1') toast('Ya eres miembro del tablero');
          await S.sync();
        } catch (err) { toast(errorText(err)); }
        load();
      })));
    },
  });
  load();
}

export { todayStr };
