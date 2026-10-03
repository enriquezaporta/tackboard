# Cambios

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
