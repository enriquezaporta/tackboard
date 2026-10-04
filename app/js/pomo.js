// Pomodoro: estado del temporizador, sincronizado con el servidor (que avisa al terminar aunque la app esté
// cerrada). Sin conexión funciona igual y los pomodoros terminados se envían después.
import * as S from './store.js';
import * as db from './db.js';
import { get, post, ApiError } from './api.js';

export const DEFAULTS = { focus: 25, short: 5, long: 15, every: 4 };
export const PHASE_NAME = { focus: 'Concentración', short: 'Descanso corto', long: 'Descanso largo' };

export const pomo = {
  active: null,     // {id, phase, cardId, startedAt, endsAt, minutes, offline?}
  finished: null,   // lo último que terminó: {phase, cardId, at}
  offset: 0,        // reloj del servidor - reloj del dispositivo
  today: 0,         // pomodoros completados hoy
  cycle: 0,         // pomodoros seguidos (para el descanso largo)
  ack: 0,           // fin del último pomodoro ya atendido (para no proponer su descanso otra vez)
};

export const durations = () => ({ ...DEFAULTS, ...(S.state.settings.pomo || {}) });
export const nowSrv = () => Date.now() + pomo.offset;
export const remaining = () => (pomo.active ? Math.max(0, pomo.active.endsAt - nowSrv()) : 0);
export const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Cada segundo, mientras hay uno en marcha, se avisa a quien muestre el tiempo (sin repintar la pantalla).
const tickers = new Set();
export function onTick(fn) { tickers.add(fn); return () => tickers.delete(fn); }
let tickTimer = null;
function ticking() {
  clearInterval(tickTimer);
  tickTimer = pomo.active ? setInterval(() => { for (const f of tickers) f(); }, 1000) : null;
  for (const f of tickers) f();
}

async function persist() {
  await db.setMeta('pomo', { active: pomo.active, finished: pomo.finished, offset: pomo.offset, today: pomo.today, cycle: pomo.cycle, ack: pomo.ack, lastFocus });
}
let lastFocus = 0;

function apply(r) {
  pomo.offset = r.now - Date.now();
  pomo.today = r.today;
  if (!(pomo.active?.offline && !r.active)) pomo.active = r.active;
  // Si terminó mientras la app estaba cerrada, se propone el descanso.
  if (!pomo.active && !pomo.finished && r.lastEnd && r.lastEnd > pomo.ack && r.now - r.lastEnd < 15 * 60000) {
    pomo.finished = { phase: 'focus', cardId: null, at: r.lastEnd };
  }
  if (r.lastEnd && (pomo.active || pomo.finished)) pomo.ack = Math.max(pomo.ack, r.lastEnd);
  arm();
  persist();
  S.emit();
}

export async function restorePomo() {
  const m = await db.getMeta('pomo');
  if (m) Object.assign(pomo, { active: m.active, finished: m.finished, offset: m.offset || 0, today: m.today || 0, cycle: m.cycle || 0, ack: m.ack || 0 });
  lastFocus = m?.lastFocus || 0;
  arm();
}

export async function loadPomo() {
  try {
    apply(await get('/api/pomo'));
    flushOffline();
  } catch { /* sin conexión: se sigue con lo guardado */ }
}

let audio = null;
function prepareSound() {
  // El sonido solo se puede preparar al tocar un botón (norma de los navegadores).
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch { audio = null; }
}
function chime() {
  try {
    navigator.vibrate?.([180, 80, 180]);
    if (!audio) return;
    const t = audio.currentTime;
    [0, 0.25].forEach((d, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = i ? 880 : 660;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.4);
      o.connect(g).connect(audio.destination);
      o.start(t + d); o.stop(t + d + 0.45);
    });
  } catch { /* sin sonido */ }
}

export async function startPomo(phase, cardId = null) {
  prepareSound();
  const minutes = durations()[phase];
  pomo.finished = null;
  try {
    apply(await post('/api/pomo/start', { phase, minutes, cardId: phase === 'focus' ? cardId : null }));
    return 'ok';
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 0) throw e;
    const t = nowSrv();
    pomo.active = { id: `local-${t}`, phase, cardId: phase === 'focus' ? cardId : null, startedAt: t, endsAt: t + minutes * 60000, minutes, offline: true };
    arm(); persist(); S.emit();
    return 'offline';
  }
}

export async function stopPomo() {
  const a = pomo.active;
  pomo.active = null;
  pomo.finished = null;
  pomo.ack = Math.max(pomo.ack, nowSrv());
  arm(); persist(); S.emit();
  if (a && !a.offline) {
    try { apply(await post('/api/pomo/stop', { id: a.id })); } catch { /* el servidor lo cerrará solo */ }
  }
}

/** Siguiente descanso propuesto: largo cada N pomodoros. */
export function nextBreak() {
  const d = durations();
  return pomo.cycle > 0 && pomo.cycle % d.every === 0 ? 'long' : 'short';
}

let endTimer = null;
function arm() {
  clearTimeout(endTimer);
  if (pomo.active) endTimer = setTimeout(finishLocal, remaining() + 250);
  ticking();
}

async function finishLocal() {
  const a = pomo.active;
  if (!a) return;
  if (remaining() > 0) { arm(); return; }
  pomo.active = null;
  pomo.finished = { phase: a.phase, cardId: a.cardId, at: a.endsAt };
  pomo.ack = Math.max(pomo.ack, a.endsAt);
  if (a.phase === 'focus') {
    // Si hace más de 3 horas del anterior, el ciclo empieza de nuevo.
    if (a.endsAt - lastFocus > 3 * 3600000) pomo.cycle = 0;
    pomo.cycle += 1;
    lastFocus = a.endsAt;
    pomo.today += 1;
    if (a.offline) {
      const q = await db.getMeta('pomoOutbox', []);
      q.push({ cardId: a.cardId, startedAt: a.startedAt, minutes: a.minutes });
      await db.setMeta('pomoOutbox', q.slice(-50));
    }
  }
  chime();
  arm(); persist(); S.emit();
  if (a.offline) flushOffline(); else setTimeout(() => loadPomo(), 3000);
}

async function flushOffline() {
  const q = await db.getMeta('pomoOutbox', []);
  if (!q.length) return;
  try {
    const r = await post('/api/pomo/log', { items: q });
    await db.setMeta('pomoOutbox', []);
    apply(r);
  } catch { /* se intentará más tarde */ }
}

export const getStats = (days) => get(`/api/pomo/stats?days=${days}`);

/** Al cerrar sesión. */
export function resetPomo() {
  pomo.active = null; pomo.finished = null; pomo.today = 0; pomo.cycle = 0;
  arm();
}
