// Adjuntos de las tarjetas: fotos (se reducen y pierden los metadatos, como la ubicación) y PDF.
import * as S from './store.js';
import { upload, download, del, errorText } from './api.js';
import { esc, icon, toast } from './util.js';
import { confirmDialog } from './ui.js';

export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_PER_CARD = 20;
const MAX_SIDE = 2048;

export const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Foto: se dibuja de nuevo como JPEG de 2048 px como mucho. Así pesa menos y no lleva EXIF (GPS, cámara…). */
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) throw new Error('encode');
    const base = (file.name || 'foto').replace(/\.[^.]+$/, '').slice(0, 100) || 'foto';
    return { blob, name: `${base}.jpg`, mime: 'image/jpeg', w, h };
  } finally { URL.revokeObjectURL(url); }
}

async function prepare(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_FILE) throw Object.assign(new Error(), { code: 'too_big' });
    return { blob: file.type ? file : new Blob([file], { type: 'application/pdf' }), name: file.name.slice(0, 120), mime: 'application/pdf' };
  }
  if (file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(file.name)) return prepareImage(file);
  throw Object.assign(new Error(), { code: 'file_type' });
}

/** Sube los archivos elegidos y los añade a la tarjeta. */
export async function addFiles(cardId, fileList) {
  const files = [...fileList];
  if (!navigator.onLine) { toast('Los adjuntos necesitan conexión con el servidor.'); return; }
  // La tarjeta tiene que existir en el servidor antes de subir nada.
  if (S.state.pending) await S.sync().catch(() => {});
  let added = 0;
  for (const file of files) {
    const cur = S.record(cardId);
    if (!cur) return;
    if ((cur.data.attachments || []).length >= MAX_PER_CARD) { toast(`Máximo ${MAX_PER_CARD} adjuntos por tarjeta.`); break; }
    try {
      toast(`Subiendo ${file.name || 'archivo'}…`);
      const p = await prepare(file);
      if (p.blob.size > MAX_FILE) throw Object.assign(new Error(), { code: 'too_big' });
      const r = await upload(`/api/files?card=${encodeURIComponent(cardId)}&name=${encodeURIComponent(p.name)}`, p.blob);
      cache.set(r.id, URL.createObjectURL(p.blob));
      const now = S.record(cardId);
      await S.save('card', now.id, now.boardId, { ...now.data, attachments: [...(now.data.attachments || []), { id: r.id, name: r.name, mime: r.mime, size: r.size, w: p.w ?? null, h: p.h ?? null }] });
      added++;
    } catch (e) {
      toast(e.code === 'too_big' || e.code === 'file_type' ? errorText(e) : `No se ha podido subir ${file.name || 'el archivo'}: ${errorText(e)}`);
    }
  }
  if (added) toast(added === 1 ? 'Adjunto añadido' : `${added} adjuntos añadidos`);
}

// Archivos ya descargados en esta sesión (como direcciones blob:, que la CSP permite).
const cache = new Map();
const loading = new Map();
export function blobUrl(id) {
  if (cache.has(id)) return Promise.resolve(cache.get(id));
  if (!loading.has(id)) {
    loading.set(id, download(`/api/files/${encodeURIComponent(id)}`).then((b) => {
      const u = URL.createObjectURL(b);
      cache.set(id, u);
      return u;
    }).finally(() => loading.delete(id)));
  }
  return loading.get(id);
}

/** Rellena las miniaturas de un contenedor. */
export function fillThumbs(root) {
  root.querySelectorAll('img[data-att]').forEach((img) => {
    blobUrl(img.dataset.att).then((u) => { img.src = u; img.closest('.att')?.classList.remove('loading'); })
      .catch(() => { img.closest('.att')?.classList.add('broken'); });
  });
}

export function attachmentsHtml(card, canWrite) {
  const list = card.data.attachments || [];
  return `<div class="atts">${list.map((a) => a.mime.startsWith('image/')
    ? `<button type="button" class="att loading" data-att-open="${esc(a.id)}" aria-label="Ver ${esc(a.name)}"><img data-att="${esc(a.id)}" alt=""></button>`
    : `<button type="button" class="att file" data-att-open="${esc(a.id)}">${icon('text')}<span class="att-name">${esc(a.name)}</span><span class="att-size">${sizeText(a.size)}</span></button>`).join('')}
    ${canWrite ? `<label class="att add" for="att-input">${icon('plus')}<span>Añadir</span></label>
      <input id="att-input" class="sr" type="file" accept="image/*,application/pdf" multiple>` : ''}</div>
    ${!list.length && !canWrite ? '<p class="muted small">Sin adjuntos.</p>' : ''}`;
}

async function saveFile(a) {
  const u = await blobUrl(a.id);
  const link = document.createElement('a');
  link.href = u;
  // La extensión, siempre la del tipo real (que es el que comprobó el servidor).
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[a.mime] || '';
  link.download = a.name.replace(/\.[^.]*$/, '') + ext;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Ver una foto a pantalla completa o descargar un PDF. */
export async function openAttachment(cardId, attId) {
  const card = S.record(cardId);
  const a = card?.data.attachments?.find((x) => x.id === attId);
  if (!a) return;
  if (!a.mime.startsWith('image/')) {
    try { await saveFile(a); } catch (e) { toast(errorText(e)); }
    return;
  }
  const canWrite = S.can(card.boardId, 'write');
  const v = document.createElement('div');
  v.className = 'viewer';
  v.setAttribute('role', 'dialog');
  v.setAttribute('aria-modal', 'true');
  v.setAttribute('aria-label', a.name);
  v.innerHTML = `<div class="viewer-bar"><span class="grow viewer-name">${esc(a.name)}</span>
      <button type="button" class="btn sm" data-v="save">Descargar</button>
      ${canWrite ? '<button type="button" class="btn sm danger" data-v="del">Eliminar</button>' : ''}
      <button type="button" class="icon-btn plain" data-v="close" aria-label="Cerrar">${icon('close')}</button></div>
    <div class="viewer-img"><img alt="${esc(a.name)}"></div>`;
  document.body.append(v);
  const close = () => { v.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  v.querySelector('[data-v=close]').focus();
  blobUrl(a.id).then((u) => { v.querySelector('img').src = u; }).catch((e) => toast(errorText(e)));
  v.addEventListener('click', async (e) => {
    const what = e.target.closest('[data-v]')?.dataset.v;
    if (!what && e.target.closest('.viewer-img') && e.target.tagName !== 'IMG') { close(); return; }
    if (what === 'close') close();
    if (what === 'save') saveFile(a).catch((err) => toast(errorText(err)));
    if (what === 'del') {
      close();
      await removeAttachment(cardId, attId);
    }
  });
}

export async function removeAttachment(cardId, attId) {
  const card = S.record(cardId);
  const a = card?.data.attachments?.find((x) => x.id === attId);
  if (!a) return false;
  const ok = await confirmDialog({ title: 'Eliminar adjunto', text: `Se eliminará «${esc(a.name)}» para todos los miembros del tablero.`, ok: 'Eliminar', danger: true });
  // El diálogo sustituye a la hoja de la tarjeta: se vuelve a abrir.
  import('./sheets.js').then((m) => m.openCard(cardId));
  if (!ok) return false;
  const now = S.record(cardId);
  await S.save('card', now.id, now.boardId, { ...now.data, attachments: (now.data.attachments || []).filter((x) => x.id !== attId) });
  try { await del(`/api/files/${encodeURIComponent(attId)}`); } catch { /* sin conexión: el servidor lo borrará solo */ }
  toast('Adjunto eliminado');
  return true;
}
