const API_URL = import.meta.env.VITE_API_URL || "/api";

let authToken = localStorage.getItem("ledger_token");

export function setToken(t) {
  authToken = t;
  if (t) localStorage.setItem("ledger_token", t);
  else localStorage.removeItem("ledger_token");
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

  // admin
  listUsers: () => request("GET", "/auth/users"),
  deleteUser: (id) => request("DELETE", `/auth/users/${id}`),
  listInvitations: () => request("GET", "/auth/invitations"),
  createInvitation: (email) => request("POST", "/auth/invitations", { email }),
  deleteInvitation: (id) => request("DELETE", `/auth/invitations/${id}`),

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
  getByCategory: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request("GET", `/transactions/by-category${q ? "?" + q : ""}`);
  },
  getCashflow: () => request("GET", "/transactions/cashflow"),

  // budgets / goals / notes / categories
  getBudgets: () => request("GET", "/budgets"),
  createBudget: (data) => request("POST", "/budgets", data),
  updateBudget: (id, data) => request("PATCH", `/budgets/${id}`, data),
  deleteBudget: (id) => request("DELETE", `/budgets/${id}`),

  getGoals: () => request("GET", "/goals"),
  createGoal: (data) => request("POST", "/goals", data),
  updateGoal: (id, data) => request("PATCH", `/goals/${id}`, data),
  deleteGoal: (id) => request("DELETE", `/goals/${id}`),

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
};