"""
Backend API tests for WhatsApp Connection Monitor.

Tests the FastAPI /api routes (status, qr, monitors, events, settings,
internal event webhook, websocket). The Node sidecar is in 'qr' state
(no real pairing), so add_monitor is expected to return 409.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path

import pytest
import requests
import websockets
from dotenv import load_dotenv

# Load frontend env to read REACT_APP_BACKEND_URL (preview/public URL)
ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / "frontend" / ".env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"
WS_URL = re.sub(r"^http", "ws", BASE_URL) + "/api/ws"

TEST_PHONE = "33612345678"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---- WhatsApp service proxy -------------------------------------------------
class TestWhatsappProxy:
    def test_status_has_state_field(self, client):
        r = client.get(f"{API}/whatsapp/status", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "state" in data
        assert data["state"] in {"qr", "initializing", "ready", "unreachable"}

    def test_qr_returns_state_and_qr(self, client):
        r = client.get(f"{API}/whatsapp/qr", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "state" in data
        assert "qr" in data
        # When state != ready, qr should be a base64 PNG data URL (or null if not yet generated)
        if data["state"] != "ready" and data["qr"] is not None:
            assert isinstance(data["qr"], str)
            assert data["qr"].startswith("data:image/png;base64,")


# ---- Monitors CRUD ----------------------------------------------------------
class TestMonitors:
    def test_list_monitors_returns_array(self, client):
        r = client.get(f"{API}/monitors", timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_add_monitor_when_client_not_ready_returns_409(self, client):
        r = client.post(
            f"{API}/monitors", json={"phone": TEST_PHONE}, timeout=15
        )
        # WA client is in 'qr' state — not ready
        assert r.status_code == 409, f"unexpected status {r.status_code}: {r.text}"
        body = r.json()
        assert "detail" in body
        assert "not ready" in body["detail"].lower()

    def test_add_monitor_invalid_phone_returns_400(self, client):
        r = client.post(f"{API}/monitors", json={"phone": "123"}, timeout=10)
        assert r.status_code == 400
        assert "invalid phone" in r.json()["detail"].lower()

    def test_delete_monitor_idempotent(self, client):
        r = client.delete(f"{API}/monitors/{TEST_PHONE}", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        # Second delete still ok
        r2 = client.delete(f"{API}/monitors/{TEST_PHONE}", timeout=10)
        assert r2.status_code == 200
        assert r2.json() == {"ok": True}


# ---- Events -----------------------------------------------------------------
class TestEvents:
    def test_list_events_returns_array(self, client):
        r = client.get(f"{API}/events", timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_clear_events(self, client):
        r = client.delete(f"{API}/events", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        r2 = client.get(f"{API}/events", timeout=10)
        assert r2.status_code == 200
        assert r2.json() == []


# ---- Settings ---------------------------------------------------------------
class TestSettings:
    def test_default_settings(self, client):
        # Reset to defaults first
        client.put(
            f"{API}/settings",
            json={"email_enabled": False, "email_recipient": None},
            timeout=10,
        )
        r = client.get(f"{API}/settings", timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data["email_enabled"] is False
        assert data["email_recipient"] is None

    def test_update_settings_and_persist(self, client):
        payload = {"email_enabled": True, "email_recipient": "test@example.com"}
        r = client.put(f"{API}/settings", json=payload, timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data["email_enabled"] is True
        assert data["email_recipient"] == "test@example.com"

        # GET to verify persistence
        r2 = client.get(f"{API}/settings", timeout=10)
        assert r2.status_code == 200
        d2 = r2.json()
        assert d2["email_enabled"] is True
        assert d2["email_recipient"] == "test@example.com"

        # Cleanup
        client.put(
            f"{API}/settings",
            json={"email_enabled": False, "email_recipient": None},
            timeout=10,
        )


# ---- Internal event webhook -------------------------------------------------
class TestInternalEvent:
    def test_client_state_event_logged(self, client):
        # Clear first
        client.delete(f"{API}/events", timeout=10)
        r = client.post(
            f"{API}/internal/event",
            json={"type": "client_state", "state": "ready"},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True

        # Verify event row created
        time.sleep(0.5)
        r2 = client.get(f"{API}/events", timeout=10)
        events = r2.json()
        assert any(
            e["event_type"] == "client_state" and e["detail"] == "ready" for e in events
        ), f"client_state event not found in {events}"

    def test_presence_event_logged_and_persisted(self, client):
        client.delete(f"{API}/events", timeout=10)
        r = client.post(
            f"{API}/internal/event",
            json={"type": "presence", "phone": TEST_PHONE, "status": "online"},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True

        time.sleep(0.5)
        r2 = client.get(f"{API}/events", timeout=10)
        assert r2.status_code == 200
        events = r2.json()
        match = [
            e for e in events
            if e["phone"] == TEST_PHONE and e["event_type"] == "online"
        ]
        assert match, f"presence online event not found: {events}"

        # offline event also
        r3 = client.post(
            f"{API}/internal/event",
            json={"type": "presence", "phone": TEST_PHONE, "status": "offline"},
            timeout=10,
        )
        assert r3.status_code == 200

        time.sleep(0.5)
        events2 = client.get(f"{API}/events", timeout=10).json()
        assert any(
            e["phone"] == TEST_PHONE and e["event_type"] == "offline" for e in events2
        )

    def test_unknown_event_type_ignored(self, client):
        r = client.post(
            f"{API}/internal/event",
            json={"type": "garbage"},
            timeout=10,
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True


# ---- WebSocket --------------------------------------------------------------
class TestWebSocket:
    def test_ws_hello_message(self):
        async def _run():
            async with websockets.connect(WS_URL, open_timeout=10) as ws:
                msg = await asyncio.wait_for(ws.recv(), timeout=10)
                return msg

        msg = asyncio.run(_run())
        assert "hello" in msg, f"unexpected first ws message: {msg}"

    def test_ws_receives_broadcast_on_internal_event(self, client):
        """
        Open a WS connection, then POST an internal event and confirm the
        socket receives a 'presence' broadcast within a few seconds.
        """
        async def _run():
            async with websockets.connect(WS_URL, open_timeout=10) as ws:
                # Drain hello
                hello = await asyncio.wait_for(ws.recv(), timeout=10)
                assert "hello" in hello

                # Trigger an internal event from another thread (sync call)
                def post_event():
                    requests.post(
                        f"{API}/internal/event",
                        json={
                            "type": "presence",
                            "phone": TEST_PHONE,
                            "status": "online",
                        },
                        timeout=10,
                    )

                await asyncio.get_event_loop().run_in_executor(None, post_event)

                # Wait for a broadcast (presence)
                deadline = asyncio.get_event_loop().time() + 8
                while asyncio.get_event_loop().time() < deadline:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=2)
                        if "presence" in msg and TEST_PHONE in msg:
                            return msg
                    except asyncio.TimeoutError:
                        continue
                return None

        msg = asyncio.run(_run())
        assert msg is not None, "did not receive presence broadcast over WS"
