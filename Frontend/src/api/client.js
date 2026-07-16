// SPDX-License-Identifier: AGPL-3.0-or-later
const API_URL = import.meta.env.VITE_API_URL || "/api";

let authToken = localStorage.getItem("coinvane_token");

export function setToken(t) {
  authToken = t;
  if (t) localStorage.setItem("coinvane_token", t);
  else localStorage.removeItem("coinvane_token");
}

export function getToken() { return authToken; }

async function request(method, path, body) {
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  // Only declare a JSON body when we actually have one — otherwise Fastify's
  // body parser sees Content-Type: application/json with an empty body and
  // rejects with 400 (FST_ERR_CTP_EMPTY_JSON_BODY). Affects POST endpoints
  // that take no payload, like /plaid/sync and /notifications/read-all.
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    setToken(null);
    window.location.reload();
    throw new Error("Unauthorized");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

export const api = {
  // auth — Google SSO only
  googleLogin: (id_token) => request("POST", "/auth/google", { id_token }),
  me: () => request("GET", "/auth/me"),
  updateMe: (data) => request("PATCH", "/auth/me", data),
  sendTestEmail: () => request("POST", "/auth/me/test-email"),

  // admin
  listUsers: () => request("GET", "/auth/users"),
  deleteUser: (id) => request("DELETE", `/auth/users/${id}`),
  updateUserRole: (id, role) => request("PATCH", `/auth/users/${id}/role`, { role }),
  sendUserTestEmail: (id) => request("POST", `/auth/users/${id}/test-email`),

  // accounts
  getAccounts: () => request("GET", "/accounts"),
  createAccount: (data) => request("POST", "/accounts", data),
  updateAccount: (id, data) => request("PATCH", `/accounts/${id}`, data),
  deleteAccount: (id) => request("DELETE", `/accounts/${id}`),
  getAccountSummary: () => request("GET", "/accounts/summary"),
  getNetWorthHistory: (range = "mtd") => request("GET", `/accounts/networth-history?range=${encodeURIComponent(range)}`),

  // transactions
  getTransactions: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/transactions${q ? "?" + q : ""}`);
  },
  createTransaction: (data) => request("POST", "/transactions", data),
  updateTransaction: (id, data) => request("PATCH", `/transactions/${id}`, data),
  deleteTransaction: (id) => request("DELETE", `/transactions/${id}`),
  savePaystub: (id, paystub) => request("PUT", `/transactions/${id}/paystub`, { paystub }),
  // Scheduled transactions
  getScheduledTransactions: () => request("GET", "/transactions/scheduled"),
  createScheduledTransaction: (data) => request("POST", "/transactions/scheduled", data),
  setTransactionScheduled: (id, is_scheduled) =>
    request("PATCH", `/transactions/${id}/scheduled`, { is_scheduled }),
  // Manual override: force a transaction's classification. classification is
  // one of "income" | "expense" | "transfer".
  classifyTransaction: (id, classification) =>
    request("PATCH", `/transactions/${id}/classify`, { classification }),
  // Manual split. body: { splits: [{ category, amount, note? }, ...] }
  splitTransaction: (id, splits) =>
    request("POST", `/transactions/${id}/split`, { splits }),
  // Receipt attachments. Upload uses multipart (bespoke — request() only
  // does JSON). Download returns a signed same-origin URL string.
  uploadAttachment: async (id, file) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_URL}/transactions/${id}/attachment`, {
      method: "POST",
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: fd,
    });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    return data;
  },
  // Fetches the receipt as a blob (authed) and returns an object URL the
  // browser can drop into <img src>. Caller is responsible for
  // URL.revokeObjectURL when the image is no longer displayed.
  fetchAttachment: async (id) => {
    const res = await fetch(`${API_URL}/transactions/${id}/attachment`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    if (!res.ok) throw new Error("failed to load attachment");
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
  deleteAttachment: (id) => request("DELETE", `/transactions/${id}/attachment`),

  // ── Loans (debt-payoff tracking) ────────────────────────────────
  listLoans:  () => request("GET", "/loans"),
  createLoan: (data) => request("POST", "/loans", data),
  updateLoan: (id, data) => request("PATCH", `/loans/${id}`, data),
  deleteLoan: (id) => request("DELETE", `/loans/${id}`),
  recordLoanPayment: (id, amount) =>
    request("POST", `/loans/${id}/payment`, { amount }),

  // ── Bills (recurring outgoing obligations) ─────────────────────
  listBills: (historyCount = 0) =>
    request("GET", `/bills${historyCount ? "?historyCount=" + historyCount : ""}`),
  createBill: (data) => request("POST", "/bills", data),
  updateBill: (id, data) => request("PATCH", `/bills/${id}`, data),
  deleteBill: (id) => request("DELETE", `/bills/${id}`),
  markBillPaid: (id, amount) => request("POST", `/bills/${id}/mark-paid`, { amount }),
  markBillUnpaid: (id) => request("POST", `/bills/${id}/mark-unpaid`),
  skipBillCycle: (id) => request("POST", `/bills/${id}/skip`),
  refreshBillCycles: () => request("POST", "/bills/refresh-cycles"),

  // ── Automations (per-user rule engine) ─────────────────────────
  getAutomationVocab:   () => request("GET",    "/automations/vocab"),
  listAutomations:      () => request("GET",    "/automations"),
  createAutomation:  (d) => request("POST",   "/automations", d),
  updateAutomation:  (id, d) => request("PATCH",  `/automations/${id}`, d),
  deleteAutomation:  (id) => request("DELETE", `/automations/${id}`),
  reorderAutomations:(ids) => request("POST",   "/automations/reorder", { ids }),
  getAutomationHistory: () => request("GET",    "/automations/history"),
  acknowledgeAutomationHistory: (id) =>
    request("POST", `/automations/history/${id}/acknowledge`),
  acknowledgeAllAutomationErrors: () =>
    request("POST", "/automations/history/acknowledge-all"),
  getByCategory: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/transactions/by-category${q ? "?" + q : ""}`);
  },
  getCashflow: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/transactions/cashflow${q ? "?" + q : ""}`);
  },

  // budgets / goals / notes / categories
  getBudgets: () => request("GET", "/budgets"),
  createBudget: (data) => request("POST", "/budgets", data),
  updateBudget: (id, data) => request("PATCH", `/budgets/${id}`, data),
  deleteBudget: (id) => request("DELETE", `/budgets/${id}`),
  reorderBudgets: (ids) => request("POST", "/budgets/reorder", { ids }),
  getBudgetTrackers: () => request("GET", "/budgets/trackers"),
  getBudgetSuggestions: () => request("GET", "/budgets/suggestions"),
  getBudgetTransactions: (id, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/budgets/${id}/transactions${q ? "?" + q : ""}`);
  },
  getBudgetHistory: (count = 6) => request("GET", `/budgets/history?count=${count}`),
  updateTrackerSettings: (data) => request("PATCH", "/budgets/tracker-settings", data),

  getGoals: () => request("GET", "/goals"),
  createGoal: (data) => request("POST", "/goals", data),
  updateGoal: (id, data) => request("PATCH", `/goals/${id}`, data),
  contributeGoal: (id, amount) => request("POST", `/goals/${id}/contribute`, { amount }),
  deleteGoal: (id) => request("DELETE", `/goals/${id}`),

  // Merchant rule + bulk recategorize (Feature 3)
  recategorizeMerchant: (merchant, category) =>
    request("POST", "/transactions/recategorize-merchant", { merchant, category }),
  getMerchantRules: () => request("GET", "/transactions/merchant-rules"),
  deleteMerchantRule: (id) => request("DELETE", `/transactions/merchant-rules/${id}`),

  getNotes: () => request("GET", "/notes"),
  createNote: (data) => request("POST", "/notes", data),
  updateNote: (id, data) => request("PATCH", `/notes/${id}`, data),
  deleteNote: (id) => request("DELETE", `/notes/${id}`),

  getCategories: () => request("GET", "/categories"),
  createCategory: (data) => request("POST", "/categories", data),
  updateCategory: (id, data) => request("PATCH", `/categories/${id}`, data),
  deleteCategory: (id) => request("DELETE", `/categories/${id}`),

  // notifications
  getNotifications: () => request("GET", "/notifications"),
  markNotificationRead: (id) => request("POST", `/notifications/${id}/read`),
  markAllNotificationsRead: () => request("POST", "/notifications/read-all"),
  deleteNotification: (id) => request("DELETE", `/notifications/${id}`),
  getUnreadCount: () => request("GET", "/notifications/unread-count"),

  // investments
  getHoldings: () => request("GET", "/investments/holdings"),
  getInvestmentSummary: () => request("GET", "/investments/summary"),

  // plaid
  createLinkToken: (data = {}) => request("POST", "/plaid/link-token", data),
  exchangePublicToken: (public_token, metadata) =>
    request("POST", "/plaid/exchange", { public_token, metadata }),
  listPlaidItems: () => request("GET", "/plaid/items"),
  deletePlaidItem: (id) => request("DELETE", `/plaid/items/${id}`),
  syncPlaid: () => request("POST", "/plaid/sync"),

  // merchant rules — danger zone
  clearMerchantRules: () => request("DELETE", "/transactions/merchant-rules"),

  // CSV / PDF — non-JSON download endpoints
  exportTransactionsCSV: () => downloadAuthed("/transactions/export.csv", "coinvane-transactions.csv"),
  importTransactionsCSV: (csv) => request("POST", "/transactions/import.csv", { csv }),
  exportFullPDF: () => downloadAuthed("/export/full.pdf", "coinvane-export.pdf"),
  exportMonthlyPDF: (month) =>
    downloadAuthed(`/export/monthly.pdf${month ? "?month=" + encodeURIComponent(month) : ""}`,
                   `coinvane-monthly-${month || "current"}.pdf`),
  exportCategoryYoyPDF: (year) =>
    downloadAuthed(`/export/category-yoy.pdf${year ? "?year=" + encodeURIComponent(year) : ""}`,
                   `coinvane-yoy-${year || "current"}.pdf`),
  exportBudgetsPDF: () => downloadAuthed("/export/budgets.pdf", "coinvane-budgets.pdf"),
  exportBillsLoansPDF: () => downloadAuthed("/export/bills-loans.pdf", "coinvane-bills-loans.pdf"),

  // admin
  adminInfo: () => request("GET", "/admin/info"),
  adminGetSyncInterval: () => request("GET", "/admin/sync-interval"),
  adminSetSyncInterval: (minutes) => request("PATCH", "/admin/sync-interval", { minutes }),
  adminGetAllowlist: () => request("GET", "/admin/allowlist"),
  adminSetAllowlist: (emails) => request("PUT", "/admin/allowlist", { emails }),
  adminGetAudit: () => request("GET", "/admin/audit"),
  adminCleanupNotifications: (days) => request("POST", "/admin/cleanup-notifications", { days }),
};

// Authed file-download helper. fetch() with Authorization → blob → save.
// Used for CSV / PDF endpoints that return non-JSON payloads.
async function downloadAuthed(path, filename) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (!res.ok) {
    const ct = res.headers.get("content-type") || "";
    const err = ct.includes("application/json")
      ? (await res.json())?.error || res.statusText
      : res.statusText;
    throw new Error(err);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { ok: true };
}