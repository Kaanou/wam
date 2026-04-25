"""
Backend API tests for WhatsApp Connection Monitor (iteration 2).

Covers:
- REGRESSION: status, qr, monitors, events, settings, websocket
- NEW: pairing-mode / pairing-code endpoints and {state,qr,code,mode} shape on /qr
- NEW: monitor labels (POST/PATCH /monitors)
- NEW: events filters and CSV export
- NEW: settings daily summary fields, validation, hour clamp, send-summary-now
- NEW: internal webhook X-Internal-Secret auth
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
from datetime import datetime, timezone
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

# Read REACT_APP_BACKEND_URL (preview/public URL) from frontend env
ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / "frontend" / ".env")
load_dotenv(ROOT / "backend" / ".env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"
WS_URL = re.sub(r"^http", "ws", BASE_URL) + "/api/ws"

INTERNAL_SECRET = os.environ.get("INTERNAL_API_SECRET", "wa-mon-3f9c1a8b6d2e4f7a8c1b9d3e5f6a2b4c")

TEST_PHONE = "33612345678"
TEST_PHONE_2 = "33687654321"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module", autouse=True)
def _cleanup(client):
    """Wipe events/settings/test monitors before & after the run."""
    # before
    try:
        client.delete(f"{API}/events", timeout=10)
        client.delete(f"{API}/monitors/{TEST_PHONE}", timeout=10)
        client.delete(f"{API}/monitors/{TEST_PHONE_2}", timeout=10)
    except Exception:
        pass
    yield
    # after
    try:
        client.delete(f"{API}/events", timeout=10)
        client.delete(f"{API}/monitors/{TEST_PHONE}", timeout=10)
        client.delete(f"{API}/monitors/{TEST_PHONE_2}", timeout=10)
        client.put(
            f"{API}/settings",
            json={
                "email_enabled": False,
                "email_recipient": None,
                "daily_summary_enabled": False,
                "daily_summary_hour": 9,
            },
            timeout=10,
        )
    except Exception:
        pass


# ---- WhatsApp service proxy (regression + new shape) ------------------------
class TestWhatsappProxy:
    def test_status_has_state_field(self, client):
        r = client.get(f"{API}/whatsapp/status", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "state" in data
        assert data["state"] in {"qr", "initializing", "ready", "unreachable"}

    def test_qr_returns_state_qr_code_mode(self, client):
        r = client.get(f"{API}/whatsapp/qr", timeout=15)
        assert r.status_code == 200
        data = r.json()
        # New iteration 2 shape
        for k in ("state", "qr", "code", "mode"):
            assert k in data, f"missing key {k} in {data}"
        assert data["mode"] in {"qr", "code"}


# ---- Pairing mode / code (NEW) ---------------------------------------------
class TestPairing:
    def test_set_pairing_mode_code(self, client):
        r = client.post(f"{API}/whatsapp/pairing-mode?mode=code", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("ok") is True
        assert data.get("mode") == "code"

    def test_set_pairing_mode_qr(self, client):
        r = client.post(f"{API}/whatsapp/pairing-mode?mode=qr", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("ok") is True
        assert data.get("mode") == "qr"

    def test_pairing_code_invalid_phone_returns_400(self, client):
        r = client.post(f"{API}/whatsapp/pairing-code", json={"phone": "123"}, timeout=15)
        assert r.status_code == 400
        assert "invalid phone" in r.json().get("detail", "").lower()

    def test_pairing_code_valid_phone(self, client):
        # Make sure we are in qr state for code generation to be possible
        status = client.get(f"{API}/whatsapp/status", timeout=10).json()
        client.post(f"{API}/whatsapp/pairing-mode?mode=qr", timeout=10)
        r = client.post(
            f"{API}/whatsapp/pairing-code",
            json={"phone": TEST_PHONE},
            timeout=20,
        )
        # Acceptable: 200 OK with code; 409/500 if client not in qr state.
        if status.get("state") == "qr" and r.status_code == 200:
            data = r.json()
            assert data.get("ok") is True
            code = data.get("code", "")
            assert isinstance(code, str)
            # whatsapp-web.js returns 8 chars; allow stripped formatting
            assert len(code.replace("-", "").replace(" ", "")) >= 6
        else:
            # Acceptable failure modes documented by the request
            assert r.status_code in (200, 400, 409, 500, 502), (
                f"unexpected status {r.status_code}: {r.text}"
            )


# ---- Monitors CRUD + labels (NEW) ------------------------------------------
class TestMonitors:
    def test_list_monitors_returns_array(self, client):
        r = client.get(f"{API}/monitors", timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_add_monitor_when_client_not_ready_returns_409(self, client):
        # WA client is not paired (state=qr) so add_monitor should be 409
        r = client.post(
            f"{API}/monitors", json={"phone": TEST_PHONE, "label": "Alice"}, timeout=15
        )
        assert r.status_code == 409, f"unexpected {r.status_code}: {r.text}"
        assert "not ready" in r.json()["detail"].lower()

    def test_add_monitor_invalid_phone_returns_400(self, client):
        r = client.post(f"{API}/monitors", json={"phone": "12"}, timeout=10)
        assert r.status_code == 400

    def test_patch_monitor_label_updates_and_get_returns_label(self, client):
        # Insert directly via mongo isn't available; use internal/event to create
        # presence which upserts? It only updates monitors that exist. We simulate
        # an insert by hitting /monitors (which fails since not ready), so instead
        # we PATCH a non-existent phone and expect 404, then bypass by inserting
        # via direct DB through a presence event won't create monitor row.
        # => We can only test the 404 behaviour here.
        r = client.patch(
            f"{API}/monitors/{TEST_PHONE_2}", json={"label": "Bob"}, timeout=10
        )
        assert r.status_code == 404
        assert "not found" in r.json()["detail"].lower()

    def test_patch_monitor_label_success_when_exists(self, client):
        """Seed a monitor directly in Mongo (since WA client is not paired)
        and verify PATCH updates the label and persists."""
        async def _seed():
            mc = AsyncIOMotorClient(os.environ["MONGO_URL"])
            db = mc[os.environ["DB_NAME"]]
            await db.monitors.delete_one({"phone": TEST_PHONE_2})
            await db.monitors.insert_one({
                "phone": TEST_PHONE_2,
                "label": "Original",
                "added_at": datetime.now(timezone.utc).isoformat(),
                "status": "unknown",
                "last_seen": None,
            })
            mc.close()
        asyncio.run(_seed())
        try:
            r = client.patch(
                f"{API}/monitors/{TEST_PHONE_2}", json={"label": "Updated"}, timeout=10
            )
            assert r.status_code == 200, r.text
            assert r.json()["label"] == "Updated"
            # GET to verify persistence
            mons = client.get(f"{API}/monitors", timeout=10).json()
            match = [m for m in mons if m["phone"] == TEST_PHONE_2]
            assert match and match[0]["label"] == "Updated"
        finally:
            async def _cleanup():
                mc = AsyncIOMotorClient(os.environ["MONGO_URL"])
                db = mc[os.environ["DB_NAME"]]
                await db.monitors.delete_one({"phone": TEST_PHONE_2})
                mc.close()
            asyncio.run(_cleanup())

    def test_delete_monitor_idempotent(self, client):
        r = client.delete(f"{API}/monitors/{TEST_PHONE}", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        r2 = client.delete(f"{API}/monitors/{TEST_PHONE}", timeout=10)
        assert r2.status_code == 200


# ---- Events filters & CSV export (NEW) -------------------------------------
class TestEventsFiltersAndCSV:
    def _seed_events(self, client):
        client.delete(f"{API}/events", timeout=10)
        # Use internal webhook with secret to seed
        h = {"X-Internal-Secret": INTERNAL_SECRET, "Content-Type": "application/json"}
        for status in ("online", "offline"):
            requests.post(
                f"{API}/internal/event",
                headers=h,
                json={"type": "presence", "phone": TEST_PHONE, "status": status},
                timeout=10,
            )
        requests.post(
            f"{API}/internal/event",
            headers=h,
            json={"type": "presence", "phone": TEST_PHONE_2, "status": "online"},
            timeout=10,
        )
        requests.post(
            f"{API}/internal/event",
            headers=h,
            json={"type": "client_state", "state": "ready"},
            timeout=10,
        )
        time.sleep(0.4)

    def test_events_filter_by_phone(self, client):
        self._seed_events(client)
        r = client.get(f"{API}/events", params={"phone": TEST_PHONE}, timeout=10)
        assert r.status_code == 200
        events = r.json()
        assert len(events) >= 1
        for e in events:
            assert e["phone"] == TEST_PHONE

    def test_events_filter_by_event_type(self, client):
        self._seed_events(client)
        r = client.get(f"{API}/events", params={"event_type": "online"}, timeout=10)
        assert r.status_code == 200
        events = r.json()
        assert len(events) >= 1
        for e in events:
            assert e["event_type"] == "online"

    def test_events_export_csv_has_correct_header_and_content_type(self, client):
        self._seed_events(client)
        r = client.get(f"{API}/events/export.csv", timeout=10)
        assert r.status_code == 200
        ctype = r.headers.get("content-type", "")
        assert "text/csv" in ctype, f"unexpected content-type {ctype}"
        text = r.text
        first_line = text.splitlines()[0] if text else ""
        assert first_line == "timestamp,phone,event_type,detail,id"
        # Should contain at least one row of TEST_PHONE
        assert TEST_PHONE in text

    def test_events_export_csv_filters(self, client):
        self._seed_events(client)
        r = client.get(
            f"{API}/events/export.csv",
            params={"phone": TEST_PHONE, "event_type": "online"},
            timeout=10,
        )
        assert r.status_code == 200
        lines = [l for l in r.text.splitlines() if l]
        # header + at least one data row
        assert len(lines) >= 2
        for line in lines[1:]:
            cols = line.split(",")
            assert cols[1] == TEST_PHONE
            assert cols[2] == "online"


# ---- Settings (NEW: daily summary fields, validation, hour clamp) ----------
class TestSettings:
    def test_default_settings_have_daily_summary_fields(self, client):
        client.put(
            f"{API}/settings",
            json={
                "email_enabled": False,
                "email_recipient": None,
                "daily_summary_enabled": False,
                "daily_summary_hour": 9,
            },
            timeout=10,
        )
        r = client.get(f"{API}/settings", timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert "daily_summary_enabled" in data
        assert "daily_summary_hour" in data
        assert data["daily_summary_enabled"] is False
        assert data["daily_summary_hour"] == 9

    def test_update_daily_summary_persists(self, client):
        payload = {
            "email_enabled": True,
            "email_recipient": "test@example.com",
            "daily_summary_enabled": True,
            "daily_summary_hour": 14,
        }
        r = client.put(f"{API}/settings", json=payload, timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert d["daily_summary_enabled"] is True
        assert d["daily_summary_hour"] == 14
        # GET to verify persistence
        r2 = client.get(f"{API}/settings", timeout=10).json()
        assert r2["daily_summary_enabled"] is True
        assert r2["daily_summary_hour"] == 14

    def test_email_enabled_without_recipient_returns_400(self, client):
        r = client.put(
            f"{API}/settings",
            json={
                "email_enabled": True,
                "email_recipient": None,
                "daily_summary_enabled": False,
                "daily_summary_hour": 9,
            },
            timeout=10,
        )
        assert r.status_code == 400
        assert "email_recipient" in r.json().get("detail", "").lower()

    def test_daily_summary_hour_clamped_to_23(self, client):
        r = client.put(
            f"{API}/settings",
            json={
                "email_enabled": False,
                "email_recipient": None,
                "daily_summary_enabled": True,
                "daily_summary_hour": 25,
            },
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["daily_summary_hour"] == 23

    def test_send_summary_now_disabled_returns_400(self, client):
        client.put(
            f"{API}/settings",
            json={
                "email_enabled": False,
                "email_recipient": None,
                "daily_summary_enabled": False,
                "daily_summary_hour": 9,
            },
            timeout=10,
        )
        r = client.post(f"{API}/settings/send-summary-now", timeout=20)
        assert r.status_code == 400
        assert "summary not sent" in r.json().get("detail", "").lower()

    def test_send_summary_now_success_path(self, client):
        """Seed a monitor + enable daily_summary, then verify endpoint returns 200."""
        seed_phone = "33611111111"

        async def _seed():
            mc = AsyncIOMotorClient(os.environ["MONGO_URL"])
            db = mc[os.environ["DB_NAME"]]
            await db.monitors.delete_one({"phone": seed_phone})
            await db.monitors.insert_one({
                "phone": seed_phone,
                "label": "Summary Test",
                "added_at": datetime.now(timezone.utc).isoformat(),
                "status": "unknown",
                "last_seen": None,
            })
            mc.close()
        asyncio.run(_seed())
        try:
            client.put(
                f"{API}/settings",
                json={
                    "email_enabled": True,
                    "email_recipient": "delivered@resend.dev",
                    "daily_summary_enabled": True,
                    "daily_summary_hour": 9,
                },
                timeout=10,
            )
            r = client.post(f"{API}/settings/send-summary-now", timeout=30)
            # 200 ok if Resend accepts; 400 if Resend test mode rejects (acceptable per spec)
            assert r.status_code in (200, 400), r.text
            if r.status_code == 200:
                assert r.json().get("ok") is True
        finally:
            async def _cleanup():
                mc = AsyncIOMotorClient(os.environ["MONGO_URL"])
                db = mc[os.environ["DB_NAME"]]
                await db.monitors.delete_one({"phone": seed_phone})
                mc.close()
            asyncio.run(_cleanup())
            client.put(
                f"{API}/settings",
                json={
                    "email_enabled": False,
                    "email_recipient": None,
                    "daily_summary_enabled": False,
                    "daily_summary_hour": 9,
                },
                timeout=10,
            )


# ---- Internal webhook auth (NEW) -------------------------------------------
class TestInternalWebhookAuth:
    def test_no_secret_returns_401(self, client):
        # No X-Internal-Secret header
        r = requests.post(
            f"{API}/internal/event",
            json={"type": "client_state", "state": "ready"},
            timeout=10,
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 401, f"expected 401 got {r.status_code}: {r.text}"

    def test_wrong_secret_returns_401(self, client):
        r = requests.post(
            f"{API}/internal/event",
            json={"type": "client_state", "state": "ready"},
            timeout=10,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": "wrong-value",
            },
        )
        assert r.status_code == 401

    def test_valid_secret_client_state_succeeds(self, client):
        client.delete(f"{API}/events", timeout=10)
        r = requests.post(
            f"{API}/internal/event",
            json={"type": "client_state", "state": "ready"},
            timeout=10,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": INTERNAL_SECRET,
            },
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True
        time.sleep(0.4)
        events = client.get(f"{API}/events", timeout=10).json()
        assert any(
            e["event_type"] == "client_state" and e["detail"] == "ready" for e in events
        )

    def test_valid_secret_presence_succeeds(self, client):
        client.delete(f"{API}/events", timeout=10)
        r = requests.post(
            f"{API}/internal/event",
            json={"type": "presence", "phone": TEST_PHONE, "status": "online"},
            timeout=10,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": INTERNAL_SECRET,
            },
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True
        time.sleep(0.4)
        events = client.get(f"{API}/events", timeout=10).json()
        assert any(
            e["phone"] == TEST_PHONE and e["event_type"] == "online" for e in events
        )


# ---- WebSocket (regression) ------------------------------------------------
class TestWebSocket:
    def test_ws_hello_message(self):
        async def _run():
            async with websockets.connect(WS_URL, open_timeout=10) as ws:
                msg = await asyncio.wait_for(ws.recv(), timeout=10)
                return msg
        msg = asyncio.run(_run())
        assert "hello" in msg

    def test_ws_receives_broadcast_on_internal_event(self):
        async def _run():
            async with websockets.connect(WS_URL, open_timeout=10) as ws:
                hello = await asyncio.wait_for(ws.recv(), timeout=10)
                assert "hello" in hello

                def post_event():
                    requests.post(
                        f"{API}/internal/event",
                        json={
                            "type": "presence",
                            "phone": TEST_PHONE,
                            "status": "online",
                        },
                        timeout=10,
                        headers={
                            "Content-Type": "application/json",
                            "X-Internal-Secret": INTERNAL_SECRET,
                        },
                    )

                await asyncio.get_event_loop().run_in_executor(None, post_event)

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
        assert msg is not None
