"""Тестовое окружение релея: изолированная БД, управляемое время, сброс лимитеров.

Env выставляется ДО импорта relay (CFG/секреты читаются при импорте). Дальше каждый тест
получает чистую SQLite-БД во временном файле, дефолтный CFG и обнулённые in-memory лимитеры.
"""
import os
import importlib

# Секреты для тестов: RELAY_SECRET и RELAY_TOKEN РАЗНЫЕ (как в проде).
os.environ.setdefault("RELAY_SECRET", "test-signing-secret")
os.environ.setdefault("RELAY_TOKEN", "legacy-shared-token")
os.environ.setdefault("RELAY_DB", "/tmp/relay-test-default.db")

import pytest
import relay as relay_mod


# Снимок дефолтов CFG, чтобы восстанавливать между тестами.
_CFG_DEFAULTS = {k: getattr(relay_mod.CFG, k) for k in dir(relay_mod.CFG) if not k.startswith("_")}


class Clock:
    """Управляемое время: подменяет relay._now()."""
    def __init__(self, base=1_000_000.0):
        self.t = base

    def now(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(relay_mod, "_now", c.now)
    return c


@pytest.fixture(autouse=True)
def fresh_relay(tmp_path, monkeypatch):
    """Чистая БД + дефолтный CFG + пустые лимитеры на каждый тест."""
    db_file = str(tmp_path / "accounts.db")
    monkeypatch.setattr(relay_mod, "DB_PATH", db_file)
    # Восстановить дефолты CFG (тесты, мутировавшие пороги, не текут в соседние).
    for k, v in _CFG_DEFAULTS.items():
        setattr(relay_mod.CFG, k, v)
    # Обнулить in-memory структуры.
    relay_mod._fail_login.clear()
    relay_mod._fail_ip.clear()
    relay_mod._reg_ip.clear()
    relay_mod._report_ip.clear()
    relay_mod._conn_ip.clear()
    relay_mod.rooms.clear()
    yield


@pytest.fixture
def relay():
    return relay_mod
