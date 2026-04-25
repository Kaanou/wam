/**
 * WhatsApp presence monitoring service.
 * Uses whatsapp-web.js (unofficial). Exposes a small HTTP API consumed
 * only by the FastAPI backend on localhost. Pushes presence events to
 * the backend via HTTP webhook.
 */
const express = require("express");
const QRCode = require("qrcode");
const axios = require("axios");
const { Client, LocalAuth } = require("whatsapp-web.js");
const path = require("path");

const PORT = parseInt(process.env.WA_SERVICE_PORT || "3001", 10);
const BACKEND_WEBHOOK =
  process.env.BACKEND_WEBHOOK_URL || "http://localhost:8001/api/internal/event";
const POLL_INTERVAL_MS = parseInt(process.env.PRESENCE_POLL_MS || "12000", 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "";

const app = express();
app.use(express.json());

// Pairing-by-code state
let pendingPairingPhone = null; // user-provided phone awaiting code
let lastPairingCode = null; // last code returned by whatsapp-web.js
let pairingMode = "qr"; // "qr" | "code"

// ---- WhatsApp client state ---------------------------------------------------
let clientState = "initializing"; // initializing | qr | authenticated | ready | disconnected | auth_failure
let lastQr = null; // raw QR string
let lastQrDataUrl = null; // base64 PNG data URL
let meInfo = null; // info about the paired account

// monitored numbers: { phone: { jid, status: "online"|"offline"|"unknown", lastSeen: ISO|null } }
const monitored = new Map();

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "main",
    dataPath: path.join(__dirname, ".wwebjs_auth"),
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/google-chrome",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  },
});

async function postEvent(payload) {
  try {
    const headers = INTERNAL_SECRET
      ? { "x-internal-secret": INTERNAL_SECRET }
      : {};
    await axios.post(BACKEND_WEBHOOK, payload, { timeout: 5000, headers });
  } catch (err) {
    console.error("[wa] webhook post failed:", err.message);
  }
}

client.on("qr", async (qr) => {
  clientState = "qr";
  lastQr = qr;
  try {
    lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  } catch (e) {
    lastQrDataUrl = null;
  }
  console.log("[wa] QR received");
  postEvent({ type: "client_state", state: "qr" });

  // If user requested code pairing, request a fresh pairing code now.
  if (pairingMode === "code" && pendingPairingPhone) {
    try {
      const code = await client.requestPairingCode(pendingPairingPhone);
      lastPairingCode = code || null;
      console.log("[wa] pairing code:", code);
      postEvent({ type: "client_state", state: "qr", code: code });
    } catch (err) {
      console.error("[wa] pairing code failed:", err.message);
      lastPairingCode = null;
    }
  }
});

client.on("authenticated", () => {
  console.log("[wa] authenticated");
  clientState = "authenticated";
  postEvent({ type: "client_state", state: "authenticated" });
});

client.on("auth_failure", (msg) => {
  console.error("[wa] auth_failure:", msg);
  clientState = "auth_failure";
  postEvent({ type: "client_state", state: "auth_failure", message: msg });
});

client.on("ready", async () => {
  console.log("[wa] ready");
  clientState = "ready";
  lastQr = null;
  lastQrDataUrl = null;
  try {
    meInfo = client.info ? { wid: client.info.wid?._serialized, pushname: client.info.pushname } : null;
  } catch {
    meInfo = null;
  }
  postEvent({ type: "client_state", state: "ready", me: meInfo });
});

client.on("disconnected", (reason) => {
  console.warn("[wa] disconnected:", reason);
  clientState = "disconnected";
  postEvent({ type: "client_state", state: "disconnected", reason });
});

// Listen to presence updates pushed by the WhatsApp server.
client.on("presence_update", async (presence) => {
  try {
    const id = presence?.id?._serialized || presence?.id;
    if (!id) return;
    const phone = jidToPhone(id);
    if (!monitored.has(phone)) return;

    // chatstates is an array { state: "available"|"unavailable"|"composing"|... }
    let isOnline = null;
    if (Array.isArray(presence.chatstates)) {
      const me = presence.chatstates.find((c) => c.id?._serialized === id) || presence.chatstates[0];
      if (me) {
        if (me.type === "available" || me.state === "available") isOnline = true;
        else if (me.type === "unavailable" || me.state === "unavailable") isOnline = false;
      }
    }
    if (isOnline === null && presence.isOnline !== undefined) isOnline = !!presence.isOnline;
    if (isOnline === null) return;

    const entry = monitored.get(phone);
    const newStatus = isOnline ? "online" : "offline";
    if (entry.status !== newStatus) {
      entry.status = newStatus;
      entry.lastSeen = new Date().toISOString();
      monitored.set(phone, entry);
      postEvent({
        type: "presence",
        phone,
        status: newStatus,
        timestamp: entry.lastSeen,
      });
    }
  } catch (err) {
    console.error("[wa] presence_update error:", err.message);
  }
});

function phoneToJid(rawPhone) {
  const digits = String(rawPhone).replace(/[^0-9]/g, "");
  return `${digits}@c.us`;
}
function jidToPhone(jid) {
  return String(jid).split("@")[0];
}

// ---- Polling fallback --------------------------------------------------------
async function pollPresenceLoop() {
  while (true) {
    if (clientState === "ready" && monitored.size > 0) {
      for (const [phone, entry] of monitored.entries()) {
        try {
          const chat = await client.getChatById(entry.jid);
          if (!chat) continue;
          // Subscribe / refresh presence — fires presence_update when received.
          if (typeof chat.fetchPresence === "function") {
            await chat.fetchPresence().catch(() => {});
          }
        } catch (err) {
          // ignore — chat may not exist yet
        }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ---- HTTP API ----------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, state: clientState });
});

app.get("/status", (req, res) => {
  res.json({
    state: clientState,
    me: meInfo,
    monitored_count: monitored.size,
  });
});

app.get("/qr", (req, res) => {
  if (clientState === "ready") {
    return res.json({ state: clientState, qr: null, code: null });
  }
  res.json({
    state: clientState,
    qr: pairingMode === "qr" ? lastQrDataUrl : null,
    code: pairingMode === "code" ? lastPairingCode : null,
    mode: pairingMode,
  });
});

// Request pairing-by-code (8-digit) for a given phone number.
// Will reset the WhatsApp client to force a fresh QR/code generation cycle.
app.post("/pairing-code", async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");
  if (!phone || phone.length < 7) {
    return res.status(400).json({ error: "invalid phone" });
  }
  if (clientState === "ready") {
    return res.status(409).json({ error: "already paired" });
  }
  pendingPairingPhone = phone;
  pairingMode = "code";
  lastPairingCode = null;

  // If client is already in QR phase, request the pairing code immediately.
  if (clientState === "qr") {
    try {
      const code = await client.requestPairingCode(phone);
      lastPairingCode = code || null;
      return res.json({ ok: true, code });
    } catch (err) {
      console.error("[wa] pairing code (immediate) failed:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Otherwise, the qr handler will pick it up when ready.
  res.json({ ok: true, code: null, pending: true });
});

// Cancel code pairing — go back to QR mode.
app.post("/pairing-mode", (req, res) => {
  const mode = req.body?.mode === "code" ? "code" : "qr";
  pairingMode = mode;
  if (mode === "qr") {
    pendingPairingPhone = null;
    lastPairingCode = null;
  }
  res.json({ ok: true, mode: pairingMode });
});

app.get("/monitors", (req, res) => {
  const items = [];
  for (const [phone, entry] of monitored.entries()) {
    items.push({ phone, status: entry.status, last_seen: entry.lastSeen });
  }
  res.json({ items });
});

app.post("/monitors", async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");
  if (!phone) return res.status(400).json({ error: "phone required" });
  if (clientState !== "ready") {
    return res.status(409).json({ error: "whatsapp not ready", state: clientState });
  }
  try {
    const numberId = await client.getNumberId(phone);
    if (!numberId) {
      return res.status(404).json({ error: "number not on whatsapp" });
    }
    const jid = numberId._serialized;
    if (!monitored.has(phone)) {
      monitored.set(phone, { jid, status: "unknown", lastSeen: null });
    }
    // Trigger initial presence subscription
    try {
      const chat = await client.getChatById(jid);
      if (chat && typeof chat.fetchPresence === "function") {
        await chat.fetchPresence().catch(() => {});
      }
    } catch {}
    res.json({ ok: true, phone, jid });
  } catch (err) {
    console.error("[wa] add monitor failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/monitors/:phone", (req, res) => {
  const phone = String(req.params.phone).replace(/[^0-9]/g, "");
  monitored.delete(phone);
  res.json({ ok: true });
});

app.post("/logout", async (req, res) => {
  try {
    await client.logout();
  } catch (e) {
    console.error("[wa] logout error:", e.message);
  }
  monitored.clear();
  clientState = "initializing";
  pairingMode = "qr";
  pendingPairingPhone = null;
  lastPairingCode = null;
  res.json({ ok: true });
  // Re-init after logout
  setTimeout(() => {
    client.initialize().catch((e) => console.error("[wa] re-init failed:", e.message));
  }, 1000);
});

// ---- Boot --------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wa] http listening on :${PORT}`);
});

console.log("[wa] initializing whatsapp client...");
client.initialize().catch((err) => {
  console.error("[wa] initialize failed:", err);
});
pollPresenceLoop().catch((err) => console.error("[wa] poll loop error:", err));
