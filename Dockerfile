# Tackboard: app, backend y Caddy en una sola imagen pequeña.
FROM caddy:2-alpine

RUN apk add --no-cache python3 py3-cryptography tini libcap \
 && setcap -r /usr/bin/caddy \
 && apk del libcap \
 && addgroup -S tackboard && adduser -S -D -H -G tackboard tackboard \
 && mkdir -p /data && chown tackboard:tackboard /data && chmod 700 /data

COPY app/ /srv/tackboard/
COPY backend/server.py /opt/tackboard/server.py
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY docker/entrypoint.sh /usr/local/bin/tackboard-entrypoint
COPY docker/tackboard-admin /usr/local/bin/tackboard-admin

ENV TB_DB=/data/tackboard.db \
    TB_WEB_ROOT=/srv/tackboard \
    TB_HTTP_PORT=8080 \
    TB_API_PORT=8000 \
    TB_PORT=8000 \
    TB_ALLOW_SIGNUP=1 \
    TB_OPERATOR_NAME="" \
    TB_OPERATOR_CONTACT="" \
    PYTHONUNBUFFERED=1 \
    XDG_DATA_HOME=/tmp/caddy \
    XDG_CONFIG_HOME=/tmp/caddy

USER tackboard
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "tackboard-entrypoint"]
