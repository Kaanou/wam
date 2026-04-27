/**
 * WhatsApp presence monitoring service — Baileys edition.
 * Replaces whatsapp-web.js (Puppeteer/Chrome) with @whiskeysockets/baileys
 * which connects directly to WhatsApp's protocol — no browser needed.
 *
 * Exposes the same HTTP API as the previous server so the FastAPI backend
 * requires zero changes.
 */

const express = require("express");
const QRCode = require("qrcode");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");

const PORT = parseInt(process.env.WA_SERVICE_PORT || "3001", 10);
const BACKEND_WEBHOOK =
  process.env.BACKEND_WEBHOOK_URL || "http://localhost:8001/api/internal/event";
const POLL_INTERVAL_MS = parseInt(process.env.PRESENCE_POLL_MS || "12000", 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || "";
const AUTH_DIR = path.join(__dirname, ".baileys_auth");

const app = express();
app.use(express.json());

// ---- Logger (quiet in prod) --------------------------------------------------
const logger = P({ level: "silent" });

// ---- State ------------------------------------------------------------------
let sock = null;
let clientState = "initializing";
let lastQrDataUrl = null;
let lastQrRaw = null;
let meInfo = null;
let pairingMode = "qr"; // "qr" | "code"
let pendingPairingPhone = null;
let lastPairingCode = null;
let pairingCodeError = null;
let reconnectTimer = null;

// monitored numbers: Map<phone, { jid, status, lastSeen }>
const monitored = new Map();

// ---- Webhook ----------------------------------------------------------------
async function postEvent(payload) {
  try {
    const headers = INTERNAL_SECRET
      ? { "x-internal-secret": INTERNAL_SECRET }
      : {};
    await axios.post(BACKEND_WEBHOOK, payload, { timeout: 5000, headers });
  } catch (err) {
    console.error("[wa] webhook failed:", err.message);
  }
}

// ---- Presence polling -------------------------------------------------------
async function pollPresence() {
  if (!sock || clientState !== "ready") return;
  for (const [phone, info] of monitored.entries()) {
    try {
      await sock.sendPresenceUpdate("available");
      await sock.presenceSubscribe(info.jid);
    } catch (e) {
      // ignore
    }
  }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollPresence, POLL_INTERVAL_MS);
}

// ---- Baileys connection -----------------------------------------------------
async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  // ---- QR / pairing code --------------------------------------------------
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      clientState = "qr";
      lastQrRaw = qr;
      try {
        lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
      } catch (e) {
        lastQrDataUrl = null;
      }
      console.log("[wa] QR received");
      postEvent({ type: "client_state", state: "qr" });

      // Auto-request pairing code if mode is "code" and phone is set
      if (pairingMode === "code" && pendingPairingPhone && !sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(pendingPairingPhone);
          lastPairingCode = code?.match(/.{1,4}/g)?.join("-") || code;
          pairingCodeError = null;
          console.log("[wa] Pairing code:", lastPairingCode);
          postEvent({ type: "pairing_code", code: lastPairingCode });
        } catch (e) {
          pairingCodeError = e.message;
          console.error("[wa] Pairing code error:", e.message);
        }
      }
    }

    if (connection === "open") {
      clientState = "ready";
      lastQrDataUrl = null;
      lastQrRaw = null;
      lastPairingCode = null;
      meInfo = {
        pushname: sock.user?.name || "",
        phone: sock.user?.id?.split(":")[0] || "",
      };
      console.log("[wa] Connected as", meInfo.pushname);
      postEvent({ type: "client_state", state: "ready" });
      startPolling();

      // Re-subscribe presence for all monitored numbers
      for (const [, info] of monitored.entries()) {
        try {
          await sock.presenceSubscribe(info.jid);
        } catch (e) { /* ignore */ }
      }
    }

    if (connection === "close") {
      startPolling(); // stop
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log("[wa] Disconnected. Reason:", reason, "Reconnect:", shouldReconnect);

      if (reason === DisconnectReason.loggedOut) {
        clientState = "disconnected";
        meInfo = null;
        postEvent({ type: "client_state", state: "disconnected" });
        // Clear auth
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
      } else if (shouldReconnect) {
        clientState = "initializing";
        postEvent({ type: "client_state", state: "initializing" });
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connectToWhatsApp(), 3000);
      } else {
        clientState = "auth_failure";
        postEvent({ type: "client_state", state: "auth_failure" });
      }
    }
  });

  // ---- Presence updates ---------------------------------------------------
  sock.ev.on("presence.update", ({ id, presences }) => {
    for (const [phone, info] of monitored.entries()) {
      if (info.jid === id || id.startsWith(phone)) {
        const p = presences[id] || presences[Object.keys(presences)[0]];
        if (!p) continue;
        const isOnline = p.lastKnownPresence === "available" || p.lastKnownPresence === "composing";
        const newStatus = isOnline ? "online" : "offline";
        const ts = new Date().toISOString();

        if (info.status !== newStatus) {
          info.status = newStatus;
          info.lastSeen = ts;
          monitored.set(phone, info);
          console.log(`[wa] ${phone} → ${newStatus}`);
          postEvent({
            type: "presence",
            phone,
            status: newStatus,
            timestamp: ts,
            id: `${phone}_${Date.now()}`,
          });
        }

        // last_seen from lastSeen timestamp
        if (p.lastSeen) {
          const lastSeenIso = new Date(p.lastSeen * 1000).toISOString();
          postEvent({ type: "last_seen_update", phone, last_seen_public: lastSeenIso });
        }
      }
    }
  });

  // ---- Credentials save ---------------------------------------------------
  sock.ev.on("creds.update", saveCreds);
}

// ---- HTTP API (same contract as whatsapp-web.js version) --------------------

app.get("/status", (req, res) => {
  res.json({ state: clientState, me: meInfo });
});

app.get("/qr", (req, res) => {
  res.json({
    qr: lastQrDataUrl,
    code: lastPairingCode,
    code_error: pairingCodeError,
    mode: pairingMode,
  });
});

app.post("/pairing-mode", (req, res) => {
  const mode = req.query.mode || req.body?.mode;
  if (mode === "qr" || mode === "code") {
    pairingMode = mode;
    if (mode === "qr") { lastPairingCode = null; pairingCodeError = null; }
  }
  res.json({ mode: pairingMode });
});

app.post("/pairing-code", async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone required" });
  if (clientState !== "qr") {
    return res.status(400).json({ error: "Not in QR state. Wait for QR first." });
  }
  if (sock?.authState?.creds?.registered) {
    return res.status(400).json({ error: "Already registered" });
  }
  pendingPairingPhone = phone;
  pairingMode = "code";
  try {
    const code = await sock.requestPairingCode(phone);
    lastPairingCode = code?.match(/.{1,4}/g)?.join("-") || code;
    pairingCodeError = null;
    res.json({ code: lastPairingCode });
  } catch (e) {
    pairingCodeError = e.message;
    res.status(500).json({ error: e.message });
  }
});

app.post("/monitors", (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone required" });
  const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
  monitored.set(phone, { jid, status: "unknown", lastSeen: null });
  // Subscribe presence immediately
  if (sock && clientState === "ready") {
    sock.presenceSubscribe(jid).catch(() => {});
  }
  res.json({ ok: true });
});

app.delete("/monitors/:phone", (req, res) => {
  monitored.delete(req.params.phone);
  res.json({ ok: true });
});

app.get("/monitors", (req, res) => {
  const list = [];
  for (const [phone, info] of monitored.entries()) {
    list.push({ phone, status: info.status, lastSeen: info.lastSeen });
  }
  res.json(list);
});

app.post("/logout", async (req, res) => {
  try {
    if (sock) await sock.logout();
  } catch (e) { /* ignore */ }
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
  monitored.clear();
  clientState = "initializing";
  meInfo = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectToWhatsApp(), 1000);
  res.json({ ok: true });
});

app.post("/reset-session", async (req, res) => {
  try { if (sock) await sock.logout(); } catch (e) {}
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
  monitored.clear();
  clientState = "initializing";
  meInfo = null;
  lastQrDataUrl = null;
  lastPairingCode = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectToWhatsApp(), 500);
  res.json({ ok: true });
});

app.get("/profile/:phone", async (req, res) => {
  const phone = req.params.phone;
  const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
  try {
    const [pic, info] = await Promise.allSettled([
      sock?.profilePictureUrl(jid, "image"),
      sock?.fetchStatus(jid),
    ]);
    res.json({
      phone,
      picture_url: pic.status === "fulfilled" ? pic.value : null,
      about: info.status === "fulfilled" ? info.value?.status : null,
    });
  } catch (e) {
    res.json({ phone, picture_url: null, about: null });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, state: clientState });
});

// ---- Start ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[wa] Baileys service listening on port ${PORT}`);
  connectToWhatsApp();
});
