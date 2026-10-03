"""Pruebas del backend: cd tackboard && python3 -m unittest discover -s tests -v"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
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
                self.assertEqual(self.store.one("SELECT COUNT(*) FROM push_subs")[0], 0)
        finally:
            self.srv.RequestHandlerClass.app.push_opener = None
        # Darse de baja y borrar la cuenta limpian las suscripciones.
        self.assertEqual(a.post("/api/push/subscribe", sub)[0], 200)
        self.assertEqual(a.post("/api/push/unsubscribe", {"endpoint": sub["endpoint"]})[0], 200)
        a.post("/api/push/subscribe", sub)
        a.post("/api/me/delete", {"password": "secreto123"})
        with self.store.lock:
            self.assertEqual(self.store.one("SELECT COUNT(*) FROM push_subs")[0], 0)

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
