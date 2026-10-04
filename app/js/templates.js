// Plantillas de tablero: las incluidas en la app y las que guarda cada persona (en el servidor).
import * as S from './store.js';
import * as db from './db.js';
import { get, post, del } from './api.js';
import { uid, shortId, COLORS } from './util.js';

const L = (name, color) => ({ id: shortId(), name, color });
const C = (title, extra = {}) => ({ title, ...extra });
const check = (...items) => items.map((text) => ({ text }));

/** Plantillas incluidas. Las etiquetas se crean con identificadores nuevos cada vez. */
export function builtins() {
  const proj = [L('Error', COLORS[3]), L('Mejora', COLORS[1]), L('Urgente', COLORS[5])];
  const casa = [L('Compras', COLORS[2]), L('Reparaciones', COLORS[3]), L('Limpieza', COLORS[0]), L('Papeleo', COLORS[4])];
  const lab = [L('Red', COLORS[1]), L('Proxmox', COLORS[3]), L('Seguridad', COLORS[5]), L('Copias', COLORS[0]), L('Docs', COLORS[7])];
  const viaje = [L('Transporte', COLORS[1]), L('Alojamiento', COLORS[4]), L('Documentos', COLORS[3]), L('Maleta', COLORS[2])];
  const mud = [L('Trámites', COLORS[4]), L('Suministros', COLORS[1]), L('Cajas', COLORS[2]), L('Limpieza', COLORS[0])];
  return [
    { id: 'basic', name: 'Básico', desc: 'El Kanban de siempre, con un límite de 3 en curso.', color: COLORS[0], labels: [], cards: [],
      columns: [{ name: 'Por hacer' }, { name: 'En curso', wip: 3 }, { name: 'Hecho', isDone: true }] },
    { id: 'project', name: 'Proyecto', desc: 'Con columna de revisión y etiquetas de error y mejora.', color: COLORS[1], labels: proj, cards: [],
      columns: [{ name: 'Ideas' }, { name: 'Por hacer' }, { name: 'En curso', wip: 3 }, { name: 'En revisión', wip: 3 }, { name: 'Hecho', isDone: true }] },
    { id: 'home', name: 'Casa', desc: 'Lo de esta semana aparte, con etiquetas de compras, reparaciones…', color: COLORS[2], labels: casa, cards: [],
      columns: [{ name: 'Pendiente' }, { name: 'Esta semana', wip: 5 }, { name: 'Hecho', isDone: true }] },
    { id: 'homelab', name: 'Homelab', desc: 'Ideas, pruebas y tareas de mantenimiento.', color: COLORS[3], labels: lab,
      columns: [{ name: 'Ideas' }, { name: 'Por hacer' }, { name: 'En curso', wip: 2 }, { name: 'Probando' }, { name: 'Hecho', isDone: true }],
      cards: [
        C('Comprobar que las copias de seguridad se restauran', { col: 1, labels: [lab[3].id], checklist: check('Elegir una copia reciente', 'Restaurarla en un contenedor de prueba', 'Comprobar que arranca y tiene los datos') }),
        C('Actualizar los nodos', { col: 1, labels: [lab[1].id], checklist: check('Leer las notas de la versión', 'Actualizar un nodo y comprobarlo', 'Actualizar el resto') }),
        C('Documentar IPs y servicios', { col: 0, labels: [lab[4].id] }),
      ] },
    { id: 'trip', name: 'Viaje', desc: 'De la idea a la maleta.', color: COLORS[4], labels: viaje,
      columns: [{ name: 'Ideas' }, { name: 'Reservar' }, { name: 'Preparar' }, { name: 'Listo', isDone: true }],
      cards: [
        C('Transporte', { col: 1, labels: [viaje[0].id] }),
        C('Alojamiento', { col: 1, labels: [viaje[1].id] }),
        C('Documentación', { col: 2, labels: [viaje[2].id], checklist: check('DNI o pasaporte en vigor', 'Tarjeta sanitaria europea', 'Seguro de viaje', 'Reservas a mano') }),
        C('Maleta', { col: 2, labels: [viaje[3].id], checklist: check('Cargadores', 'Medicinas', 'Ropa', 'Neceser') }),
      ] },
    { id: 'move', name: 'Mudanza', desc: 'Trámites, suministros y cajas.', color: COLORS[6], labels: mud,
      columns: [{ name: 'Por hacer' }, { name: 'En curso', wip: 4 }, { name: 'Hecho', isDone: true }],
      cards: [
        C('Dar de alta luz, agua y gas', { col: 0, labels: [mud[1].id] }),
        C('Internet en la casa nueva', { col: 0, labels: [mud[1].id] }),
        C('Empadronarse', { col: 0, labels: [mud[0].id] }),
        C('Cambiar la dirección', { col: 0, labels: [mud[0].id], checklist: check('Banco', 'Seguros', 'Tráfico (DGT)', 'Trabajo') }),
        C('Cajas y material', { col: 0, labels: [mud[2].id], checklist: check('Cajas', 'Cinta', 'Rotulador', 'Plástico de burbujas') }),
        C('Limpieza del piso antiguo', { col: 0, labels: [mud[3].id] }),
      ] },
  ];
}

// ---------- Plantillas propias ----------
let mine = null;
export async function loadMine() {
  try {
    mine = (await get('/api/templates')).templates;
    await db.setMeta('templates', mine);
  } catch { mine = mine || await db.getMeta('templates', []); }
  return mine;
}
export const cachedMine = () => mine || [];

export async function saveMine(tpl) {
  mine = (await post('/api/templates', tpl)).templates;
  await db.setMeta('templates', mine);
  return mine;
}
export async function deleteMine(id) {
  mine = (await del(`/api/templates/${encodeURIComponent(id)}`)).templates;
  await db.setMeta('templates', mine);
  return mine;
}

/** Convierte un tablero en plantilla (sin fechas, personas ni tarjetas archivadas). */
export function boardToTemplate(boardId, name, withCards) {
  const b = S.board(boardId);
  const cols = S.columns(boardId);
  const idx = new Map(cols.map((c, i) => [c.id, i]));
  const labelIds = new Set((b.data.labels || []).map((l) => l.id));
  const cards = withCards ? cols.flatMap((c) => S.columnCards(c.id).filter((x) => !x.data.done).map((x) => ({
    col: idx.get(c.id), title: x.data.title, description: x.data.description || '', priority: x.data.priority || '',
    labels: (x.data.labels || []).filter((l) => labelIds.has(l)),
    checklist: (x.data.checklist || []).map((i) => ({ text: i.text })),
  }))).slice(0, 300) : [];
  return {
    name, color: b.data.color, labels: (b.data.labels || []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    columns: cols.map((c) => ({ name: c.data.name, wip: c.data.wip ?? null, isDone: !!c.data.isDone })), cards,
  };
}

/** Crea un tablero a partir de una plantilla. Devuelve su id. */
export async function createFromTemplate(tpl, name, color) {
  // Etiquetas con identificadores nuevos, para que dos tableros de la misma plantilla no compartan nada.
  const labelMap = new Map((tpl.labels || []).map((l) => [l.id, shortId()]));
  const id = uid();
  S.state.roles.set(id, 'owner');
  S.state.boardInfo.set(id, { members: 1, owner: S.state.user?.username });
  const colIds = tpl.columns.map(() => uid());
  const pos = (S.boards().at(-1)?.data.pos || 0) + 1024;
  const now = Date.now();
  const perCol = new Map();
  await S.saveMany([
    { kind: 'board', id, boardId: id, data: { name, color, pos, labels: (tpl.labels || []).map((l) => ({ id: labelMap.get(l.id), name: l.name, color: l.color })) } },
    ...tpl.columns.map((c, i) => ({ kind: 'column', id: colIds[i], boardId: id, data: { name: c.name, wip: c.wip ?? null, isDone: !!c.isDone, pos: (i + 1) * 1024 } })),
    ...(tpl.cards || []).map((c) => {
      const n = (perCol.get(c.col) || 0) + 1;
      perCol.set(c.col, n);
      const done = !!tpl.columns[c.col]?.isDone;
      return { kind: 'card', id: uid(), boardId: id, data: {
        columnId: colIds[c.col], title: c.title, description: c.description || '', start: '', due: '', dueTime: '',
        priority: c.priority || '', labels: (c.labels || []).map((l) => labelMap.get(l)).filter(Boolean),
        checklist: (c.checklist || []).map((x) => ({ id: shortId(), text: x.text, done: false })),
        pos: n * 1024, done, doneAt: done ? now : null, archived: false,
      } };
    }),
  ]);
  return id;
}
