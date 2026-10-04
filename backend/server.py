#!/usr/bin/env python3
"""Tackboard: backend de cuentas, tableros compartidos y sincronización.

Solo usa la librería estándar de Python y SQLite. Escucha en 127.0.0.1 y va siempre detrás de un
proxy (Caddy) que pone el HTTPS, las cabeceras de seguridad y la cabecera X-Real-IP.

Endpoints. Todos salvo health, legal, register, login y recover piden "Authorization: Bearer <token>".

  GET  /api/health                              -> {ok, version, signup, policyVersion}
  GET  /api/legal                               -> responsable de esta instalación
  POST /api/auth/register  {username, name, password, consent}   -> {token, user, recoveryCode}
  POST /api/auth/login     {username, password}                  -> {token, user}
  POST /api/auth/recover   {username, code, password}            -> {token, user, recoveryCode}
  POST /api/auth/logout
  POST /api/auth/logout-others                  cierra las demás sesiones del usuario
  GET  /api/me                                  -> {user}
  POST /api/me             {name?, acceptInvites?, consent?}     -> {user}
  POST /api/me/password    {current, password}  -> {token}       (cierra las demás sesiones)
  POST /api/me/recovery    {password}           -> {recoveryCode}  (genera uno nuevo)
  POST /api/me/delete      {password}           elimina la cuenta y sus datos
  GET  /api/export                              todos los datos del usuario (JSON)

  POST /api/sync           {since, changes:[record]} -> {cursor, changes, boards, rejected, invitations, more}

  GET    /api/boards/<id>/members               miembros (y, para quien gestiona, invitaciones pendientes)
  POST   /api/boards/<id>/members  {username, role}      invitar (gestores)
  POST   /api/boards/<id>/members/<usuario> {role}       cambiar permiso (gestores)
  DELETE /api/boards/<id>/members/<usuario>              quitar a alguien (gestores) o salir (uno mismo)
  GET    /api/invitations                       invitaciones recibidas pendientes
  POST   /api/invitations/<boardId> {accept}    aceptar o rechazar

  GET  /api/push/key                            clave pública VAPID para suscribirse a avisos
  POST /api/push/subscribe   {endpoint, keys:{p256dh, auth}}
  POST /api/push/unsubscribe {endpoint}
  POST /api/push/test                           envía un aviso de prueba a los dispositivos del usuario
  GET  /api/push/prefs                          preferencias de avisos (silencio, resumen, títulos…)
  POST /api/push/prefs   {campos a cambiar}

Los avisos (Web Push) necesitan el paquete python3-cryptography. Sin él, el resto funciona igual.

Un "record" es {id, kind: board|column|card, boardId, updatedAt, deleted?, data}.

Permisos dentro de un tablero:
  read   (Lectura)    ve el tablero
  write  (Escritura)  además crea, edita, mueve y completa tarjetas
  admin  (Todo)       además gestiona columnas, etiquetas, datos del tablero y miembros
  owner  (Anfitrión)  todo lo anterior y además puede borrar el tablero. Solo hay uno.

Administración (en el servidor):  python3 server.py admin <orden>   (ver ADMIN_HELP)
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

VERSION = "1.1.2"
POLICY_VERSION = "2026-10"

DB_PATH = os.environ.get("TB_DB", "/var/lib/tackboard/tackboard.db")
HOST = os.environ.get("TB_HOST", "127.0.0.1")
PORT = int(os.environ.get("TB_PORT", "8000"))


def env_flag(name, default="1"):
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


PBKDF2_ITERS = 600_000
TOKEN_IDLE = 90 * 86400
TOKEN_MAX = 365 * 86400

MAX_BODY_SYNC = 8 * 1024 * 1024
MAX_BODY = 256 * 1024
MAX_CHANGES = 5000
PAGE = 2000

MAX_BOARDS_OWNED = 100
MAX_MEMBERSHIPS = 200
MAX_MEMBERS = 50
MAX_PENDING_INVITES = 20
MAX_COLUMNS = 50
MAX_CARDS = 5000
MAX_RECORD_BYTES = 32 * 1024          # un registro, en bytes UTF-8
MAX_BOARD_BYTES = 16 * 1024 * 1024    # todo el contenido de un tablero
PAGE_BYTES = 4 * 1024 * 1024          # tamaño máximo de una página de sincronización
MAX_THREADS = 128

ROLES = ("read", "write", "admin", "owner")
ROLE_RANK = {r: i for i, r in enumerate(ROLES)}

USERNAME_RE = re.compile(r"^[a-z0-9_.-]{3,30}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
SHORT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
TZ_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$")
# Recordatorios posibles en una tarjeta: minutos antes del momento de referencia.
REMINDERS = {"2d": 2880, "1d": 1440, "3h": 180, "1h": 60, "15m": 15, "due": 0}
# Caracteres de control y de dirección de texto (permiten engañar en pantalla o en la terminal).
CONTROL_RE = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
CONTROL_LINE_RE = re.compile("[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]")


def now():
    return int(time.time())


def clean_name(v, maxlen=60):
    """Nombre visible: sin caracteres de control ni de dirección de texto."""
    return CONTROL_LINE_RE.sub("", str(v or "")).strip()[:maxlen]


def now_ms():
    return int(time.time() * 1000)


# ----------------------------------------------------------------------------------------------------
# Base de datos
# ----------------------------------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  recovery_hash TEXT,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  policy_version TEXT,
  policy_accepted_at INTEGER,
  accept_invites INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
CREATE TABLE IF NOT EXISTS members (
  board_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  invited_by INTEGER,
  created_at INTEGER NOT NULL,
  joined_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT,
  updated_at INTEGER NOT NULL,
  server_ts INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS records_board_ts ON records(board_id, server_ts);
CREATE INDEX IF NOT EXISTS records_ts ON records(server_ts);
-- Suscripciones a avisos push (una por dispositivo).
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok INTEGER,
  token_hash TEXT,
  fails INTEGER NOT NULL DEFAULT 0,
  fail_since INTEGER
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
-- Preferencias de avisos de cada usuario.
CREATE TABLE IF NOT EXISTS notify_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
-- Avisos ya programados o enviados (evita repetirlos). Se limpian a los pocos días.
CREATE TABLE IF NOT EXISTS notify_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  deliver_at INTEGER NOT NULL,
  state INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  UNIQUE (user_id, card_id, kind, fire_at)
);
CREATE INDEX IF NOT EXISTS notify_log_pending ON notify_log(state, deliver_at);
-- Ajustes internos (claves VAPID).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Identificadores de tableros borrados: impiden que un cliente desfasado los vuelva a crear.
CREATE TABLE IF NOT EXISTS deleted_boards (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
"""


class Store:
    """Acceso a SQLite. Una sola conexión protegida por un candado: es una app pequeña y así
    las marcas de servidor (server_ts) nunca se cruzan con escrituras sin confirmar."""

    def __init__(self, path):
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.executescript(SCHEMA)
        # Migraciones de versiones anteriores.
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(push_subs)")}
        if "token_hash" not in cols:
            self.db.execute("ALTER TABLE push_subs ADD COLUMN token_hash TEXT")
        if "fails" not in cols:
            self.db.execute("ALTER TABLE push_subs ADD COLUMN fails INTEGER NOT NULL DEFAULT 0")
        if "fail_since" not in cols:
            self.db.execute("ALTER TABLE push_subs ADD COLUMN fail_since INTEGER")
        if "sent_at" not in {r[1] for r in self.db.execute("PRAGMA table_info(notify_log)")}:
            self.db.execute("ALTER TABLE notify_log ADD COLUMN sent_at INTEGER")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        r = self.db.execute(
            "SELECT MAX(m) FROM (SELECT MAX(server_ts) m FROM records UNION ALL SELECT MAX(joined_ts) FROM members)"
        ).fetchone()
        self.ts = r[0] or 0

    def next_ts(self):
        self.ts += 1
        return self.ts

    def q(self, sql, args=()):
        return self.db.execute(sql, args).fetchall()

    def one(self, sql, args=()):
        return self.db.execute(sql, args).fetchone()

    def x(self, sql, args=()):
        return self.db.execute(sql, args)


# ----------------------------------------------------------------------------------------------------
# Contraseñas, tokens y códigos
# ----------------------------------------------------------------------------------------------------

def hash_password(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITERS)
    return "pbkdf2_sha256$%d$%s$%s" % (PBKDF2_ITERS, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def check_password(pw, stored):
    try:
        algo, iters, salt, dk = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(salt), int(iters))
        return hmac.compare_digest(calc, base64.b64decode(dk))
    except Exception:
        return False


_DUMMY_HASH = None


def dummy_check(pw):
    """Gasta el mismo tiempo que una comprobación real, para no delatar si un usuario existe."""
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password("x" * 12)
    check_password(pw, _DUMMY_HASH)


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def new_recovery_code():
    raw = base64.b32encode(secrets.token_bytes(10)).decode()  # 80 bits, 16 caracteres
    return "-".join(raw[i:i + 4] for i in range(0, 16, 4))


def norm_code(code):
    return re.sub(r"[^A-Z2-7]", "", (code or "").upper())


# ----------------------------------------------------------------------------------------------------
# Límite de intentos (en memoria, con tamaño acotado)
# ----------------------------------------------------------------------------------------------------

class RateLimiter:
    """Ventana deslizante por clave. Las claves caducan con la ventana (nada se guarda más tiempo) y,
    si hay demasiadas, se descartan las más antiguas, nunca todas a la vez."""

    def __init__(self, limit, window, max_keys=20000):
        self.limit, self.window, self.max_keys = limit, window, max_keys
        self.hits = OrderedDict()
        self.lock = threading.Lock()
        self.last_purge = 0.0

    def _recent(self, key, t):
        return [x for x in self.hits.get(key, ()) if x > t - self.window]

    def _purge(self, t):
        if t - self.last_purge < 30 and len(self.hits) <= self.max_keys:
            return
        self.last_purge = t
        cutoff = t - self.window
        # Las claves están ordenadas por último uso: se quitan por delante mientras estén caducadas.
        while self.hits:
            k, v = next(iter(self.hits.items()))
            if v and v[-1] > cutoff and len(self.hits) <= self.max_keys:
                break
            self.hits.popitem(last=False)

    def count(self, key):
        t = time.monotonic()
        with self.lock:
            return len(self._recent(key, t))

    def blocked(self, key):
        return self.count(key) >= self.limit

    def hit(self, key):
        """Cuenta un intento. Devuelve False si se ha superado el límite."""
        t = time.monotonic()
        with self.lock:
            self._purge(t)
            lst = self._recent(key, t)
            if len(lst) >= self.limit:
                return False
            lst.append(t)
            self.hits[key] = lst
            self.hits.move_to_end(key)
            return True

    def clear(self):
        with self.lock:
            self.hits.clear()


AUTH_IP = RateLimiter(20, 900)          # intentos de entrar/recuperar por IP
FAIL_USER_IP = RateLimiter(10, 900)     # fallos por usuario e IP
FAIL_USER = RateLimiter(50, 900)        # fallos por usuario desde cualquier IP (ataques repartidos)
RECOVER_USER = RateLimiter(10, 900)     # recuperaciones por usuario
SIGNUP_IP = RateLimiter(5, 3600)
ACCOUNT_PW = RateLimiter(10, 900)       # comprobaciones de contraseña ya dentro (cambiar, borrar…)
INVITE_USER = RateLimiter(30, 3600)
ACCEPT_BOARD = RateLimiter(10, 86400)   # altas por tablero y día (cada alta hace que los miembros lo descarguen)
API_TOKEN = RateLimiter(600, 60)        # peticiones por sesión
BAD_TOKEN_IP = RateLimiter(60, 300)     # tokens no válidos por IP
LIMITERS = (AUTH_IP, FAIL_USER_IP, FAIL_USER, RECOVER_USER, SIGNUP_IP, ACCOUNT_PW, INVITE_USER, ACCEPT_BOARD, API_TOKEN, BAD_TOKEN_IP)


# ----------------------------------------------------------------------------------------------------
# Validación de registros
# ----------------------------------------------------------------------------------------------------

class Invalid(Exception):
    pass


def v_str(v, maxlen, field, allow_empty=True, multiline=False):
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise Invalid(field)
    v = (CONTROL_RE if multiline else CONTROL_LINE_RE).sub("", v)
    if len(v) > maxlen or (not allow_empty and not v.strip()):
        raise Invalid(field)
    return v


def v_num(v, field, lo=-1e15, hi=1e15):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or not (lo <= v <= hi):
        raise Invalid(field)
    return v


def v_int_or_none(v, field, lo, hi):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
        raise Invalid(field)
    return v


def v_bool(v, field):
    if v is None:
        return False
    if not isinstance(v, bool):
        raise Invalid(field)
    return v


def v_color(v, field, default="#0E6B62"):
    if v is None:
        return default
    if not isinstance(v, str) or not COLOR_RE.match(v):
        raise Invalid(field)
    return v.upper()


def v_ref(v, field, allow_none=True):
    if v is None or v == "":
        if allow_none:
            return None
        raise Invalid(field)
    if not isinstance(v, str) or not ID_RE.match(v):
        raise Invalid(field)
    return v


def v_date(v, field):
    if v in (None, ""):
        return ""
    if not isinstance(v, str) or not DATE_RE.match(v):
        raise Invalid(field)
    try:
        time.strptime(v, "%Y-%m-%d")
    except ValueError:
        raise Invalid(field)
    return v


def v_time(v, field):
    if v in (None, ""):
        return ""
    if not isinstance(v, str) or not TIME_RE.match(v):
        raise Invalid(field)
    return v


def clean_board(d):
    labels = d.get("labels") or []
    if not isinstance(labels, list) or len(labels) > 30:
        raise Invalid("labels")
    out_labels = []
    for lb in labels:
        if not isinstance(lb, dict):
            raise Invalid("labels")
        lid = lb.get("id")
        if not isinstance(lid, str) or not SHORT_ID_RE.match(lid):
            raise Invalid("labels")
        out_labels.append({"id": lid, "name": v_str(lb.get("name"), 40, "labels"), "color": v_color(lb.get("color"), "labels")})
    return {
        "name": v_str(d.get("name"), 80, "name", allow_empty=False),
        "color": v_color(d.get("color"), "color"),
        "labels": out_labels,
        "pos": v_num(d.get("pos", 0), "pos"),
    }


def clean_column(d):
    return {
        "name": v_str(d.get("name"), 60, "name", allow_empty=False),
        "pos": v_num(d.get("pos", 0), "pos"),
        "wip": v_int_or_none(d.get("wip"), "wip", 1, 999),
        "isDone": v_bool(d.get("isDone"), "isDone"),
    }


def clean_card(d):
    prio = d.get("priority") or ""
    if prio not in ("", "low", "medium", "high"):
        raise Invalid("priority")
    labels = d.get("labels") or []
    if not isinstance(labels, list) or len(labels) > 30 or not all(isinstance(x, str) and SHORT_ID_RE.match(x) for x in labels):
        raise Invalid("labels")
    checklist = d.get("checklist") or []
    if not isinstance(checklist, list) or len(checklist) > 100:
        raise Invalid("checklist")
    out_check = []
    for it in checklist:
        if not isinstance(it, dict):
            raise Invalid("checklist")
        iid = it.get("id")
        if not isinstance(iid, str) or not SHORT_ID_RE.match(iid):
            raise Invalid("checklist")
        out_check.append({"id": iid, "text": v_str(it.get("text"), 300, "checklist"), "done": v_bool(it.get("done"), "checklist")})
    due = v_date(d.get("due"), "due")
    due_time = v_time(d.get("dueTime"), "dueTime") if due else ""
    due_at = v_int_or_none(d.get("dueAt"), "dueAt", 0, 10 ** 14) if due else None
    alert_base = v_int_or_none(d.get("alertBase"), "alertBase", 0, 10 ** 14) if due else None
    if due:
        y, mo, dd = (int(x) for x in due.split("-"))
        hh, mm = (int(x) for x in due_time.split(":")) if due_time else (23, 59)
        nominal = int(datetime(y, mo, dd, hh, mm, tzinfo=timezone.utc).timestamp() * 1000)
        if due_at is not None and abs(due_at - nominal) > 14 * 3600_000:
            raise Invalid("dueAt")
        if alert_base is not None:
            if due_time and due_at is not None and alert_base != due_at:
                raise Invalid("alertBase")
            nominal_alert = nominal if due_time else int(datetime(y, mo, dd, 9, 0, tzinfo=timezone.utc).timestamp() * 1000)
            if abs(alert_base - nominal_alert) > 14 * 3600_000:
                raise Invalid("alertBase")
    reminders = d.get("reminders")
    if reminders is not None:
        if not isinstance(reminders, list) or len(reminders) > len(REMINDERS) or \
                not all(isinstance(x, str) and x in REMINDERS for x in reminders):
            raise Invalid("reminders")
        reminders = [k for k in REMINDERS if k in reminders]  # orden fijo y sin repetidos
    return {
        "columnId": v_ref(d.get("columnId"), "columnId", allow_none=False),
        "title": v_str(d.get("title"), 200, "title", allow_empty=False),
        "description": v_str(d.get("description"), 10000, "description", multiline=True),
        "start": v_date(d.get("start"), "start"),
        "due": due,
        "dueTime": due_time,
        "dueAt": due_at,
        # Momento de referencia para los avisos: la hora de vencimiento o, si es de todo el día, las 9:00 de ese día.
        "alertBase": alert_base,
        "reminders": reminders,
        "priority": prio,
        "labels": list(dict.fromkeys(labels)),
        "checklist": out_check,
        "pos": v_num(d.get("pos", 0), "pos"),
        "done": v_bool(d.get("done"), "done"),
        "doneAt": v_int_or_none(d.get("doneAt"), "doneAt", 0, 10 ** 14),
        "archived": v_bool(d.get("archived"), "archived"),
    }


CLEANERS = {"board": clean_board, "column": clean_column, "card": clean_card}


# ----------------------------------------------------------------------------------------------------
# Avisos push (Web Push: RFC 8030, cifrado RFC 8291, identificación VAPID RFC 8292)
# ----------------------------------------------------------------------------------------------------

try:  # opcional: sin la librería, los avisos quedan desactivados
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    PUSH_AVAILABLE = True
except ImportError:  # pragma: no cover
    PUSH_AVAILABLE = False

# Solo se envían avisos a los servicios de los navegadores conocidos (evita usar el servidor para
# hacer peticiones a direcciones arbitrarias).
PUSH_HOSTS = re.compile(
    r"^(web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|fcm\.googleapis\.com|"
    r"updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)$")
MAX_SUBS_PER_USER = 10
PUSH_TEST = RateLimiter(5, 60)


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_dec(s):
    s = str(s)
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _hmac(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


class Vapid:
    """Par de claves P-256 de esta instalación. Se crea la primera vez y se guarda en la base de datos."""

    def __init__(self, store):
        with store.lock:
            row = store.one("SELECT value FROM settings WHERE key='vapid_private'")
            if row:
                self.key = serialization.load_pem_private_key(row["value"].encode(), password=None)
            else:
                self.key = ec.generate_private_key(ec.SECP256R1())
                pem = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                             serialization.NoEncryption()).decode()
                store.x("INSERT INTO settings(key,value) VALUES('vapid_private',?)", (pem,))
        self.public_raw = self.key.public_key().public_bytes(serialization.Encoding.X962,
                                                             serialization.PublicFormat.UncompressedPoint)
        self.public = b64u(self.public_raw)

    def header(self, endpoint, subject):
        u = urlparse(endpoint)
        claims = {"aud": "%s://%s" % (u.scheme, u.netloc), "exp": now() + 12 * 3600, "sub": subject}
        signing = (b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode()) + "." +
                   b64u(json.dumps(claims, separators=(",", ":")).encode()))
        r, s_ = decode_dss_signature(self.key.sign(signing.encode(), ec.ECDSA(hashes.SHA256())))
        jwt = signing + "." + b64u(r.to_bytes(32, "big") + s_.to_bytes(32, "big"))
        return "vapid t=%s, k=%s" % (jwt, self.public)


def encrypt_push(payload, p256dh, auth):
    """Cifra el contenido para un dispositivo (aes128gcm, un solo registro)."""
    ua_public = b64u_dec(p256dh)
    auth_secret = b64u_dec(auth)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    as_key = ec.generate_private_key(ec.SECP256R1())
    as_public = as_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ecdh = as_key.exchange(ec.ECDH(), ua_key)
    prk_key = _hmac(auth_secret, ecdh)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    salt = secrets.token_bytes(16)
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    body = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + (4096).to_bytes(4, "big") + bytes([len(as_public)]) + as_public + body


import urllib.error  # noqa: E402
import urllib.request  # noqa: E402


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Un servicio de avisos nunca redirige: si lo hace, se trata como fallo (y no se sigue a otra dirección)."""

    def redirect_request(self, *a, **kw):
        return None


_PUSH_OPENER = urllib.request.build_opener(_NoRedirect)
PUSH_TIMEOUT = 5
SUB_MAX_FAILS = 5
SUB_FAIL_WINDOW = 3 * 86400          # s: una suscripción se borra si lleva 3 días fallando (y al menos 5 fallos)


def send_push(vapid, sub, payload, subject, ttl=3600, urgency="normal", opener=None):
    """Envía un aviso. Devuelve el código HTTP del servicio (201 = aceptado; 404/410 = suscripción caducada;
    0 = sin respuesta)."""
    data = encrypt_push(json.dumps(payload, ensure_ascii=False).encode(), sub["p256dh"], sub["auth"])
    req = urllib.request.Request(sub["endpoint"], data=data, method="POST", headers={
        "TTL": str(ttl), "Urgency": urgency, "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream", "Authorization": vapid.header(sub["endpoint"], subject)})
    try:
        with (opener or _PUSH_OPENER.open)(req, timeout=PUSH_TIMEOUT) as res:
            return res.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def send_to_subs(store, vapid, subs, payload, subject, opener=None, ttl=6 * 3600, urgency="high"):
    """Envía a varios dispositivos a la vez y actualiza su estado: los caducados (404/410) se borran, y los que
    llevan más de SUB_FAIL_WINDOW fallando (con al menos SUB_MAX_FAILS fallos), también. Así un corte de red
    corto no borra suscripciones buenas. Devuelve [(sub, status)]."""
    from concurrent.futures import ThreadPoolExecutor
    if not subs:
        return []
    with ThreadPoolExecutor(max_workers=min(5, len(subs))) as ex:
        statuses = list(ex.map(lambda sb: send_push(vapid, sb, payload, subject, ttl, urgency, opener), subs))
    t = now()
    with store.lock:
        for sb, st in zip(subs, statuses):
            since = sb.get("fail_since")
            if st in (404, 410) or (not 200 <= st < 300 and st != 429 and since is not None
                                    and t - since >= SUB_FAIL_WINDOW and (sb.get("fails") or 0) + 1 >= SUB_MAX_FAILS):
                store.x("DELETE FROM push_subs WHERE id=?", (sb["id"],))
            elif 200 <= st < 300:
                store.x("UPDATE push_subs SET last_ok=?, fails=0, fail_since=NULL WHERE id=?", (t, sb["id"]))
            elif st != 429:
                store.x("UPDATE push_subs SET fails=fails+1, fail_since=COALESCE(fail_since, ?) WHERE id=?", (t, sb["id"]))
    return list(zip(subs, statuses))


def active_subs(store, uid):
    """Dispositivos de un usuario cuya sesión sigue abierta y cuya cuenta está activa."""
    return [dict(r) for r in store.q(
        """SELECT s.* FROM push_subs s JOIN tokens t ON t.hash=s.token_hash JOIN users u ON u.id=s.user_id
           WHERE s.user_id=? AND u.disabled=0""", (uid,))]


def norm_endpoint(u):
    """Forma canónica de la dirección de suscripción (la misma al darse de alta y de baja)."""
    path = u.path or "/"
    if u.params:
        path += ";" + u.params
    return "https://%s%s%s" % (u.hostname.lower(), path, ("?" + u.query) if u.query else "")


def valid_subscription(body):
    endpoint = body.get("endpoint")
    keys = body.get("keys") if isinstance(body.get("keys"), dict) else {}
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not isinstance(endpoint, str) or len(endpoint) > 1024 or not endpoint.startswith("https://"):
        raise ApiError(400, "push_endpoint")
    try:
        u = urlparse(endpoint)
        port = u.port
    except ValueError:
        raise ApiError(400, "push_endpoint")
    # Solo https al puerto 443, sin usuario ni contraseña y con un nombre de servidor conocido.
    if u.scheme != "https" or u.username or u.password or "@" in u.netloc or port not in (None, 443) \
            or not re.match(r"^[A-Za-z0-9.-]+(:443)?$", u.netloc) or not PUSH_HOSTS.match((u.hostname or "").lower()) \
            or re.search(r"[\s\\#]", endpoint):
        raise ApiError(400, "push_endpoint")
    endpoint = norm_endpoint(u)
    try:
        if len(b64u_dec(p256dh)) != 65 or len(b64u_dec(auth)) != 16:
            raise ValueError
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64u_dec(p256dh))
    except Exception:
        raise ApiError(400, "push_keys")
    return endpoint, p256dh, auth


# ----------------------------------------------------------------------------------------------------
# Preferencias de avisos y planificador
# ----------------------------------------------------------------------------------------------------

DEFAULT_PREFS = {
    "enabled": True,                 # recibir avisos en mis dispositivos
    "defaultReminders": ["1h"],      # recordatorio que se pone al dar fecha a una tarjeta
    "quiet": {"on": False, "start": "23:00", "end": "08:00"},
    "digest": {"on": False, "time": "08:00"},
    "showTitles": False,             # mostrar el título de la tarea en el aviso
    "mutedBoards": [],               # tableros silenciados
    "tz": "UTC",
}
LATE_LIMIT_MS = 12 * 3600 * 1000     # un aviso que no se pudo entregar en 12 h ya no se envía
REPEAT_GAP_MS = 30 * 60 * 1000       # el mismo recordatorio de la misma tarjeta, como mucho cada 30 min
BOARD_HOURLY_CAP = 20                # avisos sueltos por persona, tablero y hora
USER_HOURLY_CAP = 40                 # avisos sueltos por persona y hora, sumando todos los tableros
USER_TICK_CAP = 10                   # avisos sueltos por persona en cada revisión
SUMMARY_GAP_MS = 10 * 60 * 1000      # lo que pase de los topes se agrupa en un aviso-resumen, como mucho cada 10 min
SCHEDULE_TICK_CAP = 5000             # avisos nuevos programados por revisión; el resto, en la siguiente (no se pierden)
DIGEST_GAP_MS = 20 * 3600 * 1000
SCAN_BACKLOG_MS = 30 * 60 * 1000     # tras un reinicio, se recuperan los avisos de los últimos 30 min
MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
             "octubre", "noviembre", "diciembre"]
DOW_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def get_tz(name):
    if ZoneInfo and isinstance(name, str) and TZ_RE.match(name):
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return timezone.utc


def load_prefs(store, uid):
    row = store.one("SELECT data FROM notify_prefs WHERE user_id=?", (uid,))
    prefs = json.loads(json.dumps(DEFAULT_PREFS))
    if row:
        try:
            saved = json.loads(row["data"])
            for k in DEFAULT_PREFS:
                if k in saved:
                    prefs[k] = saved[k]
            prefs["lastDigest"] = saved.get("lastDigest", "")
            prefs["lastDigestAt"] = saved.get("lastDigestAt", 0)
        except ValueError:
            pass
    return prefs


def save_prefs(store, uid, prefs):
    store.x("INSERT INTO notify_prefs(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data",
            (uid, json.dumps(prefs, separators=(",", ":"))))


def clean_prefs(body, prefs):
    """Aplica a `prefs` los campos válidos de `body`. Lanza ApiError si alguno no lo es."""
    out = json.loads(json.dumps(prefs))
    if "enabled" in body:
        out["enabled"] = body["enabled"] is True
    if "showTitles" in body:
        out["showTitles"] = body["showTitles"] is True
    if "defaultReminders" in body:
        r = body["defaultReminders"]
        if not isinstance(r, list) or not all(isinstance(x, str) and x in REMINDERS for x in r):
            raise ApiError(400, "prefs")
        out["defaultReminders"] = [k for k in REMINDERS if k in r]
    for key, fields in (("quiet", ("start", "end")), ("digest", ("time",))):
        if key in body:
            v = body[key]
            if not isinstance(v, dict):
                raise ApiError(400, "prefs")
            cur = dict(out[key])
            if "on" in v:
                cur["on"] = v["on"] is True
            for f in fields:
                if f in v:
                    if not isinstance(v[f], str) or not TIME_RE.match(v[f]):
                        raise ApiError(400, "prefs")
                    cur[f] = v[f]
            out[key] = cur
    if "mutedBoards" in body:
        m = body["mutedBoards"]
        if not isinstance(m, list) or len(m) > MAX_MEMBERSHIPS or not all(isinstance(x, str) and ID_RE.match(x) for x in m):
            raise ApiError(400, "prefs")
        out["mutedBoards"] = list(dict.fromkeys(m))
    if "tz" in body:
        tz = body["tz"]
        if not isinstance(tz, str) or not TZ_RE.match(tz) or get_tz(tz) is timezone.utc and tz not in ("UTC", "Etc/UTC"):
            raise ApiError(400, "prefs")
        out["tz"] = tz
    return out


def _hm(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def quiet_deliver(fire_ms, prefs):
    """Si `fire_ms` cae en el horario de silencio, devuelve el final de ese silencio; si no, `fire_ms`."""
    q = prefs.get("quiet") or {}
    if not q.get("on"):
        return fire_ms
    tz = get_tz(prefs.get("tz"))
    local = datetime.fromtimestamp(fire_ms / 1000, tz)
    mins = local.hour * 60 + local.minute
    start, end = _hm(q.get("start", "23:00")), _hm(q.get("end", "08:00"))
    if start == end:
        return fire_ms
    inside = (start <= mins < end) if start < end else (mins >= start or mins < end)
    if not inside:
        return fire_ms
    day = local.date()
    if start > end and mins >= start:  # el silencio cruza la medianoche: termina mañana
        day = day + timedelta(days=1)
    end_dt = datetime(day.year, day.month, day.day, end // 60, end % 60, tzinfo=tz)
    return int(end_dt.timestamp() * 1000)


def due_text(card, now_ms, tz):
    """Texto relativo del vencimiento ("vence en 15 min", "vence mañana a las 10:00", "ha vencido"…)."""
    now = datetime.fromtimestamp(now_ms / 1000, tz)
    try:
        y, m, d = (int(x) for x in card["due"].split("-"))
        due_day = datetime(y, m, d, tzinfo=tz).date()
    except Exception:
        return "vence pronto"
    days = (due_day - now.date()).days
    if not card.get("dueTime"):
        if days < 0:
            return "ha vencido"
        if days == 0:
            return "vence hoy"
        if days == 1:
            return "vence mañana"
        return "vence el %s %d" % (DOW_ES[due_day.weekday()], due_day.day)
    diff = round((card.get("dueAt") or now_ms) - now_ms) / 60000
    hhmm = card["dueTime"]
    if diff <= 0:
        return "ha vencido" if diff > -5 else "venció a las %s" % hhmm
    if diff < 60:
        return "vence en %d min" % max(1, round(diff))
    if days == 0:
        return "vence hoy a las %s" % hhmm
    if days == 1:
        return "vence mañana a las %s" % hhmm
    return "vence el %d de %s a las %s" % (due_day.day, MONTHS_ES[due_day.month - 1], hhmm)


class Notifier:
    """Revisa cada medio minuto qué recordatorios tocan, los programa (respetando el silencio de cada
    persona) y los envía una sola vez. También manda el resumen diario."""

    def __init__(self, app):
        self.app = app
        self.s = app.s
        self.last_cleanup = 0
        self.last_summary = {}  # uid -> último resumen (en memoria: tras reiniciar, como mucho uno de más)

    def subs(self, uid):
        return active_subs(self.s, uid)

    def tick(self, now_ms=None):
        now_ms = now_ms or now_ms_()
        outbox = []  # (uid, payload)
        with self.s.lock:
            self.s.x("BEGIN IMMEDIATE")
            try:
                self.schedule(now_ms)
                outbox += self.collect(now_ms)
                outbox += self.digests(now_ms)
                if now_ms - self.last_cleanup > 3600_000:
                    self.s.x("DELETE FROM notify_log WHERE deliver_at < ?", (now_ms - 3 * 86400_000,))
                    # Suscripciones de sesiones que ya no existen.
                    self.s.x("DELETE FROM push_subs WHERE token_hash IS NULL OR token_hash NOT IN (SELECT hash FROM tokens)")
                    self.last_cleanup = now_ms
                self.s.x("COMMIT")
            except Exception:
                self.s.x("ROLLBACK")
                raise
        sent = 0
        for uid, payload in outbox:
            sent += self.deliver(uid, payload)
        return sent

    def schedule(self, now_ms):
        row = self.s.one("SELECT value FROM settings WHERE key='notify_scan'")
        last = int(row["value"]) if row else now_ms - 60_000
        start = max(last, now_ms - SCAN_BACKLOG_MS)
        max_off = max(REMINDERS.values()) * 60000
        rows = self.s.q(
            """SELECT id, board_id, data FROM records WHERE kind='card' AND deleted=0
               AND json_extract(data,'$.alertBase') > ? AND json_extract(data,'$.alertBase') <= ?""",
            (start, now_ms + max_off))
        fires = []  # (momento, tarjeta, tablero, recordatorio)
        for r in rows:
            d = json.loads(r["data"])
            if d.get("done") or d.get("archived") or not d.get("reminders") or not d.get("alertBase"):
                continue
            for k in d["reminders"]:
                f = d["alertBase"] - REMINDERS[k] * 60000
                if start < f <= now_ms:
                    fires.append((f, r["id"], r["board_id"], k))
        fires.sort()
        has_subs = {r["user_id"] for r in self.s.q(
            """SELECT DISTINCT s.user_id FROM push_subs s JOIN tokens t ON t.hash=s.token_hash
               JOIN users u ON u.id=s.user_id WHERE u.disabled=0""")}
        prefs_cache, members_cache = {}, {}
        created, cursor = 0, now_ms
        for fire, cid, bid, kind in fires:
            if created >= SCHEDULE_TICK_CAP:
                # Demasiados de golpe: se sigue en la siguiente revisión desde aquí. Los ya programados se
                # ignoran (UNIQUE), así que siempre se avanza.
                cursor = fire - 1
                break
            if bid not in members_cache:
                members_cache[bid] = [m["user_id"] for m in self.s.q(
                    "SELECT user_id FROM members WHERE board_id=? AND status='active'", (bid,))]
            for uid in members_cache[bid]:
                if uid not in has_subs:
                    continue
                if uid not in prefs_cache:
                    prefs_cache[uid] = load_prefs(self.s, uid)
                p = prefs_cache[uid]
                if not p["enabled"] or bid in p["mutedBoards"]:
                    continue
                # Si la fecha cambia una y otra vez, el mismo recordatorio no se envía más de una vez cada 30 min.
                if self.s.one("""SELECT 1 FROM notify_log WHERE user_id=? AND card_id=? AND kind=? AND state IN (1,5)
                                 AND fire_at>? AND fire_at<>?""", (uid, cid, kind, fire - REPEAT_GAP_MS, fire)):
                    continue
                cur = self.s.x("""INSERT OR IGNORE INTO notify_log(user_id,card_id,kind,fire_at,deliver_at,state)
                                  VALUES(?,?,?,?,?,0)""", (uid, cid, kind, fire, quiet_deliver(fire, p)))
                created += cur.rowcount
        self.s.x("INSERT INTO settings(key,value) VALUES('notify_scan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (str(cursor),))

    def collect(self, now_ms):
        """Avisos programados que ya tocan. Se comprueba de nuevo que siguen siendo válidos. Nunca se pierde uno
        en silencio: lo que pase de los topes por tablero y por persona se agrupa en un aviso-resumen."""
        out = []
        # Por turnos: como mucho 500 por persona en cada revisión, para que nadie acapare el trabajo.
        pending = self.s.q("""SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY deliver_at) AS rn
                                FROM notify_log WHERE state=0 AND deliver_at<=?) WHERE rn<=500 ORDER BY deliver_at LIMIT 5000""",
                           (now_ms,))
        prefs, ok_user, member = {}, {}, {}
        valid = {}  # uid -> [(fila, tablero, datos)]
        for n in pending:
            uid = n["user_id"]
            if uid not in prefs:
                prefs[uid] = load_prefs(self.s, uid)
                row = self.s.one("SELECT disabled FROM users WHERE id=?", (uid,))
                ok_user[uid] = row is not None and not row["disabled"]
            p = prefs[uid]
            rec = self.s.one("SELECT board_id, data FROM records WHERE id=? AND kind='card' AND deleted=0", (n["card_id"],))
            state = 2
            if now_ms - n["deliver_at"] > LATE_LIMIT_MS:
                state = 3
            elif rec and ok_user[uid] and p["enabled"] and rec["board_id"] not in p["mutedBoards"]:
                d = json.loads(rec["data"])
                key = (uid, rec["board_id"])
                if key not in member:
                    member[key] = bool(self.s.one("SELECT 1 FROM members WHERE board_id=? AND user_id=? AND status='active'", key[::-1]))
                if (member[key] and not d.get("done") and not d.get("archived") and n["kind"] in (d.get("reminders") or [])
                        and d.get("alertBase") and d["alertBase"] - REMINDERS[n["kind"]] * 60000 == n["fire_at"]):
                    valid.setdefault(uid, []).append((n, rec["board_id"], d))
                    continue
            self.s.x("UPDATE notify_log SET state=? WHERE id=?", (state, n["id"]))
        for uid, items in valid.items():
            out += self.deliver_user(uid, items, prefs[uid], now_ms)
        return out

    def deliver_user(self, uid, items, p, now_ms):
        """Reparte los avisos de una persona: sueltos hasta los topes (por turnos entre tableros) y el resto en un resumen."""
        out = []
        per_board = {r["board_id"]: r["c"] for r in self.s.q(
            """SELECT r.board_id, COUNT(*) AS c FROM notify_log n JOIN records r ON r.id=n.card_id
               WHERE n.user_id=? AND n.state=1 AND n.sent_at>? GROUP BY r.board_id""", (uid, now_ms - 3600_000))}
        total = sum(per_board.values())
        # Por turnos entre tableros: un tablero con muchas tarjetas (por ejemplo, de otra persona) no tapa a los demás.
        queues = {}
        for it in items:
            queues.setdefault(it[1], []).append(it)
        order = []
        while queues:
            for bid in list(queues):
                order.append(queues[bid].pop(0))
                if not queues[bid]:
                    del queues[bid]
        # Dentro de los topes por hora: sueltos (los que no caben en esta revisión esperan a la siguiente, 30 s).
        # Fuera de los topes: al resumen.
        single, rest = [], []
        for it in order:
            bid = it[1]
            if total < USER_HOURLY_CAP and per_board.get(bid, 0) < BOARD_HOURLY_CAP:
                per_board[bid] = per_board.get(bid, 0) + 1
                total += 1
                if len(single) < USER_TICK_CAP:
                    single.append(it)
            else:
                rest.append(it)
        tz = get_tz(p["tz"])
        for n, bid, d in single:
            self.s.x("UPDATE notify_log SET state=1, sent_at=? WHERE id=?", (now_ms, n["id"]))
            text = due_text(d, now_ms, tz)
            if p["showTitles"]:
                bname = self.app.board_name(bid)[0] or "Tackboard"
                payload = {"title": bname, "body": "«%s» %s" % (d["title"][:120], text)}
            else:
                payload = {"title": "Tackboard", "body": "Tienes una tarea que %s" % text}
            payload.update({"tag": "card-" + n["card_id"], "url": "/#/tarjeta/" + n["card_id"]})
            out.append((uid, payload))
        # El resto se agrupa. Si hace poco que se mandó un resumen, esperan en cola al siguiente (no se pierden).
        if rest and now_ms - self.last_summary.get(uid, 0) >= SUMMARY_GAP_MS:
            self.last_summary[uid] = now_ms
            for n, _, _ in rest:
                self.s.x("UPDATE notify_log SET state=5, sent_at=? WHERE id=?", (now_ms, n["id"]))
            cards = len({n["card_id"] for n, _, _ in rest})
            boards = {bid for _, bid, _ in rest}
            what = "1 tarea más" if cards == 1 else "%d tareas más" % cards
            body = "Tienes %s que %s pronto o ya ha%s vencido." % (what, "vence" if cards == 1 else "vencen",
                                                                  "" if cards == 1 else "n")
            title = "Tackboard"
            if p["showTitles"] and len(boards) == 1:
                title = self.app.board_name(next(iter(boards)))[0] or "Tackboard"
            out.append((uid, {"title": title, "body": body, "tag": "tackboard-summary", "url": "/#/hoy"}))
        return out

    def digests(self, now_ms):
        out = []
        for r in self.s.q("SELECT user_id FROM notify_prefs"):
            uid = r["user_id"]
            p = load_prefs(self.s, uid)
            dg = p.get("digest") or {}
            if not p["enabled"] or not dg.get("on"):
                continue
            tz = get_tz(p["tz"])
            local = datetime.fromtimestamp(now_ms / 1000, tz)
            today = local.date().isoformat()
            if p.get("lastDigest") == today or local.hour * 60 + local.minute < _hm(dg.get("time", "08:00")) \
                    or now_ms - (p.get("lastDigestAt") or 0) < DIGEST_GAP_MS:
                continue
            urow = self.s.one("SELECT disabled FROM users WHERE id=?", (uid,))
            if not urow or urow["disabled"]:
                continue
            boards = [m["board_id"] for m in self.s.q(
                "SELECT board_id FROM members WHERE user_id=? AND status='active'", (uid,)) if m["board_id"] not in p["mutedBoards"]]
            n_today = n_late = 0
            for bid in boards:
                for c in self.s.q("SELECT data FROM records WHERE board_id=? AND kind='card' AND deleted=0", (bid,)):
                    d = json.loads(c["data"])
                    if d.get("done") or d.get("archived") or not d.get("due"):
                        continue
                    if d["due"] == today:
                        n_today += 1
                    elif d["due"] < today:
                        n_late += 1
            p["lastDigest"] = today
            p["lastDigestAt"] = now_ms
            save_prefs(self.s, uid, p)
            if n_today or n_late:
                parts = []
                if n_today:
                    parts.append("%d %s para hoy" % (n_today, "tarea" if n_today == 1 else "tareas"))
                if n_late:
                    parts.append("%d %s" % (n_late, "vencida" if n_late == 1 else "vencidas"))
                out.append((uid, {"title": "Tu día en Tackboard", "body": "Tienes " + " y ".join(parts) + ".",
                                  "tag": "digest", "url": "/#/hoy"}))
        return out

    def deliver(self, uid, payload):
        vapid = self.app.vapid()
        with self.s.lock:
            subs = self.subs(uid)
        res = send_to_subs(self.s, vapid, subs, payload, self.app.push_subject(),
                           opener=getattr(self.app, "push_opener", None))
        return sum(1 for _, st in res if 200 <= st < 300)

    def run_forever(self, interval=30):
        while True:
            try:
                self.tick()
            except Exception as e:  # pragma: no cover
                print("Avisos: error %s" % type(e).__name__, file=sys.stderr, flush=True)
            time.sleep(interval)


def now_ms_():
    return now_ms()


# ----------------------------------------------------------------------------------------------------
# Lógica
# ----------------------------------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status, msg, extra=None):
        super().__init__(msg)
        self.status, self.msg, self.extra = status, msg, extra or {}


def user_json(u):
    return {
        "username": u["username"],
        "name": u["name"],
        "createdAt": u["created_at"],
        "acceptInvites": bool(u["accept_invites"]),
        "needsConsent": u["policy_version"] != POLICY_VERSION,
    }


def record_json(r):
    out = {"id": r["id"], "kind": r["kind"], "boardId": r["board_id"], "updatedAt": r["updated_at"], "serverTs": r["server_ts"]}
    if r["deleted"]:
        out["deleted"] = True
    else:
        out["data"] = json.loads(r["data"])
    return out


class PushApi:
    """Parte de App dedicada a los avisos."""

    def vapid(self):
        if not PUSH_AVAILABLE:
            raise ApiError(503, "push_unavailable")
        if self._vapid is None:
            self._vapid = Vapid(self.s)
        return self._vapid

    def push_subject(self):
        contact = os.environ.get("TB_OPERATOR_CONTACT", "").strip()
        if re.match(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", contact, re.I):
            return "mailto:" + contact
        return "https://github.com/enriquezaporta/tackboard"

    def push_key(self, u):
        return {"publicKey": self.vapid().public}

    def push_subscribe(self, u, body, tok_hash=None):
        self.vapid()
        endpoint, p256dh, auth = valid_subscription(body)
        with self.s.lock:
            # Si el mismo dispositivo estaba con otra cuenta (cambio de usuario), pasa a esta.
            self.s.x("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))
            n = self.s.one("SELECT COUNT(*) FROM push_subs WHERE user_id=?", (u["id"],))[0]
            if n >= MAX_SUBS_PER_USER:  # se olvida el dispositivo más antiguo
                self.s.x("DELETE FROM push_subs WHERE id=(SELECT id FROM push_subs WHERE user_id=? ORDER BY created_at, id LIMIT 1)",
                         (u["id"],))
            # La suscripción queda ligada a esta sesión: al cerrarla, el dispositivo deja de recibir avisos.
            self.s.x("INSERT INTO push_subs(user_id,endpoint,p256dh,auth,created_at,token_hash) VALUES(?,?,?,?,?,?)",
                     (u["id"], endpoint, p256dh, auth, now(), tok_hash))
        return {"ok": True}

    def push_unsubscribe(self, u, body):
        endpoint = body.get("endpoint")
        if isinstance(endpoint, str) and len(endpoint) <= 1024:
            try:
                parsed = urlparse(endpoint)
                canon = norm_endpoint(parsed) if parsed.scheme == "https" and parsed.hostname else endpoint
            except ValueError:
                canon = endpoint
            with self.s.lock:
                self.s.x("DELETE FROM push_subs WHERE user_id=? AND endpoint IN (?,?)", (u["id"], endpoint, canon))
        return {"ok": True}

    def notify_prefs(self, u):
        with self.s.lock:
            p = load_prefs(self.s, u["id"])
        p.pop("lastDigest", None)
        p.pop("lastDigestAt", None)
        return {"prefs": p, "available": PUSH_AVAILABLE}

    def set_notify_prefs(self, u, body):
        with self.s.lock:
            cur = load_prefs(self.s, u["id"])
            new = clean_prefs(body, cur)
            new["lastDigest"] = cur.get("lastDigest", "")
            new["lastDigestAt"] = cur.get("lastDigestAt", 0)
            # Si se activa el resumen después de su hora, el primero llega mañana; si es antes, hoy mismo.
            if new["digest"].get("on") and not cur["digest"].get("on"):
                local = datetime.fromtimestamp(now(), get_tz(new["tz"]))
                if local.hour * 60 + local.minute >= _hm(new["digest"].get("time", "08:00")):
                    new["lastDigest"] = local.date().isoformat()
            save_prefs(self.s, u["id"], new)
        new.pop("lastDigest", None)
        new.pop("lastDigestAt", None)
        return {"prefs": new, "available": PUSH_AVAILABLE}

    def push_test(self, u):
        vapid = self.vapid()
        if not PUSH_TEST.hit(u["id"]):
            raise ApiError(429, "rate")
        with self.s.lock:
            subs = active_subs(self.s, u["id"])
        res = send_to_subs(self.s, vapid, subs, {"title": "Tackboard", "body": "Aviso de prueba: las notificaciones funcionan.",
                                                 "tag": "tackboard-test", "url": "/#/ajustes"},
                           self.push_subject(), opener=getattr(self, "push_opener", None), ttl=600)
        return {"sent": len(subs), "results": [{"service": urlparse(sb["endpoint"]).hostname, "status": st} for sb, st in res]}


class App(PushApi):
    def __init__(self, store):
        self._vapid = None
        self.s = store

    # ---- utilidades -------------------------------------------------------------------------------

    def issue_token(self, user_id):
        tok = secrets.token_urlsafe(32)
        t = now()
        self.s.x("INSERT INTO tokens(hash,user_id,created_at,last_used) VALUES(?,?,?,?)", (sha(tok), user_id, t, t))
        return tok

    def auth(self, header, ip):
        try:
            return self._auth(header)
        except ApiError as e:
            # Solo se frena a quien prueba tokens no válidos; una sesión válida nunca queda bloqueada por esto.
            if e.status == 401 and not BAD_TOKEN_IP.hit(ip):
                raise ApiError(429, "rate")
            raise

    def _auth(self, header):
        if not header or not header.startswith("Bearer "):
            raise ApiError(401, "auth")
        tok = header[7:].strip()
        if not tok or len(tok) > 200:
            raise ApiError(401, "auth")
        h = sha(tok)
        with self.s.lock:
            r = self.s.one(
                "SELECT t.created_at, t.last_used, u.* FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=?", (h,)
            )
            t = now()
            if not r or r["disabled"] or t - r["last_used"] > TOKEN_IDLE or t - r["created_at"] > TOKEN_MAX:
                if r:
                    self.s.x("DELETE FROM tokens WHERE hash=?", (h,))
                raise ApiError(401, "auth")
            if t - r["last_used"] > 3600:
                self.s.x("UPDATE tokens SET last_used=? WHERE hash=?", (t, h))
        if not API_TOKEN.hit(h):
            raise ApiError(429, "rate")
        return r, h

    def membership(self, board_id, user_id):
        return self.s.one("SELECT * FROM members WHERE board_id=? AND user_id=? AND status='active'", (board_id, user_id))

    def require_role(self, board_id, user_id, min_role):
        m = self.membership(board_id, user_id)
        if not m or ROLE_RANK[m["role"]] < ROLE_RANK[min_role]:
            raise ApiError(403, "forbidden")
        return m

    def board_name(self, board_id):
        r = self.s.one("SELECT data FROM records WHERE id=? AND kind='board' AND deleted=0", (board_id,))
        if not r:
            return None, None
        d = json.loads(r["data"])
        return d.get("name"), d.get("color")

    def delete_board(self, board_id):
        delete_board(self.s, board_id)

    def boards_list(self, user_id):
        rows = self.s.q(
            """SELECT m.board_id, m.role,
                      (SELECT COUNT(*) FROM members m2 WHERE m2.board_id=m.board_id AND m2.status='active') AS n,
                      (SELECT u.username FROM members m3 JOIN users u ON u.id=m3.user_id
                         WHERE m3.board_id=m.board_id AND m3.role='owner') AS owner
               FROM members m WHERE m.user_id=? AND m.status='active'""",
            (user_id,),
        )
        return [{"id": r["board_id"], "role": r["role"], "members": r["n"], "owner": r["owner"]} for r in rows]

    def invitations(self, user_id):
        rows = self.s.q(
            """SELECT m.board_id, m.role, m.created_at, u.username, u.name FROM members m
               LEFT JOIN users u ON u.id=m.invited_by WHERE m.user_id=? AND m.status='pending'
               ORDER BY m.created_at""",
            (user_id,),
        )
        out = []
        for r in rows:
            name, color = self.board_name(r["board_id"])
            if name is None:
                continue
            out.append({"boardId": r["board_id"], "boardName": name, "color": color, "role": r["role"],
                        "from": r["username"], "fromName": r["name"], "createdAt": r["created_at"]})
        return out

    # ---- cuentas ----------------------------------------------------------------------------------

    def register(self, body, ip):
        if not env_flag("TB_ALLOW_SIGNUP"):
            raise ApiError(403, "signup_closed")
        if not SIGNUP_IP.hit(ip):
            raise ApiError(429, "rate")
        username = str(body.get("username") or "").strip().lower()
        name = clean_name(body.get("name")) or username
        pw = body.get("password")
        if not USERNAME_RE.match(username):
            raise ApiError(400, "username")
        if not isinstance(pw, str) or not (8 <= len(pw) <= 128):
            raise ApiError(400, "password")
        if body.get("consent") is not True:
            raise ApiError(400, "consent")
        pw_hash = hash_password(pw)
        code = new_recovery_code()
        with self.s.lock:
            if self.s.one("SELECT 1 FROM users WHERE username=?", (username,)):
                raise ApiError(409, "username_taken")
            cur = self.s.x(
                "INSERT INTO users(username,name,pw_hash,recovery_hash,created_at,policy_version,policy_accepted_at) VALUES(?,?,?,?,?,?,?)",
                (username, name, pw_hash, sha(norm_code(code)), now(), POLICY_VERSION, now()),
            )
            uid = cur.lastrowid
            tok = self.issue_token(uid)
            u = self.s.one("SELECT * FROM users WHERE id=?", (uid,))
        return {"token": tok, "user": user_json(u), "recoveryCode": code}

    def login(self, body, ip):
        username = str(body.get("username") or "").strip().lower()
        pw = body.get("password")
        if not isinstance(pw, str) or len(pw) > 128:
            raise ApiError(400, "password")
        if not AUTH_IP.hit(ip):
            raise ApiError(429, "rate")
        if not USERNAME_RE.match(username):
            raise ApiError(401, "login")  # un formato imposible no revela nada; no hace falta gastar CPU
        # Se bloquea a la IP que falla. El límite global por usuario (ataques repartidos) no frena
        # a una IP que todavía no ha fallado con ese usuario.
        if FAIL_USER_IP.blocked((username, ip)) or (FAIL_USER.blocked(username) and FAIL_USER_IP.count((username, ip)) > 0):
            raise ApiError(429, "rate")
        with self.s.lock:
            u = self.s.one("SELECT * FROM users WHERE username=?", (username,))
        if not u:
            dummy_check(pw)
            ok = False
        else:
            ok = check_password(pw, u["pw_hash"]) and not u["disabled"]
        if not ok:
            # Solo cuentan los fallos: quien sabe la contraseña no queda bloqueado por un tercero
            # salvo ataque masivo desde muchas IPs (FAIL_USER).
            FAIL_USER_IP.hit((username, ip))
            FAIL_USER.hit(username)
            raise ApiError(401, "login")
        with self.s.lock:
            tok = self.issue_token(u["id"])
        return {"token": tok, "user": user_json(u)}

    def recover(self, body, ip):
        username = str(body.get("username") or "").strip().lower()
        code = norm_code(str(body.get("code") or "")[:64])
        pw = body.get("password")
        if not isinstance(pw, str) or not (8 <= len(pw) <= 128):
            raise ApiError(400, "password")
        if not USERNAME_RE.match(username):
            raise ApiError(401, "recover")
        if not AUTH_IP.hit(ip) or not RECOVER_USER.hit(username):
            raise ApiError(429, "rate")
        with self.s.lock:
            u = self.s.one("SELECT * FROM users WHERE username=?", (username,))
        ok = bool(u and u["recovery_hash"] and hmac.compare_digest(u["recovery_hash"], sha(code)) and not u["disabled"])
        pw_hash = hash_password(pw)  # siempre, para igualar tiempos
        if not ok:
            raise ApiError(401, "recover")
        new_code = new_recovery_code()
        with self.s.lock:
            self.s.x("UPDATE users SET pw_hash=?, recovery_hash=? WHERE id=?", (pw_hash, sha(norm_code(new_code)), u["id"]))
            self.s.x("DELETE FROM tokens WHERE user_id=?", (u["id"],))
            self.s.x("DELETE FROM push_subs WHERE user_id=?", (u["id"],))
            tok = self.issue_token(u["id"])
        return {"token": tok, "user": user_json(u), "recoveryCode": new_code}

    def update_me(self, u, body):
        sets, args = [], []
        if "name" in body:
            name = clean_name(body.get("name"))
            if not name:
                raise ApiError(400, "name")
            sets.append("name=?"); args.append(name)
        if "acceptInvites" in body:
            sets.append("accept_invites=?"); args.append(1 if body.get("acceptInvites") is True else 0)
        if body.get("consent") is True:
            sets.append("policy_version=?"); args.append(POLICY_VERSION)
            sets.append("policy_accepted_at=?"); args.append(now())
        with self.s.lock:
            if sets:
                self.s.x("UPDATE users SET %s WHERE id=?" % ",".join(sets), (*args, u["id"]))
            u2 = self.s.one("SELECT * FROM users WHERE id=?", (u["id"],))
        return {"user": user_json(u2)}

    def change_password(self, u, tok_hash, body):
        cur, pw = body.get("current"), body.get("password")
        if not isinstance(pw, str) or not (8 <= len(pw) <= 128) or not isinstance(cur, str) or len(cur) > 128:
            raise ApiError(400, "password")
        if not ACCOUNT_PW.hit(u["id"]):
            raise ApiError(429, "rate")
        if not check_password(cur, u["pw_hash"]):
            raise ApiError(403, "wrong_password")
        h = hash_password(pw)
        with self.s.lock:
            self.s.x("UPDATE users SET pw_hash=? WHERE id=?", (h, u["id"]))
            self.s.x("DELETE FROM tokens WHERE user_id=?", (u["id"],))
            tok = self.issue_token(u["id"])
            # Este dispositivo conserva sus avisos (pasan a la sesión nueva); los de las demás sesiones se borran.
            self.s.x("UPDATE push_subs SET token_hash=? WHERE user_id=? AND token_hash=?", (sha(tok), u["id"], tok_hash))
            self.s.x("DELETE FROM push_subs WHERE user_id=? AND (token_hash IS NULL OR token_hash<>?)", (u["id"], sha(tok)))
        return {"token": tok}

    def new_recovery(self, u, body):
        pw = body.get("password")
        if not isinstance(pw, str) or len(pw) > 128:
            raise ApiError(400, "password")
        if not ACCOUNT_PW.hit(u["id"]):
            raise ApiError(429, "rate")
        if not check_password(pw, u["pw_hash"]):
            raise ApiError(403, "wrong_password")
        code = new_recovery_code()
        with self.s.lock:
            self.s.x("UPDATE users SET recovery_hash=? WHERE id=?", (sha(norm_code(code)), u["id"]))
        return {"recoveryCode": code}

    def delete_me(self, u, body):
        pw = body.get("password")
        if not isinstance(pw, str) or len(pw) > 128:
            raise ApiError(400, "password")
        if not ACCOUNT_PW.hit(u["id"]):
            raise ApiError(429, "rate")
        if not check_password(pw, u["pw_hash"]):
            raise ApiError(403, "wrong_password")
        with self.s.lock:
            delete_user(self.s, u["id"])
        return {"ok": True}

    def export(self, u):
        with self.s.lock:
            boards = self.boards_list(u["id"])
            ids = [b["id"] for b in boards]
            records = []
            for bid in ids:
                records += [record_json(r) for r in self.s.q("SELECT * FROM records WHERE board_id=? AND deleted=0", (bid,))]
            members = {}
            for b in boards:
                manager = ROLE_RANK[b["role"]] >= ROLE_RANK["admin"]
                members[b["id"]] = [
                    {"username": r["username"], "role": r["role"], "status": r["status"]}
                    for r in self.s.q(
                        "SELECT u.username, m.role, m.status FROM members m JOIN users u ON u.id=m.user_id WHERE m.board_id=?",
                        (b["id"],),
                    )
                    if r["status"] == "active" or manager
                ]
            sessions = [
                {"createdAt": r["created_at"], "lastUsed": r["last_used"]}
                for r in self.s.q("SELECT created_at,last_used FROM tokens WHERE user_id=?", (u["id"],))
            ]
            invitations = self.invitations(u["id"])
            push = [{"service": urlparse(r["endpoint"]).hostname, "createdAt": r["created_at"], "lastOk": r["last_ok"]}
                    for r in self.s.q("SELECT endpoint, created_at, last_ok FROM push_subs WHERE user_id=?", (u["id"],))]
            notify_prefs = load_prefs(self.s, u["id"])
        return {
            "app": "Tackboard",
            "exportedAt": now(),
            "account": {**user_json(u), "policyVersion": u["policy_version"], "policyAcceptedAt": u["policy_accepted_at"]},
            "boards": boards,
            "members": members,
            "records": records,
            "invitationsReceived": invitations,
            "sessions": sessions,
            "pushDevices": push,
            "notificationPrefs": notify_prefs,
        }

    # ---- sincronización ---------------------------------------------------------------------------

    def sync(self, u, body):
        if u["policy_version"] != POLICY_VERSION:
            raise ApiError(428, "consent")
        since = body.get("since") or 0
        if isinstance(since, bool) or not isinstance(since, int) or since < 0:
            raise ApiError(400, "since")
        changes = body.get("changes") or []
        if not isinstance(changes, list) or len(changes) > MAX_CHANGES:
            raise ApiError(400, "changes")
        uid = u["id"]
        rejected = []
        sizes = {}  # bytes por tablero, calculados una vez por sincronización
        with self.s.lock:
            self.s.x("BEGIN IMMEDIATE")
            try:
                # Primero los tableros nuevos, luego columnas y por último tarjetas.
                order = {"board": 0, "column": 1, "card": 2}
                for ch in sorted(changes, key=lambda c: order.get(c.get("kind") if isinstance(c, dict) else None, 3)):
                    try:
                        self.apply_change(uid, ch, sizes)
                    except ApiError as e:
                        cid = ch.get("id") if isinstance(ch, dict) and isinstance(ch.get("id"), str) else None
                        if cid and ID_RE.match(cid):
                            rejected.append(self.rejection(uid, cid, e.msg))
                self.s.x("COMMIT")
            except Exception:
                self.s.x("ROLLBACK")
                raise

            boards = self.boards_list(uid)
            ids = [b["id"] for b in boards]
            out, more, cursor = [], False, max(self.s.ts, since)
            if ids:
                marks = ",".join("?" * len(ids))
                rows = self.s.q(
                    "SELECT * FROM records WHERE board_id IN (%s) AND server_ts>? ORDER BY server_ts LIMIT ?" % marks,
                    (*ids, since, PAGE + 1),
                )
                total = 0
                for i, r in enumerate(rows):
                    size = len(r["data"].encode()) if r["data"] else 0
                    if i >= PAGE or (out and total + size > PAGE_BYTES):
                        more = True
                        break
                    out.append(record_json(r))
                    total += size
                if more:
                    cursor = out[-1]["serverTs"]
            invitations = len(self.invitations(uid))
        return {"cursor": cursor, "changes": out, "boards": boards, "rejected": rejected,
                "invitations": invitations, "more": more}

    def rejection(self, uid, rid, reason):
        r = self.s.one("SELECT * FROM records WHERE id=?", (rid,))
        cur = None
        if r and self.membership(r["board_id"], uid):
            cur = record_json(r)
        return {"id": rid, "reason": reason, "current": cur}

    def board_bytes(self, board_id, sizes):
        if board_id not in sizes:
            sizes[board_id] = self.s.one(
                "SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) FROM records WHERE board_id=?", (board_id,))[0]
        return sizes[board_id]

    def apply_change(self, uid, ch, sizes):
        if not isinstance(ch, dict):
            raise ApiError(400, "invalid")
        rid, kind = ch.get("id"), ch.get("kind")
        if not isinstance(rid, str) or not ID_RE.match(rid):
            raise ApiError(400, "invalid")
        existing = self.s.one("SELECT * FROM records WHERE id=?", (rid,))
        # Con un registro ajeno, la única respuesta posible es "prohibido" (no se revela nada de él).
        if existing and not self.membership(existing["board_id"], uid):
            raise ApiError(403, "forbidden")
        if kind not in CLEANERS:
            raise ApiError(400, "invalid")
        upd = ch.get("updatedAt")
        if isinstance(upd, bool) or not isinstance(upd, int) or upd <= 0 or upd > now_ms() + 86400_000:
            raise ApiError(400, "updatedAt")
        deleted = ch.get("deleted") is True

        if existing:
            if existing["kind"] != kind:
                raise ApiError(400, "invalid")
            board_id = existing["board_id"]
        elif kind == "board":
            board_id = rid
        else:
            board_id = ch.get("boardId")
            if not isinstance(board_id, str) or not ID_RE.match(board_id):
                raise ApiError(400, "invalid")

        data, data_json, size = None, None, 0
        if not deleted:
            raw = ch.get("data")
            if not isinstance(raw, dict):
                raise ApiError(400, "invalid")
            try:
                data = CLEANERS[kind](raw)
            except Invalid as e:
                raise ApiError(400, "invalid:%s" % e)
            data_json = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            size = len(data_json.encode())
            if size > MAX_RECORD_BYTES:
                raise ApiError(400, "too_big")

        # ---- tablero nuevo
        if not existing and kind == "board":
            if deleted:
                return
            if self.s.one("SELECT 1 FROM deleted_boards WHERE id=?", (board_id,)) or \
                    self.s.one("SELECT 1 FROM members WHERE board_id=?", (board_id,)) or \
                    self.s.one("SELECT 1 FROM records WHERE board_id=?", (board_id,)):
                raise ApiError(409, "exists")
            owned = self.s.one("SELECT COUNT(*) FROM members WHERE user_id=? AND role='owner'", (uid,))[0]
            total = self.s.one("SELECT COUNT(*) FROM members WHERE user_id=? AND status='active'", (uid,))[0]
            if owned >= MAX_BOARDS_OWNED or total >= MAX_MEMBERSHIPS:
                raise ApiError(400, "limit")
            ts = self.s.next_ts()
            self.s.x("INSERT INTO records(id,board_id,kind,data,updated_at,server_ts,deleted) VALUES(?,?,?,?,?,?,0)",
                     (rid, board_id, kind, data_json, upd, ts))
            self.s.x("INSERT INTO members(board_id,user_id,role,status,invited_by,created_at,joined_ts) VALUES(?,?,?,?,?,?,?)",
                     (board_id, uid, "owner", "active", None, now(), ts))
            sizes[board_id] = size
            return

        # ---- permisos
        m = self.membership(board_id, uid)
        if not m:
            raise ApiError(403, "forbidden")
        role = m["role"]
        if kind == "board":
            need = "owner" if deleted else "admin"
        elif kind == "column":
            need = "admin"
        else:
            need = "write"
        if ROLE_RANK[role] < ROLE_RANK[need]:
            raise ApiError(403, "forbidden")
        if not self.s.one("SELECT 1 FROM records WHERE id=? AND kind='board' AND deleted=0", (board_id,)):
            raise ApiError(403, "forbidden")

        if existing and existing["updated_at"] >= upd:
            raise ApiError(409, "stale")

        if kind == "board" and deleted:
            self.delete_board(board_id)
            sizes.pop(board_id, None)
            return

        if kind == "card" and not deleted:
            col = self.s.one("SELECT 1 FROM records WHERE id=? AND kind='column' AND board_id=? AND deleted=0",
                             (data["columnId"], board_id))
            if not col:
                raise ApiError(400, "invalid:columnId")

        old_size = len(existing["data"].encode()) if existing and existing["data"] else 0
        if size > old_size and self.board_bytes(board_id, sizes) + size - old_size > MAX_BOARD_BYTES:
            raise ApiError(400, "limit")

        if not existing:
            if deleted:
                return
            if kind == "column":
                n = self.s.one("SELECT COUNT(*) FROM records WHERE board_id=? AND kind='column' AND deleted=0", (board_id,))[0]
                if n >= MAX_COLUMNS:
                    raise ApiError(400, "limit")
            if kind == "card":
                n = self.s.one("SELECT COUNT(*) FROM records WHERE board_id=? AND kind='card' AND deleted=0", (board_id,))[0]
                if n >= MAX_CARDS:
                    raise ApiError(400, "limit")
            ts = self.s.next_ts()
            self.s.x("INSERT INTO records(id,board_id,kind,data,updated_at,server_ts,deleted) VALUES(?,?,?,?,?,?,0)",
                     (rid, board_id, kind, data_json, upd, ts))
        else:
            ts = self.s.next_ts()
            if deleted:
                self.s.x("UPDATE records SET data=NULL, deleted=1, updated_at=?, server_ts=? WHERE id=?", (upd, ts, rid))
            else:
                self.s.x("UPDATE records SET data=?, deleted=0, updated_at=?, server_ts=? WHERE id=?", (data_json, upd, ts, rid))
        if board_id in sizes:
            sizes[board_id] += size - old_size

    # ---- miembros e invitaciones -------------------------------------------------------------------

    def members(self, u, board_id):
        with self.s.lock:
            m = self.require_role(board_id, u["id"], "read")
            manager = ROLE_RANK[m["role"]] >= ROLE_RANK["admin"]
            rows = self.s.q(
                """SELECT u.username, u.name, m.role, m.status, m.created_at FROM members m
                   JOIN users u ON u.id=m.user_id WHERE m.board_id=? ORDER BY m.status, m.created_at""",
                (board_id,),
            )
        out = [{"username": r["username"], "name": r["name"], "role": r["role"], "status": r["status"], "since": r["created_at"]}
               for r in rows if r["status"] == "active" or manager]
        return {"members": out, "myRole": m["role"]}

    def invite(self, u, board_id, body):
        username = str(body.get("username") or "").strip().lower()[:30]
        role = body.get("role")
        if role not in ("read", "write", "admin"):
            raise ApiError(400, "role")
        if not INVITE_USER.hit(u["id"]):
            raise ApiError(429, "rate")
        with self.s.lock:
            self.require_role(board_id, u["id"], "admin")
            target = self.s.one("SELECT * FROM users WHERE username=?", (username,))
            # Mismo error si no existe, está desactivado o no acepta invitaciones.
            if not target or target["disabled"] or not target["accept_invites"] or target["id"] == u["id"]:
                raise ApiError(404, "user")
            if self.s.one("SELECT 1 FROM members WHERE board_id=? AND user_id=?", (board_id, target["id"])):
                raise ApiError(409, "already")
            n_act = self.s.one("SELECT COUNT(*) FROM members WHERE board_id=? AND status='active'", (board_id,))[0]
            n_pend = self.s.one("SELECT COUNT(*) FROM members WHERE board_id=? AND status='pending'", (board_id,))[0]
            if n_act + n_pend >= MAX_MEMBERS or n_pend >= MAX_PENDING_INVITES:
                raise ApiError(400, "limit")
            self.s.x("INSERT INTO members(board_id,user_id,role,status,invited_by,created_at,joined_ts) VALUES(?,?,?,?,?,?,0)",
                     (board_id, target["id"], role, "pending", u["id"], now()))
        return {"ok": True}

    def set_role(self, u, board_id, username, body):
        role = body.get("role")
        if role not in ("read", "write", "admin"):
            raise ApiError(400, "role")
        with self.s.lock:
            self.require_role(board_id, u["id"], "admin")
            t = self.s.one("SELECT m.*, u.id AS uid FROM members m JOIN users u ON u.id=m.user_id WHERE m.board_id=? AND u.username=?",
                           (board_id, username))
            if not t:
                raise ApiError(404, "user")
            if t["role"] == "owner":
                raise ApiError(403, "forbidden")
            self.s.x("UPDATE members SET role=? WHERE board_id=? AND user_id=?", (role, board_id, t["uid"]))
        return {"ok": True}

    def remove_member(self, u, board_id, username):
        with self.s.lock:
            t = self.s.one("SELECT m.*, u.id AS uid FROM members m JOIN users u ON u.id=m.user_id WHERE m.board_id=? AND u.username=?",
                           (board_id, username))
            if t and t["uid"] == u["id"]:
                if t["role"] == "owner":
                    raise ApiError(403, "owner_cannot_leave")
                self.s.x("DELETE FROM members WHERE board_id=? AND user_id=?", (board_id, u["id"]))
                return {"ok": True}
            self.require_role(board_id, u["id"], "admin")
            if not t:
                raise ApiError(404, "user")
            if t["role"] == "owner":
                raise ApiError(403, "forbidden")
            self.s.x("DELETE FROM members WHERE board_id=? AND user_id=?", (board_id, t["uid"]))
        return {"ok": True}

    def answer_invitation(self, u, board_id, body):
        accept = body.get("accept") is True
        with self.s.lock:
            m = self.s.one("SELECT * FROM members WHERE board_id=? AND user_id=? AND status='pending'", (board_id, u["id"]))
            if not m:
                raise ApiError(404, "invitation")
            if accept:
                total = self.s.one("SELECT COUNT(*) FROM members WHERE user_id=? AND status='active'", (u["id"],))[0]
                if total >= MAX_MEMBERSHIPS:
                    raise ApiError(400, "limit")
                if not ACCEPT_BOARD.hit(board_id):
                    raise ApiError(429, "rate")
                self.s.x("BEGIN IMMEDIATE")
                try:
                    self.s.x("UPDATE members SET status='active', joined_ts=? WHERE board_id=? AND user_id=?",
                             (self.s.next_ts(), board_id, u["id"]))
                    # Se vuelve a marcar todo el tablero para que el nuevo miembro lo reciba con la sincronización
                    # normal (paginada). Los demás miembros lo descargan otra vez una sola vez.
                    for r in self.s.q("SELECT id FROM records WHERE board_id=? ORDER BY server_ts", (board_id,)):
                        self.s.x("UPDATE records SET server_ts=? WHERE id=?", (self.s.next_ts(), r["id"]))
                    self.s.x("COMMIT")
                except Exception:
                    self.s.x("ROLLBACK")
                    raise
            else:
                self.s.x("DELETE FROM members WHERE board_id=? AND user_id=?", (board_id, u["id"]))
        return {"ok": True}


def delete_board(store, board_id):
    store.x("DELETE FROM records WHERE board_id=?", (board_id,))
    store.x("DELETE FROM members WHERE board_id=?", (board_id,))
    store.x("INSERT OR IGNORE INTO deleted_boards(id, deleted_at) VALUES(?,?)", (board_id, now()))


def delete_user(store, uid):
    """Borra la cuenta: sus tableros (con todo su contenido y miembros), su presencia en tableros ajenos,
    sus invitaciones y sus sesiones. Las tarjetas que creó en tableros ajenos pertenecen a ese tablero."""
    for r in store.q("SELECT board_id FROM members WHERE user_id=? AND role='owner'", (uid,)):
        delete_board(store, r["board_id"])
    store.x("DELETE FROM members WHERE user_id=?", (uid,))
    store.x("UPDATE members SET invited_by=NULL WHERE invited_by=?", (uid,))
    store.x("DELETE FROM tokens WHERE user_id=?", (uid,))
    store.x("DELETE FROM push_subs WHERE user_id=?", (uid,))
    store.x("DELETE FROM notify_prefs WHERE user_id=?", (uid,))
    store.x("DELETE FROM notify_log WHERE user_id=?", (uid,))
    store.x("DELETE FROM users WHERE id=?", (uid,))


# ----------------------------------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------------------------------

ROUTE_MEMBERS = re.compile(r"^/api/boards/([A-Za-z0-9_-]{8,64})/members$")
ROUTE_MEMBER = re.compile(r"^/api/boards/([A-Za-z0-9_-]{8,64})/members/([a-z0-9_.-]{3,30})$")
ROUTE_INVITE = re.compile(r"^/api/invitations/([A-Za-z0-9_-]{8,64})$")


class Handler(BaseHTTPRequestHandler):
    server_version = "Tackboard"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30  # segundos por operación de lectura en el socket (protege de conexiones lentas)
    app = None

    def log_message(self, fmt, *args):
        pass  # Sin registros de peticiones: ni IPs ni nombres de usuario.

    def client_ip(self):
        return (self.headers.get("X-Real-IP") or self.client_address[0] or "?")[:64]

    def send_json(self, status, obj, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        te = self.headers.get("Transfer-Encoding")
        if te:
            raise ApiError(411, "length")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "length")
        if n < 0 or n > limit:
            raise ApiError(413, "too_big")
        raw = self.rfile.read(n) if n else b""
        if len(raw) != n:
            raise ApiError(400, "length")
        self.body_read = True
        if not raw:
            return {}
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError(415, "json")
        try:
            body = json.loads(raw)
        except Exception:
            raise ApiError(400, "json")
        if not isinstance(body, dict):
            raise ApiError(400, "json")
        return body

    def handle_api(self, method):
        path = urlparse(self.path).path
        app = self.app
        ip = self.client_ip()

        if method == "GET" and path == "/api/health":
            return self.send_json(200, {"ok": True, "version": VERSION, "signup": env_flag("TB_ALLOW_SIGNUP"),
                                        "policyVersion": POLICY_VERSION})
        if method == "GET" and path == "/api/legal":
            return self.send_json(200, {"operator": os.environ.get("TB_OPERATOR_NAME", "").strip()[:120],
                                        "contact": os.environ.get("TB_OPERATOR_CONTACT", "").strip()[:200],
                                        "policyVersion": POLICY_VERSION})
        if method == "POST" and path == "/api/auth/register":
            return self.send_json(200, app.register(self.read_body(MAX_BODY), ip))
        if method == "POST" and path == "/api/auth/login":
            return self.send_json(200, app.login(self.read_body(MAX_BODY), ip))
        if method == "POST" and path == "/api/auth/recover":
            return self.send_json(200, app.recover(self.read_body(MAX_BODY), ip))

        u, tok_hash = app.auth(self.headers.get("Authorization"), ip)

        if method == "POST" and path == "/api/sync":
            return self.send_json(200, app.sync(u, self.read_body(MAX_BODY_SYNC)))
        body = self.read_body(MAX_BODY) if method in ("POST", "DELETE") else {}

        if method == "POST" and path == "/api/auth/logout":
            with app.s.lock:
                app.s.x("DELETE FROM push_subs WHERE token_hash=?", (tok_hash,))
                app.s.x("DELETE FROM tokens WHERE hash=?", (tok_hash,))
            return self.send_json(200, {"ok": True})
        if method == "POST" and path == "/api/auth/logout-others":
            with app.s.lock:
                app.s.x("DELETE FROM push_subs WHERE user_id=? AND (token_hash IS NULL OR token_hash<>?)", (u["id"], tok_hash))
                app.s.x("DELETE FROM tokens WHERE user_id=? AND hash<>?", (u["id"], tok_hash))
            return self.send_json(200, {"ok": True})
        if method == "GET" and path == "/api/me":
            return self.send_json(200, {"user": user_json(u)})
        if method == "POST" and path == "/api/me":
            return self.send_json(200, app.update_me(u, body))
        if method == "POST" and path == "/api/me/password":
            return self.send_json(200, app.change_password(u, tok_hash, body))
        if method == "POST" and path == "/api/me/recovery":
            return self.send_json(200, app.new_recovery(u, body))
        if method == "POST" and path == "/api/me/delete":
            return self.send_json(200, app.delete_me(u, body))
        if method == "GET" and path == "/api/export":
            return self.send_json(200, app.export(u),
                                  {"Content-Disposition": 'attachment; filename="tackboard-datos.json"'})
        if method == "GET" and path == "/api/invitations":
            with app.s.lock:
                inv = app.invitations(u["id"])
            return self.send_json(200, {"invitations": inv})

        if path.startswith("/api/push/"):
            if method == "GET" and path == "/api/push/key":
                return self.send_json(200, app.push_key(u))
            if method == "POST" and path == "/api/push/subscribe":
                return self.send_json(200, app.push_subscribe(u, body, tok_hash))
            if method == "POST" and path == "/api/push/unsubscribe":
                return self.send_json(200, app.push_unsubscribe(u, body))
            if method == "POST" and path == "/api/push/test":
                return self.send_json(200, app.push_test(u))
            if method == "GET" and path == "/api/push/prefs":
                return self.send_json(200, app.notify_prefs(u))
            if method == "POST" and path == "/api/push/prefs":
                return self.send_json(200, app.set_notify_prefs(u, body))
        m = ROUTE_INVITE.match(path)
        if m and method == "POST":
            return self.send_json(200, app.answer_invitation(u, m.group(1), body))
        m = ROUTE_MEMBERS.match(path)
        if m and method == "GET":
            return self.send_json(200, app.members(u, m.group(1)))
        if m and method == "POST":
            return self.send_json(200, app.invite(u, m.group(1), body))
        m = ROUTE_MEMBER.match(unquote(path))
        if m and method == "POST":
            return self.send_json(200, app.set_role(u, m.group(1), m.group(2), body))
        if m and method == "DELETE":
            return self.send_json(200, app.remove_member(u, m.group(1), m.group(2)))
        raise ApiError(404, "not_found")

    def dispatch(self, method):
        self.body_read = False
        try:
            # Si la petición trae un cuerpo que no se va a leer (error antes de leerlo, GET con cuerpo,
            # Transfer-Encoding…), la conexión se cierra al responder. Si no, esos bytes se tomarían
            # como la petición siguiente y las respuestas se cruzarían entre conexiones.
            has_body = bool(self.headers.get("Transfer-Encoding")) or (self.headers.get("Content-Length") or "0").strip() not in ("", "0")
            if not self.path.startswith("/api/"):
                raise ApiError(404, "not_found")
            try:
                self.handle_api(method)
            finally:
                if has_body and not self.body_read:
                    self.close_connection = True
        except ApiError as e:
            self.close_connection = True
            self.send_json(e.status, {"error": e.msg, **e.extra}, {"Connection": "close"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # pragma: no cover
            print("Error interno: %s" % type(e).__name__, file=sys.stderr)
            self.close_connection = True
            try:
                self.send_json(500, {"error": "internal"}, {"Connection": "close"})
            except Exception:
                pass

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_DELETE(self):
        self.dispatch("DELETE")


class Server(ThreadingHTTPServer):
    """Servidor con un número máximo de hilos: si se agotan, las conexiones nuevas esperan en cola."""
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, *a, **kw):
        self.slots = threading.BoundedSemaphore(MAX_THREADS)
        super().__init__(*a, **kw)

    def process_request(self, request, client_address):
        if not self.slots.acquire(timeout=0.5):
            # Sin hilos libres: se responde enseguida en vez de bloquear la aceptación de conexiones.
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n"
                                b"Content-Length: 16\r\nConnection: close\r\nRetry-After: 5\r\n\r\n{\"error\":\"busy\"}")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def make_server(store, host=HOST, port=PORT):
    Handler.app = App(store)
    srv = Server((host, port), Handler)
    srv.timeout = 30
    return srv


# ----------------------------------------------------------------------------------------------------
# Administración por línea de órdenes
# ----------------------------------------------------------------------------------------------------

ADMIN_HELP = """Uso: server.py admin <orden>
  users                    usuarios, tableros y estado
  adduser <usuario> [nombre]   crea una cuenta y muestra contraseña y código de recuperación
  passwd <usuario>         nueva contraseña aleatoria (cierra sus sesiones)
  disable <usuario>        desactiva la cuenta (cierra sus sesiones)
  enable <usuario>         reactiva la cuenta
  deluser <usuario>        borra la cuenta y todos sus datos
"""


def admin(argv):
    s = Store(DB_PATH)
    cmd = argv[0] if argv else ""
    arg = argv[1].strip().lower() if len(argv) > 1 else ""

    def get(username):
        u = s.one("SELECT * FROM users WHERE username=?", (username,))
        if not u:
            print("No existe el usuario %r." % username)
            sys.exit(1)
        return u

    if cmd == "users":
        rows = s.q("""SELECT u.username, u.name, u.disabled, u.created_at,
                      (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id AND m.role='owner') AS own,
                      (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id AND m.status='active' AND m.role<>'owner') AS shared
                      FROM users u ORDER BY u.username""")
        print("%-20s %-24s %8s %10s  %s" % ("usuario", "nombre", "propios", "compartid", "estado"))
        for r in rows:
            print("%-20s %-24s %8d %10d  %s" % (r["username"], clean_name(r["name"], 24), r["own"], r["shared"],
                                                 "desactivado" if r["disabled"] else "activo"))
        return
    if cmd == "adduser" and arg:
        if not USERNAME_RE.match(arg):
            print("Usuario no válido: 3-30 caracteres, minúsculas, números y . _ -")
            sys.exit(1)
        if s.one("SELECT 1 FROM users WHERE username=?", (arg,)):
            print("Ese usuario ya existe.")
            sys.exit(1)
        name = clean_name(" ".join(argv[2:])) or arg
        pw = secrets.token_urlsafe(12)
        code = new_recovery_code()
        s.x("INSERT INTO users(username,name,pw_hash,recovery_hash,created_at,policy_version) VALUES(?,?,?,?,?,NULL)",
            (arg, name, hash_password(pw), sha(norm_code(code)), now()))
        print("Usuario: %s\nContraseña: %s\nCódigo de recuperación: %s" % (arg, pw, code))
        print("Al entrar tendrá que aceptar la política de privacidad.")
        return
    if cmd == "passwd" and arg:
        u = get(arg)
        pw = secrets.token_urlsafe(12)
        s.x("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(pw), u["id"]))
        s.x("DELETE FROM tokens WHERE user_id=?", (u["id"],))
        s.x("DELETE FROM push_subs WHERE user_id=?", (u["id"],))
        print("Nueva contraseña de %s: %s" % (arg, pw))
        return
    if cmd in ("disable", "enable") and arg:
        u = get(arg)
        s.x("UPDATE users SET disabled=? WHERE id=?", (1 if cmd == "disable" else 0, u["id"]))
        if cmd == "disable":
            s.x("DELETE FROM tokens WHERE user_id=?", (u["id"],))
            s.x("DELETE FROM push_subs WHERE user_id=?", (u["id"],))
        print("Hecho.")
        return
    if cmd == "deluser" and arg:
        u = get(arg)
        delete_user(s, u["id"])
        print("Usuario %s y sus datos borrados." % arg)
        return
    print(ADMIN_HELP)
    sys.exit(1)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "admin":
        return admin(sys.argv[2:])
    store = Store(DB_PATH)
    srv = make_server(store)
    if PUSH_AVAILABLE and env_flag("TB_NOTIFY"):
        threading.Thread(target=Notifier(Handler.app).run_forever, name="avisos", daemon=True).start()
    elif not PUSH_AVAILABLE:
        print("Avisos desactivados: falta python3-cryptography.", flush=True)
    print("Tackboard %s escuchando en %s:%d" % (VERSION, HOST, PORT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
