# Instalación

Tackboard es una carpeta de archivos estáticos (`app/`), un servidor en Python (`backend/server.py`) y Caddy delante.
Hay dos formas de instalarlo:

- [En Debian (contenedor LXC de Proxmox o máquina virtual)](#en-debian-lxc-o-vm), con systemd. Es la recomendada para un homelab.
- [Con Docker](#con-docker).

> **HTTPS es obligatorio** para instalarla como app y para que funcione sin conexión (los *service workers* solo
> funcionan con HTTPS o en `localhost`). Lo normal es poner delante un proxy inverso con certificado: Caddy,
> Nginx Proxy Manager, Traefik… Ver [HTTPS](#https).

## En Debian (LXC o VM)

### 1. Crear el contenedor (Proxmox)

Un contenedor sin privilegios con Debian 12 o 13 es suficiente: 1 núcleo, 256–512 MB de RAM y 4 GB de disco.
Desde la consola de un nodo:

```bash
# Ajusta CTID, almacenamiento, plantilla, IP y puerta de enlace a tu red.
pveam update
# Ojo: la lista incluye también plantillas arm64; los equipos x86 necesitan la amd64.
T=$(pveam available --section system | awk '/debian-13-standard.*_amd64/ {print $2}' | sort -V | tail -1); echo "$T"
pveam download local "$T"

pct create <CTID> "local:vztmpl/$T" --arch amd64 \
  --hostname tackboard --cores 1 --memory 512 --swap 256 \
  --rootfs local-zfs:4 --unprivileged 1 --features nesting=1 \
  --net0 name=eth0,bridge=vmbr0,ip=<IP>/24,gw=<PUERTA-DE-ENLACE>,firewall=1 \
  --nameserver <DNS> --onboot 1 --password
pct start <CTID>
```

`nesting=1` permite a systemd aplicar sus protecciones dentro del contenedor.

Desde el nodo, `pct exec <CTID> -- …` usa un PATH reducido: llama a la orden de administración con su ruta
completa, `/usr/local/bin/tackboard-admin`. Dentro del contenedor (`pct enter`) basta con `tackboard-admin`.

### 2. Instalar

Dentro del contenedor (`pct enter <CTID>`):

```bash
apt update && apt install -y git
git clone https://github.com/enriquezaporta/tackboard.git /opt/tackboard-src
cd /opt/tackboard-src && bash deploy/install.sh
```

El instalador:

- instala Python y Caddy. Si la versión de Caddy de Debian es antigua, instala la oficial y comprueba su suma de verificación;
- crea el usuario de servicio `tackboard`;
- copia la app a `/srv/tackboard` y el servidor a `/opt/tackboard-api`;
- deja en marcha `tackboard-api` (systemd, endurecido) y Caddy en el puerto 80.

La base de datos está en `/var/lib/tackboard/tackboard.db`.

### 3. Ajustes de la instalación

```bash
tackboard-admin operator "Tu nombre" "tu-correo@ejemplo.com"   # responsable (política de privacidad)
tackboard-admin proxy 192.0.2.10        # IP de tu proxy inverso, para ver las IP reales de los clientes
tackboard-admin signup off              # cerrar el registro cuando ya estén creadas las cuentas
```

Si cierras el registro, las cuentas nuevas se crean con `tackboard-admin adduser <usuario> "Nombre"`. Muestra
una contraseña y un código de recuperación. La persona tendrá que aceptar la política la primera vez que entre.

### Administración

| Orden | Qué hace |
|---|---|
| `tackboard-admin users` | Usuarios, tableros propios y compartidos |
| `tackboard-admin adduser <usuario> [nombre]` | Crea una cuenta |
| `tackboard-admin passwd <usuario>` | Contraseña nueva aleatoria (cierra sus sesiones) |
| `tackboard-admin disable` / `enable <usuario>` | Desactiva o reactiva una cuenta |
| `tackboard-admin deluser <usuario>` | Borra la cuenta y todos sus datos |
| `tackboard-admin signup on` / `off` | Abre o cierra el registro desde la app |
| `tackboard-admin operator "Nombre" "contacto"` | Responsable que aparece en la política de privacidad |
| `tackboard-admin proxy <ip> [ip…]` / `none` | Proxies de confianza para la IP real del cliente |
| `tackboard-admin backup [carpeta]` | Copia consistente de la base de datos (por defecto en `/var/backups/tackboard`) |

### Actualizar

```bash
cd /opt/tackboard-src && git pull && bash deploy/install.sh
```

Antes de actualizar se hace una copia de la base de datos. Se guardan las tres últimas en `/var/lib/tackboard/`.

Si has modificado `/etc/caddy/Caddyfile` (por ejemplo para poner tu dominio), el instalador no lo toca. Deja la
versión nueva en `/etc/caddy/Caddyfile.tackboard-nuevo` para que puedas comparar.

## HTTPS

### Detrás de un proxy inverso (lo habitual en un homelab)

Apunta un nombre (por ejemplo `tackboard.casa.lan`) al proxy y que este reenvíe a `http://<IP-del-contenedor>:80`.
Con Caddy como proxy:

```caddyfile
tackboard.casa.lan {
	tls internal          # o tu certificado / Let's Encrypt si tienes dominio
	reverse_proxy <IP-del-contenedor>:80
}
```

Después, en el contenedor de Tackboard, indica la IP del proxy para que los límites de intentos vean la IP real
de cada cliente:

```bash
tackboard-admin proxy <IP-del-proxy>
```

Si usas una CA propia (`tls internal`), instala su certificado raíz en cada dispositivo. En iPhone, además, hay que
activarlo en *Ajustes → General → Información → Ajustes de confianza de certificados*.

### Directamente con Caddy y un dominio público

Edita `/etc/caddy/Caddyfile` y cambia `:{$TB_HTTP_PORT:80}` por tu dominio (`tareas.ejemplo.com`). Abre los
puertos 80 y 443 hacia el contenedor; Caddy obtiene y renueva el certificado solo. Después `systemctl restart caddy`.

## Cortafuegos

No hace falta un contenedor con un cortafuegos aparte: basta con el **cortafuegos de Proxmox** en el propio
contenedor. La idea:

- **Entrada**: solo el puerto 80 desde el proxy inverso (y SSH desde tu equipo, si lo usas).
- **Salida**:
  - DNS hacia tu servidor de nombres;
  - HTTP/HTTPS hacia internet (paquetes de Debian; en la versión 1.1, los avisos push);
  - NTP;
  - y **nada hacia el resto de tu red**. Así, si alguien comprometiera la app, no podría saltar a otros equipos ni a la administración de Proxmox.

1. **Antes de activar nada**, comprueba que el cortafuegos del centro de datos deja entrar a la interfaz web y a
   SSH de los nodos desde tu red. Si no, al activarlo puedes quedarte fuera:

   ```bash
   # /etc/pve/firewall/cluster.fw
   [OPTIONS]
   enable: 1

   [RULES]
   IN ACCEPT -source <TU-LAN>/24 -p tcp -dport 8006 # interfaz web de Proxmox
   IN ACCEPT -source <TU-LAN>/24 -p tcp -dport 22   # SSH a los nodos
   ```

2. Reglas del contenedor:

   ```bash
   # /etc/pve/firewall/<CTID>.fw
   [OPTIONS]
   enable: 1
   policy_in: DROP
   policy_out: DROP

   [RULES]
   IN ACCEPT -source <IP-del-proxy> -p tcp -dport 80 # proxy inverso
   IN ACCEPT -source <IP-de-tu-PC> -p tcp -dport 22 # SSH (opcional)
   OUT ACCEPT -dest <IP-del-DNS> -p udp -dport 53 # DNS
   OUT ACCEPT -dest <IP-del-DNS> -p tcp -dport 53 # DNS
   OUT DROP -dest <TU-LAN>/24 # nada más dentro de casa
   OUT ACCEPT -p tcp -dport 443 # internet: paquetes y avisos push
   OUT ACCEPT -p tcp -dport 80 # internet: repositorios de Debian
   OUT ACCEPT -p udp -dport 123 # hora
   ```

   Las reglas se aplican en orden. Por eso las excepciones de la red local van antes que `OUT DROP -dest <TU-LAN>/24`.

3. Comprueba que el contenedor tiene `firewall=1` en su interfaz:

   ```bash
   pct config <CTID> | grep net0
   pct set <CTID> -net0 name=eth0,bridge=vmbr0,ip=<IP>/24,gw=<PUERTA-DE-ENLACE>,firewall=1
   ```

4. Prueba que la app sigue funcionando a través del proxy y que desde el contenedor no llegas a otro equipo:

   ```bash
   pct exec <CTID> -- curl -m 3 -sI https://<IP-de-un-nodo>:8006
   ```

   Debe fallar por tiempo de espera.

Si más adelante separas el homelab en VLAN, estas mismas reglas se pueden aplicar en el router.

## Con Docker

```bash
git clone https://github.com/enriquezaporta/tackboard.git && cd tackboard
# Edita docker-compose.yml: responsable, registro abierto o cerrado y proxies de confianza.
docker compose up -d --build
```

- La imagen ejecuta Caddy y el servidor en el mismo contenedor, sin privilegios y con el sistema de archivos de solo lectura.
- Los datos van en el volumen `tackboard-data`.
- Por defecto escucha solo en `127.0.0.1:8080`: pon delante tu proxy con HTTPS.
- La imagen también se publica en `ghcr.io/enriquezaporta/tackboard` para amd64 y arm64.

Administración:

```bash
docker exec -it tackboard tackboard-admin users
docker exec -it tackboard tackboard-admin adduser alex "Alex"
```

Variables de entorno:

| Variable | Por defecto | Para qué |
|---|---|---|
| `TB_OPERATOR_NAME`, `TB_OPERATOR_CONTACT` | vacías | Responsable que aparece en la política de privacidad |
| `TB_ALLOW_SIGNUP` | `1` | `0` cierra el registro desde la app |
| `TB_TRUSTED_PROXIES` | `127.0.0.1/32` (en el compose, la red de Docker) | Proxies de los que se acepta la IP real del cliente |
| `TB_HTTP_PORT` | `8080` | Puerto de Caddy dentro del contenedor |

## Copias de seguridad

Todo está en un único archivo SQLite. Haz copias con la orden de administración, no copiando el archivo en
caliente:

```bash
tackboard-admin backup /ruta/de/copias
```

Con Docker:

```bash
docker exec tackboard python3 -c "import sqlite3;s=sqlite3.connect('/data/tackboard.db');d=sqlite3.connect('/data/copia.db');s.backup(d)"
docker cp tackboard:/data/copia.db .
```

Guárdalas fuera del servidor y, si salen de casa, cifradas. Para restaurar:

1. Para el servicio: `systemctl stop tackboard-api`.
2. Sustituye `/var/lib/tackboard/tackboard.db` por la copia (propietario `tackboard`, permisos `600`).
3. Arranca de nuevo el servicio.

## Probar en local sin instalar nada

```bash
TB_DB=/tmp/tb.db TB_PORT=8000 python3 backend/server.py &
caddy run --config deploy/Caddyfile --adapter caddyfile   # con TB_HTTP_PORT=8080 TB_WEB_ROOT=$PWD/app
```

Abre <http://localhost:8080>. Las pruebas del servidor se lanzan con `python3 -m unittest discover -s tests`, y las
capturas de esta documentación se generan con `python3 tools/capturas.py http://localhost:8080`, sobre una
instalación vacía.
