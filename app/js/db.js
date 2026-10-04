// Almacenamiento local en IndexedDB: registros, cambios pendientes de enviar y ajustes.

const NAME = 'tackboard';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const getAll = (store) => tx([store], 'readonly', (t) => t.objectStore(store).getAll());

export async function getMeta(key, def = null) {
  const r = await tx(['meta'], 'readonly', (t) => t.objectStore('meta').get(key));
  return r ? r.value : def;
}
export const setMeta = (key, value) => tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').put({ key, value }); });
export const delMeta = (key) => tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').delete(key); });

/** Guarda registros y, si se indica, los apunta como pendientes de enviar. */
export function putRecords(records, { outbox = false } = {}) {
  return tx(['records', 'outbox'], 'readwrite', (t) => {
    const rs = t.objectStore('records');
    const ob = t.objectStore('outbox');
    for (const r of records) {
      rs.put(r);
      if (outbox) ob.put({ id: r.id, kind: r.kind, boardId: r.boardId, updatedAt: r.updatedAt, deleted: !!r.deleted, data: r.deleted ? null : r.data });
    }
  });
}

export function deleteRecords(ids, { alsoOutbox = true } = {}) {
  return tx(['records', 'outbox'], 'readwrite', (t) => {
    for (const id of ids) {
      t.objectStore('records').delete(id);
      if (alsoOutbox) t.objectStore('outbox').delete(id);
    }
  });
}

/** Quita del buzón de salida lo ya enviado, salvo que haya cambiado mientras tanto. */
export function clearSent(sent) {
  return tx(['outbox'], 'readwrite', (t) => {
    const ob = t.objectStore('outbox');
    for (const s of sent) {
      const req = ob.get(s.id);
      req.onsuccess = () => {
        if (req.result && req.result.updatedAt === s.updatedAt) ob.delete(s.id);
      };
    }
  });
}

export function putOutbox(list) {
  return tx(['outbox'], 'readwrite', (t) => { for (const o of list) t.objectStore('outbox').put(o); });
}

/** Borra todo (al cerrar sesión). */
export function wipe() {
  return tx(['records', 'outbox', 'meta'], 'readwrite', (t) => {
    t.objectStore('records').clear();
    t.objectStore('outbox').clear();
    t.objectStore('meta').clear();
  });
}
