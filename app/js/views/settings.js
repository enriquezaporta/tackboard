// Ajustes: cuenta, sincronización, apariencia, privacidad y seguridad.
import * as S from '../store.js';
import { get, post, errorText, getToken } from '../api.js';
import { esc, icon, toast } from '../util.js';
import { confirmDialog, openSheet } from '../ui.js';
import { openInvitations } from '../sheets.js';
import { showRecoveryCode } from './auth.js';

export const APP_VERSION = '1.0.0';

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
  main.innerHTML = `
    <header class="page-head"><h1>Ajustes</h1></header>
    <div class="section today-wrap">
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
    </div>`;

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
      if (await confirmDialog({ title: 'Cerrar otras sesiones', text: 'Tendrás que volver a entrar en tus otros dispositivos.', ok: 'Cerrar sesiones' })) {
        try { await post('/api/auth/logout-others'); toast('Hecho'); } catch (err) { toast(errorText(err)); }
      }
    }
    if (act === 'export') exportData();
    if (act === 'delete') deleteAccount();
    if (act === 'logout') logout();
  };
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
