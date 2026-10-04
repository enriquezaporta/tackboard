# Arquitectura

```
 Móvil / PC (PWA)                         Servidor
┌──────────────────────────┐   HTTPS   ┌───────────────────────────────────────────┐
│ app/ (HTML, CSS, JS)     │ ────────▶ │ Caddy: archivos estáticos, cabeceras,     │
│ IndexedDB: registros,    │           │ límites de tamaño, /api/* ─┐              │
│ cambios pendientes       │ ◀──────── │                            ▼              │
│ service worker (caché)   │           │ server.py (Python + SQLite, 127.0.0.1)    │
└──────────────────────────┘           └───────────────────────────────────────────┘
```

## Datos

Todo lo que hay en un tablero es un **registro** con la misma forma:

```json
{ "id": "…22 caracteres…", "kind": "board | column | card | comment", "boardId": "…", "updatedAt": 1791000000000,
  "deleted": false, "data": { … } }
```

| `kind` | `data` |
|---|---|
| `board` | `name`, `color`, `labels[]` (id, nombre, color), `pos` |
| `column` | `name`, `pos`, `wip` (límite o `null`), `isDone` |
| `comment` | `cardId`, `text`, `author`, `authorId`, `createdAt`, `editedAt` (autor y fechas los pone el servidor) |
| `card` | `columnId`, `title`, `description`, `start`, `due`, `dueTime`, `dueAt`, `alertBase`, `reminders[]`, `repeat`, `repeatedAs`, `attachments[]`, `assignees[]`, `priority`, `labels[]`, `checklist[]`, `pos`, `done`, `doneAt`, `archived` |

- **Orden**: las columnas y las tarjetas se ordenan por `pos`, un número decimal. Insertar entre dos tarjetas usa el
  punto medio; si se agota el hueco, se renumera la columna.
- **Fechas**: van como texto local (`AAAA-MM-DD` y `HH:MM`). `dueAt` guarda además el instante exacto, para ordenar
  y para los avisos de la versión 1.1.
- **Validación**: el servidor la hace campo a campo, con lista blanca. Lo desconocido se descarta. Los textos se
  limpian de caracteres de control.

Tablas de SQLite:

| Tabla | Contiene |
|---|---|
| `users` | Cuentas: hash de contraseña y de código de recuperación, versión de la política aceptada |
| `tokens` | Sesiones: solo el sha256 del token |
| `members` | Quién está en cada tablero y con qué permiso (`owner`, `admin`, `write`, `read`), o si la invitación está pendiente |
| `records` | Los registros, con `server_ts` (marca creciente del servidor) |
| `deleted_boards` | Identificadores de tableros borrados, para que un cliente desfasado no los resucite |
| `push_subs`, `notify_prefs`, `notify_log`, `settings` | Avisos (ver más abajo) |
| `pomo_active`, `pomo_log` | Pomodoro en marcha de cada persona y pomodoros completados |
| `ical_tokens` | Enlace de calendario de cada persona: sha256 del enlace, tableros excluidos, última consulta |
| `attachments` | Adjuntos: tablero, tarjeta, quién lo subió, nombre, tipo y tamaño. El archivo está en `files/<2 letras>/<id>` |
| `templates` | Plantillas de tablero de cada persona |
| `activity` | Actividad de cada tablero: quién (id), qué, tarjeta y su título en ese momento, cuándo |

## Sincronización

```
POST /api/sync  { since, changes: [registro…] }
             -> { cursor, changes: [registro…], boards: [{id, role, members, owner}], rejected, invitations, more }
```

1. El cliente envía sus cambios pendientes, en lotes de hasta 500 o unos 3 MB.
2. El servidor los aplica **en una transacción y bajo un candado**. Cada cambio aceptado recibe un `server_ts` nuevo.
3. Después devuelve todo lo de los tableros del usuario con `server_ts > since`, en páginas de hasta 2.000
   registros o 4 MB (`more: true` si hay más). El cliente guarda `cursor` para la próxima vez. Así el reloj del
   móvil no influye.
4. Los cambios que no se aceptan vuelven en `rejected` con el motivo y, si el usuario tiene acceso, la versión
   actual (`current`). El cliente se queda con esa versión y avisa:

| Motivo | Cuándo |
|---|---|
| `stale` | Ya hay un cambio más reciente |
| `forbidden` | No tiene permiso |
| `limit` | Se ha alcanzado un límite |
| `invalid` | Los datos no son válidos |

5. `boards` es la lista completa de tableros a los que tiene acceso. Si uno desaparece (le han quitado, ha salido
   o se ha borrado), el cliente borra sus datos locales.

Reglas:

- **Conflictos**: gana el último cambio de cada registro, según `updatedAt`. Cambios distintos en tarjetas distintas
  nunca chocan.
- **Borrados**: una tarjeta o columna borrada queda como marca sin contenido (`deleted: true`, `data: null`) para
  avisar a los demás dispositivos. Borrar un tablero elimina todo su contenido y sus miembros.
- **Nuevo miembro**: al aceptar una invitación, el servidor vuelve a marcar los registros de ese tablero. El nuevo
  miembro los recibe con su siguiente sincronización normal, paginada.

El cliente sincroniza:

- al abrir la app;
- al volver a ella;
- 1,5 s después de cada cambio;
- cada minuto mientras está visible.

## Avisos

```
 tarjeta: alertBase + reminders ──▶ planificador (cada 30 s) ──▶ notify_log ──▶ Web Push ──▶ Apple / Google ──▶ dispositivo
```

- **Datos de la tarjeta**: además de la fecha, `alertBase` (el instante de referencia: la hora de vencimiento o las
  9:00 si es de todo el día, calculado en el dispositivo con su zona horaria) y `reminders` (`2d`, `1d`, `3h`, `1h`,
  `15m`, `due`).
- **Preferencias de cada usuario** (`notify_prefs`): avisos sí o no, recordatorio por defecto, horario de silencio,
  resumen diario, mostrar títulos, tableros silenciados y zona horaria.
- **Planificador** (un hilo del servidor). Cada 30 segundos:
  1. busca los recordatorios cuyo momento cae desde la revisión anterior hasta ahora (como mucho 5.000 nuevos por
     revisión; si hay más, sigue en la siguiente desde ese punto), y los apunta en `notify_log`
     para cada miembro del tablero que los quiere. Si cae en su horario de silencio, la entrega se aplaza al final del
     silencio. La clave única (usuario, tarjeta, tipo, momento) impide repetirlos;
  2. entrega los que ya tocan, comprobando antes que la tarea sigue pendiente, con la misma fecha y el mismo
     recordatorio. Si no, se anulan. Hay topes por hora (por persona y tablero, y por persona) y por revisión; lo que
     no cabe en una revisión espera a la siguiente y lo que pasa del tope por hora se agrupa en un aviso-resumen;
  3. manda el resumen diario a quien lo tenga activado, una vez al día;
  4. borra el registro con más de 3 días.
- En tableros compartidos entre zonas horarias distintas, las tareas de todo el día avisan según las 9:00 de quien
  puso o cambió la fecha (los recordatorios son de la tarjeta, no de cada persona).
- Tras un reinicio se recuperan los avisos de los últimos 30 minutos. Un aviso que no se ha podido entregar en
  12 horas se descarta.
- **Envío**: cifrado para cada dispositivo (RFC 8291) y firmado con la clave VAPID de la instalación (RFC 8292). El
  service worker muestra la notificación y, al tocarla, abre `#/tarjeta/<id>`.

## Tareas que se repiten

- La regla va en la tarjeta: `repeat = {freq, every, days, day}`. `freq` es `day`, `weekday`, `week`, `month` o `year`;
  `every`, cada cuántos (1-99); `days`, los días de la semana (0 = domingo) si es semanal; `day`, el día del mes de
  referencia, para que «cada mes el 31» caiga el 28 o el 30 cuando toca y vuelva al 31 después.
- Lo hace el cliente, en `store.js` (`repeatHook`): al pasar una tarjeta a completada, crea la siguiente con la próxima
  fecha que no haya pasado (copia del título, descripción, etiquetas, checklist sin marcar, avisos y regla) en la primera
  columna, y quita la regla de la completada.
- La siguiente tiene un identificador fijo, `<tarjeta original>_r<AAAAMMDD>`: si dos dispositivos la completan sin
  conexión, crean el mismo registro y no dos.
- La completada guarda `repeatedAs = {id, at}`. Si se reabre y la siguiente no se ha tocado (mismo `updatedAt`), la
  siguiente se borra y la regla vuelve. El servidor anula `repeatedAs` si apunta a otro tablero.

## Pomodoro

- Un temporizador por persona en `pomo_active`, con la hora de fin calculada por el servidor. El cliente corrige la
  diferencia entre su reloj y el del servidor.
- El planificador de avisos duerme hasta el siguiente fin de pomodoro (o 30 s), así que el aviso llega en cuanto termina,
  aunque la app esté cerrada. Al terminar un pomodoro lo guarda en `pomo_log`; los descansos no se guardan.
- Si se detiene antes de tiempo, no cuenta.
- Sin conexión, el temporizador funciona en el dispositivo y el pomodoro terminado se envía después a `POST /api/pomo/log`,
  que solo acepta los de los últimos 7 días, sin solaparse con otros y con un máximo de 48 al día.
- Las estadísticas (`GET /api/pomo/stats?days=7|30|365`) agrupan por día en la zona horaria de la persona, por tablero y
  por tarjeta, y calculan la racha de días seguidos. Los títulos los pone el cliente con sus datos locales.

## Calendario (iCal)

- `POST /api/ical/new` crea un enlace aleatorio de 256 bits, `/api/ical/<token>.ics`, y lo devuelve una sola vez. En la
  base de datos solo queda su sha256.
- `GET /api/ical/<token>.ics` no necesita sesión: el enlace es la credencial. Devuelve las tareas pendientes con fecha
  de los tableros de la persona, menos los excluidos: las de todo el día como evento de día completo; las que tienen hora,
  como un evento de 15 minutos a esa hora. Sin alarmas, para no duplicar los avisos de la app.
- Texto escapado y líneas de 75 octetos como pide el RFC 5545. Como mucho 5.000 eventos.

## Colaboración

- **Responsables**: `assignees[]` de la tarjeta, con nombres de usuario. El servidor deja solo a miembros activos del
  tablero. La sincronización devuelve, para cada tablero, sus miembros (`people`: usuario y nombre) para mostrarlos.
- **Comentarios**: son registros más (`kind: "comment"`), así que se sincronizan, funcionan sin conexión y tienen los
  mismos permisos que las tarjetas (escritura para crear). El servidor fija autor y fechas; solo el autor (por id, no
  por nombre) edita, y borran el autor o quien gestiona el tablero. Al borrar una tarjeta se borran sus comentarios.
  Como mucho 500 por tarjeta y 10.000 por tablero.
- **Actividad**: el servidor la apunta al aplicar los cambios (creada, movida, completada, reabierta, archivada,
  restaurada, eliminada, fecha, asignada, comentario), una por tarjeta y tipo en cada sincronización y como mucho 200
  por sincronización. Se guardan 90 días y, como mucho, las 5.000 últimas de cada tablero. Sin el texto de los
  comentarios.
- Cada cambio de una sincronización va en su propio *savepoint*: si se rechaza, no deja ni actividad ni avisos.
- **Avisos**: al asignar a alguien o comentar, se avisa (en segundo plano, después de la sincronización) a quien
  corresponde, si tiene activados «Asignaciones y comentarios», no ha silenciado el tablero, no está en su horario de
  silencio y sigue siendo miembro. Un aviso por persona, tarjeta y tipo en cada sincronización; como mucho 20 por
  sincronización, 60 por hora por quien los provoca y 30 por hora por quien los recibe.

## Adjuntos

- La app reduce las fotos (2048 px, JPEG) antes de subirlas: pesan menos y pierden el EXIF. Los PDF van tal cual.
- `POST /api/files?card=<id>&name=<nombre>` con el archivo como cuerpo y su tipo en `Content-Type`. El servidor:
  - comprueba permiso de escritura en el tablero de la tarjeta y los cupos (10 MB por archivo, 20 por tarjeta, 200 MB
    por tablero y `TB_FILES_MAX_MB` en total);
  - escribe el cuerpo a disco por trozos y comprueba el tipo real por sus primeros bytes (JPEG, PNG, WebP o PDF);
  - vuelve a comprobar permisos y cupos antes de darlo por bueno (por si hay varias subidas a la vez).
- La tarjeta guarda la lista (`attachments[]`) y se sincroniza como siempre. El servidor solo deja en esa lista
  adjuntos subidos a esa misma tarjeta, y con el nombre, tipo y tamaño que tiene él.
- `GET /api/files/<id>` exige ser miembro del tablero. Se sirve con `nosniff`, `Content-Security-Policy: sandbox` y,
  los PDF, como descarga. La app los pide con la sesión y los muestra como `blob:`.
- Limpieza: al borrar un tablero se borran sus archivos. Cada hora se borran los adjuntos que ninguna tarjeta usa desde
  hace más de un día, los restos de subidas cortadas y los archivos sin fila.

## Plantillas

Las incluidas están en `app/js/templates.js`. Las propias se guardan en el servidor (`/api/templates`): nombre, color,
etiquetas, columnas y, si se quiere, tarjetas (título, descripción, prioridad, etiquetas y checklist, sin fechas).
Como mucho 30 por persona y 256 KB cada una. Crear un tablero desde una plantilla son registros normales creados por
el cliente, con identificadores nuevos.

## Permisos

Se comprueban **siempre en el servidor**, registro a registro. La interfaz solo oculta lo que no se puede hacer.

| Operación | Mínimo |
|---|---|
| Ver un tablero, sus miembros activos | `read` |
| Crear, editar, mover, archivar, borrar tarjetas | `write` |
| Columnas, etiquetas, nombre y color del tablero; invitar, cambiar permisos, quitar miembros | `admin` (*Todo*) |
| Borrar el tablero | `owner` (anfitrión) |

Además:

- El anfitrión es único: no se le puede quitar ni cambiar el permiso.
- Un registro no puede cambiar de tablero ni de tipo.
- Una tarjeta solo puede estar en una columna de su mismo tablero.
- Las invitaciones pendientes no dan acceso a nada. Quien las recibe solo ve el nombre del tablero y quién le invita.

## API

| Método y ruta | Uso |
|---|---|
| `GET /api/health`, `GET /api/legal` | Estado y responsable de la instalación (públicos) |
| `POST /api/auth/register`, `login`, `recover`, `logout`, `logout-others` | Cuentas y sesiones |
| `GET /api/me`, `POST /api/me` | Perfil: nombre, aceptar invitaciones, consentimiento |
| `POST /api/me/password`, `/api/me/recovery`, `/api/me/delete` | Contraseña, código nuevo, borrar cuenta |
| `GET /api/export` | Todos los datos del usuario |
| `POST /api/sync` | Sincronización |
| `GET`/`POST /api/boards/<id>/members` | Miembros e invitar |
| `POST`/`DELETE /api/boards/<id>/members/<usuario>` | Cambiar permiso / quitar o salir |
| `GET /api/invitations`, `POST /api/invitations/<id>` | Invitaciones recibidas, aceptar o rechazar |
| `GET /api/push/key`, `POST /api/push/subscribe`, `/unsubscribe`, `/test` | Avisos: clave VAPID, suscripción del dispositivo y aviso de prueba |
| `GET`/`POST /api/push/prefs` | Preferencias de avisos |
| `GET /api/pomo`, `POST /api/pomo/start`, `/stop`, `/log`, `GET /api/pomo/stats` | Pomodoro |
| `GET /api/ical`, `POST /api/ical/new`, `/revoke`, `/prefs` | Enlace de calendario |
| `POST /api/files`, `GET`/`DELETE /api/files/<id>` | Adjuntos |
| `GET /api/boards/<id>/activity?before=<id>` | Actividad del tablero (de 50 en 50) |
| `GET`/`POST /api/templates`, `DELETE /api/templates/<id>` | Plantillas propias |
| `GET /api/ical/<token>.ics` | El calendario (sin sesión: el enlace es la credencial) |

Todo salvo `health`, `legal`, `register`, `login`, `recover` y el `.ics` necesita `Authorization: Bearer <token>`.

## Código

| Archivo | Qué hace |
|---|---|
| `app/js/main.js` | Arranque, rutas (`#/hoy`, `#/tableros`, `#/tablero/<id>`, `#/calendario`, `#/pomodoro`, `#/buscar`, `#/ajustes`, `#/tarjeta/<id>`) y estructura |
| `app/js/pomo.js` | Estado del pomodoro, sincronizado con el servidor |
| `app/js/files.js` | Adjuntos: preparar fotos, subir, mostrar y visor |
| `app/js/quickadd.js` | Alta rápida: reconoce fecha, hora, tablero, prioridad, responsable y repetición en el título |
| `app/js/templates.js` | Plantillas incluidas y propias |
| `app/js/push.js` | Suscripción a los avisos del dispositivo |
| `app/js/store.js` | Estado en memoria, cambios locales y sincronización |
| `app/js/db.js` | IndexedDB |
| `app/js/drag.js` | Arrastrar y soltar con eventos de puntero |
| `app/js/sheets.js` | Hojas: tarjeta, nueva tarea, tablero, columnas, etiquetas, compartir, invitaciones |
| `app/js/views/` | Pantallas |
| `backend/server.py` | Toda la API y la administración por línea de órdenes |

## Decisiones

- **Sin dependencias** en la app y en el servidor, salvo `python3-cryptography` para cifrar los avisos (opcional). No hay nada que actualizar por seguridad salvo Python y Caddy, y cualquiera puede leer todo el código.
- **Offline-first**: la app debe responder al instante, haya o no conexión.
- **Sin correo**: menos datos personales. La recuperación se hace con un código que solo tiene el usuario.
- **Registros genéricos**: un único mecanismo de sincronización y permisos para tableros, columnas y tarjetas.
- **El pomodoro no es un registro**: es de una sola persona (no de un tablero) y el servidor tiene que vigilar cuándo
  termina para avisar. Por eso tiene su propia API en vez de ir por la sincronización.
