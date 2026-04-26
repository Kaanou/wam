"""
Backend tests for iteration 3: customizable alert rules.

Covers:
- REGRESSION smoke check on /api/whatsapp/status, /api/monitors, /api/events, /api/settings
- Alert rules CRUD: GET / POST / PATCH / DELETE with validation:
  * type whitelist (forbidden_online | expected_online | inactivity)
  * phone validation (>=7 digits)
  * days_of_week sanitization (drop invalid, dedupe, sort)
  * start_hour clamping (0..23) and end_hour clamping (0..24)
  * grace_minutes / max_silence_hours storage for typed rules
  * sort by created_at desc on GET
  * empty PATCH body -> 400
  * missing rule -> 404
- Direct invocation (no 60s wait) of _evaluate_rule + _trigger_alert:
  * forbidden_online fires when monitor.status == online and now is in window
  * cooldown: a second immediate evaluation does NOT re-trigger
  * triggering inserts an `alert` event and updates rule.last_triggered_at
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / "frontend" / ".env")
load_dotenv(ROOT / "backend" / ".env")

# Make /app/backend importable so we can directly invoke alert helpers
sys.path.insert(0, str(ROOT / "backend"))

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

TEST_PHONE = "33699887766"
TEST_PHONE_TRIGGER = "33655443322"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module", autouse=True)
def _cleanup_rules_and_seeds(client):
    """Wipe alert_rules + test monitors/events before & after the run."""
    async def _wipe():
        mc = AsyncIOMotorClient(os.environ["MONGO_URL"])
        db = mc[os.environ["DB_NAME"]]
        await db.alert_rules.delete_many({"phone": {"$in": [TEST_PHONE, TEST_PHONE_TRIGGER]}})
        await db.monitors.delete_many({"phone": {"$in": [TEST_PHONE, TEST_PHONE_TRIGGER]}})
        await db.events.delete_many({"phone": {"$in": [TEST_PHONE, TEST_PHONE_TRIGGER]}})
        mc.close()

    asyncio.run(_wipe())
    yield
    asyncio.run(_wipe())


# ---- REGRESSION smoke -------------------------------------------------------
class TestRegressionSmoke:
    def test_status_ok(self, client):
        r = client.get(f"{API}/whatsapp/status", timeout=15)
        assert r.status_code == 200
        assert "state" in r.json()

    def test_monitors_list_ok(self, client):
        r = client.get(f"{API}/monitors", timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_events_list_ok(self, client):
        r = client.get(f"{API}/events", timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_settings_get_ok(self, client):
        r = client.get(f"{API}/settings", timeout=10)
        assert r.status_code == 200
        d = r.json()
        for k in ("email_enabled", "email_recipient", "daily_summary_enabled", "daily_summary_hour"):
            assert k in d


# ---- Alert rules CRUD + validation -----------------------------------------
class TestAlertRulesCRUD:
    def test_initial_list_returns_array(self, client):
        # Pre-clean any leftover with our test phones
        r = client.get(f"{API}/alert-rules", timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_create_forbidden_online(self, client):
        payload = {
            "phone": TEST_PHONE,
            "name": "Night forbidden",
            "type": "forbidden_online",
            "days_of_week": [0, 1, 2],
            "start_hour": 22,
            "end_hour": 6,
        }
        r = client.post(f"{API}/alert-rules", json=payload, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["id"] and isinstance(d["id"], str)
        assert d["created_at"]
        assert d["phone"] == TEST_PHONE
        assert d["type"] == "forbidden_online"
        assert d["days_of_week"] == [0, 1, 2]
        assert d["start_hour"] == 22
        assert d["end_hour"] == 6
        assert d["enabled"] is True
        # GET to verify persistence
        rules = client.get(f"{API}/alert-rules", timeout=10).json()
        assert any(r2["id"] == d["id"] for r2 in rules)

    def test_create_expected_online_stores_grace_minutes(self, client):
        payload = {
            "phone": TEST_PHONE,
            "name": "Work online",
            "type": "expected_online",
            "grace_minutes": 15,
        }
        r = client.post(f"{API}/alert-rules", json=payload, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json()["grace_minutes"] == 15

    def test_create_inactivity_stores_max_silence_hours(self, client):
        payload = {
            "phone": TEST_PHONE,
            "name": "Inactive",
            "type": "inactivity",
            "max_silence_hours": 12,
        }
        r = client.post(f"{API}/alert-rules", json=payload, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json()["max_silence_hours"] == 12

    def test_create_invalid_type_returns_400_with_valid_list(self, client):
        r = client.post(
            f"{API}/alert-rules",
            json={"phone": TEST_PHONE, "name": "x", "type": "foo"},
            timeout=10,
        )
        assert r.status_code == 400
        detail = r.json().get("detail", "").lower()
        # Helpful detail must mention valid types
        assert "forbidden_online" in detail
        assert "expected_online" in detail
        assert "inactivity" in detail

    def test_create_invalid_phone_returns_400(self, client):
        r = client.post(
            f"{API}/alert-rules",
            json={"phone": "12", "name": "x", "type": "forbidden_online"},
            timeout=10,
        )
        assert r.status_code == 400
        assert "invalid phone" in r.json().get("detail", "").lower()

    def test_days_of_week_sanitization_drops_invalid(self, client):
        r = client.post(
            f"{API}/alert-rules",
            json={
                "phone": TEST_PHONE,
                "name": "Sanitize",
                "type": "forbidden_online",
                "days_of_week": [0, 9, 3],
            },
            timeout=10,
        )
        assert r.status_code == 200, r.text
        # 9 dropped, sorted unique -> [0, 3]
        assert r.json()["days_of_week"] == [0, 3]

    def test_start_hour_clamped(self, client):
        r = client.post(
            f"{API}/alert-rules",
            json={
                "phone": TEST_PHONE,
                "name": "Clamp",
                "type": "forbidden_online",
                "start_hour": 30,
            },
            timeout=10,
        )
        assert r.status_code == 200, r.text
        assert r.json()["start_hour"] == 23

    def test_list_sorted_by_created_at_desc(self, client):
        r = client.get(f"{API}/alert-rules", timeout=10)
        assert r.status_code == 200
        rules = [x for x in r.json() if x["phone"] == TEST_PHONE]
        assert len(rules) >= 2
        # Validate sort: created_at desc
        timestamps = [x["created_at"] for x in rules]
        assert timestamps == sorted(timestamps, reverse=True)

    def test_patch_enabled_false(self, client):
        rules = [r for r in client.get(f"{API}/alert-rules", timeout=10).json() if r["phone"] == TEST_PHONE]
        rid = rules[0]["id"]
        r = client.patch(f"{API}/alert-rules/{rid}", json={"enabled": False}, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json()["enabled"] is False
        # GET to verify
        rules2 = client.get(f"{API}/alert-rules", timeout=10).json()
        match = [x for x in rules2 if x["id"] == rid]
        assert match and match[0]["enabled"] is False

    def test_patch_multiple_fields(self, client):
        rules = [r for r in client.get(f"{API}/alert-rules", timeout=10).json() if r["phone"] == TEST_PHONE]
        rid = rules[0]["id"]
        r = client.patch(
            f"{API}/alert-rules/{rid}",
            json={"name": "Renamed", "days_of_week": [1, 2, 5], "grace_minutes": 45},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["name"] == "Renamed"
        assert d["days_of_week"] == [1, 2, 5]
        assert d["grace_minutes"] == 45

    def test_patch_empty_body_returns_400(self, client):
        rules = [r for r in client.get(f"{API}/alert-rules", timeout=10).json() if r["phone"] == TEST_PHONE]
        rid = rules[0]["id"]
        r = client.patch(f"{API}/alert-rules/{rid}", json={}, timeout=10)
        assert r.status_code == 400
        assert "no fields to update" in r.json().get("detail", "").lower()

    def test_patch_nonexistent_returns_404(self, client):
        r = client.patch(
            f"{API}/alert-rules/{uuid.uuid4()}",
            json={"enabled": True},
            timeout=10,
        )
        assert r.status_code == 404
        assert "not found" in r.json().get("detail", "").lower()

    def test_delete_rule_and_404_on_second_delete(self, client):
        # Create a throwaway rule to delete
        r = client.post(
            f"{API}/alert-rules",
            json={"phone": TEST_PHONE, "name": "ToDelete", "type": "inactivity"},
            timeout=10,
        )
        rid = r.json()["id"]
        d1 = client.delete(f"{API}/alert-rules/{rid}", timeout=10)
        assert d1.status_code == 200
        assert d1.json() == {"ok": True}
        d2 = client.delete(f"{API}/alert-rules/{rid}", timeout=10)
        assert d2.status_code == 404


# ---- Trigger logic via direct helper invocation ----------------------------
class TestAlertTrigger:
    def test_evaluate_and_trigger_forbidden_online_with_cooldown(self, client):
        """Seed a monitor (status=online), create a forbidden_online rule
        covering current weekday/hour, and invoke _evaluate_rule + _trigger_alert
        directly. Verify event insertion, last_triggered_at, and cooldown."""

        # Import the running server module's helpers (uses production DB handle)
        import server as srv  # type: ignore

        async def _run():
            mc = AsyncIOMotorClient(os.environ["MONGO_URL"])
            db = mc[os.environ["DB_NAME"]]
            # Rebind module-level db to a client bound to *this* event loop
            srv.db = db

            # Clean
            await db.alert_rules.delete_many({"phone": TEST_PHONE_TRIGGER})
            await db.monitors.delete_many({"phone": TEST_PHONE_TRIGGER})
            await db.events.delete_many({"phone": TEST_PHONE_TRIGGER})

            now = datetime.now(timezone.utc)

            # Seed monitor as ONLINE
            monitor_doc = {
                "phone": TEST_PHONE_TRIGGER,
                "label": "Trigger Test",
                "added_at": now.isoformat(),
                "status": "online",
                "last_seen": now.isoformat(),
            }
            await db.monitors.insert_one(monitor_doc.copy())

            # Build a rule covering EVERY weekday and ALL hours so that
            # post-cooldown re-evaluation also stays in-window
            rule_id = str(uuid.uuid4())
            rule_doc = {
                "id": rule_id,
                "phone": TEST_PHONE_TRIGGER,
                "name": "TestForbid",
                "type": "forbidden_online",
                "enabled": True,
                "days_of_week": [0, 1, 2, 3, 4, 5, 6],
                "start_hour": 0,
                "end_hour": 24,
                "grace_minutes": 30,
                "max_silence_hours": 24,
                "last_triggered_at": None,
                "created_at": now.isoformat(),
            }
            await db.alert_rules.insert_one(rule_doc.copy())

            # First evaluation - should trigger
            msg = await srv._evaluate_rule(rule_doc, monitor_doc, now)
            assert msg is not None, "rule should fire (forbidden_online + status=online + in-window)"
            await srv._trigger_alert(rule_doc, msg, now)

            # Verify alert event inserted
            ev = await db.events.find_one(
                {"phone": TEST_PHONE_TRIGGER, "event_type": "alert"}
            )
            assert ev is not None, "alert event must be inserted"
            assert "TestForbid" in (ev.get("detail") or "")

            # Verify last_triggered_at updated on the rule
            updated = await db.alert_rules.find_one({"id": rule_id})
            assert updated and updated.get("last_triggered_at") is not None

            # Cooldown check: re-evaluate immediately - should NOT fire
            # _evaluate_rule reads last_triggered_at from the rule dict passed in
            updated_rule = dict(updated)
            updated_rule.pop("_id", None)
            msg2 = await srv._evaluate_rule(updated_rule, monitor_doc, now + timedelta(seconds=5))
            assert msg2 is None, "cooldown should suppress immediate retrigger"

            # And after cooldown expires, it should fire again
            future = now + timedelta(seconds=srv.ALERT_COOLDOWN_SECONDS + 5)
            msg3 = await srv._evaluate_rule(updated_rule, monitor_doc, future)
            assert msg3 is not None, "rule should fire again after cooldown"

            # Cleanup
            await db.alert_rules.delete_many({"phone": TEST_PHONE_TRIGGER})
            await db.monitors.delete_many({"phone": TEST_PHONE_TRIGGER})
            await db.events.delete_many({"phone": TEST_PHONE_TRIGGER})
            mc.close()

        asyncio.run(_run())

    def test_evaluate_forbidden_online_outside_window_does_not_fire(self):
        import server as srv  # type: ignore

        async def _run():
            now = datetime.now(timezone.utc)
            # Window covers a different weekday (force out-of-window)
            other_day = (now.weekday() + 1) % 7
            rule = {
                "id": "x",
                "phone": "33600000000",
                "name": "OutOfWindow",
                "type": "forbidden_online",
                "enabled": True,
                "days_of_week": [other_day],
                "start_hour": 0,
                "end_hour": 24,
                "grace_minutes": 30,
                "max_silence_hours": 24,
                "last_triggered_at": None,
            }
            monitor = {"phone": "33600000000", "status": "online"}
            msg = await srv._evaluate_rule(rule, monitor, now)
            assert msg is None

        asyncio.run(_run())

    def test_evaluate_inactivity_fires_when_silent_long_enough(self):
        import server as srv  # type: ignore

        async def _run():
            mc = AsyncIOMotorClient(os.environ["MONGO_URL"])
            db = mc[os.environ["DB_NAME"]]
            srv.db = db
            phone = "33644445555"
            await db.events.delete_many({"phone": phone})
            await db.monitors.delete_many({"phone": phone})

            now = datetime.now(timezone.utc)
            old = now - timedelta(hours=48)
            # Seed an old online event
            await db.events.insert_one({
                "id": str(uuid.uuid4()),
                "phone": phone,
                "event_type": "online",
                "timestamp": old.isoformat(),
                "detail": None,
            })
            monitor = {"phone": phone, "status": "offline", "added_at": old.isoformat()}
            rule = {
                "id": "i1",
                "phone": phone,
                "name": "Silent",
                "type": "inactivity",
                "enabled": True,
                "max_silence_hours": 12,
                "last_triggered_at": None,
            }
            msg = await srv._evaluate_rule(rule, monitor, now)
            assert msg is not None and "sans activité" in msg

            # Cleanup
            await db.events.delete_many({"phone": phone})
            mc.close()

        asyncio.run(_run())
