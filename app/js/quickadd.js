// Alta rápida: «Pagar el IBI viernes 18:00 #casa !alta @lucia cada mes» → título, fecha, hora, tablero,
// prioridad, responsable y repetición. Lo que no se reconoce se queda en el título.
import { todayStr, addDays, parseDate, dateStr, dueLabel, esc } from './util.js';

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const DAYS = { domingo: 0, dom: 0, lunes: 1, lun: 1, martes: 2, mar: 2, miercoles: 3, mie: 3, jueves: 4, jue: 4, viernes: 5, vie: 5, sabado: 6, sab: 6 };
const MONTHS = { enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6, julio: 7, jul: 7,
  agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sep: 9, sept: 9, octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12 };
const PRIO = { alta: 'high', urgente: 'high', media: 'medium', normal: 'medium', baja: 'low' };
const REPEAT = { dia: 'day', 'día': 'day', semana: 'week', mes: 'month', ano: 'year', 'año': 'year' };

const pad = (n) => String(n).padStart(2, '0');
const validDate = (y, m, d) => { const x = new Date(y, m - 1, d); return x.getMonth() === m - 1 && x.getDate() === d ? dateStr(x) : null; };

/** Próxima fecha (sin contar hoy) que cae en ese día de la semana. */
function nextWeekday(today, dow) {
  const t = parseDate(today);
  const diff = ((dow - t.getDay() + 7) % 7) || 7;
  return addDays(today, diff);
}

/**
 * @param {string} text
 * @param {{boards?: {id: string, name: string}[], people?: {username: string, name: string}[], today?: string}} ctx
 */
export function parseQuick(text, ctx = {}) {
  const today = ctx.today || todayStr();
  const out = { title: '', due: '', dueTime: '', priority: '', boardId: null, assignees: [], repeat: null, found: [] };
  let words = text.trim().split(/\s+/).filter(Boolean);
  const used = new Array(words.length).fill(false);
  const f = words.map(fold);
  const take = (i, n, label) => { for (let k = i; k < i + n; k++) used[k] = true; out.found.push(label); };

  for (let i = 0; i < words.length; i++) {
    if (used[i]) continue;
    const w = f[i];
    const raw = words[i];
    // #tablero (por el principio del nombre, sin espacios ni tildes)
    if (raw.startsWith('#') && raw.length > 1 && ctx.boards) {
      const key = fold(raw.slice(1)).replace(/[^a-z0-9]/g, '');
      const b = ctx.boards.find((x) => fold(x.name).replace(/[^a-z0-9]/g, '') === key)
        || ctx.boards.find((x) => fold(x.name).replace(/[^a-z0-9]/g, '').startsWith(key));
      if (b) { out.boardId = b.id; take(i, 1, `Tablero: ${b.name}`); continue; }
    }
    // @persona
    if (raw.startsWith('@') && raw.length > 1 && ctx.people) {
      const key = fold(raw.slice(1));
      const p = ctx.people.find((x) => x.username === key) || ctx.people.find((x) => fold(x.name).split(/\s+/)[0] === key);
      if (p) { if (!out.assignees.includes(p.username)) out.assignees.push(p.username); take(i, 1, `Para: ${p.name || p.username}`); continue; }
    }
    // !alta, !!, !!!
    if (raw.startsWith('!')) {
      const k = w.slice(1);
      const pr = PRIO[k] || (/^!+$/.test(raw) ? (raw.length >= 3 ? 'high' : raw.length === 2 ? 'medium' : 'low') : null);
      if (pr) { out.priority = pr; take(i, 1, `Prioridad: ${{ high: 'alta', medium: 'media', low: 'baja' }[pr]}`); continue; }
    }
    // cada día / cada semana / cada mes / cada año / cada 2 semanas / cada lunes / días laborables
    if (w === 'cada' && i + 1 < words.length) {
      let n = 1, j = i + 1;
      if (/^\d{1,2}$/.test(f[j]) && j + 1 < words.length) { n = +f[j]; j++; }
      const unit = REPEAT[f[j]] || REPEAT[f[j].replace(/s$/, '')] || REPEAT[f[j].replace(/es$/, '')];
      if (unit && n >= 1 && n <= 99) { out.repeat = { freq: unit, every: n, days: [], day: null }; take(i, j - i + 1, 'Se repite'); continue; }
      if (DAYS[f[j]] !== undefined) {
        out.repeat = { freq: 'week', every: 1, days: [DAYS[f[j]]], day: null };
        if (!out.due) out.due = nextWeekday(today, DAYS[f[j]]);
        take(i, j - i + 1, 'Se repite'); continue;
      }
    }
    if ((w === 'laborables' && f[i - 1] === 'dias') || w === 'laborables') {
      out.repeat = { freq: 'weekday', every: 1, days: [], day: null };
      if (f[i - 1] === 'dias' && !used[i - 1]) used[i - 1] = true;
      take(i, 1, 'Días laborables'); continue;
    }
    // Fechas
    if (!out.due) {
      if (w === 'hoy') { out.due = today; take(i, 1, 'Hoy'); continue; }
      if (w === 'manana' && !(f[i - 1] === 'pasado')) { out.due = addDays(today, 1); take(i, 1, 'Mañana'); continue; }
      if (w === 'pasado' && f[i + 1] === 'manana') { out.due = addDays(today, 2); take(i, 2, 'Pasado mañana'); continue; }
      const day = DAYS[w] ?? (w === 'el' && DAYS[f[i + 1]] !== undefined ? 'el' : undefined);
      if (day === 'el') { out.due = nextWeekday(today, DAYS[f[i + 1]]); take(i, 2, 'Fecha'); continue; }
      if (day !== undefined && (raw.length > 3 || /^(lun|mar|mie|jue|vie|sab|dom)$/.test(w))) {
        // «mar» solo cuenta como martes si va solo (no en medio de una frase como «mar Mediterráneo»: se evita con 3+ letras completas)
        if (w.length >= 5 || ['lun', 'mie', 'jue', 'vie', 'sab', 'dom'].includes(w)) { out.due = nextWeekday(today, day); take(i, 1, 'Fecha'); continue; }
      }
      let m = w.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
      if (m) {
        const t = parseDate(today);
        let y = m[3] ? +m[3] : t.getFullYear();
        if (y < 100) y += 2000;
        let dt = validDate(y, +m[2], +m[1]);
        if (dt && !m[3] && dt < today) dt = validDate(y + 1, +m[2], +m[1]);
        if (dt) { out.due = dt; take(i, 1, 'Fecha'); continue; }
      }
      // «12 de octubre», «12 oct»
      if (/^\d{1,2}$/.test(w)) {
        let j = i + 1;
        if (f[j] === 'de') j++;
        const mo = MONTHS[f[j]];
        if (mo) {
          const t = parseDate(today);
          let dt = validDate(t.getFullYear(), mo, +w);
          if (dt && dt < today) dt = validDate(t.getFullYear() + 1, mo, +w);
          if (dt) { out.due = dt; take(i, j - i + 1, 'Fecha'); continue; }
        }
      }
      m = w.match(/^en$/) && /^\d{1,3}$/.test(f[i + 1] || '') && /^dias?$/.test(f[i + 2] || '');
      if (m) { out.due = addDays(today, +f[i + 1]); take(i, 3, 'Fecha'); continue; }
    }
    // Horas: 18:00, 9.30, 18h, «a las 18»
    if (!out.dueTime) {
      let hm = w.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)h?$/) || w.match(/^([01]?\d|2[0-3])h$/);
      let n = 1, start = i;
      if (!hm && w === 'a' && f[i + 1] === 'las' && /^([01]?\d|2[0-3])([:.][0-5]\d)?$/.test(f[i + 2] || '')) {
        hm = f[i + 2].match(/^([01]?\d|2[0-3])(?:[:.]([0-5]\d))?$/); n = 3;
      }
      if (hm) { out.dueTime = `${pad(+hm[1])}:${pad(+(hm[2] || 0))}`; take(start, n, 'Hora'); continue; }
    }
  }
  out.title = words.filter((_, i) => !used[i]).join(' ').trim();
  // Una hora sin fecha es para hoy (o mañana si ya ha pasado).
  if (out.dueTime && !out.due) {
    const now = new Date();
    const [h, mi] = out.dueTime.split(':').map(Number);
    out.due = h * 60 + mi > now.getHours() * 60 + now.getMinutes() ? today : addDays(today, 1);
  }
  if (out.repeat && !out.due) out.due = today;
  if (out.repeat?.freq === 'week' && !out.repeat.days.length) out.repeat.days = [parseDate(out.due).getDay()];
  if (out.repeat && ['month', 'year'].includes(out.repeat.freq)) out.repeat.day = parseDate(out.due).getDate();
  if (!out.title) { out.title = text.trim(); out.found = []; Object.assign(out, { due: '', dueTime: '', priority: '', boardId: null, assignees: [], repeat: null }); }
  return out;
}

/** Lo reconocido, como etiquetas bajo el campo. */
export function quickChips(q) {
  if (!q.found.length) return '';
  const when = q.due ? dueLabel(q.due, q.dueTime) : '';
  const parts = [...(when ? [when] : []), ...q.found.filter((x) => !['Fecha', 'Hoy', 'Mañana', 'Pasado mañana', 'Hora'].includes(x))];
  return parts.map((t) => `<span class="chip accent small-chip">${esc(t)}</span>`).join('');
}
