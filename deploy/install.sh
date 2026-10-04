#!/usr/bin/env bash
# Instala o actualiza Tackboard en Debian 12/13 (contenedor LXC o máquina virtual), como root.
#   git clone https://github.com/enriquezaporta/tackboard.git && cd tackboard && bash deploy/install.sh
# Es seguro volver a ejecutarlo para actualizar: los datos se conservan y antes se hace una copia.
set -euo pipefail
# pct exec y algunos entornos mínimos no incluyen /usr/local en el PATH.
export PATH="/usr/local/sbin:/usr/local/bin:$PATH"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
WEB=/srv/tackboard
CADDY_VERSION=2.10.2

[ "$(id -u)" -eq 0 ] || { echo "Ejecútalo como root."; exit 1; }

echo "==> Paquetes"
apt-get update -qq
apt-get install -y -qq python3 python3-cryptography tzdata curl ca-certificates sqlite3 >/dev/null

need_caddy=1
if command -v caddy >/dev/null; then
  v=$(caddy version | sed -E 's/^v?([0-9]+)\.([0-9]+).*/\1 \2/')
  set -- $v
  if [ "${1:-0}" -gt 2 ] || { [ "${1:-0}" -eq 2 ] && [ "${2:-0}" -ge 8 ]; }; then need_caddy=0; fi
fi
if [ $need_caddy -eq 1 ]; then
  # Debian trae una versión de Caddy demasiado antigua: se instala la oficial desde GitHub.
  arch=$(dpkg --print-architecture)
  echo "==> Caddy $CADDY_VERSION ($arch)"
  tmp=$(mktemp -d)
  base="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}"
  deb="caddy_${CADDY_VERSION}_linux_${arch}.deb"
  curl -fsSL -o "$tmp/$deb" "$base/$deb"
  curl -fsSL -o "$tmp/sums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  # Se comprueba la suma publicada por Caddy antes de instalar.
  (cd "$tmp" && grep " ${deb}\$" sums.txt | sha512sum -c --quiet -) || { echo "La suma de comprobación de Caddy no coincide."; exit 1; }
  apt-get install -y -qq "$tmp/$deb" >/dev/null
  rm -rf "$tmp"
fi

echo "==> Usuario de servicio"
id tackboard >/dev/null 2>&1 || useradd --system --home /var/lib/tackboard --shell /usr/sbin/nologin tackboard
install -d -o tackboard -g tackboard -m 750 /var/lib/tackboard

if [ -f /var/lib/tackboard/tackboard.db ]; then
  BK=/var/lib/tackboard/antes-de-actualizar-$(date +%Y%m%d-%H%M%S).db
  python3 - /var/lib/tackboard/tackboard.db "$BK" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
with dst: src.backup(dst)
PY
  chown tackboard:tackboard "$BK"; chmod 600 "$BK"
  ls -1t /var/lib/tackboard/antes-de-actualizar-*.db 2>/dev/null | tail -n +4 | xargs -r rm -f
  echo "    Copia previa: $BK"
fi

echo "==> App en $WEB"
install -d -m 755 "$WEB"
find "$WEB" -mindepth 1 -delete
cp -r "$SRC/app/." "$WEB/"
chmod -R a+rX,go-w "$WEB"

echo "==> Backend en /opt/tackboard-api"
install -d -m 755 /opt/tackboard-api
install -m 755 "$SRC/backend/server.py" /opt/tackboard-api/server.py
install -m 644 "$SRC/deploy/tackboard-api.service" /etc/systemd/system/tackboard-api.service
install -m 755 "$SRC/deploy/tackboard-admin" /usr/local/bin/tackboard-admin
touch /etc/default/tackboard-api; chmod 640 /etc/default/tackboard-api
systemctl daemon-reload
systemctl enable -q tackboard-api
systemctl restart tackboard-api
sleep 2
if ! systemctl is-active --quiet tackboard-api; then
  # Algunos contenedores no permiten todas las protecciones de systemd: se relajan las que fallan.
  echo "    El servicio no arranca con todas las protecciones; probando en modo compatible…"
  install -d /etc/systemd/system/tackboard-api.service.d
  printf '[Service]\nProtectKernelTunables=no\nProtectKernelModules=no\nProtectControlGroups=no\nPrivateDevices=no\nProtectClock=no\nProtectKernelLogs=no\nProtectHostname=no\nProtectProc=default\nRestrictNamespaces=no\n' \
    > /etc/systemd/system/tackboard-api.service.d/compat.conf
  systemctl daemon-reload
  systemctl restart tackboard-api
  sleep 2
  systemctl is-active --quiet tackboard-api || { journalctl -u tackboard-api -n 30 --no-pager; exit 1; }
fi

echo "==> Caddy"
# Ajustes propios de Caddy (proxies de confianza): tackboard-admin proxy <ip>
touch /etc/default/tackboard-caddy; chmod 640 /etc/default/tackboard-caddy
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=-/etc/default/tackboard-caddy\n' > /etc/systemd/system/caddy.service.d/tackboard.conf
systemctl daemon-reload
# El Caddyfile no se sobrescribe si lo has cambiado (por ejemplo, para poner tu dominio).
SUMFILE=/etc/caddy/.tackboard-caddyfile.sha256
if [ -f "$SUMFILE" ] && ! sha256sum -c --quiet "$SUMFILE" 2>/dev/null; then
  install -m 644 "$SRC/deploy/Caddyfile" /etc/caddy/Caddyfile.tackboard-nuevo
  echo "    Has modificado /etc/caddy/Caddyfile: lo dejo como está."
  echo "    La versión nueva está en /etc/caddy/Caddyfile.tackboard-nuevo por si quieres comparar."
else
  if [ ! -f "$SUMFILE" ] && [ -f /etc/caddy/Caddyfile ]; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.antes-de-tackboard"
  fi
  install -m 644 "$SRC/deploy/Caddyfile" /etc/caddy/Caddyfile
  sha256sum /etc/caddy/Caddyfile > "$SUMFILE"
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable -q caddy
systemctl restart caddy
sleep 1

echo
echo "==> Comprobación"
curl -s -o /dev/null -w "  App vía Caddy        -> %{http_code}\n" http://127.0.0.1/
curl -s -o /dev/null -w "  API vía Caddy        -> %{http_code}\n" http://127.0.0.1/api/health
curl -sI http://127.0.0.1/ | grep -qi "content-security-policy" && echo "  Cabeceras de seguridad: OK" || echo "  AVISO: faltan las cabeceras de seguridad"
grep -q '^TB_OPERATOR_NAME=' /etc/default/tackboard-api || \
  echo '  AVISO: falta el responsable de la política de privacidad: tackboard-admin operator "Nombre" "contacto"'
grep -q '^TB_TRUSTED_PROXIES=' /etc/default/tackboard-caddy || \
  echo '  Si hay un proxy inverso delante, indícalo para ver las IP reales: tackboard-admin proxy <ip-del-proxy>'
grep -q '^TB_ALLOW_SIGNUP="\{0,1\}0' /etc/default/tackboard-api || \
  echo '  El registro está abierto. Cuando hayáis creado vuestras cuentas puedes cerrarlo: tackboard-admin signup off'
echo
/usr/local/bin/tackboard-admin users || true
echo "Listo."
