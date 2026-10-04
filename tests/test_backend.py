"""Pruebas del backend: cd tackboard && python3 -m unittest discover -s tests -v"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ["TB_ALLOW_SIGNUP"] = "1"
import server  # noqa: E402

server.PBKDF2_ITERS = 1000  # más rápido en pruebas


class Client:
    def __init__(self, base, token=None):
        self.base, self.token = base, token

    def req(self, method, path, body=None, headers=None):
        h = {"X-Real-IP": "10.0.0.%d" % (id(self) % 250)}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, json.loads(res.read() or b"null")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, None

    def post(self, p, b=None):
        return self.req("POST", p, b if b is not None else {})

    def get(self, p):
        return self.req("GET", p)

    def delete(self, p):
        return self.req("DELETE", p, {})


def now_ms():
    return int(time.time() * 1000)


def board(bid, name="Casa", **kw):
    return {"id": bid, "kind": "board", "boardId": bid, "updatedAt": now_ms(), "data": {"name": name, "color": "#0E6B62", "labels": [], "pos": 1, **kw}}


def column(cid, bid, name="Por hacer", done=False, **kw):
    return {"id": cid, "kind": "column", "boardId": bid, "updatedAt": now_ms(), "data": {"name": name, "pos": 1, "wip": None, "isDone": done, **kw}}


def card(cid, bid, col, title="Tarea", **kw):
    d = {"columnId": col, "title": title, "description": "", "due": "", "dueTime": "", "priority": "", "labels": [],
         "checklist": [], "pos": 1, "done": False, "archived": False}
    d.update(kw)
    return {"id": cid, "kind": "card", "boardId": bid, "updatedAt": now_ms(), "data": d}


class BackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.FILES_DIR = os.path.join(cls.tmp.name, "files")
        cls.store = server.Store(os.path.join(cls.tmp.name, "t.db"))
        cls.srv = server.make_server(cls.store, "127.0.0.1", 0)
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        for rl in server.LIMITERS:
            rl.clear()

    def user(self, prefix="user"):
        BackendTest.n += 1
        name = "%s%d" % (prefix, BackendTest.n)
        c = Client(self.base)
        st, r = c.post("/api/auth/register", {"username": name, "password": "secreto123", "name": name.title(), "consent": True})
        self.assertEqual(st, 200, r)
        c.token = r["token"]
        c.username = name
        c.code = r["recoveryCode"]
        return c

    def sync(self, c, changes=(), since=0):
        st, r = c.post("/api/sync", {"since": since, "changes": list(changes)})
        self.assertEqual(st, 200, r)
        return r

    def new_board(self, c, bid="B" * 22, col="C" * 22):
        r = self.sync(c, [board(bid), column(col, bid)])
        self.assertFalse(r["rejected"], r["rejected"])
        return bid, col

    def share(self, owner, other, bid, role):
        st, r = owner.post("/api/boards/%s/members" % bid, {"username": other.username, "role": role})
        self.assertEqual(st, 200, r)
        st, r = other.post("/api/invitations/%s" % bid, {"accept": True})
        self.assertEqual(st, 200, r)

    # ---------------------------------------------------------------- cuentas

    def test_register_login_logout(self):
        a = self.user()
        st, r = Client(self.base).post("/api/auth/login", {"username": a.username, "password": "secreto123"})
        self.assertEqual(st, 200)
        st, _ = Client(self.base).post("/api/auth/login", {"username": a.username, "password": "malamala"})
        self.assertEqual(st, 401)
        st, _ = Client(self.base).post("/api/auth/login", {"username": "noexiste", "password": "malamala"})
        self.assertEqual(st, 401)
        self.assertEqual(a.post("/api/auth/logout")[0], 200)
        self.assertEqual(a.get("/api/me")[0], 401)

    def test_register_validation(self):
        c = Client(self.base)
        self.assertEqual(c.post("/api/auth/register", {"username": "AB", "password": "secreto123", "consent": True})[0], 400)
        self.assertEqual(c.post("/api/auth/register", {"username": "valido1", "password": "corta", "consent": True})[0], 400)
        self.assertEqual(c.post("/api/auth/register", {"username": "valido1", "password": "secreto123"})[0], 400)
        a = self.user()
        self.assertEqual(c.post("/api/auth/register", {"username": a.username, "password": "secreto123", "consent": True})[0], 409)

    def test_signup_closed(self):
        os.environ["TB_ALLOW_SIGNUP"] = "0"
        try:
            st, r = Client(self.base).post("/api/auth/register", {"username": "cerrado1", "password": "secreto123", "consent": True})
            self.assertEqual((st, r["error"]), (403, "signup_closed"))
        finally:
            os.environ["TB_ALLOW_SIGNUP"] = "1"

    def test_recover(self):
        a = self.user()
        c = Client(self.base)
        self.assertEqual(c.post("/api/auth/recover", {"username": a.username, "code": "AAAA-AAAA-AAAA-AAAA", "password": "nueva12345"})[0], 401)
        st, r = c.post("/api/auth/recover", {"username": a.username, "code": a.code.lower(), "password": "nueva12345"})
        self.assertEqual(st, 200)
        self.assertNotEqual(r["recoveryCode"], a.code)
        self.assertEqual(a.get("/api/me")[0], 401, "la recuperación cierra las sesiones anteriores")
        # el código viejo ya no sirve
        self.assertEqual(c.post("/api/auth/recover", {"username": a.username, "code": a.code, "password": "otra123456"})[0], 401)

    def test_change_password_closes_other_sessions(self):
        a = self.user()
        other = Client(self.base, Client(self.base).post("/api/auth/login", {"username": a.username, "password": "secreto123"})[1]["token"])
        self.assertEqual(a.post("/api/me/password", {"current": "mala", "password": "nueva12345"})[0], 403)
        st, r = a.post("/api/me/password", {"current": "secreto123", "password": "nueva12345"})
        self.assertEqual(st, 200)
        self.assertEqual(other.get("/api/me")[0], 401)
        a.token = r["token"]
        self.assertEqual(a.get("/api/me")[0], 200)

    def test_rate_limit_login(self):
        a = self.user()
        c = Client(self.base)
        codes = [c.post("/api/auth/login", {"username": a.username, "password": "mala%d" % i})[0] for i in range(12)]
        self.assertIn(429, codes)
        # Los fallos desde otra IP no bloquean a quien sabe la contraseña.
        ok = Client(self.base)
        st, _ = ok.req("POST", "/api/auth/login", {"username": a.username, "password": "secreto123"}, {"X-Real-IP": "10.9.9.9"})
        self.assertEqual(st, 200)
        # Nombres raros no comparten contador con otros límites internos.
        for i in range(12):
            c.post("/api/auth/login", {"username": "recover:%s" % a.username, "password": "x"})
        server.AUTH_IP.clear()
        st, _ = c.post("/api/auth/recover", {"username": a.username, "code": a.code, "password": "nueva12345"})
        self.assertEqual(st, 200)

    def test_token_expiry(self):
        a = self.user()
        with self.store.lock:
            self.store.x("UPDATE tokens SET last_used=last_used-? ", (server.TOKEN_IDLE + 10,))
        self.assertEqual(a.get("/api/me")[0], 401)

    def test_consent_required_for_sync(self):
        a = self.user()
        with self.store.lock:
            self.store.x("UPDATE users SET policy_version='antigua' WHERE username=?", (a.username,))
        st, r = a.post("/api/sync", {"since": 0, "changes": []})
        self.assertEqual(st, 428)
        self.assertTrue(a.get("/api/me")[1]["user"]["needsConsent"])
        self.assertEqual(a.post("/api/me", {"consent": True})[0], 200)
        self.assertEqual(a.post("/api/sync", {"since": 0, "changes": []})[0], 200)

    # ---------------------------------------------------------------- sincronización

    def test_sync_roundtrip_and_cursor(self):
        a = self.user()
        bid, col = self.new_board(a, "b1" + "x" * 20, "c1" + "x" * 20)
        r = self.sync(a)
        ids = {x["id"] for x in r["changes"]}
        self.assertEqual(ids, {bid, col})
        self.assertEqual(r["boards"][0]["role"], "owner")
        cur = r["cursor"]
        r2 = self.sync(a, since=cur)
        self.assertEqual(r2["changes"], [])
        r3 = self.sync(a, [card("k1" + "x" * 20, bid, col, "Hola")], since=cur)
        self.assertEqual([x["id"] for x in r3["changes"]], ["k1" + "x" * 20])

    def test_validation_rejects_bad_data(self):
        a = self.user()
        bid, col = self.new_board(a, "b2" + "x" * 20, "c2" + "x" * 20)
        bad = [
            card("k2" + "a" * 20, bid, col, title=""),
            card("k2" + "b" * 20, bid, col, due="2026-13-40"),
            card("k2" + "c" * 20, bid, col, priority="urgente"),
            card("k2" + "d" * 20, bid, "noexiste" + "x" * 10),
            card("k2" + "e" * 20, bid, col, title="x" * 201),
            {**card("k2" + "f" * 20, bid, col), "updatedAt": now_ms() + 5 * 86400_000},
            column("c2" + "y" * 20, bid, wip=0),
            board("b2" + "y" * 20, color="red"),
        ]
        r = self.sync(a, bad)
        self.assertEqual(len(r["rejected"]), len(bad), r["rejected"])
        # Campos desconocidos se descartan.
        ok = card("k2" + "g" * 20, bid, col, malicioso="<script>")
        self.sync(a, [ok])
        with self.store.lock:
            data = json.loads(self.store.one("SELECT data FROM records WHERE id=?", (ok["id"],))["data"])
        self.assertNotIn("malicioso", data)

    def test_stale_update_rejected(self):
        a = self.user()
        bid, col = self.new_board(a, "b3" + "x" * 20, "c3" + "x" * 20)
        k = card("k3" + "x" * 20, bid, col, "v2")
        self.sync(a, [k])
        old = dict(k, updatedAt=k["updatedAt"] - 1000)
        old["data"] = dict(k["data"], title="v1")
        r = self.sync(a, [old])
        self.assertEqual(r["rejected"][0]["reason"], "stale")
        self.assertEqual(r["rejected"][0]["current"]["data"]["title"], "v2")

    def test_isolation_between_users(self):
        a, b = self.user(), self.user()
        bid, col = self.new_board(a, "b4" + "x" * 20, "c4" + "x" * 20)
        self.sync(a, [card("k4" + "x" * 20, bid, col, "Secreto")])
        r = self.sync(b)
        self.assertEqual(r["changes"], [])
        # b no puede escribir, ni crear tarjetas, ni robar el id del tablero
        r = self.sync(b, [card("k4" + "x" * 20, bid, col, "Pisado"), card("k4" + "y" * 20, bid, col), board(bid, "Mío")])
        self.assertEqual(len(r["rejected"]), 3)
        for rj in r["rejected"]:
            self.assertIsNone(rj["current"], "no se filtra contenido ajeno en el rechazo")
        self.assertEqual(self.get_title("k4" + "x" * 20), "Secreto")
        self.assertEqual(b.get("/api/boards/%s/members" % bid)[0], 403)

    def get_title(self, cid):
        with self.store.lock:
            return json.loads(self.store.one("SELECT data FROM records WHERE id=?", (cid,))["data"])["title"]

    def test_card_cannot_move_to_other_board(self):
        a = self.user()
        b1, c1 = self.new_board(a, "b5" + "x" * 20, "c5" + "x" * 20)
        b2, c2 = self.new_board(a, "b5" + "y" * 20, "c5" + "y" * 20)
        k = card("k5" + "x" * 20, b1, c1)
        self.sync(a, [k])
        moved = dict(card("k5" + "x" * 20, b2, c2), updatedAt=now_ms() + 10)
        r = self.sync(a, [moved])
        self.assertEqual(r["rejected"][0]["reason"], "invalid:columnId")

    # ---------------------------------------------------------------- compartir

    def test_share_roles(self):
        a, b, c = self.user(), self.user(), self.user()
        bid, col = self.new_board(a, "b6" + "x" * 20, "c6" + "x" * 20)
        self.sync(a, [card("k6" + "x" * 20, bid, col, "Compartida")])

        # Invitación pendiente: b aún no ve nada, pero sí el nombre del tablero.
        self.assertEqual(a.post("/api/boards/%s/members" % bid, {"username": b.username, "role": "read"})[0], 200)
        self.assertEqual(self.sync(b)["changes"], [])
        inv = b.get("/api/invitations")[1]["invitations"]
        self.assertEqual(inv[0]["boardName"], "Casa")
        self.assertEqual(inv[0]["from"], a.username)
        cur_b = self.sync(b)["cursor"]
        self.assertEqual(b.post("/api/invitations/%s" % bid, {"accept": True})[0], 200)
        # Tras aceptar, la siguiente sincronización trae el tablero entero aunque sea anterior al cursor.
        r = self.sync(b, since=cur_b)
        self.assertEqual({x["id"] for x in r["changes"]}, {bid, col, "k6" + "x" * 20})
        self.assertEqual(r["boards"][0]["role"], "read")

        # Lectura no puede escribir.
        r = self.sync(b, [card("k6" + "y" * 20, bid, col)])
        self.assertEqual(r["rejected"][0]["reason"], "forbidden")
        # Lectura no puede invitar.
        self.assertEqual(b.post("/api/boards/%s/members" % bid, {"username": c.username, "role": "read"})[0], 403)

        # Escritura: tarjetas sí, columnas no.
        self.assertEqual(a.post("/api/boards/%s/members/%s" % (bid, b.username), {"role": "write"})[0], 200)
        r = self.sync(b, [card("k6" + "y" * 20, bid, col, "De b"), column("c6" + "y" * 20, bid, "Nueva")])
        self.assertEqual([x["id"] for x in r["rejected"]], ["c6" + "y" * 20])
        # a recibe la tarjeta de b
        self.assertIn("k6" + "y" * 20, {x["id"] for x in self.sync(a)["changes"]})

        # Todo: columnas e invitar, pero no borrar el tablero ni tocar al anfitrión.
        self.assertEqual(a.post("/api/boards/%s/members/%s" % (bid, b.username), {"role": "admin"})[0], 200)
        r = self.sync(b, [column("c6" + "y" * 20, bid, "Nueva")])
        self.assertEqual(r["rejected"], [])
        self.assertEqual(b.post("/api/boards/%s/members" % bid, {"username": c.username, "role": "read"})[0], 200)
        self.assertEqual(b.post("/api/boards/%s/members/%s" % (bid, a.username), {"role": "read"})[0], 403)
        self.assertEqual(b.delete("/api/boards/%s/members/%s" % (bid, a.username))[0], 403)
        r = self.sync(b, [{"id": bid, "kind": "board", "boardId": bid, "updatedAt": now_ms() + 50, "deleted": True}])
        self.assertEqual(r["rejected"][0]["reason"], "forbidden")
        self.assertEqual(b.post("/api/boards/%s/members" % bid, {"username": a.username, "role": "read"})[0], 409)

        # Miembros: un gestor ve los pendientes; c (pendiente) no ve nada.
        mem = b.get("/api/boards/%s/members" % bid)[1]["members"]
        self.assertEqual({m["username"]: m["status"] for m in mem}[c.username], "pending")
        self.assertEqual(c.get("/api/boards/%s/members" % bid)[0], 403)

        # Quitar a b: deja de recibirlo.
        self.assertEqual(a.delete("/api/boards/%s/members/%s" % (bid, b.username))[0], 200)
        r = self.sync(b)
        self.assertEqual(r["boards"], [])
        self.assertEqual(r["changes"], [])

    def test_read_member_sees_pending_invites_hidden(self):
        a, b, c = self.user(), self.user(), self.user()
        bid, _ = self.new_board(a, "b7" + "x" * 20, "c7" + "x" * 20)
        self.share(a, b, bid, "read")
        a.post("/api/boards/%s/members" % bid, {"username": c.username, "role": "read"})
        mem = b.get("/api/boards/%s/members" % bid)[1]["members"]
        self.assertNotIn(c.username, {m["username"] for m in mem})

    def test_leave_and_owner_cannot_leave(self):
        a, b = self.user(), self.user()
        bid, _ = self.new_board(a, "b8" + "x" * 20, "c8" + "x" * 20)
        self.share(a, b, bid, "write")
        self.assertEqual(a.delete("/api/boards/%s/members/%s" % (bid, a.username))[0], 403)
        self.assertEqual(b.delete("/api/boards/%s/members/%s" % (bid, b.username))[0], 200)
        self.assertEqual(self.sync(b)["boards"], [])

    def test_owner_deletes_board(self):
        a, b = self.user(), self.user()
        bid, col = self.new_board(a, "b9" + "x" * 20, "c9" + "x" * 20)
        self.share(a, b, bid, "admin")
        r = self.sync(a, [{"id": bid, "kind": "board", "boardId": bid, "updatedAt": now_ms() + 10, "deleted": True}])
        self.assertEqual(r["rejected"], [])
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM records WHERE board_id=?", (bid,))[0], 0)
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM members WHERE board_id=?", (bid,))[0], 0)
        self.assertEqual(self.sync(b)["boards"], [])

    def test_invite_errors(self):
        a, b = self.user(), self.user()
        bid, _ = self.new_board(a, "ba" + "x" * 20, "ca" + "x" * 20)
        self.assertEqual(a.post("/api/boards/%s/members" % bid, {"username": "noexiste", "role": "read"})[0], 404)
        self.assertEqual(a.post("/api/boards/%s/members" % bid, {"username": b.username, "role": "owner"})[0], 400)
        self.assertEqual(a.post("/api/boards/%s/members" % bid, {"username": a.username, "role": "read"})[0], 404)
        b.post("/api/me", {"acceptInvites": False})
        self.assertEqual(a.post("/api/boards/%s/members" % bid, {"username": b.username, "role": "read"})[0], 404)
        b.post("/api/me", {"acceptInvites": True})
        self.assertEqual(a.post("/api/boards/%s/members" % bid, {"username": b.username, "role": "read"})[0], 200)
        self.assertEqual(b.post("/api/invitations/%s" % bid, {"accept": False})[0], 200)
        self.assertEqual(b.get("/api/invitations")[1]["invitations"], [])
        self.assertEqual(self.sync(b)["boards"], [])

    # ---------------------------------------------------------------- privacidad

    def test_export_and_delete_account(self):
        a, b = self.user(), self.user()
        own, col = self.new_board(a, "bb" + "x" * 20, "cb" + "x" * 20)
        other, ocol = self.new_board(b, "bb" + "y" * 20, "cb" + "y" * 20)
        self.share(b, a, other, "write")
        self.sync(a, [card("kb" + "x" * 20, own, col, "Mía"), card("kb" + "y" * 20, other, ocol, "En tablero ajeno")])
        st, exp = a.get("/api/export")
        self.assertEqual(st, 200)
        self.assertEqual({x["id"] for x in exp["boards"]}, {own, other})
        self.assertIn("kb" + "x" * 20, {x["id"] for x in exp["records"]})
        self.assertNotIn("pw_hash", json.dumps(exp))

        self.assertEqual(a.post("/api/me/delete", {"password": "mala"})[0], 403)
        self.assertEqual(a.post("/api/me/delete", {"password": "secreto123"})[0], 200)
        self.assertEqual(a.get("/api/me")[0], 401)
        with self.store.lock:
            self.assertIsNone(self.store.one("SELECT 1 FROM users WHERE username=?", (a.username,)))
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM records WHERE board_id=?", (own,))[0], 0)
            # La tarjeta en el tablero ajeno se queda en ese tablero.
            self.assertIsNotNone(self.store.one("SELECT 1 FROM records WHERE id=?", ("kb" + "y" * 20,)))
        mem = b.get("/api/boards/%s/members" % other)[1]["members"]
        self.assertEqual([m["username"] for m in mem], [b.username])

    # ---------------------------------------------------------------- robustez

    def test_bad_requests(self):
        a = self.user()
        self.assertEqual(a.req("POST", "/api/sync", None, {"Content-Type": "application/json", "Content-Length": "999999999"})[0], 413)
        r = urllib.request.Request(self.base + "/api/sync", data=b"no-json", method="POST",
                                   headers={"Authorization": "Bearer " + a.token, "Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(r)
        self.assertEqual(cm.exception.code, 400)
        self.assertEqual(a.post("/api/sync", {"since": "x"})[0], 400)
        self.assertEqual(a.post("/api/sync", {"since": 0, "changes": "x"})[0], 400)
        r = self.sync(a, [None, 5, {"id": "../../etc", "kind": "card"}, {"id": "z" * 22, "kind": "evil"}])
        # Sin id válido no hay nada que devolver; con id válido pero tipo desconocido, se rechaza.
        self.assertEqual([(x["id"], x["reason"]) for x in r["rejected"]], [("z" * 22, "invalid")])
        self.assertEqual(Client(self.base).get("/api/me")[0], 401)
        self.assertEqual(Client(self.base, "x" * 500).get("/api/me")[0], 401)
        self.assertEqual(a.get("/api/nada")[0], 404)
        self.assertEqual(a.get("/nada")[0], 404)

    def test_health_and_legal(self):
        st, r = Client(self.base).get("/api/health")
        self.assertEqual(st, 200)
        self.assertEqual(r["policyVersion"], server.POLICY_VERSION)
        os.environ["TB_OPERATOR_NAME"] = "Prueba"
        try:
            self.assertEqual(Client(self.base).get("/api/legal")[1]["operator"], "Prueba")
        finally:
            del os.environ["TB_OPERATOR_NAME"]

    def test_pagination(self):
        a = self.user()
        bid, col = self.new_board(a, "bc" + "x" * 20, "cc" + "x" * 20)
        old_page = server.PAGE
        server.PAGE = 5
        try:
            self.sync(a, [card("kc%04d" % i + "x" * 16, bid, col, "T%d" % i) for i in range(12)])
            seen, since, rounds = set(), 0, 0
            while True:
                r = self.sync(a, since=since)
                seen |= {x["id"] for x in r["changes"]}
                since = r["cursor"]
                rounds += 1
                if not r["more"]:
                    break
            self.assertEqual(len(seen), 14)
            self.assertGreater(rounds, 1)
        finally:
            server.PAGE = old_page

    def test_bad_tokens_do_not_block_valid_sessions(self):
        a = self.user()
        bad = Client(self.base, "x" * 40)
        codes = [bad.get("/api/me")[0] for _ in range(70)]
        self.assertIn(429, codes)
        # Desde la misma IP bloqueada, una sesión válida sigue funcionando.
        st, _ = a.req("GET", "/api/me", None, {"X-Real-IP": "10.0.0.%d" % (id(bad) % 250)})
        self.assertEqual(st, 200)

    def test_invalid_username_login_is_cheap_and_limited(self):
        c = Client(self.base)
        codes = [c.post("/api/auth/login", {"username": "X", "password": "loquesea1"})[0] for _ in range(25)]
        self.assertEqual(codes[0], 401)
        self.assertIn(429, codes)

    # ---------------------------------------------------------------- avisos

    def make_device(self):
        """Simula un navegador: claves del dispositivo como las genera PushManager.subscribe()."""
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        key = ec.generate_private_key(ec.SECP256R1())
        pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        auth = os.urandom(16)
        return key, {"endpoint": "https://web.push.apple.com/QGuQyavXutnMH%s" % os.urandom(4).hex(),
                     "keys": {"p256dh": server.b64u(pub), "auth": server.b64u(auth)}}

    def decrypt(self, key, sub, body):
        """Descifrado de referencia del lado del dispositivo (RFC 8291) para comprobar el cifrado."""
        import hashlib, hmac as hm
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
        as_public = body[21:21 + idlen]
        self.assertEqual(rs, 4096)
        ua_public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        ecdh = key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
        H = lambda k, d: hm.new(k, d, hashlib.sha256).digest()
        ikm = H(H(server.b64u_dec(sub["keys"]["auth"]), ecdh), b"WebPush: info\x00" + ua_public + as_public + b"\x01")
        prk = H(salt, ikm)
        plain = AESGCM(H(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]).decrypt(
            H(prk, b"Content-Encoding: nonce\x00\x01")[:12], body[21 + idlen:], None)
        self.assertEqual(plain[-1], 2)
        return json.loads(plain[:-1])

    def test_push_encryption_matches_reference(self):
        key, sub = self.make_device()
        body = server.encrypt_push(b'{"title":"hola"}', sub["keys"]["p256dh"], sub["keys"]["auth"])
        self.assertEqual(self.decrypt(key, sub, body), {"title": "hola"})
        # Comprobación cruzada con la implementación de referencia http_ece, si está disponible.
        try:
            import http_ece
        except ImportError:
            return
        self.assertEqual(http_ece.decrypt(body, private_key=key, auth_secret=server.b64u_dec(sub["keys"]["auth"]),
                                          version="aes128gcm"), b'{"title":"hola"}')

    def test_push_vapid_signature(self):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
        v = server.Vapid(self.store)
        hdr = v.header("https://web.push.apple.com/abc", "mailto:yo@example.com")
        t = hdr.split("t=")[1].split(",")[0]
        k = hdr.split("k=")[1]
        self.assertEqual(k, v.public)
        head, claims, sig = t.split(".")
        c = json.loads(server.b64u_dec(claims))
        self.assertEqual(c["aud"], "https://web.push.apple.com")
        self.assertEqual(c["sub"], "mailto:yo@example.com")
        raw = server.b64u_dec(sig)
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), v.public_raw).verify(
            der, ("%s.%s" % (head, claims)).encode(), ec.ECDSA(hashes.SHA256()))
        # La clave se conserva entre reinicios.
        self.assertEqual(server.Vapid(self.store).public, v.public)

    def test_push_subscribe_and_test(self):
        a, b = self.user(), self.user()
        st, r = a.get("/api/push/key")
        self.assertEqual(st, 200)
        self.assertEqual(len(server.b64u_dec(r["publicKey"])), 65)
        key, sub = self.make_device()
        # Solo servicios de avisos conocidos (nada de direcciones internas).
        bad = dict(sub, endpoint="https://192.168.1.20:8006/x")
        self.assertEqual(a.post("/api/push/subscribe", bad)[0], 400)
        self.assertEqual(a.post("/api/push/subscribe", dict(sub, keys={"p256dh": "AAAA", "auth": "BBBB"}))[0], 400)
        self.assertEqual(a.post("/api/push/subscribe", sub)[0], 200)

        sent = []

        class FakeRes:
            status = 201
            def __enter__(self): return self
            def __exit__(self, *e): return False

        def opener(req, timeout=10):
            sent.append(req)
            return FakeRes()
        server.PUSH_TEST.clear()
        self.srv.RequestHandlerClass.app.push_opener = opener
        try:
            st, r = a.post("/api/push/test")
            self.assertEqual(st, 200, r)
            self.assertEqual(r["results"], [{"service": "web.push.apple.com", "status": 201}])
            req = sent[0]
            self.assertEqual(req.get_header("Content-encoding"), "aes128gcm")
            self.assertTrue(req.get_header("Authorization").startswith("vapid t="))
            payload = self.decrypt(key, sub, req.data)
            self.assertEqual(payload["title"], "Tackboard")
            # b no recibe los avisos de a.
            self.assertEqual(b.post("/api/push/test")[1]["sent"], 0)
            # Un dispositivo que ya no existe (410) se olvida.
            FakeRes.status = 410
            def gone(req, timeout=10):
                import urllib.error
                raise urllib.error.HTTPError(req.full_url, 410, "Gone", {}, None)
            self.srv.RequestHandlerClass.app.push_opener = gone
            a.post("/api/push/test")
            with self.store.lock:
                self.assertEqual(self.store.one("SELECT COUNT(*) FROM push_subs WHERE endpoint=?", (sub["endpoint"],))[0], 0)
        finally:
            self.srv.RequestHandlerClass.app.push_opener = None
        # Darse de baja y borrar la cuenta limpian las suscripciones.
        self.assertEqual(a.post("/api/push/subscribe", sub)[0], 200)
        self.assertEqual(a.post("/api/push/unsubscribe", {"endpoint": sub["endpoint"]})[0], 200)
        a.post("/api/push/subscribe", sub)
        a.post("/api/me/delete", {"password": "secreto123"})
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM push_subs WHERE endpoint=?", (sub["endpoint"],))[0], 0)

    # ---------------------------------------------------------------- recordatorios

    def notify_setup(self, tz="Europe/Madrid"):
        """Usuario con un dispositivo suscrito, un tablero y un opener falso que recoge los envíos."""
        a = self.user()
        key, sub = self.make_device()
        self.assertEqual(a.post("/api/push/subscribe", sub)[0], 200)
        self.assertEqual(a.post("/api/push/prefs", {"tz": tz})[0], 200)
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        sent = []
        app = self.srv.RequestHandlerClass.app

        class Res:
            status = 201
            def __enter__(self): return self
            def __exit__(self, *e): return False

        def opener(req, timeout=10):
            sent.append(self.decrypt(key, sub, req.data))
            return Res()
        app.push_opener = opener
        self.addCleanup(lambda: setattr(app, "push_opener", None))
        with self.store.lock:
            self.store.x("DELETE FROM settings WHERE key='notify_scan'")
            self.store.x("DELETE FROM notify_log")
        return a, bid, col, sent, server.Notifier(app)

    @staticmethod
    def madrid_ms(y, mo, d, h, mi):
        from zoneinfo import ZoneInfo
        from datetime import datetime
        return int(datetime(y, mo, d, h, mi, tzinfo=ZoneInfo("Europe/Madrid")).timestamp() * 1000)

    def timed_card(self, a, bid, col, title, due_ms, due, due_time, reminders, **kw):
        c = card(server.b64u(os.urandom(16)), bid, col, title, due=due, dueTime=due_time, dueAt=due_ms,
                 alertBase=due_ms, reminders=reminders, **kw)
        r = self.sync(a, [c])
        self.assertEqual(r["rejected"], [])
        return c

    def test_reminder_sent_once_at_the_right_time(self):
        a, bid, col, sent, n = self.notify_setup()
        due = self.madrid_ms(2030, 3, 5, 10, 0)
        self.timed_card(a, bid, col, "Copia de seguridad", due, "2030-03-05", "10:00", ["1h", "due"])
        n.tick(due - 2 * 3600_000)                     # 08:00: nada
        self.assertEqual(sent, [])
        n.tick(due - 3600_000 + 20_000)                # 09:00:20 → "1 h antes"
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["body"], "Tienes una tarea que vence en 60 min")
        self.assertTrue(sent[0]["url"].startswith("/#/tarjeta/"))
        n.tick(due - 3600_000 + 50_000)                # sin repetir
        self.assertEqual(len(sent), 1)
        n.tick(due + 10_000)                           # 10:00:10 → "al vencer"
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[1]["body"], "Tienes una tarea que ha vencido")

    def test_reminder_with_titles_and_shared_board(self):
        a, bid, col, sent, n = self.notify_setup()
        b, c_ = self.user(), self.user()
        self.share(a, b, bid, "read")
        key_b, sub_b = self.make_device()
        b.post("/api/push/subscribe", sub_b)
        key_c, sub_c = self.make_device()
        c_.post("/api/push/subscribe", sub_c)        # c no es miembro
        a.post("/api/push/prefs", {"showTitles": True})
        due = self.madrid_ms(2030, 3, 6, 18, 0)
        self.timed_card(a, bid, col, "Material del campeonato", due, "2030-03-06", "18:00", ["15m"])
        n.tick(due - 20 * 60000)
        n.tick(due - 15 * 60000 + 1000)
        bodies = [s["body"] for s in sent]
        # La recibe a (con título) y b (sin título, su preferencia por defecto); c no.
        self.assertEqual(len(sent), 1 + 0, "el opener solo descifra con la clave de a")
        self.assertIn("«Material del campeonato» vence en 15 min", bodies)
        with self.store.lock:
            users = {r["user_id"] for r in self.store.q("SELECT user_id FROM notify_log")}
        uid = lambda cl: self.store.one("SELECT id FROM users WHERE username=?", (cl.username,))["id"]
        self.assertEqual(users, {uid(a), uid(b)})

    def test_quiet_hours_defer(self):
        a, bid, col, sent, n = self.notify_setup()
        a.post("/api/push/prefs", {"quiet": {"on": True, "start": "23:00", "end": "08:00"}})
        due = self.madrid_ms(2030, 3, 7, 3, 0)          # vence a las 03:00
        self.timed_card(a, bid, col, "Algo de madrugada", due, "2030-03-07", "03:00", ["1h"])
        n.tick(due - 3600_000 - 10_000)
        n.tick(due - 3600_000 + 10_000)                # 02:00: en silencio
        self.assertEqual(sent, [])
        n.tick(self.madrid_ms(2030, 3, 7, 7, 59))
        self.assertEqual(sent, [])
        n.tick(self.madrid_ms(2030, 3, 7, 8, 0) + 5000)  # al acabar el silencio
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["body"], "Tienes una tarea que venció a las 03:00")

    def test_done_or_moved_card_cancels(self):
        a, bid, col, sent, n = self.notify_setup()
        a.post("/api/push/prefs", {"quiet": {"on": True, "start": "00:00", "end": "09:00"}})
        due = self.madrid_ms(2030, 3, 8, 8, 0)
        c = self.timed_card(a, bid, col, "Se completa", due, "2030-03-08", "08:00", ["1h"])
        c2 = self.timed_card(a, bid, col, "Se mueve", due, "2030-03-08", "08:00", ["1h"])
        n.tick(due - 3600_000 - 10_000)
        n.tick(due - 3600_000 + 10_000)                # programados para las 09:00
        done = dict(c, updatedAt=now_ms() + 10); done["data"] = dict(c["data"], done=True)
        later = due + 86400_000
        moved = dict(c2, updatedAt=now_ms() + 10)
        moved["data"] = dict(c2["data"], due="2030-03-09", dueAt=later, alertBase=later)
        self.sync(a, [done, moved])
        n.tick(self.madrid_ms(2030, 3, 8, 9, 0) + 5000)
        self.assertEqual(sent, [])

    def test_muted_board_and_disabled(self):
        a, bid, col, sent, n = self.notify_setup()
        a.post("/api/push/prefs", {"mutedBoards": [bid]})
        due = self.madrid_ms(2030, 3, 9, 12, 0)
        self.timed_card(a, bid, col, "Silenciada", due, "2030-03-09", "12:00", ["due"])
        n.tick(due - 10_000)
        n.tick(due + 10_000)
        self.assertEqual(sent, [])
        a.post("/api/push/prefs", {"mutedBoards": [], "enabled": False})
        due2 = due + 3600_000
        self.timed_card(a, bid, col, "Desactivado", due2, "2030-03-09", "13:00", ["due"])
        n.tick(due2 + 10_000)
        self.assertEqual(sent, [])

    def test_all_day_and_digest(self):
        a, bid, col, sent, n = self.notify_setup()
        a.post("/api/push/prefs", {"digest": {"on": True, "time": "07:30"}})
        base = self.madrid_ms(2030, 3, 10, 9, 0)        # todo el día: referencia a las 9:00
        c = card(server.b64u(os.urandom(16)), bid, col, "Pagar el seguro", due="2030-03-10", dueTime="",
                 dueAt=self.madrid_ms(2030, 3, 10, 23, 59), alertBase=base, reminders=["1d"])
        self.sync(a, [c])
        n.tick(base - 86400_000 - 10_000)
        n.tick(base - 86400_000 + 10_000)              # día anterior a las 9:00
        self.assertEqual([s["body"] for s in sent], ["Tienes una tarea que vence mañana"])
        sent.clear()
        n.tick(self.madrid_ms(2030, 3, 10, 7, 29))
        self.assertEqual(sent, [])
        n.tick(self.madrid_ms(2030, 3, 10, 7, 31))
        self.assertEqual([s["body"] for s in sent], ["Tienes 1 tarea para hoy."])
        n.tick(self.madrid_ms(2030, 3, 10, 12, 0))     # una vez al día
        self.assertEqual(len(sent), 1)

    def test_notify_prefs_validation(self):
        a = self.user()
        st, r = a.get("/api/push/prefs")
        self.assertEqual(r["prefs"]["defaultReminders"], ["1h"])
        for bad in ({"defaultReminders": ["5m"]}, {"quiet": {"start": "25:00"}}, {"tz": "../etc/passwd"},
                    {"tz": "Marte/Olimpo"}, {"mutedBoards": ["x"]}, {"digest": "sí"}):
            self.assertEqual(a.post("/api/push/prefs", bad)[0], 400, bad)
        st, r = a.post("/api/push/prefs", {"defaultReminders": ["due", "1d", "1d"], "tz": "America/Mexico_City",
                                           "quiet": {"on": True}})
        self.assertEqual(r["prefs"]["defaultReminders"], ["1d", "due"])
        self.assertEqual(r["prefs"]["quiet"], {"on": True, "start": "23:00", "end": "08:00"})
        # Recordatorios de tarjeta: solo valores conocidos.
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        r = self.sync(a, [card(server.b64u(os.urandom(16)), bid, col, reminders=["ya"])])
        self.assertEqual(r["rejected"][0]["reason"], "invalid:reminders")

    def test_due_text(self):
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Europe/Madrid")
        now = self.madrid_ms(2030, 3, 5, 9, 0)
        f = lambda due, t, at: server.due_text({"due": due, "dueTime": t, "dueAt": at}, now, tz)
        self.assertEqual(f("2030-03-05", "09:30", self.madrid_ms(2030, 3, 5, 9, 30)), "vence en 30 min")
        self.assertEqual(f("2030-03-05", "18:00", self.madrid_ms(2030, 3, 5, 18, 0)), "vence hoy a las 18:00")
        self.assertEqual(f("2030-03-06", "10:00", self.madrid_ms(2030, 3, 6, 10, 0)), "vence mañana a las 10:00")
        self.assertEqual(f("2030-03-12", "10:00", self.madrid_ms(2030, 3, 12, 10, 0)), "vence el 12 de marzo a las 10:00")
        self.assertEqual(f("2030-03-05", "", None), "vence hoy")
        self.assertEqual(f("2030-03-08", "", None), "vence el viernes 8")

    def test_push_endpoint_strict(self):
        a = self.user()
        _, sub = self.make_device()
        for ep in ("https://a@fcm.googleapis.com/x", "https://fcm.googleapis.com:81/x", "https://fcm.googleapis.com:0/x",
                   "https://[::1]@fcm.googleapis.com/x", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.io/x",
                   "https://fcm.googleapis.com\\@evil.io/x", "https://fcm.googleapis.com/x#frag"):
            self.assertEqual(a.post("/api/push/subscribe", dict(sub, endpoint=ep))[0], 400, ep)
        self.assertEqual(a.post("/api/push/subscribe", dict(sub, endpoint="https://FCM.googleapis.com:443/fcm/send/abc"))[0], 200)
        with self.store.lock:
            self.assertIsNotNone(self.store.one("SELECT 1 FROM push_subs WHERE endpoint='https://fcm.googleapis.com/fcm/send/abc'"))

    def test_push_redirect_not_followed(self):
        import http.server
        hits = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                hits.append(self.path)
                self.send_response(302); self.send_header("Location", "/interno"); self.send_header("Content-Length", "0"); self.end_headers()
            do_GET = do_POST
            def log_message(self, *a): pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            key, sub = self.make_device()
            sb = {"endpoint": "http://127.0.0.1:%d/push" % srv.server_address[1], "p256dh": sub["keys"]["p256dh"], "auth": sub["keys"]["auth"]}
            st = server.send_push(server.Vapid(self.store), sb, {"t": 1}, "mailto:x@example.com")
            self.assertEqual(st, 302)
            self.assertEqual(hits, ["/push"], "no sigue la redirección")
        finally:
            srv.shutdown()

    def test_push_tied_to_session(self):
        a, bid, col, sent, n = self.notify_setup()
        with self.store.lock:
            uid = self.store.one("SELECT id FROM users WHERE username=?", (a.username,))["id"]
            count = lambda: self.store.one("SELECT COUNT(*) FROM push_subs WHERE user_id=?", (uid,))[0]
            self.assertEqual(count(), 1)
        # Otra sesión del mismo usuario cierra las demás: este dispositivo deja de recibir avisos.
        other = Client(self.base, Client(self.base).post("/api/auth/login", {"username": a.username, "password": "secreto123"})[1]["token"])
        other.post("/api/auth/logout-others")
        with self.store.lock:
            self.assertEqual(count(), 0)
        # Al cerrar sesión, también.
        _, sub2 = self.make_device()
        other.post("/api/push/subscribe", sub2)
        other.post("/api/auth/logout")
        with self.store.lock:
            self.assertEqual(count(), 0)

    def test_alert_base_must_match_due(self):
        a = self.user()
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        due = self.madrid_ms(2030, 4, 1, 10, 0)
        ok_card = card(server.b64u(os.urandom(16)), bid, col, due="2030-04-01", dueTime="10:00", dueAt=due, alertBase=due, reminders=["due"])
        self.assertEqual(self.sync(a, [ok_card])["rejected"], [])
        for bad in (dict(dueAt=due, alertBase=due + 60000), dict(dueAt=due + 2 * 86400_000, alertBase=due + 2 * 86400_000)):
            c = card(server.b64u(os.urandom(16)), bid, col, due="2030-04-01", dueTime="10:00", reminders=["due"], **bad)
            self.assertEqual(len(self.sync(a, [c])["rejected"]), 1, bad)

    def test_reminder_spam_limited(self):
        a, bid, col, sent, n = self.notify_setup()
        due = self.madrid_ms(2030, 4, 2, 12, 0)
        c = self.timed_card(a, bid, col, "Spam", due, "2030-04-02", "12:00", ["due"])
        n.tick(due - 10_000)
        n.tick(due + 1000)
        self.assertEqual(len(sent), 1)
        # Mover la hora un minuto cada vez no genera un aviso nuevo cada vez.
        for i in range(1, 4):
            t2 = due + i * 60000
            hhmm = "12:%02d" % i
            moved = dict(c, updatedAt=now_ms() + i * 10)
            moved["data"] = dict(c["data"], dueTime=hhmm, dueAt=t2, alertBase=t2)
            self.sync(a, [moved])
            n.tick(t2 + 1000)
        self.assertEqual(len(sent), 1)
        # Muchas tarjetas a la vez: sueltos hasta el tope y el resto en un resumen. Ninguno se pierde.
        due2 = self.madrid_ms(2030, 4, 2, 15, 0)
        many = server.BOARD_HOURLY_CAP + 15
        self.sync(a, [card(server.b64u(os.urandom(16)), bid, col, "T%d" % i, due="2030-04-02", dueTime="15:00",
                           dueAt=due2, alertBase=due2, reminders=["due"]) for i in range(many)])
        n.tick(due2 - 10_000)
        n.tick(due2 + 1000)
        n.tick(due2 + 31_000)
        n.tick(due2 + 61_000)
        singles = [m for m in sent[1:] if m["tag"].startswith("card-")]
        summaries = [m for m in sent[1:] if m["tag"] == "tackboard-summary"]
        self.assertEqual(len(singles), server.BOARD_HOURLY_CAP)
        self.assertEqual(len(summaries), 1)
        self.assertIn("%d tareas más" % (many - server.BOARD_HOURLY_CAP), summaries[0]["body"])
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM notify_log WHERE state=0")[0], 0)

    def test_burst_of_all_day_cards_not_lost(self):
        """150 tareas de todo el día (todas a las 9:00): todas se programan y llegan sueltas o en resumen."""
        a, bid, col, sent, n = self.notify_setup()
        base = self.madrid_ms(2030, 5, 6, 9, 0)
        old = server.SCHEDULE_TICK_CAP
        server.SCHEDULE_TICK_CAP = 40  # obliga a repartir la programación en varias revisiones
        self.addCleanup(setattr, server, "SCHEDULE_TICK_CAP", old)
        cards = [card(server.b64u(os.urandom(16)), bid, col, "D%d" % i, due="2030-05-06", alertBase=base,
                      reminders=["due"]) for i in range(150)]
        self.assertEqual(self.sync(a, cards)["rejected"], [])
        n.tick(base - 10_000)
        for i in range(6):                                   # revisiones cada 30 s
            n.tick(base + 1000 + i * 30_000)
        for i in range(1, 4):                                # y más tarde, por si quedó algo en cola
            n.tick(base + 1000 + i * server.SUMMARY_GAP_MS)
        with self.store.lock:
            states = dict(self.store.q("SELECT state, COUNT(*) FROM notify_log GROUP BY state"))
        self.assertEqual(states.get(1, 0) + states.get(5, 0), 150, states)
        self.assertNotIn(0, states)
        self.assertTrue(any(m["tag"] == "tackboard-summary" for m in sent))

    def test_shared_board_flood_does_not_hide_own_reminders(self):
        """Un miembro que llena un tablero compartido no tapa los avisos de los tableros propios."""
        a, bid, col, sent, n = self.notify_setup()
        b = self.user()
        bid_b, col_b = self.new_board(b, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        self.share(b, a, bid_b, "read")
        due = self.madrid_ms(2030, 5, 7, 12, 0)
        flood = [card(server.b64u(os.urandom(16)), bid_b, col_b, "F%d" % i, due="2030-05-07", dueTime="12:00",
                      dueAt=due, alertBase=due, reminders=["due"]) for i in range(60)]
        self.assertEqual(self.sync(b, flood)["rejected"], [])
        own = self.timed_card(a, bid, col, "Mía", due, "2030-05-07", "12:00", ["due"])
        n.tick(due - 10_000)
        n.tick(due + 1000)
        self.assertIn("card-" + own["id"], [m["tag"] for m in sent])

    def test_repeat_gap_ignores_stale_pending(self):
        """Un aviso programado y luego cambiado (dentro del silencio) no impide el nuevo."""
        a, bid, col, sent, n = self.notify_setup()
        due = self.madrid_ms(2030, 5, 8, 12, 0)
        c = self.timed_card(a, bid, col, "Mover", due, "2030-05-08", "12:00", ["due"])
        a.post("/api/push/prefs", {"quiet": {"on": True, "start": "11:00", "end": "12:10"}})
        n.tick(due + 1000)                 # programado para las 12:10 (silencio)
        self.assertEqual(sent, [])
        a.post("/api/push/prefs", {"quiet": {"on": False, "start": "11:00", "end": "12:10"}})
        t2 = due + 5 * 60000
        moved = dict(c, updatedAt=now_ms() + 50)
        moved["data"] = dict(c["data"], dueTime="12:05", dueAt=t2, alertBase=t2)
        self.sync(a, [moved])
        n.tick(t2 + 1000)
        self.assertEqual(len(sent), 1)

    def test_digest_enabled_before_its_time_comes_today(self):
        a = self.user()
        from zoneinfo import ZoneInfo
        from datetime import datetime, timedelta
        local = datetime.now(ZoneInfo("Europe/Madrid"))
        if local.hour >= 23:
            self.skipTest("demasiado tarde para la prueba")
        later = (local + timedelta(minutes=30)).strftime("%H:%M")
        if later < local.strftime("%H:%M"):
            self.skipTest("cruza la medianoche")
        a.post("/api/push/prefs", {"tz": "Europe/Madrid", "digest": {"on": True, "time": later}})
        with self.store.lock:
            uid = self.store.one("SELECT id FROM users WHERE username=?", (a.username,))["id"]
            p = server.load_prefs(self.store, uid)
        self.assertNotEqual(p.get("lastDigest"), local.date().isoformat())

    def test_subscription_survives_short_outage(self):
        a = self.user()
        _, sub = self.make_device()
        a.post("/api/push/subscribe", sub)
        app = self.srv.RequestHandlerClass.app
        with self.store.lock:
            uid = self.store.one("SELECT id FROM users WHERE username=?", (a.username,))["id"]

        class Res:
            status = 503
            def __enter__(self): return self
            def __exit__(self, *e): return False
        for _ in range(8):
            with self.store.lock:
                subs = server.active_subs(self.store, uid)
            server.send_to_subs(self.store, app.vapid(), subs, {"title": "x", "body": "y"}, "mailto:a@b.es",
                                opener=lambda req, timeout=10: Res())
        with self.store.lock:
            self.assertEqual(len(server.active_subs(self.store, uid)), 1)
            # Si lleva días fallando, sí se borra.
            self.store.x("UPDATE push_subs SET fail_since=? WHERE user_id=?", (server.now() - server.SUB_FAIL_WINDOW - 10, uid))
            subs = server.active_subs(self.store, uid)
        server.send_to_subs(self.store, app.vapid(), subs, {"title": "x", "body": "y"}, "mailto:a@b.es",
                            opener=lambda req, timeout=10: Res())
        with self.store.lock:
            self.assertEqual(len(server.active_subs(self.store, uid)), 0)

    def test_unsubscribe_uses_same_normalization(self):
        a = self.user()
        _, sub = self.make_device()
        sub["endpoint"] = sub["endpoint"].replace("https://web.push.apple.com/", "https://WEB.push.apple.com:443/") + ";x=1"
        self.assertEqual(a.post("/api/push/subscribe", sub)[0], 200)
        a.post("/api/push/unsubscribe", {"endpoint": sub["endpoint"]})
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM push_subs WHERE endpoint LIKE '%;x=1'")[0], 0)

    def test_disabled_user_gets_nothing(self):
        a, bid, col, sent, n = self.notify_setup()
        due = self.madrid_ms(2030, 4, 3, 12, 0)
        self.timed_card(a, bid, col, "X", due, "2030-04-03", "12:00", ["due"])
        n.tick(due - 10_000)
        with self.store.lock:
            self.store.x("UPDATE users SET disabled=1 WHERE username=?", (a.username,))
        n.tick(due + 1000)
        self.assertEqual(sent, [])

    # ---------------------------------------------------------------- 1.2: repetición, pomodoro, calendario

    def test_repeat_validation(self):
        a = self.user()
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        good = card(server.b64u(os.urandom(16)), bid, col, due="2030-01-31",
                    repeat={"freq": "month", "every": 1, "days": [], "day": 31})
        self.assertEqual(self.sync(a, [good])["rejected"], [])
        for bad in ({"freq": "hourly"}, {"freq": "week", "every": 0}, {"freq": "week", "days": [7]},
                    {"freq": "day", "every": "2"}, {"freq": "month", "day": 32}, "daily"):
            c = card(server.b64u(os.urandom(16)), bid, col, due="2030-01-31", repeat=bad)
            self.assertEqual(len(self.sync(a, [c])["rejected"]), 1, bad)
        # Sin fecha, la repetición se quita.
        c = card(server.b64u(os.urandom(16)), bid, col, repeat={"freq": "day", "every": 1, "days": []})
        self.sync(a, [c])
        r = self.sync(a)["changes"]
        self.assertIsNone([x for x in r if x["id"] == c["id"]][0]["data"]["repeat"])

    def pomo_setup(self):
        a, bid, col, sent, n = self.notify_setup()
        c = card(server.b64u(os.urandom(16)), bid, col, "Escribir informe")
        self.sync(a, [c])
        return a, bid, c["id"], sent, n

    def test_pomodoro_flow(self):
        a, bid, cid, sent, n = self.pomo_setup()
        st, r = a.post("/api/pomo/start", {"phase": "focus", "minutes": 25, "cardId": cid})
        self.assertEqual(st, 200, r)
        self.assertEqual(r["active"]["cardId"], cid)
        self.assertEqual(r["active"]["endsAt"] - r["active"]["startedAt"], 25 * 60000)
        end = r["active"]["endsAt"]
        self.assertEqual(n.pomo_tick(end - 1000), 0)
        self.assertEqual(n.pomo_tick(end + 1000), 1)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["title"], "Pomodoro terminado")
        self.assertNotIn("Escribir", sent[0]["body"])     # sin títulos por defecto
        self.assertEqual(sent[0]["url"], "/#/pomodoro")
        st, s = a.get("/api/pomo/stats?days=7")
        self.assertEqual(s["total"]["count"], 1)
        self.assertEqual(s["cards"][0]["cardId"], cid)
        self.assertEqual(s["boards"][0]["boardId"], bid)
        self.assertEqual(s["streak"], 1)
        # Descanso: avisa, pero no cuenta como pomodoro.
        st, r = a.post("/api/pomo/start", {"phase": "short", "minutes": 5, "cardId": cid})
        self.assertIsNone(r["active"]["cardId"])
        n.pomo_tick(r["active"]["endsAt"] + 1000)
        self.assertEqual(sent[-1]["title"], "Descanso terminado")
        self.assertEqual(a.get("/api/pomo/stats")[1]["total"]["count"], 1)
        # Detener: no cuenta.
        st, r = a.post("/api/pomo/start", {"phase": "focus", "minutes": 25})
        a.post("/api/pomo/stop", {"id": r["active"]["id"]})
        self.assertIsNone(a.get("/api/pomo")[1]["active"])
        n.pomo_tick(r["active"]["endsAt"] + 1000)
        self.assertEqual(a.get("/api/pomo/stats")[1]["total"]["count"], 1)
        # Sin avisos de pomodoro si se desactivan.
        a.post("/api/push/prefs", {"pomoPush": False})
        st, r = a.post("/api/pomo/start", {"phase": "focus", "minutes": 1})
        before = len(sent)
        n.pomo_tick(r["active"]["endsAt"] + 1000)
        self.assertEqual(len(sent), before)
        self.assertEqual(a.get("/api/pomo/stats")[1]["total"]["count"], 2)

    def test_pomodoro_validation_and_privacy(self):
        a, bid, cid, sent, n = self.pomo_setup()
        b = self.user()
        for body in ({"phase": "nap", "minutes": 5}, {"phase": "focus", "minutes": 0}, {"phase": "focus", "minutes": 121},
                     {"phase": "focus", "minutes": "25"}, {"phase": "focus", "minutes": 25, "cardId": "../x"}):
            self.assertEqual(a.post("/api/pomo/start", body)[0], 400, body)
        # Con una tarjeta de un tablero ajeno: prohibido.
        self.assertEqual(b.post("/api/pomo/start", {"phase": "focus", "minutes": 25, "cardId": cid})[0], 403)
        # Tras salir del tablero, sus estadísticas no nombran ni el tablero ni la tarjeta.
        self.share(a, b, bid, "read")
        st, r = b.post("/api/pomo/start", {"phase": "focus", "minutes": 25, "cardId": cid})
        self.assertEqual(st, 200)
        n.pomo_tick(r["active"]["endsAt"] + 1000)
        self.assertEqual(b.get("/api/pomo/stats")[1]["cards"][0]["cardId"], cid)
        a.delete("/api/boards/%s/members/%s" % (bid, b.username))
        s = b.get("/api/pomo/stats")[1]
        self.assertEqual(s["cards"], [])
        self.assertEqual(s["boards"], [{"boardId": None, "count": 1, "minutes": 25}])
        # En la exportación y al borrar la cuenta.
        exp = b.get("/api/export")[1]
        self.assertEqual(len(exp["pomodoros"]), 1)
        b.post("/api/me/delete", {"password": "secreto123"})
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM pomo_log WHERE card_id=? AND minutes=25", (cid,))[0], 0)

    def test_pomodoro_offline_log(self):
        a, bid, cid, sent, n = self.pomo_setup()
        t = now_ms()
        items = [{"cardId": cid, "startedAt": t - 3 * 3600_000, "minutes": 25},
                 {"cardId": cid, "startedAt": t - 3 * 3600_000 + 60_000, "minutes": 25},   # se solapa: no
                 {"startedAt": t - 8 * 86400_000, "minutes": 25},                          # muy antiguo: no
                 {"startedAt": t + 3600_000, "minutes": 25},                               # futuro: no
                 {"startedAt": t - 3600_000, "minutes": 500}]                              # demasiado largo: no
        st, r = a.post("/api/pomo/log", {"items": items})
        self.assertEqual((st, r["added"]), (200, 1))
        # Máximo diario.
        many = [{"startedAt": t - 2 * 3600_000 + i * 60_000, "minutes": 1} for i in range(50)]
        a.post("/api/pomo/log", {"items": many})
        with self.store.lock:
            n_day = self.store.one("SELECT COUNT(*) FROM pomo_log WHERE user_id=(SELECT id FROM users WHERE username=?)",
                                   (a.username,))[0]
        self.assertLessEqual(n_day, server.POMO_DAY_CAP)
        self.assertEqual(a.post("/api/pomo/log", {"items": "x"})[0], 400)

    def test_ical_feed(self):
        a = self.user()
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        bid2, col2 = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        due = self.madrid_ms(2030, 6, 1, 10, 30)
        self.sync(a, [
            card(server.b64u(os.urandom(16)), bid, col, "Reunión, con; comas\\y barra", due="2030-06-01", dueTime="10:30", dueAt=due, alertBase=due),
            card(server.b64u(os.urandom(16)), bid, col, "Todo el día", due="2030-06-02"),
            card(server.b64u(os.urandom(16)), bid, col, "Hecha", due="2030-06-02", done=True),
            card(server.b64u(os.urandom(16)), bid, col, "Sin fecha"),
            card(server.b64u(os.urandom(16)), bid2, col2, "Otro tablero " + "x" * 150, due="2030-06-03"),
        ])
        self.assertFalse(a.get("/api/ical")[1]["active"])
        st, r = a.post("/api/ical/new")
        self.assertEqual(st, 200)
        path = r["path"]
        anon = Client(self.base)

        def fetch(p=path):
            req = urllib.request.Request(self.base + p, headers={"X-Real-IP": "10.9.9.9", "Host": "tackboard.home.arpa"})
            try:
                with urllib.request.urlopen(req) as res:
                    return res.status, res.headers.get("Content-Type"), res.read().decode()
            except urllib.error.HTTPError as e:
                return e.code, None, ""
        st, ctype, body = fetch()
        self.assertEqual(st, 200)
        self.assertTrue(ctype.startswith("text/calendar"))
        self.assertIn("BEGIN:VCALENDAR\r\n", body)
        self.assertIn("SUMMARY:Reunión\\, con\\; comas\\\\y barra", body)
        self.assertIn("DTSTART:20300601T083000Z", body)
        self.assertIn("DTSTART;VALUE=DATE:20300602", body)
        self.assertIn("URL:https://tackboard.home.arpa/#/tarjeta/", body)
        self.assertNotIn("Hecha", body)
        self.assertNotIn("Sin fecha", body)
        self.assertTrue(all(len(l.encode()) <= 75 for l in body.split("\r\n")))
        # Excluir un tablero.
        a.post("/api/ical/prefs", {"excluded": [bid2]})
        self.assertNotIn("Otro tablero", fetch()[2])
        self.assertTrue(a.get("/api/ical")[1]["lastFetch"])
        # Un enlace nuevo invalida el anterior; desactivar, también.
        new_path = a.post("/api/ical/new")[1]["path"]
        self.assertEqual(fetch()[0], 404)
        self.assertEqual(fetch(new_path)[0], 200)
        self.assertEqual(a.get("/api/ical")[1]["excluded"], [bid2])
        a.post("/api/ical/revoke")
        self.assertEqual(fetch(new_path)[0], 404)
        # Enlaces inventados: 404 y, si se insiste, límite.
        codes = [fetch("/api/ical/%s.ics" % server.b64u(os.urandom(32)))[0] for _ in range(25)]
        self.assertEqual(codes[0], 404)
        self.assertIn(429, codes)
        self.assertEqual(anon.get("/api/ical")[0], 401)

    def test_ical_revoked_on_recover_and_disable(self):
        a = self.user()
        path = a.post("/api/ical/new")[1]["path"]
        with self.store.lock:
            uid = self.store.one("SELECT id FROM users WHERE username=?", (a.username,))["id"]
            self.store.x("UPDATE users SET disabled=1 WHERE id=?", (uid,))
        req = urllib.request.Request(self.base + path, headers={"X-Real-IP": "10.9.9.8"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 404)
        with self.store.lock:
            self.store.x("UPDATE users SET disabled=0 WHERE id=?", (uid,))
        st, r = Client(self.base).post("/api/auth/recover", {"username": a.username, "code": a.code, "password": "otrosecreto1"})
        self.assertEqual(st, 200, r)
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM ical_tokens WHERE user_id=?", (uid,))[0], 0)

    def test_review_fixes_v12(self):
        # repeatedAs que apunta a otro tablero: se ignora.
        a = self.user()
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        bid2, col2 = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        other = card(server.b64u(os.urandom(16)), bid2, col2, "En otro tablero")
        self.sync(a, [other])
        c = card(server.b64u(os.urandom(16)), bid, col, "Hecha", due="2030-01-01", done=True,
                 repeatedAs={"id": other["id"], "at": other["updatedAt"]})
        self.sync(a, [c])
        got = [x for x in self.sync(a)["changes"] if x["id"] == c["id"]][0]
        self.assertIsNone(got["data"]["repeatedAs"])
        # El tope diario de pomodoros no se salta enviándolos de más nuevo a más antiguo.
        t = now_ms()
        items = [{"startedAt": t - 3600_000 - i * 61_000, "minutes": 1} for i in range(50)]
        a.post("/api/pomo/log", {"items": items})
        a.post("/api/pomo/log", {"items": [{"startedAt": t - 20 * 3600_000 - i * 61_000, "minutes": 1} for i in range(50)]})
        with self.store.lock:
            n = self.store.one("SELECT COUNT(*) FROM pomo_log WHERE user_id=(SELECT id FROM users WHERE username=?)", (a.username,))[0]
        self.assertLessEqual(n, server.POMO_DAY_CAP)
        # Cambiar la contraseña o cerrar las demás sesiones desactiva el enlace de calendario.
        a.post("/api/ical/new")
        st, r = a.post("/api/me/password", {"current": "secreto123", "password": "secreto456"})
        self.assertEqual(st, 200, r)
        a.token = r.get("token", a.token)
        self.assertFalse(a.get("/api/ical")[1]["active"])
        a.post("/api/ical/new")
        a.post("/api/auth/logout-others")
        self.assertFalse(a.get("/api/ical")[1]["active"])

    def test_pomodoro_respects_global_switch(self):
        a, bid, cid, sent, n = self.pomo_setup()
        a.post("/api/push/prefs", {"enabled": False})
        st, r = a.post("/api/pomo/start", {"phase": "focus", "minutes": 5})
        before = len(sent)
        n.pomo_tick(r["active"]["endsAt"] + 1000)
        self.assertEqual(len(sent), before)

    # ---------------------------------------------------------------- 1.3: plantillas y adjuntos

    def tpl(self, **kw):
        t = {"name": "Proyecto", "color": "#2457A6", "labels": [{"id": "lbl0001", "name": "Error", "color": "#B4400B"}],
             "columns": [{"name": "Por hacer"}, {"name": "En curso", "wip": 3}, {"name": "Hecho", "isDone": True}],
             "cards": [{"col": 0, "title": "Primera", "labels": ["lbl0001"], "checklist": [{"text": "uno"}]}]}
        t.update(kw)
        return t

    def test_templates(self):
        a, b = self.user(), self.user()
        st, r = a.post("/api/templates", self.tpl())
        self.assertEqual(st, 200, r)
        t = r["templates"][0]
        self.assertEqual([c["name"] for c in t["columns"]], ["Por hacer", "En curso", "Hecho"])
        self.assertEqual(t["cards"][0]["checklist"], [{"text": "uno"}])
        # Solo las ve su dueño, y solo él las borra.
        self.assertEqual(b.get("/api/templates")[1]["templates"], [])
        self.assertEqual(len(b.delete("/api/templates/" + t["id"])[1]["templates"]), 0)
        self.assertEqual(len(a.get("/api/templates")[1]["templates"]), 1)
        for bad in (self.tpl(columns=[]), self.tpl(cards=[{"col": 9, "title": "x"}]), self.tpl(cards=[{"col": 0, "title": "x", "labels": ["otra000"]}]),
                    self.tpl(name=""), self.tpl(columns=[{"name": "x"}] * 51), self.tpl(color="red")):
            self.assertEqual(a.post("/api/templates", bad)[0], 400, bad)
        # Fechas o campos desconocidos se descartan.
        st, r = a.post("/api/templates", self.tpl(cards=[{"col": 0, "title": "x", "due": "2030-01-01", "secret": 1}]))
        self.assertEqual(set(r["templates"][-1]["cards"][0]), {"col", "title", "description", "priority", "labels", "checklist"})
        self.assertEqual(len(a.get("/api/export")[1]["templates"]), 2)
        a.delete("/api/templates/" + t["id"])
        self.assertEqual(len(a.get("/api/templates")[1]["templates"]), 1)

    JPEG = b"\xff\xd8\xff\xe0" + b"0" * 2000
    PDF = b"%PDF-1.7\n" + b"0" * 1000

    def up(self, c, card_id, data, mime="image/jpeg", name="foto.jpg"):
        return c.req("POST", "/api/files?card=%s&name=%s" % (card_id, urllib.parse.quote(name)), None,
                     {"Content-Type": mime}) if data is None else self._raw(c, "/api/files?card=%s&name=%s" % (card_id, urllib.parse.quote(name)), data, mime)

    def _raw(self, c, path, data, mime):
        h = {"X-Real-IP": "10.0.0.%d" % (id(c) % 250), "Authorization": "Bearer " + c.token, "Content-Type": mime}
        r = urllib.request.Request(self.base + path, data=data, method="POST", headers=h)
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, None

    def fetch_file(self, c, fid):
        r = urllib.request.Request(self.base + "/api/files/" + fid, headers={"X-Real-IP": "10.0.0.%d" % (id(c) % 250), "Authorization": "Bearer " + c.token})
        try:
            with urllib.request.urlopen(r) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, b""

    def test_attachments(self):
        a, b, outsider = self.user(), self.user(), self.user()
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        c = card(server.b64u(os.urandom(16)), bid, col, "Con foto")
        self.sync(a, [c])
        self.share(a, b, bid, "read")
        st, r = self.up(a, c["id"], self.JPEG)
        self.assertEqual(st, 200, r)
        fid = r["id"]
        st, h, body = self.fetch_file(a, fid)
        self.assertEqual((st, body), (200, self.JPEG))
        self.assertEqual(h["Content-Type"], "image/jpeg")
        self.assertIn("sandbox", h["Content-Security-Policy"])
        self.assertEqual(self.fetch_file(b, fid)[0], 200)            # lectura: puede ver
        self.assertEqual(self.fetch_file(outsider, fid)[0], 404)     # ajeno: no existe
        self.assertEqual(self.up(b, c["id"], self.JPEG)[0], 403)     # lectura: no puede subir
        self.assertEqual(self.up(outsider, c["id"], self.JPEG)[0], 403)
        # Tipo real comprobado, tamaño máximo y tipos admitidos.
        self.assertEqual(self.up(a, c["id"], b"<html><script>", "image/jpeg")[0], 415)
        self.assertEqual(self.up(a, c["id"], b"GIF89a....", "image/gif")[0], 400)
        self.assertEqual(self.up(a, c["id"], self.PDF, "application/pdf", "factura.pdf")[0], 200)
        old = server.MAX_FILE
        server.MAX_FILE = 1000
        try:
            self.assertEqual(self.up(a, c["id"], self.JPEG)[0], 413)
        finally:
            server.MAX_FILE = old
        # La tarjeta solo puede referirse a sus propios adjuntos.
        c2 = card(server.b64u(os.urandom(16)), bid, col, "Otra")
        att = {"id": fid, "name": "foto.jpg", "mime": "image/jpeg", "size": len(self.JPEG)}
        self.sync(a, [dict(c, updatedAt=now_ms() + 5, data=dict(c["data"], attachments=[att])),
                      dict(c2, data=dict(c2["data"], attachments=[att]))])
        got = {x["id"]: x["data"]["attachments"] for x in self.sync(a)["changes"] if x["kind"] == "card"}
        self.assertEqual([x["id"] for x in got[c["id"]]], [fid])
        self.assertEqual(got[c2["id"]], [])
        # Limpieza: el PDF no lo usa la tarjeta → se borra pasado un día; la foto, no.
        with self.store.lock:
            server.files_gc(self.store, server.now() + 2 * 86400)
            left = [r["id"] for r in self.store.q("SELECT id FROM attachments WHERE card_id=?", (c["id"],))]
        self.assertEqual(left, [fid])
        self.assertTrue(os.path.exists(server.file_path(fid)))
        # Borrar el adjunto: lectura no puede; escritura sí, y desaparece el archivo.
        b.delete("/api/files/" + fid)
        self.assertEqual(self.fetch_file(a, fid)[0], 200)
        a.delete("/api/files/" + fid)
        self.assertEqual(self.fetch_file(a, fid)[0], 404)
        self.assertFalse(os.path.exists(server.file_path(fid)))
        # Al borrar el tablero se borran sus archivos.
        st, r = self.up(a, c["id"], self.JPEG)
        fid2 = r["id"]
        self.assertEqual(len(a.get("/api/export")[1]["attachments"]), 1)
        self.sync(a, [{"id": bid, "kind": "board", "boardId": bid, "updatedAt": now_ms() + 50, "deleted": True}])
        self.assertFalse(os.path.exists(server.file_path(fid2)))

    def test_attachment_limits(self):
        a = self.user()
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        c = card(server.b64u(os.urandom(16)), bid, col, "Muchas")
        self.sync(a, [c])
        old = server.MAX_BOARD_FILES
        server.MAX_BOARD_FILES = 5000
        try:
            self.assertEqual(self.up(a, c["id"], self.JPEG)[0], 200)
            self.assertEqual(self.up(a, c["id"], self.JPEG)[0], 200)
            self.assertEqual(self.up(a, c["id"], self.JPEG)[0], 400)   # pasa del cupo del tablero
        finally:
            server.MAX_BOARD_FILES = old
        self.assertEqual(self.up(a, "noexiste123", self.JPEG)[0], 403)
        self.assertEqual(self.up(a, "../../etc", self.JPEG)[0], 400)

    def test_attachment_review_fixes(self):
        import socket
        a = self.user()
        bid, col = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        c = card(server.b64u(os.urandom(16)), bid, col, "Cupo")
        self.sync(a, [c])
        old = server.MAX_CARD_FILES
        server.MAX_CARD_FILES = 1
        try:
            # Una subida a medias pasa la primera comprobación; otra completa llena el cupo; la primera, al
            # terminar, ya no cabe.
            host, port = self.srv.server_address
            sk = socket.create_connection((host, port))
            body = self.JPEG
            head = ("POST /api/files?card=%s&name=a.jpg HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\n"
                    "Content-Type: image/jpeg\r\nContent-Length: %d\r\nX-Real-IP: 10.0.0.9\r\n\r\n" % (c["id"], a.token, len(body)))
            sk.sendall(head.encode() + body[:10])
            time.sleep(0.3)
            self.assertEqual(self.up(a, c["id"], self.JPEG)[0], 200)
            sk.sendall(body[10:])
            resp = sk.recv(4096).decode(errors="replace")
            sk.close()
            self.assertIn(" 400 ", resp.split("\r\n")[0])
        finally:
            server.MAX_CARD_FILES = old
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM attachments WHERE card_id=?", (c["id"],))[0], 1)
            fid = self.store.one("SELECT id FROM attachments WHERE card_id=?", (c["id"],))["id"]
        # El nombre y el tipo los pone el servidor.
        att = {"id": fid, "name": "factura.html", "mime": "application/pdf", "size": 1}
        self.sync(a, [dict(c, updatedAt=now_ms() + 5, data=dict(c["data"], attachments=[att]))])
        got = [x for x in self.sync(a)["changes"] if x["id"] == c["id"]][0]["data"]["attachments"][0]
        self.assertEqual((got["name"], got["mime"], got["size"]), ("foto.jpg", "image/jpeg", len(self.JPEG)))
        # La limpieza barre restos de subidas cortadas y archivos sin fila.
        d = os.path.join(server.FILES_DIR, "zz")
        os.makedirs(d, exist_ok=True)
        for f in ("zzhuerfano", "zzcortado.part"):
            open(os.path.join(d, f), "wb").write(b"x")
            os.utime(os.path.join(d, f), (time.time() - 3 * 86400,) * 2)
        server.files_gc(self.store)
        self.assertEqual(os.listdir(d), [])
        self.assertTrue(os.path.exists(server.file_path(fid)))

    # ---------------------------------------------------------------- 1.4: colaboración

    def comment(self, cid, bid, card_id, text, **kw):
        return {"id": cid, "kind": "comment", "boardId": bid, "updatedAt": now_ms() + kw.pop("dt", 0),
                "data": {"cardId": card_id, "text": text, **kw}}

    def collab_setup(self):
        a, bid, col, sent, n = self.notify_setup()
        b, r = self.user(), self.user()
        key_b, sub_b = self.make_device()
        self.assertEqual(b.post("/api/push/subscribe", sub_b)[0], 200)
        self.share(a, b, bid, "write")
        self.share(a, r, bid, "read")
        app = self.srv.RequestHandlerClass.app
        app.notices_sync = True
        self.addCleanup(lambda: setattr(app, "notices_sync", False))
        sent_b = []

        class Res:
            status = 201
            def __enter__(self): return self
            def __exit__(self, *e): return False
        def opener(req, timeout=10):
            ep = req.full_url
            if ep == sub_b["endpoint"]:
                sent_b.append(self.decrypt(key_b, sub_b, req.data))
            else:
                sent.append(ep)
            return Res()
        app.push_opener = opener
        c = card(server.b64u(os.urandom(16)), bid, col, "Llamar al fontanero")
        self.sync(a, [c])
        return a, b, r, bid, col, c, sent_b

    def test_assignees(self):
        a, b, r, bid, col, c, sent_b = self.collab_setup()
        outsider = self.user()
        upd = dict(c, updatedAt=now_ms() + 10, data=dict(c["data"], assignees=[b.username, outsider.username, "nadie_x"]))
        self.sync(a, [upd])
        got = [x for x in self.sync(a)["changes"] if x["id"] == c["id"]][0]["data"]
        self.assertEqual(got["assignees"], [b.username])          # solo miembros activos
        self.assertEqual(len(sent_b), 1)
        self.assertIn("te ha asignado una tarea", sent_b[0]["body"])
        self.assertNotIn("fontanero", sent_b[0]["body"])          # sin títulos por defecto
        # Volver a guardar sin cambiar responsables no avisa otra vez.
        self.sync(a, [dict(upd, updatedAt=now_ms() + 20, data=dict(got, title="Llamar al fontanero hoy"))])
        self.assertEqual(len(sent_b), 1)
        # Quien se asigna a sí mismo no recibe aviso; con avisos de actividad apagados, tampoco.
        b.post("/api/push/prefs", {"activityPush": False})
        c2 = card(server.b64u(os.urandom(16)), bid, col, "Otra", assignees=[b.username])
        self.sync(a, [c2])
        self.assertEqual(len(sent_b), 1)
        # La lista de personas de cada tablero llega con la sincronización.
        people = [x for x in self.sync(b)["boards"] if x["id"] == bid][0]["people"]
        self.assertEqual({p["username"] for p in people}, {a.username, b.username, r.username})
        self.assertEqual(len(a.post("/api/sync", {"since": 0, "changes": [card(server.b64u(os.urandom(16)), bid, col, "x", assignees=["A B"])]})[1]["rejected"]), 1)

    def test_comments(self):
        a, b, r, bid, col, c, sent_b = self.collab_setup()
        cm = self.comment(server.b64u(os.urandom(16)), bid, c["id"], "Viene el jueves", author="otro", createdAt=1)
        self.assertEqual(self.sync(a, [cm])["rejected"], [])
        got = [x for x in self.sync(b)["changes"] if x["id"] == cm["id"]][0]["data"]
        self.assertEqual(got["author"], a.username)                 # el autor lo pone el servidor
        self.assertGreater(got["createdAt"], 1)
        self.assertEqual(len(sent_b), 1)
        self.assertIn("ha comentado", sent_b[0]["body"])
        # Lectura: puede leer, no comentar.
        self.assertTrue(any(x["id"] == cm["id"] for x in self.sync(r)["changes"]))
        self.assertEqual(self.sync(r, [self.comment(server.b64u(os.urandom(16)), bid, c["id"], "hola")])["rejected"][0]["reason"], "forbidden")
        # Solo el autor lo edita; lo borran el autor o quien gestiona el tablero.
        edit = dict(cm, updatedAt=now_ms() + 50, data={"cardId": c["id"], "text": "Cambiado"})
        self.assertEqual(self.sync(b, [edit])["rejected"][0]["reason"], "forbidden")
        self.assertEqual(self.sync(a, [edit])["rejected"], [])
        cm_b = self.comment(server.b64u(os.urandom(16)), bid, c["id"], "Vale")
        self.sync(b, [cm_b])
        self.assertEqual(self.sync(r, [dict(cm_b, updatedAt=now_ms() + 60, deleted=True)])["rejected"][0]["reason"], "forbidden")
        self.assertEqual(self.sync(a, [dict(cm_b, updatedAt=now_ms() + 70, deleted=True)])["rejected"], [])
        # Un comentario debe ir en una tarjeta del mismo tablero.
        bid2, col2 = self.new_board(a, server.b64u(os.urandom(16)), server.b64u(os.urandom(16)))
        self.assertEqual(len(self.sync(a, [self.comment(server.b64u(os.urandom(16)), bid2, c["id"], "x")])["rejected"]), 1)
        # Al borrar la tarjeta se borran sus comentarios.
        self.sync(a, [dict(c, updatedAt=now_ms() + 80, deleted=True, data=None)])
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT deleted FROM records WHERE id=?", (cm["id"],))["deleted"], 1)

    def test_activity(self):
        a, b, r, bid, col, c, sent_b = self.collab_setup()
        done_col = server.b64u(os.urandom(16))
        self.sync(a, [column(done_col, bid, "Hecho", done=True)])
        self.sync(b, [dict(c, updatedAt=now_ms() + 10, data=dict(c["data"], columnId=done_col, done=True))])
        st, act = r.get("/api/boards/%s/activity" % bid)
        self.assertEqual(st, 200)
        kinds = [x["kind"] for x in act["items"]]
        self.assertEqual(kinds[:3], ["done", "moved", "created"])
        self.assertEqual(act["items"][0]["username"], b.username)
        self.assertEqual(act["items"][1]["detail"], "Hecho")
        self.assertEqual(self.user().get("/api/boards/%s/activity" % bid)[0], 403)
        # Un cambio rechazado no deja actividad.
        n = len(r.get("/api/boards/%s/activity" % bid)[1]["items"])
        bad = card(server.b64u(os.urandom(16)), bid, "noexiste12345678", "Columna mala")
        self.assertEqual(len(self.sync(a, [bad])["rejected"]), 1)
        self.assertEqual(len(r.get("/api/boards/%s/activity" % bid)[1]["items"]), n)
        # Al borrar la cuenta, su actividad queda sin nombre.
        b.post("/api/me/delete", {"password": "secreto123"})
        items = r.get("/api/boards/%s/activity" % bid)[1]["items"]
        self.assertIsNone([x for x in items if x["kind"] == "done"][0]["username"])

    def test_collab_review_fixes(self):
        a, b, r, bid, col, c, sent_b = self.collab_setup()
        # Muchos cambios de la misma tarjeta en una sincronización: poca actividad.
        t0 = now_ms()
        changes = [dict(c, updatedAt=t0 + 10 + i, data=dict(c["data"], done=bool(i % 2), assignees=[b.username] if i % 2 else []))
                   for i in range(100)]
        self.sync(a, changes)
        items = r.get("/api/boards/%s/activity" % bid)[1]["items"]
        self.assertLessEqual(len(items), 6)
        self.assertLessEqual(len(sent_b), 1)          # un solo aviso de asignación por tarjeta y sincronización
        # El texto de un comentario no queda en la actividad.
        cm = self.comment(server.b64u(os.urandom(16)), bid, c["id"], "mi contraseña es hunter2")
        self.sync(b, [cm])
        self.sync(b, [dict(cm, updatedAt=now_ms() + 200, deleted=True)])
        self.assertNotIn("hunter2", json.dumps(r.get("/api/boards/%s/activity" % bid)[1]))
        self.assertEqual(r.get("/api/boards/%s/activity?before=%d" % (bid, 2 ** 70))[0], 200)
        # Un nombre de usuario reutilizado no hereda comentarios ni tarjetas.
        cm2 = self.comment(server.b64u(os.urandom(16)), bid, c["id"], "Comentario de b")
        self.sync(b, [cm2])
        self.sync(a, [dict(c, updatedAt=now_ms() + 300, data=dict(c["data"], assignees=[b.username]))])
        name = b.username
        b.post("/api/me/delete", {"password": "secreto123"})
        b2 = Client(self.base)
        st, rr = b2.post("/api/auth/register", {"username": name, "password": "secreto123", "name": "Otro", "consent": True})
        self.assertEqual(st, 200, rr)
        b2.token, b2.username = rr["token"], name
        self.share(a, b2, bid, "write")
        got = {x["id"]: x for x in self.sync(b2)["changes"]}
        self.assertEqual(got[cm2["id"]]["data"]["author"], "")
        self.assertNotIn(name, got[c["id"]]["data"]["assignees"])
        self.assertEqual(self.sync(b2, [dict(cm2, updatedAt=now_ms() + 400, data={"cardId": c["id"], "text": "mío"})])["rejected"][0]["reason"], "forbidden")

    def test_unread_body_closes_connection(self):
        """Un cuerpo no leído no debe interpretarse como la siguiente petición (respuestas cruzadas)."""
        import socket
        port = self.srv.server_address[1]
        smuggled = b"GET /api/legal HTTP/1.1\r\nHost: x\r\n\r\n"
        req = (b"POST /api/me HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(smuggled)) + smuggled
        sk = socket.create_connection(("127.0.0.1", port), timeout=5)
        sk.sendall(req)
        data = b""
        while True:
            chunk = sk.recv(65536)
            if not chunk:
                break
            data += chunk
        sk.close()
        self.assertIn(b"401", data.split(b"\r\n")[0])
        self.assertNotIn(b"operator", data, "el cuerpo se ejecutó como otra petición")

    def test_deleted_board_cannot_be_recreated(self):
        a, b = self.user(), self.user()
        bid, col = self.new_board(a, "be" + "x" * 20, "ce" + "x" * 20)
        self.share(a, b, bid, "admin")
        self.sync(a, [{"id": bid, "kind": "board", "boardId": bid, "updatedAt": now_ms() + 10, "deleted": True}])
        # El cliente desfasado de b intenta "editar" el tablero borrado: no puede quedárselo.
        r = self.sync(b, [dict(board(bid, "Robado"), updatedAt=now_ms() + 20), column("ce" + "y" * 20, bid)])
        self.assertEqual(len(r["rejected"]), 2)
        self.assertEqual(r["boards"], [])

    def test_foreign_record_always_forbidden(self):
        a, b = self.user(), self.user()
        bid, col = self.new_board(a, "bf" + "x" * 20, "cf" + "x" * 20)
        r = self.sync(b, [dict(column(col, bid), kind="card")])
        self.assertEqual(r["rejected"][0]["reason"], "forbidden")

    def test_export_hides_pending_for_readers(self):
        a, b, c = self.user(), self.user(), self.user()
        bid, _ = self.new_board(a, "bg" + "x" * 20, "cg" + "x" * 20)
        self.share(a, b, bid, "read")
        a.post("/api/boards/%s/members" % bid, {"username": c.username, "role": "write"})
        exp = b.get("/api/export")[1]
        self.assertNotIn(c.username, json.dumps(exp))

    def test_control_chars_stripped(self):
        a = self.user()
        st, r = a.post("/api/me", {"name": "Eve\x1b[31m\u202eROJO"})
        self.assertEqual(r["user"]["name"], "Eve[31mROJO")
        bid, col = self.new_board(a, "bh" + "x" * 20, "ch" + "x" * 20)
        self.sync(a, [card("kh" + "x" * 20, bid, col, "Tí\u202etulo", description="línea 1\nlínea 2")])
        with self.store.lock:
            d = json.loads(self.store.one("SELECT data FROM records WHERE id=?", ("kh" + "x" * 20,))["data"])
        self.assertEqual(d["title"], "Título")
        self.assertEqual(d["description"], "línea 1\nlínea 2")

    def test_page_bytes_limit(self):
        a = self.user()
        bid, col = self.new_board(a, "bi" + "x" * 20, "ci" + "x" * 20)
        old = server.PAGE_BYTES
        server.PAGE_BYTES = 20000
        try:
            big = "ñ" * 4000  # 8 KB en UTF-8
            self.sync(a, [card("ki%02d" % i + "x" * 18, bid, col, description=big) for i in range(6)])
            seen, since, rounds = set(), 0, 0
            while True:
                r = self.sync(a, since=since)
                seen |= {x["id"] for x in r["changes"]}
                since, rounds = r["cursor"], rounds + 1
                if not r["more"]:
                    break
            self.assertEqual(len(seen), 8)
            self.assertGreaterEqual(rounds, 3)
        finally:
            server.PAGE_BYTES = old

    def test_record_size_in_bytes(self):
        a = self.user()
        bid, col = self.new_board(a, "bj" + "x" * 20, "cj" + "x" * 20)
        r = self.sync(a, [card("kj" + "x" * 20, bid, col, description="😀" * 9000)])  # 9000 caracteres, 36 KB
        self.assertEqual(r["rejected"][0]["reason"], "too_big")

    def test_column_and_card_limits(self):
        a = self.user()
        bid, col = self.new_board(a, "bd" + "x" * 20, "cd" + "x" * 20)
        old = server.MAX_CARDS
        server.MAX_CARDS = 3
        try:
            r = self.sync(a, [card("kd%02d" % i + "x" * 18, bid, col) for i in range(5)])
            self.assertEqual(len(r["rejected"]), 2)
        finally:
            server.MAX_CARDS = old


if __name__ == "__main__":
    unittest.main()
