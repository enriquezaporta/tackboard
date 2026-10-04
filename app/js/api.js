// Llamadas al servidor.

let token = null;
let onAuthLost = () => {};
let onConsent = () => {};

export const setToken = (t) => { token = t; };
export const getToken = () => token;
export function onAuth(lost, consent) { onAuthLost = lost; onConsent = consent; }

export class ApiError extends Error {
  constructor(status, code) {
    super(code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

const MESSAGES = {
  login: 'Usuario o contraseña incorrectos.',
  recover: 'Usuario o código de recuperación incorrectos.',
  rate: 'Demasiados intentos. Espera unos minutos.',
  username: 'Usuario no válido: de 3 a 30 caracteres, en minúsculas, con números y . _ -',
  username_taken: 'Ese nombre de usuario ya existe.',
  password: 'La contraseña debe tener entre 8 y 128 caracteres.',
  consent: 'Tienes que aceptar la política de privacidad y las condiciones.',
  signup_closed: 'El registro está cerrado en esta instalación. Pide una cuenta al administrador.',
  wrong_password: 'La contraseña no es correcta.',
  user: 'No hay ningún usuario con ese nombre que acepte invitaciones.',
  already: 'Esa persona ya es miembro o tiene una invitación pendiente.',
  limit: 'Se ha alcanzado el límite permitido.',
  forbidden: 'No tienes permiso para hacer eso.',
  owner_cannot_leave: 'El anfitrión no puede salir del tablero: tiene que borrarlo.',
  invitation: 'Esa invitación ya no existe.',
  network: 'No se puede conectar con el servidor.',
  push_unavailable: 'El servidor no tiene activados los avisos (falta python3-cryptography).',
  push_endpoint: 'Este navegador usa un servicio de avisos no admitido.',
  push_keys: 'Las claves de avisos del dispositivo no son válidas.',
  too_big: 'El archivo es demasiado grande (máximo 10 MB).',
  file_type: 'Ese tipo de archivo no está admitido: fotos (JPEG, PNG, WebP) o PDF.',
  not_found: 'No se ha encontrado.',
};
export const errorText = (e) => MESSAGES[e?.code] || (e?.status ? `Error del servidor (${e.status}).` : MESSAGES.network);

export async function api(method, path, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* respuesta sin JSON (proxy caído, etc.) */ }
  if (!res.ok) {
    const code = data?.error || (res.status >= 500 ? 'server' : 'http');
    if (res.status === 401 && token && !path.startsWith('/api/auth/')) onAuthLost();
    if (res.status === 428) onConsent();
    throw new ApiError(res.status, code);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const del = (p) => api('DELETE', p, {});

/** Sube un archivo tal cual (sin JSON). */
export async function upload(path, blob) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type }, body: blob, credentials: 'omit' });
  } catch { throw new ApiError(0, 'network'); }
  let data = null;
  try { data = await res.json(); } catch { /* sin JSON */ }
  if (!res.ok) {
    if (res.status === 401) onAuthLost();
    throw new ApiError(res.status, data?.error || (res.status === 413 ? 'too_big' : 'http'));
  }
  return data;
}

/** Descarga un archivo protegido y devuelve un Blob. */
export async function download(path) {
  let res;
  try { res = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' }); }
  catch { throw new ApiError(0, 'network'); }
  if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'not_found' : 'http');
  return res.blob();
}
