"""Тесты безопасности релея. Каждый класс/тест соответствует пункту плана (метка [RLY-*]).

Запуск:  ./.venv-test/bin/pytest -v
"""
import base64
import hmac
import hashlib

import pytest
from fastapi.testclient import TestClient


def make_client(relay):
    return TestClient(relay.app)


def reg(client, login, password="password123", ip="10.0.0.1"):
    return client.post("/register", json={"login": login, "password": password},
                       headers={"x-forwarded-for": ip})


def login_req(client, login, password="password123", ip="10.0.0.1"):
    return client.post("/login", json={"login": login, "password": password},
                      headers={"x-forwarded-for": ip})


def recv_until(ws, want_t, skip=("peer",), limit=12):
    """Читает сообщения, пропуская служебные (peer), пока не встретит want_t."""
    for _ in range(limit):
        m = ws.receive_json()
        if m.get("t") == want_t:
            return m
        if m.get("t") in skip:
            continue
        # неожиданный тип — вернём, пусть тест разбирается
        return m
    raise AssertionError(f"не дождались сообщения t={want_t}")


# ====================================================================== базовое
def test_health(relay):
    c = make_client(relay)
    assert c.get("/health").text == "ok"


def test_reports_requires_secret(relay):
    c = make_client(relay)
    assert c.get("/reports").status_code == 403
    assert c.get("/reports", params={"key": "wrong"}).status_code == 403
    assert c.get("/reports", params={"key": relay.RELAY_SECRET}).status_code == 200


# ============================================================ [RLY-1] пароли
class TestPasswordPolicy:
    def test_short_password_rejected(self, relay):
        c = make_client(relay)
        r = reg(c, "alice", password="123")          # < 8
        assert r.status_code == 400
        assert "≥8" in r.json()["detail"]

    def test_login_equals_password_rejected(self, relay):
        c = make_client(relay)
        r = reg(c, "bob12345", password="bob12345")
        assert r.status_code == 400

    def test_strong_password_ok(self, relay):
        c = make_client(relay)
        r = reg(c, "carol", password="password123")
        assert r.status_code == 200
        assert r.json()["token"]

    def test_min_password_configurable(self, relay):
        relay.CFG.min_password = 12
        c = make_client(relay)
        assert reg(c, "dave", password="password123").status_code == 400  # 11 симв.
        assert reg(c, "dave", password="password1234").status_code == 200


# ====================================================== [RLY-2] сессии/токены
class TestSessions:
    def test_register_returns_working_session_token(self, relay):
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        assert relay.verify_token(tok) == "user1"

    def test_revoke_invalidates_token(self, relay):
        tok = relay.create_session("user1")
        assert relay.verify_token(tok) == "user1"
        sid = relay.token_sid(tok)
        assert relay.revoke_session("user1", sid) is True
        assert relay.verify_token(tok) is None        # отозван → недействителен

    def test_logout_revokes_current(self, relay):
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        assert c.post("/logout", headers={"Authorization": f"Bearer {tok}"}).json()["ok"]
        assert relay.verify_token(tok) is None

    def test_password_change_revokes_other_sessions(self, relay):
        c = make_client(relay)
        tok1 = reg(c, "user1", password="password123").json()["token"]
        tok2 = relay.create_session("user1")           # «второе устройство»
        r = c.post("/password", headers={"Authorization": f"Bearer {tok1}"},
                   json={"old_password": "password123", "new_password": "brandnew456"})
        assert r.status_code == 200
        assert relay.verify_token(tok1) == "user1"      # текущая сессия жива
        assert relay.verify_token(tok2) is None         # прочие отозваны

    def test_sessions_list_and_revoke_endpoint(self, relay):
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        relay.create_session("user1")                   # ещё одна
        lst = c.get("/sessions", headers={"Authorization": f"Bearer {tok}"}).json()["sessions"]
        assert len(lst) == 2
        target = next(s["sid"] for s in lst if s["sid"] != relay.token_sid(tok))
        c.post("/sessions/revoke", headers={"Authorization": f"Bearer {tok}"}, json={"sid": target})
        lst2 = c.get("/sessions", headers={"Authorization": f"Bearer {tok}"}).json()["sessions"]
        assert len(lst2) == 1

    def test_token_expires_after_ttl(self, relay, clock):
        relay.CFG.token_ttl = 100
        tok = relay.create_session("user1")
        assert relay.verify_token(tok) == "user1"
        clock.advance(101)
        assert relay.verify_token(tok) is None          # протух

    def test_sessions_endpoint_requires_auth(self, relay):
        c = make_client(relay)
        assert c.get("/sessions").status_code == 401
        assert c.get("/sessions", headers={"Authorization": "Bearer garbage"}).status_code == 401


# ================================================ [RLY-1] брутфорс/lockout
class TestBruteForce:
    def test_per_login_lockout(self, relay, clock):
        c = make_client(relay)
        reg(c, "victim", password="password123")
        for _ in range(relay.CFG.login_max_fails):
            assert login_req(c, "victim", password="wrong").status_code == 401
        # Лимит исчерпан → даже ПРАВИЛЬНЫЙ пароль теперь блокируется.
        r = login_req(c, "victim", password="password123")
        assert r.status_code == 429
        # После окна lockout — снова можно войти.
        clock.advance(relay.CFG.login_lockout + 1)
        assert login_req(c, "victim", password="password123").status_code == 200

    def test_lockout_window_resets_fail_counter(self, relay, clock):
        c = make_client(relay)
        reg(c, "victim", password="password123")
        for _ in range(relay.CFG.login_max_fails - 1):   # на 1 меньше порога
            login_req(c, "victim", password="wrong")
        clock.advance(relay.CFG.login_window + 1)         # окно прошло → счётчик сброшен
        # Ещё одна неудача НЕ должна сразу залочить (счётчик начался заново).
        login_req(c, "victim", password="wrong")
        assert login_req(c, "victim", password="password123").status_code == 200

    def test_per_ip_lockout_across_accounts(self, relay):
        relay.CFG.ip_login_max_fails = 3
        c = make_client(relay)
        # Разные несуществующие логины с одного IP — per-login lockout не сработает, per-IP да.
        for i in range(3):
            assert login_req(c, f"ghost{i}", password="whatever1", ip="6.6.6.6").status_code == 401
        # IP залочен → следующий вход с этого IP отбивается, даже для другого логина.
        assert login_req(c, "ghostX", password="whatever1", ip="6.6.6.6").status_code == 429
        # Другой IP не затронут.
        assert login_req(c, "ghostY", password="whatever1", ip="7.7.7.7").status_code == 401


# ============================================ [RLY-4] анти-абьюз регистрации
class TestRegistrationThrottle:
    def test_per_ip_register_limit(self, relay):
        relay.CFG.reg_max_per_ip = 2
        c = make_client(relay)
        assert reg(c, "usr1", ip="8.8.8.8").status_code == 200
        assert reg(c, "usr2", ip="8.8.8.8").status_code == 200
        assert reg(c, "usr3", ip="8.8.8.8").status_code == 429   # третий с того же IP — отбой
        assert reg(c, "usr4", ip="9.9.9.9").status_code == 200   # другой IP — ок


# ================================================ [RLY-6] legacy/stateless токены
class TestTokenGating:
    def test_legacy_shared_token_off_by_default(self, relay):
        assert relay.CFG.allow_legacy is False
        assert relay.verify_token(relay.LEGACY_TOKEN) is None

    def test_legacy_shared_token_when_enabled(self, relay):
        relay.CFG.allow_legacy = True
        assert relay.verify_token(relay.LEGACY_TOKEN) == "__legacy__"

    def _stateless(self, relay, login="olduser", ttl=10_000):
        exp = int(relay._now()) + ttl
        payload = f"{login}|{exp}"
        sig = hmac.new(relay.RELAY_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode()

    def test_stateless_token_accepted_when_allowed(self, relay):
        relay.CFG.allow_stateless = True
        assert relay.verify_token(self._stateless(relay)) == "olduser"

    def test_stateless_token_rejected_when_disabled(self, relay):
        relay.CFG.allow_stateless = False
        assert relay.verify_token(self._stateless(relay)) is None

    def test_forged_signature_rejected(self, relay):
        bad = base64.urlsafe_b64encode(b"hacker|9999999999|deadbeef").decode()
        assert relay.verify_token(bad) is None


# ==================================================== WS: форвард и изоляция
class TestWebSocketRouting:
    def test_basic_forward_app_to_pc(self, relay):
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        with c.websocket_connect(f"/ws?token={tok}&role=pc") as pc:
            with c.websocket_connect(f"/ws?token={tok}&role=app") as app:
                app.send_json({"t": "input", "data": "ls\n"})
                m = recv_until(pc, "input")
                assert m["data"] == "ls\n"

    def test_room_isolation_no_cross_account_leak(self, relay):
        """[ARCH] Ввод юзера A НЕ долетает до ПК юзера B."""
        c = make_client(relay)
        tokA = reg(c, "alice").json()["token"]
        tokB = reg(c, "bob").json()["token"]
        with c.websocket_connect(f"/ws?token={tokA}&role=pc") as pcA, \
             c.websocket_connect(f"/ws?token={tokB}&role=pc") as pcB:
            with c.websocket_connect(f"/ws?token={tokA}&role=app") as appA:
                appA.send_json({"t": "input", "data": "SECRET_A"})
                assert recv_until(pcA, "input")["data"] == "SECRET_A"   # A дошло до своего ПК
            with c.websocket_connect(f"/ws?token={tokB}&role=app") as appB:
                appB.send_json({"t": "input", "data": "DATA_B"})
                # Первое НЕ-peer сообщение на pcB обязано быть DATA_B, а не утёкшее SECRET_A.
                assert recv_until(pcB, "input")["data"] == "DATA_B"


# ==================================================== [RLY-3] device pairing
class TestDevicePairing:
    def test_unpaired_device_blocked_then_approved(self, relay):
        relay.CFG.require_pairing = True
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        with c.websocket_connect(f"/ws?token={tok}&role=pc") as pc:
            with c.websocket_connect(f"/ws?token={tok}&role=app&device=dev1") as app:
                # 1) Неодобренное устройство НЕ может слать ввод.
                app.send_json({"t": "input", "data": "rm -rf /"})
                assert app.receive_json()["t"] == "need_pairing"
                # 2) Заявка на пайринг долетает до ПК (с проверочным кодом).
                app.send_json({"t": "pair:request", "name": "Планшет", "pubkey": "APUB", "code": "4821"})
                req = recv_until(pc, "pair:request")
                assert req["device"] == "dev1" and req["pubkey"] == "APUB" and req["code"] == "4821"
                # 3) ПК одобряет → пульт получает уведомление с pubkey ПК.
                pc.send_json({"t": "pair:approve", "device": "dev1", "pubkey": "PCPUB"})
                appr = recv_until(app, "pair:approved")
                assert appr["pubkey"] == "PCPUB"
                # 4) Теперь ввод проходит (одобрение перечитано из БД, без переподключения).
                app.send_json({"t": "input", "data": "ls\n"})
                assert recv_until(pc, "input")["data"] == "ls\n"

    def test_deny_keeps_device_blocked(self, relay):
        relay.CFG.require_pairing = True
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        with c.websocket_connect(f"/ws?token={tok}&role=pc") as pc:
            with c.websocket_connect(f"/ws?token={tok}&role=app&device=dev2") as app:
                app.send_json({"t": "pair:request", "name": "X", "pubkey": "P"})
                recv_until(pc, "pair:request")
                pc.send_json({"t": "pair:deny", "device": "dev2"})
                assert recv_until(app, "pair:denied")["device"] == "dev2"
                app.send_json({"t": "input", "data": "x"})
                assert app.receive_json()["t"] == "need_pairing"   # всё ещё заблокирован

    def test_revoke_all_devices_endpoint(self, relay):
        # «Выйти на всех устройствах» снимает одобрение со всех устройств аккаунта.
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        relay.device_upsert_request("user1", "devX", "Tab", "")
        relay.device_approve("user1", "devX", "")
        assert relay.device_approved("user1", "devX") is True
        r = c.post("/devices/revoke-all", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200 and r.json()["ok"]
        assert relay.device_approved("user1", "devX") is False   # одобрение снято
        # без авторизации — нельзя
        assert c.post("/devices/revoke-all").status_code == 401

    def test_pairing_off_allows_input(self, relay):
        # require_pairing=False (дефолт) — обратная совместимость: ввод идёт без пайринга.
        assert relay.CFG.require_pairing is False
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        with c.websocket_connect(f"/ws?token={tok}&role=pc") as pc:
            with c.websocket_connect(f"/ws?token={tok}&role=app&device=anything") as app:
                app.send_json({"t": "input", "data": "ok\n"})
                assert recv_until(pc, "input")["data"] == "ok\n"


# ==================================================== [RLY-7] лимиты форварда
class TestForwardLimits:
    def test_message_too_large(self, relay):
        relay.CFG.max_msg_bytes = 200
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        with c.websocket_connect(f"/ws?token={tok}&role=app") as app:
            app.send_text('{"t":"input","data":"' + "A" * 500 + '"}')
            assert app.receive_json()["t"] == "error"

    def test_message_rate_limit(self, relay):
        relay.CFG.msg_rate = 2          # очень низкий лимит для теста
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        with c.websocket_connect(f"/ws?token={tok}&role=app") as app:
            for _ in range(6):
                app.send_json({"t": "input", "data": "x"})
            # Первые ~2 прошли молча (форвард в пустоту), затем — отбой по частоте.
            assert app.receive_json()["error"] == "rate_limited"

    def test_max_connections_per_ip(self, relay):
        relay.CFG.max_conn_per_ip = 1
        c = make_client(relay)
        tok = reg(c, "user1").json()["token"]
        with c.websocket_connect(f"/ws?token={tok}&role=app") as _first:
            with c.websocket_connect(f"/ws?token={tok}&role=app") as second:
                assert second.receive_json()["error"] == "too_many_connections"


# ==================================================== [RLY-5] лимиты reports
class TestReportLimits:
    def test_report_throttle_per_ip(self, relay):
        relay.CFG.report_max_per_ip = 2
        c = make_client(relay)
        # store_report напрямую (юнит) — третий с того же IP отбрасывается.
        assert relay.store_report({"kind": "k", "message": "m"}, None, "1.1.1.1") is True
        assert relay.store_report({"kind": "k", "message": "m"}, None, "1.1.1.1") is True
        assert relay.store_report({"kind": "k", "message": "m"}, None, "1.1.1.1") is False

    def test_report_detail_truncated(self, relay):
        relay.store_report({"kind": "k", "message": "m", "detail": "D" * 9000}, None, "2.2.2.2")
        conn = relay.db()
        row = conn.execute("SELECT detail FROM reports ORDER BY id DESC LIMIT 1").fetchone()
        conn.close()
        assert len(row[0]) <= 4000          # обрезано

    def test_report_rows_pruned(self, relay):
        relay.CFG.report_max_rows = 5
        relay.CFG.report_max_per_ip = 1000
        for i in range(12):
            relay.store_report({"kind": "k", "message": str(i)}, None, "3.3.3.3")
        conn = relay.db()
        n = conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
        conn.close()
        assert n == 5                        # держим только последние N


# ==================================================== [RLY-8] CORS закрыт
def test_cors_closed_by_default(relay):
    c = make_client(relay)
    r = c.options("/login", headers={"Origin": "https://evil.example",
                                     "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}
