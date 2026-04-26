"""
FastAPI backend for the WhatsApp connection monitor.

This server is the only component exposed publicly (via /api). It proxies the
internal Node.js WhatsApp service (whatsapp-web.js), persists monitors,
events and settings in MongoDB, broadcasts presence changes to the frontend
over a WebSocket, and optionally sends Resend email notifications.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
import csv
import io
from datetime import datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import httpx
import resend
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, Header, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---- Config -----------------------------------------------------------------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
WHATSAPP_SERVICE_URL = os.environ.get("WHATSAPP_SERVICE_URL", "http://localhost:3001")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "")

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY

# ---- Logging ----------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("wa-monitor")

# ---- DB ---------------------------------------------------------------------
mongo_client = AsyncIOMotorClient(MONGO_URL)
db = mongo_client[DB_NAME]

# ---- App --------------------------------------------------------------------
app = FastAPI(title="WhatsApp Connection Monitor")
api_router = APIRouter(prefix="/api")


# ---- Models -----------------------------------------------------------------
class Monitor(BaseModel):
    model_config = ConfigDict(extra="ignore")
    phone: str
    label: Optional[str] = None
    added_at: datetime
    status: str = "unknown"  # online | offline | unknown
    last_seen: Optional[datetime] = None


class MonitorCreate(BaseModel):
    phone: str
    label: Optional[str] = None


class MonitorPatch(BaseModel):
    label: Optional[str] = None


class EventLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    phone: str
    event_type: str  # online | offline | client_state
    timestamp: datetime
    detail: Optional[str] = None


class Settings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    email_enabled: bool = False
    email_recipient: Optional[str] = None
    daily_summary_enabled: bool = False
    daily_summary_hour: int = 9  # UTC hour 0-23


class SettingsUpdate(BaseModel):
    email_enabled: bool
    email_recipient: Optional[EmailStr] = None
    daily_summary_enabled: bool = False
    daily_summary_hour: int = 9


class PairingCodeRequest(BaseModel):
    phone: str


class AlertRule(BaseModel):
    """A user-defined alert rule.

    type:
      * forbidden_online  — fire if the contact is ONLINE inside the window.
      * expected_online   — fire if the contact is OFFLINE for more than
        `grace_minutes` consecutive minutes inside the window.
      * inactivity        — fire if no `online` event has been seen in the
        last `max_silence_hours` hours (window/days ignored).
    """

    model_config = ConfigDict(extra="ignore")
    id: str
    phone: str
    name: str
    type: str  # forbidden_online | expected_online | inactivity
    enabled: bool = True
    days_of_week: List[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4, 5, 6])  # 0=Mon
    start_hour: int = 0
    end_hour: int = 24
    grace_minutes: int = 30
    max_silence_hours: int = 24
    last_triggered_at: Optional[datetime] = None
    created_at: datetime


class AlertRuleCreate(BaseModel):
    phone: str
    name: str
    type: str
    enabled: bool = True
    days_of_week: Optional[List[int]] = None
    start_hour: int = 0
    end_hour: int = 24
    grace_minutes: int = 30
    max_silence_hours: int = 24


class AlertRulePatch(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    days_of_week: Optional[List[int]] = None
    start_hour: Optional[int] = None
    end_hour: Optional[int] = None
    grace_minutes: Optional[int] = None
    max_silence_hours: Optional[int] = None


class InternalEvent(BaseModel):
    type: str  # presence | client_state
    phone: Optional[str] = None
    status: Optional[str] = None
    state: Optional[str] = None
    timestamp: Optional[str] = None
    message: Optional[str] = None
    reason: Optional[str] = None


# ---- WebSocket manager ------------------------------------------------------
class WSManager:
    def __init__(self) -> None:
        self.active: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self.active.append(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            if ws in self.active:
                self.active.remove(ws)

    async def broadcast(self, payload: dict) -> None:
        dead: List[WebSocket] = []
        async with self._lock:
            sockets = list(self.active)
        for ws in sockets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for d in dead:
                    if d in self.active:
                        self.active.remove(d)


ws_manager = WSManager()


# ---- Helpers ----------------------------------------------------------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


async def get_settings() -> Settings:
    doc = await db.settings.find_one({"_id": "global"}, {"_id": 0})
    if not doc:
        return Settings()
    return Settings(**doc)


async def send_alert_email(phone: str, status: str, ts: datetime) -> None:
    settings = await get_settings()
    if not settings.email_enabled or not settings.email_recipient or not RESEND_API_KEY:
        return
    color = "#22c55e" if status == "online" else "#71717a"
    subject = f"[WA Monitor] +{phone} is now {status.upper()}"
    html = f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;background:#09090b;color:#fafafa;padding:24px">
      <tr><td>
        <h2 style="margin:0 0 12px 0;color:#fafafa">WhatsApp Status Change</h2>
        <p style="margin:0 0 16px 0;color:#a1a1aa">A monitored contact changed presence.</p>
        <table cellpadding="8" style="border:1px solid #27272a;border-radius:4px;font-family:monospace;font-size:13px">
          <tr><td style="color:#71717a">PHONE</td><td style="color:#fafafa">+{phone}</td></tr>
          <tr><td style="color:#71717a">STATUS</td><td style="color:{color};font-weight:bold">{status.upper()}</td></tr>
          <tr><td style="color:#71717a">TIMESTAMP</td><td style="color:#fafafa">{iso(ts)}</td></tr>
        </table>
      </td></tr>
    </table>
    """
    try:
        await asyncio.to_thread(
            resend.Emails.send,
            {
                "from": SENDER_EMAIL,
                "to": [settings.email_recipient],
                "subject": subject,
                "html": html,
            },
        )
    except Exception as e:
        logger.error(f"resend send failed: {e}")


async def wa_request(method: str, path: str, **kwargs) -> httpx.Response:
    url = f"{WHATSAPP_SERVICE_URL}{path}"
    async with httpx.AsyncClient(timeout=15) as client:
        return await client.request(method, url, **kwargs)


# ---- Daily summary scheduler ------------------------------------------------
def _human_duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    if h and m:
        return f"{h}h{m:02d}"
    if h:
        return f"{h}h"
    return f"{m}min"


async def build_daily_summary(period_start: datetime, period_end: datetime) -> Optional[str]:
    """Build the HTML body for the daily summary, or None if nothing to report."""
    monitors_docs = await db.monitors.find({}, {"_id": 0}).to_list(500)
    if not monitors_docs:
        return None

    rows_html = []
    for m in monitors_docs:
        phone = m.get("phone", "")
        label = m.get("label") or ""
        events = await db.events.find(
            {
                "phone": phone,
                "event_type": {"$in": ["online", "offline"]},
                "timestamp": {"$gte": iso(period_start), "$lt": iso(period_end)},
            },
            {"_id": 0},
        ).sort("timestamp", 1).to_list(2000)

        online_count = sum(1 for e in events if e.get("event_type") == "online")
        # Compute online time: pair online→offline within window.
        online_seconds = 0
        last_online_ts: Optional[datetime] = None
        for e in events:
            ts = e["timestamp"]
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
            if e["event_type"] == "online":
                last_online_ts = ts
            elif e["event_type"] == "offline" and last_online_ts is not None:
                online_seconds += int((ts - last_online_ts).total_seconds())
                last_online_ts = None
        # If still online at period end, add tail.
        if last_online_ts is not None:
            online_seconds += int((period_end - last_online_ts).total_seconds())

        last_seen_ts = m.get("last_seen")
        last_seen_str = (
            last_seen_ts if isinstance(last_seen_ts, str) else iso(last_seen_ts) if last_seen_ts else "—"
        )
        display = f"+{phone}" + (f" · {label}" if label else "")
        rows_html.append(
            f"""
            <tr>
              <td style="padding:8px;border-bottom:1px solid #27272a;color:#fafafa;font-family:monospace">{display}</td>
              <td style="padding:8px;border-bottom:1px solid #27272a;color:#22c55e;font-family:monospace">{online_count}</td>
              <td style="padding:8px;border-bottom:1px solid #27272a;color:#fafafa;font-family:monospace">{_human_duration(online_seconds)}</td>
              <td style="padding:8px;border-bottom:1px solid #27272a;color:#a1a1aa;font-family:monospace;font-size:11px">{last_seen_str}</td>
            </tr>
            """
        )

    if not rows_html:
        return None

    title_date = period_start.strftime("%Y-%m-%d")
    return f"""
    <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;background:#09090b;color:#fafafa;padding:24px">
      <tr><td>
        <h2 style="margin:0 0 4px 0;color:#fafafa">Daily Summary · {title_date}</h2>
        <p style="margin:0 0 16px 0;color:#a1a1aa;font-size:13px">
          Window: {iso(period_start)} → {iso(period_end)}
        </p>
        <table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #27272a;border-radius:4px;border-collapse:collapse">
          <thead>
            <tr style="background:#18181b">
              <th style="padding:8px;text-align:left;color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:1px">Number</th>
              <th style="padding:8px;text-align:left;color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:1px">Online events</th>
              <th style="padding:8px;text-align:left;color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:1px">Online time</th>
              <th style="padding:8px;text-align:left;color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:1px">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {''.join(rows_html)}
          </tbody>
        </table>
      </td></tr>
    </table>
    """


async def send_daily_summary_email() -> bool:
    settings = await get_settings()
    if not settings.daily_summary_enabled or not settings.email_recipient or not RESEND_API_KEY:
        return False
    end = now_utc().replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(hours=24)
    html = await build_daily_summary(start, end)
    if not html:
        return False
    try:
        await asyncio.to_thread(
            resend.Emails.send,
            {
                "from": SENDER_EMAIL,
                "to": [settings.email_recipient],
                "subject": f"[WA Monitor] Daily summary · {start.strftime('%Y-%m-%d')}",
                "html": html,
            },
        )
        await db.settings.update_one(
            {"_id": "global"},
            {"$set": {"last_summary_sent_at": iso(now_utc())}},
            upsert=False,
        )
        return True
    except Exception as e:
        logger.error(f"daily summary send failed: {e}")
        return False


async def daily_summary_loop() -> None:
    """Background task: every minute, check if it's time to send daily summary."""
    while True:
        try:
            await asyncio.sleep(60)
            settings = await get_settings()
            if not settings.daily_summary_enabled or not settings.email_recipient:
                continue
            now = now_utc()
            if now.hour != settings.daily_summary_hour:
                continue
            # Skip if already sent in the last 23 hours
            doc = await db.settings.find_one({"_id": "global"}, {"_id": 0})
            last = doc.get("last_summary_sent_at") if doc else None
            if last:
                last_dt = datetime.fromisoformat(last) if isinstance(last, str) else last
                if (now - last_dt).total_seconds() < 23 * 3600:
                    continue
            logger.info("[daily-summary] sending...")
            ok = await send_daily_summary_email()
            logger.info(f"[daily-summary] sent={ok}")
        except Exception as e:
            logger.error(f"daily_summary_loop error: {e}")
            await asyncio.sleep(60)  # avoid tight error loop


# ---- Alert rules evaluator --------------------------------------------------
ALERT_COOLDOWN_SECONDS = 3600  # 1h between two triggers of the same rule


def _in_window(now: datetime, rule: dict) -> bool:
    days = rule.get("days_of_week") or list(range(7))
    if now.weekday() not in days:
        return False
    h = now.hour
    start = int(rule.get("start_hour", 0))
    end = int(rule.get("end_hour", 24))
    if start <= end:
        return start <= h < end
    # Wraps midnight (e.g. 22 → 6)
    return h >= start or h < end


async def _last_online_event_ts(phone: str) -> Optional[datetime]:
    docs = await db.events.find(
        {"phone": phone, "event_type": "online"},
        {"_id": 0},
    ).sort("timestamp", -1).limit(1).to_list(1)
    if not docs:
        return None
    ts = docs[0]["timestamp"]
    return datetime.fromisoformat(ts) if isinstance(ts, str) else ts


async def _evaluate_rule(rule: dict, monitor: Optional[dict], now: datetime) -> Optional[str]:
    """Return alert message string if rule should fire, else None."""
    last_trig = rule.get("last_triggered_at")
    if last_trig:
        last_dt = datetime.fromisoformat(last_trig) if isinstance(last_trig, str) else last_trig
        if (now - last_dt).total_seconds() < ALERT_COOLDOWN_SECONDS:
            return None

    rtype = rule.get("type")
    phone = rule.get("phone", "")
    label = (monitor or {}).get("label") or ""
    pretty = f"+{phone}" + (f" ({label})" if label else "")

    if rtype == "forbidden_online":
        if not _in_window(now, rule):
            return None
        if monitor and monitor.get("status") == "online":
            return f"{pretty} est ONLINE pendant la plage interdite."
        return None

    if rtype == "expected_online":
        if not _in_window(now, rule):
            return None
        if not monitor:
            return None
        if monitor.get("status") == "online":
            return None
        # Window start. Handles midnight-wrap (start_hour > end_hour).
        start_h = int(rule.get("start_hour", 0))
        end_h = int(rule.get("end_hour", 24))
        window_start = now.replace(hour=start_h, minute=0, second=0, microsecond=0)
        if start_h > end_h and now.hour < end_h:
            # We are in the early-morning tail of a window that started yesterday.
            window_start -= timedelta(days=1)
        # Find when the contact was last online
        last_online = await _last_online_event_ts(rule.get("phone", ""))
        ref = window_start
        if last_online and last_online > ref:
            ref = last_online
        offline_minutes = (now - ref).total_seconds() / 60
        if offline_minutes >= int(rule.get("grace_minutes", 30)):
            return f"{pretty} est OFFLINE depuis {int(offline_minutes)}min (attendu online)."
        return None

    if rtype == "inactivity":
        last_online = await _last_online_event_ts(phone)
        if last_online is None:
            # Never seen online — use monitor.added_at as reference
            added = (monitor or {}).get("added_at")
            if isinstance(added, str):
                added = datetime.fromisoformat(added)
            if not added:
                return None
            last_online = added
        hours_silent = (now - last_online).total_seconds() / 3600
        if hours_silent >= int(rule.get("max_silence_hours", 24)):
            return f"{pretty} sans activité depuis {int(hours_silent)}h."
        return None

    return None


async def _trigger_alert(rule: dict, message: str, now: datetime) -> None:
    ev_id = str(uuid.uuid4())
    detail = f"[{rule.get('name', 'alert')}] {message}"
    ev_doc = {
        "id": ev_id,
        "phone": rule.get("phone", ""),
        "event_type": "alert",
        "timestamp": iso(now),
        "detail": detail,
    }
    await db.events.insert_one(ev_doc.copy())
    await db.alert_rules.update_one(
        {"id": rule["id"]}, {"$set": {"last_triggered_at": iso(now)}}
    )
    await ws_manager.broadcast(
        {
            "type": "alert",
            "id": ev_id,
            "phone": rule.get("phone", ""),
            "message": message,
            "rule_name": rule.get("name", "alert"),
            "timestamp": iso(now),
        }
    )
    # Email if configured
    settings = await get_settings()
    if settings.email_enabled and settings.email_recipient and RESEND_API_KEY:
        try:
            html = f"""
            <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;background:#09090b;color:#fafafa;padding:24px">
              <tr><td>
                <h2 style="margin:0 0 8px 0;color:#ef4444">Alert · {rule.get('name', 'rule')}</h2>
                <p style="margin:0 0 16px 0;color:#a1a1aa">{message}</p>
                <table cellpadding="6" style="border:1px solid #27272a;border-radius:4px;font-family:monospace;font-size:13px">
                  <tr><td style="color:#71717a">RULE</td><td style="color:#fafafa">{rule.get('name', '')}</td></tr>
                  <tr><td style="color:#71717a">PHONE</td><td style="color:#fafafa">+{rule.get('phone', '')}</td></tr>
                  <tr><td style="color:#71717a">TYPE</td><td style="color:#fafafa">{rule.get('type', '')}</td></tr>
                  <tr><td style="color:#71717a">TIMESTAMP</td><td style="color:#fafafa">{iso(now)}</td></tr>
                </table>
              </td></tr>
            </table>
            """
            await asyncio.to_thread(
                resend.Emails.send,
                {
                    "from": SENDER_EMAIL,
                    "to": [settings.email_recipient],
                    "subject": f"[WA Monitor · ALERT] {rule.get('name', '')}",
                    "html": html,
                },
            )
        except Exception as e:
            logger.error(f"alert email failed: {e}")


async def alert_evaluator_loop() -> None:
    """Every 60s: evaluate every enabled alert rule, trigger if needed."""
    while True:
        try:
            await asyncio.sleep(60)
            now = now_utc()
            rules = await db.alert_rules.find({"enabled": True}, {"_id": 0}).to_list(500)
            if not rules:
                continue
            # Pre-load monitors keyed by phone
            monitors = await db.monitors.find({}, {"_id": 0}).to_list(500)
            monitors_by_phone = {m["phone"]: m for m in monitors}
            for rule in rules:
                try:
                    monitor = monitors_by_phone.get(rule.get("phone", ""))
                    msg = await _evaluate_rule(rule, monitor, now)
                    if msg:
                        await _trigger_alert(rule, msg, now)
                except Exception as e:
                    logger.error(f"rule {rule.get('id')} eval error: {e}")
        except Exception as e:
            logger.error(f"alert_evaluator_loop error: {e}")
            await asyncio.sleep(60)


# ---- Routes -----------------------------------------------------------------
@api_router.get("/")
async def root():
    return {"service": "wa-monitor", "ok": True}


@api_router.get("/whatsapp/status")
async def whatsapp_status():
    try:
        r = await wa_request("GET", "/status")
        return r.json()
    except Exception as e:
        return {"state": "unreachable", "error": str(e)}


@api_router.get("/whatsapp/qr")
async def whatsapp_qr():
    try:
        r = await wa_request("GET", "/qr")
        return r.json()
    except Exception as e:
        return {"state": "unreachable", "qr": None, "code": None, "error": str(e)}


@api_router.post("/whatsapp/pairing-code")
async def whatsapp_pairing_code(payload: PairingCodeRequest):
    phone = "".join(ch for ch in payload.phone if ch.isdigit())
    if not phone or len(phone) < 7:
        raise HTTPException(status_code=400, detail="invalid phone")
    try:
        r = await wa_request("POST", "/pairing-code", json={"phone": phone})
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"whatsapp service unreachable: {e}")
    if r.status_code >= 400:
        try:
            data = r.json()
        except Exception:
            data = {"error": r.text}
        raise HTTPException(status_code=r.status_code, detail=data.get("error", r.text))
    return r.json()


@api_router.post("/whatsapp/pairing-mode")
async def whatsapp_pairing_mode(mode: str):
    try:
        r = await wa_request("POST", "/pairing-mode", json={"mode": mode})
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@api_router.post("/whatsapp/logout")
async def whatsapp_logout():
    try:
        r = await wa_request("POST", "/logout")
        await db.monitors.delete_many({})
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@api_router.post("/whatsapp/reset")
async def whatsapp_reset():
    """Hard reset: wipe local WhatsApp session + monitors and force re-pairing.
    Useful to recover from rate-limit / stuck QR loops."""
    try:
        r = await wa_request("POST", "/reset")
        await db.monitors.delete_many({})
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@api_router.get("/monitors", response_model=List[Monitor])
async def list_monitors():
    docs = await db.monitors.find({}, {"_id": 0}).sort("added_at", -1).to_list(500)
    out: List[Monitor] = []
    for d in docs:
        if isinstance(d.get("added_at"), str):
            d["added_at"] = datetime.fromisoformat(d["added_at"])
        if isinstance(d.get("last_seen"), str):
            d["last_seen"] = datetime.fromisoformat(d["last_seen"])
        out.append(Monitor(**d))
    return out


@api_router.post("/monitors", response_model=Monitor)
async def add_monitor(payload: MonitorCreate):
    phone = "".join(ch for ch in payload.phone if ch.isdigit())
    if not phone or len(phone) < 7:
        raise HTTPException(status_code=400, detail="invalid phone")
    try:
        r = await wa_request("POST", "/monitors", json={"phone": phone})
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"whatsapp service unreachable: {e}")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="number not on whatsapp")
    if r.status_code == 409:
        raise HTTPException(status_code=409, detail="whatsapp client not ready")
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=r.text)

    existing = await db.monitors.find_one({"phone": phone}, {"_id": 0})
    if existing:
        if isinstance(existing.get("added_at"), str):
            existing["added_at"] = datetime.fromisoformat(existing["added_at"])
        if isinstance(existing.get("last_seen"), str):
            existing["last_seen"] = datetime.fromisoformat(existing["last_seen"])
        return Monitor(**existing)

    monitor = Monitor(
        phone=phone,
        label=payload.label or None,
        added_at=now_utc(),
        status="unknown",
        last_seen=None,
    )
    doc = monitor.model_dump()
    doc["added_at"] = iso(doc["added_at"])
    doc["last_seen"] = None
    await db.monitors.insert_one(doc)
    await ws_manager.broadcast({"type": "monitor_added", "monitor": doc})
    return monitor


@api_router.patch("/monitors/{phone}", response_model=Monitor)
async def patch_monitor(phone: str, payload: MonitorPatch):
    phone = "".join(ch for ch in phone if ch.isdigit())
    update: dict = {}
    if payload.label is not None:
        update["label"] = payload.label.strip() or None
    if not update:
        raise HTTPException(status_code=400, detail="no fields to update")
    res = await db.monitors.update_one({"phone": phone}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="monitor not found")
    doc = await db.monitors.find_one({"phone": phone}, {"_id": 0})
    if isinstance(doc.get("added_at"), str):
        doc["added_at"] = datetime.fromisoformat(doc["added_at"])
    if isinstance(doc.get("last_seen"), str):
        doc["last_seen"] = datetime.fromisoformat(doc["last_seen"])
    await ws_manager.broadcast({"type": "monitor_updated", "monitor": {**doc, "added_at": iso(doc["added_at"]) if doc.get("added_at") else None}})
    return Monitor(**doc)


@api_router.delete("/monitors/{phone}")
async def remove_monitor(phone: str):
    phone = "".join(ch for ch in phone if ch.isdigit())
    try:
        await wa_request("DELETE", f"/monitors/{phone}")
    except Exception:
        pass
    await db.monitors.delete_one({"phone": phone})
    await ws_manager.broadcast({"type": "monitor_removed", "phone": phone})
    return {"ok": True}


@api_router.get("/events", response_model=List[EventLog])
async def list_events(
    limit: int = 200,
    phone: Optional[str] = None,
    event_type: Optional[str] = None,
):
    query: dict = {}
    if phone:
        query["phone"] = "".join(ch for ch in phone if ch.isdigit())
    if event_type:
        query["event_type"] = event_type
    docs = await db.events.find(query, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    out: List[EventLog] = []
    for d in docs:
        if isinstance(d.get("timestamp"), str):
            d["timestamp"] = datetime.fromisoformat(d["timestamp"])
        out.append(EventLog(**d))
    return out


@api_router.get("/events/export.csv")
async def export_events_csv(
    phone: Optional[str] = None,
    event_type: Optional[str] = None,
):
    query: dict = {}
    if phone:
        query["phone"] = "".join(ch for ch in phone if ch.isdigit())
    if event_type:
        query["event_type"] = event_type
    docs = await db.events.find(query, {"_id": 0}).sort("timestamp", -1).to_list(10000)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["timestamp", "phone", "event_type", "detail", "id"])
    for d in docs:
        writer.writerow(
            [
                d.get("timestamp", ""),
                d.get("phone", ""),
                d.get("event_type", ""),
                d.get("detail") or "",
                d.get("id", ""),
            ]
        )
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="wa-monitor-logs.csv"'},
    )


@api_router.delete("/events")
async def clear_events():
    await db.events.delete_many({})
    return {"ok": True}


@api_router.get("/settings", response_model=Settings)
async def read_settings():
    return await get_settings()


@api_router.put("/settings", response_model=Settings)
async def update_settings(payload: SettingsUpdate):
    if payload.email_enabled and not payload.email_recipient:
        raise HTTPException(
            status_code=400,
            detail="email_recipient is required when email_enabled is true",
        )
    hour = max(0, min(23, int(payload.daily_summary_hour)))
    doc = {
        "_id": "global",
        "email_enabled": payload.email_enabled,
        "email_recipient": payload.email_recipient,
        "daily_summary_enabled": payload.daily_summary_enabled,
        "daily_summary_hour": hour,
    }
    await db.settings.replace_one({"_id": "global"}, doc, upsert=True)
    return Settings(**{k: v for k, v in doc.items() if k != "_id"})


@api_router.post("/settings/send-summary-now")
async def send_summary_now():
    ok = await send_daily_summary_email()
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="summary not sent (check daily_summary_enabled, email_recipient, RESEND key, and that there is data to report)",
        )
    return {"ok": True}


# ---- Alert rules ------------------------------------------------------------
ALERT_TYPES = {"forbidden_online", "expected_online", "inactivity"}


@api_router.get("/alert-rules", response_model=List[AlertRule])
async def list_alert_rules():
    docs = await db.alert_rules.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    out: List[AlertRule] = []
    for d in docs:
        if isinstance(d.get("created_at"), str):
            d["created_at"] = datetime.fromisoformat(d["created_at"])
        if isinstance(d.get("last_triggered_at"), str):
            d["last_triggered_at"] = datetime.fromisoformat(d["last_triggered_at"])
        out.append(AlertRule(**d))
    return out


@api_router.post("/alert-rules", response_model=AlertRule)
async def create_alert_rule(payload: AlertRuleCreate):
    if payload.type not in ALERT_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(ALERT_TYPES)}")
    phone = "".join(ch for ch in payload.phone if ch.isdigit())
    if not phone or len(phone) < 7:
        raise HTTPException(status_code=400, detail="invalid phone")
    days = payload.days_of_week if payload.days_of_week is not None else [0, 1, 2, 3, 4, 5, 6]
    days = sorted({int(d) for d in days if 0 <= int(d) <= 6})
    rule = AlertRule(
        id=str(uuid.uuid4()),
        phone=phone,
        name=payload.name.strip() or f"Alert {phone}",
        type=payload.type,
        enabled=payload.enabled,
        days_of_week=days,
        start_hour=max(0, min(23, payload.start_hour)),
        end_hour=max(0, min(24, payload.end_hour)),
        grace_minutes=max(1, payload.grace_minutes),
        max_silence_hours=max(1, payload.max_silence_hours),
        last_triggered_at=None,
        created_at=now_utc(),
    )
    doc = rule.model_dump()
    doc["created_at"] = iso(doc["created_at"])
    doc["last_triggered_at"] = None
    await db.alert_rules.insert_one(doc)
    await ws_manager.broadcast({"type": "alert_rule_added"})
    return rule


@api_router.patch("/alert-rules/{rule_id}", response_model=AlertRule)
async def patch_alert_rule(rule_id: str, payload: AlertRulePatch):
    update: dict = {}
    if payload.name is not None:
        if not payload.name.strip():
            raise HTTPException(status_code=400, detail="name cannot be empty")
        update["name"] = payload.name.strip()
    if payload.enabled is not None:
        update["enabled"] = payload.enabled
    if payload.start_hour is not None:
        update["start_hour"] = max(0, min(23, int(payload.start_hour)))
    if payload.end_hour is not None:
        update["end_hour"] = max(0, min(24, int(payload.end_hour)))
    if payload.grace_minutes is not None:
        update["grace_minutes"] = max(1, int(payload.grace_minutes))
    if payload.max_silence_hours is not None:
        update["max_silence_hours"] = max(1, int(payload.max_silence_hours))
    if payload.days_of_week is not None:
        update["days_of_week"] = sorted({int(d) for d in payload.days_of_week if 0 <= int(d) <= 6})
    if not update:
        raise HTTPException(status_code=400, detail="no fields to update")
    res = await db.alert_rules.update_one({"id": rule_id}, {"$set": update})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="rule not found")
    doc = await db.alert_rules.find_one({"id": rule_id}, {"_id": 0})
    if isinstance(doc.get("created_at"), str):
        doc["created_at"] = datetime.fromisoformat(doc["created_at"])
    if isinstance(doc.get("last_triggered_at"), str):
        doc["last_triggered_at"] = datetime.fromisoformat(doc["last_triggered_at"])
    await ws_manager.broadcast({"type": "alert_rule_updated"})
    return AlertRule(**doc)


@api_router.delete("/alert-rules/{rule_id}")
async def delete_alert_rule(rule_id: str):
    res = await db.alert_rules.delete_one({"id": rule_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="rule not found")
    await ws_manager.broadcast({"type": "alert_rule_removed", "id": rule_id})
    return {"ok": True}


# ---- Internal webhook auth --------------------------------------------------
def verify_internal_secret(x_internal_secret: Optional[str]) -> None:
    if not INTERNAL_API_SECRET:
        return  # disabled — no secret configured
    if x_internal_secret != INTERNAL_API_SECRET:
        raise HTTPException(status_code=401, detail="invalid internal secret")


# ---- Internal webhook from Node service -------------------------------------
@api_router.post("/internal/event")
async def internal_event(
    payload: InternalEvent,
    x_internal_secret: Optional[str] = Header(default=None, alias="X-Internal-Secret"),
):
    verify_internal_secret(x_internal_secret)
    if payload.type == "client_state":
        ev_id = str(uuid.uuid4())
        ts = now_utc()
        doc = {
            "id": ev_id,
            "phone": "",
            "event_type": "client_state",
            "timestamp": iso(ts),
            "detail": payload.state or "",
        }
        await db.events.insert_one(doc.copy())
        await ws_manager.broadcast({"type": "client_state", "state": payload.state})
        return {"ok": True}

    if payload.type == "presence" and payload.phone and payload.status:
        ts = (
            datetime.fromisoformat(payload.timestamp)
            if payload.timestamp
            else now_utc()
        )
        ev_id = str(uuid.uuid4())
        ev_doc = {
            "id": ev_id,
            "phone": payload.phone,
            "event_type": payload.status,  # online | offline
            "timestamp": iso(ts),
            "detail": None,
        }
        await db.events.insert_one(ev_doc.copy())
        await db.monitors.update_one(
            {"phone": payload.phone},
            {"$set": {"status": payload.status, "last_seen": iso(ts)}},
        )
        await ws_manager.broadcast(
            {
                "type": "presence",
                "phone": payload.phone,
                "status": payload.status,
                "timestamp": iso(ts),
                "id": ev_id,
            }
        )
        # Fire-and-forget email
        asyncio.create_task(send_alert_email(payload.phone, payload.status, ts))
        return {"ok": True}

    return {"ok": True, "ignored": True}


# ---- WebSocket --------------------------------------------------------------
@app.websocket("/api/ws")
async def ws_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        # Send hello
        await websocket.send_json({"type": "hello", "ts": iso(now_utc())})
        while True:
            # Heartbeat / keepalive — accept and ignore client messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)
    except Exception:
        await ws_manager.disconnect(websocket)


# ---- Mount & middleware -----------------------------------------------------
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    mongo_client.close()


@app.on_event("startup")
async def _on_startup():
    asyncio.create_task(daily_summary_loop())
    asyncio.create_task(alert_evaluator_loop())
