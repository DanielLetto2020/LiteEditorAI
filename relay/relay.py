"""
LiteEditor relay — соединяет ПК-редактор и Android-пульт(ы) через WebSocket.

БЕЗОПАСНОСТЬ (hardened-версия, готовится к публикации пульта). Релей — единственный
доверенный посредник между пультом и ПК, а ПК исполняет присланный пультом ввод прямо в
терминал → компрометация аккаунта/релея = RCE на ПК пользователя. Поэтому здесь собраны
защитные слои; см. SECURITY_PLAN.md.

Что добавлено относительно v1 (всё конфигурируется через env, дефолты — обратносовместимы):
  • Rate-limit + lockout на login/register/WS-login (per-login и per-IP).            [RLY-1]
  • Server-side сессии с отзывом + короткий TTL вместо вечного stateless-токена.     [RLY-2]
  • Device pairing: брокеринг pair:* и (опц.) обязательное одобрение устройства.     [RLY-3]
  • Анти-абьюз регистрации: лимит per-IP/сутки.                                       [RLY-4]
  • Лимиты на reports: throttle per-IP, обрезка detail, прунинг старых строк.         [RLY-5]
  • Legacy общий токен по умолчанию ВЫКЛ (флаг RELAY_ALLOW_LEGACY).                    [RLY-6]
  • Лимиты на форвард-пути: размер сообщения и частота сообщений на соединение.       [RLY-7]
  • Лимит соединений per-IP; CORS закрыт по умолчанию.                                [RLY-8]

Авторизация (как и раньше, два пути входа):
  • HTTP: POST /register, POST /login → токен сессии (использует ПК-редактор).
  • WS: {t:"login"/"register"} в ещё НЕ авторизованное соединение → {t:"auth_ok", token}.
Управление сессиями (новое, требует Bearer-токен):
  • GET /sessions, POST /sessions/revoke, POST /password, POST /logout.

Хранилище — SQLite в /app/data (bind-mount). Rate-limit/lockout — in-memory (сброс на рестарт).
"""
import os
import json
import time
import hmac
import base64
import secrets
import hashlib
import sqlite3
from collections import defaultdict, deque

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import BaseModel


# ------------------------------------------------------------------ конфигурация
def _envi(name, default):
    try:
        return int(os.environ.get(name, "").strip() or default)
    except Exception:
        return default


def _envb(name, default):
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


class CFG:
    # Парольная политика (применяется только к НОВЫМ регистрациям — старые входят как есть).
    min_password = _envi("RELAY_MIN_PASSWORD", 8)        # было 4 [RLY-1/MOB-2]
    min_login = _envi("RELAY_MIN_LOGIN", 3)
    # Брутфорс-защита входа.
    login_max_fails = _envi("RELAY_LOGIN_MAX_FAILS", 5)  # неудач до lockout (per-login)
    login_window = _envi("RELAY_LOGIN_WINDOW", 300)      # окно подсчёта неудач, сек
    login_lockout = _envi("RELAY_LOGIN_LOCKOUT", 900)    # длительность lockout, сек
    ip_login_max_fails = _envi("RELAY_IP_LOGIN_MAX_FAILS", 30)  # суммарно неудач с одного IP
    ip_login_lockout = _envi("RELAY_IP_LOGIN_LOCKOUT", 900)
    # Анти-абьюз регистрации.
    reg_max_per_ip = _envi("RELAY_REG_MAX_PER_IP", 10)   # регистраций с IP за окно
    reg_window = _envi("RELAY_REG_WINDOW", 86400)        # окно, сек (сутки)
    # Сессии/токены.
    token_ttl = _envi("RELAY_TOKEN_TTL", 30 * 24 * 3600)  # было 10 лет → 30 суток [RLY-2]
    allow_stateless = _envb("RELAY_ALLOW_STATELESS", False)  # принимать старые stateless-токены (миграция)
    allow_legacy = _envb("RELAY_ALLOW_LEGACY", False)       # общий RELAY_TOKEN [RLY-6]
    # Device pairing.
    require_pairing = _envb("RELAY_REQUIRE_PAIRING", True)  # обязательное одобрение устройства [RLY-3]
    pair_ttl = _envi("RELAY_PAIR_TTL", 300)                  # TTL заявки на пайринг, сек
    # Лимиты форвард-пути.
    max_msg_bytes = _envi("RELAY_MAX_MSG_BYTES", 512 * 1024)  # потолок одного WS-кадра [RLY-7]
    msg_rate = _envi("RELAY_MSG_RATE", 2000)                  # сообщений/сек от ПУЛЬТА (ПК освобождён)
    max_conn_per_ip = _envi("RELAY_MAX_CONN_PER_IP", 40)      # одновременных WS с одного IP [RLY-8]
    # Reports.
    report_max_per_ip = _envi("RELAY_REPORT_MAX_PER_IP", 30)  # репортов с IP за окно
    report_window = _envi("RELAY_REPORT_WINDOW", 3600)
    report_max_rows = _envi("RELAY_REPORT_MAX_ROWS", 5000)    # прунинг старых строк
    # Прокси/CORS.
    trust_proxy = _envb("RELAY_TRUST_PROXY", True)            # читать X-Forwarded-For (за Traefik)
    cors_origins = [o.strip() for o in os.environ.get("RELAY_CORS_ORIGINS", "").split(",") if o.strip()]


RELAY_SECRET = (os.environ.get("RELAY_SECRET") or os.environ.get("RELAY_TOKEN") or "").strip()
LEGACY_TOKEN = os.environ.get("RELAY_TOKEN", "").strip()
DB_PATH = os.environ.get("RELAY_DB", "/app/data/accounts.db")

app = FastAPI(title="liteeditor-relay")
# CORS закрыт по умолчанию: ПК ходит через Node-https (без Origin/CORS), пульт логинится по WS.
# Браузерный cross-origin доступ к /login,/register не нужен → не открываем "*". [RLY-8]
if CFG.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=CFG.cors_origins,
                       allow_methods=["*"], allow_headers=["*"])

rooms: dict[str, dict[str, set]] = defaultdict(lambda: {"pc": set(), "app": set()})


# -------------------------------------------------------------- время (для тестов)
def _now() -> float:
    """Единая точка времени — тесты её мокают для детерминированной проверки окон/TTL."""
    return time.time()


# ----------------------------------------------------------------- хранилище (БД)
def db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS accounts ("
        " login TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS reports ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER, login TEXT,"
        " kind TEXT, message TEXT, detail TEXT, ua TEXT)"
    )
    # Сессии: токен ревокабелен (хранится хэш sid), короткий TTL, привязка к устройству. [RLY-2]
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions ("
        " sid TEXT PRIMARY KEY, login TEXT NOT NULL, device TEXT,"
        " created INTEGER, last_seen INTEGER, expires INTEGER, revoked INTEGER DEFAULT 0)"
    )
    # Устройства: одобрение для pairing + (для e2e) публичные ключи сторон. [RLY-3]
    conn.execute(
        "CREATE TABLE IF NOT EXISTS devices ("
        " login TEXT, device_id TEXT, name TEXT, app_pubkey TEXT, pc_pubkey TEXT,"
        " approved INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0, created INTEGER,"
        " PRIMARY KEY (login, device_id))"
    )
    return conn


def hash_pw(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000).hex()


def other(role: str) -> str:
    return "app" if role == "pc" else "pc"


# ---------------------------------------------------------- rate-limit / lockout
# In-memory структуры: key -> данные. Сбрасываются при рестарте процесса (приемлемо).
_fail_login: dict[str, dict] = {}   # login -> {"fails":int,"first":ts,"until":ts}
_fail_ip: dict[str, dict] = {}      # ip    -> {"fails":int,"first":ts,"until":ts}
_reg_ip: dict[str, deque] = defaultdict(deque)     # ip -> ts регистраций
_report_ip: dict[str, deque] = defaultdict(deque)  # ip -> ts репортов
_conn_ip: dict[str, int] = defaultdict(int)        # ip -> число открытых WS


def _locked(store: dict, key: str) -> bool:
    rec = store.get(key)
    return bool(rec and rec.get("until", 0) > _now())


def _register_fail(store: dict, key: str, max_fails: int, window: int, lockout: int):
    now = _now()
    rec = store.get(key)
    if not rec or now - rec.get("first", now) > window:
        rec = {"fails": 0, "first": now, "until": 0}
    rec["fails"] += 1
    if rec["fails"] >= max_fails:
        rec["until"] = now + lockout
        rec["fails"] = 0
        rec["first"] = now
    store[key] = rec


def _clear_fail(store: dict, key: str):
    store.pop(key, None)


def _rate_ok(store: dict, key: str, limit: int, window: int) -> bool:
    """Скользящее окно: True если ещё в пределах лимита (и засчитывает текущую попытку)."""
    now = _now()
    dq = store[key]
    while dq and now - dq[0] > window:
        dq.popleft()
    if len(dq) >= limit:
        return False
    dq.append(now)
    return True


def login_blocked(login: str, ip: str) -> bool:
    return _locked(_fail_login, login) or _locked(_fail_ip, ip)


def note_login_fail(login: str, ip: str):
    _register_fail(_fail_login, login, CFG.login_max_fails, CFG.login_window, CFG.login_lockout)
    _register_fail(_fail_ip, ip, CFG.ip_login_max_fails, CFG.login_window, CFG.ip_login_lockout)


def note_login_ok(login: str, ip: str):
    _clear_fail(_fail_login, login)
    _clear_fail(_fail_ip, ip)


# -------------------------------------------------------------------- IP клиента
def client_ip_req(request: Request) -> str:
    if CFG.trust_proxy:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[-1].strip()
    return request.client.host if request.client else "?"


def client_ip_ws(ws: WebSocket) -> str:
    if CFG.trust_proxy:
        xff = ws.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[-1].strip()
    return ws.client.host if ws.client else "?"


# ----------------------------------------------------------- сессии и токены
def _b64(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).decode()


def _unb64(s: str) -> str:
    return base64.urlsafe_b64decode(s.encode()).decode()


def create_session(login: str, device: str | None = None) -> str:
    """Создаёт ревокабельную сессию и возвращает подписанный токен с её sid."""
    sid = secrets.token_hex(16)
    now = int(_now())
    exp = now + CFG.token_ttl
    conn = db()
    try:
        conn.execute(
            "INSERT INTO sessions(sid,login,device,created,last_seen,expires,revoked) VALUES(?,?,?,?,?,?,0)",
            (sid, login, device or "", now, now, exp),
        )
        conn.commit()
    finally:
        conn.close()
    payload = f"{login}|{exp}|{sid}"
    sig = hmac.new(RELAY_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return _b64(f"{payload}|{sig}")


def _session_alive(sid: str, login: str) -> bool:
    conn = db()
    try:
        row = conn.execute("SELECT revoked,expires FROM sessions WHERE sid=? AND login=?",
                           (sid, login)).fetchone()
        if not row or row[0] or int(row[1]) <= _now():
            return False
        conn.execute("UPDATE sessions SET last_seen=? WHERE sid=?", (int(_now()), sid))
        conn.commit()
        return True
    finally:
        conn.close()


def verify_token(token: str):
    """Возвращает login или None. Поддерживает: сессионный токен (ревокабельный),
    legacy stateless-токен (если разрешён), общий legacy-токен (если разрешён)."""
    if not token:
        return None
    try:
        raw = _unb64(token)
        parts = raw.split("|")
        if len(parts) == 4:
            # Новый формат: login|exp|sid|sig — ревокабельная сессия.
            login, exp, sid, sig = parts
            good = hmac.new(RELAY_SECRET.encode(), f"{login}|{exp}|{sid}".encode(), hashlib.sha256).hexdigest()
            if hmac.compare_digest(good, sig) and int(exp) > _now() and _session_alive(sid, login):
                return login
            return None
        if len(parts) == 3:
            # Старый stateless-формат: login|exp|sig (без отзыва) — только если разрешён.
            login, exp, sig = parts
            if not CFG.allow_stateless:
                return None
            good = hmac.new(RELAY_SECRET.encode(), f"{login}|{exp}".encode(), hashlib.sha256).hexdigest()
            if hmac.compare_digest(good, sig) and int(exp) > _now():
                return login
            return None
    except Exception:
        pass
    if CFG.allow_legacy and LEGACY_TOKEN and hmac.compare_digest(token, LEGACY_TOKEN):
        return "__legacy__"
    return None


def revoke_session(login: str, sid: str) -> bool:
    conn = db()
    try:
        cur = conn.execute("UPDATE sessions SET revoked=1 WHERE login=? AND sid=?", (login, sid))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def revoke_all_sessions(login: str, except_sid: str | None = None):
    conn = db()
    try:
        if except_sid:
            conn.execute("UPDATE sessions SET revoked=1 WHERE login=? AND sid<>?", (login, except_sid))
        else:
            conn.execute("UPDATE sessions SET revoked=1 WHERE login=?", (login,))
        conn.commit()
    finally:
        conn.close()


def list_sessions(login: str):
    conn = db()
    try:
        rows = conn.execute(
            "SELECT sid,device,created,last_seen,expires FROM sessions"
            " WHERE login=? AND revoked=0 AND expires>? ORDER BY last_seen DESC",
            (login, int(_now())),
        ).fetchall()
        return [dict(zip(["sid", "device", "created", "last_seen", "expires"], r)) for r in rows]
    finally:
        conn.close()


def token_sid(token: str):
    try:
        parts = _unb64(token).split("|")
        return parts[2] if len(parts) == 4 else None
    except Exception:
        return None


# ------------------------------------------------------- авторизация (общая)
def validate_password(password: str) -> str | None:
    """Возвращает текст ошибки или None если пароль проходит политику. [RLY-1]"""
    if len(password or "") < CFG.min_password:
        return f"Пароль ≥{CFG.min_password} символов"
    return None


def do_register(login: str, password: str, ip: str | None = None):
    login = (login or "").strip().lower()
    if len(login) < CFG.min_login:
        return False, f"Логин ≥{CFG.min_login} символов"
    err = validate_password(password)
    if err:
        return False, err
    if login == (password or "").strip().lower():
        return False, "Пароль не должен совпадать с логином"
    if ip is not None and not _rate_ok(_reg_ip, ip, CFG.reg_max_per_ip, CFG.reg_window):
        return False, "Слишком много регистраций — попробуйте позже"
    salt = os.urandom(16)
    conn = db()
    try:
        conn.execute("INSERT INTO accounts(login,salt,hash,created) VALUES(?,?,?,?)",
                     (login, salt.hex(), hash_pw(password, salt), int(_now())))
        conn.commit()
    except sqlite3.IntegrityError:
        return False, "Такой логин уже занят"
    finally:
        conn.close()
    return True, login   # вызывающий создаёт сессию


def do_login(login: str, password: str, ip: str | None = None):
    login = (login or "").strip().lower()
    if ip is not None and login_blocked(login, ip):
        return False, "Слишком много попыток — вход временно заблокирован"
    conn = db()
    row = conn.execute("SELECT salt,hash FROM accounts WHERE login=?", (login,)).fetchone()
    conn.close()
    ok = bool(row) and hmac.compare_digest(hash_pw(password, bytes.fromhex(row[0])), row[1])
    if not ok:
        if ip is not None:
            note_login_fail(login, ip)
        return False, "Неверный логин или пароль"
    if ip is not None:
        note_login_ok(login, ip)
    return True, login   # вызывающий создаёт сессию


def change_password(login: str, old_pw: str, new_pw: str):
    conn = db()
    row = conn.execute("SELECT salt,hash FROM accounts WHERE login=?", (login,)).fetchone()
    if not row or not hmac.compare_digest(hash_pw(old_pw, bytes.fromhex(row[0])), row[1]):
        conn.close()
        return False, "Неверный текущий пароль"
    err = validate_password(new_pw)
    if err:
        conn.close()
        return False, err
    salt = os.urandom(16)
    conn.execute("UPDATE accounts SET salt=?, hash=? WHERE login=?",
                 (salt.hex(), hash_pw(new_pw, salt), login))
    conn.commit()
    conn.close()
    return True, "ok"


def store_report(msg: dict, login: str | None, ip: str | None = None):
    if ip is not None and not _rate_ok(_report_ip, ip, CFG.report_max_per_ip, CFG.report_window):
        return False  # тихо отбрасываем флуд репортов [RLY-5]
    conn = db()
    try:
        conn.execute(
            "INSERT INTO reports(created,login,kind,message,detail,ua) VALUES(?,?,?,?,?,?)",
            (int(_now()), (login or msg.get("login") or "")[:80], str(msg.get("kind", ""))[:40],
             str(msg.get("message", ""))[:2000], str(msg.get("detail", ""))[:4000], str(msg.get("ua", ""))[:300]),
        )
        # Прунинг: держим не больше report_max_rows последних строк. [RLY-5]
        conn.execute(
            "DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY id DESC LIMIT ?)",
            (CFG.report_max_rows,),
        )
        conn.commit()
        return True
    finally:
        conn.close()


# ------------------------------------------------------------ device pairing
def device_approved(login: str, device_id: str) -> bool:
    if not device_id:
        return False
    conn = db()
    try:
        row = conn.execute("SELECT approved,revoked FROM devices WHERE login=? AND device_id=?",
                           (login, device_id)).fetchone()
        return bool(row and row[0] and not row[1])
    finally:
        conn.close()


def device_upsert_request(login: str, device_id: str, name: str, app_pubkey: str):
    conn = db()
    try:
        conn.execute(
            "INSERT INTO devices(login,device_id,name,app_pubkey,approved,revoked,created)"
            " VALUES(?,?,?,?,0,0,?) ON CONFLICT(login,device_id) DO UPDATE SET name=?, app_pubkey=?, revoked=0",
            (login, device_id, name, app_pubkey, int(_now()), name, app_pubkey),
        )
        conn.commit()
    finally:
        conn.close()


def device_approve(login: str, device_id: str, pc_pubkey: str):
    conn = db()
    try:
        conn.execute("UPDATE devices SET approved=1, revoked=0, pc_pubkey=? WHERE login=? AND device_id=?",
                     (pc_pubkey, login, device_id))
        conn.commit()
    finally:
        conn.close()


def device_revoke(login: str, device_id: str):
    conn = db()
    try:
        conn.execute("UPDATE devices SET revoked=1, approved=0 WHERE login=? AND device_id=?",
                     (login, device_id))
        conn.commit()
    finally:
        conn.close()


def revoke_all_devices(login: str):
    """Снять одобрение со ВСЕХ устройств аккаунта — «на случай потери». При enforcement
    каждое из них блокируется (need_pairing) до повторного одобрения, независимо от типа токена."""
    conn = db()
    try:
        conn.execute("UPDATE devices SET revoked=1, approved=0 WHERE login=?", (login,))
        conn.commit()
    finally:
        conn.close()


# ------------------------------------------------------------------- модели
class Creds(BaseModel):
    login: str
    password: str


class PwChange(BaseModel):
    old_password: str
    new_password: str


class RevokeReq(BaseModel):
    sid: str


# -------------------------------------------------------------- HTTP-эндпоинты
@app.get("/health")
async def health():
    return PlainTextResponse("ok")


@app.post("/register")
async def register(c: Creds, request: Request):
    ip = client_ip_req(request)
    ok, res = do_register(c.login, c.password, ip)
    if not ok:
        code = 409 if "занят" in res else (429 if "Слишком" in res else 400)
        raise HTTPException(code, res)
    login = res
    return {"ok": True, "token": create_session(login), "login": login}


@app.post("/login")
async def login(c: Creds, request: Request):
    ip = client_ip_req(request)
    ok, res = do_login(c.login, c.password, ip)
    if not ok:
        raise HTTPException(429 if "заблокирован" in res else 401, res)
    login = res
    return {"ok": True, "token": create_session(login), "login": login}


def _auth_bearer(authorization: str | None):
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    login = verify_token(token)
    if not login or login == "__legacy__":
        raise HTTPException(401, "Требуется вход")
    return login, token


@app.get("/sessions")
async def sessions_list(authorization: str = Header(default="")):
    login, _ = _auth_bearer(authorization)
    return {"sessions": list_sessions(login)}


@app.post("/sessions/revoke")
async def sessions_revoke(req: RevokeReq, authorization: str = Header(default="")):
    login, _ = _auth_bearer(authorization)
    return {"ok": revoke_session(login, req.sid)}


@app.post("/logout")
async def logout(authorization: str = Header(default="")):
    login, token = _auth_bearer(authorization)
    sid = token_sid(token)
    if sid:
        revoke_session(login, sid)
    return {"ok": True}


@app.post("/devices/revoke-all")
async def devices_revoke_all(authorization: str = Header(default="")):
    # «Выйти на всех устройствах»: снять одобрение со всех устройств + отозвать все сессии,
    # кроме текущей (ПК, нажавший кнопку, остаётся в системе). Потерянное устройство блокируется.
    login, token = _auth_bearer(authorization)
    revoke_all_devices(login)
    revoke_all_sessions(login, except_sid=token_sid(token))
    return {"ok": True}


@app.post("/password")
async def password(req: PwChange, authorization: str = Header(default="")):
    login, token = _auth_bearer(authorization)
    ok, msg = change_password(login, req.old_password, req.new_password)
    if not ok:
        raise HTTPException(400, msg)
    revoke_all_sessions(login, except_sid=token_sid(token))   # смена пароля рвёт прочие сессии
    return {"ok": True}


@app.get("/reports")
async def reports(limit: int = Query(default=100), authorization: str = Header(default="")):
    # Extract the key from Bearer token or use the raw Authorization header if unformatted
    key = authorization[7:].strip() if authorization.lower().startswith("bearer ") else authorization
    if not RELAY_SECRET or not hmac.compare_digest(key, RELAY_SECRET):
        raise HTTPException(403, "forbidden")
    conn = db()
    rows = conn.execute(
        "SELECT id,created,login,kind,message,detail,ua FROM reports ORDER BY id DESC LIMIT ?",
        (max(1, min(limit, 500)),),
    ).fetchall()
    conn.close()
    keys = ["id", "created", "login", "kind", "message", "detail", "ua"]
    return JSONResponse([dict(zip(keys, r)) for r in rows])


# -------------------------------------------------------------------- релей WS
async def _send_to(room: str, role: str, message: str) -> None:
    dead = []
    for ws in list(rooms[room][role]):
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        rooms[room][role].discard(ws)


async def _safe_send(ws: WebSocket, obj: dict):
    try:
        await ws.send_text(json.dumps(obj))
    except Exception:
        pass


# Типы сообщений, которые НЕ требуют одобренного устройства (нужны до/во время пайринга).
_PAIR_TYPES = {"pair:request", "pair:code", "pair:approve", "pair:deny", "hello", "report"}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, token: str = Query(default=""),
                      role: str = Query(default=""), device: str = Query(default="")):
    await websocket.accept()
    ip = client_ip_ws(websocket)

    # Лимит одновременных соединений с одного IP. [RLY-8]
    if _conn_ip[ip] >= CFG.max_conn_per_ip:
        await _safe_send(websocket, {"t": "error", "error": "too_many_connections"})
        await websocket.close(code=1013)
        return
    _conn_ip[ip] += 1

    room = verify_token(token) if token else None
    cur_role = role if role in ("pc", "app") else "app"
    authed = room is not None
    device_id = (device or "").strip()[:64]
    # Одобрено ли устройство (для enforcement пайринга). PC всегда «доверенный» (это сам редактор).
    paired = (cur_role == "pc") or (not CFG.require_pairing) or device_approved(room, device_id) if authed else False

    # Token-bucket для частоты сообщений на это соединение. [RLY-7]
    bucket = float(CFG.msg_rate)
    last_refill = _now()

    if authed:
        rooms[room][cur_role].add(websocket)
        await _send_to(room, other(cur_role), json.dumps(
            {"t": "peer", "role": cur_role, "event": "join", "device": device_id}))

    try:
        while True:
            raw = await websocket.receive_text()

            # Лимит размера кадра. [RLY-7]
            if len(raw) > CFG.max_msg_bytes:
                await _safe_send(websocket, {"t": "error", "error": "message_too_large"})
                continue

            # Token-bucket частоты. [RLY-7] Применяется только к НЕ-pc ролям: вывод терминала
            # с ПК (доверенный редактор) бывает залповым и его нельзя дропать (поломает xterm).
            # Флуд от пульта → НЕ тихий дроп (это бы тоже рвало поток), а закрытие соединения:
            # клиент переподключится и пере-синкнется со снапшота — без порчи данных.
            if cur_role != "pc":
                now = _now()
                bucket = min(float(CFG.msg_rate), bucket + (now - last_refill) * CFG.msg_rate)
                last_refill = now
                if bucket < 1.0:
                    await _safe_send(websocket, {"t": "error", "error": "rate_limited"})
                    break
                bucket -= 1.0

            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("t")

            if t == "report":
                store_report(msg, room, ip)
                continue

            if not authed:
                # До входа принимаем только login/register (и report выше).
                if t in ("login", "register"):
                    if t == "login":
                        ok, res = do_login(msg.get("login", ""), msg.get("password", ""), ip)
                    else:
                        ok, res = do_register(msg.get("login", ""), msg.get("password", ""), ip)
                    if ok:
                        room = res
                        cur_role = "app"
                        authed = True
                        paired = (not CFG.require_pairing) or device_approved(room, device_id)
                        tok = create_session(room, device_id)
                        await _safe_send(websocket, {"t": "auth_ok", "token": tok, "login": room})
                        rooms[room][cur_role].add(websocket)
                        await _send_to(room, "pc", json.dumps(
                            {"t": "peer", "role": "app", "event": "join", "device": device_id}))
                    else:
                        await _safe_send(websocket, {"t": "auth_err", "error": res})
                else:
                    await _safe_send(websocket, {"t": "auth_err", "error": "Требуется вход"})
                continue

            # --- авторизованы ---

            # Брокеринг pairing (всегда разрешён, даже неодобренному устройству). [RLY-3]
            if t == "pair:request" and cur_role == "app":
                device_upsert_request(room, device_id, str(msg.get("name", ""))[:80], str(msg.get("pubkey", ""))[:256])
                # code — короткий проверочный код, который пульт показывает на экране; ПК показывает
                # его же, пользователь сверяет (подтверждает, что заявка от устройства в руках).
                await _send_to(room, "pc", json.dumps({"t": "pair:request", "device": device_id,
                                                       "name": msg.get("name", ""), "pubkey": msg.get("pubkey", ""),
                                                       "code": str(msg.get("code", ""))[:12]}))
                continue
            if t == "pair:approve" and cur_role == "pc":
                tgt = str(msg.get("device", ""))[:64]
                device_approve(room, tgt, str(msg.get("pubkey", ""))[:256])
                await _send_to(room, "app", json.dumps({"t": "pair:approved", "device": tgt,
                                                        "pubkey": msg.get("pubkey", "")}))
                if tgt == device_id:
                    paired = True
                continue
            if t == "pair:deny" and cur_role == "pc":
                await _send_to(room, "app", json.dumps({"t": "pair:denied", "device": msg.get("device", "")}))
                continue

            # Enforcement: неодобренное app-устройство НЕ может слать ничего, кроме pair/hello/report. [RLY-3]
            # Перепроверяем одобрение из БД, чтобы approve от ПК разблокировал БЕЗ переподключения.
            if not paired:
                if device_approved(room, device_id):
                    paired = True
                elif t not in _PAIR_TYPES:
                    await _safe_send(websocket, {"t": "need_pairing"})
                    continue

            # Тупой форвард на противоположную роль (терминал, ввод, стор, и т.п.).
            await _send_to(room, other(cur_role), raw)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _conn_ip[ip] = max(0, _conn_ip[ip] - 1)
        if authed and room:
            rooms[room][cur_role].discard(websocket)
            await _send_to(room, other(cur_role), json.dumps(
                {"t": "peer", "role": cur_role, "event": "leave", "device": device_id}))
