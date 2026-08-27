// SPDX-License-Identifier: AGPL-3.0-or-later
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, Reorder, LayoutGroup, animate as framerAnimate } from "framer-motion";
import {
  Home, Receipt, PieChart as PieChartIcon, Target, TrendingUp, FileText,
  Settings, Bell, Search, X, RefreshCw, LogOut, Users,
  Wallet, CreditCard, Building2, DollarSign, ArrowUpRight,
  Repeat, Utensils, Car, ShoppingBag, Heart, Briefcase, Coffee,
  Film, Zap, GraduationCap, Gift, Music, Book, Plane,
  ChevronDown, Check, Trash2, Shield, AlertCircle, AlertTriangle,
  Pin, Calendar, Link2, Mail, CheckCircle2, Plus, Info,
  Pencil, GripVertical, Sparkles, TrendingDown,
  Lock, Unlock, ChevronRight,
  Image as ImageIcon, Split, Upload, Printer,
} from "lucide-react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip,
} from "recharts";
import { usePlaidLink } from "react-plaid-link";
import { useAuth } from "./hooks/useAuth.js";
import { DataProvider, useData } from "./context/DateContext.jsx";
import { api, setToken, setContextUserId, getContextUserId } from "./api/client.js";
import { enablePush, disablePush, resurrectPushIfEnabled, pushSupported, isIosSafariNotInstalled } from "./push.js";
import { enrollBiometric, unlockBiometric, webauthnSupported, biometricMethodName } from "./webauthn.js";

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtCurrency(n, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, minimumFractionDigits: 2,
  }).format(Number(n || 0));
}
function fmtShort(n) {
  n = Number(n || 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
const fmt = fmtCurrency;

// ─── Themes ───────────────────────────────────────────────────────────────────
const LIGHT = {
  bg: "bg-slate-50", surface: "bg-white", surfaceAlt: "bg-slate-50",
  border: "border-slate-200", text: "text-slate-900",
  textMuted: "text-slate-600", textSubtle: "text-slate-500",
  hover: "hover:bg-slate-100", inputBg: "bg-white",
  chartAxis: "#94a3b8", tooltipBg: "#ffffff", tooltipBorder: "#e2e8f0",
  divide: "divide-slate-100",
};
const DARK = {
  bg: "bg-slate-950", surface: "bg-slate-900", surfaceAlt: "bg-slate-800",
  border: "border-slate-800", text: "text-slate-100",
  textMuted: "text-slate-400", textSubtle: "text-slate-500",
  hover: "hover:bg-slate-800", inputBg: "bg-slate-800",
  chartAxis: "#64748b", tooltipBg: "#1e293b", tooltipBorder: "#334155",
  divide: "divide-slate-800",
};

// ─── Category maps ────────────────────────────────────────────────────────────
const CAT_ICONS = {
  "Groceries": Utensils, "Restaurants": Coffee, "Gas & Fuel": Car,
  "Entertainment": Film, "Shopping": ShoppingBag, "Utilities": Zap,
  "Subscriptions": Repeat, "Health & Fitness": Heart, "Income": DollarSign,
  "Travel": Plane, "Home": Home, "Education": GraduationCap,
  "Gifts": Gift, "Music": Music, "Books": Book, "Other": Briefcase,
};
const CAT_COLORS = {
  "Groceries": "#10b981", "Restaurants": "#f59e0b", "Gas & Fuel": "#ef4444",
  "Entertainment": "#ec4899", "Shopping": "#8b5cf6", "Utilities": "#3b82f6",
  "Subscriptions": "#06b6d4", "Health & Fitness": "#f43f5e", "Income": "#10b981",
  "Travel": "#0ea5e9", "Home": "#a855f7", "Education": "#eab308",
  "Gifts": "#ec4899", "Other": "#6b7280",
};

// ─── AnimatedNumber ───────────────────────────────────────────────────────────
function AnimatedNumber({ value, format = fmt, duration = 0.9 }) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    const controls = framerAnimate(display, value, {
      duration, ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <>{format(display)}</>;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
const ToastCtx = React.createContext(null);
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed top-0 left-0 right-0 z-[80] flex flex-col items-center pointer-events-none px-4 pt-2">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div key={t.id}
              initial={{ y: -60, opacity: 0, scale: 0.9 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -40, opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              className="mb-2 pointer-events-auto"
            >
              <div className={`flex items-center gap-2 px-4 py-3 rounded-full shadow-lg text-white text-sm font-medium ${
                t.type === "error" ? "bg-rose-500/95" :
                t.type === "warning" ? "bg-amber-500/95" :
                "bg-emerald-500/95"
              }`}>
                {t.type === "success" && <Check className="w-4 h-4" />}
                {t.type === "error" && <AlertCircle className="w-4 h-4" />}
                {t.type === "warning" && <AlertTriangle className="w-4 h-4" />}
                {t.msg}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
const useToast = () => React.useContext(ToastCtx);

// ─── ProgressBar ──────────────────────────────────────────────────────────────
function ProgressBar({ value, color = "bg-emerald-500", darkMode, height = "h-2", delay = 0 }) {
  return (
    <div className={`${height} ${darkMode ? "bg-slate-800" : "bg-slate-100"} rounded-full overflow-hidden`}>
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(value, 100)}%` }}
        transition={{ duration: 1.1, delay, ease: [0.22, 1, 0.36, 1] }}
        className={`h-full ${color} rounded-full`}
      />
    </div>
  );
}

// ─── ConfirmDialog ────────────────────────────────────────────────────────────
// In-app replacement for window.confirm for destructive actions. Matches
// the app's design language (Sheet-like backdrop, rounded modal, themed)
// and is more visually impactful than the native dialog, which can blend
// into the browser chrome and be dismissed without the user really
// noticing.
//
// Usage:
//   <ConfirmDialog open={!!toDelete} ... />
// Always rendered (open controls visibility) so AnimatePresence can run
// the enter/exit transitions cleanly.
function ConfirmDialog({
  open, onConfirm, onCancel, theme, darkMode,
  title = "Are you sure?",
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  destructive = true,
  busy = false,
}) {
  // Hold the LATEST callbacks in refs so the effect's dep array only
  // depends on `open`. Every ancestor re-render normally hands us fresh
  // arrow-fn refs for onConfirm/onCancel (they're inline in the JSX),
  // which used to force this effect to tear down + re-run — including
  // during framer-motion's exit animation, which pollutes the global
  // projection tracker and can freeze motion.div's on other tabs at
  // opacity:0 the next time the user navigates. Refs remove the fake
  // dep churn without changing behavior.
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef  = useRef(onCancel);
  useEffect(() => { onConfirmRef.current = onConfirm; });
  useEffect(() => { onCancelRef.current  = onCancel;  });
  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (e.key === "Escape") onCancelRef.current?.();
      if (e.key === "Enter")  onConfirmRef.current?.();
    };
    document.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [open]);

  const confirmCls = destructive
    ? "bg-rose-500 hover:bg-rose-600 text-white shadow-sm shadow-rose-500/30"
    : "bg-violet-500 hover:bg-violet-600 text-white shadow-sm shadow-violet-500/30";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[70]"
            onClick={busy ? undefined : onCancel}
          />
          <div className="fixed inset-0 z-[71] flex items-center justify-center p-6 pointer-events-none">
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 8 }}
              animate={{ scale: 1,    opacity: 1, y: 0 }}
              exit={{    scale: 0.92, opacity: 0, y: 8 }}
              transition={{ type: "spring", damping: 26, stiffness: 320 }}
              className={`pointer-events-auto w-full max-w-sm ${theme.surface} ${theme.text} rounded-3xl shadow-2xl border ${theme.border} overflow-hidden`}
            >
              <div className="p-6 text-center">
                {destructive && (
                  <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-3 ${
                    darkMode ? "bg-rose-500/15" : "bg-rose-50"
                  }`}>
                    <AlertCircle className="w-6 h-6 text-rose-500" />
                  </div>
                )}
                <h3 className="font-semibold text-base mb-1">{title}</h3>
                {message && (
                  <p className={`text-sm ${theme.textMuted} leading-relaxed whitespace-pre-line`}>{message}</p>
                )}
              </div>
              <div className={`flex gap-2 px-5 pb-5`}>
                <button
                  type="button" onClick={onCancel} disabled={busy}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border} ${theme.hover} disabled:opacity-50`}
                >
                  {cancelLabel}
                </button>
                <motion.button
                  whileTap={{ scale: 0.97 }} onClick={onConfirm} disabled={busy}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 ${confirmCls}`}
                >
                  {busy ? "Working…" : confirmLabel}
                </motion.button>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── PendingPill ──────────────────────────────────────────────────────────────
// Small amber chip rendered next to a transaction's merchant when Plaid has
// reported it as `pending: true`. The sync stores pending status in
// transactions.pending; this is just the visual indicator. Renders nothing
// for posted transactions so the markup stays clean.
// Notification bodies from automation alert actions carry a hidden
// `[dedup:key]` marker so the engine can suppress repeat notifications
// for the same condition. Strip it before rendering — the marker is
// engine machinery, not user-facing text.
function stripDedupMarker(body) {
  if (!body) return "";
  return String(body).replace(/\s*​?\[dedup:[^\]]+\]\s*$/, "").trim();
}

function PendingPill({ pending, darkMode, size = "sm" }) {
  if (!pending) return null;
  const cls = size === "xs"
    ? "text-[9px] px-1.5 py-px"
    : "text-[10px] px-1.5 py-0.5";
  return (
    <span className={`inline-flex items-center gap-1 ${cls} rounded-full font-semibold uppercase tracking-wide ${
      darkMode ? "bg-amber-500/15 text-amber-400" : "bg-amber-50 text-amber-700"
    }`}>
      <span className="w-1 h-1 rounded-full bg-amber-500" />
      Pending
    </span>
  );
}

// ─── TransferPill ─────────────────────────────────────────────────────────────
// Blue chip on transactions that represent internal transfers between two of
// the user's own accounts. These rows exist in the DB (their account
// balances still need to reflect them) but they don't count toward income
// or budget spending. Rendered anywhere a Pending pill can appear.
function TransferPill({ isTransfer, darkMode, size = "sm" }) {
  if (!isTransfer) return null;
  const cls = size === "xs"
    ? "text-[9px] px-1.5 py-px"
    : "text-[10px] px-1.5 py-0.5";
  return (
    <span className={`inline-flex items-center gap-1 ${cls} rounded-full font-semibold uppercase tracking-wide ${
      darkMode ? "bg-sky-500/15 text-sky-400" : "bg-sky-50 text-sky-700"
    }`}>
      <span className="w-1 h-1 rounded-full bg-sky-500" />
      Transfer
    </span>
  );
}

// ─── ScheduledPill ────────────────────────────────────────────────────────────
// Indigo chip for user-scheduled (future / expected) transactions. Distinct
// from Pending (amber, Plaid-reported) so the user can tell "not settled yet"
// from "I planned this ahead". Once sync.js adopts the row on a matching
// real transaction, the pill disappears.
function ScheduledPill({ isScheduled, darkMode, size = "sm" }) {
  if (!isScheduled) return null;
  const cls = size === "xs"
    ? "text-[9px] px-1.5 py-px"
    : "text-[10px] px-1.5 py-0.5";
  return (
    <span className={`inline-flex items-center gap-1 ${cls} rounded-full font-semibold uppercase tracking-wide ${
      darkMode ? "bg-indigo-500/15 text-indigo-400" : "bg-indigo-50 text-indigo-700"
    }`}>
      <span className="w-1 h-1 rounded-full bg-indigo-500" />
      Scheduled
    </span>
  );
}

// ─── ReceiptMarker ────────────────────────────────────────────────────────────
// Small pink image outline shown next to a transaction's amount when it has
// a receipt attachment. Purely visual — the actual receipt is opened from
// the detail sheet. Kept intentionally minimal (no chip, no label) so the
// row layout doesn't shift.
function ReceiptMarker({ hasAttachment }) {
  if (!hasAttachment) return null;
  return (
    <span title="Receipt attached" className="inline-flex items-center">
      <ImageIcon className="w-3.5 h-3.5 text-pink-500" strokeWidth={2} />
    </span>
  );
}

// ─── AutomationErrorPill ─────────────────────────────────────────────────────
// Red sticky pill on transactions where an automation errored. Per user spec
// the ONLY way to clear this is to acknowledge the error in the Automations
// tab — tapping the pill here does not clear it. Tooltip on hover tells the
// user where to go.
function AutomationErrorPill({ hasError, darkMode, size = "sm" }) {
  if (!hasError) return null;
  const cls = size === "xs"
    ? "text-[9px] px-1.5 py-px"
    : "text-[10px] px-1.5 py-0.5";
  return (
    <span
      title="Rule error — see Automation history"
      className={`inline-flex items-center gap-1 ${cls} rounded-full font-semibold uppercase tracking-wide cursor-help ${
        darkMode ? "bg-rose-500/15 text-rose-400" : "bg-rose-50 text-rose-700"
      }`}>
      <span className="w-1 h-1 rounded-full bg-rose-500" />
      Error
    </span>
  );
}

// ─── IconButton ───────────────────────────────────────────────────────────────
function IconButton({ children, onClick, theme }) {
  return (
    <motion.button onClick={onClick} whileTap={{ scale: 0.85 }} className={`p-2 rounded-full ${theme.hover}`}>
      {children}
    </motion.button>
  );
}

// ─── KpiCard ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, icon: Icon, color, negative, theme, darkMode, format = fmt, onClick }) {
  const palette = {
    emerald: { bg: darkMode ? "bg-emerald-500/20" : "bg-emerald-50", icon: "text-emerald-500" },
    amber:   { bg: darkMode ? "bg-amber-500/20"   : "bg-amber-50",   icon: "text-amber-500"   },
    rose:    { bg: darkMode ? "bg-rose-500/20"     : "bg-rose-50",    icon: "text-rose-500"    },
    violet:  { bg: darkMode ? "bg-violet-500/20"   : "bg-violet-50",  icon: "text-violet-500"  },
    sky:     { bg: darkMode ? "bg-sky-500/20"       : "bg-sky-50",     icon: "text-sky-500"     },
  };
  const p = palette[color] || palette.emerald;
  return (
    <motion.button
      variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className={`w-full text-left p-4 rounded-2xl ${theme.surface} border ${theme.border} shadow-sm`}
    >
      <div className={`w-10 h-10 rounded-xl ${p.bg} flex items-center justify-center mb-3`}>
        <Icon className={`w-5 h-5 ${p.icon}`} />
      </div>
      <div className={`text-xl font-bold private-amount ${negative ? "text-rose-500" : ""}`} tabIndex={0}>
        <AnimatedNumber value={Number(value)} format={format} duration={0.7} />
      </div>
      <div className={`text-xs font-medium ${theme.textSubtle} mt-0.5`}>{label}</div>
    </motion.button>
  );
}

// ─── Sheet (bottom sheet on mobile, centered modal on desktop) ───────────────
// Tracks whether viewport is ≥ lg (1024px). Updates on resize.
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(min-width: 1024px)").matches
      : false
  );
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const handler = (e) => setIsDesktop(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

function Sheet({ open, onClose, title, theme, children }) {
  const isDesktop = useIsDesktop();

  useEffect(() => {
    if (!open) return;
    const h = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  // The inner panel content — shared between mobile drawer and desktop modal
  const panel = (
    <>
      {!isDesktop && (
        <div className="flex justify-center pt-3 pb-1">
          <div className={`w-10 h-1.5 rounded-full ${theme.textSubtle === "text-slate-500" ? "bg-slate-300" : "bg-slate-700"} opacity-50`} />
        </div>
      )}
      <div className={`sticky top-0 ${theme.surface} px-5 py-3 flex items-center justify-between border-b ${theme.border} z-10`}>
        <h3 className="font-semibold text-base">{title}</h3>
        <button onClick={onClose} className={`p-1.5 rounded-full ${theme.hover}`}>
          <X className={`w-5 h-5 ${theme.textSubtle}`} />
        </button>
      </div>
      <div className={`p-5 ${isDesktop ? "" : "pb-[calc(20px+env(safe-area-inset-bottom))]"}`}>
        {children}
      </div>
    </>
  );

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]"
            onClick={onClose} />

          {isDesktop ? (
            // ── Desktop: flex-centered modal, scale+fade animation ──
            // Wrapping div handles centering so framer-motion's transform
            // (scale) doesn't fight CSS translate-based centering.
            <div className="fixed inset-0 z-[61] flex items-center justify-center p-6 pointer-events-none">
              <motion.div
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1,    opacity: 1 }}
                exit={{    scale: 0.94, opacity: 0 }}
                transition={{ type: "spring", damping: 26, stiffness: 320 }}
                className={`pointer-events-auto w-full max-w-md max-h-[85vh] overflow-y-auto rounded-3xl shadow-2xl ${theme.surface} ${theme.text}`}
              >
                {panel}
              </motion.div>
            </div>
          ) : (
            // ── Mobile: bottom drawer, slide-up animation (UNCHANGED) ──
            <motion.div
              initial={{ y: "100%", opacity: 0.8 }}
              animate={{ y: 0,      opacity: 1 }}
              exit={{    y: "100%", opacity: 0.8 }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
              className={`fixed left-0 right-0 bottom-0 z-[61] ${theme.surface} ${theme.text} rounded-t-3xl shadow-2xl max-h-[92vh] overflow-y-auto`}
            >
              {panel}
            </motion.div>
          )}
        </>
      )}
    </AnimatePresence>
  );
}

// ─── Plaid Link Button ────────────────────────────────────────────────────────
// Detect OAuth redirect-return (banks like Chase send users back with this param)
const PLAID_OAUTH_RETURN = typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("oauth_state_id");

function PlaidLinkButton({ onSuccess, full = false }) {
  const toast = useToast();
  // Manual-only mode flag. useAuth() is a plain hook (not context-
  // backed) so each call is an independent state instance that starts
  // at user=null while refetching /me — we CANNOT default plaid_enabled
  // to true during that window or every mount fires a 404 link-token
  // fetch and toasts "Could not start Plaid: Not found" on a disabled
  // instance. Tri-state:
  //   null   — user still loading; wait
  //   true   — plaid enabled; allow fetch
  //   false  — manual-only; render nothing, no fetch
  const { user: _plaidUser } = useAuth();
  const _plaidEnabled = _plaidUser == null
    ? null
    : _plaidUser.plaid_enabled !== false;

  const [linkToken, setLinkToken] = useState(
    PLAID_OAUTH_RETURN ? sessionStorage.getItem("plaid_link_token") : null
  );
  const [tokenError, setTokenError] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const autoOpenedRef = useRef(false);
  // Stage 3 — merge candidates returned by /plaid/exchange when a
  // freshly-linked Plaid account matches an imported manual account
  // by name + institution. Modal walks the user through per-candidate
  // Merge or Keep-Separate. Empty until an exchange comes back with a
  // non-empty list.
  const [mergeCandidates, setMergeCandidates] = useState([]);
  const [mergeBusy, setMergeBusy] = useState(false);

  const fetchToken = useCallback(async () => {
    setTokenError(false);
    try {
      const r = await api.createLinkToken({ includeInvestments: true });
      sessionStorage.setItem("plaid_link_token", r.link_token);
      setLinkToken(r.link_token);
      return r.link_token;
    } catch (e) {
      setTokenError(true);
      toast?.("Could not start Plaid: " + (e.message || "network error"), "error");
      return null;
    }
  }, [toast]);

  // Initial token fetch. Wait for user to load (_plaidEnabled === null)
  // and skip entirely in manual-only mode (=== false) — otherwise this
  // fires an unconditional POST /plaid/link-token that 404s and toasts
  // an unhelpful "Could not start Plaid: Not found" on every mount.
  useEffect(() => {
    if (_plaidEnabled !== true) return;
    if (!PLAID_OAUTH_RETURN && !linkToken) fetchToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_plaidEnabled]);

  const { open, ready, error: plaidError } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri: PLAID_OAUTH_RETURN ? window.location.href : undefined,
    onSuccess: async (public_token, metadata) => {
      setExchanging(true);
      try {
        const res = await api.exchangePublicToken(public_token, metadata);
        sessionStorage.removeItem("plaid_link_token");
        toast?.(`Connected ${metadata?.institution?.name || "your bank"} successfully`, "success");
        // Refetch a fresh token in case user wants to link another bank
        fetchToken();
        onSuccess?.();
        // If any freshly-linked accounts match imported manual ones,
        // pop the merge modal. User confirms per row; overlap-window
        // transaction dedup is handled server-side on the next sync
        // (tryAdoptManual in sync.js). Silently skip when nothing to
        // do so a normal Plaid link stays a single click.
        if (Array.isArray(res?.mergeCandidates) && res.mergeCandidates.length > 0) {
          setMergeCandidates(res.mergeCandidates);
        }
      } catch (e) {
        toast?.("Could not save connection: " + (e.message || "server error"), "error");
      } finally {
        setExchanging(false);
      }
    },
    onExit: (err) => {
      if (err && err.error_code && err.error_code !== "USER_EXIT" && err.error_code !== "USER_CANCELED") {
        toast?.(err.display_message || err.error_message || "Bank link error", "error");
      }
      // Refresh the token after a closed Link session so the next click works
      if (err) fetchToken();
    },
  });

  // OAuth return: auto-open Plaid Link to finish the flow once ready
  useEffect(() => {
    if (PLAID_OAUTH_RETURN && ready && linkToken && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      open();
      // Clean the OAuth params from the URL bar
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [ready, linkToken, open]);

  const click = async () => {
    if (exchanging) return;
    if (tokenError || !linkToken) {
      const t = await fetchToken();
      if (!t) return;
      // usePlaidLink takes a tick to become ready after token changes —
      // user can click again, or onReady will let them through next click.
      return;
    }
    if (ready) open();
  };

  const showSpinner = exchanging || (!ready && !tokenError);
  const label =
    exchanging   ? "Linking…"   :
    tokenError   ? "Retry"      :
    !ready       ? "Preparing…" :
                   "Connect Bank";

  // Manual-only mode OR still loading — render nothing. All hooks
  // above still ran in the same order, so the rules-of-hooks contract
  // is preserved. Once user loads, _plaidEnabled becomes true or false
  // and the component either renders the button or stays null.
  if (_plaidEnabled !== true) return null;

  return (
    <>
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={click}
      disabled={exchanging}
      className={`flex items-center justify-center gap-2 bg-violet-500 hover:bg-violet-600 active:bg-violet-700 text-white text-sm font-semibold shadow-sm shadow-violet-500/30 transition-colors disabled:opacity-60 ${
        full ? "w-full py-3 mt-2 rounded-xl" : "px-4 py-2.5 rounded-xl"
      }`}
    >
      {showSpinner ? (
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white flex-shrink-0"
        />
      ) : (
        <Link2 className="w-4 h-4 flex-shrink-0" />
      )}
      {label}
    </motion.button>

    {/* Stage 3 merge modal — appears when Plaid link returns
        matching imported manual accounts. User confirms or skips
        per candidate. Rendered as a fixed-position overlay so it
        works from any tab. */}
    {mergeCandidates.length > 0 && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60"
        onClick={() => setMergeCandidates([])}>
        <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-lg bg-white rounded-2xl shadow-2xl p-5 space-y-4">
          <div>
            <div className="text-lg font-bold text-slate-900">Re-link imported account?</div>
            <div className="text-xs text-slate-500 mt-1 leading-relaxed">
              You have {mergeCandidates.length === 1 ? "an imported manual account that matches" : `${mergeCandidates.length} imported manual accounts that match`} what you just linked from Plaid. Merging moves the imported history onto the fresh Plaid connection so future syncs update the same row. Overlapping transactions (last ~30 days) will be deduplicated automatically on the next sync.
            </div>
          </div>
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {mergeCandidates.map((c) => (
              <div key={c.manual.id + ":" + c.plaid.id}
                className="rounded-xl border border-slate-200 p-3 space-y-2">
                <div className="text-sm font-semibold text-slate-900">
                  {c.plaid.name}
                  {c.plaid.institution && (
                    <span className="text-xs text-slate-500 font-normal"> · {c.plaid.institution}</span>
                  )}
                </div>
                <div className="text-xs text-slate-600 grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {c.manual.transactions > 0 && <div><span className="font-mono">{c.manual.transactions}</span> transactions</div>}
                  {c.manual.budgets > 0 && <div><span className="font-mono">{c.manual.budgets}</span> budgets</div>}
                  {c.manual.goals > 0 && <div><span className="font-mono">{c.manual.goals}</span> goals</div>}
                  {c.manual.loans > 0 && <div><span className="font-mono">{c.manual.loans}</span> loans</div>}
                  {c.manual.assets > 0 && <div><span className="font-mono">{c.manual.assets}</span> assets</div>}
                  {c.manual.bills > 0 && <div><span className="font-mono">{c.manual.bills}</span> bills</div>}
                  {c.manual.reconciliations > 0 && <div><span className="font-mono">{c.manual.reconciliations}</span> reconciliations</div>}
                  {c.manual.holdings > 0 && <div><span className="font-mono">{c.manual.holdings}</span> holdings</div>}
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="button" disabled={mergeBusy}
                    onClick={() => setMergeCandidates(prev => prev.filter(x => x !== c))}
                    className="flex-1 py-1.5 rounded-lg text-xs text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                    Keep separate
                  </button>
                  <button type="button" disabled={mergeBusy}
                    onClick={async () => {
                      setMergeBusy(true);
                      try {
                        const r = await api.mergeManualIntoPlaid(c.manual.id, c.plaid.id);
                        const moved = Object.entries(r.moves || {})
                          .filter(([, n]) => n > 0)
                          .map(([k, n]) => `${n} ${k}`)
                          .join(", ") || "no rows";
                        toast?.(`Merged into ${c.plaid.name}: ${moved}`, "success");
                        setMergeCandidates(prev => prev.filter(x => x !== c));
                        onSuccess?.();
                      } catch (e) {
                        toast?.("Merge failed: " + (e.message || ""), "error");
                      } finally {
                        setMergeBusy(false);
                      }
                    }}
                    className="flex-1 py-1.5 rounded-lg text-xs font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-40">
                    {mergeBusy ? "Merging…" : "Merge"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setMergeCandidates([])}
            className="w-full py-2 rounded-xl text-sm font-medium text-slate-500 hover:bg-slate-50">
            Done
          </button>
        </motion.div>
      </div>
    )}
    </>
  );
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const btnRef = useRef(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // Google is now optional (matches MS + one-time-link). Server drives
  // enable/disable via /public-config.googleEnabled; the build-time
  // VITE_GOOGLE_CLIENT_ID is only a fallback client id — the enable
  // decision still comes from the server so an operator flipping
  // GOOGLE_SSO_ENABLED doesn't need a frontend rebuild.
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(
    import.meta.env.VITE_GOOGLE_CLIENT_ID || null
  );

  // ── Microsoft Sign-In (server-gated by MICROSOFT_CLIENT_ID)
  // MSAL is dynamically imported on first click so users who don't
  // have MS configured don't pay the bundle-size cost. The client id
  // comes from /public-config (source of truth) with a build-time
  // env fallback for people who prefer to bake it into the bundle.
  const [msEnabled, setMsEnabled] = useState(false);
  const [msClientId, setMsClientId] = useState(
    import.meta.env.VITE_MICROSOFT_CLIENT_ID || null
  );
  // Tenant scope from server config: "common" (default), "consumers",
  // "organizations", or a specific tenant GUID. Builds the MSAL
  // authority URL. Cannot be baked at build time — the server is the
  // source of truth so a config change doesn't need a frontend rebuild.
  const [msTenant, setMsTenant] = useState("common");
  // Optional redirect URI override. Falls back to window.location.origin
  // + "/auth" if unset. Build-time env var lets people bake a value in
  // if they don't want to rely on the runtime fetch (e.g. air-gapped).
  const [msRedirectUri, setMsRedirectUri] = useState(
    import.meta.env.VITE_MICROSOFT_REDIRECT_URI || null
  );
  const [msBusy, setMsBusy] = useState(false);

  // ── One-time email sign-in link (server-gated by ONE_TIME_LINK_ENABLED)
  const [otlEnabled, setOtlEnabled] = useState(false);
  const [otlOpen, setOtlOpen] = useState(false);
  const [otlEmail, setOtlEmail] = useState("");
  const [otlSending, setOtlSending] = useState(false);
  const [otlSent, setOtlSent] = useState(false);
  // Handoff-code input (for the "I signed in in Safari but I'm using
  // the installed PWA" cross-context flow — iOS keeps Safari and
  // Home-Screen PWA storage separate).
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffCode, setHandoffCode] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(false);
  // Redeem-token state: when URL hash is #signin?t=<token>, verify and
  // sign in. Runs BEFORE the Google button init so a valid link doesn't
  // briefly flash the sign-in screen.
  const [redeeming, setRedeeming] = useState(() => /^#signin\?t=/.test(window.location.hash));
  // After verify succeeds, we hold the session pending until the user
  // acknowledges (so we can show them the handoff code first, needed
  // for iOS Safari -> Home Screen PWA). Contains { token, user,
  // handoffCode, handoffExpiresMinutes } from the server.
  const [pendingSession, setPendingSession] = useState(null);
  // Am I running as an installed PWA (standalone display mode)?
  // Used to skip the handoff-code screen when there's no other context
  // the user might want to sign into.
  const isStandalone = typeof window !== "undefined"
    && (window.matchMedia?.("(display-mode: standalone)")?.matches
        || window.navigator.standalone === true);

  useEffect(() => {
    api.publicConfig().then(c => {
      setOtlEnabled(!!c.oneTimeLinkEnabled);
      setMsEnabled(!!c.microsoftEnabled);
      setGoogleEnabled(!!c.googleEnabled);
      // Prefer server-provided values; fall back to build-time env
      // vars if the server didn't return one (e.g. older backend).
      if (c.googleClientId) setGoogleClientId(c.googleClientId);
      if (c.microsoftClientId) setMsClientId(c.microsoftClientId);
      if (c.microsoftTenant) setMsTenant(c.microsoftTenant);
      if (c.microsoftRedirectUri) setMsRedirectUri(c.microsoftRedirectUri);
    }).catch(() => { setOtlEnabled(false); setMsEnabled(false); setGoogleEnabled(false); });
  }, []);

  // Guard: onAuth is a fresh object on every render (useAuth doesn't
  // memoize), so we track "already dispatched" via a ref instead of
  // deps to prevent a double-verify (would 410 on the second attempt
  // and clobber the successful first attempt's session with an error).
  const redeemStartedRef = useRef(false);
  useEffect(() => {
    if (!redeeming || redeemStartedRef.current) return;
    redeemStartedRef.current = true;
    const m = /^#signin\?t=(.+)$/.exec(window.location.hash);
    const token = m ? decodeURIComponent(m[1]) : null;
    // Strip the token from the URL immediately so it doesn't linger in
    // browser history or get shared accidentally.
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if (!token) { setRedeeming(false); return; }
    (async () => {
      try {
        const res = await onAuth.verifyOneTimeLinkOnly(token);
        // If we're already in the installed PWA (or on desktop where
        // there's only one context), sign in immediately — no reason
        // to make the user acknowledge a handoff code they'll never
        // need. Only iOS-Safari-in-a-browser-tab-with-PWA-installed
        // benefits from the extra step, and we can't reliably detect
        // "PWA installed" from a browser tab, so we default to
        // showing the code + a Continue button for non-standalone.
        if (isStandalone) {
          onAuth.commitSession(res);
        } else {
          setPendingSession(res);
          setRedeeming(false);
        }
      } catch (e) {
        setErr(e.message || "This sign-in link is invalid or has expired.");
        setRedeeming(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redeeming]);

  useEffect(() => {
    // No-op when Google Sign-In is disabled server-side (operator chose
    // Microsoft-only, one-time-link only, or some combination without
    // Google). The button also doesn't render, so there's no visible
    // affordance to init against.
    if (!googleEnabled || !googleClientId) return;

    let cancelled = false;
    let retries = 0;

    const init = () => {
      if (cancelled) return;
      if (!window.google?.accounts?.id) {
        if (retries++ < 50) return setTimeout(init, 100);
        setErr("Could not load Google Sign-In. Check your network/ad-blocker.");
        return;
      }
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response) => {
          if (!response?.credential) return;
          setErr(""); setBusy(true);
          try {
            await onAuth.googleSignIn(response.credential);
          } catch (e) {
            setErr(e.message || "Sign-in failed");
          } finally {
            if (!cancelled) setBusy(false);
          }
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      if (btnRef.current) {
        window.google.accounts.id.renderButton(btnRef.current, {
          theme: "filled_blue", size: "large", text: "continue_with",
          shape: "pill", logo_alignment: "center", width: 280,
        });
      }
    };
    init();
    return () => { cancelled = true; };
  }, [googleEnabled, googleClientId, onAuth]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-violet-900 flex items-center justify-center p-4 safe-pt safe-pb">
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", damping: 20, stiffness: 200 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8"
      >
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-xl bg-violet-500 flex items-center justify-center shadow-sm shadow-violet-500/40">
            <DollarSign className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Coinvane</h1>
            <p className="text-sm text-slate-500">Self-hosted personal finance</p>
          </div>
        </div>

        <div className="space-y-5">
          {redeeming ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                className="w-6 h-6 rounded-full border-2 border-slate-200 border-t-violet-500" />
              <div className="text-sm text-slate-600">Verifying your one-time link…</div>
            </div>
          ) : pendingSession ? (
            <div className="space-y-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">Welcome back, {pendingSession.user?.name || "there"}!</div>
                <div className="text-sm text-slate-600 mt-1">Choose how to continue.</div>
              </div>
              <button type="button"
                onClick={() => onAuth.commitSession(pendingSession)}
                className="w-full py-3 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600">
                Continue in this browser
              </button>
              <div className="border-t border-slate-100 pt-4">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Or: sign in in the installed app
                </div>
                <div className="text-xs text-slate-500 mt-1 leading-relaxed">
                  Open Coinvane from your home screen and enter this code on the sign-in page.
                  Code expires in {pendingSession.handoffExpiresMinutes} minutes.
                </div>
                <div className="mt-3 p-4 bg-slate-50 border border-slate-200 rounded-xl text-center">
                  <div className="text-2xl font-mono font-bold tracking-[0.2em] text-slate-900 select-all">
                    {pendingSession.handoffCode}
                  </div>
                </div>
                <button type="button"
                  onClick={() => {
                    if (navigator.clipboard) {
                      navigator.clipboard.writeText(pendingSession.handoffCode).catch(() => {});
                    }
                  }}
                  className="mt-2 w-full py-2 rounded-xl text-xs font-medium text-slate-600 hover:bg-slate-50">
                  Copy code
                </button>
              </div>
            </div>
          ) : (<>
          <p className="text-sm text-slate-600 text-center">
            Choose how to sign in.
          </p>
          {/* Google Sign-In button — rendered only when the server says
              Google is enabled (googleEnabled). When Google is disabled
              the container disappears entirely so the layout collapses
              cleanly to just Microsoft / one-time-link. */}
          {(googleEnabled || busy || msBusy) && (
            <div className="flex justify-center min-h-[44px] items-center">
              {(busy || msBusy) ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                    className="w-4 h-4 rounded-full border-2 border-slate-200 border-t-violet-500" />
                  Signing you in…
                </div>
              ) : (
                googleEnabled && <div ref={btnRef} />
              )}
            </div>
          )}

          {/* Microsoft Sign-In. Sits between Google and the one-time
              link, per the login-page ordering the operator chose. Only
              renders when the server says a client id is configured
              (msEnabled). MSAL itself is dynamically imported on first
              click so the ~90KB library doesn't inflate the initial
              bundle for users who never touch this button. */}
          {msEnabled && !busy && !msBusy && (
            <button type="button"
              onClick={async () => {
                if (!msClientId) {
                  setErr("Microsoft Sign-In is misconfigured — no client id available.");
                  return;
                }
                setErr(""); setMsBusy(true);
                try {
                  const { PublicClientApplication } = await import("@azure/msal-browser");
                  const msal = new PublicClientApplication({
                    auth: {
                      clientId: msClientId,
                      // Authority = login.microsoftonline.com/<tenant>.
                      // Server-driven so the operator can flip between
                      // common / consumers / organizations / <guid>
                      // without a frontend rebuild. Backend enforces
                      // the same policy on the returned token.
                      authority: `https://login.microsoftonline.com/${msTenant || "common"}`,
                      // Redirect URI must be one of the SPA redirect URIs
                      // registered on the Entra app. Defaults to the
                      // current origin + "/auth"; MICROSOFT_REDIRECT_URI
                      // (server env) overrides if the operator needs to
                      // pin a specific domain.
                      redirectUri: msRedirectUri || (window.location.origin + "/auth"),
                      // See MsRedirectScreen for the rationale. Must
                      // match byte-for-byte across both configs so the
                      // localStorage state MSAL wrote before redirect
                      // is honoured on the way back.
                      navigateToLoginRequestUrl: false,
                    },
                    cache: {
                      // localStorage so a page reload doesn't lose the
                      // MSAL context. Our own session lives in localStorage
                      // too (coinvane_token) so this matches the trust model.
                      cacheLocation: "localStorage",
                    },
                  });
                  await msal.initialize();
                  // Full-page redirect (NOT popup). Modern browsers
                  // block MSAL's window.closed polling across the COOP
                  // boundary between our origin and login.microsoftonline.com
                  // (Microsoft doesn't set a matching Cross-Origin-Opener-
                  // Policy on its login pages, so popup handoff fails
                  // silently). Redirect flow bypasses the popup entirely —
                  // browser navigates to MS, then back to /auth where
                  // MsRedirectScreen catches the response.
                  await msal.loginRedirect({
                    scopes: ["openid", "profile", "email"],
                    prompt: "select_account",
                  });
                  // loginRedirect never returns — the browser navigates
                  // away. Nothing else runs.
                } catch (e) {
                  // eslint-disable-next-line no-console
                  console.error("[MS Sign-In] failure:", e);
                  const msg = e?.errorCode
                    ? `${e.errorCode}: ${e.errorMessage || e.message || "sign-in failed"}`
                    : (e?.message || "Microsoft sign-in failed");
                  setErr(msg);
                  setMsBusy(false);
                }
              }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-full border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-violet-300 transition">
              {/* Microsoft's 4-square glyph — inline SVG, no external asset */}
              <svg viewBox="0 0 21 21" className="w-4 h-4" aria-hidden="true">
                <rect x="1"  y="1"  width="9" height="9" fill="#F25022"/>
                <rect x="11" y="1"  width="9" height="9" fill="#7FBA00"/>
                <rect x="1"  y="11" width="9" height="9" fill="#00A4EF"/>
                <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
              </svg>
              Continue with Microsoft
            </button>
          )}

          {/* One-time email sign-in link. Rendered only when the server
              says the feature is on (ONE_TIME_LINK_ENABLED + email
              subsystem enabled). Silent success on request means the
              button always says "Check your email" — anti-enumeration. */}
          {otlEnabled && (
            <div className="border-t border-slate-100 pt-4">
              {!otlOpen && !otlSent && (
                <button type="button" onClick={() => setOtlOpen(true)}
                  className="w-full py-2.5 rounded-full border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-violet-300 transition">
                  Sign in with a one-time link
                </button>
              )}
              {otlOpen && !otlSent && (
                <form className="space-y-2" onSubmit={async (e) => {
                  e.preventDefault();
                  if (otlSending) return;
                  const email = otlEmail.trim().toLowerCase();
                  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    setErr("Enter a valid email address"); return;
                  }
                  setErr(""); setOtlSending(true);
                  try {
                    await api.requestOneTimeLink(email);
                    setOtlSent(true);
                  } catch (e2) {
                    setErr(e2.message || "Could not send link");
                  } finally { setOtlSending(false); }
                }}>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Email address</label>
                  <input type="email" required value={otlEmail}
                    onChange={e => setOtlEmail(e.target.value)}
                    placeholder="you@example.com" autoComplete="email"
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-violet-500" />
                  <div className="flex gap-2 pt-1">
                    <button type="button" onClick={() => { setOtlOpen(false); setOtlEmail(""); setErr(""); }}
                      className="flex-1 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-50">Cancel</button>
                    <button type="submit" disabled={otlSending}
                      className="flex-1 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
                      {otlSending ? "Sending…" : "Send link"}
                    </button>
                  </div>
                </form>
              )}
              {otlSent && (
                <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl p-3 space-y-1">
                  <div className="font-semibold">Check your email</div>
                  <div className="text-xs text-emerald-800">
                    If <span className="font-mono">{otlEmail}</span> is authorized, we sent a sign-in link to that address. It expires in 15 minutes.
                  </div>
                  <div className="flex items-center gap-3 pt-1">
                    <button type="button"
                      onClick={() => { setOtlSent(false); setOtlOpen(false); setOtlEmail(""); }}
                      className="text-xs text-emerald-700 underline hover:no-underline">
                      Use a different email
                    </button>
                    <span className="text-emerald-300">·</span>
                    <button type="button"
                      onClick={() => { setOtlSent(false); setOtlOpen(false); setOtlEmail(""); setHandoffOpen(true); }}
                      className="text-xs text-emerald-700 underline hover:no-underline">
                      Have a one-time code?
                    </button>
                  </div>
                </div>
              )}

              {/* Handoff-code input — visible always so the installed
                  PWA on iOS (where a Safari-tab sign-in doesn't share
                  storage) can pick up the session. Small link by
                  default; expands to a code input on click. */}
              {!otlOpen && !otlSent && !handoffOpen && (
                <button type="button"
                  onClick={() => setHandoffOpen(true)}
                  className="w-full mt-2 text-xs text-slate-500 hover:text-violet-600 hover:underline">
                  Have a sign-in code from another tab?
                </button>
              )}
              {handoffOpen && (
                <form className="space-y-2 mt-2" onSubmit={async (e) => {
                  e.preventDefault();
                  if (handoffBusy) return;
                  const code = handoffCode.trim().toUpperCase().replace(/\s+/g, "");
                  if (code.length !== 8 || !/^[A-Z0-9]+$/.test(code)) {
                    setErr("Enter the 8-character sign-in code");
                    return;
                  }
                  setErr(""); setHandoffBusy(true);
                  try {
                    await onAuth.handoffCodeSignIn(code);
                    // Success — App re-renders into authed shell.
                  } catch (e2) {
                    setErr(e2.message || "Invalid or expired code");
                  } finally { setHandoffBusy(false); }
                }}>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Sign-in code</label>
                  <input type="text" required value={handoffCode}
                    onChange={e => setHandoffCode(e.target.value.toUpperCase())}
                    placeholder="XXXX-XXXX"
                    autoComplete="one-time-code"
                    inputMode="text"
                    maxLength={16}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono tracking-widest text-center focus:outline-none focus:border-violet-500" />
                  <div className="flex gap-2 pt-1">
                    <button type="button" onClick={() => { setHandoffOpen(false); setHandoffCode(""); setErr(""); }}
                      className="flex-1 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-50">Cancel</button>
                    <button type="submit" disabled={handoffBusy}
                      className="flex-1 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
                      {handoffBusy ? "Signing in…" : "Sign in"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
          </>)}

          {err && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 p-3 rounded-xl">
              {err}
            </div>
          )}
          <p className="text-[11px] text-slate-400 text-center pt-2 leading-relaxed">
            All logins are used to identify you. No personal data is shared with external login sources.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Notifications Bell ───────────────────────────────────────────────────────
function NotificationsBell({ theme, darkMode }) {
  const { notifications, refreshAll } = useData();
  const [open, setOpen] = useState(false);
  const unread = notifications.filter(n => !n.readAt).length;

  // Keep the installed-PWA app-icon badge in sync with the in-app
  // unread count. The service worker also sets it when a push arrives,
  // but the SW's number goes stale as soon as the user marks anything
  // read in another tab / on another device — reconciling here catches
  // that. No-op on browsers without the Badging API (all desktop
  // Firefox, Safari on Mac, tab-only Chrome).
  //
  // GUARD: skip the very first render pass so a badge the SW set
  // while the app was closed isn't immediately wiped by an initial
  // unread=0 read that hasn't yet reflected the just-fetched data.
  // Once real fetches start updating the count, the effect syncs
  // normally (whether unread stays 0 or moves).
  const badgeSyncMountRef = useRef(true);
  useEffect(() => {
    if (badgeSyncMountRef.current) { badgeSyncMountRef.current = false; return; }
    if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
    (unread > 0
      ? navigator.setAppBadge(unread)
      : navigator.clearAppBadge()
    ).catch(() => { /* denied / unsupported — nothing we can do */ });
  }, [unread]);

  return (
    <div className="relative">
      <IconButton theme={theme} onClick={() => setOpen(!open)}>
        <div className="relative">
          <Bell className={`w-5 h-5 ${theme.textMuted}`} />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {unread}
            </span>
          )}
        </div>
      </IconButton>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
              className={`absolute right-0 mt-2 w-80 ${theme.surface} rounded-2xl shadow-xl border ${theme.border} z-50 max-h-96 overflow-y-auto`}>
              <div className={`px-4 py-3 border-b ${theme.border} flex items-center justify-between`}>
                <h3 className="font-semibold text-sm">Notifications</h3>
                {unread > 0 && (
                  <button onClick={async () => { await api.markAllNotificationsRead(); refreshAll(); }}
                    className="text-xs text-violet-500 font-medium">Mark all read</button>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className={`px-4 py-8 text-center text-sm ${theme.textSubtle}`}>No notifications</div>
              ) : (
                <div className={`divide-y ${theme.divide}`}>
                  {notifications.map(n => (
                    <div key={n.id} className={`px-4 py-3 ${!n.readAt ? (darkMode ? "bg-violet-500/10" : "bg-violet-50/50") : ""}`}>
                      <div className="text-sm font-medium">{n.title}</div>
                      {n.body && <div className={`text-xs ${theme.textMuted} mt-0.5`}>{stripDedupMarker(n.body)}</div>}
                      <div className={`text-xs ${theme.textSubtle} mt-1`}>{new Date(n.createdAt).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── More Menu ────────────────────────────────────────────────────────────────
function MoreMenu({ tabs, activeTab, setTab, theme, darkMode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = tabs.find(t => t.id === activeTab);
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)}
        className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
          active ? (darkMode ? "text-violet-400" : "text-violet-700") : `${theme.textMuted} ${theme.hover}`
        }`}>
        {active
          ? <><active.icon className="w-4 h-4 relative" /><span className="relative">{active.label}</span></>
          : <><span>More</span><ChevronDown className="w-4 h-4" /></>
        }
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
            className={`absolute top-full mt-1 right-0 w-48 ${theme.surface} border ${theme.border} rounded-xl shadow-lg overflow-hidden z-30`}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => { setTab(t.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm ${theme.hover} ${activeTab === t.id ? "text-violet-500 font-semibold" : ""}`}>
                <t.icon className="w-4 h-4" /> {t.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Sidebar Account Group ────────────────────────────────────────────────────
function SidebarGroup({ type, label, icon: Icon, accounts, theme, items }) {
  // Two calling patterns:
  //   (accounts, type) — filter accounts by type. Used for cash/credit/etc.
  //   (items)          — render the supplied items as-is with the shape
  //                      { id, name, institution?, balance }. Used for
  //                      assets (car / boat / valuables) which live in
  //                      a separate table but share the sidebar layout.
  const visible = items ? items : accounts.filter(a => a.type === type);
  if (!visible.length) return null;
  const total = visible.reduce((s, a) => s + Number(a.balance), 0);
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${theme.textSubtle}`} />
          <span className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider`}>{label}</span>
        </div>
        <span className={`text-sm font-semibold private-amount ${total < 0 ? "text-rose-500" : ""}`} tabIndex={0}>{fmt(total)}</span>
      </div>
      <div className="space-y-0.5">
        {visible.map(acc => (
          <div key={acc.id} className={`w-full flex items-center justify-between p-2 rounded-md ${theme.hover}`}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate private-name" tabIndex={0}>{acc.name}</div>
              <div className={`text-xs ${theme.textSubtle} truncate private-name`} tabIndex={0}>{acc.institution}</div>
            </div>
            <span className={`text-sm font-semibold ml-2 flex-shrink-0 private-amount ${Number(acc.balance) < 0 ? "text-rose-500" : ""}`} tabIndex={0}>
              {fmtShort(Number(acc.balance))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Net Worth Chart (with MTD/YTD/1M/3M/1Y/ALL selector) ────────────────────
const NET_PERIODS = [
  { id: "all", label: "ALL" },
  { id: "mtd", label: "MTD" },
  { id: "ytd", label: "YTD" },
  { id: "1m",  label: "1M"  },
  { id: "3m",  label: "3M"  },
  { id: "1y",  label: "1Y"  },
];

// Same set the NetWorth chip row uses, shared by Cashflow + Spending-
// by-Category KPI cards so all three period selectors behave identically.
const KPI_PERIODS = NET_PERIODS;

// Convert a period id to a { from, to } pair in YYYY-MM-DD LOCAL format.
// `all` returns {} — no date filter, backend picks the default. All other
// ids compute from today's local midnight so DST transitions don't shift
// the boundary by an hour.
function kpiRangeToDates(range) {
  if (!range || range === "all") return {};
  const now = new Date();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let from = null;
  if (range === "mtd") {
    from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  } else if (range === "ytd") {
    from = `${now.getFullYear()}-01-01`;
  } else if (range === "1m" || range === "3m" || range === "1y") {
    const months = { "1m": 1, "3m": 3, "1y": 12 }[range];
    const d = new Date(now);
    d.setMonth(d.getMonth() - months);
    from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return from ? { from, to } : {};
}

// Chip pill row shared by the KPI cards. `expanded` swaps to a slightly
// larger tap target when the card is rendered inside the fullscreen modal.
function KpiPeriodChips({ range, setRange, theme, darkMode, expanded, exclude }) {
  const size = expanded ? "px-3 py-1.5 text-xs" : "px-2.5 py-1 text-[11px]";
  const excludeSet = new Set(exclude || []);
  const periods = KPI_PERIODS.filter(p => !excludeSet.has(p.id));
  return (
    <div className={`flex items-center gap-1 p-1 rounded-full overflow-x-auto no-scrollbar ${
      darkMode ? "bg-slate-800" : "bg-slate-100"
    }`}>
      {periods.map(p => {
        const active = range === p.id;
        return (
          <button key={p.id} onClick={() => setRange(p.id)}
            className={`${size} rounded-full font-semibold whitespace-nowrap transition ${
              active ? "bg-violet-500 text-white" : theme.textMuted
            }`}>
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function NetWorthChart({ theme, darkMode, variant = "hero" }) {
  // variant "hero"  → mobile-style gradient card
  // variant "card"  → desktop surface card
  const [range, setRange] = useState("all");
  const [data, setData] = useState({ points: [], current: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getNetWorthHistory(range)
      .then(r => { if (!cancelled) { setData(r); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range]);

  const points = data.points || [];
  const first = points[0]?.net ?? 0;
  const last = points[points.length - 1]?.net ?? data.current ?? 0;
  const delta = last - first;
  const deltaUp = delta >= 0;
  const min = points.length ? Math.min(...points.map(p => p.net)) : 0;
  const max = points.length ? Math.max(...points.map(p => p.net)) : 0;
  const padding = Math.max((max - min) * 0.1, 100);

  const isHero = variant === "hero";

  // Period chip pill row
  const chips = (
    <div className={`flex items-center gap-1 p-1 rounded-full overflow-x-auto no-scrollbar ${
      isHero ? "bg-white/15 backdrop-blur-sm" : (darkMode ? "bg-slate-800" : "bg-slate-100")
    }`}>
      {NET_PERIODS.map(p => {
        const active = range === p.id;
        return (
          <button key={p.id} onClick={() => setRange(p.id)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap transition ${
              active
                ? (isHero ? "bg-white text-violet-700" : "bg-violet-500 text-white")
                : (isHero ? "text-white/85" : theme.textMuted)
            }`}>
            {p.label}
          </button>
        );
      })}
    </div>
  );

  const tipStyle = {
    borderRadius: "12px",
    border: `1px solid ${theme.tooltipBorder}`,
    backgroundColor: theme.tooltipBg,
    color: darkMode ? "#f1f5f9" : "#0f172a",
    fontSize: 12,
  };

  if (isHero) {
    return (
      <div className="relative rounded-3xl bg-gradient-to-br from-violet-400 via-violet-500 to-violet-700 p-5 text-white shadow-xl shadow-violet-500/30 overflow-hidden">
        <div className="relative">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-90">Net Worth</div>
          <div className="text-[40px] leading-none font-bold mt-1.5 tracking-tight private-amount" tabIndex={0}>
            <AnimatedNumber value={last} format={fmt} />
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <div className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-white/25 backdrop-blur-sm private-amount" tabIndex={0}>
              <ArrowUpRight className={`w-3.5 h-3.5 ${deltaUp ? "" : "rotate-90"}`} />
              {deltaUp ? "+" : ""}{fmtShort(delta)}
            </div>
            <span className="text-xs opacity-85">over {range.toUpperCase()}</span>
          </div>
        </div>
        <div className="relative h-24 -mx-5 -mb-5 mt-4 private-chart" tabIndex={0}>
          {points.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="heroNetFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="#fff" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#fff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <YAxis hide domain={[min - padding, max + padding]} />
                <Area type="monotone" dataKey="net" stroke="#fff" strokeWidth={2}
                      fill="url(#heroNetFill)" isAnimationActive={!loading} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-xs opacity-70">
              {loading ? "Loading…" : "Not enough history yet"}
            </div>
          )}
        </div>
        <div className="relative mt-3">{chips}</div>
      </div>
    );
  }

  // Desktop card variant
  return (
    <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
      className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
      <div className="flex items-start justify-between mb-3 gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold">Net Worth</h3>
          <div className="text-3xl font-bold mt-1 private-amount" tabIndex={0}>
            <AnimatedNumber value={last} format={fmt} />
          </div>
          <div className={`text-xs mt-1 flex items-center gap-1.5 ${deltaUp ? "text-emerald-500" : "text-rose-500"}`}>
            <ArrowUpRight className={`w-3.5 h-3.5 ${deltaUp ? "" : "rotate-90"}`} />
            <span className="font-semibold private-amount" tabIndex={0}>{deltaUp ? "+" : ""}{fmt(delta)}</span>
            <span className={theme.textSubtle}>over {range.toUpperCase()}</span>
          </div>
        </div>
        {chips}
      </div>
      <div className="h-52 private-chart" tabIndex={0}>
        {points.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points}>
              <defs>
                <linearGradient id="netFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#10b981" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke={theme.chartAxis}
                     tickFormatter={d => d.slice(5)} minTickGap={40} />
              <YAxis tick={{ fontSize: 11 }} stroke={theme.chartAxis}
                     tickFormatter={fmtShort} domain={[min - padding, max + padding]} />
              <Tooltip contentStyle={tipStyle} formatter={v => fmt(v)} />
              <Area type="monotone" dataKey="net" stroke="#10b981" strokeWidth={2}
                    fill="url(#netFill)" isAnimationActive={!loading} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className={`h-full flex items-center justify-center text-sm ${theme.textSubtle}`}>
            {loading ? "Loading…" : "Not enough history yet — sync more transactions"}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Mobile Spending Pulse (hero summary card) ────────────────────────────────
function MobileSpendingPulse({ byCategory, cashflow, theme, darkMode }) {
  const lastMonth = cashflow?.[cashflow.length - 1];
  const thisSpend = Number(lastMonth?.spending || 0);
  const prevSpend = Number(cashflow?.[cashflow.length - 2]?.spending || 0);
  const delta = thisSpend - prevSpend;
  const down = delta <= 0;

  const totalCat = byCategory.reduce((s, c) => s + Number(c.total || 0), 0) || 1;
  const FALLBACK = ["#10b981","#f59e0b","#8b5cf6","#3b82f6","#ec4899"];
  const top = byCategory.slice(0, 5).map((c, i) => ({
    name: c.category,
    value: Number(c.total || 0),
    pct: (Number(c.total || 0) / totalCat) * 100,
    color: CAT_COLORS[c.category] || FALLBACK[i % FALLBACK.length],
  }));

  return (
    <div className={`${theme.surface} rounded-3xl border ${theme.border} p-5 shadow-sm`}>
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${theme.textSubtle}`}>This Month</div>
          <div className="text-2xl font-bold mt-1 private-amount" tabIndex={0}>
            <AnimatedNumber value={thisSpend} format={fmt} />
          </div>
        </div>
        {top.length > 0 && (
          <div className={`flex items-center gap-0.5 text-xs font-semibold px-2 py-1 rounded-full private-amount ${
            down ? (darkMode ? "bg-emerald-500/15 text-emerald-400" : "bg-emerald-50 text-emerald-700")
                 : (darkMode ? "bg-rose-500/15 text-rose-400" : "bg-rose-50 text-rose-700")
          }`} tabIndex={0}>
            <ArrowUpRight className={`w-3 h-3 ${down ? "rotate-90" : ""}`} />
            {down ? "" : "+"}{fmtShort(delta)}
          </div>
        )}
      </div>

      {top.length > 0 ? (
        <>
          <div className={`flex h-2.5 rounded-full overflow-hidden private-chart ${darkMode ? "bg-slate-800" : "bg-slate-100"}`} tabIndex={0}>
            {top.map((c, i) => (
              <motion.div key={c.name}
                initial={{ width: 0 }}
                animate={{ width: `${c.pct}%` }}
                transition={{ duration: 1, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                style={{ background: c.color }} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4">
            {top.slice(0, 4).map(c => (
              <div key={c.name} className="flex items-center gap-2 text-xs">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: c.color }} />
                <span className={`flex-1 truncate ${theme.textMuted}`}>{c.name}</span>
                <span className="font-semibold private-amount" tabIndex={0}>{fmtShort(c.value)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={`text-sm ${theme.textSubtle} text-center py-4`}>Connect a bank to see your spending pulse.</div>
      )}
    </div>
  );
}

// ─── Mobile Insights (conversational cards) ───────────────────────────────────
function MobileInsights({ cashflow, budgets, theme, darkMode }) {
  const insights = [];
  const last = cashflow?.[cashflow.length - 1];
  const prev = cashflow?.[cashflow.length - 2];
  if (last && prev) {
    const lastSpend = Number(last.spending || 0);
    const prevSpend = Number(prev.spending || 0);
    const lastIncome = Number(last.income || 0);
    if (lastSpend < prevSpend && prevSpend > 0) {
      insights.push({
        title: "Spending is down",
        body: `You've spent ${fmtShort(prevSpend - lastSpend)} less than last month — nice work.`,
        icon: TrendingUp, color: "emerald",
      });
    }
    if (lastIncome > lastSpend && lastIncome > 0) {
      insights.push({
        title: "You're in the green",
        body: `Saving roughly ${fmtShort(lastIncome - lastSpend)} this month.`,
        icon: DollarSign, color: "sky",
      });
    }
  }
  const over = (budgets || []).filter(b => Number(b.spent) > Number(b.amount));
  if (over.length > 0) {
    insights.push({
      title: `${over.length} budget${over.length > 1 ? "s" : ""} over limit`,
      body: `${over[0].category}${over.length > 1 ? ` and ${over.length - 1} more` : ""} need a look.`,
      icon: AlertCircle, color: "amber",
    });
  }
  if (insights.length === 0) return null;

  const palette = {
    emerald: { bg: darkMode ? "bg-emerald-500/15" : "bg-emerald-50", text: "text-emerald-600 dark:text-emerald-400", strip: "bg-emerald-500" },
    sky:     { bg: darkMode ? "bg-sky-500/15"     : "bg-sky-50",     text: "text-sky-600 dark:text-sky-400",         strip: "bg-sky-500"     },
    amber:   { bg: darkMode ? "bg-amber-500/15"   : "bg-amber-50",   text: "text-amber-600 dark:text-amber-400",     strip: "bg-amber-500"   },
  };

  return (
    <div className="space-y-2">
      {insights.slice(0, 3).map((ins, i) => {
        const c = palette[ins.color];
        const Icon = ins.icon;
        return (
          <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className={`${theme.surface} rounded-2xl border ${theme.border} p-3.5 flex gap-3 items-start relative overflow-hidden`}>
            <div className={`absolute left-0 top-0 bottom-0 w-1 ${c.strip}`} />
            <div className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center ${c.bg} ml-1.5`}>
              <Icon className={`w-4 h-4 ${c.text}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{ins.title}</div>
              <div className={`text-xs mt-0.5 private-amount ${theme.textMuted}`} tabIndex={0}>{ins.body}</div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Cashflow card ────────────────────────────────────────────────────────────
// Desktop-only KPI (mobile has its own MobileSpendingPulse). Owns its
// period-chip state and re-fetches on chip change. When `expanded` is
// true, the chart body swells to fill the fullscreen modal.
function CashflowCard({ theme, darkMode, expanded, onExpand, showForecast, onForecastToggle }) {
  const [range, setRange] = useState("1y");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAddOneOff, setShowAddOneOff] = useState(false);
  // Number of forecast months to request. Capped at 3 across both the
  // compact and expanded views — beyond a quarter the projection is
  // dominated by uncertainty (bill amount drift, salary changes) and
  // stops being useful.
  const forecastMonths = showForecast ? 3 : 0;
  const reload = useCallback(() => {
    let alive = true;
    setLoading(true);
    api.getCashflow({ ...kpiRangeToDates(range), ...(forecastMonths ? { forecastMonths } : {}) })
      .then(r => { if (alive) { setRows(Array.isArray(r) ? r : []); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range, forecastMonths]);
  useEffect(() => { return reload(); }, [reload]);
  // Split each month into (income, spending) + (forecastIncome,
  // forecastSpending). Recharts renders both series with different
  // stroke styles so past + future read as one continuous shape.
  const data = rows.map(c => {
    const isForecast = !!c.forecast;
    return {
      month: (c.month || "").slice(5) || c.month,
      income: isForecast ? null : Number(c.income),
      spending: isForecast ? null : Number(c.spending),
      forecastIncome:   isForecast ? Number(c.income)   : null,
      forecastSpending: isForecast ? Number(c.spending) : null,
      _forecast: isForecast,
    };
  });
  // For a seamless join between historic and forecast, duplicate the
  // last historic point into the forecast series so its dashed line
  // starts from that vertex (otherwise Recharts leaves a gap).
  const bridgeIdx = data.findIndex(d => d._forecast);
  if (bridgeIdx > 0) {
    const prev = data[bridgeIdx - 1];
    prev.forecastIncome   = prev.income;
    prev.forecastSpending = prev.spending;
  }
  const tipStyle = {
    borderRadius: "12px",
    border: `1px solid ${theme.tooltipBorder}`,
    backgroundColor: theme.tooltipBg,
    color: darkMode ? "#f1f5f9" : "#0f172a",
  };
  const chartH = expanded ? "h-[62vh]" : "h-52";
  return (
    <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h3 className="font-semibold">Cashflow</h3>
          <p className={`text-xs ${theme.textSubtle}`}>
            Income vs spending
            {showForecast && forecastMonths > 0 && <> · <span className="opacity-70">dashed = forecast</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <KpiPeriodChips range={range} setRange={setRange} theme={theme} darkMode={darkMode} expanded={expanded} exclude={["mtd"]} />
          {/* One-off adjustment: opens the schedule form so the user can
              add an expected inflow / outflow the forecast doesn't know
              about yet. Manual fallback for the auto-forecast. */}
          <button type="button" onClick={() => setShowAddOneOff(true)}
            title="Add a one-off future adjustment"
            className={`hidden lg:inline-flex p-1.5 rounded-lg border ${theme.border} ${theme.hover}`}>
            <Plus className="w-3.5 h-3.5" />
          </button>
          {/* Toggle for the forecast overlay. Persisted to the user row
              so it's remembered across devices. */}
          {onForecastToggle && (
            <button type="button" onClick={onForecastToggle}
              title={showForecast ? "Hide forecast" : "Show forecast"}
              className={`hidden lg:inline-flex p-1.5 rounded-lg border ${theme.border} ${theme.hover} ${
                showForecast ? "text-violet-500" : theme.textMuted
              }`}>
              <Sparkles className="w-3.5 h-3.5" />
            </button>
          )}
          {!expanded && onExpand && (
            <button type="button" onClick={onExpand}
              title="Expand"
              className={`hidden lg:inline-flex p-1.5 rounded-lg border ${theme.border} ${theme.hover}`}>
              <ChevronRight className="w-3.5 h-3.5 -rotate-45" />
            </button>
          )}
        </div>
      </div>
      {data.length > 0 ? (
        <div className={`${chartH} private-chart`} tabIndex={0}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id={`gInc-${expanded ? "big" : "small"}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id={`gSpd-${expanded ? "big" : "small"}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke={theme.chartAxis} />
              <YAxis tick={{ fontSize: 11 }} stroke={theme.chartAxis} tickFormatter={fmtShort} />
              <Tooltip contentStyle={tipStyle} formatter={v => v == null ? "—" : fmt(v)} />
              <Area type="monotone" dataKey="income"   stroke="#10b981" fill={`url(#gInc-${expanded ? "big" : "small"})`} strokeWidth={2} isAnimationActive={!loading} connectNulls={false} />
              <Area type="monotone" dataKey="spending" stroke="#f43f5e" fill={`url(#gSpd-${expanded ? "big" : "small"})`} strokeWidth={2} isAnimationActive={!loading} connectNulls={false} />
              {showForecast && forecastMonths > 0 && (
                <>
                  <Area type="monotone" dataKey="forecastIncome"   stroke="#10b981" strokeDasharray="5 4" strokeOpacity={0.8} fill="transparent" strokeWidth={2} isAnimationActive={!loading} connectNulls={false} />
                  <Area type="monotone" dataKey="forecastSpending" stroke="#f43f5e" strokeDasharray="5 4" strokeOpacity={0.8} fill="transparent" strokeWidth={2} isAnimationActive={!loading} connectNulls={false} />
                </>
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className={`${chartH} flex items-center justify-center text-sm ${theme.textSubtle}`}>
          {loading ? "Loading…" : "No cashflow data in this range"}
        </div>
      )}
      <OneOffAdjustmentSheet open={showAddOneOff}
        onClose={() => setShowAddOneOff(false)}
        onSaved={() => { setShowAddOneOff(false); reload(); }}
        theme={theme} darkMode={darkMode} />
    </div>
  );
}

// ─── One-off future cashflow adjustment ───────────────────────────────────────
// Manual fallback for the forecast overlay. Creates a scheduled transaction
// with a "[Forecast]" tag so the user can find + delete these later. Uses
// the existing scheduled endpoint — no new backend surface.
function OneOffAdjustmentSheet({ open, onClose, onSaved, theme, darkMode }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ date: today, label: "", amount: "", direction: "out" });
  const [saving, setSaving] = useState(false);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  useEffect(() => {
    if (!open) return;
    setForm({ date: today, label: "", amount: "", direction: "out" });
  }, [open]);

  const save = async () => {
    if (!form.label.trim() || !form.amount) return;
    setSaving(true);
    try {
      const signed = (form.direction === "in" ? 1 : -1) * Math.abs(Number(form.amount));
      await api.createScheduledTransaction({
        date: form.date,
        merchant: `${form.label.trim()} [Forecast]`,
        category: form.direction === "in" ? "Other Income" : "Other",
        amount: signed,
      });
      onSaved?.();
    } catch {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="One-off adjustment" theme={theme}>
      <div className="space-y-3">
        <p className={`text-xs ${theme.textSubtle}`}>
          Add an expected inflow or outflow the forecast doesn't know about.
          Saved as a scheduled transaction; delete it any time.
        </p>
        <div className="grid grid-cols-2 gap-2 p-1 rounded-full bg-slate-100 dark:bg-slate-800">
          {["out", "in"].map(dir => (
            <button key={dir} onClick={() => setForm({ ...form, direction: dir })}
              className={`py-1.5 rounded-full text-xs font-semibold ${
                form.direction === dir
                  ? (dir === "in" ? "bg-violet-500 text-white" : "bg-rose-500 text-white")
                  : "text-slate-500"
              }`}>
              {dir === "in" ? "Inflow" : "Outflow"}
            </button>
          ))}
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Label</label>
          <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })}
            placeholder="Bonus, refund, one-off bill…" className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Amount</label>
            <input type="number" step="0.01" value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00" className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Date</label>
            <input type="date" value={form.date}
              onChange={e => setForm({ ...form, date: e.target.value })}
              className={inputCls} />
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving || !form.label.trim() || !form.amount}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ─── Spending-by-category card ────────────────────────────────────────────────
// Desktop-only, period + sort chip row. Sort options: "largest" (default,
// biggest categories first) and "smallest" for hunt-the-outlier use.
const CAT_KPI_COLORS = ["#10b981","#f59e0b","#8b5cf6","#3b82f6","#ec4899","#64748b","#14b8a6","#f97316"];
function SpendingByCategoryCard({ theme, darkMode, expanded, onExpand }) {
  const [range, setRange] = useState("1m");
  const [sortDir, setSortDir] = useState("largest");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [groupBy, setGroupBy] = useState("category"); // "category" | "group"
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.getByCategory(kpiRangeToDates(range))
      .then(r => { if (alive) { setRows(Array.isArray(r) ? r : []); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range]);
  const tipStyle = {
    borderRadius: "12px",
    border: `1px solid ${theme.tooltipBorder}`,
    backgroundColor: theme.tooltipBg,
    color: darkMode ? "#f1f5f9" : "#0f172a",
  };
  const sorted = useMemo(() => {
    let arr;
    if (groupBy === "group") {
      // Roll up leaf categories under their group_name (falling back to
      // the leaf category name for ungrouped rows).
      const agg = new Map();
      for (const r of rows) {
        const key = r.groupName || r.category;
        agg.set(key, (agg.get(key) || 0) + Number(r.total));
      }
      arr = [...agg.entries()].map(([name, value]) => ({ name, value }));
    } else {
      arr = [...rows].map(r => ({ name: r.category, value: Number(r.total) }));
    }
    arr.sort((a, b) => sortDir === "largest" ? b.value - a.value : a.value - b.value);
    return arr.map((r, i) => ({ ...r, color: CAT_KPI_COLORS[i % CAT_KPI_COLORS.length] }));
  }, [rows, sortDir, groupBy]);
  // Detect whether any groups exist to know if we should offer the toggle.
  const hasGroups = useMemo(() => rows.some(r => r.groupName), [rows]);
  const pieData = sorted.slice(0, expanded ? 10 : 6);
  const listData = sorted.slice(0, expanded ? 12 : 4);
  const chartH = expanded ? "h-[52vh]" : "h-36";
  return (
    <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <h3 className="font-semibold">Spending by category</h3>
        <div className="flex items-center gap-2">
          <KpiPeriodChips range={range} setRange={setRange} theme={theme} darkMode={darkMode} expanded={expanded} />
          {!expanded && onExpand && (
            <button type="button" onClick={onExpand}
              title="Expand"
              className={`hidden lg:inline-flex p-1.5 rounded-lg border ${theme.border} ${theme.hover}`}>
              <ChevronRight className="w-3.5 h-3.5 -rotate-45" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
          {sortDir === "largest" ? "Largest first" : "Smallest first"}
        </div>
        <div className="flex items-center gap-2">
          {hasGroups && (
            <div className={`flex items-center gap-1 p-0.5 rounded-full ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
              <button onClick={() => setGroupBy("category")}
                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${groupBy === "category" ? "bg-violet-500 text-white" : theme.textMuted}`}>
                Categories
              </button>
              <button onClick={() => setGroupBy("group")}
                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${groupBy === "group" ? "bg-violet-500 text-white" : theme.textMuted}`}>
                Groups
              </button>
            </div>
          )}
          <div className={`flex items-center gap-1 p-0.5 rounded-full ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
            <button onClick={() => setSortDir("largest")}
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${sortDir === "largest" ? "bg-violet-500 text-white" : theme.textMuted}`}>
              Largest
            </button>
            <button onClick={() => setSortDir("smallest")}
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${sortDir === "smallest" ? "bg-violet-500 text-white" : theme.textMuted}`}>
              Smallest
            </button>
          </div>
        </div>
      </div>
      {pieData.length > 0 ? (
        <>
          <div className={`${chartH} private-chart`} tabIndex={0}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                     innerRadius={expanded ? 90 : 35} outerRadius={expanded ? 180 : 62} paddingAngle={2}
                     isAnimationActive={!loading}>
                  {pieData.map((c, i) => <Cell key={i} fill={c.color} />)}
                </Pie>
                <Tooltip contentStyle={tipStyle} formatter={v => fmt(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-2 mt-3">
            {listData.map(c => (
              <div key={c.name} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: c.color }} />
                  <span className={theme.textMuted}>{c.name}</span>
                </span>
                <span className="font-semibold private-amount" tabIndex={0}>{fmt(c.value)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={`${chartH} flex items-center justify-center text-sm ${theme.textSubtle}`}>
          {loading ? "Loading…" : "No spending in this range"}
        </div>
      )}
    </div>
  );
}

// ─── KPI fullscreen modal ─────────────────────────────────────────────────────
// Desktop-only. Wraps a card component in a centered overlay so the chart
// fills most of the viewport. Escape / backdrop click closes.
function KpiFullscreenModal({ kind, onClose, theme, darkMode, showForecast, onForecastToggle }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!kind) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6"
      onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <button type="button" onClick={onClose}
          className={`absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full ${theme.surface} border ${theme.border} flex items-center justify-center shadow-lg`}>
          <X className="w-4 h-4" />
        </button>
        {kind === "cashflow" && <CashflowCard theme={theme} darkMode={darkMode} expanded
          showForecast={showForecast} onForecastToggle={onForecastToggle} />}
        {kind === "spending" && <SpendingByCategoryCard theme={theme} darkMode={darkMode} expanded />}
        {kind === "networth" && <NetWorthChart theme={theme} darkMode={darkMode} variant="card" />}
      </div>
    </div>,
    document.body
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ theme, darkMode, onNavigate }) {
  const { summary, cashflow, byCategory, transactions, budgets } = useData();
  const { user: authUser, refresh: refreshUser } = useAuth();
  const net  = Number(summary?.netWorth   || 0);
  const cash = Number(summary?.cash       || 0);
  const cred = Number(summary?.credit     || 0);
  const inv  = Number(summary?.investment || 0);

  // Desktop KPI expand — "cashflow" | "spending" | "networth" | null.
  // Mobile falls through to inline behaviour (no modal).
  const [expandedKpi, setExpandedKpi] = useState(null);
  // Cashflow forecast visibility — sourced from the user row and toggled
  // via PATCH /auth/me. Local optimistic state so the toggle feels
  // instant; refreshUser syncs the truth after the round trip.
  const [showForecast, setShowForecast] = useState(!!authUser?.show_cashflow_forecast);
  useEffect(() => { setShowForecast(!!authUser?.show_cashflow_forecast); }, [authUser?.show_cashflow_forecast]);
  const toggleForecast = async () => {
    const next = !showForecast;
    setShowForecast(next);
    try {
      await api.updateMe({ show_cashflow_forecast: next });
      refreshUser?.();
    } catch { setShowForecast(!next); }
  };

  return (
    <motion.div initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.06 } } }} className="space-y-4 lg:space-y-6">

      {/* Net Worth hero — mobile (interactive chart with period selector) */}
      <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="lg:hidden">
        <NetWorthChart theme={theme} darkMode={darkMode} variant="hero" />
      </motion.div>

      {/* Net Worth chart — desktop (card with period selector).
          Wrapped in a button so tap-anywhere on the card body opens the
          fullscreen modal. The card's own chip clicks stopPropagation so
          they don't also trigger expand. */}
      <div className="hidden lg:block relative group">
        <div onClick={(e) => {
          // Ignore clicks that came from the period chip row.
          if (e.target.closest("button")) return;
          setExpandedKpi("networth");
        }} className="cursor-pointer">
          <NetWorthChart theme={theme} darkMode={darkMode} variant="card" />
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Cash"         value={cash}        icon={Wallet}      color="emerald" theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Credit Used"  value={Math.abs(cred)} icon={CreditCard} color="amber" negative theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Investments"  value={inv}         icon={TrendingUp}  color="sky"    theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Net Worth"    value={net}         icon={DollarSign}  color="violet" theme={theme} darkMode={darkMode} onClick={() => {}} />
      </div>

      {/* Spending Pulse — mobile only */}
      <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="lg:hidden">
        <MobileSpendingPulse byCategory={byCategory} cashflow={cashflow} theme={theme} darkMode={darkMode} />
      </motion.div>

      {/* Insights — mobile only */}
      <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="lg:hidden">
        <MobileInsights cashflow={cashflow} budgets={budgets} theme={theme} darkMode={darkMode} />
      </motion.div>

      {/* Charts — desktop only (mobile gets Spending Pulse instead).
          Both cards own their period-chip state and re-fetch on chip
          change; tap anywhere outside the chips or expand button to
          open the fullscreen modal. */}
      <div className="hidden lg:grid lg:grid-cols-3 gap-4">
        <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
          className="lg:col-span-2">
          <div onClick={(e) => {
            if (e.target.closest("button")) return;
            setExpandedKpi("cashflow");
          }} className="cursor-pointer">
            <CashflowCard theme={theme} darkMode={darkMode}
              onExpand={() => setExpandedKpi("cashflow")}
              showForecast={showForecast} onForecastToggle={toggleForecast} />
          </div>
        </motion.div>

        <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}>
          <div onClick={(e) => {
            if (e.target.closest("button")) return;
            setExpandedKpi("spending");
          }} className="cursor-pointer">
            <SpendingByCategoryCard theme={theme} darkMode={darkMode} onExpand={() => setExpandedKpi("spending")} />
          </div>
        </motion.div>
      </div>

      <KpiFullscreenModal kind={expandedKpi} onClose={() => setExpandedKpi(null)}
        theme={theme} darkMode={darkMode}
        showForecast={showForecast} onForecastToggle={toggleForecast} />

      {/* Quick access */}
      <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}>
        <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2 px-1`}>Quick Access</div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Budgets",  icon: PieChartIcon, color: darkMode ? "bg-violet-500/15 text-violet-400" : "bg-violet-50 text-violet-600", tab: "budgets" },
            { label: "Goals",    icon: Target,       color: darkMode ? "bg-amber-500/15 text-amber-400"   : "bg-amber-50 text-amber-600",   tab: "goals"   },
            { label: "Notes",    icon: FileText,     color: darkMode ? "bg-sky-500/15 text-sky-400"       : "bg-sky-50 text-sky-600",       tab: "notes"   },
          ].map(item => (
            <motion.button key={item.tab} whileTap={{ scale: 0.95 }} whileHover={{ y: -2 }}
              onClick={() => onNavigate(item.tab)}
              className={`${theme.surface} rounded-2xl border ${theme.border} p-4 text-left`}>
              <div className={`w-10 h-10 rounded-xl ${item.color} flex items-center justify-center mb-2`}>
                <item.icon className="w-5 h-5" />
              </div>
              <div className="font-semibold text-sm">{item.label}</div>
            </motion.button>
          ))}
        </div>
      </motion.div>

      {/* Recent transactions */}
      <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
        className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
        <div className={`px-5 py-4 border-b ${theme.border} flex items-center justify-between`}>
          <h3 className="font-semibold">Recent transactions</h3>
          <button onClick={() => onNavigate("transactions")} className="text-xs font-medium text-violet-500">View all →</button>
        </div>
        <div className={`divide-y ${theme.divide}`}>
          {transactions.slice(0, 8).map(t => {
            const Icon = CAT_ICONS[t.category] || Briefcase;
            const color = CAT_COLORS[t.category] || "#64748b";
            return (
              <div key={t.id} className={`flex items-center gap-3 px-5 py-3 ${theme.hover} transition-colors`}>
                <div className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                  <Icon className="w-4 h-4" style={{ color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className="font-medium text-sm truncate">{t.merchant}</div>
                    <PendingPill pending={t.pending} darkMode={darkMode} />
                    <TransferPill isTransfer={t.isTransfer} darkMode={darkMode} />
                    <AutomationErrorPill hasError={t.hasAutomationError} darkMode={darkMode} />
                  </div>
                  <div className={`text-xs ${theme.textSubtle}`}>{t.date} · {t.category}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <ReceiptMarker hasAttachment={t.hasAttachment} />
                  <div className={`font-semibold text-sm private-amount ${
                    t.isTransfer ? "text-sky-500" : Number(t.amount) >= 0 ? "text-emerald-500" : ""
                  }`} tabIndex={0}>
                    {t.isTransfer ? "±" : Number(t.amount) >= 0 ? "+" : "−"}{fmt(Math.abs(Number(t.amount)))}
                  </div>
                </div>
              </div>
            );
          })}
          {transactions.length === 0 && (
            <div className={`px-5 py-8 text-center text-sm ${theme.textSubtle}`}>
              No transactions yet — connect a bank to get started.
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Tax categories panel (Settings > Data) ───────────────────────────────────
// Compact per-category IRS Schedule mapper. Any category with a schedule
// set will have its transactions rolled into the year-end tax PDF for that
// schedule. Individual transactions can be flagged deductible separately
// via the detail sheet (they roll to Schedule A when no category schedule).
const TAX_SCHEDULES = [
  { code: "",  label: "— none —"  },
  { code: "A", label: "A · Itemized deductions" },
  { code: "B", label: "B · Interest & dividends" },
  { code: "C", label: "C · Business" },
  { code: "D", label: "D · Capital gains" },
  { code: "E", label: "E · Rental / royalty" },
];
function TaxCategoriesPanel({ theme, darkMode, toast }) {
  const [cats, setCats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    try { setCats(await api.getCategories()); }
    catch { toast?.("Failed to load categories", "error"); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const setSchedule = async (cat, code) => {
    setSavingId(cat.id);
    try {
      await api.updateCategory(cat.id, { tax_schedule: code || null });
      setCats(prev => prev.map(c => c.id === cat.id ? { ...c, taxSchedule: code || null } : c));
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSavingId(null); }
  };

  const setGroup = async (cat, name) => {
    setSavingId(cat.id);
    try {
      await api.updateCategory(cat.id, { group_name: name });
      setCats(prev => prev.map(c => c.id === cat.id ? { ...c, groupName: name || null } : c));
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSavingId(null); }
  };
  const setParent = async (cat, parentId) => {
    setSavingId(cat.id);
    try {
      await api.updateCategory(cat.id, { parent_id: parentId || null });
      setCats(prev => prev.map(c => c.id === cat.id ? { ...c, parentId: parentId || null } : c));
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSavingId(null); }
  };

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-3`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Categories</h3>
        <a href="#" onClick={e => { e.preventDefault(); api.exportTaxSummaryPDF(); }}
          className={`text-xs ${theme.textSubtle} hover:text-violet-500`}>
          Download year-to-date tax PDF
        </a>
      </div>
      <p className={`text-xs ${theme.textSubtle}`}>
        Schedule maps a category to an IRS bucket for the year-end tax PDF. Group rolls
        multiple categories into one line on the byCategory pie ("Groceries" + "Restaurants" → "Food")
        without affecting budgets or rules.
      </p>
      {loading ? (
        <div className={`text-xs ${theme.textSubtle}`}>Loading…</div>
      ) : (
        <div className={`rounded-2xl border ${theme.border} max-h-72 overflow-y-auto divide-y ${theme.divide}`}>
          {cats.map(c => (
            <div key={c.id} className="flex items-center gap-2 px-3 py-2">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: c.color }} />
              <div className={`flex-1 text-sm font-medium truncate ${c.parentId ? "pl-3" : ""}`}>
                {c.parentId && <span className={theme.textSubtle}>↳ </span>}
                {c.name}
              </div>
              <select value={c.parentId || ""} disabled={savingId === c.id}
                onChange={e => setParent(c, Number(e.target.value) || null)}
                title="Parent category (makes this a subcategory)"
                className={`text-xs px-2 py-1 rounded-lg ${theme.inputBg} border ${theme.border} focus:outline-none focus:border-violet-500 max-w-[8rem]`}>
                <option value="">no parent</option>
                {cats.filter(x => x.id !== c.id && !x.parentId).map(x => (
                  <option key={x.id} value={x.id}>↳ {x.name}</option>
                ))}
              </select>
              <input placeholder="Group"
                defaultValue={c.groupName || ""}
                onBlur={e => { const v = e.target.value.trim(); if (v !== (c.groupName || "")) setGroup(c, v); }}
                className={`w-20 text-xs px-2 py-1 rounded-lg ${theme.inputBg} border ${theme.border} focus:outline-none focus:border-violet-500`} />
              <select value={c.taxSchedule || ""} disabled={savingId === c.id}
                onChange={e => setSchedule(c, e.target.value)}
                className={`text-xs px-2 py-1 rounded-lg ${theme.inputBg} border ${theme.border} focus:outline-none focus:border-violet-500`}>
                {TAX_SCHEDULES.map(s => (
                  <option key={s.code} value={s.code}>{s.label}</option>
                ))}
              </select>
            </div>
          ))}
          {cats.length === 0 && (
            <div className={`p-4 text-xs ${theme.textSubtle} text-center`}>
              No categories yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Assets panel (AccountsTab) ───────────────────────────────────────────────
// Non-account holdings that still contribute to net worth — vehicles,
// jewelry, art, collectibles, property. Support 3 depreciation methods:
//   none              → user maintains current_value manually
//   straight_line     → drops evenly from acquired → salvage over N years
//   declining_balance → drops by X%/yr on remaining value
// A "refresh depreciation" button snaps current_value to the projected
// value for today (server owns the compute).
const ASSET_KINDS = [
  { code: "vehicle",     label: "Vehicle" },
  { code: "boat",        label: "Boat" },
  { code: "jewelry",     label: "Jewelry" },
  { code: "art",         label: "Art" },
  { code: "collectible", label: "Collectible" },
  { code: "property",    label: "Property" },
  { code: "other",       label: "Other" },
];
function AssetsPanel({ theme, darkMode, toast, onChange }) {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [damageAsset, setDamageAsset] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setAssets(await api.listAssets()); }
    catch { toast?.("Failed to load assets", "error"); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const refresh = async (asset) => {
    try {
      await api.refreshAssetValue(asset.id);
      toast?.("Value refreshed to projected depreciation", "success");
      load(); onChange?.();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };
  const remove = async (asset) => {
    if (!window.confirm(`Archive "${asset.name}"?`)) return;
    try {
      await api.deleteAsset(asset.id);
      toast?.("Asset archived", "success");
      load(); onChange?.();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const total = assets.reduce((s, a) => s + Number(a.currentValue || 0), 0);

  return (
    <div className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
      <div className={`px-5 py-3.5 border-b ${theme.border} flex items-center justify-between`}>
        <div>
          <h3 className="font-semibold text-sm">Assets &amp; valuables</h3>
          <div className={`text-xs ${theme.textSubtle}`}>
            Total: <span className="private-amount" tabIndex={0}>{fmt(total)}</span> · counted in net worth
          </div>
        </div>
        <button type="button" onClick={() => { setEditing(null); setShowForm(true); }}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-violet-500 text-white hover:bg-violet-600 flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add asset
        </button>
      </div>
      {loading ? (
        <div className={`p-4 text-xs ${theme.textSubtle}`}>Loading…</div>
      ) : assets.length === 0 ? (
        <div className={`p-6 text-center text-xs ${theme.textSubtle}`}>
          No assets tracked. Add a car, boat, or valuable — it'll count toward net worth.
        </div>
      ) : (
        <div className={`divide-y ${theme.divide}`}>
          {assets.map(a => {
            const drop = Number(a.acquiredValue) - Number(a.currentValue);
            const dropPct = Number(a.acquiredValue) > 0
              ? Math.round((drop / Number(a.acquiredValue)) * 100) : 0;
            const projectedDiff = Number(a.projectedValue) - Number(a.currentValue);
            const drift = Math.abs(projectedDiff) >= 1;
            return (
              <div key={a.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{a.name}</div>
                  <div className={`text-xs ${theme.textSubtle}`}>
                    {(ASSET_KINDS.find(k => k.code === a.kind) || {}).label || "Other"} ·
                    Acquired {a.acquiredDate} at <span className="private-amount" tabIndex={0}>{fmt(a.acquiredValue)}</span>
                    {drop > 0 && <> · Down {dropPct}%</>}
                  </div>
                  {drift && a.depreciationMethod !== "none" && (
                    <div className={`text-[10px] mt-0.5 ${projectedDiff < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                      Projected {fmt(a.projectedValue)} today —
                      <button type="button" onClick={() => refresh(a)} className="ml-1 underline hover:text-violet-500">
                        refresh
                      </button>
                    </div>
                  )}
                  {a.damageEventCount > 0 && (
                    <div className="text-[10px] mt-0.5 text-rose-500">
                      {a.damageEventCount} damage {a.damageEventCount === 1 ? "event" : "events"} · −<span className="private-amount" tabIndex={0}>{fmt(a.damageTotal)}</span>
                    </div>
                  )}
                  {a.loanAccountId && (
                    <div className={`text-[10px] mt-0.5 ${theme.textSubtle}`}>
                      Loan: <span className="private-name" tabIndex={0}>{a.loanAccountName}</span> · owed <span className="private-amount" tabIndex={0}>{fmt(a.loanBalance)}</span>
                      {" · "}
                      <span className={`font-semibold ${Number(a.netPosition) >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                        net <span className="private-amount" tabIndex={0}>{fmt(a.netPosition)}</span>
                      </span>
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold private-amount" tabIndex={0}>{fmt(a.currentValue)}</div>
                  <div className="flex items-center gap-1 justify-end flex-wrap">
                    <button type="button" onClick={() => setDamageAsset(a)}
                      className={`text-[10px] ${theme.textSubtle} hover:text-rose-500`}>
                      Log damage
                    </button>
                    <button type="button" onClick={() => { setEditing(a); setShowForm(true); }}
                      className={`text-[10px] ${theme.textSubtle} hover:text-violet-500`}>
                      Edit
                    </button>
                    <button type="button" onClick={() => remove(a)}
                      className={`text-[10px] ${theme.textSubtle} hover:text-rose-500`}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <AssetFormSheet open={showForm} onClose={() => { setShowForm(false); setEditing(null); }}
        editing={editing} theme={theme} darkMode={darkMode} toast={toast}
        onSaved={() => { setShowForm(false); setEditing(null); load(); onChange?.(); }} />
      <AssetDamageSheet open={!!damageAsset} onClose={() => setDamageAsset(null)}
        asset={damageAsset} theme={theme} darkMode={darkMode} toast={toast}
        onChanged={() => { load(); onChange?.(); }} />
    </div>
  );
}

// ─── Import Preview Sheet ─────────────────────────────────────────────────────
// After a QIF/OFX/QFX/MNY file's preview_only pass, this sheet lists each
// account the file names and asks the user what to do with it: attach the
// transactions to an existing account, create a new one (name prefilled,
// editable), or skip those transactions entirely. Confirming submits the
// mapping to the backend for the real import.
function ImportPreviewSheet({ open, preview, accounts, theme, darkMode, onClose, onConfirm }) {
  const [decisions, setDecisions] = useState({});
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  useEffect(() => {
    if (!open || !preview?.accounts) return;
    // Seed defaults: for every named file-account, pre-select "create new"
    // with the file's name as the prefilled account name. Unnamed buckets
    // default to skip because the user hasn't been told what those are
    // yet — they can flip to "existing" or "create" from the sheet.
    const seed = {};
    for (const a of preview.accounts) {
      const key = a.name || "__unnamed__";
      seed[key] = a.name
        ? { action: "create", name: a.name, type: "cash" }
        : { action: "skip" };
    }
    setDecisions(seed);
  }, [open, preview]);

  if (!open || !preview) return null;
  const list = preview.accounts || [];

  const update = (key, patch) => {
    setDecisions(d => ({ ...d, [key]: { ...(d[key] || {}), ...patch } }));
  };

  const readyToSubmit = list.every(a => {
    const key = a.name || "__unnamed__";
    const d = decisions[key];
    if (!d) return false;
    if (d.action === "create") return !!d.name?.trim();
    if (d.action === "existing") return !!d.account_id;
    return true;
  });

  return (
    <Sheet open={open} onClose={onClose}
      title={`Import ${preview.format?.toUpperCase() || ""} — map ${list.length} account${list.length === 1 ? "" : "s"}`}
      theme={theme}>
      <div className="space-y-4">
        <div className={`text-xs ${theme.textSubtle}`}>
          {preview.totalTxns} transaction{preview.totalTxns === 1 ? "" : "s"} across {list.length} account{list.length === 1 ? "" : "s"}. Choose what to do with each.
        </div>
        {list.map((a) => {
          const key = a.name || "__unnamed__";
          const d = decisions[key] || {};
          return (
            <div key={key} className={`border ${theme.border} rounded-xl p-3 space-y-2`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">
                    {a.name || <span className={theme.textSubtle}>(unnamed / no account in file)</span>}
                  </div>
                  <div className={`text-[10px] ${theme.textSubtle}`}>
                    {a.txnCount} txn · {a.firstDate} → {a.lastDate}
                    {a.sampleMerchants?.length > 0 && (
                      <> · e.g. {a.sampleMerchants.slice(0, 3).join(", ")}</>
                    )}
                  </div>
                </div>
              </div>
              <div className={`flex items-center gap-1 p-0.5 rounded-full ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                {["create", "existing", "skip"].map(action => (
                  <button key={action} type="button"
                    onClick={() => update(key, { action })}
                    className={`flex-1 px-2 py-1 rounded-full text-[11px] font-semibold ${
                      d.action === action ? "bg-violet-500 text-white" : theme.textMuted
                    }`}>
                    {action === "create" ? "Create new" : action === "existing" ? "Map to existing" : "Skip"}
                  </button>
                ))}
              </div>
              {d.action === "create" && (
                <div className="grid grid-cols-3 gap-2">
                  <input className={`col-span-2 ${inputCls}`}
                    value={d.name || ""} placeholder="Account name"
                    onChange={e => update(key, { name: e.target.value })} />
                  <select className={inputCls}
                    value={d.type || "cash"}
                    onChange={e => update(key, { type: e.target.value })}>
                    <option value="cash">Cash</option>
                    <option value="credit">Credit</option>
                    <option value="investment">Investment</option>
                    <option value="loan">Loan</option>
                  </select>
                </div>
              )}
              {d.action === "existing" && (
                <select className={inputCls}
                  value={d.account_id || ""}
                  onChange={e => update(key, { account_id: Number(e.target.value) || null })}>
                  <option value="">— pick an account —</option>
                  {accounts.map(x => (
                    <option key={x.id} value={x.id}>
                      {x.name}{x.institution ? ` · ${x.institution}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
            Cancel
          </button>
          <button type="button" disabled={!readyToSubmit}
            onClick={() => onConfirm(decisions)}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-40">
            Import
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function AssetDamageSheet({ open, onClose, asset, theme, darkMode, toast, onChanged }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    event_date: new Date().toISOString().slice(0, 10),
    description: "",
    value_impact: "",
    kind: "damage",
  });
  const [saving, setSaving] = useState(false);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  useEffect(() => {
    if (!open || !asset) return;
    setForm({
      event_date: new Date().toISOString().slice(0, 10),
      description: "", value_impact: "", kind: "damage",
    });
    setLoading(true);
    api.listAssetDamage(asset.id)
      .then(setEvents)
      .catch(() => toast?.("Failed to load damage log", "error"))
      .finally(() => setLoading(false));
  }, [open, asset, toast]);

  const save = async () => {
    const raw = Number(form.value_impact);
    if (!form.description.trim() || !Number.isFinite(raw) || raw <= 0) {
      toast?.("Description and positive amount required", "error"); return;
    }
    // Damage subtracts value; repair adds it back (negative impact).
    const signed = form.kind === "repair" ? -raw : raw;
    setSaving(true);
    try {
      await api.logAssetDamage(asset.id, {
        event_date: form.event_date,
        description: form.description.trim(),
        value_impact: signed,
      });
      toast?.(form.kind === "repair" ? "Repair logged" : "Damage logged", "success");
      const list = await api.listAssetDamage(asset.id);
      setEvents(list);
      setForm({ ...form, description: "", value_impact: "" });
      onChanged?.();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };

  const remove = async (evt) => {
    if (!window.confirm(`Undo "${evt.description}"? Current value will be restored.`)) return;
    try {
      await api.deleteAssetDamage(evt.id);
      toast?.("Reverted", "success");
      const list = await api.listAssetDamage(asset.id);
      setEvents(list);
      onChanged?.();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  return (
    <Sheet open={open} onClose={onClose} title={asset ? `${asset.name} — damage log` : "Damage log"} theme={theme}>
      <div className="space-y-4">
        <div className={`text-xs ${theme.textSubtle}`}>
          Log damage (fender-bender, hail, scratch) to subtract value, or log a repair to add it back.
          The change flows into net worth and survives depreciation refreshes.
        </div>
        <div className={`${theme.inputBg} border ${theme.border} rounded-xl p-3 space-y-2`}>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={`text-[10px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Kind</label>
              <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })} className={inputCls}>
                <option value="damage">Damage (subtracts)</option>
                <option value="repair">Repair (adds back)</option>
              </select>
            </div>
            <div>
              <label className={`text-[10px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Date</label>
              <input type="date" value={form.event_date}
                onChange={e => setForm({ ...form, event_date: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={`text-[10px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Description</label>
            <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. Rear bumper repair estimate" className={inputCls} />
          </div>
          <div>
            <label className={`text-[10px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>
              {form.kind === "repair" ? "Value restored ($)" : "Value lost ($)"}
            </label>
            <input type="number" step="0.01" min="0" value={form.value_impact}
              onChange={e => setForm({ ...form, value_impact: e.target.value })} className={inputCls} />
          </div>
          <button type="button" onClick={save} disabled={saving}
            className={`w-full py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-60 ${
              form.kind === "repair" ? "bg-emerald-500 hover:bg-emerald-600" : "bg-rose-500 hover:bg-rose-600"
            }`}>
            {saving ? "Saving…" : form.kind === "repair" ? "Log repair" : "Log damage"}
          </button>
        </div>
        <div>
          <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>History</div>
          {loading ? (
            <div className={`text-xs ${theme.textSubtle}`}>Loading…</div>
          ) : events.length === 0 ? (
            <div className={`text-xs ${theme.textSubtle}`}>No damage or repairs logged yet.</div>
          ) : (
            <div className={`divide-y ${theme.divide} border ${theme.border} rounded-xl overflow-hidden`}>
              {events.map(e => {
                const isRepair = Number(e.valueImpact) < 0;
                return (
                  <div key={e.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{e.description}</div>
                      <div className={`text-[10px] ${theme.textSubtle}`}>{e.eventDate}</div>
                    </div>
                    <div className={`text-sm font-semibold private-amount ${isRepair ? "text-emerald-500" : "text-rose-500"}`} tabIndex={0}>
                      {isRepair ? "+" : "−"}{fmt(Math.abs(Number(e.valueImpact)))}
                    </div>
                    <button type="button" onClick={() => remove(e)}
                      className={`text-[10px] ${theme.textSubtle} hover:text-rose-500`}>
                      Undo
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function AssetFormSheet({ open, onClose, editing, theme, darkMode, toast, onSaved }) {
  const [form, setForm] = useState(() => defaultAssetForm());
  const [saving, setSaving] = useState(false);
  const [loanAccounts, setLoanAccounts] = useState([]);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  useEffect(() => {
    if (!open) return;
    // Load loan-type accounts the user could link.
    api.listEligibleAssetLoans().then(setLoanAccounts).catch(() => setLoanAccounts([]));
    if (editing) {
      setForm({
        name: editing.name || "", kind: editing.kind || "other",
        acquired_date: editing.acquiredDate?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        acquired_value: String(editing.acquiredValue ?? ""),
        current_value: String(editing.currentValue ?? ""),
        salvage_value: String(editing.salvageValue ?? "0"),
        useful_life_years: String(editing.usefulLifeYears ?? ""),
        depreciation_method: editing.depreciationMethod || "none",
        declining_rate: String(editing.decliningRate ?? "20"),
        notes: editing.notes || "",
        loan_account_id: editing.loanAccountId ? String(editing.loanAccountId) : "",
      });
    } else {
      setForm(defaultAssetForm());
    }
  }, [open, editing]);

  const save = async () => {
    if (!form.name.trim() || !(Number(form.acquired_value) >= 0)) {
      toast?.("Name and acquired value required", "error"); return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        acquired_value: Number(form.acquired_value),
        current_value: form.current_value ? Number(form.current_value) : Number(form.acquired_value),
        salvage_value: Number(form.salvage_value) || 0,
        useful_life_years: Number(form.useful_life_years) || 0,
        declining_rate: Number(form.declining_rate) || 20,
        // Empty string = unlink (null), otherwise coerce to number.
        loan_account_id: form.loan_account_id === "" ? null : Number(form.loan_account_id),
      };
      if (editing) await api.updateAsset(editing.id, payload);
      else await api.createAsset(payload);
      toast?.(editing ? "Asset updated" : "Asset added", "success");
      onSaved();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} title={editing ? "Edit asset" : "Add asset"} theme={theme}>
      <div className="space-y-3">
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Name</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Honda Civic" className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Kind</label>
            <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })} className={inputCls}>
              {ASSET_KINDS.map(k => <option key={k.code} value={k.code}>{k.label}</option>)}
            </select>
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Acquired date</label>
            <input type="date" value={form.acquired_date}
              onChange={e => setForm({ ...form, acquired_date: e.target.value })} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Acquired value</label>
            <input type="number" step="0.01" value={form.acquired_value}
              onChange={e => setForm({ ...form, acquired_value: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Current value</label>
            <input type="number" step="0.01" value={form.current_value}
              onChange={e => setForm({ ...form, current_value: e.target.value })} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Value curve</label>
          <select value={form.depreciation_method}
            onChange={e => setForm({ ...form, depreciation_method: e.target.value })} className={inputCls}>
            <option value="none">None — value stays put until I change it</option>
            <option value="straight_line">Depreciate straight-line — drops evenly to salvage over N years</option>
            <option value="declining_balance">Depreciate declining balance — X% off the remaining value each year</option>
            <option value="appreciating">Appreciate — grows X% per year (real estate, art, collectibles)</option>
          </select>
        </div>
        {form.depreciation_method === "straight_line" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Useful life (years)</label>
              <input type="number" step="0.5" value={form.useful_life_years}
                onChange={e => setForm({ ...form, useful_life_years: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Salvage value</label>
              <input type="number" step="0.01" value={form.salvage_value}
                onChange={e => setForm({ ...form, salvage_value: e.target.value })} className={inputCls} />
            </div>
          </div>
        )}
        {form.depreciation_method === "declining_balance" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Rate (% per year)</label>
              <input type="number" step="0.5" value={form.declining_rate}
                onChange={e => setForm({ ...form, declining_rate: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Salvage value</label>
              <input type="number" step="0.01" value={form.salvage_value}
                onChange={e => setForm({ ...form, salvage_value: e.target.value })} className={inputCls} />
            </div>
          </div>
        )}
        {form.depreciation_method === "appreciating" && (
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Growth rate (% per year)</label>
            <input type="number" step="0.5" value={form.declining_rate}
              onChange={e => setForm({ ...form, declining_rate: e.target.value })}
              placeholder="5" className={inputCls} />
            <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
              National residential real estate has averaged ~3–5% nominal per year over the last century; art and collectibles are much noisier.
            </div>
          </div>
        )}
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Notes</label>
          <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>
            Loan on this asset (optional)
          </label>
          {loanAccounts.length === 0 ? (
            <div className={`text-[11px] ${theme.textSubtle} px-3 py-2 border ${theme.border} rounded-xl`}>
              No loan-type accounts yet. Add one under Accounts → Add Manual (Type: Loan) to link it here.
            </div>
          ) : (
            <select value={form.loan_account_id}
              onChange={e => setForm({ ...form, loan_account_id: e.target.value })} className={inputCls}>
              <option value="">Not linked</option>
              {loanAccounts.map(l => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.institution ? ` · ${l.institution}` : ""} · owed {fmt(Math.abs(Number(l.balance) || 0))}
                </option>
              ))}
            </select>
          )}
          <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
            Linking shows a per-asset net position (asset value − amount owed). Net worth math is unchanged — both sides were already counted.
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>Cancel</button>
          <button type="button" onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Saving…" : editing ? "Save changes" : "Add asset"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function defaultAssetForm() {
  return {
    name: "", kind: "vehicle",
    acquired_date: new Date().toISOString().slice(0, 10),
    acquired_value: "", current_value: "",
    salvage_value: "0", useful_life_years: "5",
    depreciation_method: "none", declining_rate: "20",
    notes: "",
    loan_account_id: "",
  };
}

// ─── Custom Reports panel (Settings > Data) ───────────────────────────────────
// Pivot-style report builder: pick 1-2 dimensions, pick a measure, pick a
// side (all / expense / income), an optional date range, and hit Run. The
// server rolls the result up and returns a small table. Save-as-report
// bookmarks the current configuration for one-click re-runs.
const REPORT_DIMS = [
  { code: "category", label: "Category" },
  { code: "merchant", label: "Merchant" },
  { code: "account",  label: "Account" },
  { code: "month",    label: "Month" },
  { code: "year",     label: "Year" },
];
function CustomReportsPanel({ theme, darkMode, toast }) {
  const [config, setConfig] = useState({
    dimensions: ["category"], measure: "sum", side: "expense",
    from: "", to: "", credit: "exclude",
  });
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  const loadSaved = useCallback(async () => {
    try { setSaved(await api.listSavedReports()); } catch {}
  }, []);
  useEffect(() => { loadSaved(); }, [loadSaved]);

  const run = async () => {
    setRunning(true);
    try { setResult(await api.runReport(config)); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setRunning(false); }
  };
  const saveConfig = async () => {
    if (!saveName.trim()) return;
    try {
      await api.saveReport(saveName.trim(), config);
      toast?.("Report saved", "success");
      setSaveOpen(false); setSaveName(""); loadSaved();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };
  const loadSavedReport = (r) => { setConfig(r.config); };
  const removeSaved = async (r) => {
    if (!window.confirm(`Delete saved report "${r.name}"?`)) return;
    try { await api.deleteSavedReport(r.id); loadSaved(); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const toggleDim = (d) => {
    const has = config.dimensions.includes(d);
    let next;
    if (has) next = config.dimensions.filter(x => x !== d);
    else if (config.dimensions.length >= 2) next = [config.dimensions[1], d];
    else next = [...config.dimensions, d];
    if (next.length === 0) next = ["category"];
    setConfig({ ...config, dimensions: next });
  };
  const chip = (active) =>
    `px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
      active
        ? "bg-violet-500 text-white border-violet-500"
        : `${theme.textSubtle} border ${theme.border} ${theme.hover}`
    }`;

  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-3`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Custom reports</h3>
        {saved.length > 0 && (
          <div className={`text-xs ${theme.textSubtle}`}>{saved.length} saved</div>
        )}
      </div>
      <p className={`text-xs ${theme.textSubtle}`}>
        Pivot-style report builder — pick up to two dimensions, choose a measure, and
        run against your transaction history. Save configurations to re-run instantly.
      </p>

      <div>
        <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5`}>Dimensions</div>
        <div className="flex flex-wrap gap-1.5">
          {REPORT_DIMS.map(d => (
            <button key={d.code} type="button" onClick={() => toggleDim(d.code)}
              className={chip(config.dimensions.includes(d.code))}>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1`}>Measure</div>
          <select value={config.measure} onChange={e => setConfig({ ...config, measure: e.target.value })} className={inputCls}>
            <option value="sum">Sum ($)</option>
            <option value="count">Count</option>
            <option value="avg">Average ($)</option>
          </select>
        </div>
        <div>
          <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1`}>Side</div>
          <select value={config.side} onChange={e => setConfig({ ...config, side: e.target.value })} className={inputCls}>
            <option value="expense">Expenses</option>
            <option value="income">Income</option>
            <option value="all">All</option>
          </select>
        </div>
        <div>
          <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1`}>Credit cards</div>
          <select value={config.credit} onChange={e => setConfig({ ...config, credit: e.target.value })} className={inputCls}>
            <option value="exclude">Exclude</option>
            <option value="include">Include</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1`}>From</div>
          <input type="date" value={config.from} onChange={e => setConfig({ ...config, from: e.target.value })} className={inputCls} />
        </div>
        <div>
          <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1`}>To</div>
          <input type="date" value={config.to} onChange={e => setConfig({ ...config, to: e.target.value })} className={inputCls} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={run} disabled={running}
          className="px-3 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
          {running ? "Running…" : "Run report"}
        </button>
        <button type="button" onClick={() => setSaveOpen(v => !v)}
          className={`px-3 py-2 rounded-xl text-sm font-medium border ${theme.border} ${theme.surface}`}>
          Save configuration
        </button>
      </div>

      {saveOpen && (
        <div className={`rounded-xl border ${theme.border} p-3 flex gap-2 items-center`}>
          <input value={saveName} onChange={e => setSaveName(e.target.value)}
            placeholder="Name (e.g. Grocery spend by month)"
            className={inputCls} />
          <button type="button" onClick={saveConfig}
            className="px-3 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600">
            Save
          </button>
        </div>
      )}

      {saved.length > 0 && (
        <div className={`rounded-xl border ${theme.border} p-2 flex flex-wrap gap-1.5`}>
          {saved.map(r => (
            <div key={r.id} className={`flex items-center gap-1 rounded-full border ${theme.border} pl-2.5 pr-1 py-0.5 text-[11px]`}>
              <button type="button" onClick={() => loadSavedReport(r)}
                className="font-semibold hover:text-violet-500">
                {r.name}
              </button>
              <button type="button" onClick={() => removeSaved(r)}
                className={`p-0.5 rounded-full ${theme.textSubtle} hover:text-rose-500`}>
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className={`rounded-xl border ${theme.border} overflow-hidden`}>
          <div className={`px-3 py-2 text-[10px] font-semibold ${theme.textSubtle} uppercase tracking-wider ${darkMode ? "bg-slate-800" : "bg-slate-50"} flex items-center justify-between`}>
            <span>{result.rows.length} rows · {result.dims.join(" × ")} → {result.measure}</span>
            <span className="private-amount" tabIndex={0}>
              Total: {result.measure === "count" ? Math.round(result.total) : fmt(result.total)}
            </span>
          </div>
          <div className={`divide-y ${theme.divide} max-h-72 overflow-y-auto`}>
            {result.rows.length === 0 && (
              <div className={`p-4 text-xs ${theme.textSubtle} text-center`}>No rows.</div>
            )}
            {result.rows.map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs">
                <div className="flex-1 min-w-0 truncate">
                  <span className="font-medium">{r.dim1}</span>
                  {r.dim2 !== undefined && (
                    <> <span className={theme.textSubtle}> · </span> <span>{r.dim2}</span></>
                  )}
                </div>
                <div className="text-right font-semibold private-amount" tabIndex={0}>
                  {result.measure === "count" ? Math.round(r.value) : fmt(r.value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reconciliation Sheet ─────────────────────────────────────────────────────
// Quicken-style statement match. Two-phase flow:
//   1. User enters statement date + ending balance → we open a draft
//   2. User ticks off transactions until "difference" hits zero, then finalizes
// Finalized reconciliations are immutable and stamp reconciliation_id on
// every cleared transaction so a future reconciliation can't re-tick them.
function ReconcileSheet({ open, onClose, account, theme, darkMode, toast, onFinalize }) {
  const [phase, setPhase] = useState("start"); // "start" | "draft" | "locked"
  const [statementDate, setStatementDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endingBalance, setEndingBalance] = useState("");
  const [rec, setRec] = useState(null);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  // Reset on open/close
  useEffect(() => {
    if (!open) {
      setPhase("start"); setRec(null);
      setEndingBalance(""); setStatementDate(new Date().toISOString().slice(0, 10));
    }
  }, [open]);

  const loadDraft = useCallback(async (id) => {
    try { const data = await api.getReconciliation(id); setRec(data); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  }, [toast]);

  const startPass = async (e) => {
    e.preventDefault();
    if (!account?.id) return;
    const bal = Number(endingBalance);
    if (!Number.isFinite(bal)) { toast?.("Enter a valid ending balance", "error"); return; }
    setSaving(true);
    try {
      const { id } = await api.startReconciliation({
        account_id: account.id,
        statement_date: statementDate,
        statement_ending_balance: bal,
      });
      await loadDraft(id);
      setPhase("draft");
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };

  const toggleTxn = async (txn) => {
    if (!rec) return;
    try {
      await api.toggleReconciliationTxn(rec.id, txn.id, !txn.cleared);
      await loadDraft(rec.id);
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const finalize = async () => {
    if (!rec) return;
    setFinalizing(true);
    try {
      await api.finalizeReconciliation(rec.id);
      toast?.("Reconciled and locked", "success");
      setPhase("locked");
      onFinalize?.();
      onClose();
    } catch (e) {
      toast?.(e.message || "Not balanced yet", "error");
    } finally { setFinalizing(false); }
  };

  const cancelDraft = async () => {
    if (!rec) { onClose(); return; }
    if (!window.confirm("Discard this reconciliation? Any cleared checkmarks will be cleared.")) return;
    try { await api.deleteReconciliation(rec.id); }
    catch (e) { toast?.("Failed to discard: " + (e.message || ""), "error"); }
    onClose();
  };

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  const diffZero = rec && Math.abs(Number(rec.difference)) < 0.005;

  return (
    <Sheet open={open} onClose={onClose} title={account ? `Reconcile — ${account.name}` : "Reconcile"} theme={theme}>
      {phase === "start" && (
        <form onSubmit={startPass} className="space-y-3">
          <p className={`text-xs ${theme.textSubtle}`}>
            Enter the ending balance from your latest bank / card statement, then tick
            off each transaction that appears on the statement. When the difference
            hits zero, finalize to lock the pass.
          </p>
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Statement date</label>
            <input type="date" value={statementDate}
              onChange={e => setStatementDate(e.target.value)} className={inputCls} required />
          </div>
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Ending balance on statement</label>
            <input type="number" step="0.01" inputMode="decimal" value={endingBalance}
              onChange={e => setEndingBalance(e.target.value)} placeholder="0.00" className={inputCls} required />
          </div>
          <button type="submit" disabled={saving}
            className="w-full py-2.5 rounded-xl bg-violet-500 text-white font-semibold text-sm disabled:opacity-60">
            {saving ? "Starting…" : "Start reconciliation"}
          </button>
        </form>
      )}

      {phase === "draft" && rec && (
        <div className="space-y-3">
          <div className={`rounded-2xl border ${theme.border} p-3 grid grid-cols-3 gap-2 text-center`}>
            <div>
              <div className={`text-[10px] ${theme.textSubtle} uppercase tracking-wider`}>Statement</div>
              <div className="text-sm font-semibold">{fmt(rec.statementEndingBalance)}</div>
            </div>
            <div>
              <div className={`text-[10px] ${theme.textSubtle} uppercase tracking-wider`}>Cleared</div>
              <div className="text-sm font-semibold">{fmt(Number(rec.startingBalance) + Number(rec.clearedTotal))}</div>
            </div>
            <div>
              <div className={`text-[10px] ${theme.textSubtle} uppercase tracking-wider`}>Difference</div>
              <div className={`text-sm font-bold ${diffZero ? "text-emerald-500" : "text-rose-500"}`}>
                {rec.difference >= 0 ? "+" : "−"}{fmt(Math.abs(rec.difference))}
              </div>
            </div>
          </div>

          <div className={`rounded-2xl border ${theme.border} max-h-96 overflow-y-auto divide-y ${theme.divide}`}>
            {rec.transactions.length === 0 && (
              <div className={`p-6 text-center text-xs ${theme.textSubtle}`}>
                No unreconciled transactions on or before {rec.statementDate}.
              </div>
            )}
            {rec.transactions.map(t => (
              <button key={t.id} type="button" onClick={() => toggleTxn(t)}
                className={`w-full flex items-center gap-3 p-3 text-left ${theme.hover} transition-colors`}>
                <div className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center ${t.cleared ? "bg-violet-500 border-violet-500" : theme.border}`}>
                  {t.cleared && <Check className="w-3.5 h-3.5 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.merchant}</div>
                  <div className={`text-[11px] ${theme.textSubtle}`}>{String(t.date).slice(0, 10)} · {t.category}{t.pending ? " · Pending" : ""}</div>
                </div>
                <div className={`text-sm font-semibold ${Number(t.amount) >= 0 ? "text-emerald-500" : ""}`}>
                  {Number(t.amount) >= 0 ? "+" : "−"}{fmt(Math.abs(Number(t.amount)))}
                </div>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={cancelDraft}
              className={`flex-1 py-2.5 rounded-xl border ${theme.border} text-sm font-medium ${theme.textSubtle} hover:text-rose-500`}>
              Discard
            </button>
            <button type="button" onClick={finalize} disabled={!diffZero || finalizing}
              className="flex-1 py-2.5 rounded-xl bg-violet-500 text-white text-sm font-semibold disabled:opacity-40">
              {finalizing ? "Locking…" : diffZero ? "Finalize" : "Not balanced"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ─── Accounts Tab ─────────────────────────────────────────────────────────────
function AccountsTab({ theme, darkMode, toast }) {
  const { accounts, refreshAll } = useData();
  const { user: _accUser } = useAuth();
  const plaidEnabled = !(_accUser && _accUser.plaid_enabled === false);
  const [syncing, setSyncing] = useState(false);
  const [items, setItems] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", type: "cash", subtype: "", balance: "", institution: "", link_asset_id: "", is_business: false });
  const [adding, setAdding] = useState(false);
  const [reconAccount, setReconAccount] = useState(null);
  const [editingAccount, setEditingAccount] = useState(null);
  const [linkableAssets, setLinkableAssets] = useState([]);

  // Assets available to link when creating a loan account (car, boat, etc.
  // that don't already have a loan attached).
  useEffect(() => {
    if (!showAdd) return;
    api.listAssets()
      .then(list => setLinkableAssets(list.filter(a => !a.loanAccountId)))
      .catch(() => setLinkableAssets([]));
  }, [showAdd]);

  const loadItems = useCallback(async () => {
    try { setItems(await api.listPlaidItems()); } catch {}
  }, []);
  useEffect(() => { loadItems(); }, [loadItems]);

  const sync = async () => {
    setSyncing(true);
    try { await api.syncPlaid(); setTimeout(() => { refreshAll(); loadItems(); }, 2000); toast?.("Accounts synced", "success"); }
    catch { toast?.("Sync failed", "error"); }
    finally { setSyncing(false); }
  };

  const removeItem = async (item) => {
    if (!window.confirm(`Disconnect ${item.institutionName || "this bank"}? Accounts and transactions from it will be removed.`)) return;
    setRemovingId(item.id);
    try {
      await api.deletePlaidItem(item.id);
      toast?.("Bank disconnected", "success");
      await loadItems(); await refreshAll();
    } catch (e) {
      toast?.("Failed to disconnect: " + (e.message || ""), "error");
    } finally { setRemovingId(null); }
  };

  const submitAdd = async (e) => {
    e.preventDefault();
    setAdding(true);
    try {
      await api.createAccount({
        name: addForm.name.trim(),
        type: addForm.type,
        subtype: addForm.subtype.trim() || undefined,
        balance: Number(addForm.balance) || 0,
        institution: addForm.institution.trim() || undefined,
        is_business: !!addForm.is_business,
        link_asset_id: addForm.type === "loan" && addForm.link_asset_id
          ? Number(addForm.link_asset_id) : undefined,
      });
      toast?.("Account added", "success");
      setShowAdd(false);
      setAddForm({ name: "", type: "cash", subtype: "", balance: "", institution: "", link_asset_id: "", is_business: false });
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setAdding(false); }
  };

  const removeAccount = async (acc) => {
    if (acc.plaidItemId) {
      toast?.("Plaid-linked accounts must be disconnected via Connected Banks", "warning");
      return;
    }
    if (!window.confirm(`Delete ${acc.name}? Its transactions will be unlinked.`)) return;
    try { await api.deleteAccount(acc.id); refreshAll(); toast?.("Account deleted", "success"); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  const typeStyle = {
    cash:       { label: "Cash",       light: "bg-emerald-100 text-emerald-700", dark: "bg-emerald-500/20 text-emerald-400", icon: Wallet      },
    credit:     { label: "Credit",     light: "bg-rose-100 text-rose-700",       dark: "bg-rose-500/20 text-rose-400",       icon: CreditCard  },
    investment: { label: "Investment", light: "bg-sky-100 text-sky-700",         dark: "bg-sky-500/20 text-sky-400",         icon: TrendingUp  },
    loan:       { label: "Loan",       light: "bg-amber-100 text-amber-700",     dark: "bg-amber-500/20 text-amber-400",     icon: Building2   },
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          {plaidEnabled && (
            <motion.button whileTap={{ scale: 0.97 }} onClick={sync} disabled={syncing}
              className={`flex items-center gap-2 px-4 py-2 ${theme.surface} border ${theme.border} rounded-xl text-sm font-medium disabled:opacity-50`}>
              <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} /> Sync
            </motion.button>
          )}
          <motion.button whileTap={{ scale: 0.97 }} onClick={() => setShowAdd(true)}
            className={`flex items-center gap-1.5 px-4 py-2 ${theme.surface} border ${theme.border} rounded-xl text-sm font-medium`}>
            <Plus className="w-4 h-4" /> Add Manual
          </motion.button>
        </div>
        <PlaidLinkButton onSuccess={() => { refreshAll(); loadItems(); }} />
      </div>

      {/* Connected banks */}
      {items.length > 0 && (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
          <div className={`px-5 py-3.5 border-b ${theme.border} flex items-center justify-between`}>
            <h3 className="font-semibold text-sm">Connected Banks ({items.length})</h3>
          </div>
          <div className={`divide-y ${theme.divide}`}>
            {items.map(item => (
              <div key={item.id} className="flex items-center justify-between px-5 py-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                    <Building2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate private-name" tabIndex={0}>{item.institutionName || "Bank"}</div>
                    <div className={`text-xs ${theme.textSubtle}`}>
                      {item.lastSyncAt
                        ? `Last sync ${new Date(item.lastSyncAt).toLocaleString()}`
                        : "Not yet synced"}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => removeItem(item)}
                  disabled={removingId === item.id}
                  className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                    darkMode ? "text-rose-400 hover:bg-rose-500/10" : "text-rose-600 hover:bg-rose-50"
                  }`}
                >
                  {removingId === item.id ? "Removing…" : "Disconnect"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid md:grid-cols-2 gap-4">
        {accounts.map(a => {
          const s = typeStyle[a.type] || typeStyle.cash;
          const AIcon = s.icon;
          return (
            <motion.div key={a.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${darkMode ? s.dark : s.light}`}>
                    <AIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-semibold text-sm private-name" tabIndex={0}>{a.name}</div>
                    <div className={`text-xs ${theme.textSubtle} private-name`} tabIndex={0}>{a.institution || "Manual"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${darkMode ? s.dark : s.light}`}>{s.label}</span>
                  {!a.plaidItemId && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${darkMode ? "bg-slate-700 text-slate-300" : "bg-slate-100 text-slate-600"}`}>
                      Manual
                    </span>
                  )}
                </div>
              </div>
              <div className={`text-2xl font-bold private-amount ${Number(a.balance) < 0 ? "text-rose-500" : ""}`} tabIndex={0}>
                {fmt(Math.abs(Number(a.balance)))}
              </div>
              <div className="flex items-center justify-between mt-2">
                {a.lastSyncAt ? (
                  <div className={`text-xs ${theme.textSubtle} flex items-center gap-1`}>
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                    Synced {new Date(a.lastSyncAt).toLocaleString()}
                  </div>
                ) : <div />}
                <div className="flex items-center gap-3">
                  {(a.type === "cash" || a.type === "credit") && (
                    <button onClick={() => setReconAccount(a)}
                      className={`text-xs ${theme.textSubtle} hover:text-violet-500 transition-colors`}>
                      Reconcile
                    </button>
                  )}
                  {!a.plaidItemId && (
                    <button onClick={() => setEditingAccount(a)}
                      className={`text-xs ${theme.textSubtle} hover:text-violet-500 transition-colors`}>
                      Edit
                    </button>
                  )}
                  {!a.plaidItemId && (
                    <button onClick={() => removeAccount(a)}
                      className={`text-xs ${theme.textSubtle} hover:text-rose-500 transition-colors`}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
        {accounts.length === 0 && (
          <div className={`md:col-span-2 border-2 border-dashed ${darkMode ? "border-slate-700" : "border-slate-300"} rounded-2xl p-12 text-center`}>
            <Wallet className={`w-12 h-12 ${theme.textSubtle} mx-auto mb-3`} />
            <p className={`${theme.textMuted} mb-4`}>No accounts yet.</p>
            <div className="flex items-center justify-center gap-2">
              <PlaidLinkButton onSuccess={refreshAll} />
              <motion.button whileTap={{ scale: 0.97 }} onClick={() => setShowAdd(true)}
                className={`flex items-center gap-1.5 px-4 py-2.5 ${theme.surface} border ${theme.border} rounded-xl text-sm font-medium`}>
                <Plus className="w-4 h-4" /> Add Manually
              </motion.button>
            </div>
          </div>
        )}
      </div>

      {/* Assets & valuables */}
      <AssetsPanel theme={theme} darkMode={darkMode} toast={toast} onChange={refreshAll} />

      {/* Add manual account sheet */}
      <Sheet open={showAdd} onClose={() => setShowAdd(false)} title="Add Manual Account" theme={theme}>
        <form onSubmit={submitAdd} className="space-y-3">
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Account Name</label>
            <input required value={addForm.name} onChange={e => setAddForm({ ...addForm, name: e.target.value })}
              placeholder="My Checking" className={inputCls} />
          </div>
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Institution</label>
            <input value={addForm.institution} onChange={e => setAddForm({ ...addForm, institution: e.target.value })}
              placeholder="Bank or institution name" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Type</label>
              <select value={addForm.type} onChange={e => setAddForm({ ...addForm, type: e.target.value })}
                className={inputCls}>
                <option value="cash">Cash / Checking / Savings</option>
                <option value="credit">Credit Card</option>
                <option value="investment">Investment</option>
                <option value="loan">Loan</option>
              </select>
            </div>
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>
                {addForm.type === "loan" ? "Amount owed" : "Balance"}
              </label>
              <input type="number" step="0.01" min="0" required value={addForm.balance}
                onChange={e => setAddForm({ ...addForm, balance: e.target.value })}
                placeholder="0.00" className={inputCls} />
              {addForm.type === "loan" && (
                <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
                  Enter what you owe as a positive number — stored as a negative behind the scenes so it correctly reduces your net worth.
                </div>
              )}
            </div>
          </div>
          {/* Subtype dropdown appears only when the base type supports one.
              Retirement / HSA / 529 for investments; HELOC for credit;
              property for cash-shaped or investment (owner-occupied /
              rental). Type = loan doesn't get a subtype in this form. */}
          {(addForm.type === "investment" || addForm.type === "credit"
            || addForm.type === "cash") && (
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>
                Subtype (optional)
              </label>
              <select value={addForm.subtype}
                onChange={e => setAddForm({ ...addForm, subtype: e.target.value })} className={inputCls}>
                <option value="">— none —</option>
                {addForm.type === "investment" && (<>
                  <option value="retirement">Retirement (401k / IRA / Roth / SEP / 403b)</option>
                  <option value="hsa">HSA — health savings</option>
                  <option value="529">529 — education savings</option>
                  <option value="property">Real estate / property</option>
                </>)}
                {addForm.type === "credit" && <option value="heloc">HELOC — home equity line of credit</option>}
                {addForm.type === "cash" && <option value="property">Real estate / property</option>}
              </select>
              <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
                Retirement / HSA / 529 carry tax-advantaged treatment; HELOC + property are display + reporting labels.
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!addForm.is_business}
              onChange={e => setAddForm({ ...addForm, is_business: e.target.checked })}
              className="w-4 h-4 accent-violet-500" />
            <span>Business account (Schedule C activity)</span>
          </label>
          {addForm.type === "loan" && (
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>
                Backing asset (optional)
              </label>
              {linkableAssets.length === 0 ? (
                <div className={`text-xs ${theme.textSubtle} px-3 py-2 border ${theme.border} rounded-xl`}>
                  No unlinked assets. Add one under Assets & valuables to pair this loan with a car, boat, or property.
                </div>
              ) : (
                <select value={addForm.link_asset_id}
                  onChange={e => setAddForm({ ...addForm, link_asset_id: e.target.value })} className={inputCls}>
                  <option value="">Don't link</option>
                  {linkableAssets.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name} · value {fmt(Number(a.currentValue) || 0)}
                    </option>
                  ))}
                </select>
              )}
              <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
                Links the loan to a physical asset so you can see (value − amount owed) at a glance.
              </div>
            </div>
          )}
          <p className={`text-xs ${theme.textSubtle}`}>
            Manual accounts won't auto-sync. Update the balance and add transactions yourself.
          </p>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setShowAdd(false)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
              Cancel
            </button>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={adding}
              className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Adding…" : "Add account"}
            </motion.button>
          </div>
        </form>
      </Sheet>

      <ReconcileSheet open={!!reconAccount} onClose={() => setReconAccount(null)}
        account={reconAccount} theme={theme} darkMode={darkMode} toast={toast}
        onFinalize={refreshAll} />
      <EditAccountSheet open={!!editingAccount} account={editingAccount}
        theme={theme} darkMode={darkMode} toast={toast}
        onClose={() => setEditingAccount(null)}
        onSaved={() => { setEditingAccount(null); refreshAll(); }} />
    </div>
  );
}

// ─── Edit Account Sheet ──────────────────────────────────────────────────────
// Manual-account fields the user might realistically want to change after
// creation. Plaid-linked accounts are excluded from the edit surface
// (their balance is authoritative from the bank; renaming Plaid rows is
// a separate concern we don't expose here).
function EditAccountSheet({ open, onClose, account, theme, darkMode, toast, onSaved }) {
  const [form, setForm] = useState({ name: "", balance: "", subtype: "", is_business: false });
  const [saving, setSaving] = useState(false);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  useEffect(() => {
    if (!open || !account) return;
    setForm({
      name: account.name || "",
      // Loans store balance as a negative — surface the absolute value
      // in the input so the user edits "amount owed" as a positive.
      // On save the backend puts the sign back on.
      balance: String(account.type === "loan"
        ? Math.abs(Number(account.balance) || 0)
        : (account.balance ?? "")),
      subtype: account.subtype || "",
      is_business: !!account.isBusiness,
    });
  }, [open, account]);
  if (!open || !account) return null;
  const isLoan = account.type === "loan";
  const save = async () => {
    if (!form.name.trim()) { toast?.("Name required", "error"); return; }
    setSaving(true);
    try {
      await api.updateAccount(account.id, {
        name: form.name.trim(),
        balance: form.balance === "" ? undefined : Number(form.balance),
        subtype: form.subtype === "" ? null : form.subtype,
        is_business: form.is_business,
      });
      toast?.("Account updated", "success");
      onSaved?.();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title={`Edit · ${account.name}`} theme={theme}>
      <div className="space-y-3">
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Name</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>
            {isLoan ? "Amount owed" : "Balance"}
          </label>
          <input type="number" step="0.01" min={isLoan ? "0" : undefined} value={form.balance}
            onChange={e => setForm({ ...form, balance: e.target.value })} className={inputCls} />
          <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
            {isLoan
              ? "Type what you owe as a positive number. Coinvane flips the sign to negative behind the scenes so it correctly reduces your net worth."
              : "Editing the balance directly is one-shot — it does NOT post a corresponding transaction. Use the transaction list for anything that should show up in history."}
          </div>
        </div>
        {/* Subtype dropdown — same contextual set as the create form. */}
        {(account.type === "investment" || account.type === "credit" || account.type === "cash") && (
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Subtype</label>
            <select value={form.subtype}
              onChange={e => setForm({ ...form, subtype: e.target.value })} className={inputCls}>
              <option value="">— none —</option>
              {account.type === "investment" && (<>
                <option value="retirement">Retirement (401k / IRA / Roth / SEP / 403b)</option>
                <option value="hsa">HSA — health savings</option>
                <option value="529">529 — education savings</option>
                <option value="property">Real estate / property</option>
              </>)}
              {account.type === "credit" && <option value="heloc">HELOC — home equity line of credit</option>}
              {account.type === "cash" && <option value="property">Real estate / property</option>}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!form.is_business}
            onChange={e => setForm({ ...form, is_business: e.target.checked })}
            className="w-4 h-4 accent-violet-500" />
          <span>Business account (Schedule C activity)</span>
        </label>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>Cancel</button>
          <button type="button" onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ─── Transactions Tab ─────────────────────────────────────────────────────────
// ─── Transfer Sheet ───────────────────────────────────────────────────────────
// One action moves money between two of the user's own accounts. Creates
// paired transactions atomically on the server. Manual account balances
// are updated by the API; Plaid-linked ones are untouched.
function TransferSheet({ open, onClose, accounts, theme, darkMode, toast, onSaved }) {
  const [form, setForm] = useState(() => ({
    from_account_id: "", to_account_id: "", amount: "",
    date: new Date().toISOString().slice(0, 10), note: "",
  }));
  const [saving, setSaving] = useState(false);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  useEffect(() => {
    if (!open) return;
    setForm({
      from_account_id: "", to_account_id: "", amount: "",
      date: new Date().toISOString().slice(0, 10), note: "",
    });
  }, [open]);
  const save = async () => {
    if (!form.from_account_id || !form.to_account_id) { toast?.("Pick both accounts", "error"); return; }
    if (form.from_account_id === form.to_account_id) { toast?.("From and To must differ", "error"); return; }
    const amt = Number(form.amount);
    if (!(amt > 0)) { toast?.("Positive amount required", "error"); return; }
    setSaving(true);
    try {
      await api.transferBetweenAccounts({
        from_account_id: Number(form.from_account_id),
        to_account_id: Number(form.to_account_id),
        amount: amt,
        date: form.date,
        note: form.note.trim() || undefined,
      });
      toast?.(`Transferred ${fmt(amt)}`, "success");
      onSaved?.();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Transfer between accounts" theme={theme}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>From</label>
            <select value={form.from_account_id}
              onChange={e => setForm({ ...form, from_account_id: e.target.value })} className={inputCls}>
              <option value="">— pick —</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.institution ? ` · ${a.institution}` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>To</label>
            <select value={form.to_account_id}
              onChange={e => setForm({ ...form, to_account_id: e.target.value })} className={inputCls}>
              <option value="">— pick —</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.institution ? ` · ${a.institution}` : ""}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Amount</label>
            <input type="number" step="0.01" min="0" value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00" className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Date</label>
            <input type="date" value={form.date}
              onChange={e => setForm({ ...form, date: e.target.value })} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Note (optional)</label>
          <input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })}
            placeholder="e.g. Rent · quarterly savings top-up" className={inputCls} />
        </div>
        <div className={`text-[11px] ${theme.textSubtle}`}>
          Creates two paired transactions marked <em>Transfer</em>. Both drop out of income / cashflow / by-category totals. Manual account balances shift automatically; Plaid-linked ones stay pinned to the bank's value.
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>Cancel</button>
          <button type="button" onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Transferring…" : "Transfer"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function TransactionsTab({ theme, darkMode, toast }) {
  const { transactions, accounts, categories, budgets, refreshAll } = useData();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [catFilter, setCatFilter] = useState("");      // category filter
  const [acctFilter, setAcctFilter] = useState("all"); // account filter (id | "all")
  const [sort, setSort] = useState("date_desc");       // sort key
  const [clearedFilter, setClearedFilter] = useState("all"); // "all"|"cleared"|"uncleared"|"reconciled"
  const [flagFilter, setFlagFilter] = useState("");    // "" | colour
  const [savedViews, setSavedViews] = useState([]);
  const [showSaveViewSheet, setShowSaveViewSheet] = useState(false);
  const [newViewName, setNewViewName] = useState("");

  useEffect(() => {
    api.listSavedViews().then(setSavedViews).catch(() => setSavedViews([]));
  }, []);

  // Keyboard shortcut hook — Shell fires 'coinvane:new-txn' on `n` press.
  useEffect(() => {
    const open = () => setShowAdd(true);
    window.addEventListener("coinvane:new-txn", open);
    return () => window.removeEventListener("coinvane:new-txn", open);
  }, []);
  // Cash / Credit pill — splits the entire list by account type. Defaults to
  // "cash" every time the tab is mounted (non-persistent by design).
  const [side, setSide] = useState("cash");            // "cash" | "credit"

  // Set of credit account ids for fast classification of each transaction.
  // Manual transactions (accountId null) are treated as cash-side.
  const creditAccountIds = useMemo(
    () => new Set(accounts.filter(a => a.type === "credit").map(a => a.id)),
    [accounts]
  );
  const isCreditTxn = (t) => creditAccountIds.has(t.accountId);
  // Reset the account filter when the user flips sides so a stale id from the
  // other side doesn't silently hide everything.
  useEffect(() => { setAcctFilter("all"); }, [side]);
  const [detail, setDetail] = useState(null);
  // When true, the classify buttons in the detail sheet write a
  // merchant-scoped rule (forced_type) instead of a per-row override.
  const [applyToMerchant, setApplyToMerchant] = useState(false);
  useEffect(() => { setApplyToMerchant(false); }, [detail?.id]);
  const [deleting, setDeleting] = useState(false);
  // Manual split editor state — array of {category, amount} rows shown
  // inside the detail sheet's Split panel. When null the panel is closed.
  const [splitDraft, setSplitDraft] = useState(null);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitTemplates, setSplitTemplates] = useState([]);
  useEffect(() => {
    api.listSplitTemplates().then(setSplitTemplates).catch(() => setSplitTemplates([]));
  }, []);
  // Receipt state per open detail sheet: {url, loading, error, uploading}.
  // Object URL is created on-demand and revoked when the sheet closes.
  const [receiptState, setReceiptState] = useState({
    url: null, loading: false, error: null, uploading: false,
  });
  const receiptFileRef = useRef(null);

  // Load / revoke the receipt object URL as detail sheet opens & closes.
  // Runs whenever `detail?.id` changes; guards against setState after
  // close by capturing the id and comparing before commit.
  useEffect(() => {
    if (!detail?.id || !detail?.hasAttachment) return;
    let alive = true;
    setReceiptState(s => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const url = await api.fetchAttachment(detail.id);
        if (!alive) { URL.revokeObjectURL(url); return; }
        setReceiptState({ url, loading: false, error: null, uploading: false });
      } catch (e) {
        if (!alive) return;
        setReceiptState({ url: null, loading: false, error: e.message || "load failed", uploading: false });
      }
    })();
    return () => { alive = false; };
  }, [detail?.id, detail?.hasAttachment]);
  // Category-edit flow: 'pick' = pick new category, 'scope' = ask just-this/all-future
  const [catEdit, setCatEdit] = useState(null); // { stage, newCategory }
  // Paystub editor sheet — open when set, holds the transaction being edited.
  // Saved via api.savePaystub, then refreshAll picks up the new blob for the
  // detail sheet's summary render.
  const [paystubEdit, setPaystubEdit] = useState(null);
  // Scheduled transactions — separate list from the main table. Loaded on
  // mount + refreshed whenever we mutate one; also picks up sync-time
  // adoptions since a full refreshAll re-fetches this endpoint too.
  const [scheduled, setScheduled] = useState([]);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  // Copy-and-schedule flow: seed the schedule form from an existing txn.
  const [copyFrom, setCopyFrom] = useState(null);
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    date: today, merchant: "", amount: "", category: "Other",
    account_id: "", note: "", sign: "out", check_number: "",
  });
  const [adding, setAdding] = useState(false);
  const [payeeHintApplied, setPayeeHintApplied] = useState(null);

  const loadScheduled = useCallback(async () => {
    try { setScheduled(await api.getScheduledTransactions()); }
    catch { /* non-fatal */ }
  }, []);
  useEffect(() => { loadScheduled(); }, [loadScheduled, transactions]);

  const deleteTransaction = async () => {
    if (!detail) return;
    if (!window.confirm(`Delete "${detail.merchant}" for ${fmt(Math.abs(Number(detail.amount)))}?`)) return;
    setDeleting(true);
    try {
      await api.deleteTransaction(detail.id);
      toast?.("Transaction deleted", "success");
      setDetail(null);
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setDeleting(false); }
  };

  // Feature 3 — apply scope choice from the cat-edit "scope" stage
  const applyCategoryChange = async (scope) => {
    if (!detail || !catEdit?.newCategory) return;
    try {
      if (scope === "all") {
        // Save a per-user rule + retroactively recategorise every matching txn
        await api.recategorizeMerchant(detail.merchant, catEdit.newCategory);
        toast?.(`All "${detail.merchant}" transactions updated`, "success");
      } else {
        // Just this one
        await api.updateTransaction(detail.id, { category: catEdit.newCategory });
        toast?.("Category updated", "success");
      }
      // Patch the open sheet in place instead of closing — the user was
      // in the middle of editing and probably wants to change other things
      // (flag, note, receipt) without re-opening.
      setDetail({ ...detail, category: catEdit.newCategory });
      setCatEdit(null);
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    }
  };

  // ── Filter + sort pipeline ─────────────────────────────────────
  const filtered = useMemo(() => {
    let rows = transactions.filter(t => {
      // Cash / Credit split runs first — the tab is conceptually two
      // separate lists, not one list with a soft filter.
      const credit = isCreditTxn(t);
      if (side === "cash"   && credit) return false;
      if (side === "credit" && !credit) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(t.merchant || "").toLowerCase().includes(q) &&
            !(t.category || "").toLowerCase().includes(q)) return false;
      }
      if (catFilter && t.category !== catFilter) return false;
      if (acctFilter !== "all" && String(t.accountId) !== String(acctFilter)) return false;
      if (clearedFilter === "cleared"    && !(t.cleared && !t.reconciliationId)) return false;
      if (clearedFilter === "uncleared"  && t.cleared) return false;
      if (clearedFilter === "reconciled" && !t.reconciliationId) return false;
      if (flagFilter && t.flagColor !== flagFilter) return false;
      return true;
    });
    const cmp = {
      date_desc:  (a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id,
      date_asc:   (a, b) => (a.date || "").localeCompare(b.date || "") || a.id - b.id,
      amount_asc: (a, b) => Number(a.amount) - Number(b.amount), // most negative first → biggest expense
      amount_desc:(a, b) => Number(b.amount) - Number(a.amount), // most positive first → biggest income
      // Receipts first (has_attachment DESC), then newest within each bucket.
      has_receipt:(a, b) =>
        (b.hasAttachment ? 1 : 0) - (a.hasAttachment ? 1 : 0)
        || (b.date || "").localeCompare(a.date || "")
        || b.id - a.id,
    }[sort] || ((a, b) => 0);
    return [...rows].sort(cmp);
  }, [transactions, search, catFilter, acctFilter, sort, side, creditAccountIds, clearedFilter, flagFilter]);

  // Running balance — Quicken-style. Only meaningful when a single account
  // is selected; otherwise the number would jump between accounts. Walks
  // the filtered rows in chronological order from an implicit opening
  // balance of (current_balance − sum(amounts in view)) and stamps each
  // row with its post-transaction balance.
  const runningBalances = useMemo(() => {
    if (acctFilter === "all") return null;
    const acct = accounts.find(a => String(a.id) === String(acctFilter));
    if (!acct) return null;
    const current = Number(acct.balance) || 0;
    const chrono = [...filtered].sort((a, b) =>
      (a.date || "").localeCompare(b.date || "") || a.id - b.id
    );
    const totalInView = chrono.reduce((s, t) => s + Number(t.amount || 0), 0);
    let running = current - totalInView;
    const map = new Map();
    for (const t of chrono) {
      running += Number(t.amount || 0);
      map.set(t.id, running);
    }
    return map;
  }, [filtered, acctFilter, accounts]);
  // Decorate the filtered rows with their running balance so the render
  // can reach it directly on `t`. Not part of the primary useMemo so the
  // balance re-computes without invalidating the sort.
  const filteredWithBalance = useMemo(() => {
    if (!runningBalances) return filtered;
    return filtered.map(t => ({ ...t, runningBalance: runningBalances.get(t.id) }));
  }, [filtered, runningBalances]);

  // Group by date for the rendered list.
  // BUG FIX: when sorted by amount, transactions aren't ordered by date so
  // grouping creates many tiny groups with possible duplicate dates (which
  // collided with React keys → other tabs misrendering). For amount sorts
  // we render a single flat group with no date header.
  const isAmountSort = sort === "amount_asc" || sort === "amount_desc";
  const isFlatSort = isAmountSort || sort === "has_receipt";
  const grouped = useMemo(() => {
    if (filteredWithBalance.length === 0) return [];
    if (isFlatSort) {
      // Single flat group — date headers don't make sense when sorted by
      // amount or receipt-first (both scatter dates arbitrarily).
      return [{ date: "__flat__", items: filteredWithBalance }];
    }
    // Date sort: group consecutive same-date rows. Keys use date + index of
    // the group to avoid duplicates even if dates ever repeat.
    const groups = [];
    let currentKey = null;
    for (const t of filteredWithBalance) {
      const k = t.date || "—";
      if (k !== currentKey) {
        groups.push({ date: k, items: [] });
        currentKey = k;
      }
      groups[groups.length - 1].items.push(t);
    }
    return groups;
  }, [filteredWithBalance, isFlatSort]);

  const fmtGroupDate = (d) => {
    if (!d || d === "—") return "Undated";
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    const today = new Date();   today.setHours(0,0,0,0);
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    const dtTrim = new Date(dt); dtTrim.setHours(0,0,0,0);
    if (dtTrim.getTime() === today.getTime()) return "Today";
    if (dtTrim.getTime() === yest.getTime())  return "Yesterday";
    const sameYear = dt.getFullYear() === today.getFullYear();
    return dt.toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      year: sameYear ? undefined : "numeric",
    });
  };

  // Skip internal transfers when totalling a day — moving money between
  // your own accounts isn't income or spending, so it shouldn't skew the
  // day's net line at the top of the group.
  const groupTotal = (items) =>
    items.reduce((s, t) => (t.isTransfer ? s : s + Number(t.amount)), 0);

  // Group accounts by institution for the filter dropdown.
  // Scoped to the current side so the dropdown only ever offers accounts
  // that match the cash/credit pill.
  const accountsByBank = useMemo(() => {
    const map = new Map();
    for (const a of accounts) {
      const credit = a.type === "credit";
      if (side === "cash"   && credit) continue;
      if (side === "credit" && !credit) continue;
      const bank = a.institution || "Manual";
      if (!map.has(bank)) map.set(bank, []);
      map.get(bank).push(a);
    }
    return [...map.entries()];
  }, [accounts, side]);

  const activeFilterCount = (catFilter ? 1 : 0) + (acctFilter !== "all" ? 1 : 0) + (sort !== "date_desc" ? 1 : 0) + (clearedFilter !== "all" ? 1 : 0) + (flagFilter ? 1 : 0);

  const submit = async (e) => {
    e.preventDefault();
    setAdding(true);
    try {
      const signed = form.sign === "in" ? Math.abs(Number(form.amount)) : -Math.abs(Number(form.amount));
      await api.createTransaction({
        date: form.date,
        merchant: form.merchant.trim(),
        category: form.category,
        amount: signed,
        accountId: form.account_id ? Number(form.account_id) : undefined,
        note: form.note.trim() || undefined,
        check_number: form.check_number.trim() || undefined,
      });
      toast?.("Transaction added", "success");
      setShowAdd(false);
      setForm({ date: today, merchant: "", amount: "", category: "Other", account_id: "", note: "", sign: "out", check_number: "" });
      setPayeeHintApplied(null);
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setAdding(false); }
  };

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  // Merchant-rule + txn-recategorize picker categories.
  // Priority order:
  //   1. User's actual `categories` rows (custom created + defaults)
  //   2. Any budget category the user has set up that isn't already a row
  //      in `categories` — custom budget labels ("Pet Supplies", "Rainy
  //      Day", etc) that were created via the budgets tab need to be
  //      selectable here too, or the user can't attach a merchant rule to
  //      their custom category.
  //   3. Built-in category keys as a last-ditch fallback for fresh installs
  //      where `categories` hasn't been seeded yet.
  // Card budgets (account-scoped, category starts with "card:") are skipped
  // since they're not a real spending category the user would pick.
  const catList = (() => {
    const seen = new Set();
    const list = [];
    const push = (name) => {
      const trimmed = String(name || "").trim();
      if (!trimmed) return;
      if (seen.has(trimmed.toLowerCase())) return;
      seen.add(trimmed.toLowerCase());
      list.push(trimmed);
    };
    if (categories && categories.length > 0) {
      for (const c of categories) push(c.name);
    } else {
      for (const c of Object.keys(CAT_COLORS)) push(c);
    }
    for (const b of budgets || []) {
      if (b.accountId) continue;
      push(b.category);
    }
    return list;
  })();

  return (
    <div className="space-y-3">
      {/* Search + cash/credit pill + filters + add */}
      <div className="flex items-center gap-2">
        <div className={`flex items-center gap-3 px-4 py-2.5 ${theme.surface} border ${theme.border} rounded-xl flex-1 min-w-0`}>
          <Search className={`w-4 h-4 ${theme.textSubtle} flex-shrink-0`} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search transactions…"
            className={`flex-1 min-w-0 bg-transparent text-sm focus:outline-none ${theme.text}`} />
          {search && (
            <button onClick={() => setSearch("")}><X className={`w-4 h-4 ${theme.textSubtle}`} /></button>
          )}
        </div>
        {/* Cash / Credit slider — splits the entire list in two. Defaults to
            "cash" on every mount; intentionally not persisted. */}
        <div className={`flex items-center p-1 rounded-xl border ${theme.border} ${theme.surface} flex-shrink-0`} role="tablist" aria-label="Account type">
          {["cash", "credit"].map(s => {
            const active = side === s;
            return (
              <button key={s} role="tab" aria-selected={active}
                onClick={() => setSide(s)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold capitalize transition ${
                  active
                    ? "bg-violet-500 text-white shadow-sm shadow-violet-500/30"
                    : theme.textMuted
                }`}>
                {s}
              </button>
            );
          })}
        </div>
        <motion.button whileTap={{ scale: 0.94 }} onClick={() => setShowFilters(!showFilters)}
          className={`relative p-2.5 rounded-xl border ${theme.border} ${theme.surface} flex-shrink-0`}>
          <Settings className={`w-5 h-5 ${activeFilterCount > 0 ? "text-violet-500" : theme.textSubtle}`} />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-violet-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </motion.button>
        <motion.button whileTap={{ scale: 0.94 }} onClick={() => setShowTransfer(true)}
          title="Transfer between accounts"
          className={`p-2.5 rounded-xl border ${theme.border} ${theme.surface} ${theme.hover} flex-shrink-0`}>
          <ArrowUpRight className={`w-5 h-5 ${theme.textSubtle}`} />
        </motion.button>
        <motion.button whileTap={{ scale: 0.94 }} onClick={() => setShowAdd(true)}
          className="bg-violet-500 hover:bg-violet-600 text-white p-2.5 rounded-xl shadow-sm shadow-violet-500/30 flex-shrink-0">
          <Plus className="w-5 h-5" />
        </motion.button>
      </div>

      {/* Filter row (collapsible) */}
      <AnimatePresence initial={false}>
        {showFilters && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
            className={`${theme.surface} border ${theme.border} rounded-2xl overflow-hidden`}>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Account</label>
                  <select value={acctFilter} onChange={e => setAcctFilter(e.target.value)} className={inputCls}>
                    <option value="all">All accounts</option>
                    {accountsByBank.map(([bank, accts]) => (
                      <optgroup key={bank} label={bank}>
                        {accts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Category</label>
                  <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className={inputCls}>
                    <option value="">All categories</option>
                    {catList.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Sort by</label>
                  <select value={sort} onChange={e => setSort(e.target.value)} className={inputCls}>
                    <option value="date_desc">Newest first</option>
                    <option value="date_asc">Oldest first</option>
                    <option value="amount_asc">Highest expense</option>
                    <option value="amount_desc">Highest income</option>
                    <option value="has_receipt">Has receipt</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Clearing status</label>
                  <select value={clearedFilter} onChange={e => setClearedFilter(e.target.value)} className={inputCls}>
                    <option value="all">All</option>
                    <option value="uncleared">Uncleared only</option>
                    <option value="cleared">Cleared (draft)</option>
                    <option value="reconciled">Reconciled (locked)</option>
                  </select>
                </div>
                <div>
                  <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Flag</label>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button type="button" onClick={() => setFlagFilter("")}
                      className={`px-2 py-1 rounded-lg text-xs font-semibold ${!flagFilter ? "bg-violet-500 text-white" : `${theme.surface} border ${theme.border}`}`}>
                      Any
                    </button>
                    {["red", "orange", "amber", "emerald", "sky", "violet", "rose"].map(c => (
                      <button key={c} type="button" onClick={() => setFlagFilter(c === flagFilter ? "" : c)}
                        className={`w-6 h-6 rounded-full bg-${c}-500 ${flagFilter === c ? "ring-2 ring-offset-2 ring-violet-500" : ""}`}
                        aria-label={c} />
                    ))}
                  </div>
                </div>
              </div>
              {/* Saved views strip */}
              {savedViews.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mr-1`}>Views:</span>
                  {savedViews.map(v => (
                    <button key={v.id} type="button" onClick={() => {
                      const c = v.config || {};
                      setCatFilter(c.catFilter || "");
                      setAcctFilter(c.acctFilter || "all");
                      setSort(c.sort || "date_desc");
                      setClearedFilter(c.clearedFilter || "all");
                      setFlagFilter(c.flagFilter || "");
                    }}
                    className={`px-2 py-1 rounded-lg text-xs ${theme.surface} border ${theme.border} hover:border-violet-500 flex items-center gap-1`}>
                      {v.name}
                      <span onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm(`Delete view "${v.name}"?`)) return;
                        try { await api.deleteSavedView(v.id); setSavedViews(await api.listSavedViews()); }
                        catch { toast?.("Failed to delete view", "error"); }
                      }} className={`ml-1 ${theme.textSubtle} hover:text-rose-500`}>×</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3">
                {activeFilterCount > 0 && (
                  <button onClick={() => {
                    setCatFilter(""); setAcctFilter("all"); setSort("date_desc");
                    setClearedFilter("all"); setFlagFilter("");
                  }}
                    className={`text-xs font-medium ${theme.textSubtle} hover:text-violet-500`}>
                    Clear filters
                  </button>
                )}
                {activeFilterCount > 0 && (
                  <button onClick={() => setShowSaveViewSheet(true)}
                    className="text-xs font-semibold text-violet-500 hover:underline">
                    Save current view
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Save-view dialog */}
      <Sheet open={showSaveViewSheet} onClose={() => { setShowSaveViewSheet(false); setNewViewName(""); }}
        title="Save this view" theme={theme}>
        <div className="space-y-3">
          <input value={newViewName} onChange={e => setNewViewName(e.target.value)}
            placeholder="e.g. Groceries this month" className={inputCls} autoFocus />
          <div className={`text-xs ${theme.textSubtle}`}>
            Saves the current filter, sort, clearing status, and flag colour under a name you can re-apply from the filter panel.
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setShowSaveViewSheet(false); setNewViewName(""); }}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>Cancel</button>
            <button onClick={async () => {
              if (!newViewName.trim()) return;
              try {
                await api.createSavedView(newViewName.trim(), {
                  catFilter, acctFilter, sort, clearedFilter, flagFilter,
                });
                setSavedViews(await api.listSavedViews());
                setShowSaveViewSheet(false); setNewViewName("");
                toast?.("View saved", "success");
              } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
            }} className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600">Save</button>
          </div>
        </div>
      </Sheet>

      {/* Scheduled income — pinned above the transaction list. Only shown
          when the user actually has upcoming scheduled rows; hidden
          entirely otherwise so it doesn't take up empty space for users
          who never touch this feature. */}
      {scheduled.length > 0 && (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
          <div className={`px-4 py-2.5 border-b ${theme.border} flex items-center justify-between`}>
            <div className="flex items-center gap-1.5">
              <Calendar className={`w-3.5 h-3.5 ${theme.textSubtle}`} />
              <span className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
                Scheduled ({scheduled.length})
              </span>
            </div>
            <button type="button"
              onClick={() => { setCopyFrom(null); setShowScheduleForm(true); }}
              className="text-xs font-semibold text-violet-500 flex items-center gap-1">
              <Plus className="w-3 h-3" /> Schedule
            </button>
          </div>
          <div className={`divide-y ${theme.divide}`}>
            {scheduled.map(s => {
              const SIcon = CAT_ICONS[s.category] || Briefcase;
              const sColor = CAT_COLORS[s.category] || "#64748b";
              const isPositive = Number(s.amount) >= 0;
              return (
                <button key={s.id} type="button"
                  onClick={() => setDetail(s)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${theme.hover}`}>
                  <div className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                    <SIcon className="w-4 h-4" style={{ color: sColor }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                      <div className="font-medium text-sm truncate">{s.merchant}</div>
                      <ScheduledPill isScheduled darkMode={darkMode} />
                      {s.budgetExpectedIncome ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-500"
                          title="Counts toward the Budgets tab's expected income">
                          <Sparkles className="w-2.5 h-2.5" /> Budget Expected
                        </span>
                      ) : null}
                      {s.recurringKind && s.recurringKind !== "none" ? (
                        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${darkMode ? "bg-slate-800 text-slate-300" : "bg-slate-100 text-slate-600"}`}
                          title="Repeats — next occurrence spawns when adopted">
                          <Repeat className="w-2.5 h-2.5" /> {s.recurringKind === "custom" ? `every ${s.recurringDays}d` : s.recurringKind}
                        </span>
                      ) : null}
                    </div>
                    <div className={`text-xs ${theme.textSubtle} truncate`}>
                      Expected {s.date} · <span className="private-name" tabIndex={0}>{s.accountName || "—"}</span>
                    </div>
                  </div>
                  <div className={`font-semibold text-sm flex-shrink-0 private-amount ${
                    isPositive ? "text-emerald-500" : ""
                  }`} tabIndex={0}>
                    {isPositive ? "+" : "−"}{fmt(Math.abs(Number(s.amount)))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty-state schedule CTA — only for users who have zero scheduled
          rows AND at least one real transaction (so it doesn't clutter the
          empty-app state). Gives a discoverable entry point. */}
      {scheduled.length === 0 && transactions.length > 0 && (
        <button type="button"
          onClick={() => { setCopyFrom(null); setShowScheduleForm(true); }}
          className={`w-full ${theme.surface} border ${theme.border} border-dashed rounded-2xl px-4 py-2.5 text-left flex items-center gap-2 ${theme.textSubtle} hover:text-violet-500 transition-colors`}>
          <Calendar className="w-3.5 h-3.5" />
          <span className="text-xs font-medium">
            Schedule an upcoming paycheck or bill…
          </span>
          <Plus className="w-3.5 h-3.5 ml-auto" />
        </button>
      )}

      {/* Grouped transaction list */}
      {grouped.length === 0 ? (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} px-5 py-12 text-center text-sm ${theme.textSubtle}`}>
          {search || activeFilterCount > 0
            ? "No matching transactions"
            : side === "credit"
              ? "No credit-card transactions yet."
              : "No transactions yet — connect a bank to get started."}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map((group, gIdx) => {
            const total = groupTotal(group.items);
            const isFlat = group.date === "__flat__";
            return (
              // Composite key avoids React key collisions even if two groups
              // ever share a date string (shouldn't happen post-fix but cheap defense).
              <div key={`${group.date}__${gIdx}`}>
                {!isFlat && (
                  <div className="flex items-center justify-between px-1 pb-1.5">
                    <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
                      {fmtGroupDate(group.date)}
                    </div>
                    <div className={`text-[11px] font-semibold private-amount ${total >= 0 ? "text-emerald-500" : theme.textSubtle}`} tabIndex={0}>
                      {total >= 0 ? "+" : "−"}{fmt(Math.abs(total))}
                    </div>
                  </div>
                )}
                <div className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
                  {group.items.map((t, i) => {
                    const Icon = CAT_ICONS[t.category] || Briefcase;
                    const color = CAT_COLORS[t.category] || "#64748b";
                    const voided = !!t.voidedAt;
                    // Merchant display rename — the join in the SELECT emits
                    // merchantDisplayName from merchant_rules; fall back to raw.
                    const shownMerchant = t.merchantDisplayName || t.merchant;
                    // Running balance appears only when a single account is
                    // selected; the meaning would be nonsensical otherwise.
                    const showBalance = acctFilter !== "all" && t.runningBalance !== undefined;
                    return (
                      <motion.button key={t.id}
                        whileTap={{ scale: 0.985 }}
                        onClick={() => setDetail(t)}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left ${i < group.items.length - 1 ? `border-b ${theme.border}` : ""} ${theme.hover} transition-colors ${voided ? "opacity-60 line-through" : ""}`}>
                        {t.flagColor ? (
                          <div className={`w-1.5 h-9 rounded-full flex-shrink-0 bg-${t.flagColor}-500`} />
                        ) : null}
                        <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                          <Icon className="w-4 h-4" style={{ color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <div className="font-medium text-sm truncate">{shownMerchant}</div>
                            <PendingPill pending={t.pending} darkMode={darkMode} />
                            <TransferPill isTransfer={t.isTransfer} darkMode={darkMode} />
                            <AutomationErrorPill hasError={t.hasAutomationError} darkMode={darkMode} />
                            {voided && (
                              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${darkMode ? "bg-slate-800 text-slate-400" : "bg-slate-100 text-slate-500"}`}>Void</span>
                            )}
                            {t.reconciliationId ? (
                              <span className="text-[9px] font-bold uppercase text-emerald-500">R</span>
                            ) : t.cleared ? (
                              <span className={`text-[9px] font-bold uppercase ${theme.textSubtle}`}>c</span>
                            ) : null}
                          </div>
                          <div className={`text-xs ${theme.textSubtle} truncate`}>
                            {isFlat ? `${t.date} · ` : ""}{t.checkNumber ? `#${t.checkNumber} · ` : ""}{t.category} · <span className="private-name" tabIndex={0}>{t.accountName || "—"}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <ReceiptMarker hasAttachment={t.hasAttachment} />
                          <div className="text-right">
                            <div className={`font-semibold text-sm private-amount ${
                              t.isTransfer ? "text-sky-500" : Number(t.amount) >= 0 ? "text-emerald-500" : ""
                            }`} tabIndex={0}>
                              {t.isTransfer ? "±" : Number(t.amount) >= 0 ? "+" : "−"}{fmt(Math.abs(Number(t.amount)))}
                            </div>
                            {showBalance && (
                              <div className={`text-[10px] ${theme.textSubtle} private-amount tabular-nums`} tabIndex={0}>
                                bal {fmt(t.runningBalance)}
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add transaction sheet */}
      <Sheet open={showAdd} onClose={() => setShowAdd(false)} title="Add Transaction" theme={theme}>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Type</label>
            <div className={`flex p-1 rounded-xl ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
              <button type="button" onClick={() => setForm({ ...form, sign: "out" })}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${form.sign === "out" ? (darkMode ? "bg-slate-900 shadow text-rose-400" : "bg-white shadow text-rose-600") : theme.textMuted}`}>
                Expense
              </button>
              <button type="button" onClick={() => setForm({ ...form, sign: "in" })}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${form.sign === "in" ? (darkMode ? "bg-slate-900 shadow text-violet-400" : "bg-white shadow text-violet-600") : theme.textMuted}`}>
                Income
              </button>
            </div>
          </div>
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Date</label>
            <input type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}
              className={inputCls} />
          </div>
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Merchant / Description</label>
            <input required value={form.merchant}
              onChange={e => setForm({ ...form, merchant: e.target.value })}
              onBlur={async e => {
                const q = e.target.value.trim();
                if (q.length < 2) return;
                try {
                  const { hit } = await api.payeeHint(q);
                  if (!hit) return;
                  // Prefill category + account IFF the user hasn't already
                  // picked non-defaults. This avoids overwriting a deliberate
                  // choice with a stale memory.
                  const patch = {};
                  if (form.category === "Other") patch.category = hit.category;
                  if (!form.account_id && hit.accountId) patch.account_id = String(hit.accountId);
                  if (Object.keys(patch).length) {
                    setForm(f => ({ ...f, ...patch }));
                    setPayeeHintApplied(`Prefilled from a past ${q} entry`);
                  }
                } catch { /* silent — hint is best-effort */ }
              }}
              placeholder="Whole Foods" className={inputCls} />
            {payeeHintApplied && (
              <div className="text-[10px] text-emerald-500 mt-1">{payeeHintApplied}</div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Amount</label>
              <input type="number" step="0.01" min="0" required value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                placeholder="0.00" className={inputCls} />
            </div>
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Category</label>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                className={inputCls}>
                {catList.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Account</label>
              <select value={form.account_id} onChange={e => setForm({ ...form, account_id: e.target.value })}
                className={inputCls}>
                <option value="">— No account —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.institution ? ` · ${a.institution}` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Check # (optional)</label>
              <input value={form.check_number} onChange={e => setForm({ ...form, check_number: e.target.value })}
                placeholder="1024" className={inputCls} />
            </div>
          </div>
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Note (optional)</label>
            <textarea value={form.note} onChange={e => setForm({ ...form, note: e.target.value })}
              rows={2} className={`${inputCls} resize-none`} />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setShowAdd(false)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
              Cancel
            </button>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={adding}
              className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Adding…" : "Add transaction"}
            </motion.button>
          </div>
        </form>
      </Sheet>

      {/* Transfer between accounts sheet */}
      <TransferSheet open={showTransfer} onClose={() => setShowTransfer(false)}
        accounts={accounts} theme={theme} darkMode={darkMode} toast={toast}
        onSaved={() => { setShowTransfer(false); refreshAll(); }} />

      {/* Transaction detail / delete sheet */}
      <Sheet open={!!detail} onClose={() => {
        setDetail(null); setCatEdit(null); setSplitDraft(null);
        if (receiptState.url) URL.revokeObjectURL(receiptState.url);
        setReceiptState({ url: null, loading: false, error: null, uploading: false });
      }} title="Transaction" theme={theme}>
        {detail && (() => {
          const Icon = CAT_ICONS[detail.category] || Briefcase;
          const color = CAT_COLORS[detail.category] || "#64748b";
          const isIncome = Number(detail.amount) >= 0;

          // Stage 2: ask scope after a new category is picked
          if (catEdit?.stage === "scope") {
            const NewIcon = CAT_ICONS[catEdit.newCategory] || Briefcase;
            const newColor = CAT_COLORS[catEdit.newCategory] || "#64748b";
            return (
              <div className="space-y-4">
                <div className="text-center py-2">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>
                    <ArrowUpRight className={`w-4 h-4 ${theme.textSubtle} rotate-45`} />
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                      <NewIcon className="w-4 h-4" style={{ color: newColor }} />
                    </div>
                  </div>
                  <p className="text-sm font-medium">Change <span className="font-semibold">{detail.merchant}</span> to <span className="font-semibold">{catEdit.newCategory}</span>?</p>
                  <p className={`text-xs ${theme.textSubtle} mt-1`}>
                    Apply this change to which transactions?
                  </p>
                </div>
                <div className="space-y-2">
                  <motion.button whileTap={{ scale: 0.97 }} onClick={() => applyCategoryChange("one")}
                    className={`w-full p-3.5 rounded-2xl border ${theme.border} text-left ${theme.hover}`}>
                    <div className="font-semibold text-sm">Just this one</div>
                    <div className={`text-xs ${theme.textSubtle} mt-0.5`}>Only this transaction is recategorised.</div>
                  </motion.button>
                  <motion.button whileTap={{ scale: 0.97 }} onClick={() => applyCategoryChange("all")}
                    className="w-full p-3.5 rounded-2xl border border-violet-500 bg-violet-500/10 text-left">
                    <div className="font-semibold text-sm text-violet-600 dark:text-violet-400">All transactions from {detail.merchant}</div>
                    <div className={`text-xs ${theme.textSubtle} mt-0.5`}>Saves a rule so future syncs auto-apply this category too.</div>
                  </motion.button>
                </div>
                <button type="button" onClick={() => setCatEdit(null)}
                  className={`w-full py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>
                  Cancel
                </button>
              </div>
            );
          }

          // Stage 1: pick a new category
          if (catEdit?.stage === "pick") {
            return (
              <div className="space-y-3">
                <p className={`text-sm ${theme.textSubtle}`}>Pick a new category for {detail.merchant}</p>
                <div className="grid grid-cols-2 gap-2 max-h-[55vh] overflow-y-auto">
                  {catList.map(c => {
                    const CIcon = CAT_ICONS[c] || Briefcase;
                    const cColor = CAT_COLORS[c] || "#64748b";
                    const isCurrent = c === detail.category;
                    return (
                      <button key={c} type="button" disabled={isCurrent}
                        onClick={() => setCatEdit({ stage: "scope", newCategory: c })}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm text-left ${theme.hover} ${
                          isCurrent ? "opacity-50" : ""
                        } ${theme.border}`}>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                             style={{ backgroundColor: `${cColor}20` }}>
                          <CIcon className="w-3.5 h-3.5" style={{ color: cColor }} />
                        </div>
                        <span className="font-medium truncate">{c}</span>
                      </button>
                    );
                  })}
                </div>
                <button type="button" onClick={() => setCatEdit(null)}
                  className={`w-full py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>
                  Cancel
                </button>
              </div>
            );
          }

          // Default: detail view
          return (
            <div className="space-y-4">
              <div className="flex flex-col items-center text-center py-4">
                <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-3 ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                  <Icon className="w-7 h-7" style={{ color }} />
                </div>
                <div className="flex items-center gap-2 flex-wrap justify-center">
                  <div className="text-xl font-semibold">{detail.merchant}</div>
                  <PendingPill pending={detail.pending} darkMode={darkMode} />
                  <TransferPill isTransfer={detail.isTransfer} darkMode={darkMode} />
                  <ScheduledPill isScheduled={detail.isScheduled} darkMode={darkMode} />
                  <AutomationErrorPill hasError={detail.hasAutomationError} darkMode={darkMode} />
                </div>
                <div className={`text-3xl font-bold mt-2 ${
                  detail.isTransfer ? "text-sky-500" : isIncome ? "text-emerald-500" : ""
                }`}>
                  {detail.isTransfer ? "±" : isIncome ? "+" : "−"}{fmt(Math.abs(Number(detail.amount)))}
                </div>
                {!!detail.pending && (
                  <p className={`text-[11px] ${theme.textSubtle} mt-2 max-w-[260px]`}>
                    Authorized but not yet settled by your bank. The amount or
                    merchant name may change once it posts.
                  </p>
                )}
                {!!detail.isTransfer && (
                  <p className={`text-[11px] ${theme.textSubtle} mt-2 max-w-[260px]`}>
                    Internal transfer between your own accounts — excluded
                    from income, spending, and budget totals.
                  </p>
                )}
                {!!detail.isScheduled && (
                  <p className={`text-[11px] ${theme.textSubtle} mt-2 max-w-[260px]`}>
                    Scheduled — expected to arrive on this date. Excluded
                    from budget + income totals until adopted by a real
                    transaction from your bank (or you mark it arrived).
                  </p>
                )}
              </div>
              <div className={`${darkMode ? "bg-slate-800/50" : "bg-slate-50"} rounded-2xl divide-y ${theme.divide}`}>
                <DetailRow label="Date"     value={detail.date} theme={theme} />
                {/* Category row tappable to change */}
                <button type="button" onClick={() => setCatEdit({ stage: "pick" })}
                  className={`w-full flex items-center justify-between px-4 py-3 ${theme.hover} transition-colors`}>
                  <span className={`text-sm ${theme.textSubtle}`}>Category</span>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {detail.category}
                    <Pencil className={`w-3.5 h-3.5 ${theme.textSubtle}`} />
                  </span>
                </button>
                <DetailRow label="Account"  value={detail.accountName || "—"} theme={theme} />
                {detail.checkNumber && <DetailRow label="Check #" value={detail.checkNumber} theme={theme} />}
                {detail.note && <DetailRow label="Note" value={detail.note} theme={theme} />}
              </div>

              {/* Rename this merchant everywhere — creates or updates the
                  merchant_rule with a display_name so every row for this
                  raw merchant string renders under the friendly name. */}
              <button type="button"
                onClick={async () => {
                  const suggested = detail.merchantDisplayName || detail.merchant;
                  const val = window.prompt(
                    `Rename "${detail.merchant}" everywhere it appears?\n\nLeave blank to clear the rename.`,
                    suggested
                  );
                  if (val === null) return;
                  try {
                    // Upsert a merchant rule for this raw merchant, then set its
                    // display_name via PATCH. The recategorize endpoint is the
                    // simplest way to guarantee the rule row exists.
                    await api.recategorizeMerchant(detail.merchant, detail.category);
                    const rules = await api.getMerchantRules();
                    const rule = rules.find(r => r.merchant === detail.merchant);
                    if (rule) {
                      await api.updateMerchantRule(rule.id, {
                        display_name: val.trim() || "",
                      });
                    }
                    toast?.(val.trim() ? `Renamed to "${val.trim()}"` : "Rename cleared", "success");
                    // Update the sheet's copy of the merchant display name
                    // in place so the user can keep editing. The register
                    // itself updates via refreshAll.
                    setDetail({ ...detail, merchantDisplayName: val.trim() || null });
                    refreshAll();
                  } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                }}
                className={`w-full text-xs font-medium ${theme.textSubtle} hover:text-violet-500 py-2`}>
                Rename "{detail.merchant}" everywhere…
              </button>

              {/* Paystub detail — only offered on positive-amount rows.
                  Skipped for transfers since those aren't real income. */}
              {isIncome && !detail.isTransfer && (
                <div className={`rounded-2xl border ${theme.border} p-4`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider flex items-center gap-1.5`}>
                      <FileText className="w-3 h-3" /> Paystub detail
                    </div>
                    <button type="button"
                      onClick={() => setPaystubEdit(detail)}
                      className="text-xs font-semibold text-violet-500 flex items-center gap-1">
                      <Pencil className="w-3 h-3" />
                      {detail.paystub ? "Edit" : "Add detail"}
                    </button>
                  </div>
                  {detail.paystub ? (
                    <div className="space-y-1.5 text-xs">
                      {detail.paystub.companyName && (
                        <div className="flex justify-between">
                          <span className={theme.textSubtle}>Company</span>
                          <span className="font-medium">{detail.paystub.companyName}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className={theme.textSubtle}>Gross</span>
                        <span className="font-semibold">{fmt(sumRows(detail.paystub.earnings))}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className={theme.textSubtle}>Deductions</span>
                        <span className="font-semibold text-rose-500">
                          −{fmt(
                            sumRows(detail.paystub.preTax)
                            + sumRows(detail.paystub.taxes)
                            + sumRows(detail.paystub.postTax)
                          )}
                        </span>
                      </div>
                      <div className={`flex justify-between pt-1 border-t ${theme.border}`}>
                        <span className="font-semibold">Net (calculated)</span>
                        <span className="font-bold text-emerald-500">
                          {fmt(
                            sumRows(detail.paystub.earnings)
                            - sumRows(detail.paystub.preTax)
                            - sumRows(detail.paystub.taxes)
                            - sumRows(detail.paystub.postTax)
                          )}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className={`text-xs ${theme.textSubtle}`}>
                      Break this paycheck out by earnings, taxes, deductions,
                      and deposits — matches what your paystub shows.
                    </p>
                  )}
                </div>
              )}

              {/* Receipt attachment — hidden on scheduled rows (no bank
                  record yet to receipt) AND on split children (child rows
                  reference the parent's receipt, which prevents dupes and
                  keeps the 1-per-txn cap meaningful). */}
              {!detail.isScheduled && !(detail.note || "").startsWith("Split from #") && (
                <div className={`rounded-2xl border ${theme.border} p-4`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider flex items-center gap-1.5`}>
                      <ImageIcon className="w-3 h-3 text-pink-500" /> Receipt
                    </div>
                    {!!detail.hasAttachment && receiptState.url && (
                      <div className="flex gap-2">
                        <button type="button"
                          onClick={() => {
                            // Print flow: pop a minimal window with just the
                            // image, then trigger the browser print dialog.
                            const w = window.open("", "_blank");
                            if (!w) return;
                            w.document.write(`<!doctype html><html><head><title>Receipt — ${
                              detail.merchant.replace(/</g, "&lt;")
                            }</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff}img{max-width:100%;max-height:100vh;object-fit:contain}@media print{body{min-height:auto}img{max-height:none}}</style></head><body><img src="${receiptState.url}" onload="setTimeout(()=>window.print(),200)"/></body></html>`);
                            w.document.close();
                          }}
                          className="text-xs font-semibold text-pink-500 flex items-center gap-1">
                          <Printer className="w-3 h-3" /> Print
                        </button>
                        <button type="button"
                          onClick={async () => {
                            if (!confirm("Delete this receipt?")) return;
                            try {
                              await api.deleteAttachment(detail.id);
                              toast?.("Receipt deleted", "success");
                              if (receiptState.url) URL.revokeObjectURL(receiptState.url);
                              setReceiptState({ url: null, loading: false, error: null, uploading: false });
                              // Keep the sheet open — the user often
                              // wants to re-upload a corrected receipt
                              // right after deleting a bad one.
                              setDetail({ ...detail, hasAttachment: false });
                              refreshAll();
                            } catch (e) {
                              toast?.("Failed: " + (e.message || ""), "error");
                            }
                          }}
                          className="text-xs font-semibold text-rose-500 flex items-center gap-1">
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Hidden input, triggered by the visible button. Accepts
                      PNG / JPG only — the server rejects everything else. */}
                  <input ref={receiptFileRef} type="file" accept="image/png,image/jpeg"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) {
                        toast?.("Max 5 MB", "error");
                        return;
                      }
                      setReceiptState(s => ({ ...s, uploading: true, error: null }));
                      try {
                        await api.uploadAttachment(detail.id, file);
                        toast?.("Receipt uploaded", "success");
                        // Refresh the object URL from the new file.
                        if (receiptState.url) URL.revokeObjectURL(receiptState.url);
                        const url = await api.fetchAttachment(detail.id);
                        setReceiptState({ url, loading: false, error: null, uploading: false });
                        refreshAll();
                      } catch (e) {
                        setReceiptState(s => ({ ...s, uploading: false, error: e.message }));
                        toast?.("Upload failed: " + (e.message || ""), "error");
                      }
                    }}
                  />
                  {detail.hasAttachment ? (
                    receiptState.loading ? (
                      <p className={`text-xs ${theme.textSubtle}`}>Loading receipt…</p>
                    ) : receiptState.error ? (
                      <p className={`text-xs text-rose-500`}>Failed: {receiptState.error}</p>
                    ) : receiptState.url ? (
                      <div className="space-y-2">
                        <img src={receiptState.url} alt="Receipt"
                          className={`w-full rounded-lg border ${theme.border} max-h-80 object-contain bg-white`} />
                        <button type="button"
                          disabled={receiptState.uploading}
                          onClick={() => receiptFileRef.current?.click()}
                          className={`w-full py-2 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover} flex items-center justify-center gap-1.5 disabled:opacity-60`}>
                          <Upload className="w-3 h-3" />
                          {receiptState.uploading ? "Uploading…" : "Replace receipt"}
                        </button>
                      </div>
                    ) : null
                  ) : (
                    <button type="button"
                      disabled={receiptState.uploading}
                      onClick={() => receiptFileRef.current?.click()}
                      className={`w-full py-2 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover} text-pink-500 flex items-center justify-center gap-1.5 disabled:opacity-60`}>
                      <Upload className="w-3 h-3" />
                      {receiptState.uploading ? "Uploading…" : "Add receipt (PNG / JPG, 5 MB max)"}
                    </button>
                  )}
                </div>
              )}

              {/* Manual split — only on non-scheduled rows that haven't
                  been split yet and aren't split children themselves.
                  Sum of splits ≤ |parent|; residual stays on parent. */}
              {!detail.isScheduled
                && !(detail.note || "").includes("[Split into ")
                && !(detail.note || "").startsWith("Split from #") && (
                <div className={`rounded-2xl border ${theme.border} p-4`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider flex items-center gap-1.5`}>
                      <Split className="w-3 h-3" /> Split transaction
                    </div>
                    {!splitDraft && (
                      <button type="button"
                        onClick={() => setSplitDraft([
                          { category: "Other", amount: "", note: "" },
                          { category: "Other", amount: "", note: "" },
                        ])}
                        className="text-xs font-semibold text-violet-500 flex items-center gap-1">
                        <Plus className="w-3 h-3" /> Split
                      </button>
                    )}
                  </div>
                  {!splitDraft ? (
                    <p className={`text-xs ${theme.textSubtle}`}>
                      Break this ${fmt(Math.abs(Number(detail.amount)))} charge into
                      multiple categories (e.g. groceries + household from a
                      single Target run). Any residual stays on this row.
                    </p>
                  ) : (
                    (() => {
                      const total = splitDraft.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                      const parentAbs = Math.abs(Number(detail.amount));
                      const remaining = parentAbs - total;
                      const overflow = total > parentAbs + 0.001;
                      return (
                        <div className="space-y-2">
                          {splitTemplates.length > 0 && (
                            <div className="flex items-center gap-2">
                              <select
                                onChange={e => {
                                  const t = splitTemplates.find(t => String(t.id) === e.target.value);
                                  if (!t) return;
                                  const parent = Math.abs(Number(detail.amount));
                                  const lines = t.lines.map(l => ({
                                    category: l.category,
                                    amount: t.kind === "percent"
                                      ? (parent * (Number(l.percent) || 0) / 100).toFixed(2)
                                      : String(l.amount ?? ""),
                                    note: l.note || "",
                                  }));
                                  setSplitDraft(lines);
                                  e.target.value = "";
                                }}
                                className={`${inputCls} flex-1`} defaultValue="">
                                <option value="">Apply template…</option>
                                {splitTemplates.map(t => (
                                  <option key={t.id} value={t.id}>{t.name} ({t.kind})</option>
                                ))}
                              </select>
                            </div>
                          )}
                          {splitDraft.map((r, i) => (
                            <div key={i} className="flex gap-1.5">
                              <select value={r.category}
                                onChange={e => setSplitDraft(d => d.map((x, idx) => idx === i ? { ...x, category: e.target.value } : x))}
                                className={`${inputCls} flex-1`}>
                                {catList.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                              <input type="number" step="0.01" placeholder="Amount"
                                value={r.amount}
                                onChange={e => setSplitDraft(d => d.map((x, idx) => idx === i ? { ...x, amount: e.target.value } : x))}
                                className={`${inputCls} w-24`} />
                              {splitDraft.length > 1 && (
                                <button type="button"
                                  onClick={() => setSplitDraft(d => d.filter((_, idx) => idx !== i))}
                                  className={`px-2 rounded-lg border ${theme.border} ${theme.hover}`}>
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ))}
                          <button type="button"
                            onClick={() => setSplitDraft(d => [...d, { category: "Other", amount: "", note: "" }])}
                            className={`w-full py-1.5 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover} flex items-center justify-center gap-1`}>
                            <Plus className="w-3 h-3" /> Add row
                          </button>
                          <div className={`flex justify-between text-xs pt-1 border-t ${theme.border}`}>
                            <span className={theme.textSubtle}>Total / Parent</span>
                            <span className={`font-semibold ${overflow ? "text-rose-500" : ""}`}>
                              {fmt(total)} / {fmt(parentAbs)}
                            </span>
                          </div>
                          <div className={`flex justify-between text-xs`}>
                            <span className={theme.textSubtle}>Residual on parent</span>
                            <span className="font-semibold">{fmt(Math.max(0, remaining))}</span>
                          </div>
                          <div className="flex gap-2 pt-1">
                            <button type="button"
                              onClick={() => setSplitDraft(null)}
                              className={`flex-1 py-2 rounded-lg text-xs font-medium ${theme.textSubtle}`}>
                              Cancel
                            </button>
                            <button type="button"
                              disabled={splitSaving || overflow || total <= 0}
                              onClick={async () => {
                                setSplitSaving(true);
                                try {
                                  const splits = splitDraft
                                    .filter(r => Number(r.amount) > 0)
                                    .map(r => ({
                                      category: r.category,
                                      amount: Number(r.amount),
                                      note: r.note || undefined,
                                    }));
                                  await api.splitTransaction(detail.id, splits);
                                  toast?.(`Split into ${splits.length} rows`, "success");
                                  setSplitDraft(null);
                                  // Leave the detail sheet open — the
                                  // parent row still exists as a split
                                  // container; user might want to attach
                                  // a receipt or set a flag on it.
                                  refreshAll();
                                } catch (e) {
                                  toast?.("Failed: " + (e.message || ""), "error");
                                } finally { setSplitSaving(false); }
                              }}
                              className={`flex-1 py-2 rounded-lg text-xs font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-40`}>
                              {splitSaving ? "Splitting…" : "Save split"}
                            </button>
                          </div>
                          <button type="button"
                            onClick={async () => {
                              const validRows = splitDraft.filter(r => Number(r.amount) > 0);
                              if (validRows.length < 2) { toast?.("Need at least 2 lines", "warning"); return; }
                              const name = window.prompt("Name this template (e.g. Paycheck 60/40):");
                              if (!name || !name.trim()) return;
                              const kind = window.confirm("Save as percentages? OK = percent (rescales to any future amount) · Cancel = fixed amounts")
                                ? "percent" : "fixed";
                              try {
                                const total2 = validRows.reduce((s, r) => s + Number(r.amount), 0);
                                const lines = validRows.map(r => ({
                                  category: r.category,
                                  amount: kind === "fixed" ? Number(r.amount) : null,
                                  percent: kind === "percent" ? Number(((Number(r.amount) / total2) * 100).toFixed(2)) : null,
                                  note: r.note || null,
                                }));
                                await api.createSplitTemplate({ name: name.trim(), kind, lines });
                                setSplitTemplates(await api.listSplitTemplates());
                                toast?.(`Template "${name.trim()}" saved`, "success");
                              } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                            }}
                            className={`w-full text-xs font-medium ${theme.textSubtle} hover:text-violet-500 py-1`}>
                            Save this as a template…
                          </button>
                        </div>
                      );
                    })()
                  )}
                </div>
              )}

              {/* Manual classification override — only offered on posted rows.
                  Scheduled rows are excluded from rollups anyway, so their
                  sign / transfer flag doesn't affect anything until adopted.
                  "Apply to all from this merchant" flips the write path from
                  the per-row classify endpoint to the merchant-scoped
                  reclassify endpoint, which also saves a forced_type rule
                  so every future Plaid sync agrees. */}
              {!detail.isScheduled && (() => {
                const current = detail.isTransfer
                  ? "transfer"
                  : Number(detail.amount) >= 0 ? "income" : "expense";
                const opts = [
                  { key: "income",   label: "Income",   activeCls: "text-violet-500 border-violet-500" },
                  { key: "expense",  label: "Expense",  activeCls: "text-rose-500 border-rose-500" },
                  { key: "transfer", label: "Transfer", activeCls: "text-sky-500 border-sky-500" },
                ];
                const setClass = async (kind) => {
                  if (kind === current) return;
                  try {
                    if (applyToMerchant) {
                      const res = await api.reclassifyMerchant(detail.merchant, kind);
                      toast?.(`Marked ${res.updated || 0} rows as ${kind} + rule saved`, "success");
                    } else {
                      await api.classifyTransaction(detail.id, kind);
                      toast?.(`Marked as ${kind}`, "success");
                    }
                    // Patch the open sheet's local view so the buttons
                    // reflect the new state without a re-open. Amount sign
                    // flips for income/expense to match the backend, which
                    // rewrites the sign on the row; is_transfer flips
                    // between transfer and non-transfer.
                    const nextAmount =
                      kind === "income"   ? Math.abs(Number(detail.amount)) :
                      kind === "expense"  ? -Math.abs(Number(detail.amount)) :
                                            Number(detail.amount);
                    setDetail({
                      ...detail,
                      amount: nextAmount,
                      isTransfer: kind === "transfer" ? 1 : 0,
                      transferGroupId: kind === "transfer" ? detail.transferGroupId : null,
                    });
                    refreshAll();
                  } catch (e) {
                    toast?.("Failed: " + (e.message || ""), "error");
                  }
                };
                return (
                  <div className={`rounded-2xl border ${theme.border} p-4`}>
                    <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>
                      Classification
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {opts.map(o => {
                        const active = o.key === current;
                        return (
                          <button key={o.key} type="button" onClick={() => setClass(o.key)}
                            className={`py-2 rounded-xl text-xs font-semibold border transition-colors ${
                              active ? `${o.activeCls} bg-transparent`
                                     : `${theme.border} ${theme.textSubtle} hover:${theme.hover}`
                            }`}>
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                    <label className="flex items-start gap-2 mt-2 cursor-pointer text-[11px]">
                      <input type="checkbox" checked={applyToMerchant}
                        onChange={e => setApplyToMerchant(e.target.checked)}
                        className="mt-0.5 accent-violet-500" />
                      <div>
                        <div className={theme.textMuted}>Apply to all from "{detail.merchant}"</div>
                        <div className={theme.textSubtle}>
                          Saves a rule so every future Plaid sync forces this classification too.
                        </div>
                      </div>
                    </label>
                    <p className={`text-[11px] ${theme.textSubtle} mt-2`}>
                      Override auto-classification if it's wrong. Switching to
                      Income / Expense flips the sign; Transfer excludes the
                      row from income + spending totals.
                    </p>
                  </div>
                );
              })()}

              {/* Deductible toggle — flags an individual transaction for
                  Schedule A even if its category has no tax schedule set.
                  Reads/writes the isDeductible boolean on the row. */}
              {!detail.isScheduled && (
                <div className={`rounded-2xl border ${theme.border} p-4 flex items-center justify-between gap-3`}>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">Tax deductible</div>
                    <div className={`text-[11px] ${theme.textSubtle}`}>
                      Include this transaction in the year-end tax summary PDF.
                    </div>
                  </div>
                  <Toggle checked={!!detail.isDeductible} darkMode={darkMode}
                    onChange={async (v) => {
                      try {
                        await api.updateTransaction(detail.id, { is_deductible: v });
                        setDetail({ ...detail, isDeductible: v });
                        toast?.(v ? "Marked deductible" : "Removed deductible", "success");
                        refreshAll();
                      } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                    }} />
                </div>
              )}

              {detail.plaidItemId && (
                <p className={`text-xs ${theme.textSubtle} text-center`}>
                  This is a synced transaction. Deleting it here won't remove it from your bank.
                </p>
              )}

              {/* Schedule actions.
                  Non-scheduled rows: single (Copy & schedule) button —
                    make a future placeholder from this transaction.
                  Scheduled rows: BOTH buttons side-by-side —
                    (Copy & schedule)   (Mark Present)
                  followed by the delete row below (spans full width). */}
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => {
                    setCopyFrom(detail);
                    setShowScheduleForm(true);
                    setDetail(null);
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium border ${theme.border} ${theme.surface} text-indigo-500 hover:bg-indigo-500/10 flex items-center justify-center gap-2`}>
                  <Calendar className="w-4 h-4" /> Copy &amp; schedule
                </button>
                {!!detail.isScheduled && (
                  <button type="button"
                    onClick={async () => {
                      try {
                        await api.setTransactionScheduled(detail.id, false);
                        toast?.("Marked present", "success");
                        // Sheet stays open with the scheduled flag flipped
                        // so the user can also tweak flag / note / receipt
                        // right after adopting.
                        setDetail({ ...detail, isScheduled: false });
                        refreshAll();
                      } catch (e) {
                        toast?.("Failed: " + (e.message || ""), "error");
                      }
                    }}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border ${theme.border} ${theme.surface} text-violet-500 hover:bg-violet-500/10 flex items-center justify-center gap-2`}>
                    <Check className="w-4 h-4" /> Mark Present
                  </button>
                )}
              </div>

              {/* Exclude-from-budget-income toggle — only meaningful on
                  income (positive, non-transfer) rows. Lets you keep a
                  transaction like a tax refund or gift in the register
                  without letting it inflate the zero-based budget's
                  income bar. */}
              {Number(detail.amount) > 0 && !detail.isTransfer && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={!!detail.excludeFromBudgetIncome}
                    onChange={async e => {
                      const val = e.target.checked;
                      try {
                        await api.updateTransaction(detail.id, { exclude_from_budget_income: val });
                        setDetail({ ...detail, excludeFromBudgetIncome: val });
                        refreshAll();
                        toast?.(val ? "Excluded from budget income" : "Counted in budget income", "success");
                      } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                    }}
                    className="w-4 h-4 accent-violet-500 mt-0.5" />
                  <div className="flex-1">
                    <div>Exclude from budget income</div>
                    <div className={`text-[10px] ${theme.textSubtle}`}>
                      Keeps this row in the register but drops it out of the master-period income total.
                    </div>
                  </div>
                </label>
              )}

              {/* Budget Expected Income — same class of toggle, but flips
                  the OPPOSITE way: include this in the budgets tab's
                  "Expected income" bar. Meaningful on any income row
                  (scheduled or arrived); adoption preserves the flag so
                  an adopted paycheck keeps counting. */}
              {Number(detail.amount) > 0 && !detail.isTransfer && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={!!detail.budgetExpectedIncome}
                    onChange={async e => {
                      const val = e.target.checked;
                      try {
                        await api.updateTransaction(detail.id, { budget_expected_income: val });
                        setDetail({ ...detail, budgetExpectedIncome: val });
                        refreshAll();
                        toast?.(val ? "Included in expected income" : "Removed from expected income", "success");
                      } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                    }}
                    className="w-4 h-4 accent-violet-500 mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-violet-500" /> Budget Expected Income
                    </div>
                    <div className={`text-[10px] ${theme.textSubtle}`}>
                      Adds this amount to the Budgets tab's expected-income
                      bar and the zero-based-budget slider's basis.
                    </div>
                  </div>
                </label>
              )}

              {/* Flag colour picker — filter your register at a glance */}
              <div>
                <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>Flag</div>
                <div className="flex items-center gap-2 flex-wrap">
                  {[null, "red", "orange", "amber", "emerald", "sky", "violet", "rose"].map(c => (
                    <button key={c || "none"} type="button"
                      onClick={async () => {
                        try {
                          await api.updateTransaction(detail.id, { flag_color: c });
                          toast?.(c ? `Flagged ${c}` : "Flag cleared", "success");
                          setDetail({ ...detail, flagColor: c });
                          refreshAll();
                        } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                      }}
                      className={`w-7 h-7 rounded-full border-2 flex items-center justify-center ${
                        c ? `bg-${c}-500 border-${c}-600` : `${theme.surface} border-slate-400`
                      } ${detail.flagColor === c ? "ring-2 ring-offset-2 ring-violet-500" : ""}`}
                      aria-label={c || "no flag"}>
                      {!c && <span className="text-[10px]">×</span>}
                    </button>
                  ))}
                </div>
              </div>

              {/* Void toggle — Quicken parity. Voided rows stay visible
                  with a strikethrough but drop out of every aggregation. */}
              <motion.button whileTap={{ scale: 0.97 }}
                onClick={async () => {
                  try {
                    if (detail.voidedAt) {
                      await api.unvoidTransaction(detail.id);
                      toast?.("Transaction restored", "success");
                    } else {
                      if (!window.confirm(`Void "${detail.merchant}"? It'll stay visible but drop out of budgets, cashflow, and reports.`)) return;
                      await api.voidTransaction(detail.id);
                      toast?.("Transaction voided", "success");
                    }
                    // Toggle the local void state and stay open — the
                    // user often wants to add a note explaining the void
                    // right after flipping it.
                    setDetail({
                      ...detail,
                      voidedAt: detail.voidedAt ? null : new Date().toISOString(),
                    });
                    refreshAll();
                  } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                }}
                className={`w-full py-3 rounded-xl text-sm font-semibold border ${theme.border} ${theme.surface} ${detail.voidedAt ? "text-emerald-500 hover:bg-emerald-500/10" : "text-amber-500 hover:bg-amber-500/10"} flex items-center justify-center gap-2`}>
                {detail.voidedAt ? "Restore (unvoid)" : "Void transaction"}
              </motion.button>

              <motion.button whileTap={{ scale: 0.97 }} onClick={deleteTransaction} disabled={deleting}
                className="w-full bg-rose-500 hover:bg-rose-600 text-white py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
                <Trash2 className="w-4 h-4" />
                {deleting ? "Deleting…" : "Delete transaction"}
              </motion.button>
            </div>
          );
        })()}
      </Sheet>

      {/* Paystub editor — mounted whenever the user taps "Add detail" /
          "Edit" on an income row. Uses the transaction snapshot in
          `paystubEdit` for its initial state; refresh on save so the
          summary in the detail sheet updates in place. */}
      <PaystubSheet
        open={!!paystubEdit}
        onClose={() => setPaystubEdit(null)}
        transaction={paystubEdit}
        initial={paystubEdit?.paystub || null}
        accounts={accounts}
        theme={theme} darkMode={darkMode}
        toast={toast}
        onSaved={refreshAll}
      />

      {/* Schedule form — new scheduled row, or a copy-and-schedule seeded
          from `copyFrom`. Reused for both entry points. */}
      <ScheduleSheet
        open={showScheduleForm}
        onClose={() => { setShowScheduleForm(false); setCopyFrom(null); }}
        copyFrom={copyFrom}
        accounts={accounts}
        catList={catList}
        theme={theme} darkMode={darkMode}
        toast={toast}
        onSaved={() => { setShowScheduleForm(false); setCopyFrom(null); loadScheduled(); refreshAll(); }}
      />
    </div>
  );
}

function DetailRow({ label, value, theme }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className={`text-sm ${theme.textSubtle}`}>{label}</span>
      <span className="text-sm font-medium text-right ml-3 break-words">{value}</span>
    </div>
  );
}

// ─── Paystub detail editor ────────────────────────────────────────────────────
// Attaches an itemised breakdown to a positive-amount transaction:
//   Earnings → Pre-Tax Deductions → Taxes → After-Tax Deductions → Deposits
//
// Section shapes are all identical rows of { name, category, amount } (deposits
// swap category for an optional accountId). We keep the sections orthogonal so
// the UI grid stays consistent; totals summed across sections give
// Gross → Net so the user gets a sanity check at the bottom.
//
// The whole payload is opaque to the backend (LONGTEXT JSON). If the user
// clears every row we PUT `null` to remove the attachment.
// Row shapes per section:
//   Earnings + Taxes: { name, category, amount }
//     — earnings come FROM the employer; taxes go OUT to a tax authority.
//     Neither routes to a Coinvane account.
//   Pre-Tax + Post-Tax deductions: { name, category, accountId?, amount }
//     — many deductions ARE the paycheck being split into another account
//     (401k, HSA, Roth, ESPP, savings sweep). accountId is optional; when
//     set, the amount is destined for that Coinvane account and the user
//     can see the split reflected across their book. Matches Quicken's
//     bracketed "[Account name]" rows in those sections.
//   Deposits: { accountId, memo, amount }
//     — always account-scoped by definition.
const EMPTY_ROW           = { name: "", category: "", amount: "" };
const EMPTY_DEDUCTION_ROW = { name: "", category: "", accountId: "", amount: "" };
const EMPTY_DEPOSIT       = { accountId: "", memo: "", amount: "" };
const emptyPaystub = () => ({
  companyName: "",
  memo: "",
  earnings: [{ ...EMPTY_ROW }],
  preTax:   [{ ...EMPTY_DEDUCTION_ROW }],
  taxes:    [{ ...EMPTY_ROW }],
  postTax:  [{ ...EMPTY_DEDUCTION_ROW }],
  deposits: [{ ...EMPTY_DEPOSIT }],
});
function normalizePaystub(p) {
  if (!p) return emptyPaystub();
  return {
    companyName: p.companyName || "",
    memo:        p.memo        || "",
    earnings:    (p.earnings || []).map(r => ({ ...EMPTY_ROW,           ...r })),
    preTax:      (p.preTax   || []).map(r => ({ ...EMPTY_DEDUCTION_ROW, ...r })),
    taxes:       (p.taxes    || []).map(r => ({ ...EMPTY_ROW,           ...r })),
    postTax:     (p.postTax  || []).map(r => ({ ...EMPTY_DEDUCTION_ROW, ...r })),
    deposits:    (p.deposits || []).map(r => ({ ...EMPTY_DEPOSIT,       ...r })),
  };
}
function sumRows(rows) {
  return (rows || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

function PaystubSheet({ open, onClose, transaction, initial, accounts, theme, darkMode, onSaved, toast }) {
  const [form, setForm] = useState(() => normalizePaystub(initial));
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // Re-seed when the sheet opens for a different transaction, or when the
  // saved payload changes underneath us.
  useEffect(() => { if (open) setForm(normalizePaystub(initial)); }, [open, transaction?.id, initial]);

  const grossEarnings = sumRows(form.earnings);
  const preTaxTotal   = sumRows(form.preTax);
  const taxesTotal    = sumRows(form.taxes);
  const postTaxTotal  = sumRows(form.postTax);
  const depositsTotal = sumRows(form.deposits);
  const computedNet   = grossEarnings - preTaxTotal - taxesTotal - postTaxTotal;
  const inputCls = `w-full px-2.5 py-1.5 ${theme.inputBg} border ${theme.border} rounded-lg text-xs focus:outline-none focus:border-violet-500`;

  const setSection = (key, updater) =>
    setForm(f => ({ ...f, [key]: typeof updater === "function" ? updater(f[key]) : updater }));

  const addRow = (key) => setSection(key, rows => {
    let template;
    if (key === "deposits") template = EMPTY_DEPOSIT;
    else if (key === "preTax" || key === "postTax") template = EMPTY_DEDUCTION_ROW;
    else template = EMPTY_ROW;
    return [...rows, { ...template }];
  });
  const removeRow = (key, i) => setSection(key, rows => rows.filter((_, idx) => idx !== i));
  const patchRow  = (key, i, patch) => setSection(key,
    rows => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r)
  );

  // Any row with a real amount counts as non-empty. Everything else (blank
  // name / zero amount rows) is treated as untouched scaffolding — that
  // way opening → closing without changing anything doesn't accidentally
  // save an empty-shell blob.
  const hasContent = (form.companyName || form.memo)
    || ["earnings","preTax","taxes","postTax","deposits"].some(k =>
      (form[k] || []).some(r => Number(r.amount) > 0)
    );

  const save = async () => {
    if (!transaction?.id) return;
    setSaving(true);
    try {
      // Strip fully-blank rows on save so we don't persist scaffolding.
      // Deduction rows keep accountId when set (pre/post-tax splits).
      const clean = (rows, kind = "line") => (rows || [])
        .filter(r =>
          Number(r.amount) > 0
          || (r.name && r.name.trim())
          || (kind === "deposit" && (r.accountId || r.memo))
          || (kind === "deduction" && r.accountId)
        )
        .map(r => {
          if (kind === "deposit") return {
            accountId: r.accountId ? Number(r.accountId) : null,
            memo: r.memo || "", amount: Number(r.amount) || 0,
          };
          if (kind === "deduction") return {
            name: r.name || "", category: r.category || "",
            accountId: r.accountId ? Number(r.accountId) : null,
            amount: Number(r.amount) || 0,
          };
          return { name: r.name || "", category: r.category || "", amount: Number(r.amount) || 0 };
        });
      const payload = hasContent ? {
        companyName: form.companyName || "",
        memo: form.memo || "",
        earnings: clean(form.earnings),
        preTax:   clean(form.preTax, "deduction"),
        taxes:    clean(form.taxes),
        postTax:  clean(form.postTax, "deduction"),
        deposits: clean(form.deposits, "deposit"),
      } : null;
      await api.savePaystub(transaction.id, payload);
      toast?.(payload ? "Paystub saved" : "Paystub cleared", "success");
      onSaved?.();
      onClose?.();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setSaving(false); }
  };

  const clearDetail = async () => {
    setConfirmClear(false);
    if (!transaction?.id) return;
    setSaving(true);
    try {
      await api.savePaystub(transaction.id, null);
      toast?.("Paystub cleared", "success");
      onSaved?.();
      onClose?.();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setSaving(false); }
  };

  // Section is defined at MODULE scope below (PaystubSection) — inlining it
  // here would create a new component identity on every render, which
  // unmounts + remounts every input on every keystroke and destroys focus.

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Paystub detail" theme={theme}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Company</label>
              <input value={form.companyName}
                onChange={e => setForm({ ...form, companyName: e.target.value })}
                placeholder="Company name"
                className={inputCls} />
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Memo</label>
              <input value={form.memo}
                onChange={e => setForm({ ...form, memo: e.target.value })}
                placeholder="Reference / memo"
                className={inputCls} />
            </div>
          </div>

          <PaystubSection title="Earnings"             sectionKey="earnings" subtotal={grossEarnings}
            rows={form.earnings} accounts={accounts} theme={theme} inputCls={inputCls}
            onPatchRow={patchRow} onRemoveRow={removeRow} onAddRow={addRow} />
          <PaystubSection title="Pre-Tax Deductions"   sectionKey="preTax"   subtotal={preTaxTotal}   isDeduction
            rows={form.preTax} accounts={accounts} theme={theme} inputCls={inputCls}
            onPatchRow={patchRow} onRemoveRow={removeRow} onAddRow={addRow} />
          <PaystubSection title="Taxes"                sectionKey="taxes"    subtotal={taxesTotal}
            rows={form.taxes} accounts={accounts} theme={theme} inputCls={inputCls}
            onPatchRow={patchRow} onRemoveRow={removeRow} onAddRow={addRow} />
          <PaystubSection title="After-Tax Deductions" sectionKey="postTax"  subtotal={postTaxTotal}  isDeduction
            rows={form.postTax} accounts={accounts} theme={theme} inputCls={inputCls}
            onPatchRow={patchRow} onRemoveRow={removeRow} onAddRow={addRow} />
          <PaystubSection title="Deposit Accounts"     sectionKey="deposits" subtotal={depositsTotal} isDeposit
            rows={form.deposits} accounts={accounts} theme={theme} inputCls={inputCls}
            onPatchRow={patchRow} onRemoveRow={removeRow} onAddRow={addRow} />

          {/* Totals — matches Quicken's Net Pay / W2 Gross summary rows. */}
          <div className={`rounded-xl border ${theme.border} ${theme.surface} p-3 space-y-1`}>
            <div className="flex justify-between text-xs">
              <span className={theme.textSubtle}>Gross earnings</span>
              <span className="font-semibold">{fmt(grossEarnings)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className={theme.textSubtle}>Total deductions</span>
              <span className="font-semibold text-rose-500">
                −{fmt(preTaxTotal + taxesTotal + postTaxTotal)}
              </span>
            </div>
            <div className={`flex justify-between text-sm pt-1 border-t ${theme.border}`}>
              <span className="font-semibold">Net pay (calculated)</span>
              <span className="font-bold text-emerald-500">{fmt(computedNet)}</span>
            </div>
            {Math.abs(computedNet - Number(transaction?.amount || 0)) > 0.02 && (
              <div className="text-[10px] text-amber-500 pt-1">
                Doesn't match this transaction's amount ({fmt(Number(transaction?.amount || 0))}).
                That's fine — some deposits go to other accounts, or an earning is missing.
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            {initial && (
              <button type="button" onClick={() => setConfirmClear(true)}
                disabled={saving}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border} text-rose-500 disabled:opacity-60`}>
                Clear
              </button>
            )}
            <motion.button whileTap={{ scale: 0.97 }} type="button"
              disabled={saving} onClick={save}
              className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {saving ? "Saving…" : "Save"}
            </motion.button>
          </div>
        </div>
      </Sheet>
      <ConfirmDialog
        open={confirmClear}
        onCancel={() => setConfirmClear(false)}
        onConfirm={clearDetail}
        theme={theme} darkMode={darkMode}
        title="Clear paystub detail?"
        message="The transaction row itself will stay — just the itemised breakdown is removed."
        confirmLabel="Clear"
      />
    </>
  );
}

// Renders one section of the paystub editor. Defined at MODULE scope
// (not inline inside PaystubSheet) because inline component definitions
// get a NEW function identity on every parent render — React's
// reconciler sees "different component type" and unmounts + remounts
// the entire subtree on every keystroke, destroying input focus. This
// was the "can only type one character" bug users reported.
//
// Modes:
//   isDeposit    → account is the primary field (no category)
//   isDeduction  → account is OPTIONAL alongside category (splits paycheck
//                  into a specific account, e.g. 401k, HSA, savings sweep)
//   otherwise    → free-text category only
// Notification-preference row in SettingsPanel. Same rationale as
// PaystubSection — extracted from inline to prevent focus-loss on
// keystroke in the threshold inputs some rows expose via children.
function NotifRow({ theme, darkMode, emailOn, label, hint, checked, onToggle, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {hint && <div className={`text-xs ${theme.textSubtle} mt-0.5`}>{hint}</div>}
        </div>
        <Toggle checked={checked} onChange={onToggle} disabled={!emailOn} darkMode={darkMode} />
      </div>
      {checked && emailOn && children && <div className="pl-1">{children}</div>}
    </div>
  );
}

// Toggle switch used in Settings + a few other places. Lives at module
// scope so extracted components (like NotifRow) can reference it too —
// having it nested inside SettingsPanel earlier is what caused the
// "Toggle is not defined" crash when Settings mounted after NotifRow
// was moved to module scope.
function Toggle({ checked, onChange, disabled, darkMode }) {
  return (
    <button type="button" onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
        disabled ? "opacity-50 cursor-not-allowed" : ""
      } ${checked ? "bg-violet-500" : darkMode ? "bg-slate-700" : "bg-slate-300"}`}>
      <motion.div animate={{ x: checked ? 20 : 0 }} transition={{ type: "spring", damping: 25, stiffness: 500 }}
        className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm" />
    </button>
  );
}

function PaystubSection({
  title, sectionKey, subtotal, rows = [], accounts = [],
  theme, inputCls, isDeposit, isDeduction,
  onPatchRow, onRemoveRow, onAddRow,
}) {
  const gridCls = isDeduction
    ? "grid grid-cols-[1fr_1fr_1fr_90px_28px] gap-1.5 items-center"
    : "grid grid-cols-[1fr_1fr_90px_28px] gap-1.5 items-center";
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
          {title}
        </div>
        {subtotal !== undefined && (
          <div className={`text-[11px] font-semibold`}>{fmt(subtotal)}</div>
        )}
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className={gridCls}>
            <input
              value={r.name}
              onChange={e => onPatchRow(sectionKey, i, { name: e.target.value })}
              placeholder={isDeposit ? "Memo" : "Name (optional)"}
              className={inputCls}
            />
            {isDeposit ? (
              <select
                value={r.accountId || ""}
                onChange={e => onPatchRow(sectionKey, i, { accountId: e.target.value })}
                className={inputCls}>
                <option value="">— Account (optional) —</option>
                {accounts.map(a =>
                  <option key={a.id} value={a.id}>{a.name}</option>
                )}
              </select>
            ) : (
              <input
                value={r.category}
                onChange={e => onPatchRow(sectionKey, i, { category: e.target.value })}
                placeholder="Category (optional)"
                className={inputCls}
              />
            )}
            {isDeduction && (
              <select
                value={r.accountId || ""}
                onChange={e => onPatchRow(sectionKey, i, { accountId: e.target.value })}
                title="Optionally route this deduction into a specific account"
                className={inputCls}>
                <option value="">→ Account (optional)</option>
                {accounts.map(a =>
                  <option key={a.id} value={a.id}>{a.name}</option>
                )}
              </select>
            )}
            <input
              type="number" step="0.01" min="0"
              value={r.amount}
              onChange={e => onPatchRow(sectionKey, i, { amount: e.target.value })}
              placeholder="0.00"
              className={`${inputCls} text-right`}
            />
            <button type="button" onClick={() => onRemoveRow(sectionKey, i)}
              title="Remove row"
              className={`p-1 rounded-md ${theme.textSubtle} hover:text-rose-500`}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onAddRow(sectionKey)}
        className="mt-1.5 text-[11px] font-semibold text-violet-500 flex items-center gap-1">
        <Plus className="w-3 h-3" /> Add {isDeposit ? "deposit" : "line"}
      </button>
    </div>
  );
}

// ─── Schedule sheet ───────────────────────────────────────────────────────────
// Create-a-scheduled-transaction form. Handles both fresh schedules ("Schedule
// an upcoming paycheck") and copy-and-schedule (right-click / detail-sheet
// action → prefills from an existing transaction so the user only has to
// pick a future date). Both entry points route through the same submit path.
function ScheduleSheet({ open, onClose, copyFrom, accounts, catList, theme, darkMode, toast, onSaved }) {
  const today = new Date().toISOString().slice(0, 10);
  const initial = () => copyFrom
    ? {
        date: today, // future date is the whole point — never keep the source's date
        merchant: copyFrom.merchant || "",
        amount: String(Math.abs(Number(copyFrom.amount) || 0)),
        category: copyFrom.category || "Other",
        account_id: copyFrom.accountId ? String(copyFrom.accountId) : "",
        note: copyFrom.note || "",
        sign: Number(copyFrom.amount) >= 0 ? "in" : "out",
        budget_expected: !!copyFrom.budgetExpectedIncome,
        recurring_kind: copyFrom.recurringKind || "none",
        recurring_days: copyFrom.recurringDays || "",
      }
    : {
        date: today, merchant: "", amount: "", category: "Other",
        account_id: "", note: "", sign: "in",
        budget_expected: false, recurring_kind: "none", recurring_days: "",
      };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  // Re-seed when the sheet opens (may be for a fresh entry OR a copy).
  useEffect(() => { if (open) setForm(initial()); /* eslint-disable-next-line */ }, [open, copyFrom?.id]);

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  const submit = async (e) => {
    e.preventDefault();
    if (!form.merchant || !form.amount) {
      toast?.("Merchant and amount required", "error");
      return;
    }
    setSaving(true);
    try {
      const raw = Number(form.amount);
      if (!Number.isFinite(raw) || raw <= 0) {
        toast?.("Amount must be positive", "error");
        return;
      }
      const signed = form.sign === "in" ? raw : -raw;
      // Recurring: "custom" needs a positive day count. Everything else
      // ignores recurring_days server-side.
      const kind = form.recurring_kind || "none";
      const rdays = kind === "custom" ? Number(form.recurring_days) || 0 : null;
      if (kind === "custom" && !(rdays > 0)) {
        toast?.("Custom recurrence needs a day count", "error");
        return;
      }
      await api.createScheduledTransaction({
        date: form.date,
        merchant: form.merchant.trim(),
        category: form.category || "Other",
        amount: signed,
        accountId: form.account_id || null,
        note: form.note || null,
        // Income-only flags. Backend still accepts them on expense rows,
        // but they don't do anything for expenses so we only send them for
        // scheduled income.
        budget_expected_income: form.sign === "in" ? !!form.budget_expected : false,
        recurring_kind: kind,
        recurring_days: rdays,
      });
      toast?.("Scheduled", "success");
      onSaved?.();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setSaving(false); }
  };

  return (
    <Sheet open={open} onClose={onClose}
      title={copyFrom ? `Schedule (copy of "${copyFrom.merchant}")` : "Schedule transaction"}
      theme={theme}>
      <form onSubmit={submit} className="space-y-3">
        {/* In / Out toggle — same UX as Add Transaction. Scheduled income
            (in) is what most users will pick; keeping the toggle lets
            them also schedule a known upcoming bill if they want. */}
        <div className={`flex p-1 rounded-xl ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
          {[
            { id: "in", label: "Income" },
            { id: "out", label: "Expense" },
          ].map(o => (
            <button type="button" key={o.id}
              onClick={() => setForm({ ...form, sign: o.id })}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${
                form.sign === o.id
                  ? (darkMode ? "bg-slate-900 shadow text-violet-400" : "bg-white shadow text-violet-600")
                  : theme.textMuted
              }`}>
              {o.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Expected date</label>
            <input type="date" required value={form.date}
              onChange={e => setForm({ ...form, date: e.target.value })}
              className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Amount</label>
            <input type="number" step="0.01" min="0.01" required
              value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00" className={inputCls} />
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Merchant / source</label>
          <input required value={form.merchant}
            onChange={e => setForm({ ...form, merchant: e.target.value })}
            placeholder="Merchant or source name" className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Category</label>
            <select value={form.category}
              onChange={e => setForm({ ...form, category: e.target.value })}
              className={inputCls}>
              {catList.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Account</label>
            <select value={form.account_id}
              onChange={e => setForm({ ...form, account_id: e.target.value })}
              className={inputCls}>
              <option value="">— None —</option>
              {accounts.map(a =>
                <option key={a.id} value={a.id}>
                  {a.name}{a.institution ? ` · ${a.institution}` : ""}
                </option>
              )}
            </select>
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Note (optional)</label>
          <input value={form.note}
            onChange={e => setForm({ ...form, note: e.target.value })}
            className={inputCls} />
        </div>

        {/* Repeat cadence — one row for both income and expense scheduled
            transactions. "None" is a one-off; anything else spawns the
            next occurrence when Plaid adopts this one (or nightly via the
            worker). Custom asks for a day count. */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Repeat</label>
            <select value={form.recurring_kind}
              onChange={e => setForm({ ...form, recurring_kind: e.target.value })}
              className={inputCls}>
              <option value="none">Doesn't repeat</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="semimonthly">1st & 15th</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
              <option value="custom">Every N days</option>
            </select>
          </div>
          {form.recurring_kind === "custom" && (
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Days</label>
              <input type="number" min="1" step="1"
                value={form.recurring_days}
                onChange={e => setForm({ ...form, recurring_days: e.target.value })}
                placeholder="e.g. 10" className={inputCls} />
            </div>
          )}
        </div>

        {/* Budget Expected Income — income-only ticker. When set, this
            scheduled row's amount counts toward the Budgets tab's
            "Expected income" bar and the zero-based-budget slider's
            basis for the current period. */}
        {form.sign === "in" && (
          <label className={`flex items-start gap-2 p-3 rounded-xl border ${theme.border} cursor-pointer ${form.budget_expected ? "bg-violet-500/5 border-violet-500/40" : ""}`}>
            <input type="checkbox" checked={!!form.budget_expected}
              onChange={e => setForm({ ...form, budget_expected: e.target.checked })}
              className="mt-0.5 accent-violet-500" />
            <div className="flex-1">
              <div className="text-sm font-semibold text-violet-500 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> Budget Expected Income
              </div>
              <div className={`text-[11px] ${theme.textSubtle} mt-0.5`}>
                Include this in the Budgets tab's expected-income bar and
                the zero-based slider's basis. Great for salaried paychecks.
              </div>
            </div>
          </label>
        )}

        <p className={`text-[11px] ${theme.textSubtle}`}>
          Scheduled rows don't affect your budget or income totals. When your
          bank reports a matching transaction (same account, within $5, within
          3 days), this scheduled row is adopted in place and the pill
          disappears automatically. You can also mark it as arrived manually
          from its detail view.
        </p>
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
            Cancel
          </button>
          <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={saving}
            className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
            {saving ? "Scheduling…" : "Schedule"}
          </motion.button>
        </div>
      </form>
    </Sheet>
  );
}

// ─── Action taxonomy ─────────────────────────────────────────────────────────
// Groups the 22 actions into six navigable categories. The rule builder's
// + Add action dropdown uses this table for its cascading menu (categories
// on the left, actions on the right when a category is hovered/clicked)
// and the "Recommended order" button uses ACTION_PRIORITY to sort rules
// within their trigger group.
//
// Keep an action referenced in EXACTLY ONE category — a duplicate would
// appear twice in the menu and the sort would use whichever category
// listed it last.
const ACTION_CATEGORIES = [
  {
    id: "hygiene",
    label: "Transaction hygiene",
    description: "Categorize, tag, or split incoming transactions.",
    kinds: ["mark_as_transfer", "flag_duplicate", "set_category", "add_note", "split_txn"],
  },
  {
    id: "alerts",
    label: "Alerts",
    description: "Notify when something crosses a threshold.",
    kinds: [
      "notify_low_balance", "notify_cc_utilization",
      "notify_scheduled_miss", "notify_unusually_large_txn",
      "burn_rate_alarm",
    ],
  },
  {
    id: "budget",
    label: "Budget adjustments",
    description: "Shift or roll over budget caps between periods.",
    kinds: ["rollover_unused_budget", "seasonal_bump", "move_budget_slack"],
  },
  {
    id: "savings",
    label: "Savings & goals",
    description: "Contribute or sweep money into a goal.",
    kinds: ["contribute_to_goal_pct", "sweep_to_goal", "round_up_to_goal", "sweep_excess_income"],
  },
  {
    id: "paystub",
    label: "Paystub & recurring",
    description: "Layer paystub detail or propose scheduled rows.",
    kinds: ["apply_paystub_template", "propose_recurring_schedule"],
  },
  {
    id: "housekeeping",
    label: "Housekeeping",
    description: "Retention cleanup + summary reports.",
    kinds: [
      "archive_completed_goals", "cleanup_old_notifications",
      "monthly_summary_notification",
    ],
  },
];

// Lower priority runs FIRST in the Recommended-order sort. The idea:
//   - Detection / classification runs before mutation
//   - Content enrichment before content creation
//   - Alerts fire after the row's state has settled
//   - Money movement (goals / budgets) is late — depends on final amount
//   - Housekeeping is last (retention / summaries)
// Any kind not listed defaults to 500 (middle of the pack).
const ACTION_PRIORITY = {
  flag_duplicate:               10,
  mark_as_transfer:             20,
  set_category:                 30,
  apply_paystub_template:       40,
  add_note:                     50,
  split_txn:                    60,
  notify_unusually_large_txn:  100,
  notify_low_balance:          110,
  notify_cc_utilization:       120,
  notify_scheduled_miss:       130,
  burn_rate_alarm:             140,
  contribute_to_goal_pct:      200,
  sweep_to_goal:               210,
  round_up_to_goal:            220,
  sweep_excess_income:         230,
  rollover_unused_budget:      300,
  seasonal_bump:               310,
  move_budget_slack:           320,
  propose_recurring_schedule:  400,
  monthly_summary_notification:800,
  archive_completed_goals:     900,
  cleanup_old_notifications:   910,
};

// Trigger sort order for Recommended-order. Rules with the same trigger
// stay together (their internal order matters); triggers are laid out
// most-frequent → least-frequent so hot-path rules run first when the
// user scans the list.
const TRIGGER_PRIORITY = {
  transaction_arrived: 10,
  income_landed:       20,
  balance_changed:     30,
  daily_check:         40,
  period_rolled_over:  50,
};

// ─── Action add menu ─────────────────────────────────────────────────────────
// Cascading menu:
//   [category list] → hover/click → [actions in that category]
// The whole thing is portaled to document.body with fixed positioning so
// the sheet's scroll container doesn't clip it (same trick the native
// <select> in Add Transaction uses). Only categories with at least one
// available action are rendered.
function ActionAddMenu({ available, onPick, theme, darkMode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null); // { top, left } in viewport coords
  const [activeCat, setActiveCat] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  // Only categories with at least one server-recognized action show up.
  // If a stage's actions haven't rolled out to the connected backend
  // yet, that category is silently omitted.
  const availableSet = useMemo(() => new Set(available || []), [available]);
  const visibleCategories = useMemo(() =>
    ACTION_CATEGORIES
      .map(cat => ({ ...cat, kinds: cat.kinds.filter(k => availableSet.has(k)) }))
      .filter(cat => cat.kinds.length > 0),
    [availableSet]
  );

  // Left-anchor so the submenu extends RIGHTWARD (classic cascading
  // pattern). If the whole thing would overflow the viewport we clamp
  // to a small right margin — desktop viewports have ample room past
  // the sheet, so overflow is rare in practice.
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    // Assume main list ~208px + submenu ~272px + gap = ~480px total.
    const APPROX_MENU_WIDTH = 500;
    const left = Math.min(
      rect.left,
      Math.max(8, window.innerWidth - APPROX_MENU_WIDTH - 8)
    );
    setPos({ top: rect.bottom + 4, left });
    setActiveCat(prev => prev || visibleCategories[0]?.id || null);
  }, [open, visibleCategories]);

  // Click-outside: close when clicking anywhere that isn't the button
  // OR the portaled menu. Both refs must be checked because the menu
  // lives at document.body (outside the sheet's DOM subtree).
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      const inBtn  = btnRef.current  && btnRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inBtn && !inMenu) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!available?.length) {
    return (
      <span className={`text-[11px] ${theme.textSubtle}`}>
        No actions available yet
      </span>
    );
  }

  const activeCategory =
    visibleCategories.find(c => c.id === activeCat) || visibleCategories[0];

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)}
        className="text-[11px] font-semibold text-violet-500 flex items-center gap-1">
        <Plus className="w-3 h-3" /> Add action
      </button>
      {open && pos && createPortal(
        <div ref={menuRef}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            zIndex: 90,
          }}
          className="flex items-start">
          {/* Categories column — main list */}
          <div className={`w-52 ${theme.surface} border ${theme.border} rounded-l-xl shadow-xl`}
            style={{ maxHeight: "min(24rem, 55vh)", overflowY: "auto" }}>
            {visibleCategories.map(cat => {
              const isActive = cat.id === activeCategory?.id;
              return (
                <button key={cat.id} type="button"
                  onMouseEnter={() => setActiveCat(cat.id)}
                  onClick={() => setActiveCat(cat.id)}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 transition-colors ${
                    isActive
                      ? (darkMode ? "bg-slate-800 text-violet-400" : "bg-slate-100 text-violet-600")
                      : theme.hover
                  }`}>
                  <div className="min-w-0">
                    <div className="font-semibold">{cat.label}</div>
                    <div className={`text-[10px] ${theme.textSubtle} truncate`}>
                      {cat.kinds.length} action{cat.kinds.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                  <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? "text-violet-500" : "opacity-40"}`} />
                </button>
              );
            })}
          </div>
          {/* Actions column — child submenu for the active category */}
          {activeCategory && (
            <div className={`w-64 ${theme.surface} border-t border-r border-b ${theme.border} rounded-r-xl shadow-xl -ml-px`}
              style={{ maxHeight: "min(24rem, 55vh)", overflowY: "auto" }}>
              {activeCategory.kinds.map(k => {
                const meta = ACTION_META[k] || { label: k };
                return (
                  <button key={k} type="button"
                    onClick={() => { onPick(k); setOpen(false); }}
                    className={`w-full text-left px-3 py-2 ${theme.hover} text-xs`}>
                    <div className="font-semibold">{meta.label}</div>
                    {meta.description && (
                      <div className={`text-[10px] ${theme.textSubtle}`}>{meta.description}</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}

// ─── Action params editor ────────────────────────────────────────────────────
// Per-action UI. Each case renders whatever inputs that action's params
// need. Unknown kinds render a raw JSON textarea as a safety net so a
// future stage's action still works if the deploy is ahead of the client.
function ActionParamsEditor({ kind, params, onPatch, catList = [], accounts = [], budgets = [], goals = [], currentTrigger, theme, darkMode }) {
  const inputCls = `w-full px-2.5 py-1.5 ${theme.inputBg} border ${theme.border} rounded-lg text-xs focus:outline-none focus:border-violet-500`;

  // Trigger-mismatch hint — nudge the user if their rule's trigger
  // doesn't match this action's preferredTrigger. Doesn't block the
  // save; some setups are legitimate (e.g. running low-balance check on
  // balance_changed instead of daily_check).
  const preferred = ACTION_META[kind]?.preferredTrigger;
  const mismatch = preferred && currentTrigger && preferred !== currentTrigger;
  const MismatchHint = mismatch ? (
    <div className={`text-[10px] mt-1.5 flex items-start gap-1 ${darkMode ? "text-amber-400" : "text-amber-600"}`}>
      <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
      <span>
        This action is designed for <b>{preferred.replace(/_/g, " ")}</b> triggers.
        It may not fire meaningfully on the current one.
      </span>
    </div>
  ) : null;

  if (kind === "mark_as_transfer") {
    return <p className={`text-[11px] ${theme.textSubtle}`}>No settings needed.</p>;
  }

  if (kind === "add_note") {
    return (
      <div className="space-y-1.5">
        <input value={params.note || ""}
          onChange={e => onPatch({ note: e.target.value })}
          placeholder="Note text to attach to matching transactions"
          className={inputCls} />
        <div className={`flex items-center gap-2 text-[11px] ${theme.textSubtle}`}>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" name={`note-mode-${kind}`}
              checked={params.mode !== "append"}
              onChange={() => onPatch({ mode: "overwrite" })} />
            Overwrite
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" name={`note-mode-${kind}`}
              checked={params.mode === "append"}
              onChange={() => onPatch({ mode: "append" })} />
            Append
          </label>
        </div>
      </div>
    );
  }

  if (kind === "set_category") {
    return (
      <select value={params.category || ""}
        onChange={e => onPatch({ category: e.target.value })}
        className={inputCls}>
        <option value="">— Pick a category —</option>
        {catList.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  }

  if (kind === "flag_duplicate") {
    return (
      <div className="flex items-center gap-2">
        <span className={`text-[11px] ${theme.textSubtle}`}>Match within</span>
        <input type="number" min="0" max="7"
          value={params.withinDays ?? 0}
          onChange={e => onPatch({ withinDays: Math.max(0, Math.min(7, Number(e.target.value) || 0)) })}
          className={`w-14 ${inputCls}`} />
        <span className={`text-[11px] ${theme.textSubtle}`}>day(s) of this transaction</span>
      </div>
    );
  }

  if (kind === "split_txn") {
    const splits = Array.isArray(params.splits) ? params.splits : [];
    const patchSplit = (i, patch) =>
      onPatch({ splits: splits.map((s, idx) => idx === i ? { ...s, ...patch } : s) });
    const addSplit = () =>
      onPatch({ splits: [...splits, { category: "", amount: "", note: "" }] });
    const removeSplit = (i) =>
      onPatch({ splits: splits.filter((_, idx) => idx !== i) });
    return (
      <div className="space-y-1.5">
        {splits.map((s, i) => (
          <div key={i} className="grid grid-cols-[1fr_80px_1fr_28px] gap-1.5 items-center">
            <select value={s.category || ""}
              onChange={e => patchSplit(i, { category: e.target.value })}
              className={inputCls}>
              <option value="">— Category —</option>
              {catList.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="number" step="0.01" min="0"
              value={s.amount}
              onChange={e => patchSplit(i, { amount: e.target.value })}
              placeholder="0.00"
              className={`${inputCls} text-right`} />
            <input value={s.note || ""}
              onChange={e => patchSplit(i, { note: e.target.value })}
              placeholder="Split note (optional)"
              className={inputCls} />
            <button type="button" onClick={() => removeSplit(i)}
              className={`p-1 rounded-md ${theme.textSubtle} hover:text-rose-500`}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <button type="button" onClick={addSplit}
          className="text-[11px] font-semibold text-violet-500 flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add split
        </button>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Sum of splits must be ≤ the transaction's amount. Rules are idempotent —
          re-firing on a re-synced row won't double-split.
        </p>
      </div>
    );
  }

  if (kind === "notify_low_balance") {
    const cashAccounts = accounts.filter(a => a.type !== "credit");
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Account</label>
            <select value={params.accountId || ""}
              onChange={e => onPatch({ accountId: e.target.value })}
              className={inputCls}>
              <option value="">All non-credit accounts</option>
              {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Threshold ($)</label>
            <input type="number" step="0.01" min="0"
              value={params.threshold ?? ""}
              onChange={e => onPatch({ threshold: e.target.value })}
              placeholder="100.00" className={`${inputCls} text-right`} />
          </div>
        </div>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "notify_cc_utilization") {
    const cards = accounts.filter(a => a.type === "credit");
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Card</label>
            <select value={params.accountId || ""}
              onChange={e => onPatch({ accountId: e.target.value })}
              className={inputCls}>
              <option value="">All credit cards</option>
              {cards.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Threshold (%)</label>
            <input type="number" step="1" min="1" max="100"
              value={params.thresholdPct ?? 30}
              onChange={e => onPatch({ thresholdPct: Math.max(1, Math.min(100, Number(e.target.value) || 30)) })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        {cards.length === 0 && (
          <p className={`text-[10px] ${theme.textSubtle}`}>
            No credit accounts connected yet — this rule will do nothing.
          </p>
        )}
        {MismatchHint}
      </div>
    );
  }

  if (kind === "notify_scheduled_miss") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] ${theme.textSubtle}`}>Grace period</span>
          <input type="number" min="0" max="30"
            value={params.graceDays ?? 2}
            onChange={e => onPatch({ graceDays: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
            className={`w-14 ${inputCls}`} />
          <span className={`text-[11px] ${theme.textSubtle}`}>days after expected date</span>
        </div>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "notify_unusually_large_txn") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Multiplier vs median</label>
            <input type="number" step="0.1" min="1.5" max="20"
              value={params.multiplier ?? 3}
              onChange={e => onPatch({ multiplier: Math.max(1.5, Math.min(20, Number(e.target.value) || 3)) })}
              className={`${inputCls} text-right`} />
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Lookback (days)</label>
            <input type="number" step="1" min="7" max="365"
              value={params.lookbackDays ?? 90}
              onChange={e => onPatch({ lookbackDays: Math.max(7, Math.min(365, Number(e.target.value) || 90)) })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Needs at least 3 prior transactions at the same merchant to run — the median is meaningless below that.
        </p>
        {MismatchHint}
      </div>
    );
  }

  // Shared: a budget picker. Excludes card-usage budgets (accountId
  // set) since those aren't category budgets and rollover doesn't
  // apply the same way. "All budgets" is offered only where the
  // action supports scope=all (rollover_unused_budget, burn_rate_alarm).
  const budgetOptions = budgets.filter(b => !b.accountId);
  const budgetLabel = (b) => b.category;

  if (kind === "rollover_unused_budget") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Budget</label>
            <select value={params.budgetId || ""}
              onChange={e => onPatch({ budgetId: e.target.value })}
              className={inputCls}>
              <option value="">All category budgets</option>
              {budgetOptions.map(b =>
                <option key={b.id} value={b.id}>{budgetLabel(b)}</option>
              )}
            </select>
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Max rollover ($, optional)</label>
            <input type="number" step="0.01" min="0"
              value={params.maxRollover ?? ""}
              onChange={e => onPatch({ maxRollover: e.target.value })}
              placeholder="No cap" className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Fires at the end of every master period. Unused amount carries
          into the next period (up to Max, if set). Sets rollover credit
          each time — leftover shrinks naturally when the credit is spent.
        </p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "seasonal_bump") {
    const MONTHS = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December",
    ];
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-3 gap-1.5">
          <div className="col-span-2">
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Budget</label>
            <select value={params.budgetId || ""}
              onChange={e => onPatch({ budgetId: e.target.value })}
              className={inputCls}>
              <option value="">— Pick a budget —</option>
              {budgetOptions.map(b =>
                <option key={b.id} value={b.id}>{budgetLabel(b)}</option>
              )}
            </select>
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Month</label>
            <select value={params.monthNumber ?? 12}
              onChange={e => onPatch({ monthNumber: Number(e.target.value) })}
              className={inputCls}>
              {MONTHS.map((m, i) =>
                <option key={i} value={i + 1}>{m}</option>
              )}
            </select>
          </div>
        </div>
        <div>
          <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Bump amount ($)</label>
          <input type="number" step="0.01" min="0"
            value={params.bumpAmount ?? ""}
            onChange={e => onPatch({ bumpAmount: e.target.value })}
            placeholder="0.00"
            className={`${inputCls} text-right`} />
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Fires at every period boundary but only applies when the new
          period starts in the selected month. Adds to whatever rollover
          credit is already there.
        </p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "burn_rate_alarm") {
    return (
      <div className="space-y-1.5">
        <div>
          <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Budget</label>
          <select value={params.budgetId || ""}
            onChange={e => onPatch({ budgetId: e.target.value })}
            className={inputCls}>
            <option value="">All category budgets</option>
            {budgetOptions.map(b =>
              <option key={b.id} value={b.id}>{budgetLabel(b)}</option>
            )}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Warn at spent %</label>
            <input type="number" step="1" min="1" max="100"
              value={params.warnPct ?? 80}
              onChange={e => onPatch({ warnPct: Math.max(1, Math.min(100, Number(e.target.value) || 80)) })}
              className={`${inputCls} text-right`} />
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Only after elapsed %</label>
            <input type="number" step="1" min="1" max="100"
              value={params.timeElapsedThresholdPct ?? 50}
              onChange={e => onPatch({ timeElapsedThresholdPct: Math.max(1, Math.min(100, Number(e.target.value) || 50)) })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Only fires when BOTH thresholds are crossed — e.g. 80% spent
          with only 50% of the period elapsed. Prevents nagging on a
          budget that legitimately runs out at the end.
        </p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "move_budget_slack") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>From (source)</label>
            <select value={params.sourceBudgetId || ""}
              onChange={e => onPatch({ sourceBudgetId: e.target.value })}
              className={inputCls}>
              <option value="">— Source budget —</option>
              {budgetOptions.map(b =>
                <option key={b.id} value={b.id}>{budgetLabel(b)}</option>
              )}
            </select>
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>To (target)</label>
            <select value={params.targetBudgetId || ""}
              onChange={e => onPatch({ targetBudgetId: e.target.value })}
              className={inputCls}>
              <option value="">— Target budget —</option>
              {budgetOptions.map(b =>
                <option key={b.id} value={b.id}>{budgetLabel(b)}</option>
              )}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Amount to move ($)</label>
            <input type="number" step="0.01" min="0"
              value={params.amount ?? 50}
              onChange={e => onPatch({ amount: e.target.value })}
              className={`${inputCls} text-right`} />
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Source under %</label>
            <input type="number" step="1" min="1" max="100"
              value={params.sourceMaxUsedPct ?? 40}
              onChange={e => onPatch({ sourceMaxUsedPct: Math.max(1, Math.min(100, Number(e.target.value) || 40)) })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input type="checkbox"
            checked={params.requireTargetOver !== false}
            onChange={e => onPatch({ requireTargetOver: e.target.checked })} />
          <span className={theme.textSubtle}>Only move when target is already over cap</span>
        </label>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Runs at most once per period per rule. Clamps to whatever slack the
          source actually has — never puts source below zero.
        </p>
        {MismatchHint}
      </div>
    );
  }

  // Shared goal picker — filters out account-linked goals because the
  // backend actions can't safely write to them (their `saved` is
  // derived from account balance). The dropdown surfaces this so the
  // user isn't puzzled by their linked goals being missing.
  const manualGoals = goals.filter(g => !g.accountId);
  const goalPicker = (
    <>
      <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Goal</label>
      <select value={params.goalId || ""}
        onChange={e => onPatch({ goalId: e.target.value })}
        className={inputCls}>
        <option value="">— Pick a goal —</option>
        {manualGoals.map(g =>
          <option key={g.id} value={g.id}>{g.name}</option>
        )}
      </select>
      {manualGoals.length === 0 && (
        <p className={`text-[10px] ${theme.textSubtle} mt-1`}>
          No unlinked goals available. Create a goal without linking it to an
          account (link-linked goals derive from balance and can't accept
          automation contributions).
        </p>
      )}
    </>
  );

  if (kind === "contribute_to_goal_pct") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_100px] gap-1.5">
          <div>{goalPicker}</div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>% of income</label>
            <input type="number" step="0.1" min="0.1" max="100"
              value={params.pct ?? 10}
              onChange={e => onPatch({ pct: Math.max(0.1, Math.min(100, Number(e.target.value) || 10)) })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Fires on every income transaction. Multiple % rules stack — order
          them if you want a specific priority.
        </p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "sweep_to_goal") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_100px] gap-1.5">
          <div>{goalPicker}</div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Sweep $</label>
            <input type="number" step="0.01" min="0.01"
              value={params.amount ?? 100}
              onChange={e => onPatch({ amount: e.target.value })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Skipped if the incoming income is smaller than the sweep amount
          (prevents dipping a small paycheck negative).
        </p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "round_up_to_goal") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_100px] gap-1.5">
          <div>{goalPicker}</div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Round to $</label>
            <input type="number" step="0.25" min="0.25" max="100"
              value={params.roundTo ?? 1}
              onChange={e => onPatch({ roundTo: Math.max(0.25, Math.min(100, Number(e.target.value) || 1)) })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Every expense on a non-credit account rounds up to the nearest ${" "}
          {params.roundTo || 1}; the change goes to the goal. Transfers and
          credit-card swipes are skipped.
        </p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "sweep_excess_income") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_120px] gap-1.5">
          <div>{goalPicker}</div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Cap $ (optional)</label>
            <input type="number" step="0.01" min="0"
              value={params.maxSweep ?? ""}
              onChange={e => onPatch({ maxSweep: e.target.value })}
              placeholder="No cap"
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Fires at each period boundary. Excess = income received last period
          − sum of category budget caps (including any rollover credit).
          Only positive excess is swept.
        </p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "archive_completed_goals" || kind === "cleanup_old_notifications") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] ${theme.textSubtle}`}>Older than</span>
          <input type="number" min="1" max="365"
            value={params.afterDays ?? 30}
            onChange={e => onPatch({ afterDays: Math.max(1, Math.min(365, Number(e.target.value) || 30)) })}
            className={`w-16 ${inputCls} text-right`} />
          <span className={`text-[11px] ${theme.textSubtle}`}>days</span>
        </div>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "monthly_summary_notification" || kind === "apply_paystub_template") {
    return (
      <div className="space-y-1.5">
        <p className={`text-[11px] ${theme.textSubtle}`}>No settings needed.</p>
        {MismatchHint}
      </div>
    );
  }

  if (kind === "propose_recurring_schedule") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Occurrences to see first</label>
            <input type="number" min="2" max="10"
              value={params.N ?? 3}
              onChange={e => onPatch({ N: Math.max(2, Math.min(10, Number(e.target.value) || 3)) })}
              className={`${inputCls} text-right`} />
          </div>
          <div>
            <label className={`text-[10px] ${theme.textSubtle} block mb-1`}>Amount tolerance $</label>
            <input type="number" min="0" max="100" step="0.01"
              value={params.tolerance ?? 5}
              onChange={e => onPatch({ tolerance: Math.max(0, Math.min(100, Number(e.target.value) || 5)) })}
              className={`${inputCls} text-right`} />
          </div>
        </div>
        <p className={`text-[10px] ${theme.textSubtle}`}>
          Only proposes once per (merchant, account) pair. If you already have
          a scheduled row for that pair, or you dismissed a previous
          suggestion, this rule stays silent.
        </p>
        {MismatchHint}
      </div>
    );
  }

  // Unknown kind — raw JSON escape hatch.
  return (
    <textarea
      value={JSON.stringify(params, null, 2)}
      onChange={e => {
        try { onPatch(JSON.parse(e.target.value) || {}); }
        catch { /* invalid JSON while typing — ignore */ }
      }}
      rows={4}
      className={inputCls}
    />
  );
}

// ─── Budgets Tab ──────────────────────────────────────────────────────────────
const WEEK_DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// Period option list for the income/credit tracker sheets. weekStart is the
// user-configured first day of the week (0=Sun … 6=Sat); the weekly option's
// subtitle reflects it so "Weekly · Resets every Tuesday" stays accurate when
// the user picks a non-Sunday start day in Settings.
function getBudgetPeriods(weekStart = 0) {
  const dayName = WEEK_DAY_NAMES[((Number(weekStart) || 0) % 7 + 7) % 7];
  return [
    { id: "weekly",      label: "Weekly",       desc: `Resets every ${dayName}` },
    { id: "biweekly",    label: "Bi-weekly",    desc: "Resets every 2 weeks" },
    { id: "semimonthly", label: "Twice a month",desc: "Resets on the 1st & 15th" },
    { id: "monthly",     label: "Monthly",      desc: "Resets on the 1st" },
    { id: "yearly",      label: "Yearly",       desc: "Resets January 1" },
    { id: "custom",      label: "Custom…",      desc: "Choose your own interval" },
  ];
}
// Back-compat alias for the few places that just need labels (no day-name
// in subtitles). Kept as a constant so existing fmtPeriodLabel etc. don't
// need to thread weekStart through.
const BUDGET_PERIODS = getBudgetPeriods(0);

function fmtPeriodLabel(period, days) {
  if (period === "custom" && days) return `Every ${days}d`;
  return BUDGET_PERIODS.find(p => p.id === period)?.label || "Monthly";
}

// Cadence phrase for "Resets ___" sentences (lowercase, grammatical).
// The previous `.replace("ly", " ly")` trick produced "week ly" / "month ly".
const PERIOD_CADENCE = {
  weekly: "weekly",
  biweekly: "every 2 weeks",
  semimonthly: "on the 1st & 15th",
  monthly: "monthly",
  yearly: "yearly",
};
function fmtCadence(period, days) {
  if (period === "custom" && days) {
    return `every ${days} day${Number(days) === 1 ? "" : "s"}`;
  }
  return PERIOD_CADENCE[period] || "monthly";
}

// ── Income tracker card (pinned at top, always shown) ───────────────────────
// `readOnly` (true when the user is viewing a past period) disables the
// tap-to-configure action and hides the "tap to change" hint, so period
// settings can't be edited while reviewing history.
function IncomeTracker({ tracker, theme, darkMode, onConfigure, readOnly = false }) {
  const total = Number(tracker?.total || 0);
  const period = tracker?.period || "monthly";
  return (
    <motion.button
      whileTap={readOnly ? undefined : { scale: 0.99 }}
      onClick={readOnly ? undefined : onConfigure}
      disabled={readOnly}
      className={`w-full text-left relative rounded-2xl bg-gradient-to-br from-violet-500 to-violet-700 p-5 text-white shadow-sm shadow-violet-500/30 overflow-hidden ${readOnly ? "cursor-default" : ""}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-90 flex items-center gap-1.5">
            <ArrowUpRight className="w-3.5 h-3.5 rotate-180" /> Income
          </div>
          <div className="text-3xl font-bold mt-1 tracking-tight private-amount" tabIndex={0}>
            <AnimatedNumber value={total} format={fmt} duration={0.6} />
          </div>
          <div className="text-xs opacity-85 mt-1">
            {fmtPeriodLabel(period, tracker?.periodDays)}{!readOnly && " · tap to change"}
          </div>
        </div>
        <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
          <DollarSign className="w-5 h-5" />
        </div>
      </div>
    </motion.button>
  );
}

// ── Credit usage tracker (only when credit accounts exist) ─────────────────
// `readOnly` (true when the user is viewing a past period) disables the
// tap-to-configure action and hides the "tap to change" hint.
function CreditTracker({ tracker, theme, darkMode, onConfigure, readOnly = false }) {
  const total = Number(tracker?.total || 0);
  const period = tracker?.period || "monthly";
  return (
    <motion.button
      whileTap={readOnly ? undefined : { scale: 0.99 }}
      onClick={readOnly ? undefined : onConfigure}
      disabled={readOnly}
      className={`w-full text-left ${theme.surface} border ${theme.border} rounded-2xl p-5 ${readOnly ? "cursor-default" : ""}`}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${theme.textSubtle} flex items-center gap-1.5`}>
            <CreditCard className="w-3.5 h-3.5" /> Credit Card Usage
          </div>
          <div className="text-2xl font-bold mt-1 tracking-tight text-rose-500 private-amount" tabIndex={0}>
            <AnimatedNumber value={total} format={fmt} duration={0.6} />
          </div>
          <div className={`text-xs ${theme.textSubtle} mt-1`}>
            {fmtPeriodLabel(period, tracker?.periodDays)}{!readOnly && " · tap to change"}
          </div>
          {tracker?.cards?.length > 1 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {tracker.cards.map(c => (
                <div key={c.accountId}
                  className={`text-[10px] font-semibold px-2 py-1 rounded-full ${darkMode ? "bg-rose-500/10 text-rose-400" : "bg-rose-50 text-rose-600"}`}>
                  <span className="private-name" tabIndex={0}>{c.accountName}</span>: <span className="private-amount" tabIndex={0}>{fmtShort(c.used)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${darkMode ? "bg-rose-500/15 text-rose-400" : "bg-rose-50 text-rose-500"}`}>
          <CreditCard className="w-5 h-5" />
        </div>
      </div>
    </motion.button>
  );
}

// ── Zero-budget summary at bottom (Feature 6) ──────────────────────────────
// Three stacked bars:
//   1. Current income (green) — money that has actually landed this period
//   2. Expected income (violet) — sum of scheduled income marked
//      `budget_expected_income` (hidden if 0)
//   3. Usage — allocated ÷ basis, where basis = expected when > 0, else
//      current. Always visible.
// The "remaining to budget" pill and the zero-balanced indicator both key
// on `basis`, so the same fallback applies to the slider math.
function ZeroBudgetSummary({ zb, theme, darkMode }) {
  if (!zb) return null;
  const income = Number(zb.income || 0);
  const expected = Number(zb.expected || 0);
  const allocated = Number(zb.allocated || 0);
  // Actual dollars spent across all category budgets this period.
  // Distinct from `allocated` — allocated is the sum of budget CAPS,
  // spent is what's actually left the accounts. Drives the "Budget
  // usage" bar so 100% means "you've hit your income", not "you've
  // planned to hit it".
  const spent = Number(zb.spent || 0);
  // Basis: expected wins when the user has scheduled any income, else
  // current income takes over so the slider still means something on a
  // brand-new setup.
  const basis = expected > 0 ? expected : income;
  const remaining = basis - allocated;
  const balanced = Math.abs(remaining) < 1;
  const usagePct = basis > 0 ? Math.min(200, (spent / basis) * 100) : 0;
  const usageOver = usagePct > 100;

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl p-4 mt-2 space-y-3`}>
      <div className="flex items-center justify-between">
        <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
          Zero-based budget
        </div>
        {balanced ? (
          <div className="text-[11px] font-semibold text-emerald-500 flex items-center gap-1">
            <Check className="w-3 h-3" /> Fully allocated
          </div>
        ) : remaining > 0 ? (
          <div className="text-[11px] font-semibold text-amber-500 private-amount" tabIndex={0}>
            {fmt(remaining)} left to budget
          </div>
        ) : (
          <div className="text-[11px] font-semibold text-rose-500 private-amount" tabIndex={0}>
            {fmt(Math.abs(remaining))} over-allocated
          </div>
        )}
      </div>

      {/* Allocation bar — how much of your current income is planned
          for. The bar fills up as you allocate. Emerald when the
          allocation lands at ≤ income (the ZBB ideal — "fully
          allocated" reads GREEN, not red). Rose only when you've
          allocated MORE than you actually earn. */}
      {(() => {
        const overIncome = income > 0 && allocated > income;
        const incomeFillPct = income > 0
          ? Math.min(100, (allocated / income) * 100)
          : 0;
        return (
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <div className="flex items-center gap-1 font-semibold text-emerald-500">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> Current income
              </div>
              <div className="private-amount" tabIndex={0}>
                {fmt(allocated)} <span className={theme.textSubtle}>/ {fmt(income)}</span>
              </div>
            </div>
            <div className={`relative h-2 rounded-full overflow-hidden ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
              <motion.div initial={{ width: 0 }} animate={{ width: `${incomeFillPct}%` }}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                className={`absolute inset-y-0 left-0 ${overIncome ? "bg-rose-500" : "bg-emerald-500"}`} />
            </div>
          </div>
        );
      })()}

      {/* Expected income bar — only when the user scheduled anything.
          Same fill semantics: violet when allocated <= expected (fine),
          rose when the allocation overshoots expected. */}
      {expected > 0 && (() => {
        const overExpected = allocated > expected;
        const expectedFillPct = expected > 0
          ? Math.min(100, (allocated / expected) * 100)
          : 0;
        return (
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <div className="flex items-center gap-1 font-semibold text-violet-500">
                <span className="w-2 h-2 rounded-full bg-violet-500" /> Expected income
              </div>
              <div className="private-amount" tabIndex={0}>
                {fmt(allocated)} <span className={theme.textSubtle}>/ {fmt(expected)}</span>
              </div>
            </div>
            <div className={`relative h-2 rounded-full overflow-hidden ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
              <motion.div initial={{ width: 0 }} animate={{ width: `${expectedFillPct}%` }}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                className={`absolute inset-y-0 left-0 ${overExpected ? "bg-rose-500" : "bg-violet-500"}`} />
            </div>
          </div>
        );
      })()}

      {/* Usage — always shown; capped to 200% width so wildly over-budget
          setups still render without stretching layout. */}
      <div>
        <div className="flex items-center justify-between text-[11px] mb-1">
          <div className={`font-semibold ${usageOver ? "text-rose-500" : theme.textSubtle}`}>
            Budget usage
          </div>
          <div className={`font-semibold ${usageOver ? "text-rose-500" : theme.textSubtle} private-amount`} tabIndex={0}>
            {Math.round(usagePct)}% of {expected > 0 ? "expected" : "current"} income
          </div>
        </div>
        <div className={`relative h-1.5 rounded-full overflow-hidden ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
          <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, usagePct)}%` }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className={`absolute inset-y-0 left-0 ${usageOver ? "bg-rose-500" : "bg-violet-500"}`} />
        </div>
      </div>
    </div>
  );
}

// ── Suggested category chips (Feature 2) ───────────────────────────────────
function SuggestionChips({ suggestions, onPick, theme, darkMode }) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div>
      <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider flex items-center gap-1.5 mb-2`}>
        <Sparkles className="w-3 h-3 text-amber-500" /> Suggested
      </div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map(s => {
          const Icon = CAT_ICONS[s.category] || Briefcase;
          const color = CAT_COLORS[s.category] || "#64748b";
          return (
            <button type="button" key={s.category} onClick={() => onPick(s.category)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold border ${theme.border} ${theme.hover}`}>
              <Icon className="w-3.5 h-3.5" style={{ color }} />
              {s.category}
              <span className={`${theme.textSubtle} font-medium`}>· {fmtShort(s.total)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Budget history dropdown ────────────────────────────────────────────────
// Sits to the left of "+ New Budget". Shows past period reset dates. Picking
// a past period switches the Budgets tab into a read-only "what was this
// period's outcome" view.
function BudgetHistoryDropdown({ theme, darkMode, history, open, onOpen, onClose,
                                historyIndex, onPick }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, onClose]);

  const fmtRange = (s, e) => {
    const d1 = new Date(s), d2 = new Date(e);
    const sameYear = d1.getFullYear() === d2.getFullYear();
    const opt = (full) => ({ month: "short", day: "numeric", year: full ? "numeric" : undefined });
    return `${d1.toLocaleDateString(undefined, opt(false))} – ${d2.toLocaleDateString(undefined, opt(!sameYear))}`;
  };

  const activeLabel = historyIndex === null || !history
    ? "Current period"
    : history[historyIndex]?.isCurrent
      ? "Current period"
      : `Past · ${fmtRange(history[historyIndex].periodStart, history[historyIndex].periodEnd)}`;

  return (
    <div ref={ref} className="relative">
      <motion.button whileTap={{ scale: 0.96 }}
        onClick={() => (open ? onClose() : onOpen())}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border ${theme.border} ${theme.surface} text-xs font-medium`}>
        <Calendar className="w-3.5 h-3.5" />
        <span className="hidden sm:inline truncate max-w-[180px]">{activeLabel}</span>
        <span className="sm:hidden">History</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className={`absolute left-0 mt-2 w-72 z-30 ${theme.surface} border ${theme.border} rounded-xl shadow-xl overflow-hidden`}>
            <div className={`px-3 py-2 border-b ${theme.border} text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
              Budget periods
            </div>
            {!history ? (
              <div className={`px-3 py-4 text-xs ${theme.textSubtle} text-center`}>Loading…</div>
            ) : (() => {
              // Hide PAST periods that had zero budgets — navigating to one
              // currently triggers a framer-motion projection-corruption bug
              // (empty displayBudgets unmounts Reorder.Group, blanking
              // motion components on every other tab). Users with periods
              // that pre-date their first budget create can have many
              // empty past entries; without this filter the dropdown is
              // mostly landmines. The current period is always shown
              // regardless, since that's the active view, not a navigation
              // target.
              const visible = history
                .map((p, idx) => ({ p, idx }))
                .filter(({ p }) => p.isCurrent || p.budgets.length > 0);
              if (visible.length === 0) {
                return (
                  <div className={`px-3 py-4 text-xs ${theme.textSubtle} text-center`}>No periods yet</div>
                );
              }
              return (
                <div className="max-h-80 overflow-y-auto py-1">
                  {/* Current first (last in array since chronological).
                      Iterate over the filtered set but keep each entry's
                      ORIGINAL index so onPick still maps to the right
                      slot in BudgetsTab's history[] state. */}
                  {visible.slice().reverse().map(({ p, idx }) => {
                    const isPicked = historyIndex === idx
                      || (historyIndex === null && p.isCurrent);
                    return (
                      <button key={p.periodStart} onClick={() => onPick(p.isCurrent ? null : idx)}
                        className={`w-full text-left px-3 py-2 ${theme.hover} flex items-center justify-between gap-2 ${isPicked ? "bg-violet-500/10" : ""}`}>
                        <div className="min-w-0">
                          <div className={`text-sm font-medium ${isPicked ? "text-violet-500" : ""}`}>
                            {p.isCurrent ? "Current" : fmtRange(p.periodStart, p.periodEnd)}
                          </div>
                          <div className={`text-[10px] ${theme.textSubtle}`}>
                            Income <span className="private-amount" tabIndex={0}>{fmt(p.income)}</span> · {p.budgets.length} budget{p.budgets.length !== 1 ? "s" : ""}
                          </div>
                        </div>
                        {isPicked && <Check className="w-4 h-4 text-violet-500 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Single budget card (used inside Reorder.Item) ──────────────────────────
function BudgetCard({ b, theme, darkMode, onEdit, onDelete, reorderLocked,
                     expanded, transactions, onToggleExpand, readOnly = false }) {
  // Effective cap folds in any rollover_credit set by an automation rule
  // (rollover_unused_budget, seasonal_bump, move_budget_slack). Falls
  // back to `amount` for older server responses that don't send it, and
  // for historical snapshots (history view doesn't track rollover).
  const rolloverCredit = Number(b.rolloverCredit) || 0;
  const effectiveCap = Number(b.effectiveAmount)
    || Number(b.amount) + rolloverCredit
    || Number(b.amount);
  const pct = Math.min(100, (Number(b.spent) / effectiveCap) * 100);
  const over = pct >= 100;
  const isCardBudget = !!b.accountId;
  const displayName = isCardBudget ? (b.accountName || "Credit Card") : b.category;
  const Icon = isCardBudget ? CreditCard : (CAT_ICONS[b.category] || Briefcase);
  const color = isCardBudget ? "#f43f5e" : (CAT_COLORS[b.category] || "#64748b");

  const stopDrag = { onPointerDown: e => e.stopPropagation() };
  const loading = transactions === "loading";
  const txns = Array.isArray(transactions) ? transactions : [];

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl overflow-hidden`}>
      <div className="p-5">
        <div className="flex items-start justify-between mb-3 gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}20` }}>
              <Icon className="w-4 h-4" style={{ color }} />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{displayName}</div>
              <div className={`text-[11px] ${theme.textSubtle} mt-0.5`}>
                {fmtPeriodLabel(b.period, b.period_days)}
                {isCardBudget && <span className="text-rose-500"> · Card usage</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {!readOnly && (
              <>
                <button {...stopDrag} onClick={onEdit}
                  className={`p-1.5 rounded-lg ${theme.hover} ${theme.textSubtle}`}
                  title="Edit budget">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button {...stopDrag} onClick={onDelete}
                  className={`p-1.5 rounded-lg ${theme.hover} text-rose-500`}
                  title="Delete budget">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            {!reorderLocked && !readOnly && (
              <div className={`p-1 ${theme.textSubtle}`} title="Drag to reorder">
                <GripVertical className="w-4 h-4" />
              </div>
            )}
          </div>
        </div>
        <div className={`flex justify-between text-sm mb-2 ${theme.textMuted}`}>
          <span>{fmt(b.spent)}</span>
          <span className="font-medium">
            {fmt(effectiveCap)}
            {Math.abs(rolloverCredit) >= 0.01 && (
              <span className={`ml-1 text-[10px] font-semibold uppercase tracking-wider ${
                rolloverCredit > 0
                  ? (darkMode ? "text-indigo-400" : "text-indigo-600")
                  : (darkMode ? "text-rose-400" : "text-rose-600")
              }`} title={rolloverCredit > 0
                ? `+${fmt(rolloverCredit)} added by an automation rule this period`
                : `${fmt(rolloverCredit)} shifted out by an automation rule`}>
                {rolloverCredit > 0 ? "+" : ""}{fmt(rolloverCredit)}
              </span>
            )}
          </span>
        </div>
        <ProgressBar value={pct} color={over ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"} darkMode={darkMode} />
        <div className="flex items-center justify-between mt-1.5">
          {over
            ? <div className="text-xs text-rose-500 font-medium">Over by {fmt(Number(b.spent) - effectiveCap)}</div>
            : <div className={`text-xs ${theme.textSubtle}`}>{fmt(effectiveCap - Number(b.spent))} left</div>
          }
          {/* Show-transactions toggle */}
          <button {...stopDrag} onClick={onToggleExpand}
            className={`flex items-center gap-1 text-[11px] font-medium ${theme.textSubtle} hover:text-violet-500`}>
            {expanded ? "Hide" : "Show"} transactions
            <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
        </div>
      </div>

      {/* Expanded transactions list (Feature 1) */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={`border-t ${theme.border} overflow-hidden`}>
            {loading ? (
              <div className={`px-5 py-4 text-xs ${theme.textSubtle} text-center`}>Loading…</div>
            ) : txns.length === 0 ? (
              <div className={`px-5 py-4 text-xs ${theme.textSubtle} text-center`}>
                No transactions in this period yet.
              </div>
            ) : (
              <div className={`divide-y ${theme.divide} max-h-72 overflow-y-auto`}>
                {txns.map(t => {
                  const TIcon = CAT_ICONS[t.category] || Briefcase;
                  const tColor = CAT_COLORS[t.category] || "#64748b";
                  return (
                    <div key={t.id} className="flex items-center gap-3 px-5 py-2.5">
                      <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                        <TIcon className="w-3.5 h-3.5" style={{ color: tColor }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="font-medium text-xs truncate">{t.merchant}</div>
                          <PendingPill pending={t.pending} darkMode={darkMode} size="xs" />
                        </div>
                        <div className={`text-[10px] ${theme.textSubtle}`}>{t.date} · <span className="private-name" tabIndex={0}>{t.accountName || "—"}</span></div>
                      </div>
                      <div className="font-semibold text-xs flex-shrink-0 private-amount" tabIndex={0}>
                        −{fmt(Math.abs(Number(t.amount)))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── PDF Export Dropdown ─────────────────────────────────────────────────────
// Replaces the old single "Export full report" button. Click to open a
// menu, pick which report to build. Closes on outside click or escape.
const PDF_REPORTS = [
  { id: "full",       label: "Full report",                filename: "coinvane-export.pdf",       download: (api) => api.exportFullPDF() },
  { id: "monthly",    label: "Monthly summary",            filename: "coinvane-monthly.pdf",      download: (api) => api.exportMonthlyPDF() },
  { id: "yoy",        label: "Year-over-year categories",  filename: "coinvane-yoy.pdf",          download: (api) => api.exportCategoryYoyPDF() },
  { id: "budgets",    label: "Budget performance",         filename: "coinvane-budgets.pdf",      download: (api) => api.exportBudgetsPDF() },
  { id: "billsloans", label: "Bills & loans summary",      filename: "coinvane-bills-loans.pdf",  download: (api) => api.exportBillsLoansPDF() },
  { id: "tax",        label: "Tax summary (year-end)",     filename: "coinvane-tax-summary.pdf",  download: (api) => api.exportTaxSummaryPDF() },
  { id: "register",   label: "Register (plain print)",     filename: "coinvane-register.pdf",     download: (api) => api.exportRegisterPDF() },
];
// Full-instance .cvn backup panel — collapsed by default; expands to a
// passphrase input (optional). Empty passphrase = plaintext ZIP; any
// text = AES-256-GCM at rest with a PBKDF2-derived key. The file is
// downloaded directly by the browser — no server-side staging.
function BackupExportPanel({ theme, darkMode, toast }) {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    setErr("");
    if (passphrase && passphrase !== confirmPass) {
      setErr("Passphrases don't match.");
      return;
    }
    if (passphrase && passphrase.length < 8) {
      setErr("Use at least 8 characters for the passphrase.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.exportCvn(passphrase || null);
      toast?.(`Backup saved: ${r.filename} (${Math.round(r.bytes / 1024)} KB)`, "success");
      setOpen(false); setPassphrase(""); setConfirmPass("");
    } catch (e) {
      setErr(e.message || "Export failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <motion.button whileTap={{ scale: 0.97 }} type="button"
        onClick={() => setOpen(true)}
        className={`text-sm font-semibold px-3 py-2 rounded-xl ${darkMode ? "bg-violet-500/15 text-violet-300 border border-violet-500/30" : "bg-violet-50 text-violet-700 border border-violet-200"}`}>
        Download .cvn backup
      </motion.button>
    );
  }
  return (
    <div className={`p-3 rounded-xl border ${theme.border} ${theme.surface} space-y-2`}>
      <div>
        <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1`}>
          Passphrase (optional)
        </label>
        <input type="password" value={passphrase} disabled={busy}
          onChange={e => setPassphrase(e.target.value)}
          placeholder="Leave blank for unencrypted backup"
          className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
        <div className={`text-[11px] ${theme.textSubtle} mt-1 leading-relaxed`}>
          If provided: AES-256-GCM encryption with a PBKDF2-derived key. You'll need this same passphrase to restore. There is <strong>no recovery</strong> if forgotten. Empty = plaintext ZIP (still portable, but sensitive if the file leaks).
        </div>
      </div>
      {passphrase && (
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1`}>
            Confirm passphrase
          </label>
          <input type="password" value={confirmPass} disabled={busy}
            onChange={e => setConfirmPass(e.target.value)}
            className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
        </div>
      )}
      {err && (
        <div className={`text-xs px-2 py-1.5 rounded-lg ${darkMode ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-rose-50 text-rose-700 border border-rose-200"}`}>
          {err}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={() => { setOpen(false); setPassphrase(""); setConfirmPass(""); setErr(""); }}
          disabled={busy}
          className={`flex-1 py-2 rounded-xl text-sm ${theme.textSubtle} hover:bg-slate-500/5 disabled:opacity-60`}>
          Cancel
        </button>
        <button type="button" onClick={run} disabled={busy}
          className="flex-1 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
          {busy ? "Building…" : "Download"}
        </button>
      </div>
    </div>
  );
}

// Full-instance .cvn RESTORE panel. Two-step: preview -> confirm.
// Preview validates the file (parses ZIP, verifies checksum, decrypts
// if encrypted, checks passphrase) and shows the user WHAT will
// import. Only after they hit Restore do we actually insert. Blocks
// on a non-empty target with a link to Clear all data.
function BackupImportPanel({ theme, darkMode, toast }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [passphrase, setPassphrase] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null); // {imported: {...}}

  const reset = () => {
    setOpen(false); setFile(null); setPassphrase("");
    setPreview(null); setErr(""); setDone(null);
  };

  const runPreview = async () => {
    setErr(""); setPreview(null);
    if (!file) { setErr("Pick a .cvn file first."); return; }
    setBusy(true);
    try {
      const p = await api.previewCvnImport(file, passphrase || null);
      setPreview(p);
    } catch (e) { setErr(e.message || "Preview failed"); }
    finally { setBusy(false); }
  };

  const runImport = async () => {
    setErr("");
    setBusy(true);
    try {
      const r = await api.importCvn(file, passphrase || null);
      setDone(r);
    } catch (e) { setErr(e.message || "Import failed"); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <motion.button whileTap={{ scale: 0.97 }} type="button"
        onClick={() => setOpen(true)}
        className={`text-sm font-semibold px-3 py-2 rounded-xl ${theme.surface} border ${theme.border}`}>
        Restore from .cvn backup…
      </motion.button>
    );
  }
  if (done) {
    // Sum imported counts for a headline number.
    const totals = done.imported || {};
    const grand = Object.values(totals).reduce((a, b) => a + Number(b || 0), 0);
    return (
      <div className={`p-3 rounded-xl border ${theme.border} ${darkMode ? "bg-emerald-500/10 border-emerald-500/30" : "bg-emerald-50 border-emerald-200"} space-y-2`}>
        <div className="text-sm font-semibold text-emerald-700">Backup restored — {grand} rows imported.</div>
        <div className="text-xs text-emerald-800 grid grid-cols-2 gap-x-4 gap-y-0.5">
          {Object.entries(totals).map(([k, v]) => (
            <div key={k}><span className="font-mono">{v}</span> {k}</div>
          ))}
        </div>
        <div className="text-[11px] text-emerald-800 pt-1">
          Refresh the page to see the imported data across the app.
        </div>
        <button type="button" onClick={() => window.location.reload()}
          className="text-xs font-semibold text-emerald-700 underline hover:no-underline">
          Reload now
        </button>
      </div>
    );
  }
  return (
    <div className={`p-3 rounded-xl border ${theme.border} ${theme.surface} space-y-2`}>
      <div className="text-sm font-semibold">Restore from .cvn</div>
      <div className={`text-xs ${theme.textSubtle} leading-relaxed`}>
        Refuses to run unless your account is empty of data (categories are exempt — seeded defaults stay). Use <em>Clear all data</em> in Danger Zone if you need to start over. Your login, permissions, and settings stay untouched.
      </div>
      <div>
        <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1`}>Backup file</label>
        <input type="file" accept=".cvn,application/x-coinvane-export,application/zip"
          disabled={busy}
          onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setErr(""); }}
          className="text-xs w-full" />
      </div>
      <div>
        <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1`}>Passphrase (only if the backup was encrypted)</label>
        <input type="password" value={passphrase} disabled={busy}
          onChange={e => setPassphrase(e.target.value)}
          placeholder="Leave blank for unencrypted backups"
          className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
      </div>
      {err && (
        <div className={`text-xs px-2 py-1.5 rounded-lg ${darkMode ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-rose-50 text-rose-700 border border-rose-200"}`}>
          {err}
        </div>
      )}
      {preview && (
        <div className={`text-xs px-2 py-2 rounded-lg border ${theme.border}`}>
          <div className={`font-semibold ${theme.textMuted}`}>Ready to restore:</div>
          <div className={`grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1 ${theme.textMuted}`}>
            {Object.entries(preview.stats || {}).filter(([k]) => k !== "transactionsDateRange").map(([k, v]) => (
              <div key={k}><span className="font-mono">{v}</span> {k}</div>
            ))}
          </div>
          {preview.stats?.transactionsDateRange && (
            <div className={`text-[11px] mt-1 ${theme.textSubtle}`}>
              Transactions: {preview.stats.transactionsDateRange.from} → {preview.stats.transactionsDateRange.to}
            </div>
          )}
          <div className={`text-[11px] mt-1 ${theme.textSubtle}`}>
            Attachments: {preview.manifest?.attachmentCount || 0} · Encrypted: {preview.manifest?.encrypted ? "yes" : "no"}
          </div>
          {!preview.targetEmpty && (
            <div className={`text-[11px] mt-2 px-2 py-1.5 rounded-lg ${darkMode ? "bg-rose-500/15 text-rose-300" : "bg-rose-50 text-rose-700"}`}>
              Blocked: your account has {preview.blockedByCount} row(s) in <span className="font-mono">{preview.blockedByTable}</span>. Clear all data first.
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={reset} disabled={busy}
          className={`flex-1 py-2 rounded-xl text-sm ${theme.textSubtle} hover:bg-slate-500/5 disabled:opacity-60`}>
          Cancel
        </button>
        {!preview ? (
          <button type="button" onClick={runPreview} disabled={busy || !file}
            className="flex-1 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {busy ? "Checking…" : "Preview"}
          </button>
        ) : (
          <button type="button" onClick={runImport}
            disabled={busy || !preview.targetEmpty}
            className="flex-1 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {busy ? "Restoring…" : "Restore"}
          </button>
        )}
      </div>
    </div>
  );
}

function PdfExportDropdown({ exportingPdf, setExportingPdf, theme, darkMode, toast }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const runReport = async (r) => {
    setOpen(false);
    setExportingPdf(true);
    try { await r.download(api); toast?.(`${r.label} downloaded`, "success"); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setExportingPdf(false); }
  };
  return (
    <div className="relative" ref={ref}>
      <motion.button whileTap={{ scale: 0.97 }} type="button" disabled={exportingPdf}
        onClick={() => setOpen(v => !v)}
        className={`text-sm font-medium ${theme.surface} border ${theme.border} px-3 py-2 rounded-xl disabled:opacity-60 flex items-center gap-1`}>
        {exportingPdf ? "Building…" : "Export report (PDF)"}
        <ChevronDown className="w-3.5 h-3.5" />
      </motion.button>
      {open && (
        <div className={`absolute right-0 top-full mt-1 z-30 min-w-56 ${theme.surface} border ${theme.border} rounded-xl shadow-lg overflow-hidden`}>
          {PDF_REPORTS.map(r => (
            <button key={r.id} type="button" onClick={() => runReport(r)}
              className={`w-full text-left px-3 py-2 text-sm ${theme.hover} transition-colors`}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Loans Section (under GoalsTab) ──────────────────────────────────────────
// Sits below the Goals list. Each loan card shows balance, APR, monthly
// payment, and lets the user run an amortization projection with an
// optional extra-payment slider. Amortization math runs client-side.
const LOAN_TYPES = [
  { id: "mortgage",    label: "Mortgage" },
  { id: "auto",        label: "Auto loan" },
  { id: "student",     label: "Student loan" },
  { id: "personal",    label: "Personal" },
  { id: "credit_card", label: "Credit card" },
  { id: "other",       label: "Other" },
];

// Simulate paying off a portfolio of debts under a chosen strategy with
// an optional monthly extra applied to whichever debt is "next" per
// strategy. Snowball rolls each cleared debt's minimum into the next
// target so the pool of "extra" grows over time — that's what makes the
// method work. Cap at 720 months to guard against bad inputs.
//   strategy = "avalanche"  → target = highest APR
//   strategy = "snowball"   → target = smallest balance
// Returns { months, totalInterest, feasible }. feasible=false means at
// least one debt's minimum doesn't cover its interest.
function simulateDebts(loans, strategy, monthlyExtra) {
  const debts = loans
    .map(l => ({
      id: l.id, name: l.name,
      balance: Number(l.current_balance),
      apr: Number(l.apr),
      min: Number(l.monthly_payment),
    }))
    .filter(d => d.balance > 0.005 && d.min > 0);
  if (debts.length === 0) {
    return { months: 0, totalInterest: 0, feasible: true };
  }
  let months = 0;
  let totalInterest = 0;
  const pickTarget = (active) => {
    if (strategy === "avalanche") {
      return active.reduce((a, b) => a.apr >= b.apr ? a : b);
    }
    return active.reduce((a, b) => a.balance <= b.balance ? a : b);
  };
  while (debts.some(d => d.balance > 0.005) && months < 720) {
    // Rolled-in snowball extra = minimums of already-cleared debts.
    const cleared = debts.filter(d => d.balance <= 0.005);
    const active  = debts.filter(d => d.balance > 0.005);
    let extra = Number(monthlyExtra) + cleared.reduce((s, d) => s + d.min, 0);
    const target = pickTarget(active);
    let anyProgress = false;
    for (const d of active) {
      const rate = d.apr / 12 / 100;
      const interest = d.balance * rate;
      totalInterest += interest;
      let pay = d.min;
      if (d === target) pay += extra;
      if (pay < interest + 0.005) {
        // Min doesn't cover interest — bail out as infeasible.
        return { months: Infinity, totalInterest: Infinity, feasible: false };
      }
      const newBal = d.balance + interest - pay;
      if (newBal <= 0.005) {
        extra = Math.max(0, -newBal);
        d.balance = 0;
      } else {
        d.balance = newBal;
      }
      anyProgress = true;
    }
    if (!anyProgress) break;
    months++;
  }
  if (months >= 720 && debts.some(d => d.balance > 0.005)) {
    return { months: Infinity, totalInterest: Infinity, feasible: false };
  }
  return { months, totalInterest, feasible: true };
}

// Given balance, APR, and monthly payment, iterate month-by-month until
// paid off. Returns { months, totalInterest, months_over_term }.
// Caps at 720 (60 years) so a bad payment number can't infinite-loop.
function projectPayoff(balance, apr, monthlyPayment, extra = 0) {
  const r = Number(apr) / 12 / 100;
  const pay = Number(monthlyPayment) + Number(extra);
  if (pay <= 0) return { months: Infinity, totalInterest: Infinity, principalPaid: 0 };
  let bal = Number(balance);
  let months = 0;
  let totalInterest = 0;
  const startBal = bal;
  while (bal > 0 && months < 720) {
    const interest = bal * r;
    // If the payment doesn't even cover the interest, we'll never pay off.
    if (pay <= interest + 0.01) return { months: Infinity, totalInterest: Infinity, principalPaid: 0 };
    totalInterest += interest;
    bal = bal + interest - pay;
    months++;
    if (bal < 0.01) bal = 0;
  }
  return { months, totalInterest, principalPaid: startBal };
}

function LoansSection({ theme, darkMode, toast }) {
  const { accounts, refreshAll } = useData();
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [strategy, setStrategy] = useState("avalanche"); // "avalanche" | "snowball"

  const load = useCallback(async () => {
    try { setLoans(await api.listLoans()); }
    catch { toast?.("Failed to load loans", "error"); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const activeLoans = loans;
  const totalBalance = activeLoans.reduce((s, l) => s + Number(l.current_balance), 0);
  const totalMonthly = activeLoans.reduce((s, l) => s + Number(l.monthly_payment), 0);

  // Snowball = smallest balance first. Avalanche = highest APR first.
  const orderedLoans = useMemo(() => {
    const sorted = [...activeLoans];
    if (strategy === "avalanche") sorted.sort((a, b) => Number(b.apr) - Number(a.apr));
    else sorted.sort((a, b) => Number(a.current_balance) - Number(b.current_balance));
    return sorted;
  }, [activeLoans, strategy]);

  const removeLoan = async (loan) => {
    if (!window.confirm(`Archive loan "${loan.name}"? Its record will be kept.`)) return;
    try {
      await api.deleteLoan(loan.id);
      toast?.("Loan archived", "success");
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const [payingLoan, setPayingLoan] = useState(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Debts &amp; loans</h3>
          <p className={`text-xs ${theme.textSubtle}`}>
            Track balance, APR, and payoff projections.
          </p>
        </div>
        <button type="button" onClick={() => { setEditing(null); setShowForm(true); }}
          className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-violet-500 text-white hover:bg-violet-600 flex items-center gap-1">
          <Plus className="w-3.5 h-3.5" /> Add loan
        </button>
      </div>

      {loading ? (
        <div className={`text-sm ${theme.textSubtle}`}>Loading…</div>
      ) : activeLoans.length === 0 ? (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} p-6 text-center`}>
          <TrendingDown className={`w-6 h-6 mx-auto ${theme.textSubtle} mb-1`} />
          <p className={`text-xs ${theme.textSubtle}`}>
            No loans tracked yet.
          </p>
        </div>
      ) : (
        <>
          {activeLoans.length >= 2 && (
            <DebtSimulator loans={activeLoans} strategy={strategy} setStrategy={setStrategy}
              totalBalance={totalBalance} totalMonthly={totalMonthly}
              theme={theme} darkMode={darkMode} />
          )}
          <div className="space-y-2">
            {orderedLoans.map(loan => (
              <LoanCard key={loan.id} loan={loan} theme={theme} darkMode={darkMode}
                onEdit={() => { setEditing(loan); setShowForm(true); }}
                onPayment={() => setPayingLoan(loan)}
                onRemove={() => removeLoan(loan)} />
            ))}
          </div>
        </>
      )}

      <LoanFormSheet
        open={showForm}
        onClose={() => { setShowForm(false); setEditing(null); }}
        editing={editing}
        accounts={accounts}
        theme={theme}
        darkMode={darkMode}
        toast={toast}
        onSaved={() => { setShowForm(false); setEditing(null); load(); }}
      />
      <LoanPaymentSheet open={!!payingLoan} loan={payingLoan}
        accounts={accounts} theme={theme} darkMode={darkMode} toast={toast}
        onClose={() => setPayingLoan(null)}
        onSaved={(resp) => {
          // Optimistically patch the current_balance in local state so
          // the card updates instantly. The follow-up load() will
          // reconcile against whatever else changed.
          if (payingLoan && resp && Number.isFinite(Number(resp.current_balance))) {
            const newBal = Number(resp.current_balance);
            setLoans(prev => prev.map(l =>
              l.id === payingLoan.id ? { ...l, current_balance: newBal } : l
            ));
          }
          setPayingLoan(null);
          load();
          refreshAll?.();
        }} />
    </div>
  );
}

// ─── Loan payment sheet ───────────────────────────────────────────────────────
// Records a payment against a loan record AND, when a source account is
// picked, posts a matching outflow transaction on that account. The
// backend keeps loans + accounts in the two decoupled tables it's had
// since Stage 2; this sheet just gives the user one action to hit both.
function LoanPaymentSheet({ open, onClose, loan, accounts, theme, darkMode, toast, onSaved }) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  useEffect(() => {
    if (!open || !loan) return;
    setAmount(String(loan.monthly_payment || ""));
    setAccountId("");
    setDate(new Date().toISOString().slice(0, 10));
  }, [open, loan]);
  if (!open || !loan) return null;
  // Payment sources: cash / checking style accounts. Credit cards + loans
  // themselves are hidden — you don't pay a loan from another loan.
  const paymentSources = accounts.filter(a => a.type === "cash" || a.type === "credit");
  const save = async () => {
    const n = Number(amount);
    if (!(n > 0)) { toast?.("Enter a positive amount", "error"); return; }
    setSaving(true);
    try {
      const resp = await api.recordLoanPayment(loan.id, n, {
        accountId: accountId ? Number(accountId) : undefined,
        date,
      });
      // The backend returns the new current_balance so the caller can
      // reconcile local state without waiting for the follow-up list
      // refetch. Toast reads the returned number so the user sees the
      // outcome even if the sidebar hasn't caught up yet.
      const newBalance = Number(resp?.current_balance);
      const before = Number(loan.current_balance || 0);
      const reduction = Number.isFinite(newBalance) ? (before - newBalance) : n;
      toast?.(
        Number.isFinite(newBalance)
          ? `Payment of ${fmt(reduction)} recorded — balance now ${fmt(newBalance)}`
          : `Payment of ${fmt(n)} recorded`,
        "success"
      );
      onSaved?.(resp);
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title={`Payment · ${loan.name}`} theme={theme}>
      <div className="space-y-3">
        <div className={`text-xs ${theme.textSubtle}`}>
          Current balance {fmt(Number(loan.current_balance) || 0)} · monthly {fmt(Number(loan.monthly_payment) || 0)}
        </div>
        {!loan.linked_account_id && accounts.some(a => a.type === "loan") && (
          <div className={`text-[11px] rounded-xl p-2 ${darkMode ? "bg-amber-500/10 text-amber-300 border border-amber-500/30" : "bg-amber-50 text-amber-700 border border-amber-200"}`}>
            This loan isn't linked to a loan-type account, so recording a payment won't reduce anything in the Accounts tab. Edit the loan to point it at the matching loan account and future payments will mirror across automatically.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Amount</label>
            <input type="number" step="0.01" min="0" value={amount}
              onChange={e => setAmount(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Paid from (optional)</label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)} className={inputCls}>
            <option value="">— none — just decrement the loan balance</option>
            {paymentSources.map(a => (
              <option key={a.id} value={a.id}>{a.name}{a.institution ? ` · ${a.institution}` : ""}</option>
            ))}
          </select>
          <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
            Picking an account also posts an outflow transaction there so the payment shows on cashflow + budgets.
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>Cancel</button>
          <button type="button" onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Recording…" : "Record payment"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ─── DebtSimulator (unified payoff planner across all loans) ─────────────
// Shown at the top of LoansSection when the user has 2+ debts. Combines
// every loan into one "throw $X/mo extra at the pile" model. Cascades
// each cleared debt's minimum onto the current target debt (that's the
// snowball/avalanche effect). Renders headline "months saved / interest
// saved" vs. baseline (extra = 0).
function DebtSimulator({ loans, strategy, setStrategy, totalBalance, totalMonthly, theme, darkMode }) {
  const [extra, setExtra] = useState(0);
  const baseline = useMemo(() => simulateDebts(loans, strategy, 0), [loans, strategy]);
  const withExtra = useMemo(() => simulateDebts(loans, strategy, extra), [loans, strategy, extra]);
  const target = useMemo(() => {
    if (loans.length === 0) return null;
    if (strategy === "avalanche") {
      return loans.reduce((a, b) => Number(a.apr) >= Number(b.apr) ? a : b);
    }
    return loans.reduce((a, b) => Number(a.current_balance) <= Number(b.current_balance) ? a : b);
  }, [loans, strategy]);
  const fmtMonths = (m) => {
    if (!Number.isFinite(m)) return "never";
    const y = Math.floor(m / 12); const r = m % 12;
    if (y === 0) return `${r} mo`;
    if (r === 0) return `${y} yr`;
    return `${y} yr ${r} mo`;
  };
  const interestSaved = Number.isFinite(baseline.totalInterest) && Number.isFinite(withExtra.totalInterest)
    ? Math.max(0, baseline.totalInterest - withExtra.totalInterest) : 0;
  const monthsSaved = Number.isFinite(baseline.months) && Number.isFinite(withExtra.months)
    ? Math.max(0, baseline.months - withExtra.months) : 0;
  const maxExtra = Math.max(500, Math.round(totalMonthly * 2));

  return (
    <div className={`${theme.surface} rounded-2xl border ${theme.border} p-4 space-y-3`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm font-semibold">Debt payoff simulator</div>
          <div className={`text-xs ${theme.textSubtle}`}>
            Balance: <span className="private-amount" tabIndex={0}>{fmt(totalBalance)}</span> ·
            Minimums: <span className="private-amount" tabIndex={0}>{fmt(totalMonthly)}</span>/mo
          </div>
        </div>
        <div className={`flex items-center gap-1 p-0.5 rounded-full ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
          <button onClick={() => setStrategy("avalanche")}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${strategy === "avalanche" ? "bg-violet-500 text-white" : theme.textMuted}`}>
            Avalanche
          </button>
          <button onClick={() => setStrategy("snowball")}
            className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${strategy === "snowball" ? "bg-violet-500 text-white" : theme.textMuted}`}>
            Snowball
          </button>
        </div>
      </div>

      <div className={`rounded-xl border ${theme.border} p-3`}>
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className={theme.textSubtle}>Extra $ / month across all debts</span>
          <span className="private-amount font-semibold" tabIndex={0}>+{fmt(extra)}</span>
        </div>
        <input type="range" min="0" max={maxExtra} step="10"
          value={extra} onChange={e => setExtra(Number(e.target.value))}
          className="w-full accent-violet-500" />
        <div className={`text-[11px] ${theme.textSubtle} mt-1`}>
          {strategy === "avalanche"
            ? "Throw the extra at the highest-APR debt. As each debt clears, its minimum rolls into the next target."
            : "Throw the extra at the smallest-balance debt. As each debt clears, its minimum rolls into the next target."}
          {target && (
            <> Target: <span className="font-semibold text-violet-500">{target.name}</span>.</>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className={`rounded-xl border ${theme.border} p-3`}>
          <div className={theme.textSubtle}>Baseline (min only)</div>
          <div className="font-semibold text-sm">{fmtMonths(baseline.months)}</div>
          <div className={theme.textSubtle}>
            Interest: <span className="private-amount" tabIndex={0}>
              {Number.isFinite(baseline.totalInterest) ? fmt(baseline.totalInterest) : "—"}
            </span>
          </div>
        </div>
        <div className={`rounded-xl border ${theme.border} p-3`}>
          <div className={theme.textSubtle}>With extra + rollover</div>
          <div className={`font-semibold text-sm ${extra > 0 && withExtra.feasible ? "text-emerald-500" : ""}`}>
            {fmtMonths(withExtra.months)}
          </div>
          <div className={theme.textSubtle}>
            Interest: <span className="private-amount" tabIndex={0}>
              {Number.isFinite(withExtra.totalInterest) ? fmt(withExtra.totalInterest) : "—"}
            </span>
          </div>
        </div>
      </div>

      {extra > 0 && withExtra.feasible && (interestSaved > 0 || monthsSaved > 0) && (
        <div className={`text-xs ${theme.textSubtle} pt-1 border-t ${theme.border}`}>
          Saves <span className="private-amount font-semibold text-emerald-500" tabIndex={0}>
            {fmt(interestSaved)}
          </span> in interest and{" "}
          <span className="font-semibold text-emerald-500">
            {monthsSaved} month{monthsSaved === 1 ? "" : "s"}
          </span> off total payoff.
        </div>
      )}
      {(!baseline.feasible || !withExtra.feasible) && (
        <div className="text-xs text-rose-500">
          At least one debt's minimum doesn't cover its monthly interest — payoff isn't reachable at the current inputs.
        </div>
      )}
    </div>
  );
}

function LoanCard({ loan, theme, darkMode, onEdit, onPayment, onRemove }) {
  const [extra, setExtra] = useState(0);
  const base = projectPayoff(loan.current_balance, loan.apr, loan.monthly_payment, 0);
  const withExtra = projectPayoff(loan.current_balance, loan.apr, loan.monthly_payment, extra);
  const paidOffPct = Number(loan.principal) > 0
    ? Math.round(((Number(loan.principal) - Number(loan.current_balance)) / Number(loan.principal)) * 100)
    : 0;
  // PITI = P&I + tax + insurance + PMI + other. Zero when nothing set.
  const eTax   = Number(loan.escrow_tax || 0);
  const eIns   = Number(loan.escrow_insurance || 0);
  const ePmi   = Number(loan.escrow_pmi || 0);
  const eOther = Number(loan.escrow_other || 0);
  const escrowTotal = eTax + eIns + ePmi + eOther;
  const piti = Number(loan.monthly_payment) + escrowTotal;
  const hasEscrow = escrowTotal > 0;
  const fmtMonths = (m) => {
    if (!Number.isFinite(m)) return "never (payment too low)";
    const y = Math.floor(m / 12); const r = m % 12;
    if (y === 0) return `${r} mo`;
    if (r === 0) return `${y} yr`;
    return `${y} yr ${r} mo`;
  };
  return (
    <div className={`${theme.surface} rounded-2xl border ${theme.border} p-4`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">{loan.name}</div>
          <div className={`text-xs ${theme.textSubtle} mt-0.5`}>
            {(LOAN_TYPES.find(t => t.id === loan.loan_type) || {}).label || "Other"} ·
            {" "}{Number(loan.apr).toFixed(2)}% APR ·
            {" "}<span className="private-amount" tabIndex={0}>{fmt(Number(loan.monthly_payment))}</span>/mo
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-bold private-amount" tabIndex={0}>{fmt(Number(loan.current_balance))}</div>
          <div className={`text-[10px] ${theme.textSubtle}`}>
            of <span className="private-amount" tabIndex={0}>{fmt(Number(loan.principal))}</span>
          </div>
        </div>
      </div>
      <ProgressBar value={paidOffPct} color="bg-emerald-500" darkMode={darkMode} />
      <div className={`text-[11px] ${theme.textSubtle} mt-1 mb-3`}>{paidOffPct}% paid off</div>

      {/* PITI breakdown — only rendered when the user has entered any
          escrow amounts. Segments render in proportion to $ amount so the
          visual maps 1:1 to the label totals. */}
      {hasEscrow && (
        <div className={`rounded-xl border ${theme.border} p-3 mb-3`}>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className={theme.textSubtle}>Full monthly (PITI)</span>
            <span className="font-semibold private-amount" tabIndex={0}>{fmt(piti)}/mo</span>
          </div>
          <div className={`h-2 rounded-full overflow-hidden flex ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
            {[
              { v: Number(loan.monthly_payment), c: "#8b5cf6", label: "P&I" },
              { v: eTax,   c: "#f59e0b", label: "Tax" },
              { v: eIns,   c: "#0ea5e9", label: "Insurance" },
              { v: ePmi,   c: "#f43f5e", label: "PMI" },
              { v: eOther, c: "#64748b", label: "Other" },
            ].filter(s => s.v > 0).map((s, i) => (
              <div key={i} title={`${s.label}: ${fmt(s.v)}/mo`}
                style={{ width: `${(s.v / piti) * 100}%`, background: s.c }} />
            ))}
          </div>
          <div className={`mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] ${theme.textSubtle}`}>
            <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-500" /> P&amp;I <span className="private-amount ml-auto" tabIndex={0}>{fmt(Number(loan.monthly_payment))}</span></div>
            {eTax > 0   && <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Tax <span className="private-amount ml-auto" tabIndex={0}>{fmt(eTax)}</span></div>}
            {eIns > 0   && <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-500" /> Ins <span className="private-amount ml-auto" tabIndex={0}>{fmt(eIns)}</span></div>}
            {ePmi > 0   && <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" /> PMI <span className="private-amount ml-auto" tabIndex={0}>{fmt(ePmi)}</span></div>}
            {eOther > 0 && <div className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-500" /> Other <span className="private-amount ml-auto" tabIndex={0}>{fmt(eOther)}</span></div>}
          </div>
        </div>
      )}

      <div className={`rounded-xl border ${theme.border} p-3 space-y-2`}>
        <div className="flex items-center justify-between text-xs">
          <div className={theme.textSubtle}>Extra payment</div>
          <div className="private-amount font-semibold" tabIndex={0}>
            +{fmt(extra)}/mo
          </div>
        </div>
        <input type="range" min="0" max={Math.max(500, Math.round(Number(loan.monthly_payment) * 2))} step="10"
          value={extra} onChange={e => setExtra(Number(e.target.value))}
          className="w-full accent-violet-500" />
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className={theme.textSubtle}>Payoff (current)</div>
            <div className="font-semibold">{fmtMonths(base.months)}</div>
            <div className={theme.textSubtle}>
              Interest: <span className="private-amount" tabIndex={0}>
                {Number.isFinite(base.totalInterest) ? fmt(base.totalInterest) : "—"}
              </span>
            </div>
          </div>
          <div>
            <div className={theme.textSubtle}>With extra</div>
            <div className={`font-semibold ${extra > 0 ? "text-emerald-500" : ""}`}>
              {fmtMonths(withExtra.months)}
            </div>
            <div className={theme.textSubtle}>
              Interest: <span className="private-amount" tabIndex={0}>
                {Number.isFinite(withExtra.totalInterest) ? fmt(withExtra.totalInterest) : "—"}
              </span>
            </div>
          </div>
        </div>
        {Number.isFinite(base.totalInterest) && Number.isFinite(withExtra.totalInterest) && extra > 0 && (
          <div className={`text-[11px] ${theme.textSubtle} pt-1 border-t ${theme.border}`}>
            Saves <span className="private-amount font-semibold text-emerald-500" tabIndex={0}>
              {fmt(base.totalInterest - withExtra.totalInterest)}
            </span> in interest and{" "}
            <span className="font-semibold text-emerald-500">
              {base.months - withExtra.months} month{base.months - withExtra.months === 1 ? "" : "s"}
            </span> off the term.
          </div>
        )}
      </div>

      <div className="flex gap-1.5 mt-3 flex-wrap">
        <button type="button" onClick={onPayment}
          className="flex-1 min-w-[100px] py-1.5 rounded-lg text-xs font-semibold bg-violet-500 text-white hover:bg-violet-600 flex items-center justify-center gap-1">
          <Check className="w-3 h-3" /> Record payment
        </button>
        <button type="button" onClick={onEdit}
          className={`py-1.5 px-3 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover} flex items-center gap-1`}>
          <Pencil className="w-3 h-3" /> Edit
        </button>
        <button type="button" onClick={() => api.exportAmortizationPDF(loan.id)}
          className={`py-1.5 px-3 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover} flex items-center gap-1`}>
          <FileText className="w-3 h-3" /> Amort PDF
        </button>
        <button type="button" onClick={onRemove}
          className={`py-1.5 px-2 rounded-lg text-xs font-semibold border ${theme.border} text-rose-500 hover:bg-rose-500/10`}>
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function LoanFormSheet({ open, onClose, editing, accounts, theme, darkMode, toast, onSaved }) {
  const [form, setForm] = useState(() => defaultLoanForm());
  const [saving, setSaving] = useState(false);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name || "",
        loan_type: editing.loan_type || "other",
        principal: String(editing.principal ?? ""),
        current_balance: String(editing.current_balance ?? ""),
        apr: String(editing.apr ?? ""),
        term_months: String(editing.term_months ?? ""),
        monthly_payment: String(editing.monthly_payment ?? ""),
        start_date: editing.start_date?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        linked_account_id: editing.linked_account_id || "",
        notes: editing.notes || "",
        escrow_tax: String(editing.escrow_tax ?? ""),
        escrow_insurance: String(editing.escrow_insurance ?? ""),
        escrow_pmi: String(editing.escrow_pmi ?? ""),
        escrow_other: String(editing.escrow_other ?? ""),
      });
    } else {
      setForm(defaultLoanForm());
    }
  }, [open, editing]);

  const save = async () => {
    if (!form.name.trim() || !form.principal || !form.current_balance) {
      toast?.("Name, principal, and current balance are required", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        principal: Number(form.principal),
        current_balance: Number(form.current_balance),
        apr: Number(form.apr) || 0,
        term_months: Number(form.term_months) || 0,
        monthly_payment: Number(form.monthly_payment) || 0,
        linked_account_id: form.linked_account_id || null,
        escrow_tax:       Number(form.escrow_tax) || 0,
        escrow_insurance: Number(form.escrow_insurance) || 0,
        escrow_pmi:       Number(form.escrow_pmi) || 0,
        escrow_other:     Number(form.escrow_other) || 0,
      };
      if (editing) {
        await api.updateLoan(editing.id, payload);
        toast?.("Loan updated", "success");
      } else {
        await api.createLoan(payload);
        toast?.("Loan created", "success");
      }
      onSaved();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setSaving(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} title={editing ? "Edit loan" : "Add loan"} theme={theme}>
      <div className="space-y-3">
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Name</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Mortgage, Car loan" className={inputCls} />
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Type</label>
          <select value={form.loan_type} onChange={e => setForm({ ...form, loan_type: e.target.value })} className={inputCls}>
            {LOAN_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Original principal</label>
            <input type="number" step="0.01" value={form.principal}
              onChange={e => setForm({ ...form, principal: e.target.value })}
              className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Current balance</label>
            <input type="number" step="0.01" value={form.current_balance}
              onChange={e => setForm({ ...form, current_balance: e.target.value })}
              className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>APR %</label>
            <input type="number" step="0.01" value={form.apr}
              onChange={e => setForm({ ...form, apr: e.target.value })}
              className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Term (months)</label>
            <input type="number" value={form.term_months}
              onChange={e => setForm({ ...form, term_months: e.target.value })}
              className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Monthly pmt</label>
            <input type="number" step="0.01" value={form.monthly_payment}
              onChange={e => setForm({ ...form, monthly_payment: e.target.value })}
              className={inputCls} />
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Start date</label>
          <input type="date" value={form.start_date}
            onChange={e => setForm({ ...form, start_date: e.target.value })}
            className={inputCls} />
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>
            Linked loan account (optional)
          </label>
          <select value={form.linked_account_id} onChange={e => setForm({ ...form, linked_account_id: e.target.value })} className={inputCls}>
            <option value="">Not linked</option>
            {accounts.filter(a => a.type === "loan").map(a => (
              <option key={a.id} value={a.id}>{a.name}{a.institution ? ` · ${a.institution}` : ""}</option>
            ))}
          </select>
          <div className={`text-[10px] ${theme.textSubtle} mt-1`}>
            Point this at the loan account in your Accounts tab that mirrors this debt. Recording a payment on this tracker will then also reduce that account's balance automatically.
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Notes</label>
          <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
            rows={2} className={inputCls} />
        </div>

        {/* Escrow breakdown — mortgage-specific but not gated so the user
            can still track PMI on non-conventional loans if they want to. */}
        <details className={`rounded-2xl border ${theme.border}`} open={form.loan_type === "mortgage"}>
          <summary className={`px-3 py-2 text-xs font-semibold ${theme.textSubtle} cursor-pointer select-none`}>
            Escrow breakdown (monthly, on top of P&amp;I)
          </summary>
          <div className="grid grid-cols-2 gap-3 p-3">
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Property tax</label>
              <input type="number" step="0.01" value={form.escrow_tax}
                onChange={e => setForm({ ...form, escrow_tax: e.target.value })}
                placeholder="0.00" className={inputCls} />
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Homeowners insurance</label>
              <input type="number" step="0.01" value={form.escrow_insurance}
                onChange={e => setForm({ ...form, escrow_insurance: e.target.value })}
                placeholder="0.00" className={inputCls} />
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>PMI</label>
              <input type="number" step="0.01" value={form.escrow_pmi}
                onChange={e => setForm({ ...form, escrow_pmi: e.target.value })}
                placeholder="0.00" className={inputCls} />
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Other (HOA, etc.)</label>
              <input type="number" step="0.01" value={form.escrow_other}
                onChange={e => setForm({ ...form, escrow_other: e.target.value })}
                placeholder="0.00" className={inputCls} />
            </div>
          </div>
        </details>

        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Saving…" : editing ? "Save changes" : "Create loan"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function defaultLoanForm() {
  return {
    name: "", loan_type: "other",
    principal: "", current_balance: "",
    apr: "", term_months: "", monthly_payment: "",
    start_date: new Date().toISOString().slice(0, 10),
    linked_account_id: "", notes: "",
    escrow_tax: "", escrow_insurance: "", escrow_pmi: "", escrow_other: "",
  };
}

// ─── Bills Tab ────────────────────────────────────────────────────────────────
// Recurring outgoing obligations. Distinct from scheduled transactions:
// each bill is a template that regenerates a "cycle" every period, and
// each cycle has a paid/unpaid state + variance-vs-average tracking.
// Auto-match runs on every incoming transaction (sync.js); the manual
// fallbacks (Mark paid / Undo / Skip) live on each card here.
const BILL_CYCLES = [
  { id: "weekly",       label: "Weekly" },
  { id: "biweekly",     label: "Bi-weekly" },
  { id: "semimonthly",  label: "Semi-monthly (1st + 15th)" },
  { id: "monthly",      label: "Monthly" },
  { id: "yearly",       label: "Yearly" },
  { id: "custom",       label: "Custom (every N days)" },
];

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const [ay, am, ad] = fromIso.slice(0, 10).split("-").map(Number);
  const [by, bm, bd] = toIso.slice(0, 10).split("-").map(Number);
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  return Math.round((b - a) / (24 * 3600 * 1000));
}

function BillsTab({ theme, darkMode, toast }) {
  const { accounts, categories } = useData();
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const load = useCallback(async () => {
    try { setBills(await api.listBills(3)); }
    catch { toast?.("Failed to load bills", "error"); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  // Categorize bills for the two-panel layout.
  const active = bills.filter(b => !b.archived_at);
  const dueSoon = active.filter(b =>
    b.current && !b.current.paid_at && !b.current.skipped
    && daysBetween(todayIso, b.current.due_date) <= 7
  );
  const paidThisCycle = active.filter(b => b.current?.paid_at);
  const upcoming = active.filter(b => !dueSoon.includes(b) && !paidThisCycle.includes(b));

  const markPaid = async (bill) => {
    try {
      await api.markBillPaid(bill.id);
      toast?.(`${bill.name} — marked paid`, "success");
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };
  const markUnpaid = async (bill) => {
    try {
      await api.markBillUnpaid(bill.id);
      toast?.(`${bill.name} — reset to unpaid`, "success");
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };
  const skipCycle = async (bill) => {
    try {
      await api.skipBillCycle(bill.id);
      toast?.(`${bill.name} — skipped this cycle`, "success");
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };
  const removeBill = async (bill) => {
    if (!window.confirm(`Archive bill "${bill.name}"? Its history will be kept.`)) return;
    try {
      await api.deleteBill(bill.id);
      toast?.("Bill archived", "success");
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Bills</h2>
          <p className={`text-xs ${theme.textSubtle}`}>Recurring obligations — auto-matched from your bank when possible.</p>
        </div>
        <button type="button" onClick={() => { setEditing(null); setShowForm(true); }}
          className="px-4 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> Add bill
        </button>
      </div>

      {loading ? (
        <div className={`text-sm ${theme.textSubtle}`}>Loading…</div>
      ) : active.length === 0 ? (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} p-8 text-center`}>
          <Calendar className={`w-8 h-8 mx-auto ${theme.textSubtle} mb-2`} />
          <div className="font-semibold">No bills yet</div>
          <p className={`text-xs ${theme.textSubtle} mt-1`}>
            Add a bill to track when it's due, whether it's been paid, and how
            much it's varying month-to-month.
          </p>
        </div>
      ) : (
        <>
          <BillGroup title="Due this cycle" bills={dueSoon} tone="amber"
            theme={theme} darkMode={darkMode} accounts={accounts}
            todayIso={todayIso}
            onEdit={(b) => { setEditing(b); setShowForm(true); }}
            onMarkPaid={markPaid} onSkip={skipCycle} onRemove={removeBill} />
          <BillGroup title="Upcoming" bills={upcoming} tone="slate"
            theme={theme} darkMode={darkMode} accounts={accounts}
            todayIso={todayIso}
            onEdit={(b) => { setEditing(b); setShowForm(true); }}
            onMarkPaid={markPaid} onSkip={skipCycle} onRemove={removeBill} />
          <BillGroup title="Paid this cycle" bills={paidThisCycle} tone="emerald"
            theme={theme} darkMode={darkMode} accounts={accounts}
            todayIso={todayIso}
            onEdit={(b) => { setEditing(b); setShowForm(true); }}
            onMarkPaid={markPaid} onSkip={skipCycle} onRemove={removeBill}
            onMarkUnpaid={markUnpaid} paid />
        </>
      )}

      <BillFormSheet
        open={showForm}
        onClose={() => { setShowForm(false); setEditing(null); }}
        editing={editing}
        accounts={accounts}
        categories={categories}
        theme={theme}
        darkMode={darkMode}
        toast={toast}
        onSaved={() => { setShowForm(false); setEditing(null); load(); }}
      />
    </div>
  );
}

function BillGroup({ title, bills, tone, theme, darkMode, accounts, todayIso,
                    onEdit, onMarkPaid, onSkip, onRemove, onMarkUnpaid, paid }) {
  if (bills.length === 0) return null;
  const toneCls = {
    amber:   darkMode ? "text-amber-400"   : "text-amber-600",
    slate:   theme.textSubtle,
    emerald: darkMode ? "text-emerald-400" : "text-emerald-600",
  }[tone];
  return (
    <div>
      <div className={`text-[11px] font-semibold ${toneCls} uppercase tracking-wider mb-2 px-1`}>
        {title} <span className={theme.textSubtle}>· {bills.length}</span>
      </div>
      <div className="space-y-2">
        {bills.map(b => (
          <BillCard key={b.id} bill={b} accounts={accounts} theme={theme} darkMode={darkMode}
            todayIso={todayIso}
            onEdit={() => onEdit(b)}
            onMarkPaid={() => onMarkPaid(b)}
            onMarkUnpaid={onMarkUnpaid ? () => onMarkUnpaid(b) : null}
            onSkip={() => onSkip(b)}
            onRemove={() => onRemove(b)}
            paid={paid} />
        ))}
      </div>
    </div>
  );
}

function BillCard({ bill, accounts, theme, darkMode, todayIso,
                   onEdit, onMarkPaid, onMarkUnpaid, onSkip, onRemove, paid }) {
  const acct = accounts.find(a => a.id === bill.account_id);
  const cycle = bill.current || {};
  const daysUntil = daysBetween(todayIso, cycle.due_date);
  const overdue = !paid && daysUntil != null && daysUntil < 0;
  const avg = bill.average_amount || bill.expected_amount || 0;
  const variance = cycle.variance_pct;
  const varianceHigh = variance != null && Math.abs(Number(variance)) >= 25;
  return (
    <div className={`${theme.surface} rounded-2xl border ${theme.border} p-4`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-semibold text-sm">{bill.name}</div>
            {bill.autopay && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                darkMode ? "bg-sky-500/15 text-sky-400" : "bg-sky-50 text-sky-700"
              }`}>Autopay</span>
            )}
            {overdue && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                darkMode ? "bg-rose-500/15 text-rose-400" : "bg-rose-50 text-rose-700"
              }`}>Overdue</span>
            )}
          </div>
          <div className={`text-xs ${theme.textSubtle} mt-0.5`}>
            {bill.category} · {(BILL_CYCLES.find(c => c.id === bill.cycle) || {}).label || bill.cycle}
            {acct ? ` · ${acct.name}` : ""}
            {bill.account_hint ? ` (${bill.account_hint})` : ""}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="font-bold text-sm private-amount" tabIndex={0}>
            {fmt(Number(bill.expected_amount) || 0)}
          </div>
          {avg > 0 && Number(bill.expected_amount) > 0 && Math.abs(avg - Number(bill.expected_amount)) > 1 && (
            <div className={`text-[10px] ${theme.textSubtle}`}>
              avg <span className="private-amount" tabIndex={0}>{fmt(avg)}</span>
            </div>
          )}
        </div>
      </div>

      <div className={`text-xs ${theme.textSubtle} flex items-center gap-2 mb-3 flex-wrap`}>
        {paid ? (
          <>
            <span className={darkMode ? "text-emerald-400" : "text-emerald-600"}>
              Paid <span className="private-amount" tabIndex={0}>{fmt(Number(cycle.paid_amount) || 0)}</span>
            </span>
            {variance != null && (
              <span className={varianceHigh ? (Number(variance) > 0 ? "text-rose-500" : "text-emerald-500") : theme.textSubtle}>
                ({Number(variance) > 0 ? "+" : ""}{Number(variance).toFixed(1)}% vs expected)
              </span>
            )}
          </>
        ) : cycle.skipped ? (
          <span>Skipped this cycle</span>
        ) : (
          <span>Due {cycle.due_date} · {daysUntil == null ? "" : daysUntil >= 0 ? `in ${daysUntil} day${daysUntil === 1 ? "" : "s"}` : `${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? "" : "s"} ago`}</span>
        )}
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {!paid && !cycle.skipped && (
          <button type="button" onClick={onMarkPaid}
            className="flex-1 min-w-[100px] py-1.5 rounded-lg text-xs font-semibold bg-violet-500 text-white hover:bg-violet-600 flex items-center justify-center gap-1">
            <Check className="w-3 h-3" /> Mark paid
          </button>
        )}
        {paid && onMarkUnpaid && (
          <button type="button" onClick={onMarkUnpaid}
            className={`flex-1 min-w-[100px] py-1.5 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover} flex items-center justify-center gap-1`}>
            Undo paid
          </button>
        )}
        {!paid && !cycle.skipped && (
          <button type="button" onClick={onSkip}
            className={`py-1.5 px-3 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover}`}>
            Skip
          </button>
        )}
        <button type="button" onClick={onEdit}
          className={`py-1.5 px-3 rounded-lg text-xs font-semibold border ${theme.border} ${theme.hover} flex items-center gap-1`}>
          <Pencil className="w-3 h-3" /> Edit
        </button>
        <button type="button" onClick={onRemove}
          className={`py-1.5 px-2 rounded-lg text-xs font-semibold border ${theme.border} text-rose-500 hover:bg-rose-500/10`}>
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function BillFormSheet({ open, onClose, editing, accounts, categories, theme, darkMode, toast, onSaved }) {
  const [form, setForm] = useState(() => defaultBillForm());
  const [saving, setSaving] = useState(false);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name || "",
        category: editing.category || "Bills",
        cycle: editing.cycle || "monthly",
        cycle_days: editing.cycle_days || 30,
        cycle_anchor: editing.cycle_anchor?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        expected_amount: String(editing.expected_amount ?? ""),
        account_id: editing.account_id || "",
        autopay: !!editing.autopay,
        account_hint: editing.account_hint || "",
        min_payment: editing.min_payment != null ? String(editing.min_payment) : "",
        merchant_pattern: editing.merchant_pattern || "",
        notes: editing.notes || "",
      });
    } else {
      setForm(defaultBillForm());
    }
  }, [open, editing]);

  const save = async () => {
    if (!form.name.trim() || !form.expected_amount) {
      toast?.("Name and expected amount are required", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        expected_amount: Number(form.expected_amount),
        min_payment: form.min_payment ? Number(form.min_payment) : null,
        cycle_days: form.cycle === "custom" ? Number(form.cycle_days) || 30 : null,
        account_id: form.account_id || null,
      };
      if (editing) {
        await api.updateBill(editing.id, payload);
        toast?.("Bill updated", "success");
      } else {
        await api.createBill(payload);
        toast?.("Bill created", "success");
      }
      onSaved();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setSaving(false); }
  };

  const catList = useMemo(() => {
    const seen = new Set();
    for (const c of (categories || [])) seen.add(c.name);
    ["Bills", "Utilities", "Rent", "Subscriptions", "Insurance", "Loans"].forEach(c => seen.add(c));
    return [...seen];
  }, [categories]);

  return (
    <Sheet open={open} onClose={onClose} title={editing ? "Edit bill" : "Add bill"} theme={theme}>
      <div className="space-y-3">
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Name</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Electric, Netflix, Rent" className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Category</label>
            <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className={inputCls}>
              {catList.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Expected amount</label>
            <input type="number" step="0.01" value={form.expected_amount}
              onChange={e => setForm({ ...form, expected_amount: e.target.value })}
              placeholder="0.00" className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Cycle</label>
            <select value={form.cycle} onChange={e => setForm({ ...form, cycle: e.target.value })} className={inputCls}>
              {BILL_CYCLES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>
              {form.cycle === "custom" ? "Every N days" : "Cycle anchor"}
            </label>
            {form.cycle === "custom" ? (
              <input type="number" min="1" value={form.cycle_days}
                onChange={e => setForm({ ...form, cycle_days: e.target.value })}
                className={inputCls} />
            ) : (
              <input type="date" value={form.cycle_anchor}
                onChange={e => setForm({ ...form, cycle_anchor: e.target.value })}
                className={inputCls} />
            )}
          </div>
        </div>
        {form.cycle === "custom" && (
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Cycle anchor date</label>
            <input type="date" value={form.cycle_anchor}
              onChange={e => setForm({ ...form, cycle_anchor: e.target.value })}
              className={inputCls} />
          </div>
        )}
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Account (optional)</label>
          <select value={form.account_id} onChange={e => setForm({ ...form, account_id: e.target.value })} className={inputCls}>
            <option value="">Any account</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>
            Merchant pattern (for auto-match)
          </label>
          <input value={form.merchant_pattern} onChange={e => setForm({ ...form, merchant_pattern: e.target.value })}
            placeholder="e.g. netflix, con edison" className={inputCls} />
          <p className={`text-[11px] ${theme.textSubtle} mt-1`}>
            Case-insensitive substring match on the transaction merchant. Leave
            blank to keep this bill manual-only.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={`flex items-center gap-2 py-2 rounded-xl border ${theme.border} px-3 text-sm cursor-pointer`}>
            <input type="checkbox" checked={form.autopay}
              onChange={e => setForm({ ...form, autopay: e.target.checked })} />
            Autopay
          </label>
          <div>
            <input value={form.account_hint} onChange={e => setForm({ ...form, account_hint: e.target.value })}
              placeholder="Acct hint (last 4)" className={inputCls} />
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Notes</label>
          <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
            rows={2} className={inputCls} />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Saving…" : editing ? "Save changes" : "Create bill"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function defaultBillForm() {
  const now = new Date();
  return {
    name: "",
    category: "Bills",
    cycle: "monthly",
    cycle_days: 30,
    cycle_anchor: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`,
    expected_amount: "",
    account_id: "",
    autopay: false,
    account_hint: "",
    min_payment: "",
    merchant_pattern: "",
    notes: "",
  };
}

function BudgetsTab({ theme, darkMode, toast }) {
  const { user: authUser } = useAuth();
  // weekStart drives the tracker sheet's "Weekly · Resets every Xday" subtitle.
  const trackerPeriods = useMemo(
    () => getBudgetPeriods(Number(authUser?.week_start) || 0),
    [authUser?.week_start]
  );
  const { budgets, categories, accounts, trackers, budgetSuggestions, refreshAll } = useData();
  const [showAdd, setShowAdd] = useState(false);           // Add/Edit budget sheet
  const [editing, setEditing] = useState(null);            // budget being edited, or null
  const [adding, setAdding] = useState(false);
  const [trackerSheet, setTrackerSheet] = useState(null);  // {kind: 'income'|'credit', ...} or null
  const [savingTracker, setSavingTracker] = useState(false);
  // Reorder is LOCKED by default — user toggles the lock icon to allow drag.
  // Prevents accidental drags while scrolling on mobile.
  const [reorderLocked, setReorderLocked] = useState(true);
  // Per-budget transactions expand state (Feature 1)
  const [expandedId, setExpandedId] = useState(null);
  const [budgetTxns, setBudgetTxns] = useState({}); // { [budgetId]: Transaction[] | "loading" }
  // Budget history (read-only past periods)
  const [history, setHistory] = useState(null);      // [{periodStart, periodEnd, isCurrent, income, budgets:[...]}]
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(null); // null = current; number = index into history
  // Bounds-check historyIndex so a stale index (e.g. after history reloads
  // with fewer entries) can't lock the UI into an empty read-only screen
  // with no way back to the current period.
  const viewingHistory =
    historyIndex !== null
    && Array.isArray(history)
    && historyIndex >= 0
    && historyIndex < history.length
    && !history[historyIndex]?.isCurrent;
  // Ordered LIST OF BUDGET IDS (not budget objects) for Reorder.Group.
  //
  // Why IDs, not objects: Reorder.Group tracks items via reference
  // identity of the `values` array entries. When refreshAll re-fetches
  // /budgets after a delete, EVERY budget object gets a fresh reference
  // even if its contents are identical. Reorder.Group interpreted that
  // as "all items are new" and remounted the entire Reorder.Item
  // subtree, flooding framer-motion's global projection tracker. That
  // corruption is what stuck motion.div's on other tabs at opacity:0
  // after any budget delete — matches CLAUDE.md's documented failure
  // mode but comes from a different mechanism than the empty-values
  // case earlier fixes targeted.
  //
  // Primitive numbers have stable === across renders regardless of
  // source, so the values array only changes when actual reorder /
  // delete happens.
  const [orderedIds, setOrderedIds] = useState(() => budgets.map(b => b.id));
  // Sync from the server whenever the id-SET changes (add or delete),
  // preserving the user's current drag order for surviving items.
  useEffect(() => {
    const serverIds = budgets.map(b => b.id);
    setOrderedIds(prev => {
      const serverSet = new Set(serverIds);
      // Keep prior order for ids that still exist, then append any
      // brand-new ones the server introduced.
      const kept = prev.filter(id => serverSet.has(id));
      const additions = serverIds.filter(id => !prev.includes(id));
      const merged = [...kept, ...additions];
      // Only trigger a re-render if the id sequence actually differs;
      // otherwise we'd churn Reorder.Group's values array for no
      // reason (the whole point of this refactor).
      if (merged.length === prev.length && merged.every((id, i) => id === prev[i])) return prev;
      return merged;
    });
  }, [budgets]);
  const budgetsById = useMemo(
    () => new Map((budgets || []).map(b => [b.id, b])),
    [budgets]
  );
  // Materialised list — used for length checks, empty-state, zero-based
  // summary math, etc. Filter is defensive against a stale id lingering
  // in orderedIds for one render before the sync effect runs.
  const ordered = useMemo(
    () => orderedIds.map(id => budgetsById.get(id)).filter(Boolean),
    [orderedIds, budgetsById]
  );

  // Once Reorder.Group has been mounted with items in this session, keep it
  // mounted for the rest of the session even if the user deletes the last
  // budget. Unmounting a populated Reorder.Group tears down framer-motion's
  // global projection state and freezes motion components on every OTHER
  // tab at opacity:0 — user reported exactly this after deleting the only
  // budget on the current period. Mounting a Reorder.Group with empty
  // values *from the start* has its own corruption pattern (7ceb435,
  // reverted), which is why we still gate the initial mount on
  // ordered.length > 0.
  const hasMountedReorderRef = useRef(false);
  if (ordered.length > 0) hasMountedReorderRef.current = true;
  const keepReorderMounted = hasMountedReorderRef.current;

  const [form, setForm] = useState({
    kind: "category",
    category: "",
    custom: "",
    accountId: "",
    amount: "",
    period: "monthly",
    periodDays: 7,
    periodStart: new Date().toISOString().slice(0, 10),
  });

  const isCustomCat = form.category === "__custom__";
  const isCustomPeriod = form.period === "custom";
  const isCC = form.kind === "creditcard";
  const isEditing = !!editing;

  const allCats = useMemo(() =>
    (categories && categories.length > 0)
      ? categories.map(c => c.name)
      : Object.keys(CAT_COLORS),
    [categories]
  );

  const creditCards = useMemo(() =>
    accounts.filter(a => a.type === "credit"),
    [accounts]
  );

  const resetForm = () => {
    setEditing(null);
    setForm({
      kind: "category", category: "", custom: "", accountId: "",
      amount: "", period: "monthly", periodDays: 7,
      periodStart: new Date().toISOString().slice(0, 10),
    });
  };

  const openEdit = (b) => {
    setEditing(b);
    setForm({
      kind: b.accountId ? "creditcard" : "category",
      category: b.category,
      custom: "",
      accountId: b.accountId ? String(b.accountId) : "",
      amount: String(b.amount),
      period: b.period || "monthly",
      periodDays: b.period_days || 30,
      periodStart: b.period_start
        ? new Date(b.period_start).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
    });
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setAdding(true);
    try {
      const payload = {
        amount: Number(form.amount),
        period: form.period,
        period_start: isCustomPeriod ? form.periodStart : null,
        period_days:  isCustomPeriod ? Number(form.periodDays) : null,
      };
      if (isEditing) {
        await api.updateBudget(editing.id, payload);
        toast?.("Budget updated", "success");
      } else {
        if (isCC) {
          if (!form.accountId) { toast?.("Pick a credit card", "error"); return; }
          const acct = accounts.find(a => String(a.id) === String(form.accountId));
          payload.account_id = Number(form.accountId);
          payload.category = `card:${acct?.name || form.accountId}`;
        } else {
          const finalCat = isCustomCat ? form.custom.trim() : form.category;
          if (!finalCat) { toast?.("Pick a category", "error"); return; }
          payload.category = finalCat;
        }
        await api.createBudget(payload);
        toast?.("Budget created", "success");
      }
      setShowAdd(false);
      resetForm();
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setAdding(false); }
  };

  // Reorder receives the fresh order of IDs (Reorder.Group emits the
  // new `values` array). Optimistic-set locally, persist to server.
  const onReorder = async (nextIds) => {
    setOrderedIds(nextIds);
    try {
      await api.reorderBudgets(nextIds);
    } catch {
      toast?.("Couldn't save order — refreshing", "error");
      refreshAll();
    }
  };

  // Budget delete now goes through a themed ConfirmDialog instead of
  // window.confirm. The native browser confirm blends into the chrome
  // and is easy to miss-click; an in-app modal makes it obvious that a
  // destructive action is about to happen, and lets us spell out
  // exactly what's preserved (history) vs lost (the live budget).
  const [confirmDelete, setConfirmDelete] = useState(null); // budget object or null
  // Holds the timeout scheduled by performDeleteBudget so we can cancel it
  // if BudgetsTab unmounts before it fires. See the fire-site comment for
  // why cancelling matters.
  const refreshTimerRef = useRef(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);
  const [deletingBudget, setDeletingBudget] = useState(false);
  const deleteBudget = (b) => setConfirmDelete(b);
  const performDeleteBudget = async () => {
    if (!confirmDelete) return;
    setDeletingBudget(true);
    const budgetId = confirmDelete.id;
    try {
      await api.deleteBudget(budgetId);
      toast?.("Budget removed", "success");
      // Optimistic local removal — Budgets tab shows N-1 items
      // immediately without waiting for a refetch.
      setOrderedIds(prev => prev.filter(id => id !== budgetId));
      setConfirmDelete(null);
      // Cancel any prior queued refresh (rapid multi-delete).
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      // Schedule the cross-tab data refresh, BUT cancel it if the user
      // leaves Budgets before it fires (cleanup effect below). Rationale:
      // the refresh cascade is 14 setState calls firing over ~500ms.
      // If those land while a destination tab is mid-mount-animation,
      // framer-motion 11.3 sometimes fails to commit its "hidden →
      // visible" variant transition and leaves the motion.div's stuck
      // at opacity:0 — the bug reproduced consistently every previous
      // attempt tried to isolate. Cancelling on unmount trades stale
      // data on other tabs (until the next natural refresh) for a
      // guaranteed stable animation state. F5 fixes the staleness;
      // no fix has fixed the freeze.
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        refreshAll();
      }, 400);
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally {
      setDeletingBudget(false);
    }
  };

  // Feature 1: tap a budget → see contributing transactions.
  // Cache key includes the period so switching to a different history
  // window for the same budget reloads instead of showing stale data.
  const txCacheKey = (b) =>
    `${b.id}__${b.__periodStart || "current"}__${b.__periodEnd || ""}`;
  const toggleExpand = async (b) => {
    const key = txCacheKey(b);
    if (expandedId === b.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(b.id);
    if (budgetTxns[key]) return; // cached for this budget+period
    setBudgetTxns(prev => ({ ...prev, [key]: "loading" }));
    try {
      const params = (b.__periodStart && b.__periodEnd)
        ? { periodStart: b.__periodStart, periodEnd: b.__periodEnd }
        : {};
      const rows = await api.getBudgetTransactions(b.id, params);
      setBudgetTxns(prev => ({ ...prev, [key]: rows }));
    } catch (e) {
      setBudgetTxns(prev => ({ ...prev, [key]: [] }));
      toast?.("Failed to load transactions: " + (e.message || ""), "error");
    }
  };

  // Lazy-load history when the dropdown is opened the first time
  const loadHistory = useCallback(async () => {
    try {
      const rows = await api.getBudgetHistory(12);
      setHistory(rows);
    } catch (e) {
      toast?.("Failed to load history: " + (e.message || ""), "error");
    }
  }, [toast]);

  // When history is selected (past period), derive the budget display rows from it.
  // The cadence label is sourced from the income tracker (master period) so the
  // card's "Weekly / Bi-weekly / Every Nd" subtitle matches what's actually
  // driving the window — not a hard-coded "Monthly" default.
  const historicalBudgets = useMemo(() => {
    if (!viewingHistory || historyIndex === null) return null;
    if (historyIndex < 0 || historyIndex >= (history?.length || 0)) return null;
    const snap = history[historyIndex];
    if (!snap) return null;
    const masterPeriod = trackers?.income?.period || "monthly";
    const masterDays   = trackers?.income?.periodDays || null;
    return snap.budgets.map(b => ({
      id: b.id, category: b.category, amount: b.amount,
      accountId: b.accountId, accountName: b.accountName,
      sortOrder: b.sortOrder, spent: b.spent,
      period: masterPeriod, period_days: masterDays,
      __periodStart: snap.periodStart, __periodEnd: snap.periodEnd, // for tx lookup
    }));
  }, [viewingHistory, historyIndex, history, trackers]);

  // Reset expansion when switching periods so we don't show stale txns
  useEffect(() => { setExpandedId(null); setBudgetTxns({}); }, [historyIndex]);

  const saveTracker = async (e) => {
    e.preventDefault();
    if (!trackerSheet) return;
    setSavingTracker(true);
    try {
      const k = trackerSheet.kind; // 'income' | 'credit'
      const data = {
        [`${k}_period`]: trackerSheet.period,
        [`${k}_period_days`]: trackerSheet.period === "custom" ? Number(trackerSheet.periodDays) : null,
        [`${k}_period_start`]: trackerSheet.period === "custom" ? trackerSheet.periodStart : null,
      };
      await api.updateTrackerSettings(data);
      toast?.("Saved", "success");
      setTrackerSheet(null);
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setSavingTracker(false); }
  };

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-shrink">
          {/* History dropdown */}
          <BudgetHistoryDropdown
            theme={theme} darkMode={darkMode}
            history={history}
            open={historyOpen}
            onOpen={async () => {
              if (!history) await loadHistory();
              setHistoryOpen(true);
            }}
            onClose={() => setHistoryOpen(false)}
            historyIndex={historyIndex}
            onPick={(idx) => { setHistoryIndex(idx); setHistoryOpen(false); }}
          />
          <p className={`text-sm ${theme.textSubtle} min-w-0 truncate`}>
            {viewingHistory ? (
              <span className="font-semibold text-amber-500">
                Viewing past period — read only
              </span>
            ) : (
              <>
                {budgets.length} budget{budgets.length !== 1 ? "s" : ""}
                {budgets.length > 1 && !reorderLocked && (
                  <span className="ml-1.5 text-violet-500 font-medium">· drag to reorder</span>
                )}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Lock / unlock reorder — disabled in history view */}
          {budgets.length > 1 && (
            <motion.button whileTap={{ scale: 0.92 }}
              onClick={() => setReorderLocked(v => !v)}
              disabled={viewingHistory}
              title={viewingHistory ? "Locked — viewing past period"
                    : reorderLocked ? "Unlock to reorder budgets" : "Lock to prevent reordering"}
              className={`p-2 rounded-xl border ${theme.border} disabled:opacity-40 ${
                reorderLocked || viewingHistory
                  ? `${theme.surface} ${theme.textSubtle}`
                  : (darkMode ? "bg-violet-500/15 text-violet-400 border-violet-500/40"
                              : "bg-violet-50 text-violet-600 border-violet-200")
              }`}>
              {(reorderLocked || viewingHistory)
                ? <Lock className="w-4 h-4" />
                : <Unlock className="w-4 h-4" />
              }
            </motion.button>
          )}
          <motion.button whileTap={{ scale: 0.95 }}
            onClick={() => { resetForm(); setShowAdd(true); }}
            disabled={viewingHistory}
            title={viewingHistory ? "Disabled — viewing past period" : ""}
            className="bg-violet-500 hover:bg-violet-600 text-white px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5 shadow-sm shadow-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed">
            <Plus className="w-4 h-4" /> New Budget
          </motion.button>
        </div>
      </div>

      {/* Income tracker — pinned at top, always shown.
          In history view: the displayed total swaps to the snapshot income
          for the period being viewed (the value already returned by
          GET /budgets/history and shown in the dropdown rows), and the
          tap-to-configure action is disabled so the user can't accidentally
          edit their period settings while reviewing the past. The period
          label itself stays as the live master cadence — past income
          snapshots were computed against the user's current cadence, so
          that's still the accurate label for them. */}
      <IncomeTracker
        tracker={viewingHistory && history?.[historyIndex]
          ? { ...trackers?.income, total: history[historyIndex].income }
          : trackers?.income}
        theme={theme} darkMode={darkMode}
        readOnly={viewingHistory}
        onConfigure={() => setTrackerSheet({
          kind: "income",
          period: trackers?.income?.period || "monthly",
          periodDays: trackers?.income?.periodDays || 7,
          // Use the user's STORED anchor (e.g. "every Tuesday from 2026-01-13"),
          // not today. Without this the form would reset to today every open.
          periodStart: trackers?.income?.periodAnchor || new Date().toISOString().slice(0, 10),
        })} />

      {/* Credit tracker — only if credit account(s) exist.
          In history view we don't snapshot credit-card usage (out of scope
          for budget history), so the displayed total stays as current live
          usage. We still lock period editing to match the income tracker's
          read-only behavior in past-period view. */}
      {trackers?.credit && (
        <CreditTracker tracker={trackers.credit} theme={theme} darkMode={darkMode}
          readOnly={viewingHistory}
          onConfigure={() => setTrackerSheet({
            kind: "credit",
            period: trackers.credit.period || "monthly",
            periodDays: trackers.credit.periodDays || 7,
            periodStart: trackers.credit.periodAnchor || new Date().toISOString().slice(0, 10),
          })} />
      )}

      {/* Reorderable budgets — or read-only past period view.
          ─────────────────────────────────────────────────────
          The history view is rendered as a COMPLETELY SEPARATE subtree
          of plain BudgetCards (no Reorder.Group involvement). The
          current-period Reorder.Group below stays mounted with the same
          `values={ordered}` prop the whole time and just gets CSS-hidden
          when the user is in history view.

          Why this matters: every previous structural attempt either
          unmounted Reorder.Group (the original 7acf64a bug — leaves
          orphan projection nodes in framer-motion's global tracker and
          freezes motion components on other tabs at opacity:0), or
          mounted it with empty values, or transitioned its `values`
          from one set of object references to a totally different set
          (current → historical), which framer-motion's projection
          reconciler treats as a mass unmount+remount and corrupts state
          the same way. This structure does none of those things:
          Reorder.Group is invariant — same component, same `values`
          identity, same children — across the whole BudgetsTab session.
          It only unmounts when BudgetsTab itself unmounts on tab
          switch.

          The empty-state card for the CURRENT period (fresh user with
          no budgets) is preserved as the safe original path —
          Reorder.Group is simply not mounted in that case. Mounting
          Reorder.Group with empty values from the start was its own
          source of corruption in commit 7ceb435 (reverted), so we
          keep the established "don't mount when ordered=[]" pattern. */}

      {/* Current period empty state — shown when the user has never had a
          budget in this session. Once Reorder.Group has mounted (keep-
          mounted latch below), the empty state is rendered *inside* that
          block instead so we don't have to tear down and rebuild the
          motion tree when the user deletes their last budget. */}
      {!viewingHistory && ordered.length === 0 && !keepReorderMounted && (
        <div className={`${theme.surface} border-2 border-dashed ${darkMode ? "border-slate-700" : "border-slate-300"} rounded-2xl p-12 text-center`}>
          <PieChartIcon className={`w-12 h-12 ${theme.textSubtle} mx-auto mb-3`} />
          <p className={`${theme.textMuted} mb-4 text-sm`}>
            No budgets yet. Track spending by category or cap credit-card usage.
          </p>
          <motion.button whileTap={{ scale: 0.97 }}
            onClick={() => { resetForm(); setShowAdd(true); }}
            className="bg-violet-500 text-white px-4 py-2 rounded-xl text-sm font-semibold">
            Create your first budget
          </motion.button>
        </div>
      )}

      {/* Current period Reorder.Group. First-mounted only when ordered.length
          becomes > 0; from then on it stays mounted for the session even if
          the user deletes every budget — see hasMountedReorderRef above for
          why. CSS-hidden while viewing history so its framer-motion
          projection state is never disturbed mid-session. The `values`
          prop is permanently `ordered` — history view does NOT rebind it. */}
      {keepReorderMounted && (
        <div className={viewingHistory ? "hidden" : ""}>
          <LayoutGroup id="budgets-reorder">
            <Reorder.Group axis="y"
              values={orderedIds}
              onReorder={onReorder}
              className="space-y-3">
              {orderedIds.map(id => {
                const b = budgetsById.get(id);
                if (!b) return null;
                const lockDrag = reorderLocked;
                return (
                  <Reorder.Item key={id} value={id}
                    dragListener={!lockDrag}
                    whileDrag={{ scale: 1.02, zIndex: 50 }}
                    className={lockDrag ? "" : "cursor-grab active:cursor-grabbing touch-none"}>
                    <BudgetCard b={b} theme={theme} darkMode={darkMode}
                      reorderLocked={lockDrag}
                      readOnly={false}
                      expanded={expandedId === b.id}
                      transactions={budgetTxns[txCacheKey(b)]}
                      onToggleExpand={() => toggleExpand(b)}
                      onEdit={() => openEdit(b)}
                      onDelete={() => deleteBudget(b)} />
                  </Reorder.Item>
                );
              })}
            </Reorder.Group>
          </LayoutGroup>
          {/* Post-delete empty state: Reorder.Group stays mounted (see
              hasMountedReorderRef) but has no children. Show the CTA as a
              sibling inside the same wrapper so the layout matches the
              original empty-state placement without ever unmounting the
              motion tree. */}
          {ordered.length === 0 && !viewingHistory && (
            <div className={`${theme.surface} border-2 border-dashed ${darkMode ? "border-slate-700" : "border-slate-300"} rounded-2xl p-12 text-center`}>
              <PieChartIcon className={`w-12 h-12 ${theme.textSubtle} mx-auto mb-3`} />
              <p className={`${theme.textMuted} mb-4 text-sm`}>
                No budgets yet. Track spending by category or cap credit-card usage.
              </p>
              <motion.button whileTap={{ scale: 0.97 }}
                onClick={() => { resetForm(); setShowAdd(true); }}
                className="bg-violet-500 text-white px-4 py-2 rounded-xl text-sm font-semibold">
                Create your first budget
              </motion.button>
            </div>
          )}
        </div>
      )}

      {/* History view — plain BudgetCards in a regular div, completely
          outside Reorder.Group. With the adeaaa9 dropdown filter, the
          user can't navigate to an empty past period, so historicalBudgets
          is always populated here. Defensive `.length > 0` guard just in
          case some edge case slips through. */}
      {viewingHistory && (historicalBudgets || []).length > 0 && (
        <div className="space-y-3">
          {historicalBudgets.map(b => (
            <BudgetCard key={b.id} b={b} theme={theme} darkMode={darkMode}
              reorderLocked={true}
              readOnly={true}
              expanded={expandedId === b.id}
              transactions={budgetTxns[txCacheKey(b)]}
              onToggleExpand={() => toggleExpand(b)} />
          ))}
        </div>
      )}

      {/* Zero-budget summary — mirrors the income tracker. In history view,
          income comes from the snapshot and allocated is the sum of the
          snapshotted budget caps for that period, so the bar reflects the
          past balance rather than today's. */}
      <ZeroBudgetSummary
        zb={viewingHistory && history?.[historyIndex]
          ? (() => {
              const snap = history[historyIndex];
              const income = Number(snap.income || 0);
              const allocated = (snap.budgets || [])
                .reduce((s, b) => s + Number(b.amount || 0), 0);
              return { income, allocated, remaining: income - allocated };
            })()
          : trackers?.zeroBudget}
        theme={theme} darkMode={darkMode} />

      {/* Tracker period sheet */}
      <Sheet open={!!trackerSheet} onClose={() => setTrackerSheet(null)}
        title={trackerSheet?.kind === "income" ? "Income Tracker" : "Credit Tracker"} theme={theme}>
        {trackerSheet && (
          <form onSubmit={saveTracker} className="space-y-4">
            <p className={`text-xs ${theme.textSubtle}`}>
              {trackerSheet.kind === "income"
                ? "Tracks the sum of positive transactions (income) over the period below."
                : "Tracks the total expenses across all your credit cards over the period below."}
            </p>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Reset every</label>
              <div className="grid grid-cols-2 gap-2">
                {trackerPeriods.map(p => {
                  const active = trackerSheet.period === p.id;
                  return (
                    <button type="button" key={p.id} onClick={() => setTrackerSheet({ ...trackerSheet, period: p.id })}
                      className={`px-3 py-2 rounded-xl text-xs font-semibold text-left border transition ${
                        active
                          ? (darkMode ? "border-violet-500 bg-violet-500/10 text-violet-400" : "border-violet-500 bg-violet-50 text-violet-700")
                          : `${theme.border} ${theme.textMuted}`
                      }`}>
                      <div>{p.label}</div>
                      <div className={`text-[10px] font-normal mt-0.5 ${active ? "" : theme.textSubtle}`}>{p.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
            {trackerSheet.period === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Every N days</label>
                  <input type="number" min="1" step="1" required value={trackerSheet.periodDays}
                    onChange={e => setTrackerSheet({ ...trackerSheet, periodDays: e.target.value })}
                    className={inputCls} />
                </div>
                <div>
                  <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Starting on</label>
                  <input type="date" required value={trackerSheet.periodStart}
                    onChange={e => setTrackerSheet({ ...trackerSheet, periodStart: e.target.value })}
                    className={inputCls} />
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setTrackerSheet(null)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
                Cancel
              </button>
              <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={savingTracker}
                className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {savingTracker ? "Saving…" : "Save"}
              </motion.button>
            </div>
          </form>
        )}
      </Sheet>

      {/* Delete budget confirmation. The name is computed at render time
          off `confirmDelete` so the modal shows the right budget even
          if the underlying budgets array changes mid-confirm. */}
      <ConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={performDeleteBudget}
        theme={theme} darkMode={darkMode}
        busy={deletingBudget}
        title="Delete this budget?"
        message={confirmDelete && (
          confirmDelete.accountId
            ? `"${confirmDelete.accountName || "Credit Card"}" card-usage budget will be removed. Past period history stays intact.`
            : `"${confirmDelete.category}" budget will be removed. Past period history stays intact.`
        )}
        confirmLabel="Delete budget"
      />

      {/* New / Edit budget sheet */}
      <Sheet open={showAdd} onClose={() => { setShowAdd(false); resetForm(); }}
        title={isEditing ? "Edit Budget" : "New Budget"} theme={theme}>
        <form onSubmit={submit} className="space-y-4">
          {/* Kind toggle (locked when editing — kind/category/account can't be changed) */}
          {!isEditing && (
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Type</label>
              <div className={`flex p-1 rounded-xl ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                <button type="button" onClick={() => setForm({ ...form, kind: "category" })}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${
                    !isCC ? (darkMode ? "bg-slate-900 shadow text-violet-400" : "bg-white shadow text-violet-600") : theme.textMuted
                  }`}>
                  Category
                </button>
                <button type="button" onClick={() => setForm({ ...form, kind: "creditcard" })}
                  disabled={creditCards.length === 0}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-40 ${
                    isCC ? (darkMode ? "bg-slate-900 shadow text-rose-400" : "bg-white shadow text-rose-600") : theme.textMuted
                  }`}>
                  Credit Card
                </button>
              </div>
              {isCC && creditCards.length === 0 && (
                <p className={`text-xs ${theme.textSubtle} mt-1.5`}>No credit card accounts yet.</p>
              )}
              {!isCC && (
                <p className={`text-xs ${theme.textSubtle} mt-1.5`}>Credit card transactions are excluded from category budgets.</p>
              )}
            </div>
          )}

          {/* Suggestions chips (Feature 2) — only for new category-based budgets */}
          {!isEditing && !isCC && budgetSuggestions.length > 0 && (
            <SuggestionChips
              suggestions={budgetSuggestions}
              onPick={(c) => setForm({ ...form, category: c, custom: "" })}
              theme={theme} darkMode={darkMode}
            />
          )}

          {/* Target picker — only shown when creating (can't change after) */}
          {isEditing ? (
            <div className={`${theme.surface} border ${theme.border} rounded-xl px-3 py-2.5`}>
              <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
                {editing.accountId ? "Credit card" : "Category"}
              </div>
              <div className="text-sm font-semibold mt-0.5">
                {editing.accountId ? (editing.accountName || "Credit Card") : editing.category}
              </div>
            </div>
          ) : isCC ? (
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Credit card</label>
              <select required value={form.accountId} onChange={e => setForm({ ...form, accountId: e.target.value })} className={inputCls}>
                <option value="">Pick a card…</option>
                {creditCards.map(a => (
                  <option key={a.id} value={a.id}>{a.name}{a.institution ? ` · ${a.institution}` : ""}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Category</label>
              <select required value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className={inputCls}>
                <option value="">Pick category…</option>
                {allCats.map(c => <option key={c} value={c}>{c}</option>)}
                <option value="__custom__">+ Custom…</option>
              </select>
              {isCustomCat && (
                <input value={form.custom} onChange={e => setForm({ ...form, custom: e.target.value })}
                  placeholder="Custom category name" required autoFocus
                  className={`${inputCls} mt-2`} />
              )}
            </div>
          )}

          {/* Amount */}
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Amount</label>
            <input type="number" min="0" step="0.01" required value={form.amount}
              onChange={e => setForm({ ...form, amount: e.target.value })}
              placeholder="0.00" className={inputCls} />
          </div>

          {/* Period info — all budgets now follow the Income tracker's cycle */}
          <div className={`${darkMode ? "bg-violet-500/10" : "bg-violet-50"} rounded-xl px-3 py-2.5 flex items-start gap-2`}>
            <Calendar className="w-4 h-4 text-violet-500 flex-shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="font-semibold text-violet-700 dark:text-violet-400">
                Resets {fmtCadence(trackers?.income?.period, trackers?.income?.periodDays)}
              </div>
              <div className={`${theme.textSubtle} mt-0.5`}>
                All budgets follow the Income tracker schedule. Change the reset
                cadence by tapping the Income card.
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => { setShowAdd(false); resetForm(); }}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
              Cancel
            </button>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={adding}
              className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Saving…" : (isEditing ? "Save changes" : "Create budget")}
            </motion.button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}

// ─── Goals Tab ────────────────────────────────────────────────────────────────
const GOAL_COLORS = ["bg-emerald-500","bg-sky-500","bg-violet-500","bg-amber-500","bg-rose-500"];

function GoalsTab({ theme, darkMode, toast }) {
  const { goals, accounts, refreshAll } = useData();
  // mode: "add" | "withdraw" — direction of the contribution
  const [form, setForm] = useState({ name: "", target: "", saved: "", account_id: "" });
  const [contribFor, setContribFor] = useState(null); // {goal, amount, mode, busy}
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.createGoal({
        name: form.name,
        target: Number(form.target),
        saved: form.account_id ? 0 : Number(form.saved || 0),
        account_id: form.account_id || null,
      });
      setForm({ name: "", target: "", saved: "", account_id: "" });
      refreshAll();
      toast?.("Goal created", "success");
    } catch { toast?.("Failed to create goal", "error"); }
  };

  const contribute = async (e) => {
    e.preventDefault();
    if (!contribFor) return;
    const raw = Number(contribFor.amount);
    if (!Number.isFinite(raw) || raw <= 0) return toast?.("Enter a positive amount", "error");
    const signed = contribFor.mode === "withdraw" ? -raw : raw;
    setContribFor({ ...contribFor, busy: true });
    try {
      await api.contributeGoal(contribFor.goal.id, signed);
      toast?.(
        `${contribFor.mode === "withdraw" ? "Withdrew" : "Added"} ${fmt(raw)} ${contribFor.mode === "withdraw" ? "from" : "to"} ${contribFor.goal.name}`,
        "success"
      );
      setContribFor(null);
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
      setContribFor({ ...contribFor, busy: false });
    }
  };

  const performDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.deleteGoal(toDelete.id);
      toast?.("Goal deleted", "success");
      setToDelete(null);
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className={`${theme.surface} border ${theme.border} rounded-2xl p-4 flex flex-wrap gap-2`}>
        <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="Goal name" required
          className={`flex-1 min-w-40 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
        <input type="number" value={form.target} onChange={e => setForm({ ...form, target: e.target.value })}
          placeholder="Target" required
          className={`w-32 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
        {!form.account_id && (
          <input type="number" value={form.saved} onChange={e => setForm({ ...form, saved: e.target.value })}
            placeholder="Saved"
            className={`w-28 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
        )}
        <select value={form.account_id}
          onChange={e => setForm({ ...form, account_id: e.target.value })}
          title="Link to a bank account (optional). If set, progress auto-updates from the account balance."
          className={`min-w-44 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`}>
          <option value="">Manual (no linked account)</option>
          {accounts.map(a => (
            <option key={a.id} value={a.id}>Linked · {a.name}</option>
          ))}
        </select>
        <motion.button whileTap={{ scale: 0.97 }} type="submit"
          className="bg-violet-500 hover:bg-violet-600 text-white px-4 py-2 rounded-xl text-sm font-semibold">Add</motion.button>
      </form>
      <div className="grid md:grid-cols-2 gap-4">
        {goals.map((g, i) => {
          const saved = Number(g.saved);
          const target = Number(g.target);
          const pct = Math.max(0, Math.min(100, (saved / target) * 100));
          const bg = GOAL_COLORS[i % GOAL_COLORS.length];
          const completed = saved >= target;
          const linked = g.accountId != null;
          return (
            <motion.div key={g.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={`${theme.surface} border ${theme.border} rounded-2xl p-5`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center flex-shrink-0`}>
                    <Target className="w-5 h-5 text-white" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{g.name}</div>
                    {linked && (
                      <div className={`text-[11px] ${theme.textSubtle} flex items-center gap-1 mt-0.5`}>
                        <Link2 className="w-3 h-3" />
                        <span className="truncate private-name" tabIndex={0}>{g.accountName || "Linked account"}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!linked && (
                    <motion.button whileTap={{ scale: 0.92 }}
                      onClick={() => setContribFor({ goal: g, amount: "", mode: "add" })}
                      disabled={completed}
                      title={completed ? "Goal already reached" : "Add money"}
                      className="bg-violet-500 hover:bg-violet-600 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg flex items-center gap-1 disabled:opacity-40">
                      <Plus className="w-3 h-3" /> Add
                    </motion.button>
                  )}
                  {!linked && (
                    <motion.button whileTap={{ scale: 0.92 }}
                      onClick={() => setContribFor({ goal: g, amount: "", mode: "withdraw" })}
                      disabled={saved <= 0}
                      title={saved <= 0 ? "Nothing to withdraw" : "Withdraw money"}
                      className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg flex items-center gap-1 disabled:opacity-40 border ${theme.border} ${theme.hover}`}>
                      <TrendingDown className="w-3 h-3" /> Withdraw
                    </motion.button>
                  )}
                  <button onClick={() => setToDelete(g)} title="Delete goal">
                    <Trash2 className={`w-4 h-4 ${theme.textSubtle} hover:text-rose-500 transition-colors`} />
                  </button>
                </div>
              </div>
              <div className={`flex justify-between text-sm mb-2 ${theme.textMuted}`}>
                <span className="private-amount" tabIndex={0}>{fmt(saved)}</span>
                <span className="font-medium">{fmt(target)}</span>
              </div>
              <ProgressBar value={pct} color={bg} darkMode={darkMode} />
              <div className={`flex items-center justify-between mt-2`}>
                <span className={`text-xs ${theme.textSubtle}`}>
                  {Math.round(pct)}% complete
                  {!completed && saved < target && <span className="ml-1 private-amount" tabIndex={0}>· {fmt(target - saved)} to go</span>}
                </span>
                {g.deadline && (
                  <span className={`text-xs ${theme.textSubtle} flex items-center gap-1`}>
                    <Calendar className="w-3 h-3" /> {new Date(g.deadline).toLocaleDateString()}
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Contribute / Withdraw sheet */}
      <Sheet open={!!contribFor} onClose={() => setContribFor(null)}
        title={contribFor?.mode === "withdraw"
          ? `Withdraw from ${contribFor?.goal?.name || ""}`
          : `Add to ${contribFor?.goal?.name || ""}`}
        theme={theme}>
        {contribFor && (
          <form onSubmit={contribute} className="space-y-4">
            <div className="text-center py-2">
              <div className={`text-xs ${theme.textSubtle}`}>Currently saved</div>
              <div className="text-2xl font-bold mt-1 private-amount" tabIndex={0}>{fmt(contribFor.goal.saved)}</div>
              <div className={`text-xs ${theme.textSubtle} mt-0.5`}>of {fmt(contribFor.goal.target)}</div>
            </div>
            {/* Mode toggle — flip between Add and Withdraw without closing
                the sheet. */}
            <div className={`flex p-1 rounded-xl ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
              {["add", "withdraw"].map(m => (
                <button type="button" key={m}
                  onClick={() => setContribFor({ ...contribFor, mode: m })}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold capitalize transition ${
                    contribFor.mode === m
                      ? (darkMode ? "bg-slate-900 shadow text-violet-400" : "bg-white shadow text-violet-600")
                      : theme.textMuted
                  }`}>
                  {m}
                </button>
              ))}
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>
                {contribFor.mode === "withdraw" ? "Withdraw amount" : "Add amount"}
              </label>
              <input type="number" min="0.01" step="0.01" required autoFocus
                value={contribFor.amount}
                onChange={e => setContribFor({ ...contribFor, amount: e.target.value })}
                placeholder="0.00"
                className={`w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
            </div>
            <div className="flex flex-wrap gap-2">
              {[25, 50, 100, 250, 500].map(amt => (
                <button type="button" key={amt}
                  onClick={() => setContribFor({ ...contribFor, amount: String(amt) })}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${theme.border} ${theme.hover}`}>
                  {contribFor.mode === "withdraw" ? "−" : "+"}{fmt(amt)}
                </button>
              ))}
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setContribFor(null)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
                Cancel
              </button>
              <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={contribFor.busy}
                className={`flex-1 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 ${
                  contribFor.mode === "withdraw"
                    ? "bg-rose-500 hover:bg-rose-600"
                    : "bg-violet-500 hover:bg-violet-600"
                }`}>
                {contribFor.busy
                  ? "Working…"
                  : contribFor.mode === "withdraw" ? "Withdraw" : "Add to goal"}
              </motion.button>
            </div>
          </form>
        )}
      </Sheet>

      <ConfirmDialog
        open={!!toDelete}
        onCancel={() => !deleting && setToDelete(null)}
        onConfirm={performDelete}
        theme={theme} darkMode={darkMode}
        busy={deleting}
        title="Delete this goal?"
        message={toDelete && `"${toDelete.name}" will be removed. ${toDelete.accountId ? "The linked bank account is unaffected." : "Your saved progress will be lost."}`}
        confirmLabel="Delete goal"
      />

      {/* Debts & loans section — sits under Goals per user spec. */}
      <div className="pt-4">
        <LoansSection theme={theme} darkMode={darkMode} toast={toast} />
      </div>
    </div>
  );
}

// ─── Investments Tab ──────────────────────────────────────────────────────────
function InvestmentsTab({ theme, darkMode, toast }) {
  const { holdings, investSummary } = useData();
  const [expanded, setExpanded] = useState(null); // securityId of expanded row
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Total Value"    value={investSummary?.total || 0} icon={Briefcase}  color="sky"     theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Total Gain/Loss" value={investSummary?.gain || 0} icon={TrendingUp}  color="emerald" theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Realized YTD"  value={investSummary?.realizedYTD || 0} icon={DollarSign} color="violet" theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Holdings"       value={holdings.length}           icon={Target}      color="amber"   theme={theme} darkMode={darkMode} format={n => Math.round(n).toString()} onClick={() => {}} />
      </div>
      <div className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
        <div className={`px-5 py-4 border-b ${theme.border} flex items-center justify-between`}>
          <h3 className="font-semibold">Holdings</h3>
          <div className={`text-xs ${theme.textSubtle}`}>Tap a holding to see lots + realized gains.</div>
        </div>
        {holdings.length === 0 ? (
          <div className={`px-5 py-12 text-center text-sm ${theme.textSubtle}`}>
            No holdings — connect a brokerage account via Plaid.
          </div>
        ) : holdings.map((h, i) => {
          // Backend now returns `gain` + `basisKnown` with the per-share
          // vs total cost-basis heuristic already applied, and falls back
          // to manual-lot basis when Plaid didn't report one. Show "—"
          // instead of a misleading number when nothing's known.
          const gain = Number(h.gain) || 0;
          const basisKnown = h.basisKnown !== false;
          const isOpen = expanded === h.securityId;
          return (
            <div key={h.id} className={`${i < holdings.length - 1 ? `border-b ${theme.border}` : ""}`}>
              <button type="button" onClick={() => setExpanded(isOpen ? null : h.securityId)}
                className={`w-full flex items-center justify-between px-5 py-3.5 ${theme.hover} transition-colors text-left`}>
                <div className="flex items-center gap-2">
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""} ${theme.textSubtle}`} />
                  <div>
                    <div className="font-semibold text-sm">{h.ticker || "—"}</div>
                    <div className={`text-xs ${theme.textSubtle}`}>{h.securityName}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-sm private-amount" tabIndex={0}>{fmt(h.value)}</div>
                  {basisKnown ? (
                    <div className={`text-xs private-amount ${gain >= 0 ? "text-emerald-500" : "text-rose-500"}`} tabIndex={0}>
                      {gain >= 0 ? "+" : ""}{fmt(gain)}
                    </div>
                  ) : (
                    <div className={`text-xs ${theme.textSubtle}`} title="Cost basis not reported by your brokerage. Add a manual lot to track gain/loss.">
                      basis —
                    </div>
                  )}
                </div>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className={`border-t ${theme.border} overflow-hidden`}>
                    <LotsPanel securityId={h.securityId} accountId={h.accountId}
                      theme={theme} darkMode={darkMode} toast={toast} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── LotsPanel (per-security cost basis + realized gains) ────────────────────
// Shown when a holding row is expanded. Lists open lots (add / dispose /
// delete) and realized disposals. Wash sales flagged rose. Numbers are
// display-only — no reconciliation with Plaid's cost_basis; the user
// entering their own lots is authoritative.
function LotsPanel({ securityId, accountId, theme, darkMode, toast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [disposing, setDisposing] = useState(null); // lot object
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.getSecurityLots(securityId)); }
    catch (e) { toast?.("Failed to load lots", "error"); }
    finally { setLoading(false); }
  }, [securityId, toast]);
  useEffect(() => { load(); }, [load]);

  const removeLot = async (lot) => {
    if (!window.confirm(`Delete lot from ${lot.acquiredDate}? Any disposals against it will also be removed.`)) return;
    try { await api.deleteLot(lot.id); load(); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };
  const removeDisposal = async (d) => {
    if (!window.confirm("Delete this sale? Shares will return to the source lot.")) return;
    try { await api.deleteDisposal(d.id); load(); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  if (loading || !data) {
    return <div className={`px-5 py-4 text-xs ${theme.textSubtle}`}>Loading…</div>;
  }
  const openLots = data.lots.filter(l => Number(l.remainingQuantity) > 0.00001);
  const closedLots = data.lots.filter(l => Number(l.remainingQuantity) <= 0.00001);
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className={`text-xs ${theme.textSubtle}`}>
          Price: <span className="private-amount" tabIndex={0}>{fmt(data.security.price)}</span>
        </div>
        <button type="button" onClick={() => setShowAdd(true)}
          className="text-xs font-semibold text-violet-500 hover:text-violet-600 flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add lot
        </button>
      </div>

      {/* Open lots table */}
      {openLots.length > 0 ? (
        <div className={`rounded-xl border ${theme.border} overflow-hidden`}>
          <div className={`px-3 py-2 text-[10px] font-semibold ${theme.textSubtle} uppercase tracking-wider ${darkMode ? "bg-slate-800" : "bg-slate-50"}`}>
            Open lots
          </div>
          <div className={`divide-y ${theme.divide}`}>
            {openLots.map(l => {
              // Backend now sets unrealizedKnown=false when either the
              // security has no close_price or the lot has no basis, so
              // we can render "—" instead of showing a spurious loss
              // right after buying (before Plaid reports a fresh price).
              const gain = Number(l.unrealizedGain) || 0;
              const known = l.unrealizedKnown !== false;
              return (
                <div key={l.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{l.acquiredDate}</div>
                    <div className={theme.textSubtle}>
                      <span className="private-amount" tabIndex={0}>{Number(l.remainingQuantity).toFixed(4)}</span> @ <span className="private-amount" tabIndex={0}>{fmt(l.costBasisPerShare)}</span>
                    </div>
                  </div>
                  {known ? (
                    <div className={`text-right ${gain >= 0 ? "text-emerald-500" : "text-rose-500"} font-semibold private-amount`} tabIndex={0}>
                      {gain >= 0 ? "+" : ""}{fmt(gain)}
                    </div>
                  ) : (
                    <div className={`text-right text-xs ${theme.textSubtle}`} title="No fresh price for this security yet.">—</div>
                  )}
                  <button type="button" onClick={() => setDisposing(l)}
                    className="px-2 py-1 rounded-lg text-[10px] font-semibold border border-violet-500 text-violet-500 hover:bg-violet-500/10">
                    Sell
                  </button>
                  <button type="button" onClick={() => removeLot(l)}
                    className="p-1 rounded-lg text-rose-500 hover:bg-rose-500/10" title="Delete lot">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={`text-xs ${theme.textSubtle} text-center py-2`}>
          No open lots. Add one to start tracking cost basis.
        </div>
      )}

      {/* Realized disposals */}
      {data.disposals.length > 0 && (
        <div className={`rounded-xl border ${theme.border} overflow-hidden`}>
          <div className={`px-3 py-2 text-[10px] font-semibold ${theme.textSubtle} uppercase tracking-wider ${darkMode ? "bg-slate-800" : "bg-slate-50"}`}>
            Realized sales
          </div>
          <div className={`divide-y ${theme.divide}`}>
            {data.disposals.map(d => (
              <div key={d.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{d.disposalDate}</div>
                  <div className={theme.textSubtle}>
                    <span className="private-amount" tabIndex={0}>{Number(d.quantity).toFixed(4)}</span> @ <span className="private-amount" tabIndex={0}>{fmt(d.pricePerShare)}</span>
                    {d.washSale ? (
                      <span className="ml-2 text-rose-500 font-semibold" title={
                        Number(d.disallowedLoss) > 0
                          ? `${fmt(d.disallowedLoss)} of loss disallowed by matching purchase in ±30 day window`
                          : "Matching purchase within ±30 days — some or all of this loss is disallowed"
                      }>
                        WASH SALE{Number(d.disallowedLoss) > 0 ? ` · ${fmt(d.disallowedLoss)}` : ""}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className={`text-right font-semibold ${Number(d.realizedGain) >= 0 ? "text-emerald-500" : "text-rose-500"} private-amount`} tabIndex={0}>
                  {Number(d.realizedGain) >= 0 ? "+" : ""}{fmt(d.realizedGain)}
                </div>
                <button type="button" onClick={() => removeDisposal(d)}
                  className="p-1 rounded-lg text-rose-500 hover:bg-rose-500/10" title="Undo sale">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <LotFormSheet open={showAdd} onClose={() => setShowAdd(false)} securityId={securityId}
        accountId={accountId} theme={theme} darkMode={darkMode} toast={toast}
        onSaved={() => { setShowAdd(false); load(); }} />
      <DisposeFormSheet open={!!disposing} onClose={() => setDisposing(null)} lot={disposing}
        currentPrice={data.security.price}
        theme={theme} darkMode={darkMode} toast={toast}
        onSaved={() => { setDisposing(null); load(); }} />
    </div>
  );
}

function LotFormSheet({ open, onClose, securityId, accountId, theme, darkMode, toast, onSaved }) {
  const [form, setForm] = useState({ acquired_date: new Date().toISOString().slice(0, 10),
    quantity: "", cost_basis_per_share: "", notes: "", reinvest: false });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setForm({ acquired_date: new Date().toISOString().slice(0, 10),
      quantity: "", cost_basis_per_share: "", notes: "", reinvest: false });
  }, [open]);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  const save = async () => {
    if (!(Number(form.quantity) > 0) || !(Number(form.cost_basis_per_share) >= 0)) {
      toast?.("Quantity and cost basis are required", "error"); return;
    }
    if (form.reinvest && !accountId) {
      toast?.("Reinvest requires the brokerage account so the dividend txn can be recorded", "error"); return;
    }
    setSaving(true);
    try {
      await api.addLot(securityId, {
        acquired_date: form.acquired_date,
        quantity: Number(form.quantity),
        cost_basis_per_share: Number(form.cost_basis_per_share),
        account_id: accountId || null,
        notes: form.notes || null,
        reinvest: !!form.reinvest,
      });
      toast?.(form.reinvest ? "Reinvested dividend + lot recorded" : "Lot added", "success");
      onSaved();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add lot" theme={theme}>
      <div className="space-y-3">
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Acquired date</label>
          <input type="date" value={form.acquired_date}
            onChange={e => setForm({ ...form, acquired_date: e.target.value })} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Quantity</label>
            <input type="number" step="0.0001" value={form.quantity}
              onChange={e => setForm({ ...form, quantity: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Cost / share</label>
            <input type="number" step="0.0001" value={form.cost_basis_per_share}
              onChange={e => setForm({ ...form, cost_basis_per_share: e.target.value })} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Notes</label>
          <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
            placeholder="e.g. 401k rollover" className={inputCls} />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={!!form.reinvest}
            onChange={e => setForm({ ...form, reinvest: e.target.checked })}
            className="w-4 h-4 accent-violet-500 mt-0.5" />
          <div className="flex-1">
            <div>Reinvested dividend / distribution</div>
            <div className={`text-[10px] ${theme.textSubtle}`}>
              Also records an <em>Interest &amp; Dividends</em> income transaction on this account (quantity × price) so the money lands on Schedule B automatically.
            </div>
          </div>
        </label>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>Cancel</button>
          <button type="button" onClick={save} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
            {saving ? "Saving…" : form.reinvest ? "Record reinvest" : "Add lot"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function DisposeFormSheet({ open, onClose, lot, currentPrice, theme, darkMode, toast, onSaved }) {
  const [form, setForm] = useState({ disposal_date: new Date().toISOString().slice(0, 10),
    quantity: "", price_per_share: "", notes: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open && lot) setForm({
      disposal_date: new Date().toISOString().slice(0, 10),
      quantity: String(lot.remainingQuantity || ""),
      price_per_share: String(currentPrice || ""),
      notes: "",
    });
  }, [open, lot, currentPrice]);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  const save = async () => {
    if (!lot) return;
    const q = Number(form.quantity); const px = Number(form.price_per_share);
    if (!(q > 0) || !(px >= 0)) {
      toast?.("Quantity and price required", "error"); return;
    }
    if (q > Number(lot.remainingQuantity) + 1e-8) {
      toast?.(`Only ${Number(lot.remainingQuantity).toFixed(4)} shares remain in that lot`, "error"); return;
    }
    setSaving(true);
    try {
      const r = await api.addDisposal({
        lot_id: lot.id, disposal_date: form.disposal_date,
        quantity: q, price_per_share: px,
        notes: form.notes || null,
      });
      if (r.isWashSale) toast?.("Sale recorded — wash sale flagged", "warning");
      else toast?.(`Realized ${r.realizedGain >= 0 ? "+" : ""}${fmt(r.realizedGain)}`, "success");
      onSaved();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setSaving(false); }
  };
  const preview = lot && Number(form.quantity) > 0 && Number(form.price_per_share) >= 0
    ? (Number(form.price_per_share) - Number(lot.costBasisPerShare)) * Number(form.quantity)
    : 0;
  return (
    <Sheet open={open} onClose={onClose} title={lot ? `Sell lot from ${lot.acquiredDate}` : "Sell lot"} theme={theme}>
      {lot && (
        <div className="space-y-3">
          <div className={`rounded-xl border ${theme.border} p-3 text-xs ${theme.textSubtle}`}>
            Remaining: <span className="private-amount" tabIndex={0}>{Number(lot.remainingQuantity).toFixed(4)}</span> shares · Cost: <span className="private-amount" tabIndex={0}>{fmt(lot.costBasisPerShare)}</span>/share
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Sale date</label>
            <input type="date" value={form.disposal_date}
              onChange={e => setForm({ ...form, disposal_date: e.target.value })} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Quantity</label>
              <input type="number" step="0.0001" value={form.quantity}
                onChange={e => setForm({ ...form, quantity: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Price / share</label>
              <input type="number" step="0.0001" value={form.price_per_share}
                onChange={e => setForm({ ...form, price_per_share: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div className={`rounded-xl border ${theme.border} p-3 text-xs`}>
            <span className={theme.textSubtle}>Realized gain: </span>
            <span className={`font-semibold private-amount ${preview >= 0 ? "text-emerald-500" : "text-rose-500"}`} tabIndex={0}>
              {preview >= 0 ? "+" : ""}{fmt(preview)}
            </span>
          </div>
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Notes</label>
            <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
              className={inputCls} />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.textSubtle}`}>Cancel</button>
            <button type="button" onClick={save} disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-60">
              {saving ? "Recording…" : "Record sale"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ─── Notes Tab ────────────────────────────────────────────────────────────────
const NOTE_LIGHT = { amber:"bg-amber-50 border-amber-200", sky:"bg-sky-50 border-sky-200", emerald:"bg-emerald-50 border-emerald-200", violet:"bg-violet-50 border-violet-200", rose:"bg-rose-50 border-rose-200" };
const NOTE_DARK  = { amber:"bg-amber-500/10 border-amber-500/30", sky:"bg-sky-500/10 border-sky-500/30", emerald:"bg-emerald-500/10 border-emerald-500/30", violet:"bg-violet-500/10 border-violet-500/30", rose:"bg-rose-500/10 border-rose-500/30" };
const NOTE_DOT   = { amber:"bg-amber-400", sky:"bg-sky-400", emerald:"bg-emerald-400", violet:"bg-violet-400", rose:"bg-rose-400" };

function NotesTab({ theme, darkMode, toast }) {
  const { notes, refreshAll } = useData();
  const [form, setForm] = useState({ title: "", content: "" });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.createNote(form); setForm({ title: "", content: "" }); refreshAll();
      toast?.("Note saved", "success");
    } catch { toast?.("Failed to save note", "error"); }
  };
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className={`${theme.surface} border ${theme.border} rounded-2xl p-4 space-y-2`}>
        <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
          placeholder="Title"
          className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
        <textarea value={form.content} onChange={e => setForm({ ...form, content: e.target.value })}
          placeholder="Content" rows={3}
          className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500 resize-none`} />
        <motion.button whileTap={{ scale: 0.97 }} type="submit"
          className="bg-violet-500 hover:bg-violet-600 text-white px-4 py-2 rounded-xl text-sm font-semibold">Save note</motion.button>
      </form>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {notes.map(n => {
          const key = n.color || "amber";
          const bg = darkMode ? NOTE_DARK[key] || NOTE_DARK.amber : NOTE_LIGHT[key] || NOTE_LIGHT.amber;
          const dot = NOTE_DOT[key] || NOTE_DOT.amber;
          return (
            <motion.div key={n.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={`rounded-2xl border p-4 ${bg}`}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`w-3 h-3 rounded-full flex-shrink-0 ${dot}`} />
                  {n.pinned && <Pin className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />}
                </div>
                <button onClick={async () => { await api.deleteNote(n.id); refreshAll(); toast?.("Note deleted"); }}>
                  <X className={`w-4 h-4 ${theme.textSubtle} hover:text-rose-500 transition-colors`} />
                </button>
              </div>
              {n.title && <div className="font-semibold text-sm mb-1">{n.title}</div>}
              <div className={`text-sm ${theme.textMuted} whitespace-pre-wrap line-clamp-4`}>{n.content}</div>
              {n.date && <div className={`text-xs ${theme.textSubtle} mt-2`}>{new Date(n.date).toLocaleDateString()}</div>}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Automations Panel ───────────────────────────────────────────────────────
// Per-user rule engine. Two subpages:
//   Rules  → list of automations (drag reorder, enable toggle, edit, delete)
//   History → private log of what fired (30-day retention; errors sticky
//             until acknowledged)
// Editing (create / update / delete rules) is DESKTOP-ONLY per user spec —
// mobile shows a hint but can still toggle rules on/off and view history.
// Actions vocabulary is empty in the foundation stage; the rule builder's
// Actions picker shows a helpful "will fill in over the next stages" note
// instead of an empty dropdown so nothing looks broken.
const TRIGGER_LABELS = {
  transaction_arrived: "When a transaction lands",
  income_landed:       "When income lands (positive amount)",
  period_rolled_over:  "When a budget period rolls over",
  daily_check:         "Once a day (8 AM)",
  balance_changed:     "When an account balance changes",
};
const OP_LABELS = {
  eq: "equals", neq: "does not equal",
  contains: "contains",
  gt: ">", gte: "≥", lt: "<", lte: "≤",
  in: "is one of",
};
const FIELD_LABELS = {
  merchant: "Merchant", category: "Category",
  amount: "Amount (signed)", absAmount: "Amount (absolute)",
  accountId: "Account", accountType: "Account type",
  pending: "Pending", isTransfer: "Is transfer",
  weekday: "Weekday (0=Sun)",
};

function AutomationsPanel({ theme, darkMode, toast }) {
  const { budgets, categories, accounts, goals } = useData();
  const [subpage, setSubpage] = useState("rules");
  const [rules, setRules] = useState([]);
  const [history, setHistory] = useState([]);
  const [vocab, setVocab] = useState(null);
  const [editing, setEditing] = useState(null);  // rule object or "new" sentinel
  const [confirmDel, setConfirmDel] = useState(null);
  const [desktop, setDesktop] = useState(true);

  // Category picker vocabulary — same fold used elsewhere: real
  // categories table first, custom budget categories folded in,
  // built-in fallback last. Passed through to the action builder so
  // set_category and split_txn dropdowns show every category the
  // user could pick anywhere else in the app.
  const catList = (() => {
    const seen = new Set(), out = [];
    const push = (n) => {
      const t = String(n || "").trim();
      if (!t || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase()); out.push(t);
    };
    if (categories?.length) for (const c of categories) push(c.name);
    else for (const c of Object.keys(CAT_COLORS)) push(c);
    for (const b of budgets || []) { if (!b.accountId) push(b.category); }
    return out;
  })();

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const set = () => setDesktop(mq.matches);
    set(); mq.addEventListener?.("change", set);
    return () => mq.removeEventListener?.("change", set);
  }, []);

  const load = useCallback(async () => {
    try {
      const [r, h, v] = await Promise.all([
        api.listAutomations(),
        api.getAutomationHistory(),
        api.getAutomationVocab(),
      ]);
      setRules(r); setHistory(h); setVocab(v);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const unresolvedErrors = history.filter(h => h.status === "error" && !h.acknowledged).length;

  const saveRule = async (rule) => {
    try {
      if (rule.id) {
        await api.updateAutomation(rule.id, rule);
        toast?.("Rule updated", "success");
      } else {
        await api.createAutomation(rule);
        toast?.("Rule created", "success");
      }
      setEditing(null);
      load();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    }
  };

  const toggleEnabled = async (r) => {
    try {
      await api.updateAutomation(r.id, { enabled: !r.enabled });
      setRules(rows => rows.map(x => x.id === r.id ? { ...x, enabled: !r.enabled } : x));
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const performDel = async () => {
    if (!confirmDel) return;
    try {
      await api.deleteAutomation(confirmDel.id);
      toast?.("Rule deleted", "success");
      setConfirmDel(null);
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const ackAll = async () => {
    try {
      await api.acknowledgeAllAutomationErrors();
      toast?.("All errors acknowledged", "success");
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  // Sort rules by:
  //   1. TRIGGER_PRIORITY (transaction_arrived first, period_rolled_over last)
  //   2. Priority of the rule's FIRST action (detection → mutation → alerts
  //      → money movement → housekeeping) — see ACTION_PRIORITY
  //   3. Rule name alphabetical for stable tie-breaking
  // Rules with no actions fall to the bottom of their trigger group so
  // the user notices and either adds actions or deletes them.
  const applyRecommendedOrder = async () => {
    const sorted = [...rules].sort((a, b) => {
      const trigA = TRIGGER_PRIORITY[a.triggerType] ?? 999;
      const trigB = TRIGGER_PRIORITY[b.triggerType] ?? 999;
      if (trigA !== trigB) return trigA - trigB;
      const actA = a.actions?.[0]?.kind
        ? (ACTION_PRIORITY[a.actions[0].kind] ?? 500)
        : 999;
      const actB = b.actions?.[0]?.kind
        ? (ACTION_PRIORITY[b.actions[0].kind] ?? 500)
        : 999;
      if (actA !== actB) return actA - actB;
      return String(a.name).localeCompare(String(b.name));
    });
    // Bail if nothing would change — user hits the button, gets a toast,
    // moves on. No API call.
    const same = sorted.every((r, i) => r.id === rules[i].id);
    if (same) {
      toast?.("Rules are already in the recommended order", "success");
      return;
    }
    try {
      await api.reorderAutomations(sorted.map(r => r.id));
      toast?.("Rules re-sorted by recommended order", "success");
      load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  return (
    <div className="space-y-4">
      {/* Subpage pill */}
      <div className={`flex p-1 rounded-xl ${darkMode ? "bg-slate-800" : "bg-slate-100"} w-fit`}>
        {[
          { id: "rules",   label: "Rules" },
          { id: "history", label: `History${unresolvedErrors ? ` · ${unresolvedErrors}!` : ""}` },
        ].map(o => (
          <button key={o.id}
            onClick={() => setSubpage(o.id)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition ${
              subpage === o.id
                ? (darkMode ? "bg-slate-900 shadow text-violet-400" : "bg-white shadow text-violet-600")
                : theme.textMuted
            }`}>
            {o.label}
          </button>
        ))}
      </div>

      {subpage === "rules" ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className={`text-sm ${theme.textSubtle}`}>
              {rules.length} rule{rules.length !== 1 ? "s" : ""}
              {!desktop && rules.length === 0 && (
                <span className="ml-1">· open Coinvane on desktop to author rules</span>
              )}
            </p>
            {desktop && (
              <div className="flex items-center gap-2">
                {rules.length > 1 && (
                  <button type="button"
                    onClick={applyRecommendedOrder}
                    title="Sort rules by recommended execution order (detection → mutation → alerts → money movement → housekeeping)"
                    className={`text-xs font-semibold px-3 py-2 rounded-xl border ${theme.border} ${theme.surface} ${theme.hover} flex items-center gap-1.5`}>
                    <Sparkles className="w-3.5 h-3.5" />
                    Recommended order
                  </button>
                )}
                <motion.button whileTap={{ scale: 0.95 }}
                  onClick={() => setEditing("new")}
                  className="bg-violet-500 hover:bg-violet-600 text-white px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5 shadow-sm shadow-violet-500/30">
                  <Plus className="w-4 h-4" /> New Rule
                </motion.button>
              </div>
            )}
          </div>
          {rules.length === 0 ? (
            <div className={`${theme.surface} border-2 border-dashed ${darkMode ? "border-slate-700" : "border-slate-300"} rounded-2xl p-10 text-center`}>
              <Sparkles className={`w-10 h-10 ${theme.textSubtle} mx-auto mb-3`} />
              <p className={`${theme.textMuted} mb-1 text-sm`}>No automations yet.</p>
              <p className={`${theme.textSubtle} text-xs max-w-sm mx-auto`}>
                Set rules to auto-tag transfers, sweep round-ups into goals,
                roll over unused budget, alert on low balance, and more.
              </p>
            </div>
          ) : (
            <div className={`${theme.surface} rounded-2xl border ${theme.border} divide-y ${theme.divide}`}>
              {rules.map(r => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => toggleEnabled(r)}
                    title={r.enabled ? "Disable rule" : "Enable rule"}
                    className={`w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 ${
                      r.enabled ? "bg-violet-500 justify-end" : (darkMode ? "bg-slate-700 justify-start" : "bg-slate-300 justify-start")
                    }`}>
                    <span className="w-4 h-4 rounded-full bg-white mx-0.5" />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{r.name}</div>
                    <div className={`text-xs ${theme.textSubtle} truncate`}>
                      {TRIGGER_LABELS[r.triggerType] || r.triggerType}
                      {r.conditions?.length > 0 && ` · ${r.conditions.length} condition${r.conditions.length !== 1 ? "s" : ""}`}
                      {r.actions?.length > 0 && ` · ${r.actions.length} action${r.actions.length !== 1 ? "s" : ""}`}
                    </div>
                  </div>
                  {desktop && (
                    <>
                      <button onClick={() => setEditing(r)}
                        title="Edit rule"
                        className={`p-1.5 rounded-lg ${theme.hover} ${theme.textSubtle}`}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => setConfirmDel(r)}
                        title="Delete rule"
                        className={`p-1.5 rounded-lg ${theme.hover} text-rose-500`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className={`text-sm ${theme.textSubtle}`}>
              Last {history.length} {history.length === 1 ? "fire" : "fires"} · 30-day retention
            </p>
            {unresolvedErrors > 0 && (
              <button onClick={ackAll}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg border ${theme.border} ${theme.surface} text-rose-500 hover:bg-rose-500/10`}>
                Acknowledge {unresolvedErrors} error{unresolvedErrors !== 1 ? "s" : ""}
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <div className={`${theme.surface} rounded-2xl border ${theme.border} px-5 py-12 text-center text-sm ${theme.textSubtle}`}>
              No automations have fired yet.
            </div>
          ) : (
            <div className={`${theme.surface} rounded-2xl border ${theme.border} divide-y ${theme.divide}`}>
              {history.map(h => {
                const isErr = h.status === "error";
                const statusColor = h.status === "success"
                  ? "text-emerald-500"
                  : isErr ? "text-rose-500" : theme.textSubtle;
                const isUnack = isErr && !h.acknowledged;
                return (
                  <div key={h.id} className={`flex items-start gap-3 px-4 py-2.5 ${isUnack ? (darkMode ? "bg-rose-500/5" : "bg-rose-50/40") : ""}`}>
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                      h.status === "success" ? "bg-emerald-500" : isErr ? "bg-rose-500" : "bg-slate-400"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{h.ruleName || "(deleted rule)"}</span>
                        <span className={`text-[10px] font-semibold uppercase tracking-wider ${statusColor}`}>
                          {h.status}
                        </span>
                      </div>
                      <div className={`text-xs ${theme.textSubtle}`}>{h.summary || "—"}</div>
                      {h.errorMessage && (
                        <div className="text-xs text-rose-500 mt-0.5 break-words">{h.errorMessage}</div>
                      )}
                      <div className={`text-[10px] ${theme.textSubtle} mt-0.5`}>
                        {new Date(h.firedAt).toLocaleString()}
                      </div>
                    </div>
                    {isUnack && (
                      <button
                        onClick={async () => {
                          try {
                            await api.acknowledgeAutomationHistory(h.id);
                            load();
                          } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                        }}
                        className={`text-[11px] font-semibold px-2.5 py-1 rounded-md border ${theme.border} ${theme.hover} flex-shrink-0`}>
                        Acknowledge
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <RuleBuilderSheet
        open={!!editing}
        onClose={() => setEditing(null)}
        rule={editing === "new" ? null : editing}
        vocab={vocab}
        catList={catList}
        accounts={accounts}
        budgets={budgets}
        goals={goals}
        theme={theme} darkMode={darkMode}
        onSave={saveRule}
      />
      <ConfirmDialog
        open={!!confirmDel}
        onCancel={() => setConfirmDel(null)}
        onConfirm={performDel}
        theme={theme} darkMode={darkMode}
        title="Delete this rule?"
        message={confirmDel ? `"${confirmDel.name}" will stop firing immediately. History entries stay.` : ""}
      />
    </div>
  );
}

// Action metadata — the frontend owns per-action label + param schema so
// server /vocab just publishes the list of KINDS. New stages add entries
// here alongside the backend action handler. Keep alphabetized by kind
// so the picker order stays stable.
// Per-action metadata. `preferredTrigger` is a hint for the UI — when a
// user picks an action, we nudge them if their current trigger doesn't
// match what the action is designed for (e.g. daily-only actions on a
// transaction_arrived trigger will never fire meaningfully).
const ACTION_META = {
  add_note: {
    label: "Add note",
    description: "Attach a note to matching transactions.",
    defaults: () => ({ note: "", mode: "overwrite" }),
    preferredTrigger: "transaction_arrived",
  },
  apply_paystub_template: {
    label: "Apply paystub template",
    description: "Copy the most recent paystub blob from this merchant, scaling amounts to the new net.",
    defaults: () => ({}),
    preferredTrigger: "income_landed",
  },
  archive_completed_goals: {
    label: "Archive completed goals",
    description: "Hide goals from the main list once they've been at 100% for a while.",
    defaults: () => ({ afterDays: 30 }),
    preferredTrigger: "daily_check",
  },
  burn_rate_alarm: {
    label: "Alert on budget burn rate",
    description: "Notify when a budget is being spent faster than the period is elapsing.",
    defaults: () => ({ budgetId: "", warnPct: 80, timeElapsedThresholdPct: 50 }),
    preferredTrigger: "daily_check",
  },
  cleanup_old_notifications: {
    label: "Clean up old notifications",
    description: "Delete READ notifications older than N days (never touches unread ones).",
    defaults: () => ({ afterDays: 30 }),
    preferredTrigger: "daily_check",
  },
  contribute_to_goal_pct: {
    label: "Contribute % of income to a goal",
    description: "Push a percentage of every incoming paycheck into a savings goal.",
    defaults: () => ({ goalId: "", pct: 10 }),
    preferredTrigger: "income_landed",
  },
  flag_duplicate: {
    label: "Flag possible duplicate",
    description: "Drop an in-app notification if another same-amount txn is nearby in time.",
    defaults: () => ({ withinDays: 0 }),
    preferredTrigger: "transaction_arrived",
  },
  mark_as_transfer: {
    label: "Mark as transfer",
    description: "Flag the row so it's excluded from income + budget totals.",
    defaults: () => ({}),
    preferredTrigger: "transaction_arrived",
  },
  monthly_summary_notification: {
    label: "Monthly summary notification",
    description: "At period boundaries that cross a calendar month, drop a summary of income / spent / delta.",
    defaults: () => ({}),
    preferredTrigger: "period_rolled_over",
  },
  move_budget_slack: {
    label: "Move budget slack",
    description: "Shift unused budget from one category into another that's over.",
    defaults: () => ({
      sourceBudgetId: "", targetBudgetId: "",
      amount: 50, sourceMaxUsedPct: 40, requireTargetOver: true,
    }),
    preferredTrigger: "daily_check",
  },
  notify_cc_utilization: {
    label: "Alert on credit-card utilization",
    description: "Notify when a card's balance is above a % of its limit.",
    defaults: () => ({ accountId: "", thresholdPct: 30 }),
    preferredTrigger: "daily_check",
  },
  notify_low_balance: {
    label: "Alert on low account balance",
    description: "Notify when an account drops below a dollar threshold.",
    defaults: () => ({ accountId: "", threshold: 100 }),
    preferredTrigger: "daily_check",
  },
  notify_scheduled_miss: {
    label: "Alert on missed scheduled item",
    description: "Notify when a scheduled paycheck / bill hasn't arrived by its expected date.",
    defaults: () => ({ graceDays: 2 }),
    preferredTrigger: "daily_check",
  },
  notify_unusually_large_txn: {
    label: "Alert on unusually large transaction",
    description: "Notify when a txn is N× your median for that merchant.",
    defaults: () => ({ multiplier: 3, lookbackDays: 90 }),
    preferredTrigger: "transaction_arrived",
  },
  propose_recurring_schedule: {
    label: "Propose a scheduled row for recurring transactions",
    description: "After N consecutive similar amounts from the same merchant, suggest setting up a scheduled row.",
    defaults: () => ({ N: 3, tolerance: 5 }),
    preferredTrigger: "transaction_arrived",
  },
  rollover_unused_budget: {
    label: "Roll over unused budget",
    description: "When a period ends, carry leftover budget into the next period (capped optional).",
    defaults: () => ({ budgetId: "", maxRollover: "" }),
    preferredTrigger: "period_rolled_over",
  },
  round_up_to_goal: {
    label: "Round-up to a goal",
    description: "Round every expense up to the nearest dollar (or roundTo) and send the change to a goal.",
    defaults: () => ({ goalId: "", roundTo: 1 }),
    preferredTrigger: "transaction_arrived",
  },
  seasonal_bump: {
    label: "Seasonal budget bump",
    description: "When a specific month starts, add extra to a budget for that period.",
    defaults: () => ({ budgetId: "", monthNumber: 12, bumpAmount: 100 }),
    preferredTrigger: "period_rolled_over",
  },
  set_category: {
    label: "Set category",
    description: "Override the category on matching rows. Fires AFTER merchant rules.",
    defaults: () => ({ category: "" }),
    preferredTrigger: "transaction_arrived",
  },
  split_txn: {
    label: "Split into pieces",
    description: "Reduce the original amount and create child rows for each split.",
    defaults: () => ({ splits: [{ category: "", amount: "", note: "" }] }),
    preferredTrigger: "transaction_arrived",
  },
  sweep_excess_income: {
    label: "Sweep excess income to a goal",
    description: "At period end, send (income − budgeted) to a goal, up to an optional cap.",
    defaults: () => ({ goalId: "", maxSweep: "" }),
    preferredTrigger: "period_rolled_over",
  },
  sweep_to_goal: {
    label: "Sweep fixed $ from paycheck",
    description: "Send a fixed dollar amount to a goal after every income transaction.",
    defaults: () => ({ goalId: "", amount: 100 }),
    preferredTrigger: "income_landed",
  },
};

// Rule builder — trigger picker + conditions + actions.
function RuleBuilderSheet({ open, onClose, rule, vocab, catList = [], accounts = [], budgets = [], goals = [], theme, darkMode, onSave }) {
  const emptyRule = () => ({
    name: "",
    triggerType: "transaction_arrived",
    conditions: [],
    actions: [],
    enabled: true,
  });
  const [form, setForm] = useState(emptyRule);
  useEffect(() => { if (open) setForm(rule ? { ...rule } : emptyRule()); }, [open, rule?.id]);

  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  const smallCls = `px-2 py-1.5 ${theme.inputBg} border ${theme.border} rounded-lg text-xs focus:outline-none focus:border-violet-500`;

  const addCondition = () => setForm(f => ({
    ...f, conditions: [...(f.conditions || []), { field: "merchant", op: "contains", value: "" }],
  }));
  const patchCondition = (i, patch) => setForm(f => ({
    ...f, conditions: f.conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c),
  }));
  const removeCondition = (i) => setForm(f => ({
    ...f, conditions: f.conditions.filter((_, idx) => idx !== i),
  }));

  // Actions — same add/patch/remove pattern. Each action is
  // { kind, params: {...} } where params matches ACTION_META[kind].defaults()
  // shape.
  const addAction = (kind) => setForm(f => ({
    ...f, actions: [
      ...(f.actions || []),
      { kind, params: (ACTION_META[kind]?.defaults || (() => ({})))() },
    ],
  }));
  const patchAction = (i, patch) => setForm(f => ({
    ...f, actions: f.actions.map((a, idx) => idx === i ? { ...a, ...patch } : a),
  }));
  const patchActionParams = (i, patchP) => setForm(f => ({
    ...f, actions: f.actions.map((a, idx) =>
      idx === i ? { ...a, params: { ...(a.params || {}), ...patchP } } : a),
  }));
  const removeAction = (i) => setForm(f => ({
    ...f, actions: f.actions.filter((_, idx) => idx !== i),
  }));

  const availableActions = (vocab?.actions || []);

  const submit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave({ ...form, name: form.name.trim() });
  };

  return (
    <Sheet open={open} onClose={onClose}
      title={rule?.id ? "Edit rule" : "New rule"} theme={theme}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Name</label>
          <input required value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Rule name"
            className={inputCls} />
        </div>
        <div>
          <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Trigger</label>
          <select value={form.triggerType}
            onChange={e => setForm({ ...form, triggerType: e.target.value })}
            className={inputCls}>
            {(vocab?.triggers || []).map(t =>
              <option key={t} value={t}>{TRIGGER_LABELS[t] || t}</option>
            )}
          </select>
        </div>

        {/* Conditions */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>Conditions</label>
            <button type="button" onClick={addCondition}
              className="text-[11px] font-semibold text-violet-500 flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add condition
            </button>
          </div>
          {form.conditions?.length === 0 ? (
            <p className={`text-xs ${theme.textSubtle}`}>
              No conditions — rule fires on every event of this trigger.
            </p>
          ) : (
            <div className="space-y-1.5">
              {form.conditions.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_100px_1fr_28px] gap-1.5 items-center">
                  <select value={c.field}
                    onChange={e => patchCondition(i, { field: e.target.value })}
                    className={smallCls}>
                    {(vocab?.fields || []).map(f =>
                      <option key={f} value={f}>{FIELD_LABELS[f] || f}</option>
                    )}
                  </select>
                  <select value={c.op}
                    onChange={e => patchCondition(i, { op: e.target.value })}
                    className={smallCls}>
                    {(vocab?.ops || []).map(o =>
                      <option key={o} value={o}>{OP_LABELS[o] || o}</option>
                    )}
                  </select>
                  <input value={c.value}
                    onChange={e => patchCondition(i, { value: e.target.value })}
                    placeholder="value"
                    className={smallCls} />
                  <button type="button" onClick={() => removeCondition(i)}
                    className={`p-1 rounded-md ${theme.textSubtle} hover:text-rose-500`}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>Actions</label>
            <ActionAddMenu
              available={availableActions}
              onPick={addAction}
              theme={theme} darkMode={darkMode}
            />
          </div>
          {form.actions?.length === 0 ? (
            <p className={`text-xs ${theme.textSubtle}`}>
              No actions yet — pick one from the "+ Add action" menu above.
              A rule with 0 actions is a no-op (never fires).
            </p>
          ) : (
            <div className="space-y-2">
              {form.actions.map((a, i) => {
                const meta = ACTION_META[a.kind] || { label: a.kind, defaults: () => ({}) };
                return (
                  <div key={i} className={`rounded-xl border ${theme.border} ${theme.surface} p-3`}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">{meta.label}</div>
                        {meta.description && (
                          <div className={`text-[11px] ${theme.textSubtle}`}>{meta.description}</div>
                        )}
                      </div>
                      <button type="button" onClick={() => removeAction(i)}
                        title="Remove action"
                        className={`p-1 rounded-md ${theme.textSubtle} hover:text-rose-500 flex-shrink-0`}>
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <ActionParamsEditor
                      kind={a.kind}
                      params={a.params || {}}
                      onPatch={patch => patchActionParams(i, patch)}
                      catList={catList}
                      accounts={accounts}
                      budgets={budgets}
                      goals={goals}
                      currentTrigger={form.triggerType}
                      theme={theme} darkMode={darkMode}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
            Cancel
          </button>
          <motion.button whileTap={{ scale: 0.97 }} type="submit"
            className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold">
            {rule?.id ? "Save" : "Create"}
          </motion.button>
        </div>
      </form>
    </Sheet>
  );
}

// ─── Users Panel ──────────────────────────────────────────────────────────────
function UsersPanel({ currentUser, theme, darkMode, toast }) {
  const isDesktop = useIsDesktop();
  const [users, setUsers] = useState([]);
  const [toRemove, setToRemove] = useState(null); // user pending delete
  const [removing, setRemoving] = useState(false);
  // Admin extras
  const [info, setInfo] = useState(null);
  const [syncMin, setSyncMin] = useState("");
  const [origSyncMin, setOrigSyncMin] = useState("");
  const [allowText, setAllowText] = useState("");
  const [origAllowText, setOrigAllowText] = useState("");
  // Broadcast composer + list (D4) + Plaid account counts (D5)
  const [broadcasts, setBroadcasts] = useState([]);
  const [bcDraft, setBcDraft] = useState({ message: "", severity: "info", expires_at: "" });
  const [bcSaving, setBcSaving] = useState(false);
  const [plaidCounts, setPlaidCounts] = useState(null);
  // Pending role changes — keyed by user id. Empty when nothing pending.
  // Cleared after a successful save so the dropdown reflects fresh state.
  const [roleChanges, setRoleChanges] = useState({});
  const [audit, setAudit] = useState([]);
  const [cleanupDays, setCleanupDays] = useState(30);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [confirmRoleChanges, setConfirmRoleChanges] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { setUsers(await api.listUsers()); } catch {}
  };
  const loadAdmin = async () => {
    try {
      const [i, s, a, al, bcs, pc] = await Promise.all([
        api.adminInfo(),
        api.adminGetSyncInterval(),
        api.adminGetAllowlist(),
        api.adminGetAudit(),
        api.adminListBroadcasts().catch(() => []),
        api.adminPlaidAccountCounts().catch(() => null),
      ]);
      setInfo(i);
      const sm = String(s.minutes);
      setSyncMin(sm); setOrigSyncMin(sm);
      const at = (a.emails || []).join("\n");
      setAllowText(at); setOrigAllowText(at);
      setAudit(al);
      setBroadcasts(Array.isArray(bcs) ? bcs : []);
      setPlaidCounts(pc);
    } catch (e) { /* swallow — non-admin will 403 elsewhere */ }
  };
  const reloadBroadcasts = async () => {
    try { setBroadcasts(await api.adminListBroadcasts()); }
    catch { /* no-op */ }
  };
  const submitBroadcast = async () => {
    const msg = (bcDraft.message || "").trim();
    if (!msg) { toast?.("Message required", "error"); return; }
    setBcSaving(true);
    try {
      await api.adminCreateBroadcast({
        message: msg,
        severity: bcDraft.severity,
        expires_at: bcDraft.expires_at || null,
      });
      setBcDraft({ message: "", severity: "info", expires_at: "" });
      await reloadBroadcasts();
      toast?.("Broadcast published", "success");
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setBcSaving(false); }
  };
  const archiveBroadcast = async (id) => {
    try {
      await api.adminArchiveBroadcast(id);
      await reloadBroadcasts();
      toast?.("Archived", "success");
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };
  const isOwner = currentUser.role === "owner";
  const isAdminish = isOwner || currentUser.role === "admin";
  useEffect(() => { load(); if (isAdminish) loadAdmin(); }, []);

  if (!isAdminish) {
    return (
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-6 text-sm ${theme.textSubtle}`}>
        Admin access required to manage users.
      </div>
    );
  }

  // Permission: can the current user delete the given target row?
  // Mirrors the server-side rules in DELETE /auth/users/:id.
  const canDelete = (u) => {
    if (u.id === currentUser.id) return false;
    if (u.role === "owner") return false;
    if (u.role === "admin" && !isOwner) return false;
    return true;
  };
  // Permission: can the current user change the given target's role?
  // Owner-only, target must not be self or another owner.
  const canChangeRole = (u) => isOwner && u.id !== currentUser.id && u.role !== "owner";

  // Stage a role change locally — does NOT hit the API. The change is
  // applied when the user clicks Save and confirms the dialog. Setting the
  // dropdown back to the user's current role removes the pending entry so
  // dirty stays accurate.
  const stageRoleChange = (u, newRole) => {
    if (!canChangeRole(u)) return;
    setRoleChanges(prev => {
      const next = { ...prev };
      if (newRole === u.role) delete next[u.id];
      else next[u.id] = newRole;
      return next;
    });
  };
  // Effective role shown in the dropdown — pending change beats the server
  // value until save lands.
  const effectiveRole = (u) =>
    roleChanges[u.id] !== undefined ? roleChanges[u.id] : u.role;

  // Pretty role labels used in the confirmation dialog.
  const roleLabel = (r) => r === "user" ? "member" : r;

  // Dirty when any of the three things differ from their server snapshot.
  const dirty =
    syncMin !== origSyncMin
    || allowText !== origAllowText
    || Object.keys(roleChanges).length > 0;

  // Hitting the save bar's Save button. If there are role changes we open
  // the confirmation dialog first; everything else flows through commitSave.
  const onSaveClick = () => {
    if (Object.keys(roleChanges).length > 0) {
      setConfirmRoleChanges(true);
      return;
    }
    commitSave();
  };

  const commitSave = async () => {
    setConfirmRoleChanges(false);
    setSaving(true);
    try {
      // Role changes first — they're the most consequential.
      for (const [uid, newRole] of Object.entries(roleChanges)) {
        const u = users.find(x => x.id === Number(uid));
        await api.updateUserRole(Number(uid), newRole);
        if (u) toast?.(`${u.name || u.email} is now ${roleLabel(newRole)}`, "success");
      }
      // Sync interval (owner-only — the server enforces it too).
      if (syncMin !== origSyncMin) {
        const n = Math.round(Number(syncMin));
        if (!Number.isFinite(n) || n < 1) throw new Error("Sync interval must be a positive number");
        await api.adminSetSyncInterval(n);
        setOrigSyncMin(String(n));
      }
      // Allowlist.
      if (allowText !== origAllowText) {
        const emails = allowText.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
        const r = await api.adminSetAllowlist(emails);
        const at = (r.emails || []).join("\n");
        setAllowText(at); setOrigAllowText(at);
      }
      setRoleChanges({});
      // Reload users so the dropdown reflects the new server-side roles.
      await load();
      // Refresh audit log so the new major entries appear.
      try { setAudit(await api.adminGetAudit()); } catch {}
      toast?.("Changes saved", "success");
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setSaving(false); }
  };

  // Friendly message for the role-change confirm dialog.
  // For a single change: matches the wording you asked for.
  // For multiple: a compact list with one shared confirm.
  const roleChangeMessage = useMemo(() => {
    const entries = Object.entries(roleChanges).map(([uid, newRole]) => {
      const u = users.find(x => x.id === Number(uid));
      return u ? { name: u.name || u.email, oldRole: u.role, newRole } : null;
    }).filter(Boolean);
    if (entries.length === 0) return "";
    if (entries.length === 1) {
      const e = entries[0];
      const action = e.newRole === "admin" ? "promote" : "demote";
      return `You are about to ${action} this "${roleLabel(e.oldRole)}" to "${roleLabel(e.newRole)}", are you sure you wish to do this?`;
    }
    return `You are about to make ${entries.length} role changes:\n\n${
      entries.map(e => `• ${e.name}: ${roleLabel(e.oldRole)} → ${roleLabel(e.newRole)}`).join("\n")
    }\n\nAre you sure you wish to do this?`;
  }, [roleChanges, users]);

  const performRemove = async () => {
    if (!toRemove) return;
    setRemoving(true);
    try {
      await api.deleteUser(toRemove.id);
      toast?.(`Removed ${toRemove.name || toRemove.email}`, "success");
      setToRemove(null);
      load();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally {
      setRemoving(false);
    }
  };

  // Notification cleanup is its own destructive action (not a settings
  // change), so it goes through a confirm dialog rather than the save bar.
  const runCleanup = async () => {
    setConfirmCleanup(false);
    setCleanupBusy(true);
    try {
      const r = await api.adminCleanupNotifications(cleanupDays);
      toast?.(`Deleted ${r.deleted} notification${r.deleted === 1 ? "" : "s"}`, "success");
      // The cleanup is audited as a major event — refresh the log so it
      // surfaces immediately.
      try { setAudit(await api.adminGetAudit()); } catch {}
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setCleanupBusy(false); }
  };

  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  const Stat = ({ label, value }) => (
    <div className={`px-3 py-2 rounded-lg ${darkMode ? "bg-slate-800/60" : "bg-slate-50"} flex items-center justify-between gap-2`}>
      <span className={`text-xs ${theme.textSubtle}`}>{label}</span>
      <span className="text-xs font-semibold">{value}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Sticky save bar appears whenever a non-destructive change is
          pending (sync interval, allowlist, role staging). Destructive
          actions (delete user, cleanup notifications) go through their
          own ConfirmDialog and aren't tracked here. */}
      <SaveBar dirty={dirty} saving={saving} onSave={onSaveClick} theme={theme} darkMode={darkMode} />

      {/* ── App info ── */}
      {info && (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
          <h3 className="font-semibold mb-3">App info</h3>
          {/* Test email button moved to the Members section — per-row
              Mail icon lets the owner target a specific user. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Stat label="Plaid env"      value={info.plaidEnvironment} />
            <Stat label="Email enabled"  value={info.emailEnabled ? "yes" : "no"} />
            <Stat label="SMTP host"      value={info.smtpHost || "—"} />
            <Stat label="Signup mode"    value={info.signupMode} />
            <Stat label="Node env"       value={info.nodeEnv} />
            <Stat label="Users"          value={info.stats?.users ?? "?"} />
            <Stat label="Accounts"       value={info.stats?.accounts ?? "?"} />
            <Stat label="Transactions"   value={info.stats?.transactions ?? "?"} />
            <Stat label="Notifications"  value={info.stats?.notifications ?? "?"} />
          </div>
        </div>
      )}

      {/* ── Sync interval (owner edits, admin reads) ── */}
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5 space-y-2`}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Plaid sync interval</h3>
          {!isOwner && <span className={`text-[10px] ${theme.textSubtle}`}>Owner only</span>}
        </div>
        <div className={`text-xs ${theme.textSubtle}`}>
          How often the worker re-syncs every Plaid item. Saved value takes effect on the next worker restart.
        </div>
        <div className="flex items-center gap-2">
          <input type="text" inputMode="numeric" pattern="[0-9]*"
            className={`${inputCls} max-w-[8rem] ${!isOwner ? "opacity-60" : ""}`} value={syncMin}
            disabled={!isOwner}
            onChange={e => setSyncMin(e.target.value.replace(/[^\d]/g, ""))} />
          <span className={`text-xs ${theme.textSubtle}`}>minutes</span>
        </div>
      </div>

      {/* ── Allowlist editor (owner edits, admin reads) ── */}
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5 space-y-2`}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Email allowlist</h3>
          {!isOwner && <span className={`text-[10px] ${theme.textSubtle}`}>Owner only</span>}
        </div>
        <div className={`text-xs ${theme.textSubtle}`}>
          One email per line. Only addresses on this list can sign in via Google.
          Empty list = no restriction (not recommended in production).
        </div>
        <textarea rows={5} disabled={!isOwner}
          className={`${inputCls} font-mono text-xs leading-relaxed ${!isOwner ? "opacity-60" : ""}`}
          value={allowText} onChange={e => setAllowText(e.target.value)}
          placeholder="jane@example.com&#10;john@example.com" />
      </div>

      {/* ── Members ── */}
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
        <h3 className="font-semibold mb-3">Members ({users.length})</h3>
        <div className="space-y-0.5">
          {users.map(u => {
            // Per-role pill style. Owner = gold, Admin = violet, Member = slate.
            const rolePill = u.role === "owner"
              ? (darkMode ? "bg-amber-500/20 text-amber-300" : "bg-amber-100 text-amber-700")
              : u.role === "admin"
                ? (darkMode ? "bg-violet-500/20 text-violet-400" : "bg-violet-100 text-violet-700")
                : `${darkMode ? "bg-slate-800" : "bg-slate-100"} ${theme.textMuted}`;
            const showRoleSelect = canChangeRole(u);
            return (
              <div key={u.id} className={`flex items-center justify-between py-2.5 border-b ${theme.border} last:border-0`}>
                <div className="flex items-center gap-3 min-w-0">
                  {u.picture ? (
                    <img src={u.picture} alt="" className="w-9 h-9 rounded-full flex-shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                      {(u.name || u.email)[0].toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">
                      {u.name || u.email}
                      {u.id === currentUser.id && (
                        <span className={`text-[10px] ml-1.5 ${theme.textSubtle}`}>(you)</span>
                      )}
                    </div>
                    <div className={`text-xs ${theme.textSubtle} truncate`}>{u.email} · {u.accountCount} accounts</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {showRoleSelect ? (
                    // Owner: change Member ⇄ Admin via dropdown. "Owner" is
                    // intentionally NOT an option — single-owner instance.
                    // Selecting a new value stages it; the actual API call
                    // fires from the sticky save bar after confirmation.
                    <select
                      value={effectiveRole(u)}
                      onChange={(e) => stageRoleChange(u, e.target.value)}
                      className={`text-xs px-2 py-1 rounded-full font-medium border ${
                        roleChanges[u.id] !== undefined
                          ? (darkMode ? "border-violet-500 bg-violet-500/10" : "border-violet-500 bg-violet-50")
                          : `${theme.border} ${theme.surface}`
                      } focus:outline-none focus:border-violet-500`}>
                      <option value="user">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : (
                    <span className={`text-xs px-2 py-1 rounded-full font-medium flex items-center gap-1 capitalize ${rolePill}`}>
                      {u.role === "owner" && <Shield className="w-3 h-3" />}
                      {u.role === "admin" && <Shield className="w-3 h-3" />}
                      {u.role === "user" ? "Member" : u.role}
                    </span>
                  )}
                  {isOwner && info?.emailEnabled && (
                    <button
                      onClick={async () => {
                        try {
                          const r = await api.sendUserTestEmail(u.id);
                          toast?.(`Test email sent to ${r.sentTo}`, "success");
                        } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                      }}
                      title={`Send test email to ${u.email}`}>
                      <Mail className={`w-4 h-4 ${theme.textSubtle} hover:text-violet-500 transition-colors`} />
                    </button>
                  )}
                  {isOwner && isDesktop && info?.pushEnabled && (
                    <button
                      onClick={async () => {
                        try {
                          const r = await api.sendUserTestPush(u.id);
                          toast?.(`Test push sent to ${r.sent} device${r.sent === 1 ? "" : "s"} for ${r.sentTo}`, "success");
                        } catch (e) { toast?.("Push failed: " + (e.message || ""), "error"); }
                      }}
                      title={`Send test push to ${u.email}`}>
                      <Bell className={`w-4 h-4 ${theme.textSubtle} hover:text-violet-500 transition-colors`} />
                    </button>
                  )}
                  {canDelete(u) && (
                    <button onClick={() => setToRemove(u)} title={u.role === "admin" ? "Remove admin" : "Remove member"}>
                      <Trash2 className={`w-4 h-4 ${theme.textSubtle} hover:text-rose-500 transition-colors`} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!isOwner && (
          <div className={`text-[11px] ${theme.textSubtle} mt-3`}>
            Admins can only remove members. Removing or promoting admins is reserved to the owner.
          </div>
        )}
      </div>

      {/* ── Notification cleanup ── */}
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5 space-y-2`}>
        <h3 className="font-semibold">Clear old notifications</h3>
        <div className={`text-xs ${theme.textSubtle}`}>
          Permanently delete in-app notifications older than the threshold.
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${theme.textSubtle}`}>Older than</span>
          <input type="text" inputMode="numeric" pattern="[0-9]*"
            className={`${inputCls} max-w-[6rem]`} value={cleanupDays}
            onChange={e => setCleanupDays(e.target.value.replace(/[^\d]/g, ""))} />
          <span className={`text-xs ${theme.textSubtle}`}>days</span>
          <motion.button whileTap={{ scale: 0.97 }} type="button" disabled={cleanupBusy}
            onClick={() => setConfirmCleanup(true)}
            className={`px-3 py-2 rounded-xl text-sm font-semibold ${darkMode ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-rose-50 text-rose-700 border border-rose-200"} disabled:opacity-60`}>
            {cleanupBusy ? "Working…" : "Delete"}
          </motion.button>
        </div>
      </div>

      {/* ── Plaid account counts (D5) ── admin/owner only, hidden in manual-only mode ── */}
      {isAdminish && plaidCounts && currentUser?.plaid_enabled !== false && (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">Plaid account counts</h3>
            <span className={`text-[10px] ${theme.textSubtle}`}>
              {plaidCounts.itemCount} item{plaidCounts.itemCount === 1 ? "" : "s"} · {plaidCounts.totalAccounts} accounts
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className={`p-3 rounded-xl border ${theme.border}`}>
              <div className={`text-[10px] font-semibold uppercase ${theme.textSubtle}`}>Investment</div>
              <div className="text-xl font-bold text-violet-500">{plaidCounts.counts.investment}</div>
              <div className={`text-[10px] ${theme.textSubtle}`}>higher per-item cost</div>
            </div>
            <div className={`p-3 rounded-xl border ${theme.border}`}>
              <div className={`text-[10px] font-semibold uppercase ${theme.textSubtle}`}>Cash / Depository</div>
              <div className="text-xl font-bold text-emerald-500">{plaidCounts.counts.cash}</div>
            </div>
            <div className={`p-3 rounded-xl border ${theme.border}`}>
              <div className={`text-[10px] font-semibold uppercase ${theme.textSubtle}`}>Credit</div>
              <div className="text-xl font-bold text-rose-500">{plaidCounts.counts.credit}</div>
            </div>
            <div className={`p-3 rounded-xl border ${theme.border}`}>
              <div className={`text-[10px] font-semibold uppercase ${theme.textSubtle}`}>Loan / Other</div>
              <div className={`text-xl font-bold ${theme.textMuted}`}>{plaidCounts.counts.loan + plaidCounts.counts.other}</div>
            </div>
          </div>
          <p className={`text-[10px] ${theme.textSubtle} mt-2`}>
            Plaid-linked accounts only; manual accounts aren't counted. Use to size flat member fees against Plaid product cost.
          </p>
        </div>
      )}

      {/* ── Broadcast composer + history (D4) ── admin/owner only ── */}
      {isAdminish && (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm">Broadcast banner (desktop)</h3>
            <span className={`text-[10px] ${theme.textSubtle}`}>Shown to every user until dismissed</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_140px_180px_auto] gap-2 items-start">
            <textarea
              value={bcDraft.message}
              onChange={e => setBcDraft({ ...bcDraft, message: e.target.value.slice(0, 500) })}
              placeholder="e.g. Maintenance window tonight 10pm–11pm ET"
              rows={2}
              className={`px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
            <select value={bcDraft.severity}
              onChange={e => setBcDraft({ ...bcDraft, severity: e.target.value })}
              className={`px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`}>
              <option value="info">Info (sky)</option>
              <option value="warning">Warning (amber)</option>
              <option value="critical">Critical (rose)</option>
            </select>
            <input type="datetime-local" value={bcDraft.expires_at}
              onChange={e => setBcDraft({ ...bcDraft, expires_at: e.target.value })}
              placeholder="Optional expires-at"
              className={`px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`} />
            <button type="button" onClick={submitBroadcast} disabled={bcSaving}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-violet-500 text-white disabled:opacity-60">
              {bcSaving ? "Publishing…" : "Publish"}
            </button>
          </div>
          {broadcasts.length > 0 && (
            <div className={`mt-3 max-h-48 overflow-y-auto rounded-lg border ${theme.border} divide-y ${theme.divide}`}>
              {broadcasts.map(b => {
                const active = !b.archivedAt && (!b.expiresAt || new Date(b.expiresAt) > new Date());
                const sevColor = b.severity === "critical" ? "text-rose-500"
                             : b.severity === "warning"  ? "text-amber-500"
                             :                              "text-sky-500";
                return (
                  <div key={b.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <div className={`font-bold uppercase text-[10px] ${sevColor} min-w-[60px]`}>{b.severity}</div>
                    <div className="flex-1 min-w-0">
                      <div className={active ? "" : `line-through ${theme.textSubtle}`}>{b.message}</div>
                      <div className={`text-[10px] ${theme.textSubtle}`}>
                        {new Date(b.createdAt).toLocaleString()} · {b.createdByEmail || "system"}
                        {b.expiresAt ? ` · expires ${new Date(b.expiresAt).toLocaleString()}` : ""}
                        {b.archivedAt ? " · archived" : ""}
                      </div>
                    </div>
                    {active && (
                      <button type="button" onClick={() => archiveBroadcast(b.id)}
                        className="text-[10px] font-semibold text-rose-500 hover:underline">
                        Archive
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Audit log (last 100, tiered retention) ── */}
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-4`}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-sm">Audit log</h3>
          <span className={`text-[10px] ${theme.textSubtle}`}>Routine: 48 h · Major: 7 d</span>
        </div>
        <div className={`max-h-56 overflow-y-auto rounded-lg border ${theme.border} ${darkMode ? "bg-slate-900/40" : "bg-slate-50"}`}>
          {audit.length === 0 && (
            <div className={`text-xs ${theme.textSubtle} px-3 py-4 text-center`}>No entries.</div>
          )}
          {audit.map(a => (
            <div key={a.id}
              className={`text-[11px] px-3 py-1.5 border-b ${theme.border} last:border-0 flex items-center justify-between gap-2 ${
                a.isMajor
                  ? `border-l-4 ${darkMode ? "border-l-rose-500 bg-rose-500/10" : "border-l-rose-500 bg-rose-50"}`
                  : ""
              }`}>
              <div className="min-w-0 flex-1 flex items-center gap-1.5">
                {a.isMajor && (
                  <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${darkMode ? "bg-rose-500/25 text-rose-300" : "bg-rose-200 text-rose-800"}`}>
                    Major
                  </span>
                )}
                <span className="font-mono">{a.action}</span>
                {a.userEmail && <span className={`${theme.textSubtle} ml-1`}>{a.userEmail}</span>}
              </div>
              <div className={`${theme.textSubtle} truncate text-right`} style={{ maxWidth: "55%" }}>
                {a.ip || "?"}{a.location ? ` · ${a.location}` : ""}
                <span className="ml-2">{new Date(a.createdAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={!!toRemove}
        onCancel={() => !removing && setToRemove(null)}
        onConfirm={performRemove}
        theme={theme} darkMode={darkMode}
        busy={removing}
        title="Remove this user?"
        message={toRemove && `${toRemove.name || toRemove.email} will be deleted along with all their accounts, transactions, budgets, goals, and notes. This cannot be undone.`}
        confirmLabel="Remove user"
      />

      {/* Role-change confirmation — fired by the save bar when any role
          dropdown has been staged. Cancelling leaves the staged changes
          intact so the user can keep editing or undo manually. */}
      <ConfirmDialog
        open={confirmRoleChanges}
        onCancel={() => !saving && setConfirmRoleChanges(false)}
        onConfirm={commitSave}
        theme={theme} darkMode={darkMode}
        busy={saving}
        title="Confirm role change"
        message={roleChangeMessage}
        confirmLabel="Yes, apply"
      />

      {/* Notification cleanup confirmation — destructive bulk delete. */}
      <ConfirmDialog
        open={confirmCleanup}
        onCancel={() => !cleanupBusy && setConfirmCleanup(false)}
        onConfirm={runCleanup}
        theme={theme} darkMode={darkMode}
        busy={cleanupBusy}
        title="Delete old notifications?"
        message={`Every in-app notification older than ${cleanupDays} day${cleanupDays == 1 ? "" : "s"} will be permanently removed across all users. This cannot be undone.`}
        confirmLabel="Delete notifications"
      />
    </div>
  );
}

// ─── Mobile Banks & Accounts section (shown inside Settings on mobile) ───────
function MobileBanksSection({ theme, darkMode, toast }) {
  const { accounts, refreshAll } = useData();
  const { user: _mbsUser } = useAuth();
  const plaidEnabled = !(_mbsUser && _mbsUser.plaid_enabled === false);
  const [items, setItems] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [form, setForm] = useState({ name: "", type: "cash", subtype: "", balance: "", institution: "", link_asset_id: "" });
  const [linkableAssets, setLinkableAssets] = useState([]);

  const loadItems = useCallback(async () => {
    try { setItems(await api.listPlaidItems()); } catch {}
  }, []);
  useEffect(() => { loadItems(); }, [loadItems]);
  useEffect(() => {
    if (!showAdd) return;
    api.listAssets()
      .then(list => setLinkableAssets(list.filter(a => !a.loanAccountId)))
      .catch(() => setLinkableAssets([]));
  }, [showAdd]);

  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.syncPlaid();
      toast?.("Sync queued", "success");
      setTimeout(() => { refreshAll(); loadItems(); }, 2000);
    } catch (e) { toast?.("Sync failed: " + (e.message || ""), "error"); }
    finally { setTimeout(() => setSyncing(false), 1500); }
  };

  const removeItem = async (item) => {
    if (!window.confirm(`Disconnect ${item.institutionName || "this bank"}? Accounts and transactions from it will be removed.`)) return;
    setRemovingId(item.id);
    try {
      await api.deletePlaidItem(item.id);
      toast?.("Bank disconnected", "success");
      await loadItems(); await refreshAll();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setRemovingId(null); }
  };

  const removeAccount = async (acc) => {
    if (acc.plaidItemId) { toast?.("Disconnect via Connected Banks", "warning"); return; }
    if (!window.confirm(`Delete ${acc.name}?`)) return;
    try { await api.deleteAccount(acc.id); refreshAll(); toast?.("Deleted", "success"); }
    catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  const submitAdd = async (e) => {
    e.preventDefault();
    setAdding(true);
    try {
      await api.createAccount({
        name: form.name.trim(),
        type: form.type,
        subtype: form.subtype.trim() || undefined,
        balance: Number(form.balance) || 0,
        institution: form.institution.trim() || undefined,
        link_asset_id: form.type === "loan" && form.link_asset_id
          ? Number(form.link_asset_id) : undefined,
      });
      toast?.("Account added", "success");
      setShowAdd(false);
      setForm({ name: "", type: "cash", subtype: "", balance: "", institution: "", link_asset_id: "" });
      refreshAll();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setAdding(false); }
  };

  const manualAccounts = accounts.filter(a => !a.plaidItemId);
  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-4`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{plaidEnabled ? "Banks & Accounts" : "Accounts"}</h3>
        {plaidEnabled && (
          <motion.button whileTap={{ scale: 0.95 }} onClick={sync} disabled={syncing || items.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 ${theme.surface} border ${theme.border} rounded-lg text-xs font-medium disabled:opacity-50`}>
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync"}
          </motion.button>
        )}
      </div>

      <PlaidLinkButton onSuccess={() => { refreshAll(); loadItems(); }} full />

      {items.length > 0 && (
        <div>
          <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>Connected Banks</div>
          <div className={`rounded-xl border ${theme.border} divide-y ${theme.divide}`}>
            {items.map(item => (
              <div key={item.id} className="flex items-center justify-between px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-500/20 flex items-center justify-center flex-shrink-0">
                    <Building2 className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate private-name" tabIndex={0}>{item.institutionName || "Bank"}</div>
                    <div className={`text-[11px] ${theme.textSubtle} truncate`}>
                      {item.lastSyncAt ? `Synced ${new Date(item.lastSyncAt).toLocaleDateString()}` : "Not yet synced"}
                    </div>
                  </div>
                </div>
                <button onClick={() => removeItem(item)} disabled={removingId === item.id}
                  className={`text-xs font-medium px-2.5 py-1 rounded-lg disabled:opacity-50 ${darkMode ? "text-rose-400 hover:bg-rose-500/10" : "text-rose-600 hover:bg-rose-50"}`}>
                  {removingId === item.id ? "…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider`}>Manual Accounts</div>
          <button onClick={() => setShowAdd(true)}
            className="text-xs font-semibold text-violet-500 flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
        {manualAccounts.length === 0 ? (
          <p className={`text-xs ${theme.textSubtle} text-center py-3`}>
            No manual accounts. Use "Add" for banks Plaid doesn't support.
          </p>
        ) : (
          <div className={`rounded-xl border ${theme.border} divide-y ${theme.divide}`}>
            {manualAccounts.map(a => (
              <div key={a.id} className="flex items-center justify-between px-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate private-name" tabIndex={0}>{a.name}</div>
                  <div className={`text-[11px] ${theme.textSubtle} truncate`}><span className="private-name" tabIndex={0}>{a.institution || a.type}</span> · <span className="private-amount" tabIndex={0}>{fmt(a.balance)}</span></div>
                </div>
                <button onClick={() => removeAccount(a)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-lg ${darkMode ? "text-rose-400 hover:bg-rose-500/10" : "text-rose-600 hover:bg-rose-50"}`}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Sheet open={showAdd} onClose={() => setShowAdd(false)} title="Add Manual Account" theme={theme}>
        <form onSubmit={submitAdd} className="space-y-3">
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Account Name</label>
            <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="My Checking" className={inputCls} />
          </div>
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Institution</label>
            <input value={form.institution} onChange={e => setForm({ ...form, institution: e.target.value })}
              placeholder="Bank or institution name" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Type</label>
              <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className={inputCls}>
                <option value="cash">Cash / Checking</option>
                <option value="credit">Credit Card</option>
                <option value="investment">Investment</option>
                <option value="loan">Loan</option>
              </select>
            </div>
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Balance</label>
              <input type="number" step="0.01" required value={form.balance}
                onChange={e => setForm({ ...form, balance: e.target.value })}
                placeholder="0.00" className={inputCls} />
            </div>
          </div>
          {form.type === "loan" && (
            <div>
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>
                Backing asset (optional)
              </label>
              {linkableAssets.length === 0 ? (
                <div className={`text-xs ${theme.textSubtle} px-3 py-2 border ${theme.border} rounded-xl`}>
                  No unlinked assets yet. Add one under Assets & valuables to pair this loan with a car, boat, or property.
                </div>
              ) : (
                <select value={form.link_asset_id}
                  onChange={e => setForm({ ...form, link_asset_id: e.target.value })} className={inputCls}>
                  <option value="">Don't link</option>
                  {linkableAssets.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name} · value {fmt(Number(a.currentValue) || 0)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setShowAdd(false)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
              Cancel
            </button>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={adding}
              className="flex-1 bg-violet-500 hover:bg-violet-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Adding…" : "Add account"}
            </motion.button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
// ─── Reusable sticky "unsaved changes" save bar + side ribbon ───────────────
// Used by Settings and the Admin panel. Pinned at the top of the parent's
// scroll context when dirty; a small floating ribbon slides in on the right
// once the user has scrolled past the bar and click-scrolls them back to it.
function SaveBar({ dirty, saving, onSave, theme, darkMode, label = "You have unsaved changes" }) {
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolledFromTop(window.scrollY > 120);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
  return (
    <>
      <AnimatePresence initial={false}>
        {dirty && (
          <motion.div
            key="save-bar"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.18 }}
            className="sticky top-0 z-30 -mx-1 px-1">
            <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border shadow-lg ${
              darkMode
                ? "bg-violet-500/15 border-violet-500/40 text-violet-50 backdrop-blur"
                : "bg-violet-50 border-violet-200 text-violet-900 backdrop-blur"
            }`}>
              <div className="text-sm font-medium">{label}</div>
              <motion.button whileTap={{ scale: 0.95 }} type="button"
                onClick={onSave} disabled={saving}
                className="bg-violet-500 hover:bg-violet-600 text-white px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-60">
                {saving ? "Saving…" : "Save changes"}
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {dirty && scrolledFromTop && (
          <motion.button key="save-ribbon" type="button"
            onClick={scrollToTop}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="fixed right-0 top-24 z-40 pl-3 pr-4 py-2 rounded-l-xl bg-violet-500 text-white text-xs font-semibold shadow-lg shadow-violet-500/30 flex items-center gap-2"
            aria-label="Scroll to save bar">
            <ArrowUpRight className="w-3.5 h-3.5 -rotate-90" />
            Save Changes?
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}

const WEEK_DAYS = [
  { v: 0, label: "Sunday" }, { v: 1, label: "Monday" }, { v: 2, label: "Tuesday" },
  { v: 3, label: "Wednesday" }, { v: 4, label: "Thursday" },
  { v: 5, label: "Friday" }, { v: 6, label: "Saturday" },
];

// ── Push devices (D11) ────────────────────────────────────────────────
// Lists every browser/PWA the user has enrolled for push, with a revoke
// button per row. Endpoint URLs are opaque and not shown — user_agent
// is the human-readable identifier. Revoke DELETEs the server row so
// the daily/inline push fanout skips that device; the browser's own
// PushSubscription is left alone (silently stops receiving). Users on
// their current device see a "this browser" hint against the row that
// matches — best-effort match by looking at navigator.userAgent.
function PushDevicesPanel({ theme, darkMode, toast, showAdvanced = false }) {
  const [rows, setRows] = useState(null); // null = loading
  const [busyId, setBusyId] = useState(null);
  const currentUA = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const load = async () => {
    try { setRows(await api.listPushSubscriptions()); }
    catch { setRows([]); }
  };
  useEffect(() => { load(); }, []);

  const revoke = async (id) => {
    setBusyId(id);
    try {
      // No public endpoint by id — but each row has a unique server-side
      // id; we surface a delete-by-endpoint API. Backend also accepts a
      // body-less DELETE that wipes everything. For per-row we need the
      // endpoint, which isn't returned to the client. So we send a
      // targeted delete via a new admin-style endpoint... For now,
      // revoke ONE row by calling the wipe-all endpoint filtered by
      // the row's id via the manage-devices sub-route.
      await api.deletePushSubscriptionById(id);
      toast?.("Device revoked", "success");
      await load();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setBusyId(null); }
  };

  if (rows === null) {
    return <div className={`text-xs ${theme.textSubtle}`}>Loading devices…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className={`text-xs ${theme.textSubtle} border ${theme.border} rounded-xl px-3 py-2`}>
        No push devices enrolled yet. Toggle push on above to enroll this browser.
      </div>
    );
  }
  const uaLabel = (ua) => {
    if (!ua) return "Unknown device";
    // Cheap browser/OS identification. Full UA is shown in the tooltip.
    let browser = "Browser";
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
    else if (/Safari\//.test(ua)) browser = "Safari";
    let os = "";
    if (/iPhone|iPad|iPod/.test(ua)) os = " on iPhone/iPad";
    else if (/Android/.test(ua)) os = " on Android";
    else if (/Windows/.test(ua)) os = " on Windows";
    else if (/Macintosh|Mac OS/.test(ua)) os = " on macOS";
    else if (/Linux/.test(ua)) os = " on Linux";
    return `${browser}${os}`;
  };

  return (
    <div className={`border ${theme.border} rounded-xl divide-y ${theme.divide}`}>
      <div className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wider ${theme.textSubtle} ${darkMode ? "bg-slate-800" : "bg-slate-50"}`}>
        Enrolled devices ({rows.length})
      </div>
      {rows.map(d => {
        const isCurrent = d.userAgent && currentUA && d.userAgent.slice(0, 100) === currentUA.slice(0, 100);
        return (
          <div key={d.id} className="flex items-center gap-3 px-3 py-2 text-xs">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate" title={d.userAgent || ""}>
                {uaLabel(d.userAgent)}
                {isCurrent ? <span className={`ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${darkMode ? "bg-violet-500/15 text-violet-300" : "bg-violet-50 text-violet-700"}`}>this browser</span> : null}
              </div>
              <div className={theme.textSubtle}>
                Added {new Date(d.createdAt).toLocaleDateString()}
                {d.lastUsedAt ? ` · last used ${new Date(d.lastUsedAt).toLocaleDateString()}` : " · never used"}
              </div>
            </div>
            {showAdvanced && (
              <button type="button" disabled={busyId === d.id}
                onClick={async () => {
                  setBusyId(d.id);
                  try {
                    const r = await api.sendTestPush(d.id);
                    toast?.(`Test push sent (${r.sent} delivered)`, "success");
                  } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
                  finally { setBusyId(null); }
                }}
                className={`px-2 py-1 rounded-lg text-[11px] font-semibold text-violet-500 hover:bg-violet-500/10 disabled:opacity-40`}>
                {busyId === d.id ? "…" : "Test"}
              </button>
            )}
            <button type="button" disabled={busyId === d.id}
              onClick={() => revoke(d.id)}
              className="px-2 py-1 rounded-lg text-[11px] font-semibold text-rose-500 hover:bg-rose-500/10 disabled:opacity-40">
              {busyId === d.id ? "…" : "Revoke"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Biometric lock settings panel (D12) — mobile only ──────────────────
// Owns the FaceID / TouchID enrollment + toggle + manage-devices UI.
// Shown only when the browser supports WebAuthn; falls back to an
// explanatory disabled tile when unsupported (older iOS, Firefox
// Focus, etc). Enrolling a device implicitly enables the lock; the
// toggle then lets the user turn it off without wiping the credential.
function BiometricLockPanel({ theme, darkMode, toast, user, onUpdate }) {
  const [creds, setCreds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [lockEnabled, setLockEnabled] = useState(!!user?.biometric_lock_enabled);
  const load = useCallback(async () => {
    try { setCreds(await api.webauthnListCredentials()); }
    catch { /* stay empty */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setLockEnabled(!!user?.biometric_lock_enabled); }, [user?.biometric_lock_enabled]);

  const supported = webauthnSupported();

  const enroll = async () => {
    if (busy) return;
    setBusy(true);
    const r = await enrollBiometric();
    setBusy(false);
    if (r.ok) {
      toast?.("Device enrolled — biometric lock is on", "success");
      setLockEnabled(true);
      await load();
      onUpdate?.();
    } else if (r.reason === "denied") {
      toast?.("Cancelled", "warning");
    } else if (r.reason === "unsupported") {
      toast?.("Your browser doesn't support FaceID / TouchID here", "error");
    } else {
      toast?.("Enroll failed. Try again from the home-screen PWA.", "error");
    }
  };

  const flipLock = async (v) => {
    // Turning the lock OFF requires a fresh biometric verification —
    // stops someone with an unlocked-app session from just flipping the
    // toggle off. Turning it ON doesn't require re-auth since the user
    // is inherently past the lock at that point.
    if (!v && lockEnabled) {
      const r = await unlockBiometric();
      if (!r.ok) {
        // Roll the visible toggle back — this fires when the biometric
        // was cancelled OR failed. Silent for "denied" (cancelled),
        // toast for real errors.
        if (r.reason !== "denied") {
          toast?.("Couldn't verify. Try again.", "error");
        }
        return;
      }
    }
    setLockEnabled(v);
    try {
      await api.webauthnSetLockEnabled(v);
      toast?.(v ? "Lock enabled" : "Lock disabled", "success");
      onUpdate?.();
    } catch (e) {
      setLockEnabled(!v);
      toast?.("Failed: " + (e.message || ""), "error");
    }
  };

  const revoke = async (id) => {
    if (!window.confirm("Remove this device? You'll need to enroll again next time.")) return;
    // Removing a device weakens the lock, so gate it behind biometric
    // the same way disabling does. Same UX for both destructive actions.
    const auth = await unlockBiometric();
    if (!auth.ok) {
      if (auth.reason !== "denied") {
        toast?.("Couldn't verify. Try again.", "error");
      }
      return;
    }
    try {
      const r = await api.webauthnDeleteCredential(id);
      toast?.("Device removed", "success");
      await load();
      if (!r.remaining) {
        setLockEnabled(false);
        onUpdate?.();
      }
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
  };

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <Lock className="w-4 h-4 text-violet-500" /> Require {biometricMethodName()} to open
          </div>
          <div className={`text-xs ${theme.textSubtle} mt-0.5`}>
            Locks the app after 5 minutes idle or when reopened. Your login stays valid — this only gates who can see your data on this device. Works with any unlock method your phone already uses (biometric or passcode).
            {!supported && <> <span className="text-amber-500">Not supported by this browser.</span></>}
          </div>
        </div>
        {creds.length > 0 && (
          <Toggle checked={lockEnabled} darkMode={darkMode} onChange={flipLock} />
        )}
      </div>

      {supported && creds.length === 0 && (
        <button type="button" onClick={enroll} disabled={busy}
          className="w-full py-2.5 rounded-xl bg-violet-500 text-white text-sm font-semibold disabled:opacity-60">
          {busy ? "Enrolling…" : `Enable ${biometricMethodName()}`}
        </button>
      )}

      {supported && creds.length > 0 && (
        <div>
          <div className={`text-[10px] font-semibold uppercase tracking-wider ${theme.textSubtle} mb-1`}>
            Enrolled devices ({creds.length})
          </div>
          <div className={`border ${theme.border} rounded-xl divide-y ${theme.divide}`}>
            {creds.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{c.deviceName || "Unknown device"}</div>
                  <div className={theme.textSubtle}>
                    Added {new Date(c.createdAt).toLocaleDateString()}
                    {c.lastUsedAt ? ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : " · never used"}
                  </div>
                </div>
                <button type="button" onClick={() => revoke(c.id)}
                  className="px-2 py-1 rounded-lg text-[11px] font-semibold text-rose-500 hover:bg-rose-500/10">
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={enroll} disabled={busy}
            className={`w-full mt-2 py-2 rounded-lg text-xs font-semibold text-violet-500 border border-dashed ${theme.border} hover:bg-violet-500/5 disabled:opacity-60`}>
            {busy ? "Enrolling…" : "+ Add another device"}
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ user, onUpdate, theme, darkMode, onToggleDark }) {
  const toast = useToast();
  const isDesktop = useIsDesktop();
  const fileInputRef = useRef(null);
  const rootRef = useRef(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  // "Clear all my data" — the confirmation form pops open inline so the
  // user has to type their email before the button is armed.
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [clearDataTyped, setClearDataTyped] = useState("");
  const [clearingAllData, setClearingAllData] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [importingQuicken, setImportingQuicken] = useState(false);
  const [quickenAccountId, setQuickenAccountId] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const quickenInputRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const { accounts, refreshAll } = useData();

  // Snapshot of "what the server currently has" so we can detect unsaved
  // changes by comparing to `form`. Built lazily once at mount; reset
  // every successful save so the dirty flag clears.
  const buildSnapshot = (u) => ({
    name: u.name || "",
    notification_email: u.notification_email !== false,
    notification_push: u.notification_push !== false,
    notify_large_txn:       u.notify_large_txn       !== false,
    large_txn_threshold:    Number(u.large_txn_threshold ?? 500),
    notify_income:          u.notify_income          !== false,
    income_threshold:       Number(u.income_threshold ?? 100),
    notify_budget_warning:  u.notify_budget_warning  !== false,
    budget_warning_pct:     Number(u.budget_warning_pct ?? 80),
    notify_budget_exceeded: u.notify_budget_exceeded !== false,
    notify_goal_milestone:  u.notify_goal_milestone  !== false,
    notify_bill_reminders:  u.notify_bill_reminders  !== false,
    notify_bill_days_before: Number(u.notify_bill_days_before ?? 3),
    notify_cashflow_enabled: !!u.notify_cashflow_enabled,
    notify_cashflow_min:     Number(u.notify_cashflow_min ?? 0),
    notify_budget_usage_enabled: !!u.notify_budget_usage_enabled,
    notify_budget_usage_pct: Number(u.notify_budget_usage_pct ?? 90),
    // push_frequency is always "instant" now — kept in the payload for
    // back-compat but the cadence selector was removed since batching a
    // lock-screen alert defeats its purpose.
    push_frequency:          "instant",
    privacy_mode:           !!u.privacy_mode,
    week_start:             Number(u.week_start ?? 0),
    email_frequency:        u.email_frequency || "daily",
    email_weekday:          Number(u.email_weekday ?? 1),
  });
  const [form, setForm] = useState(() => buildSnapshot(user));
  const [original, setOriginal] = useState(() => buildSnapshot(user));
  // Cheap deep-equal via stringify — both sides are flat objects of the
  // same shape so key order is deterministic.
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(original),
    [form, original]
  );

  // Integer input helper that strips non-digits and clamps. Used by the
  // threshold inputs and the budget-warning %.
  const intChange = (key, max = 1_000_000) => (e) => {
    const raw = e.target.value.replace(/[^\d]/g, "");
    const n = raw === "" ? "" : Math.min(max, Math.max(1, Number(raw)));
    setForm(f => ({ ...f, [key]: n }));
  };

  const save = async (e) => {
    e?.preventDefault?.();
    if (!dirty || saving) return;
    setSaving(true);
    try {
      // Coerce empty strings → server default by sending the current row's
      // value; the server's COALESCE leaves it alone if null.
      const payload = { ...form };
      for (const k of ["large_txn_threshold", "income_threshold", "budget_warning_pct",
                       "notify_bill_days_before", "notify_cashflow_min",
                       "notify_budget_usage_pct"]) {
        if (payload[k] === "" || payload[k] === null) delete payload[k];
        else if (payload[k] !== undefined) payload[k] = Number(payload[k]) || 0;
      }
      await api.updateMe(payload);
      // Clear dirty by re-baselining original to the current form.
      setOriginal(form);
      toast?.("Settings saved", "success");
      onUpdate?.();
    } catch (err) { toast?.("Failed: " + err.message, "error"); }
    finally { setSaving(false); }
  };


  // Toggle lives at module scope below (SettingsToggle). Previously
  // defined inline here, but the module-scope NotifRow needs it too, so
  // it had to move out.

  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;
  const numCls   = `w-28 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500 text-right`;
  // Notifications all live under the email switch — when email is off OR the
  // server-side EMAIL_CONFIG is disabled, everything below is greyed out.
  const emailOn = form.notification_email && user.email_enabled;

  // NotifRow lives at module scope below — inlined here it would
  // re-create the component on every render and lose focus on every
  // keystroke in its children's threshold inputs (same bug pattern as
  // the paystub Section).

  // CSV import: pick a file, read text, POST it.
  const handleCsvFile = async (file) => {
    if (!file) return;
    setImportingCsv(true);
    try {
      const text = await file.text();
      const r = await api.importTransactionsCSV(text);
      toast?.(`Imported ${r.imported} (skipped ${r.skipped})`, "success");
      onUpdate?.();
    } catch (e) {
      toast?.("Import failed: " + (e.message || ""), "error");
    } finally { setImportingCsv(false); }
  };

  // QIF / OFX / QFX import. Same pattern as CSV, but with an account
  // dropdown that binds every imported row to a chosen account (or
  // leaves them account-less for later assignment). Bank exports don't
  // carry account context so this is the only way to tie them in.
  //
  // Two paths:
  //   - User picked an existing account from the dropdown → bind every
  //     row to that account (legacy fast path).
  //   - User left "auto-detect" → run preview_only=1, open the mapping
  //     sheet with per-file-account choices, then send the mapping.
  const handleQuickenFile = async (file) => {
    if (!file) return;
    setImportingQuicken(true);
    try {
      const acctId = quickenAccountId ? Number(quickenAccountId) : null;
      const isMny = /\.mny$/i.test(file.name);
      let mnyPassword = null;
      if (isMny) {
        const pw = window.prompt(
          "Microsoft Money file — enter the file password if you remember it, or leave blank and sunriise will attempt to unlock it. Cancel to abort.",
          ""
        );
        if (pw === null) { setImportingQuicken(false); return; }
        mnyPassword = pw;
      }
      // Prepare the raw payload once; every subsequent call re-uses it.
      let contentText = null, contentB64 = null;
      if (isMny) {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        contentB64 = btoa(bin);
      } else {
        contentText = await file.text();
      }
      const call = (opts) => isMny
        ? api.importMny(contentB64, { ...opts, password: mnyPassword })
        : api.importQuicken(contentText, opts);
      // Path 1: account already chosen — do the direct import.
      if (acctId) {
        await runImportWithDedupe(() => call({ accountId: acctId, allowDuplicates: false }),
                                  () => call({ accountId: acctId, allowDuplicates: true }));
        return;
      }
      // Path 2: preview → mapping sheet. If the file only names a
      // single unnamed bucket, we could still ask the user which
      // existing account to bind it to.
      const preview = await call({ previewOnly: true });
      if (!preview.preview || !Array.isArray(preview.accounts) || preview.accounts.length === 0) {
        // Preview came back empty — nothing to import.
        toast?.("Nothing to import (0 transactions found)", "warning");
        return;
      }
      setImportPreview({
        format: preview.format,
        accounts: preview.accounts,
        totalTxns: preview.totalTxns,
        // The mapping sheet fills this in with per-account choices, then
        // calls submitImportMapping which uses these callbacks.
        onSubmit: async (mapping) => {
          await runImportWithDedupe(
            () => call({ accountMapping: mapping, allowDuplicates: false }),
            () => call({ accountMapping: mapping, allowDuplicates: true }),
          );
        },
      });
    } catch (e) {
      toast?.("Import failed: " + (e.message || ""), "error");
    } finally { setImportingQuicken(false); }
  };

  // Shared post-import UX: toast the result, prompt on duplicates.
  const runImportWithDedupe = async (callWithoutDupes, callWithDupes) => {
    const r = await callWithoutDupes();
    let extra = "";
    if (r.duplicates > 0) {
      const importAnyway = window.confirm(
        `${r.duplicates} row${r.duplicates === 1 ? " looks" : "s look"} like duplicate${r.duplicates === 1 ? "" : "s"} of existing transactions (same amount within ±3 days). Import them anyway?\n\nOK = import all\nCancel = keep skipped`
      );
      if (importAnyway) {
        const r2 = await callWithDupes();
        extra = ` · +${r2.imported - r.imported} dupes imported`;
      } else {
        extra = ` · ${r.duplicates} dupes skipped`;
      }
    }
    const acctExtra = (r.createdAccountIds && r.createdAccountIds.length)
      ? ` · ${r.createdAccountIds.length} account${r.createdAccountIds.length === 1 ? "" : "s"} created`
      : "";
    toast?.(`Imported ${r.imported} ${(r.format || "").toUpperCase()} txns${extra}${acctExtra}`, "success");
    onUpdate?.();
  };

  return (
    <div className="space-y-4" ref={rootRef}>
      <SaveBar dirty={dirty} saving={saving} onSave={save} theme={theme} darkMode={darkMode} />

      {/* ── Appearance + display prefs ── */}
      <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-4`}>
        <h3 className="font-semibold">Appearance</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Dark mode</div>
            <div className={`text-xs ${theme.textSubtle} mt-0.5`}>Synced across all your devices</div>
          </div>
          <Toggle checked={darkMode} onChange={onToggleDark} darkMode={darkMode} />
        </div>
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium">Privacy mode</div>
            <div className={`text-xs ${theme.textSubtle} mt-0.5`}>Blur dollar amounts; hover to reveal. Good for screenshots.</div>
          </div>
          <Toggle checked={form.privacy_mode} onChange={v => setForm({ ...form, privacy_mode: v })} darkMode={darkMode} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Week starts on</div>
            <div className={`text-xs ${theme.textSubtle} mt-0.5`}>Used by weekly budgets and date grouping.</div>
          </div>
          <select className={`${inputCls} max-w-[10rem]`} value={form.week_start}
            onChange={e => setForm({ ...form, week_start: Number(e.target.value) })}>
            {WEEK_DAYS.map(d => <option key={d.v} value={d.v}>{d.label}</option>)}
          </select>
        </div>
      </div>

      {/* Mobile-only: Banks & Accounts management lives here (desktop has its own Accounts tab) */}
      <div className="lg:hidden space-y-4">
        <MobileBanksSection theme={theme} darkMode={darkMode} toast={toast} />
        <AssetsPanel theme={theme} darkMode={darkMode} toast={toast} onChange={refreshAll} />
      </div>

      {/* ── Account ── */}
      <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5`}>
        <h3 className="font-semibold mb-4">Account</h3>
        <div className="flex items-center gap-3 mb-1">
          {user.picture ? (
            <img src={user.picture} alt="" className="w-12 h-12 rounded-full" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-white font-semibold">
              {(user.name || user.email || "?")[0].toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{user.name}</div>
            <div className={`text-xs ${theme.textSubtle} truncate`}>{user.email}</div>
          </div>
        </div>
        <div className={`text-xs ${theme.textSubtle} mt-3`}>
          Signed in with Google · {
            user.role === "owner" ? "Owner"
            : user.role === "admin" ? "Administrator"
            : "Member"
          }
        </div>
      </div>

      {/* ── Big save form (profile + all notification prefs) ── */}
      <form onSubmit={save} className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-4`}>
        <h3 className="font-semibold">Profile</h3>
        <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Display name" className={inputCls} />

        {!user.email_enabled && (
          <div className={`text-xs font-semibold text-rose-500 ${darkMode ? "bg-rose-500/10" : "bg-rose-50"} border ${darkMode ? "border-rose-500/20" : "border-rose-100"} rounded-lg px-3 py-2`}>
            ⚠ Email Config Not Enabled — set <code className="font-mono">EMAIL_CONFIG=enabled</code> in <code className="font-mono">.env</code> and restart the backend to use email notifications.
          </div>
        )}

        {/* Master email-on switch. Every notification setting below nests
            under this — when it's off the whole block greys out. */}
        <div className={`flex items-center justify-between gap-3 ${!user.email_enabled ? "opacity-50" : ""}`}>
          <div className="min-w-0">
            <div className="text-sm font-medium">Email notifications</div>
            <div className={`text-xs ${theme.textSubtle} mt-0.5`}>
              Master switch — turn this off to silence every email notification below.
            </div>
          </div>
          <Toggle
            checked={form.notification_email && user.email_enabled}
            onChange={v => {
              if (!user.email_enabled) {
                toast?.("Email is disabled on the server", "warning");
                return;
              }
              setForm({ ...form, notification_email: v });
            }}
            darkMode={darkMode}
          />
        </div>

        {/* Nested notification controls — greyed out when emailOn is false. */}
        <div className={`pl-4 border-l-2 ${darkMode ? "border-slate-700" : "border-slate-200"} space-y-3 ${!emailOn ? "opacity-50 pointer-events-none" : ""}`}>
          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Large transactions"
            hint="Alert when a single expense exceeds your threshold."
            checked={form.notify_large_txn}
            onToggle={v => setForm({ ...form, notify_large_txn: v })}>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${theme.textSubtle}`}>Threshold $</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*"
                className={numCls} value={form.large_txn_threshold}
                onChange={intChange("large_txn_threshold")} />
            </div>
          </NotifRow>

          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Income received"
            hint='Alert when a deposit lands above the threshold ("Congrats You Got Paid!").'
            checked={form.notify_income}
            onToggle={v => setForm({ ...form, notify_income: v })}>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${theme.textSubtle}`}>Threshold $</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*"
                className={numCls} value={form.income_threshold}
                onChange={intChange("income_threshold")} />
            </div>
          </NotifRow>

          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Approaching budget limit"
            hint="Alert when a budget reaches a percentage of its cap."
            checked={form.notify_budget_warning}
            onToggle={v => setForm({ ...form, notify_budget_warning: v })}>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${theme.textSubtle}`}>Warn at</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*"
                className={numCls} value={form.budget_warning_pct}
                onChange={intChange("budget_warning_pct", 99)} />
              <span className={`text-xs ${theme.textSubtle}`}>%</span>
            </div>
          </NotifRow>

          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Budget exceeded"
            hint="Alert when a budget goes over 100%."
            checked={form.notify_budget_exceeded}
            onToggle={v => setForm({ ...form, notify_budget_exceeded: v })} />

          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Goal milestones"
            hint="Alert at 75% progress and when a goal completes."
            checked={form.notify_goal_milestone}
            onToggle={v => setForm({ ...form, notify_goal_milestone: v })} />

          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Bill reminders"
            hint="Remind me before every open bill cycle's due date."
            checked={form.notify_bill_reminders}
            onToggle={v => setForm({ ...form, notify_bill_reminders: v })}>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${theme.textSubtle}`}>Days before</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*"
                className={numCls} value={form.notify_bill_days_before}
                onChange={e => setForm({ ...form, notify_bill_days_before: e.target.value.replace(/\D/g, "").slice(0, 2) || 0 })} />
            </div>
          </NotifRow>

          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Cashflow low-balance warning"
            hint="Project scheduled income + open bill cycles for 30 days. Warn if the low point dips below your minimum."
            checked={form.notify_cashflow_enabled}
            onToggle={v => setForm({ ...form, notify_cashflow_enabled: v })}>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${theme.textSubtle}`}>Minimum $</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*"
                className={numCls} value={form.notify_cashflow_min}
                onChange={e => setForm({ ...form, notify_cashflow_min: e.target.value.replace(/\D/g, "").slice(0, 9) || 0 })} />
            </div>
          </NotifRow>

          {/* Overall budget usage threshold — mirrors the "Budget usage"
              bar on the Budgets tab. Fires once per master period when
              total spend crosses the given % of the basis. */}
          <NotifRow
            theme={theme} darkMode={darkMode} emailOn={emailOn}
            label="Overall budget usage alert"
            hint="Email + in-app alert when your total spending crosses this % of expected income (or current income when none is scheduled). Fires once per budget period."
            checked={form.notify_budget_usage_enabled}
            onToggle={v => setForm({ ...form, notify_budget_usage_enabled: v })}>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${theme.textSubtle}`}>Threshold %</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*"
                className={numCls} value={form.notify_budget_usage_pct}
                onChange={e => setForm({ ...form, notify_budget_usage_pct: e.target.value.replace(/\D/g, "").slice(0, 3) || 90 })} />
            </div>
          </NotifRow>

          {/* Email frequency — not "digest" per request. */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Email frequency</div>
              <div className={`text-xs ${theme.textSubtle} mt-0.5`}>
                When to send the email roll-up.
              </div>
            </div>
            <select className={`${inputCls} max-w-[10rem]`} value={form.email_frequency}
              onChange={e => setForm({ ...form, email_frequency: e.target.value })}>
              <option value="instant">As they happen</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          {form.email_frequency === "weekly" && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium">Weekly send day</div>
              <select className={`${inputCls} max-w-[10rem]`} value={form.email_weekday}
                onChange={e => setForm({ ...form, email_weekday: Number(e.target.value) })}>
                {WEEK_DAYS.map(d => <option key={d.v} value={d.v}>{d.label}</option>)}
              </select>
            </div>
          )}

          {/* "Send sample email" lives on the Admin panel only — it's a
              rate-limited, quota-spending operation that regular members
              don't need access to. */}
        </div>

        {/* Web Push — OS-level notifications on lock screen / notification
            tray. Toggling on triggers the browser's permission prompt +
            registers a per-device push subscription with the backend.
            The bell icon still shows every alert regardless of this
            toggle — it reads directly from the notifications table. */}
        <div className="flex items-center justify-between">
          <div className="min-w-0 pr-3">
            <div className="text-sm font-medium">Push notifications</div>
            <div className={`text-xs ${theme.textSubtle} mt-0.5`}>
              Send alerts to this device's lock screen and notification tray, the moment they happen. When several trigger at once you'll get one summary push (the most urgent one) instead of a wall of banners. In-app bell still shows every alert either way.
              {!pushSupported() && <> · <span className="text-amber-500">Not supported by this browser.</span></>}
            </div>
          </div>
          <Toggle checked={form.notification_push}
            onChange={async (v) => {
              // Optimistically flip the local form so the toggle reflects
              // the user's intent immediately; if the browser prompt is
              // denied, roll back and let the toast explain why.
              setForm(f => ({ ...f, notification_push: v }));
              if (v) {
                const r = await enablePush();
                if (!r.ok) {
                  setForm(f => ({ ...f, notification_push: false }));
                  if (r.reason === "denied") {
                    toast?.("Permission denied — enable in your browser's site settings first", "error");
                  } else if (r.reason === "ios-install-required") {
                    toast?.("On iPhone: tap Share → Add to Home Screen, then enable from there", "error");
                  } else if (r.reason === "no-key") {
                    toast?.("Push not configured on the server (VAPID keys missing)", "error");
                  } else if (r.reason === "unsupported") {
                    toast?.("This browser doesn't support Web Push", "error");
                  } else {
                    toast?.("Couldn't enable push", "error");
                  }
                }
              } else {
                await disablePush();
              }
            }} darkMode={darkMode} />
        </div>
        {/* iOS Safari one-time install hint. Shown only when the user is
            on iOS Safari AND hasn't installed the PWA yet — the two
            preconditions for push not working. Dismissible via toggle
            itself (once installed the check flips false). */}
        {isIosSafariNotInstalled() && (
          <div className={`${darkMode ? "bg-sky-500/10 border-sky-500/30 text-sky-300" : "bg-sky-50 border-sky-200 text-sky-800"} border rounded-xl px-3 py-2 text-xs`}>
            <b>iPhone/iPad:</b> Add Coinvane to your home screen (Share → Add to Home Screen) before enabling push. iOS only delivers Web Push to installed PWAs.
          </div>
        )}


        {/* Manage devices — enrolled push subscriptions per browser/PWA.
            Revoke removes the subscription server-side; the browser side
            is left alone (it'll silently stop receiving). This is the
            "sign out this device from push" surface. */}
        {form.notification_push && (
          <PushDevicesPanel theme={theme} darkMode={darkMode} toast={toast}
            showAdvanced={isDesktop && (user?.role === "admin" || user?.role === "owner")} />
        )}
        {/* Biometric app-lock — mobile only. Rendered here inside the
            notifications block since it's device-scoped like push. */}
        {!isDesktop && (
          <BiometricLockPanel theme={theme} darkMode={darkMode} toast={toast}
            user={user} onUpdate={onUpdate} />
        )}
        {/* No bottom Save button — the sticky bar at the top of the page is
            the single save action whenever the form is dirty. */}
      </form>

      {/* ── Data tools (CSV / PDF) ── */}
      <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-3`}>
        <h3 className="font-semibold">Data</h3>
        <div className="flex flex-wrap gap-2">
          <motion.button whileTap={{ scale: 0.97 }} type="button"
            onClick={async () => {
              try { await api.exportTransactionsCSV(); toast?.("CSV downloaded", "success"); }
              catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
            }}
            className={`text-sm font-medium ${theme.surface} border ${theme.border} px-3 py-2 rounded-xl`}>
            Export transactions (CSV)
          </motion.button>
          <motion.button whileTap={{ scale: 0.97 }} type="button"
            disabled={importingCsv}
            onClick={() => fileInputRef.current?.click()}
            className={`text-sm font-medium ${theme.surface} border ${theme.border} px-3 py-2 rounded-xl disabled:opacity-60`}>
            {importingCsv ? "Importing…" : "Import transactions (CSV)"}
          </motion.button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden"
            onChange={e => { handleCsvFile(e.target.files?.[0]); e.target.value = ""; }} />
          <PdfExportDropdown
            exportingPdf={exportingPdf} setExportingPdf={setExportingPdf}
            theme={theme} darkMode={darkMode} toast={toast} />
        </div>
        <div className={`text-xs ${theme.textSubtle}`}>
          CSV columns: date, merchant, category, amount, account, note, pending.
          On import, the account column is matched to your existing accounts by name; unknown names import as manual rows.
        </div>

        {/* ── Full data backup (.cvn) ─────────────────────────────
            User-owned backup / migration file. Contains every table
            (transactions, categories, budgets, goals, notes, bills,
            loans, assets, reconciliations, investments, automation
            rules, settings + receipt attachments). Excludes account
            identity (email, google_id, role) and per-server state
            (Plaid tokens, push subs, webauthn creds).
            Optional passphrase → AES-256-GCM at rest. */}
        <div className={`border-t ${theme.border} pt-3 mt-3 space-y-2`}>
          <div>
            <div className="text-sm font-semibold">Back up everything (.cvn)</div>
            <div className={`text-xs ${theme.textSubtle}`}>
              Downloads a single <span className="font-mono">.cvn</span> file with your entire Coinvane instance — transactions, budgets, goals, notes, bills, loans, assets, receipts, settings. Portable to another Coinvane server. Sign-in identity, Plaid tokens, and device sessions are deliberately excluded.
            </div>
          </div>
          <BackupExportPanel theme={theme} darkMode={darkMode} toast={toast} />
          <BackupImportPanel theme={theme} darkMode={darkMode} toast={toast} />
        </div>

        {/* ── Quicken / MS Money / Mint migration ── */}
        <div className={`border-t ${theme.border} pt-3 mt-3 space-y-2`}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="text-sm font-semibold">Import from Quicken / MS Money / Mint / bank export</div>
              <div className={`text-xs ${theme.textSubtle}`}>
                Accepts .QIF, .OFX, .QFX, or .MNY (Microsoft Money). Password-locked .mny files are unlocked automatically via sunriise. Leave the picker on <em>auto-detect</em> and Coinvane will prompt you per-account for anything the file names.
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={quickenAccountId} onChange={e => setQuickenAccountId(e.target.value)}
              className={`text-sm ${theme.inputBg} border ${theme.border} px-3 py-2 rounded-xl focus:outline-none focus:border-violet-500`}>
              <option value="">— auto-detect from file —</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>Bind everything to: {a.name}</option>
              ))}
            </select>
            <motion.button whileTap={{ scale: 0.97 }} type="button"
              disabled={importingQuicken}
              onClick={() => quickenInputRef.current?.click()}
              className={`text-sm font-medium ${theme.surface} border ${theme.border} px-3 py-2 rounded-xl disabled:opacity-60`}>
              {importingQuicken ? "Importing…" : "Import QIF / OFX / QFX / MNY"}
            </motion.button>
            <input ref={quickenInputRef} type="file"
              accept=".qif,.ofx,.qfx,.mny,application/x-ofx,application/x-msmoney,text/plain"
              className="hidden"
              onChange={e => { handleQuickenFile(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
      </div>

      <ImportPreviewSheet
        open={!!importPreview}
        preview={importPreview}
        accounts={accounts}
        theme={theme} darkMode={darkMode}
        onClose={() => setImportPreview(null)}
        onConfirm={async (mapping) => {
          const submit = importPreview.onSubmit;
          setImportPreview(null);
          setImportingQuicken(true);
          try { await submit(mapping); }
          finally { setImportingQuicken(false); }
        }} />

      {/* ── Tax categories ── */}
      <TaxCategoriesPanel theme={theme} darkMode={darkMode} toast={toast} />

      {/* ── Custom reports ── */}
      <CustomReportsPanel theme={theme} darkMode={darkMode} toast={toast} />

      {/* ── Sharing (joint accounts) — owner-only ── */}
      {!user?.is_guest_only && (
        <JointSharingSection theme={theme} darkMode={darkMode} user={user} toast={toast} refreshUser={onUpdate} />
      )}

      {/* ── Danger zone ── */}
      <div className={`${theme.surface} border ${darkMode ? "border-rose-500/30" : "border-rose-200"} rounded-2xl p-5 space-y-4`}>
        <h3 className={`font-semibold ${darkMode ? "text-rose-400" : "text-rose-600"}`}>Danger zone</h3>

        <div>
          <div className={`text-xs ${theme.textSubtle} mb-2`}>
            Clearing merchant rules removes every "always categorize X as Y" rule you've set.
            App-shipped defaults (none currently) are preserved.
          </div>
          <motion.button whileTap={{ scale: 0.97 }} type="button"
            onClick={() => setConfirmClear(true)}
            className={`text-sm font-semibold px-3 py-2 rounded-xl ${darkMode ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-rose-50 text-rose-700 border border-rose-200"}`}>
            Clear all merchant rules
          </motion.button>
        </div>

        {/* Clear all data — nuclear. Wipes every user_id-scoped row,
            revokes Plaid, deletes attachments. Requires typing the
            user's email to arm. Uses an inline confirm form rather than
            ConfirmDialog because the typed-email pattern needs the
            control state to live with the button. */}
        <div className={`pt-3 border-t ${darkMode ? "border-rose-500/20" : "border-rose-200"}`}>
          <div className={`text-xs ${theme.textSubtle} mb-2`}>
            <span className={`font-semibold ${darkMode ? "text-rose-400" : "text-rose-600"}`}>Clear all data</span> — deletes every account,
            transaction, budget, goal, note, category, holding, bill, loan, saved
            report, asset, and attachment tied to your login, and revokes every
            Plaid connection. Your login itself stays so you can start fresh.
            This cannot be undone.
          </div>
          {!clearDataOpen ? (
            <motion.button whileTap={{ scale: 0.97 }} type="button"
              onClick={() => { setClearDataOpen(true); setClearDataTyped(""); }}
              className={`text-sm font-semibold px-3 py-2 rounded-xl ${darkMode ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-rose-50 text-rose-700 border border-rose-200"}`}>
              Clear all data…
            </motion.button>
          ) : (
            <div className={`p-3 rounded-xl border ${darkMode ? "bg-rose-500/5 border-rose-500/30" : "bg-rose-50 border-rose-200"} space-y-2`}>
              <div className={`text-xs ${darkMode ? "text-rose-300" : "text-rose-700"}`}>
                Type your email <span className="font-mono font-semibold">{user?.email}</span> to confirm.
              </div>
              <input
                autoFocus
                type="email"
                value={clearDataTyped}
                onChange={e => setClearDataTyped(e.target.value)}
                placeholder={user?.email || "your@email"}
                className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-rose-500`} />
              <div className="flex gap-2">
                <button type="button" onClick={() => { setClearDataOpen(false); setClearDataTyped(""); }}
                  disabled={clearingAllData}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
                  Cancel
                </button>
                <motion.button whileTap={{ scale: 0.97 }} type="button"
                  disabled={clearingAllData || clearDataTyped.trim().toLowerCase() !== String(user?.email || "").toLowerCase()}
                  onClick={async () => {
                    setClearingAllData(true);
                    try {
                      await api.clearMyData(clearDataTyped.trim());
                      toast?.("All data cleared", "success");
                      // Refresh everything so the UI reflects the empty state.
                      // Any in-flight caches on the client stale-out; a
                      // localStorage reset would be more thorough, but the
                      // user might have preferences worth keeping.
                      refreshAll();
                      setClearDataOpen(false);
                      setClearDataTyped("");
                    } catch (e) {
                      toast?.("Failed: " + (e.message || ""), "error");
                    } finally { setClearingAllData(false); }
                  }}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold text-white bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed`}>
                  {clearingAllData ? "Clearing…" : "Yes — clear my data"}
                </motion.button>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onCancel={() => !clearing && setConfirmClear(false)}
        onConfirm={async () => {
          setClearing(true);
          try {
            const r = await api.clearMerchantRules();
            toast?.(`Deleted ${r.deleted} rule${r.deleted === 1 ? "" : "s"}`, "success");
            setConfirmClear(false);
          } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
          finally { setClearing(false); }
        }}
        theme={theme} darkMode={darkMode}
        busy={clearing}
        title="Clear all merchant rules?"
        message="Every per-merchant categorization rule you've created will be removed. Existing transactions keep their current category — only future auto-categorization is affected."
        confirmLabel="Clear rules"
      />
    </div>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────
// ── Biometric app-lock (D12) — mobile-only PWA feature ────────────────────
// Renders a full-screen lock over the entire app until the user unlocks
// with FaceID / TouchID / Windows Hello. Only ever shown when the user
// has biometric_lock_enabled=true AND has at least one enrolled
// credential. Skipped on desktop even if enabled (shouldn't happen —
// the settings toggle is mobile-only — but defensive).
//
// The JWT itself is untouched — an expired session still redirects to
// the normal Google sign-in flow at api/client.js level. This lock is
// purely a client-side reveal gate.
const BIOMETRIC_UNLOCKED_KEY = "coinvane_biometric_unlocked_at";
const BIOMETRIC_IDLE_LOCK_MIN = 5; // re-lock after 5 min hidden
function readUnlockedAt() {
  try { return Number(localStorage.getItem(BIOMETRIC_UNLOCKED_KEY) || 0); }
  catch { return 0; }
}
function writeUnlockedAt(ts) {
  try { localStorage.setItem(BIOMETRIC_UNLOCKED_KEY, String(ts)); } catch { /* noop */ }
}
function LockScreen({ theme, darkMode, onUnlocked, onLogout, userEmail }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const doUnlock = useCallback(async () => {
    setBusy(true); setErr(null);
    const r = await unlockBiometric();
    setBusy(false);
    if (r.ok) {
      writeUnlockedAt(Date.now());
      onUnlocked?.();
    } else if (r.reason === "denied") {
      setErr("Cancelled. Try again.");
    } else {
      setErr("Couldn't verify. Try again or sign out.");
    }
  }, [onUnlocked]);
  // Deliberately do NOT auto-fire the biometric prompt on mount — the
  // WebAuthn spec requires a user activation (tap), and browsers will
  // reject navigator.credentials.get() called from a bare effect with
  // NotAllowedError. The big button below is the entry point.
  return (
    <div className={`fixed inset-0 z-[100] flex items-center justify-center ${darkMode ? "bg-slate-950" : "bg-slate-50"} safe-pt safe-pb px-6`}>
      <div className="w-full max-w-xs text-center space-y-6">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-violet-500 flex items-center justify-center text-white text-2xl font-bold">$</div>
        <div>
          <div className={`text-2xl font-bold ${theme.text}`}>Coinvane locked</div>
          <div className={`text-sm ${theme.textSubtle} mt-1`}>
            Signed in as <span className="font-medium">{userEmail || "you"}</span>
          </div>
        </div>
        <button type="button" onClick={doUnlock} disabled={busy}
          className="w-full py-3 rounded-2xl bg-violet-500 text-white font-semibold text-sm shadow-lg shadow-violet-500/30 disabled:opacity-60">
          {busy ? "Verifying…" : `Unlock with ${biometricMethodName()}`}
        </button>
        {err && <div className="text-xs text-rose-500">{err}</div>}
        <button type="button" onClick={onLogout}
          className={`text-xs ${theme.textSubtle} hover:text-rose-500`}>
          Sign out instead
        </button>
      </div>
    </div>
  );
}

// ── Admin broadcast banner (D4) ────────────────────────────────────────────
// Desktop-only yellow slip pinned below the top header. Fetches active
// broadcasts on mount and every 5 minutes (cheap read, keeps a maintenance
// notice fresh without needing a page reload). Per-user dismiss is stored
// in localStorage as a set of ids — deliberately not persisted server-side
// because it's ephemeral UI state and a device swap re-showing an active
// broadcast is fine.
const BROADCAST_DISMISS_KEY = "coinvane_dismissed_broadcasts";
function readDismissed() {
  try {
    const raw = localStorage.getItem(BROADCAST_DISMISS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch { return new Set(); }
}
function writeDismissed(set) {
  try { localStorage.setItem(BROADCAST_DISMISS_KEY, JSON.stringify(Array.from(set))); }
  catch { /* localStorage disabled — banner just re-shows next load */ }
}
function BroadcastBanner({ theme, darkMode }) {
  const [items, setItems] = useState([]);
  const [dismissed, setDismissed] = useState(() => readDismissed());
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await api.myBroadcasts();
        if (!cancelled) setItems(Array.isArray(rows) ? rows : []);
      } catch { /* silently no-op — banner is opportunistic */ }
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  const visible = items.filter(b => !dismissed.has(Number(b.id)));
  if (!visible.length) return null;
  const dismiss = (id) => {
    const next = new Set(dismissed);
    next.add(Number(id));
    writeDismissed(next);
    setDismissed(next);
  };
  const stylesForSeverity = (sev) => {
    if (sev === "critical") {
      return darkMode
        ? { bg: "bg-rose-500/10 border-rose-500/40", text: "text-rose-300", icon: "text-rose-400" }
        : { bg: "bg-rose-50 border-rose-300", text: "text-rose-800", icon: "text-rose-600" };
    }
    if (sev === "warning") {
      return darkMode
        ? { bg: "bg-amber-500/10 border-amber-500/40", text: "text-amber-200", icon: "text-amber-400" }
        : { bg: "bg-amber-50 border-amber-300", text: "text-amber-900", icon: "text-amber-600" };
    }
    return darkMode
      ? { bg: "bg-sky-500/10 border-sky-500/40", text: "text-sky-200", icon: "text-sky-400" }
      : { bg: "bg-sky-50 border-sky-300", text: "text-sky-900", icon: "text-sky-600" };
  };
  return (
    <div className="hidden lg:block">
      {visible.map(b => {
        const s = stylesForSeverity(b.severity);
        const Icon = b.severity === "critical" ? AlertCircle
                  : b.severity === "warning"  ? AlertCircle
                  :                              Info;
        return (
          <div key={b.id}
            className={`border-b ${s.bg} ${s.text} px-4 py-2.5 flex items-start gap-3 text-sm`}>
            <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${s.icon}`} />
            <div className="flex-1 whitespace-pre-wrap break-words">{b.message}</div>
            <button type="button" onClick={() => dismiss(b.id)}
              className={`${s.text} opacity-60 hover:opacity-100 transition-opacity flex-shrink-0`}
              aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Shell({ user, onLogout, refreshUser }) {
  const [tab, setTab] = useState("dashboard");
  const [prevTab, setPrevTab] = useState("dashboard");
  const [darkMode, setDarkModeLocal] = useState(!!user?.dark_mode);
  const [syncing, setSyncing] = useState(false);
  const isDesktop = useIsDesktop();
  // Biometric lock — mobile only, activates on cold start when the
  // user has biometric_lock_enabled + at least one enrolled credential
  // + WebAuthn is supported by the browser. Desktop skips entirely
  // (matches the settings toggle's mobile-only visibility).
  //
  // Fresh mount ALWAYS locks (matches "closed the app, reopening now"
  // expectation). The 5-min idle window only applies to in-session
  // visibility flips — a reload / cold start / PWA restart is treated
  // as a new session and needs re-auth regardless of timing.
  const [locked, setLocked] = useState(() => {
    if (isDesktop || !webauthnSupported()) return false;
    if (!user?.biometric_lock_enabled) return false;
    return true;
  });
  useEffect(() => {
    if (isDesktop || !webauthnSupported() || !user?.biometric_lock_enabled) return;
    // Re-lock when the user comes back to a tab that's been hidden
    // for at least BIOMETRIC_IDLE_LOCK_MIN minutes. Applications get
    // suspended in iOS PWAs, so this is the primary re-lock trigger.
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const last = readUnlockedAt();
      if (!last || (Date.now() - last) >= BIOMETRIC_IDLE_LOCK_MIN * 60 * 1000) {
        setLocked(true);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [isDesktop, user?.biometric_lock_enabled]);
  const toast = useToast();
  const { refreshAll, loading, summary, accounts, assets } = useData();
  const theme = darkMode ? DARK : LIGHT;

  // Trigger a Plaid sync from the header. Enqueues a worker job; data
  // appears after the worker completes (~5-30 sec depending on bank).
  const syncBanks = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.syncPlaid();
      toast?.("Sync queued — refreshing in a moment", "success");
      setTimeout(() => refreshAll(), 2000);
    } catch (e) {
      toast?.("Sync failed: " + (e.message || ""), "error");
    } finally {
      // Keep the spinning indicator for a moment so the user sees feedback
      setTimeout(() => setSyncing(false), 1500);
    }
  }, [syncing, refreshAll, toast]);

  // Keep local state in sync if user is refreshed from server
  useEffect(() => { setDarkModeLocal(!!user?.dark_mode); }, [user?.dark_mode]);

  // If the user previously enabled push and permission is still
  // granted, re-POST the current subscription on load so the backend
  // has the freshest endpoint (browsers rotate them). No prompt.
  useEffect(() => { if (user?.id) resurrectPushIfEnabled(); }, [user?.id]);

  // Sync-on-open: trigger a Plaid sync when the app is opened / brought
  // back to focus, guarded to at most once every 30 minutes per browser
  // profile so tab-switching doesn't burn API calls. Only fires when the
  // user actually has ≥ 1 Plaid-linked account — no point enqueueing a
  // sweep for a manual-only user.
  //
  // Plaid billing note (PAYG): /transactions/sync is priced per-connection
  // per-month for most contracts, not per-call, so the 30-minute floor is
  // conservative — but on strict per-call plans it caps to at most 48
  // calls/day. On Growth/Scale committed contracts this is a no-op cost.
  useEffect(() => {
    if (!user?.id) return;
    const hasPlaid = (accounts || []).some(a => !!a.plaidItemId);
    if (!hasPlaid) return;
    const KEY = "coinvane_last_auto_sync";
    const MIN_INTERVAL_MS = 30 * 60 * 1000;
    const shouldSync = () => {
      const last = Number(localStorage.getItem(KEY) || 0);
      return !last || Date.now() - last >= MIN_INTERVAL_MS;
    };
    const maybeSync = async () => {
      if (!shouldSync()) return;
      try {
        localStorage.setItem(KEY, String(Date.now())); // stamp FIRST to defeat races
        await api.syncPlaid();
        setTimeout(() => refreshAll(), 3000);
      } catch { /* silent — header sync button still works */ }
    };
    maybeSync();
    // Also re-check on tab focus (browser was in background for hours).
    const onFocus = () => { maybeSync(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [user?.id, accounts, refreshAll]);

  // Privacy mode — adds a class to <body> so a CSS rule in index.css can
  // blur every element marked .private-amount. Toggle reveals on hover.
  useEffect(() => {
    if (user?.privacy_mode) document.body.classList.add("privacy-on");
    else document.body.classList.remove("privacy-on");
    return () => document.body.classList.remove("privacy-on");
  }, [user?.privacy_mode]);

  // Global keyboard shortcuts (Stage 4a, desktop only).
  //   n         → jump to Transactions and open the new-txn sheet
  //   /         → focus the header search (if the current tab has one)
  //   [ / ]     → prev / next month on the dashboard KPI
  //   Esc       → close any open sheet (framer-motion Sheet listens itself)
  // Skipped when the user is typing in an input/textarea/select so the
  // key press doesn't fight actual data entry.
  useEffect(() => {
    const isEditable = (el) => {
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(document.activeElement)) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setTab("transactions");
        // Broadcast so TransactionsTab can pop its add sheet.
        window.dispatchEvent(new CustomEvent("coinvane:new-txn"));
      } else if (e.key === "/") {
        e.preventDefault();
        const el = document.querySelector('input[type="search"], input[placeholder*="Search"i]');
        if (el) el.focus();
      } else if (e.key === "[" || e.key === "]") {
        window.dispatchEvent(new CustomEvent("coinvane:month-shift", { detail: { dir: e.key === "]" ? 1 : -1 } }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Persist dark mode change to backend so it follows you across devices
  const setDarkMode = useCallback(async (v) => {
    setDarkModeLocal(v); // optimistic
    try {
      await api.updateMe({ dark_mode: v });
      refreshUser?.();
    } catch {
      setDarkModeLocal(!v); // revert on error
      toast?.("Failed to save preference", "error");
    }
  }, [refreshUser, toast]);

  const TAB_ORDER = ["dashboard","accounts","transactions","investments","budgets","goals","notes","settings","admin"];
  const direction = TAB_ORDER.indexOf(tab) - TAB_ORDER.indexOf(prevTab);
  const navigate = (t) => { setPrevTab(tab); setTab(t); };

  const NAV_TABS = [
    { id: "dashboard",    label: "Home",     icon: Home        },
    { id: "transactions", label: "Activity", icon: Receipt     },
    { id: "budgets",      label: "Budgets",  icon: PieChartIcon },
    { id: "goals",        label: "Goals",    icon: Target      },
    { id: "settings",     label: "Settings", icon: Settings    },
  ];
  const ALL_TABS = [
    { id: "dashboard",    label: "Dashboard",    icon: Home        },
    { id: "accounts",     label: "Accounts",     icon: CreditCard  },
    { id: "transactions", label: "Transactions", icon: Receipt     },
    { id: "investments",  label: "Investments",  icon: TrendingUp  },
    { id: "budgets",      label: "Budgets",      icon: PieChartIcon },
    { id: "bills",        label: "Bills",        icon: Calendar    },
    { id: "goals",        label: "Goals",        icon: Target      },
    { id: "notes",        label: "Notes",        icon: FileText    },
    { id: "settings",     label: "Settings",     icon: Settings    },
    // Automations sits below Settings per user spec. Available to every
    // user (per-user rules); mobile shows a "set up on desktop" notice
    // instead of the editor, but rules still fire for mobile users once
    // authored on desktop.
    { id: "automations",  label: "Automations",  icon: Sparkles    },
    // Admin sits AFTER Automations so the dropdown reads
    // Settings → Automations → Admin. Both 'owner' and 'admin' get the
    // Admin tab; the owner has elevated controls inside the panel.
    ...((user.role === "admin" || user.role === "owner") ? [{ id: "admin", label: "Admin", icon: Users }] : []),
  ];
  const TITLES = { dashboard:"Overview", accounts:"Accounts", transactions:"Transactions", investments:"Investments", budgets:"Budgets", bills:"Bills", goals:"Goals", notes:"Notes", automations:"Automations", admin:"Admin", settings:"Settings" };
  const mainTabs = ALL_TABS.slice(0, 7);
  const moreTabs = ALL_TABS.slice(7);
  const net = Number(summary?.netWorth || 0);

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} font-sans transition-colors`}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif' }}>

      {/* Biometric lock overlays the entire app when active. Renders
          at the very top of Shell so nothing behind it can be tapped.
          Signing out from the lock screen falls back to the standard
          logout flow (drops the JWT + shows Google sign-in). */}
      {locked && (
        <LockScreen theme={theme} darkMode={darkMode}
          userEmail={user?.email}
          onUnlocked={() => setLocked(false)}
          onLogout={onLogout} />
      )}

      {/* ── Desktop nav ── */}
      <nav className={`hidden lg:block ${theme.surface} border-b ${theme.border} sticky top-0 z-20`}>
        <div className="px-6 py-3 flex items-center justify-between max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-8">
            <button onClick={() => navigate("dashboard")} className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-violet-500 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-white" />
              </div>
              <span className="font-bold text-lg">Coinvane</span>
            </button>
            <div className="flex items-center gap-1">
              {mainTabs.map(t => (
                <button key={t.id} onClick={() => navigate(t.id)}
                  className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${tab === t.id ? (darkMode ? "text-violet-400" : "text-violet-700") : `${theme.textMuted} ${theme.hover}`}`}>
                  {tab === t.id && (
                    <motion.div layoutId="desktopTabBg"
                      className={`absolute inset-0 rounded-lg ${darkMode ? "bg-violet-500/15" : "bg-violet-50"}`}
                      transition={{ type: "spring", damping: 25, stiffness: 300 }} />
                  )}
                  <t.icon className="w-4 h-4 relative" />
                  <span className="relative">{t.label}</span>
                </button>
              ))}
              {moreTabs.length > 0 && (
                <MoreMenu tabs={moreTabs} activeTab={tab} setTab={navigate} theme={theme} darkMode={darkMode} />
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <JointContextDropdown theme={theme} darkMode={darkMode} user={user} />
            <IconButton theme={theme} onClick={refreshAll}>
              <RefreshCw className={`w-5 h-5 ${theme.textMuted} ${loading ? "animate-spin" : ""}`} />
            </IconButton>
            <NotificationsBell theme={theme} darkMode={darkMode} />
            <IconButton theme={theme} onClick={onLogout}>
              <LogOut className={`w-5 h-5 ${theme.textMuted}`} />
            </IconButton>
          </div>
        </div>
      </nav>

      {/* ── Mobile sticky frosted nav (iOS style) ── */}
      <div className={`lg:hidden sticky top-0 z-30 backdrop-blur-xl ${darkMode ? "bg-slate-950/70" : "bg-white/70"} border-b ${darkMode ? "border-slate-800/40" : "border-slate-200/50"}`}>
        {/* Dynamic Island spacer — env(safe-area-inset-top) on iPhone 15+ */}
        <div className="safe-pt" style={{ paddingTop: "max(env(safe-area-inset-top), 12px)" }}>
          <div className="px-4 h-14 flex items-center justify-between">
            <button onClick={() => navigate("dashboard")} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-violet-500 flex items-center justify-center shadow-sm shadow-violet-500/40">
                <DollarSign className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-sm">Coinvane</span>
            </button>
            <div className="flex items-center gap-0.5">
              <IconButton theme={theme} onClick={() => navigate("investments")}>
                <TrendingUp className={`w-5 h-5 ${theme.textMuted}`} />
              </IconButton>
              <IconButton theme={theme} onClick={() => navigate("bills")}>
                <Calendar className={`w-5 h-5 ${theme.textMuted}`} />
              </IconButton>
              {user?.plaid_enabled !== false && (
                <IconButton theme={theme} onClick={syncBanks}>
                  <RefreshCw className={`w-5 h-5 ${theme.textMuted} ${syncing ? "animate-spin" : ""}`} />
                </IconButton>
              )}
              <NotificationsBell theme={theme} darkMode={darkMode} />
              <IconButton theme={theme} onClick={onLogout}><LogOut className={`w-5 h-5 ${theme.textMuted}`} /></IconButton>
            </div>
          </div>
        </div>
      </div>

      {/* Admin broadcast banner — desktop only, sits below the header
          and above all content. Renders nothing when no active broadcasts. */}
      <BroadcastBanner theme={theme} darkMode={darkMode} />

      {/* ── Mobile large iOS-style title (scrolls with content) ── */}
      <div className="lg:hidden px-4 pt-4 pb-1">
        <AnimatePresence mode="wait">
          <motion.h1 key={tab} initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
            exit={{ y: -16, opacity: 0 }} transition={{ duration: 0.22 }}
            className="text-[32px] leading-none font-bold tracking-tight">
            {TITLES[tab]}
          </motion.h1>
        </AnimatePresence>
      </div>

      {/* ── Body ── */}
      <div className="flex max-w-screen-2xl mx-auto">

        {/* ── Sidebar ── */}
        <aside className={`hidden lg:flex flex-col w-72 p-4 border-r ${theme.border} ${theme.surface} min-h-[calc(100vh-57px)] sticky top-[57px]`}>
          <div className="mb-6 p-2 rounded-xl cursor-default">
            <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1`}>Net Worth</div>
            <div className="text-2xl font-bold private-amount" tabIndex={0}>
              <AnimatedNumber value={net} format={fmt} />
            </div>
          </div>
          <SidebarGroup type="cash"       label="Cash"         icon={Wallet}      accounts={accounts} theme={theme} />
          <SidebarGroup type="credit"     label="Credit Cards" icon={CreditCard}  accounts={accounts} theme={theme} />
          <SidebarGroup type="investment" label="Investments"  icon={TrendingUp}  accounts={accounts} theme={theme} />
          <SidebarGroup type="loan"       label="Loans"        icon={Building2}   accounts={accounts} theme={theme} />
          <SidebarGroup label="Assets" icon={Car} theme={theme}
            items={(assets || []).map(a => ({
              id: a.id, name: a.name,
              // Use the asset kind as the "institution" subtitle so the
              // sidebar row looks like an account row.
              institution: (ASSET_KINDS.find(k => k.code === a.kind) || {}).label || "Asset",
              balance: Number(a.currentValue) || 0,
            }))} />
          <div className="mt-auto">
            <PlaidLinkButton onSuccess={refreshAll} full />
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="flex-1 min-w-0 pb-[calc(96px+env(safe-area-inset-bottom))] lg:pb-8 overflow-hidden">
          <div className="p-4 sm:p-6">
            {/* Plain-div tab switcher — DELIBERATELY no AnimatePresence.
                Root cause of "delete budget → other tabs blank until F5"
                (confirmed with DOM + React DevTools):
                  1. Delete triggers refreshAll's 14 setState cascade
                  2. That cascade races with the outgoing tab's exit
                     animation and corrupts framer-motion's animation
                     queue for THAT motion.div
                  3. The exit animation reaches its end state
                     (opacity: 0, translateX(28px)) but its
                     onAnimationComplete callback never fires
                  4. mode="wait" AnimatePresence therefore never
                     unmounts the outgoing tab, and never mounts the
                     destination — OverviewTab literally isn't in the
                     component tree until a full reload rebuilds the
                     AnimatePresence subtree
                Removing the tab-switch animation eliminates the
                failure surface entirely. React unmounts + mounts
                instantly on `tab` change. Trade: no horizontal slide
                between tabs. Feels like a normal SPA click. */}
            <div key={tab}>
              {tab === "dashboard"    && <OverviewTab      theme={theme} darkMode={darkMode} onNavigate={navigate} />}
              {tab === "accounts"     && <AccountsTab      theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "transactions" && <TransactionsTab  theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "investments"  && <InvestmentsTab   theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "budgets"      && <BudgetsTab       theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "bills"        && <BillsTab         theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "goals"        && <GoalsTab         theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "notes"        && <NotesTab         theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "admin"        && <UsersPanel       currentUser={user} theme={theme} darkMode={darkMode} toast={toast} />}
              {tab === "settings"     && <SettingsPanel    user={user} onUpdate={refreshUser} theme={theme} darkMode={darkMode} onToggleDark={setDarkMode} />}
              {tab === "automations"  && <AutomationsPanel theme={theme} darkMode={darkMode} toast={toast} />}
            </div>
          </div>
        </main>
      </div>

      {/* ── Mobile bottom nav (frosted, safe-area aware) ── */}
      <div className={`lg:hidden fixed bottom-0 left-0 right-0 z-40 backdrop-blur-xl ${darkMode ? "bg-slate-950/80" : "bg-white/80"} border-t ${darkMode ? "border-slate-800/50" : "border-slate-200/60"}`}>
        <div className="flex items-stretch px-1">
          {NAV_TABS.map(t => {
            const active = tab === t.id;
            return (
              <motion.button key={t.id} onClick={() => navigate(t.id)} whileTap={{ scale: 0.85 }}
                className="flex-1 flex flex-col items-center justify-center gap-1 pt-2 pb-1.5 relative">
                {active && (
                  <motion.div layoutId="mobileTabDot"
                    className="absolute top-0 w-10 h-[3px] bg-violet-500 rounded-full"
                    transition={{ type: "spring", damping: 30, stiffness: 400 }} />
                )}
                <motion.div animate={{ y: active ? -1 : 0, scale: active ? 1.08 : 1 }}
                  transition={{ type: "spring", damping: 20, stiffness: 300 }}>
                  <t.icon className={`w-[26px] h-[26px] ${active ? "text-violet-500" : theme.textSubtle}`} strokeWidth={active ? 2.4 : 1.9} />
                </motion.div>
                <span className={`text-[10px] font-semibold tracking-wide ${active ? "text-violet-500" : theme.textSubtle}`}>{t.label}</span>
              </motion.button>
            );
          })}
        </div>
        <div className="safe-h-bottom" />
      </div>
    </div>
  );
}

// ─── Microsoft Sign-In redirect landing page ─────────────────────────────────
// After msal.loginRedirect(), the browser navigates to Microsoft, the user
// signs in, then Microsoft redirects back to /auth#code=<...>&state=<...>.
// This component runs when we detect that URL shape, calls MSAL's
// handleRedirectPromise to exchange the code for an ID token (using PKCE
// state MSAL stashed in localStorage before the redirect), then hands the
// ID token to our backend for the standard find-or-create + JWT dance.
// ─── Joint invite redemption screen ───────────────────────────────────────────
// Handles /#joint-invite?t=<token> URLs from the invitation email. If the
// user isn't signed in yet, we surface the sign-in screen with a hint
// message; the sign-in flow itself creates the users row (as is_guest_only
// if the email isn't on the allowlist) and auto-accepts the invitation.
// If the user IS signed in, we POST /joint/accept, then switch context
// to the owner and reload.
function JointInviteScreen({ token, isSignedIn, onDone }) {
  const [status, setStatus] = useState(isSignedIn ? "accepting" : "signin");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!isSignedIn) return;
    (async () => {
      try {
        const r = await api.jointAccept(token);
        setContextUserId(r.owner_user_id);
        setStatus("done");
        setTimeout(() => window.location.replace("/"), 400);
      } catch (e) {
        setErr(e.message || "Could not accept this invitation.");
        setStatus("error");
      }
    })();
  }, [isSignedIn, token]);
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-violet-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8 text-center">
        <div className="w-11 h-11 rounded-xl bg-violet-500 flex items-center justify-center shadow-sm shadow-violet-500/40 mx-auto mb-4">
          <DollarSign className="w-6 h-6 text-white" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">Joint account invitation</h1>
        {status === "signin" && (
          <>
            <p className="text-sm text-slate-600 mb-4">Sign in with the invited email to accept.</p>
            <button onClick={() => { onDone(); window.location.hash = ""; }}
              className="w-full py-2.5 rounded-full bg-violet-500 text-white text-sm font-semibold">
              Go to sign in
            </button>
            <p className="text-[11px] text-slate-400 mt-3">Link expires in 7 days.</p>
          </>
        )}
        {status === "accepting" && (
          <p className="text-sm text-slate-600">Accepting your invitation…</p>
        )}
        {status === "done" && (
          <p className="text-sm text-emerald-600">Accepted — switching context…</p>
        )}
        {status === "error" && (
          <>
            <p className="text-sm text-rose-600 mb-3">{err}</p>
            <button onClick={() => { window.location.replace("/"); }}
              className="text-sm text-slate-600 underline">Go home</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Joint context dropdown ───────────────────────────────────────────────────
// Rendered in the Shell header when the user has ≥1 accessible context
// beyond their own (or is a guest-only user). Switching context stamps
// the id in localStorage and reloads so every downstream fetch picks
// it up cleanly (no per-component refetch coordination).
function JointContextDropdown({ theme, darkMode, user }) {
  const [contexts, setContexts] = useState([]);
  const [open, setOpen] = useState(false);
  const current = getContextUserId();
  useEffect(() => {
    api.jointListContexts().then(r => setContexts(r.contexts || [])).catch(() => setContexts([]));
  }, []);
  // Hide when there's nothing to switch to.
  if (contexts.length <= 1 && !user?.is_guest_only) return null;
  const active = contexts.find(c => (current == null && c.role === "owner") || c.user_id === current)
    || contexts[0];
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium ${theme.surface} border ${theme.border}`}>
        <Users className={`w-3.5 h-3.5 ${theme.textMuted}`} />
        <span className="truncate max-w-[140px]">{active?.label || "My data"}</span>
        <ChevronDown className={`w-3 h-3 ${theme.textSubtle}`} />
      </button>
      {open && (
        <div className={`absolute right-0 mt-1.5 w-64 z-50 rounded-xl ${theme.surface} border ${theme.border} shadow-lg overflow-hidden`}>
          {contexts.map(c => {
            const isActive = (current == null && c.role === "owner") || c.user_id === current;
            return (
              <button key={c.user_id} onClick={() => {
                setContextUserId(c.role === "owner" ? null : c.user_id);
                window.location.replace("/");
              }}
                className={`w-full text-left px-3 py-2.5 text-xs flex items-center justify-between hover:bg-violet-500/10 ${isActive ? "bg-violet-500/10" : ""}`}>
                <div className="min-w-0">
                  <div className={`font-medium truncate ${isActive ? "text-violet-500" : ""}`}>{c.label}</div>
                  <div className={`text-[10px] ${theme.textSubtle} truncate`}>{c.role}{c.email ? ` · ${c.email}` : ""}</div>
                </div>
                {isActive && <CheckCircle2 className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Sharing settings section (owner-only, joint_enabled gated) ───────────────
// Owner enables the whole feature via a toggle at the top. Once
// enabled, they can invite emails, edit permissions, revoke shares,
// and see the audit log inline. Guests never see this section.
function JointSharingSection({ theme, darkMode, user, toast, refreshUser }) {
  const [enabling, setEnabling] = useState(false);
  const [shares, setShares] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [auditRows, setAuditRows] = useState([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePerm, setInvitePerm] = useState("editor");
  const [inviting, setInviting] = useState(false);
  const load = async () => {
    try {
      const r = await api.jointListShares();
      setShares(r.shares || []); setInvitations(r.invitations || []); setAuditRows(r.audit || []);
    } catch { /* section is hidden when disabled; ignore */ }
  };
  useEffect(() => { if (user?.joint_enabled) load(); }, [user?.joint_enabled]);
  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-violet-500`;

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-4`}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Sharing (joint accounts)</h3>
          <p className={`text-xs ${theme.textSubtle} mt-0.5`}>Invite people by email to view or edit your instance.</p>
        </div>
        <button
          disabled={enabling}
          onClick={async () => {
            setEnabling(true);
            try {
              await api.jointToggle(!user.joint_enabled);
              await refreshUser?.();
              toast?.(!user.joint_enabled ? "Sharing enabled" : "Sharing disabled", "success");
            } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
            finally { setEnabling(false); }
          }}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${user.joint_enabled ? "bg-rose-500/10 text-rose-500" : "bg-violet-500 text-white"}`}>
          {user.joint_enabled ? "Disable" : "Enable"}
        </button>
      </div>

      {user.joint_enabled && (
        <>
          {/* ── Invite form ── */}
          <form onSubmit={async (e) => {
            e.preventDefault();
            if (inviting) return;
            const email = inviteEmail.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast?.("Enter a valid email", "error"); return; }
            setInviting(true);
            try {
              const r = await api.jointInvite(email, invitePerm);
              toast?.(r.email_sent ? `Invitation sent to ${email}` : `Invitation created (email is disabled — share the link manually)`, "success");
              setInviteEmail(""); await load();
            } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
            finally { setInviting(false); }
          }} className="flex items-end gap-2">
            <div className="flex-1">
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1 block`}>Invite by email</label>
              <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                placeholder="partner@example.com" className={inputCls} type="email" />
            </div>
            <select value={invitePerm} onChange={e => setInvitePerm(e.target.value)}
              className={`px-2.5 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm`}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" disabled={inviting}
              className="px-4 py-2 rounded-xl bg-violet-500 text-white text-sm font-semibold disabled:opacity-50">
              Invite
            </button>
          </form>

          {/* ── Active shares (allowlist) ── */}
          <div>
            <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>Shared users ({shares.length})</div>
            {shares.length === 0 && <p className={`text-xs ${theme.textSubtle}`}>No shared users yet.</p>}
            <div className="space-y-2">
              {shares.map(s => (
                <div key={s.id} className={`flex items-center justify-between p-3 rounded-xl border ${theme.border}`}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{s.guest_name || s.guest_email}</div>
                    <div className={`text-[11px] ${theme.textSubtle} truncate`}>
                      {s.guest_email}{s.is_guest_only ? " · guest-only" : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select value={s.permissions}
                      onChange={async e => {
                        try { await api.jointUpdatePermissions(s.id, e.target.value); toast?.("Permissions updated", "success"); await load(); }
                        catch (err) { toast?.("Failed: " + (err.message || ""), "error"); }
                      }}
                      className={`text-xs px-2 py-1 ${theme.inputBg} border ${theme.border} rounded-lg`}>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Remove ${s.guest_email}'s access?`)) return;
                        try { await api.jointRevokeShare(s.id); toast?.("Access removed", "success"); await load(); }
                        catch (err) { toast?.("Failed: " + (err.message || ""), "error"); }
                      }}
                      className="text-[11px] px-2 py-1 rounded-lg text-rose-500 hover:bg-rose-500/10">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Pending invitations ── */}
          {invitations.length > 0 && (
            <div>
              <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>Pending invitations ({invitations.length})</div>
              <div className="space-y-2">
                {invitations.map(inv => (
                  <div key={inv.id} className={`flex items-center justify-between p-3 rounded-xl border ${theme.border}`}>
                    <div className="min-w-0">
                      <div className="text-sm truncate">{inv.invitee_email}</div>
                      <div className={`text-[11px] ${theme.textSubtle}`}>
                        {inv.permissions} · expires {new Date(inv.expires_at).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        try { await api.jointRevokeInvitation(inv.id); toast?.("Invitation revoked", "success"); await load(); }
                        catch (err) { toast?.("Failed: " + (err.message || ""), "error"); }
                      }}
                      className="text-[11px] px-2 py-1 rounded-lg text-rose-500 hover:bg-rose-500/10">
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Audit log (inline per user's spec) ── */}
          <div>
            <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>Audit log</div>
            {auditRows.length === 0 && <p className={`text-xs ${theme.textSubtle}`}>No shared activity yet.</p>}
            <div className={`max-h-64 overflow-y-auto rounded-xl border ${theme.border} divide-y ${theme.divide}`}>
              {auditRows.map(a => (
                <div key={a.id} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate">
                      <span className="font-medium">{a.actor_name || a.actor_email}</span>
                      <span className={`ml-1.5 ${theme.textSubtle}`}>{a.action}{a.target_type ? ` · ${a.target_type}${a.target_id ? "#" + a.target_id : ""}` : ""}</span>
                    </div>
                  </div>
                  <div className={`text-[10px] ${theme.textSubtle} flex-shrink-0`}>{new Date(a.at).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MsRedirectScreen() {
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.publicConfig();
        if (!cfg.microsoftClientId) {
          throw new Error("Microsoft Sign-In is not configured on the server");
        }
        const { PublicClientApplication } = await import("@azure/msal-browser");
        // Config must match the loginRedirect call byte-for-byte — MSAL
        // uses these to locate the state it stashed before redirect.
        // Authority + redirectUri MUST match the config used at
        // loginRedirect time byte-for-byte, or MSAL can't locate the
        // state it stashed in localStorage. Both come from public-
        // config so both sides read from the same source of truth.
        const msal = new PublicClientApplication({
          auth: {
            clientId: cfg.microsoftClientId,
            authority: `https://login.microsoftonline.com/${cfg.microsoftTenant || "common"}`,
            redirectUri: cfg.microsoftRedirectUri || (window.location.origin + "/auth"),
            // MSAL v3 defaults this to true — after handleRedirectPromise
            // processes the response it navigates the browser back to
            // whatever URL was active when loginRedirect was called (in
            // our case "/"). That would happen BEFORE our code can hand
            // the ID token to the backend, so the sign-in silently
            // never completes. Turning it off lets our own code decide
            // when to navigate (which we do at the end of the flow).
            navigateToLoginRequestUrl: false,
          },
          cache: { cacheLocation: "localStorage" },
        });
        await msal.initialize();
        const result = await msal.handleRedirectPromise();
        if (cancelled) return;
        if (!result?.idToken) {
          throw new Error("Microsoft sign-in did not return an ID token");
        }
        const res = await api.microsoftLogin(result.idToken);
        setToken(res.token);
        // Full page reload wipes the /auth#code=... URL and re-mounts
        // App, which now sees the JWT in localStorage and drops into
        // the authed shell.
        window.location.replace("/");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[MS Redirect]", e);
        if (!cancelled) {
          setError(e?.errorMessage || e?.message || "Microsoft sign-in failed");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-violet-900 flex items-center justify-center p-4 safe-pt safe-pb">
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", damping: 20, stiffness: 200 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8 text-center space-y-5"
      >
        <div className="w-11 h-11 mx-auto rounded-xl bg-violet-500 flex items-center justify-center shadow-sm shadow-violet-500/40">
          <DollarSign className="w-6 h-6 text-white" />
        </div>
        {error ? (
          <>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Microsoft sign-in failed</h1>
              <p className="text-sm text-rose-600 mt-2 break-words">{error}</p>
            </div>
            <button type="button"
              onClick={() => { window.location.replace("/"); }}
              className="w-full py-3 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600">
              Back to sign-in
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              className="w-8 h-8 rounded-full border-2 border-slate-200 border-t-violet-500" />
            <div className="text-sm text-slate-600">Completing Microsoft sign-in…</div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// ─── Logout landing page ──────────────────────────────────────────────────────
// Registered as the Front-channel logout URL on the Entra app so
// Microsoft can hit /logout in a hidden iframe / redirect during a
// global sign-out. Also usable directly if the user pastes /logout
// into their address bar. Clears our session synchronously on mount
// and shows a friendly confirmation.
function LogoutScreen() {
  useEffect(() => {
    try { setToken(null); } catch { /* localStorage disabled — non-fatal */ }
  }, []);
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-violet-900 flex items-center justify-center p-4 safe-pt safe-pb">
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", damping: 20, stiffness: 200 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8 text-center space-y-5"
      >
        <div className="w-11 h-11 mx-auto rounded-xl bg-violet-500 flex items-center justify-center shadow-sm shadow-violet-500/40">
          <DollarSign className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">You've been signed out</h1>
          <p className="text-sm text-slate-600 mt-2">
            Your Coinvane session on this device has ended.
          </p>
        </div>
        <button type="button"
          onClick={() => { window.location.replace("/"); }}
          className="w-full py-3 rounded-xl text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600">
          Sign back in
        </button>
      </motion.div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const auth = useAuth();
  // /logout is a real path (SPA fallback in nginx serves index.html for
  // it, then this branch renders LogoutScreen). Kept out of the auth
  // check so an already-signed-out user landing here still sees the
  // confirmation instead of being bounced to the sign-in page.
  if (typeof window !== "undefined" && window.location.pathname === "/logout") {
    return <LogoutScreen />;
  }
  // /auth with an MSAL response fragment: Microsoft has redirected the
  // browser back to us after sign-in. Bypass the normal auth check and
  // let MsRedirectScreen finish the code-for-token exchange before
  // hitting our backend. Matches ?code=… or #code=… (MSAL v3 defaults
  // to fragment mode for SPA registrations).
  if (typeof window !== "undefined"
      && window.location.pathname === "/auth"
      && /[#?&](code|error)=/.test(window.location.hash + window.location.search)) {
    return <MsRedirectScreen />;
  }
  // /#joint-invite?t=<token> — invitation redemption from the email.
  // Signed-in users accept immediately; signed-out users see a prompt
  // to sign in first (the sign-in flow then auto-accepts).
  if (typeof window !== "undefined") {
    const m = /^#joint-invite\?t=([^&]+)/.exec(window.location.hash);
    if (m) {
      const token = decodeURIComponent(m[1]);
      // Strip the token from the URL so it doesn't linger in history.
      try { window.history.replaceState(null, "", window.location.pathname); } catch { /* ok */ }
      // Stash so we can pick it up after sign-in.
      try { sessionStorage.setItem("coinvane_joint_invite_token", token); } catch { /* ok */ }
    }
  }
  const pendingInvite = (() => {
    try { return sessionStorage.getItem("coinvane_joint_invite_token"); } catch { return null; }
  })();
  // Only render the accept flow AFTER the user is signed in. Signed-
  // out users fall through to AuthScreen; once they sign in, the
  // sessionStorage token is picked up here on re-render and the
  // acceptance completes automatically.
  if (pendingInvite && !auth.loading && auth.user) {
    return <JointInviteScreen
      token={pendingInvite}
      isSignedIn={true}
      onDone={() => {
        try { sessionStorage.removeItem("coinvane_joint_invite_token"); } catch { /* ok */ }
      }}
    />;
  }
  if (auth.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}
          className="w-8 h-8 rounded-full border-2 border-violet-200 border-t-violet-500" />
      </div>
    );
  }
  if (!auth.user) {
    return <AuthScreen onAuth={auth} />;
  }
  return (
    <ToastProvider>
      <DataProvider enabled={!!auth.user}>
        <Shell user={auth.user} onLogout={auth.logout} refreshUser={auth.refresh} />
      </DataProvider>
    </ToastProvider>
  );
}
