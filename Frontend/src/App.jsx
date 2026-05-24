import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence, animate as framerAnimate } from "framer-motion";
import {
  Home, Receipt, PieChart as PieChartIcon, Target, TrendingUp, FileText,
  Settings, Bell, Search, X, RefreshCw, LogOut, Users,
  Wallet, CreditCard, Building2, DollarSign, ArrowUpRight,
  Repeat, Utensils, Car, ShoppingBag, Heart, Briefcase, Coffee,
  Film, Zap, GraduationCap, Gift, Music, Book, Plane,
  ChevronDown, Check, Trash2, Shield, AlertCircle, AlertTriangle,
  Pin, Calendar, Link2, Mail, CheckCircle2, Plus
} from "lucide-react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, Tooltip,
} from "recharts";
import { usePlaidLink } from "react-plaid-link";
import { useAuth } from "./hooks/useAuth.js";
import { DataProvider, useData } from "./context/DateContext.jsx";
import { api } from "./api/client.js";

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
      <div className={`text-xl font-bold ${negative ? "text-rose-500" : ""}`}>
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
  const [linkToken, setLinkToken] = useState(
    PLAID_OAUTH_RETURN ? sessionStorage.getItem("plaid_link_token") : null
  );
  const [tokenError, setTokenError] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const autoOpenedRef = useRef(false);

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

  // Initial token fetch (skip if we're already on the OAuth return path)
  useEffect(() => {
    if (!PLAID_OAUTH_RETURN && !linkToken) fetchToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { open, ready, error: plaidError } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri: PLAID_OAUTH_RETURN ? window.location.href : undefined,
    onSuccess: async (public_token, metadata) => {
      setExchanging(true);
      try {
        await api.exchangePublicToken(public_token, metadata);
        sessionStorage.removeItem("plaid_link_token");
        toast?.(`Connected ${metadata?.institution?.name || "your bank"} successfully`, "success");
        // Refetch a fresh token in case user wants to link another bank
        fetchToken();
        onSuccess?.();
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

  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={click}
      disabled={exchanging}
      className={`flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white text-sm font-semibold shadow-sm shadow-emerald-500/30 transition-colors disabled:opacity-60 ${
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
  );
}

// ─── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const btnRef = useRef(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!CLIENT_ID) {
      setErr("Google Sign-In is not configured — set VITE_GOOGLE_CLIENT_ID in .env and rebuild.");
      return;
    }

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
        client_id: CLIENT_ID,
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
  }, [CLIENT_ID, onAuth]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-emerald-900 flex items-center justify-center p-4 safe-pt safe-pb">
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", damping: 20, stiffness: 200 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8"
      >
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-xl bg-emerald-500 flex items-center justify-center shadow-sm shadow-emerald-500/40">
            <DollarSign className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Ledger</h1>
            <p className="text-sm text-slate-500">Self-hosted personal finance</p>
          </div>
        </div>

        <div className="space-y-5">
          <p className="text-sm text-slate-600 text-center">
            Sign in with your Google account to continue.
          </p>
          <div className="flex justify-center min-h-[44px] items-center">
            {busy ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                  className="w-4 h-4 rounded-full border-2 border-slate-200 border-t-emerald-500" />
                Signing you in…
              </div>
            ) : (
              <div ref={btnRef} />
            )}
          </div>
          {err && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 p-3 rounded-xl">
              {err}
            </div>
          )}
          <p className="text-[11px] text-slate-400 text-center pt-2 leading-relaxed">
            Your Google account is only used to identify you. No financial data is shared with Google.
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
                    className="text-xs text-emerald-500 font-medium">Mark all read</button>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className={`px-4 py-8 text-center text-sm ${theme.textSubtle}`}>No notifications</div>
              ) : (
                <div className={`divide-y ${theme.divide}`}>
                  {notifications.map(n => (
                    <div key={n.id} className={`px-4 py-3 ${!n.readAt ? (darkMode ? "bg-emerald-500/10" : "bg-emerald-50/50") : ""}`}>
                      <div className="text-sm font-medium">{n.title}</div>
                      {n.body && <div className={`text-xs ${theme.textMuted} mt-0.5`}>{n.body}</div>}
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
          active ? (darkMode ? "text-emerald-400" : "text-emerald-700") : `${theme.textMuted} ${theme.hover}`
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
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm ${theme.hover} ${activeTab === t.id ? "text-emerald-500 font-semibold" : ""}`}>
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
function SidebarGroup({ type, label, icon: Icon, accounts, theme }) {
  const visible = accounts.filter(a => a.type === type);
  if (!visible.length) return null;
  const total = visible.reduce((s, a) => s + Number(a.balance), 0);
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${theme.textSubtle}`} />
          <span className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider`}>{label}</span>
        </div>
        <span className={`text-sm font-semibold ${total < 0 ? "text-rose-500" : ""}`}>{fmt(total)}</span>
      </div>
      <div className="space-y-0.5">
        {visible.map(acc => (
          <div key={acc.id} className={`w-full flex items-center justify-between p-2 rounded-md ${theme.hover}`}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{acc.name}</div>
              <div className={`text-xs ${theme.textSubtle} truncate`}>{acc.institution}</div>
            </div>
            <span className={`text-sm font-semibold ml-2 flex-shrink-0 ${Number(acc.balance) < 0 ? "text-rose-500" : ""}`}>
              {fmtShort(Number(acc.balance))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Net Worth Chart (with WTD/MTD/YTD/1M/3M/1Y/ALL selector) ────────────────
const NET_PERIODS = [
  { id: "wtd", label: "WTD" },
  { id: "mtd", label: "MTD" },
  { id: "ytd", label: "YTD" },
  { id: "1m",  label: "1M"  },
  { id: "3m",  label: "3M"  },
  { id: "1y",  label: "1Y"  },
  { id: "all", label: "ALL" },
];

function NetWorthChart({ theme, darkMode, variant = "hero" }) {
  // variant "hero"  → mobile-style gradient card
  // variant "card"  → desktop surface card
  const [range, setRange] = useState("mtd");
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
                ? (isHero ? "bg-white text-emerald-700" : "bg-emerald-500 text-white")
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
      <div className="relative rounded-3xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 p-5 text-white shadow-xl shadow-emerald-500/30 overflow-hidden">
        <div className="relative">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] opacity-90">Net Worth</div>
          <div className="text-[40px] leading-none font-bold mt-1.5 tracking-tight">
            <AnimatedNumber value={last} format={fmt} />
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <div className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-white/25 backdrop-blur-sm">
              <ArrowUpRight className={`w-3.5 h-3.5 ${deltaUp ? "" : "rotate-90"}`} />
              {deltaUp ? "+" : ""}{fmtShort(delta)}
            </div>
            <span className="text-xs opacity-85">over {range.toUpperCase()}</span>
          </div>
        </div>
        <div className="relative h-24 -mx-5 -mb-5 mt-4">
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
          <div className="text-3xl font-bold mt-1">
            <AnimatedNumber value={last} format={fmt} />
          </div>
          <div className={`text-xs mt-1 flex items-center gap-1.5 ${deltaUp ? "text-emerald-500" : "text-rose-500"}`}>
            <ArrowUpRight className={`w-3.5 h-3.5 ${deltaUp ? "" : "rotate-90"}`} />
            <span className="font-semibold">{deltaUp ? "+" : ""}{fmt(delta)}</span>
            <span className={theme.textSubtle}>over {range.toUpperCase()}</span>
          </div>
        </div>
        {chips}
      </div>
      <div className="h-52">
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

// ─── Mobile Spending Pulse (Mint signature card) ──────────────────────────────
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
          <div className="text-2xl font-bold mt-1">
            <AnimatedNumber value={thisSpend} format={fmt} />
          </div>
        </div>
        {top.length > 0 && (
          <div className={`flex items-center gap-0.5 text-xs font-semibold px-2 py-1 rounded-full ${
            down ? (darkMode ? "bg-emerald-500/15 text-emerald-400" : "bg-emerald-50 text-emerald-700")
                 : (darkMode ? "bg-rose-500/15 text-rose-400" : "bg-rose-50 text-rose-700")
          }`}>
            <ArrowUpRight className={`w-3 h-3 ${down ? "rotate-90" : ""}`} />
            {down ? "" : "+"}{fmtShort(delta)}
          </div>
        )}
      </div>

      {top.length > 0 ? (
        <>
          <div className={`flex h-2.5 rounded-full overflow-hidden ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
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
                <span className="font-semibold">{fmtShort(c.value)}</span>
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
              <div className={`text-xs mt-0.5 ${theme.textMuted}`}>{ins.body}</div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ theme, darkMode, onNavigate }) {
  const { summary, cashflow, byCategory, transactions, budgets } = useData();
  const net  = Number(summary?.netWorth   || 0);
  const cash = Number(summary?.cash       || 0);
  const cred = Number(summary?.credit     || 0);
  const inv  = Number(summary?.investment || 0);

  const cf = cashflow.map(c => ({
    month: (c.month || "").slice(5) || c.month,
    income: Number(c.income), spending: Number(c.spending),
  }));
  const COLORS = ["#10b981","#f59e0b","#8b5cf6","#3b82f6","#ec4899","#64748b"];
  const catData = byCategory.slice(0, 6).map((c, i) => ({
    name: c.category, value: Number(c.total), color: COLORS[i] || "#94a3b8",
  }));
  const tipStyle = { borderRadius: "12px", border: `1px solid ${theme.tooltipBorder}`, backgroundColor: theme.tooltipBg, color: darkMode ? "#f1f5f9" : "#0f172a" };

  return (
    <motion.div initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.06 } } }} className="space-y-4 lg:space-y-6">

      {/* Net Worth hero — mobile (interactive chart with period selector) */}
      <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="lg:hidden">
        <NetWorthChart theme={theme} darkMode={darkMode} variant="hero" />
      </motion.div>

      {/* Net Worth chart — desktop (card with period selector) */}
      <div className="hidden lg:block">
        <NetWorthChart theme={theme} darkMode={darkMode} variant="card" />
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

      {/* Charts — desktop only (mobile gets Spending Pulse instead) */}
      <div className="hidden lg:grid lg:grid-cols-3 gap-4">
        <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
          className={`lg:col-span-2 ${theme.surface} rounded-2xl border ${theme.border} p-5`}>
          <div className="mb-4">
            <h3 className="font-semibold">Cashflow</h3>
            <p className={`text-xs ${theme.textSubtle}`}>Last 12 months</p>
          </div>
          {cf.length > 0 ? (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={cf}>
                  <defs>
                    <linearGradient id="gInc" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gSpd" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke={theme.chartAxis} />
                  <YAxis tick={{ fontSize: 11 }} stroke={theme.chartAxis} tickFormatter={fmtShort} />
                  <Tooltip contentStyle={tipStyle} formatter={v => fmt(v)} />
                  <Area type="monotone" dataKey="income"   stroke="#10b981" fill="url(#gInc)" strokeWidth={2} />
                  <Area type="monotone" dataKey="spending" stroke="#f43f5e" fill="url(#gSpd)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className={`h-52 flex items-center justify-center text-sm ${theme.textSubtle}`}>
              Connect a bank to see cashflow data
            </div>
          )}
        </motion.div>

        <motion.div variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}
          className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
          <h3 className="font-semibold mb-4">Spending by category</h3>
          {catData.length > 0 ? (
            <>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={35} outerRadius={62} paddingAngle={2}>
                      {catData.map((c, i) => <Cell key={i} fill={c.color} />)}
                    </Pie>
                    <Tooltip contentStyle={tipStyle} formatter={v => fmt(v)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-2 mt-3">
                {catData.slice(0, 4).map(c => (
                  <div key={c.name} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: c.color }} />
                      <span className={theme.textMuted}>{c.name}</span>
                    </span>
                    <span className="font-semibold">{fmt(c.value)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className={`flex items-center justify-center h-52 text-sm ${theme.textSubtle}`}>No spending data yet</div>
          )}
        </motion.div>
      </div>

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
          <button onClick={() => onNavigate("transactions")} className="text-xs font-medium text-emerald-500">View all →</button>
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
                  <div className="font-medium text-sm truncate">{t.merchant}</div>
                  <div className={`text-xs ${theme.textSubtle}`}>{t.date} · {t.category}</div>
                </div>
                <div className={`font-semibold text-sm ${Number(t.amount) >= 0 ? "text-emerald-500" : ""}`}>
                  {Number(t.amount) >= 0 ? "+" : "−"}{fmt(Math.abs(Number(t.amount)))}
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

// ─── Accounts Tab ─────────────────────────────────────────────────────────────
function AccountsTab({ theme, darkMode, toast }) {
  const { accounts, refreshAll } = useData();
  const [syncing, setSyncing] = useState(false);
  const [items, setItems] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", type: "cash", subtype: "", balance: "", institution: "" });
  const [adding, setAdding] = useState(false);

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
      });
      toast?.("Account added", "success");
      setShowAdd(false);
      setAddForm({ name: "", type: "cash", subtype: "", balance: "", institution: "" });
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

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`;
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
          <motion.button whileTap={{ scale: 0.97 }} onClick={sync} disabled={syncing}
            className={`flex items-center gap-2 px-4 py-2 ${theme.surface} border ${theme.border} rounded-xl text-sm font-medium disabled:opacity-50`}>
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} /> Sync
          </motion.button>
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
                    <div className="font-medium text-sm truncate">{item.institutionName || "Bank"}</div>
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
                    <div className="font-semibold text-sm">{a.name}</div>
                    <div className={`text-xs ${theme.textSubtle}`}>{a.institution || "Manual"}</div>
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
              <div className={`text-2xl font-bold ${Number(a.balance) < 0 ? "text-rose-500" : ""}`}>
                {fmt(Math.abs(Number(a.balance)))}
              </div>
              <div className="flex items-center justify-between mt-2">
                {a.lastSyncAt ? (
                  <div className={`text-xs ${theme.textSubtle} flex items-center gap-1`}>
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                    Synced {new Date(a.lastSyncAt).toLocaleString()}
                  </div>
                ) : <div />}
                {!a.plaidItemId && (
                  <button onClick={() => removeAccount(a)}
                    className={`text-xs ${theme.textSubtle} hover:text-rose-500 transition-colors`}>
                    Delete
                  </button>
                )}
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
              <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Balance</label>
              <input type="number" step="0.01" required value={addForm.balance}
                onChange={e => setAddForm({ ...addForm, balance: e.target.value })}
                placeholder="0.00" className={inputCls} />
            </div>
          </div>
          <p className={`text-xs ${theme.textSubtle}`}>
            Manual accounts won't auto-sync. Update the balance and add transactions yourself.
          </p>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setShowAdd(false)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
              Cancel
            </button>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={adding}
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Adding…" : "Add account"}
            </motion.button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}

// ─── Transactions Tab ─────────────────────────────────────────────────────────
function TransactionsTab({ theme, darkMode, toast }) {
  const { transactions, accounts, categories, refreshAll } = useData();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [catFilter, setCatFilter] = useState("");      // category filter
  const [acctFilter, setAcctFilter] = useState("all"); // account filter (id | "all")
  const [sort, setSort] = useState("date_desc");       // sort key
  const [detail, setDetail] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    date: today, merchant: "", amount: "", category: "Other",
    account_id: "", note: "", sign: "out",
  });
  const [adding, setAdding] = useState(false);

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

  // ── Filter + sort pipeline ─────────────────────────────────────
  const filtered = useMemo(() => {
    let rows = transactions.filter(t => {
      if (search) {
        const q = search.toLowerCase();
        if (!(t.merchant || "").toLowerCase().includes(q) &&
            !(t.category || "").toLowerCase().includes(q)) return false;
      }
      if (catFilter && t.category !== catFilter) return false;
      if (acctFilter !== "all" && String(t.accountId) !== String(acctFilter)) return false;
      return true;
    });
    const cmp = {
      date_desc:  (a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id,
      date_asc:   (a, b) => (a.date || "").localeCompare(b.date || "") || a.id - b.id,
      amount_asc: (a, b) => Number(a.amount) - Number(b.amount), // most negative first → biggest expense
      amount_desc:(a, b) => Number(b.amount) - Number(a.amount), // most positive first → biggest income
    }[sort] || ((a, b) => 0);
    return [...rows].sort(cmp);
  }, [transactions, search, catFilter, acctFilter, sort]);

  // Group by date for the rendered list. Order of groups follows the sort.
  const grouped = useMemo(() => {
    const groups = [];
    let currentKey = null;
    for (const t of filtered) {
      const k = t.date || "—";
      if (k !== currentKey) {
        groups.push({ date: k, items: [] });
        currentKey = k;
      }
      groups[groups.length - 1].items.push(t);
    }
    return groups;
  }, [filtered]);

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

  const groupTotal = (items) =>
    items.reduce((s, t) => s + Number(t.amount), 0);

  // Group accounts by institution for the filter dropdown
  const accountsByBank = useMemo(() => {
    const map = new Map();
    for (const a of accounts) {
      const bank = a.institution || "Manual";
      if (!map.has(bank)) map.set(bank, []);
      map.get(bank).push(a);
    }
    return [...map.entries()];
  }, [accounts]);

  const activeFilterCount = (catFilter ? 1 : 0) + (acctFilter !== "all" ? 1 : 0) + (sort !== "date_desc" ? 1 : 0);

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
      });
      toast?.("Transaction added", "success");
      setShowAdd(false);
      setForm({ date: today, merchant: "", amount: "", category: "Other", account_id: "", note: "", sign: "out" });
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setAdding(false); }
  };

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`;
  const catList = (categories && categories.length > 0)
    ? categories.map(c => c.name)
    : Object.keys(CAT_COLORS);

  return (
    <div className="space-y-3">
      {/* Search + filters + add */}
      <div className="flex items-center gap-2">
        <div className={`flex items-center gap-3 px-4 py-2.5 ${theme.surface} border ${theme.border} rounded-xl flex-1`}>
          <Search className={`w-4 h-4 ${theme.textSubtle} flex-shrink-0`} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search transactions…"
            className={`flex-1 bg-transparent text-sm focus:outline-none ${theme.text}`} />
          {search && (
            <button onClick={() => setSearch("")}><X className={`w-4 h-4 ${theme.textSubtle}`} /></button>
          )}
        </div>
        <motion.button whileTap={{ scale: 0.94 }} onClick={() => setShowFilters(!showFilters)}
          className={`relative p-2.5 rounded-xl border ${theme.border} ${theme.surface} flex-shrink-0`}>
          <Settings className={`w-5 h-5 ${activeFilterCount > 0 ? "text-emerald-500" : theme.textSubtle}`} />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </motion.button>
        <motion.button whileTap={{ scale: 0.94 }} onClick={() => setShowAdd(true)}
          className="bg-emerald-500 hover:bg-emerald-600 text-white p-2.5 rounded-xl shadow-sm shadow-emerald-500/30 flex-shrink-0">
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
                  </select>
                </div>
              </div>
              {activeFilterCount > 0 && (
                <button onClick={() => { setCatFilter(""); setAcctFilter("all"); setSort("date_desc"); }}
                  className={`text-xs font-medium ${theme.textSubtle} hover:text-emerald-500`}>
                  Clear filters
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Grouped transaction list */}
      {grouped.length === 0 ? (
        <div className={`${theme.surface} rounded-2xl border ${theme.border} px-5 py-12 text-center text-sm ${theme.textSubtle}`}>
          {search || activeFilterCount > 0
            ? "No matching transactions"
            : "No transactions yet — connect a bank to get started."}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(group => {
            const total = groupTotal(group.items);
            return (
              <div key={group.date}>
                <div className="flex items-center justify-between px-1 pb-1.5">
                  <div className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider`}>
                    {fmtGroupDate(group.date)}
                  </div>
                  <div className={`text-[11px] font-semibold ${total >= 0 ? "text-emerald-500" : theme.textSubtle}`}>
                    {total >= 0 ? "+" : "−"}{fmt(Math.abs(total))}
                  </div>
                </div>
                <div className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
                  {group.items.map((t, i) => {
                    const Icon = CAT_ICONS[t.category] || Briefcase;
                    const color = CAT_COLORS[t.category] || "#64748b";
                    return (
                      <motion.button key={t.id}
                        whileTap={{ scale: 0.985 }}
                        onClick={() => setDetail(t)}
                        className={`w-full flex items-center gap-3 px-4 py-3 text-left ${i < group.items.length - 1 ? `border-b ${theme.border}` : ""} ${theme.hover} transition-colors`}>
                        <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                          <Icon className="w-4 h-4" style={{ color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{t.merchant}</div>
                          <div className={`text-xs ${theme.textSubtle} truncate`}>{t.category} · {t.accountName || "—"}</div>
                        </div>
                        <div className={`font-semibold text-sm flex-shrink-0 ${Number(t.amount) >= 0 ? "text-emerald-500" : ""}`}>
                          {Number(t.amount) >= 0 ? "+" : "−"}{fmt(Math.abs(Number(t.amount)))}
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
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${form.sign === "in" ? (darkMode ? "bg-slate-900 shadow text-emerald-400" : "bg-white shadow text-emerald-600") : theme.textMuted}`}>
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
            <input required value={form.merchant} onChange={e => setForm({ ...form, merchant: e.target.value })}
              placeholder="Whole Foods" className={inputCls} />
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
          <div>
            <label className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-1.5 block`}>Account</label>
            <select value={form.account_id} onChange={e => setForm({ ...form, account_id: e.target.value })}
              className={inputCls}>
              <option value="">— No account —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.institution ? ` · ${a.institution}` : ""}</option>)}
            </select>
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
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Adding…" : "Add transaction"}
            </motion.button>
          </div>
        </form>
      </Sheet>

      {/* Transaction detail / delete sheet */}
      <Sheet open={!!detail} onClose={() => setDetail(null)} title="Transaction" theme={theme}>
        {detail && (() => {
          const Icon = CAT_ICONS[detail.category] || Briefcase;
          const color = CAT_COLORS[detail.category] || "#64748b";
          const isIncome = Number(detail.amount) >= 0;
          return (
            <div className="space-y-4">
              <div className="flex flex-col items-center text-center py-4">
                <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-3 ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                  <Icon className="w-7 h-7" style={{ color }} />
                </div>
                <div className="text-xl font-semibold">{detail.merchant}</div>
                <div className={`text-3xl font-bold mt-2 ${isIncome ? "text-emerald-500" : ""}`}>
                  {isIncome ? "+" : "−"}{fmt(Math.abs(Number(detail.amount)))}
                </div>
              </div>
              <div className={`${darkMode ? "bg-slate-800/50" : "bg-slate-50"} rounded-2xl divide-y ${theme.divide}`}>
                <DetailRow label="Date"     value={detail.date} theme={theme} />
                <DetailRow label="Category" value={detail.category} theme={theme} />
                <DetailRow label="Account"  value={detail.accountName || "—"} theme={theme} />
                {detail.note && <DetailRow label="Note" value={detail.note} theme={theme} />}
              </div>
              {detail.plaidItemId && (
                <p className={`text-xs ${theme.textSubtle} text-center`}>
                  This is a synced transaction. Deleting it here won't remove it from your bank.
                </p>
              )}
              <motion.button whileTap={{ scale: 0.97 }} onClick={deleteTransaction} disabled={deleting}
                className="w-full bg-rose-500 hover:bg-rose-600 text-white py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
                <Trash2 className="w-4 h-4" />
                {deleting ? "Deleting…" : "Delete transaction"}
              </motion.button>
            </div>
          );
        })()}
      </Sheet>
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

// ─── Budgets Tab ──────────────────────────────────────────────────────────────
const BUDGET_PERIODS = [
  { id: "weekly",      label: "Weekly",       desc: "Resets every Sunday" },
  { id: "biweekly",    label: "Bi-weekly",    desc: "Resets every 2 weeks" },
  { id: "semimonthly", label: "Twice a month",desc: "Resets on the 1st & 15th" },
  { id: "monthly",     label: "Monthly",      desc: "Resets on the 1st" },
  { id: "yearly",      label: "Yearly",       desc: "Resets January 1" },
  { id: "custom",      label: "Custom…",      desc: "Choose your own interval" },
];

function fmtPeriodLabel(period, days) {
  if (period === "custom" && days) return `Every ${days}d`;
  return BUDGET_PERIODS.find(p => p.id === period)?.label || "Monthly";
}

function BudgetsTab({ theme, darkMode, toast }) {
  const { budgets, categories, accounts, refreshAll } = useData();
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    kind: "category",   // "category" or "creditcard"
    category: "",
    custom: "",
    accountId: "",
    amount: "",
    period: "monthly",
    periodDays: 30,
    periodStart: new Date().toISOString().slice(0, 10),
  });

  const isCustomCat = form.category === "__custom__";
  const isCustomPeriod = form.period === "custom";
  const isCC = form.kind === "creditcard";

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

  const resetForm = () => setForm({
    kind: "category", category: "", custom: "", accountId: "",
    amount: "", period: "monthly", periodDays: 30,
    periodStart: new Date().toISOString().slice(0, 10),
  });

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
      setShowAdd(false);
      resetForm();
      refreshAll();
    } catch (e) {
      toast?.("Failed: " + (e.message || ""), "error");
    } finally { setAdding(false); }
  };

  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className={`text-sm ${theme.textSubtle}`}>
          {budgets.length} budget{budgets.length !== 1 ? "s" : ""}
        </p>
        <motion.button whileTap={{ scale: 0.95 }} onClick={() => setShowAdd(true)}
          className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5 shadow-sm shadow-emerald-500/30">
          <Plus className="w-4 h-4" /> New Budget
        </motion.button>
      </div>

      {budgets.length === 0 ? (
        <div className={`${theme.surface} border-2 border-dashed ${darkMode ? "border-slate-700" : "border-slate-300"} rounded-2xl p-12 text-center`}>
          <PieChartIcon className={`w-12 h-12 ${theme.textSubtle} mx-auto mb-3`} />
          <p className={`${theme.textMuted} mb-4 text-sm`}>
            No budgets yet. Track spending by category or cap credit-card usage.
          </p>
          <motion.button whileTap={{ scale: 0.97 }} onClick={() => setShowAdd(true)}
            className="bg-emerald-500 text-white px-4 py-2 rounded-xl text-sm font-semibold">
            Create your first budget
          </motion.button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {budgets.map(b => {
            const pct = Math.min(100, (Number(b.spent) / Number(b.amount)) * 100);
            const over = pct >= 100;
            const isCardBudget = !!b.accountId;
            const displayName = isCardBudget
              ? (b.accountName || "Credit Card")
              : b.category;
            const Icon = isCardBudget ? CreditCard : (CAT_ICONS[b.category] || Briefcase);
            const color = isCardBudget ? "#f43f5e" : (CAT_COLORS[b.category] || "#64748b");
            return (
              <motion.div key={b.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                className={`${theme.surface} border ${theme.border} rounded-2xl p-5`}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}20` }}>
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-sm truncate">{displayName}</div>
                      <div className={`text-[11px] ${theme.textSubtle} flex items-center gap-1.5 mt-0.5`}>
                        <span>{fmtPeriodLabel(b.period, b.period_days || b.periodDays)}</span>
                        {isCardBudget && <span className="text-rose-500">· Card usage</span>}
                      </div>
                    </div>
                  </div>
                  <button onClick={async () => {
                    if (!window.confirm(`Delete budget "${displayName}"?`)) return;
                    await api.deleteBudget(b.id); refreshAll(); toast?.("Budget removed");
                  }}>
                    <Trash2 className={`w-4 h-4 ${theme.textSubtle} hover:text-rose-500 transition-colors`} />
                  </button>
                </div>
                <div className={`flex justify-between text-sm mb-2 ${theme.textMuted}`}>
                  <span>{fmt(b.spent)}</span>
                  <span className="font-medium">{fmt(b.amount)}</span>
                </div>
                <ProgressBar value={pct} color={over ? "bg-rose-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"} darkMode={darkMode} />
                {over
                  ? <div className="text-xs text-rose-500 mt-1.5 font-medium">Over by {fmt(Number(b.spent) - Number(b.amount))}</div>
                  : <div className={`text-xs ${theme.textSubtle} mt-1.5`}>{fmt(Number(b.amount) - Number(b.spent))} left</div>
                }
              </motion.div>
            );
          })}
        </div>
      )}

      {/* New budget sheet */}
      <Sheet open={showAdd} onClose={() => { setShowAdd(false); resetForm(); }} title="New Budget" theme={theme}>
        <form onSubmit={submit} className="space-y-4">
          {/* Kind toggle */}
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Type</label>
            <div className={`flex p-1 rounded-xl ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
              <button type="button" onClick={() => setForm({ ...form, kind: "category" })}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${
                  !isCC ? (darkMode ? "bg-slate-900 shadow text-emerald-400" : "bg-white shadow text-emerald-600") : theme.textMuted
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

          {/* Target picker */}
          {isCC ? (
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

          {/* Period */}
          <div>
            <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Reset every</label>
            <div className="grid grid-cols-2 gap-2">
              {BUDGET_PERIODS.map(p => {
                const active = form.period === p.id;
                return (
                  <button type="button" key={p.id} onClick={() => setForm({ ...form, period: p.id })}
                    className={`px-3 py-2 rounded-xl text-xs font-semibold text-left border transition ${
                      active
                        ? (darkMode ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" : "border-emerald-500 bg-emerald-50 text-emerald-700")
                        : `${theme.border} ${theme.textMuted}`
                    }`}>
                    <div>{p.label}</div>
                    <div className={`text-[10px] font-normal mt-0.5 ${active ? "" : theme.textSubtle}`}>{p.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {isCustomPeriod && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Every N days</label>
                <input type="number" min="1" step="1" required value={form.periodDays}
                  onChange={e => setForm({ ...form, periodDays: e.target.value })}
                  className={inputCls} />
              </div>
              <div>
                <label className={`text-[11px] font-semibold ${theme.textSubtle} uppercase tracking-wider block mb-1.5`}>Starting on</label>
                <input type="date" required value={form.periodStart}
                  onChange={e => setForm({ ...form, periodStart: e.target.value })}
                  className={inputCls} />
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => { setShowAdd(false); resetForm(); }}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
              Cancel
            </button>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={adding}
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Saving…" : "Create budget"}
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
  const { goals, refreshAll } = useData();
  const [form, setForm] = useState({ name: "", target: "", saved: "" });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.createGoal({ name: form.name, target: Number(form.target), saved: Number(form.saved || 0) });
      setForm({ name: "", target: "", saved: "" }); refreshAll();
      toast?.("Goal created", "success");
    } catch { toast?.("Failed to create goal", "error"); }
  };
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className={`${theme.surface} border ${theme.border} rounded-2xl p-4 flex flex-wrap gap-2`}>
        <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
          placeholder="Goal name" required
          className={`flex-1 min-w-40 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`} />
        <input type="number" value={form.target} onChange={e => setForm({ ...form, target: e.target.value })}
          placeholder="Target" required
          className={`w-32 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`} />
        <input type="number" value={form.saved} onChange={e => setForm({ ...form, saved: e.target.value })}
          placeholder="Saved"
          className={`w-32 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`} />
        <motion.button whileTap={{ scale: 0.97 }} type="submit"
          className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-semibold">Add</motion.button>
      </form>
      <div className="grid md:grid-cols-2 gap-4">
        {goals.map((g, i) => {
          const pct = Math.min(100, (Number(g.saved) / Number(g.target)) * 100);
          const bg = GOAL_COLORS[i % GOAL_COLORS.length];
          return (
            <motion.div key={g.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className={`${theme.surface} border ${theme.border} rounded-2xl p-5`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center`}>
                    <Target className="w-5 h-5 text-white" />
                  </div>
                  <div className="font-semibold">{g.name}</div>
                </div>
                <button onClick={async () => { await api.deleteGoal(g.id); refreshAll(); toast?.("Goal deleted"); }}>
                  <Trash2 className={`w-4 h-4 ${theme.textSubtle} hover:text-rose-500 transition-colors`} />
                </button>
              </div>
              <div className={`flex justify-between text-sm mb-2 ${theme.textMuted}`}>
                <span>{fmt(g.saved)}</span>
                <span className="font-medium">{fmt(g.target)}</span>
              </div>
              <ProgressBar value={pct} color={bg} darkMode={darkMode} />
              <div className={`flex items-center justify-between mt-2`}>
                <span className={`text-xs ${theme.textSubtle}`}>{Math.round(pct)}% complete</span>
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
    </div>
  );
}

// ─── Investments Tab ──────────────────────────────────────────────────────────
function InvestmentsTab({ theme, darkMode }) {
  const { holdings, investSummary } = useData();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard label="Total Value"    value={investSummary?.total || 0} icon={Briefcase}  color="sky"     theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Total Gain/Loss" value={investSummary?.gain || 0} icon={TrendingUp}  color="emerald" theme={theme} darkMode={darkMode} onClick={() => {}} />
        <KpiCard label="Holdings"       value={holdings.length}           icon={Target}      color="amber"   theme={theme} darkMode={darkMode} format={n => Math.round(n).toString()} onClick={() => {}} />
      </div>
      <div className={`${theme.surface} rounded-2xl border ${theme.border} overflow-hidden`}>
        <div className={`px-5 py-4 border-b ${theme.border}`}><h3 className="font-semibold">Holdings</h3></div>
        {holdings.length === 0 ? (
          <div className={`px-5 py-12 text-center text-sm ${theme.textSubtle}`}>
            No holdings — connect a brokerage account via Plaid.
          </div>
        ) : holdings.map((h, i) => {
          const gain = Number(h.value) - (Number(h.costBasis) * Number(h.quantity) || 0);
          return (
            <div key={h.id} className={`flex items-center justify-between px-5 py-3.5 ${i < holdings.length - 1 ? `border-b ${theme.border}` : ""}`}>
              <div>
                <div className="font-semibold text-sm">{h.ticker || "—"}</div>
                <div className={`text-xs ${theme.textSubtle}`}>{h.securityName}</div>
              </div>
              <div className="text-right">
                <div className="font-semibold text-sm">{fmt(h.value)}</div>
                <div className={`text-xs ${gain >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                  {gain >= 0 ? "+" : ""}{fmt(gain)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
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
          className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`} />
        <textarea value={form.content} onChange={e => setForm({ ...form, content: e.target.value })}
          placeholder="Content" rows={3}
          className={`w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500 resize-none`} />
        <motion.button whileTap={{ scale: 0.97 }} type="submit"
          className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-semibold">Save note</motion.button>
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

// ─── Users Panel ──────────────────────────────────────────────────────────────
function UsersPanel({ currentUser, theme, darkMode, toast }) {
  const [users, setUsers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [email, setEmail] = useState("");
  const load = async () => {
    try { setUsers(await api.listUsers()); setInvitations(await api.listInvitations()); } catch {}
  };
  useEffect(() => { load(); }, []);
  const invite = async (e) => {
    e.preventDefault();
    try { await api.createInvitation(email); setEmail(""); load(); toast?.("Invite sent", "success"); }
    catch { toast?.("Failed to send invite", "error"); }
  };
  if (currentUser.role !== "admin") {
    return (
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-6 text-sm ${theme.textSubtle}`}>
        Admin access required to manage users.
      </div>
    );
  }
  const inputCls = `flex-1 px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`;
  return (
    <div className="space-y-4">
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
        <h3 className="font-semibold mb-4">Invite a user</h3>
        <form onSubmit={invite} className="flex gap-2">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="email@example.com" className={inputCls} />
          <motion.button whileTap={{ scale: 0.97 }} className="bg-emerald-500 text-white px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2">
            <Mail className="w-4 h-4" /> Send invite
          </motion.button>
        </form>
      </div>
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
        <h3 className="font-semibold mb-3">Members ({users.length})</h3>
        <div className="space-y-0.5">
          {users.map(u => (
            <div key={u.id} className={`flex items-center justify-between py-2.5 border-b ${theme.border} last:border-0`}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-white font-semibold text-sm">
                  {(u.name || u.email)[0].toUpperCase()}
                </div>
                <div>
                  <div className="font-medium text-sm">{u.name || u.email}</div>
                  <div className={`text-xs ${theme.textSubtle}`}>{u.email} · {u.accountCount} accounts</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-1 rounded-full font-medium flex items-center gap-1 ${u.role === "admin" ? (darkMode ? "bg-violet-500/20 text-violet-400" : "bg-violet-100 text-violet-700") : `${theme.surfaceAlt || ""} ${theme.textMuted}`}`}>
                  {u.role === "admin" && <Shield className="w-3 h-3" />}
                  {u.role}
                </span>
                {u.id !== currentUser.id && (
                  <button onClick={async () => { await api.deleteUser(u.id); load(); toast?.("User removed"); }}>
                    <Trash2 className={`w-4 h-4 ${theme.textSubtle} hover:text-rose-500 transition-colors`} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={`${theme.surface} rounded-2xl border ${theme.border} p-5`}>
        <h3 className="font-semibold mb-3">Pending invitations</h3>
        <div>
          {invitations.filter(i => !i.accepted).map(i => (
            <div key={i.id} className={`flex items-center justify-between py-2.5 border-b ${theme.border} last:border-0`}>
              <div>
                <div className="text-sm font-medium">{i.email}</div>
                <div className={`text-xs ${theme.textSubtle}`}>Expires {new Date(i.expires_at).toLocaleDateString()}</div>
              </div>
              <button onClick={async () => { await api.deleteInvitation(i.id); load(); toast?.("Invitation deleted"); }}>
                <Trash2 className={`w-4 h-4 ${theme.textSubtle} hover:text-rose-500 transition-colors`} />
              </button>
            </div>
          ))}
          {invitations.filter(i => !i.accepted).length === 0 && (
            <div className={`text-sm ${theme.textSubtle} py-2`}>No pending invitations.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Mobile Banks & Accounts section (shown inside Settings on mobile) ───────
function MobileBanksSection({ theme, darkMode, toast }) {
  const { accounts, refreshAll } = useData();
  const [items, setItems] = useState([]);
  const [removingId, setRemovingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", type: "cash", subtype: "", balance: "", institution: "" });

  const loadItems = useCallback(async () => {
    try { setItems(await api.listPlaidItems()); } catch {}
  }, []);
  useEffect(() => { loadItems(); }, [loadItems]);

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
      });
      toast?.("Account added", "success");
      setShowAdd(false);
      setForm({ name: "", type: "cash", subtype: "", balance: "", institution: "" });
      refreshAll();
    } catch (e) { toast?.("Failed: " + (e.message || ""), "error"); }
    finally { setAdding(false); }
  };

  const manualAccounts = accounts.filter(a => !a.plaidItemId);
  const inputCls = `w-full px-3 py-2.5 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`;

  return (
    <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-4`}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Banks & Accounts</h3>
      </div>

      <PlaidLinkButton onSuccess={() => { refreshAll(); loadItems(); }} full />

      {items.length > 0 && (
        <div>
          <div className={`text-xs font-semibold ${theme.textSubtle} uppercase tracking-wider mb-2`}>Connected Banks</div>
          <div className={`rounded-xl border ${theme.border} divide-y ${theme.divide}`}>
            {items.map(item => (
              <div key={item.id} className="flex items-center justify-between px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                    <Building2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm truncate">{item.institutionName || "Bank"}</div>
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
            className="text-xs font-semibold text-emerald-500 flex items-center gap-1">
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
                  <div className="font-medium text-sm truncate">{a.name}</div>
                  <div className={`text-[11px] ${theme.textSubtle} truncate`}>{a.institution || a.type} · {fmt(a.balance)}</div>
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
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setShowAdd(false)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${theme.surface} border ${theme.border}`}>
              Cancel
            </button>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={adding}
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {adding ? "Adding…" : "Add account"}
            </motion.button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({ user, onUpdate, theme, darkMode, onToggleDark }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: user.name || "",
    notification_email: user.notification_email !== false,
    notification_push: user.notification_push !== false,
  });

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.updateMe(form);
      toast?.("Settings saved", "success");
      onUpdate?.();
    } catch (err) { toast?.("Failed: " + err.message, "error"); }
  };

  function Toggle({ checked, onChange }) {
    return (
      <button type="button" onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-emerald-500" : darkMode ? "bg-slate-700" : "bg-slate-300"}`}>
        <motion.div animate={{ x: checked ? 20 : 0 }} transition={{ type: "spring", damping: 25, stiffness: 500 }}
          className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm" />
      </button>
    );
  }

  const inputCls = `w-full px-3 py-2 ${theme.inputBg} border ${theme.border} rounded-xl text-sm focus:outline-none focus:border-emerald-500`;

  return (
    <div className="space-y-4">
      <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5`}>
        <h3 className="font-semibold mb-4">Appearance</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Dark mode</div>
            <div className={`text-xs ${theme.textSubtle} mt-0.5`}>Synced across all your devices</div>
          </div>
          <Toggle checked={darkMode} onChange={onToggleDark} />
        </div>
      </div>

      {/* Mobile-only: Banks & Accounts management lives here (desktop has its own Accounts tab) */}
      <div className="lg:hidden">
        <MobileBanksSection theme={theme} darkMode={darkMode} toast={toast} />
      </div>

      <div className={`${theme.surface} border ${theme.border} rounded-2xl p-5`}>
        <h3 className="font-semibold mb-4">Account</h3>
        <div className="flex items-center gap-3 mb-1">
          {user.picture ? (
            <img src={user.picture} alt="" className="w-12 h-12 rounded-full" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center text-white font-semibold">
              {(user.name || user.email || "?")[0].toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{user.name}</div>
            <div className={`text-xs ${theme.textSubtle} truncate`}>{user.email}</div>
          </div>
        </div>
        <div className={`text-xs ${theme.textSubtle} mt-3`}>
          Signed in with Google · {user.role === "admin" ? "Administrator" : "Member"}
        </div>
      </div>

      <form onSubmit={save} className={`${theme.surface} border ${theme.border} rounded-2xl p-5 space-y-4`}>
        <h3 className="font-semibold">Profile</h3>
        <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Display name" className={inputCls} />
        <div className="flex items-center justify-between">
          <span className="text-sm">Email digest</span>
          <Toggle checked={form.notification_email} onChange={v => setForm({ ...form, notification_email: v })} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm">In-app notifications</span>
          <Toggle checked={form.notification_push} onChange={v => setForm({ ...form, notification_push: v })} />
        </div>
        <motion.button whileTap={{ scale: 0.97 }} type="submit" className="bg-emerald-500 text-white px-4 py-2 rounded-xl text-sm font-semibold">Save</motion.button>
      </form>
    </div>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────
function Shell({ user, onLogout, refreshUser }) {
  const [tab, setTab] = useState("dashboard");
  const [prevTab, setPrevTab] = useState("dashboard");
  const [darkMode, setDarkModeLocal] = useState(!!user?.dark_mode);
  const toast = useToast();
  const { refreshAll, loading, summary, accounts } = useData();
  const theme = darkMode ? DARK : LIGHT;

  // Keep local state in sync if user is refreshed from server
  useEffect(() => { setDarkModeLocal(!!user?.dark_mode); }, [user?.dark_mode]);

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

  const TAB_ORDER = ["dashboard","accounts","transactions","investments","budgets","goals","notes","users","settings"];
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
    { id: "goals",        label: "Goals",        icon: Target      },
    { id: "notes",        label: "Notes",        icon: FileText    },
    ...(user.role === "admin" ? [{ id: "users", label: "Users", icon: Users }] : []),
    { id: "settings",     label: "Settings",     icon: Settings    },
  ];
  const TITLES = { dashboard:"Overview", accounts:"Accounts", transactions:"Transactions", investments:"Investments", budgets:"Budgets", goals:"Goals", notes:"Notes", users:"Users", settings:"Settings" };
  const mainTabs = ALL_TABS.slice(0, 7);
  const moreTabs = ALL_TABS.slice(7);
  const net = Number(summary?.netWorth || 0);

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} font-sans transition-colors`}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif' }}>

      {/* ── Desktop nav ── */}
      <nav className={`hidden lg:block ${theme.surface} border-b ${theme.border} sticky top-0 z-20`}>
        <div className="px-6 py-3 flex items-center justify-between max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-8">
            <button onClick={() => navigate("dashboard")} className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-white" />
              </div>
              <span className="font-bold text-lg">Ledger</span>
            </button>
            <div className="flex items-center gap-1">
              {mainTabs.map(t => (
                <button key={t.id} onClick={() => navigate(t.id)}
                  className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${tab === t.id ? (darkMode ? "text-emerald-400" : "text-emerald-700") : `${theme.textMuted} ${theme.hover}`}`}>
                  {tab === t.id && (
                    <motion.div layoutId="desktopTabBg"
                      className={`absolute inset-0 rounded-lg ${darkMode ? "bg-emerald-500/15" : "bg-emerald-50"}`}
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

      {/* ── Mobile sticky frosted nav (Mint/iOS style) ── */}
      <div className={`lg:hidden sticky top-0 z-30 backdrop-blur-xl ${darkMode ? "bg-slate-950/70" : "bg-white/70"} border-b ${darkMode ? "border-slate-800/40" : "border-slate-200/50"}`}>
        {/* Dynamic Island spacer — env(safe-area-inset-top) on iPhone 15+ */}
        <div className="safe-pt" style={{ paddingTop: "max(env(safe-area-inset-top), 12px)" }}>
          <div className="px-4 h-14 flex items-center justify-between">
            <button onClick={() => navigate("dashboard")} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center shadow-sm shadow-emerald-500/40">
                <DollarSign className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-sm">Ledger</span>
            </button>
            <div className="flex items-center gap-0.5">
              <IconButton theme={theme} onClick={() => navigate("investments")}>
                <TrendingUp className={`w-5 h-5 ${theme.textMuted}`} />
              </IconButton>
              <NotificationsBell theme={theme} darkMode={darkMode} />
              <IconButton theme={theme} onClick={onLogout}><LogOut className={`w-5 h-5 ${theme.textMuted}`} /></IconButton>
            </div>
          </div>
        </div>
      </div>

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
            <div className="text-2xl font-bold">
              <AnimatedNumber value={net} format={fmt} />
            </div>
          </div>
          <SidebarGroup type="cash"       label="Cash"         icon={Wallet}      accounts={accounts} theme={theme} />
          <SidebarGroup type="credit"     label="Credit Cards" icon={CreditCard}  accounts={accounts} theme={theme} />
          <SidebarGroup type="investment" label="Investments"  icon={TrendingUp}  accounts={accounts} theme={theme} />
          <SidebarGroup type="loan"       label="Loans"        icon={Building2}   accounts={accounts} theme={theme} />
          <div className="mt-auto">
            <PlaidLinkButton onSuccess={refreshAll} full />
          </div>
        </aside>

        {/* ── Main ── */}
        <main className="flex-1 min-w-0 pb-[calc(96px+env(safe-area-inset-bottom))] lg:pb-8 overflow-hidden">
          <div className="p-4 sm:p-6">
            <AnimatePresence mode="wait" custom={direction}>
              <motion.div key={tab} custom={direction}
                initial={{ opacity: 0, x: direction > 0 ? 28 : -28 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction > 0 ? -28 : 28 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                {tab === "dashboard"    && <OverviewTab      theme={theme} darkMode={darkMode} onNavigate={navigate} />}
                {tab === "accounts"     && <AccountsTab      theme={theme} darkMode={darkMode} toast={toast} />}
                {tab === "transactions" && <TransactionsTab  theme={theme} darkMode={darkMode} toast={toast} />}
                {tab === "investments"  && <InvestmentsTab   theme={theme} darkMode={darkMode} />}
                {tab === "budgets"      && <BudgetsTab       theme={theme} darkMode={darkMode} toast={toast} />}
                {tab === "goals"        && <GoalsTab         theme={theme} darkMode={darkMode} toast={toast} />}
                {tab === "notes"        && <NotesTab         theme={theme} darkMode={darkMode} toast={toast} />}
                {tab === "users"        && <UsersPanel       currentUser={user} theme={theme} darkMode={darkMode} toast={toast} />}
                {tab === "settings"     && <SettingsPanel    user={user} onUpdate={refreshUser} theme={theme} darkMode={darkMode} onToggleDark={setDarkMode} />}
              </motion.div>
            </AnimatePresence>
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
                    className="absolute top-0 w-10 h-[3px] bg-emerald-500 rounded-full"
                    transition={{ type: "spring", damping: 30, stiffness: 400 }} />
                )}
                <motion.div animate={{ y: active ? -1 : 0, scale: active ? 1.08 : 1 }}
                  transition={{ type: "spring", damping: 20, stiffness: 300 }}>
                  <t.icon className={`w-[26px] h-[26px] ${active ? "text-emerald-500" : theme.textSubtle}`} strokeWidth={active ? 2.4 : 1.9} />
                </motion.div>
                <span className={`text-[10px] font-semibold tracking-wide ${active ? "text-emerald-500" : theme.textSubtle}`}>{t.label}</span>
              </motion.button>
            );
          })}
        </div>
        <div className="safe-h-bottom" />
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const auth = useAuth();
  if (auth.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}
          className="w-8 h-8 rounded-full border-2 border-emerald-200 border-t-emerald-500" />
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
