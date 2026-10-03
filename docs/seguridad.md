# Seguridad

Resumen de las medidas aplicadas, para poder revisarlas. Para avisar de un fallo, mira [SECURITY.md](../SECURITY.md).

## Cuentas y sesiones

- **Contraseñas**:
  - con PBKDF2-HMAC-SHA256, 600.000 iteraciones (recomendación de OWASP) y sal aleatoria;
  - entre 8 y 128 caracteres.
- **Tokens de sesión**:
  - aleatorios de 256 bits; en la base de datos solo se guarda su sha256;
  - caducan a los 90 días sin uso y al año como máximo;
  - cambiar o recuperar la contraseña cierra las demás sesiones, y hay un botón para cerrarlas a mano.
- **Recuperación sin correo**: un código de 80 bits que se muestra una sola vez y se guarda como sha256. Al usarlo se genera otro.
- **Tiempos de respuesta**: son iguales exista o no el usuario, y las comparaciones son en tiempo constante.
- **Sesión caducada en un dispositivo**: se borran sus tableros de ese dispositivo. Solo se conservan los cambios sin enviar, que se envían si vuelve a entrar la misma persona.

## Límites de intentos

En memoria; nada se escribe en disco.

| Qué | Límite |
|---|---|
| Entrar o recuperar, por IP | 20 cada 15 min |
| Fallos de contraseña | 10 cada 15 min por usuario e IP. Además, 50 por usuario desde cualquier IP; ese límite no frena a una IP que aún no ha fallado |
| Recuperaciones por usuario | 10 cada 15 min |
| Registros por IP | 5 por hora |
| Comprobaciones de contraseña ya dentro (cambiarla, código nuevo, borrar cuenta) | 10 cada 15 min |
| Invitaciones | 30 por hora por usuario |
| Altas en un tablero | 10 al día |
| Peticiones por sesión | 600 por minuto |
| Tokens no válidos por IP | 60 cada 5 min (no afecta a las sesiones válidas) |

Las claves caducan con su ventana (como mucho, una hora). Si hay demasiadas, se descartan las más antiguas.
La IP real llega en `X-Real-IP` desde Caddy, que solo se fía de `X-Forwarded-For` si la petición viene de un
proxy de confianza (`tackboard-admin proxy`).

## Autorización

- Los permisos se comprueban en el servidor en **cada** cambio y consulta (ver [arquitectura](arquitectura.md#permisos)).
- Ante un registro de un tablero ajeno, la respuesta es siempre «prohibido», sin revelar nada de él.
- **Tableros compartidos**:
  - las invitaciones pendientes no dan acceso a nada;
  - quitar a alguien le corta el acceso en la siguiente sincronización y su app borra la copia local;
  - un tablero borrado no se puede volver a crear con el mismo identificador.
- **Límites de tamaño**:

| Qué | Máximo |
|---|---|
| Un registro | 32 KB |
| Contenido de un tablero | 16 MB |
| Columnas por tablero | 50 |
| Tarjetas por tablero | 5.000 |
| Tableros propios | 100 |
| Miembros por tablero | 50 |
| Invitaciones pendientes por tablero | 20 |

## Aplicación web

- **CSP estricta**:
  - `default-src 'none'` y `script-src 'self'`, sin `unsafe-inline`;
  - sin estilos en línea (los colores se aplican con CSSOM);
  - `frame-ancestors 'none'`.
- **Todo dato de usuario se escapa** antes de pintarlo; los colores se validan contra `#RRGGBB`.
- **Otras cabeceras**: `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP y CORP.
- **Sin terceros**: ni CDN ni fuentes externas; las fuentes van incluidas.
- **Sin cookies**: el token va en la cabecera `Authorization`, así que no hay CSRF.

## Avisos

- Cada aviso va cifrado para el dispositivo (RFC 8291) y firmado con la clave VAPID de la instalación (RFC 8292),
  que se genera la primera vez y se guarda en la base de datos.
- Solo se aceptan suscripciones de los servicios de notificaciones conocidos (Apple, Google, Mozilla, Microsoft):
  el servidor no puede usarse para hacer peticiones a otras direcciones.
- Las suscripciones caducadas (respuesta 404/410 del servicio) se borran solas. Máximo 10 dispositivos por cuenta.

## Servidor

- **Escucha** solo en `127.0.0.1`, detrás de Caddy.
- **Cuerpo de las peticiones**:
  - Caddy limita el tamaño (8 MB para sincronizar, 256 KB para el resto) y recibe el cuerpo entero antes de pasarlo;
  - si una petición trae un cuerpo que no se lee, la conexión se cierra, para que nunca se interprete como la petición siguiente.
- **Conexiones**:
  - tiempos máximos de lectura en Caddy y en el servidor;
  - número de hilos acotado;
  - si se agotan, responde 503 en vez de bloquearse.
- **SQLite**: consultas parametrizadas, `secure_delete` activado y base de datos con permisos `600`.
- **Registros del servidor** sin IPs ni nombres de usuario.
- **systemd**:
  - usuario propio;
  - `ProtectSystem=strict`, `NoNewPrivileges`, sin capacidades;
  - `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute` y límite de memoria.
- **Docker**: sin privilegios, sin capacidades, sistema de archivos de solo lectura y `no-new-privileges`.
- **Instalación**: el paquete de Caddy se verifica con la suma SHA-512 publicada.

## Revisión

Antes de publicar la versión 1.0 un agente independiente revisó el código y encontró:

- **1 fallo crítico**: con conexiones persistentes entre Caddy y el servidor, una petición rechazada sin leer su
  cuerpo podía hacer que otra conexión recibiera una respuesta ajena;
- **2 altos**: memoria con tarjetas muy grandes y conexiones lentas;
- **varios medios y bajos**.

Todos están corregidos y tienen prueba automática en `tests/test_backend.py`. Una segunda revisión de las
correcciones encontró tres problemas nuevos, también corregidos.

## Pendiente de ti si la publicas

Mira [privacidad.md](privacidad.md#qué-tienes-que-hacer-tú-si-la-publicas).
