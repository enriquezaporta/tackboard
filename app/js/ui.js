// Hojas (ventanas modales) y diálogos de confirmación.
import { icon, paint } from './util.js';

let current = null;

/**
 * Abre una hoja. `render(el)` rellena su contenido; se puede volver a llamar con sheet.refresh().
 * Devuelve un objeto con el elemento y close().
 */
export function openSheet({ title = '', label = '', render, onClose, wide = false }) {
  closeSheet(true);
  const root = document.getElementById('sheet-root');
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet' + (wide ? ' wide' : '');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  // El título llega ya escapado (HTML); para la etiqueta accesible se usa su texto.
  const tmp = document.createElement('template');
  tmp.innerHTML = title;
  sheet.setAttribute('aria-label', label || tmp.content.textContent || 'Detalle');
  back.append(sheet);
  root.append(back);
  const prevFocus = document.activeElement;

  const api = {
    el: sheet,
    refresh() {
      const scroll = sheet.scrollTop;
      const focusedId = document.activeElement?.id;
      sheet.innerHTML = `<div class="sheet-grip"></div>${title ? `<div class="sheet-head"><h2>${title}</h2>
        <button type="button" class="icon-btn plain" data-close aria-label="Cerrar">${icon('close')}</button></div>` : ''}<div class="sheet-body"></div>`;
      render(sheet.querySelector('.sheet-body'), api);
      paint(sheet);
      sheet.scrollTop = scroll;
      if (focusedId) document.getElementById(focusedId)?.focus();
    },
    close(silent = false) {
      if (current !== api) return;
      current = null;
      back.remove();
      document.removeEventListener('keydown', onKey);
      if (!silent) onClose?.();
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    },
  };
  const onKey = (e) => { if (e.key === 'Escape') api.close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-close]')) api.close();
  });
  current = api;
  api.refresh();
  requestAnimationFrame(() => {
    const f = sheet.querySelector('[autofocus]') || sheet.querySelector('[data-close]') || sheet;
    f.focus?.({ preventScroll: true });
  });
  return api;
}

export function closeSheet(silent = false) { current?.close(silent); }
export const sheetOpen = () => !!current;

/** Pregunta de sí/no. Devuelve una promesa con true/false. */
export function confirmDialog({ title, text, ok = 'Aceptar', danger = false, input = null }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = openSheet({
      title,
      render(el) {
        el.innerHTML = `<p class="muted">${text}</p>
          ${input ? `<div class="field"><label for="cf-in">${input.label}</label>
            <input id="cf-in" class="input" type="${input.type || 'text'}" autocomplete="${input.autocomplete || 'off'}" autofocus></div>` : ''}
          <div class="row"><button type="button" class="btn grow" data-close>Cancelar</button>
          <button type="button" class="btn grow ${danger ? 'danger' : 'primary'}" id="cf-ok">${ok}</button></div>`;
        el.querySelector('#cf-ok').addEventListener('click', () => {
          answered = true;
          const v = input ? el.querySelector('#cf-in').value : true;
          s.close(true);
          resolve(v);
        });
      },
      onClose() { if (!answered) resolve(false); },
    });
  });
}
