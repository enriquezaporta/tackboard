#!/bin/sh
# Arranca el backend y Caddy en el mismo contenedor. Si uno de los dos se para, el contenedor
# termina y Docker lo reinicia (restart: unless-stopped).
set -eu

python3 /opt/tackboard/server.py &
API=$!
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
WEB=$!

trap 'kill -TERM "$API" "$WEB" 2>/dev/null; wait; exit 0' TERM INT

while kill -0 "$API" 2>/dev/null && kill -0 "$WEB" 2>/dev/null; do
  sleep 2
done
echo "Uno de los procesos se ha parado; saliendo." >&2
kill -TERM "$API" "$WEB" 2>/dev/null || true
wait || true
exit 1
