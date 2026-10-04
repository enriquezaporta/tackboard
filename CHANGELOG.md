# Cambios

## 1.3.0 — 2026-10-04

- **Adjuntos** en las tarjetas: fotos y PDF. Las fotos se reducen a 2048 px y pierden los metadatos (ubicación) en el
  dispositivo antes de subirse. Visor a pantalla completa. Cupos: 10 MB por archivo, 20 por tarjeta, 200 MB por tablero.
- **Búsqueda** en todas las tarjetas (título, descripción, checklist y etiquetas, sin importar las tildes), con filtros
  por estado, tablero, fecha, prioridad y etiqueta. Tecla <kbd>/</kbd> en el escritorio.
- **Plantillas de tablero**: seis incluidas (Básico, Proyecto, Casa, Homelab, Viaje, Mudanza) y las tuyas, guardando
  cualquier tablero como plantilla.
- **Modo enfoque** durante un pomodoro: pantalla completa con la tarea y su checklist, sin que se apague la pantalla.
- Las copias de `tackboard-admin backup` incluyen los adjuntos.
- La política de privacidad se actualiza con los adjuntos y las plantillas (se pide aceptarla de nuevo).
- Revisión de seguridad independiente: 1 fallo medio y 6 bajos, corregidos (ver docs/seguridad.md).

## 1.2.1 — 2026-10-04

- Compartir un tablero recién creado ya no dice «No tienes permiso»: antes de cargar los miembros se envían los cambios pendientes.
- Documentación: copia diaria del contenedor con una tarea programada de Proxmox.

## 1.2.0 — 2026-10-04

- **Tareas que se repiten**: diaria, días laborables, semanal (eligiendo días), mensual, anual y «cada N». Al completarla
  se crea la siguiente; si se reabre por error, la siguiente se quita.
- **Pomodoro**: nueva pestaña con temporizador ligado a una tarea, descansos corto y largo, aviso al terminar aunque la
  app esté cerrada, tiempo restante visible en todas las pantallas y estadísticas (7 días, 30 días, año; por tablero y por
  tarea; racha de días). Se puede empezar desde una tarjeta. Funciona sin conexión.
- **Calendario del móvil**: enlace secreto iCal por persona, con tableros excluibles, para suscribirse desde el
  calendario del iPhone, Android u Outlook. Se puede renovar o desactivar.
- La política de privacidad se actualiza con los datos del pomodoro y del enlace de calendario (se pide aceptarla de nuevo).
- Corregido: las preferencias guardadas en el dispositivo que aún no existían no tomaban su valor por defecto.
- GitHub Actions actualizadas a sus versiones con Node 24.
- Una revisión de seguridad independiente de lo nuevo: 2 fallos medios y 5 bajos, corregidos (ver docs/seguridad.md).

## 1.1.3 — 2026-10-04

- *Columnas*: el campo «Límite WIP» ocupaba toda la fila y tapaba su texto. Ahora tiene ancho fijo. Lo mismo en
  *Ajustes → Resumen diario → A las*.

## 1.1.2 — 2026-10-04

- Actualizaciones fiables: al instalar una versión nueva, la app descarga todos sus archivos sin pasar por la caché
  del navegador, y Caddy pide revalidar JS y CSS. Antes podía quedar algún archivo de la versión anterior
  (por ejemplo, Ajustes seguía mostrando 1.1.0).

## 1.1.1 — 2026-10-04

- La hora de vencimiento se ve en el iPhone: un campo de hora vacío salía como una caja en blanco y no se
  distinguía. Ahora aparece rotulado («+ Hora» en la tarjeta, «Sin hora» al crear una tarea) y solo cuando hay fecha.

## 1.1.0 — 2026-10-04

- **Avisos de vencimiento**: en cada tarjeta con fecha se eligen uno o varios recordatorios (2 días, 1 día, 3 h, 1 h o
  15 min antes, o al vencer). Las tareas sin hora usan como referencia las 9:00 de ese día.
- Recordatorio por defecto (1 h antes) que se pone solo al dar fecha a una tarjeta, configurable en Ajustes.
- Desactivar los avisos en general, por tablero (útil en tableros compartidos) o en cada tarjeta.
- **Horario de silencio**: lo que toque dentro se avisa al terminar.
- **Resumen diario** opcional a la hora elegida, con las tareas de hoy y las vencidas.
- Por privacidad, el aviso no incluye el título salvo que se active en Ajustes.
- Los avisos se recalculan si la tarea se completa, se archiva o cambia de fecha, y nunca se repiten.
- Al tocar un aviso se abre la tarjeta.
- En tableros compartidos, los recordatorios de la tarjeta avisan a todos los miembros que no hayan silenciado el tablero.
- Si vencen muchas tareas a la vez, los avisos que pasan del tope por hora llegan agrupados en un resumen en vez de perderse.
- Una suscripción solo se borra si su servicio la da por caducada o si lleva 3 días fallando.

## 1.0.2 — 2026-10-04

- Base de los avisos (Web Push): el servidor genera sus claves VAPID, guarda las suscripciones de cada dispositivo
  y cifra cada aviso para él (RFC 8291). Solo se envía a los servicios de Apple, Google, Mozilla y Microsoft.
- *Ajustes → Avisos (prueba)*: activar o desactivar las notificaciones en el dispositivo y enviar un aviso de prueba.
- Nueva dependencia opcional del servidor: `python3-cryptography` (sin ella, todo funciona salvo los avisos).

## 1.0.1 — 2026-10-04

- Diseño adaptado a tablet y escritorio: contenido centrado y aprovechando el ancho.
  - *Hoy* en dos o tres columnas (hoy, próximos 7 días y resumen de tableros).
  - Tableros como fichas con tareas abiertas, vencidas, hechas y progreso.
  - *Ajustes* en dos columnas; pantalla de entrada centrada.
  - Calendario: la semana en 7 columnas y la lista en rejilla.
- Botón «Nueva tarea» en la cabecera en escritorio (el botón flotante queda para el móvil) y ya no tapa la última tarea.
- Etiquetas más legibles en tema oscuro y colores que se conservaban al cambiar de vista en el calendario y el tablero.

## 1.0.0 — 2026-10-03

Primera versión.

- Tableros Kanban con columnas, límite de trabajo en curso (WIP) y columna de terminado.
- Tarjetas con descripción, fecha y hora de vencimiento, fecha de inicio, prioridad, etiquetas y checklist.
- Arrastrar y soltar con ratón y con el dedo (pulsación larga), con desplazamiento automático del tablero.
- Pantalla «Hoy» con vencidas, tareas del día y próximos 7 días.
- Calendario de mes, semana y lista; arrastrar una tarea a otro día cambia su fecha.
- Tableros compartidos: invitaciones con permiso de lectura, escritura o todo, y anfitrión único.
- Cuentas sin correo con código de recuperación, cambio de contraseña y cierre de sesiones.
- Funciona sin conexión y sincroniza al volver; versión de escritorio y tema oscuro.
- Descarga de todos los datos, eliminación de la cuenta, política de privacidad y condiciones de uso.
- Instalación en Debian (LXC/VM) con systemd y Caddy, o con Docker.
