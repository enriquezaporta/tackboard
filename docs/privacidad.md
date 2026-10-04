# Privacidad

La app trae su [política de privacidad](../app/privacy.html) y sus [condiciones de uso](../app/terms.html). Se aceptan
al crear la cuenta y, si cambian, se vuelven a pedir.

> No soy abogado y esto no es asesoramiento legal. Si vas a abrir la app al público, que lo revise un profesional.

## Cómo cumple el RGPD

| Principio o derecho | En la app |
|---|---|
| Minimización (art. 5.1.c) | Sin correo, teléfono ni ubicación. Solo usuario, nombre visible y el contenido de los tableros |
| Información (arts. 13-14) | Política y condiciones en `/privacy.html` y `/terms.html`. Se aceptan al registrarse y se guarda la versión y la fecha |
| Acceso y portabilidad (arts. 15 y 20) | *Ajustes → Descargar todos mis datos*: JSON con cuenta, tableros, miembros, registros, invitaciones, sesiones, avisos, pomodoros y enlace de calendario |
| Rectificación (art. 16) | Todo se edita desde la app |
| Supresión (art. 17) | *Ajustes → Eliminar mi cuenta*. Borra cuenta, tableros propios (también para sus miembros), sesiones y su presencia en tableros ajenos. Lo que creó en tableros ajenos pertenece a esos tableros y se queda |
| Limitación de la conservación (art. 5.1.e) | Sesiones que caducan. IPs solo en memoria, como mucho una hora. Al borrar una tarjeta queda una marca sin contenido. Copias previas a cada actualización: se guardan las tres últimas |
| Seguridad (art. 32) | Ver [seguridad.md](seguridad.md) |
| Menores (art. 7 LOPDGDD) | Edad mínima de 14 años, declarada al registrarse |
| Cookies (art. 22.2 LSSI) | No hay cookies. Solo almacenamiento técnico imprescindible, que no necesita banner |

## Tableros compartidos

- **Quién es responsable del contenido.** El contenido de un tablero lo controla su anfitrión. Los miembros ven
  todo el tablero y los nombres de usuario de los demás miembros activos.
- **Qué ve quien recibe una invitación.** Solo el nombre del tablero y quién le invita, también si no la acepta.
- **Quién puede invitarte.** Cualquiera que sepa tu usuario puede intentarlo, salvo que desactives las invitaciones en *Ajustes*.
  - La respuesta del servidor permite saber si un nombre de usuario existe. Es inherente a invitar por nombre de usuario.
  - Está limitado a 30 invitaciones por hora.

## Pomodoro y enlace de calendario

- **Pomodoros.** Se guarda cuándo empezó cada pomodoro completo, cuánto duró y la tarjeta, si se eligió. Solo los ve su
  dueño. Las estadísticas solo nombran tableros y tarjetas de los que aún es miembro: si sale de un tablero, sus
  pomodoros cuentan como «Sin tablero».
- **Enlace de calendario.** Es un enlace secreto (256 bits) del que el servidor solo guarda el sha256.
  - Quien lo tenga ve título, fecha y tablero de las tareas pendientes con fecha.
  - La aplicación de calendario guarda una copia. Si la suscripción va a una cuenta en la nube (iCloud, Google, Outlook),
    los datos acaban en ese servicio. La app recomienda en el iPhone guardarlo «En mi iPhone».
  - Se desactiva a mano, al crear otro, al cambiar la contraseña, al cerrar las demás sesiones y al recuperar la cuenta.

## Uso doméstico

Si solo la usáis en casa y entre conocidos, el RGPD prácticamente no aplica (excepción doméstica, art. 2.2.c).
Aun así, todas estas medidas siguen protegiendo vuestros datos.

## Qué tienes que hacer tú si la publicas

1. **Identificarte como responsable.** Usa `tackboard-admin operator "Nombre" "contacto"`, o las variables
   `TB_OPERATOR_NAME` y `TB_OPERATOR_CONTACT` en Docker. Aparecen en la política.
2. **Revisar los textos** de `app/privacy.html` y `app/terms.html` y adaptarlos a tu caso. Por ejemplo, si el
   servidor está en un proveedor de alojamiento, nómbralo como encargado del tratamiento.
3. **Usar un dominio con HTTPS válido** y configurar `tackboard-admin proxy` con la IP de tu proxy.
4. **Cerrar el registro** (`tackboard-admin signup off`) si no quieres que cualquiera cree cuentas.
5. **Hacer copias de seguridad** cifradas y fuera del servidor. Indica en la política cuánto tiempo las guardas.
6. **Responder a las peticiones** que lleguen al contacto. El plazo general es de un mes.
7. **Llevar un registro de actividades de tratamiento**: qué datos tratas, para qué y cuánto tiempo. La tabla de
   la política sirve de base.
8. **Notificar las brechas de seguridad**: si alguien accede a la base de datos, tienes 72 horas para comunicarlo a la AEPD.
9. **Volver a pedir el consentimiento** si cambias la política: sube `POLICY_VERSION` en `backend/server.py` para
   que los usuarios la acepten de nuevo.
