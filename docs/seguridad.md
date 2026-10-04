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
| Pomodoro: empezar, detener o enviar los hechos sin conexión | 120 por hora por usuario |
| Enlaces de calendario nuevos | 10 por hora por usuario |
| Descargas del calendario | 60 por hora por enlace |
| Enlaces de calendario que no existen | 20 por hora por IP |
| Adjuntos subidos | 120 por hora por usuario |
| Plantillas guardadas | 60 por hora por usuario |

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
- Solo `https` al puerto 443, sin usuario ni contraseña en la dirección; el servidor no sigue redirecciones del servicio
  de avisos y espera como mucho 5 s por respuesta (los envíos a varios dispositivos van en paralelo).
- Cada suscripción va ligada a la sesión del dispositivo: cerrar sesión (también «cerrar las demás»), cambiar la
  contraseña en otro dispositivo, recuperar la cuenta o desactivarla deja de enviar avisos a ese dispositivo.
- Las suscripciones caducadas (respuesta 404/410) se borran, y también las que llevan 3 días fallando: un corte de red
  corto no las borra. Máximo 10 dispositivos por cuenta.
- **Contra el abuso**: `alertBase` tiene que corresponder a la fecha de la tarjeta (±14 h por las zonas horarias); el
  mismo recordatorio de la misma tarjeta no se repite en 30 minutos aunque se cambie la hora una y otra vez; como mucho
  20 avisos sueltos por persona, tablero y hora (40 en total). Lo que pase de ahí no se pierde: llega agrupado en un
  aviso-resumen, como mucho uno cada 10 minutos. El envío se reparte por turnos entre personas y, dentro de cada persona,
  entre tableros, para que un tablero compartido lleno de tarjetas no tape los avisos de los demás.
- Por defecto el aviso no incluye el título de la tarea: el contenido va cifrado, pero así ni siquiera el dispositivo
  bloqueado lo muestra. Cada persona puede activarlo.
- Antes de entregar un aviso se vuelve a comprobar que la persona sigue siendo miembro del tablero.
- El registro de avisos (qué tarjeta y cuándo) se borra a los 3 días.

## Pomodoro, repetición y calendario

- **Pomodoro**: solo se puede asociar a tarjetas de tableros de los que se es miembro, y se vuelve a comprobar antes
  de poner su título en un aviso. Las estadísticas no nombran tableros ni tarjetas de los que ya no se es miembro.
  Los hechos sin conexión se aceptan como mucho 7 días después, sin solaparse y con un máximo de 48 al día.
  El aviso al terminar respeta «Recibir avisos» y «Aviso al terminar».
- **Repetición**: la regla se valida en el servidor (frecuencia de una lista, 1-99, días 0-6). El enlace entre una
  tarjeta completada y la siguiente solo vale dentro del mismo tablero, y el cliente solo borra la siguiente si es
  del mismo tablero y nadie la ha tocado.
- **Calendario**: el enlace es aleatorio de 256 bits y en la base de datos solo está su sha256. Se busca por ese
  resumen, así que no hay comparación que revele nada por tiempo. Quien no tiene un enlace válido recibe 404, y a
  partir de 20 intentos por hora, 429.
  - Se desactiva al crear otro, al cambiar la contraseña (también el administrador), al cerrar las demás sesiones y
    al recuperar la cuenta. Con la cuenta desactivada devuelve 404.
  - Los títulos ya llegan limpios de caracteres de control y se escapan según el RFC 5545, así que una tarjeta no
    puede inyectar eventos ni campos.
  - La dirección de la tarjeta (`URL:`) usa la cabecera `Host` solo si es un nombre válido; solo afecta a quien hace la
    petición.
  - El servidor no registra las rutas pedidas y Caddy no guarda registro de accesos, así que el enlace no queda escrito.

## Adjuntos

- Solo JPEG, PNG, WebP y PDF, comprobados por sus primeros bytes (no por la extensión ni por lo que diga el navegador).
- Se sirven con `X-Content-Type-Options: nosniff` y `Content-Security-Policy: default-src 'none'; sandbox`; los PDF,
  como descarga. Los pide la app con la sesión, así que un enlace a un adjunto no sirve sin ella.
- Nombres en disco aleatorios (128 bits); el nombre original solo está en la base de datos y se codifica en
  `Content-Disposition`. Al descargar, la extensión es siempre la del tipo real.
- Cupos: 10 MB por archivo, 20 por tarjeta, 200 MB por tablero y un total por instalación. Se comprueban antes y
  después de recibir el archivo, para que varias subidas a la vez no los salten.
- El cuerpo se escribe a disco por trozos: un archivo grande no ocupa memoria del servidor.
- Las fotos pierden el EXIF (ubicación, cámara) en el dispositivo, antes de subirlas.
- Ver: miembro del tablero. Subir o borrar: permiso de escritura. Una tarjeta no puede referirse a adjuntos de otra.

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

En la versión 1.1 una tercera revisión, centrada en los avisos, no encontró forma de que un aviso llegue a quien no es
miembro del tablero, pero sí abusos posibles: saturar el planificador con miles de tarjetas, repetir avisos cambiando la
hora, direcciones de suscripción con puertos raros y avisos que seguían llegando tras cerrar sesión. Están corregidos
con sus pruebas.

En la versión 1.2 una cuarta revisión de pomodoro, repetición y calendario no encontró fallos críticos ni altos. Encontró
dos medios y cinco bajos, todos corregidos con prueba:

- un miembro de solo lectura podía hacer que otra persona borrara una tarjeta de otro tablero a través del enlace de
  repetición;
- el tope diario de pomodoros sin conexión se podía saltar y la comprobación era cara;
- el enlace de calendario sobrevivía a un cambio de contraseña;
- el calendario recorría todas las tarjetas;
- el límite por IP del calendario lo compartían todos los usuarios detrás de la misma IP;
- el aviso del pomodoro no respetaba «Recibir avisos»;
- dos dispositivos sin conexión podían duplicar la siguiente de una tarea que se repite.

En la versión 1.3 una quinta revisión de adjuntos, plantillas, búsqueda y modo enfoque no encontró fallos críticos
ni altos. Encontró uno medio y seis bajos, todos corregidos:

- **Medio**: varias subidas a la vez podían saltarse los cupos de adjuntos. Ahora se comprueban de nuevo antes de guardar.
- **Bajos**:
  - el nombre y el tipo de un adjunto los podía cambiar el cliente;
  - Caddy guardaba en memoria hasta 11 MB en cualquier petición, no solo en las subidas;
  - un `$` en un título descolocaba los resultados de búsqueda;
  - la limpieza de adjuntos no barría restos y se hacía con el candado puesto;
  - la caché del navegador no distinguía sesiones;
  - el bloqueo de pantalla del modo enfoque podía quedarse activo.

## Pendiente de ti si la publicas

Mira [privacidad.md](privacidad.md#qué-tienes-que-hacer-tú-si-la-publicas).
