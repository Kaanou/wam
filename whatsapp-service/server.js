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
    lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
  } catch (e) {
    lastQrDataUrl = null;
  }
  console.log("[wa] QR received");
  postEvent({ type: "client_state", state: "qr" });
  // NOTE: do NOT auto-request a pairing code here. WhatsApp rate-limits
  // (and outright blocks) repeated code requests. The user explicitly
  // triggers a fresh code via POST /pairing-code.
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

    // chatstates is an array { state: "available"|"unavailable"|"composing"|"recording"|... }
    let isOnline = null;
    let composingState = null; // "composing" | "recording" | null
    if (Array.isArray(presence.chatstates)) {
      const me =
        presence.chatstates.find((c) => c.id?._serialized === id) ||
        presence.chatstates[0];
      if (me) {
        const s = me.type || me.state;
        if (s === "available") isOnline = true;
        else if (s === "unavailable") isOnline = false;
        else if (s === "composing" || s === "recording") {
          isOnline = true; // typing/recording implies online
          composingState = s;
        }
      }
    }
    if (isOnline === null && presence.isOnline !== undefined) isOnline = !!presence.isOnline;

    const entry = monitored.get(phone);
    const nowIso = new Date().toISOString();

    // Capture last_seen if WhatsApp publishes it.
    if (presence.lastSeen) {
      const lsIso = new Date(presence.lastSeen * 1000).toISOString();
      if (entry.lastSeenPublic !== lsIso) {
        entry.lastSeenPublic = lsIso;
        postEvent({
          type: "last_seen_update",
          phone,
          last_seen_public: lsIso,
          timestamp: nowIso,
        });
      }
    }

    if (composingState && entry.composing !== composingState) {
      entry.composing = composingState;
      postEvent({
        type: "activity",
        phone,
        activity: composingState, // "composing" | "recording"
        timestamp: nowIso,
      });
      // Reset composing state after 8 s of no further updates so the next
      // composing event re-fires.
      clearTimeout(entry.composingTimer);
      entry.composingTimer = setTimeout(() => {
        entry.composing = null;
      }, 8000);
    }

    if (isOnline === null) return;
    const newStatus = isOnline ? "online" : "offline";
    if (entry.status !== newStatus) {
      entry.status = newStatus;
      entry.lastSeen = nowIso;
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
          // Fetch current presence — returns { isOnline, lastSeen, ... } when
          // the contact's privacy allows it. We use this DIRECTLY rather than
          // waiting for the (unreliable) presence_update event.
          let presence = null;
          if (typeof chat.fetchPresence === "function") {
            presence = await chat.fetchPresence().catch((e) => {
              console.warn(`[wa] fetchPresence ${phone}:`, e?.message);
              return null;
            });
          }
          if (!presence) continue;

          const nowIso = new Date().toISOString();

          // Capture lastSeen if WhatsApp publishes it.
          if (typeof presence.lastSeen === "number" && presence.lastSeen > 0) {
            const lsIso = new Date(presence.lastSeen * 1000).toISOString();
            if (entry.lastSeenPublic !== lsIso) {
              entry.lastSeenPublic = lsIso;
              postEvent({
                type: "last_seen_update",
                phone,
                last_seen_public: lsIso,
                timestamp: nowIso,
              });
            }
          }

          // Direct online/offline from presence object
          if (typeof presence.isOnline === "boolean") {
            const newStatus = presence.isOnline ? "online" : "offline";
            if (entry.status !== newStatus) {
              entry.status = newStatus;
              entry.lastSeen = nowIso;
              monitored.set(phone, entry);
              postEvent({
                type: "presence",
                phone,
                status: newStatus,
                timestamp: nowIso,
              });
            }
          }
        } catch (err) {
          console.warn(`[wa] poll ${phone}:`, err?.message);
        }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Diagnostic endpoint: returns the raw fetchPresence result for a phone.
// Helps users diagnose why a monitor is stuck on UNKNOWN.
app.get("/debug-presence/:phone", async (req, res) => {
  const phone = String(req.params.phone).replace(/[^0-9]/g, "");
  if (clientState !== "ready") {
    return res.status(409).json({ error: "whatsapp not ready", state: clientState });
  }
  try {
    const numberId = await client.getNumberId(phone);
    if (!numberId) return res.status(404).json({ error: "number not on whatsapp" });
    const jid = numberId._serialized;
    const chat = await client.getChatById(jid);
    if (!chat) return res.status(404).json({ error: "chat not found" });

    let presence = null;
    let presenceError = null;
    try {
      presence = await chat.fetchPresence();
    } catch (e) {
      presenceError = String(e?.message || e);
    }
    const me = client.info?.wid?._serialized;
    const isSelf = me === jid;
    return res.json({
      phone,
      jid,
      is_self: isSelf,
      paired_as: me,
      presence,
      presence_error: presenceError,
      hint: isSelf
        ? "Vous surveillez votre propre numéro — WhatsApp ne pousse pas la présence vers la même session. Ajoutez un AUTRE numéro."
        : presence == null
        ? "fetchPresence a retourné null — généralement privacy 'Vu à' du contact restreinte à 'Personne' ou 'Mes contacts' (et vous n'êtes pas dans ses contacts)."
        : presence.isOnline === undefined
        ? "WhatsApp a renvoyé un objet sans champ isOnline — privacy partielle probable."
        : "OK, présence reçue.",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---- Profile polling --------------------------------------------------------
// Every PROFILE_POLL_MS, fetch profile pic, name and about for each monitored
// number. Compare with the last known snapshot and emit profile_change events.
const PROFILE_POLL_MS = parseInt(process.env.PROFILE_POLL_MS || "1800000", 10); // 30 min default
const profileSnapshots = new Map(); // phone -> { pic_url, name, about }

async function pollProfilesLoop() {
  // Initial delay so we don't poll immediately at boot.
  await new Promise((r) => setTimeout(r, 60_000));
  while (true) {
    if (clientState === "ready" && monitored.size > 0) {
      for (const [phone, entry] of monitored.entries()) {
        try {
          const contact = await client.getContactById(entry.jid);
          if (!contact) continue;
          let picUrl = null;
          try {
            picUrl = await contact.getProfilePicUrl();
          } catch {
            picUrl = null;
          }
          let about = null;
          try {
            about = await contact.getAbout();
          } catch {
            about = null;
          }
          const name = contact.pushname || contact.name || null;

          const prev = profileSnapshots.get(phone) || {};
          const changes = {};
          if (prev.pic_url !== picUrl) changes.pic_url = { from: prev.pic_url || null, to: picUrl };
          if (prev.name !== name) changes.name = { from: prev.name || null, to: name };
          if (prev.about !== about) changes.about = { from: prev.about || null, to: about };

          const next = { pic_url: picUrl, name, about };
          profileSnapshots.set(phone, next);

          // First snapshot — initial baseline, don't emit events.
          if (!prev.captured_at) {
            postEvent({
              type: "profile_snapshot",
              phone,
              pic_url: picUrl,
              name,
              about,
              first: true,
              timestamp: new Date().toISOString(),
            });
            next.captured_at = new Date().toISOString();
            continue;
          }
          if (Object.keys(changes).length > 0) {
            postEvent({
              type: "profile_change",
              phone,
              changes,
              pic_url: picUrl,
              name,
              about,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          console.error(`[wa] profile poll ${phone} error:`, err.message);
        }
      }
    }
    await new Promise((r) => setTimeout(r, PROFILE_POLL_MS));
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
    code_error: pairingMode === "code" ? lastPairingCodeError : null,
    mode: pairingMode,
  });
});

// Request pairing-by-code (8-digit) for a given phone number.
// Per-call only — no auto-retry on QR refresh (WhatsApp rate-limits it).
app.post("/pairing-code", async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");
  if (!phone || phone.length < 7) {
    return res.status(400).json({ error: "invalid phone" });
  }
  if (clientState === "ready") {
    return res.status(409).json({ error: "already paired" });
  }
  // Local rate-limit: prevent the user from spamming the button.
  const now = Date.now();
  if (now - lastPairingCodeAt < 30_000) {
    return res.status(429).json({
      error: "Trop de tentatives. Patientez 30 secondes avant de redemander un code.",
    });
  }
  pendingPairingPhone = phone;
  pairingMode = "code";
  lastPairingCode = null;
  lastPairingCodeError = null;

  if (clientState !== "qr") {
    return res.json({ ok: true, code: null, pending: true });
  }
  // Rate-limit attempts (success or failure) to avoid hammering WhatsApp.
  lastPairingCodeAt = Date.now();
  try {
    const code = await client.requestPairingCode(phone);
    lastPairingCode = code || null;
    console.log("[wa] pairing code:", code);
    return res.json({ ok: true, code });
  } catch (err) {
    const msg =
      String(err?.message || "").length > 1
        ? String(err.message)
        : "WhatsApp a refusé la demande (rate-limit probable). Essayez le QR depuis un autre appareil ou réinitialisez la session.";
    lastPairingCodeError = msg;
    console.error("[wa] pairing code (immediate) failed:", err.message);
    return res.status(502).json({ error: msg });
  }
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
  lastPairingCodeError = null;
  res.json({ ok: true });
  // Re-init after logout
  setTimeout(() => {
    client.initialize().catch((e) => console.error("[wa] re-init failed:", e.message));
  }, 1000);
});

// Hard reset — destroys the LocalAuth session on disk and re-inits a fresh client.
// Useful when WhatsApp has rate-limited us into a stuck state.
app.post("/reset", async (req, res) => {
  try {
    try {
      await client.destroy();
    } catch (e) {
      /* ignore */
    }
    monitored.clear();
    clientState = "initializing";
    pairingMode = "qr";
    pendingPairingPhone = null;
    lastPairingCode = null;
    lastPairingCodeError = null;
    lastQr = null;
    lastQrDataUrl = null;
    lastPairingCodeAt = 0;
    // Wipe the auth folder.
    const fs = require("fs");
    const authDir = path.join(__dirname, ".wwebjs_auth");
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
    } catch (e) {
      console.error("[wa] reset rm error:", e.message);
    }
    res.json({ ok: true });
    setTimeout(() => {
      client.initialize().catch((e) => console.error("[wa] reset re-init failed:", e.message));
    }, 800);
  } catch (e) {
    console.error("[wa] reset error:", e.message);
    res.status(500).json({ error: e.message });
  }
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
pollProfilesLoop().catch((err) => console.error("[wa] profile poll loop error:", err));
