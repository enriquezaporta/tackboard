// Estado de la app en memoria, guardado local y sincronización con el servidor.
import * as db from './db.js';
import { api, get, post, setToken, ApiError } from './api.js';
import { uid, dueAt, alertBase, todayStr } from './util.js';

const listeners = new Set();
export const state = {
  user: null,
  records: new Map(),   // id -> {id, kind, boardId, data, updatedAt, deleted, serverTs}
  roles: new Map(),     // boardId -> 'owner' | 'admin' | 'write' | 'read'
  boardInfo: new Map(), // boardId -> {members, owner}
  invitations: 0,
  pending: 0,
  sync: { status: 'idle', lastOk: null, error: null },
  settings: { theme: 'auto', lastBoard: null },
  notify: { prefs: null, available: true },
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let noticeFn = () => {};
/** Avisos para la persona (cambios rechazados por el servidor, etc.). */
export function onNotice(fn) { noticeFn = fn; }
let emitQueued = false;
export function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; for (const fn of listeners) fn(); });
}

// ---------- Consultas ----------
const live = (r) => r && !r.deleted;
const byPos = (a, b) => (a.data.pos - b.data.pos) || (a.id < b.id ? -1 : 1);

export const ROLE_RANK = { read: 0, write: 1, admin: 2, owner: 3 };
export const ROLE_NAME = { read: 'Lectura', write: 'Escritura', admin: 'Todo', owner: 'Anfitrión' };
export const roleOf = (boardId) => state.roles.get(boardId) || 'read';
export const can = (boardId, need) => ROLE_RANK[roleOf(boardId)] >= ROLE_RANK[need];

export function boards() {
  return [...state.records.values()].filter((r) => r.kind === 'board' && live(r) && state.roles.has(r.id)).sort(byPos);
}
export const board = (id) => { const r = state.records.get(id); return r && r.kind === 'board' && live(r) ? r : null; };
export function columns(boardId) {
  return [...state.records.values()].filter((r) => r.kind === 'column' && r.boardId === boardId && live(r)).sort(byPos);
}
export function cards(filter = () => true) {
  return [...state.records.values()].filter((r) => r.kind === 'card' && live(r) && state.roles.has(r.boardId) && filter(r));
}
export function columnCards(columnId, { archived = false } = {}) {
  return cards((c) => c.data.columnId === columnId && !!c.data.archived === archived).sort(byPos);
}
export const record = (id) => { const r = state.records.get(id); return live(r) ? r : null; };
export const doneColumn = (boardId) => columns(boardId).find((c) => c.data.isDone) || null;

/** Tarjetas con fecha, no archivadas, de tableros visibles. */
export function datedCards(boardId = null) {
  return cards((c) => c.data.due && !c.data.archived && (!boardId || c.boardId === boardId));
}

// ---------- Cambios locales ----------
function stamp(prev) {
  return Math.max(Date.now(), (prev?.updatedAt || 0) + 1);
}

/**
 * Fechas de una tarjeta coherentes antes de guardarla: instante de vencimiento, referencia de los avisos y,
 * la primera vez que recibe fecha, el recordatorio por defecto de esta persona.
 */
function normalize(kind, data) {
  if (kind !== 'card') return data;
  const d = { ...data };
  if (!d.due) {
    d.dueTime = ''; d.dueAt = null; d.alertBase = null;
  } else {
    d.dueAt = dueAt(d.due, d.dueTime);
    d.alertBase = alertBase(d.due, d.dueTime);
    if (!Array.isArray(d.reminders)) d.reminders = [...(state.notify.prefs?.defaultReminders || ['1h'])];
  }
  return d;
}

export async function save(kind, id, boardId, rawData) {
  const data = normalize(kind, rawData);
  const prev = state.records.get(id);
  const r = { id, kind, boardId, data, updatedAt: stamp(prev), deleted: false, serverTs: prev?.serverTs || 0 };
  state.records.set(id, r);
  await db.putRecords([r], { outbox: true });
  afterLocalChange();
  return r;
}

export async function saveMany(list) {
  const out = list.map(({ kind, id, boardId, data: rawData }) => {
    const data = normalize(kind, rawData);
    const prev = state.records.get(id);
    const r = { id, kind, boardId, data, updatedAt: stamp(prev), deleted: false, serverTs: prev?.serverTs || 0 };
    state.records.set(id, r);
    return r;
  });
  await db.putRecords(out, { outbox: true });
  afterLocalChange();
  return out;
}

export async function remove(ids) {
  const out = [];
  for (const id of ids) {
    const prev = state.records.get(id);
    if (!prev) continue;
    const r = { ...prev, data: null, deleted: true, updatedAt: stamp(prev) };
    state.records.set(id, r);
    out.push(r);
  }
  await db.putRecords(out, { outbox: true });
  afterLocalChange();
}

function afterLocalChange() {
  emit();
  db.getAll('outbox').then((o) => { state.pending = o.length; emit(); });
  scheduleSync(1500);
}

// ---------- Acciones de alto nivel ----------
export async function createBoard(name, color) {
  const id = uid();
  const pos = (boards().at(-1)?.data.pos || 0) + 1024;
  state.roles.set(id, 'owner');
  state.boardInfo.set(id, { members: 1, owner: state.user?.username });
  const cols = [
    { name: 'Por hacer', isDone: false, wip: null },
    { name: 'En curso', isDone: false, wip: 3 },
    { name: 'Hecho', isDone: true, wip: null },
  ];
  await saveMany([
    { kind: 'board', id, boardId: id, data: { name, color, labels: [], pos } },
    ...cols.map((c, i) => ({ kind: 'column', id: uid(), boardId: id, data: { ...c, pos: (i + 1) * 1024 } })),
  ]);
  return id;
}

/** Posición para insertar en una lista ordenada de tarjetas (sin contar la que se mueve). */
export function posAt(list, index) {
  const before = list[index - 1]?.data.pos;
  const after = list[index]?.data.pos;
  if (before === undefined && after === undefined) return 1024;
  if (before === undefined) return after - 1024;
  if (after === undefined) return before + 1024;
  return (before + after) / 2;
}

/** Mueve una tarjeta a otra columna/posición. Si cae en una columna "hecho", se marca como completada. */
export async function moveCard(cardId, columnId, index) {
  const card = record(cardId);
  const col = record(columnId);
  if (!card || !col || col.boardId !== card.boardId) return;
  const list = columnCards(columnId).filter((c) => c.id !== cardId);
  let pos = posAt(list, index);
  const neighbours = [list[index - 1]?.data.pos, list[index]?.data.pos].filter((v) => v !== undefined);
  if (neighbours.length === 2 && Math.abs(neighbours[1] - neighbours[0]) < 1e-6) {
    // Sin hueco entre vecinas: se renumera la columna.
    list.splice(index, 0, card);
    await saveMany(list.map((c, i) => ({ kind: 'card', id: c.id, boardId: c.boardId,
      data: c.id === cardId ? withDone({ ...c.data, columnId, pos: (i + 1) * 1024 }, col) : { ...c.data, pos: (i + 1) * 1024 } })));
    return;
  }
  await save('card', cardId, card.boardId, withDone({ ...card.data, columnId, pos }, col));
}

function withDone(data, col) {
  const done = !!col.data.isDone;
  if (done && !data.done) return { ...data, done: true, doneAt: Date.now() };
  if (!done && data.done) return { ...data, done: false, doneAt: null };
  return data;
}

/** Completa o reabre una tarjeta desde Hoy o el calendario. */
export async function toggleDone(cardId) {
  const card = record(cardId);
  if (!card) return;
  const cols = columns(card.boardId);
  if (!card.data.done) {
    const dc = cols.find((c) => c.data.isDone);
    if (dc) return moveCard(cardId, dc.id, 0);
    return save('card', cardId, card.boardId, { ...card.data, done: true, doneAt: Date.now() });
  }
  const first = cols.find((c) => !c.data.isDone);
  if (first && cols.find((c) => c.id === card.data.columnId)?.data.isDone) return moveCard(cardId, first.id, 0);
  return save('card', cardId, card.boardId, { ...card.data, done: false, doneAt: null });
}

export async function createCard(boardId, columnId, fields, index = null) {
  const list = columnCards(columnId);
  const col = record(columnId);
  const pos = index === null ? posAt(list, list.length) : posAt(list, index);
  const data = {
    columnId, title: fields.title, description: fields.description || '', start: '',
    due: fields.due || '', dueTime: fields.dueTime || '',
    priority: '', labels: [], checklist: [], pos, done: !!col?.data.isDone, doneAt: col?.data.isDone ? Date.now() : null, archived: false,
  };
  const id = uid();
  await save('card', id, boardId, data);
  return id;
}

export async function setDue(cardId, due) {
  const card = record(cardId);
  if (!card) return;
  await save('card', cardId, card.boardId, { ...card.data, due, dueTime: due ? card.data.dueTime : '', dueAt: dueAt(due, card.data.dueTime) });
}

// ---------- Preferencias de avisos ----------
export async function loadNotifyPrefs() {
  try {
    const r = await get('/api/push/prefs');
    state.notify = r;
    await db.setMeta('notify', r);
    // La zona horaria del dispositivo, para el horario de silencio y el resumen diario (solo si aún no hay una;
    // después se cambia a mano en Ajustes, para que dos dispositivos en zonas distintas no se la pisen).
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && r.prefs.tz === 'UTC' && tz !== 'UTC') await setNotifyPrefs({ tz });
    // Si este dispositivo ya tenía los avisos activados, se vuelve a asociar a la sesión actual.
    import('./push.js').then((m) => m.resubscribe()).catch(() => {});
    emit();
  } catch { /* sin conexión: se usan las guardadas */ }
}

export async function setNotifyPrefs(patch) {
  const r = await post('/api/push/prefs', patch);
  state.notify = r;
  await db.setMeta('notify', r);
  emit();
  return r;
}

// ---------- Carga y sesión ----------
export async function load() {
  const [records, outbox, user, roles, info, settings, cursor] = await Promise.all([
    db.getAll('records'), db.getAll('outbox'), db.getMeta('user'), db.getMeta('roles', []),
    db.getMeta('boardInfo', []), db.getMeta('settings', {}), db.getMeta('cursor', 0),
  ]);
  state.records = new Map(records.map((r) => [r.id, r]));
  state.roles = new Map(roles);
  state.boardInfo = new Map(info);
  state.pending = outbox.length;
  state.settings = { ...state.settings, ...settings };
  state.user = user;
  const token = await db.getMeta('token');
  state.expiredUser = await db.getMeta('expiredUser');
  state.notify = await db.getMeta('notify', state.notify);
  if (!token) state.user = null;
  setToken(token);
  syncCursor = cursor;
  return !!token;
}

export async function signedIn(token, user) {
  // Si la sesión había caducado y vuelve a entrar la misma persona, se conservan sus cambios sin enviar.
  const expired = await db.getMeta('expiredUser');
  if (expired && expired === user.username) {
    await db.delMeta('expiredUser');
  } else {
    await db.wipe();
    state.records.clear(); state.roles.clear(); state.boardInfo.clear(); state.pending = 0; syncCursor = 0;
    state.notify = { prefs: null, available: true };
  }
  setToken(token);
  state.user = user;
  await db.setMeta('token', token);
  await db.setMeta('user', user);
  await db.setMeta('settings', state.settings);
  emit();
}

export async function setUser(user) {
  state.user = user;
  await db.setMeta('user', user);
  emit();
}

export async function setNewToken(token) {
  setToken(token);
  await db.setMeta('token', token);
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await db.setMeta('settings', state.settings);
  emit();
}

/** El servidor ya no acepta la sesión: se pide entrar de nuevo sin perder lo pendiente de enviar. */
export async function sessionExpired() {
  if (!state.user) return;
  const username = state.user.username;
  setToken(null);
  // Se borran los tableros del dispositivo; solo se guardan los cambios aún no enviados, por si vuelve a
  // entrar la misma persona. Al entrar se descarga todo de nuevo.
  const outbox = await db.getAll('outbox');
  await db.wipe();
  await db.putOutbox(outbox);
  await db.setMeta('expiredUser', username);
  await db.setMeta('settings', state.settings);
  state.records.clear(); state.roles.clear(); state.boardInfo.clear(); syncCursor = 0;
  state.expiredUser = username;
  state.user = null;
  emit();
}

export async function signOutLocal() {
  setToken(null);
  await db.wipe();
  state.user = null; state.records.clear(); state.roles.clear(); state.boardInfo.clear();
  state.pending = 0; state.invitations = 0; syncCursor = 0;
  state.notify = { prefs: null, available: true };
  emit();
}

// ---------- Sincronización ----------
let syncCursor = 0;
let syncing = null;
let syncTimer = null;

export function scheduleSync(ms = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { sync().catch(() => {}); }, ms);
}

export function sync() {
  // Si ya hay una en curso, se encadena otra para que lo cambiado mientras tanto también se envíe.
  if (syncing) return syncing.then(() => sync());
  syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  if (!state.user) return;
  state.sync.status = 'syncing';
  emit();
  try {
    let more = true;
    let rounds = 0;
    while (more && rounds++ < 50) {
      const outbox = await db.getAll('outbox');
      // Lotes de hasta 500 cambios y unos 3 MB, por debajo del límite del servidor.
      const sent = [];
      let bytes = 0;
      for (const o of outbox) {
        const n = JSON.stringify(o).length * 2;
        if (sent.length && (sent.length >= 500 || bytes + n > 3_000_000)) break;
        sent.push(o); bytes += n;
      }
      const res = await post('/api/sync', { since: syncCursor, changes: sent });
      await applyServer(res, sent);
      more = res.more || outbox.length > sent.length;
    }
    state.sync = { status: 'ok', lastOk: Date.now(), error: null };
  } catch (e) {
    state.sync = { ...state.sync, status: e instanceof ApiError && e.status === 0 ? 'offline' : 'error', error: e };
  }
  state.pending = (await db.getAll('outbox')).length;
  emit();
}

async function applyServer(res, sent) {
  await db.clearSent(sent);
  const outbox = new Map((await db.getAll('outbox')).map((o) => [o.id, o]));
  const toPut = [];
  const toDelete = [];

  for (const r of res.changes) {
    if (outbox.has(r.id)) continue; // hay un cambio local más nuevo pendiente de enviar
    if (r.deleted) toDelete.push(r.id);
    else toPut.push({ id: r.id, kind: r.kind, boardId: r.boardId, data: r.data, updatedAt: r.updatedAt, deleted: false, serverTs: r.serverTs });
  }
  const reasons = { forbidden: 0, limit: 0, other: 0 };
  for (const rj of res.rejected) {
    if (rj.reason === 'forbidden') reasons.forbidden++;
    else if (rj.reason === 'limit' || rj.reason === 'too_big') reasons.limit++;
    else if (rj.reason !== 'stale') reasons.other++;
    // El servidor no aceptó el cambio: se vuelve a su versión (o se quita si no hay acceso).
    if (rj.current && !rj.current.deleted) {
      const c = rj.current;
      toPut.push({ id: c.id, kind: c.kind, boardId: c.boardId, data: c.data, updatedAt: c.updatedAt, deleted: false, serverTs: c.serverTs });
    } else toDelete.push(rj.id);
  }

  // Tableros a los que ya no se tiene acceso: se borran sus datos locales.
  const allowed = new Set(res.boards.map((b) => b.id));
  const pendingBoards = new Set([...outbox.values()].filter((o) => o.kind === 'board').map((o) => o.id));
  for (const r of state.records.values()) {
    if (!allowed.has(r.boardId) && !pendingBoards.has(r.boardId)) toDelete.push(r.id);
  }

  for (const r of toPut) state.records.set(r.id, r);
  for (const id of toDelete) state.records.delete(id);
  await db.putRecords(toPut);
  await db.deleteRecords(toDelete);

  const roles = new Map(res.boards.map((b) => [b.id, b.role]));
  for (const id of pendingBoards) if (!roles.has(id)) roles.set(id, 'owner');
  state.roles = roles;
  state.boardInfo = new Map(res.boards.map((b) => [b.id, { members: b.members, owner: b.owner }]));
  state.invitations = res.invitations;
  syncCursor = res.cursor;
  if (reasons.forbidden) noticeFn(`${reasons.forbidden === 1 ? 'Un cambio' : `${reasons.forbidden} cambios`} sin permiso se han deshecho.`);
  if (reasons.limit) noticeFn('El servidor no ha aceptado algunos cambios: se ha alcanzado un límite de tamaño o de cantidad.');
  if (reasons.other) noticeFn(`El servidor ha rechazado ${reasons.other === 1 ? 'un cambio' : `${reasons.other} cambios`} no válidos.`);
  await db.setMeta('roles', [...state.roles]);
  await db.setMeta('boardInfo', [...state.boardInfo]);
  await db.setMeta('cursor', syncCursor);
}

/** Vuelve a descargarlo todo (por ejemplo, tras aceptar una invitación). */
export async function fullResync() {
  syncCursor = 0;
  await db.setMeta('cursor', 0);
  return sync();
}

export const today = todayStr;
export { api };
