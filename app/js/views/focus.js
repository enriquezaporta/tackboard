// Modo enfoque: pantalla completa con la tarea, su checklist y el tiempo que queda. Mantiene la pantalla encendida.
import * as S from '../store.js';
import { esc, icon, paint, toast } from '../util.js';
import { pomo, remaining, fmt, PHASE_NAME, onTick, startPomo, stopPomo, nextBreak, durations } from '../pomo.js';
import { errorText } from '../api.js';

let root = null;
let unsub = null;
let untick = null;
let lock = null;

let asking = false;
async function keepAwake() {
  if (!('wakeLock' in navigator) || lock || asking || document.visibilityState !== 'visible') return;
  asking = true;
  try {
    const l = await navigator.wakeLock.request('screen');
    // Si mientras tanto se ha salido del modo enfoque, se suelta enseguida.
    if (!root || lock) { l.release().catch(() => {}); return; }
    lock = l;
    l.addEventListener('release', () => { if (lock === l) lock = null; });
  } catch { /* el navegador no lo permite: no pasa nada */ } finally { asking = false; }
}
const onVisible = () => { if (root && document.visibilityState === 'visible') keepAwake(); };

export function openFocus() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'focus';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Modo enfoque');
  document.body.append(root);
  document.body.classList.add('focus-open');
  render();
  unsub = S.subscribe(render);
  untick = onTick(tick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisible);
  keepAwake();
  root.querySelector('[data-f="exit"]')?.focus();
}

export function closeFocus() {
  if (!root) return;
  unsub?.(); untick?.();
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('visibilitychange', onVisible);
  lock?.release?.().catch(() => {});
  lock = null;
  root.remove();
  root = null;
  document.body.classList.remove('focus-open');
}

const onKey = (e) => { if (e.key === 'Escape') closeFocus(); };

function tick() {
  const t = root?.querySelector('.focus-time');
  if (t && pomo.active) t.textContent = fmt(remaining());
}

function render() {
  if (!root) return;
  // Si se está marcando la checklist no se repinta a mitad (el foco se perdería).
  const a = pomo.active;
  const f = pomo.finished;
  const cardId = a?.cardId || f?.cardId;
  const c = cardId && S.record(cardId);
  const d = c?.data;
  const canWrite = c && S.can(c.boardId, 'write');
  const b = c && S.board(c.boardId);
  let actions;
  if (a) actions = `<button type="button" class="btn" data-f="stop">Detener</button>`;
  else if (f?.phase === 'focus') {
    const br = nextBreak();
    actions = `<button type="button" class="btn primary" data-f="${br}">Descanso (${durations()[br]} min)</button>`;
  } else actions = `<button type="button" class="btn primary" data-f="focus">Otro pomodoro</button>`;
  root.innerHTML = `<div class="focus-inner ${a ? `is-${a.phase}` : ''}">
    <div class="focus-top"><span class="focus-phase">${esc(a ? PHASE_NAME[a.phase] : f?.phase === 'focus' ? '¡Pomodoro terminado!' : 'Descanso terminado')}</span>
      <button type="button" class="icon-btn plain" data-f="exit" aria-label="Salir del modo enfoque">${icon('close')}</button></div>
    <div class="focus-time" role="timer">${a ? fmt(remaining()) : '00:00'}</div>
    ${a && a.phase !== 'focus' ? '<p class="focus-tip">Levántate, estira las piernas y descansa la vista.</p>' : ''}
    ${d && (!a || a.phase === 'focus') ? `<div class="focus-card">
      <div class="focus-board"><span class="sq" data-c="${esc(b?.data.color)}"></span>${esc(b?.data.name || '')}</div>
      <h2>${esc(d.title)}</h2>
      ${d.description ? `<p class="focus-desc">${esc(d.description.slice(0, 1200))}${d.description.length > 1200 ? '…' : ''}</p>` : ''}
      ${d.checklist.length ? `<div class="focus-check">${d.checklist.map((it) => `
        <label class="checklist-item ${it.done ? 'done' : ''}"><input type="checkbox" data-ck="${esc(it.id)}" ${it.done ? 'checked' : ''} ${canWrite ? '' : 'disabled'}>
          <span class="txt">${esc(it.text)}</span></label>`).join('')}</div>` : ''}
    </div>` : (!a || a.phase === 'focus') ? '<p class="focus-tip">Una sola cosa. Si te viene otra a la cabeza, apúntala y sigue.</p>' : ''}
    <div class="focus-actions">${actions}</div>
  </div>`;
  paint(root);
  root.querySelectorAll('[data-ck]').forEach((cb) => cb.addEventListener('change', () => {
    const cur = S.record(cardId);
    if (!cur) return;
    S.save('card', cur.id, cur.boardId, { ...cur.data, checklist: cur.data.checklist.map((i) => (i.id === cb.dataset.ck ? { ...i, done: cb.checked } : i)) });
  }));
  root.querySelectorAll('[data-f]').forEach((btn) => btn.addEventListener('click', async () => {
    const what = btn.dataset.f;
    if (what === 'exit') return closeFocus();
    try {
      if (what === 'stop') { await stopPomo(); closeFocus(); return; }
      await startPomo(what, what === 'focus' ? cardId || null : null);
    } catch (e) { toast(errorText(e)); }
  }));
}
