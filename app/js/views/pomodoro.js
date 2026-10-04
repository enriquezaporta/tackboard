// Pantalla Pomodoro: temporizador, tarea en la que se trabaja y estadísticas.
import * as S from '../store.js';
import { esc, icon, paint, toast, plural, DOW_SHORT, DOW_LETTER, MONTHS_SHORT, parseDate } from '../util.js';
import { pomo, durations, PHASE_NAME, remaining, fmt, startPomo, stopPomo, nextBreak, onTick, getStats, DEFAULTS } from '../pomo.js';
import { confirmDialog } from '../ui.js';
import { errorText } from '../api.js';

let chosenCard = null;
let statsDays = 7;
let stats = null;        // {days, data, at}
let unTick = null;

const RING = 2 * Math.PI * 54;

const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${min} min`);

function cardOptions() {
  const boards = S.boards();
  const groups = boards.map((b) => {
    const list = S.cards((c) => c.boardId === b.id && !c.data.done && !c.data.archived)
      .sort((a, z) => (a.data.due || '9') < (z.data.due || '9') ? -1 : 1);
    if (!list.length) return '';
    return `<optgroup label="${esc(b.data.name)}">${list.map((c) =>
      `<option value="${esc(c.id)}" ${c.id === chosenCard ? 'selected' : ''}>${esc(c.data.title.slice(0, 80))}</option>`).join('')}</optgroup>`;
  }).join('');
  return `<option value="">Sin tarjeta</option>${groups}`;
}

function cardLabel(id) {
  const c = id && S.record(id);
  if (!c) return '';
  const b = S.board(c.boardId);
  return `<button type="button" class="pomo-card" data-open-card="${esc(c.id)}">
    <span class="sq" data-c="${esc(b?.data.color)}"></span><span class="grow">${esc(c.data.title)}</span>${icon('right', 's')}</button>`;
}

export function renderPomodoro(main) {
  const d = durations();
  const a = pomo.active;
  const f = pomo.finished;
  const phase = a ? a.phase : f?.phase === 'focus' ? nextBreak() : 'focus';
  if (chosenCard && !S.record(chosenCard)) chosenCard = null;

  let actions;
  if (a) {
    actions = `<button type="button" class="btn grow" data-pomo="stop">Detener</button>`;
  } else if (f?.phase === 'focus') {
    const br = nextBreak();
    actions = `<button type="button" class="btn primary grow" data-pomo="${br}">Empezar ${br === 'long' ? 'descanso largo' : 'descanso'} (${d[br]} min)</button>
      <button type="button" class="btn grow" data-pomo="focus">Otro pomodoro</button>`;
  } else {
    actions = `<button type="button" class="btn primary grow" data-pomo="focus">Empezar pomodoro (${d.focus} min)</button>
      <button type="button" class="btn grow" data-pomo="short">Descanso</button>`;
  }
  const status = a ? PHASE_NAME[a.phase]
    : f?.phase === 'focus' ? '¡Pomodoro terminado!'
      : f ? 'Descanso terminado' : 'Listo';
  const total = a ? a.minutes * 60000 : d[phase] * 60000;

  main.innerHTML = `<div class="page">
    <header class="page-head"><div><div class="eyebrow">${plural(pomo.today, 'pomodoro', 'pomodoros')} hoy</div><h1>Pomodoro</h1></div></header>
    <div class="section pomo-grid">
      <section class="pomo-main ${a ? `is-${a.phase}` : ''}" aria-label="Temporizador">
        <div class="pomo-ring">
          <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="bg" cx="60" cy="60" r="54"/><circle class="fg" id="pomo-arc" cx="60" cy="60" r="54"/></svg>
          <div class="pomo-center">
            <div class="pomo-phase">${esc(status)}</div>
            <div class="pomo-time" id="pomo-time" role="timer" aria-live="off">${fmt(a ? remaining() : total)}</div>
            <div class="pomo-sub">${a?.offline ? 'Sin conexión: no habrá aviso si cierras la app' : `${pomo.cycle % d.every || (pomo.cycle ? d.every : 0)} de ${d.every} antes del descanso largo`}</div>
          </div>
        </div>
        ${a ? (a.phase === 'focus' && a.cardId ? cardLabel(a.cardId) : '') : `
          <div class="field pomo-pick"><label for="pomo-card">¿En qué vas a trabajar?</label>
            <select id="pomo-card" class="select">${cardOptions()}</select></div>`}
        <div class="row pomo-actions">${actions}</div>
        ${!a && f?.cardId && S.record(f.cardId) && !S.record(f.cardId).data.done && S.can(S.record(f.cardId).boardId, 'write')
          ? `<button type="button" class="btn ghost sm" data-done-card="${esc(f.cardId)}">${icon('check', 's')} Marcar «${esc(S.record(f.cardId).data.title.slice(0, 40))}» como hecha</button>` : ''}
      </section>

      <section class="pomo-side">
        <h2 class="section-title">Estadísticas</h2>
        <div class="row"><span class="seg" role="group" aria-label="Periodo">${[[7, '7 días'], [30, '30 días'], [365, 'Año']].map(([k, n]) =>
          `<button type="button" data-days="${k}" aria-pressed="${statsDays === k}">${n}</button>`).join('')}</span></div>
        <div id="pomo-stats" class="pomo-stats"><div class="muted small">Cargando…</div></div>

        <h2 class="section-title">Duración</h2>
        <div class="list">
          ${[['focus', 'Concentración'], ['short', 'Descanso corto'], ['long', 'Descanso largo']].map(([k, n]) => `
            <div class="list-row"><label for="pd-${k}" class="grow">${n}</label>
              <input id="pd-${k}" class="input num-s" type="number" min="1" max="120" inputmode="numeric" value="${d[k]}" data-dur="${k}"><span class="muted small">min</span></div>`).join('')}
          <div class="list-row"><label for="pd-every" class="grow">Descanso largo cada</label>
            <input id="pd-every" class="input num-s" type="number" min="2" max="12" inputmode="numeric" value="${d.every}" data-dur="every"><span class="muted small">pomodoros</span></div>
          <div class="list-row"><label for="pd-push" class="grow">Aviso al terminar<br><span class="hint">Llega aunque la app esté cerrada, si tienes los avisos activados en este dispositivo.</span></label>
            <span class="switch"><input id="pd-push" type="checkbox" ${S.state.notify.prefs?.pomoPush !== false ? 'checked' : ''}><span></span></span></div>
        </div>
        <p class="hint">La técnica: ${DEFAULTS.focus} minutos concentrado en una sola cosa, ${DEFAULTS.short} de descanso y, cada ${DEFAULTS.every}, uno más largo.
          Solo cuentan los pomodoros completos.</p>
      </section>
    </div></div>`;

  paint(main);
  bind(main);
  unTick?.();
  const arc = main.querySelector('#pomo-arc');
  const timeEl = main.querySelector('#pomo-time');
  arc.style.strokeDasharray = `${RING}`;
  const draw = () => {
    if (!document.body.contains(timeEl)) { unTick?.(); return; }
    const act = pomo.active;
    const left = act ? remaining() : total;
    timeEl.textContent = fmt(left);
    arc.style.strokeDashoffset = `${act ? RING * (1 - left / (act.minutes * 60000)) : 0}`;
  };
  draw();
  unTick = onTick(draw);
  loadStats(main);
}

function bind(main) {
  main.querySelector('#pomo-card')?.addEventListener('change', (e) => { chosenCard = e.target.value || null; });
  main.querySelectorAll('[data-pomo]').forEach((b) => b.addEventListener('click', async () => {
    const what = b.dataset.pomo;
    try {
      if (what === 'stop') {
        const a = pomo.active;
        if (a?.phase === 'focus' && remaining() > 60000) {
          const ok = await confirmDialog({ title: 'Detener el pomodoro', text: 'Un pomodoro a medias no cuenta en las estadísticas.', ok: 'Detener', danger: true });
          if (!ok) return;
        }
        await stopPomo();
      } else {
        const r = await startPomo(what, what === 'focus' ? chosenCard : null);
        if (r === 'offline') toast('Sin conexión: el temporizador funciona, pero no habrá aviso si cierras la app.');
      }
    } catch (e) { toast(errorText(e)); }
  }));
  main.querySelector('[data-open-card]')?.addEventListener('click', (e) => {
    import('../sheets.js').then((m) => m.openCard(e.currentTarget.dataset.openCard));
  });
  main.querySelector('[data-done-card]')?.addEventListener('click', async (e) => {
    await S.toggleDone(e.currentTarget.dataset.doneCard);
    toast('Tarea completada');
  });
  main.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
    statsDays = +b.dataset.days;
    main.querySelectorAll('[data-days]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadStats(main, true);
  }));
  main.querySelectorAll('[data-dur]').forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.dur;
    const [lo, hi] = k === 'every' ? [2, 12] : [1, 120];
    const v = Math.max(lo, Math.min(hi, parseInt(inp.value, 10) || DEFAULTS[k]));
    inp.value = v;
    S.saveSettings({ pomo: { ...durations(), [k]: v } });
  }));
  main.querySelector('#pd-push')?.addEventListener('change', async (e) => {
    try { await S.setNotifyPrefs({ pomoPush: e.target.checked }); } catch (err) { e.target.checked = !e.target.checked; toast(errorText(err)); }
  });
}

/** Las estadísticas se piden al servidor; se guardan un minuto para no pedirlas en cada repintado. */
async function loadStats(main, force = false) {
  const box = main.querySelector('#pomo-stats');
  const key = `${statsDays}:${pomo.today}`;
  if (!force && stats && stats.key === key && Date.now() - stats.at < 60000) { box.innerHTML = statsHtml(stats.data); paint(box); bindBars(box); return; }
  try {
    const data = await getStats(statsDays);
    stats = { key, data, at: Date.now() };
    if (!document.body.contains(box)) return;
    box.innerHTML = statsHtml(data);
    paint(box);
    bindBars(box);
  } catch {
    if (document.body.contains(box)) box.innerHTML = '<div class="muted small">Las estadísticas necesitan conexión.</div>';
  }
}

function bucket(data) {
  if (statsDays !== 365) {
    return data.days.map((x) => {
      const dt = parseDate(x.date);
      return { label: statsDays === 7 ? DOW_LETTER[dt.getDay()] : (dt.getDate() % 5 === 1 ? String(dt.getDate()) : ''),
        name: `${DOW_SHORT[dt.getDay()].toLowerCase()} ${dt.getDate()} ${MONTHS_SHORT[dt.getMonth()].toLowerCase()}`, count: x.count, minutes: x.minutes };
    });
  }
  const months = new Map();
  for (const x of data.days) {
    const k = x.date.slice(0, 7);
    const m = months.get(k) || { count: 0, minutes: 0 };
    m.count += x.count; m.minutes += x.minutes;
    months.set(k, m);
  }
  return [...months].map(([k, m]) => {
    const mi = +k.slice(5, 7) - 1;
    return { label: MONTHS_SHORT[mi].charAt(0), name: `${MONTHS_SHORT[mi].toLowerCase()} ${k.slice(0, 4)}`, ...m };
  });
}

function statsHtml(data) {
  const bars = bucket(data);
  const max = Math.max(1, ...bars.map((b) => b.count));
  const bmax = Math.max(1, ...data.boards.map((b) => b.count));
  const boardRow = (b) => {
    const bd = b.boardId && S.board(b.boardId);
    return `<div class="list-row stat-row"><span class="sq" data-c="${esc(bd?.data.color || '#4A5752')}"></span>
      <span class="grow"><span class="stat-name">${esc(bd ? bd.data.name : 'Sin tablero')}</span>
      <span class="meter"><i data-p="${Math.round(b.count / bmax * 100)}"></i></span></span>
      <span class="mono small">${b.count}</span><span class="muted small stat-min">${hm(b.minutes)}</span></div>`;
  };
  return `
    <div class="stat-tiles">
      <div class="stat-tile"><span class="v">${data.total.count}</span><span class="k">pomodoros</span></div>
      <div class="stat-tile"><span class="v">${hm(data.total.minutes)}</span><span class="k">concentrado</span></div>
      <div class="stat-tile"><span class="v">${data.streak}</span><span class="k">${data.streak === 1 ? 'día seguido' : 'días seguidos'}</span></div>
    </div>
    ${data.total.count ? `
    <div class="bars ${statsDays === 30 ? 'dense' : ''}" role="img" aria-label="Pomodoros por ${statsDays === 365 ? 'mes' : 'día'}">
      ${bars.map((b) => `<button type="button" class="bar" data-info="${esc(`${b.name}: ${plural(b.count, 'pomodoro', 'pomodoros')}${b.count ? ` (${hm(b.minutes)})` : ''}`)}"
        aria-label="${esc(`${b.name}: ${b.count}`)}"><i data-p="${Math.round(b.count / max * 100)}" class="${b.count ? '' : 'zero'}"></i><span>${esc(b.label)}</span></button>`).join('')}
    </div>
    <div class="bar-info small muted" id="bar-info">Toca una barra para ver el detalle.</div>
    <h3 class="sub-title">Por tablero</h3>
    <div class="list">${data.boards.map(boardRow).join('')}</div>
    ${data.cards.length ? `<h3 class="sub-title">Tareas con más pomodoros</h3>
    <div class="list">${data.cards.map((c) => {
      const r = S.record(c.cardId);
      return `<button type="button" class="list-row" data-open-card="${esc(c.cardId)}"><span class="grow">${esc(r ? r.data.title : 'Tarjeta borrada')}
        <br><span class="hint">${esc(S.board(c.boardId)?.data.name || '')}</span></span>
        <span class="mono small">${c.count}</span><span class="muted small stat-min">${hm(c.minutes)}</span></button>`;
    }).join('')}</div>` : ''}` : '<div class="empty small-empty">Aún no hay pomodoros en este periodo.</div>'}`;
}

function bindBars(box) {
  const info = box.querySelector('#bar-info');
  box.querySelectorAll('.bar').forEach((b) => {
    const show = () => {
      box.querySelectorAll('.bar').forEach((x) => x.classList.toggle('on', x === b));
      if (info) info.textContent = b.dataset.info;
    };
    b.addEventListener('click', show);
    b.addEventListener('mouseenter', show);
  });
  box.querySelectorAll('[data-open-card]').forEach((b) => b.addEventListener('click', () => {
    if (!S.record(b.dataset.openCard)) return;
    import('../sheets.js').then((m) => m.openCard(b.dataset.openCard));
  }));
}

/** Para empezar un pomodoro desde una tarjeta. */
export async function startFromCard(cardId) {
  if (pomo.active) {
    const ok = await confirmDialog({ title: 'Ya hay uno en marcha', text: '¿Detenerlo y empezar un pomodoro con esta tarea?', ok: 'Empezar' });
    if (!ok) return false;
  }
  chosenCard = cardId;
  const r = await startPomo('focus', cardId);
  if (r === 'offline') toast('Sin conexión: el temporizador funciona, pero no habrá aviso si cierras la app.');
  return true;
}
