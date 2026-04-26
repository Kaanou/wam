"""Iteration 4 backend tests: extended internal webhooks (activity, last_seen_update,
profile_snapshot/change), profile-snapshots endpoint, analytics (heatmap, anomalies,
correlations), backup/restore, and event filtering by new event_types.

Seeds DB directly via motor + simulates whatsapp_service via direct POST to
/api/internal/event with X-Internal-Secret. Cleanups TEST_ data after each test.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
INTERNAL_SECRET = os.environ["INTERNAL_API_SECRET"]
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

TEST_PHONE_A = "33699887701"
TEST_PHONE_B = "33699887702"
TEST_PHONE_C = "33699887703"


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


@pytest.fixture(scope="module")
def headers():
    return {"X-Internal-Secret": INTERNAL_SECRET, "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _run(coro):
    return asyncio.run(coro)


async def _cleanup_async():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    test_phones = [TEST_PHONE_A, TEST_PHONE_B, TEST_PHONE_C]
    await db.events.delete_many({"phone": {"$in": test_phones}})
    await db.monitors.delete_many({"phone": {"$in": test_phones}})
    await db.profile_snapshots.delete_many({"phone": {"$in": test_phones}})
    client.close()


@pytest.fixture(autouse=True)
def cleanup():
    _run(_cleanup_async())
    yield
    _run(_cleanup_async())


# --------------------------------------------------------------------- helpers
async def _seed_monitor(phone: str, label: str | None = None):
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    await db.monitors.insert_one(
        {
            "phone": phone,
            "label": label,
            "added_at": iso(datetime.now(timezone.utc) - timedelta(days=30)),
            "status": "unknown",
            "last_seen": None,
        }
    )
    client.close()


async def _seed_events(phone: str, pairs: list[tuple[datetime, datetime]]):
    """Each pair = (online_ts, offline_ts). Inserts both events."""
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    docs = []
    for s, e in pairs:
        docs.append({"id": str(uuid.uuid4()), "phone": phone, "event_type": "online", "timestamp": iso(s), "detail": None})
        docs.append({"id": str(uuid.uuid4()), "phone": phone, "event_type": "offline", "timestamp": iso(e), "detail": None})
    if docs:
        await db.events.insert_many(docs)
    client.close()


# ============================================================ REGRESSION SMOKE
class TestRegressionSmoke:
    def test_status(self, session):
        r = session.get(f"{BASE_URL}/api/whatsapp/status")
        assert r.status_code == 200
        assert "state" in r.json()

    def test_monitors(self, session):
        r = session.get(f"{BASE_URL}/api/monitors")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_events(self, session):
        r = session.get(f"{BASE_URL}/api/events")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_settings(self, session):
        r = session.get(f"{BASE_URL}/api/settings")
        assert r.status_code == 200
        assert "email_enabled" in r.json()

    def test_alert_rules(self, session):
        r = session.get(f"{BASE_URL}/api/alert-rules")
        assert r.status_code == 200
        assert isinstance(r.json(), list)


# ===================================================== INTERNAL WEBHOOK SECRET
class TestInternalSecret:
    def test_missing_secret_returns_401(self, session):
        r = session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "activity", "phone": TEST_PHONE_A, "activity": "composing"},
        )
        assert r.status_code == 401

    def test_wrong_secret_returns_401(self, session):
        r = session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "activity", "phone": TEST_PHONE_A, "activity": "composing"},
            headers={"X-Internal-Secret": "WRONG"},
        )
        assert r.status_code == 401


# ================================================== INTERNAL WEBHOOK: ACTIVITY
class TestActivityWebhook:
    def test_composing_inserts_event(self, session, headers):
        r = session.post(
            f"{BASE_URL}/api/internal/event",
            json={
                "type": "activity",
                "phone": TEST_PHONE_A,
                "activity": "composing",
                "timestamp": iso(datetime.now(timezone.utc)),
            },
            headers=headers,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        # Verify event persisted with event_type=composing
        ev = session.get(
            f"{BASE_URL}/api/events", params={"phone": TEST_PHONE_A, "event_type": "composing"}
        ).json()
        assert len(ev) >= 1
        assert ev[0]["event_type"] == "composing"
        assert ev[0]["phone"] == TEST_PHONE_A

    def test_recording_inserts_event(self, session, headers):
        session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "activity", "phone": TEST_PHONE_A, "activity": "recording"},
            headers=headers,
        )
        ev = session.get(
            f"{BASE_URL}/api/events", params={"phone": TEST_PHONE_A, "event_type": "recording"}
        ).json()
        assert len(ev) >= 1
        assert ev[0]["event_type"] == "recording"


# ========================================== INTERNAL WEBHOOK: LAST_SEEN_UPDATE
class TestLastSeenUpdate:
    def test_updates_monitor_last_seen_public(self, session, headers):
        _run(_seed_monitor(TEST_PHONE_A, "alpha"))
        ls = "il y a 2 minutes"
        r = session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "last_seen_update", "phone": TEST_PHONE_A, "last_seen_public": ls},
            headers=headers,
        )
        assert r.status_code == 200

        async def _check():
            client = AsyncIOMotorClient(MONGO_URL)
            db = client[DB_NAME]
            m = await db.monitors.find_one({"phone": TEST_PHONE_A}, {"_id": 0})
            client.close()
            return m

        m = _run(_check())
        assert m is not None
        assert m.get("last_seen_public") == ls


# ==================================== INTERNAL WEBHOOK: PROFILE SNAPSHOT/CHANGE
class TestProfileSnapshots:
    def test_first_snapshot_no_event(self, session, headers):
        r = session.post(
            f"{BASE_URL}/api/internal/event",
            json={
                "type": "profile_snapshot",
                "phone": TEST_PHONE_A,
                "first": True,
                "pic_url": "https://example.com/p.jpg",
                "name": "Alpha",
                "about": "hi",
            },
            headers=headers,
        )
        assert r.status_code == 200

        # No event_type=profile_change should have been logged
        ev = session.get(
            f"{BASE_URL}/api/events",
            params={"phone": TEST_PHONE_A, "event_type": "profile_change"},
        ).json()
        assert len(ev) == 0

        # Snapshot should be present
        snaps = session.get(
            f"{BASE_URL}/api/profile-snapshots", params={"phone": TEST_PHONE_A}
        ).json()
        assert len(snaps) >= 1
        assert snaps[0]["phone"] == TEST_PHONE_A
        assert snaps[0]["first"] is True
        assert snaps[0]["name"] == "Alpha"

    def test_profile_change_inserts_snapshot_and_event(self, session, headers):
        # First baseline
        session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "profile_snapshot", "phone": TEST_PHONE_A, "first": True, "name": "Alpha"},
            headers=headers,
        )
        # Then change
        r = session.post(
            f"{BASE_URL}/api/internal/event",
            json={
                "type": "profile_change",
                "phone": TEST_PHONE_A,
                "name": "Alpha2",
                "changes": {"name": {"old": "Alpha", "new": "Alpha2"}},
            },
            headers=headers,
        )
        assert r.status_code == 200
        ev = session.get(
            f"{BASE_URL}/api/events",
            params={"phone": TEST_PHONE_A, "event_type": "profile_change"},
        ).json()
        assert len(ev) >= 1
        assert ev[0]["event_type"] == "profile_change"
        assert "name" in (ev[0].get("detail") or "")

        snaps = session.get(
            f"{BASE_URL}/api/profile-snapshots", params={"phone": TEST_PHONE_A}
        ).json()
        assert len(snaps) >= 2

    def test_snapshots_sorted_desc(self, session, headers):
        for i in range(3):
            session.post(
                f"{BASE_URL}/api/internal/event",
                json={
                    "type": "profile_snapshot",
                    "phone": TEST_PHONE_A,
                    "first": i == 0,
                    "name": f"V{i}",
                    "timestamp": iso(datetime.now(timezone.utc) - timedelta(minutes=10 - i)),
                },
                headers=headers,
            )
        snaps = session.get(
            f"{BASE_URL}/api/profile-snapshots", params={"phone": TEST_PHONE_A}
        ).json()
        ts = [s["captured_at"] for s in snaps]
        assert ts == sorted(ts, reverse=True)


# ============================================================= ANALYTICS: HEATMAP
class TestHeatmap:
    def test_heatmap_grid_shape_and_total(self, session):
        # Seed 2 sessions of known durations
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        s1 = now - timedelta(days=1)
        e1 = s1 + timedelta(minutes=30)
        s2 = now - timedelta(days=2)
        e2 = s2 + timedelta(minutes=15)
        _run(_seed_events(TEST_PHONE_A, [(s1, e1), (s2, e2)]))

        r = session.get(f"{BASE_URL}/api/analytics/heatmap", params={"phone": TEST_PHONE_A, "days": 7})
        assert r.status_code == 200
        data = r.json()
        assert data["phone"] == TEST_PHONE_A
        assert data["days"] == 7
        assert len(data["grid"]) == 7
        assert all(len(row) == 24 for row in data["grid"])
        grid_sum = sum(sum(r) for r in data["grid"])
        assert abs(grid_sum - data["total_minutes"]) < 0.01
        # 30 + 15 = 45 minutes total
        assert abs(data["total_minutes"] - 45.0) < 0.5

    def test_heatmap_days_clamped(self, session):
        r = session.get(f"{BASE_URL}/api/analytics/heatmap", params={"phone": TEST_PHONE_A, "days": 9999})
        assert r.status_code == 200
        assert r.json()["days"] == 180

        r2 = session.get(f"{BASE_URL}/api/analytics/heatmap", params={"phone": TEST_PHONE_A, "days": 0})
        assert r2.status_code == 200
        assert r2.json()["days"] == 1


# =========================================================== ANALYTICS: ANOMALIES
class TestAnomalies:
    def test_insufficient_history(self, session):
        r = session.get(f"{BASE_URL}/api/analytics/anomalies", params={"phone": TEST_PHONE_A})
        assert r.status_code == 200
        data = r.json()
        assert data["phone"] == TEST_PHONE_A
        assert data["anomalies"] == []
        assert data.get("note") in ("insufficient history", "no data today")


# ========================================================= ANALYTICS: CORRELATIONS
class TestCorrelations:
    def test_needs_at_least_2_monitors(self, session):
        # Ensure low monitor count: cleanup has wiped TEST_PHONE_*; check that
        # if total monitors < 2, the note is returned.
        async def _count():
            client = AsyncIOMotorClient(MONGO_URL)
            n = await client[DB_NAME].monitors.count_documents({})
            client.close()
            return n

        n = _run(_count())
        if n >= 2:
            pytest.skip(f"DB already has {n} monitors; cannot test <2 case")
        r = session.get(f"{BASE_URL}/api/analytics/correlations", params={"days": 14})
        assert r.status_code == 200
        data = r.json()
        assert data.get("note") == "need at least 2 monitors"
        assert data["pairs"] == []

    def test_overlap_computed(self, session):
        _run(_seed_monitor(TEST_PHONE_A, "alpha"))
        _run(_seed_monitor(TEST_PHONE_B, "beta"))
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        # A online 10:00-11:00, B online 10:30-10:45 -> 15 min overlap
        sA = now - timedelta(days=1, hours=2)
        eA = sA + timedelta(hours=1)
        sB = sA + timedelta(minutes=30)
        eB = sB + timedelta(minutes=15)
        _run(_seed_events(TEST_PHONE_A, [(sA, eA)]))
        _run(_seed_events(TEST_PHONE_B, [(sB, eB)]))

        r = session.get(f"{BASE_URL}/api/analytics/correlations", params={"days": 7})
        assert r.status_code == 200
        data = r.json()
        # Find our pair
        match = [
            p for p in data["pairs"]
            if {p["phone_a"], p["phone_b"]} == {TEST_PHONE_A, TEST_PHONE_B}
        ]
        assert len(match) == 1, f"pair not found in {data['pairs']}"
        pair = match[0]
        assert abs(pair["overlap_minutes"] - 15.0) < 1.0
        assert pair["overlap_pct"] > 0
        assert pair["label_a"] in ("alpha", "beta")
        assert pair["label_b"] in ("alpha", "beta")


# ================================================================ BACKUP/RESTORE
class TestBackupRestore:
    def test_backup_shape(self, session):
        r = session.get(f"{BASE_URL}/api/backup")
        assert r.status_code == 200
        data = r.json()
        for key in ("version", "exported_at", "monitors", "events", "settings", "alert_rules", "profile_snapshots"):
            assert key in data
        assert data["version"] == 1

    def test_restore_replace_true(self, session, headers):
        _run(_seed_monitor(TEST_PHONE_A, "before"))
        # Backup current state first so we don't lose other data
        full = session.get(f"{BASE_URL}/api/backup").json()

        payload = {
            "monitors": [
                {
                    "phone": TEST_PHONE_C,
                    "label": "restored",
                    "added_at": iso(datetime.now(timezone.utc)),
                    "status": "unknown",
                    "last_seen": None,
                }
            ],
            "events": [],
            "alert_rules": [],
            "profile_snapshots": [],
            "settings": full.get("settings"),
            "version": 1,
        }
        r = session.post(f"{BASE_URL}/api/backup/restore?replace=true", json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["restored"]["monitors"] == 1

        # TEST_PHONE_A monitor (seeded before) should be gone
        ms = session.get(f"{BASE_URL}/api/monitors").json()
        phones = [m["phone"] for m in ms]
        assert TEST_PHONE_A not in phones
        assert TEST_PHONE_C in phones

        # Restore original full backup so we don't break other tests/iterations
        restore_payload = {
            "monitors": full["monitors"],
            "events": full["events"],
            "alert_rules": full["alert_rules"],
            "profile_snapshots": full["profile_snapshots"],
            "settings": full["settings"],
            "version": 1,
        }
        rr = session.post(f"{BASE_URL}/api/backup/restore?replace=true", json=restore_payload)
        assert rr.status_code == 200

    def test_restore_replace_false_appends(self, session):
        # Capture pre-count
        before = session.get(f"{BASE_URL}/api/monitors").json()
        before_count = len(before)
        payload = {
            "monitors": [
                {
                    "phone": TEST_PHONE_C,
                    "label": "appended",
                    "added_at": iso(datetime.now(timezone.utc)),
                    "status": "unknown",
                    "last_seen": None,
                }
            ],
            "events": [],
            "alert_rules": [],
            "profile_snapshots": [],
            "version": 1,
        }
        r = session.post(f"{BASE_URL}/api/backup/restore?replace=false", json=payload)
        assert r.status_code == 200
        after = session.get(f"{BASE_URL}/api/monitors").json()
        # After must include all before phones + TEST_PHONE_C
        before_phones = {m["phone"] for m in before}
        after_phones = {m["phone"] for m in after}
        assert before_phones.issubset(after_phones)
        assert TEST_PHONE_C in after_phones
        assert len(after) >= before_count

    def test_round_trip(self, session):
        # Export
        full = session.get(f"{BASE_URL}/api/backup").json()
        original_monitors = sorted([m["phone"] for m in full["monitors"]])

        # Restore (replace=true) with same payload
        payload = {
            "monitors": full["monitors"],
            "events": full["events"],
            "alert_rules": full["alert_rules"],
            "profile_snapshots": full["profile_snapshots"],
            "settings": full["settings"],
            "version": 1,
        }
        r = session.post(f"{BASE_URL}/api/backup/restore?replace=true", json=payload)
        assert r.status_code == 200

        # Re-export & compare monitor phones
        full2 = session.get(f"{BASE_URL}/api/backup").json()
        new_monitors = sorted([m["phone"] for m in full2["monitors"]])
        assert original_monitors == new_monitors


# =================================================== EVENT FILTER: NEW EVENT TYPES
class TestEventFilter:
    def test_filter_composing(self, session, headers):
        session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "activity", "phone": TEST_PHONE_A, "activity": "composing"},
            headers=headers,
        )
        ev = session.get(f"{BASE_URL}/api/events", params={"event_type": "composing"}).json()
        assert all(e["event_type"] == "composing" for e in ev)
        assert any(e["phone"] == TEST_PHONE_A for e in ev)

    def test_filter_recording(self, session, headers):
        session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "activity", "phone": TEST_PHONE_A, "activity": "recording"},
            headers=headers,
        )
        ev = session.get(f"{BASE_URL}/api/events", params={"event_type": "recording"}).json()
        assert all(e["event_type"] == "recording" for e in ev)

    def test_filter_profile_change(self, session, headers):
        session.post(
            f"{BASE_URL}/api/internal/event",
            json={"type": "profile_snapshot", "phone": TEST_PHONE_A, "first": True, "name": "x"},
            headers=headers,
        )
        session.post(
            f"{BASE_URL}/api/internal/event",
            json={
                "type": "profile_change",
                "phone": TEST_PHONE_A,
                "name": "y",
                "changes": {"name": {"old": "x", "new": "y"}},
            },
            headers=headers,
        )
        ev = session.get(f"{BASE_URL}/api/events", params={"event_type": "profile_change"}).json()
        assert all(e["event_type"] == "profile_change" for e in ev)
        assert any(e["phone"] == TEST_PHONE_A for e in ev)
