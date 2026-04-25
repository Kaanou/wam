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
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import httpx
import resend
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
    added_at: datetime
    status: str = "unknown"  # online | offline | unknown
    last_seen: Optional[datetime] = None


class MonitorCreate(BaseModel):
    phone: str


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


class SettingsUpdate(BaseModel):
    email_enabled: bool
    email_recipient: Optional[EmailStr] = None


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
        return {"state": "unreachable", "qr": None, "error": str(e)}


@api_router.post("/whatsapp/logout")
async def whatsapp_logout():
    try:
        r = await wa_request("POST", "/logout")
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

    monitor = Monitor(phone=phone, added_at=now_utc(), status="unknown", last_seen=None)
    doc = monitor.model_dump()
    doc["added_at"] = iso(doc["added_at"])
    doc["last_seen"] = None
    await db.monitors.insert_one(doc)
    await ws_manager.broadcast({"type": "monitor_added", "monitor": doc})
    return monitor


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
async def list_events(limit: int = 200):
    docs = await db.events.find({}, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    out: List[EventLog] = []
    for d in docs:
        if isinstance(d.get("timestamp"), str):
            d["timestamp"] = datetime.fromisoformat(d["timestamp"])
        out.append(EventLog(**d))
    return out


@api_router.delete("/events")
async def clear_events():
    await db.events.delete_many({})
    return {"ok": True}


@api_router.get("/settings", response_model=Settings)
async def read_settings():
    return await get_settings()


@api_router.put("/settings", response_model=Settings)
async def update_settings(payload: SettingsUpdate):
    doc = {
        "_id": "global",
        "email_enabled": payload.email_enabled,
        "email_recipient": payload.email_recipient,
    }
    await db.settings.replace_one({"_id": "global"}, doc, upsert=True)
    return Settings(email_enabled=payload.email_enabled, email_recipient=payload.email_recipient)


# ---- Internal webhook from Node service -------------------------------------
@api_router.post("/internal/event")
async def internal_event(payload: InternalEvent):
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
