// Ajustes: cuenta, sincronización, apariencia, privacidad y seguridad.
import * as S from '../store.js';
import { get, post, errorText, getToken } from '../api.js';
import { esc, icon, toast, REMINDERS, paint } from '../util.js';
import { confirmDialog, openSheet } from '../ui.js';
import { openInvitations } from '../sheets.js';
import { showRecoveryCode } from './auth.js';
import { pushState, enablePush, disablePush, testPush } from '../push.js';
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };

export const APP_VERSION = '1.3.0';

function syncText() {
  const s = S.state.sync;
  if (s.status === 'syncing') return 'Sincronizando…';
  if (s.status === 'offline') return 'Sin conexión con el servidor';
  if (s.status === 'error') return errorText(s.error);
  if (s.lastOk) return `Sincronizado a las ${new Date(s.lastOk).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  return 'Sin sincronizar todavía';
}

export function syncClass() {
  const s = S.state.sync.status;
  if (s === 'error' || s === 'offline') return 'error';
  if (S.state.pending) return 'pending';
  return s === 'ok' ? 'ok' : '';
}

export function renderSettings(main) {
  const u = S.state.user;
  const theme = S.state.settings.theme || 'auto';
  main.innerHTML = `<div class="page">
    <header class="page-head"><h1>Ajustes</h1></header>
    <div class="section settings-grid"><div class="settings-col">
      <h2 class="section-title">Cuenta</h2>
      <div class="list">
        <div class="list-row"><span class="avatar" data-c="#0E6B62">${esc((u.name || u.username).charAt(0))}</span>
          <span class="grow"><strong>${esc(u.name)}</strong><br><span class="small muted">@${esc(u.username)}</span></span>
          <button type="button" class="btn sm" data-act="name">Cambiar nombre</button></div>
        <div class="list-row"><label for="acc-inv" class="grow">Permitir que me inviten a tableros<br><span class="hint">Si lo desactivas, nadie puede enviarte invitaciones.</span></label>
          <span class="switch"><input id="acc-inv" type="checkbox" ${u.acceptInvites ? 'checked' : ''}><span></span></span></div>
        <button type="button" class="list-row" data-act="inv">${icon('inbox')}<span class="grow">Invitaciones recibidas</span>
          ${S.state.invitations ? `<span class="badge">${S.state.invitations}</span>` : ''}${icon('right', 's')}</button>
      </div>

      <h2 class="section-title">Sincronización</h2>
      <div class="list">
        <div class="list-row"><span class="sync-dot ${syncClass()}"></span><span class="grow">${esc(syncText())}<br>
          <span class="hint">${S.state.pending ? `${S.state.pending} cambios pendientes de enviar` : 'Todo enviado'}</span></span>
          <button type="button" class="btn sm" data-act="sync">${icon('sync', 's')} Sincronizar</button></div>
      </div>
      <p class="hint">Los cambios se guardan primero en este dispositivo y se envían al servidor en cuanto hay conexión.</p>

      <h2 class="section-title">Apariencia</h2>
      <div class="list"><div class="list-row"><span class="grow">Tema</span>
        <span class="seg" role="group" aria-label="Tema">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, n]) =>
          `<button type="button" data-theme-set="${k}" aria-pressed="${theme === k}">${n}</button>`).join('')}</span></div></div>

      <h2 class="section-title">Calendario del móvil</h2>
      <div class="list" id="ical-box"><div class="list-row"><span class="grow muted">Cargando…</span></div></div>
      <p class="hint">Un enlace secreto para ver tus tareas con fecha en el calendario del iPhone, Android, Outlook o Google Calendar.
        Se actualiza solo, normalmente cada hora; es de solo lectura.</p>

    </div><div class="settings-col">
      <h2 class="section-title">Avisos</h2>
      <div class="list" id="push-box"><div class="list-row"><span class="grow muted">Comprobando este dispositivo…</span></div></div>
      ${notifyHtml()}
      <h2 class="section-title">Seguridad</h2>
      <div class="list">
        <button type="button" class="list-row" data-act="pw"><span class="grow">Cambiar contraseña</span>${icon('right', 's')}</button>
        <button type="button" class="list-row" data-act="code"><span class="grow">Generar un código de recuperación nuevo</span>${icon('right', 's')}</button>
        <button type="button" class="list-row" data-act="others"><span class="grow">Cerrar sesión en los demás dispositivos</span>${icon('right', 's')}</button>
      </div>

      <h2 class="section-title">Privacidad</h2>
      <div class="list">
        <button type="button" class="list-row" data-act="export"><span class="grow">Descargar todos mis datos</span>${icon('right', 's')}</button>
        <a class="list-row" href="privacy.html"><span class="grow">Política de privacidad</span>${icon('right', 's')}</a>
        <a class="list-row" href="terms.html"><span class="grow">Condiciones de uso</span>${icon('right', 's')}</a>
        <button type="button" class="list-row" data-act="delete"><span class="grow error-text">Eliminar mi cuenta</span>${icon('right', 's')}</button>
      </div>

      <div class="sep"></div>
      <button type="button" class="btn block" data-act="logout">Cerrar sesión</button>
      <p class="hint">Tackboard ${APP_VERSION} · <a href="https://github.com/enriquezaporta/tackboard" rel="noopener noreferrer" target="_blank">Código fuente</a></p>
    </div></div></div>`;

  renderPush(main);
  renderIcal(main);
  bindNotify(main);
  if (!S.state.notify.prefs && !prefsRequested) { prefsRequested = true; S.loadNotifyPrefs(); }

  main.querySelector('#acc-inv').addEventListener('change', async (e) => {
    try { const r = await post('/api/me', { acceptInvites: e.target.checked }); await S.setUser(r.user); }
    catch (err) { toast(errorText(err)); e.target.checked = !e.target.checked; }
  });

  main.onclick = async (e) => {
    const th = e.target.closest('[data-theme-set]');
    if (th) { await S.saveSettings({ theme: th.dataset.themeSet }); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'sync') { await S.sync(); toast(S.state.sync.status === 'ok' ? 'Sincronizado' : syncText()); }
    if (act === 'inv') openInvitations();
    if (act === 'name') {
      const v = await confirmDialog({ title: 'Cambiar nombre', text: 'Es el nombre que ven los miembros de tus tableros.', ok: 'Guardar', input: { label: 'Nombre' } });
      if (v && v.trim()) {
        try { const r = await post('/api/me', { name: v.trim() }); await S.setUser(r.user); toast('Nombre cambiado'); }
        catch (err) { toast(errorText(err)); }
      }
    }
    if (act === 'pw') changePassword();
    if (act === 'code') {
      const pw = await confirmDialog({ title: 'Código nuevo', text: 'El código anterior dejará de servir. Escribe tu contraseña para continuar.', ok: 'Generar', input: { label: 'Contraseña', type: 'password', autocomplete: 'current-password' } });
      if (pw) {
        try { const r = await post('/api/me/recovery', { password: pw }); showRecoveryCode(r.recoveryCode); }
        catch (err) { toast(errorText(err)); }
      }
    }
    if (act === 'others') {
      if (await confirmDialog({ title: 'Cerrar otras sesiones', text: 'Tendrás que volver a entrar en tus otros dispositivos. Si tienes enlace de calendario, también se desactiva.', ok: 'Cerrar sesiones' })) {
        try { await post('/api/auth/logout-others'); toast('Hecho'); } catch (err) { toast(errorText(err)); }
      }
    }
    if (act === 'export') exportData();
    if (act === 'delete') deleteAccount();
    if (act === 'logout') logout();
  };
}

let prefsRequested = false;

// ---------- Enlace de calendario (iCal) ----------
const fmtDate = (s) => new Date(s * 1000).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function renderIcal(main) {
  const box = main.querySelector('#ical-box');
  let info;
  try { info = await get('/api/ical'); } catch {
    if (document.body.contains(box)) box.innerHTML = '<div class="list-row"><span class="grow muted">Necesita conexión con el servidor.</span></div>';
    return;
  }
  if (!document.body.contains(box)) return;
  if (!info.active) {
    box.innerHTML = `<div class="list-row"><span class="grow">Sin enlace</span>
      <button type="button" class="btn sm primary" data-ical="new">Crear enlace</button></div>`;
  } else {
    const ex = new Set(info.excluded);
    box.innerHTML = `<div class="list-row"><span class="grow">Enlace activo<br><span class="hint">Creado el ${esc(fmtDate(info.createdAt))}${
      info.lastFetch ? ` · consultado el ${esc(fmtDate(info.lastFetch))}` : ' · aún no se ha consultado'}</span></span></div>
      ${S.boards().map((b) => `<div class="list-row"><span class="sq" data-c="${esc(b.data.color)}"></span><label for="ic-${esc(b.id)}" class="grow">${esc(b.data.name)}</label>
        <span class="switch"><input id="ic-${esc(b.id)}" type="checkbox" data-ical-board="${esc(b.id)}" ${ex.has(b.id) ? '' : 'checked'}><span></span></span></div>`).join('')}
      <div class="list-row"><button type="button" class="btn sm" data-ical="new">Crear un enlace nuevo</button><span class="grow"></span>
        <button type="button" class="btn sm danger" data-ical="revoke">Desactivar</button></div>`;
  }
  paint(box);
  box.querySelectorAll('[data-ical-board]').forEach((cb) => cb.addEventListener('change', async () => {
    const excluded = [...box.querySelectorAll('[data-ical-board]')].filter((x) => !x.checked).map((x) => x.dataset.icalBoard);
    try { await post('/api/ical/prefs', { excluded }); } catch (err) { cb.checked = !cb.checked; toast(errorText(err)); }
  }));
  box.querySelector('[data-ical="new"]')?.addEventListener('click', async () => {
    if (info.active && !await confirmDialog({ title: 'Crear un enlace nuevo', text: 'El enlace actual dejará de funcionar: tendrás que suscribirte otra vez con el nuevo.', ok: 'Crear enlace' })) return;
    try { const r = await post('/api/ical/new'); showIcalLink(r.path); } catch (err) { toast(errorText(err)); }
    renderIcal(main);
  });
  box.querySelector('[data-ical="revoke"]')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Desactivar el enlace', text: 'Los calendarios suscritos dejarán de recibir tus tareas.', ok: 'Desactivar', danger: true })) return;
    try { await post('/api/ical/revoke'); toast('Enlace desactivado'); } catch (err) { toast(errorText(err)); }
    renderIcal(main);
  });
}

function showIcalLink(path) {
  const url = `${location.origin}${path}`;
  const webcal = url.replace(/^https?:/, 'webcal:');
  openSheet({
    title: 'Enlace de calendario',
    render(el) {
      el.innerHTML = `
        <p class="small">Cópialo ahora: por seguridad no se vuelve a mostrar. Si lo pierdes, crea uno nuevo.</p>
        <label class="sr" for="ical-url">Enlace</label>
        <input id="ical-url" class="input mono" readonly value="${esc(url)}">
        <div class="row"><button type="button" class="btn grow" id="ical-copy">Copiar</button>
          <a class="btn primary grow" href="${esc(webcal)}">Añadir al calendario</a></div>
        <h3 class="sub-title">iPhone</h3>
        <p class="small">Toca <strong>Añadir al calendario</strong> y confirma. O bien: <em>Ajustes → Calendario → Cuentas → Añadir cuenta → Otra →
          Añadir calendario suscrito</em> y pega el enlace. Elige guardarlo <strong>En mi iPhone</strong> (no en iCloud) para que las tareas no salgan del teléfono.</p>
        <h3 class="sub-title">Google Calendar u Outlook</h3>
        <p class="small">«Añadir calendario → Desde URL» y pega el enlace. Ojo: esos servicios tienen que poder llegar a tu servidor desde internet.</p>
        <p class="hint">Quien tenga el enlace puede ver los títulos y fechas de tus tareas. No lo compartas; si crees que alguien lo tiene, crea uno nuevo.</p>`;
      el.querySelector('#ical-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); }
        catch { const i = el.querySelector('#ical-url'); i.select(); toast('Selecciónalo y cópialo'); }
      });
    },
  });
}

function notifyHtml() {
  const n = S.state.notify;
  const p = n.prefs;
  if (!p) return '<p class="hint">Las preferencias de avisos se cargarán al conectar con el servidor.</p>';
  if (n.available === false) return '<p class="callout warn">El servidor no tiene activados los avisos (falta python3-cryptography).</p>';
  const sw = (id, on, label, hint = '', dis = '') => `<div class="list-row"><label for="${id}" class="grow">${label}${hint ? `<br><span class="hint">${hint}</span>` : ''}</label>
    <span class="switch"><input id="${id}" type="checkbox" ${on ? 'checked' : ''} ${dis}><span></span></span></div>`;
  const boards = S.boards();
  const dis = p.enabled ? '' : 'disabled';
  return `<div class="list notify-prefs">
      ${sw('np-enabled', p.enabled, 'Recibir avisos', 'En todos tus dispositivos con los avisos activados.')}
      <div class="list-row stack"><span>Recordatorio por defecto<br><span class="hint">Se pone al dar fecha a una tarjeta. Luego puedes cambiarlo en cada una.</span></span>
        <span class="chips">${REMINDERS.map(([k, label]) => `<button type="button" class="chip" data-defrem="${k}" aria-pressed="${p.defaultReminders.includes(k)}" ${dis}>${label}</button>`).join('')}</span></div>
      ${sw('np-quiet', p.quiet.on, 'Horario de silencio', 'Lo que toque en ese tiempo se avisa al terminar.', dis)}
      ${p.quiet.on ? `<div class="list-row times"><label for="np-qs">Desde</label><input id="np-qs" class="input time-input" type="time" value="${esc(p.quiet.start)}" ${dis}>
        <label for="np-qe">hasta</label><input id="np-qe" class="input time-input" type="time" value="${esc(p.quiet.end)}" ${dis}></div>` : ''}
      ${sw('np-digest', p.digest.on, 'Resumen diario', 'Cuántas tareas tienes para hoy y cuántas han vencido.', dis)}
      ${p.digest.on ? `<div class="list-row"><label for="np-dt" class="grow">A las</label><input id="np-dt" class="input time-input num" type="time" value="${esc(p.digest.time)}" ${dis}></div>` : ''}
      <div class="list-row"><span class="grow">Zona horaria<br><span class="hint">Para el horario de silencio y el resumen diario.</span></span>
        <span class="small muted">${esc(p.tz)}</span>
        ${deviceTz() && deviceTz() !== p.tz ? `<button type="button" class="btn sm" id="np-tz">Usar ${esc(deviceTz())}</button>` : ''}</div>
      ${sw('np-titles', p.showTitles, 'Mostrar el título de la tarea', 'Si está desactivado, el aviso solo dice «Tienes una tarea que vence…» y el título no pasa por Apple ni Google.', dis)}
    </div>
    ${boards.length ? `<div class="section-title small-title">Por tablero</div><div class="list">${boards.map((b) => `<div class="list-row">
        <span class="sq" data-c="${esc(b.data.color)}"></span><label for="nb-${esc(b.id)}" class="grow">${esc(b.data.name)}</label>
        <span class="switch"><input id="nb-${esc(b.id)}" type="checkbox" data-board-mute="${esc(b.id)}" ${p.mutedBoards.includes(b.id) ? '' : 'checked'} ${dis}><span></span></span></div>`).join('')}</div>` : ''}`;
}

function bindNotify(main) {
  if (!S.state.notify.prefs) return;
  const save = async (patch) => {
    try { await S.setNotifyPrefs(patch); } catch (err) { toast(errorText(err)); S.emit(); }
  };
  const on = (sel, fn) => main.querySelector(sel)?.addEventListener('change', fn);
  on('#np-enabled', (e) => save({ enabled: e.target.checked }));
  on('#np-quiet', (e) => save({ quiet: { on: e.target.checked } }));
  on('#np-qs', (e) => e.target.value && save({ quiet: { start: e.target.value } }));
  on('#np-qe', (e) => e.target.value && save({ quiet: { end: e.target.value } }));
  on('#np-digest', (e) => save({ digest: { on: e.target.checked } }));
  on('#np-dt', (e) => e.target.value && save({ digest: { time: e.target.value } }));
  on('#np-titles', (e) => save({ showTitles: e.target.checked }));
  main.querySelector('#np-tz')?.addEventListener('click', () => save({ tz: deviceTz() }));
  main.querySelectorAll('[data-defrem]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.defrem;
    const cur = S.state.notify.prefs.defaultReminders;
    save({ defaultReminders: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] });
  }));
  main.querySelectorAll('[data-board-mute]').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.dataset.boardMute;
    const cur = S.state.notify.prefs.mutedBoards.filter((x) => x !== id);
    save({ mutedBoards: cb.checked ? cur : [...cur, id] });
  }));
}

const PUSH_TEXT = {
  unsupported: 'Este navegador no admite notificaciones push.',
  install: 'En iPhone y iPad los avisos solo funcionan con la app instalada: Safari → Compartir → Añadir a pantalla de inicio, y ábrela desde el icono.',
  denied: 'Has bloqueado las notificaciones. Actívalas en los ajustes del dispositivo (en iPhone: Ajustes → Notificaciones → Tackboard).',
  off: 'Este dispositivo no recibe avisos.',
  on: 'Este dispositivo recibe avisos.',
};

async function renderPush(main) {
  const box = main.querySelector('#push-box');
  if (!box) return;
  let st;
  try { st = await pushState(); } catch { st = 'unsupported'; }
  if (!document.body.contains(box)) return;
  box.innerHTML = `<div class="list-row"><span class="sync-dot ${st === 'on' ? 'ok' : st === 'off' ? '' : 'error'}"></span>
      <span class="grow">${esc(PUSH_TEXT[st])}</span></div>
    ${st === 'off' ? `<div class="list-row"><button type="button" class="btn primary block" data-push="on">Activar en este dispositivo</button></div>` : ''}
    ${st === 'on' ? `<div class="list-row"><button type="button" class="btn grow" data-push="test">Enviar aviso de prueba</button>
      <button type="button" class="btn" data-push="off">Desactivar aquí</button></div>` : ''}`;
  box.querySelectorAll('[data-push]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (b.dataset.push === 'on') {
        const r = await enablePush();
        toast(r === 'granted' ? 'Avisos activados' : 'No se ha dado permiso para las notificaciones');
      } else if (b.dataset.push === 'off') {
        await disablePush();
        toast('Avisos desactivados en este dispositivo');
      } else {
        const r = await testPush();
        const ok = r.results.filter((x) => x.status >= 200 && x.status < 300).length;
        if (!r.sent) toast('No hay dispositivos con avisos activados.');
        else if (ok === r.sent) toast(`Enviado a ${ok === 1 ? '1 dispositivo' : `${ok} dispositivos`}. Debería llegar en unos segundos.`);
        else toast(`Respuesta del servicio: ${r.results.map((x) => `${x.service} ${x.status || 'sin conexión'}`).join(', ')}`);
      }
    } catch (err) {
      toast(err?.code ? errorText(err) : `No se pudo: ${err?.message || err}`);
    }
    renderPush(main);
  }));
}

function changePassword() {
  const s = openSheet({
    title: 'Cambiar contraseña',
    render(el) {
      el.innerHTML = `<form id="pwf">
        <input type="text" class="hidden" autocomplete="username" value="${esc(S.state.user.username)}" aria-hidden="true" tabindex="-1">
        <div class="field"><label for="pw-cur">Contraseña actual</label><input id="pw-cur" class="input" type="password" autocomplete="current-password" required maxlength="128" autofocus></div>
        <div class="field"><label for="pw-new">Contraseña nueva</label><input id="pw-new" class="input" type="password" autocomplete="new-password" required minlength="8" maxlength="128">
          <span class="hint">Mínimo 8 caracteres. Se cerrará la sesión en tus otros dispositivos.</span></div>
        <p class="error-text" id="pw-err"></p>
        <button type="submit" class="btn primary block">Cambiar</button></form>`;
      el.querySelector('#pwf').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await post('/api/me/password', { current: el.querySelector('#pw-cur').value, password: el.querySelector('#pw-new').value });
          await S.setNewToken(r.token);
          s.close();
          toast('Contraseña cambiada');
        } catch (err) { el.querySelector('#pw-err').textContent = errorText(err); }
      });
    },
  });
}

async function exportData() {
  try {
    const res = await fetch('/api/export', { headers: { Authorization: `Bearer ${getToken()}` }, cache: 'no-store' });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tackboard-${S.state.user.username}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch { toast('No se pudo descargar. Comprueba la conexión con el servidor.'); }
}

async function deleteAccount() {
  const owned = S.boards().filter((b) => S.roleOf(b.id) === 'owner');
  const shared = owned.filter((b) => (S.state.boardInfo.get(b.id)?.members || 1) > 1);
  const pw = await confirmDialog({
    title: 'Eliminar mi cuenta',
    text: `Se borrarán tu cuenta y tus ${owned.length} tableros con todo su contenido${shared.length ? `, también para las personas con quien los compartes (${shared.map((b) => `«${esc(b.data.name)}»`).join(', ')})` : ''}.
      Saldrás de los tableros de otras personas; las tarjetas que creaste en ellos se quedan en esos tableros. No se puede deshacer.`,
    ok: 'Eliminar para siempre', danger: true,
    input: { label: 'Escribe tu contraseña para confirmar', type: 'password', autocomplete: 'current-password' },
  });
  if (!pw) return;
  try {
    await post('/api/me/delete', { password: pw });
    await S.signOutLocal();
    toast('Cuenta eliminada');
    location.hash = '#/';
  } catch (err) { toast(errorText(err)); }
}

async function logout() {
  // Este dispositivo deja de recibir avisos de esta cuenta.
  try { await disablePush(); } catch { /* sin conexión o sin avisos */ }
  const pending = S.state.pending;
  if (pending) {
    await S.sync();
  }
  if (S.state.pending && !(await confirmDialog({ title: 'Cambios sin enviar', text: `Hay ${S.state.pending} cambios que no han llegado al servidor y se perderán.`, ok: 'Cerrar sesión igualmente', danger: true }))) return;
  try { await post('/api/auth/logout'); } catch { /* sin conexión: se cierra igualmente en este dispositivo */ }
  await S.signOutLocal();
  location.hash = '#/';
}

export { get };
