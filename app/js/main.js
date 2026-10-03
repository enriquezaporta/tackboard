// Arranque, rutas y estructura de la app.
import * as S from './store.js';
import { onAuth } from './api.js';
import { esc, icon, paint, toast } from './util.js';
import { isDragging } from './drag.js';
import { renderToday } from './views/today.js';
import { renderBoards, renderBoard } from './views/board.js';
import { renderCalendar } from './views/calendar.js';
import { renderSettings, syncClass } from './views/settings.js';
import { renderAuth, askConsent } from './views/auth.js';

const main = document.getElementById('main');
const tabbar = document.getElementById('tabbar');
const sidebar = document.getElementById('sidebar');

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/');
  return { name: name || 'hoy', arg: arg ? decodeURIComponent(arg) : null };
}

const TABS = [
  ['hoy', 'Hoy', 'sun'],
  ['tableros', 'Tableros', 'board'],
  ['calendario', 'Calendario', 'cal'],
  ['ajustes', 'Ajustes', 'settings'],
];
const section = (name) => (name === 'tablero' ? 'tableros' : name);

function renderChrome(r) {
  const sec = section(r.name);
  const inv = S.state.invitations;
  tabbar.innerHTML = TABS.map(([k, n, ic]) => `<a class="tab" href="#/${k}" ${sec === k ? 'aria-current="page"' : ''}>
    ${icon(ic)}${n}${k === 'tableros' && inv ? `<span class="badge" aria-label="${inv} invitaciones">${inv}</span>` : ''}</a>`).join('');

  const boards = S.boards();
  sidebar.innerHTML = `<div class="side-brand"><img src="icons/icon-192.png" alt="">Tackboard</div>
    <nav class="side-nav">${TABS.map(([k, n, ic]) => `<a class="side-link" href="#/${k}" ${r.name === k ? 'aria-current="page"' : ''}>${icon(ic, 's')}<span class="grow">${n}</span>
      ${k === 'tableros' && inv ? `<span class="badge">${inv}</span>` : ''}</a>`).join('')}</nav>
    <div class="side-nav"><div class="side-label">Tableros</div>
      ${boards.map((b) => `<a class="side-link" href="#/tablero/${esc(b.id)}" ${r.name === 'tablero' && r.arg === b.id ? 'aria-current="page"' : ''}>
        <span class="sq" data-c="${esc(b.data.color)}"></span><span class="grow">${esc(b.data.name)}</span>
        ${(S.state.boardInfo.get(b.id)?.members || 1) > 1 ? icon('users', 's') : ''}</a>`).join('')}
      <a class="side-link muted" href="#/tableros">${icon('plus', 's')}<span class="grow">Nuevo tablero</span></a></div>
    <div class="side-foot"><span class="sync-dot ${syncClass()}"></span>${S.state.pending ? `${S.state.pending} sin enviar` : S.state.sync.status === 'ok' ? 'Sincronizado' : S.state.sync.status === 'syncing' ? 'Sincronizando…' : 'Sin conexión'}</div>`;
  paint(sidebar);
}

/** ¿Hay algo a medio escribir en la pantalla principal? Entonces no se repinta. */
function editingInMain() {
  const a = document.activeElement;
  return a && main.contains(a) && a.matches('textarea, input:not([type="checkbox"]):not([type="search"])');
}

let pendingRender = false;
function render() {
  if (isDragging() || editingInMain()) { pendingRender = true; return; }
  pendingRender = false;
  const r = route();
  applyTheme();
  if (!S.state.user) {
    document.body.classList.add('auth-page');
    renderAuth(main);
    return;
  }
  document.body.classList.remove('auth-page');
  renderChrome(r);
  if (r.name === 'hoy') renderToday(main);
  else if (r.name === 'tableros') renderBoards(main);
  else if (r.name === 'tablero') renderBoard(main, r.arg);
  else if (r.name === 'calendario') renderCalendar(main, r.arg);
  else if (r.name === 'ajustes') renderSettings(main);
  else renderToday(main);
  paint(main);
}

document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) render(); }, 0));
document.addEventListener('pointerup', () => setTimeout(() => { if (pendingRender) render(); }, 30));

const media = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = S.state.settings.theme || 'auto';
  const dark = t === 'dark' || (t === 'auto' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
media.addEventListener('change', () => render());

let lastRoute = '';
window.addEventListener('hashchange', () => {
  const now = location.hash;
  if (now !== lastRoute) { lastRoute = now; window.scrollTo(0, 0); }
  render();
  main.focus({ preventScroll: true });
});

onAuth(
  async () => { await S.sessionExpired(); location.hash = '#/'; },
  () => askConsent(),
);
S.onNotice((msg) => toast(msg));

S.subscribe(render);

(async function start() {
  await S.load();
  lastRoute = location.hash;
  render();
  if (S.state.user) S.sync();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.state.user) S.sync(); });
  window.addEventListener('online', () => S.state.user && S.sync());
  // Mientras la app está abierta, se recogen cada minuto los cambios de los tableros compartidos.
  setInterval(() => { if (document.visibilityState === 'visible' && S.state.user) S.sync(); }, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}());
