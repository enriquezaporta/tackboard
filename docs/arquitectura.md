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
{ "id": "…22 caracteres…", "kind": "board | column | card", "boardId": "…", "updatedAt": 1791000000000,
  "deleted": false, "data": { … } }
```

| `kind` | `data` |
|---|---|
| `board` | `name`, `color`, `labels[]` (id, nombre, color), `pos` |
| `column` | `name`, `pos`, `wip` (límite o `null`), `isDone` |
| `card` | `columnId`, `title`, `description`, `start`, `due`, `dueTime`, `dueAt`, `priority`, `labels[]`, `checklist[]`, `pos`, `done`, `doneAt`, `archived` |

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

Todo salvo `health`, `legal`, `register`, `login` y `recover` necesita `Authorization: Bearer <token>`.

## Código

| Archivo | Qué hace |
|---|---|
| `app/js/main.js` | Arranque, rutas (`#/hoy`, `#/tableros`, `#/tablero/<id>`, `#/calendario`, `#/ajustes`) y estructura |
| `app/js/store.js` | Estado en memoria, cambios locales y sincronización |
| `app/js/db.js` | IndexedDB |
| `app/js/drag.js` | Arrastrar y soltar con eventos de puntero |
| `app/js/sheets.js` | Hojas: tarjeta, nueva tarea, tablero, columnas, etiquetas, compartir, invitaciones |
| `app/js/views/` | Pantallas |
| `backend/server.py` | Toda la API y la administración por línea de órdenes |

## Decisiones

- **Sin dependencias** en la app y en el servidor. No hay nada que actualizar por seguridad salvo Python y Caddy, y cualquiera puede leer todo el código.
- **Offline-first**: la app debe responder al instante, haya o no conexión.
- **Sin correo**: menos datos personales. La recuperación se hace con un código que solo tiene el usuario.
- **Registros genéricos**: un único mecanismo de sincronización y permisos para tableros, columnas y tarjetas.
  Añadir tipos nuevos (por ejemplo, sesiones de pomodoro) no cambia el protocolo.
