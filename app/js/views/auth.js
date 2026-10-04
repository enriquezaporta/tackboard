// Entrar, crear cuenta, recuperar la contraseña y aceptar la política.
import * as S from '../store.js';
import { get, post, errorText } from '../api.js';
import { esc } from '../util.js';
import { openSheet } from '../ui.js';

let mode = 'login';
let signupOpen = true;

export function renderAuth(main) {
  main.innerHTML = `<div class="auth">
    <div class="brand"><img src="icons/icon-192.png" alt=""><div><h1>Tackboard</h1><p>Tableros, calendario y tareas compartidas.</p></div></div>
    <div class="seg" role="tablist">
      <button type="button" role="tab" data-mode="login" aria-pressed="${mode === 'login'}" aria-selected="${mode === 'login'}">Entrar</button>
      <button type="button" role="tab" data-mode="register" aria-pressed="${mode === 'register'}" aria-selected="${mode === 'register'}">Crear cuenta</button>
    </div>
    ${S.state.expiredUser && mode === 'login' ? `<p class="callout warn">Tu sesión ha caducado. Entra de nuevo como <b>@${esc(S.state.expiredUser)}</b>
      para enviar los cambios que quedaron pendientes${S.state.pending ? ` (${S.state.pending})` : ''}.</p>` : ''}
    <form id="auth-form" novalidate>
      ${mode === 'recover' ? '<p class="muted">Escribe tu usuario, el código de recuperación que guardaste al crear la cuenta y una contraseña nueva.</p>' : ''}
      ${mode === 'register' ? `<div class="field"><label for="a-name">Tu nombre</label><input id="a-name" class="input" maxlength="60" autocomplete="name"></div>` : ''}
      <div class="field"><label for="a-user">Usuario</label>
        <input id="a-user" class="input" required maxlength="30" autocomplete="username" autocapitalize="none" spellcheck="false" inputmode="email">
        ${mode === 'register' ? '<span class="hint">De 3 a 30 caracteres: minúsculas, números y . _ - · Es lo que verán quienes te inviten.</span>' : ''}</div>
      ${mode === 'recover' ? `<div class="field"><label for="a-code">Código de recuperación</label>
        <input id="a-code" class="input mono" required maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX"></div>` : ''}
      <div class="field"><label for="a-pw">${mode === 'recover' ? 'Contraseña nueva' : 'Contraseña'}</label>
        <input id="a-pw" class="input" type="password" required maxlength="128" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
        ${mode !== 'login' ? '<span class="hint">Mínimo 8 caracteres.</span>' : ''}</div>
      ${mode === 'register' ? `<label class="consent"><input id="a-consent" type="checkbox">
        <span>Tengo 14 años o más y acepto la <a href="privacy.html" target="_blank">política de privacidad</a> y las <a href="terms.html" target="_blank">condiciones de uso</a>.</span></label>` : ''}
      ${mode === 'register' && !signupOpen ? '<p class="callout warn">El registro está cerrado en esta instalación. Pide una cuenta al administrador.</p>' : ''}
      <p class="error-text" id="a-err" role="alert"></p>
      <button type="submit" class="btn primary block">${mode === 'login' ? 'Entrar' : mode === 'register' ? 'Crear cuenta' : 'Cambiar contraseña'}</button>
    </form>
    <p class="small">${mode === 'recover' ? '<a href="#" data-mode="login">Volver a entrar</a>' : '<a href="#" data-mode="recover">He olvidado mi contraseña</a>'}</p>
    <p class="small muted"><a href="privacy.html">Privacidad</a> · <a href="terms.html">Condiciones</a></p>
  </div>`;

  if (S.state.expiredUser && mode === 'login') main.querySelector('#a-user').value = S.state.expiredUser;
  main.onclick = (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { e.preventDefault(); mode = m.dataset.mode; renderAuth(main); main.querySelector('#a-user')?.focus(); }
  };
  main.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = main.querySelector('#a-err');
    const btn = e.target.querySelector('button[type="submit"]');
    err.textContent = '';
    const username = main.querySelector('#a-user').value.trim().toLowerCase();
    const password = main.querySelector('#a-pw').value;
    if (!username || !password) { err.textContent = 'Rellena el usuario y la contraseña.'; return; }
    btn.disabled = true;
    try {
      if (mode === 'login') {
        const r = await post('/api/auth/login', { username, password });
        await S.signedIn(r.token, r.user);
      } else if (mode === 'register') {
        if (!main.querySelector('#a-consent').checked) throw { code: 'consent' };
        const r = await post('/api/auth/register', { username, password, name: main.querySelector('#a-name').value.trim(), consent: true });
        await S.signedIn(r.token, r.user);
        showRecoveryCode(r.recoveryCode, true);
      } else {
        const r = await post('/api/auth/recover', { username, password, code: main.querySelector('#a-code').value });
        await S.signedIn(r.token, r.user);
        showRecoveryCode(r.recoveryCode);
      }
      mode = 'login';
      location.hash = '#/';
      S.sync();
      S.loadNotifyPrefs();
    } catch (ex) {
      err.textContent = errorText(ex);
    } finally { btn.disabled = false; }
  });
  get('/api/health').then((h) => { if (signupOpen !== h.signup) { signupOpen = h.signup; if (mode === 'register') renderAuth(main); } }).catch(() => {});
}

/** Muestra el código de recuperación una única vez. */
export function showRecoveryCode(code, welcome = false) {
  const s = openSheet({
    title: welcome ? 'Bienvenido a Tackboard' : 'Código de recuperación',
    render(el) {
      el.innerHTML = `<p>Guarda este código en un sitio seguro (por ejemplo, tu gestor de contraseñas).
        Es la única forma de recuperar la cuenta si olvidas la contraseña: no pedimos correo electrónico.</p>
        <div class="code-box" id="rc">${esc(code)}</div>
        <div class="sep"></div>
        <div class="row"><button type="button" class="btn grow" id="rc-copy">Copiar</button></div>
        <div class="sep"></div>
        <label class="consent"><input type="checkbox" id="rc-ok"><span>Lo he guardado. No se volverá a mostrar.</span></label>
        <button type="button" class="btn primary block" id="rc-done" disabled>Continuar</button>`;
      el.querySelector('#rc-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code); el.querySelector('#rc-copy').textContent = 'Copiado'; } catch { /* sin portapapeles */ }
      });
      el.querySelector('#rc-ok').addEventListener('change', (e) => { el.querySelector('#rc-done').disabled = !e.target.checked; });
      el.querySelector('#rc-done').addEventListener('click', () => s.close());
    },
  });
}

/** La política ha cambiado (o la cuenta la creó el administrador): hay que aceptarla para seguir sincronizando. */
export function askConsent() {
  const s = openSheet({
    title: 'Política de privacidad',
    render(el) {
      el.innerHTML = `<p>Para seguir sincronizando tus tableros necesitas aceptar la <a href="privacy.html" target="_blank">política de privacidad</a>
        y las <a href="terms.html" target="_blank">condiciones de uso</a> actuales.</p>
        <label class="consent"><input type="checkbox" id="cs-ok"><span>Tengo 14 años o más y las acepto.</span></label>
        <p class="error-text" id="cs-err"></p>
        <button type="button" class="btn primary block" id="cs-go" disabled>Aceptar y continuar</button>`;
      el.querySelector('#cs-ok').addEventListener('change', (e) => { el.querySelector('#cs-go').disabled = !e.target.checked; });
      el.querySelector('#cs-go').addEventListener('click', async () => {
        try {
          const r = await post('/api/me', { consent: true });
          await S.setUser(r.user);
          s.close();
          S.sync();
        } catch (e) { el.querySelector('#cs-err').textContent = errorText(e); }
      });
    },
  });
}
