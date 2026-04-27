import { useEffect, useRef, useState, useCallback } from "react";
import axios from "axios";
import { Toaster, toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Calendar,
  ChevronDown,
  CircleDot,
  Clock,
  Download,
  Edit3,
  Image as ImageIcon,
  Info,
  KeyRound,
  LogOut,
  Mail,
  Network,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  Shield,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  ScanLine,
  Bell,
  X,
} from "lucide-react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:8001";
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

// ---------- Alert rule helpers ----------
const DAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const ALERT_TYPE_META = {
  forbidden_online: {
    label: "Online interdit",
    desc: "Alerte si le contact est online dans la plage choisie.",
    needsWindow: true,
    needsGrace: false,
  },
  expected_online: {
    label: "Online attendu",
    desc: "Alerte si offline > grace minutes pendant la plage choisie.",
    needsWindow: true,
    needsGrace: true,
  },
  inactivity: {
    label: "Inactivité",
    desc: "Alerte si aucune connexion depuis X heures (24/7).",
    needsWindow: false,
    needsGrace: false,
  },
};

const RuleForm = ({ form, setForm, onToggleDay, monitors, isEditing, saving, onSave, onCancel }) => {
  const meta = ALERT_TYPE_META[form.type] || ALERT_TYPE_META.expected_online;
  return (
    <div
      data-testid="rule-form"
      className="border border-zinc-800 bg-zinc-950/60 rounded-sm p-4 mb-4 space-y-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-[0.22em] text-zinc-300">
          {isEditing ? "Modifier l'alerte" : "Nouvelle alerte"}
        </h3>
        <button
          data-testid="rule-cancel"
          onClick={onCancel}
          className="text-zinc-500 hover:text-zinc-200"
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
            Numéro
          </label>
          <select
            data-testid="rule-phone-select"
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            disabled={isEditing}
            className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 font-mono disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
          >
            <option value="">— choisir —</option>
            {monitors.map((m) => (
              <option key={m.phone} value={m.phone}>
                +{m.phone}
                {m.label ? ` · ${m.label}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
            Nom de l'alerte
          </label>
          <input
            data-testid="rule-name-input"
            type="text"
            placeholder="Ex: Travail 9-18h, Insomnie nuit, Silence 24h…"
            value={form.name}
            maxLength={60}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 placeholder:text-zinc-600 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
          />
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
          Type
        </label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {Object.entries(ALERT_TYPE_META).map(([key, m]) => (
            <button
              key={key}
              data-testid={`rule-type-${key}`}
              onClick={() => setForm((f) => ({ ...f, type: key }))}
              disabled={isEditing}
              className={`text-left p-3 border rounded-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                form.type === key
                  ? "border-white bg-zinc-100/5"
                  : "border-zinc-800 hover:border-zinc-700"
              }`}
            >
              <div className="text-xs font-medium text-zinc-100">{m.label}</div>
              <div className="text-[10px] font-mono text-zinc-500 leading-relaxed mt-1">
                {m.desc}
              </div>
            </button>
          ))}
        </div>
      </div>

      {meta.needsWindow && (
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
              <Calendar size={10} className="inline mr-1" /> Jours de la semaine
            </label>
            <div className="flex flex-wrap gap-1.5" data-testid="rule-days">
              {DAY_LABELS.map((lab, i) => {
                const active = form.days.includes(i);
                return (
                  <button
                    key={i}
                    data-testid={`rule-day-${i}`}
                    onClick={() => onToggleDay(i)}
                    className={`px-2.5 py-1 border rounded-sm font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                      active
                        ? "bg-zinc-100 text-zinc-950 border-zinc-100"
                        : "border-zinc-800 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    {lab}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
                <Clock size={10} className="inline mr-1" /> De (UTC)
              </label>
              <select
                data-testid="rule-start-hour"
                value={form.start_hour}
                onChange={(e) => setForm((f) => ({ ...f, start_hour: Number(e.target.value) }))}
                className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
              >
                {Array.from({ length: 24 }).map((_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
                <Clock size={10} className="inline mr-1" /> À (UTC)
              </label>
              <select
                data-testid="rule-end-hour"
                value={form.end_hour}
                onChange={(e) => setForm((f) => ({ ...f, end_hour: Number(e.target.value) }))}
                className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
              >
                {Array.from({ length: 25 }).map((_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {meta.needsGrace && (
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
            Tolérance offline (minutes)
          </label>
          <input
            data-testid="rule-grace"
            type="number"
            min="1"
            max="720"
            value={form.grace_minutes}
            onChange={(e) =>
              setForm((f) => ({ ...f, grace_minutes: Math.max(1, Number(e.target.value) || 1) }))
            }
            className="w-32 bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
          />
          <p className="text-[10px] font-mono text-zinc-600 mt-1">
            Déclenche si offline ≥ {form.grace_minutes} min consécutives dans la plage.
          </p>
        </div>
      )}

      {form.type === "inactivity" && (
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-1.5">
            Silence maximum (heures)
          </label>
          <input
            data-testid="rule-silence"
            type="number"
            min="1"
            max="720"
            value={form.max_silence_hours}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                max_silence_hours: Math.max(1, Number(e.target.value) || 1),
              }))
            }
            className="w-32 bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
          />
          <p className="text-[10px] font-mono text-zinc-600 mt-1">
            Déclenche si aucun "online" depuis ≥ {form.max_silence_hours} h.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-zinc-800 pt-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            data-testid="rule-enabled-toggle"
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-zinc-800 rounded-full peer peer-checked:bg-emerald-500 transition-colors relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:h-4 after:w-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4"></div>
          <span className="text-xs text-zinc-300 font-mono uppercase tracking-[0.12em]">
            {form.enabled ? "Activée" : "Désactivée"}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 border border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 rounded-sm font-mono text-[11px] uppercase tracking-[0.18em] transition-colors"
          >
            Annuler
          </button>
          <button
            data-testid="rule-save"
            onClick={onSave}
            disabled={saving}
            className="px-4 py-1.5 bg-white text-zinc-950 hover:bg-zinc-200 disabled:bg-zinc-800 disabled:text-zinc-500 rounded-sm font-medium text-xs transition-colors"
          >
            {saving ? "Enregistrement..." : isEditing ? "Mettre à jour" : "Créer l'alerte"}
          </button>
        </div>
      </div>
    </div>
  );
};

const RuleRow = ({ rule, monitor, onToggle, onEdit, onDelete }) => {
  const meta = ALERT_TYPE_META[rule.type] || {};
  const hh = (h) => String(h).padStart(2, "0") + ":00";
  let summary = "";
  if (rule.type === "inactivity") {
    summary = `≥ ${rule.max_silence_hours}h sans activité`;
  } else {
    const days = (rule.days_of_week || []).map((d) => DAY_LABELS[d]).join(" ");
    summary = `${days} · ${hh(rule.start_hour)}–${hh(rule.end_hour)} UTC`;
    if (rule.type === "expected_online") summary += ` · grace ${rule.grace_minutes}min`;
  }
  const phoneDisplay = `+${rule.phone}` + (monitor?.label ? ` · ${monitor.label}` : "");
  return (
    <li
      data-testid={`rule-row-${rule.id}`}
      className="flex items-start justify-between gap-3 py-3 -mx-4 px-4 hover:bg-zinc-900/40 transition-colors"
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div className={`mt-0.5 ${rule.enabled ? "text-emerald-400" : "text-zinc-700"}`}>
          {rule.enabled ? (
            <Shield size={16} strokeWidth={1.75} />
          ) : (
            <Shield size={16} strokeWidth={1.75} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-zinc-100 font-medium">{rule.name}</span>
            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500 px-1.5 py-0.5 border border-zinc-800 rounded-sm">
              {meta.label || rule.type}
            </span>
          </div>
          <div className="text-[11px] font-mono text-zinc-400 mt-1 truncate">
            {phoneDisplay}
          </div>
          <div className="text-[11px] font-mono text-zinc-500 mt-0.5">{summary}</div>
          {rule.last_triggered_at && (
            <div className="text-[10px] font-mono text-red-400/80 mt-0.5 inline-flex items-center gap-1">
              <AlertTriangle size={10} strokeWidth={1.75} />
              dernier déclenchement · {fmtRelative(rule.last_triggered_at)}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <label className="relative inline-flex items-center cursor-pointer mr-1" title="Activer/Désactiver">
          <input
            data-testid={`rule-toggle-${rule.id}`}
            type="checkbox"
            checked={!!rule.enabled}
            onChange={onToggle}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-zinc-800 rounded-full peer peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:h-4 after:w-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4"></div>
        </label>
        <button
          data-testid={`rule-edit-${rule.id}`}
          onClick={onEdit}
          className="p-1.5 border border-zinc-800 hover:border-zinc-600 text-zinc-500 hover:text-zinc-100 rounded-sm transition-colors"
          title="Editer"
        >
          <Edit3 size={13} strokeWidth={1.75} />
        </button>
        <button
          data-testid={`rule-delete-${rule.id}`}
          onClick={onDelete}
          className="p-1.5 border border-zinc-800 hover:border-red-500/30 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 rounded-sm transition-colors"
          title="Supprimer"
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </button>
      </div>
    </li>
  );
};

// ---------- Heatmap & analytics ----------
const HM_COLORS = [
  "bg-zinc-900/40",
  "bg-emerald-900/40",
  "bg-emerald-700/50",
  "bg-emerald-600/60",
  "bg-emerald-500/70",
  "bg-emerald-400/90",
];

const Heatmap = ({ grid }) => {
  if (!grid) return null;
  const max = Math.max(1, ...grid.flat());
  const colorOf = (v) => {
    if (!v) return HM_COLORS[0];
    const ratio = v / max;
    if (ratio < 0.05) return HM_COLORS[1];
    if (ratio < 0.2) return HM_COLORS[2];
    if (ratio < 0.4) return HM_COLORS[3];
    if (ratio < 0.7) return HM_COLORS[4];
    return HM_COLORS[5];
  };
  return (
    <div data-testid="heatmap" className="overflow-x-auto scroll-thin">
      <table className="border-separate border-spacing-[2px]">
        <thead>
          <tr>
            <th></th>
            {Array.from({ length: 24 }).map((_, h) => (
              <th
                key={h}
                className="text-[9px] font-mono text-zinc-600 px-0.5 align-bottom"
              >
                {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAY_LABELS.map((lab, dow) => (
            <tr key={dow}>
              <td className="text-[10px] font-mono text-zinc-500 pr-2">{lab}</td>
              {grid[dow].map((v, h) => (
                <td
                  key={h}
                  title={`${lab} ${String(h).padStart(2, "0")}:00 — ${Math.round(v)} min`}
                  className={`h-5 w-5 rounded-[2px] ${colorOf(v)}`}
                ></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-1 mt-2 text-[9px] font-mono text-zinc-600">
        <span>moins</span>
        {HM_COLORS.map((c, i) => (
          <span key={i} className={`h-3 w-3 rounded-[2px] ${c}`}></span>
        ))}
        <span>plus actif</span>
        <span className="ml-auto">total · {Math.round(grid.flat().reduce((a, b) => a + b, 0))} min</span>
      </div>
    </div>
  );
};

const MonitorDetail = ({ phone, heatmap, anomalies, snapshots, loading }) => {
  if (loading) {
    return (
      <div className="text-[11px] font-mono text-zinc-500 py-4">chargement...</div>
    );
  }
  return (
    <div className="space-y-5 mt-3 pt-3 border-t border-zinc-800">
      <div>
        <h4 className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-2">
          Heatmap d'activité · 28 jours · UTC
        </h4>
        {heatmap?.grid ? (
          <Heatmap grid={heatmap.grid} />
        ) : (
          <div className="text-[11px] font-mono text-zinc-600">pas de données</div>
        )}
      </div>
      <div>
        <h4 className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-2">
          Anomalies aujourd'hui
        </h4>
        {anomalies?.note ? (
          <div className="text-[11px] font-mono text-zinc-600">{anomalies.note}</div>
        ) : anomalies?.anomalies?.length ? (
          <ul className="space-y-1.5">
            {anomalies.anomalies.map((a, i) => (
              <li
                key={i}
                className="text-[11px] font-mono text-zinc-300 flex items-center gap-2"
              >
                <AlertTriangle
                  size={11}
                  strokeWidth={1.75}
                  className={a.kind === "more_active" ? "text-amber-400" : "text-cyan-400"}
                />
                <span>
                  {DAY_LABELS[a.weekday]} {String(a.hour).padStart(2, "0")}h ·{" "}
                  <span className="text-zinc-100">
                    {a.today_minutes} min
                  </span>
                  <span className="text-zinc-500"> vs. baseline {a.baseline_mean_minutes} min</span>
                  <span className={`ml-2 px-1.5 py-0.5 rounded-sm border text-[10px] ${a.kind === "more_active" ? "border-amber-500/30 text-amber-300 bg-amber-500/5" : "border-cyan-500/30 text-cyan-300 bg-cyan-500/5"}`}>
                    {a.kind === "more_active" ? "+ actif" : "− actif"} · z={a.z_score}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[11px] font-mono text-zinc-600">aucune anomalie détectée</div>
        )}
      </div>
      <div>
        <h4 className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-2">
          Timeline du profil
        </h4>
        {snapshots?.length ? (
          <ul className="space-y-2">
            {snapshots.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-3 border border-zinc-800 rounded-sm p-2 bg-zinc-950/40"
              >
                {s.pic_url ? (
                  <img
                    src={s.pic_url}
                    alt="profil"
                    className="w-12 h-12 rounded-sm object-cover border border-zinc-800"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <div className="w-12 h-12 rounded-sm border border-dashed border-zinc-800 flex items-center justify-center text-zinc-700 text-[10px]">
                    no pic
                  </div>
                )}
                <div className="flex-1 min-w-0 text-[11px] font-mono">
                  <div className="text-zinc-300">
                    {s.name || <span className="text-zinc-600 italic">no name</span>}
                  </div>
                  <div className="text-zinc-500 truncate">
                    {s.about || <span className="italic">no about</span>}
                  </div>
                  <div className="text-zinc-600 mt-0.5">
                    {s.first ? "• baseline · " : "• change · "}
                    {fmtTime(s.captured_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[11px] font-mono text-zinc-600">
            aucun snapshot · le polling profil démarre 1 min après l'ajout d'un monitor (puis toutes les 30 min)
          </div>
        )}
      </div>
    </div>
  );
};

// ---------- main ----------
export default function App() {
  const [waState, setWaState] = useState({ state: "initializing", me: null });
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [pairingCode, setPairingCode] = useState(null);
  const [pairingCodeError, setPairingCodeError] = useState(null);
  const [pairingMode, setPairingMode] = useState("qr"); // "qr" | "code"
  const [pairingPhone, setPairingPhone] = useState("");
  const [requestingCode, setRequestingCode] = useState(false);
  const [resettingSession, setResettingSession] = useState(false);
  const [monitors, setMonitors] = useState([]);
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState({});
  const [phoneInput, setPhoneInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [summaryEnabled, setSummaryEnabled] = useState(false);
  const [summaryHour, setSummaryHour] = useState(9);
  const [adding, setAdding] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [sendingSummary, setSendingSummary] = useState(false);
  const [editingLabel, setEditingLabel] = useState(null); // phone of row currently being edited
  const [editingLabelValue, setEditingLabelValue] = useState("");
  // Activity log filters
  const [filterPhone, setFilterPhone] = useState("");
  const [filterEvent, setFilterEvent] = useState(""); // ""|"online"|"offline"|"client_state"|"alert"

  // Alert rules
  const [alertRules, setAlertRules] = useState([]);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState(null);
  const emptyRuleForm = {
    phone: "",
    name: "",
    type: "expected_online",
    days: [0, 1, 2, 3, 4],
    start_hour: 9,
    end_hour: 18,
    grace_minutes: 30,
    max_silence_hours: 24,
    enabled: true,
  };
  const [ruleForm, setRuleForm] = useState(emptyRuleForm);
  const [savingRule, setSavingRule] = useState(false);

  // Monitor expand / detail (heatmap, anomalies, profile timeline)
  const [expandedPhone, setExpandedPhone] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailHeatmap, setDetailHeatmap] = useState(null);
  const [detailAnomalies, setDetailAnomalies] = useState(null);
  const [detailSnapshots, setDetailSnapshots] = useState([]);

  // Correlations
  const [correlations, setCorrelations] = useState([]);
  const [correlationsLoading, setCorrelationsLoading] = useState(false);

  // Backup
  const [restoring, setRestoring] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const fileInputRef = useRef(null);

  const wsRef = useRef(null);
  const liveFlashRef = useRef(new Set());
  const filterPhoneRef = useRef("");
  const filterEventRef = useRef("");
  const fetchAllRef = useRef(null);

  // browser notification permission
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, q, m, e, st, ar] = await Promise.all([
        axios.get(`${API}/whatsapp/status`),
        axios.get(`${API}/whatsapp/qr`),
        axios.get(`${API}/monitors`),
        axios.get(`${API}/events?limit=200`),
        axios.get(`${API}/settings`),
        axios.get(`${API}/alert-rules`),
      ]);
      setWaState(s.data);
      setQrDataUrl(q.data?.qr || null);
      setPairingCode(q.data?.code || null);
      setPairingCodeError(q.data?.code_error || null);
      if (q.data?.mode) setPairingMode(q.data.mode);
      setMonitors(m.data || []);
      setEvents(e.data || []);
      setSettings(st.data || {});
      setAlertRules(ar.data || []);
      setEmailInput(st.data?.email_recipient || "");
      setEmailEnabled(!!st.data?.email_enabled);
      setSummaryEnabled(!!st.data?.daily_summary_enabled);
      setSummaryHour(typeof st.data?.daily_summary_hour === "number" ? st.data.daily_summary_hour : 9);
    } catch (err) {
      console.error("fetchAll error:", err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Sync refs — avoid stale closure in WS handler
  useEffect(() => { filterPhoneRef.current = filterPhone; }, [filterPhone]);
  useEffect(() => { filterEventRef.current = filterEvent; }, [filterEvent]);
  useEffect(() => { fetchAllRef.current = fetchAll; }, [fetchAll]);

  // Periodic refresh of QR + status (Node service may take time to boot)
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const s = await axios.get(`${API}/whatsapp/status`);
        setWaState(s.data);
        if (s.data.state !== "ready") {
          const q = await axios.get(`${API}/whatsapp/qr`);
          setQrDataUrl(q.data?.qr || null);
          setPairingCode(q.data?.code || null);
          setPairingCodeError(q.data?.code_error || null);
          if (q.data?.mode) setPairingMode(q.data.mode);
        } else {
          setQrDataUrl(null);
          setPairingCode(null);
          setPairingCodeError(null);
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
        ws.send("hi");
        const ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 25000);
        ws.addEventListener("close", () => clearInterval(ping));
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
      // Only prepend to local events list if it matches current filter view
      const matchesFilter =
        (!filterPhoneRef.current.trim() || phone.includes(filterPhoneRef.current.replace(/[^0-9]/g, ""))) &&
        (!filterEventRef.current || filterEventRef.current === status);
      if (matchesFilter) {
        setEvents((prev) =>
          [{ id, phone, event_type: status, timestamp, detail: null }, ...prev].slice(0, 500),
        );
        liveFlashRef.current.add(id);
        setTimeout(() => liveFlashRef.current.delete(id), 2000);
      }
      // Always update monitor row
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
        setPairingCode(null);
        toast.success("WhatsApp connecté");
        // Auto-refresh monitors + full state after connection
        if (fetchAllRef.current) fetchAllRef.current();
      } else if (data.state === "qr") {
        // refetch qr
        axios.get(`${API}/whatsapp/qr`).then((r) => {
          setQrDataUrl(r.data?.qr || null);
          setPairingCode(r.data?.code || null);
        });
      } else if (data.state === "disconnected") {
        toast.error("WhatsApp déconnecté");
        if (fetchAllRef.current) fetchAllRef.current();
      }
    } else if (data.type === "activity") {
      // composing | recording — short-lived signal, just toast + log
      const { phone, activity, timestamp, id } = data;
      const matches =
        (!filterPhoneRef.current.trim() || phone.includes(filterPhoneRef.current.replace(/[^0-9]/g, ""))) &&
        (!filterEventRef.current || filterEventRef.current === activity);
      if (matches) {
        setEvents((prev) =>
          [{ id, phone, event_type: activity, timestamp, detail: null }, ...prev].slice(0, 500),
        );
        liveFlashRef.current.add(id);
        setTimeout(() => liveFlashRef.current.delete(id), 2000);
      }
      const verb = activity === "composing" ? "✏ tape un message" : "🎤 enregistre un audio";
      toast(`+${phone} ${verb}`, { description: fmtTime(timestamp) });
    } else if (data.type === "last_seen_update") {
      setMonitors((prev) =>
        prev.map((m) =>
          m.phone === data.phone ? { ...m, last_seen_public: data.last_seen_public } : m,
        ),
      );
    } else if (data.type === "profile_change") {
      const { phone, changes, timestamp, id } = data;
      const fields = Object.keys(changes || {}).join(", ");
      const matches =
        (!filterPhoneRef.current.trim() || phone.includes(filterPhoneRef.current.replace(/[^0-9]/g, ""))) &&
        (!filterEventRef.current || filterEventRef.current === "profile_change");
      if (matches) {
        setEvents((prev) =>
          [
            { id, phone, event_type: "profile_change", timestamp, detail: `profile changed: ${fields}` },
            ...prev,
          ].slice(0, 500),
        );
      }
      toast(`+${phone} a changé son profil`, { description: fields });
    } else if (data.type === "alert") {
      const { phone, message, rule_name, timestamp, id } = data;
      // Refetch rules to pick up updated last_triggered_at
      axios.get(`${API}/alert-rules`).then((r) => setAlertRules(r.data || []));
      // Add to events list if matching filter
      const matches =
        (!filterPhone.trim() || (phone || "").includes(filterPhone.replace(/[^0-9]/g, ""))) &&
        (!filterEvent || filterEvent === "alert");
      if (matches) {
        setEvents((prev) =>
          [
            { id, phone: phone || "", event_type: "alert", timestamp, detail: `[${rule_name}] ${message}` },
            ...prev,
          ].slice(0, 500),
        );
        liveFlashRef.current.add(id);
        setTimeout(() => liveFlashRef.current.delete(id), 2000);
      }
      toast.error(`⚠ ${rule_name}`, { description: message });
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(`⚠ Alert · ${rule_name}`, { body: message });
        } catch {
          /* ignore */
        }
      }
    } else if (data.type === "alert_rule_added" || data.type === "alert_rule_updated" || data.type === "alert_rule_removed") {
      axios.get(`${API}/alert-rules`).then((r) => setAlertRules(r.data || []));
    } else if (data.type === "monitor_added" || data.type === "monitor_removed" || data.type === "monitor_updated") {
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
      await axios.post(`${API}/monitors`, {
        phone: cleaned,
        label: labelInput.trim() || null,
      });
      setPhoneInput("");
      setLabelInput("");
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

  const requestPairingCode = async () => {
    const cleaned = pairingPhone.replace(/[^0-9]/g, "");
    if (!cleaned || cleaned.length < 7) {
      toast.error("Numéro invalide. Format international (sans +), ex : 33612345678");
      return;
    }
    setRequestingCode(true);
    setPairingCodeError(null);
    try {
      const r = await axios.post(`${API}/whatsapp/pairing-code`, { phone: cleaned });
      if (r.data?.code) {
        setPairingCode(r.data.code);
        setPairingMode("code");
        toast.success("Code de pairing généré");
      } else if (r.data?.pending) {
        setPairingMode("code");
        toast("Code en attente, le QR doit d'abord être prêt...");
      }
    } catch (err) {
      const detail =
        err?.response?.data?.detail ||
        err?.message ||
        "Échec inconnu";
      setPairingCodeError(typeof detail === "string" ? detail : JSON.stringify(detail));
      toast.error(typeof detail === "string" ? detail : "Échec");
    } finally {
      setRequestingCode(false);
    }
  };

  const resetWhatsappSession = async () => {
    if (
      !window.confirm(
        "Réinitialiser complètement la session WhatsApp ? Tous les monitors seront supprimés et un nouveau QR sera généré.",
      )
    )
      return;
    setResettingSession(true);
    try {
      await axios.post(`${API}/whatsapp/reset`);
      setMonitors([]);
      setPairingCode(null);
      setPairingCodeError(null);
      setQrDataUrl(null);
      toast.success("Session réinitialisée. Un nouveau QR va apparaître dans quelques secondes...");
    } catch (err) {
      const detail = err?.response?.data?.detail || "Erreur";
      toast.error(`Reset échoué : ${detail}`);
    } finally {
      setResettingSession(false);
    }
  };

  const copyAppUrl = async () => {
    const url = window.location.href.split("?")[0].replace(/\/$/, "");
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Lien copié — ouvrez-le sur un ordinateur ou un autre appareil pour scanner le QR");
    } catch {
      // Fallback: show URL in a prompt
      window.prompt("Copiez ce lien et ouvrez-le sur un autre appareil :", url);
    }
  };

  const switchPairingMode = async (mode) => {
    try {
      await axios.post(`${API}/whatsapp/pairing-mode?mode=${mode}`);
      setPairingMode(mode);
      if (mode === "qr") {
        setPairingCode(null);
      }
    } catch {
      /* ignore */
    }
  };

  const updateLabel = async (phone) => {
    try {
      await axios.patch(`${API}/monitors/${phone}`, { label: editingLabelValue });
      setMonitors((prev) =>
        prev.map((m) => (m.phone === phone ? { ...m, label: editingLabelValue || null } : m)),
      );
      setEditingLabel(null);
      setEditingLabelValue("");
      toast.success("Label mis à jour");
    } catch {
      toast.error("Erreur lors de la mise à jour");
    }
  };

  const startEditLabel = (m) => {
    setEditingLabel(m.phone);
    setEditingLabelValue(m.label || "");
  };

  const exportCsv = () => {
    const params = new URLSearchParams();
    if (filterPhone.trim()) params.set("phone", filterPhone.replace(/[^0-9]/g, ""));
    if (filterEvent) params.set("event_type", filterEvent);
    const url = `${API}/events/export.csv${params.toString() ? "?" + params.toString() : ""}`;
    window.open(url, "_blank");
  };

  const reloadEvents = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (filterPhone.trim()) params.set("phone", filterPhone.replace(/[^0-9]/g, ""));
    if (filterEvent) params.set("event_type", filterEvent);
    try {
      const r = await axios.get(`${API}/events?${params.toString()}`);
      setEvents(r.data || []);
    } catch {
      /* ignore */
    }
  }, [filterPhone, filterEvent]);

  // Refetch events when filters change
  useEffect(() => {
    reloadEvents();
  }, [reloadEvents]);

  const sendSummaryNow = async () => {
    setSendingSummary(true);
    try {
      await axios.post(`${API}/settings/send-summary-now`);
      toast.success("Résumé envoyé");
    } catch (err) {
      const detail = err?.response?.data?.detail || "Erreur";
      toast.error(`Impossible d'envoyer : ${detail}`);
    } finally {
      setSendingSummary(false);
    }
  };

  // ---------- Alert rules ----------
  const openNewRuleForm = () => {
    setRuleForm({
      ...emptyRuleForm,
      phone: monitors[0]?.phone || "",
    });
    setEditingRuleId(null);
    setShowRuleForm(true);
  };

  const openEditRule = (r) => {
    setRuleForm({
      phone: r.phone,
      name: r.name,
      type: r.type,
      days: r.days_of_week || [],
      start_hour: r.start_hour,
      end_hour: r.end_hour,
      grace_minutes: r.grace_minutes,
      max_silence_hours: r.max_silence_hours,
      enabled: r.enabled,
    });
    setEditingRuleId(r.id);
    setShowRuleForm(true);
  };

  const closeRuleForm = () => {
    setShowRuleForm(false);
    setEditingRuleId(null);
    setRuleForm(emptyRuleForm);
  };

  const toggleDay = (d) => {
    setRuleForm((f) => {
      const has = f.days.includes(d);
      return { ...f, days: has ? f.days.filter((x) => x !== d) : [...f.days, d].sort() };
    });
  };

  const saveRule = async () => {
    if (!ruleForm.phone) {
      toast.error("Choisissez un numéro à surveiller.");
      return;
    }
    if (!ruleForm.name.trim()) {
      toast.error("Donnez un nom à l'alerte.");
      return;
    }
    if (ruleForm.type !== "inactivity" && ruleForm.days.length === 0) {
      toast.error("Sélectionnez au moins un jour.");
      return;
    }
    setSavingRule(true);
    try {
      if (editingRuleId) {
        const payload = {
          name: ruleForm.name.trim(),
          enabled: ruleForm.enabled,
          days_of_week: ruleForm.days,
          start_hour: ruleForm.start_hour,
          end_hour: ruleForm.end_hour,
          grace_minutes: ruleForm.grace_minutes,
          max_silence_hours: ruleForm.max_silence_hours,
        };
        await axios.patch(`${API}/alert-rules/${editingRuleId}`, payload);
        toast.success("Alerte mise à jour");
      } else {
        const payload = {
          phone: ruleForm.phone,
          name: ruleForm.name.trim(),
          type: ruleForm.type,
          enabled: ruleForm.enabled,
          days_of_week: ruleForm.days,
          start_hour: ruleForm.start_hour,
          end_hour: ruleForm.end_hour,
          grace_minutes: ruleForm.grace_minutes,
          max_silence_hours: ruleForm.max_silence_hours,
        };
        await axios.post(`${API}/alert-rules`, payload);
        toast.success("Alerte créée");
      }
      const r = await axios.get(`${API}/alert-rules`);
      setAlertRules(r.data || []);
      closeRuleForm();
    } catch (err) {
      const detail = err?.response?.data?.detail || "Erreur";
      toast.error(`Impossible : ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    } finally {
      setSavingRule(false);
    }
  };

  const toggleRuleEnabled = async (rule) => {
    try {
      await axios.patch(`${API}/alert-rules/${rule.id}`, { enabled: !rule.enabled });
      setAlertRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)),
      );
    } catch {
      toast.error("Erreur lors de la mise à jour");
    }
  };

  const deleteRule = async (id) => {
    if (!window.confirm("Supprimer cette alerte ?")) return;
    try {
      await axios.delete(`${API}/alert-rules/${id}`);
      setAlertRules((prev) => prev.filter((r) => r.id !== id));
      toast("Alerte supprimée");
    } catch {
      toast.error("Erreur lors de la suppression");
    }
  };

  // ---------- Monitor detail (heatmap / anomalies / timeline) ----------
  const toggleMonitorDetail = async (phone) => {
    if (expandedPhone === phone) {
      setExpandedPhone(null);
      return;
    }
    setExpandedPhone(phone);
    setDetailLoading(true);
    setDetailHeatmap(null);
    setDetailAnomalies(null);
    setDetailSnapshots([]);
    try {
      const [hm, an, sn] = await Promise.all([
        axios.get(`${API}/analytics/heatmap?phone=${phone}&days=28`),
        axios.get(`${API}/analytics/anomalies?phone=${phone}`),
        axios.get(`${API}/profile-snapshots?phone=${phone}&limit=20`),
      ]);
      setDetailHeatmap(hm.data);
      setDetailAnomalies(an.data);
      setDetailSnapshots(sn.data || []);
    } catch (err) {
      toast.error("Impossible de charger le détail");
    } finally {
      setDetailLoading(false);
    }
  };

  // ---------- Correlations ----------
  const loadCorrelations = useCallback(async () => {
    setCorrelationsLoading(true);
    try {
      const r = await axios.get(`${API}/analytics/correlations?days=14&top=20`);
      setCorrelations(r.data?.pairs || []);
    } catch {
      /* ignore */
    } finally {
      setCorrelationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (monitors.length >= 2) loadCorrelations();
  }, [monitors.length, loadCorrelations]);

  // ---------- Backup / restore ----------
  const exportBackup = async () => {
    try {
      const r = await axios.get(`${API}/backup`);
      const blob = new Blob([JSON.stringify(r.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wa-monitor-backup-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Backup téléchargé");
    } catch {
      toast.error("Erreur lors de l'export");
    }
  };

  const importBackup = async (file) => {
    if (!file) return;
    if (
      !window.confirm(
        "Restaurer ce backup va REMPLACER toutes les données actuelles. Continuer ?",
      )
    )
      return;
    setRestoring(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const r = await axios.post(`${API}/backup/restore?replace=true`, data);
      const restored = r.data?.restored || {};
      toast.success(
        `Restauré · ${restored.monitors || 0} monitors · ${restored.events || 0} events · ${restored.alert_rules || 0} alerts`,
      );
      await fetchAll();
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.message || "Erreur";
      toast.error(`Restauration échouée : ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    } finally {
      setRestoring(false);
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
    if (emailEnabled && !emailInput.trim()) {
      toast.error("Une adresse email est requise pour activer les notifications email.");
      return;
    }
    setSavingSettings(true);
    try {
      const payload = {
        email_enabled: emailEnabled,
        email_recipient: emailInput.trim() || null,
        daily_summary_enabled: summaryEnabled,
        daily_summary_hour: Number(summaryHour) || 9,
      };
      const r = await axios.put(`${API}/settings`, payload);
      setSettings(r.data);
      toast.success("Paramètres enregistrés");
    } catch (err) {
      const detail = err?.response?.data?.detail || "Erreur";
      toast.error(`Impossible d'enregistrer : ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
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

  const reloadEvents = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/events?limit=200`);
      setEvents(res.data || []);
    } catch (err) {
      console.error("reloadEvents:", err);
    }
  }, []);

  const clearLogs = async () => {
    if (!window.confirm("Effacer tous les logs ? Action irréversible.")) return;
    try {
      await axios.delete(`${API}/events`);
      setEvents([]);
      toast("Logs effacés");
    } catch {
      toast.error("Erreur lors de la suppression des logs");
    }
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
              disabled={refreshing}
              className="p-2 border border-zinc-800 rounded-sm hover:bg-zinc-900 text-zinc-400 hover:text-zinc-100 disabled:opacity-50 transition-colors"
              title="Rafraîchir"
            >
              <RefreshCw size={14} strokeWidth={1.75} className={refreshing ? "animate-spin" : ""} />
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
                {waState.state === "ready" ? "session active" : "scan or code"}
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
              <div className="flex flex-col gap-3" data-testid="qr-container">
                {/* Mode tabs */}
                <div className="flex border border-zinc-800 rounded-sm overflow-hidden text-[11px] font-mono uppercase tracking-[0.18em]">
                  <button
                    data-testid="pairing-mode-qr"
                    onClick={() => switchPairingMode("qr")}
                    className={`flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 transition-colors ${
                      pairingMode === "qr"
                        ? "bg-zinc-100 text-zinc-950"
                        : "text-zinc-400 hover:bg-zinc-900"
                    }`}
                  >
                    <QrCode size={12} strokeWidth={1.75} /> QR
                  </button>
                  <button
                    data-testid="pairing-mode-code"
                    onClick={() => switchPairingMode("code")}
                    className={`flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 transition-colors border-l border-zinc-800 ${
                      pairingMode === "code"
                        ? "bg-zinc-100 text-zinc-950"
                        : "text-zinc-400 hover:bg-zinc-900"
                    }`}
                  >
                    <KeyRound size={12} strokeWidth={1.75} /> Code
                  </button>
                </div>

                {pairingMode === "qr" ? (
                  <div className="flex flex-col items-center gap-3">
                    {qrDataUrl ? (
                      <div className="border border-zinc-800 p-3 bg-white rounded-sm">
                        <img
                          src={qrDataUrl}
                          alt="WhatsApp pairing QR code"
                          className="block w-[280px] h-[280px] sm:w-[320px] sm:h-[320px]"
                        />
                      </div>
                    ) : (
                      <div className="w-[280px] h-[280px] sm:w-[320px] sm:h-[320px] border border-dashed border-zinc-800 flex flex-col items-center justify-center text-zinc-600 gap-2">
                        <ScanLine size={32} strokeWidth={1.5} />
                        <span className="text-[10px] font-mono uppercase tracking-[0.18em]">
                          {waState.state === "unreachable"
                            ? "Service unreachable"
                            : "Generating QR..."}
                        </span>
                      </div>
                    )}
                    <p className="text-xs text-zinc-400 text-center font-mono leading-relaxed max-w-xs">
                      WhatsApp → Paramètres → Appareils liés → Scanner ce code.
                    </p>
                    <div className="border border-amber-500/20 bg-amber-500/5 rounded-sm px-3 py-2 max-w-sm">
                      <p className="text-[11px] font-mono text-amber-300/90 leading-relaxed">
                        ⓘ Vous ne pouvez pas scanner ce QR avec le téléphone qui affiche cette page.
                      </p>
                      <button
                        data-testid="copy-app-url-button"
                        onClick={copyAppUrl}
                        className="mt-2 w-full text-[10px] font-mono uppercase tracking-[0.18em] text-amber-200 hover:text-white border border-amber-500/30 hover:bg-amber-500/10 px-2 py-1.5 rounded-sm transition-colors"
                      >
                        Copier le lien · ouvrir sur un autre appareil
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      Entrez votre numéro (format international, sans <span className="font-mono">+</span>).
                      WhatsApp générera un code à 8 chiffres à entrer dans l'app
                      <span className="text-zinc-200"> Paramètres → Appareils liés → Lier avec un numéro de téléphone</span>.
                    </p>
                    <div className="flex items-stretch gap-2">
                      <div className="flex items-center px-3 border border-zinc-800 bg-zinc-950 text-zinc-400 font-mono text-sm rounded-sm">
                        +
                      </div>
                      <input
                        data-testid="pairing-phone-input"
                        type="tel"
                        inputMode="numeric"
                        placeholder="33612345678"
                        value={pairingPhone}
                        onChange={(e) => setPairingPhone(e.target.value)}
                        className="flex-1 bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 placeholder:text-zinc-600 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
                      />
                    </div>
                    <button
                      data-testid="request-pairing-code-button"
                      onClick={requestPairingCode}
                      disabled={requestingCode}
                      className="bg-white text-zinc-950 hover:bg-zinc-200 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed py-2 rounded-sm font-medium text-sm transition-colors inline-flex items-center justify-center gap-2"
                    >
                      <KeyRound size={14} strokeWidth={2} />
                      {requestingCode ? "Génération..." : "Obtenir le code"}
                    </button>
                    <div
                      data-testid="pairing-code-box"
                      className="border border-zinc-800 rounded-sm p-4 bg-zinc-950 min-h-[88px] flex items-center justify-center"
                    >
                      {pairingCode ? (
                        <div className="text-center">
                          <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-2">
                            Votre code de pairing · valide ~60 s
                          </div>
                          <div className="font-mono text-3xl tracking-[0.4em] text-emerald-400 select-all">
                            {pairingCode}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[11px] font-mono text-zinc-600 uppercase tracking-[0.18em] text-center">
                          {requestingCode ? "génération..." : "code non encore généré"}
                        </span>
                      )}
                    </div>
                    {pairingCodeError && (
                      <div
                        data-testid="pairing-code-error"
                        className="border border-red-500/30 bg-red-500/10 rounded-sm px-3 py-2"
                      >
                        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-red-400 mb-1">
                          Échec de la demande
                        </div>
                        <p className="text-[11px] font-mono text-red-300/90 leading-relaxed">
                          {pairingCodeError}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Reset session — visible whenever not paired, useful after rate-limit */}
                <button
                  data-testid="reset-session-button"
                  onClick={resetWhatsappSession}
                  disabled={resettingSession}
                  className="mt-2 w-full text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500 hover:text-red-400 border border-zinc-800 hover:border-red-500/30 hover:bg-red-500/5 px-2 py-2 rounded-sm transition-colors disabled:opacity-50"
                >
                  {resettingSession ? "Réinitialisation..." : "↺ Réinitialiser la session WhatsApp"}
                </button>
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
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 mb-2">
                  Alias · optionnel
                </label>
                <input
                  data-testid="label-input"
                  type="text"
                  placeholder="Ex: Marie, Boulot, Famille…"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMonitor()}
                  maxLength={40}
                  className="w-full bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 placeholder:text-zinc-600 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white transition-colors rounded-sm"
                />
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
                  ▲ Appairez d'abord WhatsApp (QR ou code) pour activer le client.
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
              </div>

              <div className="border border-zinc-800 rounded-sm p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Send size={14} className="text-zinc-400" strokeWidth={1.75} />
                    <span className="text-sm text-zinc-200">Résumé quotidien</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      data-testid="summary-enabled-toggle"
                      type="checkbox"
                      checked={summaryEnabled}
                      onChange={(e) => setSummaryEnabled(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-zinc-800 rounded-full peer peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:h-4 after:w-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4"></div>
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500">
                    Heure UTC
                  </label>
                  <select
                    data-testid="summary-hour-select"
                    value={summaryHour}
                    onChange={(e) => setSummaryHour(Number(e.target.value))}
                    disabled={!summaryEnabled}
                    className="flex-1 bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-50 font-mono disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
                  >
                    {Array.from({ length: 24 }).map((_, h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] font-mono text-zinc-600 leading-relaxed">
                  ⓘ Email envoyé chaque jour à l'heure choisie (UTC) avec : nb d'évènements,
                  temps online par numéro, dernière activité.
                </p>
                <button
                  data-testid="send-summary-now-button"
                  onClick={sendSummaryNow}
                  disabled={sendingSummary || !summaryEnabled || !emailInput.trim()}
                  className="w-full bg-transparent border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed py-2 rounded-sm font-mono text-[11px] uppercase tracking-[0.18em] transition-colors inline-flex items-center justify-center gap-2"
                >
                  <Send size={12} strokeWidth={1.75} />
                  {sendingSummary ? "Envoi..." : "Envoyer un résumé maintenant"}
                </button>
              </div>

              <button
                data-testid="save-settings-button"
                onClick={saveSettings}
                disabled={savingSettings}
                className="w-full bg-white text-zinc-950 hover:bg-zinc-200 disabled:bg-zinc-800 disabled:text-zinc-500 py-2 rounded-sm font-medium text-sm transition-colors"
              >
                {savingSettings ? "Enregistrement..." : "Enregistrer les paramètres"}
              </button>

              <div className="flex items-start gap-2 px-3 py-2 border border-zinc-800 rounded-sm bg-zinc-950/40">
                <Info size={12} className="text-amber-400/80 mt-0.5 shrink-0" strokeWidth={1.75} />
                <p className="text-[10px] font-mono text-zinc-500 leading-relaxed">
                  Resend en mode test n'envoie qu'à l'adresse vérifiée du compte.
                  Pour envoyer à n'importe quelle adresse, vérifiez un domaine sur{" "}
                  <a
                    href="https://resend.com/domains"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:underline"
                    data-testid="resend-domains-link"
                  >
                    resend.com/domains
                  </a>
                  , puis remplacez <span className="text-zinc-300">SENDER_EMAIL</span> dans le .env backend.
                </p>
              </div>

              <div className="border border-zinc-800 rounded-sm p-3 space-y-3">
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500">
                  Backup · Restauration
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    data-testid="export-backup-button"
                    onClick={exportBackup}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 border border-zinc-700 hover:bg-zinc-800 hover:text-white text-zinc-300 rounded-sm font-mono text-[11px] uppercase tracking-[0.18em] transition-colors"
                  >
                    <Download size={12} strokeWidth={1.75} /> Export JSON
                  </button>
                  <button
                    data-testid="import-backup-button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={restoring}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 border border-zinc-700 hover:bg-zinc-800 hover:text-white text-zinc-300 disabled:opacity-50 rounded-sm font-mono text-[11px] uppercase tracking-[0.18em] transition-colors"
                  >
                    <Upload size={12} strokeWidth={1.75} />
                    {restoring ? "Restauration..." : "Restore"}
                  </button>
                  <input
                    ref={fileInputRef}
                    data-testid="import-backup-file"
                    type="file"
                    accept="application/json,.json"
                    onChange={(e) => importBackup(e.target.files?.[0])}
                    className="hidden"
                  />
                </div>
                <p className="text-[10px] font-mono text-zinc-600 leading-relaxed">
                  ⓘ Export contient monitors, événements, alertes, snapshots de profil et settings.
                  Restore remplace tout.
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
                  className="py-3 -mx-4 px-4 hover:bg-zinc-900/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0 flex-1">
                      <StatusPill status={m.status || "unknown"} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="font-mono text-sm text-zinc-100 truncate">
                            +{m.phone}
                          </div>
                          {editingLabel === m.phone ? (
                            <div className="flex items-center gap-1 flex-1 max-w-xs">
                              <input
                                data-testid={`label-edit-input-${m.phone}`}
                                value={editingLabelValue}
                                onChange={(e) => setEditingLabelValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") updateLabel(m.phone);
                                  if (e.key === "Escape") setEditingLabel(null);
                                }}
                                autoFocus
                                maxLength={40}
                                className="flex-1 bg-zinc-950 border border-zinc-700 px-2 py-0.5 text-xs text-zinc-50 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
                                placeholder="alias..."
                              />
                              <button
                                data-testid={`label-save-${m.phone}`}
                                onClick={() => updateLabel(m.phone)}
                                className="text-[10px] font-mono uppercase tracking-[0.18em] text-emerald-400 hover:text-emerald-300 px-1"
                              >
                                ok
                              </button>
                              <button
                                onClick={() => setEditingLabel(null)}
                                className="text-zinc-500 hover:text-zinc-300"
                              >
                                <X size={12} strokeWidth={1.75} />
                              </button>
                            </div>
                          ) : (
                            <button
                              data-testid={`label-edit-${m.phone}`}
                              onClick={() => startEditLabel(m)}
                              className="inline-flex items-center gap-1 text-xs font-mono text-zinc-400 hover:text-zinc-100 group"
                              title="Editer alias"
                            >
                              {m.label ? (
                                <span className="px-2 py-0.5 border border-zinc-800 rounded-sm bg-zinc-900/60 text-zinc-200">
                                  {m.label}
                                </span>
                              ) : (
                                <span className="text-zinc-600 italic">+ alias</span>
                              )}
                              <Edit3 size={11} strokeWidth={1.75} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-zinc-500 truncate mt-0.5">
                          {m.last_seen
                            ? `last change · ${fmtRelative(m.last_seen)}`
                            : "no presence event yet"}
                          {m.last_seen_public && (
                            <span className="ml-2 text-cyan-400/80">
                              · vu à · {fmtRelative(m.last_seen_public)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        data-testid={`expand-monitor-${m.phone}`}
                        onClick={() => toggleMonitorDetail(m.phone)}
                        className={`p-2 border rounded-sm transition-colors ${
                          expandedPhone === m.phone
                            ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/5"
                            : "border-zinc-800 hover:border-zinc-600 text-zinc-500 hover:text-zinc-100"
                        }`}
                        title="Voir analytics & timeline"
                      >
                        <BarChart3 size={14} strokeWidth={1.75} />
                      </button>
                      <button
                        data-testid={`remove-monitor-${m.phone}`}
                        onClick={() => removeMonitor(m.phone)}
                        className="p-2 border border-zinc-800 hover:border-red-500/30 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 rounded-sm transition-colors"
                        title="Remove"
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                  {expandedPhone === m.phone && (
                    <MonitorDetail
                      phone={m.phone}
                      heatmap={detailHeatmap}
                      anomalies={detailAnomalies}
                      snapshots={detailSnapshots}
                      loading={detailLoading}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Correlations between contacts */}
        {monitors.length >= 2 && (
          <Panel
            title="Correlations · co-online sessions"
            icon={Network}
            testid="panel-correlations"
            right={
              <button
                data-testid="reload-correlations-button"
                onClick={loadCorrelations}
                disabled={correlationsLoading}
                className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              >
                {correlationsLoading ? "calcul..." : "refresh"}
              </button>
            }
          >
            {correlations.length === 0 ? (
              <div className="py-8 flex flex-col items-center gap-2 text-zinc-600">
                <Network size={24} strokeWidth={1.25} />
                <p className="text-sm font-mono">Pas de chevauchement détecté.</p>
                <p className="text-[11px] font-mono text-zinc-700 max-w-md text-center">
                  Quand au moins 2 numéros sont surveillés ET online en même temps,
                  ils apparaîtront ici classés par minutes en commun.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800" data-testid="correlations-list">
                {correlations.map((p, i) => (
                  <li
                    key={`${p.phone_a}-${p.phone_b}`}
                    className="flex items-center justify-between py-2.5 gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-[10px] font-mono text-zinc-600 w-5">{i + 1}.</span>
                      <div className="min-w-0">
                        <div className="font-mono text-xs text-zinc-100 truncate">
                          +{p.phone_a}
                          {p.label_a ? <span className="text-zinc-500"> · {p.label_a}</span> : null}
                          <span className="text-zinc-700 mx-2">↔</span>
                          +{p.phone_b}
                          {p.label_b ? <span className="text-zinc-500"> · {p.label_b}</span> : null}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm text-emerald-400">
                        {p.overlap_minutes} min
                      </div>
                      <div className="text-[10px] font-mono text-zinc-500">
                        {p.overlap_pct}% du plus court
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[10px] font-mono text-zinc-600 leading-relaxed">
              ⓘ Calcul sur les 14 derniers jours. Un chevauchement élevé peut suggérer
              que deux numéros se parlent ou suivent le même rythme de vie.
            </p>
          </Panel>
        )}

        {/* Alert Rules */}
        <Panel
          title="Alert Rules"
          icon={Shield}
          testid="panel-alert-rules"
          right={
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-zinc-600">
                {alertRules.filter((r) => r.enabled).length}/{alertRules.length} active
              </span>
              <button
                data-testid="new-rule-button"
                onClick={openNewRuleForm}
                disabled={monitors.length === 0}
                className="inline-flex items-center gap-1 px-2 py-1 border border-zinc-700 hover:bg-zinc-800 hover:text-white text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed rounded-sm font-mono text-[10px] uppercase tracking-[0.18em] transition-colors"
              >
                <Plus size={11} strokeWidth={1.75} /> new
              </button>
            </div>
          }
        >
          {showRuleForm && (
            <RuleForm
              form={ruleForm}
              setForm={setRuleForm}
              onToggleDay={toggleDay}
              monitors={monitors}
              isEditing={!!editingRuleId}
              saving={savingRule}
              onSave={saveRule}
              onCancel={closeRuleForm}
            />
          )}

          {alertRules.length === 0 && !showRuleForm ? (
            <div className="py-10 flex flex-col items-center gap-2 text-zinc-600">
              <Shield size={28} strokeWidth={1.25} />
              <p className="text-sm font-mono">Aucune alerte configurée.</p>
              <p className="text-[11px] font-mono text-zinc-700 max-w-md text-center">
                {monitors.length === 0
                  ? "Ajoutez d'abord un numéro à surveiller."
                  : 'Cliquez sur "new" pour créer une alerte personnalisée.'}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800" data-testid="alert-rules-list">
              {alertRules.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  monitor={monitors.find((m) => m.phone === r.phone)}
                  onToggle={() => toggleRuleEnabled(r)}
                  onEdit={() => openEditRule(r)}
                  onDelete={() => deleteRule(r.id)}
                />
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
            <div className="flex items-center gap-2">
              <button
                data-testid="refresh-logs-button"
                onClick={reloadEvents}
                title="Rafraîchir les logs"
                className="p-1 text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                <RefreshCw size={11} strokeWidth={1.75} />
              </button>
              <span className="text-zinc-800">·</span>
              <button
                data-testid="export-csv-button"
                onClick={exportCsv}
                className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500 hover:text-emerald-400 transition-colors"
              >
                <Download size={11} strokeWidth={1.75} /> csv
              </button>
              <span className="text-zinc-800">·</span>
              <button
                data-testid="clear-logs-button"
                onClick={clearLogs}
                className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500 hover:text-red-400 transition-colors"
              >
                clear
              </button>
            </div>
          }
        >
          {/* Filter toolbar */}
          <div className="flex flex-wrap items-center gap-2 mb-4 pb-4 border-b border-zinc-900">
            <div className="flex items-stretch">
              <div className="flex items-center px-2 border border-zinc-800 border-r-0 bg-zinc-950 text-zinc-500 font-mono text-xs rounded-l-sm">
                +
              </div>
              <input
                data-testid="filter-phone-input"
                type="tel"
                inputMode="numeric"
                placeholder="filter by phone"
                value={filterPhone}
                onChange={(e) => setFilterPhone(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 px-3 py-1.5 text-xs text-zinc-50 placeholder:text-zinc-600 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-r-sm w-44"
              />
            </div>
            <select
              data-testid="filter-event-select"
              value={filterEvent}
              onChange={(e) => setFilterEvent(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-xs text-zinc-50 font-mono focus:outline-none focus:ring-1 focus:ring-white focus:border-white rounded-sm"
            >
              <option value="">all events</option>
              <option value="online">online</option>
              <option value="offline">offline</option>
              <option value="composing">composing</option>
              <option value="recording">recording</option>
              <option value="profile_change">profile_change</option>
              <option value="alert">alert</option>
              <option value="client_state">client_state</option>
            </select>
            {(filterPhone || filterEvent) && (
              <button
                data-testid="clear-filters-button"
                onClick={() => {
                  setFilterPhone("");
                  setFilterEvent("");
                }}
                className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-200 inline-flex items-center gap-1"
              >
                <X size={11} strokeWidth={1.75} /> reset
              </button>
            )}
            <span className="ml-auto text-[10px] font-mono text-zinc-600">
              {events.length} entr{events.length > 1 ? "ies" : "y"}
            </span>
          </div>

          {events.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-2 text-zinc-600">
              <p className="text-sm font-mono">Pas encore d'évènement.</p>
              <p className="text-[11px] font-mono text-zinc-700">
                {filterPhone || filterEvent
                  ? "Aucun résultat avec ces filtres."
                  : "Les connexions et déconnexions s'afficheront ici en temps réel."}
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
                    const isAlert = ev.event_type === "alert";
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
                          {isAlert && (
                            <span className="inline-flex items-center gap-1.5 text-red-400">
                              <Dot color="bg-red-500" /> ALERT
                            </span>
                          )}
                          {ev.event_type === "composing" && (
                            <span className="inline-flex items-center gap-1.5 text-cyan-400">
                              <Dot color="bg-cyan-400" /> TYPING
                            </span>
                          )}
                          {ev.event_type === "recording" && (
                            <span className="inline-flex items-center gap-1.5 text-fuchsia-400">
                              <Dot color="bg-fuchsia-400" /> AUDIO
                            </span>
                          )}
                          {ev.event_type === "profile_change" && (
                            <span className="inline-flex items-center gap-1.5 text-violet-400">
                              <Dot color="bg-violet-400" /> PROFILE
                            </span>
                          )}
                          {!isOnline && !isOffline && !isState && !isAlert &&
                           !["composing", "recording", "profile_change"].includes(ev.event_type) && (
                            <span className="text-zinc-500">{ev.event_type}</span>
                          )}
                        </td>
                        <td className={`py-2 pr-4 ${isAlert ? "text-red-300" : "text-zinc-500"}`}>
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
