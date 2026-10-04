// Avisos push en este dispositivo: estado, activar, desactivar y prueba.
import { get, post } from './api.js';

const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Estado: 'unsupported' | 'install' (iOS fuera de la pantalla de inicio) | 'denied' | 'off' | 'on' */
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS() && !isStandalone() ? 'install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

/** Debe llamarse desde un toque del usuario (iOS lo exige para pedir permiso). */
export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm;
  const { publicKey } = await get('/api/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await post('/api/push/subscribe', sub.toJSON());
  return 'granted';
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* sin conexión: se borrará al caducar */ }
  await sub.unsubscribe();
}

export const testPush = () => post('/api/push/test');

/** Vuelve a registrar en el servidor la suscripción que ya tiene el dispositivo (p. ej., tras entrar de nuevo). */
export async function resubscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await post('/api/push/subscribe', sub.toJSON());
}
