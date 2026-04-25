import { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { Toaster, toast } from "sonner";
import {
  Activity,
  CircleDot,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  ScanLine,
  Bell,
} from "lucide-react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// ---------- helpers ----------
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `il y a ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h}h`;
  return fmtTime(iso);
}

function statePillLabel(state) {
  return (
    {
      ready: "CONNECTED",
      qr: "AWAITING QR",
      authenticated: "AUTHENTICATING",
      initializing: "INITIALIZING",
      disconnected: "DISCONNECTED",
      auth_failure: "AUTH FAILED",
      unreachable: "SERVICE DOWN",
    }[state] || (state ? state.toUpperCase() : "UNKNOWN")
  );
}

function stateColor(state) {
  if (state === "ready") return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
  if (state === "qr" || state === "authenticated" || state === "initializing")
    return "text-amber-400 border-amber-500/30 bg-amber-500/10";
  return "text-red-400 border-red-500/30 bg-red-500/10";
}

// ---------- atoms ----------
const Panel = ({ title, icon: Icon, children, right, testid }) => (
  <section
    data-testid={testid}
    className="border border-zinc-800 bg-zinc-950/60 backdrop-blur-sm rounded-sm flex flex-col"
  >
    <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
      <div className="flex items-center gap-2">
        {Icon && <Icon size={14} className="text-zinc-500" strokeWidth={1.75} />}
        <h2 className="text-[11px] font-mono uppercase tracking-[0.22em] text-zinc-500">
          {title}
        </h2>
      </div>
      {right}
    </header>
    <div className="p-4 flex-1">{children}</div>
  </section>
);

const Dot = ({ color = "bg-zinc-500", pulse = false }) => (
  <span
    className={`inline-block h-2 w-2 rounded-full ${color} ${pulse ? "dot-pulse" : ""}`}
  />
);

const StatusPill = ({ status }) => {
  const cfg = {
    online: { color: "bg-emerald-400", text: "text-emerald-300", label: "ONLINE", border: "border-emerald-500/30 bg-emerald-500/5" },
    offline: { color: "bg-zinc-500", text: "text-zinc-400", label: "OFFLINE", border: "border-zinc-700 bg-zinc-900/40" },
    unknown: { color: "bg-amber-400", text: "text-amber-300", label: "UNKNOWN", border: "border-amber-500/30 bg-amber-500/5" },
  }[status] || { color: "bg-zinc-500", text: "text-zinc-400", label: "UNKNOWN", border: "border-zinc-700" };

  return (
    <span
      data-testid={`status-pill-${status}`}
      className={`inline-flex items-center gap-2 px-2 py-1 border rounded-sm font-mono text-[10px] tracking-[0.18em] ${cfg.border} ${cfg.text}`}
    >
      <Dot color={cfg.color} pulse={status === "online"} />
      {cfg.label}
    </span>
  );
};

// ---------- main ----------
export default function App() {
  const [waState, setWaState] = useState({ state: "initializing", me: null });
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [monitors, setMonitors] = useState([]);
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState({ email_enabled: false, email_recipient: "" });
  const [phoneInput, setPhoneInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const wsRef = useRef(null);
  const liveFlashRef = useRef(new Set());

  // browser notification permission
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  const fetchAll = useCallback(async () => {
    try {
      const [s, q, m, e, st] = await Promise.all([
        axios.get(`${API}/whatsapp/status`),
        axios.get(`${API}/whatsapp/qr`),
        axios.get(`${API}/monitors`),
        axios.get(`${API}/events?limit=200`),
        axios.get(`${API}/settings`),
      ]);
      setWaState(s.data);
      setQrDataUrl(q.data?.qr || null);
      setMonitors(m.data || []);
      setEvents(e.data || []);
      setSettings(st.data || {});
      setEmailInput(st.data?.email_recipient || "");
      setEmailEnabled(!!st.data?.email_enabled);
    } catch (err) {
      console.error("fetchAll error:", err);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Periodic refresh of QR + status (Node service may take time to boot)
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const s = await axios.get(`${API}/whatsapp/status`);
        setWaState(s.data);
        if (s.data.state !== "ready") {
          const q = await axios.get(`${API}/whatsapp/qr`);
          setQrDataUrl(q.data?.qr || null);
        } else {
          setQrDataUrl(null);
        }
      } catch {
        /* ignore */
      }
    }, 4000);
    return () => clearInterval(id);
  }, []);

  // WebSocket connection
  useEffect(() => {
    const wsUrl = BACKEND_URL.replace(/^http/, "ws") + "/api/ws";
    let closed = false;
    let reconnectTimer = null;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // keepalive
        ws.send("hi");
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          handleWsEvent(data);
        } catch (e) {
          /* ignore */
        }
      };

      ws.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(connect, 2500);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWsEvent = (data) => {
    if (data.type === "presence") {
      const { phone, status, timestamp, id } = data;
      // Update events list (prepend)
      setEvents((prev) => [
        { id, phone, event_type: status, timestamp, detail: null },
        ...prev,
      ].slice(0, 500));
      liveFlashRef.current.add(id);
      setTimeout(() => liveFlashRef.current.delete(id), 2000);
      // Update monitor row
      setMonitors((prev) =>
        prev.map((m) =>
          m.phone === phone ? { ...m, status, last_seen: timestamp } : m,
        ),
      );
      // Toast + notification
      const verb = status === "online" ? "se connecte" : "se déconnecte";
      toast(`+${phone} ${verb}`, {
        description: fmtTime(timestamp),
      });
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(`+${phone} ${status === "online" ? "🟢 ONLINE" : "⚫ OFFLINE"}`, {
            body: fmtTime(timestamp),
            silent: false,
          });
        } catch {
          /* ignore */
        }
      }
    } else if (data.type === "client_state") {
      setWaState((s) => ({ ...s, state: data.state }));
      if (data.state === "ready") {
        setQrDataUrl(null);
        toast.success("WhatsApp connecté");
      } else if (data.state === "qr") {
        // refetch qr
        axios.get(`${API}/whatsapp/qr`).then((r) => setQrDataUrl(r.data?.qr || null));
      } else if (data.state === "disconnected") {
        toast.error("WhatsApp déconnecté");
      }
    } else if (data.type === "monitor_added" || data.type === "monitor_removed") {
      axios.get(`${API}/monitors`).then((r) => setMonitors(r.data || []));
    }
  };

  const requestNotifPermission = async () => {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setNotifPerm(p);
    if (p === "granted") toast.success("Notifications navigateur activées");
  };

  const addMonitor = async () => {
    const cleaned = phoneInput.replace(/[^0-9]/g, "");
    if (!cleaned || cleaned.length < 7) {
      toast.error("Numéro invalide. Format international, ex : 33612345678");
      return;
    }
    if (waState.state !== "ready") {
      toast.error("WhatsApp n'est pas connecté. Scannez le QR d'abord.");
      return;
    }
    setAdding(true);
    try {
      await axios.post(`${API}/monitors`, { phone: cleaned });
      setPhoneInput("");
      const m = await axios.get(`${API}/monitors`);
      setMonitors(m.data || []);
      toast.success(`Monitoring activé pour +${cleaned}`);
    } catch (err) {
      const detail = err?.response?.data?.detail || "Erreur inconnue";
      toast.error(`Impossible d'ajouter : ${detail}`);
    } finally {
      setAdding(false);
    }
  };

  const removeMonitor = async (phone) => {
    try {
      await axios.delete(`${API}/monitors/${phone}`);
      setMonitors((prev) => prev.filter((m) => m.phone !== phone));
      toast(`+${phone} retiré`);
    } catch {
      toast.error("Erreur lors de la suppression");
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const payload = {
        email_enabled: emailEnabled,
        email_recipient: emailInput || null,
      };
      const r = await axios.put(`${API}/settings`, payload);
      setSettings(r.data);
      toast.success("Paramètres enregistrés");
    } catch (err) {
      const detail = err?.response?.data?.detail || "Erreur";
      toast.error(`Impossible d'enregistrer : ${JSON.stringify(detail)}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const logoutWhatsapp = async () => {
    if (!window.confirm("Déconnecter WhatsApp et supprimer la session ?")) return;
    try {
      await axios.post(`${API}/whatsapp/logout`);
      setMonitors([]);
      toast("Déconnexion WhatsApp...");
    } catch {
      toast.error("Erreur lors de la déconnexion");
    }
  };

  const clearLogs = async () => {
    if (!window.confirm("Effacer tous les logs ?")) return;
    await axios.delete(`${API}/events`);
    setEvents([]);
    toast("Logs effacés");
  };

  // ---------- render ----------
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 grid-bg" data-testid="app-root">
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          style: {
            background: "#09090b",
            border: "1px solid #27272a",
            color: "#fafafa",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "12px",
            borderRadius: "2px",
          },
        }}
      />

      {/* Header */}
      <header
        className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-40"
        data-testid="app-header"
      >
        <div className="max-w-[1600px] mx-auto px-4 md:px-6 lg:px-8 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 border border-zinc-700 rounded-sm flex items-center justify-center bg-zinc-900">
              <Activity size={16} className="text-emerald-400" strokeWidth={2} />
            </div>
            <div>
              <h1 className="font-display text-lg md:text-xl font-semibold text-zinc-50 leading-tight">
                WA Presence Monitor
              </h1>
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500">
                whatsapp · connection observability
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span
              data-testid="wa-state-pill"
              className={`inline-flex items-center gap-2 px-3 py-1.5 border rounded-sm font-mono text-[11px] tracking-[0.18em] ${stateColor(
                waState.state,
              )}`}
            >
              <CircleDot size={12} strokeWidth={2} />
              {statePillLabel(waState.state)}
            </span>
            {waState.me?.pushname && (
              <span className="hidden md:inline text-[11px] font-mono text-zinc-400">
                @{waState.me.pushname}
              </span>
            )}
            <button
              data-testid="refresh-button"
              onClick={fetchAll}
              className="p-2 border border-zinc-800 rounded-sm hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100 transition-colors"
              title="Refresh"
            >
              <RefreshCw size={14} strokeWidth={1.75} />
            </button>
            {waState.state === "ready" && (
              <button
                data-testid="logout-wa-button"
                onClick={logoutWhatsapp}
                className="inline-flex items-center gap-2 px-3 py-1.5 border border-red-500/20 bg-red-500/5 text-red-400 hover:bg-red-500/10 rounded-sm text-[11px] font-mono tracking-[0.18em] uppercase transition-colors"
              >
                <LogOut size={12} strokeWidth={1.75} /> Logout
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="max-w-[1600px] mx-auto px-4 md:px-6 lg:px-8 py-6 space-y-6">
        {/* Top row: QR + Add monitor + Settings */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
          {/* QR or Connected card */}
          <Panel
            title="01 · Pairing"
            icon={ScanLine}
            testid="panel-pairing"
            right={
              <span className="text-[10px] font-mono text-zinc-600">
                {waState.state === "ready" ? "session active" : "scan required"}
              </span>
            }
          >
            {waState.state === "ready" ? (
              <div className="flex flex-col items-start gap-3 py-4">
                <div className="flex items-center gap-2">
                  <Wifi size={20} className="text-emerald-400" strokeWidth={1.75} />
                  <span className="font-display text-xl text-zinc-50">Session active</span>
                </div>
                <p className="text-sm text-zinc-400 max-w-md">
                  Le client WhatsApp est connecté
                  {waState.me?.pushname ? ` en tant que ${waState.me.pushname}` : ""}.
                  Vous pouvez désormais ajouter des numéros à surveiller.
                </p>
                <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600">
                  {monitors.length} numéro{monitors.length > 1 ? "s" : ""} surveillé
                  {monitors.length > 1 ? "s" : ""}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3" data-testid="qr-container">
                {qrDataUrl ? (
                  <div className="border border-zinc-800 p-3 bg-white rounded-sm">
                    <img
                      src={qrDataUrl}
                      alt="WhatsApp pairing QR code"
                      className="block w-[240px] h-[240px]"
                    />
                  </div>
                ) : (
                  <div className="w-[240px] h-[240px] border border-dashed border-zinc-800 flex flex-col items-center justify-center text-zinc-600 gap-2">
                    <ScanLine size={32} strokeWidth={1.5} />
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em]">
                      {waState.state === "unreachable"
                        ? "Service unreachable"
                        : "Generating QR..."}
                    </span>
                  </div>
                )}
                <p className="text-xs text-zinc-400 text-center font-mono leading-relaxed max-w-xs">
                  Ouvrez WhatsApp → Paramètres → Appareils liés → Scanner ce code.
                </p>
              </div>
            )}
          </Panel>

          {/* Add monitor */}
          <Panel title="02 · Add Monitor" icon={Plus} testid="panel-add-monitor">
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-2">
                  Numéro · format international
                </label>
                <div className="flex items-stretch gap-2">
                  <div className="flex items-center px-3 border border-zinc-800 bg-zinc-950 text-zinc-400 font-mono text-sm rounded-sm">
                    +
                  </div>
                  <input
                    data-testid="phone-input"
                    type="tel"
                    inputMode="numeric"
                    placeholder="33612345678"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addMonitor()}
                    className="flex-1 bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 placeholder:text-zinc-600 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white transition-colors rounded-sm"
                  />
                </div>
                <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed">
                  Pas de "+", pas d'espaces. Ex : 33 6 12 34 56 78 →{" "}
                  <span className="font-mono text-zinc-400">33612345678</span>
                </p>
              </div>
              <button
                data-testid="add-monitor-button"
                onClick={addMonitor}
                disabled={adding || waState.state !== "ready"}
                className="w-full bg-white text-zinc-950 hover:bg-zinc-200 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed py-2.5 rounded-sm font-medium text-sm transition-colors inline-flex items-center justify-center gap-2"
              >
                <Plus size={14} strokeWidth={2} />
                {adding ? "Ajout..." : "Surveiller ce numéro"}
              </button>
              {waState.state !== "ready" && (
                <p className="text-[11px] font-mono text-amber-400/80">
                  ▲ Scannez d'abord le QR pour activer le client.
                </p>
              )}
            </div>
          </Panel>

          {/* Settings */}
          <Panel title="03 · Notifications" icon={Bell} testid="panel-settings">
            <div className="space-y-4">
              <div className="flex items-center justify-between border border-zinc-800 rounded-sm p-3">
                <div>
                  <div className="text-sm text-zinc-200">Notifications navigateur</div>
                  <div className="text-[11px] font-mono text-zinc-500 mt-0.5">
                    {notifPerm === "granted"
                      ? "GRANTED"
                      : notifPerm === "denied"
                      ? "DENIED"
                      : "NOT REQUESTED"}
                  </div>
                </div>
                <button
                  data-testid="enable-notifs-button"
                  onClick={requestNotifPermission}
                  disabled={notifPerm === "granted" || notifPerm === "unsupported"}
                  className="px-3 py-1.5 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed rounded-sm font-mono text-[11px] uppercase tracking-[0.18em] transition-colors"
                >
                  {notifPerm === "granted" ? "ON" : "Activer"}
                </button>
              </div>

              <div className="border border-zinc-800 rounded-sm p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Mail size={14} className="text-zinc-400" strokeWidth={1.75} />
                    <span className="text-sm text-zinc-200">Notifications email</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      data-testid="email-enabled-toggle"
                      type="checkbox"
                      checked={emailEnabled}
                      onChange={(e) => setEmailEnabled(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-zinc-800 rounded-full peer peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:h-4 after:w-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4"></div>
                  </label>
                </div>
                <input
                  data-testid="email-input"
                  type="email"
                  placeholder="vous@exemple.com"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  disabled={!emailEnabled}
                  className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 placeholder:text-zinc-600 font-mono disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
                />
                <button
                  data-testid="save-settings-button"
                  onClick={saveSettings}
                  disabled={savingSettings}
                  className="w-full bg-transparent border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white py-2 rounded-sm font-mono text-[11px] uppercase tracking-[0.18em] transition-colors"
                >
                  {savingSettings ? "Enregistrement..." : "Enregistrer"}
                </button>
                <p className="text-[10px] font-mono text-zinc-600 leading-relaxed">
                  ⓘ Resend en mode test n'envoie qu'à l'adresse vérifiée du compte.
                </p>
              </div>
            </div>
          </Panel>
        </div>

        {/* Monitors list */}
        <Panel
          title="Monitors"
          icon={CircleDot}
          testid="panel-monitors"
          right={
            <span className="text-[10px] font-mono text-zinc-600">
              {monitors.length} active
            </span>
          }
        >
          {monitors.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-2 text-zinc-600">
              <WifiOff size={28} strokeWidth={1.25} />
              <p className="text-sm font-mono">Aucun numéro surveillé.</p>
              <p className="text-[11px] font-mono text-zinc-700">
                Ajoutez un numéro ci-dessus pour commencer.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800" data-testid="monitors-list">
              {monitors.map((m) => (
                <li
                  key={m.phone}
                  data-testid={`monitor-row-${m.phone}`}
                  className="flex items-center justify-between py-3 gap-4 hover:bg-zinc-900/40 -mx-4 px-4 transition-colors"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <StatusPill status={m.status || "unknown"} />
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-zinc-100 truncate">
                        +{m.phone}
                      </div>
                      <div className="text-[11px] font-mono text-zinc-500 truncate">
                        {m.last_seen
                          ? `last change · ${fmtRelative(m.last_seen)}`
                          : "no presence event yet"}
                      </div>
                    </div>
                  </div>
                  <button
                    data-testid={`remove-monitor-${m.phone}`}
                    onClick={() => removeMonitor(m.phone)}
                    className="p-2 border border-zinc-800 hover:border-red-500/30 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 rounded-sm transition-colors"
                    title="Remove"
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Activity feed / Logs */}
        <Panel
          title="Activity Log"
          icon={Activity}
          testid="panel-logs"
          right={
            <button
              data-testid="clear-logs-button"
              onClick={clearLogs}
              className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500 hover:text-red-400 transition-colors"
            >
              clear
            </button>
          }
        >
          {events.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-2 text-zinc-600">
              <p className="text-sm font-mono">Pas encore d'évènement.</p>
              <p className="text-[11px] font-mono text-zinc-700">
                Les connexions et déconnexions s'afficheront ici en temps réel.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-left" data-testid="logs-table">
                <thead>
                  <tr className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-600 border-b border-zinc-800">
                    <th className="py-2 pr-4 font-medium">Timestamp</th>
                    <th className="py-2 pr-4 font-medium">Phone</th>
                    <th className="py-2 pr-4 font-medium">Event</th>
                    <th className="py-2 pr-4 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {events.map((ev) => {
                    const isOnline = ev.event_type === "online";
                    const isOffline = ev.event_type === "offline";
                    const isState = ev.event_type === "client_state";
                    return (
                      <tr
                        key={ev.id}
                        className={`border-b border-zinc-900 hover:bg-zinc-900/40 ${
                          liveFlashRef.current.has(ev.id) ? "row-flash" : ""
                        }`}
                        data-testid={`log-row-${ev.id}`}
                      >
                        <td className="py-2 pr-4 text-zinc-400 whitespace-nowrap">
                          {fmtTime(ev.timestamp)}
                        </td>
                        <td className="py-2 pr-4 text-zinc-200">
                          {ev.phone ? `+${ev.phone}` : "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {isOnline && (
                            <span className="inline-flex items-center gap-1.5 text-emerald-400">
                              <Dot color="bg-emerald-400" /> ONLINE
                            </span>
                          )}
                          {isOffline && (
                            <span className="inline-flex items-center gap-1.5 text-zinc-400">
                              <Dot color="bg-zinc-500" /> OFFLINE
                            </span>
                          )}
                          {isState && (
                            <span className="inline-flex items-center gap-1.5 text-amber-400">
                              <Dot color="bg-amber-400" /> STATE
                            </span>
                          )}
                          {!isOnline && !isOffline && !isState && (
                            <span className="text-zinc-500">{ev.event_type}</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-zinc-500">
                          {ev.detail || (isState ? "client" : "—")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <footer className="text-[10px] font-mono text-zinc-700 uppercase tracking-[0.22em] py-6 border-t border-zinc-900 text-center">
          unofficial · uses whatsapp-web.js · use at your own risk
        </footer>
      </main>
    </div>
  );
}
